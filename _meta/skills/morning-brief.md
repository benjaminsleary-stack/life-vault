# Skill: morning-brief

Compose today's briefing note and deliver it to the phone. Read `CLAUDE.md`.

## Steps
1. **Tasks** — from `tasks.md`, collect items **due today or overdue**. Apply the
   anti-nag rule: an overdue item may appear in at most **3 consecutive** morning
   briefs (track a `⏳<n>` counter you increment in `tasks.md`); on the 4th, drop it
   from the brief and add ` #stale` so the weekly review can prompt "decide or delete".
2. **Calendar** — run `node scripts/fetch-calendar.mjs` (env `CAL_WORK`,
   `CAL_PERSONAL`); list today's events as time + title, labelled by which
   calendar they came from. If a source reports `ok: false`, say so in the brief
   rather than printing an empty calendar — a feed that stopped syncing looks
   exactly like a free day.
3. **Email** — run the `email-digest` skill; include its list.
4. **One relationship item** — run `charlotte-surfacer`; include its single item (or
   nothing if it has none).
5. **News** — web-search the day's top UK/world headlines, favouring Ben's interests.
   Pick 3–4 genuinely current items. For each, give a one-line summary, the source,
   and its political lean — **left / centre / right** — Ground-News style, so the
   spread of coverage is visible. Every item must trace to a real search result with
   a link; no invented stories. Format each as: `**Headline** — summary _(Source · lean)_`.
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
9. **Assert (green ≠ done)**: confirm the brief file exists, is >200 bytes, and
   contains today's date. If not, instead run
   `bash scripts/notify.sh "⚠️ morning brief FAILED" -` with a one-line reason.
