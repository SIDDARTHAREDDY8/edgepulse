-- EdgePulse schema v1
-- Design rules:
--   * No column ever stores an IP address, user agent, or user identifier.
--   * Every event row is scoped to a project; every index leads with project_id.
--   * (project_id, event_id) is the primary key, so client retries are idempotent.

CREATE TABLE projects (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  retention_days  INTEGER NOT NULL DEFAULT 90 CHECK (retention_days BETWEEN 1 AND 3650),
  created_at      INTEGER NOT NULL
);

-- Raw keys are shown once at creation and never stored; only SHA-256 hashes live here.
-- scope = 'ingest' keys are safe to embed in a client build (write-only);
-- scope = 'read' keys unlock the stats API and the MCP endpoint.
CREATE TABLE api_keys (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key_hash    TEXT NOT NULL UNIQUE,
  prefix      TEXT NOT NULL,
  scope       TEXT NOT NULL CHECK (scope IN ('ingest', 'read')),
  created_at  INTEGER NOT NULL,
  revoked_at  INTEGER
);
CREATE INDEX idx_api_keys_project ON api_keys (project_id);

CREATE TABLE events (
  project_id   TEXT NOT NULL,
  event_id     TEXT NOT NULL,
  name         TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  ts           INTEGER NOT NULL,   -- client event time, epoch ms (validated + clamped server-side)
  received_at  INTEGER NOT NULL,   -- server receive time, epoch ms
  props        TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (project_id, event_id)
) WITHOUT ROWID;
CREATE INDEX idx_events_project_ts      ON events (project_id, ts);
CREATE INDEX idx_events_project_name_ts ON events (project_id, name, ts);

-- Daily aggregates written by the cron trigger. They outlive raw-event retention,
-- so long-range history stays queryable after raw rows are purged.
CREATE TABLE daily_rollups (
  project_id  TEXT NOT NULL,
  day         TEXT NOT NULL,       -- YYYY-MM-DD (UTC)
  name        TEXT NOT NULL,
  events      INTEGER NOT NULL,
  sessions    INTEGER NOT NULL,
  PRIMARY KEY (project_id, day, name)
) WITHOUT ROWID;

-- Fixed-window rate limiter state (one row per key per minute).
CREATE TABLE rate_limits (
  bucket      TEXT NOT NULL,
  window      INTEGER NOT NULL,
  count       INTEGER NOT NULL,
  PRIMARY KEY (bucket, window)
) WITHOUT ROWID;
