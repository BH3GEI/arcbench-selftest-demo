"""Standalone execution process (`SELFTEST_ROLE=worker`): claims queued
submissions from the shared SQLite store and runs the Docker build/test
pipeline. Split out from the API process (server/app/main.py, `SELFTEST_ROLE=api`)
so the host Docker socket — full code-execution privilege — is mounted only
here, on a process with no exposed HTTP port, never on the internet-facing
API container. See docs/security-review.md open item #1.

Run with: python -m app.worker
"""

from __future__ import annotations

import logging
import time

from .config import load
from .docker_ops import DockerOps
from .jobs import run_submission
from .logging_setup import configure as configure_logging
from .runner import LocalDockerEvaluator
from .store import Store

log = logging.getLogger("selftest.worker")

POLL_INTERVAL_S = 2


def main() -> None:
    cfg = load()
    configure_logging(cfg)
    store = Store(cfg.data_dir)
    ops = DockerOps(cfg)
    evaluator = LocalDockerEvaluator(cfg, ops)
    try:
        ops.janitor()
    except Exception:
        log.exception("startup janitor failed")
    log.info("worker started (role=%s), polling %s every %ss", cfg.role, cfg.data_dir, POLL_INTERVAL_S)
    while True:
        claim = store.claim_next_queued()
        if claim is None:
            time.sleep(POLL_INTERVAL_S)
            continue
        sub_id, task_id = claim
        log.info("claimed submission %s (task=%s)", sub_id, task_id)
        run_submission(cfg, store, evaluator, sub_id, task_id)


if __name__ == "__main__":
    main()
