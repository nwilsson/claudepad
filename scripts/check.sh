#!/usr/bin/env bash
# Every check the README lists, in one run; CI runs the same script.
# tsc needs .claude-plugin/types, which the engine lays on a live load
# (never committed): without them the step says so and moves on.
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0
step() { printf '\n== %s\n' "$1"; }

step 'claude plugin validate'
command claude plugin validate . || fail=1

step 'tsc'
if [ -d .claude-plugin/types ]; then
  # a bare `npx tsc` fetches an unrelated package named tsc
  npx --yes -p typescript tsc -p . || fail=1
else
  echo 'skipped: no .claude-plugin/types (load the plugin in a session once)'
fi

step 'claude plugin test'
out=$(command claude plugin test "$PWD" 2>&1) || true
printf '%s\n' "$out" | grep -E '^\(fail\)|^ *[0-9]+ (pass|fail)$|^Ran ' || true
# gate on the summary itself: a test file that fails to load prints no (fail) row
printf '%s\n' "$out" | grep -qE '^ *0 fail$' && printf '%s\n' "$out" | grep -qE '^ *[1-9][0-9]* pass$' || { echo 'plugin tests did not pass'; fail=1; }

step 'manifest versions agree'
version() { sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$1" | head -1; }
a=$(version .claude-plugin/plugin.json)
b=$(version .claude-plugin/marketplace.json)
echo "plugin.json $a, marketplace.json $b"
[ -n "$a" ] && [ "$a" = "$b" ] || fail=1

exit $fail
