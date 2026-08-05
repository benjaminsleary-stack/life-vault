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
 * from the dashboard. It now shares worker/ical.js, so what the brief says and
 * what the app shows cannot disagree.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseICS, expandEvents } from "../worker/ical.js";

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

// Same three feeds the dashboard subscribes to. Family was missing here, so
// shared-calendar events (birthdays, trips, the boys' things) never reached a
// brief even though the app showed them.
const configured = [
  { name: "work", url: process.env.CAL_WORK, env: "CAL_WORK" },
  { name: "personal", url: process.env.CAL_PERSONAL || process.env.ICS_URL, env: "CAL_PERSONAL" },
  { name: "family", url: process.env.CAL_FAMILY, env: "CAL_FAMILY" },
];
const feeds = configured.filter((f) => f.url);
// An unset feed used to vanish entirely, so "secret missing" and "free day" were
// the same empty list. Report it as a source that is not ok — the brief is told
// to print an unhealthy source rather than an empty calendar.
const unset = configured
  .filter((f) => !f.url)
  .map((f) => ({ name: f.name, ok: false, error: `${f.env} not set` }));

const days = Math.max(1, parseInt(process.argv[2] || "2", 10));
const back = process.argv.includes("--back");
const fmt = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d);
const today = fmt(new Date());
const tomorrow = fmt(new Date(Date.now() + 864e5));
// Forward: today .. today+n. Back: today-n+1 .. today (today included, because
// a Sunday harvest should catch Sunday morning).
const from = back ? fmt(new Date(Date.now() - (days - 1) * 864e5)) : today;
const to = back ? today : fmt(new Date(Date.now() + (days - 1) * 864e5));

if (!feeds.length) {
  // `sources: unset`, not `sources: []`. This path threw away the very list it
  // had just built, so the one case where EVERY feed is missing — the worst
  // one — reported no unhealthy sources at all, and a caller reading `sources`
  // saw a clean bill of health on an empty calendar. That is the failure this
  // file's own comment above says it exists to prevent.
  console.log(JSON.stringify({ error: "no calendar feeds set (CAL_WORK / CAL_PERSONAL / CAL_FAMILY)", events: [], sources: unset }));
  process.exit(1);
}

const events = [];
const sources = [...unset];
await Promise.all(feeds.map(async (feed) => {
  try {
    const r = await fetch(feed.url, { headers: { "User-Agent": "life-vault" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    for (const e of expandEvents(parseICS(await r.text()), from, to, { zone: TZ })) {
      // Private calendar markers never reach a brief — see PRIVATE_EVENT in
      // worker/vault.js and the ## Private rule in CLAUDE.md.
      if (/^that week$/i.test(e.title.trim())) continue;
      events.push({
        date: e.date,
        // Anchored on the real today, not on the window start — with --back
        // the first day of the window is a week ago, and labelling it "today"
        // would put last Sunday's events in a brief as if they were now.
        when: e.date === today ? "today" : e.date === tomorrow ? "tomorrow" : e.date,
        time: e.allDay ? "all-day" : e.time,
        title: e.title,
        location: e.location,
        minutes: e.minutes,
        calendar: feed.name,
      });
    }
    sources.push({ name: feed.name, ok: true });
  } catch (e) {
    // Never echo the URL: it is the credential.
    sources.push({ name: feed.name, ok: false, error: String((e && e.message) || e) });
  }
}));

events.sort((a, b) => a.date.localeCompare(b.date) || String(a.time).localeCompare(String(b.time)));
console.log(JSON.stringify({ count: events.length, from, to, sources, events }, null, 2));

// Loud failure: a calendar that silently stopped syncing looks like a free week.
if (sources.some((s) => !s.ok)) process.exit(2);
