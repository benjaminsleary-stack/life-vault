# Skill: family-events

A monthly shortlist of family-friendly things to do within an hour's drive of
Cambridge. Read `CLAUDE.md`. Needs web access.

**Origin:** captured 2026-08-01 — *"Add a check, probably monthly to find and add
events in and near Cambridge that are family friendly. National trust ones are
good. No more than a 1hr drive. Add these to my Google calendar automatically."*

That capture was first mis-filed as a task in `tasks.md`, which is exactly the
failure the "Standing instructions are routines" rule in `CLAUDE.md` now exists
to prevent. It is a routine. This is it.

## What it can and cannot do

**Read the limitation before writing the digest, and be honest about it in the
output.** Every calendar integration in this vault is a read-only `.ics`
subscription — `CAL_WORK`, `CAL_PERSONAL`, `CAL_FAMILY`. There is no credential
anywhere that can write to Google Calendar, so the "automatically" half of the
capture is **not** currently possible.

What this skill does instead: produce a short, dated, linked shortlist and push
it to the phone, plus an `.ics` file that adds the chosen events in one action.
Adding to the calendar stays a deliberate tap. Do not pretend otherwise in the
digest, and do not create a task asking Ben to do it by hand.

## Steps

1. **Know what's already on.** `node scripts/fetch-calendar.mjs 45` — the next
   six weeks across all three feeds. A day that already has a commitment on it
   is not a free day; weekends that are already full are worth nothing.

2. **Search.** Family-friendly events and days out within roughly an hour's
   drive of Cambridge (CB postcodes as the centre), happening in the **next 4–6
   weeks**. Weight towards:
   - **National Trust** properties and their events — named as a favourite.
   - English Heritage, Wildlife Trusts, RSPB reserves, country parks.
   - Museums and science/discovery centres (Cambridge itself, Duxford, Ely,
     Bury St Edmunds, Peterborough).
   - Seasonal one-offs: fairs, light trails, open days, steam galas.

   Suitable for a **5-year-old and a 2-year-old** — [[Jasper]] and [[Milo]].
   That is the binding filter. A 12+ event is not a family event here, and
   anything requiring a full day of queueing with a toddler is not either.

3. **Filter hard.** 4–6 items maximum. Drop anything that:
   - clashes with something already on the calendar,
   - is more than about an hour's drive (say the drive time for each; if you
     can't establish it, drop the item rather than guess),
   - appeared in the last two monthly digests and wasn't acted on,
   - has no date, or no bookable/checkable link.

   A short list gets read. Twelve options get scrolled past, and then none of it
   happens — which is the whole point of the routine.

4. **Write `digests/<YYYY-MM>-family-events.md`.** One block per item:

   ```
   ## Sat 16 Aug — Wimpole Estate: Farm Festival
   National Trust · ~25 min drive · from £8, free for members · [book](url)
   Working farm with shire horses; toddler-friendly, buggy-accessible.
   ```

   State the date, place, drive time, cost, and a real link. Every fact must
   trace to a real search result — no invented dates, prices or events. If a
   detail can't be established, leave it out rather than guess. If the month
   genuinely has nothing worth the drive, write "nothing worth the trip this
   month" and stop; padding it is worse than an empty month.

5. **Write the calendar file.** Emit `attachments/family-events-<YYYY-MM>.ics`
   containing one `VEVENT` per shortlisted item — all-day events, `SUMMARY` as
   the title, `LOCATION` as the venue, `DESCRIPTION` carrying the link and the
   cost. Opening that file on a phone offers to add the events in one action,
   which is as close to "automatically" as the current setup reaches.

6. **Deliver.** `bash scripts/notify.sh "Family days out — <Month>" digests/<file>`.

7. **Assert (green ≠ done).** Confirm the digest exists, is over 200 bytes, and
   carries at least one dated item with a link — or, if the month was genuinely
   empty, that it says so. If the calendar fetch reported any source as
   `ok: false`, name the source in the digest: a clash check run against a feed
   that wasn't loaded is not a clash check.

## Rules

- Never write to `tasks.md`. If Ben wants to go to one of these, he taps it into
  the calendar; the routine's job is to find them, not to give him homework.
- Never create people or project notes from an event.
- Cadence is monthly — see `[triggers]` in `worker/wrangler.toml` and
  `CRON_SKILL` in `worker/worker.js`. It is not a task and must never become one.
