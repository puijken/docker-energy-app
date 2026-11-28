// Info sheets: one pop-up per tile, row texts, the "Hoe berekend" fold.

import { $, clock, esc, eur, fmt, hm, isNum, kwh, num, pct, plain, power, state, todayData, todaySavings, TZ } from "./util.js";
import { approx, plugLabel, sources, warnings, weekday } from "./home.js";
import { carChart, carHome, carLy, carNoData, drawHistChart, HIST_CHARTS, histChartBlock, histLabel } from "./history.js";
import { contractKey, contractPrices, dmy, dmyTs, eur0, KIND, monthChart, PLACE, price, socChart, watt,
  yearKwh } from "./screens.js";
import { chartBlock, dash, dayChart, drawChart, lineLg, maybeFetchBattery, maybeFetchDetail, maybeFetchSolar,
  outdoorPoints, outdoorRange, peakHour, plugSpark, solarChart, sq, stringsBlock, yesterdaySoFar } from "./detail.js";
import { hideTip } from "./touch.js";

// ---------- info sheets ----------
const link = (key, text) => (state.config.links[key] ? `<p><a href="${esc(state.config.links[key])}" target="_blank" rel="noopener">${esc(text)} ›</a></p>` : "");
// "Hoe berekend" (audit #7, 2026-11-28): how a figure is computed and where it comes from sits behind
// one small button at the end of a sheet, so a sheet shows what a number means and its period first.
// While openSheet() builds a sheet, rows() moves the rows named here (and "Bron" everywhere) into that
// fold instead of the body. Values, "Periode", "Niet meegeteld" and the ≈ notes stay visible.
const FOLD = {
  zon: ["Hoe verdeeld", "Per string", "Normaal"], batterij: ["Waarom verschil", "Lijnen"],
  huis: ["Berekening", "Per uur", "Auto vannacht"], netnu: ["Per uur"], gas: ["Berekening"], plug: ["Per uur"],
  opgewekt: ["Berekening"], verbruik: ["Berekening"], zelfvoorzienend: ["Berekening"], net: ["Berekening"],
  verwacht: ["Berekening", "Dakvlakken", "Hoe goed"], bespaard: ["Prijzen 2027", "Zonder batterij"],
  beschikbaar: ["Capaciteit"], geladen: ["Berekening"], gbespaard: ["Berekening"],
  gmaanden: ["Berekening"], gmaand: ["Berekening"], gjaar: ["Berekening"],
  hopgewekt: ["Berekening", "Per uur"], hverbruik: ["Berekening", "Per uur"], hzelfv: ["Berekening", "Per uur"],
  hbenut: ["Berekening", "Per uur"], hnet: ["Berekening", "Per uur"], hrekening: ["Berekening", "Per uur"],
  hgas: ["Berekening", "Per uur"], hgraad: ["Berekening", "Per uur"], hgpg: ["Berekening", "Per uur"],
  hsoc: ["Kleuren"], socdag: ["Kleuren"], sindsnieuw: ["Berekening"], celrendement: ["Berekening"],
  mbasis: ["Berekening", "Auto herkend", "Per maand", "Tot de batterij"], contract: ["Berekening"],
};
let foldSheet = null, foldRows = [], foldOpen = false;
const dl = (pairs) => `<dl>${pairs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}</dl>`;
const rows = (pairs) => {
  const fold = foldSheet ? ["Bron", ...(FOLD[foldSheet] || [])] : [];
  const shown = [];
  for (const p of pairs.filter(Boolean)) (fold.includes(p[0]) ? foldRows : shown).push(p);
  return shown.length ? dl(shown) : "";
};
const foldHtml = () => (foldRows.length
  ? `<div class="how"><button type="button" class="how-btn" aria-expanded="${foldOpen}">ⓘ Hoe berekend</button><div class="how-body"${foldOpen ? "" : " hidden"}>${dl(foldRows)}</div></div>` : "");
document.addEventListener("click", (e) => {
  const b = e.target.closest?.(".how-btn");
  if (!b) return;
  foldOpen = !foldOpen; // kept through the sheet's redraws; a new sheet starts closed (openSheet)
  b.setAttribute("aria-expanded", foldOpen);
  b.nextElementSibling.hidden = !foldOpen;
});
const LIVE_PERIOD = () => {
  const d = state.live?.data;
  return d?.flow_time ? `live, meting van ${clock(d.flow_time)} (elke ${fmt[0].format(state.config.liveInterval)} s nieuw)` : "live; er is geen meting van de laatste 5 minuten, daarom “—”";
};
// The weather station's name comes from the server's WEATHER_STATION (site-specific, kept out of this
// public repo); without it the texts say "het meetstation".
const station = () => (state.config.weatherStation ? `meetstation ${esc(state.config.weatherStation)}` : "het meetstation");
const TODAY_PERIOD = "vandaag 00:00 – nu, geen live waarde (elke minuut bijgewerkt)";

const SHEETS = {
  zon() {
    const d = state.live?.data;
    const day = state.solar?.data || null;
    maybeFetchSolar();
    return { title: `Zon · ${plain(power(d?.solar_w))}`, body: rows([
      ["Wat", "Zonnestroom nu en waar die heen gaat (groene lijnen)."],
      ["Nu", d?.flow_time ? `batterij ${plain(power(d.flow_sun_bat_w))} · huis ${plain(power(d.flow_sun_house_w))} · net ${plain(power(d.flow_sun_grid_w))}` : "—"],
    ]) + stringsBlock(day) + rows([
      ["Hoe verdeeld", "De panelen hangen aan de thuisbatterij, dus alle zonnestroom gaat door het apparaat. Gemeten: wat de cellen laden, wat het apparaat aan het huis levert en wat de slimme meter terug ziet gaan. Daaruit volgt elke lijn. Alleen als zon en batterij tegelijk aan het huis leveren (rond zonsopgang en -ondergang) is de verdeling geschat, naar verhouding. Samen iets minder dan de zon zelf: ongeveer 3 % gaat verloren bij het omzetten."],
      ["Per string", "De panelen liggen in twee strings, elk op een eigen dakvlak: oost en west. Per string gemeten: spanning × stroom, vóór het omzetten (DC), elke 5 s. Opgeteld komt dat een paar procent onder Opgewekt uit; voor de dag geldt Opgewekt, het zonvermogen dat de batterij meldt (zoals in de Anker-app)."],
      ["Verwachting", "≈ Open-Meteo per dakvlak; per uur zit die er vaak een derde naast."],
      ["Lage spanning", "Onder 150 V terwijl er stroom loopt (≥ 0,3 A): die string levert dan minder dan hij kan."],
      ["Normaal", "een string werkt op 250–300 V; bij zonsopgang en -ondergang zakt de spanning ook, maar dan met weinig stroom, dus dat telt niet mee"],
      ["Periode", `nu: ${LIVE_PERIOD()}; vandaag: 00:00 – nu, elke minuut nieuw`],
      ["Bron", "thuisbatterij (PV-vermogen, en per string spanning en stroom); verwachting Open-Meteo"],
    ]) + link("day", "Zon vandaag in Grafana"), after: () => {
      const box = $("[data-solar-chart]");
      if (box) box.innerHTML = solarChart(day, box.clientWidth);
    } };
  },
  batterij() {
    const d = state.live?.data, b = state.battery;
    maybeFetchBattery();
    return { title: `Batterij · ${isNum(d?.soc) ? fmt[0].format(d.soc) + "%" : "—"}`, body: rows([
      ["Wat", "Laadniveau en wat de cellen nu doen: laden (groen) of ontladen (rood)."],
      ["Lijnen", "rode lijn naar het huis: de batterij levert uit de cellen; rode lijn van het net: de batterij laadt uit het stopcontact; groen: laden uit de zon"],
      ["Nu", d ? `cellen ${plain(power(d.battery_cells_w))} (boven nul ontladen) · naar het huis ${plain(power(d.battery_ac_w))}${d.socket_in_w >= 10 ? ` · uit het stopcontact ${plain(power(d.socket_in_w))}` : ""}` : "—"],
      ["Vandaag", (() => { const t = todayData(); return t && isNum(t.battery_charged_kwh) ? `geladen ${num(t.battery_charged_kwh)} kWh · ontladen ${num(t.battery_discharged_kwh)} kWh` : "—"; })()],
    ]) + `<h4 class="sub">Laadniveau vandaag</h4><div class="chart" data-bsoc></div>` + rows([
      ["Waarom verschil", "Tussen cellen en huis gaat stroom verloren bij het omzetten, en de batterij gebruikt zelf wat (stand-byverbruik)."],
      ["Temperatuur", d && isNum(d.battery_temp_c) ? `${fmt[1].format(d.battery_temp_c)} °C` : "—"],
      ["Periode", `nu: ${LIVE_PERIOD()}; laadniveau: per 5 minuten sinds 00:00`],
      ["Bron", "thuisbatterij"],
    ]) + '<p><a href="#batterij">Alles over de batterij ›</a></p>' + link("battery", "Batterij in Grafana"), after: () => {
      const box = $("[data-bsoc]");
      if (box) box.innerHTML = b?.soc && b.day_start ? socChart(b.soc, b.day_start, b.day_end, box.clientWidth) : '<p class="empty">Laden…</p>';
    } };
  },
  huis() {
    const d = state.live?.data, x = state.detail?.data, t = todayData();
    maybeFetchDetail();
    const calc = d?.flow_time ? `${plain(power(d.grid_w))} net + ${plain(power(d.battery_ac_w))} uit de batterij${d.socket_in_w >= 10 ? ` − ${plain(power(d.socket_in_w))} batterij uit het stopcontact` : ""} = ${plain(power(d.house_w))}${d.house_w < 0 ? " (onder 0 kan niet: net en batterij worden op net andere momenten gemeten; de cirkel toont 0 W)" : ""}` : "—";
    const ySoFar = yesterdaySoFar(x?.hours);
    // today so far from the same hourly figures as yesterday (the counters' day total runs ~1 % higher)
    const hSoFar = (x?.hours || []).reduce((a, h) => (isNum(h.house_kwh) ? (a ?? 0) + h.house_kwh : a), null);
    const plugs = x?.plugs || [];
    const plugSum = plugs.reduce((a, p) => a + (isNum(p.today_kwh) ? p.today_kwh : 0), 0);
    const night = x?.night;
    return { title: `Verbruik nu · ${plain(power(isNum(d?.house_w) ? Math.max(0, d.house_w) : null))}`, body: rows([
      ["Wat", "Wat het huis nu gebruikt, auto en stekkers inbegrepen."],
      ["Nu", calc],
      ["Vandaag", t && isNum(t.consumption_kwh) ? `${num(t.consumption_kwh)} kWh` : "—"],
      ["Tegen gisteren", isNum(ySoFar) && isNum(hSoFar) && ySoFar > 0 ? `${hSoFar >= ySoFar ? "+" : "−"}${fmt[0].format(Math.abs(hSoFar / ySoFar - 1) * 100)} %: tot nu ${num(hSoFar)} kWh, gisteren tot dezelfde tijd ${num(ySoFar)} kWh` : "—"],
      ["Vannacht", night ? `${fmt[0].format(night.w)} W gemiddeld 01:00–05:00${night.car ? " · <b>de auto laadde</b> (de meter zag de lader)" : " · basislast"}` : "—: 01:00–05:00 is nog niet voorbij"],
      ["Stekkers", plugs.length ? `samen ${num(plugSum, 2)} kWh vandaag${t && isNum(t.consumption_kwh) && t.consumption_kwh > 0 ? ` (${fmt[0].format((plugSum / t.consumption_kwh) * 100)} % van het verbruik)` : ""}` : "—"],
    ]) + chartBlock("huis", "Vandaag per uur", `${sq("var(--huis)", "vandaag")}${dash("gisteren")}<span>kWh per uur</span>`) + rows([
      ["Berekening", "afname − teruglevering + wat de batterij aan het huis levert − wat de batterij uit het stopcontact laadt"],
      ["Per uur", "het gemiddelde vermogen per uur, het lopende uur tot nu; opgeteld een paar procent onder het dagtotaal, dat uit de tellers komt"],
      ["Auto vannacht", "herkend aan de meter: een uur van 1,5 kW of meer, of een sprong van 0,8 kW tussen de uren (zoals op Meer)"],
      ["Periode", `nu: ${LIVE_PERIOD()}; per uur: vandaag tot nu`],
      ["Bron", "slimme meter, thuisbatterij en meetstekkers"],
    ]) + link("day", "Verbruik vandaag in Grafana"), after: drawChart("huis", { bars: [{ key: "house_kwh", color: "var(--huis)", label: "vandaag" }], tick: { key: "y_house_kwh", label: "gisteren" } }) };
  },
  netnu() {
    const d = state.live?.data, x = state.detail?.data, t = todayData();
    maybeFetchDetail();
    const g = d?.grid_w;
    const what = !isNum(g) ? "—" : g >= 10 ? `afname ${plain(power(g))}` : g <= -10 ? `teruglevering ${plain(power(-g))}` : "bijna niets";
    return { title: `Net · ${what}`, body: rows([
      ["Wat", "Rood: je neemt af. Groen: je levert zonnestroom terug."],
      ["Vandaag", t && isNum(t.import_kwh) ? `afgenomen ${num(t.import_kwh)} kWh (${eur(t.import_eur)}) · teruggeleverd ${num(t.export_kwh)} kWh (${eur(t.export_eur)})` : "—"],
      ["Meeste afname", peakHour(x?.hours, "import_kwh", "kWh", 2)],
      ["Meeste terug", peakHour(x?.hours, "export_kwh", "kWh", 2)],
    ]) + chartBlock("net", "Vandaag per uur", `${sq("var(--uit)", "afgenomen")}${sq("var(--eigen)", "teruggeleverd (onder de lijn)")}<span>kWh per uur</span>`) + rows([
      ["Per uur", "uit de tellers van de slimme meter: de stand aan het begin van het volgende uur − die aan het begin van dit uur"],
      ["Periode", `nu: ${LIVE_PERIOD()}; per uur: vandaag tot nu`],
      ["Bron", "slimme meter (P1); bedragen tegen de contractprijs"],
    ]) + link("day", "Net vandaag in Grafana"), after: drawChart("net", { bars: [{ key: "import_kwh", color: "var(--uit)", label: "afgenomen" }, { key: "export_kwh", color: "var(--eigen)", neg: true, label: "teruggeleverd" }], digits: 1 }) };
  },
  gas() {
    const t = todayData(), x = state.detail?.data;
    maybeFetchDetail();
    return { title: `Gas vandaag · ${t && isNum(t.gas_m3) ? fmt[2].format(t.gas_m3) + " m³" : "—"}`, body: rows([
      ["Wat", "Gas vandaag: verwarming, warm water en koken."],
      ["Kosten", t && isNum(t.gas_eur) ? `${eur(t.gas_eur)} (contractprijs)` : "—"],
      ["Meeste gas", peakHour(x?.hours, "gas_m3", "m³", 2)],
      ["Buiten", outdoorRange()],
    ]) + chartBlock("gas", "Vandaag per uur", `${sq("var(--gas)", "gas (m³ per uur)")}${lineLg("buiten (°C, rechts)", "var(--muted)")}`) + rows([
      ["Berekening", "stand van de gasmeter nu − stand om 00:00; per uur de stand aan het begin van het volgende uur − die aan het begin van dit uur"],
      ["Periode", "vandaag tot nu; de gasmeter meldt zich elke 5 minuten"],
      ["Bron", `gasmeter via de slimme meter; buitentemperatuur Buienradar, ${station()}`],
    ]) + link("period", "Gas in Grafana"), after: drawChart("gas", { bars: [{ key: "gas_m3", color: "var(--gas)", label: "gas m³" }], line: { points: outdoorPoints(), color: "var(--muted)" }, digits: 1 }) };
  },
  buiten() {
    const d = state.live?.data;
    maybeFetchDetail();
    return { title: `Buiten · ${d && isNum(d.outdoor_c) ? fmt[1].format(d.outdoor_c) + " °C" : "—"}`, body: rows([
      ["Wat", "De buitentemperatuur van het weerstation in de buurt."],
      ["Vandaag", outdoorRange()],
    ]) + chartBlock("buiten", "Vandaag", `${lineLg("buiten (°C, rechts)", "var(--muted)")}${sq("var(--gas)", "gas (m³ per uur)")}`) + rows([
      ["Periode", d?.outdoor_time ? `meting van ${hm(d.outdoor_time)}; er komt er elke 10 minuten een` : "geen meting in de laatste 3 uur, daarom “—”"],
      ["Bron", `Buienradar, ${station()} (elke 10 minuten opgehaald)`],
    ]), after: drawChart("buiten", { bars: [{ key: "gas_m3", color: "var(--gas)", label: "gas m³" }], line: { points: outdoorPoints(), color: "var(--muted)" }, digits: 1 }) };
  },
  plugs() {
    const d = state.live?.data, x = state.detail?.data;
    maybeFetchDetail();
    const live = Object.fromEntries((d?.plugs || []).map((p) => [p.name, p]));
    const day = Object.fromEntries((x?.plugs || []).map((p) => [p.name, p]));
    const names = [...new Set([...Object.keys(live), ...Object.keys(day)])].sort((a, b) => plugLabel(a).localeCompare(plugLabel(b)));
    const max = Math.max(1, ...Object.values(day).flatMap((p) => (p.w || []).filter(isNum)));
    const vs = (p) => (p && isNum(p.usual_sofar_kwh) ? `<small>gewoonlijk ${fmt[2].format(p.usual_sofar_kwh)}</small>${isNum(p.usual_kwh) ? `<small>hele dag ${fmt[2].format(p.usual_kwh)}</small>` : ""}` : "");
    const table = names.length ? `<table class="t27 tplugday"><thead><tr><th></th><th>nu</th><th>vandaag kWh</th><th>per uur</th></tr></thead><tbody>${names.map((n) => {
      const l = live[n], p = day[n];
      return `<tr data-sheet="plug:${esc(n)}"><th scope="row"><button type="button" data-sheet="plug:${esc(n)}">${esc(plugLabel(n))} ›</button></th><td>${l ? plain(power(l.w)) : "—"}</td><td>${p && isNum(p.today_kwh) ? fmt[2].format(p.today_kwh) : "—"}${vs(p)}</td><td>${p ? plugSpark(p.w, max) : ""}</td></tr>`;
    }).join("")}</tbody></table>` : "<p>Geen stekker meldde zich in de laatste 15 minuten.</p>";
    return { title: "Stekkers", body: rows([
      ["Wat", "Apparaten met een meetstekker; ze zitten al in het verbruik van het huis. Tik op een stekker voor zijn dag per uur."],
    ]) + table + rows([
      ["Gewoonlijk", "de mediaan van de laatste 14 dagen tot dit uur; daarachter een hele dag"],
      ["Per uur", "per uur, alle stekkers op één schaal (hoogste: " + plain(power(max)) + ")"],
      ["Periode", "nu: live per stekker; vandaag: tot nu"],
      ["Bron", "Zigbee-meetstekkers"],
    ]) + link("plugs", "Stekkers in Grafana") };
  },
  // One plug (key "plug:<name>"): today per hour against its usual day, like the Huis sheet against yesterday.
  plug(name) {
    const d = state.live?.data, x = state.detail?.data, t = todayData();
    maybeFetchDetail();
    const l = (d?.plugs || []).find((q) => q.name === name), p = (x?.plugs || []).find((q) => q.name === name);
    const hours = (x?.hours || []).map((h, i) => ({ hour: h.hour, w: p?.w?.[i], uw: p?.uw?.[i] }));
    const sofar = p && isNum(p.today_kwh) && isNum(p.usual_sofar_kwh) && p.usual_sofar_kwh > 0
      ? `${p.today_kwh >= p.usual_sofar_kwh ? "+" : "−"}${fmt[0].format(Math.abs(p.today_kwh / p.usual_sofar_kwh - 1) * 100)} %: tot nu ${fmt[2].format(p.today_kwh)} kWh, gewoonlijk tot dezelfde tijd ${fmt[2].format(p.usual_sofar_kwh)} kWh${isNum(p.usual_kwh) ? `; een hele dag gewoonlijk ${fmt[2].format(p.usual_kwh)} kWh` : ""}`
      : "—";
    const share = p && isNum(p.today_kwh) && t && isNum(t.consumption_kwh) && t.consumption_kwh > 0 ? `${fmt[0].format((p.today_kwh / t.consumption_kwh) * 100)} % van wat het huis vandaag gebruikte (${num(t.consumption_kwh)} kWh)` : "—";
    const draw = () => {
      const box = $('[data-dchart="plug"]');
      if (!box) return;
      box.innerHTML = x && !p ? '<p class="empty">—: deze stekker meldde zich vandaag niet.</p>'
        : dayChart(x && { hours }, { bars: [{ key: "w", color: "var(--huis)", label: "vandaag" }], tick: { key: "uw", label: "gewoonlijk" }, width: box.clientWidth, tipFmt: (v) => `${fmt[0].format(v)} W` });
    };
    return { title: `${plugLabel(name)} · ${l ? plain(power(l.w)) : "—"}`, body: rows([
      ["Nu", l ? `${plain(power(l.w))} (gemeld om ${hm(l.time)})` : "—: meldde zich niet in de laatste 15 minuten"],
      ["Vandaag", p && isNum(p.today_kwh) ? `${fmt[2].format(p.today_kwh)} kWh` : "—"],
      ["Tegen gewoonlijk", sofar],
      ["Meeste", peakHour(hours, "w", "W", 0)],
      ["Aandeel", share],
    ]) + chartBlock("plug", "Vandaag per uur", `${sq("var(--huis)", "vandaag")}${dash("gewoonlijk")}<span>W gemiddeld per uur</span>`) + rows([
      ["Per uur", "het gemiddelde vermogen per uur, het lopende uur tot nu"],
      ["Gewoonlijk", "per uur: de mediaan van hetzelfde uur over de laatste 14 dagen; tot nu: wat de stekker die dagen tot dezelfde tijd gebruikte (mediaan)"],
      ["Periode", "nu: live, de stekker meldt zich op zijn eigen moment; per uur: vandaag 00:00 – nu, elke minuut nieuw"],
      ["Bron", "Zigbee-meetstekker; zit al in het verbruik van het huis, niet erbovenop"],
    ]) + '<p><a href="#" data-sheet="plugs">Alle stekkers ›</a></p>' + link("plugs", "Stekkers in Grafana"), after: draw };
  },
  opgewekt() {
    const t = todayData();
    return { title: `Opgewekt · ${plain(kwh(t?.generated_kwh))}`, body: rows([
      ["Berekening", "het zonvermogen van de thuisbatterij, opgeteld sinds 00:00 (elke 5 s gemeten)"],
      ["Zelf benut", t && isNum(t.self_consumption)
        ? `${fmt[0].format(t.self_consumption * 100)} %: niet teruggeleverd, maar zelf gebruikt of in de batterij gezet`
        : "—: nog niets opgewekt vandaag"],
      ["Periode", TODAY_PERIOD],
      ["Bron", "thuisbatterij (de panelen hangen eraan)"],
    ]) + link("period", "Opgewekt per dag in Grafana") };
  },
  verbruik() {
    const t = todayData();
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
    const t = todayData();
    return { title: `Zelfvoorzienend · ${plain(pct(t?.self_sufficiency))}`, body: rows([
      ["Wat", "Deel van je verbruik dat uit eigen zon kwam, direct of via de batterij."],
      ["Berekening", "eigen verbruik ÷ verbruik; eigen verbruik = verbruik − afgenomen"],
      ["Vandaag", t && isNum(t.self_used_kwh) ? `${num(t.self_used_kwh)} ÷ ${num(t.consumption_kwh)} kWh` : "—"],
      ["Periode", TODAY_PERIOD],
      ["Bron", "tellers van de slimme meter en de thuisbatterij"],
    ]) + link("period", "Zelfvoorzienend per dag in Grafana") };
  },
  net() {
    const t = todayData();
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
    const t = todayData();
    return { title: `Zon verwacht · morgen ${f && f.tomorrow_hours >= 24 ? plain(approx(f.tomorrow_kwh)) : "—"}`, body: rows([
      ["Wat", "Verwachte opbrengst van de panelen (≈: geen meting)."],
      ["Nog vandaag", f && isNum(f.rest_today_kwh) ? `${plain(approx(f.rest_today_kwh))} van nu tot middernacht; de hele dag ${plain(approx(f.today_kwh))}${t && isNum(t.generated_kwh) ? `, opgewekt tot nu ${plain(kwh(t.generated_kwh))}` : ""}` : "—"],
      ["Morgen", f && f.tomorrow_hours >= 24 ? `${plain(approx(f.tomorrow_kwh))} (${weekday(1)})` : "—: nog geen verwachting voor morgen"],
      ["Berekening", "de zon die de weerverwachting per uur geeft op elk dakvlak × wat elke string echt opwekte per eenheid zon"],
      notes.planes && ["Dakvlakken", esc(notes.planes)],
      notes.accuracy && ["Hoe goed", esc(notes.accuracy)],
      ["Periode", f?.fetched_at ? `elk uur nieuw opgehaald, laatst om ${hm(f.fetched_at)}` : "elk uur nieuw opgehaald; nog niets opgehaald"],
      ["Bron", `Open-Meteo (gratis, zonder account)${notes.location ? `. Locatie: ${esc(notes.location)}` : ""}`],
    ]) + link("period", "Verwacht en opgewekt per dag in Grafana") };
  },
  rekening() {
    const t = todayData();
    return { title: `Energierekening vandaag · ${eur(t?.net_eur)}`, body: rows([
      ["Wat", "Wat vandaag tot nu kost volgens je energiecontract."],
      ["Stroom", t ? `${eur(t.import_eur)} afname − ${eur(t.export_eur)} teruglevering` : "—"],
      ["Gas", eur(t?.gas_eur)],
      ["Vaste kosten", t ? `${eur(t.fixed_eur)} per dag` : "—"],
      ["Niet meegeteld", "terugleverkosten: tot 2027 een vast bedrag per dag dat pas bij de jaarafrekening vastligt"],
      ["Periode", TODAY_PERIOD],
      ["Bron", "meterstanden en de contractprijzen uit DSMR-reader"],
    ]) + link("money", "Energierekening in Grafana") };
  },
  bespaard() {
    const s = todaySavings();
    if (!s) return { title: "Bespaard door de batterij · —", body: "<p>Nog geen gegevens vandaag, of de dag ligt vóór de installatie van de batterij.</p>" };
    return { title: `Bespaard door de batterij · ≈ ${eur(s.savings_eur)}`, body: rows([
      ["Wat", "Wat de batterij vandaag scheelt, met de regels van 2027 (geen salderen)."],
      ["Berekening", `rekening zonder batterij − rekening met batterij = ${eur(s.cost_without_eur)} − ${eur(s.cost_with_eur)}`],
      ["Afname", `${num(s.import_without_kwh, 2)} kWh zonder batterij, ${num(s.import_with_kwh, 2)} kWh echt`],
      ["Teruglevering", `${num(s.export_without_kwh, 2)} kWh zonder batterij, ${num(s.export_with_kwh, 2)} kWh echt`],
      ["Prijzen 2027", `afname € ${num(s.p_import, 5)}/kWh; teruglevering levert € ${num(s.p_feedin, 4)} op en kost € ${num(s.p_feedin_cost, 5)} terugleverkosten per kWh`],
      ["Zonder batterij", "verbruik − de zon zoals een gewone omvormer die had geleverd. Het rendement daarvan is gemeten aan je vorige omvormer (75 % bij weinig zon, 97 % bij veel). Dat is de enige aanname: daarom “berekend” en “≈”."],
      ["Periode", "vandaag tot nu, elke 5 minuten bijgewerkt"],
      ["Bron", "slimme meter, thuisbatterij, contractprijzen 2027"],
    ]) };
  },
  laadniveau() {
    const d = state.live?.data;
    return { title: `Laadniveau · ${isNum(d?.soc) ? fmt[0].format(d.soc) + "%" : "—"}`, body: rows([
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
    const t = todayData();
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
      ["Wat", "Wat de batterij scheelt met de regels van 2027 (geen salderen)."],
      ["Berekening", "per dag: rekening zonder batterij − rekening met batterij, met de prijzen van 2027; zonder batterij = verbruik − de zon zoals je vorige omvormer die had geleverd (gemeten rendement). Daarom “berekend” en “≈”."],
      ["Vandaag", sv ? `≈ ${eur(sv.today_eur)}` : "—"],
      ["Deze maand", sv ? `≈ ${eur(sv.month_eur)}` : "—"],
      ["Sinds installatie", sv ? `≈ ${eur(sv.total_eur)} over ${sv.days} dagen${sv.since ? ` (vanaf ${new Date(sv.since).toLocaleString("nl-NL", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: TZ })})` : ""}` : "—"],
      price && ["Terugverdienen", `tegen ${eur0(price)}, de aanschafprijs`],
      ["Periode", sv?.filled_at ? `vandaag elke 5 min; eerdere dagen elk uur, laatst ${hm(sv.filled_at)}` : "vandaag elke 5 min; eerdere dagen nog niet berekend"],
      ["Bron", "slimme meter, thuisbatterij, contractprijzen 2027"],
    ]) };
  },
  g2027() {
    const b = state.money?.bill_2027;
    return { title: `Klaar voor 2027 · ≈ ${b ? eur0(b.net_eur) : "—"}`, body: rows([
      ["Wat", "Wat dit jaar tot nu had gekost met de regels en prijzen van 2027."],
      ["Echt", b ? `${eur0(b.real_eur)} (de rekening van dit jaar tot nu, met salderen)` : "—"],
      ["Afname", b ? `${num(b.import_kwh, 0)} kWh × € ${num(b.p_import, 5)} = ${eur0(b.import_eur)}` : "—"],
      ["Teruglevering", b ? `${num(b.export_kwh, 0)} kWh × (€ ${num(b.p_feedin, 4)} − € ${num(b.p_feedin_cost, 5)} terugleverkosten) = ${eur0(b.export_eur)}` : "—"],
      ["Gas", b ? `${num(b.gas_m3, 0)} m³ × € ${num(b.p_gas, 4)} = ${eur0(b.gas_eur)}` : "—"],
      ["Vaste kosten", b ? `${b.days} dagen × € ${num(b.p_fixed, 4)} = ${eur0(b.fixed_eur)}` : "—"],
      ["Let op", "Rekenvoorbeeld op dit jaar: met de batterij was er minder teruggeleverd, en ook de prijzen verschillen."],
      ["Periode", "1 januari – nu"],
      ["Bron", "meterstanden en de contractprijzen voor 2027"],
    ]) + link("money", "Geld in Grafana") };
  },
  gmaanden() {
    const h = state.moneyYear;
    return { title: "Energierekening per maand", body: rows([
      ["Wat", "De rekening per maand; grijze lijn: vorig jaar."],
      ["Berekening", "stroomkosten − terugleververgoeding + gaskosten + vaste kosten, met het contract dat toen gold en salderen per afrekenperiode. Terugleverkosten tellen nog niet mee."],
      ["Dit jaar", h ? `${eur0(h.totals?.net_eur)} tot nu; vorig jaar tot dezelfde dag ${eur0(h.ly_totals?.net_eur)}` : "—"],
      ["Bron", "meterstanden en de contractprijzen uit DSMR-reader"],
    ]) + link("money", "Geld in Grafana") };
  },
  hopgewekt() { return histSheet("Opgewekt", "generated_kwh", "kWh", "Wat de zonnepanelen opwekten.", "som van de opbrengst per dag: tot 13-11-2026 de teller van de omvormer, sindsdien het zonvermogen van de thuisbatterij, opgeteld", "omvormer / thuisbatterij"); },
  hverbruik() { return histSheet("Verbruik", "consumption_kwh", "kWh", "Wat het huis gebruikte, auto en stekkers inbegrepen.", "per dag: afgenomen − teruggeleverd + opgewekt (vóór de batterij) of + uit de batterij − uit het stopcontact (sinds de batterij)", "slimme meter en omvormer / thuisbatterij"); },
  hzelfv() { return histSheet("Zelfvoorzienend", "self_sufficiency", "%", "Deel van je verbruik dat uit eigen zon kwam, direct of via de batterij.", "eigen verbruik ÷ verbruik over de hele periode (niet het gemiddelde van de dagen)", "slimme meter en omvormer / thuisbatterij"); },
  hbenut() { return histSheet("Zelf benut", "self_consumption", "%", "Deel van de opgewekte zon dat niet naar het net ging.", "(opgewekt − teruggeleverd) ÷ opgewekt over de hele periode", "slimme meter en omvormer / thuisbatterij"); },
  hnet() { return histSheet("Afgenomen · teruggeleverd", "import_kwh", "kWh", "Stroom van en naar het net.", "standen van de slimme meter, normaal- en daltarief samen", "slimme meter", "export_kwh"); },
  hrekening() { return histSheet("Energierekening", "net_eur", "€", "Wat deze periode kostte volgens je energiecontracten.", "stroomkosten − terugleververgoeding + gaskosten + vaste kosten, met de prijzen van het contract dat toen gold en salderen per afrekenperiode (tot en met 2026). Terugleverkosten tellen nog niet mee.", "meterstanden en de contractprijzen uit DSMR-reader", undefined, [["Contract", "het contract dat toen gold; terugleverkosten tellen nog niet mee"]]); },
  hgas() { return histSheet("Gas", "gas_m3", "m³", "", "standen van de gasmeter per dag", "gasmeter via de slimme meter"); },
  hsoc() {
    const s = state.hist.data?.soc;
    const r = s?.ranges || [], pts = (s?.points || []).map((p) => p.soc).filter(isNum);
    const lo = s?.unit === "day" ? Math.min(...pts) : Math.min(...r.map((x) => x.min)), hi = s?.unit === "day" ? Math.max(...pts) : Math.max(...r.map((x) => x.max));
    const has = Number.isFinite(lo) && Number.isFinite(hi);
    return { title: `Laadniveau batterij · ${has ? `${fmt[0].format(lo)}–${fmt[0].format(hi)}%` : "—"}`, body: rows([
      ["Grafiek", s?.unit === "day" ? "het laadniveau per 5 minuten, met de onder- en bovengrens gestippeld" : `per ${s?.unit === "year" ? "maand" : "dag"} een balk van het laagste tot het hoogste laadniveau: raakte de batterij vol, en kwam hij bij de ondergrens?`],
      ["Kleuren", "groen vanaf 50 %, oranje van 20 tot 50 %, rood onder 20 %"],
      ["Periode", s?.first ? `metingen sinds ${dmyTs(s.first)}` : "—"],
      ["Bron", "thuisbatterij"],
    ]) + link("battery", "Batterij in Grafana") };
  },
  hgraad() { return histSheet("Graaddagen", "degree_days", "", "Hoe koud het was, op maat van dit huis: twee keer zoveel graaddagen is ongeveer twee keer zoveel stookgas.", "per dag max(17 °C − daggemiddelde buiten, 0) × 1,1 (nov–feb), × 1,0 (mrt, okt) of × 0,8 (apr–sep): gewogen graaddagen op een basis van 17 °C. Waarom 17: over 5½ jaar gasverbruik van dit huis past dit het best (beter dan 18 °C, en beter dan ongewogen); met ongeveer 20,5 °C binnen leveren zon, mensen en apparaten de rest. Mindergas rekent met 20,5 °C binnen en een stookgrens van 18 °C en telt daardoor meer graaddagen (oktober 2026: ≈ 258 tegen 149 hier). KNMI levert de daggemiddelden een of twee dagen later; tot dan staat een dag zonder graaddagen.", `KNMI, ${station()} (gemeten daggemiddelde)`, undefined, [["Laatste dagen", "KNMI meldt een dag pas 1–2 dagen later; tot dan telt die dag zonder graaddagen."]]); },
  hgpg() { return histSheet("Gas per graaddag", "gas_per_degree_day", "m³", "Gas per graaddag: lager is zuiniger gestookt, los van het weer.", "gas op dagen met een graaddagwaarde ÷ graaddagen; pas vanaf 5 graaddagen (anders “—”). Gas voor warm water en koken telt ook mee (ongeveer 0,2 m³ per dag), dus in de zomer is dit getal hoog.", `gasmeter en KNMI (${station()})`, undefined, [["Let op", "vanaf 5 graaddagen (anders “—”); warm water en koken tellen mee, dus 's zomers hoog"]]); },
  temperatuur() {
    const d = state.live?.data, sm = state.battery?.summary;
    return { title: `Temperatuur batterij · ${d && isNum(d.battery_temp_c) ? fmt[0].format(d.battery_temp_c) + " °C" : "—"}`, body: rows([
      ["Wat", "Temperatuur die de batterij meldt (zoals in de Anker-app)."],
      ["Vandaag", sm && isNum(sm.temp_min_c) ? `laagste ${fmt[0].format(sm.temp_min_c)} °C, hoogste ${fmt[0].format(sm.temp_max_c)} °C` : "—"],
      ["Periode", LIVE_PERIOD() + "; laagste en hoogste: vandaag 00:00 – nu"],
      ["Bron", "thuisbatterij"],
    ]) + link("tech", "Temperatuur in Grafana (Techniek)") };
  },
  socdag() {
    const sm = state.battery?.summary;
    return { title: "Laadniveau vandaag", body: rows([
      ["Wat", "Laadniveau sinds middernacht, per 5 minuten."],
      ["Kleuren", "groen vanaf 50 %, oranje van 20 tot 50 %, rood onder 20 %; elk stuk van de lijn heeft de kleur van zijn eigen hoogte"],
      ["Gestippeld", "onder- en bovengrens uit de Anker-app; onder de ondergrens ontlaadt ze niet"],
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
      ["Wat", "Welk deel er aan de andere kant uitkomt, per vermogensband."],
      ["Zon → batterij + huis", "(in de cellen + naar het huis) ÷ zon, tijdens laden uit zon"],
      ["Batterij → huis", "naar het huis ÷ uit de cellen, tijdens ontladen zonder zon"],
      ["Stopcontact → batterij", "in de cellen ÷ uit het stopcontact, tijdens laden van het net"],
      ["Periode", "laatste 30 dagen; een band telt pas vanaf 5 minuten metingen"],
      ["Bron", "thuisbatterij, metingen om de paar seconden"],
    ]) + link("battery", "Rendement in Grafana") };
  },
  gezondheid() {
    const sm = state.battery?.summary;
    return { title: `Gezondheid · ${sm && isNum(sm.soh) ? fmt[0].format(sm.soh) + "%" : "—"}`, body: rows([
      ["SOH", "wat de batterij zelf meldt over haar resterende capaciteit (state of health)"],
      ["Capaciteit", sm && isNum(sm.rated_kwh) ? `${plain(kwh(sm.rated_kwh))}, zoals de batterij meldt (verkocht als 7 kWh)` : "—"],
      ["Periode", "live"],
      ["Bron", "thuisbatterij"],
    ]) + link("tech", "Gezondheid in Grafana (Techniek)") };
  },
  cycli() {
    const sm = state.battery?.summary;
    return { title: `Volle cycli · ${sm && isNum(sm.full_cycles) ? fmt[1].format(sm.full_cycles) : "—"}`, body: rows([
      ["Wat", "Hoe vaak de batterij in totaal vol is geladen (twee keer half = één)."],
      ["Berekening", sm ? `geladen sinds nieuw ÷ capaciteit = ${num(sm.charged_total_kwh)} ÷ ${num(sm.rated_kwh)} kWh` : "geladen sinds nieuw ÷ capaciteit"],
      ["Periode", "sinds de batterij nieuw is"],
      ["Bron", "thuisbatterij"],
    ]) + link("battery", "Batterij in Grafana") };
  },
  mbasis() {
    const u = state.meer?.usage;
    const cars = (u?.nights || []).filter((x) => x.car).length;
    return { title: `Basislast · ${u?.last ? plain(watt(u.last.w)) : "—"}`, body: rows([
      ["Wat", "Wat het huis 's nachts (01:00–05:00) gebruikt als niemand iets aanzet."],
      ["Berekening", "per nacht het gemiddelde verbruik van het huis tussen 01:00 en 05:00 (net plus wat de batterij aan het huis levert); “gewoonlijk” is de mediaan van de laatste 30 nachten, zodat een uitschieter niet meetelt"],
      ["Auto", `nachten waarin de auto laadde tellen niet mee (grijs in de grafiek${cars ? `, ${cars} van de laatste ${u.nights.length}` : ""})`],
      ["Auto herkend", `aan de meter: een uur van 1,5 kW of meer (zo hoog komt de basislast nooit; de lader voegt 1,6–1,8 kW toe) of een sprong van 0,8 kW tussen de uren, dus ook als de laadbeurt nog niet is ingelezen.`],
      ["Vorig jaar", u && isNum(u.ly_median_30) ? `${plain(watt(u.ly_median_30))}: dezelfde 30 nachten een jaar eerder, op dezelfde manier` : "te weinig nachten zonder laden in dezelfde periode vorig jaar"],
      ["Laatste 12 maanden", u && isNum(u.median_365) ? `${plain(watt(u.median_365))}, mediaan van ${u.n_365} nachten: dag en nacht zo veel is ≈ ${yearKwh(u.median_365)} per jaar${isNum(u.prev_median_365) ? `; de 12 maanden daarvoor ${plain(watt(u.prev_median_365))} (${u.median_365 >= u.prev_median_365 ? "+" : "−"}${fmt[0].format(Math.abs(u.median_365 - u.prev_median_365))} W, ≈ ${yearKwh(Math.abs(u.median_365 - u.prev_median_365))} per jaar ${u.median_365 >= u.prev_median_365 ? "meer" : "minder"})` : ""}` : "—: nog geen 180 nachten zonder laden"],
      ["Seizoen", "'s winters ligt de basislast elk jaar hoger dan 's zomers: in nachten waarin de verwarming tussen 01:00 en 05:00 brandt, gebruiken de ketel en de pomp ongeveer 50–75 W extra (gemeten: november 2026 van 372 naar 446 W toen de verwarming 's nachts aansloeg). Vergelijk daarom de laatste 30 nachten met dezelfde nachten vorig jaar, en het jaar met het jaar ervoor"],
    ]) + `<h4 class="sub">Per maand, laatste 3 jaar</h4><div class="chart" data-mmonths></div><p class="legend"><span><i class="sq" style="--c:var(--huis)"></i>mediaan per maand</span><span><i class="ln dash" style="border-top-color:var(--fg)"></i>laatste 12 maanden</span><span>W</span></p>` + rows([
      ["Per maand", "de mediaan van de nachten in die maand, zonder de nachten waarin de auto laadde; de lopende maand lichter"],
      ["Tot de batterij", "vóór 13 november 2026 is de basislast wat de slimme meter 's nachts afnam: zonder zon en zonder batterij is dat het hele huis"],
      ["Stekkers", "de tabel eronder: per stekker vannacht, en de rest van het huis"],
      ["Periode", "de laatste 60 nachten; per maand: de laatste 36 maanden"],
      ["Bron", "slimme meter, thuisbatterij, meetstekkers, laadsessies"],
    ]) + link("day", "Verloop per dag in Grafana"), after: () => {
      const box = $("[data-mmonths]");
      if (box) box.innerHTML = u?.months?.length ? monthChart(u.months, u.median_365, box.clientWidth) : '<p class="empty">Laden…</p>';
    } };
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
    const chart = carChart(h);
    return { title: `Auto · ${c && isNum(c.net_eur) ? eur(c.net_eur) : "—"}`, after: drawHistChart(chart), body: rows([
      ["Wat", "Waar de auto in deze periode laadde, en wat thuis laden opleverde. Een laadbeurt telt in de periode waarin hij begon."],
      ["Thuis", carNoData(c) || (carHome(c) === "none" ? `nog niet binnen: de nieuwste thuissessie is van ${dmyTs(c.last_home)}`
        : `${home ? `${place(home)}, waarvan ${plain(kwh(home.solar_kwh, 0))} uit eigen zon${share(home)}` : "niet geladen"}${carHome(c) === "part" ? `; alleen tot ${dmyTs(c.last_home)}, de rest komt nog binnen` : ""}`)],
      ["Vergoed − kosten", home ? `${eur(home.reimbursed_eur)} vergoed − ${eur(home.real_cost_eur)} werkelijke kosten = ${eur(c.net_eur)}` : "—"],
      ["Werk", now.work ? `${place(now.work)}, ${eur(now.work.billed_eur)} op de laadpas` : "niet geladen"],
      ["Onderweg", now.public ? `${place(now.public)}, ${eur(now.public.billed_eur)} op de laadpas` : "niet geladen"],
    ]) + histChartBlock(h, chart) + rows([
      ["Vorig jaar", !ly ? "—: van toen zijn er nog geen laadgegevens" : `thuis ${lyHome ? `${place(lyHome)}, eigen zon ${plain(kwh(lyHome.solar_kwh, 0))}${share(lyHome)}, vergoed − kosten ${eur(c.ly_net_eur)}` : "niet geladen"} · werk ${ly.work ? plain(kwh(ly.work.kwh, 0)) : "—"} · onderweg ${ly.public ? plain(kwh(ly.public.kwh, 0)) : "—"}`],
      ["Deze periode", period],
      ["Thuis bijgewerkt", c?.last_home ? `in pakketjes binnen; de nieuwste thuissessie is van ${dmyTs(c.last_home)}` : "—"],
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
// notes: rows shown under the chart, before the method rows (which go into the fold)
function histSheet(title, key, unitName, what, how, source, key2, notes) {
  const h = state.hist.data, T = h?.totals || {}, Y = h?.ly_totals || {};
  const f = (x) => (!isNum(x) ? "—" : unitName === "%" ? `${fmt[0].format(x * 100)} %` : unitName === "€" ? eur(x, 2) : `${fmt[unitName === "m³" && key === "gas_per_degree_day" ? 2 : 1].format(x)}${unitName ? " " + unitName : ""}`);
  const val = (o) => (key2 ? `${f(o[key])} · ${f(o[key2])}` : f(o[key]));
  const period = h ? `${histLabel(h)}${h.running ? ", tot nu" : ""}` : "—";
  const ly = h ? `${new Date(h.ly_start).toLocaleDateString("nl-NL", { day: "numeric", month: "short", year: "numeric", timeZone: TZ })} – ${new Date(new Date(h.ly_compare_end).getTime() - 3600000).toLocaleDateString("nl-NL", { day: "numeric", month: "short", year: "numeric", timeZone: TZ })}` : "—";
  const c = h && HIST_CHARTS[SHEET_OF_KEY[key]]?.(h);
  return { title: `${title} · ${h ? val(T) : "—"}`, body: rows([
    what && ["Wat", what],
    ["Deze periode", `${period}: ${h ? val(T) : "—"}`],
    ["Vorig jaar", `${ly}: ${h ? val(Y) : "—"}`],
  ]) + histChartBlock(h, c) + rows([
    ...(notes || []),
    ["Berekening", how],
    h?.bucket === "hour" && ["Per uur", c?.note || "de staafjes per uur komen uit het gemiddelde vermogen per uur; het dagtotaal uit de tellers, dus ze kunnen een paar procent verschillen"],
    ["Bron", source],
  ]) + link("period", "Periode in Grafana"), after: drawHistChart(c) };
}
// Which chart (HIST_CHARTS) belongs to a histSheet, by its key.
const SHEET_OF_KEY = { generated_kwh: "hopgewekt", consumption_kwh: "hverbruik", self_sufficiency: "hzelfv", self_consumption: "hbenut", import_kwh: "hnet", net_eur: "hrekening", gas_m3: "hgas", degree_days: "hgraad", gas_per_degree_day: "hgpg" };

// Sheet for this month's or this year's bill.
function moneySheet(k, title) {
  const b = state.money?.[`bill_${k}`];
  return { title: `${title} · ${b ? eur(b.net_eur) : "—"}`, body: rows([
    ["Stroom", b ? `${eur(b.import_eur)} afname (${num(b.import_kwh, 0)} kWh) − ${eur(b.export_eur)} teruglevering (${num(b.export_kwh, 0)} kWh)` : "—"],
    ["Gas", b ? `${eur(b.gas_eur)} (${num(b.gas_m3, 0)} m³)` : "—"],
    ["Vaste kosten", b ? `${eur(b.fixed_eur)} over ${b.days} dagen` : "—"],
    ["Berekening", "met de prijzen van het contract dat toen gold; tot en met 2026 wordt teruglevering verrekend tegen de stroomprijs (salderen per afrekenperiode)"],
    ["Niet meegeteld", "terugleverkosten: tot 2027 een vast bedrag per dag dat pas bij de jaarafrekening vastligt"],
    ["Periode", k === "month" ? "deze maand, de 1e – nu" : "dit jaar, 1 januari – nu"],
    ["Bron", "meterstanden en de contractprijzen uit DSMR-reader"],
  ]) + link("money", "Geld in Grafana") };
}

function openSheet(key) {
  const i = key.indexOf(":"); // "plug:tv": the sheet "plug" for "tv"
  const make = SHEETS[i < 0 ? key : key.slice(0, i)];
  if (!make) return;
  const dlg = $("#sheet");
  if (!dlg.open || dlg.dataset.key !== key) foldOpen = false;
  foldSheet = i < 0 ? key : key.slice(0, i); foldRows = [];
  let built;
  try { built = make(i < 0 ? undefined : key.slice(i + 1)); } finally { foldSheet = null; }
  const { title, body, after } = built;
  $("#sheet-title").textContent = title;
  $("#sheet-body").innerHTML = body + foldHtml();
  // a new sheet (also one opened from inside another, e.g. a plug from Stekkers) starts at its top
  // without a label; a redraw of the same one keeps both
  if (!dlg.open || dlg.dataset.key !== key) { hideTip(); dlg.scrollTop = 0; }
  dlg.dataset.key = key;
  if (!dlg.open) dlg.showModal();
  after?.(); // drawn once the sheet is open, so a chart can take the sheet's real width
}
export function refreshSheet() {
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
