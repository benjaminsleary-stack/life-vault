# Cloud environment for the Routines (spec §6)

Create a **Custom** environment (NOT Default — Default blocks ntfy/Google and the
run goes green having done nothing). Attach it to each routine.

## Network access: Custom — allowlist these hosts
- `ntfy.sh`               — briefing delivery (or your NTFY_SERVER host)
- `imap.gmail.com`        — mail fetch
- `calendar.google.com`   — .ics fetch
- `hc-ping.com`           — healthchecks.io ping
- `api.github.com` + `github.com` — clone/push the vault
- (keep the default package registries so setup.sh can pip-install)
- web-search egress for `interest-scout` (confirm the exact hosts your search tool uses)

> Anything not listed returns `403 host_not_allowed`, invisibly to the run status.
> Phase 4 exists solely to prove this allowlist with a one-off "Run now".

## Environment variables (secrets live here, never in prompts)
`GMAIL_ADDRESS`, `GMAIL_APP_PASSWORD`, `ICS_URL`, `NTFY_TOPIC`, `HEALTHCHECK_URL`
(+ `NTFY_TOKEN` if the topic is protected). See `.env.example`.

## Setup script
`bash scripts/setup.sh` (installs imap-tools, icalendar, requests; cached between runs).

## Repo permissions
Enable **Allow unrestricted branch pushes** on `life-vault` so routines update
`main` in place (otherwise they can only push `claude/*`).

## Routines (2 daily + 2 weekly — inside the Pro 5/day cap)
| Routine | Prompt file | Schedule (local) |
|---|---|---|
| morning | `routines/morning.md` | daily ~06:45 |
| evening | `routines/evening.md` | daily ~20:45 |
| interest-scout | `routines/interest-scout.md` | weekly (e.g. Sat 09:00) |
| refresh-summaries | `routines/refresh-summaries.md` | weekly Sun 03:00 |

Create them at claude.ai/code/routines (or `/schedule` in the CLI — but that's
hidden if `ANTHROPIC_API_KEY` is set in your shell; unset it or use the web).
Point each at the `life-vault` repo + this environment.

## Prove it before trusting it (Phase 4)
Run a one-off routine that does exactly: POST a test line to ntfy AND run
`python scripts/fetch-mail.py`. Both must succeed. Only then schedule `morning`.
