#!/usr/bin/env node
/**
 * Check that a brief is actually a brief. Mechanical, not model-remembered.
 *
 *   node scripts/assert-brief.mjs morning-brief [path]
 *   node scripts/assert-brief.mjs evening-brief [path]
 *
 * Exit 0 = the brief is sound. Exit 1 = it is not, and the reasons are on
 * stdout, one per line, ready to go straight into a notification.
 *
 * ## Why this is a script and not a step in the prompt
 *
 * Both brief skills already END with "assert your own output" — file exists,
 * >200 bytes, today's date, all five headings. That instruction has been there
 * throughout, and on 21 August 2026 the morning brief came out at **164 bytes**
 * with every section empty, and the run recorded `ok: true, delivered: true`
 * with no alert. Six mornings running, the News section was empty and nothing
 * said so.
 *
 * `run-skill.sh` already learned this lesson once, about delivery:
 *
 *   > Delivery is too important to depend on a model remembering the last step
 *   > of a prompt.
 *
 * The self-check is the same shape of problem. A skill that has quietly stopped
 * producing anything is exactly the skill least likely to notice it has, and
 * "assert your own output" asks the failing component to grade itself. So the
 * runner grades it instead, records the verdict in the `.status` file, and
 * `health()` turns a failed assert into a red row — the same treatment
 * `delivered` gets, for the same reason (golden rule 5: silence must be loud).
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skill = process.argv[2] || "morning-brief";
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());

const SPEC = {
  "morning-brief": {
    path: `digests/${today}-morning.md`,
    headings: ["Today's calendar", "Due / overdue", "Inbox that needs you", "For Charlotte", "News"],
    // The one section that is never legitimately empty. A day with no events, no
    // due tasks and nothing captured is an ordinary quiet Tuesday; a day with no
    // news in the world is not a thing that happens, so an empty News section is
    // always a failure of the brief rather than a fact about the day.
    mustHaveItems: "News",
  },
  "evening-brief": {
    path: `digests/${today}-evening.md`,
    headings: ["Tomorrow", "Charlotte", "Advice", "One question"],
    mustHaveItems: null,
  },
};

const spec = SPEC[skill];
if (!spec) { console.log(`no assert defined for ${skill}`); process.exit(0); }

const rel = process.argv[3] || spec.path;
const file = join(ROOT, rel);
const fail = [];

if (!existsSync(file)) {
  console.log(`${rel} was never written`);
  process.exit(1);
}

const text = readFileSync(file, "utf8");
const bytes = Buffer.byteLength(text, "utf8");

if (bytes <= 200) fail.push(`${rel} is ${bytes} bytes — too thin to be a brief`);

// The date the file CLAIMS, taken from its own name, so the check is "does this
// brief's content match the day it is filed under" rather than "is it today" —
// true for the scheduled run either way, and meaningful when pointed at an
// older brief by hand.
const claimed = rel.match(/(\d{4}-\d{2}-\d{2})-(?:morning|evening)\.md$/)?.[1] || today;
const human = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London", weekday: "short", day: "2-digit", month: "short",
}).format(new Date(claimed + "T12:00:00Z"));
// The heading is a human date ("Fri 21 Aug"), so accept either form rather than
// demanding the ISO string appear in prose it was never meant to be in.
if (!text.includes(claimed) && !text.includes(human)) {
  fail.push(`${rel} carries neither ${claimed} nor "${human}" — is it the right day's?`);
}

for (const h of spec.headings) {
  if (!new RegExp(`^##\\s+${h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "mi").test(text)) {
    fail.push(`the "${h}" heading is missing`);
  }
}

// The lines under a `## Heading`, up to the next one. Scanned rather than
// matched: the obvious regex ends with a `(?=^##\s|\z)` lookahead, and `\z` is
// not a JavaScript escape — it matches a literal "z". So the LAST section of a
// file (which News always is) only closed if it happened to contain the letter
// z, and otherwise read as empty. The test caught it; a live run would have
// reported every brief hollow, including the good ones.
function sectionLines(md, heading) {
  const want = new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i");
  const out = [];
  let inside = false;
  for (const line of md.split("\n")) {
    if (/^##\s+/.test(line)) { inside = want.test(line); continue; }
    if (inside) out.push(line);
  }
  return out;
}

// Does the section that must carry content actually carry any?
if (spec.mustHaveItems) {
  const body = sectionLines(text, spec.mustHaveItems)
    .map((l) => l.trim())
    // The foot-of-brief health marker is not content — it is the note saying
    // there ISN'T any, and counting it as an item is how an empty section passes.
    .filter((l) => l && l !== "—" && !l.startsWith("⚠"));
  if (!body.length) {
    fail.push(`the ${spec.mustHaveItems} section is empty — six mornings of this went unreported in August`);
  }
}

if (fail.length) { for (const f of fail) console.log(f); process.exit(1); }
console.log(`${rel} looks sound (${bytes} bytes)`);
