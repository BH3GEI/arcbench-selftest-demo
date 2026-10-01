"""Persistence for submissions and results. Plain files + a small index in
SQLite; enough for a demo and easy to swap for the platform's database."""

from __future__ import annotations

import json
import logging
import shutil
import sqlite3
import threading
import time
from dataclasses import asdict
from pathlib import Path

from .runner import EvalResult

log = logging.getLogger("selftest.store")


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
            "id TEXT PRIMARY KEY, team TEXT NOT NULL, task_id TEXT NOT NULL, status TEXT NOT NULL, "
            "created_at REAL NOT NULL, updated_at REAL NOT NULL)"
        )
        self._db.commit()

    def create(self, sub_id: str, team: str, task_id: str) -> None:
        now = time.time()
        with self._lock:
            self._db.execute(
                "INSERT INTO submissions (id, team, task_id, status, created_at, updated_at) "
                "VALUES (?, ?, ?, 'queued', ?, ?)",
                (sub_id, team, task_id, now, now),
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
            "SELECT id, team, task_id, status, created_at, updated_at FROM submissions WHERE id = ?",
            (sub_id,),
        ).fetchone()
        if not row:
            return None
        return {"id": row[0], "team": row[1], "task_id": row[2], "status": row[3],
                "created_at": row[4], "updated_at": row[5]}

    def list_for_team(self, team: str, limit: int = 20) -> list[dict]:
        rows = self._db.execute(
            "SELECT id, team, task_id, status, created_at, updated_at FROM submissions "
            "WHERE team = ? ORDER BY created_at DESC LIMIT ?",
            (team, limit),
        ).fetchall()
        return [
            {"id": r[0], "team": r[1], "task_id": r[2], "status": r[3], "created_at": r[4], "updated_at": r[5]}
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

    # ------------------------------------------------------------------ retention
    def sweep_expired(self, retention_hours: int) -> int:
        """Delete finished submissions (zip, extracted source, results, logs)
        older than `retention_hours`, plus their DB rows. 0 disables this —
        callers should not invoke it at all in that case. Returns the count
        removed. Submissions still queued/building/running are never swept
        regardless of age."""
        if retention_hours <= 0:
            return 0
        cutoff = time.time() - retention_hours * 3600
        rows = self._db.execute(
            "SELECT id FROM submissions WHERE created_at < ? "
            "AND status NOT IN ('queued', 'building', 'running')",
            (cutoff,),
        ).fetchall()
        removed = 0
        for (sub_id,) in rows:
            shutil.rmtree(self.submission_dir(sub_id), ignore_errors=True)
            shutil.rmtree(self.result_dir(sub_id), ignore_errors=True)
            with self._lock:
                self._db.execute("DELETE FROM submissions WHERE id = ?", (sub_id,))
                self._db.commit()
            removed += 1
        if removed:
            log.info("retention sweep removed %d submission(s) older than %dh", removed, retention_hours)
        return removed
