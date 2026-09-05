#!/usr/bin/env node
/**
 * Preflight for the briefing skills: every mechanical fact a brief needs,
 * assembled by code, printed as one JSON object, in ONE tool call.
 *
 *   node scripts/brief-context.mjs morning
 *   node scripts/brief-context.mjs evening
 *   node scripts/brief-context.mjs morning --pretty     # for humans
 *
 * ## Why this exists
 *
 * `_meta/skill-usage.jsonl`, 20 Jul – 5 Aug 2026: 24 morning-brief runs at
 * 24–59 turns each, $0.92 average, up to $2.16, with 0.7M–2.9M cached tokens per
 * run. $22 of the vault's $30 total spend went on this one skill.
 *
 * The cost is not the thinking. It is the *discovery*: the model opened
 * `tasks.md`, `people/charlotte.md`, `_meta/hot-cache.md`, the inbox listing and
 * the calendar one tool call at a time, and every one of those results was then
 * re-sent as cache on every following turn. Context grows with each turn, so
 * spend grows roughly with turns × context — which is why a 59-turn run cost
 * nine times a 6-turn one.
 *
 * None of that discovery is judgement. Which tasks are due, what is on the
 * calendar, which of Charlotte's fragments are eligible to surface, how many
 * captures are waiting — all of it is deterministic, and `worker/vault.js`
 * already knows the rules. So it happens here, once, in code, for a fraction of
 * a penny. What is left for the model is what only it can do: choose, phrase and
 * write.
 *
 * ## Contract
 *
 * Read-only. This script never writes to the vault — the skill still makes its
 * own edits, because an unattended script rewriting `tasks.md` is a much worse
 * failure than an expensive brief. Where an edit is needed it hands over the
 * exact source line (`raw`) and what to do with it (`action`), so the edit is
 * one exact-match replacement and not a re-read.
 *
 * Private content never enters the bundle: every note goes through
 * `stripPrivate()` first (CLAUDE.md, private sections).
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseTasks, parseLog, openLoops, occasionsIn, stripPrivate, today,
} from "../worker/vault.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mode = (process.argv[2] || "morning").toLowerCase();
const pretty = process.argv.includes("--pretty");
const T = today();

/* ------------------------------------------------------------------ helpers */

const read = (p) => { try { return readFileSync(join(ROOT, p), "utf8"); } catch { return ""; } };
const readSafe = (p) => stripPrivate(read(p));
const ls = (p) => { try { return readdirSync(join(ROOT, p)); } catch { return []; } };
const days = (from, to = T) =>
  Math.round((new Date(to + "T12:00:00Z") - new Date(from + "T12:00:00Z")) / 864e5);
const short = (e) => String((e && e.message) || e).split("\n")[0].slice(0, 200);

// "Wed 05 Aug" — the heading the brief is written under, computed here so the
// model never has to reason about what day it is (it has been wrong about this).
const heading = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London", weekday: "short", day: "2-digit", month: "short",
}).format(new Date());

/* ----------------------------------------------------------------- calendar */

// Shells out rather than re-implementing: fetch-calendar.mjs owns the feeds, the
// .env loading, and the private-marker filter, and it shares worker/ical.js with
// the dashboard so the brief and the app cannot disagree.
function calendar(span) {
  const args = [join(ROOT, "scripts/fetch-calendar.mjs"), String(span)];
  const parse = (s) => JSON.parse(s);
  try {
    return parse(execFileSync(process.execPath, args, {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 90_000,
    }));
  } catch (e) {
    // Exit 2 means a feed failed, and the JSON is still on stdout — naming the
    // broken feed is the entire point. A feed that stopped syncing looks
    // exactly like a free day, which is the silence rule 5 forbids.
    try { return parse(String((e && e.stdout) || "")); } catch { /* fall through */ }
    return { sources: [{ name: "calendar", ok: false, error: short(e) }], events: [] };
  }
}

/* -------------------------------------------------------------------- tasks */

// Due today and overdue, with the anti-nag rule (CLAUDE.md rule 3) already
// applied: three consecutive appearances, then it drops out and goes `#stale`.
// The decision is arithmetic, so it is made here; the model only writes it down.
function tasks() {
  const open = parseTasks(read("tasks.md")).filter((t) => !t.done);
  const shape = (t) => ({
    text: t.text, due: t.due, area: t.area, raw: t.raw,
    ...(t.overdue ? { overdueDays: days(t.due), nag: t.nag } : {}),
  });
  const stale = open.filter((t) => t.tags.includes("stale"));
  const live = open.filter((t) => !t.tags.includes("stale"));
  const dueToday = live.filter((t) => t.today).map(shape);
  const overdue = live.filter((t) => t.overdue).map((t) => {
    const s = shape(t);
    // The counter is 1-based on first appearance: nag 0 means "not yet shown".
    s.action = t.nag >= 3
      ? "DROP from the brief — add ` #stale` to this line (rule 3, it has had its three)"
      : `include — replace ⏳${t.nag || ""} with ⏳${t.nag + 1} on this line`;
    return s;
  });
  return {
    dueToday, overdue,
    // Not for the brief. Listed so the weekly "decide or delete" review has its
    // input, and so a task that went stale is visible as a fact rather than
    // just absent.
    stale: stale.map((t) => ({ text: t.text, due: t.due })),
    openCount: live.length,
  };
}

/* ---------------------------------------------------------------- charlotte */

// The surfacer's eligibility rules, done in code: nothing private, nothing
// stamped `surfaced:` inside 14 days. What is left is a shortlist to CHOOSE
// from — the choice, and whether to surface anything at all, stays judgement.
function charlotte() {
  const raw = read("people/charlotte.md");
  if (!raw) return { note: "people/charlotte.md not found" };
  const text = stripPrivate(raw);
  const log = parseLog(text);

  // Which fragments carry a recent `surfaced:` stamp. parseLog strips the stamp
  // (rightly — it is bookkeeping, not content), so it is read here from the
  // source lines and matched back BY POSITION.
  //
  // Matching on a text prefix was the obvious approach and it was wrong: the
  // prefix taken from the source line still had `_(surfaced: …)_` on the end of
  // it while the one taken from the parsed fragment did not, so no stamp ever
  // matched and a fragment used this morning was offered again tomorrow. Walking
  // the same head lines parseLog walks, in the same order, has no such seam.
  const inFileOrder = [];
  for (const line of (text.match(/##\s*Log\s*\n([\s\S]*?)(?=\n##\s|$)/i)?.[1] || "").split("\n")) {
    const head = line.match(/^-\s+(\d{4}-\d{2}-\d{2})\s*—\s*(.+)$/);
    if (head) inFileOrder.push({ date: head[1], stamp: null });
    const st = line.match(/_\(surfaced:\s*(\d{4}-\d{2}-\d{2})\)_/);
    if (st && inFileOrder.length) inFileOrder[inFileOrder.length - 1].stamp = st[1];
  }
  const stamps = inFileOrder.reverse();   // parseLog returns file order reversed
  const aligned = stamps.length === log.length && log.every((f, i) => f.date === stamps[i].date);
  const stampOf = (f, i) => (aligned ? stamps[i].stamp : lastStampNear(f));
  // Only reached if the two walks disagree, which means the Log has a shape
  // neither of us predicted. Suppress on any stamp for that date rather than
  // risk re-surfacing something used yesterday — over-caution here costs one
  // quiet morning, under-caution costs the trust the whole skill runs on.
  function lastStampNear(f) {
    const hit = stamps.find((s) => s.date === f.date && s.stamp);
    return hit ? hit.stamp : null;
  }

  // A fragment that says it points at private material is itself a pointer, and
  // CLAUDE.md's wall covers being "used as the reason for a suggestion" — so it
  // never reaches the shortlist. Counted, not silently dropped.
  const pointsAtPrivate = (f) => /\bprivate\b/i.test(f.text);

  const eligible = log.filter((f, i) => {
    if (pointsAtPrivate(f)) return false;
    const s = stampOf(f, i);
    return !s || days(s) >= 14;
  });
  const eligibleIds = new Set(eligible.map((f) => f.date + "|" + f.text));
  // Newest by DATE, not by file position. parseLog returns file order reversed,
  // and Charlotte's log is already written newest-first, so `log[0]` was the
  // OLDEST fragment — which reported her note as 17 days quiet on a day it had
  // fragments from four days ago, and would have fired the "capture has stopped"
  // alarm on a note that was being written to.
  const dates = log.map((f) => f.date).sort();
  const latest = dates.length ? dates[dates.length - 1] : null;

  return {
    // The surfacer must say so out loud if capture has stopped — the system
    // failing at the one thing Ben named as his biggest problem must not fail
    // silently (charlotte-surfacer.md, "Assert").
    lastFragment: latest,
    daysQuiet: latest ? days(latest) : null,
    captureStalled: latest ? days(latest) >= 14 : true,
    // Priority 1 in the surfacer: something with a date now near or just past.
    // Same eligibility as the shortlist — openLoops reads the same fragments, so
    // an ineligible one must not come back through this door.
    loops: openLoops(log, "Charlotte", "charlotte")
      .filter((l) => eligibleIds.has(l.logged + "|" + l.text))
      .map((l) => ({ date: l.date, daysAway: l.daysAway, text: l.text, logged: l.logged })),
    // occasionsIn() strips the `_(surfaced: …)_` stamp into nothing (it's
    // bookkeeping, per vault.js) rather than returning it, so the 14-day
    // dedup that loops/candidates get has to be redone here from the raw
    // text — otherwise an occasion re-offers itself the morning right after
    // it was surfaced, the one thing charlotte-surfacer.md rules out.
    occasions: (() => {
      const stampByDate = new Map();
      for (const m of text.matchAll(/\(occasion::\s*(\d{4}-\d{2}-\d{2})\)\s*(.*)/g)) {
        const st = m[2].match(/_\(surfaced:\s*(\d{4}-\d{2}-\d{2})\)_/);
        if (st) stampByDate.set(m[1], st[1]);
      }
      return occasionsIn(text)
        .filter((o) => o.date >= T && days(T, o.date) <= 45)
        .filter((o) => { const s = stampByDate.get(o.date); return !s || days(s) >= 14; })
        .map((o) => ({ ...o, daysAway: days(T, o.date) }));
    })(),
    // Newest first, capped: a shortlist, not the whole file.
    candidates: [...eligible]
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 10)
      .map((f) => ({ date: f.date, text: f.text })),
    suppressed: log.length - eligible.length,
  };
}

/* -------------------------------------------------------------- inbox, gaps */

const inbox = () => {
  const files = ls("inbox").filter((f) => f.endsWith(".md"));
  return { count: files.length, files: files.slice(0, 20) };
};

// The oldest open gap that is fair to ask: not asked in the last 14 days, and
// not already asked three times (rule 3 again — a question declined three times
// is not going to be answered).
function gaps() {
  const text = read("_meta/gaps.md");
  const open = text.match(/##\s*Open\s*\n([\s\S]*?)(?=\n##\s|$)/i)?.[1] || "";
  const items = [];
  for (const block of open.split(/\n(?=-\s\[)/)) {
    if (!/^-\s\[[ xX]\]/.test(block.trim())) continue;
    const asked = [...block.matchAll(/asked:\s*(\d{4}-\d{2}-\d{2})/g)].map((m) => m[1]);
    const last = asked.length ? asked[asked.length - 1] : null;
    items.push({
      text: block.replace(/^-\s\[[ xX]\]\s*/, "").replace(/_\(asked:[^)]*\)_/g, "")
        .split(/\s+/).join(" ").trim(),
      raw: block.trim(),
      askedCount: asked.length,
      lastAsked: last,
      eligible: asked.length < 3 && (!last || days(last) >= 14),
    });
  }
  const next = items.find((i) => i.eligible) || null;
  return {
    next,
    // If nothing is eligible the brief writes "—". An empty question beats a
    // manufactured one (evening-brief.md).
    openCount: items.length,
    parkedNext: !next && items.length ? "all open gaps are inside their 14-day window or have been asked three times" : null,
  };
}

/* -------------------------------------------- today's counts (evening score) */

// The inputs to `_meta/day-log.jsonl`, counted rather than estimated. Ben's own
// bar, from identity.md: a task completed AND something positive written down.
function dayCounts() {
  const tasksCompleted = parseTasks(read("tasks.md")).filter((t) => t.completed === T).length;
  const captures = ls("inbox/_archive").filter((f) => f.startsWith(T)).length
    + ls("inbox").filter((f) => f.endsWith(".md")).length;
  const habits = read("habits-log.md").split("\n").filter((l) => l.startsWith(`- ${T} `)).length;
  let fragments = 0;
  for (const dir of ["people", "projects"]) {
    for (const f of ls(dir).filter((n) => n.endsWith(".md"))) {
      fragments += readSafe(`${dir}/${f}`).split("\n").filter((l) => new RegExp(`^-\\s+${T}\\s*—`).test(l)).length;
    }
  }
  return { tasksCompleted, captures, habits, fragments };
}

/* ------------------------------------------------------------------- output */

const cal = calendar(mode === "evening" ? 2 : 1);
const events = (cal.events || []).map((e) => ({
  when: e.when, time: e.time, title: e.title, location: e.location || null,
  minutes: e.minutes, calendar: e.calendar,
}));

const payload = {
  mode, today: T, heading,
  calendar: {
    // Every source, healthy or not. A source with ok:false must be NAMED in the
    // brief — "not connected" and "nothing on" are different facts.
    sources: cal.sources || [],
    ...(cal.error ? { error: cal.error } : {}),
    today: events.filter((e) => e.when === "today"),
    ...(mode === "evening" ? { tomorrow: events.filter((e) => e.when === "tomorrow") } : {}),
  },
  tasks: tasks(),
  inbox: inbox(),
  charlotte: charlotte(),
  ...(mode === "evening" ? { gaps: gaps(), day: dayCounts() } : {}),
};

process.stdout.write(JSON.stringify(payload, null, pretty ? 2 : 0) + "\n");

// Loud, not fatal: the brief still gets written, and the missing feed is named
// in it. Exit 2 matches fetch-calendar.mjs so a caller can tell the difference.
if ((cal.sources || []).some((s) => !s.ok)) process.exitCode = 2;
