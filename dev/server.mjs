/**
 * Life-Vault — local development server.
 *
 *   node dev/server.mjs          # http://localhost:8766  (LV_PORT to change)
 *
 * Serves dashboard/ statically and mounts the SAME api as the Cloudflare
 * Worker (worker/vault.js), backed by the vault files on disk instead of the
 * GitHub Contents API. So the dashboard you develop against behaves exactly
 * like the deployed one, and every write lands in the working tree where you
 * can `git diff` it before it goes anywhere.
 *
 * This replaces scripts/dashboard-server.py, which reimplemented the markdown
 * rules in Python and had drifted several features behind the Worker.
 *
 * Auth: off by default (it is a localhost tool). Set LV_TOKEN to require the
 * same bearer token the Worker does.
 */

import { createServer } from "node:http";
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createApi, readPushSubs, addPushSub, removePushSubs } from "../worker/vault.js";
import { sendToAll } from "../worker/push.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATIC = join(ROOT, "dashboard");
const PORT = Number(process.env.LV_PORT || 8766);
const TOKEN = process.env.LV_TOKEN || "";

/* ------------------------------------------------------- filesystem store */

// Keep every path inside the vault — the API sanitizes too, but a dev server
// bound to localhost is still not an excuse to allow `../../.ssh`.
function safe(path) {
  const full = resolve(ROOT, path);
  if (full !== ROOT && !full.startsWith(ROOT + sep)) throw new Error("path escapes vault");
  return full;
}

const store = {
  async readFile(path) {
    try {
      return { text: await readFile(safe(path), "utf8"), sha: "fs" };
    } catch (e) {
      if (e.code === "ENOENT" || e.code === "EISDIR") return null;
      throw e;
    }
  },
  async listDir(path) {
    try {
      const entries = await readdir(safe(path), { withFileTypes: true });
      return entries.filter((e) => e.isFile()).map((e) => ({ name: e.name, path: `${path}/${e.name}` }));
    } catch (e) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
  },
  async putFile(path, text) {
    const full = safe(path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, text, "utf8");
    console.log(`  write ${path}`);
  },
};

/* ------------------------------------------------------------- calendars */
// Feed URLs are credentials, so they live in .env (gitignored), never in the
// repo. Deployed, the same values are Worker secrets.
function loadEnvFile() {
  try {
    for (const line of readFileSync(join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
      if (/^\s*#/.test(line)) continue;
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch { /* no .env is fine */ }
}
loadEnvFile();

const calendars = [
  process.env.CAL_WORK && { name: "work", url: process.env.CAL_WORK },
  process.env.CAL_PERSONAL && { name: "personal", url: process.env.CAL_PERSONAL },
  process.env.CAL_FAMILY && { name: "family", url: process.env.CAL_FAMILY },
].filter(Boolean);

const handle = createApi(store, { calendars });

/* -------------------------------------------------------------- http shell */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
};

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

async function serveStatic(res, pathname) {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const full = join(STATIC, rel);
  if (!full.startsWith(STATIC)) return send(res, 403, "forbidden", "text/plain");
  try {
    const buf = await readFile(full);
    send(res, 200, buf, MIME[extname(full)] || "application/octet-stream");
  } catch {
    send(res, 404, "not found", "text/plain");
  }
}

async function handlePushDev(method, path, payload) {
  const p = payload || {};
  if (path === "/api/push/key") {
    // VAPID_PUBLIC_KEY in .env lets the real subscribe flow be tested locally.
    return { status: 200, body: { ok: !!process.env.VAPID_PUBLIC_KEY, key: process.env.VAPID_PUBLIC_KEY || null } };
  }
  if (path === "/api/push/devices") {
    const { subs } = await readPushSubs(store);
    return { status: 200, body: { ok: true, devices: subs.map((s) => ({ label: s.label, added: s.added })) } };
  }
  if (path === "/api/push/subscribe" && method === "POST") {
    const ok = await addPushSub(store, { ...(p.subscription || {}), label: p.label });
    return { status: 200, body: { ok, error: ok ? undefined : "malformed subscription" } };
  }
  if (path === "/api/push/unsubscribe" && method === "POST") {
    return { status: 200, body: { ok: await removePushSubs(store, [p.endpoint]) } };
  }
  if (path === "/api/push/send" && method === "POST") {
    const { subs } = await readPushSubs(store);
    if (!subs.length) return { status: 200, body: { ok: false, sent: 0, total: 0, error: "no devices are registered for notifications" } };
    const r = await sendToAll(subs, JSON.stringify({ title: p.title, body: p.body, at: Date.now() }), process.env);
    if (r.gone.length) await removePushSubs(store, r.gone);
    return { status: 200, body: { ok: r.sent > 0, sent: r.sent, total: r.total, error: r.sent ? undefined : "no device accepted the push" } };
  }
  return { status: 404, body: { ok: false, error: "not found" } };
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (!url.pathname.startsWith("/api/")) return serveStatic(res, url.pathname);

  if (TOKEN) {
    const got = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (got !== TOKEN) return send(res, 401, JSON.stringify({ error: "unauthorized" }));
  }

  let payload = null;
  if (req.method === "POST") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { payload = {}; }
  }

  // Push routes live in worker.js, not vault.js, because they need the VAPID
  // secrets off the Worker env. Mount them here too so the subscribe flow can
  // be exercised locally — sending needs real keys, everything else doesn't.
  if (url.pathname.startsWith("/api/push")) {
    const { status, body } = await handlePushDev(req.method, url.pathname, payload);
    console.log(`${req.method} ${url.pathname} -> ${status}`);
    return send(res, status, JSON.stringify(body));
  }

  try {
    const { status, body } = await handle(req.method, url.pathname, url.searchParams, payload);
    console.log(`${req.method} ${url.pathname} -> ${status}`);
    send(res, status, JSON.stringify(body));
  } catch (e) {
    console.error(`${req.method} ${url.pathname} !! ${e.message}`);
    send(res, 500, JSON.stringify({ error: String(e.message || e) }));
  }
}).listen(PORT, () => {
  console.log(`life-vault dev server — http://localhost:${PORT}`);
  console.log(`vault: ${ROOT}`);
  console.log(TOKEN ? "auth: bearer token required" : "auth: open (localhost dev)");
});
