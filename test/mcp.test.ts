import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { BASE, createProject, event, mcp, postEvents, type TestProject } from "./helpers";

let p: TestProject;

beforeAll(async () => {
  p = await createProject();
  await postEvents(p.ingestKey, [
    event({ name: "world.entered", session_id: "sess_mcp00001" }),
    event({ name: "world.entered", session_id: "sess_mcp00002" }),
    event({ name: "world.exited", session_id: "sess_mcp00001" }),
  ]);
});

describe("MCP server", () => {
  it("completes the initialize handshake", async () => {
    const { status, body } = await mcp(p.readKey, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
    });
    expect(status).toBe(200);
    expect(body.result.protocolVersion).toBe("2025-06-18");
    expect(body.result.capabilities.tools).toBeDefined();
    expect(body.result.serverInfo.name).toBe("edgepulse");
  });

  it("falls back to its latest protocol version for unknown requests", async () => {
    const { body } = await mcp(p.readKey, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "1999-01-01" },
    });
    expect(body.result.protocolVersion).toBe("2025-06-18");
  });

  it("acknowledges notifications with 202 and no body", async () => {
    const { status, body } = await mcp(p.readKey, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(status).toBe(202);
    expect(body).toBeNull();
  });

  it("lists read-only tools with JSON schemas", async () => {
    const { body } = await mcp(p.readKey, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const names = body.result.tools.map((t: any) => t.name);
    expect(names).toEqual(["list_event_names", "get_summary", "get_top_events", "get_timeseries"]);
    for (const tool of body.result.tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.annotations.readOnlyHint).toBe(true);
    }
  });

  it("answers questions through tools/call with text and structured content", async () => {
    const { body } = await mcp(p.readKey, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "get_summary", arguments: {} },
    });
    expect(body.result.structuredContent).toMatchObject({ events: 3, sessions: 2 });
    expect(JSON.parse(body.result.content[0].text)).toEqual(body.result.structuredContent);

    const top = await mcp(p.readKey, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "get_top_events", arguments: { limit: 1 } },
    });
    expect(top.body.result.structuredContent.events).toEqual([{ name: "world.entered", events: 2, sessions: 2 }]);
  });

  it("returns tool problems in-band so a model can self-correct", async () => {
    const { body } = await mcp(p.readKey, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "get_timeseries", arguments: { from: "2025-01-01", to: "2025-12-31", interval: "hour" } },
    });
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/coarser interval/);
  });

  it("uses JSON-RPC error codes for protocol errors", async () => {
    const unknownMethod = await mcp(p.readKey, { jsonrpc: "2.0", id: 6, method: "resources/list" });
    expect(unknownMethod.body.error.code).toBe(-32601);

    const badParams = await mcp(p.readKey, {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "get_summary", arguments: { from: "not a date" } },
    });
    expect(badParams.body.error.code).toBe(-32602);

    const unknownTool = await mcp(p.readKey, { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "drop_table" } });
    expect(unknownTool.body.error.code).toBe(-32602);

    const batch = await mcp(p.readKey, [{ jsonrpc: "2.0", id: 9, method: "ping" }]);
    expect(batch.body.error.code).toBe(-32600);

    const parse = await SELF.fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${p.readKey}`, "content-type": "application/json" },
      body: "{not json",
    });
    expect(((await parse.json()) as any).error.code).toBe(-32700);
  });

  it("requires a read key and rejects GET", async () => {
    expect((await mcp(p.ingestKey, { jsonrpc: "2.0", id: 1, method: "ping" })).status).toBe(403);
    const get = await SELF.fetch(`${BASE}/mcp`, { headers: { authorization: `Bearer ${p.readKey}` } });
    expect(get.status).toBe(405);
  });
});
