#!/usr/bin/env node
/**
 * Preflight for `file-inbox`: the captures waiting, and everything needed to
 * route them, in one JSON object and one tool call.
 *
 *   node scripts/inbox-context.mjs
 *   node scripts/inbox-context.mjs --pretty
 *
 * ## Why
 *
 * 21 August 2026, 19:47 — the evening brief asked: *"The searchable-database
 * side project is the biggest thing you actually push at work. What would 'done'
 * look like, and who else has asked for it?"* At 20:08 Ben captured, in the app:
 * *"I need to find a way to get ai to search through the information provided by
 * the search… without needing a licence or API calls."*
 *
 * That is the answer to the question, twenty-one minutes later. `file-inbox`
 * filed it to `notes/unsorted/` and left the gap open, still stamped
 * `asked: 2026-08-07` — so it will be asked again in a fortnight, having already
 * been answered. It also missed that `projects/jgc-director-path.md` is
 * literally about "organising JGC's database and making it searchable".
 *
 * The prompt already said to do both things (step 3, and the routing table). It
 * ran on haiku, and it was being asked to discover the gaps file, the project
 * notes and the people notes by crawling, then match semantically across all of
 * them. The rule was there; the evidence wasn't in front of it.
 *
 * So the mechanical half happens here: what is waiting, what questions are
 * outstanding, which one was asked most recently (a capture arriving hours after
 * a question is a strong candidate for being its answer), and the list of people,
 * projects and lists a capture could belong to — with the words that would name
 * each one. Deciding is still the model's job. Finding is not.
 *
 * Read-only. Nothing here writes to the vault.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTasks, parseEntity, stripPrivate, today } from "../worker/vault.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pretty = process.argv.includes("--pretty");
const T = today();

const read = (p) => { try { return readFileSync(join(ROOT, p), "utf8"); } catch { return ""; } };
const ls = (p) => { try { return readdirSync(join(ROOT, p)); } catch { return []; } };
const days = (from, to = T) =>
  Math.round((new Date(to + "T12:00:00Z") - new Date(from + "T12:00:00Z")) / 864e5);

/* ----------------------------------------------------------------- captures */

// Oldest first, as the skill processes them. The capture filename is an ISO
// stamp, so it doubles as the arrival time — which is what makes "this landed
// twenty minutes after the question" a fact rather than a guess.
function captures() {
  return ls("inbox")
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => {
      const text = read(`inbox/${f}`).trim();
      const m = f.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})(\d{2})(\d{2})/);
      return {
        file: `inbox/${f}`,
        arrived: m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}Z` : null,
        text,
        // The two prefixes that change what a capture IS, flagged so they are
        // never missed in a batch of thirty.
        isDone: /^done:/i.test(text),
        // CLAUDE.md's tells for a standing instruction — work for the system,
        // not work for Ben. Filing one as a task is a routing failure that puts
        // a chore on his list that can never honestly be ticked.
        looksStanding: /\b(every (week|month|day|morning)|monthly|weekly|daily|automatically|from now on|keep an eye|remind me|always|each (morning|week|month))\b/i.test(text),
      };
    });
}

/* --------------------------------------------------------------------- gaps */

// Open questions, and — the point of this block — which one was asked most
// recently. The evening brief asks one a day and stamps it; anything captured
// after that stamp may well be the answer.
function gaps() {
  const text = read("_meta/gaps.md");
  const open = text.match(/##\s*Open\s*\n([\s\S]*?)(?=\n##\s|$)/i)?.[1] || "";
  const items = [];
  for (const block of open.split(/\n(?=-\s\[)/)) {
    if (!/^-\s\[[ xX]\]/.test(block.trim())) continue;
    const asked = [...block.matchAll(/asked:\s*(\d{4}-\d{2}-\d{2})/g)].map((m) => m[1]);
    const last = asked.length ? asked.sort()[asked.length - 1] : null;
    items.push({
      question: block.replace(/^-\s\[[ xX]\]\s*/, "").replace(/_\(asked:[^)]*\)_/g, "")
        .split(/\s+/).join(" ").trim(),
      raw: block.trim(),
      lastAsked: last,
      daysSinceAsked: last ? days(last) : null,
    });
  }
  const asked = items.filter((g) => g.lastAsked).sort((a, b) => a.lastAsked.localeCompare(b.lastAsked));
  return { open: items, mostRecentlyAsked: asked.length ? asked[asked.length - 1] : null };
}

// Which outstanding questions each capture could be answering. The test is
// arrival, not wording: a capture that landed on or after the day a question was
// put is a candidate for being its answer, and the model is told to look rather
// than left to notice. On 21 August the answer arrived twenty-one minutes after
// the question and was filed to notes/unsorted — the connection was never made
// because nothing pointed at it.
function answerCandidates(caps, g) {
  const asked = g.open.filter((x) => x.lastAsked);
  for (const c of caps) {
    const day = (c.arrived || "").slice(0, 10) || T;
    const hits = asked
      .filter((x) => x.lastAsked <= day && days(x.lastAsked, day) <= 3)
      .sort((a, b) => b.lastAsked.localeCompare(a.lastAsked));
    c.mayAnswer = hits.map((x) => ({ question: x.question, lastAsked: x.lastAsked, raw: x.raw }));
  }
}

/* ------------------------------------------------- routing targets */

// Every note a capture could belong to, with the words that would name it, so
// matching is reading a list rather than crawling the vault. `terms` is what the
// note calls itself: its name, its filename, and the distinctive words of its
// summary — jgc-director-path's summary says "organising JGC's database and
// making it searchable", which is exactly what the 21 Aug capture was about and
// exactly what was missed.
// Words too common to identify anything. Without this the top terms of every
// note are "should", "because", "things".
const STOP = new Set(("about above after again against because been before being below "
  + "between both cannot could doing during each further having himself herself "
  + "into itself might more most other over same should since some such than that "
  + "their them then there these they this those through under until very were "
  + "what when where which while with would your yours still just like really "
  + "something anything everything nothing someone always never often") .split(/\s+/));

function entities(dir, type) {
  return ls(dir)
    .filter((f) => f.endsWith(".md") && !f.startsWith("_"))
    .map((f) => {
      const slug = f.replace(/\.md$/, "");
      const raw = stripPrivate(read(`${dir}/${f}`));
      const e = parseEntity(raw, slug);
      // Terms come from the WHOLE note, not the summary excerpt. Truncating the
      // summary to 240 characters cut "organising JGC's database and making it
      // searchable" off at character ~250 — the one phrase that would have
      // routed the 21 Aug capture to this project instead of notes/unsorted.
      const freq = new Map();
      for (const w of (raw.toLowerCase().match(/\b[a-z][a-z-]{4,}\b/g) || [])) {
        if (STOP.has(w)) continue;
        freq.set(w, (freq.get(w) || 0) + 1);
      }
      const top = [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 30).map(([w]) => w);
      return {
        path: `${dir}/${f}`, slug, name: e.name, tags: e.tags, type,
        summary: e.summary.slice(0, 240),
        terms: [...new Set([String(e.name).toLowerCase(), slug.replace(/-/g, " "), ...top])],
      };
    });
}

// `type: list` notes — shopping and the like. A capture matching one of these
// appends to it; it must never become a task (CLAUDE.md: a shopping list in
// tasks.md is permanent noise that never leaves).
function lists() {
  return ls("notes")
    .filter((f) => f.endsWith(".md"))
    .map((f) => ({ f, text: read(`notes/${f}`) }))
    .filter(({ text }) => /^type:\s*list\s*$/m.test(text))
    .map(({ f, text }) => ({
      path: `notes/${f}`, slug: f.replace(/\.md$/, ""),
      name: parseEntity(text, f.replace(/\.md$/, "")).name,
      openItems: (text.match(/^-\s\[ \]/gm) || []).length,
    }));
}

/* -------------------------------------------------------------------- tasks */

// Open tasks, for a `done:` capture to match against. Titles only — the whole
// file is not needed to find "ordered the washing machine".
const openTasks = () =>
  parseTasks(read("tasks.md")).filter((t) => !t.done)
    .map((t) => ({ text: t.text, due: t.due, area: t.area, raw: t.raw }));

/* ------------------------------------------------------------------- output */

const caps = captures();
const g = gaps();
answerCandidates(caps, g);
const payload = {
  today: T,
  captures: caps,
  count: caps.length,
  gaps: g,
  people: entities("people", "person"),
  projects: entities("projects", "project"),
  lists: lists(),
  openTasks: openTasks(),
};

process.stdout.write(JSON.stringify(payload, null, pretty ? 2 : 0) + "\n");
