#!/usr/bin/env bash
# Runner entrypoint: readiness probe, then the Playwright pack.
# Inputs come as env vars (BASE_URL, READY_TIMEOUT) and mounts
# (/pack read-only test pack, /results writable artifact dir).
set -uo pipefail

echo "[runner] probing $BASE_URL (timeout ${READY_TIMEOUT:-60}s)"
node /opt/selftest/wait-ready.mjs || exit 3

# The pack's specs import '@playwright/test'; they resolve it through
# /work/node_modules -> the runner image's global install.
mkdir -p /work
ln -sfn "$(npm root -g)" /work/node_modules
rm -rf /work/pack
cp -r /pack /work/pack
chown -R runner:runner /work /results 2>/dev/null || true

echo "[runner] app ready, running pack"
# Drop root before the step that actually launches Chromium against
# participant-controlled pages: a browser sandbox escape then lands as
# this unprivileged user, not root. Sandbox itself stays on (no
# --no-sandbox / chromiumSandbox:false anywhere in playwright.config.js).
export HOME=/home/runner
exec gosu runner npx playwright test --config=/opt/selftest/playwright.config.js
