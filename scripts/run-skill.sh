#!/usr/bin/env bash
# Run one skill headless and record its status. The single source of truth used
# by BOTH the GitHub Actions workflows and the local desktop watcher.
#
#   Usage: bash scripts/run-skill.sh <skill-name>
#
# Requires: the Claude CLI on PATH (auth via CLAUDE_CODE_OAUTH_TOKEN, or a prior
# `claude` login on the desktop). No jq dependency.
# Writes: inbox/_runs/<skill>.status  → {skill, ok, when, outputs:[changed .md]}
# Exit:   0 if the skill succeeded, non-zero otherwise.
set -uo pipefail
skill="${1:?usage: run-skill.sh <skill-name> [input]}"
input="${2:-}"                                   # optional free text handed to the skill

# The .md files that are currently changed/new, excluding runner bookkeeping.
dirty_md() {
  git status --porcelain --untracked-files=all \
    | sed -E 's/^.{3}//' \
    | grep -E '\.md$' | grep -v -E '^inbox/_runs/' | sort -u
}

# Map the skill to its saved prompt: the skill file, then a routine, else /slash.
prompt_file=""
if [ -f "_meta/skills/$skill.md" ]; then prompt_file="_meta/skills/$skill.md"
elif [ -f "routines/$skill.md" ]; then prompt_file="routines/$skill.md"; fi
if [ -n "$prompt_file" ]; then prompt="$(cat "$prompt_file")"; else prompt="/$skill"; fi
if [ -n "$input" ]; then
  prompt="$prompt

## Input from the dashboard
$input"
fi

before="$(dirty_md)"
# --dangerously-skip-permissions: unattended vault-maintenance run, no approver.
out="$(claude -p "$prompt" --dangerously-skip-permissions 2>&1)"; code=$?
echo "$out" | tail -n 40
when="$(date -u +%FT%TZ)"
[ "$code" -eq 0 ] && ok=true || ok=false

# Build a JSON array of .md files that became dirty during the run (no jq).
outputs="$(comm -13 <(printf '%s\n' "$before") <(printf '%s\n' "$(dirty_md)"))"
arr="["; first=1
while IFS= read -r p; do
  [ -z "$p" ] && continue
  esc="${p//\\/\\\\}"; esc="${esc//\"/\\\"}"
  if [ $first -eq 1 ]; then first=0; else arr+=","; fi
  arr+="\"$esc\""
done <<< "$outputs"
arr+="]"

mkdir -p inbox/_runs
printf '{"skill":"%s","ok":%s,"when":"%s","outputs":%s}\n' "$skill" "$ok" "$when" "$arr" \
  > "inbox/_runs/$skill.status"

# Shout on failure (spec §5: silence must be loud), best-effort.
if [ "$ok" = false ] && [ -n "${NTFY_TOPIC:-}" ]; then
  curl -s -H "Title: skill $skill failed" -d "$(echo "$out" | tail -n 5)" \
    "https://ntfy.sh/$NTFY_TOPIC" >/dev/null 2>&1 || true
fi


[ "$ok" = true ]
