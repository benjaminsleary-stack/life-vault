# Skill: morning-brief

Compose today's briefing note and deliver it to the phone. Read `CLAUDE.md`.

## Steps
1. **Tasks** — from `tasks.md`, collect items **due today or overdue**. Apply the
   anti-nag rule: an overdue item may appear in at most **3 consecutive** morning
   briefs (track a `⏳<n>` counter you increment in `tasks.md`); on the 4th, drop it
   from the brief and add ` #stale` so the weekly review can prompt "decide or delete".
2. **Calendar** — run `python scripts/fetch-ics.py` (env `ICS_URL`); list today's
   events (time + title).
3. **Email** — run the `email-digest` skill; include its list.
4. **One relationship item** — run `charlotte-surfacer`; include its single item (or
   nothing if it has none).
5. Write `digests/<today>-morning.md`:
   ```
   # Morning — <today, e.g. Sat 12 Jul>
   ## Today’s calendar
   ## Due / overdue
   ## Inbox that needs you
   ## For Charlotte
   ```
   Keep it scannable. If a section is empty, write "—".
6. Commit and push to the default branch (the routine wrapper does the git; if you
   have shell, `git add -A && git commit -m "morning brief <today>" && git push`).
7. **Deliver**: `bash scripts/notify.sh "Morning brief" digests/<today>-morning.md`
   (env `NTFY_TOPIC`) — the brief content goes in the ntfy body.
8. **Assert (green ≠ done)**: confirm the brief file exists, is >200 bytes, and
   contains today's date. If not, instead run
   `bash scripts/notify.sh "⚠️ morning brief FAILED" -` with a one-line reason.
