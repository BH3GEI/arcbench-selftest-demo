#!/usr/bin/env bash
# Optional warm-up: pull base images and build the Playwright runner image
# ahead of time. The service also builds the runner lazily on first use.
set -euo pipefail
cd "$(dirname "$0")/.."

docker pull node:24-bookworm-slim
docker build -t selftest-runner:local ./runner
echo "prep done"
