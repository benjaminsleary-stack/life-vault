/**
 * Calendar reads — the ONE place "what are the events, by source?" is answered.
 *
 * Both the dashboard (worker/vault.js `readCalendar`, with its ~1MB cache) and
 * the brief CLI (scripts/fetch-calendar.mjs) used to answer this independently,
 * each carrying its own copy of the feed list and the private-marker wall. That
 * is exactly the drift worker/vault.js was built to kill for task rules — and it
 * had already started: the family feed reached the app but not the brief, and
 * `/^that week$/` was written in two files. This module makes the feed identity
 * and the private wall exist ONCE. Callers inject their own fetch (a caching one
 * in the Worker, a plain one in the CLI, a fake in a test) and map the canonical
 * events to whatever shape they render.
 *
 * Caching is deliberately NOT here: it is host policy. The Worker caches the
 * parse and memoises the per-window expansion because a Worker's CPU budget is
 * measured in milliseconds; the CLI runs once and exits. So the two share the
 * rules and keep their own performance strategy.
 */

import { parseICS, expandEvents } from "./ical.js";

// Calendar titles that are private markers, not appointments — the user's own
// shorthand ("That week" tracks Charlotte's cycle). They stay on the calendar
// but must never reach the agenda or a brief, exactly like a ## Private note
// (CLAUDE.md's private wall). This is the single definition of that rule; it
// used to live in both worker/vault.js and scripts/fetch-calendar.mjs.
export const PRIVATE_EVENT = /^that week$/i;
export const isPrivateEvent = (title) => PRIVATE_EVENT.test(String(title || "").trim());

/**
 * The feeds the whole system subscribes to, read from host env / secrets.
 *
 * One definition, so a feed added here reaches the Worker, the dev server and
 * the brief CLI at once — never again in one but not the others. Each entry
 * carries its env-var name so an unset feed can name itself. `url` may be
 * undefined; callers decide whether to include unset feeds (the dashboard hides
 * them, the brief reports them as not-connected). ICS_URL is the legacy name
 * for the personal feed, still honoured.
 */
export function selectFeeds(env = {}) {
  return [
    { name: "work", url: env.CAL_WORK, key: "CAL_WORK" },
    { name: "personal", url: env.CAL_PERSONAL || env.ICS_URL, key: "CAL_PERSONAL" },
    { name: "family", url: env.CAL_FAMILY, key: "CAL_FAMILY" },
  ];
}

// Expand one feed's already-parsed events into [fromDay, toDay], drop private
// markers, and tag each occurrence with its source name. Kept separate from
// fetching and parsing so the Worker can cache those and only re-expand when the
// window changes. `opts` is passed straight to expandEvents (e.g. { zone }).
export function expandForWindow(events, fromDay, toDay, sourceName, opts = {}) {
  return expandEvents(events, fromDay, toDay, opts)
    .filter((o) => !isPrivateEvent(o.title))
    .map((o) => ({ ...o, source: sourceName }));
}

// Canonical event order: by day, all-day first within a day, then by time.
export function sortEvents(events) {
  return events.sort((a, b) =>
    a.date.localeCompare(b.date) ||
    (a.allDay === b.allDay ? String(a.time).localeCompare(String(b.time)) : (a.allDay ? -1 : 1))
  );
}

/**
 * Read events across feeds into a window. Host-agnostic: `fetchText(feed)`
 * returns the feed's raw .ics text — the Worker would inject a caching fetch,
 * the CLI a plain one, a test a fake that returns a fixture. Returns
 * { events, sources }; each source is { name, ok, error? }.
 *
 * A feed with no url reports ok:false naming its env var, so "never wired up"
 * and "free day" are never the same empty list (golden rule 5 — silence must be
 * loud). One broken feed reports itself and never sinks the rest.
 */
export async function readCalendarEvents(feeds, fromDay, toDay, fetchText, opts = {}) {
  const events = [];
  const sources = [];
  await Promise.all(feeds.map(async (feed) => {
    if (!feed.url) {
      sources.push({ name: feed.name, ok: false, error: `${feed.key || feed.name} not set` });
      return;
    }
    try {
      const text = await fetchText(feed);
      for (const occ of expandForWindow(parseICS(text), fromDay, toDay, feed.name, opts)) {
        events.push(occ);
      }
      sources.push({ name: feed.name, ok: true });
    } catch (e) {
      // Never echo the URL: it is the credential.
      sources.push({ name: feed.name, ok: false, error: String((e && e.message) || e) });
    }
  }));
  sortEvents(events);
  return { events, sources };
}
