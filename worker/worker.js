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

function githubStore(env) {
  const branch = env.GH_BRANCH || "main";
  return {
    async readFile(path) {
      const r = await gh(env, `/contents/${encodeURI(path)}?ref=${branch}`);
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`read ${path}: ${r.status}`);
      const j = await r.json();
      return { text: j.content ? b64decode(j.content) : "", sha: j.sha };
    },
    async listDir(path) {
      const r = await gh(env, `/contents/${encodeURI(path)}?ref=${branch}`);
      if (r.status === 404) return [];
      if (!r.ok) throw new Error(`list ${path}: ${r.status}`);
      const j = await r.json();
      return Array.isArray(j) ? j.map((e) => ({ name: e.name, path: e.path, sha: e.sha })) : [];
    },
    // Create or update a file (a commit). Pass sha to update, omit to create.
    // A concurrent writer (bridge, scheduled skill, second device) makes the sha
    // stale → GitHub returns 409/422; re-read the sha and retry a few times
    // rather than surfacing a 500 to the dashboard.
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
          const cur = await this.readFile(path);
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
