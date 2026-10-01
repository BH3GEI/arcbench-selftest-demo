"""GitHub OAuth login: session cookie signing, the Authenticator that
validates it, and the login/callback/logout routes end to end (GitHub's own
HTTP calls are monkeypatched — these tests never hit the network)."""

from __future__ import annotations

import datetime
import time

import pytest
from fastapi.testclient import TestClient

from app import oauth_github
from app.auth import AuthError, GitHubCookieAuth, SESSION_COOKIE, sign_session, verify_session
from app.config import Config
from app.main import create_app


def test_sign_verify_round_trip():
    token = sign_session("s3cret", {"github_id": 42, "github_login": "octocat"})
    payload = verify_session("s3cret", token, max_age_s=3600)
    assert payload["github_id"] == 42
    assert payload["github_login"] == "octocat"


def test_verify_rejects_tampered_cookie():
    token = sign_session("s3cret", {"github_id": 42})
    body, _, sig = token.rpartition(".")
    tampered = body + "x." + sig
    assert verify_session("s3cret", tampered, max_age_s=3600) is None


def test_verify_rejects_wrong_secret():
    token = sign_session("s3cret", {"github_id": 42})
    assert verify_session("different-secret", token, max_age_s=3600) is None


def test_verify_rejects_expired_cookie():
    token = sign_session("s3cret", {"github_id": 42})
    assert verify_session("s3cret", token, max_age_s=0) is None


def test_github_cookie_auth_valid_session():
    token = sign_session("s3cret", {"github_id": 123456, "github_login": "octocat"})
    auth = GitHubCookieAuth("s3cret", session_max_age_s=3600)
    assert auth.authenticate(token) == "123456"


def test_github_cookie_auth_rejects_missing_cookie():
    auth = GitHubCookieAuth("s3cret", session_max_age_s=3600)
    with pytest.raises(AuthError):
        auth.authenticate(None)


def test_github_cookie_auth_rejects_invalid_cookie():
    auth = GitHubCookieAuth("s3cret", session_max_age_s=3600)
    with pytest.raises(AuthError):
        auth.authenticate("garbage")


def test_github_cookie_auth_requires_session_secret():
    with pytest.raises(AuthError):
        GitHubCookieAuth("", session_max_age_s=3600)


def _github_cfg(tmp_path, **overrides) -> Config:
    kwargs = dict(
        data_dir=tmp_path / "data", tasks_dir=tmp_path / "tasks",
        auth_mode="github",
        github_client_id="client-id", github_client_secret="client-secret",
        oauth_callback_url="https://selftest.example.com/auth/github/callback",
        session_secret="s3cret",
        min_account_age_days=7,
    )
    kwargs.update(overrides)
    return Config(**kwargs).resolve()


def test_login_redirects_to_github_with_state_cookie(tmp_path):
    cfg = _github_cfg(tmp_path)
    client = TestClient(create_app(cfg), follow_redirects=False)
    resp = client.get("/auth/github/login")
    assert resp.status_code in (302, 307)
    assert resp.headers["location"].startswith("https://github.com/login/oauth/authorize?")
    assert "client_id=client-id" in resp.headers["location"]
    assert oauth_github.STATE_COOKIE in resp.cookies


def test_callback_rejects_bad_state(tmp_path):
    cfg = _github_cfg(tmp_path)
    client = TestClient(create_app(cfg), follow_redirects=False)
    client.cookies.set(oauth_github.STATE_COOKIE, "expected-state")
    resp = client.get("/auth/github/callback", params={"code": "abc", "state": "wrong-state"})
    assert resp.status_code == 400


def test_callback_success_sets_session_cookie(tmp_path, monkeypatch):
    cfg = _github_cfg(tmp_path)
    monkeypatch.setattr(oauth_github, "_exchange_code", lambda cfg, code: "gh-access-token")
    monkeypatch.setattr(oauth_github, "_fetch_user", lambda token: {
        "id": 999, "login": "octocat",
        "created_at": "2010-01-01T00:00:00Z",
    })
    client = TestClient(create_app(cfg), follow_redirects=False)
    client.cookies.set(oauth_github.STATE_COOKIE, "the-state")
    resp = client.get("/auth/github/callback", params={"code": "abc", "state": "the-state"})
    assert resp.status_code in (302, 307)
    assert SESSION_COOKIE in resp.cookies

    # The issued session authenticates subsequent requests as github id 999.
    quota_resp = client.get("/api/quota")
    assert quota_resp.status_code == 200
    assert quota_resp.json()["team"] == "999"


def test_callback_rejects_too_new_account(tmp_path, monkeypatch):
    cfg = _github_cfg(tmp_path, min_account_age_days=7)
    recent = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=1)).isoformat()
    monkeypatch.setattr(oauth_github, "_exchange_code", lambda cfg, code: "gh-access-token")
    monkeypatch.setattr(oauth_github, "_fetch_user", lambda token: {"id": 1, "login": "new", "created_at": recent})
    client = TestClient(create_app(cfg), follow_redirects=False)
    client.cookies.set(oauth_github.STATE_COOKIE, "the-state")
    resp = client.get("/auth/github/callback", params={"code": "abc", "state": "the-state"})
    assert resp.status_code == 403


def test_callback_fails_open_on_missing_created_at(tmp_path, monkeypatch):
    cfg = _github_cfg(tmp_path, min_account_age_days=7)
    monkeypatch.setattr(oauth_github, "_exchange_code", lambda cfg, code: "gh-access-token")
    monkeypatch.setattr(oauth_github, "_fetch_user", lambda token: {"id": 1, "login": "unknown-age"})
    client = TestClient(create_app(cfg), follow_redirects=False)
    client.cookies.set(oauth_github.STATE_COOKIE, "the-state")
    resp = client.get("/auth/github/callback", params={"code": "abc", "state": "the-state"})
    assert resp.status_code in (302, 307)


def test_logout_clears_session_cookie(tmp_path):
    cfg = _github_cfg(tmp_path)
    client = TestClient(create_app(cfg), follow_redirects=False)
    resp = client.get("/auth/logout")
    assert resp.status_code in (302, 307)
    # Expired/deleted cookie: either absent or an empty value.
    assert resp.cookies.get(SESSION_COOKIE) in (None, "")


def test_oauth_routes_not_registered_outside_github_mode(tmp_path):
    cfg = Config(data_dir=tmp_path / "data", tasks_dir=tmp_path / "tasks", auth_mode="token").resolve()
    client = TestClient(create_app(cfg))
    resp = client.get("/auth/github/login")
    assert resp.status_code == 404
