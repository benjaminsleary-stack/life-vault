// Life-Vault service worker.
// Purpose: (1) make the app installable — Chrome wants a registered SW; a fetch
// handler is required on older versions and harmless on new ones. (2) serve the
// app shell offline. It deliberately NEVER caches API responses — live task data
// masquerading as current from a stale cache is worse than a network error.
// (3) Web Push display + click-through.

const SHELL = "lv-shell-v2";
const SHELL_FILES = ["./", "./index.html", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Only handle same-origin GET for the shell; never touch the API or Open-Meteo.
  if (e.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  // Network-first so a redeploy is picked up immediately when online; cache is the offline fallback only.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(SHELL).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("./index.html")))
  );
});

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || "Life-Vault", {
    body: d.body || "",
    tag: d.tag || "life-vault",
    icon: "./icon-192.png",
    badge: "./icon-192.png",
    data: { url: d.url || "/" },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((ws) => {
    for (const w of ws) if ("focus" in w) return w.focus();
    return self.clients.openWindow((e.notification.data && e.notification.data.url) || "/");
  }));
});
