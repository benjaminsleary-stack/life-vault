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

# On failure, keep the last few lines of output IN the status file. Without
# this a failed run records only that it failed, and the reason lives solely in
# a GitHub Actions log you have to go and find — so the dashboard could say
# "interest-scout failed" and nothing more. Silence must be loud (spec §5), and
# a failure with no cause is most of the way back to silence.
# Sanitise rather than escape. Getting backslashes and quotes safely through
# sed/awk into a JSON string is fragile across platforms (GNU sed and the msys
# sed disagree, and the escaping expression fails outright on Git Bash), and a
# status file that is invalid JSON is worse than a terse one — the dashboard
# silently skips any status it cannot parse. Strip the two characters that can
# break the string; the message stays readable.
err=""
if [ "$ok" = false ]; then
  err="$(printf '%s\n' "$out" | grep -vE '^[[:space:]]*$' | tail -n 3 \
    | tr -d '\\"' | tr '\t\r' '  ' \
    | awk '{printf "%s%s", sep, $0; sep=" | "}')"
  err="${err:0:500}"
fi

mkdir -p inbox/_runs
printf '{"skill":"%s","ok":%s,"when":"%s","outputs":%s,"error":"%s"}\n' \
  "$skill" "$ok" "$when" "$arr" "$err" \
  > "inbox/_runs/$skill.status"

# Shout on failure (spec §5: silence must be loud), best-effort.
if [ "$ok" = false ] && [ -n "${NTFY_TOPIC:-}" ]; then
  curl -s -H "Title: skill $skill failed" -d "$(echo "$out" | tail -n 5)" \
    "https://ntfy.sh/$NTFY_TOPIC" >/dev/null 2>&1 || true
fi


[ "$ok" = true ]
