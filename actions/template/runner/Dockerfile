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

# Runs as the image's unprivileged `node` user (uid 1000), not root.
# Chromium's own sandbox additionally needs unprivileged user namespaces;
# scripts/grade.sh / grade.yml provide them (AppArmor sysctl + Playwright's
# seccomp profile, runner/seccomp_profile.json).
USER node

ENTRYPOINT ["/opt/selftest/run.sh"]
