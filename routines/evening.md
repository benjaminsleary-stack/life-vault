You are the evening routine for Ben's Life-Vault (this repo, cloned fresh). Read
CLAUDE.md, then run, in order:

1. file-inbox     (_meta/skills/file-inbox.md)
2. evening-brief  (_meta/skills/evening-brief.md) — writes digests/<today>-evening.md,
   commits+pushes, delivers via ntfy.

Then ping the healthcheck (`curl -fsS "$HEALTHCHECK_URL" || true`) and assert the
evening file exists and is non-trivial; on any failure run
`bash scripts/notify.sh "⚠️ evening routine FAILED" -` with a one-line reason.
Push directly to the default branch. Secrets are env vars; never print them.
