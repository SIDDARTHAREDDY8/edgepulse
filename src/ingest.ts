import { HttpError } from "./http";
import type { EventError, ValidEvent } from "./types";
import { LIMITS, isEventError, validateEvent } from "./validation";

export interface IngestResult {
  accepted: number;
  duplicates: number;
  rejected: EventError[];
}

/**
 * Validates a batch and writes the valid events in one D1 transaction.
 *
 * Partial success is deliberate: one malformed event shouldn't cost a client
 * the other 99. Duplicates (same event_id) are counted but not re-written,
 * which makes client retries safe after a timeout.
 */
export async function ingestBatch(db: D1Database, projectId: string, body: unknown): Promise<IngestResult> {
  const raw = Array.isArray(body)
    ? body
    : typeof body === "object" && body !== null && Array.isArray((body as { events?: unknown }).events)
      ? (body as { events: unknown[] }).events
      : null;

  if (raw === null) {
    throw new HttpError(400, "invalid_body", 'Body must be {"events": [...]} or a JSON array of events');
  }
  if (raw.length === 0) throw new HttpError(400, "empty_batch", "Batch contains no events");
  if (raw.length > LIMITS.maxBatch) {
    throw new HttpError(413, "batch_too_large", `A batch may contain at most ${LIMITS.maxBatch} events`);
  }

  const now = Date.now();
  const valid: ValidEvent[] = [];
  const rejected: EventError[] = [];
  const seen = new Set<string>();

  raw.forEach((item, index) => {
    const result = validateEvent(item, index, now);
    if (isEventError(result)) {
      rejected.push(result);
    } else if (seen.has(result.event_id)) {
      rejected.push({ index, event_id: result.event_id, errors: ["duplicate event_id within this batch"] });
    } else {
      seen.add(result.event_id);
      valid.push(result);
    }
  });

  if (valid.length === 0) return { accepted: 0, duplicates: 0, rejected };

  const insert = db.prepare(
    `INSERT INTO events (project_id, event_id, name, session_id, ts, received_at, props)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT (project_id, event_id) DO NOTHING`,
  );
  const results = await db.batch(
    valid.map((e) => insert.bind(projectId, e.event_id, e.name, e.session_id, e.ts, now, JSON.stringify(e.props))),
  );

  const accepted = results.reduce((sum, r) => sum + (r.meta.changes ?? 0), 0);
  return { accepted, duplicates: valid.length - accepted, rejected };
}
