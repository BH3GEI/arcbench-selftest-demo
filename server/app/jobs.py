"""Background job queue: zip -> validate -> evaluate -> store result."""

from __future__ import annotations

import logging
import shutil
import threading
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


class JobService:
    def __init__(self, cfg: Config, store: Store, quota: Quota, evaluator: Evaluator):
        self.cfg = cfg
        self.store = store
        self.quota = quota
        self.evaluator = evaluator
        self.pool = ThreadPoolExecutor(max_workers=cfg.job_workers, thread_name_prefix="eval")
        self._inflight = 0
        self._inflight_lock = threading.Lock()

    def submit(self, team: str, zip_bytes: bytes, filename: str, task_id: str) -> str:
        """Validate + enqueue. Raises TaskError / ValidationError / QuotaExceeded / QueueFull."""
        with self._inflight_lock:
            if self._inflight >= self.cfg.job_queue_max:
                raise QueueFull(f"job queue is full ({self.cfg.job_queue_max} submissions in flight)")
            self._inflight += 1
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
            with self._inflight_lock:
                self._inflight -= 1
            raise
        self.pool.submit(self._run_and_release, sub_id, task_id)
        return sub_id

    def _run_and_release(self, sub_id: str, task_id: str) -> None:
        try:
            self._run(sub_id, task_id)
        finally:
            with self._inflight_lock:
                self._inflight -= 1

    def _run(self, sub_id: str, task_id: str) -> None:
        sub_dir = self.store.submission_dir(sub_id)
        results_dir = self.store.result_dir(sub_id)
        visibility = "hidden"  # safest default if the task can't even be reloaded
        try:
            task = load_task(self.cfg.tasks_dir, task_id)
            visibility = task.visibility
            self.store.set_status(sub_id, "building")
            src = sub_dir / "src"
            extract(sub_dir / "app.zip", src)
            self.store.set_status(sub_id, "running")
            result = self.evaluator.evaluate(sub_id, src, results_dir, task)
        except Exception as exc:  # task reload, extract errors, unexpected failures
            log.exception("job %s failed", sub_id)
            result = EvalResult(status="error", task_id=task_id, visibility=visibility, detail=str(exc)[:500])
        # Keep big artifacts alongside result.json.
        results_dir.mkdir(parents=True, exist_ok=True)
        if result.app_log:
            (results_dir / "app.log").write_text(result.app_log)
        if result.runner_log:
            (results_dir / "runner.log").write_text(result.runner_log)
        self.store.save_result(sub_id, result)
        self.store.set_status(sub_id, result.status)
        shutil.rmtree(sub_dir / "src", ignore_errors=True)  # source no longer needed
