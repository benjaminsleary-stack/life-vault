#!/usr/bin/env bash
# Run one skill headless and record its status. The single source of truth used
# by BOTH the GitHub Actions workflows and the local desktop watcher.
#
#   Usage: bash scripts/run-skill.sh <skill-name>
#
# Requires: the Claude CLI and node on PATH (auth via CLAUDE_CODE_OAUTH_TOKEN,
# or a prior `claude` login on the desktop). No jq dependency.
# Writes: inbox/_runs/<skill>.status   → latest run: status, outputs, model, tokens
#         _meta/skill-usage.jsonl      → append-only one line per run, for cost
#                                        comparison over time
# Model:  chosen per skill (see the case below) — mechanical work on haiku,
#         synthesis on sonnet. SKILL_MODEL=... overrides.
# Exit:   0 if the skill succeeded, non-zero otherwise.
set -uo pipefail
skill="${1:?usage: run-skill.sh <skill-name> [input]}"
input="${2:-}"                                   # optional free text handed to the skill

# Paths that are the runner's own bookkeeping, or the raw material a skill
# consumed rather than produced. None of these is ever the thing you want to
# open from the dashboard, and listing them is what made the Routines card a
# wall of filenames: file-inbox's "outputs" were the hot-cache, the capture it
# filed, the archive copy of that capture, and tasks.md — four rows, nothing to
# read.
BOOKKEEPING_RE='^(_meta/(hot-cache|skill-usage|index)|inbox/(_runs|_archive)/|inbox/[0-9]|tasks\.md$|habits(-log)?\.md$)'

# The .md files currently changed/new in the working tree.
dirty_md() {
  git status --porcelain --untracked-files=all \
    | sed -E 's/^(.{3})//; s/^.* -> //' \
    | grep -E '\.md$' | sort -u
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

# Model per skill. The plan default is the most capable (and most expensive)
# model available, and most of this work does not need it: filing captures,
# weaving MOCs and refreshing summaries are structured transforms, where the
# briefs involve judgement, web synthesis and relationship advice. Picking per
# skill is the single biggest lever on weekly usage.
# Override for a one-off:  SKILL_MODEL=opus bash scripts/run-skill.sh <skill>
case "$skill" in
  file-inbox|weave|refresh-summaries) model="haiku" ;;
  morning-brief|evening-brief|interest-scout|ask) model="sonnet" ;;
  *) model="sonnet" ;;
esac
[ -n "${SKILL_MODEL:-}" ] && model="$SKILL_MODEL"

# Which skills are supposed to reach the phone. Anything here that finishes
# without a delivery receipt is recorded as undelivered, and health() turns that
# into a failed check — writing the brief is only half the job.
case "$skill" in
  morning-brief|evening-brief|interest-scout) expects_delivery=1 ;;
  *) expects_delivery=0 ;;
esac
receipt_file="$(mktemp 2>/dev/null || echo "/tmp/lv-delivery-$$")"
: > "$receipt_file"
export LV_DELIVERY_RECEIPT="$receipt_file"
trap 'rm -f "$receipt_file"' EXIT

# Outputs are measured from a commit boundary, not just the dirty tree. The
# briefs `git commit && git push` as one of their own steps, so by the time the
# runner looked, the tree was clean and every brief recorded "outputs": [] —
# which is why vault.js had to guess the file back out of digests/. Diffing
# against the SHA we started on catches work the skill committed itself, and
# unioning the dirty set catches work it left uncommitted.
start_sha="$(git rev-parse HEAD 2>/dev/null || true)"
before="$(dirty_md)"
# --output-format json so the run reports its own token usage (logged below).
# --dangerously-skip-permissions: unattended vault-maintenance run, no approver.
raw="$(claude -p "$prompt" --dangerously-skip-permissions --output-format json --model "$model" 2>&1)"; code=$?

# Unwrap the JSON envelope: the assistant text for logs/notifications, and the
# usage numbers for the cost log. If the CLI failed before emitting JSON (or
# node is unavailable), fall back to treating the whole output as the text.
out="$(printf '%s' "$raw" | node -e '
  let s=""; process.stdin.on("data",(d)=>s+=d).on("end",()=>{
    let j=null; try { j=JSON.parse(s); } catch {}
    process.stdout.write(j && j.result != null ? String(j.result) : s);
  });' 2>/dev/null)"
[ -z "$out" ] && out="$raw"
usage_tsv="$(printf '%s' "$raw" | node -e '
  let s=""; process.stdin.on("data",(d)=>s+=d).on("end",()=>{
    let j=null; try { j=JSON.parse(s); } catch {}
    const u=(j&&j.usage)||{}, n=(v)=>(v==null?"":v);
    process.stdout.write([
      u.input_tokens||0, u.output_tokens||0,
      (u.cache_read_input_tokens||0)+(u.cache_creation_input_tokens||0),
      n(j&&j.total_cost_usd), n(j&&j.num_turns), n(j&&j.duration_ms),
    ].join("\t"));
  });' 2>/dev/null)"
IFS=$'\t' read -r tok_in tok_out tok_cache cost turns ms <<< "$usage_tsv"
tok_in="${tok_in:-0}"; tok_out="${tok_out:-0}"; tok_cache="${tok_cache:-0}"
[ -z "${cost:-}" ]  && cost=null
[ -z "${turns:-}" ] && turns=null
[ -z "${ms:-}" ]    && ms=null

echo "$out" | tail -n 40
when="$(date -u +%FT%TZ)"
[ "$code" -eq 0 ] && ok=true || ok=false
echo "[usage] $skill model=$model in=$tok_in out=$tok_out cache=$tok_cache cost=$cost turns=$turns"

# Build a JSON array of the .md files this run PRODUCED (no jq): everything it
# committed since we started, plus anything newly dirty, minus bookkeeping.
# digests/ leads, so outputs[0] is the artefact worth opening — the dashboard
# hangs its "Open" button on exactly that.
{
  [ -n "$start_sha" ] && git diff --name-only "$start_sha" HEAD -- '*.md' 2>/dev/null
  comm -13 <(printf '%s\n' "$before") <(printf '%s\n' "$(dirty_md)")
} | sort -u | grep -E '\.md$' | grep -vE "$BOOKKEEPING_RE" > "$receipt_file.out" || true
outputs="$( { grep    '^digests/' "$receipt_file.out" || true; \
              grep -v '^digests/' "$receipt_file.out" || true; } )"
rm -f "$receipt_file.out"

arr="["; first=1
while IFS= read -r p; do
  [ -z "$p" ] && continue
  esc="${p//\\/\\\\}"; esc="${esc//\"/\\\"}"
  if [ $first -eq 1 ]; then first=0; else arr+=","; fi
  arr+="\"$esc\""
done <<< "$outputs"
arr+="]"

# Did it actually reach the phone? Absence of a receipt from a skill that is
# meant to deliver counts as a failure, not as "unknown" — notify.sh writes one
# on the way out of every path it has, including the ones that used to die
# silently.
delivered=null; delivery_err=""
if [ "$expects_delivery" -eq 1 ]; then
  delivered=false
  if [ -s "$receipt_file" ]; then
    IFS=$'\t' read -r d_ok d_why < "$receipt_file"
    if [ "${d_ok:-}" = "true" ]; then delivered=true; else delivery_err="${d_why:-}"; fi
  else
    delivery_err="the skill never called notify.sh"
  fi
  # Same sanitise-don't-escape rule as `err` below: a status file that is
  # invalid JSON is silently skipped by the dashboard, which is worse than terse.
  delivery_err="$(printf '%s' "$delivery_err" | tr -d '\\"' | tr '\t\r\n' '   ')"
  delivery_err="${delivery_err:0:200}"
fi

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
printf '{"skill":"%s","ok":%s,"when":"%s","outputs":%s,"error":"%s","delivered":%s,"deliveryError":"%s","model":"%s","tokens":{"in":%s,"out":%s,"cache":%s},"cost_usd":%s}\n' \
  "$skill" "$ok" "$when" "$arr" "$err" "$delivered" "$delivery_err" \
  "$model" "$tok_in" "$tok_out" "$tok_cache" "$cost" \
  > "inbox/_runs/$skill.status"

# Append-only usage log — one line per run, so cost per skill can be compared
# over time and the expensive ones tuned. Never rewritten (golden rule 1); the
# .status file only ever holds the LATEST run, which is no use for spotting a
# trend or a skill that has quietly got more expensive.
mkdir -p _meta
printf '{"when":"%s","skill":"%s","model":"%s","ok":%s,"in":%s,"out":%s,"cache":%s,"cost_usd":%s,"turns":%s,"ms":%s}\n' \
  "$when" "$skill" "$model" "$ok" "$tok_in" "$tok_out" "$tok_cache" "$cost" "$turns" "$ms" \
  >> _meta/skill-usage.jsonl

# Shout on failure (spec §5: silence must be loud), best-effort.
if [ "$ok" = false ] && [ -n "${NTFY_TOPIC:-}" ]; then
  curl -s -H "Title: skill $skill failed" -d "$(echo "$out" | tail -n 5)" \
    "https://ntfy.sh/$NTFY_TOPIC" >/dev/null 2>&1 || true
fi


[ "$ok" = true ]
