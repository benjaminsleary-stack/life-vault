/**
 * Life-Vault dashboard — Cloudflare Worker (the write-proxy / API).
 *
 * This file is now only two things: a GitHub-backed `store`, and the HTTP shell
 * (CORS and auth). Every rule about what a task or a habit or a person
 * note MEANS lives in vault.js, shared with the local dev server, so the two
 * can no longer drift apart.
 *
 * It is the ONLY holder of the GitHub token: the PWA never sees it. Every
 * request must carry the shared unlock token; anything without it is refused,
 * so the public Pages URL is not an open door to the vault.
 *
 * Bindings (set as Worker secrets / vars, never in code):
 *   GH_TOKEN       fine-grained PAT, scoped to the life-vault repo (contents RW)
 *   GH_OWNER       repo owner, e.g. "ben"
 *   GH_REPO        repo name, e.g. "life-vault"
 *   GH_BRANCH      branch to read/write (default "main")
 *   UNLOCK_TOKEN   shared secret the PWA must send (the app-unlock gate)
 *   ALLOW_ORIGIN   the Pages origin allowed by CORS (default "*")
 */

import { createApi, readPushSubs, addPushSub, removePushSubs } from "./vault.js";
import { sendToAll } from "./push.js";

const API = "https://api.github.com";

/* ------------------------------------------------------------------ helpers */

function cors(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOW_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization,Content-Type",
  };
}

function json(body, env, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors(env) },
  });
}

// Constant-ish time compare so the unlock token isn't trivially timing-guessable.
//
// Both sides are trimmed. The length check below is the first thing that runs,
// so a single trailing newline — pasted into `wrangler secret put`, the GitHub
// secrets box, or the app's unlock field — rejects the request with a 401
// identical to a completely wrong token. That cost twelve days of briefs that
// were written, committed and never delivered. No legitimate unlock token has
// leading or trailing whitespace, so trimming can only ever help.
// Where tapping a notification is allowed to land: a relative path inside the
// app, and nothing else. A notification is tapped without being read, so it must
// not be able to carry anyone off-origin. Rejected input returns "" and the
// service worker falls back to the app root — this never sanitises and forwards,
// because a half-cleaned URL is the one that gets through.
//
// Rejects: absolute URLs ("https://…", "javascript:…"), protocol-relative
// ("//evil.example"), backslash variants Windows and some parsers fold to "/"
// ("/\evil.example", "\\evil.example"), and bare paths with no leading slash.
export function safeDeepLink(raw) {
  const s = String(raw == null ? "" : raw);
  if (!s || s.length > 200) return "";
  if (s.includes("\\") || s.includes("\n") || s.includes("\r")) return "";
  if (!/^\.?\//.test(s)) return "";        // must be "/…" or "./…"
  if (/^\/\//.test(s) || /^\.\/\//.test(s)) return "";  // protocol-relative
  return s;
}

export function tokenOk(req, env) {
  const want = (env.UNLOCK_TOKEN || "").trim();
  const got = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!want || got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function b64decode(b64) {
  const bin = atob(b64.replace(/\n/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function gh(env, path, init = {}) {
  return fetch(`${API}/repos/${env.GH_OWNER}/${env.GH_REPO}${path}`, {
    ...init,
    // Cloudflare-native way to bypass caching the GitHub read (the `cache` fetch
    // option can throw "not implemented" in Workers, so we don't use it here).
    cf: { cacheTtl: 0, cacheEverything: false },
    headers: {
      Authorization: `Bearer ${env.GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "life-vault-dashboard",
      ...(init.headers || {}),
    },
  });
}

/* ------------------------------------------------------------- github store */

// Fetch many files/dirs in ONE GraphQL request. Each key is {kind,path}; a file
// resolves to a Blob (text+oid), a dir to a Tree (entries). This is what keeps
// /api/data under the Workers subrequest cap: ~40 Contents calls collapse into a
// couple of GraphQL calls. `entries` is a plain list (not a paginated
// connection), so it needs no pagination args and the query costs ~1 point.
async function graphqlBatch(env, branch, keys) {
  const fields = keys.map((k, i) =>
    `a${i}: object(expression: ${JSON.stringify(`${branch}:${k.path}`)}) {
       __typename
       ... on Blob { text isBinary oid }
       ... on Tree { entries { name type oid } }
     }`
  ).join("\n");
  const query = `query { repository(owner: ${JSON.stringify(env.GH_OWNER)}, name: ${JSON.stringify(env.GH_REPO)}) { ${fields} } }`;
  const r = await fetch(`${API}/graphql`, {
    method: "POST",
    cf: { cacheTtl: 0, cacheEverything: false },
    headers: {
      Authorization: `Bearer ${env.GH_TOKEN}`,
      "User-Agent": "life-vault-dashboard",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });
  if (!r.ok) throw new Error(`graphql ${r.status}`);
  const j = await r.json();
  if (j.errors) throw new Error(`graphql: ${JSON.stringify(j.errors).slice(0, 200)}`);
  const repo = j.data && j.data.repository;
  if (!repo) throw new Error("graphql: no repository");
  return keys.map((_, i) => repo[`a${i}`] || null);
}

function githubStore(env) {
  const branch = env.GH_BRANCH || "main";

  // Single-item REST calls: the GraphQL fallback path, and the writer's re-read.
  async function restRead(path) {
    const r = await gh(env, `/contents/${encodeURI(path)}?ref=${branch}`);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`read ${path}: ${r.status}`);
    const j = await r.json();
    return { text: j.content ? b64decode(j.content) : "", sha: j.sha };
  }
  async function restList(path) {
    const r = await gh(env, `/contents/${encodeURI(path)}?ref=${branch}`);
    if (r.status === 404) return [];
    if (!r.ok) throw new Error(`list ${path}: ${r.status}`);
    const j = await r.json();
    return Array.isArray(j) ? j.map((e) => ({ name: e.name, path: e.path, sha: e.sha })) : [];
  }

  // DataLoader-style batching: reads queued within a microtask tick go out as
  // ONE GraphQL query. The queue is per-request (a fresh store per fetch), so
  // there is no cross-request state. On any GraphQL failure the whole batch
  // falls back to per-item REST — the dashboard keeps working, just with more
  // subrequests, never an outage over an optimisation.
  let queue = [];
  let scheduled = false;
  const schedule = () => { if (!scheduled) { scheduled = true; queueMicrotask(flush); } };
  async function flush() {
    scheduled = false;
    const batch = queue;
    queue = [];
    if (!batch.length) return;
    let objs;
    try {
      objs = await graphqlBatch(env, branch, batch);
    } catch {
      await Promise.all(batch.map(async (b) => {
        try { b.resolve(b.kind === "file" ? await restRead(b.path) : await restList(b.path)); }
        catch (err) { b.reject(err); }
      }));
      return;
    }
    batch.forEach((b, i) => {
      const o = objs[i];
      if (b.kind === "file") {
        b.resolve(o && o.__typename === "Blob" ? { text: o.isBinary ? "" : (o.text || ""), sha: o.oid } : null);
      } else {
        b.resolve(o && o.__typename === "Tree"
          ? o.entries.map((e) => ({ name: e.name, path: `${b.path}/${e.name}`, sha: e.oid }))
          : []);
      }
    });
  }

  return {
    readFile: (path) => new Promise((resolve, reject) => { queue.push({ kind: "file", path, resolve, reject }); schedule(); }),
    listDir: (path) => new Promise((resolve, reject) => { queue.push({ kind: "dir", path, resolve, reject }); schedule(); }),
    // Create or update a file (a commit). Pass sha to update, omit to create. A
    // concurrent writer (bridge, scheduled skill, second device) makes the sha
    // stale → 409/422; re-read (REST, unbatched) and retry rather than 500.
    async putFile(path, text, message, sha) {
      for (let attempt = 0; ; attempt++) {
        const body = { message, content: b64encode(text), branch };
        if (sha) body.sha = sha;
        const r = await gh(env, `/contents/${encodeURI(path)}`, {
          method: "PUT",
          body: JSON.stringify(body),
        });
        if (r.ok) return r.json();
        if ((r.status === 409 || r.status === 422) && attempt < 3) {
          await new Promise((res) => setTimeout(res, 250 * (attempt + 1)));
          const cur = await restRead(path);
          sha = cur ? cur.sha : undefined;
          continue;
        }
        throw new Error(`put ${path}: ${r.status} ${await r.text()}`);
      }
    },
  };
}

/* ------------------------------------------------------------------ routing */

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") return new Response(null, { headers: cors(env) });
    if (!tokenOk(req, env)) return json({ error: "unauthorized" }, env, 401);

    const store = githubStore(env);

    // Push routes live here rather than in vault.js: they need the VAPID
    // secrets off `env`, and vault.js is deliberately host-agnostic so the dev
    // server can share it. Everything here is already behind the unlock token.
    if (url.pathname.startsWith("/api/push")) {
      try {
        return json(await handlePush(req, url, env, store), env);
      } catch (e) {
        return json({ ok: false, error: String((e && e.message) || e) }, env, 500);
      }
    }

    const handle = createApi(store, {
      // Subscribed calendars. A private .ics URL is a credential — anyone
      // holding it can read the calendar — so these are Worker secrets:
      //   npx wrangler secret put CAL_WORK
      //   npx wrangler secret put CAL_PERSONAL
      calendars: [
        env.CAL_WORK && { name: "work", url: env.CAL_WORK },
        env.CAL_PERSONAL && { name: "personal", url: env.CAL_PERSONAL },
        env.CAL_FAMILY && { name: "family", url: env.CAL_FAMILY },
      ].filter(Boolean),
    });

    try {
      const payload = req.method === "POST" ? await req.json().catch(() => ({})) : null;
      const { status, body } = await handle(req.method, url.pathname, url.searchParams, payload);
      return json(body, env, status);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, env, 500);
    }
  },

  /**
   * The clock for the scheduled routines.
   *
   * This used to be GitHub's own `schedule:` trigger, and GitHub was firing it
   * 2½–3¼ hours late every single day: a 04:45 UTC cron landed between 07:19
   * and 08:11 across five consecutive days, so a brief meant to be waiting at
   * 06:30 arrived mid-morning. GitHub documents "may be delayed"; this repo was
   * getting delayed by hours, every day, which makes the schedule useless for
   * anything you plan a morning around.
   *
   * Cloudflare cron triggers fire within about a minute, and — the part that
   * matters — a `workflow_dispatch` run starts immediately, where a `schedule`
   * run queues behind GitHub's shared scheduler. So the Worker keeps time and
   * GitHub only does the work.
   *
   * Needs `actions: write` on GH_TOKEN, in addition to the contents RW it
   * already has. If the dispatch fails, shout via push rather than letting the
   * morning pass silently (CLAUDE.md rule 5) — a schedule that quietly stopped
   * looks exactly like a quiet day.
   */
  async scheduled(event, env, ctx) {
    const skill = CRON_SKILL[event.cron];
    if (!skill) return;
    ctx.waitUntil((async () => {
      try {
        const r = await gh(env, "/actions/workflows/scheduled-skills.yml/dispatches", {
          method: "POST",
          body: JSON.stringify({ ref: env.GH_BRANCH || "main", inputs: { skill } }),
        });
        // 204 is the success code here; anything else means nothing was queued.
        if (!r.ok) throw new Error(`dispatch ${skill}: ${r.status} ${await r.text()}`);
      } catch (e) {
        await shout(env, `⚠️ ${skill} never started`, String((e && e.message) || e));
      }
    })());
  },
};

// Cron expression -> the skill it runs. Kept in step with [triggers] in
// wrangler.toml; a cron with no entry here is a no-op rather than a guess.
const CRON_SKILL = {
  "45 4 * * *": "morning-brief",     // 05:45 BST / 04:45 GMT
  "45 19 * * *": "evening-brief",    // 20:45 BST / 19:45 GMT
  "0 8 * * 6": "interest-scout",     // Sat 09:00 BST
  "0 9 * * 7": "harvest",            // Sun 10:00 BST — the weekly calendar sweep
  "0 10 1 * *": "family-events",     // 1st of the month, 11:00 BST
};

/* -------------------------------------------------------------- push api */

/**
 * Everything the PWA and the runner need to deliver a notification.
 *
 *   GET  /api/push/key          the VAPID public key, so it is not hardcoded
 *                               in the dashboard and rotating needs no redeploy
 *   POST /api/push/subscribe    { subscription, label } — register this device
 *   POST /api/push/unsubscribe  { endpoint } — forget it
 *   POST /api/push/send         { title, body, url?, kind? } — fan out to every
 *                               device. `url` is a relative in-app destination
 *                               for the tap (e.g. "./?view=brief"); `kind` tags
 *                               an inline reply with the digest it answered.
 *   GET  /api/push/devices      what is registered, without the keys
 */
async function handlePush(req, url, env, store) {
  const path = url.pathname;
  const payload = req.method === "POST" ? await req.json().catch(() => ({})) : {};

  if (path === "/api/push/key") {
    return { ok: !!env.VAPID_PUBLIC_KEY, key: env.VAPID_PUBLIC_KEY || null };
  }

  if (path === "/api/push/devices") {
    const { subs } = await readPushSubs(store);
    // Never echo p256dh/auth back out — they are the device's decryption keys.
    return { ok: true, devices: subs.map((s) => ({ label: s.label, added: s.added, endpoint: s.endpoint.slice(0, 40) + "…" })) };
  }

  if (path === "/api/push/subscribe" && req.method === "POST") {
    const ok = await addPushSub(store, { ...(payload.subscription || {}), label: payload.label });
    return { ok, error: ok ? undefined : "malformed subscription" };
  }

  if (path === "/api/push/unsubscribe" && req.method === "POST") {
    return { ok: await removePushSubs(store, [payload.endpoint]) };
  }

  if (path === "/api/push/send" && req.method === "POST") {
    const title = String(payload.title || "Life-Vault").slice(0, 120);
    const body = String(payload.body || "").slice(0, 2400);
    // Where tapping the notification lands, and which digest it came from.
    // Relative paths only: a notification is a thing the user taps without
    // reading, so it must not be able to carry them off-origin. Anything with a
    // scheme, a protocol-relative "//host", or a backslash is dropped rather
    // than sanitised — the service worker then falls back to the app root.
    const kind = String(payload.kind || "").slice(0, 80);
    const deepUrl = safeDeepLink(payload.url);
    const { subs } = await readPushSubs(store);
    if (!subs.length) {
      // Push is the only channel now, so "nobody is subscribed" is a delivery
      // failure and has to be reported as one — not quietly counted as success.
      return { ok: false, sent: 0, total: 0, error: "no devices are registered for notifications" };
    }
    const msg = { title, body, at: Date.now() };
    if (deepUrl) msg.url = deepUrl;
    if (kind) msg.kind = kind;
    const r = await sendToAll(subs, JSON.stringify(msg), env);
    // Prune the ones the push service says are dead, or they absorb every send
    // from here on and the failure count never comes back down.
    if (r.gone.length) await removePushSubs(store, r.gone);
    return {
      ok: r.sent > 0,
      sent: r.sent, total: r.total, pruned: r.gone.length,
      error: r.sent > 0 ? undefined
        : (r.failed[0] && `${r.failed[0].status}: ${r.failed[0].error}`) || "every device rejected the push",
    };
  }

  return { ok: false, error: "not found" };
}

// Best-effort alert. The Worker is the only part of the system that can still
// speak when the runner never started, so a failure to dispatch has to leave
// this building somehow. Same channel as everything else now that ntfy is gone.
async function shout(env, title, body) {
  try {
    const { subs } = await readPushSubs(githubStore(env));
    if (subs.length) await sendToAll(subs, JSON.stringify({ title, body: String(body).slice(0, 2400) }), env);
  } catch { /* nothing left to try */ }
}
