// Energy app front end: no build step, no framework. One EventSource feeds every number.
// Rules shown on screen: only measured values in tiles (calculated and forecast numbers say so with a
// chip and "≈"), every value says whether it is live or "vandaag 00:00 – nu", and an empty value is "—"
// with a reason.
// This module (screen switch, tabs, the data stream, wall view, start) is the one the page loads; the
// rest is split by part: util.js (helpers, state), home.js (Thuis), sheets.js (the pop-ups), history.js,
// screens.js (Geld, Contracten, Meer, Batterij), detail.js (day charts), touch.js (chart values, swipe).

import { $, $$, esc, setTZ, state, TZ, wallMode } from "./util.js";
import { flowSvg, renderFreshness, renderLive, renderStatus, renderToday, renderWallFoot } from "./home.js";
import { refreshSheet } from "./sheets.js";
import { fetchHistory, renderHistory, todayIso } from "./history.js";
import { fetchBattery, fetchContracts, fetchMeer, fetchMoney, renderBattery, renderGlossary, renderMoney } from "./screens.js";

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
  startScreenData(name);
  window.scrollTo(0, 0);
}
// Each screen fetches its own data on a timer, only while it is shown (and the page is visible).
let batteryTimer = null, histTimer = null, moneyTimer = null, meerTimer = null;
function stopScreenData() {
  clearInterval(batteryTimer); batteryTimer = null;
  clearInterval(histTimer); histTimer = null;
  clearInterval(moneyTimer); moneyTimer = null;
  clearInterval(meerTimer); meerTimer = null;
}
function startScreenData(name) {
  stopScreenData();
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
    histTimer = setInterval(() => { if (state.hist.data?.running || (state.hist.onToday && state.hist.anchor !== todayIso())) fetchHistory(); }, 60000);
  }
  if (name === "batterij" && !wallMode) {
    fetchBattery();
    batteryTimer = setInterval(fetchBattery, Math.max(30, state.config.batteryInterval || 60) * 1000);
  }
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
let source = null, failures = 0, retryTimer = null, streamOpened = false;
function connect() {
  clearTimeout(retryTimer); retryTimer = null;
  if (source) source.close();
  const es = new EventSource("/api/stream");
  source = es;
  // every reconnect after the first may be to a new version (a deploy restarts the server)
  es.addEventListener("open", () => { if (streamOpened) checkBuild(); streamOpened = true; });
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
// After a deploy the server's build id changes (BUILD in app.py). The wall view reloads at once; a
// phone or browser not while someone is using it: when it is hidden, or the moment it comes back into
// view (an installed app kept in memory runs the old page otherwise).
let reloadPending = false;
async function checkBuild(atOnce = false) { // atOnce: the page just came into view
  try {
    const r = await fetch("/api/config", { cache: "no-store", credentials: "same-origin" });
    const b = r.ok ? (await r.json()).build : null;
    if (!b || !state.config.build || b === state.config.build) return;
  } catch { return; }
  if (atOnce || wallMode || document.visibilityState === "hidden") location.reload();
  else reloadPending = true;
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") { if (reloadPending) location.reload(); }
  else checkBuild(true);
});

// A page nobody sees (another tab, a locked phone, the app in the background) needs no live data:
// after a minute hidden the stream closes and the screen's timers stop, so the server stops reading
// the database (it reads only while a screen is connected) and nothing crosses the network. Back in
// view it reconnects and refreshes at once; a phone that comes back also skips the retry delay.
// The wall view stays live.
const HIDDEN_PAUSE_MS = 60000;
let hiddenTimer = null, paused = false;
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    if (wallMode) return;
    clearTimeout(hiddenTimer);
    hiddenTimer = setTimeout(() => {
      paused = true;
      clearTimeout(retryTimer); retryTimer = null;
      if (source) source.close();
      stopScreenData();
    }, HIDDEN_PAUSE_MS);
    return;
  }
  clearTimeout(hiddenTimer); hiddenTimer = null;
  if (state.auth === "login") return;
  if (paused) { paused = false; connect(); startScreenData(currentScreen()); }
  else if (source && source.readyState === EventSource.CLOSED) connect();
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
  if (state.config.timeZone) setTZ(state.config.timeZone);
  renderTabs();
  showScreen();
  if (wallMode) startWall();
  if (state.live) { renderToday(); renderLive(); }
  connect();
  let shownDay = todayIso();
  setInterval(() => {
    renderFreshness();
    // a new day: yesterday's figures go blank even when no new data arrives (offline, wall view)
    if (todayIso() !== shownDay) { shownDay = todayIso(); renderToday(); renderLive(); }
  }, 1000);
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  // Warm the server's cache for Geld (app_money ~0.2 s, cached 5 min) a few seconds after opening, so
  // the tab answers at once. Not on the wall screen, which never shows Geld; not when Geld is already open.
  if (!wallMode) setTimeout(() => {
    if (currentScreen() === "geld") return;
    for (const url of ["/api/money", `/api/history?${new URLSearchParams({ unit: "year", date: todayIso() })}`])
      fetch(url, { cache: "no-store", credentials: "same-origin" }).catch(() => {});
  }, 3000);
}
start();
