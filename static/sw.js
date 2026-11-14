// Service worker: keeps the app shell available offline. Live data is never cached here: the page
// itself keeps the last values (marked "verouderd") when the server can't be reached.
const SHELL = "energie-shell-v1";
const FILES = ["/", "/static/app.css", "/static/app.js", "/manifest.webmanifest", "/static/icons/icon.svg", "/static/icons/icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  // Network first, so a new version shows at once; the cached shell only when offline.
  e.respondWith(
    fetch(e.request).then((r) => {
      if (r.ok && r.type === "basic") { const copy = r.clone(); caches.open(SHELL).then((c) => c.put(e.request, copy)); }
      return r;
    }).catch(() => caches.match(e.request).then((m) => m || caches.match("/")))
  );
});
