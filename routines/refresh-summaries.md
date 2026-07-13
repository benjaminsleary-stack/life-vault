You are the weekly refresh-summaries routine for Ben's Life-Vault (this repo, cloned
fresh), scheduled Sun 03:00 local (a quiet slot — this is the only routine that
rewrites existing prose). Read CLAUDE.md, then run refresh-summaries
(_meta/skills/refresh-summaries.md): rebuild the "What to know" summary atop each
people/*.md and projects/*.md FROM ITS LOG (fragments win over the old summary).
Then run weave (_meta/skills/weave.md): link unlinked real mentions, refresh
maps/*.md and _meta/index.md, report orphans — obey its anti-tenuous-link rules.
Commit+push once at the end, ntfy a one-line count, ping the healthcheck. Assert you
edited >=1 file; notify failure otherwise. Do not touch any ## Log. Push directly to
the default branch.
