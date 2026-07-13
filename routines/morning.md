You are the morning routine for Ben's Life-Vault (this repo, cloned fresh). Work
only within the repo. Read CLAUDE.md first, then run these skills IN ORDER, each per
its file in _meta/skills/:

1. file-inbox     (_meta/skills/file-inbox.md) — file everything in inbox/, archive raws
2. email-digest   (_meta/skills/email-digest.md)
3. morning-brief  (_meta/skills/morning-brief.md) — this also runs charlotte-surfacer,
   writes digests/<today>-morning.md, commits+pushes, and delivers via ntfy

Then:
- Ping the healthcheck: `curl -fsS "$HEALTHCHECK_URL" || true`.
- FINAL ASSERTION (green ≠ done): confirm digests/<today>-morning.md exists, is
  >200 bytes, and contains today's date. If ANY step failed or the assertion fails,
  run `bash scripts/notify.sh "⚠️ morning routine FAILED" -` with a one-line reason,
  and say clearly what broke.

Do not open PRs — push directly to the default branch. Secrets are environment
variables; never print them.
