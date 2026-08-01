#!/usr/bin/env bash
# Drain the on-demand trigger queue: run every inbox/_runs/*.run through
# run-skill.sh, then archive the trigger.
#
#   bash scripts/process-queue.sh [label]
#
# `label` only colours the log ("queued" vs "leftover"). This was ~25 lines
# duplicated three ways — the main loop in skill-runner.yml, the sweep step in
# scheduled-skills.yml, and near-enough the same again in the local watcher —
# where a fix to one silently left the others behind.
#
# Never deletes a trigger: archives to inbox/_runs/_archive/ (golden rule 1).
# Never fails the caller: a skill that dies records ok:false in its .status and
# the queue keeps draining, because one bad skill must not strand the rest.
set -uo pipefail
label="${1:-queued}"

shopt -s nullglob
runs=(inbox/_runs/*.run)
if [ ${#runs[@]} -eq 0 ]; then
  echo "No $label runs."
  exit 0
fi
mkdir -p inbox/_runs/_archive

for f in "${runs[@]}"; do
  skill="$(basename "$f" .run | sed -E 's/-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{6}$//')"
  echo "::group::$label $skill ($f)"
  input="$(node -e 'try{process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).input||""))}catch(e){}' "$f")"
  bash scripts/run-skill.sh "$skill" "$input" || true    # status file records ok/fail
  git mv "$f" "inbox/_runs/_archive/$(basename "$f")" 2>/dev/null \
    || mv "$f" "inbox/_runs/_archive/$(basename "$f")"
  echo "::endgroup::"
done
