// Shared helpers: element lookup, number and time formats, the app state and today's figures.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const fmt = {};
for (const d of [0, 1, 2, 3, 4, 5]) fmt[d] = new Intl.NumberFormat("nl-NL", { minimumFractionDigits: d, maximumFractionDigits: d });
export const isNum = (x) => typeof x === "number" && Number.isFinite(x);
// Charge-level colours, shared by the battery bars (Thuis, Batterij) and the Laadniveau vandaag chart:
// green from 50 %, amber from 20 %, red below.
export const SOC_GREEN = 50, SOC_RED = 20;
export const socColor = (v) => (!isNum(v) ? "--bat" : v >= SOC_GREEN ? "--ok" : v >= SOC_RED ? "--warn" : "--bad");
export const num =(x, d = 1) => (isNum(x) ? fmt[d].format(x) : "—");
export const unit = (text, u) => (text === "—" ? "—" : `${text}<small>${u}</small>`);
export const kwh = (x, d = 1) => unit(num(x, d), "kWh");
export const eur = (x, d = 2) => (isNum(x) ? `${x < 0 ? "−" : ""}€\u00a0${fmt[d].format(Math.abs(x))}` : "—");
export const pct = (x) => (isNum(x) ? unit(fmt[0].format(x * 100), "%") : "—");
export function power(w) {
  if (!isNum(w)) return "—";
  const a = Math.abs(w);
  return a < 1000 ? unit(fmt[0].format(w), "W") : unit(fmt[a < 10000 ? 2 : 1].format(w / 1000), "kW");
}
export const plain = (html) => html.replace(/<small>/g, " ").replace(/<\/small>/g, "");
export let TZ = "Europe/Amsterdam"; // replaced by the server's TZ from /api/config (setTZ, at start)
export function setTZ(tz) { TZ = tz; }
export const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: TZ }) : "—");
export const hm = (iso) => (iso ? new Date(iso).toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit", timeZone: TZ }) : "—");
export function ago(seconds) {
  if (!isNum(seconds)) return "geen meting";
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))} s geleden`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min geleden`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} uur geleden`;
  return "langer dan een dag geleden";
}

// [year, month, day] of a moment in the app's time zone
export function ymd(iso) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { year: "numeric", month: "numeric", day: "numeric", timeZone: TZ })
    .formatToParts(new Date(iso)).map((x) => [x.type, Number(x.value)]));
  return [p.year, p.month, p.day];
}

export const state = { config: { links: {}, plugLabels: {}, liveInterval: 5, staleAfter: {} }, live: null, today: null, liveAt: 0, cached: false, auth: "ok" };
// Today's figures only while they are today's: after midnight, offline or before the server's first
// read of the new day, a cached (yesterday's) answer would show under "vandaag" (audit #6). Every
// reader goes through these; a timer redraws when the date changes (start()).
const isToday = (iso) => !!iso && ymd(iso).join() === ymd(new Date().toISOString()).join();
export const todayData = () => (isToday(state.today?.data?.day_start) ? state.today.data : null);
export const todaySavings = () => (todayData() ? state.today.savings : null);
export const wallMode = new URLSearchParams(location.search).has("kiosk");
