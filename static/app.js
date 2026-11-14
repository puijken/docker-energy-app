// Energy app front end: no build step, no framework. One EventSource feeds every number.
// Rules shown on screen: only measured values in tiles (the one calculated number says so), every
// value says whether it is live or "vandaag 00:00 – nu", and an empty value is "—" with a reason.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const fmt = {};
for (const d of [0, 1, 2, 3, 4, 5]) fmt[d] = new Intl.NumberFormat("nl-NL", { minimumFractionDigits: d, maximumFractionDigits: d });
const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const num = (x, d = 1) => (isNum(x) ? fmt[d].format(x) : "—");
const unit = (text, u) => (text === "—" ? "—" : `${text}<small>${u}</small>`);
const kwh = (x, d = 1) => unit(num(x, d), "kWh");
const eur = (x, d = 2) => (isNum(x) ? `€\u00a0${fmt[d].format(x)}` : "—");
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

// ---------- flow picture: one line per measured connection (real wiring) ----------
function flowSvg() {
  return `
  <svg viewBox="0 0 340 282" aria-label="Stroomschema: waar de stroom nu vandaan komt en heen gaat">
    <path class="line off" data-line="zon" d="M152 68 L101 137" stroke="var(--zon)"/>
    <path class="line off" data-line="bat" d="M117 168 L223 168" stroke="var(--bat)"/>
    <path class="line off" data-line="net" d="M262 244 L262 207" stroke="var(--uit)"/>
    <text data-t="zon-line" x="114" y="98" font-size="12.5" fill="var(--muted)" text-anchor="end"></text>
    <text data-t="bat-line" x="170" y="158" font-size="12.5" fill="var(--muted)" text-anchor="middle"></text>
    <text data-t="net-line" x="274" y="229" font-size="12.5" fill="var(--muted)"></text>

    <g class="node" data-sheet="zon" tabindex="0" role="button" aria-label="Zon">
      <circle cx="170" cy="42" r="31" fill="var(--card)" stroke="var(--zon)" stroke-width="3"/>
      <text data-t="zon" x="170" y="43" text-anchor="middle" class="big" font-size="16" fill="var(--fg)">—</text>
      <text data-t="zon-u" x="170" y="58" text-anchor="middle" font-size="10.5" fill="var(--muted)">zon</text>
    </g>
    <g class="node" data-sheet="batterij" tabindex="0" role="button" aria-label="Batterij">
      <circle cx="78" cy="168" r="39" fill="var(--card)" stroke="var(--bat)" stroke-width="3"/>
      <text data-t="soc" x="78" y="166" text-anchor="middle" class="big" font-size="19" fill="var(--fg)">—</text>
      <text data-t="bat-state" x="78" y="183" text-anchor="middle" font-size="10.5" fill="var(--muted)"></text>
      <text data-t="bat-label" x="78" y="225" text-anchor="middle" font-size="11.5" fill="var(--muted)">Batterij</text>
    </g>
    <g class="node" data-sheet="huis" tabindex="0" role="button" aria-label="Huis">
      <circle cx="262" cy="168" r="39" fill="var(--card)" stroke="var(--huis)" stroke-width="3"/>
      <text data-t="huis" x="262" y="167" text-anchor="middle" class="big" font-size="19" fill="var(--fg)">—</text>
      <text data-t="huis-u" x="262" y="183" text-anchor="middle" font-size="10.5" fill="var(--muted)">huis</text>
    </g>
    <g class="node" data-sheet="netnu" tabindex="0" role="button" aria-label="Net">
      <rect data-t="net-box" x="216" y="245" width="92" height="22" rx="11" fill="var(--card)" stroke="var(--ref)"/>
      <text data-t="net" x="262" y="260" text-anchor="middle" font-size="11.5" font-weight="650" fill="var(--muted)">Net</text>
    </g>
    <g class="node" data-sheet="gas" tabindex="0" role="button" aria-label="Gas vandaag">
      <text x="14" y="22" font-size="11.5" fill="var(--muted)">Gas vandaag</text>
      <text data-t="gas" x="14" y="41" class="big" font-size="15" fill="var(--gas)">—</text>
    </g>
    <g class="node" data-sheet="buiten" tabindex="0" role="button" aria-label="Buitentemperatuur">
      <text data-t="buiten-l" x="326" y="22" font-size="11.5" fill="var(--muted)" text-anchor="end">Buiten</text>
      <text data-t="buiten" x="326" y="41" class="big" font-size="15" fill="var(--fg)" text-anchor="end">—</text>
    </g>
  </svg>`;
}

function setLine(svg, name, watts, reverse, color) {
  const line = $(`[data-line="${name}"]`, svg);
  const on = isNum(watts) && Math.abs(watts) >= 10;
  line.classList.toggle("off", !on);
  line.classList.toggle("rev", !!reverse);
  if (color) line.setAttribute("stroke", color);
  line.style.strokeWidth = on ? `${2 + Math.min(4, Math.abs(watts) / 700)}px` : "2px";
  $(`[data-t="${name}-line"]`, svg).textContent = on ? plain(power(Math.abs(watts))) : "";
}

function renderFlow(svg, d, today) {
  const t = (k, v) => { const el = $(`[data-t="${k}"]`, svg); if (el) el.textContent = v; };
  const has = d && d.flow_time;
  // Zon: kW without unit in the circle, unit underneath
  if (has && isNum(d.solar_w)) {
    const a = Math.abs(d.solar_w);
    t("zon", a < 1000 ? fmt[0].format(d.solar_w) : fmt[2].format(d.solar_w / 1000));
    t("zon-u", a < 1000 ? "W zon" : "kW zon");
  } else { t("zon", "—"); t("zon-u", "zon"); }
  if (has && isNum(d.house_w)) {
    const a = Math.abs(d.house_w);
    t("huis", a < 1000 ? fmt[0].format(d.house_w) : fmt[2].format(d.house_w / 1000));
    t("huis-u", a < 1000 ? "W huis" : "kW huis");
  } else { t("huis", "—"); t("huis-u", "huis"); }
  t("soc", d && isNum(d.soc) ? `${fmt[0].format(d.soc)}%` : "—");
  const cw = d ? d.battery_cells_w : null;
  t("bat-state", !d || !isNum(cw) ? "" : cw > 10 ? "ontlaadt" : cw < -10 ? "laadt" : "rust");
  t("bat-label", !d || !isNum(cw) || Math.abs(cw) <= 10 ? "Batterij" : `Batterij · ${plain(power(Math.abs(cw)))}`);

  setLine(svg, "zon", has ? d.solar_w : null, false);
  if (has && d.battery_ac_w >= 10) setLine(svg, "bat", d.battery_ac_w, false);
  else if (has && d.socket_in_w >= 10) setLine(svg, "bat", d.socket_in_w, true);
  else setLine(svg, "bat", null);

  const g = has ? d.grid_w : null;
  const box = $('[data-t="net-box"]', svg), label = $('[data-t="net"]', svg);
  if (isNum(g) && g >= 10) {
    setLine(svg, "net", g, false, "var(--uit)");
    box.setAttribute("stroke", "var(--uit)"); label.setAttribute("fill", "var(--uit)"); label.textContent = "Net · afname";
  } else if (isNum(g) && g <= -10) {
    setLine(svg, "net", g, true, "var(--terug)");
    box.setAttribute("stroke", "var(--terug)"); label.setAttribute("fill", "var(--fg)"); label.textContent = "Net · terug";
  } else {
    setLine(svg, "net", null);
    box.setAttribute("stroke", "var(--ref)"); label.setAttribute("fill", "var(--muted)"); label.textContent = isNum(g) ? "Net · 0 W" : "Net · —";
  }
  t("gas", today && isNum(today.gas_m3) ? `${fmt[2].format(today.gas_m3)} m³` : "—");
  const oc = d ? d.outdoor_c : null;
  t("buiten", isNum(oc) ? `${fmt[1].format(oc)} °C` : "—");
  t("buiten-l", d && d.outdoor_time ? `Buiten ${hm(d.outdoor_time)}` : "Buiten");
}

// ---------- rendering ----------
const setV = (key, html) => $$(`[data-v="${key}"]`).forEach((el) => { el.innerHTML = html; });
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
  $$("[data-flow] svg").forEach((svg) => renderFlow(svg, d, today));

  const plugs = $("#plugs");
  const list = d?.plugs || [];
  plugs.innerHTML = list.map((p) => `<button type="button" data-sheet="plugs">${esc(plugLabel(p.name))} ${plain(power(p.w))}</button>`).join("");

  // battery card
  const soc = d?.soc;
  $("[data-bar]").style.width = isNum(soc) ? `${Math.max(0, Math.min(100, soc))}%` : "0";
  const lim = $("[data-lim]");
  if (isNum(soc) && isNum(d?.discharge_limit_soc)) { lim.style.display = "block"; lim.style.left = `${d.discharge_limit_soc}%`; } else lim.style.display = "none";
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
  setV("opgewekt", kwh(t?.generated_kwh));
  setV("verbruik", kwh(t?.consumption_kwh));
  setV("zelfvoorzienend", pct(t?.self_sufficiency));
  setV("net", t && isNum(t.import_kwh) ? `${num(t.import_kwh)}<small>· ${num(t.export_kwh)} kWh</small>` : "—");
  setV("rekening", eur(t?.net_eur));
  setV("rekening-sub", t && isNum(t.net_eur) ? `stroom ${num((t.import_eur ?? 0) - (t.export_eur ?? 0), 2)} · gas ${num(t.gas_eur, 2)} · vast ${num(t.fixed_eur, 2)}` : "geen gegevens vandaag");
  setV("bespaard", s && isNum(s.savings_eur) ? `≈ ${eur(s.savings_eur)}` : "—");
  setV("geladen", t && isNum(t.battery_charged_kwh) ? `${num(t.battery_charged_kwh)}<small>· ${num(t.battery_discharged_kwh)} kWh</small>` : "—");
  $$("[data-flow] svg").forEach((svg) => renderFlow(svg, state.live?.data, t));
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
    return { title: `Zon · ${plain(power(d?.solar_w))}`, body: rows([
      ["Wat", "Wat de zonnepanelen nu leveren. Ze hangen direct aan de thuisbatterij, dus deze stroom gaat altijd eerst de batterij in; de batterij levert daarna aan het huis."],
      ["Periode", LIVE_PERIOD()],
      ["Bron", "thuisbatterij (PV-vermogen)"],
    ]) + link("day", "Zon vandaag in Grafana") };
  },
  batterij() {
    const d = state.live?.data;
    return { title: `Batterij · ${isNum(d?.soc) ? fmt[0].format(d.soc) + "%" : "—"}`, body: rows([
      ["Wat", "Laadniveau en wat de cellen nu doen: laden (uit zon of het stopcontact) of ontladen. De lijn naar het huis is wat de batterij aan het huis levert (AC-uitgang)."],
      ["Nu", d ? `cellen ${plain(power(d.battery_cells_w))} (boven nul ontladen) · naar het huis ${plain(power(d.battery_ac_w))}${d.socket_in_w >= 10 ? ` · uit het stopcontact ${plain(power(d.socket_in_w))}` : ""}` : "—"],
      ["Waarom verschil", "Tussen cellen en huis gaat stroom verloren bij het omzetten, en de batterij gebruikt zelf wat (stand-byverbruik)."],
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
      ["Wat", "Stroom van of naar het net. Rood: je neemt af. Steenkleur: je levert terug."],
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
      ["Periode", d?.outdoor_time ? `meting van ${hm(d.outdoor_time)}; er komt één per uur` : "geen meting in de laatste 3 uur, daarom “—”"],
      ["Bron", "Buienradar, via DSMR-reader (die haalt hem elk uur op)"],
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
      ["Periode", TODAY_PERIOD + ", berekend uit metingen om de paar seconden"],
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
  status() {
    const list = sources().map((s) => [s.name, `<span class="dot" style="background:var(${s.ok ? "--ok" : "--warn"})"></span>${esc(s.text)}`]);
    const w = warnings();
    return { title: "Status", body: rows(list) + (w.length ? `<p><b>Let op</b></p><ul>${w.map((x) => `<li>${esc(x.text)}</li>`).join("")}</ul>` : "<p>Alle bronnen melden zich op tijd.</p>") + link("tech", "Techniek in Grafana") };
  },
  meer() {
    const L = state.config.links;
    const items = [
      L.plugs && `<li><a href="${esc(L.plugs)}" target="_blank" rel="noopener">Stekkers</a> (Grafana)</li>`,
      L.tech && `<li><a href="${esc(L.tech)}" target="_blank" rel="noopener">Techniek</a> (Grafana)</li>`,
      '<li><a href="#" data-sheet="status">Status van de bronnen</a></li>',
      '<li><a href="?kiosk">Wandweergave</a></li>',
    ].filter(Boolean).join("");
    return { title: "Meer", body: `<ul>${items}</ul><p style="color:var(--muted)">Pilot: alleen Thuis is al in de app. Historie, Geld en Batterij openen voorlopig Grafana.</p>` };
  },
};

function openSheet(key) {
  const make = SHEETS[key];
  if (!make) return;
  const { title, body } = make();
  $("#sheet-title").textContent = title;
  $("#sheet-body").innerHTML = body;
  const dlg = $("#sheet");
  dlg.dataset.key = key;
  if (!dlg.open) dlg.showModal();
}
function refreshSheet() {
  const dlg = $("#sheet");
  if (dlg.open && dlg.dataset.key) openSheet(dlg.dataset.key);
}

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-sheet]");
  if (!el) return;
  e.preventDefault();
  openSheet(el.dataset.sheet);
});
document.addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && e.target.matches?.("g[data-sheet]")) { e.preventDefault(); openSheet(e.target.dataset.sheet); }
});
$("#sheet").addEventListener("click", (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });

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
    if (key === "thuis") return `<a class="tab on" href="./" aria-current="page">${svg}<span>${label}</span></a>`;
    if (key === "meer") return `<button type="button" class="tab" data-sheet="meer">${svg}<span>${label}</span></button>`;
    if (!href) return "";
    return `<a class="tab" href="${esc(href)}" target="_blank" rel="noopener" title="${label} in Grafana">${svg}<span>${label} <span class="ext">↗</span></span></a>`;
  };
  const html = tab("thuis", "Thuis") + tab("historie", "Historie", L.period) + tab("geld", "Geld", L.money) + tab("batterij", "Batterij", L.battery) + tab("meer", "Meer");
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

let source = null, failures = 0;
function connect() {
  source = new EventSource("/api/stream");
  source.addEventListener("live", (e) => {
    state.live = JSON.parse(e.data); state.liveAt = Date.now(); state.cached = false; failures = 0; state.auth = "ok";
    renderLive(); refreshSheet(); save();
  });
  source.addEventListener("today", (e) => {
    state.today = JSON.parse(e.data); renderToday(); renderLive(); refreshSheet(); save();
  });
  source.onerror = async () => {
    failures += 1;
    if (failures < 2) return; // EventSource retries on its own
    state.auth = await checkAuth();
    if (state.auth === "login") {
      source.close();
      if (wallMode) setTimeout(() => location.reload(), 30000);
    }
    renderStatus(); renderFreshness(); renderWallFoot();
  };
}

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
  if (wallMode) startWall();
  if (state.live) { renderToday(); renderLive(); }
  connect();
  setInterval(() => { renderFreshness(); }, 1000);
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
}
start();
