// Thuis screen: the flow picture, the tiles and the status lines.

import { $, $$, ago, clock, esc, eur, fmt, hm, isNum, kwh, num, pct, plain, power, socColor, state, todayData,
  todaySavings, unit, wallMode, ymd } from "./util.js";
import { renderBattery, renderMeerStatus } from "./screens.js";
import { STRINGS } from "./detail.js";

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
export function flowSvg() {
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
      <rect x="292" y="10" width="66" height="44" fill="transparent"/><!-- tap area: the value alone is ~20 px tall -->
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
  // house use below 0 is a sampling artefact (P1 and battery read at different instants): show 0
  circleValue(t, "huis", has ? Math.max(0, d.house_w) : null);
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
export const setV = (key, html) => $$(`[data-v="${key}"]`).forEach((el) => { el.innerHTML = html; });
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
export const plugLabel = (name) => state.config.plugLabels[name] || (name ? name[0].toUpperCase() + name.slice(1) : "?");
export const secondsBetween = (later, earlier) => (later && earlier ? (new Date(later) - new Date(earlier)) / 1000 : null);

function liveAge() {
  const d = state.live?.data;
  if (!d || !d.flow_time) return null;
  // age at the server when read, plus how long ago we received it
  return secondsBetween(d.db_now, d.flow_time) + (Date.now() - state.liveAt) / 1000;
}

export function renderLive() {
  const d = state.live?.data || null;
  const today = todayData() || null;
  $$("[data-flow] > svg").forEach((svg) => renderFlow(svg, d, today));

  const plugs = $("#plugs");
  const list = d?.plugs || [];
  plugs.innerHTML = list.length
    ? list.map((p) => `<button type="button" data-sheet="plug:${esc(p.name)}">${plugIcon(p.name)}<span>${esc(plugLabel(p.name))}</span><b>${plain(power(p.w))}</b></button>`).join("")
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

export function renderToday() {
  const t = todayData() || null;
  const s = todaySavings() || null;
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

// the calendar day offsetDays from today in the app's time zone (not now + 24 h, which lands on the
// wrong day on the evening before the spring clock change)
export const weekday = (offsetDays) => {
  const [y, m, d] = ymd(new Date().toISOString());
  return new Date(Date.UTC(y, m - 1, d + offsetDays, 12)).toLocaleDateString("nl-NL", { weekday: "long", day: "numeric", month: "short", timeZone: "UTC" });
};
export const approx = (x) => (isNum(x) ? `≈ ${kwh(x)}` : "—");

function forecastAge() {
  const f = state.today?.forecast;
  return f?.fetched_at ? (Date.now() - new Date(f.fetched_at)) / 1000 : null;
}

function renderForecast() {
  const f = state.today?.forecast || null;
  const t = todayData() || null;
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

export function renderFreshness() {
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
  // The wall view: from across the room, old numbers must not look live (audit #32). Dimmed, the
  // lines stand still, and "verouderd · 17:03" under the clock.
  if (wallMode) {
    $("#wall").classList.toggle("stale", stale);
    const ws = $("#w-stale");
    ws.hidden = !stale;
    ws.textContent = !stale ? "" : d?.flow_time ? `verouderd · ${hm(d.flow_time)}` : "geen meting";
  }
  const batStale = !d?.battery_time;
  bat.textContent = batStale ? "— · geen meting in de laatste 5 minuten" : stale ? `verouderd · ${hm(d.battery_time)}` : "live";
  bat.classList.toggle("stale", batStale || stale);
}

// ---------- status ----------
export function sources() {
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

export function warnings() {
  const out = [];
  if (state.auth === "login") out.push({ level: "bad", text: "Je bent uitgelogd. Laad de pagina opnieuw om in te loggen." });
  if (state.live?.ok === false || state.today?.ok === false) out.push({ level: "bad", text: "De app kan de database nu niet lezen; je ziet de laatste waarden." });
  if (state.auth === "offline") out.push({ level: "warn", text: "Geen verbinding met de server; je ziet de laatste waarden." });
  for (const s of sources()) if (!s.ok) out.push({ level: "warn", text: `${s.name}: ${s.text}.` });
  const d = state.live?.data;
  if (d && isNum(d.grid_w) && isNum(d.battery_cells_w) && d.grid_w > 50 && d.battery_cells_w < -50 && !(d.socket_in_w > 50)) { // charging from the socket on purpose is no CT-meter problem
    out.push({ level: "warn", text: `Het huis neemt ${plain(power(d.grid_w))} van het net terwijl de batterij ${plain(power(-d.battery_cells_w))} laadt. Waarschijnlijk ziet de CT-meter van de batterij fase 2 niet, zodat hij te weinig aan het huis levert.` });
  }
  const s = state.live?.strings;
  for (const [k, name] of STRINGS) {
    if (s?.[`${k}_stuck`] && !state.cached) out.push({ level: "warn", text: `Zonnepanelen ${name.toLowerCase()}: de string hangt op lage spanning (${num(s[`${k}_v`], 0)} V bij ${num(s[`${k}_a`], 2)} A) en levert minder dan hij kan. Tik op de zon voor de details.` });
  }
  return out;
}

export function renderStatus() {
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

export function renderWallFoot() {
  if (!wallMode) return;
  const w = warnings();
  const el = $("#w-status");
  el.textContent = w.length ? `● ${w.length} ${w.length === 1 ? "melding" : "meldingen"}` : "● Alles werkt";
  el.className = w.length ? "warn" : "";
  const d = state.live?.data;
  $("#w-bat").textContent = d && isNum(d.available_kwh) ? `Batterij ${fmt[0].format(d.soc)}% · ${fmt[1].format(d.available_kwh)} kWh beschikbaar` : "Batterij —";
}
