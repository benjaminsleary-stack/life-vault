/**
 * Tests for open loops — reading dates OUT of fragment text.
 *
 *   node --test test/
 *
 * Ben, 1 Aug 2026, on what actually works with Charlotte: "remembering what's on
 * her mind and talking about it — my biggest problem is I can't track these
 * things." A fragment saying "her mum's operation is on the 14th" is priceless
 * on the 13th and useless on the 20th, so the date *inside the sentence* is what
 * matters, not the date the fragment was written.
 *
 * Two properties are load-bearing and both are asserted below:
 *   - the private wall holds. parseLog stops at the next heading, so `## Private`
 *     content can never reach a loop. That is structural, not a filter, and the
 *     test exists to keep it structural.
 *   - a guessed date is labelled as guessed. "the 14th" has no month in it;
 *     presenting the inference as fact would break golden rule 4.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createApi, today } from "../worker/vault.js";

function memStore(files = {}) {
  return {
    files,
    async readFile(p) { return p in files ? { text: files[p], sha: "mem" } : null; },
    async listDir(path) {
      const prefix = path.replace(/\/$/, "") + "/";
      const seen = new Set();
      for (const p of Object.keys(files)) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        if (!rest.includes("/")) seen.add(rest);
      }
      return [...seen].map((name) => ({ name, path: prefix + name }));
    },
    async putFile(p, text) { files[p] = text; },
  };
}

const shift = (n) => {
  const d = new Date(today() + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// A person note whose log is supplied as [{ logged, text }].
const person = (name, log) => [
  "---", "type: person", `name: ${name}`, "tags: [family]", "---", "",
  "## What to know", "Someone.", "", "## Log",
  ...log.map((l) => `- ${l.logged} — ${l.text}`), "",
].join("\n");

const loopsFor = async (files) => {
  const { body } = await createApi(memStore({ "tasks.md": "# Tasks\n", ...files }))(
    "GET", "/api/data", new URLSearchParams(), null);
  return body.loops;
};

test("an ISO date in a fragment becomes a loop", async () => {
  const when = shift(5);
  const loops = await loopsFor({
    "people/charlotte.md": person("Charlotte", [{ logged: today(), text: `Her mum's operation is on ${when}.` }]),
  });
  assert.equal(loops.length, 1);
  assert.equal(loops[0].date, when);
  assert.equal(loops[0].who, "Charlotte");
  assert.equal(loops[0].exact, true);
  assert.equal(loops[0].daysAway, 5);
});

test('"14 August" and "August 14" both resolve, and are exact', async () => {
  const a = await loopsFor({ "people/a.md": person("A", [{ logged: "2026-08-01", text: "Op on 14 August." }]) });
  const b = await loopsFor({ "people/b.md": person("B", [{ logged: "2026-08-01", text: "Op on August 14." }]) });
  for (const l of [a, b]) {
    if (!l.length) continue;             // outside the 21-day window when run later
    assert.equal(l[0].date, "2026-08-14");
    assert.equal(l[0].exact, true);
  }
});

test('"the 14th" resolves but is flagged as a guess', async () => {
  // There is no month in that sentence. Presenting the inference as fact would
  // be inventing a date, which rule 4 forbids — so `exact` is false and the UI
  // says "month assumed".
  const d = new Date(today() + "T12:00:00Z");
  const target = Math.min(28, d.getUTCDate() + 3);
  const loops = await loopsFor({
    "people/c.md": person("C", [{ logged: today(), text: `Her mum's operation is on the ${target}th.` }]),
  });
  assert.equal(loops.length, 1);
  assert.equal(loops[0].exact, false, "an inferred month must be labelled");
  assert.equal(loops[0].date.slice(-2), String(target).padStart(2, "0"));
});

test('a weekday resolves to the next one after the fragment was written', async () => {
  // "she was dreading Thursday" — written on a Monday means this Thursday.
  const loops = await loopsFor({
    "people/d.md": person("D", [{ logged: shift(-1), text: "Dreading the presentation on Thursday." }]),
  });
  if (loops.length) {
    assert.equal(loops[0].exact, false);
    assert.equal(new Date(loops[0].date + "T12:00:00Z").getUTCDay(), 4, "must land on a Thursday");
  }
});

test("a fragment with no date is not a loop", async () => {
  const loops = await loopsFor({
    "people/e.md": person("E", [{ logged: today(), text: "She is tired of my depression." }]),
  });
  assert.deepEqual(loops, []);
});

test("loops age out three days after the date, and stop 21 days ahead", async () => {
  const loops = await loopsFor({
    "people/f.md": person("F", [
      { logged: shift(-40), text: `Long gone: ${shift(-10)}.` },
      { logged: today(), text: `Just past: ${shift(-2)}.` },
      { logged: today(), text: `Soon: ${shift(2)}.` },
      { logged: today(), text: `Far off: ${shift(60)}.` },
    ]),
  });
  const dates = loops.map((l) => l.date);
  assert.ok(dates.includes(shift(-2)), "just-past stays — you may still need to ask how it went");
  assert.ok(dates.includes(shift(2)), "upcoming stays");
  assert.ok(!dates.includes(shift(-10)), "long gone is history, not a loop");
  assert.ok(!dates.includes(shift(60)), "beyond the horizon is not actionable");
});

test("loops are sorted by the date they point at, soonest first", async () => {
  const loops = await loopsFor({
    "people/g.md": person("G", [
      { logged: today(), text: `Later: ${shift(9)}.` },
      { logged: today(), text: `Sooner: ${shift(1)}.` },
    ]),
  });
  assert.deepEqual(loops.map((l) => l.date), [shift(1), shift(9)]);
});

/* ------------------------------------------------------------ the private wall */

test("a dated line under ## Private NEVER becomes a loop", async () => {
  // CLAUDE.md: a `## Private` section is never surfaced in a brief, digest,
  // notification or nudge. The loops card is all four. This holds because
  // parseLog stops at the next heading — the test keeps it that way.
  const when = shift(3);
  const note = [
    "---", "type: person", "name: Charlotte", "tags: [family]", "---", "",
    "## What to know", "Wife.", "",
    "## Private", "", `- Cycle marker due ${when}, tracked on the calendar.`, "",
    "## Log", `- ${today()} — Nothing dated here.`, "",
  ].join("\n");
  const loops = await loopsFor({ "people/charlotte.md": note });
  assert.deepEqual(loops, [], "private content must not reach the loops card");
});

test("a ## Private section AFTER the log doesn't leak either", async () => {
  const when = shift(3);
  const note = [
    "---", "type: person", "name: Charlotte", "tags: [family]", "---", "",
    "## Log", `- ${today()} — Her mum's op is on ${when}.`, "",
    "## Private", "", `- Something else on ${shift(4)}.`, "",
  ].join("\n");
  const loops = await loopsFor({ "people/charlotte.md": note });
  assert.equal(loops.length, 1, "only the log fragment");
  assert.equal(loops[0].date, when);
});

test("the surfaced stamp is stripped from the loop's text", async () => {
  const when = shift(2);
  const loops = await loopsFor({
    "people/h.md": person("H", [{ logged: today(), text: `Op on ${when}. _(surfaced: ${today()})_` }]),
  });
  assert.equal(loops.length, 1);
  assert.doesNotMatch(loops[0].text, /surfaced/, "bookkeeping must not render into the card");
});

test("projects contribute loops too, not just people", async () => {
  const when = shift(4);
  const loops = await loopsFor({
    "projects/house-retrofit.md": [
      "---", "type: project", "name: House Retrofit", "tags: [house]", "---", "",
      "## Log", `- ${today()} — Skirting booked for ${when}.`, "",
    ].join("\n"),
  });
  assert.equal(loops.length, 1);
  assert.equal(loops[0].who, "House Retrofit");
});

test("the same person and date logged twice is one loop, with the fuller text", async () => {
  // Jasper's birthday was logged as a fact and again as a correction, both
  // pointing at the same day, and the card showed it twice.
  const when = shift(6);
  const loops = await loopsFor({
    "people/j.md": person("J", [
      { logged: today(), text: `Turns 5 on ${when}.` },
      { logged: today(), text: `Correction: he turns 5 on ${when}, so he is 4 until then.` },
    ]),
  });
  assert.equal(loops.length, 1, "one date, one row");
  assert.match(loops[0].text, /Correction/, "keeps the fuller telling");
});

test("a fragment wrapped over several lines is read whole", async () => {
  // parseLog took only the first line, so any fragment past ~80 characters
  // rendered cut off mid-clause — most of the substantial ones.
  const when = shift(3);
  const note = [
    "---", "type: person", "name: K", "tags: [family]", "---", "",
    "## Log",
    `- ${today()} — Her mum's operation is on ${when}, and she is worried about`,
    "  getting time off work to be there for it.",
    "",
  ].join("\n");
  const loops = await loopsFor({ "people/k.md": note });
  assert.equal(loops.length, 1);
  assert.match(loops[0].text, /time off work to be there for it\.$/, "the whole sentence survives");
});

test("the surfaced stamp is stripped even when it trails a wrapped fragment", async () => {
  const when = shift(3);
  const note = [
    "---", "type: person", "name: L", "tags: [family]", "---", "",
    "## Log",
    `- ${today()} — Op on ${when}, and she is anxious about`,
    `  the whole thing. _(surfaced: ${today()})_`,
    "",
  ].join("\n");
  const loops = await loopsFor({ "people/l.md": note });
  assert.doesNotMatch(loops[0].text, /surfaced/);
  assert.match(loops[0].text, /anxious about the whole thing\.$/);
});
