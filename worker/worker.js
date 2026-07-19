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

import { createApi } from "./vault.js";

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
function tokenOk(req, env) {
  const want = env.UNLOCK_TOKEN || "";
  const got = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
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
};
