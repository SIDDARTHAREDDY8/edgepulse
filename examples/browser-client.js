/**
 * Minimal browser client for EdgePulse: anonymous sessions, batching,
 * idempotent retries, and a flush when the page is hidden.
 *
 *   const pulse = createPulse({ endpoint: "https://edgepulse.example.workers.dev", key: "ep_ing_..." });
 *   pulse.track("world.entered", { world: "temple" });
 */
export function createPulse({ endpoint, key, flushEvery = 5000, maxBatch = 100 }) {
  // A fresh random token per page session. Never derived from a person.
  const sessionId = "sess_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  let queue = [];

  function track(name, props = {}) {
    queue.push({ event_id: crypto.randomUUID(), name, session_id: sessionId, ts: Date.now(), props });
    if (queue.length >= maxBatch) flush();
  }

  async function flush({ keepalive = false } = {}) {
    if (queue.length === 0) return;
    const batch = queue.splice(0, maxBatch);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(`${endpoint}/v1/events`, {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({ events: batch }),
          keepalive,
        });
        if (res.status === 429) {
          await new Promise((r) => setTimeout(r, Number(res.headers.get("retry-after") ?? 5) * 1000));
          continue;
        }
        if (res.status >= 500) throw new Error(String(res.status));
        return; // 202/207/422: the server has decided; retrying would not change it.
      } catch {
        // Same event_ids on retry, so the server de-duplicates anything that already landed.
        await new Promise((r) => setTimeout(r, 2 ** attempt * 500));
      }
    }
    queue = batch.concat(queue); // give up for now; try again on the next flush
  }

  setInterval(flush, flushEvery);
  addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush({ keepalive: true });
  });

  return { track, flush, sessionId };
}
