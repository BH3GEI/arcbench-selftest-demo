FROM python:3.12-slim

WORKDIR /srv
COPY server/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
# docker.io: Debian's own official package for the `docker` CLI (not the
# daemon) — only the SELFTEST_ROLE=worker process actually calls out to it
# (server/app/docker_ops.py's build_image(), for a build timeout that really
# kills the build — see docs/security-review.md open item #2), but api/all
# share this same image, so it's installed either way.
RUN apt-get update && apt-get install -y --no-install-recommends docker.io \
    && rm -rf /var/lib/apt/lists/*
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
