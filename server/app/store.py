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
        # The api/worker split (docs/security-review.md open item #1) has two
        # separate OS processes sharing this file; give SQLite's own file
        # locking a few seconds to resolve a writer collision instead of
        # raising "database is locked" immediately.
        self._db.execute("PRAGMA busy_timeout = 5000")
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

    def count_active(self) -> int:
        """Submissions not yet in a terminal state — queued, building, or
        running — across however many processes share this store (the
        api/worker split means that's not just this process's own count)."""
        row = self._db.execute(
            "SELECT COUNT(*) FROM submissions WHERE status IN ('queued', 'building', 'running')"
        ).fetchone()
        return row[0]

    def claim_next_queued(self) -> tuple[str, str] | None:
        """Atomically take the oldest queued submission (id, task_id), or
        None if there isn't one. For the standalone worker process
        (server/app/worker.py); safe if multiple worker processes call this
        against the same SQLite file — the UPDATE's WHERE guard means only
        one of them actually claims a given row, SQLite's own file locking
        serializes the race."""
        with self._lock:
            row = self._db.execute(
                "SELECT id, task_id FROM submissions WHERE status = 'queued' ORDER BY created_at LIMIT 1"
            ).fetchone()
            if not row:
                return None
            sub_id, task_id = row
            cur = self._db.execute(
                "UPDATE submissions SET status = 'building', updated_at = ? WHERE id = ? AND status = 'queued'",
                (time.time(), sub_id),
            )
            self._db.commit()
            if cur.rowcount == 0:
                return None  # another worker claimed it first
            return sub_id, task_id

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
