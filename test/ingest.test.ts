import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { BASE, createProject, event, postEvents } from "./helpers";

describe("POST /v1/events", () => {
  it("accepts a batch and stores it", async () => {
    const p = await createProject();
    const res = await postEvents(p.ingestKey, { events: [event(), event({ name: "world.exited" })] });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: 2, duplicates: 0, rejected: [] });

    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE project_id = ?").bind(p.id).first<{ n: number }>();
    expect(row?.n).toBe(2);
  });

  it("is idempotent: a retried batch is counted as duplicates, not re-written", async () => {
    const p = await createProject();
    const batch = [event(), event()];
    await postEvents(p.ingestKey, batch);
    const retry = await postEvents(p.ingestKey, batch);
    expect(await retry.json()).toMatchObject({ accepted: 0, duplicates: 2 });
  });

  it("accepts the good events in a mixed batch and explains the bad ones (207)", async () => {
    const p = await createProject();
    const res = await postEvents(p.ingestKey, [event(), event({ props: { email: "a@b.co" } }), event({ name: "" })]);
    expect(res.status).toBe(207);
    const body = await res.json<any>();
    expect(body.accepted).toBe(1);
    expect(body.rejected.map((r: any) => r.index)).toEqual([1, 2]);
  });

  it("returns 422 when nothing in the batch is valid", async () => {
    const p = await createProject();
    const res = await postEvents(p.ingestKey, [event({ session_id: "jane@example.com" })]);
    expect(res.status).toBe(422);
  });

  it("rejects duplicate event_ids inside one batch", async () => {
    const p = await createProject();
    const e = event();
    const body = await (await postEvents(p.ingestKey, [e, e])).json<any>();
    expect(body.accepted).toBe(1);
    expect(body.rejected[0].errors[0]).toMatch(/duplicate/);
  });

  it("enforces batch size, body shape, and content type", async () => {
    const p = await createProject();
    const tooMany = await postEvents(p.ingestKey, Array.from({ length: 101 }, () => event()));
    expect(tooMany.status).toBe(413);

    const badShape = await postEvents(p.ingestKey, { hello: "world" });
    expect(badShape.status).toBe(400);

    const notJson = await SELF.fetch(`${BASE}/v1/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${p.ingestKey}`, "content-type": "text/plain" },
      body: "hi",
    });
    expect(notJson.status).toBe(415);
  });

  it("isolates projects: events never leak across tenants", async () => {
    const a = await createProject("A");
    const b = await createProject("B");
    const shared = event();
    await postEvents(a.ingestKey, [shared]);
    const res = await postEvents(b.ingestKey, [shared]);
    // Same event_id in another project is a new event, not a duplicate.
    expect(await res.json()).toMatchObject({ accepted: 1, duplicates: 0 });
  });

  it("requires an ingest-scoped key", async () => {
    const p = await createProject();
    expect((await postEvents("ep_ing_not-a-real-key", [event()])).status).toBe(401);
    expect((await postEvents(p.readKey, [event()])).status).toBe(403);
  });

  it("rate limits per key and sends Retry-After", async () => {
    const p = await createProject(); // test config allows 5 requests/minute
    const statuses: number[] = [];
    let retryAfter: string | null = null;
    for (let i = 0; i < 6; i++) {
      const res = await postEvents(p.ingestKey, [event()]);
      statuses.push(res.status);
      if (res.status === 429) retryAfter = res.headers.get("retry-after");
    }
    expect(statuses).toEqual([202, 202, 202, 202, 202, 429]);
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });

  it("answers CORS preflight for allowed origins only", async () => {
    const allowed = await SELF.fetch(`${BASE}/v1/events`, {
      method: "OPTIONS",
      headers: { origin: "https://world.example.com" },
    });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://world.example.com");

    const blocked = await SELF.fetch(`${BASE}/v1/events`, { method: "OPTIONS", headers: { origin: "https://evil.example" } });
    expect(blocked.headers.get("access-control-allow-origin")).toBeNull();
  });
});
