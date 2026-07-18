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

import { sendPush } from "./push.js";

const API = "https://api.github.com";
const SUBS_PATH = "_meta/push-subs.json";

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
// A concurrent writer (bridge, scheduled skill, second device) makes the sha
// stale → GitHub returns 409/422; re-read the sha and retry a few times rather
// than surfacing a 500 to the dashboard.
async function putFile(env, path, text, message, sha) {
  const branch = env.GH_BRANCH || "main";
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
      const cur = await readFile(env, path);
      sha = cur ? cur.sha : undefined;
      continue;
    }
    throw new Error(`put ${path}: ${r.status} ${await r.text()}`);
  }
}

/* -------------------------------------------------- markdown parsing (ported) */

const DUE_RE = /📅\s*(\d{4}-\d{2}-\d{2})/;      // 📅 YYYY-MM-DD
const DONE_RE = /✅\s*(\d{4}-\d{2}-\d{2})/;            // ✅ YYYY-MM-DD
const TAG_RE = /(?:^|\s)#([A-Za-z0-9_/-]+)/g;
const TASK_RE = /^(\s*)- \[( |x|X)\]\s+(.*)$/;
const OCCASION_RE = /\(occasion::\s*(\d{4}-\d{2}-\d{2})\)\s*(.*)/g;
// `u` flag is load-bearing: without it these classes match lone UTF-16
// surrogates, so 📅 (shares the D83D high surrogate) false-matches and gets
// half-stripped by replace() — corrupting due dates in tasks.md.
const PRIORITY_RE = /[🔺⏫🔼🔽⏬]/gu;           // Obsidian Tasks priority markers
const HIGH_RE = /[🔺⏫]/u;                        // counts as "priority" in the UI

function today() {
  // Vault dates are Europe/London days, not UTC (they differ 23:00–00:00 GMT
  // in summer). en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());
}

// Stable id: text stripped of stamps/tags, then a small stable hash. The Worker
// is the only place ids are made, so browser round-trips stay consistent.
function coreText(text) {
  let t = text.replace(DUE_RE, "").replace(DONE_RE, "").replace(PRIORITY_RE, "");
  t = t.replace(/(?:^|\s)#[A-Za-z0-9_/-]+/g, "");
  return t.split(/\s+/).join(" ").trim().toLowerCase();
}
function taskId(text) {
  const core = coreText(text);
  let h = 0;
  for (let i = 0; i < core.length; i++) h = (h * 31 + core.charCodeAt(i)) | 0;
  return String(Math.abs(h));
}

// Walk a file's task lines assigning occurrence-stable ids: duplicate task text
// gets "-2", "-3", … suffixes in file order, so two identical tasks stay
// individually addressable by toggle/priority/reorder.
function taskLines(lines) {
  const seen = {};
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(TASK_RE);
    if (!m) continue;
    const h = taskId(m[3]);
    const n = (seen[h] = (seen[h] || 0) + 1);
    out.push({ idx: i, id: n > 1 ? `${h}-${n}` : h, m });
  }
  return out;
}

function parseTasks(text) {
  const out = [];
  for (const tl of taskLines(text.split("\n"))) {
    const m = tl.m;
    const checked = m[2].toLowerCase() === "x";
    const body = m[3];
    const dueM = body.match(DUE_RE);
    const due = dueM ? dueM[1] : null;
    const tags = [...body.matchAll(TAG_RE)].map((x) => x[1]);
    let label = body.replace(DUE_RE, "").replace(DONE_RE, "").replace(PRIORITY_RE, "");
    label = label.replace(/(?:^|\s)#[A-Za-z0-9_/-]+/g, "");
    label = label.replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, "$1"); // wikilinks
    label = label.split(/\s+/).join(" ").trim();
    const overdue = !!(due && !checked && due <= today());
    const priority = HIGH_RE.test(body);
    out.push({ id: tl.id, text: label, done: checked, due, tags, overdue, priority });
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

// The brief card wants the newest morning/evening digest specifically — a bare
// name sort would rank 2026-W29-interests.md above every dated brief ('W' > '0')
// and "evening" below "morning" within a day.
async function latestBrief(env) {
  const BRIEF_RE = /^(\d{4}-\d{2}-\d{2})-(morning|evening)\.md$/;
  const briefs = (await listDir(env, "digests"))
    .map((f) => ({ f, m: f.name.match(BRIEF_RE) }))
    .filter((x) => x.m);
  if (!briefs.length) return null;
  briefs.sort((a, b) =>
    a.m[1].localeCompare(b.m[1]) ||
    (a.m[2] === "evening" ? 1 : 0) - (b.m[2] === "evening" ? 1 : 0)
  );
  const newest = briefs[briefs.length - 1].f;
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

/* ------------------------------------------------------------------- habits */
// habits.md: "## <Habit>" sections with "- [ ]" sub-items and a "(day:: date)"
// marker. The checkboxes represent TODAY: when the marker is stale the file is
// lazily reset on the next toggle, and reads report everything unchecked.
// Completions are also appended to habits-log.md — append-only history that
// streaks are derived from (golden rule: never rewrite the log).

function parseHabits(text) {
  const dayM = text.match(/\(day::\s*(\d{4}-\d{2}-\d{2})\)/);
  const stale = !dayM || dayM[1] !== today();
  const habits = [];
  let cur = null;
  for (const line of text.split("\n")) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) { cur = { name: h[1], items: [] }; habits.push(cur); continue; }
    const m = line.match(TASK_RE);
    if (m && cur) cur.items.push({ text: m[3].trim(), done: !stale && m[2].toLowerCase() === "x" });
  }
  return habits.filter((h) => h.items.length);
}

// Streak: consecutive days (ending today or yesterday) with at least one
// logged completion for the habit.
function habitStreaks(logText) {
  const byHabit = {};
  for (const m of logText.matchAll(/^- (\d{4}-\d{2}-\d{2}) — ([^/\n]+?) \//gm)) {
    (byHabit[m[2].trim()] = byHabit[m[2].trim()] || new Set()).add(m[1]);
  }
  const streaks = {};
  const dayMs = 864e5;
  const t = new Date(today() + "T12:00:00Z").getTime();
  for (const [name, days] of Object.entries(byHabit)) {
    let streak = 0;
    let d = days.has(today()) ? t : t - dayMs;   // may start counting from yesterday
    while (days.has(new Date(d).toISOString().slice(0, 10))) { streak++; d -= dayMs; }
    streaks[name] = streak;
  }
  return streaks;
}

async function readHabits(env) {
  const file = await readFile(env, "habits.md");
  if (!file) return [];
  const habits = parseHabits(file.text);
  if (!habits.length) return [];
  const log = await readFile(env, "habits-log.md");
  const streaks = log ? habitStreaks(log.text) : {};
  return habits.map((h) => ({ ...h, streak: streaks[h.name] || 0 }));
}

// Toggle one habit sub-item for today. Resets the whole file first if the
// day marker is stale, and appends completions to habits-log.md.
async function toggleHabit(env, habit, item) {
  habit = String(habit || "").trim();
  item = String(item || "").trim();
  if (!habit || !item) return false;
  const cur = await readFile(env, "habits.md");
  if (!cur) return false;
  let lines = cur.text.split("\n");
  const dayM = cur.text.match(/\(day::\s*(\d{4}-\d{2}-\d{2})\)/);
  if (!dayM || dayM[1] !== today()) {
    lines = lines.map((l) => l.replace(/^(\s*)- \[[xX]\]/, "$1- [ ]"));
    const marker = `(day:: ${today()})`;
    const mi = lines.findIndex((l) => /\(day::\s*\d{4}-\d{2}-\d{2}\)/.test(l));
    if (mi >= 0) lines[mi] = lines[mi].replace(/\(day::\s*\d{4}-\d{2}-\d{2}\)/, marker);
    else lines.splice(1, 0, "", marker);
  }
  let inSection = false, toggledOn = null;
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^##\s+(.+?)\s*$/);
    if (h) { inSection = h[1] === habit; continue; }
    if (!inSection) continue;
    const m = lines[i].match(TASK_RE);
    if (!m || m[3].trim() !== item) continue;
    const nowDone = m[2] === " ";
    lines[i] = `${m[1]}- [${nowDone ? "x" : " "}] ${m[3]}`;
    toggledOn = nowDone;
    break;
  }
  if (toggledOn === null) return false;
  await putFile(env, "habits.md", lines.join("\n"), "dashboard: habit", cur.sha);
  if (toggledOn) {
    const log = await readFile(env, "habits-log.md");
    const entry = `- ${today()} — ${habit} / ${item}`;
    const base = log ? log.text.replace(/\s*$/, "") : "# Habits log";
    if (!base.includes(entry)) {
      await putFile(env, "habits-log.md", base + "\n" + entry + "\n", "dashboard: habit log", log && log.sha);
    }
  }
  return true;
}

// Count raw, unfiled captures sitting in inbox/ (excludes _archive / _runs).
async function inboxCount(env) {
  const files = await listDir(env, "inbox");
  return files.filter((f) => f.name.endsWith(".md") && !f.name.startsWith("_")).length;
}

async function buildData(env) {
  const tasksFile = await readFile(env, "tasks.md");
  const [projects, people, occasions, brief, skills, inbox, habits] = await Promise.all([
    readEntities(env, "projects"),
    readEntities(env, "people"),
    readOccasions(env),
    latestBrief(env),
    readSkills(env),
    inboxCount(env),
    readHabits(env),
  ]);
  return {
    generated: new Date().toISOString(),
    tasks: tasksFile ? parseTasks(tasksFile.text) : [],
    projects,
    people,
    occasions,
    brief,
    skills,
    inbox,
    habits,
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
  const tl = taskLines(lines).find((t) => t.id === String(id));
  if (!tl) return false;
  const indent = tl.m[1];
  let body = tl.m[3];
  if (tl.m[2].toLowerCase() === "x") {
    body = body.replace(DONE_RE, "").replace(/\s+$/, "");
    lines[tl.idx] = `${indent}- [ ] ${body}`;
  } else {
    body = body.replace(/\s+$/, "") + ` ✅ ${today()}`;
    lines[tl.idx] = `${indent}- [x] ${body}`;
  }
  await putFile(env, "tasks.md", lines.join("\n"), "dashboard: toggle task", cur.sha);
  return true;
}

// Toggle the ⏫ priority marker on a task.
async function setPriority(env, id) {
  const cur = await readFile(env, "tasks.md");
  if (!cur) return false;
  const lines = cur.text.split("\n");
  const tl = taskLines(lines).find((t) => t.id === String(id));
  if (!tl) return false;
  const had = HIGH_RE.test(tl.m[3]);
  let body = tl.m[3].replace(PRIORITY_RE, "").replace(/\s{2,}/g, " ").replace(/\s+$/, "");
  if (!had) body = body + " ⏫";
  lines[tl.idx] = `${tl.m[1]}- [${tl.m[2]}] ${body}`;
  await putFile(env, "tasks.md", lines.join("\n"), "dashboard: toggle priority", cur.sha);
  return true;
}

// Reorder tasks.md to match the given id order. Only the slots whose ids were
// actually received are permuted; done tasks, unknown ids, and non-task lines
// stay exactly where they are (so a partial/duplicate list can't lose a line).
async function reorderTasks(env, ids) {
  if (!Array.isArray(ids)) return false;
  const cur = await readFile(env, "tasks.md");
  if (!cur) return false;
  const lines = cur.text.split("\n");
  const tl = taskLines(lines);
  const byId = {};
  for (const t of tl) byId[t.id] = t;
  // De-dupe the request and keep only ids that exist in the file.
  const received = [];
  const seen = new Set();
  for (const raw of ids) {
    const id = String(raw);
    if (byId[id] && !seen.has(id)) { received.push(id); seen.add(id); }
  }
  if (!received.length) return true;   // nothing to do
  // Capture the lines first, then permute them into the received slots.
  const orderedLines = received.map((id) => lines[byId[id].idx]);
  const targetSlots = tl.filter((t) => seen.has(t.id)).map((t) => t.idx);
  targetSlots.forEach((idx, k) => { lines[idx] = orderedLines[k]; });
  await putFile(env, "tasks.md", lines.join("\n"), "dashboard: reorder tasks", cur.sha);
  return true;
}

// Queue a skill run: a .run trigger file the runner (local or cloud) picks up.
// `input` (optional) is free text handed to the skill — used by Ask.
async function queueRun(env, skill, input) {
  skill = (skill || "").trim().replace(/[^a-z0-9-]/gi, "");
  if (!skill) return false;
  const payload = JSON.stringify(
    { skill, requested: new Date().toISOString(), by: "dashboard", input: String(input || "") },
    null, 2
  );
  await putFile(env, `inbox/_runs/${skill}-${stamp()}.run`, payload + "\n", `dashboard: run ${skill}`);
  return true;
}

// Append a dated fragment to a person's ## Log (used by evening-brief advice-save).
async function appendFragment(env, person, text) {
  person = String(person || "").trim();
  text = String(text || "").trim();
  if (!person || !text) return false;
  const slug = person.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const path = `people/${slug}.md`;
  const cur = await readFile(env, path);
  if (!cur) return false;                       // never create a person from the dashboard
  const line = `- ${today()} — ${text} _(saved from dashboard)_`;
  let body = cur.text.replace(/\s*$/, "");
  body += /##\s*Log/i.test(body) ? `\n${line}\n` : `\n\n## Log\n${line}\n`;
  await putFile(env, path, body, `dashboard: log for ${person}`, cur.sha);
  return true;
}

/* ---------------------------------------------------------------- web push */

async function readSubs(env) {
  const f = await readFile(env, SUBS_PATH);
  if (!f) return { subs: [], sha: undefined };
  try { return { subs: JSON.parse(f.text), sha: f.sha }; }
  catch { return { subs: [], sha: f.sha }; }
}

async function pushSubscribe(env, sub) {
  if (!sub || !sub.endpoint || !sub.keys) return false;
  const { subs, sha } = await readSubs(env);
  if (!subs.some((s) => s.endpoint === sub.endpoint)) {
    subs.push({ endpoint: sub.endpoint, keys: sub.keys });
    await putFile(env, SUBS_PATH, JSON.stringify(subs, null, 2) + "\n", "dashboard: push subscribe", sha);
  }
  return true;
}

async function notify(env, payload) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return false;
  const { subs, sha } = await readSubs(env);
  if (!subs.length) return true;
  const dead = await sendPush(env, subs, {
    title: String(payload.title || "Life-Vault"),
    body: String(payload.body || ""),
    tag: String(payload.tag || "life-vault"),
    url: String(payload.url || "/"),
  });
  if (dead.length) {
    const alive = subs.filter((s) => !dead.includes(s.endpoint));
    await putFile(env, SUBS_PATH, JSON.stringify(alive, null, 2) + "\n", "dashboard: prune push subs", sha);
  }
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
      if (req.method === "GET" && path === "/api/push-key") {
        return json({ key: env.VAPID_PUBLIC_KEY || "" }, env);
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
        else if (path === "/api/priority") ok = await setPriority(env, payload.id);
        else if (path === "/api/reorder") ok = await reorderTasks(env, payload.ids);
        else if (path === "/api/run") ok = await queueRun(env, payload.skill, payload.input);
        else if (path === "/api/append") ok = await appendFragment(env, payload.person, payload.text);
        else if (path === "/api/habit") ok = await toggleHabit(env, payload.habit, payload.item);
        else if (path === "/api/push-subscribe") ok = await pushSubscribe(env, payload.subscription || payload);
        else if (path === "/api/notify") ok = await notify(env, payload);
        else return json({ error: "not found" }, env, 404);
        return json({ ok }, env);
      }
      return json({ error: "not found" }, env, 404);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, env, 500);
    }
  },
};
