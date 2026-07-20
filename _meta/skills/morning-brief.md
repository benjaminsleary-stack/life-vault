# Skill: morning-brief

Compose today's briefing note and deliver it to the phone. Read `CLAUDE.md`.

## Steps
1. **Tasks** — from `tasks.md`, collect items **due today or overdue**. Apply the
   anti-nag rule: an overdue item may appear in at most **3 consecutive** morning
   briefs (track a `⏳<n>` counter you increment in `tasks.md`); on the 4th, drop it
   from the brief and add ` #stale` so the weekly review can prompt "decide or delete".
2. **Calendar** — run `node scripts/fetch-calendar.mjs` (env `CAL_WORK`,
   `CAL_PERSONAL`, `CAL_FAMILY`); list today's events as time + title, labelled by
   which calendar they came from. Every source reports `ok: true|false`, including
   ones whose secret is unset (`error: "CAL_WORK not set"`). Name any `ok: false`
   source and its error in the brief rather than printing an empty calendar — a
   feed that stopped syncing, or was never wired up, looks exactly like a free day.
   "Not connected" means a missing GitHub Actions secret: Actions secrets are
   separate from the Worker's, so the dashboard can show a calendar the brief can't.
3. **Email** — run the `email-digest` skill; include its list.
4. **One relationship item** — run `charlotte-surfacer`; include its single item (or
   nothing if it has none).
5. **News** — web-search the day's top UK/world headlines, favouring Ben's interests.
   Pick 3–4 genuinely current items. For each, give a one-line summary, the source,
   and its political lean — **left / centre / right** — Ground-News style, so the
   spread of coverage is visible. Format each as:
   `**[Headline](url)** — summary _(Source · lean)_`
   The headline links straight to the article, so the brief is readable on the phone
   (`notify.sh` sends `Markdown: yes`, so ntfy renders the link as a tap target).
   Link rules: the `url` must be the article URL as it appeared in the search result
   — copied, never reconstructed or guessed from the headline. No homepages, no
   search-result redirects, no AMP wrappers. If a result gives you no usable URL,
   drop the item and pick another; never invent a link or a story. This section is
   never omitted: if searching genuinely returns nothing, write "—" under `## News`.
6. Write `digests/<today>-morning.md`:
   ```
   # Morning — <today, e.g. Sat 12 Jul>
   ## Today’s calendar
   ## Due / overdue
   ## Inbox that needs you
   ## For Charlotte
   ## News
   ```
   Keep it scannable. If a section is empty, write "—".
7. Commit and push to the default branch (the routine wrapper does the git; if you
   have shell, `git add -A && git commit -m "morning brief <today>" && git push`).
8. **Deliver**: `bash scripts/notify.sh "Morning brief" digests/<today>-morning.md`
   (env `NTFY_TOPIC`) — the brief content goes in the ntfy body.
9. **Assert (green ≠ done)**: confirm the brief file exists, is >200 bytes, contains
   today's date, and carries all five `##` headings from step 6 — a section that
   silently went missing (News has done this) is indistinguishable from a quiet day.
   If any check fails, instead run
   `bash scripts/notify.sh "⚠️ morning brief FAILED" -` with a one-line reason.
