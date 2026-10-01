"""Team tokens and per-submission visibility.

Demo-grade auth: a bearer-style token identifies the team. Platform
integration should replace `team_for_token` with their SSO/session mapping;
the visibility rule (results readable only by the submitting team) stays.
"""

from __future__ import annotations

from .config import Config


class AuthError(Exception):
    pass


class VisibilityError(Exception):
    pass


def team_for_token(cfg: Config, token: str | None) -> str:
    if not token:
        raise AuthError("missing team token (X-Team-Token header)")
    if cfg.team_tokens:
        team = cfg.team_tokens.get(token)
        if team is None:
            raise AuthError("unknown team token")
        return team
    if not cfg.allow_any_token:
        raise AuthError("no team tokens configured on the server")
    # Dev mode (SELFTEST_ALLOW_ANY_TOKEN=1): the token string itself is the team id.
    return token


def assert_can_view(team: str, owner_team: str) -> None:
    if team != owner_team:
        raise VisibilityError("submission belongs to another team")
