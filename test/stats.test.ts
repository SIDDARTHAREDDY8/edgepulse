import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { createProject, getJson, type TestProject } from "./helpers";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 8, 1, 0, 0, 0); // 2026-09-01T00:00Z
const range = `from=${T0}&to=${T0 + 48 * HOUR}`;

let p: TestProject;

async function seed(projectId: string) {
  // Session A: 2 events spanning 10 minutes on day 1.
  // Session B: 3 events on day 1 and day 2 (25h span).
  // Session C: 1 event on day 2.
  const rows: Array<[string, string, string, number]> = [
    ["a1", "world.entered", "sess_aaaaaaaa", T0 + 1 * HOUR],
    ["a2", "world.exited", "sess_aaaaaaaa", T0 + 1 * HOUR + 600_000],
    ["b1", "world.entered", "sess_bbbbbbbb", T0 + 2 * HOUR],
    ["b2", "breath.completed", "sess_bbbbbbbb", T0 + 3 * HOUR],
    ["b3", "world.entered", "sess_bbbbbbbb", T0 + 27 * HOUR],
    ["c1", "world.entered", "sess_cccccccc", T0 + 30 * HOUR],
  ];
  const stmt = env.DB.prepare(
    "INSERT INTO events (project_id, event_id, name, session_id, ts, received_at, props) VALUES (?1, ?2, ?3, ?4, ?5, ?5, '{}')",
  );
  await env.DB.batch(rows.map(([id, name, session, ts]) => stmt.bind(projectId, `evt_${id}_xxxx`, name, session, ts)));
}

beforeAll(async () => {
  p = await createProject();
  await seed(p.id);
  const other = await createProject("noise");
  await seed(other.id); // identical data in another project must not affect results
});

describe("stats API", () => {
  it("summarizes events, sessions, and session length", async () => {
    const { status, body } = await getJson(`/v1/stats/summary?${range}`, p.readKey);
    expect(status).toBe(200);
    expect(body).toMatchObject({ events: 6, sessions: 3, event_names: 3 });
    // spans: A = 600s, B = 25h = 90000s, C = 0s -> avg 30200s
    expect(body.avg_session_seconds).toBe(30200);
    expect(body.max_session_seconds).toBe(90000);
  });

  it("ranks top events", async () => {
    const { body } = await getJson(`/v1/stats/top-events?${range}&limit=2`, p.readKey);
    expect(body.events).toEqual([
      { name: "world.entered", events: 4, sessions: 3 },
      { name: "breath.completed", events: 1, sessions: 1 },
    ]);
  });

  it("builds a zero-filled daily series", async () => {
    const { body } = await getJson(`/v1/stats/timeseries?${range}&interval=day`, p.readKey);
    expect(body.points).toEqual([
      { t: "2026-09-01T00:00:00.000Z", events: 4, sessions: 2 },
      { t: "2026-09-02T00:00:00.000Z", events: 2, sessions: 2 },
    ]);
  });

  it("builds an hourly series filtered by name, with explicit zeros", async () => {
    const { body } = await getJson(
      `/v1/stats/timeseries?from=${T0}&to=${T0 + 4 * HOUR}&interval=hour&name=world.entered`,
      p.readKey,
    );
    expect(body.points.map((x: any) => x.events)).toEqual([0, 1, 1, 0]);
  });

  it("lists event names", async () => {
    const { body } = await getJson(`/v1/stats/event-names`, p.readKey);
    expect(body.names.map((n: any) => n.name)).toEqual(["breath.completed", "world.entered", "world.exited"]);
  });

  it("validates ranges and parameters", async () => {
    expect((await getJson(`/v1/stats/summary?from=${T0}&to=${T0}`, p.readKey)).status).toBe(400);
    expect((await getJson(`/v1/stats/summary?from=yesterday`, p.readKey)).status).toBe(400);
    expect((await getJson(`/v1/stats/timeseries?${range}&interval=week`, p.readKey)).status).toBe(400);
    expect((await getJson(`/v1/stats/top-events?${range}&limit=0`, p.readKey)).status).toBe(400);
    const tooFine = await getJson(`/v1/stats/timeseries?from=${T0}&to=${T0 + 60 * 86_400_000}&interval=hour`, p.readKey);
    expect(tooFine.status).toBe(400);
  });

  it("refuses ingest keys on read endpoints", async () => {
    expect((await getJson(`/v1/stats/summary`, p.ingestKey)).status).toBe(403);
  });
});
