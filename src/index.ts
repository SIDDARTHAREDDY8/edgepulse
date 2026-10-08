import { createKey, requireAdmin, requireKey } from "./auth";
import { DASHBOARD_HTML } from "./dashboard";
import { HttpError, corsHeaders, errorResponse, json, parseTime, readJson } from "./http";
import { ingestBatch } from "./ingest";
import { runMaintenance } from "./maintenance";
import { handleMcpMessage } from "./mcp";
import { enforceRateLimit } from "./ratelimit";
import { checkRange, dailyHistory, defaultRange, eventNames, summary, timeseries, topEvents, type Range } from "./stats";
import type { Env, KeyScope } from "./types";
import { LIMITS } from "./validation";

type Handler = (request: Request, env: Env, params: Record<string, string>, url: URL) => Promise<Response>;
interface Route {
  method: string;
  pattern: URLPattern;
  handler: Handler;
}

const routes: Route[] = [];
function route(method: string, pathname: string, handler: Handler) {
  routes.push({ method, pattern: new URLPattern({ pathname }), handler });
}

function rangeFrom(url: URL): Range {
  const fallback = defaultRange();
  const range = {
    from: parseTime(url.searchParams.get("from"), fallback.from, "from"),
    to: parseTime(url.searchParams.get("to"), fallback.to, "to"),
  };
  const problem = checkRange(range);
  if (problem) throw new HttpError(400, "invalid_range", problem);
  return range;
}

// ---------- Public ----------

route("GET", "/", async () =>
  new Response(DASHBOARD_HTML, { headers: { "content-type": "text/html; charset=utf-8" } }),
);

route("GET", "/health", async (_req, env) => {
  const started = Date.now();
  await env.DB.prepare("SELECT 1").first();
  return json({ status: "ok", db_latency_ms: Date.now() - started });
});

// ---------- Ingest (write-only key, safe to ship in a client build) ----------

route("POST", "/v1/events", async (request, env) => {
  const auth = await requireKey(request, env, "ingest");
  await enforceRateLimit(env.DB, `ingest:${auth.keyId}`, Number(env.RATE_LIMIT_PER_MINUTE ?? "600"));
  const body = await readJson(request, LIMITS.maxBodyBytes);
  const result = await ingestBatch(env.DB, auth.projectId, body);
  // 207 tells the client "some events were refused, read the details".
  const status = result.rejected.length === 0 ? 202 : result.accepted + result.duplicates > 0 ? 207 : 422;
  return json(result, status);
});

// ---------- Stats (read key) ----------

route("GET", "/v1/stats/summary", async (request, env, _p, url) => {
  const auth = await requireKey(request, env, "read");
  return json(await summary(env.DB, auth.projectId, rangeFrom(url)));
});

route("GET", "/v1/stats/top-events", async (request, env, _p, url) => {
  const auth = await requireKey(request, env, "read");
  const limit = Number(url.searchParams.get("limit") ?? "10");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new HttpError(400, "invalid_parameter", "limit must be an integer 1-100");
  }
  return json(await topEvents(env.DB, auth.projectId, rangeFrom(url), limit));
});

route("GET", "/v1/stats/timeseries", async (request, env, _p, url) => {
  const auth = await requireKey(request, env, "read");
  const interval = url.searchParams.get("interval") ?? "day";
  if (interval !== "hour" && interval !== "day") {
    throw new HttpError(400, "invalid_parameter", "interval must be 'hour' or 'day'");
  }
  try {
    const name = url.searchParams.get("name") ?? undefined;
    return json(await timeseries(env.DB, auth.projectId, rangeFrom(url), interval, name));
  } catch (err) {
    if (err instanceof RangeError) throw new HttpError(400, "too_many_buckets", err.message);
    throw err;
  }
});

route("GET", "/v1/stats/event-names", async (request, env) => {
  const auth = await requireKey(request, env, "read");
  return json(await eventNames(env.DB, auth.projectId));
});

route("GET", "/v1/stats/daily", async (request, env, _p, url) => {
  const auth = await requireKey(request, env, "read");
  const day = /^\d{4}-\d{2}-\d{2}$/;
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";
  if (!day.test(from) || !day.test(to)) {
    throw new HttpError(400, "invalid_parameter", "from and to must be YYYY-MM-DD");
  }
  return json(await dailyHistory(env.DB, auth.projectId, from, to));
});

// ---------- MCP (read key) ----------

route("POST", "/mcp", async (request, env) => {
  const auth = await requireKey(request, env, "read");
  const body = await readJson(request, 64 * 1024).catch((err) => {
    if (err instanceof HttpError && err.code === "invalid_json") return Symbol.for("parse_error");
    throw err;
  });
  if (body === Symbol.for("parse_error")) {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }
  const response = await handleMcpMessage(env.DB, auth, body);
  return response === null ? new Response(null, { status: 202 }) : json(response);
});

route("GET", "/mcp", async () => {
  // Stateless server: no server-initiated SSE stream.
  throw new HttpError(405, "method_not_allowed", "This MCP server does not offer an SSE stream; POST JSON-RPC instead", undefined, {
    allow: "POST",
  });
});

// ---------- Admin (ADMIN_TOKEN) ----------

route("POST", "/v1/admin/projects", async (request, env) => {
  await requireAdmin(request, env);
  const body = (await readJson(request, 4096)) as { name?: unknown; retention_days?: unknown };
  if (typeof body.name !== "string" || body.name.trim().length === 0 || body.name.length > 100) {
    throw new HttpError(400, "invalid_parameter", "name is required (1-100 chars)");
  }
  const retention = body.retention_days === undefined ? 90 : Number(body.retention_days);
  if (!Number.isInteger(retention) || retention < 1 || retention > 3650) {
    throw new HttpError(400, "invalid_parameter", "retention_days must be an integer 1-3650");
  }
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO projects (id, name, retention_days, created_at) VALUES (?1, ?2, ?3, ?4)")
    .bind(id, body.name.trim(), retention, Date.now())
    .run();
  const [ingest, read] = await Promise.all([createKey(env, id, "ingest"), createKey(env, id, "read")]);
  return json(
    {
      project: { id, name: body.name.trim(), retention_days: retention },
      keys: { ingest: ingest.key, read: read.key },
      note: "Store these keys now. Only their hashes are kept, so they cannot be shown again.",
    },
    201,
  );
});

route("POST", "/v1/admin/projects/:id/keys", async (request, env, params) => {
  await requireAdmin(request, env);
  const body = (await readJson(request, 1024)) as { scope?: unknown };
  if (body.scope !== "ingest" && body.scope !== "read") {
    throw new HttpError(400, "invalid_parameter", "scope must be 'ingest' or 'read'");
  }
  const project = await env.DB.prepare("SELECT id FROM projects WHERE id = ?1").bind(params.id).first();
  if (!project) throw new HttpError(404, "not_found", "Project not found");
  const key = await createKey(env, params.id, body.scope as KeyScope);
  return json({ id: key.id, key: key.key, scope: key.scope }, 201);
});

route("POST", "/v1/admin/keys/:id/revoke", async (request, env, params) => {
  await requireAdmin(request, env);
  const result = await env.DB.prepare("UPDATE api_keys SET revoked_at = ?1 WHERE id = ?2 AND revoked_at IS NULL")
    .bind(Date.now(), params.id)
    .run();
  if ((result.meta.changes ?? 0) === 0) throw new HttpError(404, "not_found", "Key not found or already revoked");
  return json({ id: params.id, revoked: true });
});

// ---------- Entry points ----------

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  let methodMismatch = false;
  for (const r of routes) {
    const match = r.pattern.exec({ pathname: url.pathname });
    if (!match) continue;
    if (r.method !== request.method) {
      methodMismatch = true;
      continue;
    }
    const params = Object.fromEntries(
      Object.entries(match.pathname.groups).filter((e): e is [string, string] => typeof e[1] === "string"),
    );
    return r.handler(request, env, params, url);
  }
  if (methodMismatch) throw new HttpError(405, "method_not_allowed", `${request.method} is not allowed here`);
  throw new HttpError(404, "not_found", `No route for ${request.method} ${url.pathname}`);
}

export default {
  async fetch(request, env): Promise<Response> {
    const requestId = request.headers.get("cf-ray") ?? crypto.randomUUID();
    const started = Date.now();
    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    let response: Response;
    try {
      response = await handle(request, env);
    } catch (err) {
      if (err instanceof HttpError) {
        response = errorResponse(err, requestId);
      } else {
        console.error(JSON.stringify({ msg: "unhandled_error", request_id: requestId, error: String(err) }));
        response = errorResponse(new HttpError(500, "internal_error", "Unexpected server error"), requestId);
      }
    }

    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(cors)) headers.set(k, v);
    headers.set("x-request-id", requestId);
    // Structured access log. Deliberately no IP, user agent, or key material.
    console.log(
      JSON.stringify({
        msg: "request",
        request_id: requestId,
        method: request.method,
        path: new URL(request.url).pathname,
        status: response.status,
        duration_ms: Date.now() - started,
      }),
    );
    return new Response(response.body, { status: response.status, headers });
  },

  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(
      runMaintenance(env.DB).then((report) => console.log(JSON.stringify({ msg: "maintenance", ...report }))),
    );
  },
} satisfies ExportedHandler<Env>;
