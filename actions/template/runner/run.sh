#!/usr/bin/env bash
# Runner entrypoint: readiness probe, then the Playwright pack.
# Inputs come as env vars (BASE_URL, READY_TIMEOUT) and mounts
# (/pack read-only test pack, /results writable artifact dir).
set -uo pipefail

echo "[runner] probing $BASE_URL (timeout ${READY_TIMEOUT:-60}s)"
node /opt/selftest/wait-ready.mjs || exit 3

echo "[runner] app ready, running pack at ${PACK_TEST_DIR:-/pack}"
# Already running as the image's unprivileged `node` user (Dockerfile's
# USER node) for the whole entrypoint, not just this step — Chromium's own
# sandbox stays on too (chromiumSandbox: true in playwright.config.js).
exec npx playwright test --config=/opt/selftest/playwright.config.js
