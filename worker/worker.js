/**
 * Life-Vault dashboard — Cloudflare Worker (the write-proxy / API).
 *
 * This replaces scripts/dashboard-server.py for the laptop-free deployment.
 * It is the ONLY holder of the GitHub token: the PWA never sees it. Every
 * request must carry the shared unlock token; anything without it is refused,
 * so the public Pages URL is not an open door to the vault.
 *
 * Reads the vault via the GitHub Contents API and returns the same shape the
 * Python server's build_data() did. Writes (capture / add task / tick / queue a
 * skill run) become commits on the vault repo. The desktop bridge and the cloud
 * routines sync through the same GitHub repo, so there is one source of truth.
 *
 * Bindings (set as Worker secrets / vars, never in code):
 *   GH_TOKEN       fine-grained PAT, scoped to the life-vault repo (contents RW)
 *   GH_OWNER       repo owner, e.g. "ben"
 *   GH_REPO        repo name, e.g. "life-vault"
 *   GH_BRANCH      branch to read/write (default "main")
 *   UNLOCK_TOKEN   shared secret the PWA must send (the app-unlock gate)
 *   ALLOW_ORIGIN   the Pages origin allowed by CORS (default "*")
 */

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
    cache: "no-store",            // don't let Cloudflare serve a stale GitHub read
    cf: { cacheTtl: 0, cacheEverything: false },
    headers: {
      Authorization: `Bearer ${env.GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "life-vault-dashboard",
      ...(init.headers || {}),
    },
  });
}

// Read a single file: returns { text, sha } or null if it doesn't exist.
async function readFile(env, path) {
  const branch = env.GH_BRANCH || "main";
  const r = await gh(env, `/contents/${encodeURI(path)}?ref=${branch}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`read ${path}: ${r.status}`);
  const j = await r.json();
  return { text: j.content ? b64decode(j.content) : "", sha: j.sha };
}

// List a directory: returns [{ name, path, sha }].
async function listDir(env, path) {
  const branch = env.GH_BRANCH || "main";
  const r = await gh(env, `/contents/${encodeURI(path)}?ref=${branch}`);
  if (r.status === 404) return [];
  if (!r.ok) throw new Error(`list ${path}: ${r.status}`);
  const j = await r.json();
  return Array.isArray(j) ? j.map((e) => ({ name: e.name, path: e.path, sha: e.sha })) : [];
}

// Create or update a file (a commit). Pass sha to update, omit to create.
async function putFile(env, path, text, message, sha) {
  const branch = env.GH_BRANCH || "main";
  const body = { message, content: b64encode(text), branch };
  if (sha) body.sha = sha;
  const r = await gh(env, `/contents/${encodeURI(path)}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`put ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

/* -------------------------------------------------- markdown parsing (ported) */

const DUE_RE = /📅\s*(\d{4}-\d{2}-\d{2})/;      // 📅 YYYY-MM-DD
const DONE_RE = /✅\s*(\d{4}-\d{2}-\d{2})/;            // ✅ YYYY-MM-DD
const TAG_RE = /(?:^|\s)#([A-Za-z0-9_/-]+)/g;
const TASK_RE = /^(\s*)- \[( |x|X)\]\s+(.*)$/;
const OCCASION_RE = /\(occasion::\s*(\d{4}-\d{2}-\d{2})\)\s*(.*)/g;

function today() {
  return new Date().toISOString().slice(0, 10);
}

// Stable id: text stripped of stamps/tags, then a small stable hash. The Worker
// is the only place ids are made, so browser round-trips stay consistent.
function coreText(text) {
  let t = text.replace(DUE_RE, "").replace(DONE_RE, "");
  t = t.replace(/(?:^|\s)#[A-Za-z0-9_/-]+/g, "");
  return t.split(/\s+/).join(" ").trim().toLowerCase();
}
function taskId(text) {
  const core = coreText(text);
  let h = 0;
  for (let i = 0; i < core.length; i++) h = (h * 31 + core.charCodeAt(i)) | 0;
  return String(Math.abs(h));
}

function parseTasks(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const m = line.match(TASK_RE);
    if (!m) continue;
    const checked = m[2].toLowerCase() === "x";
    const body = m[3];
    const dueM = body.match(DUE_RE);
    const due = dueM ? dueM[1] : null;
    const tags = [...body.matchAll(TAG_RE)].map((x) => x[1]);
    let label = body.replace(DUE_RE, "").replace(DONE_RE, "");
    label = label.replace(/(?:^|\s)#[A-Za-z0-9_/-]+/g, "");
    label = label.replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, "$1"); // wikilinks
    label = label.split(/\s+/).join(" ").trim();
    const overdue = !!(due && !checked && due <= today());
    out.push({ id: taskId(body), text: label, done: checked, due, tags, overdue });
  }
  return out;
}

function parseEntity(text, fallbackName) {
  let name = fallbackName, tags = [], updated = null, summary = "";
  const fm = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (fm) {
    const block = fm[1];
    const nm = block.match(/^name:\s*(.+)$/m);
    if (nm) name = nm[1].trim();
    const tm = block.match(/^tags:\s*\[(.*?)\]/m);
    if (tm) tags = tm[1].split(",").map((t) => t.trim()).filter(Boolean);
    const um = block.match(/^updated:\s*(.+)$/m);
    if (um) updated = um[1].trim();
  }
  const sm = text.match(/## What to know\s*\n(.+)/);
  if (sm) summary = sm[1].trim();
  return { name, tags, updated, summary };
}

async function readEntities(env, folder) {
  const files = await listDir(env, folder);
  const items = [];
  for (const f of files) {
    if (!f.name.endsWith(".md") || f.name.startsWith("_")) continue;
    const file = await readFile(env, f.path);
    if (!file) continue;
    items.push(parseEntity(file.text, f.name.slice(0, -3)));
  }
  return items;
}

async function readOccasions(env) {
  const files = await listDir(env, "people");
  const out = [];
  const t = today();
  for (const f of files) {
    if (!f.name.endsWith(".md")) continue;
    const file = await readFile(env, f.path);
    if (!file) continue;
    for (const m of file.text.matchAll(OCCASION_RE)) {
      if (m[1] >= t) out.push({ date: m[1], text: m[2].trim() });
    }
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

async function latestBrief(env) {
  const files = (await listDir(env, "digests")).filter((f) => f.name.endsWith(".md"));
  if (!files.length) return null;
  files.sort((a, b) => a.name.localeCompare(b.name));
  const newest = files[files.length - 1];
  const file = await readFile(env, newest.path);
  return file ? { name: newest.name, text: file.text } : null;
}

// Skill run status: one <skill>.status file per skill in inbox/_runs/.
async function readSkills(env) {
  const files = await listDir(env, "inbox/_runs");
  const status = {};
  for (const f of files) {
    if (!f.name.endsWith(".status")) continue;
    const file = await readFile(env, f.path);
    if (!file) continue;
    try {
      status[f.name.replace(/\.status$/, "")] = JSON.parse(file.text);
    } catch { /* ignore malformed status */ }
  }
  return status;
}

async function buildData(env) {
  const tasksFile = await readFile(env, "tasks.md");
  const [projects, people, occasions, brief, skills] = await Promise.all([
    readEntities(env, "projects"),
    readEntities(env, "people"),
    readOccasions(env),
    latestBrief(env),
    readSkills(env),
  ]);
  return {
    generated: new Date().toISOString(),
    tasks: tasksFile ? parseTasks(tasksFile.text) : [],
    projects,
    people,
    occasions,
    brief,
    skills,
  };
}

/* ------------------------------------------------------------------- writes */

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function rand(n = 6) {
  const c = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < n; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}

async function capture(env, text) {
  text = (text || "").trim();
  if (!text) return false;
  await putFile(env, `inbox/${stamp()}-${rand()}.md`, text + "\n", "dashboard: capture");
  return true;
}

async function addTask(env, text, due, tag) {
  text = (text || "").trim();
  if (!text) return false;
  let line = `- [ ] ${text}`;
  if (tag) { tag = String(tag).replace(/^#/, "").trim(); if (tag) line += ` #${tag}`; }
  if (due && /^\d{4}-\d{2}-\d{2}$/.test(String(due).trim())) line += ` 📅 ${String(due).trim()}`;
  const cur = await readFile(env, "tasks.md");
  const base = cur ? cur.text.replace(/\n+$/, "") : "# Tasks";
  await putFile(env, "tasks.md", base + "\n" + line + "\n", "dashboard: add task", cur && cur.sha);
  return true;
}

async function toggleTask(env, id) {
  const cur = await readFile(env, "tasks.md");
  if (!cur) return false;
  const lines = cur.text.split("\n");
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(TASK_RE);
    if (!m || taskId(m[3]) !== String(id)) continue;
    const indent = m[1];
    let body = m[3];
    if (m[2].toLowerCase() === "x") {
      body = body.replace(DONE_RE, "").replace(/\s+$/, "");
      lines[i] = `${indent}- [ ] ${body}`;
    } else {
      body = body.replace(/\s+$/, "") + ` ✅ ${today()}`;
      lines[i] = `${indent}- [x] ${body}`;
    }
    changed = true;
    break;
  }
  if (!changed) return false;
  await putFile(env, "tasks.md", lines.join("\n"), "dashboard: toggle task", cur.sha);
  return true;
}

// Queue a skill run: a .run trigger file the GitHub Action picks up.
async function queueRun(env, skill) {
  skill = (skill || "").trim().replace(/[^a-z0-9-]/gi, "");
  if (!skill) return false;
  const payload = JSON.stringify({ skill, requested: new Date().toISOString(), by: "dashboard" }, null, 2);
  await putFile(env, `inbox/_runs/${skill}-${stamp()}.run`, payload + "\n", `dashboard: run ${skill}`);
  return true;
}

/* ------------------------------------------------------------------ routing */

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "OPTIONS") return new Response(null, { headers: cors(env) });
    if (!tokenOk(req, env)) return json({ error: "unauthorized" }, env, 401);

    try {
      if (req.method === "GET" && path === "/api/data") {
        return json(await buildData(env), env);
      }
      if (req.method === "GET" && path === "/api/file") {
        const p = url.searchParams.get("path") || "";
        // Sanitize: relative vault paths only, no traversal, must be markdown.
        if (!p || p.startsWith("/") || p.includes("..") || !p.endsWith(".md")) {
          return json({ error: "bad path" }, env, 400);
        }
        const f = await readFile(env, p);
        if (!f) return json({ error: "not found" }, env, 404);
        return json({ path: p, text: f.text }, env);
      }
      if (req.method === "POST") {
        const payload = await req.json().catch(() => ({}));
        let ok = false;
        if (path === "/api/capture") ok = await capture(env, payload.text);
        else if (path === "/api/task") ok = await addTask(env, payload.text, payload.due, payload.tag);
        else if (path === "/api/toggle") ok = await toggleTask(env, payload.id);
        else if (path === "/api/run") ok = await queueRun(env, payload.skill);
        else return json({ error: "not found" }, env, 404);
        return json({ ok }, env);
      }
      return json({ error: "not found" }, env, 404);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, env, 500);
    }
  },
};
