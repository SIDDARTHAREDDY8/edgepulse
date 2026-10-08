/**
 * A Model Context Protocol server over Streamable HTTP (stateless, JSON responses).
 *
 * Any MCP client (Claude, Cursor, an agent framework) can connect with a
 * project's read key and ask questions like "how many sessions yesterday?" or
 * "which event dropped off this week?". Tools reuse the exact queries behind
 * the REST API, and every tool is read-only.
 */
import type { AuthContext } from "./types";
import { checkRange, defaultRange, eventNames, summary, timeseries, topEvents, type Interval, type Range } from "./stats";

export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "edgepulse", title: "EdgePulse Analytics", version: "1.0.0" };

type JsonRpcId = string | number | null;
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

const rangeProps = {
  from: { type: "string", description: "Start of range, ISO-8601 (inclusive). Defaults to 7 days ago." },
  to: { type: "string", description: "End of range, ISO-8601 (exclusive). Defaults to now." },
};
const readOnly = { readOnlyHint: true, openWorldHint: false };

export const TOOLS = [
  {
    name: "list_event_names",
    title: "List event names",
    description: "List every distinct event name this project has recorded, with when each was last seen. Call this first to discover what can be queried.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: readOnly,
  },
  {
    name: "get_summary",
    title: "Summarize activity",
    description: "Total events, unique sessions, distinct event names, and average/max session length for a time range.",
    inputSchema: { type: "object", properties: rangeProps, additionalProperties: false },
    annotations: readOnly,
  },
  {
    name: "get_top_events",
    title: "Top events",
    description: "Event names ranked by count (with unique sessions) for a time range.",
    inputSchema: {
      type: "object",
      properties: { ...rangeProps, limit: { type: "integer", minimum: 1, maximum: 100, default: 10 } },
      additionalProperties: false,
    },
    annotations: readOnly,
  },
  {
    name: "get_timeseries",
    title: "Event time series",
    description: "Zero-filled hourly or daily counts of events and sessions, optionally filtered to one event name.",
    inputSchema: {
      type: "object",
      properties: {
        ...rangeProps,
        interval: { type: "string", enum: ["hour", "day"], default: "day" },
        name: { type: "string", description: "Optional event name filter (see list_event_names)." },
      },
      additionalProperties: false,
    },
    annotations: readOnly,
  },
] as const;

class RpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

function toolRange(args: Record<string, unknown>): Range {
  const fallback = defaultRange();
  const parse = (v: unknown, def: number, field: string) => {
    if (v === undefined) return def;
    const ms = typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN;
    if (!Number.isFinite(ms)) throw new RpcError(-32602, `${field} must be an ISO-8601 date`);
    return ms;
  };
  const range = { from: parse(args.from, fallback.from, "from"), to: parse(args.to, fallback.to, "to") };
  const problem = checkRange(range);
  if (problem) throw new RpcError(-32602, problem);
  return range;
}

async function callTool(db: D1Database, auth: AuthContext, name: string, args: Record<string, unknown>) {
  switch (name) {
    case "list_event_names":
      return eventNames(db, auth.projectId);
    case "get_summary":
      return summary(db, auth.projectId, toolRange(args));
    case "get_top_events": {
      const limit = args.limit === undefined ? 10 : Number(args.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RpcError(-32602, "limit must be 1-100");
      return topEvents(db, auth.projectId, toolRange(args), limit);
    }
    case "get_timeseries": {
      const interval = (args.interval ?? "day") as Interval;
      if (interval !== "hour" && interval !== "day") throw new RpcError(-32602, "interval must be 'hour' or 'day'");
      if (args.name !== undefined && typeof args.name !== "string") throw new RpcError(-32602, "name must be a string");
      return timeseries(db, auth.projectId, toolRange(args), interval, args.name as string | undefined);
    }
    default:
      throw new RpcError(-32602, `Unknown tool: ${name}`);
  }
}

async function dispatch(db: D1Database, auth: AuthContext, req: JsonRpcRequest): Promise<unknown> {
  switch (req.method) {
    case "initialize": {
      const requested = String(req.params?.protocolVersion ?? "");
      return {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "Privacy-first product analytics for one project. Start with list_event_names, then use get_summary, get_top_events, or get_timeseries. All tools are read-only. No personal data is stored.",
      };
    }
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call": {
      const name = req.params?.name;
      const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
      if (typeof name !== "string") throw new RpcError(-32602, "params.name is required");
      if (typeof args !== "object" || args === null || Array.isArray(args)) {
        throw new RpcError(-32602, "params.arguments must be an object");
      }
      try {
        const data = await callTool(db, auth, name, args);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data };
      } catch (err) {
        if (err instanceof RpcError) throw err;
        // Tool-level failures are reported in-band so the model can read them and adjust.
        const message = err instanceof Error ? err.message : "Tool failed";
        return { content: [{ type: "text", text: message }], isError: true };
      }
    }
    default:
      throw new RpcError(-32601, `Method not found: ${req.method}`);
  }
}

function rpcError(id: JsonRpcId, code: number, message: string) {
  return { jsonrpc: "2.0" as const, id, error: { code, message } };
}

/** Returns the JSON-RPC response body, or null for notifications (HTTP 202, no body). */
export async function handleMcpMessage(db: D1Database, auth: AuthContext, body: unknown): Promise<unknown | null> {
  if (Array.isArray(body)) return rpcError(null, -32600, "JSON-RPC batching is not supported");
  if (typeof body !== "object" || body === null) return rpcError(null, -32600, "Invalid Request");

  const req = body as Partial<JsonRpcRequest>;
  const id = req.id ?? null;
  if (req.jsonrpc !== "2.0" || typeof req.method !== "string") return rpcError(id, -32600, "Invalid Request");

  const isNotification = req.id === undefined;
  if (isNotification) return null; // e.g. notifications/initialized: acknowledge, nothing to return.

  try {
    const result = await dispatch(db, auth, req as JsonRpcRequest);
    return { jsonrpc: "2.0", id, result };
  } catch (err) {
    if (err instanceof RpcError) return rpcError(id, err.code, err.message);
    console.error(JSON.stringify({ msg: "mcp_internal_error", error: String(err) }));
    return rpcError(id, -32603, "Internal error");
  }
}
