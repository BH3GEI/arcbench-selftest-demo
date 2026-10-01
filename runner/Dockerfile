# Playwright runner image: browsers pinned, pack-agnostic.
# Built once per deployment (`docker compose up --build` triggers it when the
# image is missing, or run scripts/prep.sh). Submissions never rebuild it.
FROM node:24-bookworm-slim

ARG PLAYWRIGHT_VERSION=1.57.0

# Optional apt mirror for networks where deb.debian.org is slow, e.g.
#   docker build --build-arg APT_MIRROR=mirrors.ustc.edu.cn ./runner
ARG APT_MIRROR=
RUN if [ -n "$APT_MIRROR" ]; then \
      sed -i "s|deb.debian.org|$APT_MIRROR|g" /etc/apt/sources.list.d/debian.sources; \
    fi

RUN npm install -g @playwright/test@${PLAYWRIGHT_VERSION} && npm cache clean --force
RUN npx playwright install --with-deps chromium

# gosu: drop root before the step that actually launches Chromium against
# participant-controlled pages, so a browser sandbox escape lands as this
# unprivileged user, not root. Official Debian package, not a third-party
# binary fetch.
RUN apt-get update && apt-get install -y --no-install-recommends gosu \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -r runner && useradd -r -g runner -m -d /home/runner runner

COPY playwright.config.js wait-ready.mjs run.sh /opt/selftest/
RUN chmod +x /opt/selftest/run.sh

ENTRYPOINT ["/opt/selftest/run.sh"]
