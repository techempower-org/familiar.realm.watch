// Minimal service worker for offline PWA shell.
// Caches only the static shell — API calls always hit the network.
// Bump CACHE name on shell file changes so old clients pick up new HTML/CSS/JS.
const CACHE = "familiar-shell-v17";
const SHELL = [
  "/", "/index.html", "/style.css", "/app.js", "/favicon.svg", "/manifest.webmanifest",
  "/highlight.min.js", "/highlight-dark.css", "/highlight-light.css",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith("/v1/") || url.pathname.startsWith("/api/")) {
    return; // default fetch
  }
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request))
  );
});
