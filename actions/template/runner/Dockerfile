# Playwright runner image: browsers pinned, pack-agnostic.
# Built once per grader run (or pulled pre-built via GRADER_RUNNER_IMAGE).
FROM node:24-bookworm-slim

ARG PLAYWRIGHT_VERSION=1.57.0
# Fixed, world-readable browser path: installed here as root (during build)
# but launched later as the unprivileged `node` user (below) — Playwright's
# default install path is under root's home, which that user can't read.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npm install -g @playwright/test@${PLAYWRIGHT_VERSION} \
    && npx playwright install --with-deps chromium \
    && npm cache clean --force \
    && mkdir -p /ms-playwright && chmod -R a+rX /ms-playwright

# The test pack is bind-mounted read-only with no node_modules of its own
# (it's someone else's tests/*.spec.ts, not an npm project), so a bare
# `import { test } from '@playwright/test'` in the pack can't resolve via
# normal upward node_modules search. Point NODE_PATH at the global install so
# Node's module resolution falls back to it.
ENV NODE_PATH=/usr/local/lib/node_modules

COPY playwright.config.js wait-ready.mjs run.sh /opt/selftest/
RUN chmod +x /opt/selftest/run.sh \
    && chown -R node:node /opt/selftest

# Chromium refuses its own sandbox when launched as root (no privileges left
# to drop), which is why a root Playwright container usually either crashes
# or gets `--no-sandbox` bolted on — the latter gives a browser exploit a
# much easier path to the host-adjacent container (docs/security-review.md
# open item #3). Running as the image's unprivileged `node` user (uid 1000)
# is necessary for Chromium's namespace sandbox, but not sufficient: Ubuntu
# 23.10+ disables unprivileged user namespaces by default via AppArmor
# (confirmed by a real "No usable sandbox!" failure against GitHub's
# ubuntu-latest — docs/parity.md), so `scripts/grade.sh`'s `docker run` for
# this image also needs `--security-opt apparmor=unconfined`.
USER node

ENTRYPOINT ["/opt/selftest/run.sh"]
