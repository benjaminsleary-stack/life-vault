/**
 * Tests for scripts/assert-brief.mjs — the mechanical "is this actually a brief"
 * check that runs after every brief skill.
 *
 *   node --test test/assert-brief.test.mjs
 *
 * WHY IT EXISTS
 * -------------
 * Both brief prompts have always ended with "assert your own output: the file
 * exists, is >200 bytes, carries all five headings". On 21 August 2026 the
 * morning brief came out at 164 bytes with every section empty and recorded
 * `ok: true, delivered: true`, with no alert — the sixth consecutive morning
 * with no News at all. Asking the failing component to grade itself does not
 * work. `run-skill.sh` had already learned this about delivery ("too important
 * to depend on a model remembering the last step of a prompt"); this is the
 * same lesson applied to the output itself.
 *
 * The first version of the check was itself broken in a way only a test caught:
 * it closed a section with a `(?=^##\s|\z)` lookahead, and `\z` is not a
 * JavaScript escape — it matches a literal "z". The LAST section of a file
 * (which News always is) therefore only closed if it happened to contain the
 * letter z. Live, that would have reported every brief hollow, including good
 * ones — a checker that cries wolf gets muted, and then the real failure is
 * invisible again.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts/assert-brief.mjs");
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());
const human = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London", weekday: "short", day: "2-digit", month: "short",
}).format(new Date());

// Write a brief into a throwaway vault and check it, returning {code, out}.
// The script resolves the vault root from its OWN location, so it is copied in
// rather than pointed at — otherwise every case here would silently grade the
// real digests/ instead of the fixture, and pass or fail for the wrong reasons.
function check(skill, body, name = `${today}-morning.md`) {
  const dir = mkdtempSync(join(tmpdir(), "lv-assert-"));
  mkdirSync(join(dir, "digests"), { recursive: true });
  mkdirSync(join(dir, "scripts"), { recursive: true });
  cpSync(SCRIPT, join(dir, "scripts/assert-brief.mjs"));
  writeFileSync(join(dir, "digests", name), body);
  try {
    const out = execFileSync(process.execPath, [join(dir, "scripts/assert-brief.mjs"), skill, `digests/${name}`], {
      cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || "") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const morning = (news) => [
  `# Morning — ${human}`, "",
  "## Today's calendar", "- 09:00 — A real meeting _(work)_", "",
  "## Due / overdue", "—", "",
  "## Inbox that needs you", "—", "",
  "## For Charlotte", "**Something she said** — on the 1st. _(logged 2026-08-01)_", "",
  "## News", news, "",
].join("\n");

test("a sound brief passes", () => {
  const r = check("morning-brief",
    morning("**[Headline](https://example.com/a)** — a thing happened. _(Reuters · centre)_"));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /looks sound/);
});

test("News is the LAST section and still closes correctly", () => {
  // The `\z` regression: a final section with no letter z in it read as empty.
  const r = check("morning-brief",
    morning("**[Rain in Cambridge](https://example.com/b)** — it rained. _(BBC · centre)_"));
  assert.equal(r.code, 0, "a real last section must not read as empty: " + r.out);
});

test("an empty News section fails, however long the rest is", () => {
  const r = check("morning-brief", morning("—"));
  assert.equal(r.code, 1);
  assert.match(r.out, /News section is empty/);
});

test("the ⚠ health marker is not content", () => {
  // The marker is the note saying there ISN'T any news. Counting it as an item
  // is precisely how six empty mornings passed for healthy.
  const r = check("morning-brief", morning("—\n\n⚠ news: no sources found"));
  assert.equal(r.code, 1, "a ⚠ line must not satisfy the News requirement");
  assert.match(r.out, /News section is empty/);
});

test("a 164-byte brief fails on size — the one that actually shipped", () => {
  const r = check("morning-brief", [
    `# Morning — ${human}`, "",
    "## Today's calendar", "—", "",
    "## Due / overdue", "—", "",
    "## Inbox that needs you", "—", "",
    "## For Charlotte", "—", "",
    "## News", "—", "",
  ].join("\n"));
  assert.equal(r.code, 1);
  assert.match(r.out, /too thin to be a brief/);
});

test("a missing heading is named", () => {
  const r = check("morning-brief",
    morning("**[H](https://e.com/a)** — x. _(Reuters · centre)_").replace("## For Charlotte\n", ""));
  assert.equal(r.code, 1);
  assert.match(r.out, /"For Charlotte" heading is missing/);
});

test("a brief filed under the wrong day is caught", () => {
  const r = check("morning-brief",
    morning("**[H](https://e.com/a)** — x. _(Reuters · centre)_"), "2020-01-01-morning.md");
  assert.equal(r.code, 1);
  assert.match(r.out, /is it the right day's\?/);
});

test("the evening brief is not required to carry news", () => {
  // Sized like a real one — they run 560–932 bytes, so the shared >200 bar is
  // nowhere near them even on a quiet night.
  const r = check("evening-brief", [
    `# Evening — ${human}`, "",
    "## Tomorrow",
    "- 09:00 — Girton College site progress meeting _(work)_",
    "- All day — Jasper's swimming lesson _(family)_", "",
    "## Charlotte",
    "Nothing captured or logged today.", "",
    "## Advice",
    "- Ask her about the thing she mentioned on Tuesday, before the week runs out.",
    "- The anniversary is three weeks off; a booking made now is one made in time.", "",
    "## One question",
    "You don't actually know what you weigh — what does the scale say?", "",
  ].join("\n"), `${today}-evening.md`);
  assert.equal(r.code, 0, r.out);
});
