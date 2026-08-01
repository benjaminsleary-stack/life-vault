// Life-Vault service worker.
// Purpose: (1) make the app installable — Chrome wants a registered SW; a fetch
// handler is required on older versions and harmless on new ones. (2) serve the
// app shell offline. It deliberately NEVER caches API responses — live task data
// masquerading as current from a stale cache is worse than a network error.
// (3) receive push notifications — the vault's only delivery channel.

const SHELL = "lv-shell-v6";
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

// --- push -------------------------------------------------------------------
// The Worker encrypts the payload (RFC 8291), so what arrives here is already
// plaintext to us and unreadable to Google's push service in between. That is
// what makes it acceptable to send the evening brief's Charlotte section.
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: "Life-Vault", body: (e.data && e.data.text()) || "" }; }
  const title = d.title || "Life-Vault";
  // Android collapses same-tag notifications, which is what we want for a
  // re-sent brief but not across different briefs — so tag by title.
  e.waitUntil(self.registration.showNotification(title, {
    body: (d.body || "").slice(0, 1200),
    icon: "./icon-192.png",
    badge: "./icon-192.png",
    tag: "lv-" + title.toLowerCase().replace(/\W+/g, "-"),
    renotify: true,
    timestamp: d.at || Date.now(),
    data: { url: "./" },
  }));
});

// Tapping the notification focuses the app if it is already open rather than
// stacking another copy of it.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) {
      if ("focus" in c) { await c.focus(); return; }
    }
    if (self.clients.openWindow) await self.clients.openWindow("./");
  })());
});

// A push service can rotate a subscription without warning. When it does, the
// old endpoint stops working — so re-register immediately rather than
// discovering it the next silent morning.
self.addEventListener("pushsubscriptionchange", (e) => {
  e.waitUntil((async () => {
    const clientsList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of clientsList) c.postMessage({ type: "resubscribe" });
  })());
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
