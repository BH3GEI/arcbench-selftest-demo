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
#               APP_DOWNLOAD_TOKEN, GH_TOKEN, SUBMISSION_TIMESTAMP,
#               SUBMISSION_SIGNATURE, SELFTEST_DISPATCH_SIGNING_KEY
set -uo pipefail

retry() {
  # retry <attempts> <sleep_s> -- <cmd...> — only for infra calls (download,
  # pulling a prebuilt runner image), never for building/testing the
  # submission itself: a flaky network shouldn't get 3 tries disguised as 1,
  # but a genuinely broken submission shouldn't get any extra either.
  local attempts="$1" sleep_s="$2" n=1
  shift 2
  until "$@"; do
    if [ "$n" -ge "$attempts" ]; then return 1; fi
    n=$((n + 1))
    sleep "$sleep_s"
  done
}

: "${SUBMISSION_ID:?missing SUBMISSION_ID}"
: "${TASK_ID:?missing TASK_ID}"
: "${DOWNLOAD_URL:?missing DOWNLOAD_URL}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
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

# 0. authenticate the dispatch itself. This is also where per-team daily
# quota lands on the Actions side (see README_ACTIONS.md "Quota"): the
# self-test service signs {submission_id, task_id, timestamp} only *after*
# its own quota.try_consume() succeeds, so a valid, fresh signature doubles
# as proof quota was already checked — the grader never re-implements a
# stateful counter. No-ops (passes) when SELFTEST_DISPATCH_SIGNING_KEY isn't
# configured, e.g. local workflow_dispatch testing.
SIG_ERR="$(python3 "$ROOT/scripts/verify_signature.py" \
  --submission-id "$SUBMISSION_ID" --task-id "$TASK_ID" \
  --timestamp "${SUBMISSION_TIMESTAMP:-0}" --signature "${SUBMISSION_SIGNATURE:-}" 2>&1 >/dev/null)"
SIG_RC=$?
if [ "$SIG_RC" -ne 0 ]; then
  STATUS="error"; DETAIL="dispatch rejected: ${SIG_ERR:-invalid signature}"
  # An unauthenticated request means submission_id/task_id/callback_url are
  # all untrusted too — never POST to an attacker-supplied callback_url.
  CALLBACK_URL=""
fi

if [ -z "$DETAIL" ] && ! [[ "$TASK_ID" =~ ^[A-Za-z0-9_-]+$ ]]; then
  STATUS="error"; DETAIL="invalid task_id"
fi

# Task lookup (visibility, app_port, timeouts, tests dir) goes through
# common/taskspec.py — the exact module the local docker-compose server
# imports for the same purpose — so a task_id resolves identically on both
# grading channels.
if [ -z "$DETAIL" ]; then
  if ! TASK_ENV="$(PYTHONPATH="$ROOT" python3 -m common.taskspec "$ROOT/tasks" "$TASK_ID")"; then
    STATUS="error"; DETAIL="unknown task_id: $TASK_ID"
  else
    eval "$TASK_ENV"
  fi
fi

if [ -z "$DETAIL" ]; then
  if [ -n "${VISIBILITY_OVERRIDE:-}" ]; then VISIBILITY="$VISIBILITY_OVERRIDE"; fi

  echo "[grade] submission=$SUBMISSION_ID task=$TASK_ID visibility=$VISIBILITY"

  # 1. download the submitted app zip (pre-signed URL expected; optional bearer
  # token for private storage). URL/token are never echoed. HTTPS only, with
  # size and time caps so a hostile URL cannot fill the disk or hang the job.
  # Retried: this is infra, not the submission under test.
  CURL_OPTS=(-fsSL --proto =https --proto-redir =https --max-filesize 104857600 --max-time 120)
  DL_OK=0
  if [ -n "${APP_DOWNLOAD_TOKEN:-}" ]; then
    retry 3 5 curl "${CURL_OPTS[@]}" -H "Authorization: Bearer $APP_DOWNLOAD_TOKEN" "$DOWNLOAD_URL" -o "$WORK/app.zip" || DL_OK=1
  else
    retry 3 5 curl "${CURL_OPTS[@]}" "$DOWNLOAD_URL" -o "$WORK/app.zip" || DL_OK=1
  fi
  if [ "$DL_OK" -ne 0 ]; then
    STATUS="error"; DETAIL="download failed"
  fi
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
    --memory=512m --memory-swap=512m --cpus=1.0 --pids-limit=256 \
    --read-only --tmpfs /tmp:rw,noexec,size=64m \
    --security-opt no-new-privileges \
    --cap-drop NET_RAW --cap-drop MKNOD --cap-drop SYS_CHROOT --cap-drop AUDIT_WRITE --cap-drop SETFCAP \
    --log-opt max-size=10m --log-opt max-file=1 \
    "$IMAGE" > /dev/null

  # 5. Playwright runner container: mounted read-only with this task's test
  # pack only *now*, after the app container exists — the app never sees the
  # tests dir (different container, no shared mount), and the runner never
  # sees the app's source (only BASE_URL over the internal network).
  if [ -n "${GRADER_RUNNER_IMAGE:-}" ]; then
    RUNNER_IMAGE="$GRADER_RUNNER_IMAGE"
    retry 3 5 docker pull "$RUNNER_IMAGE" > /dev/null 2>&1 || true
  else
    docker build -q -t "$RUNNER_IMAGE" "$ROOT/runner" > /dev/null
  fi
  set +e
  timeout "$RUN_TIMEOUT_S" docker run --name "$RUNNER_CTR" --network "$NET" \
    --label "$LABEL" \
    -e "BASE_URL=http://app:$APP_PORT" \
    -e "READY_TIMEOUT=$READY_TIMEOUT_S" \
    --memory=2g --cpus=2.0 --pids-limit=1024 \
    --security-opt no-new-privileges \
    -v "$TESTS_DIR:/pack:ro" \
    -v "$RESULTS:/results" \
    "$RUNNER_IMAGE" > "$RESULTS/runner.log" 2>&1
  RUNNER_EXIT=$?
  set -e

  docker logs --tail 5000 "$APP_CTR" > "$RESULTS/app.log" 2>&1 || true

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

# Only the headline goes to the job log; the full result (test titles, error
# text for public tasks) is delivered by report_back.py below.
python3 -c "import json,sys;r=json.load(open(sys.argv[1]));print('[grade] status=%s passed=%s/%s'%(r['status'],r['passed'],r['total']))" "$RESULTS/result.json"

# 7. report back to the submitter (never via Actions logs).
RESULT_FILE="$RESULTS/result.json" python3 "$ROOT/scripts/report_back.py"

PASS_STATUS="$(python3 -c "import json;print(json.load(open('$RESULTS/result.json'))['status'])")"
if [ "$PASS_STATUS" = "passed" ]; then
  exit 0
else
  exit 1
fi
