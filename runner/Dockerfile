# Playwright runner image: browsers pinned, pack-agnostic.
# Built once per deployment (`docker compose up --build` triggers it when the
# image is missing, or run scripts/prep.sh). Submissions never rebuild it.
FROM node:24-bookworm-slim

ARG PLAYWRIGHT_VERSION=1.57.0
RUN npm install -g @playwright/test@${PLAYWRIGHT_VERSION} \
    && npx playwright install --with-deps chromium \
    && npm cache clean --force

COPY playwright.config.js wait-ready.mjs run.sh /opt/selftest/
RUN chmod +x /opt/selftest/run.sh

ENTRYPOINT ["/opt/selftest/run.sh"]
