import io
import threading
import zipfile
from pathlib import Path

import pytest

from app.config import Config
from app.jobs import JobService, QueueFull
from app.quota import Quota
from app.runner import EvalResult
from app.store import Store


class BlockingEvaluator:
    """Blocks until released, so a test can hold a job "in flight"."""

    def __init__(self):
        self.release = threading.Event()
        self.started = threading.Event()

    def evaluate(self, job_id, app_src, results_dir, task) -> EvalResult:
        self.started.set()
        self.release.wait(timeout=5)
        return EvalResult(status="done", task_id=task.task_id, visibility=task.visibility, passed=1, total=1)


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


def test_submit_rejects_once_queue_is_full(tmp_path):
    cfg = Config(data_dir=tmp_path / "data", tasks_dir=tmp_path / "tasks",
                daily_limit=10, job_workers=1, job_queue_max=1).resolve()
    make_task(cfg.tasks_dir)
    store = Store(cfg.data_dir)
    quota = Quota(cfg.data_dir / "quota.db", cfg.daily_limit)
    evaluator = BlockingEvaluator()
    service = JobService(cfg, store, quota, evaluator)

    sub_id = service.submit("team-a", make_zip(), "app.zip", "t1")
    assert evaluator.started.wait(timeout=5)

    with pytest.raises(QueueFull):
        service.submit("team-a", make_zip(), "app.zip", "t1")

    evaluator.release.set()
    # draining the in-flight job frees a queue slot for the next submission
    for _ in range(50):
        if store.get(sub_id)["status"] == "done":
            break
        threading.Event().wait(0.05)
    assert service.submit("team-a", make_zip(), "app.zip", "t1")
