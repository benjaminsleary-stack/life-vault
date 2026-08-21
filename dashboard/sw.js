// Life-Vault service worker.
// Purpose: (1) make the app installable — Chrome wants a registered SW; a fetch
// handler is required on older versions and harmless on new ones. (2) serve the
// app shell offline. It deliberately NEVER caches API responses — live task data
// masquerading as current from a stale cache is worse than a network error.
// (3) receive push notifications — the vault's only delivery channel.

const SHELL = "lv-shell-20260821153836";
const SHELL_FILES = [
  "./", "./index.html", "./manifest.webmanifest",
  "./icon-192.png", "./icon-512.png", "./icon-maskable-512.png", "./badge-96.png",
];

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

// --- credentials for background writes ---------------------------------------
// Replying from a notification means POSTing without a page open, and the API
// base and unlock token live in localStorage, which a service worker cannot
// read. The page hands them over via postMessage on load and we keep them in
// the Cache API — the only key-value store available here without pulling in
// IndexedDB boilerplate. Same origin, same protection as localStorage.
const CREDS = "lv-creds-v1";
const CRED_KEY = "https://life-vault.internal/creds";

async function saveCreds(creds) {
  const c = await caches.open(CREDS);
  await c.put(CRED_KEY, new Response(JSON.stringify(creds), { headers: { "Content-Type": "application/json" } }));
}
async function loadCreds() {
  try {
    const c = await caches.open(CREDS);
    const r = await c.match(CRED_KEY);
    return r ? await r.json() : null;
  } catch { return null; }
}

self.addEventListener("message", (e) => {
  const d = e.data || {};
  if (d.type === "creds") e.waitUntil(saveCreds({ api: d.api || "", token: d.token || "" }));
  if (d.type === "signout") e.waitUntil(caches.delete(CREDS));
});

// --- push -------------------------------------------------------------------
// The Worker encrypts the payload (RFC 8291), so what arrives here is already
// plaintext to us and unreadable to Google's push service in between. That is
// what makes it acceptable to send the evening brief's Charlotte section.
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: "Life-Vault", body: (e.data && e.data.text()) || "" }; }
  const title = d.title || "Life-Vault";
  // An inline reply box on the notification itself. This is the whole point:
  // answering the evening brief's one question used to cost unlock -> open app
  // -> maybe re-enter the token -> type -> send, and the vault was getting nine
  // captures a fortnight. From here it costs one tap and a sentence, without
  // the app ever opening. `type: "text"` is Chrome-on-Android; browsers that
  // don't support actions ignore the field and the notification still works.
  e.waitUntil(self.registration.showNotification(title, {
    body: (d.body || "").slice(0, 1200),
    icon: "./icon-192.png",
    // A badge is NOT a small icon. Android throws its colour away and uses only
    // the alpha channel as a stencil, so pointing this at the full-bleed app
    // icon — which has no transparency to stencil — drew a featureless block in
    // the status bar. badge-96.png is a white keyhole on a transparent ground.
    badge: "./badge-96.png",
    tag: "lv-" + title.toLowerCase().replace(/\W+/g, "-"),
    renotify: true,
    timestamp: d.at || Date.now(),
    actions: [
      { action: "reply", type: "text", title: "Reply", placeholder: d.placeholder || "Type to capture…" },
      { action: "open", title: "Open" },
    ],
    // The sender says where the notification leads; "./" is only the fallback.
    // Hard-coding it here meant tapping the morning brief opened the dashboard
    // home and left you to find the brief yourself.
    data: { url: d.url || "./", kind: d.kind || "" },
  }));
});

// Tapping the notification focuses the app if it is already open rather than
// stacking another copy of it. Typing into the reply box captures straight to
// the inbox — no window is opened at all.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();

  if (e.action === "reply") {
    const text = (e.reply || "").trim();
    if (!text) return;                       // dismissed the box without typing
    e.waitUntil(captureFromNotification(text, e.notification.data || {}));
    return;
  }

  e.waitUntil((async () => {
    const target = new URL((e.notification.data || {}).url || "./", self.location.href).href;
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) {
      if (!("focus" in c)) continue;
      await c.focus();
      // Focusing alone left an already-open app sitting on whatever it was last
      // showing, which is why tapping the brief did nothing visible. Three ways
      // to get it to the right place, cheapest first: tell a live page to handle
      // the intent itself (no reload, keeps scroll and state); navigate the
      // client if it won't answer; give up and let the loop fall through to
      // openWindow. navigate() throws for an uncontrolled client, so it cannot
      // be the only route.
      if (await handledByPage(c, target)) return;
      try { if ("navigate" in c) { await c.navigate(target); return; } } catch { /* fall through */ }
    }
    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});

// Ask an open page to handle the launch intent in-place, and wait briefly for it
// to say it did. A page from an older build won't reply, and the timeout is what
// lets us fall back rather than hang on it.
function handledByPage(client, url) {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    const done = (v) => {
      clearTimeout(t);
      // Close both ends: an unclosed channel is a leak, and one per tapped
      // notification adds up in a worker that is kept alive between pushes.
      try { ch.port1.close(); ch.port2.close(); } catch { /* already gone */ }
      resolve(v);
    };
    const t = setTimeout(() => done(false), 400);
    ch.port1.onmessage = (ev) => done(!!(ev.data && ev.data.handled));
    try { client.postMessage({ type: "intent", url }, [ch.port2]); }
    catch { done(false); }
  });
}

// A reply that fails must not vanish — that is golden rule 1, and the phone is
// exactly where signal is worst. On failure, re-notify so the text is still on
// screen and can be sent again rather than silently lost.
async function captureFromNotification(text, data) {
  const creds = await loadCreds();
  if (!creds || !creds.token) {
    return self.registration.showNotification("Couldn't save that", {
      body: "Open the app once to reconnect this device, then try again.\n\n" + text,
      icon: "./icon-192.png", badge: "./icon-192.png", tag: "lv-reply-failed", renotify: true,
    });
  }
  // Answering the evening question is a capture like any other: file-inbox
  // routes it and crosses the gap off. Tagging the source means the brief it
  // answered is recoverable later.
  const body = data.kind ? `${text}\n\n_(replied to ${data.kind})_` : text;
  try {
    const r = await fetch(creds.api + "/api/capture", {
      method: "POST",
      headers: { "Authorization": "Bearer " + creds.token, "Content-Type": "application/json" },
      body: JSON.stringify({ text: body }),
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    await self.registration.showNotification("Captured", {
      body: text.slice(0, 200), icon: "./icon-192.png", badge: "./icon-192.png",
      tag: "lv-reply-ok", renotify: true, silent: true,
    });
  } catch {
    await self.registration.showNotification("Couldn't save that — tap to retry", {
      body: text, icon: "./icon-192.png", badge: "./icon-192.png",
      tag: "lv-reply-failed", renotify: true,
      actions: [{ action: "reply", type: "text", title: "Send again", placeholder: text }],
      data: { url: "./", kind: data.kind || "" },
    });
  }
}

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
