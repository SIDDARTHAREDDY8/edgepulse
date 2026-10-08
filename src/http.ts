import type { Env } from "./types";

/** An error that maps directly to an HTTP response. Throw it anywhere in a handler. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
  }
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export function errorResponse(err: HttpError, requestId: string): Response {
  return json(
    { error: { code: err.code, message: err.message, details: err.details, request_id: requestId } },
    err.status,
    err.headers,
  );
}

/** Reads a JSON body with a hard size cap, so a huge payload can't exhaust Worker memory. */
export async function readJson(request: Request, maxBytes: number): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > maxBytes) {
    throw new HttpError(413, "payload_too_large", `Body exceeds ${maxBytes} bytes`);
  }
  const type = request.headers.get("content-type") ?? "";
  if (!type.toLowerCase().includes("application/json")) {
    throw new HttpError(415, "unsupported_media_type", "Content-Type must be application/json");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new HttpError(413, "payload_too_large", `Body exceeds ${maxBytes} bytes`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid_json", "Body is not valid JSON");
  }
}

export function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("origin");
  if (!origin) return {};
  const allowed = (env.ALLOWED_ORIGINS ?? "*").split(",").map((s) => s.trim());
  const allow = allowed.includes("*") ? "*" : allowed.includes(origin) ? origin : null;
  if (!allow) return {};
  return {
    "access-control-allow-origin": allow,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, mcp-protocol-version",
    "access-control-max-age": "86400",
    ...(allow === "*" ? {} : { vary: "origin" }),
  };
}

/** Parses a time bound from a query string: epoch ms, or any ISO-8601 date. */
export function parseTime(value: string | null, fallback: number, field: string): number {
  if (value === null || value === "") return fallback;
  const asNumber = Number(value);
  const ms = Number.isFinite(asNumber) ? asNumber : Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new HttpError(400, "invalid_parameter", `${field} must be epoch milliseconds or an ISO-8601 date`);
  }
  return ms;
}
