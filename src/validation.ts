import type { EventError, ValidEvent } from "./types";

export const LIMITS = {
  maxBatch: 100,
  maxBodyBytes: 256 * 1024,
  maxProps: 20,
  maxStringValue: 200,
  maxFutureSkewMs: 5 * 60 * 1000,
  maxPastMs: 7 * 24 * 60 * 60 * 1000,
} as const;

const EVENT_NAME = /^[a-z][a-z0-9_.:-]{0,63}$/;
const PROP_KEY = /^[a-z][a-z0-9_]{0,39}$/;
const EVENT_ID = /^[A-Za-z0-9_-]{8,64}$/;
// Session IDs must be opaque random tokens. Anything shaped like an email or
// containing whitespace is rejected before it can reach storage.
const SESSION_ID = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Privacy guard. Property keys that name personal data are refused outright,
 * and string values that look like personal data are refused even under an
 * innocent key. The goal is that nothing identifying can be stored by accident.
 */
const DENYLISTED_KEYS = new Set([
  "email", "e_mail", "mail", "phone", "phone_number", "mobile", "ip", "ip_address",
  "name", "first_name", "last_name", "full_name", "username", "user_name", "user_id",
  "userid", "ssn", "dob", "date_of_birth", "address", "street", "zip", "postcode",
  "mrn", "patient_id", "patient_name", "device_id", "idfa", "gaid", "lat", "lng",
  "latitude", "longitude", "location",
]);

const PII_VALUE_PATTERNS: Array<[RegExp, string]> = [
  [/[^\s@]+@[^\s@]+\.[^\s@]{2,}/, "an email address"],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/, "an IPv4 address"],
  [/\b(?:[0-9a-f]{1,4}:){4,7}[0-9a-f]{1,4}\b/i, "an IPv6 address"],
  [/\+\d[\d\s().-]{8,17}\d/, "a phone number"], // international, e.g. +44 20 7946 0958
  [/\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/, "a phone number"], // North American, e.g. (513) 555-0142
  [/\b\d{10,15}\b/, "a phone number"], // bare digit runs (send numeric values as JSON numbers instead)
  [/\b\d{3}-\d{2}-\d{4}\b/, "a US SSN"],
];

export function piiReason(value: string): string | null {
  for (const [pattern, label] of PII_VALUE_PATTERNS) {
    if (pattern.test(value)) return label;
  }
  return null;
}

function parseTs(raw: unknown, now: number): { ts?: number; error?: string } {
  if (raw === undefined || raw === null) return { ts: now };
  const ms = typeof raw === "number" ? raw : typeof raw === "string" ? Date.parse(raw) : NaN;
  if (!Number.isFinite(ms)) return { error: "ts must be epoch milliseconds or an ISO-8601 string" };
  if (ms > now + LIMITS.maxFutureSkewMs) return { error: "ts is more than 5 minutes in the future" };
  if (ms < now - LIMITS.maxPastMs) return { error: "ts is more than 7 days in the past" };
  return { ts: Math.trunc(ms) };
}

export function validateEvent(raw: unknown, index: number, now: number): ValidEvent | EventError {
  const errors: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { index, errors: ["event must be a JSON object"] };
  }
  const e = raw as Record<string, unknown>;
  const eventId = typeof e.event_id === "string" ? e.event_id : undefined;

  if (!eventId || !EVENT_ID.test(eventId)) {
    errors.push("event_id is required: 8-64 chars of [A-Za-z0-9_-] (a UUID works)");
  }
  if (typeof e.name !== "string" || !EVENT_NAME.test(e.name)) {
    errors.push("name is required: lowercase, starts with a letter, max 64 chars of [a-z0-9_.:-]");
  }
  if (typeof e.session_id !== "string" || !SESSION_ID.test(e.session_id)) {
    errors.push("session_id is required: an opaque 8-64 char token of [A-Za-z0-9_-]");
  }

  const { ts, error: tsError } = parseTs(e.ts, now);
  if (tsError) errors.push(tsError);

  const props: Record<string, string | number | boolean> = {};
  if (e.props !== undefined) {
    if (typeof e.props !== "object" || e.props === null || Array.isArray(e.props)) {
      errors.push("props must be a flat JSON object");
    } else {
      const entries = Object.entries(e.props as Record<string, unknown>);
      if (entries.length > LIMITS.maxProps) errors.push(`props may have at most ${LIMITS.maxProps} keys`);
      for (const [key, value] of entries.slice(0, LIMITS.maxProps)) {
        if (!PROP_KEY.test(key)) {
          errors.push(`props.${key}: keys must be snake_case, max 40 chars`);
          continue;
        }
        if (DENYLISTED_KEYS.has(key)) {
          errors.push(`props.${key}: this key names personal data and is not accepted`);
          continue;
        }
        if (typeof value === "string") {
          if (value.length > LIMITS.maxStringValue) {
            errors.push(`props.${key}: string values max ${LIMITS.maxStringValue} chars`);
            continue;
          }
          const reason = piiReason(value);
          if (reason) {
            errors.push(`props.${key}: value looks like ${reason} and is not accepted`);
            continue;
          }
          props[key] = value;
        } else if (typeof value === "number") {
          if (!Number.isFinite(value)) errors.push(`props.${key}: numbers must be finite`);
          else props[key] = value;
        } else if (typeof value === "boolean") {
          props[key] = value;
        } else {
          errors.push(`props.${key}: values must be string, number, or boolean (no nesting)`);
        }
      }
    }
  }

  if (errors.length > 0) return { index, event_id: eventId, errors };
  return {
    event_id: eventId!,
    name: e.name as string,
    session_id: e.session_id as string,
    ts: ts!,
    props,
  };
}

export function isEventError(v: ValidEvent | EventError): v is EventError {
  return "errors" in v;
}
