"""Hardening checks: auth default, hidden visibility, artifact allowlist,
expanded-size cap."""

from __future__ import annotations

import io
import zipfile

import pytest
from fastapi.testclient import TestClient

from app.auth import AuthError, team_for_token
from app.config import Config
from app.jobs import JobService
from app.main import create_app
from app.quota import Quota
from app.runner import EvalResult, TestCaseResult
from app.store import Store
from app.validate import ValidationError, validate_zip

from test_api import VALID_ZIP, FakeEvaluator, submit, wait_done


def test_no_tokens_configured_rejects_by_default(tmp_path):
    cfg = Config(data_dir=tmp_path, allow_any_token=False)
    with pytest.raises(AuthError):
        team_for_token(cfg, "anything")


def test_dev_mode_needs_explicit_opt_in(tmp_path):
    cfg = Config(data_dir=tmp_path, allow_any_token=True)
    assert team_for_token(cfg, "team-x") == "team-x"


def _client(tmp_path, visibility="public"):
    cfg = Config(data_dir=tmp_path / "data", pack_dir=tmp_path / "pack",
                 visibility=visibility, allow_any_token=True).resolve()
    store = Store(cfg.data_dir)
    result = EvalResult(status="failed", passed=0, failed=1, total=1, pack_hash="h",
                        tests=[TestCaseResult(title="secret title", ok=False,
                                              error="expected 'secret'", screenshot="output/a/shot.png")],
                        app_log="app", runner_log="runner")
    service = JobService(cfg, store, Quota(cfg.data_dir / "quota.db", 10), FakeEvaluator(result))
    client = TestClient(create_app(cfg, service))
    sub_id = submit(client, VALID_ZIP).json()["id"]
    wait_done(client, sub_id)
    res = store.result_dir(sub_id)
    (res / "output" / "a").mkdir(parents=True)
    (res / "output" / "a" / "shot.png").write_bytes(b"\x89PNG")
    (res / "report.json").write_text("{}")
    return client, sub_id


def test_artifact_serves_only_listed_screenshots(tmp_path):
    client, sub_id = _client(tmp_path)
    h = {"X-Team-Token": "team-a"}
    ok = client.get(f"/api/submissions/{sub_id}/artifact", params={"path": "output/a/shot.png"}, headers=h)
    assert ok.status_code == 200
    assert ok.headers["x-content-type-options"] == "nosniff"
    for path in ("report.json", "result.json", "runner.log"):
        r = client.get(f"/api/submissions/{sub_id}/artifact", params={"path": path}, headers=h)
        assert r.status_code == 404


def test_hidden_visibility_returns_counts_only(tmp_path):
    client, sub_id = _client(tmp_path, visibility="hidden")
    h = {"X-Team-Token": "team-a"}
    body = client.get(f"/api/submissions/{sub_id}", headers=h).json()
    assert body["result"]["total"] == 1
    assert "secret" not in str(body)
    assert "tests" not in body["result"] and "runner_log" not in body["result"]
    assert client.get(f"/api/submissions/{sub_id}/logs/runner", headers=h).status_code == 404
    assert client.get(f"/api/submissions/{sub_id}/logs/app", headers=h).status_code == 404
    r = client.get(f"/api/submissions/{sub_id}/artifact", params={"path": "output/a/shot.png"}, headers=h)
    assert r.status_code == 404


def test_zip_bomb_rejected_by_expanded_size(tmp_path):
    path = tmp_path / "bomb.zip"
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("Dockerfile", "FROM scratch")
        zf.writestr("big.bin", b"\0" * (3 * 1024 * 1024))
    with pytest.raises(ValidationError, match="expands"):
        validate_zip(path, max_mb=1, max_files=10, max_unzipped_mb=2)
