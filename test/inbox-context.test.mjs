/**
 * Tests for scripts/inbox-context.mjs — the routing preflight for `file-inbox`.
 *
 *   node --test test/inbox-context.test.mjs
 *
 * WHY
 * ---
 * 21 August 2026, 19:47 — the evening brief asked what "done" looks like for the
 * searchable-database side project. 20:08 — Ben captured, in the app: "I need to
 * find a way to get ai to search through the information provided by the
 * search… without needing a licence or API calls."
 *
 * `file-inbox` filed that to `notes/unsorted/` and left the gap open, still
 * stamped as asked. So the vault asked a specific question, got a specific
 * answer twenty-one minutes later, threw it in the drawer, and queued the same
 * question to be asked again a fortnight on.
 *
 * The prompt already said to cross off answered gaps, and already had a routing
 * table with projects in it. Both were ignored because both required crawling
 * and semantic matching on haiku. So the finding happens in code and only the
 * deciding is left to the model — the same division as the briefing preflight.
 *
 * The two assertions that matter are the two things that actually failed:
 * a capture must be told which questions were outstanding when it landed, and a
 * project must be findable by the words its own note uses.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { today } from "../worker/vault.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const T = today();

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), "lv-inbox-"));
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(p)), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
  for (const p of ["scripts/inbox-context.mjs", "worker/vault.js", "worker/ical.js", "worker/calendar.js"]) {
    mkdirSync(join(dir, dirname(p)), { recursive: true });
    cpSync(join(ROOT, p), join(dir, p));
  }
  for (const d of ["inbox", "people", "projects", "notes"]) mkdirSync(join(dir, d), { recursive: true });
  return dir;
}
const run = (dir) => JSON.parse(execFileSync(process.execPath,
  [join(dir, "scripts/inbox-context.mjs")], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));

// The real project note's shape: the identifying words sit well past the first
// 240 characters of the summary, which is exactly why they were missed.
const PROJECT = [
  "---", "type: project", "name: JGC Director Path", "tags: [work]", "---", "",
  "## What to know",
  "Ben aiming to become next director of JGC alongside founder [[Joel]]. Senior",
  "engineer; third person to join the company and part of the original core. The",
  "bar, in Ben's words: Joel decides, alone, and the criterion is functional —",
  "managing the business — not fee income or time served. The firm is at sixteen",
  "people, a size Joel has singled out as the point where it has to change.",
  "The one thing he actually pushes at work is organising JGC's database and",
  "making it searchable with a custom interface.", "",
].join("\n");

const GAPS = (askedDay) => [
  "# Gaps", "", "## Open", "",
  "- [ ] The searchable-database side project is the biggest thing you actually push",
  '      at work. What would "done" look like, and who else has asked for it? #work',
  `      _(asked: ${askedDay})_`,
  "- [ ] What does the scale say? #health",
  "      _(asked: 2020-01-01)_",
  "", "## Answered", "",
].join("\n");

const CAPTURE = "I need to find a way to get ai to search through the information provided "
  + "by the search. But the issue is how I pass information to the airport, have it "
  + "formulate an answer, pass it back without needing a licence or API calls\n";

test("a capture is told which questions were open when it landed", () => {
  const dir = fixture({
    [`inbox/${T}T200822-cvtmzk.md`]: CAPTURE,
    "_meta/gaps.md": GAPS(T),
    "tasks.md": "# Tasks\n",
  });
  const { captures } = run(dir);
  assert.equal(captures.length, 1);
  const [c] = captures;
  assert.ok(c.mayAnswer.length, "a capture that arrived after a question must offer it as a candidate");
  assert.match(c.mayAnswer[0].question, /searchable-database/,
    "the question asked that same day must come first");
  assert.ok(c.mayAnswer[0].raw.includes("asked:"),
    "the raw line must come along — it is the exact-match edit target");
  rmSync(dir, { recursive: true, force: true });
});

test("a question asked long ago is not offered as a candidate", () => {
  // Otherwise every capture is a candidate answer to everything, which is the
  // same as flagging nothing.
  const dir = fixture({
    [`inbox/${T}T200822-cvtmzk.md`]: CAPTURE,
    "_meta/gaps.md": GAPS("2020-01-01"),
    "tasks.md": "# Tasks\n",
  });
  const [c] = run(dir).captures;
  assert.equal(c.mayAnswer.length, 0, "a five-year-old question is not what this capture is answering");
  rmSync(dir, { recursive: true, force: true });
});

test("a project is findable by the words its own note uses", () => {
  // The miss: 'database' and 'searchable' sit past the 240-character summary
  // cut-off, so the note that was plainly about this capture looked unrelated.
  const dir = fixture({
    "projects/jgc-director-path.md": PROJECT,
    "_meta/gaps.md": GAPS(T),
    "tasks.md": "# Tasks\n",
  });
  const { projects } = run(dir);
  const p = projects.find((x) => x.slug === "jgc-director-path");
  assert.ok(p, "the project was not listed at all");
  for (const w of ["database", "searchable"]) {
    assert.ok(p.terms.includes(w), `"${w}" must be a term the router can match on`);
  }
  rmSync(dir, { recursive: true, force: true });
});

test("common words are not offered as identifying terms", () => {
  const dir = fixture({ "projects/jgc-director-path.md": PROJECT, "tasks.md": "# Tasks\n" });
  const p = run(dir).projects[0];
  for (const w of ["about", "because", "should", "there"]) {
    assert.ok(!p.terms.includes(w), `"${w}" identifies nothing and crowds out what does`);
  }
  rmSync(dir, { recursive: true, force: true });
});

test("a standing instruction is flagged before it can become a task", () => {
  // CLAUDE.md's sharpest routing rule: work for the SYSTEM must never land in
  // tasks.md as a chore Ben can never honestly tick. It has happened once.
  const dir = fixture({
    [`inbox/${T}T090000-aaaaaa.md`]: "Add a check, probably monthly, to find family friendly events near Cambridge\n",
    "tasks.md": "# Tasks\n",
  });
  const [c] = run(dir).captures;
  assert.equal(c.looksStanding, true);
  rmSync(dir, { recursive: true, force: true });
});

test("a done: capture is flagged and the open tasks come with it", () => {
  const dir = fixture({
    [`inbox/${T}T090000-aaaaaa.md`]: "done: ordered the washing machine\n",
    "tasks.md": "# Tasks\n- [ ] Order washing machine #house\n- [x] Already done #house ✅ 2026-01-01\n",
  });
  const j = run(dir);
  assert.equal(j.captures[0].isDone, true);
  assert.equal(j.openTasks.length, 1, "only OPEN tasks are candidates for a done:");
  assert.match(j.openTasks[0].text, /Order washing machine/);
  rmSync(dir, { recursive: true, force: true });
});

test("captures come oldest first, with their arrival time", () => {
  const dir = fixture({
    [`inbox/${T}T200822-bbbbbb.md`]: "second\n",
    [`inbox/${T}T090000-aaaaaa.md`]: "first\n",
    "tasks.md": "# Tasks\n",
  });
  const { captures } = run(dir);
  assert.deepEqual(captures.map((c) => c.text), ["first", "second"]);
  assert.equal(captures[0].arrived, `${T}T09:00:00Z`);
  rmSync(dir, { recursive: true, force: true });
});

test("private content never reaches the routing bundle", () => {
  const dir = fixture({
    "people/charlotte.md": "---\ntype: person\nname: Charlotte\n---\n\n## Private\nsomething that must never leave\n\n## Log\n- 2026-08-01 — fine\n",
    "tasks.md": "# Tasks\n",
  });
  assert.ok(!JSON.stringify(run(dir)).includes("must never leave"));
  rmSync(dir, { recursive: true, force: true });
});
