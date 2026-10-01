"""Pluggable authentication, plus per-submission visibility.

`Authenticator.authenticate(token) -> team` is the integration seam: swap in
your platform's SSO/session verifier by implementing it and returning it from
`build_authenticator()` for `SELFTEST_AUTH_MODE=sso` below. Two built-in
implementations ship for everything short of that:

- `token` (default): a bearer-style token identifies the team directly, via
  the `SELFTEST_TEAM_TOKENS` map. With no map configured, requests are
  rejected unless `SELFTEST_ALLOW_ANY_TOKEN=1`, in which case the token
  string itself is the team id — convenient for local dev, not for anything
  with real stakes.
- `hmac`: a signed, expiring token (`team.timestamp.signature`) keyed per
  team by `SELFTEST_TEAM_SECRETS`, for a bit more assurance than a static
  bearer token without standing up a full SSO integration. It is NOT
  replay-proof (no nonce store) — only a bounded validity window — so treat
  it as "slightly harder to shoulder-surf and replay forever", not a
  cryptographic session protocol.
- `github`: GitHub OAuth login (see server/app/oauth_github.py for the
  authorize/callback routes). Quota and ownership are keyed by the GitHub
  account's numeric id (stable; a login/username can be renamed) — the same
  identifier `actions/web/`'s NextAuth-based login uses for the same reason,
  so a participant's daily quota means the same thing on both channels even
  though the storage is separate (SQLite here, Vercel Blob there). The
  GitHub access token itself is used once, server-side, to fetch the
  profile, then discarded — it is never put in the session cookie issued to
  the browser.

The visibility rule (a submission's result is readable only by the team that
submitted it) is unrelated to which Authenticator is in use and stays as-is.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from typing import Protocol

from .config import Config

SESSION_COOKIE = "selftest_session"


class AuthError(Exception):
    pass


class VisibilityError(Exception):
    pass


class Authenticator(Protocol):
    def authenticate(self, token: str | None) -> str:
        """Return the team id for a request's token. Raises AuthError."""
        ...


class StaticTokenAuth:
    """Default: `SELFTEST_TEAM_TOKENS` map. With no map configured, requests
    are rejected unless `allow_any_token` is explicitly set — a server
    deployed without tokens configured should refuse requests, not silently
    trust any caller; `SELFTEST_ALLOW_ANY_TOKEN=1` opts into that passthrough
    for local dev."""

    def __init__(self, team_tokens: dict[str, str], allow_any_token: bool = False):
        self.team_tokens = team_tokens
        self.allow_any_token = allow_any_token

    def authenticate(self, token: str | None) -> str:
        if not token:
            raise AuthError("missing team token (X-Team-Token header)")
        if self.team_tokens:
            team = self.team_tokens.get(token)
            if team is None:
                raise AuthError("unknown team token")
            return team
        if not self.allow_any_token:
            raise AuthError("no team tokens configured on the server")
        # Dev mode (SELFTEST_ALLOW_ANY_TOKEN=1): the token string itself is the team id.
        return token


class HmacTokenAuth:
    """`X-Team-Token: <team>.<unix-timestamp>.<hex hmac-sha256>`, signed with
    that team's secret over `f"{team}.{timestamp}"`. Rejects a timestamp
    outside `max_skew_s` of the server clock either direction."""

    def __init__(self, team_secrets: dict[str, str], max_skew_s: int = 300):
        if not team_secrets:
            raise AuthError("SELFTEST_AUTH_MODE=hmac requires SELFTEST_TEAM_SECRETS")
        self.team_secrets = team_secrets
        self.max_skew_s = max_skew_s

    def authenticate(self, token: str | None) -> str:
        if not token:
            raise AuthError("missing team token (X-Team-Token header)")
        parts = token.split(".")
        if len(parts) != 3:
            raise AuthError("malformed token: expected team.timestamp.signature")
        team, raw_ts, signature = parts
        secret = self.team_secrets.get(team)
        if secret is None:
            raise AuthError("unknown team")
        try:
            timestamp = int(raw_ts)
        except ValueError:
            raise AuthError("malformed token: timestamp must be an integer") from None
        if abs(time.time() - timestamp) > self.max_skew_s:
            raise AuthError("token expired or timestamp out of range")
        expected = hmac.new(secret.encode(), f"{team}.{raw_ts}".encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, signature):
            raise AuthError("invalid signature")
        return team


def sign_session(secret: str, payload: dict) -> str:
    """Stdlib-only signed-cookie value: base64url(json(payload with iat)) +
    "." + hex hmac-sha256 over that base64 body. No separate crypto
    dependency for the same reason `common/` stays stdlib-only — this is a
    small, self-contained security primitive, easier to review inline than
    to trust a new transitive dependency for."""
    body_json = json.dumps({**payload, "iat": int(time.time())}, separators=(",", ":"))
    body = base64.urlsafe_b64encode(body_json.encode()).rstrip(b"=").decode()
    sig = hmac.new(secret.encode(), body.encode(), hashlib.sha256).hexdigest()
    return f"{body}.{sig}"


def verify_session(secret: str, cookie_value: str, max_age_s: int) -> dict | None:
    """Returns the payload dict if `cookie_value` is a valid, unexpired
    `sign_session()` output; None otherwise (never raises — a bad/missing
    cookie just means "not logged in")."""
    if not cookie_value or "." not in cookie_value:
        return None
    body, _, sig = cookie_value.rpartition(".")
    expected = hmac.new(secret.encode(), body.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, sig):
        return None
    try:
        padded = body + "=" * (-len(body) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded.encode()))
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(payload, dict) or time.time() - payload.get("iat", 0) > max_age_s:
        return None
    return payload


class GitHubCookieAuth:
    """Validates the signed session cookie `oauth_github.py`'s callback
    route issues after a successful GitHub login. `authenticate()` here
    takes the cookie *value*, not a bearer token — main.py passes whichever
    of the X-Team-Token header or the session cookie is present, and in
    `SELFTEST_AUTH_MODE=github` only the cookie will ever be set."""

    def __init__(self, session_secret: str, session_max_age_s: int):
        if not session_secret:
            raise AuthError("SELFTEST_AUTH_MODE=github requires SELFTEST_SESSION_SECRET")
        self.session_secret = session_secret
        self.session_max_age_s = session_max_age_s

    def authenticate(self, token: str | None) -> str:
        if not token:
            raise AuthError("not logged in (missing session cookie)")
        payload = verify_session(self.session_secret, token, self.session_max_age_s)
        if payload is None or "github_id" not in payload:
            raise AuthError("session expired or invalid, please log in again")
        return str(payload["github_id"])


def build_authenticator(cfg: Config) -> Authenticator:
    mode = cfg.auth_mode
    if mode == "token":
        return StaticTokenAuth(cfg.team_tokens, cfg.allow_any_token)
    if mode == "hmac":
        return HmacTokenAuth(cfg.team_secrets)
    if mode == "github":
        return GitHubCookieAuth(cfg.session_secret, cfg.session_max_age_s)
    if mode == "sso":
        raise SystemExit(
            "config: SELFTEST_AUTH_MODE=sso has no built-in implementation — "
            "implement Authenticator (see server/app/auth.py) against your "
            "platform's SSO/session verifier and return it here"
        )
    raise SystemExit(f"config: unknown SELFTEST_AUTH_MODE {mode!r} (expected token, hmac, github, or sso)")


def team_for_token(cfg: Config, token: str | None) -> str:
    """Back-compat shim for callers that haven't moved to build_authenticator()."""
    return StaticTokenAuth(cfg.team_tokens, cfg.allow_any_token).authenticate(token)


def assert_can_view(team: str, owner_team: str) -> None:
    if team != owner_team:
        raise VisibilityError("submission belongs to another team")
