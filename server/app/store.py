"""Persistence for submissions and results. Plain files + a small index in
SQLite; enough for a demo and easy to swap for the platform's database."""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from dataclasses import asdict
from pathlib import Path

from .runner import EvalResult


class Store:
    def __init__(self, data_dir: Path):
        self.data_dir = data_dir
        self.submissions_dir = data_dir / "submissions"
        self.results_dir = data_dir / "results"
        self.submissions_dir.mkdir(parents=True, exist_ok=True)
        self.results_dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._db = sqlite3.connect(data_dir / "selftest.db", check_same_thread=False)
        self._db.execute(
            "CREATE TABLE IF NOT EXISTS submissions ("
            "id TEXT PRIMARY KEY, team TEXT NOT NULL, status TEXT NOT NULL, "
            "created_at REAL NOT NULL, updated_at REAL NOT NULL)"
        )
        self._db.commit()

    def create(self, sub_id: str, team: str) -> None:
        now = time.time()
        with self._lock:
            self._db.execute(
                "INSERT INTO submissions (id, team, status, created_at, updated_at) VALUES (?, ?, 'queued', ?, ?)",
                (sub_id, team, now, now),
            )
            self._db.commit()

    def set_status(self, sub_id: str, status: str) -> None:
        with self._lock:
            self._db.execute(
                "UPDATE submissions SET status = ?, updated_at = ? WHERE id = ?",
                (status, time.time(), sub_id),
            )
            self._db.commit()

    def get(self, sub_id: str) -> dict | None:
        row = self._db.execute(
            "SELECT id, team, status, created_at, updated_at FROM submissions WHERE id = ?",
            (sub_id,),
        ).fetchone()
        if not row:
            return None
        return {"id": row[0], "team": row[1], "status": row[2], "created_at": row[3], "updated_at": row[4]}

    def list_for_team(self, team: str, limit: int = 20) -> list[dict]:
        rows = self._db.execute(
            "SELECT id, team, status, created_at, updated_at FROM submissions "
            "WHERE team = ? ORDER BY created_at DESC LIMIT ?",
            (team, limit),
        ).fetchall()
        return [
            {"id": r[0], "team": r[1], "status": r[2], "created_at": r[3], "updated_at": r[4]}
            for r in rows
        ]

    # ------------------------------------------------------------------ files
    def submission_dir(self, sub_id: str) -> Path:
        return self.submissions_dir / sub_id

    def result_dir(self, sub_id: str) -> Path:
        return self.results_dir / sub_id

    def save_result(self, sub_id: str, result: EvalResult) -> None:
        path = self.result_dir(sub_id) / "result.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = asdict(result)
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=1))

    def load_result(self, sub_id: str) -> dict | None:
        path = self.result_dir(sub_id) / "result.json"
        if not path.is_file():
            return None
        try:
            return json.loads(path.read_text())
        except (OSError, json.JSONDecodeError):
            return None
