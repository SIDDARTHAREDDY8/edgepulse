import { HttpError } from "./http";
import type { AuthContext, Env, KeyScope } from "./types";

const KEY_PREFIX: Record<KeyScope, string> = { ingest: "ep_ing_", read: "ep_read_" };

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string comparison (both sides hashed first so lengths always match). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0;
}

export function randomToken(bytes = 24): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...buf)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function bearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match ? match[1] : null;
}

export async function requireAdmin(request: Request, env: Env): Promise<void> {
  const token = bearer(request);
  if (!env.ADMIN_TOKEN) {
    throw new HttpError(503, "admin_disabled", "ADMIN_TOKEN is not configured on this deployment");
  }
  if (!token || !(await safeEqual(token, env.ADMIN_TOKEN))) {
    throw new HttpError(401, "unauthorized", "Valid admin token required");
  }
}

/**
 * Resolves a bearer API key to its project. The raw key is hashed before lookup,
 * so a leaked database never leaks usable keys.
 */
export async function requireKey(request: Request, env: Env, scope: KeyScope): Promise<AuthContext> {
  const token = bearer(request);
  if (!token) throw new HttpError(401, "unauthorized", "Missing bearer API key");

  const row = await env.DB.prepare(
    "SELECT id, project_id, scope FROM api_keys WHERE key_hash = ?1 AND revoked_at IS NULL",
  )
    .bind(await sha256Hex(token))
    .first<{ id: string; project_id: string; scope: KeyScope }>();

  if (!row) throw new HttpError(401, "unauthorized", "Unknown or revoked API key");
  if (row.scope !== scope) {
    throw new HttpError(403, "wrong_key_scope", `This endpoint requires a '${scope}' key`);
  }
  return { projectId: row.project_id, keyId: row.id, scope: row.scope };
}

export async function createKey(
  env: Env,
  projectId: string,
  scope: KeyScope,
): Promise<{ id: string; key: string; prefix: string; scope: KeyScope }> {
  const key = KEY_PREFIX[scope] + randomToken();
  const id = crypto.randomUUID();
  const prefix = key.slice(0, KEY_PREFIX[scope].length + 4);
  await env.DB.prepare(
    "INSERT INTO api_keys (id, project_id, key_hash, prefix, scope, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  )
    .bind(id, projectId, await sha256Hex(key), prefix, scope, Date.now())
    .run();
  return { id, key, prefix, scope };
}
