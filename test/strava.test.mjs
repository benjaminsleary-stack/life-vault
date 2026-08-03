/**
 * Tests for the Strava run summary.
 *
 *   node --test test/
 *
 * Only the pure shaping is tested — the network half is credentials and HTTP,
 * and cannot be exercised without a real account. What matters here is that the
 * numbers are right, because they are about to become dated fragments in
 * projects/running-fitness.md and the briefs will reason from them.
 *
 * The week-on-week comparison is the point. Ben has had three injuries since
 * restarting (Achilles, knees, ankle) against a half-marathon goal, and the
 * useful thing to record is not "you ran 5k" but how the week compares to the
 * one before it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { summariseRuns, pace } from "../scripts/fetch-strava.mjs";

const TODAY = "2026-08-15";
const day = (n) => {
  const d = new Date(`${TODAY}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
// A Strava activity, near enough.
const act = (o) => ({
  id: Math.random(), name: "Morning Run", sport_type: "Run",
  distance: 5000, moving_time: 1800, total_elevation_gain: 20,
  start_date_local: `${o.date}T07:00:00Z`, ...o,
});

/* ------------------------------------------------------------------- pace */

test("pace is minutes per km, zero-padded", () => {
  assert.equal(pace(5000, 1500), "5:00");
  assert.equal(pace(5000, 1530), "5:06");
  assert.equal(pace(10000, 3000), "5:00");
  assert.equal(pace(0, 100), null);
  assert.equal(pace(1000, 0), null);
});

/* ------------------------------------------------------------------- runs */

test("only running activities count", () => {
  const { runs } = summariseRuns([
    act({ date: day(-1), sport_type: "Run" }),
    act({ date: day(-2), sport_type: "TrailRun" }),
    act({ date: day(-3), sport_type: "VirtualRun" }),
    act({ date: day(-1), sport_type: "Ride" }),
    act({ date: day(-1), sport_type: "Swim" }),
    act({ date: day(-1), sport_type: "WeightTraining" }),
  ], TODAY);
  assert.equal(runs.length, 3, "the bike and the swim are not runs");
});

test("an older activity with `type` and no `sport_type` still counts", () => {
  const a = act({ date: day(-1) });
  delete a.sport_type;
  a.type = "Run";
  assert.equal(summariseRuns([a], TODAY).runs.length, 1);
});

test("a run carries the numbers a runner actually reads", () => {
  const { runs } = summariseRuns([
    act({ date: day(-1), distance: 8000, moving_time: 2400, total_elevation_gain: 55, average_heartrate: 152.4, max_heartrate: 171 }),
  ], TODAY);
  assert.deepEqual(runs[0], {
    id: runs[0].id, date: day(-1), name: "Morning Run",
    km: 8, minutes: 40, pace: "5:00", elevation: 55, avgHr: 152, maxHr: 171,
  });
});

test("runs come back newest first", () => {
  const { runs } = summariseRuns([
    act({ date: day(-5) }), act({ date: day(-1) }), act({ date: day(-3) }),
  ], TODAY);
  assert.deepEqual(runs.map((r) => r.date), [day(-1), day(-3), day(-5)]);
});

test("no heart rate is null, not zero — the watch may not have been worn", () => {
  const { runs } = summariseRuns([act({ date: day(-1) })], TODAY);
  assert.equal(runs[0].avgHr, null);
  assert.equal(runs[0].maxHr, null);
});

/* -------------------------------------------------------------- the weeks */

test("this week and last week are split at seven days", () => {
  const { weeks } = summariseRuns([
    act({ date: day(-1), distance: 5000 }),
    act({ date: day(-6), distance: 5000 }),
    act({ date: day(-8), distance: 4000 }),
    act({ date: day(-13), distance: 4000 }),
  ], TODAY);
  assert.equal(weeks.thisWeek.runs, 2);
  assert.equal(weeks.thisWeek.km, 10);
  assert.equal(weeks.lastWeek.runs, 2);
  assert.equal(weeks.lastWeek.km, 8);
});

test("a big jump in weekly distance is stated as a fact", () => {
  // This is the pattern that has cost him three injuries. Reported as a number,
  // never as advice — the vault does not do sports medicine.
  const { weeks } = summariseRuns([
    act({ date: day(-1), distance: 10000 }),
    act({ date: day(-3), distance: 10000 }),
    act({ date: day(-9), distance: 10000 }),
  ], TODAY);
  assert.equal(weeks.thisWeek.km, 20);
  assert.equal(weeks.lastWeek.km, 10);
  assert.equal(weeks.changePct, 100);
  assert.match(weeks.note, /up 100% on last week \(10km → 20km\)/);
});

test("a steady week says nothing", () => {
  const { weeks } = summariseRuns([
    act({ date: day(-1), distance: 10000 }),
    act({ date: day(-9), distance: 10000 }),
  ], TODAY);
  assert.equal(weeks.changePct, 0);
  assert.equal(weeks.note, null, "no note when nothing changed");
});

test("a jump off a tiny base is not reported as a percentage", () => {
  // 2km to 4km is +100% and means nothing at all. Percentages need a base.
  const { weeks } = summariseRuns([
    act({ date: day(-1), distance: 4000 }),
    act({ date: day(-9), distance: 2000 }),
  ], TODAY);
  assert.equal(weeks.changePct, null);
  assert.equal(weeks.note, null);
});

test("coming back from injury after weeks off does not divide by zero", () => {
  // Exactly Ben's situation on 1 Aug: three weeks off, then a first run back.
  const { weeks } = summariseRuns([act({ date: day(-1), distance: 3000 })], TODAY);
  assert.equal(weeks.thisWeek.km, 3);
  assert.equal(weeks.lastWeek.km, 0);
  assert.equal(weeks.changePct, null, "no base to compare against");
  assert.equal(weeks.note, null);
});

test("nothing at all is a valid, quiet answer", () => {
  const s = summariseRuns([], TODAY);
  assert.deepEqual(s.runs, []);
  assert.equal(s.weeks.thisWeek.km, 0);
  assert.equal(s.weeks.note, null);
});

test("an activity with no date is dropped rather than dated to nothing", () => {
  const a = act({ date: day(-1) });
  delete a.start_date_local;
  assert.equal(summariseRuns([a], TODAY).runs.length, 0);
});

test("local start date is used, not UTC", () => {
  // A 07:00 run in France is the 14th locally and the 14th in start_date_local.
  // Using start_date (UTC) instead would file some evening runs a day early.
  const { runs } = summariseRuns([
    { ...act({ date: "x" }), start_date_local: "2026-08-14T07:00:00Z", start_date: "2026-08-13T23:00:00Z" },
  ], TODAY);
  assert.equal(runs[0].date, "2026-08-14");
});
