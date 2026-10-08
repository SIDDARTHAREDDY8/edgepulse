import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { runMaintenance } from "../src/maintenance";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 8, 3, 17); // cron time on 2026-10-08

async function project(id: string, retentionDays: number) {
  await env.DB.prepare("INSERT INTO projects (id, name, retention_days, created_at) VALUES (?1, ?1, ?2, 0)")
    .bind(id, retentionDays)
    .run();
}

async function insert(projectId: string, eventId: string, name: string, session: string, ts: number) {
  await env.DB.prepare(
    "INSERT INTO events (project_id, event_id, name, session_id, ts, received_at, props) VALUES (?1, ?2, ?3, ?4, ?5, ?5, '{}')",
  )
    .bind(projectId, eventId, name, session, ts)
    .run();
}

describe("scheduled maintenance", () => {
  it("rolls up recent days, recomputing (not double counting) on re-run", async () => {
    await project("roll", 365);
    const yesterday = Date.UTC(2026, 9, 7, 10);
    await insert("roll", "e1", "world.entered", "s1", yesterday);
    await insert("roll", "e2", "world.entered", "s2", yesterday + 1000);
    await insert("roll", "e3", "world.exited", "s1", yesterday + 2000);
    await insert("roll", "e4", "world.entered", "s3", NOW); // today: not rolled up yet

    await runMaintenance(env.DB, NOW);
    // A late event for yesterday arrives, then the job runs again.
    await insert("roll", "e5", "world.entered", "s4", yesterday + 3000);
    await runMaintenance(env.DB, NOW);

    const { results } = await env.DB.prepare(
      "SELECT day, name, events, sessions FROM daily_rollups WHERE project_id = 'roll' ORDER BY name",
    ).all();
    expect(results).toEqual([
      { day: "2026-10-07", name: "world.entered", events: 3, sessions: 3 },
      { day: "2026-10-07", name: "world.exited", events: 1, sessions: 1 },
    ]);
  });

  it("purges raw events past each project's own retention window", async () => {
    await project("short", 7);
    await project("long", 90);
    for (const p of ["short", "long"]) {
      await insert(p, `${p}_old`, "x", "s", NOW - 30 * DAY);
      await insert(p, `${p}_new`, "x", "s", NOW - 2 * DAY);
    }
    const report = await runMaintenance(env.DB, NOW);
    expect(report.purged_events).toBe(1);

    const { results } = await env.DB.prepare(
      "SELECT event_id FROM events WHERE project_id IN ('short','long') ORDER BY event_id",
    ).all<{ event_id: string }>();
    expect(results.map((r) => r.event_id)).toEqual(["long_new", "long_old", "short_new"]);
  });

  it("clears stale rate-limit windows", async () => {
    const currentWindow = Math.floor(NOW / 60_000);
    await env.DB.prepare("INSERT INTO rate_limits (bucket, window, count) VALUES ('k', ?1, 3), ('k', ?2, 3)")
      .bind(currentWindow - 60, currentWindow)
      .run();
    const report = await runMaintenance(env.DB, NOW);
    expect(report.purged_rate_windows).toBeGreaterThanOrEqual(1);
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM rate_limits WHERE bucket = 'k'").first<{ n: number }>();
    expect(left?.n).toBe(1);
  });
});
