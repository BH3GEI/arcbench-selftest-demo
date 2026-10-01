"""GitHub OAuth login (`SELFTEST_AUTH_MODE=github`): the three FastAPI routes
(`/auth/github/login`, `/auth/github/callback`, `/auth/logout`) mounted by
main.py, plus the stdlib-only calls to GitHub's OAuth endpoints.

Mirrors `actions/web/`'s NextAuth-based login (same identity key — the
GitHub numeric account id, not the login name, which can be renamed — same
default scope, same "never put the GitHub access token in the browser-facing
session" rule) without adopting NextAuth itself; see docs/parity.md for the
full comparison. No third-party HTTP client: GitHub's endpoints are called
with stdlib `urllib.request`, the same choice `cli/selftest.py` and
`common/` already made.
"""

from __future__ import annotations

import datetime
import json
import logging
import secrets
import urllib.error
import urllib.parse
import urllib.request

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import RedirectResponse

from .auth import SESSION_COOKIE, sign_session
from .config import Config

log = logging.getLogger("selftest.oauth")

AUTHORIZE_URL = "https://github.com/login/oauth/authorize"
TOKEN_URL = "https://github.com/login/oauth/access_token"
USER_URL = "https://api.github.com/user"
STATE_COOKIE = "selftest_oauth_state"
STATE_MAX_AGE_S = 600  # just long enough for the GitHub redirect round trip


def _require_configured(cfg: Config) -> None:
    if cfg.auth_mode != "github":
        raise HTTPException(status_code=400, detail="GitHub OAuth is not enabled on this server")
    if not cfg.github_client_id or not cfg.github_client_secret:
        raise HTTPException(status_code=500, detail="server misconfigured: GITHUB_OAUTH_CLIENT_ID/SECRET not set")
    if not cfg.session_secret:
        raise HTTPException(status_code=500, detail="server misconfigured: SELFTEST_SESSION_SECRET not set")
    if not cfg.oauth_callback_url:
        raise HTTPException(status_code=500, detail="server misconfigured: SELFTEST_OAUTH_CALLBACK_URL not set")


def _exchange_code(cfg: Config, code: str) -> str:
    """POST the authorization code for an access token. Returns the token;
    never persisted or returned to the browser past this function."""
    body = urllib.parse.urlencode({
        "client_id": cfg.github_client_id,
        "client_secret": cfg.github_client_secret,
        "code": code,
        "redirect_uri": cfg.oauth_callback_url,
    }).encode()
    req = urllib.request.Request(
        TOKEN_URL, data=body, method="POST",
        headers={"Accept": "application/json", "Content-Type": "application/x-www-form-urlencoded"},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            payload = json.loads(resp.read())
    except urllib.error.URLError as exc:
        raise HTTPException(status_code=502, detail=f"GitHub token exchange failed: {exc}") from exc
    token = payload.get("access_token")
    if not token:
        raise HTTPException(status_code=401, detail=payload.get("error_description") or "GitHub login failed")
    return token


def _fetch_user(access_token: str) -> dict:
    req = urllib.request.Request(USER_URL, headers={
        "Authorization": f"Bearer {access_token}",
        "Accept": "application/vnd.github+json",
        "User-Agent": "arcbench-selftest-demo",
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read())
    except urllib.error.URLError as exc:
        raise HTTPException(status_code=502, detail=f"GitHub profile fetch failed: {exc}") from exc


def _account_too_new(cfg: Config, created_at: str | None) -> bool:
    """Abuse resistance against disposable accounts. Fails open (does not
    block) when the age gate is disabled or GitHub didn't return a creation
    date, matching actions/web/'s accountTooNew()."""
    if cfg.min_account_age_days <= 0 or not created_at:
        return False
    try:
        created = datetime.datetime.fromisoformat(created_at.replace("Z", "+00:00"))
    except ValueError:
        return False
    age_days = (datetime.datetime.now(datetime.timezone.utc) - created).days
    return age_days < cfg.min_account_age_days


def build_router(cfg: Config) -> APIRouter:
    router = APIRouter()

    @router.get("/auth/github/login", include_in_schema=False)
    def login() -> RedirectResponse:
        _require_configured(cfg)
        state = secrets.token_urlsafe(24)
        params = urllib.parse.urlencode({
            "client_id": cfg.github_client_id,
            "redirect_uri": cfg.oauth_callback_url,
            "scope": "read:user",
            "state": state,
        })
        resp = RedirectResponse(f"{AUTHORIZE_URL}?{params}")
        resp.set_cookie(STATE_COOKIE, state, max_age=STATE_MAX_AGE_S, httponly=True,
                        samesite="lax", secure=cfg.force_https)
        return resp

    @router.get("/auth/github/callback", include_in_schema=False)
    def callback(request: Request, code: str | None = Query(default=None),
                state: str | None = Query(default=None)) -> RedirectResponse:
        _require_configured(cfg)
        expected_state = request.cookies.get(STATE_COOKIE)
        if not code or not state or not expected_state or not secrets.compare_digest(state, expected_state):
            raise HTTPException(status_code=400, detail="invalid or expired OAuth state")
        access_token = _exchange_code(cfg, code)
        profile = _fetch_user(access_token)
        github_id = profile.get("id")
        if github_id is None:
            raise HTTPException(status_code=502, detail="GitHub did not return an account id")
        if _account_too_new(cfg, profile.get("created_at")):
            raise HTTPException(status_code=403,
                                detail=f"GitHub account must be at least {cfg.min_account_age_days} days old")
        session_value = sign_session(cfg.session_secret, {
            "github_id": github_id,
            "github_login": profile.get("login"),
        })
        resp = RedirectResponse("/")
        resp.delete_cookie(STATE_COOKIE)
        resp.set_cookie(SESSION_COOKIE, session_value, max_age=cfg.session_max_age_s,
                        httponly=True, samesite="lax", secure=cfg.force_https, path="/")
        return resp

    @router.get("/auth/logout", include_in_schema=False)
    def logout() -> RedirectResponse:
        resp = RedirectResponse("/")
        resp.delete_cookie(SESSION_COOKIE, path="/")
        return resp

    return router
