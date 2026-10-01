"""Background job queue: zip -> validate -> enqueue -> (build -> evaluate ->
store result). The last step is split out as `run_submission()` so it can be
driven two ways: in-process (`SELFTEST_ROLE=all`, the default — a
ThreadPoolExecutor inside the API process, as before) or out-of-process
(`SELFTEST_ROLE=api` + a separate `server/app/worker.py` process polling the
same SQLite store). See docs/security-review.md open item #1: splitting
these means the Docker socket — full code-execution privilege on the host —
only has to be mounted into the worker process, never the internet-facing
API process."""

from __future__ import annotations

import logging
import shutil
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from common.taskspec import TaskError, load_task

from .config import Config
from .quota import Quota, QuotaExceeded
from .runner import Evaluator, EvalResult
from .store import Store
from .validate import extract, validate_zip, ValidationError

log = logging.getLogger("selftest.jobs")


class QueueFull(Exception):
    pass


def run_submission(cfg: Config, store: Store, evaluator: Evaluator, sub_id: str, task_id: str) -> None:
    """Build the submitted app, run its task's test pack, and persist the
    result. Assumes `sub_id` is already validated/persisted (JobService.submit)
    and its zip is on disk. Shared by JobService's in-process pool and the
    standalone worker process — the one place this logic lives."""
    sub_dir = store.submission_dir(sub_id)
    results_dir = store.result_dir(sub_id)
    visibility = "hidden"  # safest default if the task can't even be reloaded
    try:
        task = load_task(cfg.tasks_dir, task_id)
        visibility = task.visibility
        store.set_status(sub_id, "building")
        src = sub_dir / "src"
        extract(sub_dir / "app.zip", src)
        store.set_status(sub_id, "running")
        result = evaluator.evaluate(sub_id, src, results_dir, task)
    except Exception as exc:  # task reload, extract errors, unexpected failures
        log.exception("job %s failed", sub_id)
        result = EvalResult(status="error", task_id=task_id, visibility=visibility, detail=str(exc)[:500])
    # Keep big artifacts alongside result.json.
    results_dir.mkdir(parents=True, exist_ok=True)
    if result.app_log:
        (results_dir / "app.log").write_text(result.app_log)
    if result.runner_log:
        (results_dir / "runner.log").write_text(result.runner_log)
    store.save_result(sub_id, result)
    store.set_status(sub_id, result.status)
    shutil.rmtree(sub_dir / "src", ignore_errors=True)  # source no longer needed


class JobService:
    def __init__(self, cfg: Config, store: Store, quota: Quota, evaluator: Evaluator | None):
        """`evaluator=None` means this process only validates and enqueues —
        `SELFTEST_ROLE=api`, with a separate worker process draining the
        queue. Otherwise (the default, `SELFTEST_ROLE=all`) this process also
        runs jobs itself via an in-process thread pool, as before."""
        self.cfg = cfg
        self.store = store
        self.quota = quota
        self.evaluator = evaluator
        self.pool = ThreadPoolExecutor(max_workers=cfg.job_workers, thread_name_prefix="eval") \
            if evaluator is not None else None

    def submit(self, team: str, zip_bytes: bytes, filename: str, task_id: str) -> str:
        """Validate + enqueue. Raises TaskError / ValidationError / QuotaExceeded / QueueFull."""
        # Backed by the store (not an in-process counter) so the cap holds
        # across the api/worker split too, where "in flight" spans processes.
        if self.store.count_active() >= self.cfg.job_queue_max:
            raise QueueFull(f"job queue is full ({self.cfg.job_queue_max} submissions in flight)")
        sub_id = uuid.uuid4().hex[:12]
        sub_dir = self.store.submission_dir(sub_id)
        try:
            load_task(self.cfg.tasks_dir, task_id)  # raises TaskError for an unknown task_id
            sub_dir.mkdir(parents=True, exist_ok=True)
            zip_path = sub_dir / "app.zip"
            zip_path.write_bytes(zip_bytes)
            validate_zip(zip_path, self.cfg.max_zip_mb, self.cfg.max_zip_files, self.cfg.max_unzipped_mb)
            self.quota.try_consume(team)  # raises QuotaExceeded; counts accepted submissions
            self.store.create(sub_id, team, task_id)
        except Exception:
            shutil.rmtree(sub_dir, ignore_errors=True)  # rejected uploads leave nothing on disk
            raise
        if self.pool is not None:
            self.pool.submit(run_submission, self.cfg, self.store, self.evaluator, sub_id, task_id)
        # else: left at status="queued" for the standalone worker to claim.
        return sub_id
