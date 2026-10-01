# Playwright runner image: browsers pinned, pack-agnostic.
# Built once per grader run (or pulled pre-built via GRADER_RUNNER_IMAGE).
FROM node:24-bookworm-slim

ARG PLAYWRIGHT_VERSION=1.57.0
RUN npm install -g @playwright/test@${PLAYWRIGHT_VERSION} \
    && npx playwright install --with-deps chromium \
    && npm cache clean --force

# The test pack is bind-mounted read-only with no node_modules of its own
# (it's someone else's tests/*.spec.ts, not an npm project), so a bare
# `import { test } from '@playwright/test'` in the pack can't resolve via
# normal upward node_modules search. Point NODE_PATH at the global install so
# Node's module resolution falls back to it.
ENV NODE_PATH=/usr/local/lib/node_modules

COPY playwright.config.js wait-ready.mjs run.sh /opt/selftest/
RUN chmod +x /opt/selftest/run.sh

ENTRYPOINT ["/opt/selftest/run.sh"]
