#!/usr/bin/env bash
# Orchestrates one grading run: download -> validate -> isolated build/run ->
# Playwright pack -> parsed, visibility-filtered result.json.
#
# Mirrors the local demo's LocalDockerEvaluator (server/app/runner.py +
# docker_ops.py in the public repo) step for step, as plain docker CLI calls
# so this template has no Python/Docker-SDK dependency to install.
#
# Delivering the result back to the submitter (callback POST / GitHub
# Release) is NOT this script's job any more — that needs CALLBACK_TOKEN /
# SELFTEST_DISPATCH_SIGNING_KEY, which this script's job must never hold
# (it builds and runs untrusted participant code). See scripts/report_back.py,
# called from the workflow's separate `report` job instead.
#
# Required env: SUBMISSION_ID, TASK_ID, DOWNLOAD_URL
# Optional env: VISIBILITY_OVERRIDE, APP_DOWNLOAD_TOKEN,
#               DISPATCH_STATUS, DISPATCH_DETAIL (set by the `prepare` job
#               when the dispatch signature itself didn't check out — see
#               "status vocabulary" below)
#
# Status vocabulary written to result.json (see README_ACTIONS.md "Result
# fields" for the full contract the self-test/web side reads):
#   passed        - scored, every test passed
#   failed        - scored or not, but the *participant's* fault: build
#                   failed, bad zip/no Dockerfile, app never became ready,
#                   tests ran and some failed or the run itself timed out
#   system_error  - infra, not the participant's fault: download failed,
#                   the runner harness crashed before producing a report.
#                   The caller should retry the dispatch once and must not
#                   charge the daily quota for this result.
#   rejected      - the dispatch itself didn't authenticate (bad/missing
#                   HMAC signature) or named an unknown task_id; not a real
#                   graded submission at all.
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

STATUS="system_error"
DETAIL=""

cleanup() {
  docker rm -f "$RUNNER_CTR" "$APP_CTR" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  docker image rm "$IMAGE" >/dev/null 2>&1 || true
  # A build killed on timeout (below) can leave BuildKit cache/intermediate
  # state behind on the shared daemon; this run's job filesystem is thrown
  # away either way, but the daemon isn't, so reclaim it explicitly.
  docker builder prune -f --filter "until=0s" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# 0. The `prepare` job already ran scripts/verify_signature.py (it holds
# SELFTEST_DISPATCH_SIGNING_KEY, which this job must not) and the task_id
# format check. If that rejected the dispatch, skip straight to writing a
# "rejected" result — no download, no build, nothing untrusted touched.
if [ "${DISPATCH_STATUS:-ok}" != "ok" ]; then
  STATUS="rejected"; DETAIL="${DISPATCH_DETAIL:-dispatch rejected}"
fi

# Task lookup (visibility, app_port, timeouts, tests dir) goes through
# common/taskspec.py — the exact module the local docker-compose server
# imports for the same purpose — so a task_id resolves identically on both
# grading channels.
if [ -z "$DETAIL" ]; then
  if ! TASK_ENV="$(PYTHONPATH="$ROOT" python3 -m common.taskspec "$ROOT/tasks" "$TASK_ID")"; then
    STATUS="rejected"; DETAIL="unknown task_id: $TASK_ID"
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
  # Retried: this is infra, not the submission under test — and a download
  # failure after retries is the self-test service's/storage's fault, not the
  # participant's, so it's status=system_error, never a participant result.
  CURL_OPTS=(-fsSL --proto =https --proto-redir =https --max-filesize 104857600 --max-time 120)
  DL_OK=0
  if [ -n "${APP_DOWNLOAD_TOKEN:-}" ]; then
    retry 3 5 curl "${CURL_OPTS[@]}" -H "Authorization: Bearer $APP_DOWNLOAD_TOKEN" "$DOWNLOAD_URL" -o "$WORK/app.zip" || DL_OK=1
  else
    retry 3 5 curl "${CURL_OPTS[@]}" "$DOWNLOAD_URL" -o "$WORK/app.zip" || DL_OK=1
  fi
  if [ "$DL_OK" -ne 0 ]; then
    STATUS="system_error"; DETAIL="download failed"
  fi
fi

if [ -z "$DETAIL" ]; then
  # 2. unzip with basic safety limits (path traversal, size, file count).
  # A rejected zip or a missing Dockerfile is the participant's own
  # submission being malformed — status=failed, not system_error.
  APP_SRC="$WORK/app_src"
  mkdir -p "$APP_SRC"
  if ! python3 "$ROOT/scripts/safe_unzip.py" "$WORK/app.zip" "$APP_SRC"; then
    STATUS="failed"; DETAIL="zip failed validation (bad paths, too large, or too many files)"
  elif [ ! -f "$APP_SRC/Dockerfile" ]; then
    STATUS="failed"; DETAIL="no Dockerfile at the root of the submitted app"
  fi
fi

if [ -z "$DETAIL" ]; then
  # 3. isolated build — no network, resource-capped, and actually killed on
  # timeout. `DOCKER_BUILDKIT=1` + a plain `timeout` is not enough on its own:
  # against the legacy builder, killing the `docker build` *client* process
  # does not stop the daemon-side build (see docs/security-review.md #2) — a
  # hung or hostile build keeps consuming CPU/RAM/disk on the runner forever.
  # BuildKit (the default builder on current `docker`/Actions images) *does*
  # cancel the daemon-side build when the client's gRPC session is torn down,
  # so pin it explicitly rather than relying on whatever the runner image
  # happens to default to. `--kill-after` escalates to SIGKILL if the client
  # itself ignores SIGTERM; cleanup()'s `docker builder prune` reclaims any
  # cache a killed build left behind. Memory/CPU caps are defense in depth
  # for the (rarer) legacy-builder path and for steps that run before the
  # timeout would otherwise fire.
  BUILD_RC=0
  DOCKER_BUILDKIT=1 timeout --kill-after=10 --signal=TERM "$BUILD_TIMEOUT_S" \
    docker build --network=none \
    --memory=2g --memory-swap=2g --cpu-quota=200000 --cpu-period=100000 \
    -t "$IMAGE" "$APP_SRC" \
    > "$RESULTS/build.log" 2>&1 || BUILD_RC=$?
  if [ "$BUILD_RC" -ne 0 ]; then
    STATUS="failed"
    if [ "$BUILD_RC" -eq 124 ] || [ "$BUILD_RC" -eq 137 ]; then
      DETAIL="app build exceeded ${BUILD_TIMEOUT_S}s (terminated)"
    else
      DETAIL="app build failed"
    fi
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
  # sees the app's source (only BASE_URL over the internal network). Runs as
  # a non-root user (see runner/Dockerfile) so Chromium's own sandbox is
  # available instead of needing --no-sandbox — that alone isn't enough on
  # Ubuntu 23.10+ though, which disables unprivileged user namespaces by
  # default (AppArmor), hence --security-opt apparmor=unconfined below,
  # scoped to just this one container. $RESULTS is made world-writable
  # first since that non-root uid otherwise can't write into a host
  # bind-mount owned by whatever uid this job happens to run as.
  chmod -R o+rwX "$RESULTS"
  if [ -n "${GRADER_RUNNER_IMAGE:-}" ]; then
    RUNNER_IMAGE="$GRADER_RUNNER_IMAGE"
    retry 3 5 docker pull "$RUNNER_IMAGE" > /dev/null 2>&1 || true
  else
    docker build -q -t "$RUNNER_IMAGE" "$ROOT/runner" > /dev/null
  fi

  # Retried once if the harness itself crashed before producing a report
  # (system_error territory, not the participant's fault) — never retried
  # for a run that reached a ready app and actually executed/timed out tests
  # (that's a participant-fault signal, see the exit-code checks below).
  RUNNER_ATTEMPTS=0
  RUNNER_MAX_ATTEMPTS=2
  while :; do
    RUNNER_ATTEMPTS=$((RUNNER_ATTEMPTS + 1))
    rm -f "$RESULTS/report.json"
    docker rm -f "$RUNNER_CTR" >/dev/null 2>&1 || true
    set +e
    timeout "$RUN_TIMEOUT_S" docker run --name "$RUNNER_CTR" --network "$NET" \
      --label "$LABEL" \
      -e "BASE_URL=http://app:$APP_PORT" \
      -e "READY_TIMEOUT=$READY_TIMEOUT_S" \
      --memory=2g --cpus=2.0 --pids-limit=1024 \
      --security-opt no-new-privileges \
      --security-opt apparmor=unconfined \
      --shm-size=1g \
      -v "$TESTS_DIR:/pack:ro" \
      -v "$RESULTS:/results" \
      "$RUNNER_IMAGE" > "$RESULTS/runner.log" 2>&1
    RUNNER_EXIT=$?
    set -e
    # exit 124 (run timeout) and 3 (app never ready) are decided outcomes,
    # not harness crashes; a report.json means it ran to completion either
    # way. Anything else with no report is the harness itself failing.
    if [ "$RUNNER_EXIT" -eq 124 ] || [ "$RUNNER_EXIT" -eq 3 ] || [ -f "$RESULTS/report.json" ]; then
      break
    fi
    if [ "$RUNNER_ATTEMPTS" -ge "$RUNNER_MAX_ATTEMPTS" ]; then
      break
    fi
    echo "[grade] runner exited $RUNNER_EXIT with no report (attempt $RUNNER_ATTEMPTS/$RUNNER_MAX_ATTEMPTS) — retrying, infra fault" >&2
  done

  docker logs --tail 5000 "$APP_CTR" > "$RESULTS/app.log" 2>&1 || true

  if [ "$RUNNER_EXIT" -eq 124 ]; then
    STATUS="failed"; DETAIL="test run exceeded ${RUN_TIMEOUT_S}s"
  elif [ "$RUNNER_EXIT" -eq 3 ]; then
    STATUS="failed"; DETAIL="app did not become ready within ${READY_TIMEOUT_S}s"
  elif [ ! -f "$RESULTS/report.json" ]; then
    STATUS="system_error"; DETAIL="runner exited $RUNNER_EXIT without a report after $RUNNER_ATTEMPTS attempt(s)"
  else
    STATUS="scored" # final pass/fail decided by parse_report.py below
  fi
fi

# 6. parse + apply visibility, regardless of how far we got (every outcome
# produces a result.json so the caller always gets a structured answer).
python3 "$ROOT/scripts/parse_report.py" \
  --submission-id "$SUBMISSION_ID" \
  --task-id "$TASK_ID" \
  --visibility "${VISIBILITY:-public}" \
  --status "$STATUS" \
  --detail "$DETAIL" \
  --report "$RESULTS/report.json" \
  --out "$RESULTS/result.json"

# Only the headline goes to the job log; the full result (test titles, error
# text for public tasks) is delivered by the workflow's separate `report`
# job (scripts/report_back.py), never via Actions logs.
python3 -c "import json,sys;r=json.load(open(sys.argv[1]));print('[grade] status=%s passed=%s/%s'%(r['status'],r['passed'],r['total']))" "$RESULTS/result.json"

PASS_STATUS="$(python3 -c "import json;print(json.load(open('$RESULTS/result.json'))['status'])")"
if [ "$PASS_STATUS" = "passed" ]; then
  exit 0
else
  exit 1
fi
