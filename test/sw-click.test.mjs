/**
 * Tapping a notification has to land on the thing the notification was about.
 *
 *   node --test 'test/*.test.mjs'
 *
 * The morning brief arrived, was tapped, and opened the dashboard home — you
 * then had to go and find the brief yourself. Three separate links in the chain
 * were broken and each looked fine in isolation: notify.sh never sent a
 * destination, the Worker rebuilt the payload as {title, body} and dropped
 * anything else, and the click handler focused an open window without ever
 * telling it where to go.
 *
 * This covers the last of those by running the real dashboard/sw.js in a vm with
 * stubbed service-worker globals, because the failure was behavioural — the code
 * read perfectly well while doing nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

const SW = new URL("../dashboard/sw.js", import.meta.url);
const ORIGIN = "https://vault.example/";

// A service worker global with just enough surface for the click path.
function loadSW({ clients = [], openWindow = null, pageAnswers = false } = {}) {
  const calls = { focused: [], navigated: [], opened: [], posted: [] };

  const windowClients = clients.map((c, i) => ({
    id: String(i),
    url: c.url ?? ORIGIN,
    focus: async () => { calls.focused.push(i); },
    navigate: c.canNavigate === false
      ? async () => { throw new Error("client is not controlled"); }
      : async (u) => { calls.navigated.push(u); },
    postMessage: (msg, transfer) => {
      calls.posted.push(msg);
      // The page replies down the transferred port when it handles the intent
      // itself. A page from an older build simply never answers.
      if (pageAnswers && transfer && transfer[0]) {
        setTimeout(() => transfer[0].postMessage({ handled: true }), 0);
      }
    },
  }));

  const listeners = {};
  const self = {
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    location: { origin: ORIGIN, href: ORIGIN },
    registration: { showNotification: async () => {} },
    clients: {
      matchAll: async () => windowClients,
      claim: async () => {},
      openWindow: openWindow === null
        ? async (u) => { calls.opened.push(u); }
        : openWindow,
    },
    skipWaiting: () => {},
  };

  // A hand-rolled MessageChannel rather than node's: a real MessagePort keeps
  // the event loop alive, so the suite passed and then hung forever instead of
  // exiting. This is also closer to the browser's, where an unreferenced channel
  // simply goes away.
  class FakeChannel {
    constructor() {
      const mk = (peer) => ({
        onmessage: null,
        closed: false,
        postMessage(m) { if (!this.closed && !peer().closed) queueMicrotask(() => peer().onmessage?.({ data: m })); },
        close() { this.closed = true; },
      });
      this.port1 = mk(() => this.port2);
      this.port2 = mk(() => this.port1);
    }
  }

  const ctx = createContext({
    self, console, URL, MessageChannel: FakeChannel, setTimeout, clearTimeout, Promise, queueMicrotask,
    caches: { open: async () => ({ match: async () => null, put: async () => {}, addAll: async () => {} }), keys: async () => [], delete: async () => {} },
    fetch: async () => ({ ok: true, status: 200 }),
  });
  runInContext(readFileSync(SW, "utf8"), ctx);

  return { listeners, calls };
}

function clickEvent(data, action = "") {
  let settle;
  const done = new Promise((r) => { settle = r; });
  return {
    event: {
      action,
      notification: { data, close: () => {} },
      waitUntil: (p) => Promise.resolve(p).then(settle, settle),
    },
    done,
  };
}

async function tap(sw, data, action) {
  const { event, done } = clickEvent(data, action);
  sw.listeners.notificationclick.forEach((fn) => fn(event));
  await done;
}

test("a live page is told where to go, and is not reloaded", async () => {
  const sw = loadSW({ clients: [{}], pageAnswers: true });
  await tap(sw, { url: "./?view=brief" });

  assert.deepEqual(sw.calls.focused, [0], "the window should be brought forward");
  assert.equal(sw.calls.posted.length, 1);
  assert.equal(sw.calls.posted[0].type, "intent");
  assert.equal(sw.calls.posted[0].url, ORIGIN + "?view=brief", "resolved against the SW scope");
  assert.deepEqual(sw.calls.navigated, [], "answering in-place must not also reload the page");
  assert.deepEqual(sw.calls.opened, [], "an open window must not be duplicated");
});

test("a page that does not answer is navigated instead", async () => {
  const sw = loadSW({ clients: [{}], pageAnswers: false });
  await tap(sw, { url: "./?view=brief" });

  assert.deepEqual(sw.calls.focused, [0]);
  assert.deepEqual(sw.calls.navigated, [ORIGIN + "?view=brief"],
    "an older build of the page must still end up on the brief");
  assert.deepEqual(sw.calls.opened, []);
});

test("navigate() throwing falls through to opening a window", async () => {
  const sw = loadSW({ clients: [{ canNavigate: false }], pageAnswers: false });
  await tap(sw, { url: "./?view=brief" });

  assert.deepEqual(sw.calls.navigated, [], "navigate threw, so nothing was navigated");
  assert.deepEqual(sw.calls.opened, [ORIGIN + "?view=brief"],
    "an uncontrolled client must not swallow the tap");
});

test("with no window open, one is opened at the destination", async () => {
  const sw = loadSW({ clients: [] });
  await tap(sw, { url: "./?view=brief" });
  assert.deepEqual(sw.calls.opened, [ORIGIN + "?view=brief"]);
});

// The regression itself: this is exactly what the old handler did for every
// notification, whatever it was about.
test("a notification carrying no url still opens the app root", async () => {
  const sw = loadSW({ clients: [] });
  await tap(sw, {});
  assert.deepEqual(sw.calls.opened, [ORIGIN], "the fallback must still work");
});

test("replying inline does not open or navigate anything", async () => {
  const sw = loadSW({ clients: [{}], pageAnswers: true });
  const { event, done } = clickEvent({ url: "./?view=brief" }, "reply");
  event.reply = "";                        // dismissed without typing
  sw.listeners.notificationclick.forEach((fn) => fn(event));
  await Promise.race([done, new Promise((r) => setTimeout(r, 50))]);

  assert.deepEqual(sw.calls.opened, []);
  assert.deepEqual(sw.calls.navigated, []);
  assert.deepEqual(sw.calls.focused, []);
});

// --- the deep link is a contract across four files ---------------------------
// notify.sh sends it, worker.js has to let it through, index.html has to answer
// to it, and the manifest shortcut uses the same one. Each of those was written
// at a different time, and the tap silently did nothing when they disagreed.
// A string constant would be nice; four different languages is what we have.
test("notify.sh, the manifest and the app all agree on ?view=brief", () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

  assert.match(read("../scripts/notify.sh"), /deep_url="\.\/\?view=brief&file=\$src"/,
    "notify.sh must send the intent the app answers to");
  assert.match(read("../dashboard/index.html"), /q\.get\("view"\)==="brief"/,
    "the app must still handle view=brief");
  assert.match(read("../dashboard/manifest.webmanifest"), /"\.\/\?view=brief"/,
    "the home-screen shortcut must use the same intent");
});

test("the notification names the digest, and the app opens the one it names", () => {
  // `?view=brief` alone means "the latest brief", which is not the same thing as
  // the brief the notification is about: tap last night's evening push after the
  // morning run and you get the wrong file. It also made the app race its own
  // first data load and lose, which is what "opens to a no-brief window" was.
  const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
  const app = read("../dashboard/index.html");

  assert.match(read("../scripts/notify.sh"), /file=\$src/,
    "the push must name the digest it is about");
  assert.match(app, /const file=q\.get\("file"\);/,
    "the app must read the named file out of the launch intent");
  assert.match(app, /\^digests\\\/\[\\w\.-\]\+\\\.md\$/,
    "and must only open digests through it");
  assert.ok(!/setTimeout\(openBrief/.test(app),
    "the brief panel must wait on the data, not on a timer it can lose");
});

test("the brief panel carries a reply box", () => {
  // Six specific questions were asked over six days and none were answered.
  // The reply box existed — on the file viewer — but reading the brief went
  // through openPanel, which hid it. A question with nowhere to answer it is
  // not a question.
  const app = readFileSync(new URL("../dashboard/index.html", import.meta.url), "utf8");
  assert.match(app, /openPanel\(BRIEF_PANEL,[^)]*\{ reply:true \}\)/s,
    "openBrief must ask for the reply box");
  assert.match(app, /if\(opts && opts\.reply\)\{[^}]*modalReply"\)\.classList\.remove\("hidden"\)/s,
    "openPanel must honour it");
});

test("notify.sh only deep-links things the app can actually show", () => {
  // digests/ is the only path with a viewer behind it. Sending ?view=brief for
  // anything else would open an empty panel.
  const sh = readFileSync(new URL("../scripts/notify.sh", import.meta.url), "utf8");
  assert.match(sh, /case "\$src" in\s*\n\s*digests\/\*\.md\)/,
    "the deep link must be scoped to digests");
});
