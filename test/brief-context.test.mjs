/**
 * Tests for the briefing preflight (scripts/brief-context.mjs) and the domain
 * helpers it leans on.
 *
 *   node --test test/brief-context.test.mjs
 *
 * WHY THESE EXIST
 * ---------------
 * The preflight moved work out of the model and into code, which is the point —
 * it took a morning brief from 24–59 turns to a budgeted 10. But it also moved
 * three *rules* into code, and a rule in code that nobody asserts is a rule that
 * can break silently:
 *
 *   - the `## Private` wall (CLAUDE.md, binding, and previously enforced by one
 *     regex in two places with no test on either);
 *   - the anti-nag arithmetic (rule 3: three appearances, then `#stale`);
 *   - "how quiet has Charlotte's note been", which drives an alarm that is
 *     supposed to fire when capture stops.
 *
 * The last one shipped broken and these caught it: `parseLog` returns file order
 * reversed, Charlotte's log is written newest-first, so taking `log[0]` as the
 * newest fragment reported a note written to four days ago as seventeen days
 * quiet — an alarm that would have cried wolf every single morning.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTasks, parseLog, stripPrivate, occasionsIn, today } from "../worker/vault.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const T = today();

/* ------------------------------------------------------- the private wall */

test("stripPrivate removes the Private section and nothing else", () => {
  const note = [
    "## What to know", "Summary line.", "",
    "## Private", "The thing that must never surface.", "",
    "## Log", "- 2026-07-19 — A fragment that must survive.", "",
  ].join("\n");
  const out = stripPrivate(note);
  assert.ok(!out.includes("must never surface"), "private content survived");
  assert.ok(out.includes("A fragment that must survive"), "the Log was eaten");
  assert.ok(out.includes("Summary line."), "the summary was eaten");
});

test("a Private section ABOVE the Log does not take the Log with it", () => {
  // The real shape of people/charlotte.md: `## Private` sits above `## Log`, so
  // a "drop everything after the heading" implementation would delete every
  // fragment the surfacer runs on and report an empty, healthy-looking note.
  const note = "## Private\nsecret\n\n## Log\n- 2026-08-01 — kept\n";
  const log = parseLog(stripPrivate(note));
  assert.equal(log.length, 1);
  assert.equal(log[0].text, "kept");
});

test("occasionsIn reads inline occasion markers", () => {
  const found = occasionsIn("- (occasion:: 2026-08-31) Civil wedding anniversary\n");
  assert.deepEqual(found, [{ date: "2026-08-31", text: "Civil wedding anniversary" }]);
});

test("an occasion the surfacer has stamped keeps its stamp out of the text", () => {
  // Live on 11 Aug 2026: the morning brief surfaced the anniversary and stamped
  // the occasion line, so the next read of it carried the bookkeeping into the
  // brief and onto the dashboard's agenda card.
  const found = occasionsIn("- (occasion:: 2026-08-31) Civil wedding anniversary _(surfaced: 2026-08-11)_\n");
  assert.deepEqual(found, [{ date: "2026-08-31", text: "Civil wedding anniversary" }]);
});

/* ------------------------------------------------------- the nag arithmetic */

test("parseTasks exposes the nag counter and the untouched source line", () => {
  const line = "- [ ] Jasper raincoat #family 📅 2026-07-25 ⏳2";
  const [t] = parseTasks(line);
  assert.equal(t.nag, 2);
  assert.equal(t.raw, line, "raw must be byte-identical — it is an edit target");
  assert.equal(t.text, "Jasper raincoat", "the counter must not reach the title");
});

test("a task with no counter reads as nag 0, not NaN", () => {
  const [t] = parseTasks("- [ ] Buy lamps #house 📅 2026-01-01");
  assert.equal(t.nag, 0);
});

/* ------------------------------------------------------------ the preflight */

// A whole disposable vault, so the script is exercised end to end rather than
// its pieces in isolation.
function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), "lv-brief-"));
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(p)), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
  for (const p of ["scripts/brief-context.mjs", "scripts/fetch-calendar.mjs", "worker/vault.js", "worker/ical.js", "worker/calendar.js"]) {
    mkdirSync(join(dir, dirname(p)), { recursive: true });
    cpSync(join(ROOT, p), join(dir, p));
  }
  mkdirSync(join(dir, "inbox/_archive"), { recursive: true });
  return dir;
}

function runPreflight(dir, mode = "morning") {
  let stdout = "";
  try {
    stdout = execFileSync(process.execPath, [join(dir, "scripts/brief-context.mjs"), mode], {
      cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      // No calendar feeds in a fixture: exit 2 is expected and the JSON is still
      // on stdout, which is the contract the skills rely on.
      env: { ...process.env, CAL_WORK: "", CAL_PERSONAL: "", CAL_FAMILY: "", ICS_URL: "" },
    });
  } catch (e) { stdout = String(e.stdout || ""); }
  return JSON.parse(stdout);
}

const CHARLOTTE = [
  "---", "type: person", "name: Charlotte", "tags: [family]", "---", "",
  "## Dates & occasions",
  "- (occasion:: 2026-08-31) Civil wedding anniversary", "",
  "## Private",
  "- 2026-07-19 — something that must never leave the vault.", "",
  "## Log",
  "- 2026-08-01 — Newest fragment, never surfaced.",
  "- 2026-07-19 — Older fragment. _(surfaced: " + T + ")_",
  "- 2026-07-13 — Old one, surfaced long ago. _(surfaced: 2026-01-01)_",
  "",
].join("\n");

test("the bundle carries no private content, in any field", () => {
  const dir = fixture({ "tasks.md": "# Tasks\n", "people/charlotte.md": CHARLOTTE });
  const bundle = runPreflight(dir);
  assert.ok(!JSON.stringify(bundle).includes("must never leave"),
    "private content reached the brief input");
  rmSync(dir, { recursive: true, force: true });
});

test("a fragment surfaced inside 14 days is not offered again", () => {
  const dir = fixture({ "tasks.md": "# Tasks\n", "people/charlotte.md": CHARLOTTE });
  const { charlotte } = runPreflight(dir);
  const texts = charlotte.candidates.map((c) => c.text);
  assert.ok(texts.some((t) => t.startsWith("Newest fragment")), "an eligible fragment was dropped");
  assert.ok(!texts.some((t) => t.startsWith("Older fragment")), "a just-surfaced fragment came back");
  assert.ok(texts.some((t) => t.startsWith("Old one")), "a stale stamp should be eligible again");
  rmSync(dir, { recursive: true, force: true });
});

test("daysQuiet is measured from the newest fragment by date, not by position", () => {
  const dir = fixture({ "tasks.md": "# Tasks\n", "people/charlotte.md": CHARLOTTE });
  const { charlotte } = runPreflight(dir);
  assert.equal(charlotte.lastFragment, "2026-08-01");
  assert.equal(charlotte.candidates[0].date, "2026-08-01", "candidates must be newest first");
  rmSync(dir, { recursive: true, force: true });
});

test("the anti-nag rule is decided in the bundle, not left to the model", () => {
  const dir = fixture({
    "tasks.md": [
      "# Tasks",
      "- [ ] First time overdue #house 📅 2026-01-01",
      "- [ ] Third time overdue #house 📅 2026-01-01 ⏳3",
      "- [ ] Already parked #house 📅 2026-01-01 ⏳3 #stale",
      "- [x] Done thing #house ✅ " + T,
    ].join("\n"),
  });
  const { tasks } = runPreflight(dir, "evening");
  const first = tasks.overdue.find((t) => t.text.startsWith("First time"));
  const third = tasks.overdue.find((t) => t.text.startsWith("Third time"));
  assert.match(first.action, /⏳1/, "a first appearance should bump the counter to 1");
  assert.match(third.action, /DROP/, "a fourth appearance must drop out, per rule 3");
  assert.ok(!tasks.overdue.some((t) => t.text.startsWith("Already parked")),
    "a #stale task must never be nagged again");
  assert.equal(tasks.stale.length, 1, "but it must stay visible for the weekly review");
  rmSync(dir, { recursive: true, force: true });
});

test("today's completed tasks are counted for the day log", () => {
  const dir = fixture({ "tasks.md": "# Tasks\n- [x] Done today ✅ " + T + "\n- [x] Done before ✅ 2026-01-01\n" });
  const { day } = runPreflight(dir, "evening");
  assert.equal(day.tasksCompleted, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("an unset calendar feed is reported as unhealthy, never as a free day", () => {
  // The failure this guards: with every feed missing, fetch-calendar returned
  // `sources: []` — no events AND no unhealthy sources, which reads exactly like
  // a clear diary. Golden rule 5: silence must be loud.
  const dir = fixture({ "tasks.md": "# Tasks\n" });
  const { calendar } = runPreflight(dir);
  assert.equal(calendar.today.length, 0);
  assert.ok(calendar.sources.length >= 1, "a missing feed must appear as a source");
  assert.ok(calendar.sources.every((s) => s.ok === false));
  assert.match(calendar.sources.map((s) => s.error).join(" "), /not set/);
  rmSync(dir, { recursive: true, force: true });
});

test("the gap question honours the 14-day and three-ask limits", () => {
  const dir = fixture({
    "tasks.md": "# Tasks\n",
    "_meta/gaps.md": [
      "# Gaps", "", "## Open", "",
      "- [ ] Asked yesterday, too soon to repeat. #work",
      "      _(asked: " + T + ")_",
      "- [ ] Asked three times already. #work",
      "      _(asked: 2026-01-01)_ _(asked: 2026-02-01)_ _(asked: 2026-03-01)_",
      "- [ ] The one that should be asked. #health",
      "",
    ].join("\n"),
  });
  const { gaps } = runPreflight(dir, "evening");
  assert.ok(gaps.next, "an eligible gap was available and none was offered");
  assert.match(gaps.next.text, /should be asked/);
  assert.equal(gaps.openCount, 3);
  rmSync(dir, { recursive: true, force: true });
});

test("no eligible gap yields null rather than a manufactured question", () => {
  const dir = fixture({
    "tasks.md": "# Tasks\n",
    "_meta/gaps.md": "# Gaps\n\n## Open\n\n- [ ] Asked today. #work _(asked: " + T + ")_\n",
  });
  const { gaps } = runPreflight(dir, "evening");
  assert.equal(gaps.next, null);
  assert.ok(gaps.parkedNext, "the reason should be stated, not left blank");
  rmSync(dir, { recursive: true, force: true });
});
