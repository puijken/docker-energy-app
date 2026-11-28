// Geld, Contracten, Meer and Batterij screens.

import { $, ago, esc, eur, fmt, hm, isNum, kwh, num, plain, SOC_GREEN, SOC_RED, socColor, state, todayData, TZ,
  unit } from "./util.js";
import { plugLabel, secondsBetween, setV, sources, warnings } from "./home.js";
import { refreshSheet } from "./sheets.js";
import { histChart, MONTHS, todayIso } from "./history.js";

// ---------- Geld screen (/api/money: app_money(); the per-month chart reuses /api/history?unit=year) ----------
state.money = null; state.moneyYear = null;

export const eur0 = (x) => eur(x, 0);
const billSub = (b) => (b && isNum(b.net_eur) ? `stroom ${fmt[0].format((b.import_eur ?? 0) - (b.export_eur ?? 0))} · gas ${fmt[0].format(b.gas_eur ?? 0)} · vast ${fmt[0].format(b.fixed_eur ?? 0)}` : "");

export function renderMoney() {
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

export async function fetchMoney() {
  const get = async (url) => { try { const r = await fetch(url, { cache: "no-store", credentials: "same-origin" }); return r.ok ? await r.json() : null; } catch { return null; } };
  const [m, y] = await Promise.all([get("/api/money"), get(`/api/history?${new URLSearchParams({ unit: "year", date: todayIso() })}`)]);
  if (m?.data) state.money = m.data;
  if (y?.data) state.moneyYear = y.data;
  renderMoney(); refreshSheet();
}

// ---------- Contracten (/api/contracts: app_contracts()) ----------
state.contracts = null;
export const dmy = (d) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString("nl-NL", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "—");
export const dmyTs = (iso) => (iso ? new Date(iso).toLocaleDateString("nl-NL", { day: "numeric", month: "short", year: "numeric", timeZone: TZ }) : "—");
export const price = (x, d = 4) => (isNum(x) ? `€ ${fmt[d].format(x)}` : "—");
export const KIND = { "stroom en gas": "stroom en gas", stroom: "alleen stroom", gas: "alleen gas" };

export function contractPrices(c) {
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

export let contractKey = null;
document.addEventListener("click", (e) => { const r = e.target.closest("[data-cid]"); if (r) contractKey = Number(r.dataset.cid); }, true);

export async function fetchContracts() {
  try {
    const r = await fetch("/api/contracts", { cache: "no-store", credentials: "same-origin" });
    if (r.ok) { const j = await r.json(); if (j.data) state.contracts = j.data; }
  } catch { /* offline: keep what we have */ }
  renderContracts(); refreshSheet();
}

// ---------- Meer screen (/api/meer: app_meer(): base load, plugs, car, background sources) ----------
state.meer = null;
export const PLACE = { home: "thuis", work: "op het werk", public: "onderweg" };
export const watt = (x) => (isNum(x) ? unit(fmt[0].format(x), "W") : "—");
// whole calendar days between a date (YYYY-MM-DD) and today in the app's time zone (it anchored at
// 12:00 UTC before, one day too low in the morning)
export const daysAgo = (d) => (d ? Math.round((Date.parse(todayIso()) - Date.parse(d)) / 86400000) : null);
const nowIso = () => new Date().toISOString();

// upload_status.detail is English (energy-monitor is a public image; the jobs print their own log
// line): "8 session(s)", "2026-11-27: 6741.186 m3", "energy_prices: 3 contract(s) synced from
// DSMR-reader", "telegram-week: sent week of 2026-11-23". Said here in Dutch with the app's number
// format; anything else as is.
function uploadDetail(t) {
  let m = /(\d+) contract\(s\) synced/.exec(t);
  if (m) return `${m[1]} ${m[1] === "1" ? "contract" : "contracten"}`;
  m = /sent week of (\d{4}-\d{2}-\d{2})$/.exec(t);
  if (m) return `week van ${dmy(m[1])} verstuurd`;
  m = /^(\d+) session\(s\)$/.exec(t);
  if (m) return `${m[1]} ${m[1] === "1" ? "sessie" : "sessies"}`;
  m = /^(\d{4}-\d{2}-\d{2}): ([\d.]+) m3$/.exec(t);
  if (m) return `stand ${dmy(m[1])}: ${fmt[3].format(Number(m[2]))} m³`;
  return t;
}
// Sources that report in the background, next to the live ones of sources(): when each last delivered.
function backgroundSources() {
  const s = state.meer?.status;
  if (!s) return [];
  // Uploads energy-monitor records after every attempt, and the price sync and weekly Telegram of the
  // jobs container (upload_status): green when the last success is recent enough, a warning with the
  // error text when not; grey "nog niet gemeld" without a row (a job that hasn't run since it started
  // reporting).
  const up = s.uploads || {};
  const upload = (key, name, limit) => {
    const u = up[key];
    if (!u) return { name, ok: null, text: "nog niet gemeld" };
    const age = secondsBetween(nowIso(), u.last_ok);
    const ok = isNum(age) && age <= limit;
    return { name, ok, error: !ok && u.last_error ? u.last_error : null,
      text: u.last_ok ? `${ago(age)}${u.detail ? ` · ${uploadDetail(u.detail)}` : ""}` : "nog nooit gelukt" };
  };
  const out = [
    upload("pvoutput", "PVOutput", 15 * 60),
    upload("mindergas", "Mindergas", 26 * 3600),
    up.monta ? upload("monta", "Laadpas-sessies", 20 * 3600)
      : { name: "Laadpas-sessies", age: secondsBetween(nowIso(), s.monta_fetched), limit: 20 * 3600 },
    upload("prices", "Contractprijzen", 26 * 3600),
    upload("telegram", "Weekbericht Telegram", 7 * 86400 + 2 * 3600),
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

export function renderMeerStatus() {
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

// A constant load for a whole year, in kWh, rounded to 10: 385 W -> "3.370 kWh".
export const yearKwh = (w) => `${fmt[0].format(Math.round((w * 8.76) / 10) * 10)} kWh`;
// Base load per calendar month over three years (app_meer's months[], 053): the median night of each
// month as a bar, the running month lighter, the last 12 months' median dashed. Years under the
// Januaries; the label shows the month, its median and how many nights it counts.
export function monthChart(months, median, width) {
  const W = Math.max(300, Math.round(width || 600)), H = Math.round(Math.min(200, Math.max(150, W * 0.32)));
  const L = 44, R = 6, T = 10, B = 24, n = Math.max(months.length, 1);
  const max = Math.max(100, ...months.map((x) => x.w).filter(isNum), isNum(median) ? median : 0);
  const step = [100, 200, 250, 500, 1000].find((s) => max / s <= 4) || 1000;
  const top = Math.ceil(max / step) * step;
  const y = (v) => T + ((top - v) / top) * (H - T - B);
  const slotW = (W - L - R) / n, cx = (i) => L + slotW * (i + 0.5), bw = Math.max(2, Math.min(14, slotW * 0.7));
  const f1 = (v) => v.toFixed(1);
  let grid = "";
  for (let v = 0; v <= top; v += step) grid += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="g"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" class="ax">${fmt[0].format(v)}</text>`;
  const thisMonth = todayIso().slice(0, 7);
  const bars = months.map((x, i) => {
    const [yy, mm] = x.month.split("-").map(Number);
    const run = x.month.slice(0, 7) === thisMonth;
    const tick = mm === 1 ? `<text x="${f1(cx(i))}" y="${H - 6}" text-anchor="middle" class="ax">${yy}</text>` : "";
    const bar = isNum(x.w) ? `<rect x="${f1(cx(i) - bw / 2)}" y="${f1(y(x.w))}" width="${f1(bw)}" height="${f1(y(0) - y(x.w))}" rx="${f1(Math.min(3, bw / 3))}" fill="var(--huis)"${run ? ' opacity=".55"' : ""}/>` : "";
    return `<g><title>${MONTHS[mm - 1]} ${yy}${run ? " (tot nu)" : ""}: ${isNum(x.w) ? `${fmt[0].format(x.w)} W` : "—"} (${x.n} ${x.n === 1 ? "nacht" : "nachten"})</title><rect x="${f1(cx(i) - slotW / 2)}" y="${T}" width="${f1(slotW)}" height="${H - T - B}" fill="transparent"/>${bar}</g>${tick}`;
  }).join("");
  const med = isNum(median) ? `<line x1="${L}" x2="${W - R}" y1="${f1(y(median))}" y2="${f1(y(median))}" stroke="var(--fg)" stroke-width="1.5" stroke-dasharray="5 4"/>` : "";
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Basislast per maand, laatste 3 jaar">${grid}${bars}${med}</svg>`;
}

function renderMeer() {
  const m = state.meer, u = m?.usage;
  setV("m-last", u?.last ? watt(u.last.w) : "—");
  setV("m-last-sub", u?.last ? `nacht naar ${dmy(u.last.night)}${u.last.car ? " · auto laadde thuis" : ""}` : "");
  setV("m-med", u && isNum(u.median_30) ? watt(u.median_30) : "—");
  setV("m-med-sub", u && isNum(u.median_30) ? `mediaan van ${u.n_30} nachten${isNum(u.ly_median_30) ? ` · vorig jaar ${fmt[0].format(u.ly_median_30)} W` : ""}` : "");
  setV("m-year", u && isNum(u.median_365) ? watt(u.median_365) : "—");
  setV("m-year-sub", u && isNum(u.median_365) ? `≈ ${yearKwh(u.median_365)} per jaar${isNum(u.prev_median_365) ? ` · 12 maanden daarvoor ${fmt[0].format(u.prev_median_365)} W` : ""}` : "nog geen jaar aan nachten");
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
export function renderGlossary() {
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

export async function fetchMeer() {
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
export function socChart(rows, dayStart, dayEnd, width) {
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
  // one invisible strip per measurement, half-way to its neighbours, carrying its value: hover on a
  // desktop, a finger on a phone (the touch section reads these <title>s)
  const pts = rows.filter((r) => isNum(r.soc));
  const hits = pts.map((r, i) => {
    const px = x(r.time), a = i ? (x(pts[i - 1].time) + px) / 2 : Math.max(L, px - 3), b = i < pts.length - 1 ? (px + x(pts[i + 1].time)) / 2 : Math.min(W - R, px + 3);
    const lim = isNum(r.discharge_limit_soc) && isNum(r.charge_limit_soc) ? ` (grenzen ${fmt[0].format(r.discharge_limit_soc)}–${fmt[0].format(r.charge_limit_soc)}%)` : "";
    return `<rect x="${f1(a)}" y="${T}" width="${f1(Math.max(0.5, b - a))}" height="${H - T - B}" fill="transparent"><title>${hm(r.time)} · ${fmt[0].format(r.soc)}%${lim}</title></rect>`;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Laadniveau vandaag">
    <defs>${grad(`${gid}l`, 1, 1)}<linearGradient id="${gid}f" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--muted)" stop-opacity=".16"/><stop offset="1" stop-color="var(--muted)" stop-opacity=".02"/></linearGradient></defs>
    ${grid}${ticks}
    <path d="${area}" fill="url(#${gid}f)"/>
    <path d="${up.d}" class="lim-line"/><path d="${low.d}" class="lim-line"/>
    <path d="${soc.d}" fill="none" stroke="url(#${gid}l)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
    ${dot}${empty}${hits}
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

export function renderBattery() {
  const b = state.battery;
  const s = b?.summary || null;
  const chart = $("[data-soc-chart]");
  if (chart && b?.soc && b.day_start) chart.innerHTML = socChart(b.soc, b.day_start, b.day_end, chart.clientWidth);
  setV("soc-range", s && isNum(s.min_soc) ? `vandaag ${fmt[0].format(s.min_soc)}–${fmt[0].format(s.max_soc)}%` : "");
  renderEfficiency(b?.efficiency);
  const t = todayData();
  setV("socket-today", t && isNum(t.battery_in_kwh) && t.battery_in_kwh >= 0.05 ? `waarvan ${num(t.battery_in_kwh)} kWh uit het stopcontact` : "");
  setV("sinds-nieuw", s && isNum(s.charged_total_kwh) ? `${num(s.charged_total_kwh)}<small>· ${num(s.discharged_total_kwh)} kWh</small>` : "—");
  setV("sinds-nieuw-sub", s ? "tellers van de batterij" : "");
  setV("celrendement", s && isNum(s.cell_efficiency_30d) ? unit(fmt[0].format(s.cell_efficiency_30d * 100), "%") : "—");
  setV("soh", s && isNum(s.soh) ? unit(fmt[0].format(s.soh), "%") : "—");
  setV("rated", kwh(s?.rated_kwh));
  setV("cycli", s && isNum(s.full_cycles) ? fmt[1].format(s.full_cycles) : "—");
  setV("temp-range", s && isNum(s.temp_min_c) ? `${fmt[0].format(s.temp_min_c)}–${fmt[0].format(s.temp_max_c)}<small>°C</small>` : "—");
}

export async function fetchBattery() {
  try {
    const r = await fetch("/api/battery", { cache: "no-store", credentials: "same-origin" });
    if (r.ok) state.battery = await r.json();
  } catch { /* offline: keep what we have */ }
  renderBattery(); refreshSheet();
}
