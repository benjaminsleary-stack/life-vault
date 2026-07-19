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
 *
 * Subscribed .ics calendar feeds are passed in as `hooks.calendars`, since their
 * URLs are credentials and belong in the host's secret store, never here.
 */

import { parseICS, expandEvents } from "./ical.js";

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

// The morning brief's anti-nag counter (CLAUDE.md rule 3): it increments ⏳<n>
// on an overdue task and drops it from the brief after three. It is bookkeeping,
// so it must survive in the file but never appear in the title — "Reply to dad
// ⏳2" was reaching the screen exactly like the project slug did.
const NAG_RE = /⏳\s*\d*/gu;

// Strip stamps/tags/wikilinks down to the human label.
function taskLabel(body) {
  let label = body.replace(DUE_RE, "").replace(DONE_RE, "").replace(PRIORITY_RE, "").replace(NAG_RE, "");
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
    // A task belongs to a project by wikilink, not by tag — the area tag list is
    // closed (CLAUDE.md), so "#project/house-retrofit" would be inventing one.
    // [[house-retrofit]] is how the vault already expresses "refers to".
    const links = [...body.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)].map((m) => m[1].trim());
    out.push({
      id: tl.id,
      text: taskLabel(body),
      // The title with its links intact. buildData needs this to drop the
      // PROJECT link from the display text while keeping [[Milo]] — taskLabel
      // unwraps every link to its bare text, which is right for a person and
      // wrong for a project, since "Insulate Milo's room house-retrofit" is not
      // a sentence anyone wrote.
      titleRaw: taskTitleRaw(body),
      links,
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

// Occasions live wherever they are written, not only on people notes. Fifteen
// acquaintances with a birthday each do not each warrant an entity note — they
// live in notes/birthdays.md — but their dates should still reach the agenda.
async function readOccasions(store) {
  const files = [...await store.listDir("people"), ...await store.listDir("notes")];
  const out = [];
  const t = today();
  for (const f of files) {
    if (!f.name.endsWith(".md")) continue;
    const file = await store.readFile(f.path);
    if (!file) continue;
    // A note's occasions belong to a person only if it IS a person note.
    const who = f.path.startsWith("people/") ? f.name.slice(0, -3) : null;
    for (const m of file.text.matchAll(OCCASION_RE)) {
      if (m[1] >= t) out.push({ date: m[1], text: m[2].trim(), who });
    }
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

/* ---------------------------------------------------------------- graph */

// The vault map: a node+edge graph of the vault's [[wikilinks]], so the
// dashboard can draw an Obsidian-style "map of content". Nodes are the notes in
// maps/ (areas), people/, projects/ and notes/; edges are the wikilink
// references between them (a [[target]] that has no file still gets a light
// node, so orphan mentions are visible). record_count is each node's degree,
// used to size it. Read-only and store-agnostic (works on the Worker and the
// local dev server alike).
const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;
const linkTarget = (raw) => String(raw).split(/[|#]/)[0].trim();
const graphSlug = (s) => String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const prettyName = (slug) => String(slug).replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

async function buildGraph(store) {
  const FOLDERS = [["maps", "area"], ["people", "person"], ["projects", "project"], ["notes", "topic"]];
  const nodes = new Map();
  const edgeSet = new Set();
  const edges = [];
  const ensure = (id, name, type) => {
    let n = nodes.get(id);
    if (!n) { n = { id, name: name || prettyName(id), type: type || "topic", record_count: 0 }; nodes.set(id, n); }
    else if (type && type !== "topic" && n.type === "topic") { n.type = type; if (name) n.name = name; }
    return n;
  };
  const filed = [];
  for (const [folder, type] of FOLDERS) {
    let files = [];
    try { files = await store.listDir(folder); } catch { files = []; }
    for (const f of files) {
      if (!f.name.endsWith(".md") || f.name.startsWith("_")) continue;
      const slug = f.name.slice(0, -3);
      const id = graphSlug(slug);
      let name = prettyName(slug);
      const file = await store.readFile(f.path);
      const nm = file && file.text.match(/^name:\s*(.+)$/m);
      if (nm) name = nm[1].trim();
      ensure(id, name, type);
      filed.push({ id, text: file ? file.text : "" });
    }
  }
  for (const fl of filed) {
    const src = nodes.get(fl.id);
    const seen = new Set();
    for (const m of fl.text.matchAll(WIKILINK_RE)) {
      const raw = linkTarget(m[1]);
      const tid = graphSlug(raw);
      if (!tid || tid === fl.id || seen.has(tid)) continue;
      seen.add(tid);
      const tgt = ensure(tid, prettyName(raw), "topic");
      const key = fl.id < tid ? `${fl.id}|${tid}` : `${tid}|${fl.id}`;
      if (!edgeSet.has(key)) { edgeSet.add(key); edges.push({ from: fl.id, to: tid }); }
      src.record_count++; tgt.record_count++;
    }
  }
  return { nodes: [...nodes.values()], edges };
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

/* ------------------------------------------------- editing the habit list */
// habits.md was hand-edited only: the app could tick a habit but never add,
// rename or retire one, so changing what you track meant opening Obsidian.
//
// Removing a habit or an item never touches habits-log.md. The log is
// append-only history (golden rule 1) — retiring a habit stops the tracking,
// it does not unmake the fortnight you did it.

const HABITS_HEAD = "# Habits\n";

async function habitsFile(store) {
  const cur = await store.readFile("habits.md");
  if (cur) return cur;
  return { text: `${HABITS_HEAD}\n(day:: ${today()})\n`, sha: undefined };
}

async function addHabitGroup(store, name) {
  name = String(name || "").trim().replace(/^#+\s*/, "");
  if (!name) return false;
  const cur = await habitsFile(store);
  if (new RegExp(`^##\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m").test(cur.text)) return false;
  const body = cur.text.replace(/\s*$/, "") + `\n\n## ${name}\n`;
  await store.putFile("habits.md", body, `dashboard: add habit ${name}`, cur.sha);
  return true;
}

async function addHabitItem(store, habit, text) {
  habit = String(habit || "").trim();
  text = String(text || "").trim();
  if (!habit || !text) return false;
  const cur = await store.readFile("habits.md");
  if (!cur) return false;
  const lines = cur.text.split("\n");
  let inSection = false, insertAt = -1;
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^##\s+(.+?)\s*$/);
    if (h) {
      if (inSection) break;                      // next section starts: insert above it
      inSection = h[1] === habit;
      if (inSection) insertAt = i + 1;
      continue;
    }
    if (inSection && TASK_RE.test(lines[i])) insertAt = i + 1;
  }
  if (insertAt < 0) return false;
  lines.splice(insertAt, 0, `- [ ] ${text}`);
  await store.putFile("habits.md", lines.join("\n"), `dashboard: add habit item`, cur.sha);
  return true;
}

async function removeHabitItem(store, habit, item) {
  habit = String(habit || "").trim();
  item = String(item || "").trim();
  if (!habit || !item) return false;
  const cur = await store.readFile("habits.md");
  if (!cur) return false;
  const lines = cur.text.split("\n");
  let inSection = false;
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^##\s+(.+?)\s*$/);
    if (h) { inSection = h[1] === habit; continue; }
    if (!inSection) continue;
    const m = lines[i].match(TASK_RE);
    if (!m || m[3].trim() !== item) continue;
    lines.splice(i, 1);
    await store.putFile("habits.md", lines.join("\n"), "dashboard: remove habit item", cur.sha);
    return true;
  }
  return false;
}

async function removeHabitGroup(store, habit) {
  habit = String(habit || "").trim();
  if (!habit) return false;
  const cur = await store.readFile("habits.md");
  if (!cur) return false;
  const lines = cur.text.split("\n");
  const start = lines.findIndex((l) => (l.match(/^##\s+(.+?)\s*$/) || [])[1] === habit);
  if (start < 0) return false;
  let end = start + 1;
  while (end < lines.length && !/^##\s+/.test(lines[end])) end++;
  lines.splice(start, end - start);
  await store.putFile("habits.md", lines.join("\n").replace(/\n{3,}/g, "\n\n"),
    `dashboard: retire habit ${habit}`, cur.sha);
  return true;
}

async function renameHabitGroup(store, habit, name) {
  habit = String(habit || "").trim();
  name = String(name || "").trim().replace(/^#+\s*/, "");
  if (!habit || !name || habit === name) return false;
  const cur = await store.readFile("habits.md");
  if (!cur) return false;
  const lines = cur.text.split("\n");
  const i = lines.findIndex((l) => (l.match(/^##\s+(.+?)\s*$/) || [])[1] === habit);
  if (i < 0) return false;
  lines[i] = `## ${name}`;
  await store.putFile("habits.md", lines.join("\n"), `dashboard: rename habit`, cur.sha);
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
    // <ISO>-<rand>.md — match the stamp rather than slicing a fixed width, or
    // the random suffix bleeds into the timestamp.
    const m = f.name.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})(\d{2})(\d{2})/);
    out.push({
      path: f.path,
      when: m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}` : null,
      text: text.length > 140 ? text.slice(0, 140) + "…" : text,
    });
  }
  return out.sort((a, b) => String(b.when || "").localeCompare(String(a.when || "")));
}

/* ----------------------------------------------------------------- lists */
// Shopping lists and the like: notes with `type: list` in their frontmatter.
//
// Deliberately NOT tasks.md. A shopping list is consumed in one trip and then
// meaningless; in the task list it is permanent noise that never leaves and
// drags twenty items through every view. The vault already says lists live in
// notes/ — this marks them by frontmatter type, matching how people, projects
// and topics are distinguished, rather than adding a folder.

function parseListItems(text) {
  const items = [];
  for (const line of text.split("\n")) {
    const m = line.match(TASK_RE);
    if (m) items.push({ text: m[3].trim(), done: m[2].toLowerCase() === "x" });
  }
  return items;
}

async function readLists(store) {
  const files = await store.listDir("notes");
  const out = [];
  for (const f of files) {
    if (!f.name.endsWith(".md") || f.name.startsWith("_")) continue;
    const file = await store.readFile(f.path);
    if (!file || !/^---\n[\s\S]*?^type:\s*list\s*$/m.test(file.text)) continue;
    const e = parseEntity(file.text, f.name.slice(0, -3));
    const items = parseListItems(file.text);
    out.push({
      slug: f.name.slice(0, -3),
      name: e.name || f.name.slice(0, -3),
      tags: e.tags,
      items,
      open: items.filter((i) => !i.done).length,
      done: items.filter((i) => i.done).length,
    });
  }
  return out.sort((a, b) => b.open - a.open || a.name.localeCompare(b.name));
}

async function listPath(store, slug) {
  const s = slugify(slug);
  return s ? `notes/${s}.md` : null;
}

// Tick or untick one item. Matched on text, since a list has no stable ids and
// inventing some would mean rewriting the file the user edits in Obsidian.
async function toggleListItem(store, slug, item) {
  const path = await listPath(store, slug);
  const cur = path && await store.readFile(path);
  if (!cur) return false;
  const want = String(item || "").trim();
  const lines = cur.text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(TASK_RE);
    if (!m || m[3].trim() !== want) continue;
    lines[i] = `${m[1]}- [${m[2] === " " ? "x" : " "}] ${m[3]}`;
    await store.putFile(path, lines.join("\n"), `dashboard: ${slug}`, cur.sha);
    return true;
  }
  return false;
}

// Append items, one per line, in a single write. Same reasoning as bulk tasks.
async function addListItems(store, slug, lines) {
  const path = await listPath(store, slug);
  const cur = path && await store.readFile(path);
  if (!cur) return { added: 0 };
  const wanted = (Array.isArray(lines) ? lines : String(lines || "").split("\n"))
    .map((l) => String(l || "").replace(/^\s*[-*]\s*\[[ xX]\]\s*/, "").replace(/^\s*[-*]\s+/, "").trim())
    .filter(Boolean).slice(0, 200);
  if (!wanted.length) return { added: 0 };
  const have = new Set(parseListItems(cur.text).filter((i) => !i.done).map((i) => i.text.toLowerCase()));
  const fresh = wanted.filter((t) => !have.has(t.toLowerCase()) && have.add(t.toLowerCase()));
  if (!fresh.length) return { added: 0, skipped: wanted.length };
  const body = cur.text.replace(/\s*$/, "") + "\n" + fresh.map((t) => `- [ ] ${t}`).join("\n") + "\n";
  await store.putFile(path, body, `dashboard: add ${fresh.length} to ${slug}`, cur.sha);
  return { added: fresh.length, skipped: wanted.length - fresh.length };
}

// Clear the ticked items — the "I've done the shop" action. Removed items go to
// the note's own ## Cleared log rather than evaporating.
async function clearListDone(store, slug) {
  const path = await listPath(store, slug);
  const cur = path && await store.readFile(path);
  if (!cur) return { cleared: 0 };
  const keep = [], gone = [];
  for (const line of cur.text.split("\n")) {
    const m = line.match(TASK_RE);
    if (m && m[2].toLowerCase() === "x") gone.push(m[3].trim());
    else keep.push(line);
  }
  if (!gone.length) return { cleared: 0 };
  let body = keep.join("\n").replace(/\s*$/, "");
  body += `\n\n## Cleared ${today()}\n${gone.map((g) => `- ${g}`).join("\n")}\n`;
  await store.putFile(path, body, `dashboard: clear ${gone.length} from ${slug}`, cur.sha);
  return { cleared: gone.length };
}

async function createList(store, name) {
  name = String(name || "").trim();
  if (!name) return false;
  const slug = slugify(name);
  const path = `notes/${slug}.md`;
  if (await store.readFile(path)) return false;          // never clobber a note
  const body = `---\ntype: list\nname: ${name}\ntags: [admin]\nupdated: ${today()}\n---\n\n# ${name}\n\n`;
  await store.putFile(path, body, `dashboard: new list ${name}`);
  return true;
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

/* ---------------------------------------------------------------- calendar */
// Subscribed .ics feeds (work Outlook, personal Google). Read-only: the vault
// is the source of truth for tasks and occasions, the calendar is not, so
// nothing here writes back. The app turns an event into a task or a note
// instead, which lands in the vault where it belongs.

const CAL_TTL_MS = 15 * 60 * 1000;
const calCache = new Map();                    // url -> { at, events }

// The work feed is ~1MB and /api/data is polled every 60s, so it is cached for
// CAL_TTL_MS. That cache is the ONLY thing standing between a change in Outlook
// and this app: Exchange regenerates the published .ics per request (its
// DTSTAMPs equal the fetch time), so the feed itself is never stale.
//
// It cannot be revalidated cheaply either — Microsoft returns no ETag,
// Last-Modified or Cache-Control on this URL, so a conditional request is
// impossible and every refresh is a full megabyte. Hence a TTL, and an explicit
// bypass for when you have just added something and want to see it now.
async function fetchCalendar(feed, force) {
  const hit = calCache.get(feed.url);
  if (!force && hit && Date.now() - hit.at < CAL_TTL_MS) return hit;
  const r = await fetch(feed.url, {
    headers: { "User-Agent": "life-vault-dashboard" },
    cf: force ? { cacheTtl: 0 } : { cacheTtl: 900, cacheEverything: true },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const entry = { at: Date.now(), events: parseICS(await r.text()) };
  calCache.set(feed.url, entry);
  return entry;
}

// Calendar titles that are private markers, not appointments. They are the
// user's own shorthand — "That week" tracks Charlotte's cycle — and must not
// reach the agenda or a brief, exactly like a ## Private note (CLAUDE.md). The
// event stays on the calendar; it just never surfaces here.
const PRIVATE_EVENT = /^that week$/i;

async function readCalendar(feeds, fromDay, toDay, force) {
  if (!feeds || !feeds.length) return { events: [], sources: [] };
  const events = [];
  const sources = [];
  // One broken feed must not take the whole dashboard down with it — the app
  // says which source failed and still renders the rest.
  await Promise.all(feeds.map(async (feed) => {
    try {
      const entry = await fetchCalendar(feed, force);
      // Expanding recurrences costs real CPU, and a Worker's budget is measured
      // in milliseconds — so the expanded window is memoised alongside the
      // parse. Without this every poll re-expanded the whole calendar and the
      // steady-state cost of a cache HIT was still tens of milliseconds.
      const key = `${fromDay}|${toDay}`;
      if (entry.window !== key) {
        entry.expanded = expandEvents(entry.events, fromDay, toDay)
          .filter((o) => !PRIVATE_EVENT.test(o.title.trim()))
          .map((o) => ({ ...o, source: feed.name }));
        entry.window = key;
      }
      for (const occ of entry.expanded) events.push(occ);
      sources.push({ name: feed.name, ok: true, fetched: new Date(entry.at).toISOString(), ageMs: Date.now() - entry.at });
    } catch (e) {
      sources.push({ name: feed.name, ok: false, error: String((e && e.message) || e) });
    }
  }));
  events.sort((a, b) =>
    a.date.localeCompare(b.date) ||
    (a.allDay === b.allDay ? String(a.time).localeCompare(String(b.time)) : (a.allDay ? -1 : 1))
  );
  return { events, sources };
}

/* -------------------------------------------------------------- assembly */

// How far the agenda looks. Matches the dashboard's own horizon.
const AGENDA_DAYS = 14;

async function buildData(store, feeds, forceCalendar) {
  const tasksFile = await store.readFile("tasks.md");
  const horizon = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" })
    .format(new Date(Date.now() + AGENDA_DAYS * 864e5));
  const [projects, people, occasions, brief, skills, inbox, habits, lessons, calendar, lists] = await Promise.all([
    readEntities(store, "projects"),
    readEntities(store, "people"),
    readOccasions(store),
    latestBrief(store),
    readSkills(store),
    readInbox(store),
    readHabits(store),
    readLessons(store),
    readCalendar(feeds, today(), horizon, forceCalendar),
    readLists(store),
  ]);
  const tasks = tasksFile ? parseTasks(tasksFile.text) : [];
  // Resolve each task's [[wikilinks]] against the projects that actually exist,
  // so a link to a note that isn't a project doesn't invent one.
  const bySlug = new Map();
  for (const p of projects) {
    bySlug.set(p.slug.toLowerCase(), p.slug);
    if (p.name) bySlug.set(slugify(p.name), p.slug);
  }
  for (const t of tasks) {
    t.project = (t.links || []).map((l) => bySlug.get(slugify(l)) || bySlug.get(l.toLowerCase()))
      .find(Boolean) || null;
    // A project link is metadata, not part of the sentence — remove it from the
    // display title, then unwrap the links that ARE part of it.
    if (t.project && t.titleRaw) {
      t.text = t.titleRaw
        .replace(/\s*\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, (m, target) =>
          (bySlug.get(slugify(target)) || bySlug.get(target.toLowerCase())) ? "" : m)
        .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, "$1")
        .replace(/\s{2,}/g, " ").trim();
    }
    delete t.titleRaw;
  }
  for (const p of projects) {
    const mine = tasks.filter((t) => t.project === p.slug);
    p.openTasks = mine.filter((t) => !t.done).length;
    p.doneTasks = mine.filter((t) => t.done).length;
  }

  return {
    generated: new Date().toISOString(),
    today: today(),
    tasks,
    projects,
    people,
    occasions,
    brief,
    skills,
    inbox,
    habits,
    lessons: lessons.slice(0, 20),
    lessonCount: lessons.length,
    calendar: calendar.events,
    calendarSources: calendar.sources,
    lists,
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

/* ------------------------------------------------- completed-task decay */

// How long a ticked task stays in tasks.md before it is filed away. Long enough
// to see what you did and to undo a mistaken tick; short enough that the list
// does not become a graveyard.
const RETAIN_DONE_DAYS = 3;
const DONE_ARCHIVE = "notes/completed-tasks.md";

// Split ticked-and-stale lines out of tasks.md. Only lines carrying a ✅ stamp
// are eligible: a task ticked in Obsidian without one has no date to judge, so
// it stays rather than being swept on a guess.
function splitStaleDone(lines) {
  const keep = [], stale = [];
  for (const line of lines) {
    const m = line.match(TASK_RE);
    if (!m || m[2].toLowerCase() !== "x") { keep.push(line); continue; }
    const done = m[3].match(DONE_RE);
    if (done && daysAgo(done[1]) >= RETAIN_DONE_DAYS) stale.push({ line, date: done[1], text: taskLabel(m[3]) });
    else keep.push(line);
  }
  return { keep, stale };
}

/**
 * The single writer for tasks.md.
 *
 * Every path that rewrites the file goes through here so the decay rule is
 * applied in exactly one place. Completed tasks are MOVED, never dropped —
 * golden rule 1 — into notes/completed-tasks.md with the date they were done,
 * so the record of what you got through survives the list being tidy.
 *
 * The archive is a second file, so its write cannot collide with the tasks.md
 * sha, and it is appended after the main write: if the archive write fails, the
 * worst case is a task that stays in the list a day longer, not one that
 * vanishes.
 */
async function writeTasks(store, lines, message, sha) {
  const { keep, stale } = splitStaleDone(lines);
  await store.putFile("tasks.md", keep.join("\n"), message, sha);
  if (!stale.length) return 0;
  const cur = await store.readFile(DONE_ARCHIVE);
  const head = "# Completed tasks\n\nTicked tasks, filed here " +
    `${RETAIN_DONE_DAYS} days after completion so tasks.md stays current. ` +
    "Nothing is deleted — golden rule 1.";
  const base = cur ? cur.text.replace(/\s*$/, "") : head;
  const added = stale.map((s) => `- ${s.date} — ${s.text}`).join("\n");
  await store.putFile(DONE_ARCHIVE, base + "\n" + added + "\n",
    `dashboard: file ${stale.length} completed task${stale.length > 1 ? "s" : ""}`, cur && cur.sha);
  return stale.length;
}

function taskLine(text, due, tag, priority, project) {
  let line = `- [ ] ${text}`;
  if (project) line += ` [[${String(project).trim()}]]`;
  if (tag) { tag = String(tag).replace(/^#/, "").trim(); if (tag) line += ` #${tag}`; }
  if (priority) line += " ⏫";
  if (due && /^\d{4}-\d{2}-\d{2}$/.test(String(due).trim())) line += ` 📅 ${String(due).trim()}`;
  return line;
}

async function addTask(store, text, due, tag, priority, project) {
  text = (text || "").trim();
  if (!text) return false;
  const cur = await store.readFile("tasks.md");
  const base = cur ? cur.text.replace(/\n+$/, "") : "# Tasks";
  await writeTasks(store, (base + "\n" + taskLine(text, due, tag, priority, project)).split("\n"),
    "dashboard: add task", cur && cur.sha);
  return true;
}

/**
 * Add many tasks in ONE write.
 *
 * The point is the single commit. Twenty tasks added one at a time is twenty
 * GitHub round-trips, each re-reading and re-writing tasks.md — slow, and every
 * one of them a chance to collide with a routine writing the same file. It also
 * means twenty commits in the vault history for one action.
 *
 * Already-present open tasks are skipped, so re-pasting a list you have partly
 * entered does not duplicate it.
 */
async function addTasks(store, lines, due, tag, project) {
  const wanted = (Array.isArray(lines) ? lines : String(lines || "").split("\n"))
    .map((l) => String(l || "").replace(/^\s*[-*]\s*\[[ xX]\]\s*/, "").replace(/^\s*[-*]\s+/, "").trim())
    .filter(Boolean)
    .slice(0, 200);                       // a runaway paste is not a feature
  if (!wanted.length) return { added: 0, skipped: 0 };

  const cur = await store.readFile("tasks.md");
  const text = cur ? cur.text : "# Tasks";
  const existing = new Set(parseTasks(text).filter((t) => !t.done).map((t) => coreText(t.text)));

  const fresh = [];
  let skipped = 0;
  for (const t of wanted) {
    const key = coreText(t);
    if (existing.has(key)) { skipped++; continue; }
    existing.add(key);                    // also de-dupes within the paste itself
    fresh.push(taskLine(t, due, tag, false, project));
  }
  if (!fresh.length) return { added: 0, skipped };

  await writeTasks(store, (text.replace(/\n+$/, "") + "\n" + fresh.join("\n")).split("\n"),
    `dashboard: add ${fresh.length} tasks`, cur && cur.sha);
  return { added: fresh.length, skipped };
}

// Shared read-modify-write over one task line. `fn(body, m)` returns the new
// body, or null to leave the file untouched.
const LINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
const linksIn = (s) => [...String(s).matchAll(LINK_RE)].map((m) => m[1].trim());
const tagsIn = (s) => [...String(s).matchAll(TAG_RE)].map((m) => m[1]);

/**
 * Refuse a rewrite that silently drops a link or tag.
 *
 * Twice in one sitting an edit destroyed something it was never asked to
 * touch — both times because a line was rebuilt from its DISPLAY form, and the
 * display form is lossy by design. Only the caller knows which links it means
 * to remove, so anything else disappearing is a bug, and this turns it into a
 * loud failure instead of a quiet one (golden rule 5).
 */
export function assertNothingLost(before, after, mayRemove = []) {
  const allowed = new Set(mayRemove.map((s) => String(s).toLowerCase()));
  const lost = (kind, was, now) => {
    const left = [...now];
    const gone = [];
    for (const item of was) {
      const i = left.findIndex((x) => x.toLowerCase() === item.toLowerCase());
      if (i >= 0) left.splice(i, 1);
      else if (!allowed.has(item.toLowerCase())) gone.push(item);
    }
    if (gone.length) {
      throw new Error(
        `refusing to edit: would drop ${kind} ${gone.map((g) => `"${g}"`).join(", ")} — ` +
        `not requested. before: "${before}" after: "${after}"`
      );
    }
  };
  lost("wikilink", linksIn(before), linksIn(after));
  lost("tag", tagsIn(before), tagsIn(after));
}

/**
 * The one place a task line's body is rewritten.
 *
 * `fn(body, match)` returns the new body, `false` to delete the line, or `null`
 * to abort. Every mutation funnels through here, so the loss check only has to
 * exist once — and any future endpoint inherits it without having to remember.
 */
async function editTaskLine(store, id, message, fn, mayRemove) {
  const cur = await store.readFile("tasks.md");
  if (!cur) return false;
  const lines = cur.text.split("\n");
  const tl = taskLines(lines).find((t) => t.id === String(id));
  if (!tl) return false;
  const next = fn(tl.m[3], tl.m);
  if (next === null) return false;
  if (next === false) lines.splice(tl.idx, 1);                       // delete
  else {
    // mayRemove may be a list, or a function of the original body — a retitle
    // only knows what it is allowed to drop once it can see what was there.
    const allowed = typeof mayRemove === "function" ? mayRemove(tl.m[3]) : (mayRemove || []);
    assertNothingLost(tl.m[3], next, allowed);
    lines[tl.idx] = `${tl.m[1]}- [${tl.m[2]}] ${next}`;
  }
  await writeTasks(store, lines, message, cur.sha);
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
  await writeTasks(store, lines, "dashboard: toggle task", cur.sha);
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
// The title as WRITTEN — stamps and tags removed, but [[wikilinks]] left alone.
//
// taskLabel() strips wikilinks for display, and rebuilding a line from it meant
// that editing only a due date rewrote "Insulate [[Milo]]'s room" as "Insulate
// Milo's room" — quietly severing the link to Milo's note. An edit must never
// destroy a link the user did not touch.
function taskTitleRaw(body) {
  // NOTE: the ⏳ nag counter is deliberately NOT stripped here. This feeds the
  // line that gets written back, and the brief's own bookkeeping must survive an
  // edit made from the dashboard.
  let t = body.replace(DUE_RE, "").replace(DONE_RE, "").replace(PRIORITY_RE, "");
  t = t.replace(/(?:^|\s)#[A-Za-z0-9_/-]+/g, "");
  return t.split(/\s+/).join(" ").trim();
}

async function editTask(store, id, fields, projectSlugs) {
  const has = (k) => Object.prototype.hasOwnProperty.call(fields, k);
  if (has("due") && fields.due && !/^\d{4}-\d{2}-\d{2}$/.test(String(fields.due))) return false;
  const tag = has("tag") ? String(fields.tag || "").replace(/^#/, "").trim() : null;
  if (tag && !AREAS.includes(tag)) return false;
  const project = has("project") ? String(fields.project || "").trim() : null;

  // What this edit is ALLOWED to remove, declared up front: the area tag when
  // you change area, and a project link when you reassign the project. Anything
  // else disappearing is a bug and will throw.
  // Computed from the line being edited, because a deliberate retitle is
  // allowed to drop whatever the OLD title contained — you typed a new one.
  const mayRemove = (body) => {
    const out = [];
    if (has("tag")) out.push(...AREAS);
    if (has("project")) out.push(...(projectSlugs || []));
    if (has("text") && String(fields.text).trim()) out.push(...linksIn(body));
    return out;
  };

  return editTaskLine(store, id, "dashboard: edit task", (body) => {
    let title = has("text") && String(fields.text).trim()
      ? String(fields.text).trim()
      : taskTitleRaw(body);

    // Reassigning the project swaps only the link that names a project; links to
    // people or notes in the title are none of this operation's business.
    if (has("project")) {
      const known = new Set((projectSlugs || []).map((s) => s.toLowerCase()));
      title = title.replace(/\s*\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, (m, target) =>
        known.has(slugify(target)) || known.has(target.toLowerCase()) ? "" : m).trim();
      if (project) title += ` [[${project}]]`;
    }

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
    return parts.join(" ").replace(/\s{2,}/g, " ").trim();
  }, mayRemove);
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
  await writeTasks(store, lines, "dashboard: reorder tasks", cur.sha);
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
  // Any skill whose LAST run failed, scheduled or not. Without this an
  // on-demand skill could fail every time and health still read "all routines
  // on schedule", because only the three cadenced ones were ever checked —
  // which is what happened to file-inbox.
  for (const [name, st] of Object.entries(skills)) {
    if (EXPECTED[name] || !st.when || st.ok !== false) continue;
    checks.push({ name, when: st.when, ok: false, why: "last run failed", error: st.error || "" });
  }
  for (const c of checks) {
    const st = skills[c.name];
    if (st && st.error && !c.error) c.error = st.error;
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
  // "Overdue" and "errored" are different problems with different fixes, and
  // calling both overdue sent exactly the wrong signal: interest-scout had run
  // on schedule and crashed, and the app reported it as not having run.
  const broke = failing.filter((c) => c.why === "last run failed");
  const late = failing.filter((c) => c.why !== "last run failed");
  const parts = [];
  if (stuck.length) parts.push(`${stuck.length} run${stuck.length > 1 ? "s" : ""} queued with no runner`);
  if (broke.length) parts.push(`${broke.map((f) => f.name).join(", ")} failed`);
  if (late.length) parts.push(`${late.map((f) => f.name).join(", ")} overdue`);
  return {
    ok: !failing.length && !stuck.length,
    checks,
    stuck,
    summary: parts.length ? parts.join(" · ") : "all routines on schedule",
  };
}

/* ------------------------------------------------------------------ routing */

/**
 * The whole HTTP surface, host-agnostic.
 * Returns { status, body } — the host turns that into its own Response type.
 */
export function createApi(rawStore, hooks = {}) {
  const feeds = hooks.calendars || [];
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
      if (path === "/api/data") {
        // ?calendar=fresh bypasses the feed cache, for when you have just added
        // a meeting and do not want to wait out the TTL.
        const force = params.get("calendar") === "fresh";
        return { status: 200, body: await buildData(store, feeds, force) };
      }
      if (path === "/api/health") return { status: 200, body: await health(store) };
      if (path === "/api/graph") return { status: 200, body: await buildGraph(store) };
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
      return { status: 404, body: { error: "not found" } };
    }

    if (method === "POST") {
      const p = payload || {};
      let ok;
      switch (path) {
        case "/api/capture":    ok = await capture(store, p.text); break;
        case "/api/task":       ok = await addTask(store, p.text, p.due, p.tag, p.priority, p.project); break;
        case "/api/tasks": {
          const r = await addTasks(store, p.lines, p.due, p.tag, p.project);
          return { status: 200, body: { ok: r.added > 0, ...r } };
        }
        case "/api/toggle":     ok = await toggleTask(store, p.id); break;
        case "/api/priority":   ok = await setPriority(store, p.id); break;
        case "/api/edit": {
          // Reassigning a project needs to know which links name projects, so a
          // [[Milo]] in the title is left alone.
          const slugs = Object.prototype.hasOwnProperty.call(p.fields || {}, "project")
            ? (await store.listDir("projects")).filter((f) => f.name.endsWith(".md")).map((f) => f.name.slice(0, -3))
            : [];
          ok = await editTask(store, p.id, p.fields || {}, slugs);
          break;
        }
        case "/api/reschedule": ok = await rescheduleTask(store, p.id, p.due || null); break;
        case "/api/delete":     ok = await deleteTask(store, p.id); break;
        case "/api/reorder":    ok = await reorderTasks(store, p.ids); break;
        case "/api/run":        ok = await queueRun(store, p.skill, p.input); break;
        case "/api/append":     ok = await appendFragment(store, p.person, p.text); break;
        case "/api/habit":      ok = await toggleHabit(store, p.habit, p.item); break;
        case "/api/habit/group":       ok = await addHabitGroup(store, p.name); break;
        case "/api/habit/item":        ok = await addHabitItem(store, p.habit, p.text); break;
        case "/api/habit/item/remove": ok = await removeHabitItem(store, p.habit, p.item); break;
        case "/api/habit/group/remove":ok = await removeHabitGroup(store, p.habit); break;
        case "/api/habit/rename":      ok = await renameHabitGroup(store, p.habit, p.name); break;
        case "/api/lesson":     ok = await addLesson(store, p.scope, p.text, p.verdict); break;
        case "/api/list/toggle": ok = await toggleListItem(store, p.list, p.item); break;
        case "/api/list/new":    ok = await createList(store, p.name); break;
        case "/api/list/add": {
          const r = await addListItems(store, p.list, p.lines);
          return { status: 200, body: { ok: r.added > 0, ...r } };
        }
        case "/api/list/clear": {
          const r = await clearListDone(store, p.list);
          return { status: 200, body: { ok: r.cleared > 0, ...r } };
        }
        default:
          return { status: 404, body: { error: "not found" } };
      }
      return { status: 200, body: { ok } };
    }

    return { status: 404, body: { error: "not found" } };
  };
}
