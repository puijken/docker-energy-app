// Energy app front end: no build step, no framework. One EventSource feeds every number.
// Rules shown on screen: only measured values in tiles (calculated and forecast numbers say so with a
// chip and "≈"), every
// value says whether it is live or "vandaag 00:00 – nu", and an empty value is "—" with a reason.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const fmt = {};
for (const d of [0, 1, 2, 3, 4, 5]) fmt[d] = new Intl.NumberFormat("nl-NL", { minimumFractionDigits: d, maximumFractionDigits: d });
const isNum = (x) => typeof x === "number" && Number.isFinite(x);
// Charge-level colours, shared by the battery bars (Thuis, Batterij) and the Laadniveau vandaag chart:
// green from 50 %, amber from 20 %, red below.
const SOC_GREEN = 50, SOC_RED = 20;
const socColor = (v) => (!isNum(v) ? "--bat" : v >= SOC_GREEN ? "--ok" : v >= SOC_RED ? "--warn" : "--bad");
const num =(x, d = 1) => (isNum(x) ? fmt[d].format(x) : "—");
const unit = (text, u) => (text === "—" ? "—" : `${text}<small>${u}</small>`);
const kwh = (x, d = 1) => unit(num(x, d), "kWh");
const eur = (x, d = 2) => (isNum(x) ? `${x < 0 ? "−" : ""}€\u00a0${fmt[d].format(Math.abs(x))}` : "—");
const pct = (x) => (isNum(x) ? unit(fmt[0].format(x * 100), "%") : "—");
function power(w) {
  if (!isNum(w)) return "—";
  const a = Math.abs(w);
  return a < 1000 ? unit(fmt[0].format(w), "W") : unit(fmt[a < 10000 ? 2 : 1].format(w / 1000), "kW");
}
const plain = (html) => html.replace(/<small>/g, " ").replace(/<\/small>/g, "");
let TZ = "Europe/Amsterdam"; // replaced by the server's TZ from /api/config
const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: TZ }) : "—");
const hm = (iso) => (iso ? new Date(iso).toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit", timeZone: TZ }) : "—");
function ago(seconds) {
  if (!isNum(seconds)) return "geen meting";
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))} s geleden`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min geleden`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} uur geleden`;
  return "langer dan een dag geleden";
}

const state = { config: { links: {}, plugLabels: {}, liveInterval: 5, staleAfter: {} }, live: null, today: null, liveAt: 0, cached: false, auth: "ok" };
const wallMode = new URLSearchParams(location.search).has("kiosk");

// ---------- flow picture: who feeds whom (app_live.flow_*_w, derived in SQL from measurements) ----------
// Laid out like Grafana's Stroomschema: sun on top, grid left, house right, battery at the bottom, gas and
// the outdoor temperature (plain text) in the top corners. Every pair has its own line; idle routes stay as faint grey
// dashes so the picture keeps its shape. Green = solar going somewhere; red = drawn from the grid or the
// battery. Each circle: icon, today's kWh, the live value.
const FLOW_R = 46;
const FLOW_LINES = [
  // name, path (source -> target), label x, y, anchor
  ["sun-bat", "M180 104 L180 210", 187, 136, "start"],
  ["sun-house", "M215 89 Q212 131 271 121", 237, 110, "start"],
  ["sun-grid", "M145 89 Q148 131 89 121", 123, 110, "end"],
  ["bat-house", "M215 227 Q212 185 271 195", 237, 210, "start"],
  ["bat-grid", "M145 227 Q148 185 89 195", 123, 210, "end"],
  ["grid-house", "M102 158 L256 158", 130, 151, "middle"],
];
const FLOW_ICONS = {
  zon: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/>',
  huis: '<path d="M3 11 12 3.5 21 11"/><path d="M5.5 9.5V20h13V9.5"/><path d="M10 20v-5.5h4V20"/>',
  net: '<path d="M13 2.5 4.5 13.5H11L10 21.5l8.5-11H12z"/>',
  bat: '<rect x="2.5" y="7" width="16.5" height="10" rx="2"/><path d="M21.5 10.5v3"/><path d="M11.5 8.8 9 12.2h3.5L10 15.6"/>',
  gas: '<path d="M12 2.5c.8 3.3 5.5 5.6 5.5 10.6a5.5 5.5 0 0 1-11 0c0-2.6 1.4-4.3 2.6-5.4.2 1.6.9 2.7 1.9 3.3.1-3.2 1-5.6 1-8.5z"/>',
  buiten: '<path d="M14 14.6V5a2 2 0 0 0-4 0v9.6a4 4 0 1 0 4 0z"/><path d="M12 11v6"/>',
};
const icon = (key, x, y, size) =>
  `<svg x="${x - size / 2}" y="${y}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${FLOW_ICONS[key]}</svg>`;

// One main circle. rows: [key, dy, size, class] text lines; the value line has its unit as a tspan.
function flowNode(key, sheet, label, cx, cy, color, rows) {
  const lines = rows.map(([k, dy, size, cls]) => cls === "big"
    ? `<text x="${cx}" y="${cy + dy}" text-anchor="middle" class="big" font-size="${size}" fill="var(--fg)"><tspan data-t="${k}">—</tspan><tspan data-t="${k}-u" class="u" font-size="${Math.round(size * 0.6)}" dx="2"></tspan></text>`
    : `<text data-t="${k}" x="${cx}" y="${cy + dy}" text-anchor="middle" font-size="${size}" fill="var(--muted)"></text>`).join("");
  return `<g class="node" data-sheet="${sheet}" data-node="${key}" tabindex="0" role="button" aria-label="${label}" style="--c:${color}">
      <circle class="ring" cx="${cx}" cy="${cy}" r="${FLOW_R}"/>
      <g class="ic">${icon(key, cx, cy - 39, 17)}</g>${lines}
    </g>`;
}

// A small corner circle (gas, outdoor temperature): icon and value inside, a caption under it.
function flowCorner(key, sheet, label, cx, cy, color) {
  return `<g class="node" data-sheet="${sheet}" data-node="${key}" tabindex="0" role="button" aria-label="${label}" style="--c:${color}">
      <circle class="ring small" cx="${cx}" cy="${cy}" r="27"/>
      <g class="ic">${icon(key, cx, cy - 20, 13)}</g>
      <text data-t="${key}" x="${cx}" y="${cy + 10}" text-anchor="middle" class="big" font-size="12.5" fill="var(--fg)">—</text>
      <text data-t="${key}-l" x="${cx}" y="${cy + 43}" text-anchor="middle" font-size="10.5" fill="var(--muted)"></text>
    </g>`;
}

let flowCount = 0;
function flowSvg() {
  const id = `f${flowCount++}`; // marker ids per picture: the wall view has its own copy of the SVG
  const marker = (name, color) => `<marker id="${id}-${name}" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="11" markerHeight="11" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M0 0.5 10 5 0 9.5z" fill="${color}"/></marker>`;
  const lines = FLOW_LINES.map(([n, d]) => `<path class="line off" data-line="${n}" d="${d}" stroke="var(--eigen)"/>`).join("");
  const labels = FLOW_LINES.map(([n, , x, y, anchor]) => `<text data-t="${n}-line" class="lbl" x="${x}" y="${y}" font-size="12" fill="var(--muted)" text-anchor="${anchor}" stroke="var(--card)" stroke-width="5" stroke-linejoin="round" paint-order="stroke"></text>`).join("");
  return `
  <svg viewBox="0 0 360 316" data-id="${id}" aria-label="Stroomschema: waar de stroom nu vandaan komt en heen gaat">
    <defs>${marker("green", "var(--eigen)")}${marker("red", "var(--uit)")}</defs>
    ${lines}
    ${labels}
    ${flowNode("zon", "zon", "Zon", 180, 54, "var(--zon)", [["zon", 5, 21, "big"], ["zon-k", 21, 10.5], ["zon-v", 32, 9.5]])}
    ${flowNode("net", "netnu", "Net", 52, 158, "var(--ref)", [["net-s", -13, 10.5], ["net", 8, 20, "big"], ["net-in", 23, 10], ["net-out", 34, 10]])}
    ${flowNode("huis", "huis", "Huis", 308, 158, "var(--huis)", [["huis", 5, 21, "big"], ["huis-k", 21, 10.5], ["huis-v", 32, 9.5]])}
    ${flowNode("bat", "batterij", "Batterij", 180, 262, "var(--bat)", [["bat-k", -10, 10.5], ["bat", 11, 20, "big"], ["bat-state", 27, 10.5]])}
    ${flowCorner("gas", "gas", "Gas vandaag", 30, 30, "var(--gas)")}
    <g class="node" data-sheet="buiten" tabindex="0" role="button" aria-label="Buitentemperatuur">
      <text data-t="buiten" x="352" y="36" class="big" font-size="16" fill="var(--fg)" text-anchor="end">—</text>
    </g>
  </svg>`;
}

function setLine(svg, name, watts, reverse, color) {
  const line = $(`[data-line="${name}"]`, svg);
  const on = isNum(watts) && Math.abs(watts) >= 10;
  line.classList.toggle("off", !on);
  line.classList.toggle("rev", !!reverse);
  if (color) line.setAttribute("stroke", color);
  const m = on ? `url(#${svg.dataset.id}-${color === "var(--uit)" ? "red" : "green"})` : "none";
  line.setAttribute("marker-end", on && !reverse ? m : "none");
  line.setAttribute("marker-start", on && reverse ? m : "none");
  line.style.strokeWidth = on ? `${2 + Math.min(4, Math.abs(watts) / 700)}px` : "";
  $(`[data-t="${name}-line"]`, svg).textContent = on ? plain(power(Math.abs(watts))) : "";
}

// Value in a circle: W below 1000, kW above; the unit is a smaller tspan after the number.
function circleValue(t, key, w) {
  if (!isNum(w)) { t(key, "—"); t(`${key}-u`, ""); return; }
  const a = Math.abs(w);
  t(key, a < 1000 ? fmt[0].format(a) : fmt[2].format(a / 1000));
  t(`${key}-u`, a < 1000 ? "W" : "kW");
}

function renderFlow(svg, d, today) {
  const t = (k, v) => { const el = $(`[data-t="${k}"]`, svg); if (el) el.textContent = v; };
  const color = (node, c) => { const g = $(`[data-node="${node}"]`, svg); if (g) g.style.setProperty("--c", c); };
  const has = d && d.flow_time;
  const GREEN = "var(--eigen)", RED = "var(--uit)";
  const kwhToday = (key, x) => { const ok = today && isNum(x); t(`${key}-k`, ok ? `${fmt[1].format(x)} kWh` : ""); t(`${key}-v`, ok ? "vandaag" : ""); };

  circleValue(t, "zon", has ? d.solar_w : null);
  kwhToday("zon", today?.generated_kwh);
  circleValue(t, "huis", has ? d.house_w : null);
  kwhToday("huis", today?.consumption_kwh);

  const cw = d ? d.battery_cells_w : null;
  circleValue(t, "bat", isNum(cw) ? cw : null);
  const soc = d && isNum(d.soc) ? `${fmt[0].format(d.soc)} %` : "—";
  t("bat-k", d && isNum(d.battery_temp_c) ? `${soc} · ${fmt[0].format(d.battery_temp_c)} °C` : soc);
  const idle = !d || !isNum(cw) || Math.abs(cw) <= 10;
  t("bat-state", !d || !isNum(cw) ? "" : idle ? "rust" : cw > 0 ? "ontlaadt" : "laadt");
  $('[data-t="bat-state"]', svg)?.setAttribute("fill", idle ? "var(--muted)" : cw > 0 ? RED : GREEN);

  const f = (k) => (has ? d[`flow_${k}_w`] : null);
  setLine(svg, "sun-bat", f("sun_bat"), false, GREEN);
  setLine(svg, "sun-house", f("sun_house"), false, GREEN);
  setLine(svg, "sun-grid", f("sun_grid"), false, GREEN);
  setLine(svg, "bat-house", f("bat_house"), false, RED);
  setLine(svg, "grid-house", f("grid_house"), false, RED);
  // One line between battery and grid: battery -> grid (export from the cells, rare) or the battery
  // charging from the socket (grid -> battery), whichever is larger.
  const bg = f("bat_grid") ?? 0, gb = f("grid_bat") ?? 0;
  if (gb >= 10 && gb >= bg) setLine(svg, "bat-grid", gb, true, RED);
  else setLine(svg, "bat-grid", bg, false, RED);

  // Grid: ring and word follow the direction (red = afname, green = teruglevering, grey = about zero);
  // today's import and export inside.
  const g = has ? d.grid_w : null;
  circleValue(t, "net", isNum(g) && Math.abs(g) >= 10 ? g : isNum(g) ? 0 : null);
  const ns = $('[data-t="net-s"]', svg);
  if (isNum(g) && g >= 10) { color("net", RED); t("net-s", "afname"); ns?.setAttribute("fill", RED); }
  else if (isNum(g) && g <= -10) { color("net", GREEN); t("net-s", "terug"); ns?.setAttribute("fill", GREEN); }
  else { color("net", "var(--ref)"); t("net-s", ""); }
  t("net-in", today && isNum(today.import_kwh) ? `→ ${fmt[1].format(today.import_kwh)} kWh` : "");
  t("net-out", today && isNum(today.export_kwh) ? `← ${fmt[1].format(today.export_kwh)} kWh` : "");

  t("gas", today && isNum(today.gas_m3) ? `${fmt[2].format(today.gas_m3)} m³` : "—");
  t("gas-l", "vandaag");
  const oc = d ? d.outdoor_c : null;
  t("buiten", isNum(oc) ? `${fmt[1].format(oc)} °C` : "—");
}

// ---------- rendering ----------
const setV = (key, html) => $$(`[data-v="${key}"]`).forEach((el) => { el.innerHTML = html; });
// Small icon per plug, picked from its name or label; a plug when nothing matches.
const PLUG_ICONS = [
  [/\b(tv|televisie|television)\b/i, '<rect x="2.5" y="5" width="19" height="12.5" rx="2"/><path d="M8 21h8M12 17.5V21"/>'],
  [/router|wifi|modem|access ?point/i, '<path d="M2.5 9a14 14 0 0 1 19 0M5.5 12.5a9.5 9.5 0 0 1 13 0M9 16a4.5 4.5 0 0 1 6 0"/><circle cx="12" cy="19.5" r="1.2"/>'],
  [/server|\bnas\b/i, '<rect x="3.5" y="3.5" width="17" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="17" height="7" rx="1.5"/><path d="M7.5 7h.01M7.5 17h.01"/>'],
  [/airco|\bac\b|klima|warmtepomp|heat ?pump|fan|ventilat/i, '<path d="M12 2.5v19M3.8 7.25l16.4 9.5M3.8 16.75l16.4-9.5M9.5 4l2.5 2.5L14.5 4M9.5 20l2.5-2.5 2.5 2.5"/>'],
  [/bureau|desk|\bpc\b|computer|laptop/i, '<rect x="4.5" y="5" width="15" height="10.5" rx="1.5"/><path d="M2 19h20"/>'],
];
const PLUG_DEFAULT = '<path d="M9 2.5v5M15 2.5v5M6.5 7.5h11v3.5a5.5 5.5 0 0 1-11 0zM12 16.5v5"/>';
function plugIcon(name) {
  const text = `${name} ${plugLabel(name)}`;
  const hit = PLUG_ICONS.find(([re]) => re.test(text));
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${hit ? hit[1] : PLUG_DEFAULT}</svg>`;
}
const plugLabel = (name) => state.config.plugLabels[name] || (name ? name[0].toUpperCase() + name.slice(1) : "?");
const secondsBetween = (later, earlier) => (later && earlier ? (new Date(later) - new Date(earlier)) / 1000 : null);

function liveAge() {
  const d = state.live?.data;
  if (!d || !d.flow_time) return null;
  // age at the server when read, plus how long ago we received it
  return secondsBetween(d.db_now, d.flow_time) + (Date.now() - state.liveAt) / 1000;
}

function renderLive() {
  const d = state.live?.data || null;
  const today = state.today?.data || null;
  $$("[data-flow] > svg").forEach((svg) => renderFlow(svg, d, today));

  const plugs = $("#plugs");
  const list = d?.plugs || [];
  plugs.innerHTML = list.length
    ? list.map((p) => `<button type="button" data-sheet="plugs">${plugIcon(p.name)}<span>${esc(plugLabel(p.name))}</span><b>${plain(power(p.w))}</b></button>`).join("")
    : '<p class="empty">Geen stekker meldde zich in de laatste 15 minuten.</p>';
  const sum = list.reduce((a, p) => a + (isNum(p.w) ? p.w : 0), 0);
  $("#plugs-sum").textContent = list.length ? `live · samen ${plain(power(sum))}` : "live";

  // battery card
  const soc = d?.soc;
  $$("[data-bar]").forEach((bar) => {
    bar.style.width = isNum(soc) ? `${Math.max(0, Math.min(100, soc))}%` : "0";
    bar.style.background = `var(${socColor(soc)})`;
  });
  $$("[data-lim]").forEach((lim) => {
    if (isNum(soc) && isNum(d?.discharge_limit_soc)) { lim.style.display = "block"; lim.style.left = `${d.discharge_limit_soc}%`; } else lim.style.display = "none";
  });
  const cw = d?.battery_cells_w;
  setV("bat-w", isNum(cw) ? power(Math.abs(cw)) : "—");
  setV("bat-state", !isNum(cw) ? "" : Math.abs(cw) <= 10 ? "rust" : cw > 0 ? '<span style="color:var(--uit)">ontlaadt</span>' : '<span style="color:var(--eigen)">laadt</span>');
  setV("bat-temp", d && isNum(d.battery_temp_c) ? unit(fmt[0].format(d.battery_temp_c), "°C") : "—");
  setV("soc", isNum(soc) ? `${fmt[0].format(soc)}%` : "—");
  setV("beschikbaar", kwh(d?.available_kwh));
  renderFreshness();
  renderStatus();
  renderWallFoot();
}

function renderToday() {
  const t = state.today?.data || null;
  const s = state.today?.savings || null;
  const note = $('[data-note="today"]');
  if (note) note.hidden = !!(t && isNum(t.consumption_kwh));
  setV("opgewekt", t && isNum(t.generated_kwh)
    ? `${num(t.generated_kwh)}<small>kWh${isNum(t.self_consumption) ? ` · ${fmt[0].format(t.self_consumption * 100)} %` : ""}</small>` : "—");
  setV("verbruik", kwh(t?.consumption_kwh));
  setV("zelfvoorzienend", pct(t?.self_sufficiency));
  setV("net", t && isNum(t.import_kwh) ? `${num(t.import_kwh)}<small>· ${num(t.export_kwh)} kWh</small>` : "—");
  setV("rekening", eur(t?.net_eur));
  setV("rekening-sub", t && isNum(t.net_eur) ? `stroom ${num((t.import_eur ?? 0) - (t.export_eur ?? 0), 2)} · gas ${num(t.gas_eur, 2)} · vast ${num(t.fixed_eur, 2)}` : "geen gegevens vandaag");
  setV("bespaard", s && isNum(s.savings_eur) ? `≈ ${eur(s.savings_eur)}` : "—");
  setV("geladen", t && isNum(t.battery_charged_kwh) ? `${num(t.battery_charged_kwh)}<small>· ${num(t.battery_discharged_kwh)} kWh</small>` : "—");
  $$("[data-flow] > svg").forEach((svg) => renderFlow(svg, state.live?.data, t));
  renderForecast();
  if (state.battery) renderBattery();
}

const weekday = (offsetDays) => new Date(Date.now() + offsetDays * 86400000).toLocaleDateString("nl-NL", { weekday: "long", day: "numeric", month: "short", timeZone: TZ });
const approx = (x) => (isNum(x) ? `≈ ${kwh(x)}` : "—");

function forecastAge() {
  const f = state.today?.forecast;
  return f?.fetched_at ? (Date.now() - new Date(f.fetched_at)) / 1000 : null;
}

function renderForecast() {
  const f = state.today?.forecast || null;
  const t = state.today?.data || null;
  const label = $("#fc-label");
  const age = forecastAge();
  const stale = !isNum(age) || age > (state.config.staleAfter?.forecast ?? 10800);
  label.textContent = !f?.fetched_at ? "— · nog geen verwachting opgehaald"
    : stale ? `verouderd · opgehaald ${hm(f.fetched_at)}` : `Open-Meteo · ${hm(f.fetched_at)}`;
  label.classList.toggle("stale", stale);
  setV("fc-rest", approx(f?.rest_today_kwh));
  setV("fc-rest-sub", f && isNum(f.today_kwh)
    ? `hele dag ≈ ${num(f.today_kwh)}${t && isNum(t.generated_kwh) ? ` · opgewekt ${num(t.generated_kwh)} kWh` : " kWh"}` : "");
  setV("fc-morgen", f && f.tomorrow_hours >= 24 ? approx(f.tomorrow_kwh) : "—");
  setV("fc-morgen-sub", f && f.tomorrow_hours >= 24 ? weekday(1) : "nog geen verwachting voor morgen");
}

function renderFreshness() {
  const label = $("#live-label"), bat = $("#bat-label");
  const d = state.live?.data;
  const age = liveAge();
  const stale = !d?.flow_time || age > Math.max(30, state.config.liveInterval * 4) || state.live?.ok === false || state.cached;
  if (!d?.flow_time) {
    label.textContent = "— · geen meting in de laatste 5 minuten";
  } else if (stale) {
    label.textContent = `verouderd · laatste meting ${hm(d.flow_time)}`;
  } else {
    label.textContent = `live · ${clock(d.flow_time)}`;
  }
  label.classList.toggle("stale", stale);
  const batStale = !d?.battery_time;
  bat.textContent = batStale ? "— · geen meting in de laatste 5 minuten" : stale ? `verouderd · ${hm(d.battery_time)}` : "live";
  bat.classList.toggle("stale", batStale || stale);
}

// ---------- status ----------
function sources() {
  const d = state.live?.data || {};
  const now = d.db_now;
  const st = state.config.staleAfter || {};
  const expected = Object.keys(state.config.plugLabels || {});
  const seen = new Set((d.plugs || []).map((p) => p.name));
  const plugCount = expected.length ? expected.filter((k) => seen.has(k)).length : seen.size;
  const plugTotal = expected.length || seen.size;
  const out = [
    { name: "Slimme meter", age: secondsBetween(now, d.p1_time), limit: st.p1 ?? 60 },
    { name: "Thuisbatterij", age: secondsBetween(now, d.battery_last_time), limit: st.battery ?? 60 },
    { name: "Gasmeter", age: secondsBetween(now, d.gas_time), limit: st.gas ?? 1200 },
  ];
  out.push({ name: "Buitentemperatuur", age: secondsBetween(now, d.outdoor_time), limit: st.outdoor ?? 10800 });
  out.push({ name: "Zonverwachting", age: forecastAge(), limit: st.forecast ?? 10800 });
  out.forEach((s) => { s.ok = isNum(s.age) && s.age <= s.limit; s.text = ago(s.age); });
  out.push({ name: "Stekkers", ok: plugTotal > 0 && plugCount === plugTotal, text: plugTotal ? `${plugCount} van ${plugTotal} meldden zich in 15 min` : "geen stekkers gezien" });
  return out;
}

function warnings() {
  const out = [];
  if (state.auth === "login") out.push({ level: "bad", text: "Je bent uitgelogd. Laad de pagina opnieuw om in te loggen." });
  if (state.live?.ok === false || state.today?.ok === false) out.push({ level: "bad", text: "De app kan de database nu niet lezen; je ziet de laatste waarden." });
  if (state.auth === "offline") out.push({ level: "warn", text: "Geen verbinding met de server; je ziet de laatste waarden." });
  for (const s of sources()) if (!s.ok) out.push({ level: "warn", text: `${s.name}: ${s.text}.` });
  const d = state.live?.data;
  if (d && isNum(d.grid_w) && isNum(d.battery_cells_w) && d.grid_w > 50 && d.battery_cells_w < -50) {
    out.push({ level: "warn", text: `Het huis neemt ${plain(power(d.grid_w))} van het net terwijl de batterij ${plain(power(-d.battery_cells_w))} laadt. Waarschijnlijk ziet de CT-meter van de batterij fase 2 niet, zodat hij te weinig aan het huis levert.` });
  }
  const s = state.live?.strings;
  for (const [k, name] of STRINGS) {
    if (s?.[`${k}_stuck`] && !state.cached) out.push({ level: "warn", text: `Zonnepanelen ${name.toLowerCase()}: de string hangt op lage spanning (${num(s[`${k}_v`], 0)} V bij ${num(s[`${k}_a`], 2)} A) en levert minder dan hij kan. Tik op de zon voor de details.` });
  }
  return out;
}

function renderStatus() {
  const pill = $("#status-pill");
  const w = warnings();
  const bad = w.some((x) => x.level === "bad");
  pill.className = `pill ${!state.live ? "" : bad ? "bad" : w.length ? "warn" : "ok"}`;
  $("span", pill).textContent = !state.live ? "Laden…" : bad ? "Storing" : w.length ? `${w.length} ${w.length === 1 ? "melding" : "meldingen"}` : "Alles werkt";
  const banner = $("#banner");
  if (state.auth === "login") {
    banner.hidden = false;
    banner.innerHTML = 'Je bent uitgelogd.<button type="button" id="relogin">Opnieuw inloggen</button>';
    $("#relogin").onclick = () => location.reload();
  } else banner.hidden = true;
  if (!$("#scr-meer").hidden) renderMeerStatus();
}

function renderWallFoot() {
  if (!wallMode) return;
  const w = warnings();
  const el = $("#w-status");
  el.textContent = w.length ? `● ${w.length} ${w.length === 1 ? "melding" : "meldingen"}` : "● Alles werkt";
  el.className = w.length ? "warn" : "";
  const d = state.live?.data;
  $("#w-bat").textContent = d && isNum(d.available_kwh) ? `Batterij ${fmt[0].format(d.soc)}% · ${fmt[1].format(d.available_kwh)} kWh beschikbaar` : "Batterij —";
}

// ---------- info sheets ----------
const link = (key, text) => (state.config.links[key] ? `<p><a href="${esc(state.config.links[key])}" target="_blank" rel="noopener">${esc(text)} ›</a></p>` : "");
const rows = (pairs) => `<dl>${pairs.filter(Boolean).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}</dl>`;
const LIVE_PERIOD = () => {
  const d = state.live?.data;
  return d?.flow_time ? `live, meting van ${clock(d.flow_time)} (elke ${fmt[0].format(state.config.liveInterval)} s nieuw)` : "live; er is geen meting van de laatste 5 minuten, daarom “—”";
};
const TODAY_PERIOD = "vandaag 00:00 – nu, geen live waarde (elke minuut bijgewerkt)";

const SHEETS = {
  zon() {
    const d = state.live?.data;
    const day = state.solar?.data || null;
    maybeFetchSolar();
    return { title: `Zon · ${plain(power(d?.solar_w))}`, body: rows([
      ["Wat", "Wat de zonnepanelen nu leveren, en waar het heen gaat: de batterij in, naar het huis of naar het net (groene lijnen)."],
      ["Nu", d?.flow_time ? `batterij ${plain(power(d.flow_sun_bat_w))} · huis ${plain(power(d.flow_sun_house_w))} · net ${plain(power(d.flow_sun_grid_w))}` : "—"],
    ]) + stringsBlock(day) + rows([
      ["Hoe verdeeld", "De panelen hangen aan de thuisbatterij, dus alle zonnestroom gaat door het apparaat. Gemeten: wat de cellen laden, wat het apparaat aan het huis levert en wat de slimme meter terug ziet gaan. Daaruit volgt elke lijn. Alleen als zon en batterij tegelijk aan het huis leveren (rond zonsopgang en -ondergang) is de verdeling geschat, naar verhouding. Samen iets minder dan de zon zelf: ongeveer 3 % gaat verloren bij het omzetten."],
      ["Per string", "De panelen liggen in twee strings, elk op een eigen dakvlak: oost en west. Per string gemeten: spanning × stroom, vóór het omzetten (DC), elke 5 s. Opgeteld komt dat een paar procent hoger uit dan Opgewekt, de teller van de batterij; voor de dag geldt Opgewekt."],
      ["Verwachting", "Open-Meteo, per dakvlak (≈). Per uur per string zit die er vaak een derde naast: vergelijk oost met west en de hele dag, niet één uur."],
      ["Lage spanning", "Telt als een string onder 150 V zit terwijl er minstens 0,3 A door loopt. Normaal werkt een string op 250–300 V. Bij zonsopgang en -ondergang zakt de spanning ook, maar dan met weinig stroom; dat telt niet mee. Blijft de batterij bij daglicht op lage spanning hangen, dan levert die string minder dan hij kan."],
      ["Periode", `nu: ${LIVE_PERIOD()}; vandaag: 00:00 – nu, elke minuut nieuw`],
      ["Bron", "thuisbatterij (PV-vermogen, en per string spanning en stroom); verwachting Open-Meteo"],
    ]) + link("day", "Zon vandaag in Grafana"), after: () => {
      const box = $("[data-solar-chart]");
      if (box) box.innerHTML = solarChart(day, box.clientWidth);
    } };
  },
  batterij() {
    const d = state.live?.data;
    return { title: `Batterij · ${isNum(d?.soc) ? fmt[0].format(d.soc) + "%" : "—"}`, body: rows([
      ["Wat", "Laadniveau en wat de cellen nu doen: laden (groen; uit zon of het stopcontact) of ontladen (rood). Rode lijn naar het huis: de batterij levert uit de cellen. Rode lijn van het net: de batterij laadt uit het stopcontact."],
      ["Nu", d ? `cellen ${plain(power(d.battery_cells_w))} (boven nul ontladen) · naar het huis ${plain(power(d.battery_ac_w))}${d.socket_in_w >= 10 ? ` · uit het stopcontact ${plain(power(d.socket_in_w))}` : ""}` : "—"],
      ["Waarom verschil", "Tussen cellen en huis gaat stroom verloren bij het omzetten, en de batterij gebruikt zelf wat (stand-byverbruik)."],
      ["Temperatuur", d && isNum(d.battery_temp_c) ? `${fmt[1].format(d.battery_temp_c)} °C: de temperatuur die de batterij zelf meldt, dezelfde als in de Anker-app (welke sensor precies is niet bekend)` : "—"],
      ["Periode", LIVE_PERIOD()],
      ["Bron", "thuisbatterij"],
    ]) + link("battery", "Batterij in Grafana") };
  },
  huis() {
    const d = state.live?.data;
    const calc = d?.flow_time ? `${plain(power(d.grid_w))} net + ${plain(power(d.battery_ac_w))} uit de batterij${d.socket_in_w >= 10 ? ` − ${plain(power(d.socket_in_w))} batterij uit het stopcontact` : ""} = ${plain(power(d.house_w))}` : "—";
    return { title: `Verbruik nu · ${plain(power(d?.house_w))}`, body: rows([
      ["Wat", "Wat het huis nu gebruikt, auto en stekkers inbegrepen."],
      ["Berekening", "afname − teruglevering + wat de batterij aan het huis levert − wat de batterij uit het stopcontact laadt"],
      ["Nu", calc],
      ["Periode", LIVE_PERIOD()],
      ["Bron", "slimme meter en thuisbatterij"],
    ]) + link("day", "Verbruik vandaag in Grafana") };
  },
  netnu() {
    const d = state.live?.data;
    const g = d?.grid_w;
    const what = !isNum(g) ? "—" : g >= 10 ? `afname ${plain(power(g))}` : g <= -10 ? `teruglevering ${plain(power(-g))}` : "bijna niets";
    return { title: `Net · ${what}`, body: rows([
      ["Wat", "Stroom van of naar het net. Rood: je neemt af (lijn naar het huis, of naar de batterij als die uit het stopcontact laadt). Groen: je levert zonnestroom terug."],
      ["Periode", LIVE_PERIOD()],
      ["Bron", "slimme meter (P1)"],
    ]) + link("day", "Net vandaag in Grafana") };
  },
  gas() {
    const t = state.today?.data;
    return { title: `Gas vandaag · ${t && isNum(t.gas_m3) ? fmt[2].format(t.gas_m3) + " m³" : "—"}`, body: rows([
      ["Wat", "Gasverbruik vandaag."],
      ["Berekening", "stand van de gasmeter nu − stand om 00:00"],
      ["Kosten", t && isNum(t.gas_eur) ? `${eur(t.gas_eur)} (contractprijs)` : "—"],
      ["Periode", TODAY_PERIOD + "; de gasmeter meldt zich om de 5 minuten"],
      ["Bron", "gasmeter via de slimme meter"],
    ]) + link("period", "Gas in Grafana") };
  },
  buiten() {
    const d = state.live?.data;
    return { title: `Buiten · ${d && isNum(d.outdoor_c) ? fmt[1].format(d.outdoor_c) + " °C" : "—"}`, body: rows([
      ["Wat", "De buitentemperatuur van het weerstation in de buurt."],
      ["Periode", d?.outdoor_time ? `meting van ${hm(d.outdoor_time)}; er komt er elke 10 minuten een` : "geen meting in de laatste 3 uur, daarom “—”"],
      ["Bron", "Buienradar, meetstation Westdorpe (elke 10 minuten opgehaald)"],
      ["Waarom niet de sensor bij de voordeur", "die hangt tegen het huis en wordt in de zon veel te warm"],
    ]) };
  },
  plugs() {
    const d = state.live?.data;
    const list = (d?.plugs || []).map((p) => `<li>${esc(plugLabel(p.name))}: ${plain(power(p.w))} <span style="color:var(--muted)">(${hm(p.time)})</span></li>`).join("");
    return { title: "Stekkers", body: rows([
      ["Wat", "Losse apparaten met een meetstekker. Ze zitten al in het verbruik van het huis, niet erbovenop."],
      ["Periode", "live; elke stekker meldt zich op zijn eigen moment, de tijd staat erachter"],
      ["Bron", "Zigbee-meetstekkers"],
    ]) + (list ? `<ul>${list}</ul>` : "<p>Geen stekker meldde zich in de laatste 15 minuten.</p>") + link("plugs", "Stekkers in Grafana") };
  },
  opgewekt() {
    const t = state.today?.data;
    return { title: `Opgewekt · ${plain(kwh(t?.generated_kwh))}`, body: rows([
      ["Wat", "Wat de zonnepanelen vandaag opwekten."],
      ["Berekening", "stand van de opbrengstteller nu − stand om 00:00"],
      ["Zelf benut", t && isNum(t.self_consumption)
        ? `${fmt[0].format(t.self_consumption * 100)} %: het deel dat niet naar het net ging, direct gebruikt of de batterij in. (${num(t.generated_kwh)} − ${num(t.export_kwh)}) ÷ ${num(t.generated_kwh)} kWh. Wat bij het omzetten in de batterij verloren gaat, telt als benut.`
        : "—: nog niets opgewekt vandaag"],
      ["Periode", TODAY_PERIOD],
      ["Bron", "opbrengstteller van de thuisbatterij (de panelen hangen eraan)"],
    ]) + link("period", "Opgewekt per dag in Grafana") };
  },
  verbruik() {
    const t = state.today?.data;
    const calc = t && isNum(t.consumption_kwh)
      ? `${num(t.import_kwh)} − ${num(t.export_kwh)} + ${num(t.battery_out_kwh)} − ${num(t.battery_in_kwh)} = ${num(t.consumption_kwh)} kWh` : "—";
    return { title: `Verbruik · ${plain(kwh(t?.consumption_kwh))}`, body: rows([
      ["Wat", "Wat het huis vandaag gebruikte, auto en stekkers inbegrepen."],
      ["Berekening", "afgenomen − teruggeleverd + uit de batterij naar het huis − batterij uit het stopcontact"],
      ["Vandaag", calc],
      ["Periode", TODAY_PERIOD],
      ["Bron", "tellers van de slimme meter en de thuisbatterij"],
    ]) + link("period", "Verbruik per dag in Grafana") };
  },
  zelfvoorzienend() {
    const t = state.today?.data;
    return { title: `Zelfvoorzienend · ${plain(pct(t?.self_sufficiency))}`, body: rows([
      ["Wat", "Deel van je verbruik dat uit eigen zon kwam, direct of via de batterij."],
      ["Berekening", "eigen verbruik ÷ verbruik; eigen verbruik = verbruik − afgenomen"],
      ["Vandaag", t && isNum(t.self_used_kwh) ? `${num(t.self_used_kwh)} ÷ ${num(t.consumption_kwh)} kWh` : "—"],
      ["Periode", TODAY_PERIOD],
      ["Bron", "tellers van de slimme meter en de thuisbatterij"],
    ]) + link("period", "Zelfvoorzienend per dag in Grafana") };
  },
  net() {
    const t = state.today?.data;
    return { title: `Afgenomen · teruggeleverd`, body: rows([
      ["Afgenomen", `${plain(kwh(t?.import_kwh, 2))}: van het net`],
      ["Teruggeleverd", `${plain(kwh(t?.export_kwh, 2))}: naar het net`],
      ["Berekening", "stand van de meter nu − stand om 00:00, normaal- en daltarief samen"],
      ["Periode", TODAY_PERIOD],
      ["Bron", "slimme meter"],
    ]) + link("period", "Net per dag in Grafana") };
  },
  verwacht() {
    const notes = state.config.forecastNotes || {};
    const f = state.today?.forecast;
    const t = state.today?.data;
    return { title: `Zon verwacht · morgen ${f && f.tomorrow_hours >= 24 ? plain(approx(f.tomorrow_kwh)) : "—"}`, body: rows([
      ["Wat", "Hoeveel de zonnepanelen naar verwachting opwekken. Een verwachting, geen meting: daarom “≈”."],
      ["Nog vandaag", f && isNum(f.rest_today_kwh) ? `${plain(approx(f.rest_today_kwh))} van nu tot middernacht; de hele dag ${plain(approx(f.today_kwh))}${t && isNum(t.generated_kwh) ? `, opgewekt tot nu ${plain(kwh(t.generated_kwh))}` : ""}` : "—"],
      ["Morgen", f && f.tomorrow_hours >= 24 ? `${plain(approx(f.tomorrow_kwh))} (${weekday(1)})` : "—: nog geen verwachting voor morgen"],
      ["Berekening", "de zon die de weerverwachting per uur geeft op elk dakvlak × wat elke string echt opwekte per eenheid zon"],
      notes.planes && ["Dakvlakken", esc(notes.planes)],
      notes.accuracy && ["Hoe goed", esc(notes.accuracy)],
      ["Periode", f?.fetched_at ? `verwachting, elk uur nieuw opgehaald; deze om ${hm(f.fetched_at)}` : "verwachting, elk uur nieuw opgehaald; nog niets opgehaald"],
      ["Bron", `Open-Meteo (gratis, zonder account)${notes.location ? `. Locatie: ${esc(notes.location)}` : ""}`],
    ]) + link("period", "Verwacht en opgewekt per dag in Grafana") };
  },
  rekening() {
    const t = state.today?.data;
    return { title: `Energierekening vandaag · ${eur(t?.net_eur)}`, body: rows([
      ["Wat", "Wat vandaag tot nu kost volgens je energiecontract."],
      ["Stroom", t ? `${eur(t.import_eur)} afname − ${eur(t.export_eur)} teruglevering (tot en met 2026 verrekend tegen de stroomprijs: salderen)` : "—"],
      ["Gas", eur(t?.gas_eur)],
      ["Vaste kosten", t ? `${eur(t.fixed_eur)} per dag: netbeheer en vaste leveringskosten, min de vermindering energiebelasting` : "—"],
      ["Niet meegeteld", "terugleverkosten: tot 2027 een vast bedrag per dag dat pas bij de jaarafrekening vastligt"],
      ["Periode", TODAY_PERIOD],
      ["Bron", "meterstanden en de contractprijzen uit DSMR-reader"],
    ]) + link("money", "Energierekening in Grafana") };
  },
  bespaard() {
    const s = state.today?.savings;
    if (!s) return { title: "Bespaard door de batterij · —", body: "<p>Nog geen gegevens vandaag, of de dag ligt vóór de installatie van de batterij.</p>" };
    return { title: `Bespaard door de batterij · ≈ ${eur(s.savings_eur)}`, body: rows([
      ["Wat", "Wat de batterij je vandaag bespaart onder de regels van 2027: geen salderen meer, afname en teruglevering apart afgerekend."],
      ["Berekening", `rekening zonder batterij − rekening met batterij = ${eur(s.cost_without_eur)} − ${eur(s.cost_with_eur)}`],
      ["Afname", `${num(s.import_without_kwh, 2)} kWh zonder batterij, ${num(s.import_with_kwh, 2)} kWh echt`],
      ["Teruglevering", `${num(s.export_without_kwh, 2)} kWh zonder batterij, ${num(s.export_with_kwh, 2)} kWh echt`],
      ["Prijzen 2027", `afname € ${num(s.p_import, 5)}/kWh; teruglevering levert € ${num(s.p_feedin, 4)} op en kost € ${num(s.p_feedin_cost, 5)} terugleverkosten per kWh`],
      ["Zonder batterij", "verbruik − de zon zoals een gewone omvormer die had geleverd. Het rendement daarvan is gemeten aan je vorige omvormer (75 % bij weinig zon, 97 % bij veel). Dat is de enige aanname: daarom “berekend” en “≈”."],
      ["Periode", TODAY_PERIOD + ", berekend uit metingen om de paar seconden, elke 5 minuten bijgewerkt"],
      ["Bron", "slimme meter, thuisbatterij, contractprijzen 2027"],
    ]) };
  },
  laadniveau() {
    const d = state.live?.data;
    return { title: `Laadniveau · ${isNum(d?.soc) ? fmt[0].format(d.soc) + "%" : "—"}`, body: rows([
      ["Wat", "Hoe vol de batterij is."],
      ["Streepje", isNum(d?.discharge_limit_soc) ? `de ondergrens (${fmt[0].format(d.discharge_limit_soc)}%): daaronder ontlaadt de batterij niet` : "—"],
      ["Grenzen", "stel je in de Anker-app in"],
      ["Periode", LIVE_PERIOD()],
      ["Bron", "thuisbatterij"],
    ]) + link("battery", "Laadniveau in Grafana") };
  },
  beschikbaar() {
    const d = state.live?.data;
    return { title: `Nog beschikbaar · ${plain(kwh(d?.available_kwh))}`, body: rows([
      ["Wat", "Wat er nog uit de batterij kan voordat hij bij de ondergrens stopt."],
      ["Berekening", d && isNum(d.soc) ? `(${fmt[0].format(d.soc)}% − ${fmt[0].format(d.discharge_limit_soc)}%) × ${num(d.rated_kwh)} kWh = ${num(d.available_kwh, 2)} kWh` : "(laadniveau − ondergrens) × capaciteit"],
      ["Capaciteit", "zoals de batterij die zelf meldt (7,1 of 7,2 kWh; verkocht als 7 kWh). Door omzettingsverlies komt er iets minder in huis aan."],
      ["Periode", LIVE_PERIOD()],
      ["Bron", "thuisbatterij"],
    ]) + link("battery", "Batterij in Grafana") };
  },
  geladen() {
    const t = state.today?.data;
    return { title: "Geladen · ontladen vandaag", body: rows([
      ["Geladen", `${plain(kwh(t?.battery_charged_kwh))} de cellen in`],
      ["Ontladen", `${plain(kwh(t?.battery_discharged_kwh))} de cellen uit`],
      ["Berekening", "tellers van de batterij nu − stand om 00:00 (in stappen van 0,1 kWh)"],
      ["Periode", TODAY_PERIOD],
      ["Bron", "thuisbatterij"],
    ]) + link("battery", "Geladen en ontladen in Grafana") };
  },
  contract() {
    const c = (state.contracts?.contracts || []).find((x) => x.id === contractKey);
    if (!c) return { title: "Contract", body: "<p>—</p>" };
    const kwh0 = (x) => (isNum(x) ? `${fmt[0].format(x)} kWh` : "—");
    const elec = c.kind !== "gas", gas = c.kind !== "stroom";
    const period = c.days ? `${dmyTs(c.first_day)} – ${dmyTs(c.last_day)}, ${c.days} dagen${c.status === "lopend" ? " (tot nu)" : ""}` : c.status === "komend" ? `begint ${dmy(c.start)}` : "geen meetgegevens in deze looptijd";
    const feedin = c.feedin_cost_per_kwh ? `${price(c.feedin_cost_per_kwh, 5)} per teruggeleverde kWh (niet in de bedragen hierboven)`
      : c.feedin_bands ? "een vast bedrag per dag volgens een staffel op de teruglevering per jaar; ligt pas bij de jaarafrekening vast en zit niet in de bedragen hierboven" : null;
    return { title: c.name, body: rows([
      ["Looptijd", `${dmy(c.start)} – ${dmy(c.end)} · ${KIND[c.kind] || c.kind}${c.status !== "afgelopen" ? ` · ${c.status}` : ""}`],
      ["Prijzen", contractPrices(c)],
      ["Salderen", c.salderen ? "ja: teruglevering wordt per afrekenperiode verrekend tegen de stroomprijs, tot de afname op is" : "nee: teruglevering levert alleen de terugleververgoeding op"],
      feedin && ["Teruglever\u00adkosten", feedin],
      ["Gemeten", period],
      elec && ["Stroom", c.days ? `${kwh0(c.import_kwh)} afgenomen (${eur(c.import_eur)}), ${kwh0(c.export_kwh)} teruggeleverd (<span class="nw">−${eur(c.export_eur)}</span>)` : "—"],
      gas && ["Gas", c.gas_days ? `${fmt[0].format(c.gas_m3)} m³ (${eur(c.gas_eur)})` : "—"],
      ["Vaste kosten", c.days ? eur(c.fixed_eur) : "—"],
      ["Totaal", isNum(c.net_eur) ? `${eur(c.net_eur)}${c.days ? ` · ${eur(c.net_eur / c.days)} per dag` : ""}` : "—"],
      elec && c.days && ["Zon en verbruik", `${kwh0(c.generated_kwh)} opgewekt, ${kwh0(c.consumption_kwh)} verbruikt, ${isNum(c.self_sufficiency) ? fmt[0].format(c.self_sufficiency * 100) + " %" : "—"} zelfvoorzienend`],
      ["Berekening", "dezelfde dagrekening als op Geld en in Grafana: per dag met het contract dat toen gold. Gas komt van het gascontract van die dag (in 2022 liepen stroom en gas apart)."],
      ["Bron", "contracten uit DSMR-reader, meterstanden"],
    ]) + link("money", "Geld in Grafana") };
  },
  gmaand() { return moneySheet("month", "Energierekening deze maand"); },
  gjaar() { return moneySheet("year", "Energierekening dit jaar"); },
  gbespaard() {
    const sv = state.money?.savings, price = state.config.batteryPriceEur;
    return { title: `Bespaard door de batterij · ≈ ${sv ? eur(sv.total_eur) : "—"}`, body: rows([
      ["Wat", "Wat de batterij je bespaart onder de regels van 2027 (geen salderen meer), zoals op Thuis, nu ook opgeteld per maand en sinds de installatie."],
      ["Berekening", "per dag: rekening zonder batterij − rekening met batterij, met de prijzen van 2027; zonder batterij = verbruik − de zon zoals je vorige omvormer die had geleverd (gemeten rendement). Daarom “berekend” en “≈”."],
      ["Vandaag", sv ? `≈ ${eur(sv.today_eur)}` : "—"],
      ["Deze maand", sv ? `≈ ${eur(sv.month_eur)}` : "—"],
      ["Sinds installatie", sv ? `≈ ${eur(sv.total_eur)} over ${sv.days} dagen${sv.since ? ` (vanaf ${new Date(sv.since).toLocaleString("nl-NL", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: TZ })})` : ""}` : "—"],
      price && ["Terugverdienen", `tegen ${eur0(price)}, de aanschafprijs (instelling BATTERY_PRICE_EUR)`],
      ["Periode", sv?.filled_at ? `vandaag elke 5 minuten bijgewerkt; eerdere dagen elk uur berekend, laatst om ${hm(sv.filled_at)}` : "vandaag elke 5 minuten bijgewerkt; de eerdere dagen worden nog niet berekend (de dagtaak in de database staat nog niet aan), dus tellen alleen vandaag"],
      ["Bron", "slimme meter, thuisbatterij, contractprijzen 2027"],
    ]) };
  },
  g2027() {
    const b = state.money?.bill_2027;
    return { title: `Klaar voor 2027 · ≈ ${b ? eur0(b.net_eur) : "—"}`, body: rows([
      ["Wat", "Wat dit jaar tot nu had gekost met dezelfde meterstanden, maar met de regels en prijzen van 2027: geen salderen, teruglevering levert alleen de terugleververgoeding op en kost terugleverkosten per kWh."],
      ["Echt", b ? `${eur0(b.real_eur)} (de rekening van dit jaar tot nu, met salderen)` : "—"],
      ["Afname", b ? `${num(b.import_kwh, 0)} kWh × € ${num(b.p_import, 5)} = ${eur0(b.import_eur)}` : "—"],
      ["Teruglevering", b ? `${num(b.export_kwh, 0)} kWh × (€ ${num(b.p_feedin, 4)} − € ${num(b.p_feedin_cost, 5)} terugleverkosten) = ${eur0(b.export_eur)}` : "—"],
      ["Gas", b ? `${num(b.gas_m3, 0)} m³ × € ${num(b.p_gas, 4)} = ${eur0(b.gas_eur)}` : "—"],
      ["Vaste kosten", b ? `${b.days} dagen × € ${num(b.p_fixed, 4)} = ${eur0(b.fixed_eur)}` : "—"],
      ["Let op", "een rekenvoorbeeld op de stromen van dit jaar: met de batterij het hele jaar was de teruglevering lager geweest. Ook de prijzen verschillen (gas duurder, vaste kosten lager), niet alleen het einde van salderen."],
      ["Periode", "1 januari – nu"],
      ["Bron", "meterstanden en de contractprijzen voor 2027"],
    ]) + link("money", "Geld in Grafana") };
  },
  gmaanden() {
    const h = state.moneyYear;
    return { title: "Energierekening per maand", body: rows([
      ["Wat", "De energierekening van elke maand dit jaar, met dezelfde maand vorig jaar als grijze lijn."],
      ["Berekening", "stroomkosten − terugleververgoeding + gaskosten + vaste kosten, met het contract dat toen gold en salderen per afrekenperiode. Terugleverkosten tellen nog niet mee."],
      ["Dit jaar", h ? `${eur0(h.totals?.net_eur)} tot nu; vorig jaar tot dezelfde dag ${eur0(h.ly_totals?.net_eur)}` : "—"],
      ["Bron", "meterstanden en de contractprijzen uit DSMR-reader"],
    ]) + link("money", "Geld in Grafana") };
  },
  hopgewekt() { return histSheet("Opgewekt", "generated_kwh", "kWh", "Wat de zonnepanelen opwekten.", "som van de opbrengst per dag (de teller van de omvormer, sinds 13-11-2026 die van de thuisbatterij)", "omvormer / thuisbatterij"); },
  hverbruik() { return histSheet("Verbruik", "consumption_kwh", "kWh", "Wat het huis gebruikte, auto en stekkers inbegrepen.", "per dag: afgenomen − teruggeleverd + opgewekt (vóór de batterij) of + uit de batterij − uit het stopcontact (sinds de batterij)", "slimme meter en omvormer / thuisbatterij"); },
  hzelfv() { return histSheet("Zelfvoorzienend", "self_sufficiency", "%", "Deel van je verbruik dat uit eigen zon kwam, direct of via de batterij.", "eigen verbruik ÷ verbruik over de hele periode (niet het gemiddelde van de dagen)", "slimme meter en omvormer / thuisbatterij"); },
  hbenut() { return histSheet("Zelf benut", "self_consumption", "%", "Deel van de opgewekte zon dat je niet teruggeleverd hebt: zelf gebruikt of in de batterij gezet.", "(opgewekt − teruggeleverd) ÷ opgewekt over de hele periode", "slimme meter en omvormer / thuisbatterij"); },
  hnet() { return histSheet("Afgenomen · teruggeleverd", "import_kwh", "kWh", "Stroom van en naar het net.", "standen van de slimme meter, normaal- en daltarief samen", "slimme meter", "export_kwh"); },
  hrekening() { return histSheet("Energierekening", "net_eur", "€", "Wat deze periode kostte volgens je energiecontracten.", "stroomkosten − terugleververgoeding + gaskosten + vaste kosten, met de prijzen van het contract dat toen gold en salderen per afrekenperiode (tot en met 2026). Terugleverkosten tellen nog niet mee.", "meterstanden en de contractprijzen uit DSMR-reader"); },
  hgas() { return histSheet("Gas", "gas_m3", "m³", "Gasverbruik.", "standen van de gasmeter per dag", "gasmeter via de slimme meter"); },
  hsoc() {
    const s = state.hist.data?.soc;
    const r = s?.ranges || [], pts = (s?.points || []).map((p) => p.soc).filter(isNum);
    const lo = s?.unit === "day" ? Math.min(...pts) : Math.min(...r.map((x) => x.min)), hi = s?.unit === "day" ? Math.max(...pts) : Math.max(...r.map((x) => x.max));
    const has = Number.isFinite(lo) && Number.isFinite(hi);
    return { title: `Laadniveau batterij · ${has ? `${fmt[0].format(lo)}–${fmt[0].format(hi)}%` : "—"}`, body: rows([
      ["Wat", "Hoe vol de batterij was in deze periode."],
      ["Grafiek", s?.unit === "day" ? "het laadniveau per 5 minuten, met de onder- en bovengrens gestippeld" : `per ${s?.unit === "year" ? "maand" : "dag"} een balk van het laagste tot het hoogste laadniveau: raakte de batterij vol, en kwam hij bij de ondergrens?`],
      ["Kleuren", "groen vanaf 50 %, oranje van 20 tot 50 %, rood onder 20 %"],
      ["Periode", s?.first ? `metingen sinds ${dmyTs(s.first)}` : "—"],
      ["Bron", "thuisbatterij"],
    ]) + link("battery", "Batterij in Grafana") };
  },
  hgraad() { return histSheet("Graaddagen", "degree_days", "", "Hoe koud het was, zo gerekend dat het past bij hoeveel dit huis stookt. Twee keer zoveel graaddagen betekent ongeveer twee keer zoveel gas voor verwarming.", "per dag max(17 °C − daggemiddelde buiten, 0) × 1,1 (nov–feb), × 1,0 (mrt, okt) of × 0,8 (apr–sep): gewogen graaddagen op een basis van 17 °C. Waarom 17: over 5½ jaar gasverbruik van dit huis past dit het best (beter dan 18 °C, en beter dan ongewogen); met ongeveer 20,5 °C binnen leveren zon, mensen en apparaten de rest. Mindergas rekent met 20,5 °C binnen en een stookgrens van 18 °C en telt daardoor meer graaddagen (oktober 2026: ≈ 258 tegen 149 hier). KNMI levert de daggemiddelden een of twee dagen later; tot dan staat een dag zonder graaddagen.", "KNMI, meetstation Westdorpe (gemeten daggemiddelde)"); },
  hgpg() { return histSheet("Gas per graaddag", "gas_per_degree_day", "m³", "Gas gedeeld door graaddagen: zo zie je of je zuiniger stookt, los van of het een koude of zachte periode was. Een lagere thermostaat of betere isolatie geeft een lager getal.", "gas op dagen met een graaddagwaarde ÷ graaddagen; pas vanaf 5 graaddagen (anders “—”). Gas voor warm water en koken telt ook mee (ongeveer 0,2 m³ per dag), dus in de zomer is dit getal hoog.", "gasmeter en KNMI (Westdorpe)"); },
  temperatuur() {
    const d = state.live?.data, sm = state.battery?.summary;
    return { title: `Temperatuur batterij · ${d && isNum(d.battery_temp_c) ? fmt[0].format(d.battery_temp_c) + " °C" : "—"}`, body: rows([
      ["Wat", "De temperatuur die de batterij zelf meldt, dezelfde als in de Anker-app (welke sensor precies is niet bekend)."],
      ["Vandaag", sm && isNum(sm.temp_min_c) ? `laagste ${fmt[0].format(sm.temp_min_c)} °C, hoogste ${fmt[0].format(sm.temp_max_c)} °C` : "—"],
      ["Periode", LIVE_PERIOD() + "; laagste en hoogste: vandaag 00:00 – nu"],
      ["Bron", "thuisbatterij"],
    ]) + link("tech", "Temperatuur in Grafana (Techniek)") };
  },
  socdag() {
    const sm = state.battery?.summary;
    return { title: "Laadniveau vandaag", body: rows([
      ["Wat", "Hoe vol de batterij was, van middernacht tot nu, gemiddeld per 5 minuten."],
      ["Kleuren", "groen vanaf 50 %, oranje van 20 tot 50 %, rood onder 20 %; elk stuk van de lijn heeft de kleur van zijn eigen hoogte"],
      ["Gestippeld", "de onder- en bovengrens die je in de Anker-app instelt; de batterij ontlaadt niet onder de ondergrens"],
      ["Vandaag", sm && isNum(sm.min_soc) ? `laagste ${fmt[0].format(sm.min_soc)}%, hoogste ${fmt[0].format(sm.max_soc)}%` : "—"],
      ["Periode", "vandaag 00:00 – nu, elke minuut bijgewerkt"],
      ["Bron", "thuisbatterij"],
    ]) + link("battery", "Laadniveau in Grafana") };
  },
  sindsnieuw() {
    const sm = state.battery?.summary;
    return { title: "Geladen · ontladen sinds nieuw", body: rows([
      ["Geladen", sm ? `${plain(kwh(sm.charged_total_kwh))} de cellen in` : "—"],
      ["Ontladen", sm ? `${plain(kwh(sm.discharged_total_kwh))} de cellen uit, inclusief wat de batterij zelf gebruikt` : "—"],
      ["Berekening", "de levenslange tellers van de batterij, in stappen van 0,1 kWh"],
      ["Periode", sm?.first_reading ? `sinds de batterij nieuw is; deze app leest hem sinds ${new Date(sm.first_reading).toLocaleDateString("nl-NL", { day: "numeric", month: "long", year: "numeric", timeZone: TZ })}` : "sinds de batterij nieuw is"],
      ["Bron", "thuisbatterij"],
    ]) + link("battery", "Batterij in Grafana") };
  },
  celrendement() {
    const sm = state.battery?.summary;
    const since = sm?.efficiency_since ? new Date(sm.efficiency_since).toLocaleDateString("nl-NL", { day: "numeric", month: "short", timeZone: TZ }) : null;
    return { title: `Rendement aan de cellen · ${sm && isNum(sm.cell_efficiency_30d) ? fmt[0].format(sm.cell_efficiency_30d * 100) + "%" : "—"}`, body: rows([
      ["Wat", "Welk deel van wat de cellen in ging er ook weer uit kwam."],
      ["Berekening", "(ontladen + verandering in opgeslagen energie) ÷ geladen; de verandering = verschil in laadniveau × capaciteit, zodat een volle of lege batterij aan het eind niet meetelt"],
      ["Periode", since ? `laatste 30 dagen (metingen vanaf ${since}); pas vanaf 3 kWh geladen, anders “—”` : "laatste 30 dagen; pas vanaf 3 kWh geladen"],
      ["Geladen", sm ? plain(kwh(sm.charged_30d_kwh)) : "—"],
      ["Bron", "tellers en laadniveau van de thuisbatterij"],
    ]) + link("battery", "Rendement in Grafana") };
  },
  rendement() {
    return { title: "Rendement per vermogen", body: rows([
      ["Wat", "Welk deel van het vermogen dat erin gaat er aan de andere kant uitkomt, per vermogensband. Zo zie je bij welk vermogen de batterij het zuinigst is."],
      ["Zon → batterij + huis", "(in de cellen + naar het huis) ÷ zon, tijdens laden uit zon"],
      ["Batterij → huis", "naar het huis ÷ uit de cellen, tijdens ontladen zonder zon"],
      ["Stopcontact → batterij", "in de cellen ÷ uit het stopcontact, tijdens laden van het net"],
      ["Zon → huis", "niet getoond: als de batterij vol is, geeft ze voor het huis precies het zonvermogen door, dus daar valt geen rendement uit af te lezen"],
      ["Periode", "laatste 30 dagen; een band telt pas vanaf 5 minuten metingen"],
      ["Bron", "thuisbatterij, metingen om de paar seconden"],
    ]) + link("battery", "Rendement in Grafana") };
  },
  gezondheid() {
    const sm = state.battery?.summary;
    return { title: `Gezondheid · ${sm && isNum(sm.soh) ? fmt[0].format(sm.soh) + "%" : "—"}`, body: rows([
      ["SOH", "state of health: hoeveel van de oorspronkelijke capaciteit er volgens de batterij nog is. Een getal van de batterij zelf, niet door ons berekend."],
      ["Capaciteit", sm && isNum(sm.rated_kwh) ? `${plain(kwh(sm.rated_kwh))}, zoals de batterij meldt (verkocht als 7 kWh)` : "—"],
      ["Periode", "live"],
      ["Bron", "thuisbatterij"],
    ]) + link("tech", "Gezondheid in Grafana (Techniek)") };
  },
  cycli() {
    const sm = state.battery?.summary;
    return { title: `Volle cycli · ${sm && isNum(sm.full_cycles) ? fmt[1].format(sm.full_cycles) : "—"}`, body: rows([
      ["Wat", "Hoe vaak de batterij in totaal volgeladen werd: twee keer half vol telt als één cyclus."],
      ["Berekening", sm ? `geladen sinds nieuw ÷ capaciteit = ${num(sm.charged_total_kwh)} ÷ ${num(sm.rated_kwh)} kWh` : "geladen sinds nieuw ÷ capaciteit"],
      ["Periode", "sinds de batterij nieuw is"],
      ["Bron", "thuisbatterij"],
    ]) + link("battery", "Batterij in Grafana") };
  },
  mbasis() {
    const u = state.meer?.usage;
    const cars = (u?.nights || []).filter((x) => x.car).length;
    return { title: `Basislast · ${u?.last ? plain(watt(u.last.w)) : "—"}`, body: rows([
      ["Wat", "Wat het huis 's nachts gebruikt als niemand iets aanzet: alles wat altijd aan staat, zoals koelkast, router, server en stand-by. Een lagere basislast scheelt het hele jaar door."],
      ["Berekening", "per nacht het gemiddelde verbruik van het huis tussen 01:00 en 05:00 (net plus wat de batterij aan het huis levert); “gewoonlijk” is de mediaan van de laatste 30 nachten, zodat een uitschieter niet meetelt"],
      ["Auto", `nachten waarin de auto thuis laadde (grijs in de grafiek${cars ? `, ${cars} van de laatste ${u.nights.length}` : ""}) tellen niet mee: de lader is ook verbruik van het huis. Laadbeurten worden in delen ingelezen, dus een recente laadnacht kan nog blauw staan; de mediaan laat die buiten beschouwing.`],
      ["Vorig jaar", u && isNum(u.ly_median_30) ? `${plain(watt(u.ly_median_30))}: dezelfde 30 nachten een jaar eerder, op dezelfde manier` : "te weinig nachten zonder laden in dezelfde periode vorig jaar"],
      ["Stekkers", "de tabel eronder splitst vannacht uit: wat elke meetstekker gemiddeld deed, en wat er voor de rest van het huis overbleef"],
      ["Periode", "de laatste 60 nachten; vannacht = de nacht naar vandaag toe"],
      ["Bron", "slimme meter, thuisbatterij, meetstekkers, laadsessies"],
    ]) + link("day", "Verloop per dag in Grafana") };
  },
  hauto() {
    const h = state.hist.data, c = h?.car;
    const by = (list) => Object.fromEntries((list || []).map((p) => [p.kind, p]));
    const now = by(c?.places), ly = carLy(c) ? by(c.ly_places) : null;
    const home = now.home, lyHome = ly?.home;
    const share = (p) => (p && isNum(p.solar_kwh) && p.kwh ? ` (${fmt[0].format((p.solar_kwh / p.kwh) * 100)} %)` : "");
    const place = (p) => (p ? `${plain(kwh(p.kwh, 0))} in ${p.sessions} keer` : "niet geladen");
    const period = h ? `${histLabel(h)}${h.running ? ", tot nu" : ""}` : "—";
    const ls = c?.last_session;
    return { title: `Auto · ${c && isNum(c.net_eur) ? eur(c.net_eur) : "—"}`, body: rows([
      ["Wat", "Waar de auto in deze periode laadde, en wat thuis laden opleverde. Een laadbeurt telt in de periode waarin hij begon."],
      ["Thuis", carNoData(c) || (carHome(c) === "none" ? `nog niet binnen: de nieuwste thuissessie is van ${dmyTs(c.last_home)}`
        : `${home ? `${place(home)}, waarvan ${plain(kwh(home.solar_kwh, 0))} uit eigen zon${share(home)}` : "niet geladen"}${carHome(c) === "part" ? `; alleen tot ${dmyTs(c.last_home)}, de rest komt nog binnen` : ""}`)],
      ["Vergoed − kosten", home ? `${eur(home.reimbursed_eur)} vergoed − ${eur(home.real_cost_eur)} werkelijke kosten (stroom van het net tegen je contractprijs, eigen zon tegen wat die zon anders had opgeleverd) = ${eur(c.net_eur)}` : "—"],
      ["Werk", now.work ? `${place(now.work)}, ${eur(now.work.billed_eur)} op de laadpas` : "niet geladen"],
      ["Onderweg", now.public ? `${place(now.public)}, ${eur(now.public.billed_eur)} op de laadpas` : "niet geladen"],
      ["Vorig jaar", !ly ? "—: van toen zijn er nog geen laadgegevens" : `thuis ${lyHome ? `${place(lyHome)}, eigen zon ${plain(kwh(lyHome.solar_kwh, 0))}${share(lyHome)}, vergoed − kosten ${eur(c.ly_net_eur)}` : "niet geladen"} · werk ${ly.work ? plain(kwh(ly.work.kwh, 0)) : "—"} · onderweg ${ly.public ? plain(kwh(ly.public.kwh, 0)) : "—"}`],
      ["Deze periode", period],
      ["Thuis bijgewerkt", c?.last_home ? `de laadpaal-export komt in pakketjes binnen; de nieuwste thuissessie is van ${dmyTs(c.last_home)}` : "—"],
      ["Laatste laadbeurt", ls ? `${dmyTs(ls.time)}, ${PLACE[ls.kind] || ls.kind}, ${plain(kwh(ls.kwh))}` : "—"],
      ["Bron", "laadpaal thuis en de laadpas-sessies; kilometerstanden uit de auto-app"],
    ]) + link("car", "Auto in Grafana") };
  },
  status() {
    const list = sources().map((s) => [s.name, `<span class="dot" style="background:var(${s.ok ? "--ok" : "--warn"})"></span>${esc(s.text)}`]);
    const w = warnings();
    return { title: "Status", body: rows(list) + (w.length ? `<p><b>Let op</b></p><ul>${w.map((x) => `<li>${esc(x.text)}</li>`).join("")}</ul>` : "<p>Alle bronnen melden zich op tijd.</p>") + link("tech", "Techniek in Grafana") };
  },
};

// Sheet for a Historie total: the selected period and the same period last year.
function histSheet(title, key, unitName, what, how, source, key2) {
  const h = state.hist.data, T = h?.totals || {}, Y = h?.ly_totals || {};
  const f = (x) => (!isNum(x) ? "—" : unitName === "%" ? `${fmt[0].format(x * 100)} %` : unitName === "€" ? eur(x, 2) : `${fmt[unitName === "m³" && key === "gas_per_degree_day" ? 2 : 1].format(x)}${unitName ? " " + unitName : ""}`);
  const val = (o) => (key2 ? `${f(o[key])} · ${f(o[key2])}` : f(o[key]));
  const period = h ? `${histLabel(h)}${h.running ? ", tot nu" : ""}` : "—";
  const ly = h ? `${new Date(h.ly_start).toLocaleDateString("nl-NL", { day: "numeric", month: "short", year: "numeric", timeZone: TZ })} – ${new Date(new Date(h.ly_compare_end).getTime() - 3600000).toLocaleDateString("nl-NL", { day: "numeric", month: "short", year: "numeric", timeZone: TZ })}` : "—";
  return { title: `${title} · ${h ? val(T) : "—"}`, body: rows([
    ["Wat", what],
    ["Berekening", how],
    ["Deze periode", `${period}: ${h ? val(T) : "—"}`],
    ["Vorig jaar", `${ly}: ${h ? val(Y) : "—"}`],
    h?.bucket === "hour" && ["Per uur", "de staafjes per uur komen uit het gemiddelde vermogen per uur; het dagtotaal uit de tellers, dus ze kunnen een paar procent verschillen"],
    ["Bron", source],
  ]) + link("period", "Periode in Grafana") };
}

// Sheet for this month's or this year's bill.
function moneySheet(k, title) {
  const b = state.money?.[`bill_${k}`];
  return { title: `${title} · ${b ? eur(b.net_eur) : "—"}`, body: rows([
    ["Stroom", b ? `${eur(b.import_eur)} afname (${num(b.import_kwh, 0)} kWh) − ${eur(b.export_eur)} teruglevering (${num(b.export_kwh, 0)} kWh)` : "—"],
    ["Gas", b ? `${eur(b.gas_eur)} (${num(b.gas_m3, 0)} m³)` : "—"],
    ["Vaste kosten", b ? `${eur(b.fixed_eur)} over ${b.days} dagen: netbeheer en vaste leveringskosten, min de vermindering energiebelasting` : "—"],
    ["Berekening", "met de prijzen van het contract dat toen gold; tot en met 2026 wordt teruglevering verrekend tegen de stroomprijs (salderen per afrekenperiode)"],
    ["Niet meegeteld", "terugleverkosten: tot 2027 een vast bedrag per dag dat pas bij de jaarafrekening vastligt"],
    ["Periode", k === "month" ? "deze maand, de 1e – nu" : "dit jaar, 1 januari – nu"],
    ["Bron", "meterstanden en de contractprijzen uit DSMR-reader"],
  ]) + link("money", "Geld in Grafana") };
}

function openSheet(key) {
  const make = SHEETS[key];
  if (!make) return;
  const { title, body, after } = make();
  $("#sheet-title").textContent = title;
  $("#sheet-body").innerHTML = body;
  const dlg = $("#sheet");
  dlg.dataset.key = key;
  if (!dlg.open) dlg.showModal();
  after?.(); // drawn once the sheet is open, so a chart can take the sheet's real width
}
function refreshSheet() {
  const dlg = $("#sheet");
  if (dlg.open && dlg.dataset.key) openSheet(dlg.dataset.key);
}

document.addEventListener("click", (e) => {
  if (e.target.closest('#sheet a[href^="#"]:not([data-sheet])')) $("#sheet").close();
  const el = e.target.closest("[data-sheet]");
  if (!el) return;
  e.preventDefault();
  openSheet(el.dataset.sheet);
});
document.addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && e.target.matches?.("g[data-sheet]")) { e.preventDefault(); openSheet(e.target.dataset.sheet); }
});
$("#sheet").addEventListener("click", (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });

// ---------- Historie screen (/api/history: app_history(unit, date), rules in SQL) ----------
const HIST_UNITS = { day: "Dag", week: "Week", month: "Maand", year: "Jaar" };
const MONTHS = ["jan", "feb", "mrt", "apr", "mei", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];
const DAYS = ["ma", "di", "wo", "do", "vr", "za", "zo"];
state.hist = { unit: "month", anchor: null, data: null, loading: false };

// Calendar date of an instant in the app's time zone, as [y, m (1-12), d].
function ymd(iso) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { year: "numeric", month: "numeric", day: "numeric", timeZone: TZ })
    .formatToParts(new Date(iso)).map((x) => [x.type, Number(x.value)]));
  return [p.year, p.month, p.day];
}
const isoDate = (y, m, d) => { const t = new Date(Date.UTC(y, m - 1, d)); return t.toISOString().slice(0, 10); };
const todayIso = () => { const [y, m, d] = ymd(new Date().toISOString()); return isoDate(y, m, d); };
function isoWeek(y, m, d) {
  const t = new Date(Date.UTC(y, m - 1, d)); const day = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - day + 3);
  const first = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((t - first) / 86400000 - 3 + ((first.getUTCDay() + 6) % 7)) / 7);
}
function histLabel(h) {
  const [y, m, d] = ymd(h.start);
  if (h.unit === "year") return String(y);
  if (h.unit === "day") return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("nl-NL", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  if (h.unit === "month") return `${new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString("nl-NL", { month: "long", timeZone: "UTC" })} ${y}`;
  const [ey, em, ed] = ymd(new Date(new Date(h.end).getTime() - 3600000).toISOString()); // the last day
  const range = em === m ? `${d}–${ed} ${MONTHS[m - 1]}` : `${d} ${MONTHS[m - 1]} – ${ed} ${MONTHS[em - 1]}`;
  return `week ${isoWeek(y, m, d)} · ${range} ${ey}`;
}
// The anchor date one period before or after the shown one.
function histShift(h, step) {
  const [y, m, d] = ymd(h.start);
  if (h.unit === "year") return isoDate(y + step, 1, 1);
  if (h.unit === "month") return isoDate(y, m + step, 1);
  if (h.unit === "day") return isoDate(y, m, d + step);
  return isoDate(y, m, d + 7 * step);
}

// Slot index of a bucket: day number within the period, or month number for a year.
function slotOf(h, t, start) {
  if (h.bucket === "month") return ymd(t)[1] - 1;
  if (h.bucket === "hour") return Math.round((new Date(t) - new Date(start)) / 3600000);
  return Math.round((new Date(t) - new Date(start)) / 86400000);
}
function slotCount(h) {
  if (h.bucket === "month") return 12;
  if (h.bucket === "hour") return Math.round((new Date(h.end) - new Date(h.start)) / 3600000); // 23 or 25 on a clock change
  return Math.round((new Date(h.end) - new Date(h.start)) / 86400000);
}
function slotLabel(h, i) {
  if (h.bucket === "month") return MONTHS[i];
  if (h.bucket === "hour") return String(i).padStart(2, "0");
  const [y, m, d] = ymd(h.start);
  if (h.unit === "week") return DAYS[i];
  return String(new Date(Date.UTC(y, m - 1, d + i)).getUTCDate());
}

// The battery's charge level over a week, month or year: per day (per month for a year) a bar from
// the lowest to the highest level, coloured by height like the Batterij chart (socColor).
function socRangeChart(h, ranges, width) {
  const n = slotCount(h);
  const W = Math.max(300, Math.round(width || 600)), H = Math.round(Math.min(200, Math.max(150, W * 0.3)));
  const L = 38, R = 6, T = 10, B = 24;
  const y = (v) => T + (1 - v / 100) * (H - T - B);
  const slotW = (W - L - R) / n, cx = (i) => L + slotW * (i + 0.5);
  const bw = Math.max(3, Math.min(18, slotW * 0.55));
  const grid = [0, 25, 50, 75, 100].map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="g"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" class="ax">${v}%</text>`).join("");
  const every = h.bucket === "month" ? (W < 420 ? 2 : 1) : h.unit === "week" ? 1 : W < 420 ? 7 : 5;
  const ticks = Array.from({ length: n }, (_, i) => i).filter((i) => h.unit === "month" ? (i === 0 || (i + 1) % every === 0) : i % every === 0)
    .map((i) => `<text x="${cx(i)}" y="${H - 6}" text-anchor="middle" class="ax">${slotLabel(h, i)}</text>`).join("");
  const off = (v) => ((1 - v / 100) * 100).toFixed(1);
  const st = (o, c) => `<stop offset="${o}%" stop-color="var(${c})"/>`;
  const grad = `<linearGradient id="hsocg" gradientUnits="userSpaceOnUse" x1="0" x2="0" y1="${y(100)}" y2="${y(0)}">${st(0, "--ok")}${st(off(SOC_GREEN), "--ok")}${st(off(SOC_GREEN), "--warn")}${st(off(SOC_RED), "--warn")}${st(off(SOC_RED), "--bad")}${st(100, "--bad")}</linearGradient>`;
  const bars = ranges.map((r) => {
    const i = slotOf(h, r.t, h.start);
    if (i < 0 || i >= n || !isNum(r.min) || !isNum(r.max)) return "";
    const top = y(r.max), hgt = Math.max(3, y(r.min) - top);   // a day at one level still shows a stub
    return `<rect x="${(cx(i) - bw / 2).toFixed(1)}" y="${(top - (hgt === 3 ? 1.5 : 0)).toFixed(1)}" width="${bw.toFixed(1)}" height="${hgt.toFixed(1)}" rx="${Math.min(4, bw / 3).toFixed(1)}" fill="url(#hsocg)"><title>${slotLabel(h, i)}: ${fmt[0].format(r.min)}–${fmt[0].format(r.max)}%</title></rect>`;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" role="img"><defs>${grad}</defs>${grid}${bars}${ticks}</svg>`;
}

function renderHistSoc(h) {
  const box = $("[data-hsoc]");
  if (!box) return;
  const s = h?.soc;
  const hasDay = s?.unit === "day" && s.points?.length, hasRange = s && s.unit !== "day" && s.ranges?.length;
  setV("h-soc-sub", s?.unit === "day" ? "per 5 minuten" : s?.unit === "year" ? "laagste – hoogste per maand" : "laagste – hoogste per dag");
  if (hasDay) box.innerHTML = socChart(s.points, s.start, s.end, box.clientWidth);
  else if (hasRange) box.innerHTML = socRangeChart(h, s.ranges, box.clientWidth);
  else {
    const before = s?.first && new Date(s.end) <= new Date(s.first);
    box.innerHTML = `<p class="empty">${!s ? "—" : before ? `Geen batterijgegevens: de metingen beginnen op ${dmyTs(s.first)}.` : "Geen batterijgegevens in deze periode."}</p>`;
  }
}

// Bars for this period, last year's same period as a grey line with dots.
function histChart(h, key, color, width, digits) {
  const n = slotCount(h);
  const now = new Array(n).fill(null), ly = new Array(n).fill(null);
  for (const b of h.buckets) { const i = slotOf(h, b.t, h.start); if (i >= 0 && i < n && isNum(b[key])) now[i] = b[key]; }
  for (const b of h.ly_buckets) { const i = slotOf(h, b.t, h.ly_start); if (i >= 0 && i < n && isNum(b[key])) ly[i] = b[key]; }
  const W = Math.max(300, Math.round(width || 600)), H = Math.round(Math.min(230, Math.max(160, W * 0.34)));
  const L = 44, R = 6, T = 10, B = 24;
  const vals = [...now, ...ly].filter(isNum);
  const max = Math.max(1, ...vals), min = Math.min(0, ...vals);
  const span = max - min;
  const step = [1, 2, 2.5, 5, 10].map((f) => f * 10 ** Math.floor(Math.log10(span / 3))).find((s) => span / s <= 4) || span / 3;
  const top = Math.ceil(max / step) * step, floor = Math.floor(min / step) * step;
  const y = (v) => T + ((top - v) / (top - floor)) * (H - T - B);
  const slotW = (W - L - R) / n, cx = (i) => L + slotW * (i + 0.5);
  const bw = Math.max(2, Math.min(28, slotW * 0.62));
  let grid = "";
  for (let v = floor; v <= top + 1e-9; v += step) grid += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="g"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" class="ax">${fmt[Number.isInteger(step) ? 0 : 1].format(v)}</text>`;
  const every = h.bucket === "month" ? (W < 420 ? 2 : 1) : h.bucket === "hour" ? (W < 420 ? 6 : 3) : h.unit === "week" ? 1 : W < 420 ? 7 : 5;
  const ticks = Array.from({ length: n }, (_, i) => i).filter((i) => h.unit === "month" ? (i === 0 || (i + 1) % every === 0) : i % every === 0)
    .map((i) => `<text x="${cx(i)}" y="${H - 6}" text-anchor="middle" class="ax">${slotLabel(h, i)}</text>`).join("");
  const bars = now.map((v, i) => isNum(v) && v !== 0 ? `<rect x="${(cx(i) - bw / 2).toFixed(1)}" y="${Math.min(y(v), y(0)).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.abs(y(0) - y(v)).toFixed(1)}" rx="${Math.min(4, bw / 3).toFixed(1)}" fill="${color}"><title>${slotLabel(h, i)}: ${fmt[digits].format(v)}${isNum(ly[i]) ? ` (vorig jaar ${fmt[digits].format(ly[i])})` : ""}</title></rect>` : "").join("");
  let line = "", dots = "";
  ly.forEach((v, i) => {
    if (!isNum(v)) return;
    line += `${line && isNum(ly[i - 1]) ? "L" : "M"}${cx(i).toFixed(1)} ${y(v).toFixed(1)}`;
    dots += `<circle cx="${cx(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2.5" fill="var(--ref)"/>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img">${grid}${bars}<path d="${line}" fill="none" stroke="var(--ref)" stroke-width="1.5" stroke-dasharray="4 3"/>${dots}${ticks}</svg>`;
}

// "vorig jaar 312 kWh (+5 %)" under a total
function vsLastYear(now, ly, fmtFn, pctPoints) {
  if (!isNum(ly)) return "vorig jaar —";
  let delta = "";
  if (isNum(now)) {
    if (pctPoints) { const p = (now - ly) * 100; delta = ` (${p >= 0 ? "+" : "−"}${fmt[0].format(Math.abs(p))} pt)`; }
    else if (ly !== 0) { const p = (now / ly - 1) * 100; delta = ` (${p >= 0 ? "+" : "−"}${fmt[0].format(Math.abs(p))} %)`; }
  }
  return `vorig jaar ${fmtFn(ly)}${delta}`;
}

function renderHistory() {
  const h = state.hist.data;
  $$("[data-hunit]").forEach((b) => { const on = b.dataset.hunit === state.hist.unit; b.classList.toggle("on", on); b.setAttribute("aria-pressed", on); });
  $("#hist-label").textContent = h ? histLabel(h) : "—";
  const today = todayIso();
  $("#hist-next").disabled = !h || histShift(h, 1) > today;
  $("#hist-prev").disabled = !h || (h.first_day && new Date(h.start) <= new Date(h.first_day));
  $("#hist-note").textContent = !h ? "" : !h.running ? "" : h.unit === "day" ? "vandaag tot nu; vorig jaar de hele dag" : "tot nu; vorig jaar tot dezelfde dag";
  const T = h?.totals || {}, Y = h?.ly_totals || {};
  const kd = h?.unit === "day" ? 1 : 0, gd = h?.unit === "day" ? 2 : 0; // a single day: decimals
  const k = (x) => `${fmt[kd].format(x)} kWh`, e = (x) => eur(x, gd), p = (x) => (isNum(x) ? `${fmt[0].format(x * 100)} %` : "—");
  setV("h-opgewekt", kwh(T.generated_kwh, kd)); setV("h-opgewekt-ly", vsLastYear(T.generated_kwh, Y.generated_kwh, k));
  setV("h-verbruik", kwh(T.consumption_kwh, kd)); setV("h-verbruik-ly", vsLastYear(T.consumption_kwh, Y.consumption_kwh, k));
  setV("h-zelfv", pct(T.self_sufficiency)); setV("h-zelfv-ly", vsLastYear(T.self_sufficiency, Y.self_sufficiency, p, true));
  setV("h-benut", pct(T.self_consumption)); setV("h-benut-ly", vsLastYear(T.self_consumption, Y.self_consumption, p, true));
  setV("h-net", isNum(T.import_kwh) ? `${fmt[kd].format(T.import_kwh)}<small>· ${fmt[kd].format(T.export_kwh)} kWh</small>` : "—");
  setV("h-net-ly", isNum(Y.import_kwh) ? `vorig jaar ${fmt[kd].format(Y.import_kwh)} · ${fmt[kd].format(Y.export_kwh)} kWh` : "vorig jaar —");
  setV("h-rekening", isNum(T.net_eur) ? eur(T.net_eur, gd) : "—"); setV("h-rekening-ly", vsLastYear(T.net_eur, Y.net_eur, e));
  setV("h-gas", isNum(T.gas_m3) ? unit(fmt[gd].format(T.gas_m3), "m³") : "—"); setV("h-gas-ly", vsLastYear(T.gas_m3, Y.gas_m3, (x) => `${fmt[gd].format(x)} m³`));
  setV("h-graad", isNum(T.degree_days) ? fmt[kd].format(T.degree_days) : "—"); setV("h-graad-ly", vsLastYear(T.degree_days, Y.degree_days, (x) => fmt[kd].format(x)));
  setV("h-gpg", isNum(T.gas_per_degree_day) ? unit(fmt[2].format(T.gas_per_degree_day), "m³") : "—");
  setV("h-gpg-ly", vsLastYear(T.gas_per_degree_day, Y.gas_per_degree_day, (x) => `${fmt[2].format(x)} m³`));
  const dg = h?.bucket === "hour" ? 2 : 1;
  for (const [sel, key, color, digits] of [["[data-hchart=opgewekt]", "generated_kwh", "var(--zon)", dg], ["[data-hchart=verbruik]", "consumption_kwh", "var(--huis)", dg]]) {
    const box = $(sel);
    if (box) box.innerHTML = h ? histChart(h, key, color, box.clientWidth, digits) : "";
  }
  renderHistSoc(h);
  renderHistCar(h);
  const a = $("[data-hlink]");
  if (a) {
    // a day opens Grafana's Dag dashboard, longer periods Periode
    const base = h?.unit === "day" ? state.config.links.day : state.config.links.period;
    a.hidden = !base || !h;
    if (base && h) {
      const u = new URL(base, location.href); // the configured link may carry its own range: replace it
      u.searchParams.set("from", String(new Date(h.start).getTime()));
      u.searchParams.set("to", String(Math.min(new Date(h.end).getTime(), Date.now())));
      a.href = u.toString(); a.target = "_blank"; a.rel = "noopener";
    }
  }
}

// The Auto card for the selected week, month or year (hidden for a day: sessions run across midnight).
// Last year counts only when it lies after the first session; before that "—", not 0 kWh.
const carLy = (c) => !!c && !!c.first && new Date(c.ly_compare_end) > new Date(c.first);
// "none": the period starts after the newest imported home session; "part": it runs past it.
function carHome(c) {
  if (!c?.last_home) return "none";
  const after = new Date(c.last_home).getTime() + 86400000;
  if (new Date(c.start).getTime() > after) return "none";
  return new Date(c.end).getTime() > after && after < Date.now() ? "part" : "ok";
}
const carNoData = (c) => (c?.first && new Date(c.end) <= new Date(c.first) ? `—: laadgegevens beginnen ${dmyTs(c.first)}` : "");
function renderHistCar(h) {
  const card = $("[data-hauto]");
  if (!card) return;
  card.hidden = !h || h.unit === "day";
  const c = h?.car;
  if (card.hidden) return;
  const by = (list) => Object.fromEntries((list || []).map((p) => [p.kind, p]));
  const none = !c || !!carNoData(c);
  const now = by(c?.places), ly = carLy(c) ? by(c.ly_places) : null;
  const k0 = (x) => `${fmt[0].format(x)} kWh`;
  const kwhOf = (p) => (none ? "—" : kwh(p ? p.kwh : 0, 0));
  const lyKwh = (kind) => (ly ? vsLastYear(now[kind]?.kwh ?? 0, ly[kind]?.kwh ?? 0, k0) : "vorig jaar —");
  // Home sessions arrive in batches (the charger's export). A period that starts after the newest one
  // has no home figures yet ("—", not 0); one that runs past it is incomplete, so no change against
  // last year, only "tot <date>" and last year's figure.
  const lastHome = c?.last_home ? new Date(c.last_home) : null;
  const homeNone = !none && carHome(c) === "none", homePart = !none && carHome(c) === "part";
  const upTo = lastHome ? `tot ${lastHome.toLocaleDateString("nl-NL", { day: "numeric", month: "short", timeZone: TZ })}` : "";
  const plainLy = (x, f) => (ly ? `vorig jaar ${f(x ?? 0)}` : "vorig jaar —");
  setV("ha-home", none || homeNone ? "—" : kwh(now.home ? now.home.kwh : 0, 0));
  setV("ha-home-sub", none ? carNoData(c) : homeNone ? `nog niet binnen · ${plainLy(ly?.home?.kwh, k0)}`
    : `${now.home && isNum(now.home.solar_kwh) && now.home.kwh ? `${fmt[0].format((now.home.solar_kwh / now.home.kwh) * 100)} % eigen zon · ` : ""}${homePart ? `${upTo} · ${plainLy(ly?.home?.kwh, k0)}` : lyKwh("home")}`);
  setV("ha-net", none || homeNone ? "—" : eur(c.net_eur ?? 0, 0));
  setV("ha-net-sub", none ? "" : `${homeNone ? "nog niet binnen · " : homePart ? `${upTo} · ` : ""}${plainLy(c.ly_net_eur, (x) => eur(x, 0))}`);
  setV("ha-work", kwhOf(now.work));
  setV("ha-work-sub", none ? "" : `${now.work ? `${eur(now.work.billed_eur, 0)} laadpas · ` : ""}${lyKwh("work")}`);
  setV("ha-public", kwhOf(now.public));
  setV("ha-public-sub", none ? "" : `${now.public ? `${eur(now.public.billed_eur, 0)} laadpas · ` : ""}${lyKwh("public")}`);

  // Home sessions arrive in batches: say so when the period reaches past the newest one.
  const lag = $("[data-hacar]");
  if (lag) {
    const behind = homeNone || homePart;
    lag.hidden = !behind;
    lag.textContent = behind ? `Thuisladen staat erin tot ${dmyTs(c.last_home)}: de laadpaal-export komt in pakketjes binnen.` : "";
  }
  const note = $("[data-mreading]");
  const n = daysAgo(c?.reading_day);
  if (note) {
    note.hidden = !(isNum(n) && n > 90);
    note.textContent = note.hidden ? "" : `De laatste kilometerstand is van ${dmy(c.reading_day)}; tijd voor een nieuwe stand uit de auto-app.`;
  }
  const a = $("[data-hacarlink]");
  if (a) {
    const base = state.config.links.car;
    a.hidden = !base;
    if (base) {
      const u = new URL(base, location.href);
      u.searchParams.set("from", String(new Date(h.start).getTime()));
      u.searchParams.set("to", String(Math.min(new Date(h.end).getTime(), Date.now())));
      a.href = u.toString(); a.target = "_blank"; a.rel = "noopener";
    }
  }
}

let histTimer = null, histSeq = 0;
async function fetchHistory() {
  const seq = ++histSeq;
  const q = new URLSearchParams({ unit: state.hist.unit, date: state.hist.anchor || todayIso() });
  try {
    const r = await fetch(`/api/history?${q}`, { cache: "no-store", credentials: "same-origin" });
    if (r.ok && seq === histSeq) { const j = await r.json(); if (j.data) state.hist.data = j.data; }
  } catch { /* offline: keep what we have */ }
  if (seq === histSeq) { renderHistory(); refreshSheet(); }
}
function histGo(anchor) { state.hist.anchor = anchor; fetchHistory(); }
document.addEventListener("click", (e) => {
  const u = e.target.closest("[data-hunit]");
  if (u) { state.hist.unit = u.dataset.hunit; state.hist.anchor = todayIso(); fetchHistory(); return; }
  if (e.target.closest("#hist-prev") && state.hist.data) histGo(histShift(state.hist.data, -1));
  if (e.target.closest("#hist-next") && state.hist.data) histGo(histShift(state.hist.data, 1));
});

// ---------- Geld screen (/api/money: app_money(); the per-month chart reuses /api/history?unit=year) ----------
state.money = null; state.moneyYear = null;

const eur0 = (x) => eur(x, 0);
const billSub = (b) => (b && isNum(b.net_eur) ? `stroom ${fmt[0].format((b.import_eur ?? 0) - (b.export_eur ?? 0))} · gas ${fmt[0].format(b.gas_eur ?? 0)} · vast ${fmt[0].format(b.fixed_eur ?? 0)}` : "");

function renderMoney() {
  const m = state.money, sv = m?.savings, b27 = m?.bill_2027;
  setV("g-maand", m?.bill_month ? eur(m.bill_month.net_eur) : "—");
  setV("g-maand-sub", billSub(m?.bill_month));
  setV("g-jaar", m?.bill_year ? eur0(m.bill_year.net_eur) : "—");
  setV("g-jaar-sub", billSub(m?.bill_year));

  const filled = !!sv?.filled_at;
  setV("g-bv", sv && isNum(sv.today_eur) ? `≈ ${eur(sv.today_eur)}` : "—");
  setV("g-bm", sv && isNum(sv.month_eur) ? `≈ ${eur(sv.month_eur)}` : "—");
  setV("g-bt", sv && isNum(sv.total_eur) ? `≈ ${eur(sv.total_eur)}` : "—");
  setV("g-bt-sub", sv?.since ? `sinds ${new Date(sv.since).toLocaleDateString("nl-NL", { day: "numeric", month: "short", year: "numeric", timeZone: TZ })}` : "");
  const note = $("[data-gnote]");
  if (note) note.hidden = !m || filled;
  const price = state.config.batteryPriceEur;
  const pb = $("[data-payback]");
  if (pb) {
    pb.hidden = !price;
    if (price) {
      const got = sv && isNum(sv.total_eur) ? Math.max(0, sv.total_eur) : 0;
      $("[data-pbar]").style.width = `${Math.min(100, (got / price) * 100)}%`;
      setV("g-pb", `≈ ${eur0(got)} van ${eur0(price)} terugverdiend (${fmt[1].format((got / price) * 100)} %)`);
    }
  }

  setV("g-27real", b27 ? eur0(b27.real_eur) : "—");
  setV("g-27", b27 ? `≈ ${eur0(b27.net_eur)}` : "—");
  setV("g-27diff", b27 && isNum(b27.net_eur) ? `${b27.net_eur >= b27.real_eur ? "+" : "−"}${eur0(Math.abs(b27.net_eur - b27.real_eur))} onder de regels van 2027` : "");
  const tbl = $("[data-g27]");
  if (tbl) {
    const y = m?.bill_year;
    tbl.innerHTML = b27 && y ? [
      ["Stroom afname", y.import_eur, b27.import_eur],
      ["Teruglevering", -(y.export_eur ?? 0), -(b27.export_eur ?? 0)],
      ["Gas", y.gas_eur, b27.gas_eur],
      ["Vaste kosten", y.fixed_eur, b27.fixed_eur],
    ].map(([l, a, c]) => `<tr><th scope="row">${l}</th><td>${eur0(a)}</td><td>≈ ${eur0(c)}</td></tr>`).join("") : "";
  }

  const box = $("[data-gchart]");
  const h = state.moneyYear;
  if (box) box.innerHTML = h ? histChart(h, "net_eur", "var(--accent)", box.clientWidth, 0) : "";
}

let moneyTimer = null;
async function fetchMoney() {
  const get = async (url) => { try { const r = await fetch(url, { cache: "no-store", credentials: "same-origin" }); return r.ok ? await r.json() : null; } catch { return null; } };
  const [m, y] = await Promise.all([get("/api/money"), get(`/api/history?${new URLSearchParams({ unit: "year", date: todayIso() })}`)]);
  if (m?.data) state.money = m.data;
  if (y?.data) state.moneyYear = y.data;
  renderMoney(); refreshSheet();
}

// ---------- Contracten (/api/contracts: app_contracts()) ----------
state.contracts = null;
const dmy = (d) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString("nl-NL", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "—");
const dmyTs = (iso) => (iso ? new Date(iso).toLocaleDateString("nl-NL", { day: "numeric", month: "short", year: "numeric", timeZone: TZ }) : "—");
const price = (x, d = 4) => (isNum(x) ? `€ ${fmt[d].format(x)}` : "—");
const KIND = { "stroom en gas": "stroom en gas", stroom: "alleen stroom", gas: "alleen gas" };

function contractPrices(c) {
  const parts = [];
  if (c.kind !== "gas") {
    parts.push(`stroom ${price(c.p_normal)}${isNum(c.p_low) && Math.abs(c.p_low - c.p_normal) > 1e-6 ? ` / ${fmt[4].format(c.p_low)} dal` : ""}`);
    parts.push(`terug ${price(c.f_normal)}`);
  }
  if (c.kind !== "stroom") parts.push(`gas ${price(c.p_gas)}`);
  parts.push(`vast ${price(c.p_fixed, 2)}/dag`);
  return parts.join(" · ");
}

function renderContracts() {
  const list = state.contracts?.contracts || [];
  const row = (c) => {
    const term = `${dmy(c.start)} – ${dmy(c.end)}`;
    const chip = c.status === "lopend" ? '<span class="chip on">lopend</span>' : c.status === "komend" ? '<span class="chip">komend</span>' : "";
    const total = isNum(c.net_eur) ? eur(c.net_eur, 0) : "—";
    const sub = c.days ? `${c.days} dagen${c.status === "lopend" ? " tot nu" : ""} · ${eur(c.net_eur / c.days)}/dag` : c.status === "komend" ? "nog niet begonnen" : "geen meetgegevens";
    return `<button type="button" class="crow" data-sheet="contract" data-cid="${c.id}">
      <span class="cmain"><b>${esc(c.name)} ${chip}</b><small>${term} · ${KIND[c.kind] || c.kind}</small><small>${contractPrices(c)}</small></span>
      <span class="ctot"><b>${total}</b><small>${sub}</small></span></button>`;
  };
  const now = list.filter((c) => c.status !== "afgelopen"), past = list.filter((c) => c.status === "afgelopen");
  const a = $('[data-clist="now"]'), b = $('[data-clist="past"]');
  if (a) a.innerHTML = now.length ? now.map(row).join("") : '<p class="empty">—</p>';
  if (b) b.innerHTML = past.length ? past.map(row).join("") : '<p class="empty">—</p>';
}

let contractKey = null;
document.addEventListener("click", (e) => { const r = e.target.closest("[data-cid]"); if (r) contractKey = Number(r.dataset.cid); }, true);

async function fetchContracts() {
  try {
    const r = await fetch("/api/contracts", { cache: "no-store", credentials: "same-origin" });
    if (r.ok) { const j = await r.json(); if (j.data) state.contracts = j.data; }
  } catch { /* offline: keep what we have */ }
  renderContracts(); refreshSheet();
}

// ---------- Meer screen (/api/meer: app_meer(): base load, plugs, car, background sources) ----------
state.meer = null;
const PLACE = { home: "thuis", work: "op het werk", public: "onderweg" };
const watt = (x) => (isNum(x) ? unit(fmt[0].format(x), "W") : "—");
const daysAgo = (d) => (d ? Math.floor((Date.now() - new Date(`${d}T12:00:00Z`)) / 86400000) : null);
const nowIso = () => new Date().toISOString();

// Sources that report in the background, next to the live ones of sources(): when each last delivered.
function backgroundSources() {
  const s = state.meer?.status;
  if (!s) return [];
  // Uploads energy-monitor records after every attempt (upload_status): green when the last success
  // is recent enough, a warning with the error text when not; grey "nog niet gemeld" without a row.
  const up = s.uploads || {};
  const upload = (key, name, limit) => {
    const u = up[key];
    if (!u) return { name, ok: null, text: "nog niet gemeld" };
    const age = secondsBetween(nowIso(), u.last_ok);
    const ok = isNum(age) && age <= limit;
    return { name, ok, error: !ok && u.last_error ? u.last_error : null,
      text: u.last_ok ? `${ago(age)}${u.detail ? ` · ${u.detail}` : ""}` : "nog nooit gelukt" };
  };
  const out = [
    upload("pvoutput", "PVOutput", 15 * 60),
    upload("mindergas", "Mindergas", 26 * 3600),
    up.monta ? upload("monta", "Laadpas-sessies", 20 * 3600)
      : { name: "Laadpas-sessies", age: secondsBetween(nowIso(), s.monta_fetched), limit: 20 * 3600 },
    { name: "Daggemiddelden KNMI", age: secondsBetween(nowIso(), s.knmi_fetched), limit: 20 * 3600, extra: s.knmi_day ? ` · t/m ${dmy(s.knmi_day)}` : "" },
  ];
  out.forEach((x) => { if ("limit" in x) { x.ok = isNum(x.age) && x.age <= x.limit; x.text = ago(x.age) + (x.extra || ""); } });
  const failed = s.jobs_failed || [];
  out.push({ name: "Databasetaken", ok: failed.length === 0 && s.jobs_total > 0,
    text: failed.length ? `${failed.length} van ${s.jobs_total} mislukt` : `${s.jobs_total} van ${s.jobs_total} in orde${s.jobs_last_ok ? `, laatst ${hm(s.jobs_last_ok)}` : ""}` });
  const n = daysAgo(s.reading_day);
  out.push({ name: "Kilometerstand", ok: isNum(n) && n <= 100, text: s.reading_day ? `${dmy(s.reading_day)} (${n} ${n === 1 ? "dag" : "dagen"} geleden)` : "nog geen" });
  return out;
}

function backgroundWarnings() {
  const out = [];
  for (const x of backgroundSources()) {
    if (x.ok !== false) continue;
    if (x.error) { out.push({ level: "warn", text: `${x.name}: laatst gelukt ${x.text}; fout: ${x.error}` }); continue; }
    if (x.name === "Kilometerstand") out.push({ level: "warn", text: "De laatste kilometerstand is meer dan 100 dagen oud; voeg een nieuwe stand uit de auto-app toe." });
    else if (x.name === "Databasetaken") out.push({ level: "warn", text: `Databasetaken: ${(state.meer.status.jobs_failed || []).map((j) => j.what).join(", ")} mislukt.` });
    else out.push({ level: "warn", text: `${x.name}: ${x.text}.` });
  }
  return out;
}

function renderMeerStatus() {
  const box = $("[data-msrc]");
  if (!box) return;
  const list = [...sources(), ...backgroundSources()];
  box.innerHTML = list.map((s) => `<dt>${esc(s.name)}</dt><dd><span class="dot" style="background:var(${s.ok === null ? "--ref" : s.ok ? "--ok" : "--warn"})"></span>${esc(s.text)}</dd>`).join("");
  const w = [...warnings(), ...backgroundWarnings()];
  const ul = $("[data-mwarn]");
  ul.hidden = !w.length;
  ul.innerHTML = w.map((x) => `<li>${esc(x.text)}</li>`).join("");
  setV("m-stat-sum", !state.live ? "" : w.length ? `${w.length} ${w.length === 1 ? "melding" : "meldingen"}` : "alles werkt");
}

function nightChart(nights, median, width) {
  const W = Math.max(300, Math.round(width || 600)), H = Math.round(Math.min(200, Math.max(140, W * 0.3)));
  const L = 44, R = 6, T = 10, B = 24, n = Math.max(nights.length, 1);
  const max = Math.max(100, ...nights.map((x) => x.w).filter(isNum));
  const step = [100, 200, 250, 500, 1000].find((s) => max / s <= 4) || 1000;
  const top = Math.ceil(max / step) * step;
  const y = (v) => T + ((top - v) / top) * (H - T - B);
  const slotW = (W - L - R) / n, cx = (i) => L + slotW * (i + 0.5), bw = Math.max(2, Math.min(14, slotW * 0.7));
  let grid = "";
  for (let v = 0; v <= top; v += step) grid += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="g"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" class="ax">${fmt[0].format(v)}</text>`;
  const every = W < 420 ? 14 : 7;
  const label = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString("nl-NL", { day: "numeric", month: "short", timeZone: "UTC" });
  // the newest night is labelled; a label too close to an edge is anchored to that edge, not cut off
  const tick = (i, text) => { const x = cx(i), a = x > W - R - 24 ? ["end", W - R] : x < L + 24 ? ["start", L] : ["middle", x]; return `<text x="${a[1]}" y="${H - 6}" text-anchor="${a[0]}" class="ax">${text}</text>`; };
  const ticks = nights.map((x, i) => (nights.length - 1 - i) % every === 0 ? tick(i, label(x.night)) : "").join("");
  const bars = nights.map((x, i) => isNum(x.w) ? `<rect x="${(cx(i) - bw / 2).toFixed(1)}" y="${y(x.w).toFixed(1)}" width="${bw.toFixed(1)}" height="${(y(0) - y(x.w)).toFixed(1)}" rx="${Math.min(3, bw / 3).toFixed(1)}" fill="var(${x.car ? "--ref" : "--huis"})"><title>nacht naar ${label(x.night)}: ${fmt[0].format(x.w)} W${x.car ? " (auto laadde thuis)" : ""}</title></rect>` : "").join("");
  const med = isNum(median) ? `<line x1="${L}" x2="${W - R}" y1="${y(median).toFixed(1)}" y2="${y(median).toFixed(1)}" stroke="var(--fg)" stroke-width="1.5" stroke-dasharray="5 4"/>` : "";
  return `<svg viewBox="0 0 ${W} ${H}" role="img">${grid}${bars}${med}${ticks}</svg>`;
}

function renderMeer() {
  const m = state.meer, u = m?.usage;
  setV("m-last", u?.last ? watt(u.last.w) : "—");
  setV("m-last-sub", u?.last ? `nacht naar ${dmy(u.last.night)}${u.last.car ? " · auto laadde thuis" : ""}` : "");
  setV("m-med", u && isNum(u.median_30) ? watt(u.median_30) : "—");
  setV("m-med-sub", u && isNum(u.median_30) ? `mediaan van ${u.n_30} nachten${isNum(u.ly_median_30) ? ` · vorig jaar ${fmt[0].format(u.ly_median_30)} W` : ""}` : "");
  const box = $("[data-mchart]");
  if (box) box.innerHTML = u?.nights?.length ? nightChart(u.nights, u.median_30, box.clientWidth) : "";

  const tb = $("[data-mplugs]");
  if (tb) {
    const plugs = u?.plugs || [];
    const nightSum = plugs.reduce((a, p) => a + (isNum(p.night_w) ? p.night_w : 0), 0);
    const rest = u?.last && !u.last.car && plugs.some((p) => isNum(p.night_w)) ? u.last.w - nightSum : null;
    tb.innerHTML = plugs.length ? plugs.map((p) => `<tr><th scope="row">${esc(plugLabel(p.name))}</th><td>${plain(kwh(p.today_kwh, 2))}</td><td>${plain(watt(p.night_w))}</td></tr>`).join("")
      + (isNum(rest) ? `<tr class="rest"><th scope="row">Rest van het huis</th><td></td><td>${plain(watt(rest))}</td></tr>` : "")
      : '<tr><td colspan="3" class="empty">geen stekkers gezien</td></tr>';
  }

  renderMeerStatus();
}

const GLOSSARY = [
  ["Opgewekt", "Wat de zonnepanelen opwekten."],
  ["Verbruik", "Wat het huis gebruikte, auto en stekkers inbegrepen, of het nu uit de zon, de batterij of het net kwam."],
  ["Afgenomen · teruggeleverd", "Stroom van en naar het net, volgens de slimme meter."],
  ["Zelfvoorzienend", "Deel van je verbruik dat uit eigen zon kwam, direct of via de batterij."],
  ["Zelf benut", "Deel van de opgewekte zon dat je niet teruggeleverd hebt: zelf gebruikt of in de batterij gezet."],
  ["Basislast", "Wat het huis 's nachts tussen 01:00 en 05:00 gemiddeld gebruikt: alles wat altijd aan staat, zoals koelkast, router en stand-by. Nachten waarin de auto thuis laadde tellen niet mee."],
  ["Nog beschikbaar", "Wat er nog uit de batterij kan voordat hij bij de ondergrens stopt."],
  ["Volle cycli", "Hoe vaak de batterij in totaal volgeladen werd: twee keer half vol telt als één cyclus."],
  ["Rendement", "Welk deel van wat de batterij in ging er ook weer uit kwam. De rest gaat verloren als warmte bij het omzetten."],
  ["Graaddagen", "Hoe koud het was, zo gerekend dat het past bij hoeveel dit huis stookt. Twee keer zoveel graaddagen betekent ongeveer twee keer zoveel gas voor verwarming."],
  ["Salderen", "Teruglevering wordt verrekend tegen de stroomprijs, tot de afname op is. Kan tot en met 2026; vanaf 2027 levert teruglevering alleen de terugleververgoeding op."],
  ["Terugleverkosten", "Wat de leverancier rekent voor teruggeleverde stroom: per schijf (staffel) of per kWh."],
  ["≈ en “berekend”", "Een getal dat niet gemeten is maar uitgerekend, met een aanname erin, zoals wat de batterij bespaart of de zonverwachting. Al het andere is gemeten."],
  ["Live en vandaag", "Live is de laatste meting, elke paar seconden ververst. Vandaag loopt van 00:00 tot nu."],
];
function renderGlossary() {
  const box = $("[data-mgloss]");
  if (box && !box.childElementCount) box.innerHTML = GLOSSARY.map(([t, d]) => `<details><summary>${esc(t)}</summary><p>${esc(d)}</p></details>`).join("");
  const ul = $("[data-mlinks]");
  if (ul) {
    const L = state.config.links;
    ul.innerHTML = [
      '<li><a href="#contracten">Energiecontracten</a></li>',
      '<li><a href="?kiosk">Wandweergave</a></li>',
      ...[["plugs", "Stekkers"], ["car", "Auto"], ["tech", "Techniek"]].filter(([k]) => L[k]).map(([k, t]) => `<li><a href="${esc(L[k])}" target="_blank" rel="noopener">${t} in Grafana ↗</a></li>`),
    ].join("");
  }
}

let meerTimer = null;
async function fetchMeer() {
  try {
    const r = await fetch("/api/meer", { cache: "no-store", credentials: "same-origin" });
    if (r.ok) { const j = await r.json(); if (j.data) state.meer = j.data; }
  } catch { /* offline: keep what we have */ }
  renderMeer(); refreshSheet();
}

// ---------- Batterij screen (/api/battery: app_battery_soc_today, _summary, _efficiency) ----------
// Fetched only while the screen is open, every batteryInterval seconds; live values (charge level,
// power, temperature) come from the same stream as Thuis.
const EFF_PATHS = [
  ["solar", "Zon → batterij + huis", "var(--zon)"],
  ["battery", "Batterij → huis", "var(--bat)"],
  ["socket", "Stopcontact → batterij", "var(--uit)"],
  // No "Zon → huis (batterij vol)": in standby the battery reports its AC output as exactly its PV
  // power, so that ratio is ~100 % by construction, not a measurement.
];

// Charge level over today as an SVG line: 00:00 – 24:00 on x (23 or 25 hours on a clock change
// day), 0 – 100 % on y, the two limits as dashed steps. A gap of more than 15 minutes breaks the line.
let socChartSeq = 0;
function socChart(rows, dayStart, dayEnd, width) {
  // drawn at the card's own width, so the 12 px labels stay 12 px on a phone
  const W = Math.max(300, Math.round(width || 600)), H = Math.round(Math.min(240, Math.max(170, W * 0.36)));
  const L = 38, R = 6, T = 10, B = 26;
  const t0 = new Date(dayStart).getTime(), t1 = new Date(dayEnd).getTime();
  const x = (t) => L + ((new Date(t).getTime() - t0) / (t1 - t0)) * (W - L - R);
  const y = (v) => T + (1 - v / 100) * (H - T - B);
  // own gradient ids per drawing: Batterij and Historie can both hold one, at different heights
  const gid = `soc${++socChartSeq}`;
  const grid = [0, 25, 50, 75, 100].map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="g"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" class="ax">${v}%</text>`).join("");
  const hours = Math.round((t1 - t0) / 3600000);
  const ticks = [0, 6, 12, 18, hours].map((h) => `<text x="${x(t0 + h * 3600000)}" y="${H - 6}" text-anchor="${h === 0 ? "start" : h === hours ? "end" : "middle"}" class="ax">${String(h === hours ? 24 : h).padStart(2, "0")}:00</text>`).join("");
  // runs of [x, y] points per series; a gap of more than 15 minutes starts a new run
  const runs = (key) => {
    const out = []; let prev = null;
    for (const r of rows) {
      if (!isNum(r[key])) { prev = null; continue; }
      if (!prev || new Date(r.time) - new Date(prev.time) > 15 * 60000) out.push([]);
      out[out.length - 1].push([x(r.time), y(r[key])]);
      prev = r;
    }
    return out;
  };
  const f1 = (n) => n.toFixed(1);
  const line = (rs, step) => rs.map((pts) => pts.map(([px, py], i) => (i === 0 ? `M${f1(px)} ${f1(py)}` : step ? `H${f1(px)}V${f1(py)}` : `L${f1(px)} ${f1(py)}`)).join("")).join("");
  const socRuns = runs("soc");
  const soc = { d: line(socRuns, false), last: socRuns.length ? socRuns[socRuns.length - 1].slice(-1)[0] : null };
  const up = { d: line(runs("charge_limit_soc"), true) }, low = { d: line(runs("discharge_limit_soc"), true) };
  const area = socRuns.map((pts) => `M${f1(pts[0][0])} ${y(0)}${pts.map(([px, py]) => `L${f1(px)} ${f1(py)}`).join("")}L${f1(pts[pts.length - 1][0])} ${y(0)}Z`).join("");
  // Colour by level: green from 50 %, amber from 20 %, red below. A vertical gradient pinned to the
  // y axis (userSpaceOnUse) gives every part of the line the colour of its own height. The area
  // under it stays neutral: it reaches down to 0 %, so in the same colours it would always show red.
  const lastSoc = [...rows].reverse().find((r) => isNum(r.soc))?.soc;
  const stops = (op0, op1) => {
    const o = (v) => f1((1 - v / 100) * 100);   // offset (%) of level v from the top
    const st = (off, c, op) => `<stop offset="${off}%" stop-color="var(${c})" stop-opacity="${op}"/>`;
    const fade = (v) => (op0 + (op1 - op0) * (1 - v / 100)).toFixed(3);
    return st(0, "--ok", fade(100)) + st(o(SOC_GREEN), "--ok", fade(SOC_GREEN)) + st(o(SOC_GREEN), "--warn", fade(SOC_GREEN))
      + st(o(SOC_RED), "--warn", fade(SOC_RED)) + st(o(SOC_RED), "--bad", fade(SOC_RED)) + st(100, "--bad", fade(0));
  };
  const grad = (id, op0, op1) => `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" x2="0" y1="${y(100)}" y2="${y(0)}">${stops(op0, op1)}</linearGradient>`;
  const dot = soc.last ? `<circle cx="${soc.last[0]}" cy="${soc.last[1]}" r="4" fill="var(${socColor(lastSoc)})" stroke="var(--card)" stroke-width="2"/>` : "";
  const empty = rows.length ? "" : `<text x="${(L + W - R) / 2}" y="${y(50)}" text-anchor="middle" class="ax">—: nog geen metingen vandaag</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Laadniveau vandaag">
    <defs>${grad(`${gid}l`, 1, 1)}<linearGradient id="${gid}f" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--muted)" stop-opacity=".16"/><stop offset="1" stop-color="var(--muted)" stop-opacity=".02"/></linearGradient></defs>
    ${grid}${ticks}
    <path d="${area}" fill="url(#${gid}f)"/>
    <path d="${up.d}" class="lim-line"/><path d="${low.d}" class="lim-line"/>
    <path d="${soc.d}" fill="none" stroke="url(#${gid}l)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
    ${dot}${empty}
  </svg>`;
}

function renderEfficiency(rows) {
  const box = $("[data-eff]");
  if (!box) return;
  const used = EFF_PATHS.filter(([k]) => (rows || []).some((r) => isNum(r[k])));
  const bands = (rows || []).filter((r) => used.some(([k]) => isNum(r[k])));
  if (!bands.length) { box.innerHTML = '<p class="empty">—: nog te weinig metingen (een vermogensband telt vanaf 5 minuten).</p>'; return; }
  const legend = `<p class="legend">${used.map(([, label, c]) => `<span><i class="sq" style="--c:${c}"></i>${label}</span>`).join("")}</p>`;
  const body = bands.map((r) => `<button type="button" class="eff-row" data-sheet="rendement"><span class="eff-l">${esc(r.label)}</span><span class="eff-bars">${
    used.map(([k, label, c]) => isNum(r[k])
      ? `<span class="eff-bar" title="${label}"><span style="--c:${c};width:${Math.max(0, Math.min(100, r[k] * 100)).toFixed(1)}%"></span><b>${fmt[0].format(r[k] * 100)}%</b></span>`
      : "").join("")}</span></button>`).join("");
  box.innerHTML = legend + body;
}

function renderBattery() {
  const b = state.battery;
  const s = b?.summary || null;
  const chart = $("[data-soc-chart]");
  if (chart && b?.soc && b.day_start) chart.innerHTML = socChart(b.soc, b.day_start, b.day_end, chart.clientWidth);
  setV("soc-range", s && isNum(s.min_soc) ? `vandaag ${fmt[0].format(s.min_soc)}–${fmt[0].format(s.max_soc)}%` : "");
  renderEfficiency(b?.efficiency);
  const t = state.today?.data;
  setV("socket-today", t && isNum(t.battery_in_kwh) && t.battery_in_kwh >= 0.05 ? `waarvan ${num(t.battery_in_kwh)} kWh uit het stopcontact` : "");
  setV("sinds-nieuw", s && isNum(s.charged_total_kwh) ? `${num(s.charged_total_kwh)}<small>· ${num(s.discharged_total_kwh)} kWh</small>` : "—");
  setV("sinds-nieuw-sub", s ? "tellers van de batterij" : "");
  setV("celrendement", s && isNum(s.cell_efficiency_30d) ? unit(fmt[0].format(s.cell_efficiency_30d * 100), "%") : "—");
  setV("soh", s && isNum(s.soh) ? unit(fmt[0].format(s.soh), "%") : "—");
  setV("rated", kwh(s?.rated_kwh));
  setV("cycli", s && isNum(s.full_cycles) ? fmt[1].format(s.full_cycles) : "—");
  setV("temp-range", s && isNum(s.temp_min_c) ? `${fmt[0].format(s.temp_min_c)}–${fmt[0].format(s.temp_max_c)}<small>°C</small>` : "—");
}

let batteryTimer = null;
async function fetchBattery() {
  try {
    const r = await fetch("/api/battery", { cache: "no-store", credentials: "same-origin" });
    if (r.ok) state.battery = await r.json();
  } catch { /* offline: keep what we have */ }
  renderBattery(); refreshSheet();
}

// ---------- Zon sheet: per string (app_solar_live with the live stream, /api/solar for the day) ----------
const STRINGS = [["east", "Oost", "var(--oost)"], ["west", "West", "var(--zon)"]];

// Read on demand only: when the Zon sheet is (re)drawn and the day is older than SOLAR_INTERVAL. Every
// attempt counts, so a failing read is retried after the interval, not on every live update.
state.solarAt = 0;
let solarBusy = false;
async function fetchSolar() {
  if (solarBusy) return;
  solarBusy = true;
  state.solarAt = Date.now();
  try {
    const r = await fetch("/api/solar", { cache: "no-store", credentials: "same-origin" });
    if (r.ok) state.solar = await r.json();
  } catch { /* offline: keep what we have */ } finally { solarBusy = false; }
  refreshSheet();
}
function maybeFetchSolar() {
  if (Date.now() - state.solarAt > (state.config.solarInterval ?? 60) * 1000) fetchSolar();
}

const hmRange = (a, b) => (a && b ? `${hm(a)}–${hm(b)}` : "");

// The per-string table, a line about low voltage when there is something to say, and the hour chart.
function stringsBlock(day) {
  const s = state.live?.strings;
  const live = !!s?.strings_time;
  const cell = (f) => STRINGS.map(([key]) => `<td>${f(key)}</td>`).join("");
  const fc = (key) => (day && isNum(day[`${key}_fc_sofar_kwh`]) ? `≈ ${num(day[`${key}_fc_sofar_kwh`])} kWh` : "—");
  const low = (key) => {
    if (!day) return "—";
    const m = day[`${key}_low_min`];
    const txt = isNum(m) ? `${fmt[0].format(m)} min` : "—";
    return s?.[`${key}_stuck`] ? `<b style="color:var(--bad)">${txt} · nu</b>` : m > 0 ? `<b style="color:var(--warn)">${txt}</b>` : txt;
  };
  const head = STRINGS.map(([, name, c]) => `<th><i class="sq" style="--c:${c}"></i>${name}</th>`).join("");
  const table = `<table class="t27 tstrings"><thead><tr><th></th>${head}</tr></thead><tbody>
    <tr><th scope="row">Nu</th>${cell((k) => (live ? plain(power(s[`${k}_w`])) : "—"))}</tr>
    <tr><th scope="row">Spanning · stroom</th>${cell((k) => (live && isNum(s[`${k}_v`]) ? `${num(s[`${k}_v`], 0)} V · ${num(s[`${k}_a`], 2)} A` : "—"))}</tr>
    <tr><th scope="row">Vandaag</th>${cell((k) => (day ? plain(kwh(day[`${k}_kwh`])) : "—"))}</tr>
    <tr><th scope="row">Verwacht tot nu</th>${cell(fc)}</tr>
    <tr><th scope="row">Lage spanning</th>${cell(low)}</tr>
  </tbody></table>`;

  // One sentence per string with low voltage today: stuck now (with the other string's voltage for
  // comparison), or how long and when it was earlier today.
  const lines = STRINGS.map(([key, name], i) => {
    const other = STRINGS[1 - i];
    const m = day?.[`${key}_low_min`];
    const span = day ? hmRange(day[`${key}_low_first`], day[`${key}_low_last`]) : "";
    if (s?.[`${key}_stuck`]) {
      const ov = isNum(s[`${other[0]}_v`]) && s[`${other[0]}_a`] >= 0.1 ? ` (${other[1].toLowerCase()}: ${num(s[`${other[0]}_v`], 0)} V)` : "";
      return `<p class="sline bad"><b>${name} hangt nu op lage spanning</b>: ${num(s[`${key}_v`], 0)} V bij ${num(s[`${key}_a`], 2)} A${ov}. Die string levert nu minder dan hij kan.${m > 0 ? ` Vandaag al ${fmt[0].format(m)} min${span ? `, eerste keer ${hm(day[`${key}_low_first`])}` : ""}.` : ""}</p>`;
    }
    if (m > 0) return `<p class="sline">${name} hing vandaag ${fmt[0].format(m)} min op lage spanning${span ? ` (tussen ${span})` : ""}.</p>`;
    return "";
  }).join("");

  const legend = `<p class="legend">${STRINGS.map(([, name, c]) => `<span><i class="sq" style="--c:${c}"></i>${name}</span>`).join("")}<span><i class="ln dash" style="border-top-color:var(--fg)"></i>verwacht ≈</span><span><i class="ln" style="--c:var(--bad)"></i>lage spanning</span><span>Wh per uur</span></p>`;
  return `<h4 class="sub">Per string</h4>${table}${lines}<div class="chart" data-solar-chart></div>${day ? legend : ""}`;
}

// Today per hour: a bar per string (measured DC Wh), a dashed tick at that string's forecast, and a red
// mark under a bar for an hour with low voltage. Only the hours with sun (measured or forecast).
function solarChart(day, width) {
  if (!day) return '<p class="empty">Laden…</p>';
  const hours = day.hours || [];
  const vals = (h) => [h.east_wh, h.west_wh, h.east_fc_wh, h.west_fc_wh].filter(isNum);
  const active = hours.map((h, i) => (Math.max(0, ...vals(h)) >= 5 ? i : -1)).filter((i) => i >= 0);
  if (!active.length) return '<p class="empty">—: nog geen zon gemeten of verwacht vandaag.</p>';
  const sel = hours.slice(active[0], active[active.length - 1] + 1);
  const W = Math.max(300, Math.round(width || 600)), H = Math.round(Math.min(220, Math.max(160, W * 0.34)));
  const L = 40, R = 6, T = 10, B = 26;
  const maxV = Math.max(100, ...sel.flatMap(vals));
  const step = [50, 100, 250, 500, 1000].find((st) => maxV / st <= 4) || 1000;
  const top = Math.ceil(maxV / step) * step;
  const y = (v) => T + (1 - v / top) * (H - T - B);
  const slot = (W - L - R) / sel.length;
  const bw = Math.max(2, Math.min(16, slot * 0.36)), gap = Math.max(1, Math.round(slot * 0.06));
  const f1 = (n) => n.toFixed(1);
  const grid = [];
  for (let v = 0; v <= top; v += step) grid.push(`<line x1="${L}" x2="${W - R}" y1="${f1(y(v))}" y2="${f1(y(v))}" class="g"/><text x="${L - 6}" y="${f1(y(v) + 4)}" text-anchor="end" class="ax">${fmt[0].format(v)}</text>`);
  const every = Math.max(1, Math.ceil(28 / slot));
  const bars = sel.map((h, i) => {
    const cx = L + slot * (i + 0.5);
    const hour = hm(h.hour).slice(0, 2);
    const label = i % every === 0 ? `<text x="${f1(cx)}" y="${H - 6}" text-anchor="middle" class="ax">${hour}</text>` : "";
    const parts = STRINGS.map(([key, name, c], j) => {
      const x = j === 0 ? cx - gap / 2 - bw : cx + gap / 2;
      const v = h[`${key}_wh`], e = h[`${key}_fc_wh`], lowMin = h[`${key}_low_min`];
      const bar = isNum(v) && v > 0 ? `<rect x="${f1(x)}" y="${f1(y(v))}" width="${f1(bw)}" height="${f1(y(0) - y(v))}" rx="1.5" fill="${c}"/>` : "";
      const tick = isNum(e) && e > 0 ? `<line x1="${f1(x - 1)}" x2="${f1(x + bw + 1)}" y1="${f1(y(e))}" y2="${f1(y(e))}" class="fc-tick"/>` : "";
      const low = isNum(lowMin) && lowMin > 0 ? `<rect x="${f1(x)}" y="${f1(y(0) + 2)}" width="${f1(bw)}" height="3" fill="var(--bad)"/>` : "";
      return bar + tick + low;
    }).join("");
    const tip = STRINGS.map(([key, name]) => `${name.toLowerCase()} ${isNum(h[`${key}_wh`]) ? fmt[0].format(h[`${key}_wh`]) : "—"} Wh (≈ ${isNum(h[`${key}_fc_wh`]) ? fmt[0].format(h[`${key}_fc_wh`]) : "—"})${h[`${key}_low_min`] > 0 ? `, ${fmt[0].format(h[`${key}_low_min`])} min lage spanning` : ""}`).join(" · ");
    return `<g><title>${hour}:00 · ${tip}</title><rect x="${f1(cx - slot / 2)}" y="${T}" width="${f1(slot)}" height="${H - T - B}" fill="transparent"/>${parts}</g>${label}`;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Zon per string per uur, vandaag">${grid.join("")}${bars}</svg>`;
}

// ---------- screens, by the address's #hash (Thuis is the default) ----------
const SCREENS = { thuis: "Thuis", historie: "Historie", geld: "Geld", batterij: "Batterij", meer: "Meer", contracten: "Contracten" };
const TAB_OF = { contracten: "geld" }; // screens without their own tab light up their parent's
function currentScreen() { const h = location.hash.replace("#", ""); return SCREENS[h] ? h : "thuis"; }
function showScreen() {
  const name = currentScreen();
  for (const key of Object.keys(SCREENS)) $(`#scr-${key}`).hidden = key !== name;
  $("#page-title").textContent = SCREENS[name];
  document.title = name === "thuis" ? "Energie" : `${SCREENS[name]} · Energie`;
  $$("[data-tabs] .tab[data-screen]").forEach((a) => {
    const on = a.dataset.screen === (TAB_OF[name] || name);
    a.classList.toggle("on", on);
    if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  clearInterval(batteryTimer); batteryTimer = null;
  clearInterval(histTimer); histTimer = null;
  clearInterval(moneyTimer); moneyTimer = null;
  clearInterval(meerTimer); meerTimer = null;
  if (name === "meer" && !wallMode) {
    renderGlossary();
    fetchMeer();
    meerTimer = setInterval(fetchMeer, 60000);
  }
  if (name === "contracten" && !wallMode) fetchContracts();
  if (name === "geld" && !wallMode) {
    fetchMoney();
    moneyTimer = setInterval(fetchMoney, 60000);
  }
  if (name === "historie" && !wallMode) {
    if (!state.hist.anchor) state.hist.anchor = todayIso();
    fetchHistory();
    // a running period changes during the day; a past one doesn't
    histTimer = setInterval(() => { if (state.hist.data?.running) fetchHistory(); }, 60000);
  }
  if (name === "batterij" && !wallMode) {
    fetchBattery();
    batteryTimer = setInterval(fetchBattery, Math.max(30, state.config.batteryInterval || 60) * 1000);
  }
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", showScreen);
let resizeTimer = null;
window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (state.battery) renderBattery(); if (state.hist.data) renderHistory(); if (state.money) renderMoney(); }, 200); });

// ---------- tabs ----------
const ICONS = {
  thuis: '<path d="M3 11l9-7 9 7v9H3z"/>',
  historie: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  geld: '<circle cx="12" cy="12" r="9"/><path d="M15 9a3 3 0 1 0 0 6M8 11h6M8 13h6"/>',
  batterij: '<rect x="3" y="7" width="16" height="10" rx="2"/><path d="M21 10v4"/>',
  meer: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
};
function renderTabs() {
  const L = state.config.links;
  const tab = (key, label, href) => {
    const svg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">${ICONS[key]}</svg>`;
    if (SCREENS[key]) return `<a class="tab" data-screen="${key}" href="#${key === "thuis" ? "" : key}">${svg}<span>${label}</span></a>`;
    if (!href) return "";
    return `<a class="tab" href="${esc(href)}" target="_blank" rel="noopener" title="${label} in Grafana">${svg}<span>${label} <span class="ext">↗</span></span></a>`;
  };
  const html = tab("thuis", "Thuis") + tab("batterij", "Batterij") + tab("historie", "Historie") + tab("geld", "Geld") + tab("meer", "Meer");
  $$("[data-tabs]").forEach((n) => { n.innerHTML = html; });
  $$("[data-link]").forEach((a) => {
    const href = L[a.dataset.link];
    a.hidden = !href;
    if (href) { a.href = href; a.target = "_blank"; a.rel = "noopener"; }
  });
}

// ---------- data: one EventSource, cache for offline ----------
function save() {
  try { localStorage.setItem("energie.last", JSON.stringify({ live: state.live, today: state.today, liveAt: state.liveAt })); } catch { /* private mode */ }
}
function restore() {
  try {
    const c = JSON.parse(localStorage.getItem("energie.last") || "null");
    if (c?.live) { state.live = c.live; state.today = c.today; state.liveAt = c.liveAt || 0; state.cached = true; }
  } catch { /* nothing cached */ }
}

async function checkAuth() {
  try {
    const r = await fetch("/api/live", { redirect: "manual", cache: "no-store", credentials: "same-origin" });
    if (r.type === "opaqueredirect" || r.status === 401 || r.status === 403 || (r.status >= 300 && r.status < 400)) return "login";
    return r.ok ? "ok" : "offline";
  } catch { return "offline"; }
}

// EventSource reconnects by itself after a dropped connection, but gives up for good when a reconnect
// gets an error reply (Traefik's 502/404 while the app restarts or redeploys, or Authelia's login page):
// then readyState is CLOSED and nothing would ever update again. So reconnect ourselves, with a
// growing delay (5 s, 10 s, … up to a minute), unless the session needs a new login.
let source = null, failures = 0, retryTimer = null;
function connect() {
  clearTimeout(retryTimer); retryTimer = null;
  if (source) source.close();
  const es = new EventSource("/api/stream");
  source = es;
  es.addEventListener("live", (e) => {
    state.live = JSON.parse(e.data); state.liveAt = Date.now(); state.cached = false; failures = 0; state.auth = "ok";
    renderLive(); refreshSheet(); save();
  });
  es.addEventListener("today", (e) => {
    state.today = JSON.parse(e.data); renderToday(); renderLive(); refreshSheet(); save();
  });
  es.onerror = async () => {
    failures += 1;
    if (failures < 2 && es.readyState !== EventSource.CLOSED) return; // it retries on its own
    state.auth = await checkAuth();
    if (es !== source) return; // replaced meanwhile
    if (state.auth === "login") {
      es.close();
      if (wallMode) setTimeout(() => location.reload(), 30000);
    } else if (es.readyState === EventSource.CLOSED && !retryTimer) {
      retryTimer = setTimeout(connect, Math.min(60000, 5000 * failures));
    }
    renderStatus(); renderFreshness(); renderWallFoot();
  };
}
// A phone that comes back to the app: don't wait for the retry delay.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && source && source.readyState === EventSource.CLOSED && state.auth !== "login") connect();
});

// ---------- wall view ----------
function startWall() {
  document.documentElement.dataset.theme = "dark";
  document.body.classList.add("walled");
  $("#wall").hidden = false;
  const tick = () => {
    const now = new Date();
    $("#w-clock").textContent = now.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
    $("#w-date").textContent = now.toLocaleDateString("nl-NL", { weekday: "short", day: "numeric", month: "long", timeZone: TZ });
    const h = Number(now.toLocaleString("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: TZ }));
    $("#wall").classList.toggle("night", h >= 23 || h < 7);
  };
  tick(); setInterval(tick, 10000);
  // Against burn-in: move everything a few pixels each minute.
  setInterval(() => {
    const dx = Math.round(Math.random() * 12 - 6), dy = Math.round(Math.random() * 12 - 6);
    $("#wall-in").style.transform = `translate(${dx}px, ${dy}px)`;
  }, 60000);
  let lock = null;
  const keepAwake = async () => { try { if ("wakeLock" in navigator && document.visibilityState === "visible") lock = await navigator.wakeLock.request("screen"); } catch { /* not allowed */ } };
  document.addEventListener("visibilitychange", keepAwake);
  keepAwake();
}

// ---------- start ----------
async function start() {
  $$("[data-flow]").forEach((n) => { n.innerHTML = flowSvg(); });
  restore();
  try {
    const r = await fetch("/api/config", { cache: "no-store" });
    if (r.ok) state.config = { ...state.config, ...(await r.json()) };
  } catch { /* offline: defaults */ }
  if (state.config.timeZone) TZ = state.config.timeZone;
  renderTabs();
  showScreen();
  if (wallMode) startWall();
  if (state.live) { renderToday(); renderLive(); }
  connect();
  setInterval(() => { renderFreshness(); }, 1000);
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
}
start();
