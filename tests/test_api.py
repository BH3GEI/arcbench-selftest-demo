"""API end-to-end tests. The Docker-backed evaluator is replaced with a fake
one so these run anywhere, no daemon required."""

from __future__ import annotations

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
from app.runner import EvalResult
from app.store import Store


class FakeEvaluator:
    """Stands in for LocalDockerEvaluator: no docker_ops/runner involved."""

    def __init__(self, result: EvalResult | None = None):
        self.result = result or EvalResult(status="done", passed=1, failed=0, total=1, pass_rate=100.0)
        self.calls: list[str] = []

    def evaluate(self, job_id: str, app_src: Path, results_dir: Path, task) -> EvalResult:
        self.calls.append(job_id)
        self.result.task_id = task.task_id
        self.result.visibility = task.visibility
        return self.result


def make_zip(files: dict[str, str]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, content in files.items():
            zf.writestr(name, content)
    return buf.getvalue()


VALID_ZIP = make_zip({"Dockerfile": "FROM scratch", "server.js": "ok"})


def make_task(tasks_dir: Path, task_id: str = "t1") -> None:
    req_dir = tasks_dir / task_id / "requirements"
    req_dir.mkdir(parents=True)
    (req_dir / "requirements.yaml").write_text("visibility: public\n")
    (tasks_dir / task_id / "tests").mkdir()


def build_client(tmp_path, *, daily_limit=10, evaluator=None, max_zip_mb=1, max_zip_files=50):
    cfg = Config(
        data_dir=tmp_path / "data",
        tasks_dir=tmp_path / "tasks",
        daily_limit=daily_limit,
        max_zip_mb=max_zip_mb,
        max_zip_files=max_zip_files,
    ).resolve()
    make_task(cfg.tasks_dir)
    store = Store(cfg.data_dir)
    quota = Quota(cfg.data_dir / "quota.db", cfg.daily_limit)
    fake = evaluator or FakeEvaluator()
    service = JobService(cfg, store, quota, fake)
    app = create_app(cfg, service)
    return TestClient(app), fake, service


def submit(client, data: bytes, filename="app.zip", token="team-a", task_id="t1"):
    return client.post(
        "/api/submissions",
        files={"file": (filename, data, "application/zip")},
        data={"task_id": task_id},
        headers={"X-Team-Token": token},
    )


def wait_done(client, sub_id, token="team-a", timeout=2.0):
    deadline = time.monotonic() + timeout
    record = {}
    while time.monotonic() < deadline:
        resp = client.get(f"/api/submissions/{sub_id}", headers={"X-Team-Token": token})
        record = resp.json()
        if record["status"] in ("done", "failed", "error"):
            return record
        time.sleep(0.01)
    raise AssertionError(f"submission did not finish in time: {record}")


def test_health(tmp_path):
    client, _, _ = build_client(tmp_path)
    assert client.get("/api/health").json() == {"ok": True}


def test_submit_valid_zip_runs_to_completion(tmp_path):
    client, fake, _ = build_client(tmp_path)
    resp = submit(client, VALID_ZIP)
    assert resp.status_code == 202
    sub_id = resp.json()["id"]
    assert resp.json()["status"] == "queued"

    record = wait_done(client, sub_id)
    assert record["status"] == "done"
    assert record["result"]["passed"] == 1
    assert fake.calls == [sub_id]


def test_submit_rejects_zip_without_dockerfile(tmp_path):
    client, fake, _ = build_client(tmp_path)
    bad = make_zip({"server.js": "no dockerfile here"})
    resp = submit(client, bad)
    assert resp.status_code == 400
    assert "Dockerfile" in resp.json()["detail"]
    assert fake.calls == []


def test_submit_rejects_path_traversal(tmp_path):
    client, fake, _ = build_client(tmp_path)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("Dockerfile", "FROM scratch")
        zf.writestr("../escape.txt", "boom")
    resp = submit(client, buf.getvalue())
    assert resp.status_code == 400
    assert "unsafe path" in resp.json()["detail"]
    assert fake.calls == []


def test_submit_rejects_oversized_zip(tmp_path):
    client, fake, _ = build_client(tmp_path, max_zip_mb=0)
    resp = submit(client, VALID_ZIP)
    assert resp.status_code == 400
    assert "MB" in resp.json()["detail"]
    assert fake.calls == []


def test_submit_rejects_non_zip(tmp_path):
    client, fake, _ = build_client(tmp_path)
    resp = submit(client, b"not actually a zip")
    assert resp.status_code == 400
    assert "zip" in resp.json()["detail"]


def test_quota_exhausted_is_rejected(tmp_path):
    client, _, _ = build_client(tmp_path, daily_limit=1)
    first = submit(client, VALID_ZIP)
    assert first.status_code == 202

    second = submit(client, VALID_ZIP)
    assert second.status_code == 429
    assert "daily limit" in second.json()["detail"]


def test_quota_endpoint_reports_usage(tmp_path):
    client, _, _ = build_client(tmp_path, daily_limit=5)
    submit(client, VALID_ZIP)
    status = client.get("/api/quota", headers={"X-Team-Token": "team-a"}).json()
    assert status == {"team": "team-a", "limit": 5, "used": 1, "remaining": 4}


def test_missing_token_is_unauthorized(tmp_path):
    client, _, _ = build_client(tmp_path)
    resp = client.get("/api/quota")
    assert resp.status_code == 401


def test_can_only_view_own_submissions(tmp_path):
    client, _, _ = build_client(tmp_path)
    resp = submit(client, VALID_ZIP, token="team-a")
    sub_id = resp.json()["id"]

    own = client.get(f"/api/submissions/{sub_id}", headers={"X-Team-Token": "team-a"})
    assert own.status_code == 200

    other = client.get(f"/api/submissions/{sub_id}", headers={"X-Team-Token": "team-b"})
    assert other.status_code == 403


def test_unknown_submission_is_not_found(tmp_path):
    client, _, _ = build_client(tmp_path)
    resp = client.get("/api/submissions/does-not-exist", headers={"X-Team-Token": "team-a"})
    assert resp.status_code == 404


def test_list_submissions_only_shows_own_team(tmp_path):
    client, _, _ = build_client(tmp_path, daily_limit=10)
    submit(client, VALID_ZIP, token="team-a")
    submit(client, VALID_ZIP, token="team-b")

    team_a_list = client.get("/api/submissions", headers={"X-Team-Token": "team-a"}).json()
    assert len(team_a_list) == 1

    team_b_list = client.get("/api/submissions", headers={"X-Team-Token": "team-b"}).json()
    assert len(team_b_list) == 1
    assert team_a_list[0]["id"] != team_b_list[0]["id"]
