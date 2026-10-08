/**
 * Cron-triggered maintenance (see `triggers.crons` in wrangler.jsonc):
 *   1. Roll raw events up into per-day, per-name aggregates.
 *   2. Purge raw events older than each project's retention window.
 *   3. Drop stale rate-limiter windows.
 *
 * Every step is idempotent, so a retried or overlapping run is harmless.
 */
const DAY_MS = 86_400_000;

export interface MaintenanceReport {
  rolled_up_days: number;
  purged_events: number;
  purged_rate_windows: number;
}

export function dayString(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export async function runMaintenance(db: D1Database, now = Date.now(), lookbackDays = 3): Promise<MaintenanceReport> {
  const todayStart = Math.floor(now / DAY_MS) * DAY_MS;

  // Re-roll the last few complete days: late-arriving events (ts up to 7 days
  // old is accepted) are folded in without double counting, because each
  // (project, day, name) row is fully recomputed and overwritten.
  const statements = [];
  for (let d = 1; d <= lookbackDays; d++) {
    const dayStart = todayStart - d * DAY_MS;
    statements.push(
      db
        .prepare(
          `INSERT INTO daily_rollups (project_id, day, name, events, sessions)
           SELECT project_id, ?1, name, COUNT(*), COUNT(DISTINCT session_id)
           FROM events WHERE ts >= ?2 AND ts < ?3
           GROUP BY project_id, name
           ON CONFLICT (project_id, day, name) DO UPDATE SET
             events = excluded.events, sessions = excluded.sessions`,
        )
        .bind(dayString(dayStart), dayStart, dayStart + DAY_MS),
    );
  }

  const purgeEvents = db
    .prepare(
      `DELETE FROM events WHERE (project_id, event_id) IN (
         SELECT e.project_id, e.event_id FROM events e
         JOIN projects p ON p.id = e.project_id
         WHERE e.ts < ?1 - p.retention_days * ${DAY_MS}
         LIMIT 50000
       )`,
    )
    .bind(todayStart);
  const purgeWindows = db.prepare("DELETE FROM rate_limits WHERE window < ?1").bind(Math.floor(now / 60_000) - 5);

  const results = await db.batch([...statements, purgeEvents, purgeWindows]);
  return {
    rolled_up_days: lookbackDays,
    purged_events: results[statements.length].meta.changes ?? 0,
    purged_rate_windows: results[statements.length + 1].meta.changes ?? 0,
  };
}
