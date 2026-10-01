import io
import time
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Config
from app.jobs import JobService
from app.main import create_app
from app.quota import Quota
from app.runner import EvalResult, TestCaseResult
from app.store import Store


class FakeEvaluator:
    """Evaluates instantly, no Docker. Used by API tests."""

    def evaluate(self, job_id: str, app_src: Path, results_dir: Path, task) -> EvalResult:
        return EvalResult(
            status="done",
            task_id=task.task_id,
            visibility=task.visibility,
            passed=2,
            failed=0,
            total=2,
            pass_rate=100.0,
            pack_hash="ab" * 32,
            tests=[TestCaseResult(title="t1", ok=True), TestCaseResult(title="t2", ok=True)],
            app_log="listening on 3000",
            duration_s=0.1,
        )


def make_zip_bytes(files: dict[str, str]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, content in files.items():
            zf.writestr(name, content)
    return buf.getvalue()


def make_task(tasks_dir: Path, task_id: str, visibility: str = "public") -> None:
    req_dir = tasks_dir / task_id / "requirements"
    req_dir.mkdir(parents=True)
    (req_dir / "requirements.yaml").write_text(f"visibility: {visibility}\n")
    tests_dir = tasks_dir / task_id / "tests"
    tests_dir.mkdir()
    (tests_dir / "x.spec.js").write_text("test('x')")


@pytest.fixture()
def client(tmp_path):
    cfg = Config(data_dir=tmp_path / "data", tasks_dir=tmp_path / "tasks", daily_limit=2)
    make_task(cfg.tasks_dir, "t1")
    make_task(cfg.tasks_dir, "t1-hidden", visibility="hidden")
    store = Store(cfg.data_dir)
    quota = Quota(cfg.data_dir / "quota.db", cfg.daily_limit)
    service = JobService(cfg, store, quota, FakeEvaluator())
    app = create_app(cfg, service)
    with TestClient(app) as c:
        c.store = store
        yield c


def wait_done(store, sub_id, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        sub = store.get(sub_id)
        if sub["status"] in ("done", "failed", "error"):
            return sub
        time.sleep(0.05)
    raise AssertionError("job did not finish")


def submit(client, token="team-a", task_id="t1"):
    return client.post(
        "/api/submissions",
        files={"file": ("app.zip", make_zip_bytes({"Dockerfile": "FROM scratch"}), "application/zip")},
        data={"task_id": task_id},
        headers={"X-Team-Token": token},
    )


def test_full_flow(client):
    r = submit(client)
    assert r.status_code == 202
    sub_id = r.json()["id"]
    sub = wait_done(client.store, sub_id)
    assert sub["status"] == "done"
    r = client.get(f"/api/submissions/{sub_id}", headers={"X-Team-Token": "team-a"})
    body = r.json()
    assert body["result"]["pass_rate"] == 100.0
    assert body["result"]["pack_hash"] == "ab" * 32
    assert [t["title"] for t in body["result"]["tests"]] == ["t1", "t2"]


def test_hidden_task_result_reduced_to_status_passed_total(client):
    sub_id = submit(client, task_id="t1-hidden").json()["id"]
    wait_done(client.store, sub_id)
    body = client.get(f"/api/submissions/{sub_id}", headers={"X-Team-Token": "team-a"}).json()
    assert body["result"] == {"status": "done", "passed": 2, "total": 2}


def test_hidden_task_logs_and_artifacts_forbidden(client):
    sub_id = submit(client, task_id="t1-hidden").json()["id"]
    wait_done(client.store, sub_id)
    (client.store.result_dir(sub_id) / "app.log").write_text("secret log")
    r = client.get(f"/api/submissions/{sub_id}/logs/app", headers={"X-Team-Token": "team-a"})
    assert r.status_code == 403
    r = client.get(f"/api/submissions/{sub_id}/artifact?path=app.log", headers={"X-Team-Token": "team-a"})
    assert r.status_code == 403


def test_unknown_task_id_rejected(client):
    r = client.post(
        "/api/submissions",
        files={"file": ("app.zip", make_zip_bytes({"Dockerfile": "FROM scratch"}), "application/zip")},
        data={"task_id": "no-such-task"},
        headers={"X-Team-Token": "team-a"},
    )
    assert r.status_code == 400
    assert "no-such-task" in r.json()["detail"]


def test_results_visible_only_to_owner(client):
    sub_id = submit(client, token="team-a").json()["id"]
    wait_done(client.store, sub_id)
    r = client.get(f"/api/submissions/{sub_id}", headers={"X-Team-Token": "team-b"})
    assert r.status_code == 403
    r = client.get(f"/api/submissions/{sub_id}")
    assert r.status_code == 401


def test_quota_rejects_after_limit(client):
    assert submit(client).status_code == 202
    assert submit(client).status_code == 202
    r = submit(client)
    assert r.status_code == 429
    q = client.get("/api/quota", headers={"X-Team-Token": "team-a"}).json()
    assert q == {"team": "team-a", "limit": 2, "used": 2, "remaining": 0}


def test_invalid_zip_rejected_without_consuming_quota(client):
    r = client.post(
        "/api/submissions",
        files={"file": ("app.zip", b"junk", "application/zip")},
        data={"task_id": "t1"},
        headers={"X-Team-Token": "team-a"},
    )
    assert r.status_code == 400
    assert client.get("/api/quota", headers={"X-Team-Token": "team-a"}).json()["used"] == 0


def test_missing_dockerfile_rejected(client):
    r = client.post(
        "/api/submissions",
        files={"file": ("app.zip", make_zip_bytes({"x.txt": "y"}), "application/zip")},
        data={"task_id": "t1"},
        headers={"X-Team-Token": "team-a"},
    )
    assert r.status_code == 400
    assert "Dockerfile" in r.json()["detail"]


def test_health(client):
    assert client.get("/api/health").json() == {"ok": True}
