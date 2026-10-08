export interface Env {
  DB: D1Database;
  /** Secret used for project/key administration. Set with `wrangler secret put ADMIN_TOKEN`. */
  ADMIN_TOKEN: string;
  /** Max ingest requests per key per minute (string because it comes from [vars]). */
  RATE_LIMIT_PER_MINUTE?: string;
  /** Comma-separated list of allowed CORS origins, or "*". */
  ALLOWED_ORIGINS?: string;
}

export type KeyScope = "ingest" | "read";

export interface AuthContext {
  projectId: string;
  keyId: string;
  scope: KeyScope;
}

export interface IncomingEvent {
  event_id: string;
  name: string;
  session_id: string;
  ts?: number | string;
  props?: Record<string, unknown>;
}

export interface ValidEvent {
  event_id: string;
  name: string;
  session_id: string;
  ts: number;
  props: Record<string, string | number | boolean>;
}

export interface EventError {
  index: number;
  event_id?: string;
  errors: string[];
}
