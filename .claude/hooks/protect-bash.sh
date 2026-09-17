#!/usr/bin/env bash
# Blocks dangerous bash commands before they run.
# Dependencies: bash, jq.

set -euo pipefail

# Without jq the input cannot be parsed. The exit code has to be exactly 2: any
# other code is not treated as a refusal by PreToolUse, and a forbidden command
# would run — the protection would open up silently exactly where its absence
# goes unnoticed.
if ! command -v jq >/dev/null 2>&1; then
  echo "BLOCKED: no jq, nothing to parse the command with" 1>&2
  echo "Install jq, or remove the hook from .claude/settings.json deliberately" 1>&2
  exit 2
fi

input=$(cat)
cmd=$(echo "$input" | jq -r '.tool_input.command // ""')

if [ -z "$cmd" ]; then
  exit 0
fi

# Every item is a "regex##reason" pair.
# The separator is ## precisely because | occurs inside the regexes themselves.
# The quotes are single: inside double ones bash would expand $## as the
# variable $#.
#
# The rules about `.env` end with an anchor: without it they would also close
# `.env.example`, which is in the index and is edited as a matter of course.
deny_rules=(
  'rm +-rf +/##deleting from the root'
  'rm +-rf +~##deleting the home directory'
  'rm +-rf +\*##deleting by a mask'
  'rm +-rf +\.( |$)##deleting the current directory'
  'npm +publish##publishing a package'
  'pnpm +publish##publishing a package'
  'npm +version##bumping the package version'
  'uv +publish##publishing a package'
  'git +push +--force##force push'
  'git +push +-f( |$)##force push'
  'git +reset +--hard##loss of uncommitted changes'
  'chmod +777##unsafe permissions'
  '>>? *"?[^ "]*\.env($|[^.a-zA-Z0-9_-])##overwriting .env'
  'cp +.+ +\.env( |$)##overwriting .env by copying'
  'mv +.+ +\.env( |$)##overwriting .env by moving'
  '(^|[;&|(] *)atlas +schema +apply##changing the database schema, done by the set and deliberately'
  'docker +compose +down +.*-v##deleting docker volumes that hold data'
  'docker +volume +rm##deleting a docker volume that holds data'
  '(^|[;&|(] *)docker +system +prune##deleting images and volumes of other projects on a shared machine'
  'DROP +TABLE##destructive SQL'
  'DROP +DATABASE##destructive SQL'
  'TRUNCATE +##destructive SQL'
  'pnpm +install +--no-frozen-lockfile##divergence from pnpm-lock.yaml'
)

for rule in "${deny_rules[@]}"; do
  pat="${rule%%##*}"
  reason="${rule#*##}"
  if echo "$cmd" | grep -Eiq "$pat"; then
    echo "BLOCKED: $reason" 1>&2
    echo "Command: $cmd" 1>&2
    echo "Pattern: $pat" 1>&2
    echo "If the operation is really needed, ask the user to run it by hand" 1>&2
    exit 2
  fi
done

log_dir=".claude/logs"
mkdir -p "$log_dir"
printf '%s | %s\n' "$(date -Iseconds)" "$cmd" >> "$log_dir/bash-commands.log"

exit 0
