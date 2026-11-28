// Today per hour and per string: the day charts behind the Thuis sheets.

import { $, fmt, hm, isNum, kwh, num, plain, power, state } from "./util.js";
import { refreshSheet } from "./sheets.js";
import { fetchBattery } from "./screens.js";

// ---------- Zon sheet: per string (app_solar_live with the live stream, /api/solar for the day) ----------
export const STRINGS = [["east", "Oost", "var(--oost)"], ["west", "West", "var(--zon)"]];

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
export function maybeFetchSolar() {
  if (Date.now() - state.solarAt > (state.config.solarInterval ?? 60) * 1000) fetchSolar();
}

const hmRange = (a, b) => (a && b ? `${hm(a)}–${hm(b)}` : "");

// The per-string table, a line about low voltage when there is something to say, and the hour chart.
export function stringsBlock(day) {
  const s = state.live?.strings;
  const live = !!s?.strings_time;
  const cell = (f) => STRINGS.map(([key]) => `<td>${f(key)}</td>`).join("");
  const fc = (key) => (day && isNum(day[`${key}_fc_sofar_kwh`]) ? `≈ ${num(day[`${key}_fc_sofar_kwh`])} kWh` : "—");
  const low = (key) => {
    if (!day) return "—";
    const m = day[`${key}_low_min`];
    const txt = isNum(m) ? `${fmt[0].format(m)} min` : "—";
    return s?.[`${key}_stuck`] ? `<b style="color:var(--bad-text)">${txt} · nu</b>` : m > 0 ? `<b style="color:var(--warn-text)">${txt}</b>` : txt;
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
export function solarChart(day, width) {
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

// ---------- today per hour behind the Huis, Net, Gas, Buiten and plug sheets (/api/detail) ----------
// Read on demand like the Zon sheet: when one of these sheets is drawn and the data is older than
// DETAIL_INTERVAL; every attempt counts, so a failing read is retried after the interval.
state.detailAt = 0;
let detailBusy = false;
async function fetchDetail() {
  if (detailBusy) return;
  detailBusy = true;
  state.detailAt = Date.now();
  try {
    const r = await fetch("/api/detail", { cache: "no-store", credentials: "same-origin" });
    if (r.ok) state.detail = await r.json();
  } catch { /* offline: keep what we have */ } finally { detailBusy = false; }
  refreshSheet();
}
export function maybeFetchDetail() {
  if (Date.now() - state.detailAt > (state.config.detailInterval ?? 60) * 1000) fetchDetail();
}
// The Batterij sheet reuses the Batterij screen's data (/api/battery).
state.batteryAt = 0;
export function maybeFetchBattery() {
  if (Date.now() - state.batteryAt > (state.config.batteryInterval ?? 60) * 1000) { state.batteryAt = Date.now(); fetchBattery(); }
}

const hourRange = (iso) => { const a = hm(iso); return `${a}–${String((+a.slice(0, 2) + 1) % 24).padStart(2, "0")}:00`; };
// The hour of the day's rows with the highest value, as "18:00–19:00 · 1,2 kWh".
export function peakHour(hours, key, u, d = 1) {
  const best = (hours || []).filter((h) => isNum(h[key])).reduce((a, h) => (!a || h[key] > a[key] ? h : a), null);
  return best && best[key] >= 0.5 * 10 ** -d ? `${hourRange(best.hour)} · ${fmt[d].format(best[key])} ${u}` : "—";
}

// One chart for a day per hour. bars: [{key, color, neg}] (a neg bar goes below zero, e.g. export);
// tick: {key} a dashed mark per hour (yesterday); line: {points: [{time, v}], color, unit} on its own
// axis at the right (outdoor temperature). x runs over the whole day, so the rest of today is empty.
// tipFmt formats a value in the hover/finger label (default: digits + 1 decimals).
export function dayChart(day, { bars, tick, line, width, digits = 1, tipFmt = (v) => fmt[digits + 1].format(v) }) {
  if (!day) return '<p class="empty">Laden…</p>';
  const hours = day.hours || [];
  const W = Math.max(300, Math.round(width || 600)), H = Math.round(Math.min(200, Math.max(150, W * 0.32)));
  const L = 38, R = line ? 34 : 6, T = 10, B = 24;
  const vals = (sign) => hours.flatMap((h) => [...bars.filter((b) => !!b.neg === sign).map((b) => h[b.key]), ...(tick && !sign ? [h[tick.key]] : [])]).filter(isNum);
  const top0 = Math.max(0, ...vals(false));
  let bot0 = Math.max(0, ...vals(true));
  if (bot0 < top0 * 0.02) bot0 = 0; // a few Wh of export doesn't earn a band below zero
  const span = Math.max(top0 + bot0, 0.1);
  const step = [0.05, 0.1, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000].find((s) => span / s <= 5) || 1000; // W for a plug
  const top = Math.max(step, Math.ceil(top0 / step) * step), bot = Math.ceil(bot0 / step) * step;
  const y = (v) => T + ((top - v) / (top + bot)) * (H - T - B);
  const slot = (W - L - R) / hours.length;
  const f1 = (n) => n.toFixed(1);
  const dg = (String(step).split(".")[1] || "").length; // 0.25 -> 2 decimals, 0.5 -> 1, 2 -> 0
  const grid = [];
  for (let v = -bot; v <= top + 1e-9; v += step) grid.push(`<line x1="${L}" x2="${W - R}" y1="${f1(y(v))}" y2="${f1(y(v))}" class="g"/><text x="${L - 6}" y="${f1(y(v) + 4)}" text-anchor="end" class="ax">${fmt[dg].format(Math.abs(v))}</text>`);
  const every = Math.max(3, Math.ceil(28 / slot));
  const n = bars.filter((b) => !b.neg).length || 1;
  const bw = Math.max(2, Math.min(14, (slot * 0.7) / n));
  const cols = hours.map((h, i) => {
    const cx = L + slot * (i + 0.5);
    const hr = hm(h.hour).slice(0, 2);
    const label = (+hr) % every === 0 ? `<text x="${f1(cx)}" y="${H - 6}" text-anchor="middle" class="ax">${hr}</text>` : "";
    let k = 0;
    const rects = bars.map((b) => {
      const v = h[b.key];
      if (!isNum(v) || v <= 0) { if (!b.neg) k++; return ""; }
      const x = b.neg ? cx - bw / 2 : cx - (n * bw) / 2 + (k++) * bw;
      const y0 = y(0), y1 = b.neg ? y(-v) : y(v);
      return `<rect x="${f1(x)}" y="${f1(Math.min(y0, y1))}" width="${f1(bw - 1)}" height="${f1(Math.abs(y1 - y0))}" rx="1.5" fill="${b.color}"/>`;
    }).join("");
    const t = tick && isNum(h[tick.key]) && h[tick.key] > 0 ? `<line x1="${f1(cx - (n * bw) / 2 - 1)}" x2="${f1(cx + (n * bw) / 2)}" y1="${f1(y(h[tick.key]))}" y2="${f1(y(h[tick.key]))}" class="fc-tick"/>` : "";
    const tip = [...bars.map((b) => `${b.label} ${isNum(h[b.key]) ? tipFmt(h[b.key]) : "—"}`), ...(tick ? [`${tick.label} ${isNum(h[tick.key]) ? tipFmt(h[tick.key]) : "—"}`] : [])].join(" · ");
    return `<g><title>${hourRange(h.hour)} · ${tip}</title><rect x="${f1(cx - slot / 2)}" y="${T}" width="${f1(slot)}" height="${H - T - B}" fill="transparent"/>${rects}${t}</g>${label}`;
  }).join("");
  let lineSvg = "";
  const pts = (line?.points || []).filter((p) => isNum(p.v));
  if (pts.length) {
    const t0 = new Date(day.day_start).getTime(), t1 = new Date(day.day_end).getTime();
    const lo = Math.floor(Math.min(...pts.map((p) => p.v)) - 1), hi = Math.ceil(Math.max(...pts.map((p) => p.v)) + 1);
    const ly = (v) => T + ((hi - v) / (hi - lo)) * (H - T - B);
    const lx = (t) => L + ((new Date(t).getTime() - t0) / (t1 - t0)) * (W - L - R);
    const d = pts.map((p, i) => `${i ? "L" : "M"}${f1(lx(p.time))} ${f1(ly(p.v))}`).join("");
    const axis = [hi, Math.round((hi + lo) / 2), lo].map((v) => `<text x="${W - R + 4}" y="${f1(ly(v) + 4)}" class="ax">${fmt[0].format(v)}°</text>`).join("");
    lineSvg = `<path d="${d}" fill="none" stroke="${line.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>${axis}`;
  }
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Vandaag per uur">${grid.join("")}<line x1="${L}" x2="${W - R}" y1="${f1(y(0))}" y2="${f1(y(0))}" class="g" style="stroke:var(--muted);opacity:.5"/>${cols}${lineSvg}</svg>`;
}

// A chart block in a sheet: heading, the chart (drawn in after(), at the sheet's width) and a legend.
export const chartBlock = (key, title, legend) => `<h4 class="sub">${title}</h4><div class="chart" data-dchart="${key}"></div><p class="legend">${legend}</p>`;
export const drawChart = (key, opts) => () => { const box = $(`[data-dchart="${key}"]`); if (box) box.innerHTML = dayChart(state.detail?.data, { ...opts, width: box.clientWidth }); };
export const sq = (c, t) => `<span><i class="sq" style="--c:${c}"></i>${t}</span>`;
export const dash = (t, c = "var(--fg)") => `<span><i class="ln dash" style="border-top-color:${c}"></i>${t}</span>`;
export const lineLg = (t, c) => `<span><i class="ln" style="--c:${c}"></i>${t}</span>`;
export const outdoorPoints = () => (state.detail?.data?.outdoor || []).map((p) => ({ time: p.time, v: p.c }));
export function outdoorRange() {
  const pts = state.detail?.data?.outdoor || [];
  if (!pts.length) return "—";
  const lo = pts.reduce((a, p) => (p.c < a.c ? p : a)), hi = pts.reduce((a, p) => (p.c > a.c ? p : a));
  return `laagst ${fmt[1].format(lo.c)} °C (${hm(lo.time)}) · hoogst ${fmt[1].format(hi.c)} °C (${hm(hi.time)})`;
}
// Yesterday up to the same time of day: whole hours that have passed, the running hour pro rata.
export function yesterdaySoFar(hours) {
  const now = Date.now();
  let sum = 0, any = false;
  for (const h of hours || []) {
    const t = new Date(h.hour).getTime();
    if (!isNum(h.y_house_kwh) || t >= now) continue;
    sum += h.y_house_kwh * Math.min(1, (now - t) / 3600000); any = true;
  }
  return any ? sum : null;
}
// Per plug: 24 small bars of mean power per hour today.
export function plugSpark(w, max) {
  const n = (w || []).length || 24, W = 96, H = 22, bw = W / n;
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" aria-hidden="true">${(w || []).map((v, i) => (isNum(v) && v > 0 && max > 0
    ? `<rect x="${(i * bw).toFixed(1)}" y="${(H - (v / max) * H).toFixed(1)}" width="${Math.max(1, bw - 1).toFixed(1)}" height="${((v / max) * H).toFixed(1)}" fill="var(--huis)"/>` : "")).join("")}</svg>`;
}
