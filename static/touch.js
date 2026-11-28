// Chart values by finger or mouse, and swiping a sheet down to close it.

import { $, $$ } from "./util.js";

// ---------- chart values by finger or mouse, swipe a sheet down to close it ----------
// Every chart carries its values as SVG <title>s, one per bar or slot. The browser's own tooltip for
// them is slow, sits at the cursor and doesn't exist on a phone, so the titles become data-tip
// attributes (tipItems) and the app shows them itself: the nearest slot's text in a label above the
// chart, with a guide line through the slot.
// - Finger: sliding sideways moves it. In a sheet a tap is enough; on a screen a tap still opens the
//   chart's sheet, so only a sideways slide shows values there. The label stays after the finger lifts,
//   until the next touch somewhere else.
// - Mouse: hovering is enough; the label follows the cursor and goes when it leaves the chart.
// Sheets are redrawn on every live update (refreshSheet) and screens on new data, so the label keeps
// its chart and slot by position and follows.
const SVGNS = "http://www.w3.org/2000/svg";
const tipBox = Object.assign(document.createElement("div"), { className: "tip", hidden: true });
const tipGuide = document.createElementNS(SVGNS, "line");
tipGuide.setAttribute("class", "tip-guide");
let tipAt = null;   // { box, sheetN, slotN, mouse }: the chart (a sheet's chart by its index, a screen's by element), the slot, and whether a mouse put it there
let scrub = null;   // the finger on a chart: { id, x0, y0, inSheet, on }
let eatClick = 0;   // a slide over a screen's chart must not also open its sheet
const tipObserver = new MutationObserver((recs) => { if (recs.some((r) => r.target !== tipBox)) requestAnimationFrame(showTip); });

// A chart's slots: elements with a data-tip. Fresh drawings still carry <title>s; they move into data-tip
// here, so the browser's own tooltip never shows on top of the app's label.
function tipItems(svg) {
  for (const t of $$("title", svg)) { t.parentNode.setAttribute("data-tip", t.textContent); t.remove(); }
  return $$("[data-tip]", svg);
}
function tipChart(at) {
  const box = at.sheetN >= 0 ? $$("#sheet-body .chart")[at.sheetN] : at.box;
  return box?.isConnected ? $("svg", box) : null;
}
// The slot under or nearest to x (horizontal distance first, vertical second: bar-only titles have gaps).
function slotAt(svg, x, y) {
  let best = -1, bestD = Infinity;
  tipItems(svg).forEach((n, i) => {
    const r = n.getBoundingClientRect();
    if (!r.width) return;
    const d = Math.max(r.left - x, x - r.right, 0) * 1000 + Math.max(r.top - y, y - r.bottom, 0);
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}
function showTip() {
  if (!tipAt) return;
  const svg = tipChart(tipAt), n = svg && tipItems(svg)[tipAt.slotN];
  if (!n) { hideTip(); return; }
  const vb = svg.viewBox.baseVal, bb = n.getBBox(), cx = (bb.x + bb.width / 2).toFixed(1);
  if (tipGuide.parentNode !== svg) svg.insertBefore(tipGuide, svg.firstChild); // behind the bars
  for (const [k, v] of [["x1", cx], ["x2", cx], ["y1", 4], ["y2", vb.height - 22]]) tipGuide.setAttribute(k, v);
  const dlg = $("#sheet"), inSheet = dlg.contains(svg), home = inSheet ? dlg : document.body; // the open sheet is in the top layer
  if (tipBox.parentNode !== home) home.append(tipBox);
  const text = n.getAttribute("data-tip");
  if (tipBox.textContent !== text) tipBox.textContent = text;
  tipBox.hidden = false;
  const sr = svg.getBoundingClientRect(), w = tipBox.offsetWidth, h = tipBox.offsetHeight;
  const px = sr.left + (cx / vb.width) * sr.width;
  const ceiling = inSheet ? dlg.getBoundingClientRect().top + 6 : 6;
  tipBox.style.left = `${Math.round(Math.min(Math.max(px - w / 2, 8), innerWidth - w - 8))}px`;
  tipBox.style.top = `${Math.round(sr.top - h - 6 >= ceiling ? sr.top - h - 6 : sr.top + 4)}px`;
}
export function hideTip() {
  tipAt = null;
  tipObserver.disconnect();
  tipBox.hidden = true;
  tipGuide.remove();
}
function tipTo(box, sheetN, e, mouse) {
  const svg = tipChart({ box, sheetN });
  if (!svg) return;
  const slotN = slotAt(svg, e.clientX, e.clientY);
  if (slotN < 0) return;
  if (tipAt && tipAt.box === box && tipAt.slotN === slotN && tipAt.mouse === mouse) return;
  if (!tipAt) tipObserver.observe(document.body, { childList: true, subtree: true });
  tipAt = { box, sheetN, slotN, mouse };
  showTip();
}
const scrubTo = (e) => tipTo(scrub.box, scrub.inSheet ? scrub.sheetN : -1, e, false);
// The mouse over a chart, or off it.
function hoverTo(e) {
  const svg = e.target.closest?.(".chart svg");
  if (!svg) { if (tipAt?.mouse) hideTip(); return; }
  const box = svg.closest(".chart"), inSheet = !!box.closest("#sheet");
  tipTo(box, inSheet ? $$("#sheet-body .chart").indexOf(box) : -1, e, true);
}
document.addEventListener("pointerdown", (e) => {
  scrub = null; eatClick = 0; // a new touch: a click still to come is this touch's own
  if (e.pointerType === "mouse") return;
  const svg = e.target.closest?.(".chart svg");
  if (!svg) { hideTip(); return; }
  const box = svg.closest(".chart"), inSheet = !!box.closest("#sheet");
  if (e.target.hasPointerCapture?.(e.pointerId)) e.target.releasePointerCapture(e.pointerId); // the slot under the finger may be redrawn
  scrub = { id: e.pointerId, x0: e.clientX, y0: e.clientY, box, inSheet, sheetN: inSheet ? $$("#sheet-body .chart").indexOf(box) : -1, on: inSheet };
  if (inSheet) scrubTo(e);
  else if (tipAt && tipAt.box !== box) hideTip();
}, true);
document.addEventListener("pointermove", (e) => {
  if (e.pointerType === "mouse") { hoverTo(e); return; }
  if (!scrub || e.pointerId !== scrub.id) return;
  if (!scrub.on) {
    const dx = Math.abs(e.clientX - scrub.x0), dy = Math.abs(e.clientY - scrub.y0);
    if (dx < 8 || dx < dy) return;
    scrub.on = true;
  }
  scrubTo(e);
});
document.addEventListener("pointerup", (e) => {
  if (scrub?.on && !scrub.inSheet && e.pointerId === scrub.id) eatClick = e.timeStamp;
  scrub = null;
});
document.addEventListener("pointercancel", () => { if (scrub) hideTip(); scrub = null; }); // the page took over: a vertical scroll
document.addEventListener("pointerout", (e) => { // off the chart onto nothing that moves, or out of the window
  if (e.pointerType === "mouse" && tipAt?.mouse && !e.relatedTarget?.closest?.(".chart svg")) hideTip();
});
document.addEventListener("click", (e) => {
  if (eatClick && e.timeStamp - eatClick < 600) { e.stopPropagation(); e.preventDefault(); }
  eatClick = 0;
}, true);
document.addEventListener("scroll", () => { if (tipAt) showTip(); }, { capture: true, passive: true });
addEventListener("resize", () => { if (tipAt) showTip(); });

// The sheet follows a finger pulled down from its top and closes past ~a quarter of its height or on
// a quick flick; otherwise it springs back. Only while the sheet is scrolled to the top (otherwise a
// pull scrolls it up), and not from a chart (there a finger reads values). Touch events, not pointer
// events: the pull has to cancel the browser's own scrolling, decided on the first move.
{
  const dlg = $("#sheet");
  let drag = null;
  dlg.addEventListener("touchstart", (e) => {
    drag = null;
    if (e.touches.length !== 1 || dlg.scrollTop > 0 || e.target.closest(".chart svg")) return;
    const t = e.touches[0];
    drag = { x0: t.clientX, y0: t.clientY, dy: 0, on: null, lastY: t.clientY, lastT: e.timeStamp, v: 0 };
  }, { passive: true });
  dlg.addEventListener("touchmove", (e) => {
    if (!drag) return;
    const t = e.touches[0], dy = t.clientY - drag.y0;
    if (drag.on === null) {
      drag.on = dy > 0 && dy >= Math.abs(t.clientX - drag.x0) && dlg.scrollTop <= 0 && e.cancelable;
      if (!drag.on) { drag = null; return; }
      hideTip();
      dlg.classList.add("dragging");
    }
    e.preventDefault();
    if (e.timeStamp > drag.lastT) drag.v = (t.clientY - drag.lastY) / (e.timeStamp - drag.lastT);
    drag.lastY = t.clientY; drag.lastT = e.timeStamp; drag.dy = Math.max(0, dy);
    dlg.style.transform = `translateY(${drag.dy}px)`;
  }, { passive: false });
  const end = () => {
    if (!drag?.on) { drag = null; return; }
    const { dy, v } = drag;
    drag = null;
    dlg.classList.remove("dragging");
    if (dy > Math.min(140, dlg.offsetHeight * 0.25) || (v > 0.5 && dy > 24)) {
      dlg.style.transform = `translateY(${dlg.offsetHeight + 40}px)`;
      setTimeout(() => dlg.close(), 200);
    } else dlg.style.transform = "";
  };
  dlg.addEventListener("touchend", end);
  dlg.addEventListener("touchcancel", end);
  dlg.addEventListener("close", () => {
    dlg.classList.add("dragging"); // no slide-back animation on the way out
    dlg.style.transform = "";
    requestAnimationFrame(() => dlg.classList.remove("dragging"));
    if (tipAt?.sheetN >= 0) hideTip();
  });
}
