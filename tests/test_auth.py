import hashlib
import hmac
import time

import pytest

from app.auth import AuthError, HmacTokenAuth, StaticTokenAuth, build_authenticator
from app.config import Config


def test_static_token_auth_known_token():
    auth = StaticTokenAuth({"tok-a": "team-a"})
    assert auth.authenticate("tok-a") == "team-a"


def test_static_token_auth_unknown_token_rejected():
    auth = StaticTokenAuth({"tok-a": "team-a"})
    with pytest.raises(AuthError):
        auth.authenticate("nope")


def test_static_token_auth_dev_mode_passthrough():
    auth = StaticTokenAuth({})
    assert auth.authenticate("whatever-team") == "whatever-team"


def test_static_token_auth_missing_token_rejected():
    with pytest.raises(AuthError):
        StaticTokenAuth({}).authenticate(None)


def _sign(secret: str, team: str, ts: int) -> str:
    sig = hmac.new(secret.encode(), f"{team}.{ts}".encode(), hashlib.sha256).hexdigest()
    return f"{team}.{ts}.{sig}"


def test_hmac_auth_accepts_valid_signature():
    auth = HmacTokenAuth({"team-a": "s3cret"})
    token = _sign("s3cret", "team-a", int(time.time()))
    assert auth.authenticate(token) == "team-a"


def test_hmac_auth_rejects_bad_signature():
    auth = HmacTokenAuth({"team-a": "s3cret"})
    token = f"team-a.{int(time.time())}.deadbeef"
    with pytest.raises(AuthError):
        auth.authenticate(token)


def test_hmac_auth_rejects_expired_timestamp():
    auth = HmacTokenAuth({"team-a": "s3cret"}, max_skew_s=60)
    token = _sign("s3cret", "team-a", int(time.time()) - 3600)
    with pytest.raises(AuthError):
        auth.authenticate(token)


def test_hmac_auth_rejects_unknown_team():
    auth = HmacTokenAuth({"team-a": "s3cret"})
    token = _sign("s3cret", "team-b", int(time.time()))
    with pytest.raises(AuthError):
        auth.authenticate(token)


def test_hmac_auth_rejects_malformed_token():
    auth = HmacTokenAuth({"team-a": "s3cret"})
    with pytest.raises(AuthError):
        auth.authenticate("not-three-parts")


def test_build_authenticator_token_mode():
    cfg = Config(auth_mode="token", team_tokens={"tok-a": "team-a"})
    auth = build_authenticator(cfg)
    assert isinstance(auth, StaticTokenAuth)


def test_build_authenticator_hmac_mode():
    cfg = Config(auth_mode="hmac", team_secrets={"team-a": "s3cret"})
    auth = build_authenticator(cfg)
    assert isinstance(auth, HmacTokenAuth)


def test_build_authenticator_hmac_mode_without_secrets_fails():
    cfg = Config(auth_mode="hmac", team_secrets={})
    with pytest.raises(AuthError):
        build_authenticator(cfg)


def test_build_authenticator_unknown_mode_fails():
    cfg = Config(auth_mode="carrier-pigeon")
    with pytest.raises(SystemExit):
        build_authenticator(cfg)


def test_build_authenticator_sso_mode_is_a_stub():
    cfg = Config(auth_mode="sso")
    with pytest.raises(SystemExit):
        build_authenticator(cfg)
