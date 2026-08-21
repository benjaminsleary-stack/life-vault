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
  # harvest is judgement about what's worth writing down, not a transform —
  # the whole skill is "discard the noise", and haiku writes the noise down.
  morning-brief|evening-brief|interest-scout|ask|harvest|family-events) model="sonnet" ;;
  *) model="sonnet" ;;
esac
[ -n "${SKILL_MODEL:-}" ] && model="$SKILL_MODEL"

# Which skills are supposed to reach the phone. Anything here that finishes
# without a delivery receipt is recorded as undelivered, and health() turns that
# into a failed check — writing the brief is only half the job.
case "$skill" in
  morning-brief|evening-brief|interest-scout|family-events) expects_delivery=1 ;;
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
# DON'T PAY TWICE FOR THE SAME BRIEF.
#
# On 4 Aug 2026 morning-brief was dispatched seven times while delivery was being
# debugged. Four of those runs regenerated a brief that already existed and was
# already correct: $2.16, $0.97, $0.58 and $0.84 — $4.55 for one morning, on a
# day that needed one brief. The runner already knows which artefact each brief
# skill produces (the delivery fallback below finds it), so it can check first.
#
# Only when LV_SKIP_IF_FRESH=1, which the scheduled workflow sets. A run started
# by hand from the dashboard is a deliberate "do it again" and is never skipped.
skip_model=0
if [ "${LV_SKIP_IF_FRESH:-0}" = "1" ]; then
  _day="$(TZ=Europe/London date +%F)"
  case "$skill" in
    morning-brief) _fresh="digests/${_day}-morning.md" ;;
    evening-brief) _fresh="digests/${_day}-evening.md" ;;
    *)             _fresh="" ;;
  esac
  if [ -n "$_fresh" ] && [ -f "$_fresh" ] && [ "$(wc -c < "$_fresh" 2>/dev/null || echo 0)" -gt 200 ]; then
    # Already written AND already on his phone: nothing left to do at any price.
    if [ -f "inbox/_runs/$skill.status" ] \
       && grep -q '"delivered":true' "inbox/_runs/$skill.status" \
       && grep -q "\"when\":\"$(date -u +%F)" "inbox/_runs/$skill.status"; then
      echo "[skip] $_fresh is already written and already delivered today — nothing to do"
      exit 0
    fi
    # Written but not delivered: deliver it, don't rewrite it. Falls through to
    # the delivery block below, which finds today's digest on its own.
    echo "[skip] $_fresh already written today — delivering it rather than regenerating"
    skip_model=1
  fi
fi

start_sha="$(git rev-parse HEAD 2>/dev/null || true)"
before="$(dirty_md)"
# --output-format json so the run reports its own token usage (logged below).
# --dangerously-skip-permissions: unattended vault-maintenance run, no approver.
if [ "$skip_model" -eq 1 ]; then
  raw=""; code=0
else
  raw="$(claude -p "$prompt" --dangerously-skip-permissions --output-format json --model "$model" 2>&1)"; code=$?
fi

# Unwrap the JSON envelope: the assistant text for logs/notifications, and the
# usage numbers for the cost log. If the CLI failed before emitting JSON (or
# node is unavailable), fall back to treating the whole output as the text.
out="$(printf '%s' "$raw" | node -e '
  let s=""; process.stdin.on("data",(d)=>s+=d).on("end",()=>{
    let j=null; try { j=JSON.parse(s); } catch {}
    process.stdout.write(j && j.result != null ? String(j.result) : s);
  });' 2>/dev/null)"
[ -z "$out" ] && out="$raw"
[ "$skip_model" -eq 1 ] && out="[skipped] today's $skill was already written; delivering the existing file instead of regenerating it"
# Cache reads and cache WRITES are reported separately, not as one number. They
# are priced an order of magnitude apart (a write costs more than fresh input, a
# read a tenth of it), so a single summed field can't tell an expensive run from
# a long one — and the summed field was hiding that roughly half of a brief's
# spend was cache creation, not cache reuse. `cache` stays as the total so the
# existing log stays comparable.
usage_tsv="$(printf '%s' "$raw" | node -e '
  let s=""; process.stdin.on("data",(d)=>s+=d).on("end",()=>{
    let j=null; try { j=JSON.parse(s); } catch {}
    const u=(j&&j.usage)||{}, n=(v)=>(v==null?"":v);
    const rd=u.cache_read_input_tokens||0, wr=u.cache_creation_input_tokens||0;
    process.stdout.write([
      u.input_tokens||0, u.output_tokens||0, rd+wr, rd, wr,
      n(j&&j.total_cost_usd), n(j&&j.num_turns), n(j&&j.duration_ms),
    ].join("\t"));
  });' 2>/dev/null)"
IFS=$'\t' read -r tok_in tok_out tok_cache tok_cache_r tok_cache_w cost turns ms <<< "$usage_tsv"
tok_in="${tok_in:-0}"; tok_out="${tok_out:-0}"; tok_cache="${tok_cache:-0}"
tok_cache_r="${tok_cache_r:-0}"; tok_cache_w="${tok_cache_w:-0}"
[ -z "${cost:-}" ]  && cost=null
[ -z "${turns:-}" ] && turns=null
[ -z "${ms:-}" ]    && ms=null

echo "$out" | tail -n 40
when="$(date -u +%FT%TZ)"
[ "$code" -eq 0 ] && ok=true || ok=false
echo "[usage] $skill model=$model in=$tok_in out=$tok_out cache=$tok_cache (read=$tok_cache_r write=$tok_cache_w) cost=$cost turns=$turns"

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

# IS IT ACTUALLY A BRIEF? Both brief prompts end with "assert your own output",
# and on 21 Aug 2026 the morning brief came out at 164 bytes with every section
# empty and recorded ok:true — the sixth consecutive morning with no News and
# nothing said so. Asking the failing component to grade itself does not work,
# for the same reason delivery could not be left to the prompt. So the runner
# grades it. This never flips `ok` (a thin brief is still worth delivering) —
# it records a verdict health() can turn red, exactly like `delivered`.
assert_ok=null; assert_why=""
case "$skill" in
  morning-brief|evening-brief)
    if [ "$ok" = true ]; then
      assert_out="$(node scripts/assert-brief.mjs "$skill" 2>&1)"
      if [ $? -eq 0 ]; then assert_ok=true; else
        assert_ok=false
        assert_why="$(printf '%s' "$assert_out" | tr -d '\\"' | tr '\t\r\n' '   ')"
        assert_why="${assert_why:0:300}"
        echo "[assert] FAILED — $assert_why"
      fi
    fi
    ;;
esac

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

  # DELIVER IT OURSELVES if the skill didn't.
  #
  # Every briefing skill has a "run notify.sh" step in its prompt, and on
  # 4 Aug 2026 morning-brief simply didn't do it — wrote the brief, committed,
  # pushed, and stopped. The status read "written, but never reached your
  # phone", which is honest but is not the same as Ben getting his brief.
  #
  # Delivery is too important to depend on a model remembering the last step of
  # a prompt. The runner already knows which skills must deliver and which file
  # is the artefact (outputs is digests-first), so it can just do it. The
  # skill's own call stays — it delivers sooner and with a better title — and
  # this is the backstop for when it doesn't happen.
  if [ "$delivered" = false ] && [ "$ok" = true ]; then
    primary="$(printf '%s\n' "$outputs" | grep '^digests/' | head -n1)"

    # Nothing in outputs does NOT mean nothing to deliver. A re-run that finds
    # today's brief already written changes no files, so `outputs` is empty —
    # which is exactly what happened at 19:10 on 4 Aug, leaving a brief that had
    # existed since 15:01 still undelivered. Fall back to the artefact this
    # skill is KNOWN to produce, the same way vault.js backfills the Open button.
    if [ -z "$primary" ]; then
      day="$(TZ=Europe/London date +%F)"
      case "$skill" in
        morning-brief)  cand="digests/${day}-morning.md" ;;
        evening-brief)  cand="digests/${day}-evening.md" ;;
        interest-scout) cand="$(ls -1 digests/*-interests.md 2>/dev/null | tail -n1)" ;;
        family-events)  cand="$(ls -1 digests/*-family-events.md 2>/dev/null | tail -n1)" ;;
        *)              cand="" ;;
      esac
      if [ -n "${cand:-}" ] && [ -f "$cand" ]; then
        primary="$cand"
        echo "[delivery] the run produced no new file; falling back to $primary"
      fi
    fi

    if [ -n "$primary" ] && [ -f "$primary" ]; then
      case "$skill" in
        morning-brief)   title="Morning brief" ;;
        evening-brief)   title="Evening" ;;
        interest-scout)  title="Weekly interests" ;;
        family-events)   title="Family days out" ;;
        *)               title="$skill" ;;
      esac
      echo "[delivery] the skill did not deliver — sending $primary from the runner"
      bash scripts/notify.sh "$title" "$primary" || true
      # notify.sh has now written the receipt either way; re-read it.
      if [ -s "$receipt_file" ]; then
        IFS=$'\t' read -r d_ok d_why < "$receipt_file"
        if [ "${d_ok:-}" = "true" ]; then
          delivered=true; delivery_err=""
        else
          delivery_err="${d_why:-delivery failed}"
        fi
      fi
    else
      echo "[delivery] nothing to deliver — no digest found for $skill"
    fi
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
printf '{"skill":"%s","ok":%s,"when":"%s","outputs":%s,"error":"%s","delivered":%s,"deliveryError":"%s","assertOk":%s,"assertWhy":"%s","model":"%s","tokens":{"in":%s,"out":%s,"cache":%s},"cost_usd":%s}\n' \
  "$skill" "$ok" "$when" "$arr" "$err" "$delivered" "$delivery_err" "$assert_ok" "$assert_why" \
  "$model" "$tok_in" "$tok_out" "$tok_cache" "$cost" \
  > "inbox/_runs/$skill.status"

# Append-only usage log — one line per run, so cost per skill can be compared
# over time and the expensive ones tuned. Never rewritten (golden rule 1); the
# .status file only ever holds the LATEST run, which is no use for spotting a
# trend or a skill that has quietly got more expensive.
mkdir -p _meta
printf '{"when":"%s","skill":"%s","model":"%s","ok":%s,"in":%s,"out":%s,"cache":%s,"cacheRead":%s,"cacheWrite":%s,"cost_usd":%s,"turns":%s,"ms":%s,"skipped":%s}\n' \
  "$when" "$skill" "$model" "$ok" "$tok_in" "$tok_out" "$tok_cache" "$tok_cache_r" "$tok_cache_w" \
  "$cost" "$turns" "$ms" "$([ "$skip_model" -eq 1 ] && echo true || echo false)" \
  >> _meta/skill-usage.jsonl

# Shout on failure (spec §5: silence must be loud), best-effort. Goes through
# notify.sh like everything else, so it uses the one delivery channel there is.
# LV_DELIVERY_RECEIPT is cleared first: this is an alert about the failure, not
# the skill's own delivery, and letting it overwrite the receipt would report a
# brief as delivered because its failure notice got through.
# A brief that came out hollow is a failure the run itself won't report — `ok`
# is true, the file exists, it was delivered. Without this the only trace is a
# field in a status file nobody opens on a normal morning.
if [ "$assert_ok" = false ]; then
  ( unset LV_DELIVERY_RECEIPT
    printf '%s\n' "$assert_why" | bash scripts/notify.sh "⚠️ $skill came out hollow" - ) \
    || echo "[alert] could not deliver the hollow-brief notice"
fi

if [ "$ok" = false ]; then
  # NOT silenced. This used to be `>/dev/null 2>&1 || true`, which meant that
  # when the alert itself failed to send there was no trace of it anywhere —
  # the failure of the failure-notifier, invisible. On 4 Aug two runs died on a
  # session limit and no alert arrived, and the log had nothing to say about it.
  ( unset LV_DELIVERY_RECEIPT
    printf '%s\n' "$out" | tail -n 5 | bash scripts/notify.sh "⚠️ $skill failed" - ) \
    || echo "[alert] could not deliver the failure notice — see the notify: line above"
fi


[ "$ok" = true ]
