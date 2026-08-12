#!/usr/bin/env node
/**
 * Print calendar events as JSON, for the briefing skills.
 *
 *   node scripts/fetch-calendar.mjs            # today + tomorrow
 *   node scripts/fetch-calendar.mjs 7          # the next 7 days
 *   node scripts/fetch-calendar.mjs 7 --back   # the last 7 days, ending today
 *
 * `--back` is what the `harvest` skill runs on. Until it existed the calendar
 * was read every morning for "what's on today" and then thrown away — three
 * feeds' worth of factual, zero-effort evidence about who Ben actually saw and
 * what he actually did, discarded daily while people/ notes sat empty.
 *
 * Reads the same feeds the dashboard does, from the same env vars:
 *   CAL_WORK       work Outlook published .ics
 *   CAL_PERSONAL   personal Google private .ics
 *   CAL_FAMILY     shared family Google private .ics
 *   ICS_URL        legacy name for the personal feed; still honoured
 *
 * Each is optional on its own, but every one you set must also exist as a GitHub
 * Actions secret — Actions secrets are separate from the Worker's, so a feed the
 * dashboard shows can still be missing from the brief.
 *
 * Values come from the environment, or from .env at the vault root when run on
 * the desktop. A private .ics URL is a credential — it is never printed.
 *
 * This replaces scripts/fetch-ics.py, which needed `icalendar` and `requests`
 * (neither of which was actually installed, so every brief since setup has
 * reported the calendar as unavailable) and parsed .ics a second, different way
 * from the dashboard. It is now a thin adapter over worker/calendar.js — the
 * same module the dashboard reads through — so the feed list and the private
 * wall are defined once and what the brief says and what the app shows cannot
 * disagree. This file keeps only what is CLI-specific: the .env loader, the
 * date window (including --back), and the brief's own event shape.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { selectFeeds, readCalendarEvents } from "../worker/calendar.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TZ = process.env.TZ_NAME || "Europe/London";

// .env at the vault root, so a desktop run needs no exported variables.
try {
  for (const line of readFileSync(join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
} catch { /* no .env is fine — CI supplies real env vars */ }

// The one feed definition (shared with the Worker and the dev server). Unset
// feeds are kept here, not filtered: readCalendarEvents reports each as
// ok:false naming its env var, so the brief can say which calendar is not
// connected instead of showing a spuriously empty day.
const feeds = selectFeeds(process.env);

const days = Math.max(1, parseInt(process.argv[2] || "2", 10));
const back = process.argv.includes("--back");
const fmt = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d);
const today = fmt(new Date());
const tomorrow = fmt(new Date(Date.now() + 864e5));
// Forward: today .. today+n. Back: today-n+1 .. today (today included, because
// a Sunday harvest should catch Sunday morning).
const from = back ? fmt(new Date(Date.now() - (days - 1) * 864e5)) : today;
const to = back ? today : fmt(new Date(Date.now() + (days - 1) * 864e5));

if (!feeds.some((f) => f.url)) {
  // `sources` names each missing feed, never `[]`. The one case where EVERY feed
  // is missing — the worst one — must still report unhealthy sources, or a caller
  // reading `sources` sees a clean bill of health on an empty calendar, which is
  // the failure this file exists to prevent. (readCalendarEvents reports unset
  // feeds too; this early-exit path names them itself.)
  const sources = feeds.map((f) => ({ name: f.name, ok: false, error: `${f.key} not set` }));
  console.log(JSON.stringify({ error: "no calendar feeds set (CAL_WORK / CAL_PERSONAL / CAL_FAMILY)", events: [], sources }));
  process.exit(1);
}

const fetchText = async (feed) => {
  const r = await fetch(feed.url, { headers: { "User-Agent": "life-vault" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
};
const { events: occ, sources } = await readCalendarEvents(feeds, from, to, fetchText, { zone: TZ });

// Map the shared module's canonical occurrences to the brief's own shape.
const events = occ.map((e) => ({
  date: e.date,
  // Anchored on the real today, not on the window start — with --back the first
  // day of the window is a week ago, and labelling it "today" would put last
  // Sunday's events in a brief as if they were now.
  when: e.date === today ? "today" : e.date === tomorrow ? "tomorrow" : e.date,
  time: e.allDay ? "all-day" : e.time,
  title: e.title,
  location: e.location,
  minutes: e.minutes,
  calendar: e.source,
}));

console.log(JSON.stringify({ count: events.length, from, to, sources, events }, null, 2));

// Loud failure: a calendar that silently stopped syncing looks like a free week.
if (sources.some((s) => !s.ok)) process.exit(2);
