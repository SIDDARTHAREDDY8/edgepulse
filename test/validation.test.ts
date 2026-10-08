import { describe, expect, it } from "vitest";
import { isEventError, piiReason, validateEvent } from "../src/validation";

const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);
const base = { event_id: "evt_12345678", name: "world.entered", session_id: "sess_abcdef12" };

describe("validateEvent", () => {
  it("accepts a minimal event and defaults ts to receive time", () => {
    const result = validateEvent(base, 0, NOW);
    expect(isEventError(result)).toBe(false);
    expect(result).toMatchObject({ ...base, ts: NOW, props: {} });
  });

  it("accepts ISO and epoch timestamps within the allowed window", () => {
    const iso = validateEvent({ ...base, ts: "2026-10-08T11:00:00Z" }, 0, NOW);
    const epoch = validateEvent({ ...base, ts: NOW - 60_000 }, 0, NOW);
    expect(iso).toMatchObject({ ts: Date.UTC(2026, 9, 8, 11) });
    expect(epoch).toMatchObject({ ts: NOW - 60_000 });
  });

  it("rejects timestamps far in the future or past", () => {
    const future = validateEvent({ ...base, ts: NOW + 10 * 60_000 }, 0, NOW);
    const past = validateEvent({ ...base, ts: NOW - 8 * 86_400_000 }, 0, NOW);
    expect(isEventError(future) && future.errors[0]).toMatch(/future/);
    expect(isEventError(past) && past.errors[0]).toMatch(/past/);
  });

  it("reports every problem with an event at once", () => {
    const result = validateEvent({ event_id: "x", name: "Bad Name", session_id: "a b" }, 3, NOW);
    expect(isEventError(result)).toBe(true);
    if (isEventError(result)) {
      expect(result.index).toBe(3);
      expect(result.errors).toHaveLength(3);
    }
  });

  it("refuses property keys that name personal data", () => {
    const result = validateEvent({ ...base, props: { email: "x", patient_id: "123", level: 3 } }, 0, NOW);
    expect(isEventError(result) && result.errors).toEqual([
      expect.stringContaining("props.email"),
      expect.stringContaining("props.patient_id"),
    ]);
  });

  it("refuses PII hiding under an innocent key", () => {
    const result = validateEvent({ ...base, props: { note: "reach me at jane@hospital.org" } }, 0, NOW);
    expect(isEventError(result) && result.errors[0]).toMatch(/email address/);
  });

  it("refuses nested objects and oversized strings", () => {
    const result = validateEvent({ ...base, props: { meta: { a: 1 }, text: "x".repeat(201) } }, 0, NOW);
    expect(isEventError(result) && result.errors).toHaveLength(2);
  });

  it("keeps clean primitive props", () => {
    const result = validateEvent({ ...base, props: { world: "temple", seconds: 312.5, completed: true } }, 0, NOW);
    expect(result).toMatchObject({ props: { world: "temple", seconds: 312.5, completed: true } });
  });
});

describe("piiReason", () => {
  it.each([
    ["sam@example.com", "an email address"],
    ["10.0.0.12", "an IPv4 address"],
    ["2001:0db8:85a3:0000:0000:8a2e:0370:7334", "an IPv6 address"],
    ["+1 (513) 555-0142", "a phone number"],
    ["513.555.0142", "a phone number"],
    ["+44 20 7946 0958", "a phone number"],
    ["123-45-6789", "a US SSN"],
  ])("flags %s as %s", (value, label) => {
    expect(piiReason(value)).toBe(label);
  });

  it.each(["temple", "ward_4b", "v1.2.3", "night-shift", "2026-10-08", "2026-10-08T12:30:00Z", "build 4521"])("lets %s through", (value) => {
    expect(piiReason(value)).toBeNull();
  });
});
