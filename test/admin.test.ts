import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { ADMIN, BASE, createProject, event, postEvents } from "./helpers";

function admin(path: string, body: unknown, token = ADMIN) {
  return SELF.fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("administration and keys", () => {
  it("creates a project and returns scoped keys exactly once", async () => {
    const res = await admin("/v1/admin/projects", { name: "Pilot hospital", retention_days: 30 });
    expect(res.status).toBe(201);
    const body = await res.json<any>();
    expect(body.keys.ingest).toMatch(/^ep_ing_/);
    expect(body.keys.read).toMatch(/^ep_read_/);
    expect(body.project.retention_days).toBe(30);
  });

  it("stores only key hashes, never raw keys", async () => {
    const p = await createProject();
    const { results } = await env.DB.prepare("SELECT key_hash, prefix FROM api_keys WHERE project_id = ?")
      .bind(p.id)
      .all<{ key_hash: string; prefix: string }>();
    expect(results).toHaveLength(2);
    for (const row of results) {
      expect(row.key_hash).toMatch(/^[0-9a-f]{64}$/);
      expect([p.ingestKey, p.readKey]).not.toContain(row.key_hash);
    }
  });

  it("rejects bad admin tokens and bad input", async () => {
    expect((await admin("/v1/admin/projects", { name: "x" }, "wrong")).status).toBe(401);
    expect((await admin("/v1/admin/projects", { name: "" })).status).toBe(400);
    expect((await admin("/v1/admin/projects", { name: "x", retention_days: 0 })).status).toBe(400);
  });

  it("revoked keys stop working immediately", async () => {
    const p = await createProject();
    const created = await (await admin(`/v1/admin/projects/${p.id}/keys`, { scope: "ingest" })).json<any>();
    expect((await postEvents(created.key, [event()])).status).toBe(202);

    const revoke = await admin(`/v1/admin/keys/${created.id}/revoke`, {});
    expect(revoke.status).toBe(200);
    expect((await postEvents(created.key, [event()])).status).toBe(401);
    expect((await admin(`/v1/admin/keys/${created.id}/revoke`, {})).status).toBe(404);
  });

  it("404s keys for unknown projects", async () => {
    expect((await admin(`/v1/admin/projects/nope/keys`, { scope: "read" })).status).toBe(404);
  });
});

describe("routing and platform", () => {
  it("serves health, dashboard, 404 and 405 with request ids", async () => {
    const health = await SELF.fetch(`${BASE}/health`);
    expect(await health.json()).toMatchObject({ status: "ok" });
    expect(health.headers.get("x-request-id")).toBeTruthy();

    const dash = await SELF.fetch(`${BASE}/`);
    expect(dash.headers.get("content-type")).toContain("text/html");

    const missing = await SELF.fetch(`${BASE}/nope`);
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as any).error.request_id).toBeTruthy();

    expect((await SELF.fetch(`${BASE}/v1/events`)).status).toBe(405);
  });
});
