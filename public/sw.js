// Minimal service worker: exists so Chromium offers the PWA install prompt.
// Deliberately no caching — Cody is a live self-hosted app (SSE streams,
// terminals); a stale cache is strictly worse than a network error. The
// fetch listener is a no-op, which modern Chromium detects and bypasses.
self.addEventListener("install", () => {
  self.skipWaiting();
});
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener("fetch", () => {});
