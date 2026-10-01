#!/usr/bin/env bash
# End-to-end demo against a running stack:
#   1. the example todo app passes every test
#   2. the deliberately broken app fails
#   3. the partially finished app scores 60% (3/5)
#   4. the next submission is rejected once the daily limit is reached
# Start the stack with a small limit to see scenario 4, e.g.:
#   SELFTEST_DAILY_LIMIT=3 docker compose up --build
set -uo pipefail
cd "$(dirname "$0")/.."

BASE="${SELFTEST_SERVER:-http://127.0.0.1:8080}"
TOKEN="${SELFTEST_TOKEN:-demo-token}"
CLI="python3 cli/selftest.py --server $BASE --token $TOKEN"
failures=0

check() { # name expected_code actual_code
  if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "MISS - $1 (expected exit $2, got $3)"; failures=$((failures + 1)); fi
}

echo "== quota before =="
$CLI quota

echo "== 1. example app: expect all tests passed (exit 0) =="
$CLI submit examples/app-todo --task demo-todo --wait
check "example app passes" 0 $?

echo "== 2. broken app: expect failing tests (exit 1) =="
$CLI submit examples/app-todo-broken --task demo-todo --wait
check "broken app fails" 1 $?

echo "== 3. partial app: expect 60% (exit 1) =="
$CLI submit examples/app-todo-partial --task demo-todo --wait
check "partial app scores 60%" 1 $?

echo "== 4. over-quota submission: expect rejection =="
out=$($CLI submit examples/app-todo --task demo-todo 2>&1)
rc=$?
echo "$out"
if [ $rc -ne 0 ] && echo "$out" | grep -q "429"; then
  echo "ok   - over-quota rejected (HTTP 429)"
else
  echo "MISS - over-quota rejection (exit $rc, no HTTP 429 in output; is SELFTEST_DAILY_LIMIT=3?)"
  failures=$((failures + 1))
fi

echo "== quota after =="
$CLI quota

if [ $failures -eq 0 ]; then echo "e2e demo: all four scenarios as expected"; else echo "e2e demo: $failures mismatch(es)"; exit 1; fi
