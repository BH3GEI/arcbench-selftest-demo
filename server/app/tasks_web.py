"""Task listing for the web UI's task picker — mirrors actions/web's
lib/taskVisibility.ts exactly (display names, which task ids are hidden from
the picker) so both channels show the same list. Keep the two in sync by
hand; there is no shared runtime between a Python server and a Next.js app
to enforce it automatically (see docs/parity.md §7)."""

from __future__ import annotations

from pathlib import Path

from common.taskspec import TaskError, load_task

# Keep in sync with actions/web/lib/taskVisibility.ts.
DISPLAY_NAMES: dict[str, str] = {
    "github-stage-1-req-test": "GitHub 题 · 第一阶段",
}
UNLISTED_TASK_IDS: frozenset[str] = frozenset({"demo-todo", "demo-todo-hidden"})


def task_display_name(task_id: str) -> str:
    return DISPLAY_NAMES.get(task_id, task_id)


def is_task_listed(task_id: str) -> bool:
    return task_id not in UNLISTED_TASK_IDS


def list_tasks(tasks_dir: Path) -> list[dict[str, str]]:
    """Every subdirectory of tasks_dir with a valid requirements.yaml,
    filtered the same way the picker page filters them, sorted by id for a
    stable order."""
    if not tasks_dir.is_dir():
        return []
    out: list[dict[str, str]] = []
    for entry in sorted(tasks_dir.iterdir(), key=lambda p: p.name):
        if not entry.is_dir() or not is_task_listed(entry.name):
            continue
        try:
            load_task(tasks_dir, entry.name)
        except TaskError:
            continue
        out.append({"id": entry.name, "displayName": task_display_name(entry.name)})
    return out
