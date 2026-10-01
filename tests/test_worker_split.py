"""SELFTEST_ROLE=api/worker split: JobService(evaluator=None) only enqueues;
Store.claim_next_queued/count_active drive a separate worker process (or, in
these tests, a direct call to jobs.run_submission)."""

from __future__ import annotations

import io
import zipfile
from pathlib import Path

from app.config import Config
from app.jobs import JobService, run_submission
from app.quota import Quota
from app.runner import EvalResult
from app.store import Store


class FakeEvaluator:
    def evaluate(self, job_id, app_src, results_dir, task) -> EvalResult:
        return EvalResult(status="done", task_id=task.task_id, visibility=task.visibility,
                          passed=1, total=1)


def make_zip() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("Dockerfile", "FROM scratch")
    return buf.getvalue()


def make_task(tasks_dir: Path, task_id: str = "t1") -> None:
    req_dir = tasks_dir / task_id / "requirements"
    req_dir.mkdir(parents=True)
    (req_dir / "requirements.yaml").write_text("visibility: public\n")
    (tasks_dir / task_id / "tests").mkdir()


def test_api_role_only_enqueues_no_evaluator_needed(tmp_path):
    cfg = Config(data_dir=tmp_path / "data", tasks_dir=tmp_path / "tasks", role="api").resolve()
    make_task(cfg.tasks_dir)
    store = Store(cfg.data_dir)
    quota = Quota(cfg.data_dir / "quota.db", 10)
    service = JobService(cfg, store, quota, None)  # no evaluator in api role

    sub_id = service.submit("team-a", make_zip(), "app.zip", "t1")
    assert store.get(sub_id)["status"] == "queued"
    assert service.pool is None


def test_worker_claims_and_runs_queued_submission(tmp_path):
    cfg = Config(data_dir=tmp_path / "data", tasks_dir=tmp_path / "tasks", role="api").resolve()
    make_task(cfg.tasks_dir)
    store = Store(cfg.data_dir)
    quota = Quota(cfg.data_dir / "quota.db", 10)
    service = JobService(cfg, store, quota, None)
    sub_id = service.submit("team-a", make_zip(), "app.zip", "t1")

    claim = store.claim_next_queued()
    assert claim == (sub_id, "t1")
    assert store.get(sub_id)["status"] == "building"
    assert store.claim_next_queued() is None  # nothing else queued

    run_submission(cfg, store, FakeEvaluator(), sub_id, "t1")
    assert store.get(sub_id)["status"] == "done"
    assert store.load_result(sub_id)["passed"] == 1


def test_queue_max_counts_across_processes_via_store(tmp_path):
    cfg = Config(data_dir=tmp_path / "data", tasks_dir=tmp_path / "tasks",
                role="api", job_queue_max=1).resolve()
    make_task(cfg.tasks_dir)
    store = Store(cfg.data_dir)
    quota = Quota(cfg.data_dir / "quota.db", 10)
    service = JobService(cfg, store, quota, None)

    service.submit("team-a", make_zip(), "app.zip", "t1")
    assert store.count_active() == 1
    import pytest
    from app.jobs import QueueFull
    with pytest.raises(QueueFull):
        service.submit("team-a", make_zip(), "app.zip", "t1")
