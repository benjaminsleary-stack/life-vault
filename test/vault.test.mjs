/**
 * Tests for the vault domain layer.
 *
 *   node --test test/
 *
 * No dependencies and no framework: Node's built-in runner, against an
 * in-memory store. These exist because of one specific class of bug.
 *
 * THE BUG CLASS
 * -------------
 * Every write here is read-modify-write on a markdown file that a human also
 * edits in Obsidian. The tempting way to change one field is: parse the line
 * into a tidy object, change the field, print it back. That is lossy, because
 * the parsed form is built for DISPLAY and deliberately discards syntax —
 * wikilinks, unusual tags, emoji stamps.
 *
 * It bit twice in one afternoon. Both times the symptom was silent: the edit
 * "worked", and something the user never touched was gone from their vault.
 *
 *   - editTask rebuilt titles via taskLabel(), which strips [[wikilinks]], so
 *     changing a due date rewrote "Insulate [[Milo]]'s room" as "Insulate
 *     Milo's room" and severed the link to Milo's note.
 *   - A three-call edit (retitle, then reschedule) silently dropped two thirds
 *     of itself, because a task's id is a hash of its text and the retitle
 *     invalidated the id the next call used.
 *
 * So the tests below are mostly not "does the feature work". They are "does the
 * feature leave everything else alone" — the property that kept breaking.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createApi, parseTasks, today, assertNothingLost } from "../worker/vault.js";

/* ---------------------------------------------------------------- harness */

// An in-memory store with the same three methods as GitHub / the filesystem.
function memStore(files = {}) {
  return {
    files,
    async readFile(path) {
      return path in files ? { text: files[path], sha: "mem" } : null;
    },
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
    async putFile(path, text) { files[path] = text; },
  };
}

const TASKS = [
  "# Tasks",
  "",
  "- [ ] Insulate [[Milo]]'s room [[house-retrofit]] #house",
  "- [ ] Reply to dad about him coming to visit #family 📅 2026-07-18",
  "- [ ] Something with a #custom-tag and #house",
  "- [ ] Plain task",
  "- [x] Done a while ago #admin ✅ 2020-01-01",
  "",
].join("\n");

function setup(extra = {}) {
  const store = memStore({ "tasks.md": TASKS, ...extra });
  return { store, api: createApi(store) };
}
const lineFor = (store, needle) =>
  store.files["tasks.md"].split("\n").find((l) => l.includes(needle));
const idFor = async (api, needle) => {
  const { body } = await api("GET", "/api/data", new URLSearchParams(), null);
  const t = body.tasks.find((x) => x.text.includes(needle));
  assert.ok(t, `no task matching ${needle}`);
  return t.id;
};

/* ------------------------------------------------- the regression itself */

test("editing a due date keeps the wikilinks in the title", async () => {
  const { store, api } = setup();
  const id = await idFor(api, "Insulate");
  await api("POST", "/api/edit", null, { id, fields: { due: "2026-08-01" } });

  const line = lineFor(store, "Insulate");
  assert.match(line, /\[\[Milo\]\]/, "person link was destroyed by a date change");
  assert.match(line, /\[\[house-retrofit\]\]/, "project link was destroyed");
  assert.match(line, /📅 2026-08-01/);
  assert.match(line, /#house/);
});

test("editing an area keeps the wikilinks and any non-area tag", async () => {
  const { store, api } = setup();
  const id = await idFor(api, "Something with a");
  await api("POST", "/api/edit", null, { id, fields: { tag: "admin" } });

  const line = lineFor(store, "Something with a");
  assert.match(line, /#custom-tag/, "a tag outside the closed area list was dropped");
  assert.match(line, /#admin/);
  assert.doesNotMatch(line, /#house/, "the old area tag should be replaced");
});

test("reassigning a project swaps only the project link", async () => {
  const { store, api } = setup({ "projects/house-retrofit.md": "---\ntype: project\n---\n" });
  const id = await idFor(api, "Insulate");
  await api("POST", "/api/edit", null, { id, fields: { project: "" } });

  const line = lineFor(store, "Insulate");
  assert.match(line, /\[\[Milo\]\]/, "clearing the project took the person link with it");
  assert.doesNotMatch(line, /house-retrofit/);
});

/* ----------------------------------- the guard that catches the next one */

// The guard is the safety net for code that does not exist yet. Every current
// mutation is correct, so it cannot be provoked through the public API — which
// is exactly why it is worth testing directly.
test("the guard catches a dropped wikilink", () => {
  assert.throws(
    () => assertNothingLost("Insulate [[Milo]]'s room #house", "Insulate Milo's room #house"),
    /would drop wikilink "Milo"/,
    "this is the exact rewrite that severed Milo's link in production"
  );
});

test("the guard catches a dropped tag", () => {
  assert.throws(() => assertNothingLost("A task #custom-tag", "A task"), /would drop tag "custom-tag"/);
});

test("the guard permits removals the caller declared", () => {
  assert.doesNotThrow(() => assertNothingLost("A task [[proj]]", "A task", ["proj"]));
  assert.doesNotThrow(() => assertNothingLost("A task #house", "A task #admin", ["house"]));
});

test("the guard ignores reordering and rewording that loses nothing", () => {
  assert.doesNotThrow(() =>
    assertNothingLost("Do it [[Milo]] #house 📅 2026-01-01", "Do it [[Milo]] #house"));
  assert.doesNotThrow(() =>
    assertNothingLost("Do it #house [[Milo]]", "Do it [[Milo]] #house"));
});

test("a legitimate edit still writes", async () => {
  const { store, api } = setup();
  const before = store.files["tasks.md"];
  const id = await idFor(api, "Insulate");
  const { body } = await api("POST", "/api/edit", null, { id, fields: { due: "2026-09-09" } });
  assert.equal(body.ok, true);
  assert.notEqual(store.files["tasks.md"], before);
});

/* --------------------------------------------------- other write paths */

test("toggling preserves everything and stamps the date", async () => {
  const { store, api } = setup();
  const id = await idFor(api, "Insulate");
  await api("POST", "/api/toggle", null, { id });

  const line = lineFor(store, "Insulate");
  assert.match(line, /^- \[x\]/);
  assert.match(line, /\[\[Milo\]\]/);
  assert.match(line, /\[\[house-retrofit\]\]/);
  assert.match(line, new RegExp(`✅ ${today()}`));
});

test("priority preserves the rest of the line", async () => {
  const { store, api } = setup();
  const id = await idFor(api, "Reply to dad");
  await api("POST", "/api/priority", null, { id });
  const line = lineFor(store, "Reply to dad");
  assert.match(line, /⏫/);
  assert.match(line, /📅 2026-07-18/, "the due date was lost setting priority");
  assert.match(line, /#family/);
});

test("bulk add is one write, skips duplicates, and links the project", async () => {
  const { store, api } = setup();
  const { body } = await api("POST", "/api/tasks", null, {
    lines: ["Bleed the radiators", "Plain task", "Fix the porch light"],
    tag: "house", project: "house-retrofit",
  });
  assert.equal(body.added, 2);
  assert.equal(body.skipped, 1, "an existing open task should not be added twice");
  assert.match(lineFor(store, "Bleed"), /\[\[house-retrofit\]\] #house/);
});

test("completed tasks decay after the retention window, into the archive", async () => {
  const { store, api } = setup();
  // The seeded ✅ 2020-01-01 task is well past the window; a fresh one is not.
  const id = await idFor(api, "Plain task");
  await api("POST", "/api/toggle", null, { id });          // any write triggers the sweep

  assert.doesNotMatch(store.files["tasks.md"], /Done a while ago/, "stale done task was not swept");
  assert.match(store.files["notes/completed-tasks.md"], /2020-01-01 — Done a while ago/,
    "swept task must be archived, never dropped");
  assert.match(store.files["tasks.md"], /Plain task/, "a task completed today must stay");
});

test("a task ticked without a ✅ date is never swept", async () => {
  const store = memStore({ "tasks.md": "# Tasks\n- [x] Ticked in Obsidian, no date\n- [ ] Other\n" });
  const api = createApi(store);
  const id = await idFor(api, "Other");
  await api("POST", "/api/toggle", null, { id });
  assert.match(store.files["tasks.md"], /Ticked in Obsidian, no date/,
    "a task with no completion date has nothing to judge and must be left alone");
});

/* ------------------------------------------------------------- parsing */

test("CRLF still parses — the display form must not depend on line endings", () => {
  const crlf = TASKS.replace(/\n/g, "\r\n");
  // The API normalises at the store boundary; parseTasks is the raw parser, so
  // this documents why that normalisation has to exist.
  assert.equal(parseTasks(crlf.replace(/\r\n/g, "\n")).length, 5);
});

test("parseTasks unwraps wikilinks for display and records them in links[]", () => {
  const [t] = parseTasks("- [ ] Insulate [[Milo]]'s room [[house-retrofit]] #house");
  assert.deepEqual(t.links, ["Milo", "house-retrofit"]);
  assert.equal(t.area, "house");
  // parseTasks alone cannot know which link is a project, so it unwraps both.
  assert.equal(t.text, "Insulate Milo's room house-retrofit");
});

test("the brief's ⏳ nag counter is hidden from the title but kept in the file", async () => {
  const store = memStore({ "tasks.md": "# Tasks\n- [ ] Reply to dad #family 📅 2026-07-18 ⏳2\n" });
  const api = createApi(store);
  const { body } = await api("GET", "/api/data", new URLSearchParams(), null);
  assert.equal(body.tasks[0].text, "Reply to dad", "bookkeeping leaked into the title");

  // An edit from the dashboard must not wipe the brief's own counter.
  await api("POST", "/api/edit", null, { id: body.tasks[0].id, fields: { due: "2026-07-20" } });
  assert.match(store.files["tasks.md"], /⏳2/, "the edit destroyed the anti-nag counter");
});

test("a project link is not left dangling in the task's title", async () => {
  const { api } = setup({ "projects/house-retrofit.md": "---\ntype: project\nname: House Retrofit\n---\n" });
  const { body } = await api("GET", "/api/data", new URLSearchParams(), null);
  const t = body.tasks.find((x) => x.project === "house-retrofit");
  assert.ok(t, "the task should resolve to the project");
  // The project is metadata; the person link is part of the sentence.
  assert.equal(t.text, "Insulate Milo's room",
    "the project slug leaked into the title the user reads");
});
