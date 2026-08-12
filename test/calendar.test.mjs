/**
 * Tests for worker/calendar.js — the shared calendar-read module.
 *
 *   node --test test/
 *
 * WHY THIS EXISTS
 * ---------------
 * Calendar reading used to live twice: once in worker/vault.js (the dashboard)
 * and once in scripts/fetch-calendar.mjs (the brief). The two drifted — the
 * family feed reached the app but not the brief, and an *unset* feed vanished
 * from the brief entirely, so "the secret isn't wired up" and "nothing on today"
 * were the same empty list. calendar.js makes the feed list and the private wall
 * exist once; these tests pin the behaviour both callers now share.
 *
 * readCalendarEvents takes its fetch as an argument, so there is nothing to stub
 * globally — a fake fetchText returns fixture .ics.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { selectFeeds, readCalendarEvents, isPrivateEvent } from "../worker/calendar.js";
import { today } from "../worker/vault.js";

// A one-day .ics with the given SUMMARYs, all on `day` as all-day events.
function icsFor(day, ...summaries) {
  const stamp = day.replace(/-/g, "");
  const body = summaries.flatMap((s, i) => [
    "BEGIN:VEVENT", `UID:${i}`, `DTSTART;VALUE=DATE:${stamp}`, `SUMMARY:${s}`, "END:VEVENT",
  ]);
  return ["BEGIN:VCALENDAR", "VERSION:2.0", ...body, "END:VCALENDAR"].join("\r\n");
}

test("selectFeeds names all three feeds and honours the ICS_URL fallback", () => {
  const feeds = selectFeeds({ CAL_WORK: "w", ICS_URL: "legacy", CAL_FAMILY: "f" });
  const byName = Object.fromEntries(feeds.map((f) => [f.name, f]));
  assert.equal(byName.work.url, "w");
  assert.equal(byName.personal.url, "legacy", "ICS_URL is the legacy personal feed");
  assert.equal(byName.family.url, "f");
  // Every feed carries its env-var name, so an unset one can say which secret.
  assert.equal(byName.work.key, "CAL_WORK");
});

test("CAL_PERSONAL wins over the legacy ICS_URL when both are set", () => {
  const personal = selectFeeds({ CAL_PERSONAL: "new", ICS_URL: "old" }).find((f) => f.name === "personal");
  assert.equal(personal.url, "new");
});

test("an unset feed reports ok:false naming its env var, not silence", async () => {
  // The bug that started all this: a missing secret used to drop the feed
  // entirely, so the brief showed a blank calendar instead of "not connected".
  const day = today();
  const feeds = selectFeeds({ CAL_WORK: "https://example.invalid/w.ics" }); // personal + family unset
  const { events, sources } = await readCalendarEvents(
    feeds, day, day, async () => icsFor(day, "Team JGC"),
  );
  const byName = Object.fromEntries(sources.map((s) => [s.name, s]));
  assert.equal(byName.work.ok, true);
  assert.equal(byName.personal.ok, false, "an unset feed must surface, not vanish");
  assert.match(byName.personal.error, /CAL_PERSONAL not set/);
  assert.match(byName.family.error, /CAL_FAMILY not set/);
  assert.equal(events.length, 1, "only the configured feed's events come through");
});

test("the private marker never reaches the events, and tags stay by source", async () => {
  const day = today();
  const feeds = selectFeeds({ CAL_WORK: "https://example.invalid/w.ics" });
  const { events } = await readCalendarEvents(
    feeds, day, day, async () => icsFor(day, "That week", "Team JGC"),
  );
  const titles = events.map((e) => e.title);
  assert.ok(titles.includes("Team JGC"), "ordinary events still come through");
  assert.ok(!titles.some((t) => /that week/i.test(t)), "the private marker must not surface");
  assert.equal(events[0].source, "work", "each occurrence is tagged with its feed");
});

test("one broken feed reports itself and never sinks the others", async () => {
  const day = today();
  const feeds = selectFeeds({
    CAL_WORK: "https://example.invalid/w.ics",
    CAL_PERSONAL: "https://example.invalid/p.ics",
  });
  const { events, sources } = await readCalendarEvents(feeds, day, day, async (feed) => {
    if (feed.name === "personal") throw new Error("HTTP 500");
    return icsFor(day, "Team JGC");
  });
  const byName = Object.fromEntries(sources.map((s) => [s.name, s]));
  assert.equal(byName.work.ok, true);
  assert.equal(byName.personal.ok, false);
  assert.match(byName.personal.error, /HTTP 500/);
  assert.equal(events.length, 1, "the healthy feed still renders");
});

test("isPrivateEvent trims and is case-insensitive", () => {
  assert.ok(isPrivateEvent("  That Week "));
  assert.ok(!isPrivateEvent("that weekend away"));
});
