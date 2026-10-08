/**
 * Read-side queries. Shared by the REST API and the MCP tools, so an AI agent
 * and a dashboard always see exactly the same numbers.
 */

export interface Range {
  from: number;
  to: number;
}

export type Interval = "hour" | "day";
const INTERVAL_MS: Record<Interval, number> = { hour: 3_600_000, day: 86_400_000 };
const MAX_BUCKETS = 1000;

export function defaultRange(now = Date.now()): Range {
  return { from: now - 7 * 86_400_000, to: now };
}

export function checkRange(range: Range): string | null {
  if (range.from >= range.to) return "from must be earlier than to";
  if (range.to - range.from > 366 * 86_400_000) return "range may span at most 366 days";
  return null;
}

export async function summary(db: D1Database, projectId: string, range: Range) {
  const totals = await db
    .prepare(
      `SELECT COUNT(*) AS events, COUNT(DISTINCT session_id) AS sessions, COUNT(DISTINCT name) AS event_names
       FROM events WHERE project_id = ?1 AND ts >= ?2 AND ts < ?3`,
    )
    .bind(projectId, range.from, range.to)
    .first<{ events: number; sessions: number; event_names: number }>();

  // Session length = time between a session's first and last event.
  const sessionStats = await db
    .prepare(
      `SELECT AVG(span) AS avg_ms, MAX(span) AS max_ms FROM (
         SELECT MAX(ts) - MIN(ts) AS span FROM events
         WHERE project_id = ?1 AND ts >= ?2 AND ts < ?3
         GROUP BY session_id
       )`,
    )
    .bind(projectId, range.from, range.to)
    .first<{ avg_ms: number | null; max_ms: number | null }>();

  return {
    range: { from: new Date(range.from).toISOString(), to: new Date(range.to).toISOString() },
    events: totals?.events ?? 0,
    sessions: totals?.sessions ?? 0,
    event_names: totals?.event_names ?? 0,
    avg_session_seconds: sessionStats?.avg_ms == null ? null : Math.round(sessionStats.avg_ms / 100) / 10,
    max_session_seconds: sessionStats?.max_ms == null ? null : Math.round(sessionStats.max_ms / 100) / 10,
  };
}

export async function topEvents(db: D1Database, projectId: string, range: Range, limit = 10) {
  const { results } = await db
    .prepare(
      `SELECT name, COUNT(*) AS events, COUNT(DISTINCT session_id) AS sessions
       FROM events WHERE project_id = ?1 AND ts >= ?2 AND ts < ?3
       GROUP BY name ORDER BY events DESC, name ASC LIMIT ?4`,
    )
    .bind(projectId, range.from, range.to, Math.min(Math.max(limit, 1), 100))
    .all<{ name: string; events: number; sessions: number }>();
  return { range: isoRange(range), events: results };
}

/** Zero-filled series, so charts and agents never have to guess about gaps. */
export async function timeseries(db: D1Database, projectId: string, range: Range, interval: Interval, name?: string) {
  const size = INTERVAL_MS[interval];
  const start = Math.floor(range.from / size) * size;
  const buckets = Math.ceil((range.to - start) / size);
  if (buckets > MAX_BUCKETS) {
    throw new RangeError(`range produces ${buckets} ${interval} buckets; max is ${MAX_BUCKETS}. Use a coarser interval.`);
  }

  const nameFilter = name ? "AND name = ?5" : "";
  const stmt = db.prepare(
    // CAST matters: D1 may bind JS numbers as REAL, which would turn this into
    // float division and silently put every event in its own bucket.
    `SELECT (ts / CAST(?4 AS INTEGER)) * CAST(?4 AS INTEGER) AS bucket, COUNT(*) AS events, COUNT(DISTINCT session_id) AS sessions
     FROM events WHERE project_id = ?1 AND ts >= ?2 AND ts < ?3 ${nameFilter}
     GROUP BY bucket ORDER BY bucket`,
  );
  const bound = name
    ? stmt.bind(projectId, range.from, range.to, size, name)
    : stmt.bind(projectId, range.from, range.to, size);
  const { results } = await bound.all<{ bucket: number; events: number; sessions: number }>();

  const byBucket = new Map(results.map((r) => [r.bucket, r]));
  const points = [];
  for (let i = 0; i < buckets; i++) {
    const t = start + i * size;
    const hit = byBucket.get(t);
    points.push({ t: new Date(t).toISOString(), events: hit?.events ?? 0, sessions: hit?.sessions ?? 0 });
  }
  return { range: isoRange(range), interval, name: name ?? null, points };
}

export async function eventNames(db: D1Database, projectId: string) {
  const { results } = await db
    .prepare(
      `SELECT name, MAX(ts) AS last_seen FROM events WHERE project_id = ?1
       GROUP BY name ORDER BY name LIMIT 500`,
    )
    .bind(projectId)
    .all<{ name: string; last_seen: number }>();
  return { names: results.map((r) => ({ name: r.name, last_seen: new Date(r.last_seen).toISOString() })) };
}

/** Long-range history from the cron-built rollups (survives raw-event retention). */
export async function dailyHistory(db: D1Database, projectId: string, fromDay: string, toDay: string) {
  const { results } = await db
    .prepare(
      `SELECT day, SUM(events) AS events FROM daily_rollups
       WHERE project_id = ?1 AND day >= ?2 AND day <= ?3
       GROUP BY day ORDER BY day`,
    )
    .bind(projectId, fromDay, toDay)
    .all<{ day: string; events: number }>();
  return { from: fromDay, to: toDay, days: results };
}

function isoRange(range: Range) {
  return { from: new Date(range.from).toISOString(), to: new Date(range.to).toISOString() };
}
