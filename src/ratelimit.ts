import { HttpError } from "./http";

const WINDOW_MS = 60_000;

/**
 * Fixed-window limiter backed by D1: one atomic UPSERT ... RETURNING per request.
 *
 * Trade-off: D1 adds a round trip, but the count is exact and global across
 * every edge location. For very high traffic, swap this for the Workers Rate
 * Limiting binding (approximate, per-location, but zero-latency).
 */
export async function enforceRateLimit(db: D1Database, bucket: string, limit: number, now = Date.now()): Promise<void> {
  const window = Math.floor(now / WINDOW_MS);
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (bucket, window, count) VALUES (?1, ?2, 1)
       ON CONFLICT (bucket, window) DO UPDATE SET count = count + 1
       RETURNING count`,
    )
    .bind(bucket, window)
    .first<{ count: number }>();

  if (row && row.count > limit) {
    const retryAfter = Math.ceil(((window + 1) * WINDOW_MS - now) / 1000);
    throw new HttpError(429, "rate_limited", `Rate limit of ${limit} requests/minute exceeded`, undefined, {
      "retry-after": String(retryAfter),
    });
  }
}
