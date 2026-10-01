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

    def evaluate(self, job_id: str, app_src: Path, results_dir: Path) -> EvalResult:
        return EvalResult(
            status="done",
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


@pytest.fixture()
def client(tmp_path):
    cfg = Config(data_dir=tmp_path / "data", pack_dir=tmp_path / "pack", daily_limit=2)
    cfg.pack_dir.mkdir()
    (cfg.pack_dir / "x.spec.js").write_text("test('x')")
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


def submit(client, token="team-a"):
    return client.post(
        "/api/submissions",
        files={"file": ("app.zip", make_zip_bytes({"Dockerfile": "FROM scratch"}), "application/zip")},
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
        headers={"X-Team-Token": "team-a"},
    )
    assert r.status_code == 400
    assert client.get("/api/quota", headers={"X-Team-Token": "team-a"}).json()["used"] == 0


def test_missing_dockerfile_rejected(client):
    r = client.post(
        "/api/submissions",
        files={"file": ("app.zip", make_zip_bytes({"x.txt": "y"}), "application/zip")},
        headers={"X-Team-Token": "team-a"},
    )
    assert r.status_code == 400
    assert "Dockerfile" in r.json()["detail"]


def test_health(client):
    assert client.get("/api/health").json() == {"ok": True}
