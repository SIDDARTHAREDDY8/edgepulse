import { SELF } from "cloudflare:test";

export const BASE = "https://edgepulse.test";
export const ADMIN = "test-admin-token";

export interface TestProject {
  id: string;
  ingestKey: string;
  readKey: string;
}

export async function createProject(name = "Test project"): Promise<TestProject> {
  const res = await SELF.fetch(`${BASE}/v1/admin/projects`, {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (res.status !== 201) throw new Error(`createProject failed: ${res.status} ${await res.text()}`);
  const body = await res.json<{ project: { id: string }; keys: { ingest: string; read: string } }>();
  return { id: body.project.id, ingestKey: body.keys.ingest, readKey: body.keys.read };
}

let counter = 0;
export function event(overrides: Record<string, unknown> = {}) {
  counter++;
  return {
    event_id: crypto.randomUUID(),
    name: "world.entered",
    session_id: `sess_${String(counter).padStart(6, "0")}`,
    ...overrides,
  };
}

export function postEvents(key: string, body: unknown, init: RequestInit = {}) {
  return SELF.fetch(`${BASE}/v1/events`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    ...init,
  });
}

export function getJson<T = any>(path: string, key: string): Promise<{ status: number; body: T }> {
  return SELF.fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${key}` } }).then(async (r) => ({
    status: r.status,
    body: (await r.json()) as T,
  }));
}

export async function mcp(key: string, message: unknown) {
  const res = await SELF.fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(message),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as any) : null };
}
