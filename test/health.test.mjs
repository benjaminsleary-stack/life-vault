/**
 * Tests for the parts of the domain layer that had none: the health check, the
 * private-calendar filter, habits and lists.
 *
 *   node --test test/
 *
 * WHY THESE, AND WHY NOW
 * ----------------------
 * vault.test.mjs covers tasks thoroughly and nothing else. Two of the gaps had
 * already cost something real:
 *
 *   - health() could only see whether a routine had RUN. Between 20 Jul and
 *     1 Aug 2026 every brief was written, pushed, and delivered to nobody, on
 *     a delivery secret that was present but empty — and the dashboard said
 *     "all routines on schedule" for twelve days straight. Golden rule 5 says
 *     silence must be loud; nothing asserted that it was. Delivery has since
 *     moved to the vault's own Web Push, but the failure mode is identical:
 *     a brief can be written, committed and pushed, and reach nobody.
 *
 *   - PRIVATE_EVENT is a binding CLAUDE.md rule (an event titled "That week" is
 *     Charlotte's cycle and must never surface in a brief, digest or nudge)
 *     enforced by one regex, duplicated in two files, asserted nowhere.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createApi, today } from "../worker/vault.js";

function memStore(files = {}) {
  return {
    files,
    async readFile(path) { return path in files ? { text: files[path], sha: "mem" } : null; },
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

const nowISO = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
// A .status file as run-skill.sh writes it.
const status = (skill, extra = {}) => JSON.stringify({
  skill, ok: true, when: nowISO(), outputs: [`digests/${today()}-morning.md`],
  error: "", delivered: null, deliveryError: "", model: "sonnet",
  tokens: { in: 1, out: 1, cache: 1 }, cost_usd: 0.1, ...extra,
});
// Every cadenced skill in EXPECTED, all healthy. Keep this in step with
// EXPECTED in vault.js — a skill missing here shows up as "overdue" and fails
// the unrelated tests below, which is how family-events announced itself.
const CADENCED = ["morning-brief", "evening-brief", "interest-scout", "harvest", "family-events"];
const allRan = (extra = {}) =>
  Object.fromEntries(CADENCED.map((s) => [`inbox/_runs/${s}.status`, status(s, extra[s])]));
const health = async (files) => {
  const { body } = await createApi(memStore(files))("GET", "/api/health", new URLSearchParams(), null);
  return body;
};

/* ------------------------------------------------------------------ health */

test("all routines run and delivered reads as healthy", async () => {
  const h = await health(allRan({ "morning-brief": { delivered: true } }));
  assert.equal(h.ok, true);
  assert.equal(h.summary, "all routines on schedule");
});

test("a brief that ran but never reached the phone is NOT a healthy run", async () => {
  // The twelve-day failure, as a test. Everything about this run succeeded
  // except the only part Ben experiences.
  const h = await health(allRan({
    "morning-brief": { delivered: false, deliveryError: "no devices are registered for notifications" },
  }));
  assert.equal(h.ok, false, "undelivered must not read as ok");
  const c = h.checks.find((x) => x.name === "morning-brief");
  assert.equal(c.ok, false);
  assert.match(c.why, /never reached your phone/);
  assert.match(c.error, /no devices are registered/, "the reason must survive to the panel");
});

test("undelivered is its own summary line, not 'overdue' and not 'failed'", async () => {
  // These are three different problems with three different fixes. Undelivered
  // is a missing secret; overdue is a dead scheduler; failed is a broken skill.
  const h = await health(allRan({ "evening-brief": { delivered: false } }));
  assert.match(h.summary, /evening-brief not delivered/);
  assert.doesNotMatch(h.summary, /overdue/);
  assert.doesNotMatch(h.summary, /failed/);
});

test("a skill with no delivery expectation is never marked undelivered", async () => {
  // harvest and file-inbox don't push anything; `delivered: null` must stay
  // silent rather than reading as a failure.
  const h = await health(allRan());
  assert.equal(h.ok, true);
  assert.equal(h.checks.find((x) => x.name === "harvest").ok, true);
});

test("an overdue routine still reports overdue, with its age", async () => {
  const old = new Date(Date.now() - 5 * 864e5).toISOString().replace(/\.\d+Z$/, "Z");
  const h = await health({ ...allRan(), "inbox/_runs/morning-brief.status": status("morning-brief", { when: old }) });
  assert.equal(h.ok, false);
  assert.match(h.summary, /morning-brief overdue/);
  assert.match(h.checks.find((x) => x.name === "morning-brief").why, /5d since last run/);
});

test("a trigger nobody has claimed surfaces as stuck", async () => {
  const queued = new Date(Date.now() - 45 * 60000).toISOString().slice(0, 19);
  const h = await health({ ...allRan(), [`inbox/_runs/morning-brief-${queued.replace(/[-:]/g, "").replace(/^(\d{4})(\d{2})(\d{2})T/, "$1-$2-$3T")}.run`]: "{}" });
  assert.equal(h.stuck.length, 1);
  assert.match(h.summary, /queued with no runner/);
});

test("a malformed .status file is skipped, not fatal", async () => {
  const h = await health({ ...allRan(), "inbox/_runs/weave.status": "{not json" });
  assert.ok(h.checks.length >= 4, "the readable statuses still report");
});

/* ------------------------------------------ standing instructions vs tasks */

test("every scheduled routine is wired end to end", async () => {
  // A routine is only real if all four places agree: the skill file, the
  // Cloudflare cron, the cron->skill map, and EXPECTED (which is what notices
  // when it stops running). family-events was originally filed as a checkbox in
  // tasks.md instead of any of them — a job the system agreed to do, handed
  // back to Ben as a chore. This asserts the wiring, so the next one can't be
  // half-connected.
  const fs = await import("node:fs");
  const toml = fs.readFileSync("worker/wrangler.toml", "utf8");
  const worker = fs.readFileSync("worker/worker.js", "utf8");
  const vault = fs.readFileSync("worker/vault.js", "utf8");
  const dash = fs.readFileSync("dashboard/index.html", "utf8");

  const crons = [...toml.matchAll(/^\s*"([^"]+)",/gm)].map((m) => m[1]);
  assert.ok(crons.length >= 5, "expected the cron list to be found");

  for (const cron of crons) {
    const m = worker.match(new RegExp(`"${cron.replace(/\*/g, "\\*")}":\\s*"([\\w-]+)"`));
    assert.ok(m, `cron ${cron} has no entry in CRON_SKILL — it would tick and do nothing`);
    const skill = m[1];
    assert.ok(fs.existsSync(`_meta/skills/${skill}.md`), `${skill} has no skill file`);
    assert.match(vault, new RegExp(`"?${skill}"?:\\s*\\d+`), `${skill} is missing from EXPECTED`);
    assert.match(dash, new RegExp(`name:"${skill}"`), `${skill} has no row in the dashboard`);
  }
});

test("every cron is valid for CLOUDFLARE, whose day-of-week is 1-7", async () => {
  // Standard cron accepts 0 OR 7 for Sunday. Cloudflare accepts only 1-7 and
  // rejects the whole deploy with "invalid cron string" — which it did, live,
  // on `0 9 * * 0` for harvest, after the other triggers had already applied.
  const fs = await import("node:fs");
  const toml = fs.readFileSync("worker/wrangler.toml", "utf8");
  const crons = [...toml.matchAll(/^\s*"([^"]+)",/gm)].map((m) => m[1]);
  for (const cron of crons) {
    const f = cron.trim().split(/\s+/);
    assert.equal(f.length, 5, `${cron}: needs five fields`);
    const dow = f[4];
    if (dow === "*") continue;
    for (const part of dow.split(",")) {
      for (const n of part.split("-")) {
        if (!/^\d+$/.test(n)) continue;             // names like SUN are fine
        assert.ok(+n >= 1 && +n <= 7,
          `${cron}: day-of-week ${n} is invalid on Cloudflare — Sunday is 7, not 0`);
      }
    }
  }
});

test("the family-events instruction is a routine and not a task", async () => {
  const fs = await import("node:fs");
  const tasks = fs.readFileSync("tasks.md", "utf8");
  assert.doesNotMatch(tasks, /family-friendly events/i,
    "a standing instruction must never sit in tasks.md as a checkbox");
  assert.ok(fs.existsSync("_meta/skills/family-events.md"));
});

/* --------------------------------------------------- the private-event wall */

test("a private calendar marker never reaches the agenda", async () => {
  // CLAUDE.md: an event titled "That week" is Charlotte's cycle. It stays on
  // the calendar and never surfaces — not summarised, not alluded to.
  const day = today();
  const ics = [
    "BEGIN:VCALENDAR", "VERSION:2.0",
    "BEGIN:VEVENT", "UID:1", `DTSTART;VALUE=DATE:${day.replace(/-/g, "")}`,
    "SUMMARY:That week", "END:VEVENT",
    "BEGIN:VEVENT", "UID:2", `DTSTART;VALUE=DATE:${day.replace(/-/g, "")}`,
    "SUMMARY:Team JGC", "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(ics, { status: 200 });
  try {
    const api = createApi(memStore({ "tasks.md": "# Tasks\n" }),
      { calendars: [{ name: "personal", url: "https://example.invalid/x.ics" }] });
    const { body } = await api("GET", "/api/calendar", new URLSearchParams("fresh=1"), null);
    const titles = body.calendar.map((e) => e.title);
    assert.ok(titles.includes("Team JGC"), "ordinary events still come through");
    assert.ok(!titles.some((t) => /that week/i.test(t)), "the private marker must not surface");
  } finally { globalThis.fetch = realFetch; }
});

/* ------------------------------------------------------------------ habits */

const HABITS = [
  "# Habits", "", `(day:: ${today()})`, "",
  "## Morning routine", "- [ ] Gym or a walk", "- [ ] Supplements", "",
].join("\n");

test("ticking a habit logs it and leaves the other items alone", async () => {
  const store = memStore({ "habits.md": HABITS, "habits-log.md": "# Habits log\n" });
  const api = createApi(store);
  await api("POST", "/api/habit", new URLSearchParams(), { habit: "Morning routine", item: "Gym or a walk" });
  assert.match(store.files["habits.md"], /- \[x\] Gym or a walk/);
  assert.match(store.files["habits.md"], /- \[ \] Supplements/, "the untouched item stays untouched");
  assert.match(store.files["habits-log.md"], new RegExp(`- ${today()} — Morning routine / Gym or a walk`));
});

test("yesterday's ticks read as unchecked once the day marker is stale", async () => {
  // The checkboxes represent TODAY. A stale marker must not report last
  // Tuesday's gym session as done this morning.
  const stale = HABITS.replace(`(day:: ${today()})`, "(day:: 2020-01-01)")
    .replace("- [ ] Gym or a walk", "- [x] Gym or a walk");
  const api = createApi(memStore({ "habits.md": stale, "habits-log.md": "# Habits log\n" }));
  const { body } = await api("GET", "/api/data", new URLSearchParams(), null);
  const items = body.habits.flatMap((h) => h.items);
  assert.ok(items.every((i) => !i.done), "a stale day reports everything undone");
});

test("renaming a habit group keeps its items", async () => {
  const store = memStore({ "habits.md": HABITS, "habits-log.md": "# Habits log\n" });
  const api = createApi(store);
  await api("POST", "/api/habit/rename", new URLSearchParams(), { habit: "Morning routine", name: "Before work" });
  assert.match(store.files["habits.md"], /## Before work/);
  assert.match(store.files["habits.md"], /- \[ \] Supplements/);
});

/* ------------------------------------------------------------------- lists */

const LIST = [
  "---", "type: list", "name: Shopping", "tags: [house]", "---", "",
  "- [ ] Milk", "- [x] Bread", "",
].join("\n");

test("clearing a list moves ticked items to a dated Cleared section", async () => {
  // CLAUDE.md: cleared items append to a dated `## Cleared` section rather than
  // disappearing. A list that forgets is a list you stop trusting.
  const store = memStore({ "notes/shopping.md": LIST });
  const api = createApi(store);
  const { body } = await api("POST", "/api/list/clear", new URLSearchParams(), { list: "shopping" });
  assert.equal(body.cleared, 1);
  const out = store.files["notes/shopping.md"];
  assert.match(out, /## Cleared/);
  assert.match(out, /Bread/, "the cleared item is moved, never deleted");
  assert.match(out, /- \[ \] Milk/, "the open item stays open");
  assert.doesNotMatch(out.split("## Cleared")[0], /- \[x\] Bread/, "and leaves the live list");
});

test("adding to a list skips items already on it", async () => {
  const store = memStore({ "notes/shopping.md": LIST });
  const api = createApi(store);
  const { body } = await api("POST", "/api/list/add", new URLSearchParams(), { list: "shopping", lines: ["Milk", "Eggs"] });
  assert.equal(body.added, 1);
  assert.equal(store.files["notes/shopping.md"].match(/Milk/g).length, 1);
});
