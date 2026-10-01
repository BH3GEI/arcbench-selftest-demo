from datetime import date, timedelta

import pytest

from app.quota import Quota, QuotaExceeded


def test_consume_up_to_limit_then_rejected(tmp_path):
    q = Quota(tmp_path / "q.db", limit=2)
    assert q.try_consume("team-a") == 1
    assert q.try_consume("team-a") == 0
    with pytest.raises(QuotaExceeded):
        q.try_consume("team-a")


def test_teams_are_independent(tmp_path):
    q = Quota(tmp_path / "q.db", limit=1)
    q.try_consume("team-a")
    assert q.try_consume("team-b") == 0
    with pytest.raises(QuotaExceeded):
        q.try_consume("team-a")


def test_quota_resets_next_day(tmp_path):
    q = Quota(tmp_path / "q.db", limit=1)
    yesterday = (date.today() - timedelta(days=1)).isoformat()
    q.try_consume("team-a", today=yesterday)
    assert q.try_consume("team-a") == 0  # today is a fresh budget


def test_status_shape(tmp_path):
    q = Quota(tmp_path / "q.db", limit=10)
    q.try_consume("team-a")
    assert q.status("team-a") == {"team": "team-a", "limit": 10, "used": 1, "remaining": 9}
