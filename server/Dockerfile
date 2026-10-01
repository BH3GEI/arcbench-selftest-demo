FROM python:3.12-slim

WORKDIR /srv
COPY server/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
# Docker CLI only (not the daemon) — the official static binary from
# download.docker.com, not the Debian docker.io apt package: that package
# bundles dockerd/containerd/runc and apparently doesn't reliably leave a
# `docker` binary on PATH in this base image (confirmed by a failed verify
# run — "No such file or directory: 'docker'" — see docs/parity.md). Only
# the SELFTEST_ROLE=worker process actually calls out to it
# (server/app/docker_ops.py's build_image(), for a build timeout that
# really kills the build — docs/security-review.md open item #2), but
# api/all share this same image, so it's installed either way.
ARG DOCKER_CLI_VERSION=29.8.2
RUN set -eu; \
    ARCH="$(dpkg --print-architecture)"; \
    case "$ARCH" in amd64) ARCH=x86_64 ;; arm64) ARCH=aarch64 ;; esac; \
    URL="https://download.docker.com/linux/static/stable/${ARCH}/docker-${DOCKER_CLI_VERSION}.tgz"; \
    python3 -c "import urllib.request,sys; urllib.request.urlretrieve(sys.argv[1], '/tmp/docker-cli.tgz')" "$URL"; \
    tar -xzf /tmp/docker-cli.tgz -C /usr/local/bin --strip-components=1 docker/docker; \
    rm -f /tmp/docker-cli.tgz; \
    chmod +x /usr/local/bin/docker; \
    docker --version
COPY server/app ./app
# The real common/ module lives at actions/template/common/ (the GitHub
# Actions grader template is self-contained and portable; the repo-root
# `common` symlink is for local, non-Docker use e.g. pytest). Copy the real
# directory directly so the image doesn't depend on resolving a symlink.
COPY actions/template/common ./common
ENV PYTHONPATH=/srv

EXPOSE 8080
# SELFTEST_ROLE selects which process actually runs (server/app/config.py):
# "all" (default, single-container local use) and "api" serve HTTP; "worker"
# runs the Docker build/test loop with no HTTP server at all. compose.yml's
# default topology is the api+worker split (docs/security-review.md item #1).
CMD ["sh", "-c", "if [ \"$SELFTEST_ROLE\" = \"worker\" ]; then exec python -m app.worker; else exec uvicorn app.main:app --host 0.0.0.0 --port 8080; fi"]
