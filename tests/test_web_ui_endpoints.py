"""The two read endpoints added for server/app/static's web UI (not part of
oauth_github.py's own login/callback/logout flow, see tests/test_oauth_github.py
for those): GET /api/me (who's signed in) and GET /api/tasks (the picker
list). Also covers server/app/tasks_web.py's filtering directly. See
docs/parity.md §7."""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from app.auth import SESSION_COOKIE, sign_session
from app.config import Config
from app.main import create_app
from app.tasks_web import is_task_listed, list_tasks, task_display_name


def make_task(tasks_dir: Path, task_id: str, visibility: str = "public") -> None:
    req_dir = tasks_dir / task_id / "requirements"
    req_dir.mkdir(parents=True)
    (req_dir / "requirements.yaml").write_text(f"visibility: {visibility}\n")
    (tasks_dir / task_id / "tests").mkdir()


def _github_cfg(tmp_path, **overrides) -> Config:
    kwargs = dict(
        data_dir=tmp_path / "data", tasks_dir=tmp_path / "tasks",
        auth_mode="github",
        github_client_id="client-id", github_client_secret="client-secret",
        oauth_callback_url="https://selftest.example.com/auth/github/callback",
        session_secret="s3cret",
    )
    kwargs.update(overrides)
    return Config(**kwargs).resolve()


def test_me_requires_session(tmp_path):
    client = TestClient(create_app(_github_cfg(tmp_path)))
    resp = client.get("/api/me")
    assert resp.status_code == 401
    assert resp.json() == {"error": "sign in required"}


def test_me_with_valid_session(tmp_path):
    cfg = _github_cfg(tmp_path)
    client = TestClient(create_app(cfg))
    client.cookies.set(SESSION_COOKIE, sign_session(cfg.session_secret, {"github_id": 42, "github_login": "octocat"}))
    resp = client.get("/api/me")
    assert resp.status_code == 200
    assert resp.json() == {"githubId": "42", "login": "octocat"}


def test_me_rejects_tampered_session(tmp_path):
    cfg = _github_cfg(tmp_path)
    client = TestClient(create_app(cfg))
    token = sign_session(cfg.session_secret, {"github_id": 42, "github_login": "octocat"})
    body, _, sig = token.rpartition(".")
    client.cookies.set(SESSION_COOKIE, body + "x." + sig)
    assert client.get("/api/me").status_code == 401


def test_tasks_requires_auth(tmp_path):
    client = TestClient(create_app(_github_cfg(tmp_path)))
    resp = client.get("/api/tasks")
    assert resp.status_code == 401


def test_tasks_lists_via_session_cookie(tmp_path):
    cfg = _github_cfg(tmp_path)
    make_task(cfg.tasks_dir, "github-stage-1-req-test")
    make_task(cfg.tasks_dir, "demo-todo")  # unlisted
    client = TestClient(create_app(cfg))
    client.cookies.set(SESSION_COOKIE, sign_session(cfg.session_secret, {"github_id": 1, "github_login": "a"}))
    resp = client.get("/api/tasks")
    assert resp.status_code == 200
    assert resp.json() == {"tasks": [{"id": "github-stage-1-req-test", "displayName": "GitHub 题 · 第一阶段"}]}


def test_tasks_also_works_with_team_token(tmp_path):
    # /api/tasks authenticates like every other endpoint: X-Team-Token or
    # cookie, either is enough — not GitHub-login-specific.
    cfg = Config(data_dir=tmp_path / "data", tasks_dir=tmp_path / "tasks",
                allow_any_token=True, auth_mode="token").resolve()
    make_task(cfg.tasks_dir, "t1")
    client = TestClient(create_app(cfg))
    resp = client.get("/api/tasks", headers={"X-Team-Token": "team-a"})
    assert resp.status_code == 200
    assert resp.json() == {"tasks": [{"id": "t1", "displayName": "t1"}]}


def test_list_tasks_filters_unlisted_and_invalid(tmp_path):
    tasks_dir = tmp_path / "tasks"
    make_task(tasks_dir, "demo-todo")
    make_task(tasks_dir, "demo-todo-hidden")
    make_task(tasks_dir, "github-stage-1-req-test")
    (tasks_dir / "not-a-task").mkdir()  # no requirements.yaml
    assert list_tasks(tasks_dir) == [{"id": "github-stage-1-req-test", "displayName": "GitHub 题 · 第一阶段"}]


def test_list_tasks_missing_dir_returns_empty():
    assert list_tasks(Path("/nonexistent/path/does/not/exist")) == []


def test_task_display_name_falls_back_to_id():
    assert task_display_name("some-unmapped-task") == "some-unmapped-task"
    assert is_task_listed("demo-todo") is False
    assert is_task_listed("some-unmapped-task") is True
