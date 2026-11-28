// Historie screen and the period charts in its sheets.

import { $, $$, eur, fmt, isNum, kwh, pct, SOC_GREEN, SOC_RED, state, TZ, unit, ymd } from "./util.js";
import { setV } from "./home.js";
import { refreshSheet } from "./sheets.js";
import { daysAgo, dmy, dmyTs, socChart } from "./screens.js";
import { dash, lineLg, sq } from "./detail.js";

// ---------- Historie screen (/api/history: app_history(unit, date), rules in SQL) ----------
export const MONTHS = ["jan", "feb", "mrt", "apr", "mei", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];
const DAYS = ["ma", "di", "wo", "do", "vr", "za", "zo"];
state.hist = { unit: "month", anchor: null, onToday: true, data: null, loading: false }; // onToday: the anchor follows the date (past midnight too)

// Calendar date of an instant in the app's time zone, as [y, m (1-12), d].
const isoDate = (y, m, d) => { const t = new Date(Date.UTC(y, m - 1, d)); return t.toISOString().slice(0, 10); };
export const todayIso = () => { const [y, m, d] = ymd(new Date().toISOString()); return isoDate(y, m, d); };
function isoWeek(y, m, d) {
  const t = new Date(Date.UTC(y, m - 1, d)); const day = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - day + 3);
  const first = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((t - first) / 86400000 - 3 + ((first.getUTCDay() + 6) % 7)) / 7);
}
export function histLabel(h) {
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
export function histChart(h, key, color, width, digits) {
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

// ---------- charts in the Historie sheets: one chart of the selected period per sheet ----------
const bucketWord = (h) => (h?.bucket === "hour" ? "Per uur" : h?.bucket === "month" ? "Per maand" : "Per dag");
const clamp01 = (x) => (isNum(x) ? Math.min(1, Math.max(0, x)) : null);
// Values per slot of the period (rows with t, positioned like histChart); rows in one slot are summed.
function histSlots(h, rows, start, get) {
  const n = slotCount(h), out = new Array(n).fill(null);
  for (const b of rows || []) {
    const i = slotOf(h, b.t, start), v = get(b);
    if (i >= 0 && i < n && isNum(v)) out[i] = (out[i] ?? 0) + v;
  }
  return out;
}
function niceAxis(min, max) {
  if (max - min < 1e-9) max = min + 1;
  const span = max - min;
  const step = [1, 2, 2.5, 5, 10].map((f) => f * 10 ** Math.floor(Math.log10(span / 3))).find((s) => span / s <= 4) || span / 3;
  const dg = Math.min(2, (String(+step.toPrecision(6)).split(".")[1] || "").length);
  return { step, dg, top: Math.ceil(max / step - 1e-9) * step, floor: Math.floor(min / step + 1e-9) * step };
}
function slotTicks(h, n, cx, W, H) {
  const every = h.bucket === "month" ? (W < 420 ? 2 : 1) : h.bucket === "hour" ? (W < 420 ? 6 : 3) : h.unit === "week" ? 1 : W < 420 ? 7 : 5;
  return Array.from({ length: n }, (_, i) => i).filter((i) => h.unit === "month" ? (i === 0 || (i + 1) % every === 0) : i % every === 0)
    .map((i) => `<text x="${cx(i).toFixed(1)}" y="${H - 6}" text-anchor="middle" class="ax">${slotLabel(h, i)}</text>`).join("");
}
// Bars per slot, stacked (a neg series, or a negative value, goes below zero); ly: last year's same
// period as a grey dashed line with dots; mark: a dark tick per slot (e.g. the total of a stack);
// line: a series on its own axis at the right (degree days). pct: values are 0-1, axis 0-100 %.
// absAxis: labels below zero without a minus (export is an amount below the line).
function periodChart(h, o, width) {
  const n = slotCount(h), rows = o.rows || h.buckets, f = o.fmt;
  const series = o.bars.map((b) => histSlots(h, rows, h.start, b.get));
  const lyV = o.ly ? histSlots(h, h.ly_buckets, h.ly_start, o.ly.get) : [];
  const markV = o.mark ? histSlots(h, rows, h.start, o.mark.get) : [];
  const lineV = o.line ? histSlots(h, rows, h.start, o.line.get) : [];
  if (![...series.flat(), ...lyV, ...lineV].some(isNum)) return '<p class="empty">Geen gegevens in deze periode.</p>';
  const signed = (k, i) => { const v = series[k][i]; return isNum(v) ? (o.bars[k].neg ? -v : v) : null; };
  let max = 0, min = 0;
  for (let i = 0; i < n; i++) {
    let up = 0, dn = 0;
    o.bars.forEach((_, k) => { const v = signed(k, i); if (v > 0) up += v; else if (v < 0) dn += v; });
    max = Math.max(max, up, lyV[i] ?? 0, markV[i] ?? 0); min = Math.min(min, dn, lyV[i] ?? 0, markV[i] ?? 0);
  }
  if (o.pct) { min = 0; max = 1; }
  if (-min < max * 0.02) min = 0; // a few Wh of export doesn't earn a band below zero (as dayChart)
  const W = Math.max(300, Math.round(width || 600)), H = Math.round(Math.min(220, Math.max(160, W * 0.34)));
  const L = 44, R = o.line ? 36 : 6, T = 10, B = 24;
  const ax = o.pct ? { step: 0.25, dg: 0, top: 1, floor: 0 } : niceAxis(min, max);
  const y = (v) => T + ((ax.top - v) / (ax.top - ax.floor)) * (H - T - B);
  const slotW = (W - L - R) / n, cx = (i) => L + slotW * (i + 0.5);
  const bw = Math.max(2, Math.min(24, slotW * 0.62));
  const f1 = (x) => x.toFixed(1);
  let grid = "";
  for (let v = ax.floor; v <= ax.top + 1e-9; v += ax.step) grid += `<line x1="${L}" x2="${W - R}" y1="${f1(y(v))}" y2="${f1(y(v))}" class="g"/><text x="${L - 6}" y="${f1(y(v) + 4)}" text-anchor="end" class="ax">${o.pct ? fmt[0].format(v * 100) + "%" : fmt[ax.dg].format(Math.abs(v) < 1e-9 ? 0 : o.absAxis ? Math.abs(v) : v)}</text>`;
  const cols = Array.from({ length: n }, (_, i) => {
    let up = 0, dn = 0;
    const rects = o.bars.map((b, k) => {
      const v = signed(k, i);
      if (!isNum(v) || Math.abs(v) < 1e-9) return "";
      const from = v > 0 ? up : dn, to = from + v;
      if (v > 0) up = to; else dn = to;
      return `<rect x="${f1(cx(i) - bw / 2)}" y="${f1(Math.min(y(from), y(to)))}" width="${f1(bw)}" height="${f1(Math.max(1, Math.abs(y(to) - y(from))))}" rx="1.5" fill="${b.color}"/>`;
    }).join("");
    const mk = isNum(markV[i]) ? `<line x1="${f1(cx(i) - bw / 2 - 2)}" x2="${f1(cx(i) + bw / 2 + 2)}" y1="${f1(y(markV[i]))}" y2="${f1(y(markV[i]))}" stroke="var(--fg)" stroke-width="2"/>` : "";
    const tip = [...o.bars.map((b, k) => isNum(series[k][i]) ? `${b.label} ${f(series[k][i])}` : null),
      o.mark && isNum(markV[i]) ? `${o.mark.label} ${f(markV[i])}` : null,
      o.line && isNum(lineV[i]) ? `${o.line.label} ${o.line.fmt(lineV[i])}` : null,
      o.ly && isNum(lyV[i]) ? `vorig jaar ${f(lyV[i])}` : null].filter(Boolean).join(" · ");
    return tip ? `<g><title>${slotLabel(h, i)}: ${tip}</title><rect x="${f1(cx(i) - slotW / 2)}" y="${T}" width="${f1(slotW)}" height="${H - T - B}" fill="transparent"/>${rects}${mk}</g>` : "";
  }).join("");
  const path = (vals, yf) => { let d = ""; vals.forEach((v, i) => { if (isNum(v)) d += `${d && isNum(vals[i - 1]) ? "L" : "M"}${f1(cx(i))} ${f1(yf(v))}`; }); return d; };
  let ly = "";
  if (o.ly) ly = `<path d="${path(lyV, y)}" fill="none" stroke="var(--ref)" stroke-width="1.5" stroke-dasharray="4 3"/>` + lyV.map((v, i) => isNum(v) ? `<circle cx="${f1(cx(i))}" cy="${f1(y(v))}" r="2.5" fill="var(--ref)"/>` : "").join("");
  let rl = "";
  if (o.line && lineV.some(isNum)) {
    const a2 = niceAxis(0, Math.max(...lineV.filter(isNum)));
    const y2 = (v) => T + ((a2.top - v) / a2.top) * (H - T - B);
    rl = `<path d="${path(lineV, y2)}" fill="none" stroke="${o.line.color}" stroke-width="2" stroke-linejoin="round"/>` +
      lineV.map((v, i) => isNum(v) ? `<circle cx="${f1(cx(i))}" cy="${f1(y2(v))}" r="2" fill="${o.line.color}"/>` : "").join("") +
      [a2.top, a2.top / 2, 0].map((v) => `<text x="${W - R + 4}" y="${f1(y2(v) + 4)}" class="ax">${fmt[Number.isInteger(v) ? 0 : 1].format(v)}</text>`).join("");
  }
  const zero = ax.floor < 0 ? `<line x1="${L}" x2="${W - R}" y1="${f1(y(0))}" y2="${f1(y(0))}" class="g" style="stroke:var(--muted);opacity:.5"/>` : "";
  return `<svg viewBox="0 0 ${W} ${H}" role="img">${grid}${zero}${cols}${ly}${rl}${slotTicks(h, n, cx, W, H)}</svg>`;
}
// Running total through the period, against last year's same period (grey dashed): ahead or behind.
// This period's line stops at the last slot with data (a running period).
function cumulChart(h, get, color, f, width) {
  const n = slotCount(h);
  const run = (vals) => {
    let last = -1, s = 0;
    vals.forEach((v, i) => { if (isNum(v)) last = i; });
    return vals.map((v, i) => (i > last ? null : (s += isNum(v) ? v : 0)));
  };
  const now = run(histSlots(h, h.buckets, h.start, get)), ly = run(histSlots(h, h.ly_buckets, h.ly_start, get));
  if (![...now, ...ly].some(isNum)) return '<p class="empty">Geen gegevens in deze periode.</p>';
  const W = Math.max(300, Math.round(width || 600)), H = Math.round(Math.min(220, Math.max(160, W * 0.34)));
  const L = 44, R = 6, T = 10, B = 24;
  const ax = niceAxis(0, Math.max(...[...now, ...ly].filter(isNum)));
  const y = (v) => T + ((ax.top - v) / ax.top) * (H - T - B);
  const slotW = (W - L - R) / n, cx = (i) => L + slotW * (i + 0.5);
  const f1 = (x) => x.toFixed(1);
  let grid = "";
  for (let v = 0; v <= ax.top + 1e-9; v += ax.step) grid += `<line x1="${L}" x2="${W - R}" y1="${f1(y(v))}" y2="${f1(y(v))}" class="g"/><text x="${L - 6}" y="${f1(y(v) + 4)}" text-anchor="end" class="ax">${fmt[ax.dg].format(v)}</text>`;
  const path = (vals) => { let d = ""; vals.forEach((v, i) => { if (isNum(v)) d += `${d ? "L" : "M"}${f1(cx(i))} ${f1(y(v))}`; }); return d; };
  const hits = Array.from({ length: n }, (_, i) => isNum(now[i]) || isNum(ly[i])
    ? `<rect x="${f1(cx(i) - slotW / 2)}" y="${T}" width="${f1(slotW)}" height="${H - T - B}" fill="transparent"><title>t/m ${slotLabel(h, i)}: ${isNum(now[i]) ? f(now[i]) : "—"}${isNum(ly[i]) ? ` (vorig jaar ${f(ly[i])})` : ""}</title></rect>` : "").join("");
  const endDot = (vals, c) => { const i = vals.map(isNum).lastIndexOf(true); return i < 0 ? "" : `<circle cx="${f1(cx(i))}" cy="${f1(y(vals[i]))}" r="3" fill="${c}"/>`; };
  return `<svg viewBox="0 0 ${W} ${H}" role="img">${grid}<path d="${path(ly)}" fill="none" stroke="var(--ref)" stroke-width="1.5" stroke-dasharray="4 3"/>${endDot(ly, "var(--ref)")}<path d="${path(now)}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round"/>${endDot(now, color)}${hits}${slotTicks(h, n, cx, W, H)}</svg>`;
}

// The chart of each Historie sheet: { legend, svg(width), heading?, after?, note? } (after: a line under
// the legend; note: how the per-hour figures are made, shown for a day instead of the general per-hour
// row), or null when the unit has none.
const kwhF = (h) => (x) => `${fmt[h.bucket === "hour" ? 2 : 1].format(x)} kWh`;
const pctF = (x) => `${fmt[0].format(x * 100)} %`;
export const HIST_CHARTS = {
  cumul: (key, color, label) => (h) => ({
    heading: "Opgeteld door de periode",
    legend: `${lineLg("deze periode", color)}${dash("vorig jaar")}<span>${label}</span>`,
    svg: (w) => cumulChart(h, (b) => b[key], color, kwhF(h), w),
    after: "Opgeteld van het begin van de periode; ligt de lijn boven de grijze, dan zit je voor op vorig jaar.",
  }),
  hzelfv: (h) => ({
    legend: `${sq("var(--deel)", "deel van het verbruik uit eigen zon")}`,
    svg: (w) => periodChart(h, { pct: true, fmt: pctF, bars: [{ label: "zelfvoorzienend", color: "var(--deel)",
      get: (b) => (b.consumption_kwh > 0 ? clamp01((isNum(b.self_used_kwh) ? b.self_used_kwh : b.consumption_kwh - b.import_kwh) / b.consumption_kwh) : null) }] }, w),
    note: "(verbruik − afgenomen) ÷ verbruik; het verbruik komt uit het gemiddelde vermogen, afgenomen uit de teller, dus bij weinig verbruik is een uur een paar procent onzeker",
  }),
  hbenut: (h) => {
    const gmax = Math.max(0, ...(h.buckets || []).map((b) => b.generated_kwh).filter(isNum));
    return {
      legend: `${sq("var(--deel)", "deel van de opgewekte zon zelf benut")}<span>alleen ${h.bucket === "hour" ? "uren" : h.bucket === "month" ? "maanden" : "dagen"} met noemenswaardige opwek</span>`,
      svg: (w) => periodChart(h, { pct: true, fmt: pctF, bars: [{ label: "zelf benut", color: "var(--deel)",
        get: (b) => (b.generated_kwh > 0.03 * gmax && b.generated_kwh > 0 ? clamp01((b.generated_kwh - b.export_kwh) / b.generated_kwh) : null) }] }, w),
      note: "(opgewekt − teruggeleverd) ÷ opgewekt; opgewekt uit het gemiddelde vermogen, teruggeleverd uit de teller",
    };
  },
  hnet: (h) => ({
    legend: `${sq("var(--uit)", "afgenomen")}${sq("var(--eigen)", "teruggeleverd (onder de lijn)")}<span>kWh</span>`,
    svg: (w) => periodChart(h, { fmt: kwhF(h), absAxis: true, bars: [{ label: "afgenomen", color: "var(--uit)", get: (b) => b.import_kwh }, { label: "teruggeleverd", color: "var(--eigen)", neg: true, get: (b) => b.export_kwh }] }, w),
    note: "uit de tellers van de slimme meter: de stand aan het begin van het volgende uur − die aan het begin van dit uur; opgeteld gelijk aan het dagtotaal",
  }),
  hrekening: (h) => (h.bucket === "hour" ? null : {
    legend: `${sq("var(--uit)", "stroom")}${sq("var(--gas)", "gas")}${sq("var(--deel)", "vaste kosten")}${sq("var(--eigen)", "teruglevering (onder de lijn)")}<span><i class="ln" style="--c:var(--fg)"></i>totaal</span>${dash("totaal vorig jaar")}`,
    svg: (w) => periodChart(h, { fmt: (x) => eur(x, 2), bars: [
      { label: "stroom", color: "var(--uit)", get: (b) => b.import_eur }, { label: "gas", color: "var(--gas)", get: (b) => b.gas_eur },
      { label: "vaste kosten", color: "var(--deel)", get: (b) => b.fixed_eur }, { label: "teruglevering", color: "var(--eigen)", neg: true, get: (b) => b.export_eur }],
      mark: { label: "totaal", get: (b) => b.net_eur }, ly: { get: (b) => b.net_eur } }, w),
  }),
  hgas: (h) => (h.bucket === "hour" ? {
    legend: `${sq("var(--gas)", "gas")}<span>m³ per uur</span>`,
    svg: (w) => periodChart(h, { fmt: (x) => `${fmt[2].format(x)} m³`, bars: [{ label: "gas", color: "var(--gas)", get: (b) => b.gas_m3 }] }, w),
    note: "uit de stand van de gasmeter (elke 5 minuten, vroeger elk half uur): de stand aan het begin van het volgende uur − die aan het begin van dit uur",
  } : {
    legend: `${sq("var(--gas)", "gas (m³, links)")}${lineLg("graaddagen (rechts)", "var(--accent)")}`,
    svg: (w) => periodChart(h, { fmt: (x) => `${fmt[1].format(x)} m³`, bars: [{ label: "gas", color: "var(--gas)", get: (b) => b.gas_m3 }],
      line: { label: "graaddagen", color: "var(--accent)", get: (b) => b.degree_days, fmt: (x) => fmt[1].format(x) } }, w),
    after: "Volgt het gas de graaddagen, dan is het verbruik vooral verwarming; een dag zonder graaddagen heeft nog geen KNMI-waarde.",
  }),
  hgraad: (h) => (h.bucket === "hour" ? null : {
    legend: `${sq("var(--accent)", "graaddagen")}${dash("vorig jaar")}`,
    svg: (w) => periodChart(h, { fmt: (x) => fmt[1].format(x), bars: [{ label: "graaddagen", color: "var(--accent)", get: (b) => b.degree_days }], ly: { get: (b) => b.degree_days } }, w),
  }),
  hgpg: (h) => {
    if (h.bucket === "hour") return null;
    const get = (b) => (b.degree_days >= 5 ? b.gas_dd_m3 / b.degree_days : null);
    return {
      legend: `${sq("var(--gas)", "m³ per graaddag")}${dash("vorig jaar")}<span>alleen ${h.bucket === "month" ? "maanden" : "dagen"} met minstens 5 graaddagen</span>`,
      svg: (w) => periodChart(h, { fmt: (x) => `${fmt[2].format(x)} m³`, bars: [{ label: "per graaddag", color: "var(--gas)", get }], ly: { get } }, w),
    };
  },
};
HIST_CHARTS.hopgewekt = HIST_CHARTS.cumul("generated_kwh", "var(--zon)", "kWh opgewekt");
HIST_CHARTS.hverbruik = HIST_CHARTS.cumul("consumption_kwh", "var(--huis)", "kWh verbruikt");
// The Auto sheet: kWh per day (per month for a year) and place, from app_history_car's buckets.
export function carChart(h) {
  const c = h?.car;
  if (!c || h.bucket === "hour" || !c.buckets) return null;
  return {
    legend: `${sq("var(--huis)", "thuis")}${sq("var(--deel)", "werk")}${sq("var(--oost)", "onderweg")}<span>kWh, op de dag waarop de laadbeurt begon</span>`,
    svg: (w) => periodChart(h, { rows: c.buckets, fmt: (x) => `${fmt[1].format(x)} kWh`, bars: [
      { label: "thuis", color: "var(--huis)", get: (b) => b.home_kwh }, { label: "werk", color: "var(--deel)", get: (b) => b.work_kwh },
      { label: "onderweg", color: "var(--oost)", get: (b) => b.public_kwh }] }, w),
  };
}
export const histChartBlock = (h, c) => (c ? `<h4 class="sub">${c.heading || bucketWord(h)}</h4><div class="chart" data-hschart></div><p class="legend">${c.legend}</p>${c.after ? `<p class="legend">${c.after}</p>` : ""}` : "");
export const drawHistChart = (c) => (c ? () => { const box = $("[data-hschart]"); if (box) box.innerHTML = c.svg(box.clientWidth); } : undefined);

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

export function renderHistory() {
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
export const carLy = (c) => !!c && !!c.first && new Date(c.ly_compare_end) > new Date(c.first);
// "none": the period starts after the newest imported home session; "part": it runs past it.
export function carHome(c) {
  if (!c?.last_home) return "none";
  const after = new Date(c.last_home).getTime() + 86400000;
  if (new Date(c.start).getTime() > after) return "none";
  return new Date(c.end).getTime() > after && after < Date.now() ? "part" : "ok";
}
export const carNoData = (c) => (c?.first && new Date(c.end) <= new Date(c.first) ? `—: laadgegevens beginnen ${dmyTs(c.first)}` : "");
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

let histSeq = 0;
export async function fetchHistory() {
  const seq = ++histSeq;
  if (state.hist.onToday) state.hist.anchor = todayIso(); // an app left open past midnight moves to the new day
  const q = new URLSearchParams({ unit: state.hist.unit, date: state.hist.anchor || todayIso() });
  try {
    const r = await fetch(`/api/history?${q}`, { cache: "no-store", credentials: "same-origin" });
    // the running period (the one holding today) follows the date; a past one stays put
    if (r.ok && seq === histSeq) { const j = await r.json(); if (j.data) { state.hist.data = j.data; state.hist.onToday = !!j.data.running; } }
  } catch { /* offline: keep what we have */ }
  if (seq === histSeq) { renderHistory(); refreshSheet(); prefetchPrevHistory(); }
}
// Ask the server for the period before the shown one, so "vorige" answers from its cache (an uncached
// period costs ~0.1 s of SQL). Once per shown period, not on the running period's minute refresh, and
// not before the first day of data. The answer is not used here; the server keeps it 5 minutes.
let histPrefetched = "";
function prefetchPrevHistory() {
  const h = state.hist.data;
  if (!h || new Date(h.start) <= new Date(h.first_day)) return;
  const key = `${h.unit} ${h.start}`;
  if (key === histPrefetched) return;
  histPrefetched = key;
  const q = new URLSearchParams({ unit: h.unit, date: histShift(h, -1) });
  fetch(`/api/history?${q}`, { cache: "no-store", credentials: "same-origin" }).catch(() => {});
}
function histGo(anchor) { state.hist.anchor = anchor; state.hist.onToday = anchor === todayIso(); fetchHistory(); }
document.addEventListener("click", (e) => {
  const u = e.target.closest("[data-hunit]");
  if (u) { state.hist.unit = u.dataset.hunit; state.hist.anchor = todayIso(); state.hist.onToday = true; fetchHistory(); return; }
  if (e.target.closest("#hist-prev") && state.hist.data) histGo(histShift(state.hist.data, -1));
  if (e.target.closest("#hist-next") && state.hist.data) histGo(histShift(state.hist.data, 1));
});
