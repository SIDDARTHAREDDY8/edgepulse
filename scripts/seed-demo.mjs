#!/usr/bin/env node
/**
 * Seeds a project with a week of realistic demo traffic: short, anonymous
 * "five minute break" sessions in an immersive world.
 *
 *   node scripts/seed-demo.mjs <base-url> <ingest-key> [sessions-per-day]
 *   node scripts/seed-demo.mjs http://localhost:8787 ep_ing_xxx 40
 */
const [base, key, perDayArg] = process.argv.slice(2);
if (!base || !key) {
  console.error("usage: node scripts/seed-demo.mjs <base-url> <ingest-key> [sessions-per-day]");
  process.exit(1);
}
const perDay = Number(perDayArg ?? 40);
const DAY = 86_400_000;
const worlds = ["temple", "forest", "shoreline", "night_sky"];
const rand = (min, max) => min + Math.random() * (max - min);
const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];
const sessionId = () => "sess_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);

const events = [];
const now = Date.now();
for (let d = 6; d >= 0; d--) {
  // Weekday-ish shape: busier mid-week, quieter at the edges.
  const sessions = Math.round(perDay * (0.6 + 0.8 * Math.sin(((6 - d) / 6) * Math.PI)));
  for (let s = 0; s < sessions; s++) {
    const id = sessionId();
    const world = pick(worlds);
    let t = now - d * DAY - rand(0, d === 0 ? 0.4 * DAY : DAY);
    const length = rand(150, 330) * 1000; // 2.5–5.5 minutes
    const end = t + length;
    const push = (name, props = {}) =>
      events.push({ event_id: crypto.randomUUID(), name, session_id: id, ts: Math.round(t), props: { world, ...props } });

    push("world.entered");
    if (Math.random() < 0.5) push("ambient.toggled", { sound: pick(["rain", "birds", "waves", "off"]) });
    const breaths = Math.floor(rand(0, 4));
    for (let b = 0; b < breaths; b++) {
      t += rand(30, 70) * 1000;
      if (t < end) push("breath.completed", { cycle: b + 1 });
    }
    t = end;
    push("world.exited", { seconds: Math.round(length / 1000) });
  }
}

let accepted = 0;
for (let i = 0; i < events.length; i += 100) {
  const res = await fetch(`${base}/v1/events`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ events: events.slice(i, i + 100) }),
  });
  const body = await res.json();
  if (!res.ok && res.status !== 207) throw new Error(`${res.status}: ${JSON.stringify(body)}`);
  accepted += body.accepted;
}
console.log(`Sent ${events.length} events, ${accepted} accepted.`);
