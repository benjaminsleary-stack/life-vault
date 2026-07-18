/**
 * Life-Vault — the vault domain layer.
 *
 * Everything here is storage-agnostic: it talks to a `store` with three methods
 * and knows nothing about GitHub, Cloudflare, or the filesystem.
 *
 *   store.readFile(path)            -> { text, sha } | null
 *   store.listDir(path)             -> [{ name, path }]
 *   store.putFile(path, text, msg, sha)
 *
 * Two hosts wrap it:
 *   worker/worker.js  — GitHub Contents API store, deployed to Cloudflare
 *   dev/server.mjs    — local filesystem store, for development
 *
 * That is the whole point of the split: the parsing rules for tasks.md,
 * habits.md and people/*.md exist ONCE. The previous local Python server drifted
 * three features behind the Worker because the rules were written twice.
 */

/* -------------------------------------------------------- markdown parsing */

const DUE_RE = /📅\s*(\d{4}-\d{2}-\d{2})/;             // 📅 YYYY-MM-DD
const DONE_RE = /✅\s*(\d{4}-\d{2}-\d{2})/;            // ✅ YYYY-MM-DD
const TAG_RE = /(?:^|\s)#([A-Za-z0-9_/-]+)/g;
const TASK_RE = /^(\s*)- \[( |x|X)\]\s+(.*)$/;
const OCCASION_RE = /\(occasion::\s*(\d{4}-\d{2}-\d{2})\)\s*(.*)/g;
// `u` flag is load-bearing: without it these classes match lone UTF-16
// surrogates, so 📅 (shares the D83D high surrogate) false-matches and gets
// half-stripped by replace() — corrupting due dates in tasks.md.
const PRIORITY_RE = /[🔺⏫🔼🔽⏬]/gu;                    // Obsidian Tasks priority markers
const HIGH_RE = /[🔺⏫]/u;                              // counts as "priority" in the UI

export const AREAS = ["family", "house", "work", "health", "interests", "admin"];

export function today() {
  // Vault dates are Europe/London days, not UTC (they differ 23:00–00:00 GMT
  // in summer). en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());
}
function daysAgo(iso, from = today()) {
  return Math.round((new Date(from + "T12:00:00Z") - new Date(iso + "T12:00:00Z")) / 864e5);
}

// Stable id: text stripped of stamps/tags, then a small stable hash. The server
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

// Strip stamps/tags/wikilinks down to the human label.
function taskLabel(body) {
  let label = body.replace(DUE_RE, "").replace(DONE_RE, "").replace(PRIORITY_RE, "");
  label = label.replace(/(?:^|\s)#[A-Za-z0-9_/-]+/g, "");
  label = label.replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, "$1");
  return label.split(/\s+/).join(" ").trim();
}

export function parseTasks(text) {
  const out = [];
  const t = today();
  for (const tl of taskLines(text.split("\n"))) {
    const m = tl.m;
    const checked = m[2].toLowerCase() === "x";
    const body = m[3];
    const dueM = body.match(DUE_RE);
    const due = dueM ? dueM[1] : null;
    const doneM = body.match(DONE_RE);
    const tags = [...body.matchAll(TAG_RE)].map((x) => x[1]);
    out.push({
      id: tl.id,
      text: taskLabel(body),
      done: checked,
      due,
      completed: doneM ? doneM[1] : null,
      tags,
      area: tags.find((g) => AREAS.includes(g)) || null,
      overdue: !!(due && !checked && due < t),
      today: !!(due && !checked && due === t),
      priority: HIGH_RE.test(body),
    });
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
  const sm = text.match(/## What to know\s*\n([\s\S]*?)(?=\n##\s|\n*$)/);
  if (sm) summary = sm[1].trim().split("\n").filter(Boolean).join(" ");
  return { name, tags, updated, summary };
}

// Dated fragments under "## Log" — newest first. These are the truth (golden
// rule 2), so the person drawer shows them verbatim with their capture dates.
function parseLog(text) {
  const sec = text.match(/##\s*Log\s*\n([\s\S]*?)(?=\n##\s|$)/i);
  if (!sec) return [];
  const out = [];
  for (const line of sec[1].split("\n")) {
    const m = line.match(/^-\s+(\d{4}-\d{2}-\d{2})\s*—\s*(.+)$/);
    if (m) out.push({ date: m[1], text: m[2].replace(/\s*_\(surfaced:[^)]*\)_\s*$/, "").trim() });
  }
  return out.reverse();
}

/* -------------------------------------------------------------- entity reads */

function slugify(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function readEntities(store, folder) {
  const files = await store.listDir(folder);
  const items = [];
  for (const f of files) {
    if (!f.name.endsWith(".md") || f.name.startsWith("_")) continue;
    const file = await store.readFile(f.path);
    if (!file) continue;
    const e = parseEntity(file.text, f.name.slice(0, -3));
    const log = parseLog(file.text);
    items.push({
      ...e,
      path: f.path,
      slug: f.name.slice(0, -3),
      fragments: log.length,
      // "last heard" drives the People card's real job: who has gone quiet.
      last: log.length ? log[0].date : null,
      silentDays: log.length ? daysAgo(log[0].date) : null,
    });
  }
  return items;
}

async function readOccasions(store) {
  const files = await store.listDir("people");
  const out = [];
  const t = today();
  for (const f of files) {
    if (!f.name.endsWith(".md")) continue;
    const file = await store.readFile(f.path);
    if (!file) continue;
    for (const m of file.text.matchAll(OCCASION_RE)) {
      if (m[1] >= t) out.push({ date: m[1], text: m[2].trim(), who: f.name.slice(0, -3) });
    }
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

/* -------------------------------------------------------------- digests */

const BRIEF_RE = /^(\d{4}-\d{2}-\d{2})-(morning|evening)\.md$/;

// Newest morning/evening digest. A bare name sort would rank
// 2026-W29-interests.md above every dated brief ('W' > '0') and put "evening"
// below "morning" within a day, so sort on the parsed parts.
function sortBriefs(files) {
  return files
    .map((f) => ({ f, m: f.name.match(BRIEF_RE) }))
    .filter((x) => x.m)
    .sort((a, b) =>
      a.m[1].localeCompare(b.m[1]) ||
      (a.m[2] === "evening" ? 1 : 0) - (b.m[2] === "evening" ? 1 : 0)
    );
}

async function latestBrief(store) {
  const briefs = sortBriefs(await store.listDir("digests"));
  if (!briefs.length) return null;
  const newest = briefs[briefs.length - 1].f;
  const file = await store.readFile(newest.path);
  return file ? { name: newest.name, path: newest.path, text: file.text } : null;
}

/* -------------------------------------------------------------- skill runs */

// A skill's newest output, recovered from digests/ when the runner recorded
// none. run-skill.sh diffs `git status` for changed .md files — when the
// scheduled workflow commits the brief before the status is written, `outputs`
// comes back empty and the dashboard's Open button greys out even though the
// brief is sitting right there. This maps skill -> its known output pattern.
const SKILL_OUTPUT = {
  "morning-brief": (files) => newestMatching(files, /-morning\.md$/),
  "evening-brief": (files) => newestMatching(files, /-evening\.md$/),
  "interest-scout": (files) => newestMatching(files, /-W\d{2}-interests\.md$/),
};
function newestMatching(files, re) {
  const hits = files.filter((f) => re.test(f.name)).sort((a, b) => a.name.localeCompare(b.name));
  return hits.length ? hits[hits.length - 1].path : null;
}

// Skill run status: one <skill>.status file per skill in inbox/_runs/, plus any
// unclaimed .run triggers (which tell us something is queued but not yet run).
async function readSkills(store) {
  const files = await store.listDir("inbox/_runs");
  const digests = await store.listDir("digests");
  const status = {};
  for (const f of files) {
    if (!f.name.endsWith(".status")) continue;
    const file = await store.readFile(f.path);
    if (!file) continue;
    try {
      status[f.name.replace(/\.status$/, "")] = JSON.parse(file.text);
    } catch { /* ignore malformed status */ }
  }
  // Backfill missing outputs so Open is never greyed out over a bookkeeping gap.
  for (const [name, st] of Object.entries(status)) {
    if ((!st.outputs || !st.outputs.length) && SKILL_OUTPUT[name]) {
      const p = SKILL_OUTPUT[name](digests);
      if (p) { st.outputs = [p]; st.inferred = true; }
    }
  }
  // Queued-but-unclaimed triggers: <skill>-<stamp>.run still sitting in _runs.
  for (const f of files) {
    if (!f.name.endsWith(".run")) continue;
    const m = f.name.match(/^(.+)-(\d{4}-\d{2}-\d{2})T(\d{6})\.run$/);
    if (!m) continue;
    const iso = `${m[2]}T${m[3].slice(0, 2)}:${m[3].slice(2, 4)}:${m[3].slice(4, 6)}`;
    const st = (status[m[1]] = status[m[1]] || {});
    // Keep the earliest outstanding request — that is the one that is late.
    if (!st.queued || iso < st.queued) st.queued = iso;
  }
  return status;
}

/* ------------------------------------------------------------------ habits */
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

function parseHabitLog(logText) {
  const byHabit = {};
  for (const m of logText.matchAll(/^- (\d{4}-\d{2}-\d{2}) — ([^/\n]+?) \//gm)) {
    (byHabit[m[2].trim()] = byHabit[m[2].trim()] || new Set()).add(m[1]);
  }
  return byHabit;
}

// Streak: consecutive days (ending today or yesterday) with at least one
// logged completion. `history` is the last 14 days as booleans, oldest first —
// the dashboard draws it so a broken streak is visible, not just a number.
function habitStats(byHabit) {
  const stats = {};
  const dayMs = 864e5;
  const t = new Date(today() + "T12:00:00Z").getTime();
  for (const [name, days] of Object.entries(byHabit)) {
    let streak = 0;
    let d = days.has(today()) ? t : t - dayMs;
    while (days.has(new Date(d).toISOString().slice(0, 10))) { streak++; d -= dayMs; }
    const history = [];
    for (let i = 13; i >= 0; i--) history.push(days.has(new Date(t - i * dayMs).toISOString().slice(0, 10)));
    stats[name] = { streak, history, days30: [...days].filter((x) => daysAgo(x) < 30).length };
  }
  return stats;
}

async function readHabits(store) {
  const file = await store.readFile("habits.md");
  if (!file) return [];
  const habits = parseHabits(file.text);
  if (!habits.length) return [];
  const log = await store.readFile("habits-log.md");
  const stats = habitStats(log ? parseHabitLog(log.text) : {});
  return habits.map((h) => ({
    ...h,
    streak: (stats[h.name] || {}).streak || 0,
    history: (stats[h.name] || {}).history || new Array(14).fill(false),
    days30: (stats[h.name] || {}).days30 || 0,
  }));
}

// Toggle one habit sub-item for today. Resets the whole file first if the
// day marker is stale, and appends completions to habits-log.md.
async function toggleHabit(store, habit, item) {
  habit = String(habit || "").trim();
  item = String(item || "").trim();
  if (!habit || !item) return false;
  const cur = await store.readFile("habits.md");
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
  await store.putFile("habits.md", lines.join("\n"), "dashboard: habit", cur.sha);
  if (toggledOn) {
    const log = await store.readFile("habits-log.md");
    const entry = `- ${today()} — ${habit} / ${item}`;
    const base = log ? log.text.replace(/\s*$/, "") : "# Habits log";
    if (!base.includes(entry)) {
      await store.putFile("habits-log.md", base + "\n" + entry + "\n", "dashboard: habit log", log && log.sha);
    }
  }
  return true;
}

/* ------------------------------------------------------------------- inbox */

// Raw, unfiled captures sitting in inbox/ (excludes _archive / _runs). The
// dashboard shows what they SAY, not just how many — a bare count of five is
// not something you can act on.
async function readInbox(store) {
  const files = await store.listDir("inbox");
  const out = [];
  for (const f of files) {
    if (!f.name.endsWith(".md") || f.name.startsWith("_")) continue;
    const file = await store.readFile(f.path);
    const text = file ? file.text.trim() : "";
    out.push({
      path: f.path,
      when: f.name.slice(0, 19).replace(/T(\d{2})(\d{2})(\d{2})/, "T$1:$2:$3"),
      text: text.length > 140 ? text.slice(0, 140) + "…" : text,
    });
  }
  return out.sort((a, b) => b.when.localeCompare(a.when));
}

/* --------------------------------------------------------------- lessons */
// The self-improvement loop. Every thumbs-down / "not useful" the dashboard
// records lands here as a dated line, and the skills read this file before they
// generate. Append-only: a lesson is never rewritten, only superseded.

const LESSONS_PATH = "_meta/lessons.md";

async function readLessons(store) {
  const f = await store.readFile(LESSONS_PATH);
  if (!f) return [];
  const out = [];
  for (const m of f.text.matchAll(/^- (\d{4}-\d{2}-\d{2}) — \[([^\]]+)\] (more like|less like|note): (.+)$/gm)) {
    out.push({ date: m[1], scope: m[2], verdict: m[3], text: m[4].trim() });
  }
  return out.reverse();
}

async function addLesson(store, scope, text, verdict) {
  scope = String(scope || "general").trim().slice(0, 80);
  text = String(text || "").trim();
  if (!text) return false;
  const cur = await store.readFile(LESSONS_PATH);
  const head = "# Lessons\n\nRouting and preference lessons, appended by the dashboard's feedback\ncontrols and read by the skills before they generate. Append-only.\n";
  const base = cur ? cur.text.replace(/\s*$/, "") : head;
  const mark = verdict === "up" ? "more like" : verdict === "down" ? "less like" : "note";
  const line = `- ${today()} — [${scope}] ${mark}: ${text}`;
  await store.putFile(LESSONS_PATH, base + "\n" + line + "\n", "dashboard: lesson", cur && cur.sha);
  return true;
}

/* -------------------------------------------------------------- assembly */

async function buildData(store) {
  const tasksFile = await store.readFile("tasks.md");
  const [projects, people, occasions, brief, skills, inbox, habits, lessons] = await Promise.all([
    readEntities(store, "projects"),
    readEntities(store, "people"),
    readOccasions(store),
    latestBrief(store),
    readSkills(store),
    readInbox(store),
    readHabits(store),
    readLessons(store),
  ]);
  return {
    generated: new Date().toISOString(),
    today: today(),
    tasks: tasksFile ? parseTasks(tasksFile.text) : [],
    projects,
    people,
    occasions,
    brief,
    skills,
    inbox,
    habits,
    lessons: lessons.slice(0, 20),
    lessonCount: lessons.length,
  };
}

/* ------------------------------------------------------------------ writes */

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

async function capture(store, text) {
  text = (text || "").trim();
  if (!text) return false;
  await store.putFile(`inbox/${stamp()}-${rand()}.md`, text + "\n", "dashboard: capture");
  return true;
}

function taskLine(text, due, tag, priority) {
  let line = `- [ ] ${text}`;
  if (tag) { tag = String(tag).replace(/^#/, "").trim(); if (tag) line += ` #${tag}`; }
  if (priority) line += " ⏫";
  if (due && /^\d{4}-\d{2}-\d{2}$/.test(String(due).trim())) line += ` 📅 ${String(due).trim()}`;
  return line;
}

async function addTask(store, text, due, tag, priority) {
  text = (text || "").trim();
  if (!text) return false;
  const cur = await store.readFile("tasks.md");
  const base = cur ? cur.text.replace(/\n+$/, "") : "# Tasks";
  await store.putFile("tasks.md", base + "\n" + taskLine(text, due, tag, priority) + "\n",
    "dashboard: add task", cur && cur.sha);
  return true;
}

// Shared read-modify-write over one task line. `fn(body, m)` returns the new
// body, or null to leave the file untouched.
async function editTaskLine(store, id, message, fn) {
  const cur = await store.readFile("tasks.md");
  if (!cur) return false;
  const lines = cur.text.split("\n");
  const tl = taskLines(lines).find((t) => t.id === String(id));
  if (!tl) return false;
  const next = fn(tl.m[3], tl.m);
  if (next === null) return false;
  if (next === false) lines.splice(tl.idx, 1);                       // delete
  else lines[tl.idx] = `${tl.m[1]}- [${tl.m[2]}] ${next}`;
  await store.putFile("tasks.md", lines.join("\n"), message, cur.sha);
  return true;
}

// Toggle the checkbox and the ✅ stamp in one write (doing it as two store
// round-trips would race the sha and cost an extra commit).
async function toggleTask(store, id) {
  const cur = await store.readFile("tasks.md");
  if (!cur) return false;
  const lines = cur.text.split("\n");
  const tl = taskLines(lines).find((t) => t.id === String(id));
  if (!tl) return false;
  const wasDone = tl.m[2].toLowerCase() === "x";
  const body = wasDone
    ? tl.m[3].replace(DONE_RE, "").replace(/\s{2,}/g, " ").replace(/\s+$/, "")
    : tl.m[3].replace(/\s+$/, "") + ` ✅ ${today()}`;
  lines[tl.idx] = `${tl.m[1]}- [${wasDone ? " " : "x"}] ${body}`;
  await store.putFile("tasks.md", lines.join("\n"), "dashboard: toggle task", cur.sha);
  return true;
}

async function setPriority(store, id) {
  return editTaskLine(store, id, "dashboard: toggle priority", (body) => {
    const had = HIGH_RE.test(body);
    const clean = body.replace(PRIORITY_RE, "").replace(/\s{2,}/g, " ").replace(/\s+$/, "");
    return had ? clean : clean + " ⏫";
  });
}

// Reschedule: set, change, or (with due=null) clear the 📅 stamp.
async function rescheduleTask(store, id, due) {
  if (due && !/^\d{4}-\d{2}-\d{2}$/.test(String(due))) return false;
  return editTaskLine(store, id, "dashboard: reschedule task", (body) => {
    const clean = body.replace(DUE_RE, "").replace(/\s{2,}/g, " ").replace(/\s+$/, "");
    return due ? `${clean} 📅 ${due}` : clean;
  });
}

/**
 * Edit title, due date and area in ONE write.
 *
 * This has to be atomic, and not for performance: a task's id is a hash of its
 * text, so the moment a retitle lands the id the caller holds is stale and any
 * follow-up reschedule silently matches nothing. Three sequential calls looked
 * like they worked and quietly dropped two thirds of the edit.
 *
 * Fields absent from the payload are left alone; `due: null` clears the date.
 */
async function editTask(store, id, fields) {
  const has = (k) => Object.prototype.hasOwnProperty.call(fields, k);
  if (has("due") && fields.due && !/^\d{4}-\d{2}-\d{2}$/.test(String(fields.due))) return false;
  const tag = has("tag") ? String(fields.tag || "").replace(/^#/, "").trim() : null;
  if (tag && !AREAS.includes(tag)) return false;

  return editTaskLine(store, id, "dashboard: edit task", (body) => {
    const title = has("text") && String(fields.text).trim()
      ? String(fields.text).trim()
      : taskLabel(body);
    const dueM = body.match(DUE_RE);
    const due = has("due") ? fields.due : (dueM ? dueM[1] : null);
    const doneM = body.match(DONE_RE);
    // Keep any non-area tags the vault or a skill put there.
    const keptTags = [...body.matchAll(TAG_RE)].map((x) => x[1]).filter((t) => !AREAS.includes(t));
    const area = has("tag") ? (tag ? [tag] : []) : [...body.matchAll(TAG_RE)].map((x) => x[1]).filter((t) => AREAS.includes(t));
    const parts = [title, ...area.map((t) => `#${t}`), ...keptTags.map((t) => `#${t}`)];
    if (HIGH_RE.test(body)) parts.push("⏫");
    if (due) parts.push(`📅 ${due}`);
    if (doneM) parts.push(doneM[0]);
    return parts.join(" ");
  });
}

// Delete is the one operation the golden rules forbid doing silently: the line
// is moved to notes/deleted-tasks.md with its date rather than dropped.
async function deleteTask(store, id) {
  const cur = await store.readFile("tasks.md");
  if (!cur) return false;
  const tl = taskLines(cur.text.split("\n")).find((t) => t.id === String(id));
  if (!tl) return false;
  const line = taskLabel(tl.m[3]);
  const bin = await store.readFile("notes/deleted-tasks.md");
  const base = bin ? bin.text.replace(/\s*$/, "")
    : "# Deleted tasks\n\nTasks removed from the dashboard. Never lost — golden rule 1.";
  await store.putFile("notes/deleted-tasks.md", `${base}\n- ${today()} — ${line}\n`,
    "dashboard: archive deleted task", bin && bin.sha);
  return editTaskLine(store, id, "dashboard: delete task", () => false);
}

async function reorderTasks(store, ids) {
  if (!Array.isArray(ids)) return false;
  const cur = await store.readFile("tasks.md");
  if (!cur) return false;
  const lines = cur.text.split("\n");
  const tl = taskLines(lines);
  const byId = {};
  for (const t of tl) byId[t.id] = t;
  const received = [];
  const seen = new Set();
  for (const raw of ids) {
    const id = String(raw);
    if (byId[id] && !seen.has(id)) { received.push(id); seen.add(id); }
  }
  if (!received.length) return true;
  const orderedLines = received.map((id) => lines[byId[id].idx]);
  const targetSlots = tl.filter((t) => seen.has(t.id)).map((t) => t.idx);
  targetSlots.forEach((idx, k) => { lines[idx] = orderedLines[k]; });
  await store.putFile("tasks.md", lines.join("\n"), "dashboard: reorder tasks", cur.sha);
  return true;
}

// Queue a skill run: a .run trigger file the runner (local or cloud) picks up.
// `input` (optional) is free text handed to the skill — used by Ask.
async function queueRun(store, skill, input) {
  skill = (skill || "").trim().replace(/[^a-z0-9-]/gi, "");
  if (!skill) return false;
  const payload = JSON.stringify(
    { skill, requested: new Date().toISOString(), by: "dashboard", input: String(input || "") },
    null, 2
  );
  await store.putFile(`inbox/_runs/${skill}-${stamp()}.run`, payload + "\n", `dashboard: run ${skill}`);
  return true;
}

// Append a dated fragment to a person's ## Log.
async function appendFragment(store, person, text) {
  person = String(person || "").trim();
  text = String(text || "").trim();
  if (!person || !text) return false;
  const path = `people/${slugify(person)}.md`;
  const cur = await store.readFile(path);
  if (!cur) return false;                       // never create a person from the dashboard
  const line = `- ${today()} — ${text} _(saved from dashboard)_`;
  let body = cur.text.replace(/\s*$/, "");
  body += /##\s*Log/i.test(body) ? `\n${line}\n` : `\n\n## Log\n${line}\n`;
  await store.putFile(path, body, `dashboard: log for ${person}`, cur.sha);
  return true;
}

// One person, in full: summary + every dated fragment + their occasions.
async function readPerson(store, slug) {
  slug = slugify(slug);
  if (!slug) return null;
  const path = `people/${slug}.md`;
  const f = await store.readFile(path);
  if (!f) return null;
  const e = parseEntity(f.text, slug);
  const log = parseLog(f.text);
  const occasions = [...f.text.matchAll(OCCASION_RE)]
    .map((m) => ({ date: m[1], text: m[2].trim() }))
    .sort((a, b) => a.date.localeCompare(b.date));
  return {
    ...e, slug, path, log, occasions,
    last: log.length ? log[0].date : null,
    silentDays: log.length ? daysAgo(log[0].date) : null,
  };
}

/* ------------------------------------------------------------------ health */
// Green ≠ done (golden rule 5). The dashboard's own honesty check: is the agent
// loop actually alive, or has it been quietly dead since Tuesday?

const EXPECTED = {
  "morning-brief": 1,      // daily
  "evening-brief": 1,      // daily
  "interest-scout": 7,     // weekly
};

async function health(store) {
  const skills = await readSkills(store);
  const checks = [];
  for (const [name, everyDays] of Object.entries(EXPECTED)) {
    const st = skills[name];
    const when = st && st.when ? st.when.slice(0, 10) : null;
    const age = when ? daysAgo(when) : null;
    checks.push({
      name,
      when: st ? st.when : null,
      ok: !!(st && st.ok !== false && age !== null && age <= everyDays),
      why: !st ? "never run" : st.ok === false ? "last run failed"
        : age === null ? "no timestamp" : age > everyDays ? `${age}d since last run` : "",
    });
  }
  // A trigger that has sat unclaimed for over 20 minutes means no runner is
  // listening — the single most useful thing this app can tell you.
  const stuck = [];
  for (const [name, st] of Object.entries(skills)) {
    if (!st.queued) continue;
    const mins = Math.round((Date.now() - new Date(st.queued + "Z").getTime()) / 60000);
    if (mins > 20) stuck.push({ name, queued: st.queued, mins });
  }
  const failing = checks.filter((c) => !c.ok);
  return {
    ok: !failing.length && !stuck.length,
    checks,
    stuck,
    summary: stuck.length ? `${stuck.length} run${stuck.length > 1 ? "s" : ""} queued with no runner`
      : failing.length ? `${failing.map((f) => f.name).join(", ")} overdue`
      : "all routines on schedule",
  };
}

/* ------------------------------------------------------------------ routing */

/**
 * The whole HTTP surface, host-agnostic.
 * Returns { status, body } — the host turns that into its own Response type.
 */
export function createApi(rawStore, hooks = {}) {
  // Normalise line endings once, at the boundary. Every parser here anchors on
  // `$`, and JS treats \r as a line terminator that `.` will not match — so a
  // single CRLF file makes tasks.md and habits.md silently parse to nothing.
  // A Windows checkout produces exactly that. Writes always go out as LF.
  const store = {
    listDir: (p) => rawStore.listDir(p),
    putFile: (p, text, msg, sha) => rawStore.putFile(p, text.replace(/\r\n/g, "\n"), msg, sha),
    async readFile(p) {
      const f = await rawStore.readFile(p);
      return f ? { ...f, text: f.text.replace(/\r\n/g, "\n") } : null;
    },
  };

  return async function handle(method, path, params, payload) {
    if (method === "GET") {
      if (path === "/api/data") return { status: 200, body: await buildData(store) };
      if (path === "/api/health") return { status: 200, body: await health(store) };
      if (path === "/api/person") {
        const p = await readPerson(store, params.get("slug") || "");
        return p ? { status: 200, body: p } : { status: 404, body: { error: "not found" } };
      }
      if (path === "/api/lessons") return { status: 200, body: { lessons: await readLessons(store) } };
      if (path === "/api/file") {
        const p = params.get("path") || "";
        // Sanitize: relative vault paths only, no traversal, must be markdown.
        if (!p || p.startsWith("/") || p.includes("..") || !p.endsWith(".md")) {
          return { status: 400, body: { error: "bad path" } };
        }
        const f = await store.readFile(p);
        return f ? { status: 200, body: { path: p, text: f.text } }
          : { status: 404, body: { error: "not found" } };
      }
      if (path === "/api/push-key" && hooks.pushKey) return { status: 200, body: { key: hooks.pushKey() } };
      return { status: 404, body: { error: "not found" } };
    }

    if (method === "POST") {
      const p = payload || {};
      let ok;
      switch (path) {
        case "/api/capture":    ok = await capture(store, p.text); break;
        case "/api/task":       ok = await addTask(store, p.text, p.due, p.tag, p.priority); break;
        case "/api/toggle":     ok = await toggleTask(store, p.id); break;
        case "/api/priority":   ok = await setPriority(store, p.id); break;
        case "/api/edit":       ok = await editTask(store, p.id, p.fields || {}); break;
        case "/api/reschedule": ok = await rescheduleTask(store, p.id, p.due || null); break;
        case "/api/delete":     ok = await deleteTask(store, p.id); break;
        case "/api/reorder":    ok = await reorderTasks(store, p.ids); break;
        case "/api/run":        ok = await queueRun(store, p.skill, p.input); break;
        case "/api/append":     ok = await appendFragment(store, p.person, p.text); break;
        case "/api/habit":      ok = await toggleHabit(store, p.habit, p.item); break;
        case "/api/lesson":     ok = await addLesson(store, p.scope, p.text, p.verdict); break;
        default:
          if (hooks.post) {
            const r = await hooks.post(path, p);
            if (r) return r;
          }
          return { status: 404, body: { error: "not found" } };
      }
      return { status: 200, body: { ok } };
    }

    return { status: 404, body: { error: "not found" } };
  };
}
