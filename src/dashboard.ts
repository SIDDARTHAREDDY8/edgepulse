/**
 * A dependency-free dashboard served from the Worker itself at GET /.
 * The read key stays in the tab's sessionStorage and is sent only to this origin.
 */
export const DASHBOARD_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>EdgePulse</title>
<style>
  :root { --bg:#0e1116; --panel:#161b22; --line:#262d36; --text:#e6edf3; --muted:#8b949e; --accent:#4fd1c5; --bar:#2c7a7b; }
  @media (prefers-color-scheme: light) { :root { --bg:#f6f8fa; --panel:#fff; --line:#d0d7de; --text:#1f2328; --muted:#57606a; --accent:#0f766e; --bar:#5eead4; } }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
  main { max-width:960px; margin:0 auto; padding:32px 16px 64px; }
  header { display:flex; align-items:baseline; gap:12px; flex-wrap:wrap; margin-bottom:24px; }
  h1 { margin:0; font-size:22px; letter-spacing:-.01em; }
  h1 span { color:var(--accent); }
  header p { margin:0; color:var(--muted); }
  form { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:24px; }
  input, select, button { font:inherit; color:var(--text); background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:8px 12px; }
  input { flex:1 1 280px; font-family:ui-monospace,monospace; font-size:13px; }
  button { background:var(--accent); color:#04201d; border-color:transparent; font-weight:600; cursor:pointer; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:12px; margin-bottom:16px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:16px; }
  .k { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.06em; }
  .v { font-size:28px; font-weight:650; font-variant-numeric:tabular-nums; }
  h2 { font-size:14px; margin:0 0 12px; color:var(--muted); font-weight:600; }
  svg { width:100%; height:200px; display:block; font-family:inherit; }
  table { width:100%; border-collapse:collapse; font-variant-numeric:tabular-nums; }
  td, th { padding:6px 0; border-bottom:1px solid var(--line); text-align:left; }
  td:not(:first-child), th:not(:first-child) { text-align:right; }
  th { color:var(--muted); font-weight:500; font-size:12px; }
  #err { color:#f87171; min-height:1.5em; }
  .hidden { display:none; }
</style>
</head>
<body>
<main>
  <header><h1>Edge<span>Pulse</span></h1><p>Privacy-first event analytics on the edge. No personal data, ever.</p></header>
  <form id="f">
    <input id="key" type="password" placeholder="Read key (ep_read_…)" autocomplete="off" required>
    <select id="days"><option value="1">24 hours</option><option value="7" selected>7 days</option><option value="30">30 days</option></select>
    <button>Load</button>
  </form>
  <div id="err" role="alert"></div>
  <section id="out" class="hidden">
    <div class="grid">
      <div class="card"><div class="k">Events</div><div class="v" id="events">–</div></div>
      <div class="card"><div class="k">Sessions</div><div class="v" id="sessions">–</div></div>
      <div class="card"><div class="k">Avg session</div><div class="v" id="avg">–</div></div>
      <div class="card"><div class="k">Event types</div><div class="v" id="names">–</div></div>
    </div>
    <div class="card" style="margin-bottom:16px"><h2>Events over time</h2><svg id="chart" role="img" aria-label="Events over time"></svg></div>
    <div class="card"><h2>Top events</h2><table><thead><tr><th>Event</th><th>Count</th><th>Sessions</th></tr></thead><tbody id="top"></tbody></table></div>
  </section>
</main>
<script>
const $ = (id) => document.getElementById(id);
try { $("key").value = sessionStorage.getItem("ep_key") || ""; } catch {}
const fmt = (n) => n == null ? "–" : Number(n).toLocaleString();
function dur(s) {
  if (s == null) return "–";
  if (s < 60) return Math.round(s) + "s";
  if (s < 3600) return Math.floor(s / 60) + "m " + Math.round(s % 60) + "s";
  if (s < 86400) return Math.floor(s / 3600) + "h " + Math.round((s % 3600) / 60) + "m";
  return Math.floor(s / 86400) + "d " + Math.round((s % 86400) / 3600) + "h";
}

async function get(path, key) {
  const res = await fetch(path, { headers: { authorization: "Bearer " + key } });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ? body.error.message : res.statusText);
  return body;
}

function draw(points, interval) {
  const svg = $("chart"), W = 900, H = 200, top = 18, base = H - 22;
  svg.setAttribute("viewBox", "0 0 " + W + " " + H);
  const max = Math.max(1, ...points.map((p) => p.events));
  const bw = W / points.length;
  const every = Math.ceil(points.length / 12);
  const label = (t) => {
    const d = new Date(t);
    return interval === "hour"
      ? d.toLocaleTimeString([], { hour: "numeric" })
      : d.toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" });
  };
  svg.innerHTML = points.map((p, i) => {
    const h = Math.max(p.events ? 2 : 0, (p.events / max) * (base - top));
    const x = i * bw;
    let out = '<rect x="' + (x + 2) + '" y="' + (base - h) + '" width="' + Math.max(1, bw - 4) +
      '" height="' + h + '" rx="3" fill="var(--bar)"><title>' + label(p.t) + " — " + p.events + " events, " +
      p.sessions + ' sessions</title></rect>';
    if (p.events && bw > 40) out += '<text x="' + (x + bw / 2) + '" y="' + (base - h - 5) +
      '" text-anchor="middle" font-size="11" fill="var(--muted)">' + p.events + "</text>";
    if (i % every === 0) out += '<text x="' + (x + bw / 2) + '" y="' + (H - 4) +
      '" text-anchor="middle" font-size="11" fill="var(--muted)">' + label(p.t) + "</text>";
    return out;
  }).join("") + '<line x1="0" x2="' + W + '" y1="' + base + '" y2="' + base + '" stroke="var(--line)"/>';
}

$("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  const key = $("key").value.trim(), days = Number($("days").value);
  try { sessionStorage.setItem("ep_key", key); } catch {}
  const to = Date.now(), from = to - days * 86400000, q = "?from=" + from + "&to=" + to;
  $("err").textContent = "";
  try {
    const [s, top, ts] = await Promise.all([
      get("/v1/stats/summary" + q, key),
      get("/v1/stats/top-events" + q + "&limit=10", key),
      get("/v1/stats/timeseries" + q + "&interval=" + (days > 2 ? "day" : "hour"), key),
    ]);
    $("events").textContent = fmt(s.events);
    $("sessions").textContent = fmt(s.sessions);
    $("avg").textContent = dur(s.avg_session_seconds);
    $("names").textContent = fmt(s.event_names);
    $("top").innerHTML = top.events.map((r) => {
      const td = document.createElement("td"); td.textContent = r.name;
      return "<tr>" + td.outerHTML + "<td>" + fmt(r.events) + "</td><td>" + fmt(r.sessions) + "</td></tr>";
    }).join("") || '<tr><td colspan="3">No events in this range yet.</td></tr>';
    draw(ts.points, ts.interval);
    $("out").classList.remove("hidden");
  } catch (err) { $("err").textContent = err.message; }
});
</script>
</body>
</html>`;
