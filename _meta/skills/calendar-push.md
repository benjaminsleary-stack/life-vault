# Skill: calendar-push

Put the latest `family-events` shortlist into the Google Calendar, using the
**Google Calendar connector** of whatever Claude session you are in.

**Run this by hand, roughly monthly**, in a session that has the calendar
connector — the phone notification from `family-events` is the prompt. It takes
about a minute. Nothing else in the vault depends on it having been run.

## Why it is manual, and why that is fine

The original capture (2026-08-01) asked for events to be added "automatically",
and the honest position is that the automatic half already works: `family-events`
runs monthly in GitHub Actions, searches, filters, writes
`digests/<YYYY-MM>-family-events.md`, emits an `.ics`, and pushes it to the
phone. No laptop, no credentials. What could not be automated is the calendar
*write*:

- The scheduled runner is GitHub Actions, which authenticates with a Claude
  token and carries **no claude.ai connectors** — so a routine there cannot use
  one.
- A Claude Routine *can* hold connectors, but they cannot be attached through
  the API this account has (`connectors` is not available for the org, and a
  Routine created without them fires with no `mcp__*` tools at all — verified
  26 Aug 2026, including a live test firing).
- The remaining path is a Google Cloud OAuth client: a project, a consent
  screen, publishing to production or a token that dies every 7 days, and four
  more secrets — for one monthly write. That is `docs/google-calendar.md`, kept
  because it still works, and not the recommended route.

So: the finding, filtering and delivery are automatic; the last hop is one
sentence to Claude. That is a better trade than four credentials.

## Steps

1. Read the newest `digests/*-family-events.md`. Each item is a `##` heading of
   the form `## Sat 8 Aug — <title>` followed by a line with the provider, drive
   time, cost and a link.

2. **Check what is already there before writing anything.** List events on the
   Family calendar (`family09454908126888304951@group.calendar.google.com`)
   across the digest's date range. Skip any item where an existing event has the
   same date and a matching title, or carries the same `lifeVaultKey`.

   This is the whole safety property. The digest is regenerated monthly and
   search results repeat, so without the check "find family events every month"
   becomes "add August's events again, every month".

3. Create what is left, on the **Family** calendar — not `primary`:
   - **All day.** The connector's end date is **exclusive**: an all-day event on
     the 8th needs `startTime: 2026-09-08`, `endTime: 2026-09-09`. Passing the
     same date twice is rejected with "start_time must be smaller than end_time".
   - `summary` — the event title, without the date prefix.
   - `location` — the venue, so the calendar entry can be navigated to.
   - `description` — the drive time, the cost, the booking link, and then
     `lifeVaultKey: <slug-of-title>-<YYYY-MM-DD>` on its own final line.
   - `notificationLevel: NONE` — this is a shared calendar; nobody needs mail
     about it.

4. Report: created, skipped-as-already-present, and anything you could not place.
   If the digest says the month had nothing worth the trip, say so and stop.

## Rules

- **Only what the digest says.** Never invent an event, a date, a price or a
  link, and never search for more here — that is `family-events`' job, and it
  has already applied the drive-time and age filters.
- Never write to `tasks.md`. If Ben wants to go, the calendar entry is the
  action.
- An event already in the calendar is left exactly as it is. Do not update,
  re-title or "improve" it; he may have edited it deliberately.
