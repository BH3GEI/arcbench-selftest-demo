"""Per-team daily submission quota, backed by SQLite."""

from __future__ import annotations

import sqlite3
import threading
from datetime import date
from pathlib import Path


class QuotaExceeded(Exception):
    def __init__(self, team: str, limit: int):
        super().__init__(f"team {team!r} reached the daily limit of {limit} submissions")
        self.team = team
        self.limit = limit


class Quota:
    def __init__(self, db_path: Path, limit: int):
        self.limit = limit
        self._lock = threading.Lock()
        self._db = sqlite3.connect(db_path, check_same_thread=False)
        self._db.execute(
            "CREATE TABLE IF NOT EXISTS usage (team TEXT NOT NULL, day TEXT NOT NULL, "
            "count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (team, day))"
        )
        self._db.commit()

    def _today(self) -> str:
        return date.today().isoformat()

    def used_today(self, team: str, today: str | None = None) -> int:
        row = self._db.execute(
            "SELECT count FROM usage WHERE team = ? AND day = ?", (team, today or self._today())
        ).fetchone()
        return int(row[0]) if row else 0

    def try_consume(self, team: str, today: str | None = None) -> int:
        """Count one accepted submission. Returns remaining quota afterwards."""
        with self._lock:
            day = today or self._today()
            used = self.used_today(team, day)
            if used >= self.limit:
                raise QuotaExceeded(team, self.limit)
            self._db.execute(
                "INSERT INTO usage (team, day, count) VALUES (?, ?, 1) "
                "ON CONFLICT (team, day) DO UPDATE SET count = count + 1",
                (team, day),
            )
            self._db.commit()
            return self.limit - used - 1

    def status(self, team: str) -> dict:
        used = self.used_today(team)
        return {"team": team, "limit": self.limit, "used": used, "remaining": max(0, self.limit - used)}
