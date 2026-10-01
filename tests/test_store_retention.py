import time

from app.store import Store


def make_submission(store: Store, sub_id: str, team: str, status: str, age_hours: float) -> None:
    store.create(sub_id, team, "t1")
    store.submission_dir(sub_id).mkdir(parents=True, exist_ok=True)
    (store.submission_dir(sub_id) / "app.zip").write_bytes(b"x")
    store.result_dir(sub_id).mkdir(parents=True, exist_ok=True)
    (store.result_dir(sub_id) / "result.json").write_text("{}")
    created_at = time.time() - age_hours * 3600
    with store._lock:
        store._db.execute(
            "UPDATE submissions SET status = ?, created_at = ? WHERE id = ?",
            (status, created_at, sub_id),
        )
        store._db.commit()


def test_sweep_removes_old_finished_submissions(tmp_path):
    store = Store(tmp_path)
    make_submission(store, "old-done", "team-a", "done", age_hours=48)
    removed = store.sweep_expired(retention_hours=24)
    assert removed == 1
    assert store.get("old-done") is None
    assert not store.submission_dir("old-done").exists()
    assert not store.result_dir("old-done").exists()


def test_sweep_keeps_recent_submissions(tmp_path):
    store = Store(tmp_path)
    make_submission(store, "recent-done", "team-a", "done", age_hours=1)
    removed = store.sweep_expired(retention_hours=24)
    assert removed == 0
    assert store.get("recent-done") is not None


def test_sweep_never_removes_in_flight_submissions(tmp_path):
    store = Store(tmp_path)
    make_submission(store, "old-running", "team-a", "running", age_hours=999)
    removed = store.sweep_expired(retention_hours=24)
    assert removed == 0
    assert store.get("old-running") is not None


def test_sweep_disabled_when_zero(tmp_path):
    store = Store(tmp_path)
    make_submission(store, "old-done", "team-a", "done", age_hours=999)
    assert store.sweep_expired(retention_hours=0) == 0
    assert store.get("old-done") is not None
