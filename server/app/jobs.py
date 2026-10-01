"""Background job queue: zip -> validate -> evaluate -> store result."""

from __future__ import annotations

import logging
import shutil
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from .config import Config
from .quota import Quota, QuotaExceeded
from .runner import Evaluator, EvalResult
from .store import Store
from .validate import extract, validate_zip, ValidationError

log = logging.getLogger("selftest.jobs")


class JobService:
    def __init__(self, cfg: Config, store: Store, quota: Quota, evaluator: Evaluator):
        self.cfg = cfg
        self.store = store
        self.quota = quota
        self.evaluator = evaluator
        self.pool = ThreadPoolExecutor(max_workers=cfg.job_workers, thread_name_prefix="eval")

    def submit(self, team: str, zip_bytes: bytes, filename: str) -> str:
        """Validate + enqueue. Raises ValidationError / QuotaExceeded."""
        sub_id = uuid.uuid4().hex[:12]
        sub_dir = self.store.submission_dir(sub_id)
        sub_dir.mkdir(parents=True, exist_ok=True)
        zip_path = sub_dir / "app.zip"
        zip_path.write_bytes(zip_bytes)
        try:
            validate_zip(zip_path, self.cfg.max_zip_mb, self.cfg.max_zip_files, self.cfg.max_unzipped_mb)
            self.quota.try_consume(team)  # raises QuotaExceeded; counts accepted submissions
        except Exception:
            shutil.rmtree(sub_dir, ignore_errors=True)  # rejected uploads leave nothing on disk
            raise
        self.store.create(sub_id, team)
        self.pool.submit(self._run, sub_id)
        return sub_id

    def _run(self, sub_id: str) -> None:
        sub_dir = self.store.submission_dir(sub_id)
        results_dir = self.store.result_dir(sub_id)
        try:
            self.store.set_status(sub_id, "building")
            src = sub_dir / "src"
            extract(sub_dir / "app.zip", src)
            self.store.set_status(sub_id, "running")
            result = self.evaluator.evaluate(sub_id, src, results_dir)
        except Exception as exc:  # extract errors and unexpected failures
            log.exception("job %s failed", sub_id)
            result = EvalResult(status="error", detail=str(exc)[:500])
        # Keep big artifacts alongside result.json.
        results_dir.mkdir(parents=True, exist_ok=True)
        if result.app_log:
            (results_dir / "app.log").write_text(result.app_log)
        if result.runner_log:
            (results_dir / "runner.log").write_text(result.runner_log)
        self.store.save_result(sub_id, result)
        self.store.set_status(sub_id, result.status)
        shutil.rmtree(sub_dir / "src", ignore_errors=True)  # source no longer needed
