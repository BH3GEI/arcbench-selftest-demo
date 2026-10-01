#!/usr/bin/env bash
# Orchestrates one grading run: download -> validate -> isolated build/run ->
# Playwright pack -> parsed, visibility-filtered result -> report back.
#
# Mirrors the local demo's LocalDockerEvaluator (server/app/runner.py +
# docker_ops.py in the public repo) step for step, as plain docker CLI calls
# so this template has no Python/Docker-SDK dependency to install.
#
# Required env: SUBMISSION_ID, TASK_ID, DOWNLOAD_URL
# Optional env: VISIBILITY_OVERRIDE, CALLBACK_URL, CALLBACK_TOKEN,
#               APP_DOWNLOAD_TOKEN, GH_TOKEN
set -uo pipefail

: "${SUBMISSION_ID:?missing SUBMISSION_ID}"
: "${TASK_ID:?missing TASK_ID}"
: "${DOWNLOAD_URL:?missing DOWNLOAD_URL}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TASK_DIR="$ROOT/tasks/$TASK_ID"
REQ_FILE="$TASK_DIR/requirements/requirements.yaml"
TESTS_DIR="$TASK_DIR/tests"
# Fixed, predictable location (not mktemp) so a workflow step can upload
# $WORK/results as a build artifact for debugging without knowing a random
# path. Gitignored; removed at the end of a normal cleanup trap is not
# necessary since the whole job's filesystem is thrown away after the run.
WORK="$ROOT/.gradework"
RESULTS="$WORK/results"
rm -rf "$WORK"
mkdir -p "$RESULTS"

SHORT="${SUBMISSION_ID//[^a-zA-Z0-9]/}"
SHORT="${SHORT:0:12}"
IMAGE="app-img-$SHORT"
RUNNER_IMAGE="grader-runner:local"
NET="net-$SHORT"
APP_CTR="app-ctr-$SHORT"
RUNNER_CTR="runner-ctr-$SHORT"
LABEL="grader.managed=$SUBMISSION_ID"

STATUS="error"
DETAIL=""
PASSED=0
TOTAL=0

cleanup() {
  docker rm -f "$RUNNER_CTR" "$APP_CTR" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  docker image rm "$IMAGE" >/dev/null 2>&1 || true
}
trap cleanup EXIT

req() {
  # req <key> <default> — flat "key: value" lookup, see requirements.yaml header.
  local line
  line="$(grep -E "^$1:" "$REQ_FILE" 2>/dev/null | head -1 | cut -d: -f2-)"
  line="$(echo "$line" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  if [ -z "$line" ]; then echo "$2"; else echo "$line"; fi
}

if [ ! -f "$REQ_FILE" ]; then
  STATUS="error"; DETAIL="unknown task_id: $TASK_ID"
else
  VISIBILITY="$(req visibility public)"
  if [ -n "${VISIBILITY_OVERRIDE:-}" ]; then VISIBILITY="$VISIBILITY_OVERRIDE"; fi
  APP_PORT="$(req app_port 3000)"
  BUILD_TIMEOUT_S="$(req build_timeout_s 600)"
  READY_TIMEOUT_S="$(req ready_timeout_s 60)"
  RUN_TIMEOUT_S="$(req run_timeout_s 900)"

  echo "[grade] submission=$SUBMISSION_ID task=$TASK_ID visibility=$VISIBILITY"

  # 1. download the submitted app zip (pre-signed URL expected; optional bearer
  # token for private storage). URL/token are never echoed.
  if [ -n "${APP_DOWNLOAD_TOKEN:-}" ]; then
    DL_OK=0
    curl -fsSL -H "Authorization: Bearer $APP_DOWNLOAD_TOKEN" "$DOWNLOAD_URL" -o "$WORK/app.zip" || DL_OK=1
  else
    DL_OK=0
    curl -fsSL "$DOWNLOAD_URL" -o "$WORK/app.zip" || DL_OK=1
  fi
  if [ "$DL_OK" -ne 0 ]; then
    STATUS="error"; DETAIL="download failed"
  fi
fi

if [ "$STATUS" = "error" ] && [ -z "$DETAIL" ]; then
  : # requirements missing path already set DETAIL above
fi

if [ -z "$DETAIL" ]; then
  # 2. unzip with basic safety limits (path traversal, size, file count).
  APP_SRC="$WORK/app_src"
  mkdir -p "$APP_SRC"
  if ! python3 "$ROOT/scripts/safe_unzip.py" "$WORK/app.zip" "$APP_SRC"; then
    STATUS="error"; DETAIL="zip failed validation (bad paths, too large, or too many files)"
  elif [ ! -f "$APP_SRC/Dockerfile" ]; then
    STATUS="error"; DETAIL="no Dockerfile at the root of the submitted app"
  fi
fi

if [ -z "$DETAIL" ]; then
  # 3. isolated build — no network, wall-clock timeout.
  if ! timeout "$BUILD_TIMEOUT_S" docker build --network=none -t "$IMAGE" "$APP_SRC" \
      > "$RESULTS/build.log" 2>&1; then
    STATUS="error"; DETAIL="app build failed or exceeded ${BUILD_TIMEOUT_S}s"
  fi
fi

if [ -z "$DETAIL" ]; then
  # 4. fresh internal network (no outbound internet) + fresh app container.
  docker network create --driver bridge --internal --label "$LABEL" "$NET" >/dev/null
  docker run -d --name "$APP_CTR" --network "$NET" --network-alias app \
    --label "$LABEL" \
    -e "PORT=$APP_PORT" \
    --memory=512m --cpus=1.0 --pids-limit=256 \
    --read-only --tmpfs /tmp:rw,noexec,size=64m \
    "$IMAGE" > /dev/null

  # 5. Playwright runner container: mounted read-only with this task's test
  # pack only *now*, after the app container exists — the app never sees the
  # tests dir (different container, no shared mount), and the runner never
  # sees the app's source (only BASE_URL over the internal network).
  if [ -n "${GRADER_RUNNER_IMAGE:-}" ]; then
    RUNNER_IMAGE="$GRADER_RUNNER_IMAGE"
    docker pull "$RUNNER_IMAGE" > /dev/null 2>&1 || true
  else
    docker build -q -t "$RUNNER_IMAGE" "$ROOT/runner" > /dev/null
  fi
  set +e
  timeout "$RUN_TIMEOUT_S" docker run --name "$RUNNER_CTR" --network "$NET" \
    --label "$LABEL" \
    -e "BASE_URL=http://app:$APP_PORT" \
    -e "READY_TIMEOUT=$READY_TIMEOUT_S" \
    --memory=2g --cpus=2.0 \
    -v "$TESTS_DIR:/pack:ro" \
    -v "$RESULTS:/results" \
    "$RUNNER_IMAGE" > "$RESULTS/runner.log" 2>&1
  RUNNER_EXIT=$?
  set -e

  docker logs "$APP_CTR" > "$RESULTS/app.log" 2>&1 || true

  if [ "$RUNNER_EXIT" -eq 124 ]; then
    STATUS="error"; DETAIL="test run exceeded ${RUN_TIMEOUT_S}s"
  elif [ "$RUNNER_EXIT" -eq 3 ]; then
    STATUS="error"; DETAIL="app did not become ready within ${READY_TIMEOUT_S}s"
  elif [ ! -f "$RESULTS/report.json" ]; then
    STATUS="error"; DETAIL="runner exited $RUNNER_EXIT without a report"
  else
    STATUS="scored" # final pass/fail decided by parse_report.py below
  fi
fi

# 6. parse + apply visibility, regardless of how far we got (errors also
# produce a result.json so the caller always gets a structured answer).
python3 "$ROOT/scripts/parse_report.py" \
  --submission-id "$SUBMISSION_ID" \
  --task-id "$TASK_ID" \
  --visibility "${VISIBILITY:-public}" \
  --status "$STATUS" \
  --detail "$DETAIL" \
  --report "$RESULTS/report.json" \
  --out "$RESULTS/result.json"

echo "[grade] result:"
cat "$RESULTS/result.json"

# 7. report back to the submitter (never via Actions logs).
RESULT_FILE="$RESULTS/result.json" python3 "$ROOT/scripts/report_back.py"

PASS_STATUS="$(python3 -c "import json;print(json.load(open('$RESULTS/result.json'))['status'])")"
if [ "$PASS_STATUS" = "passed" ]; then
  exit 0
else
  exit 1
fi
