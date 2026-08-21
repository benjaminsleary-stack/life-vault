# Skill: morning-brief

Compose today's briefing note and deliver it to the phone.

`CLAUDE.md` is already loaded as project instructions — don't open it. (It used
to say "Read `CLAUDE.md`" here, which bought a second 11KB copy of a file that
was in the prompt before the run started, and then paid to re-send it on every
turn after that.)

## Step 1 — preflight, one command

```
node scripts/brief-context.mjs morning
```

That JSON is the whole mechanical half of the brief: today's date and heading,
every calendar source with its health, today's events, tasks due and overdue
with the anti-nag arithmetic already done, the inbox count, and the shortlist of
Charlotte fragments that are eligible to surface.

**Do not re-read what it gives you.** No opening `tasks.md`, `people/charlotte.md`,
`_meta/hot-cache.md`, `_meta/index.md` or the calendar to check — it is all in the
bundle, and the bundle is authoritative. Read a file only if the bundle names
something missing that you need.

This matters more than it looks. Between 20 July and 5 August this skill ran at
24–59 turns and up to $2.16 a morning, because it rediscovered the same five
files one tool call at a time and then re-sent them as cached context on every
following turn. The bundle is 1.8KB against 26KB of raw files, in one call
instead of twelve. **Budget: 10 turns.** If you are past 15, you are exploring
something the preflight already answered.

## Step 2 — news

Web-search the day's top UK/world headlines, favouring Ben's interests. Pick 3–4
genuinely current items. Format each as:

`**[Headline](url)** — one-line summary _(Source · lean)_`

with the lean marked **left / centre / right**, Ground-News style, so the spread
of coverage is visible.

- **Budget: up to 6 searches, and no fetching of full articles.** Snippets carry
  the headline, the gist and the URL, which is everything this section needs;
  pulling whole pages into a context that is re-sent every turn is the single
  most expensive thing this skill can do. Six is what `interest-scout` gets, and
  `interest-scout` comes back with real linked results every week — so six is
  demonstrably enough to find things. Three was not.
- **An empty News section is a bug, not a quiet day.** There is always news. If
  your first query returns nothing usable, the query was wrong — change its
  shape and search again (a different phrasing, a different outlet, "UK news
  today", a topic Ben follows) until the budget is spent. Do not stop at the
  first empty result, and do not treat "no sources found" as an answer you are
  allowed to give while you still have searches left.
- The lean label is **best effort**. Mark it `left / centre / right` where you
  can tell, Ground-News style, so the spread is visible — but a headline you
  cannot confidently place keeps its source and drops the label. **Never drop a
  real story for want of a lean.** That rule was costing items, not adding
  balance.
- The `url` must be the article URL as it appeared in the search result —
  copied, never reconstructed. No homepages, no redirects, no AMP wrappers. If a
  result gives no usable URL, drop it and pick another. Never invent a link or a
  story.
- A thin spread is worth a `⚠ news: one source only` at the foot — a plain fact,
  not a paragraph under the headlines, and never a narrow spread presented as a
  balanced one.

**Why this is spelled out.** Between 16 and 21 August the News section came back
empty six mornings running, on a three-search budget, while `interest-scout`
searched successfully the whole time. The prompt had made giving up tidy: a
one-line `⚠ news: no sources found` was clean, sanctioned output, so the cheapest
path was to take it. The wording drifted run to run — "one source only", "no
usable sources found", "search unreachable" — which is what improvising an excuse
looks like. Reporting no news is only honest after the budget is spent.

## Step 3 — the Charlotte line

The bundle's `charlotte` block has already applied the rules: nothing private,
nothing surfaced in the last 14 days. What is left is a shortlist to **choose
from**, and choosing is the judgement — read `_meta/skills/charlotte-surfacer.md`
for what makes a good choice, in priority order (an open loop with a near date
beats everything; commentary and generic advice are worse than silence).

- `loops` first, then `occasions` inside 7–21 days, then `candidates`.
- One item, or none. **None is a valid and frequent answer.**
- If you use one, stamp that fragment `_(surfaced: <today>)_` in
  `people/charlotte.md` — one exact-match edit, no rewrite of the file.
- If `captureStalled` is true, say so in the brief. A fortnight with no new
  fragment means the capture half has stopped, and that must not fail silently.

## Step 4 — write it

`digests/<today>-morning.md`, using `heading` from the bundle:

```
# Morning — <heading>
## Today's calendar
## Due / overdue
## Inbox that needs you
## For Charlotte
## News
```

Keep it scannable; "—" for an empty section, and nothing else.

**Never narrate a search that found nothing.** Ben, 7 August 2026: *"The digests
have too much text, lots of 'I looked for this and that and found nothing'. Say
nothing instead."* No "I checked X and…", no explaining why a section is thin, no
apologising for it. An empty section is one character long.

That still leaves a real obligation — a feed that stopped syncing looks exactly
like a free day, and mail that wasn't checked is not mail that was clear. So
anything unhealthy goes in **one terse line at the foot of the brief**, never as
prose inside a section:

```
⚠ mail not connected · work calendar failing
```

Facts separated by ` · `, no sentences, no causes, no remedies. That line is the
whole of what golden rule 5 requires here: visible, not explained. If everything
is healthy, there is no line at all.

## Step 5 — the nag counters

For each task in `tasks.overdue`, do exactly what its `action` says, using the
`raw` line as the exact-match target. That is one edit per task, no reading
first. Tasks in `dueToday` get no counter.

## Step 6 — ship

1. `git add -A && git commit -m "morning brief <today>" && git push`
2. `bash scripts/notify.sh "Morning brief" digests/<today>-morning.md`
3. **Assert (green ≠ done):** the file exists, is >200 bytes, contains today's
   date, and carries all five `##` headings. A section that silently went
   missing (News has done this) is indistinguishable from a quiet day. If any
   check fails, run `bash scripts/notify.sh "⚠️ morning brief FAILED" -` with a
   one-line reason instead.

Delivery is verified for you — `notify.sh` writes a receipt and the runner
records it — so never report the brief as delivered on the strength of having
called the script.
