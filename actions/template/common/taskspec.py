"""Task definitions shared by both grading channels. A task is a directory
`<tasks_dir>/<task_id>/` holding `requirements/requirements.yaml` (flat
`key: value`, parsed without a YAML library so this stays stdlib-only and
usable from a bare `python3` on either channel) and a `tests/` directory of
Playwright specs. Same shape arcbench already uses, so a task folder can be
copied in as-is.
"""
from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path

VISIBILITIES = ("public", "hidden")


class TaskError(Exception):
    pass


@dataclass(frozen=True)
class TaskSpec:
    task_id: str
    visibility: str
    app_port: int
    build_timeout_s: int
    ready_timeout_s: int
    run_timeout_s: int
    tests_dir: Path


def parse_flat_yaml(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in path.read_text().splitlines():
        line = line.split("#", 1)[0].strip()
        if not line or ":" not in line:
            continue
        key, _, value = line.partition(":")
        values[key.strip()] = value.strip()
    return values


def load_task(tasks_dir: Path, task_id: str) -> TaskSpec:
    task_dir = Path(tasks_dir) / task_id
    req_file = task_dir / "requirements" / "requirements.yaml"
    if not req_file.is_file():
        raise TaskError(f"unknown task_id: {task_id}")
    raw = parse_flat_yaml(req_file)

    visibility = raw.get("visibility", "public")
    if visibility not in VISIBILITIES:
        raise TaskError(f"task {task_id}: visibility must be public or hidden, got {visibility!r}")

    def _int(key: str, default: int) -> int:
        value = raw.get(key)
        if value in (None, ""):
            return default
        try:
            return int(value)
        except ValueError:
            raise TaskError(f"task {task_id}: {key} must be an integer, got {value!r}") from None

    tests_dir = task_dir / "tests"
    if not tests_dir.is_dir():
        raise TaskError(f"task {task_id}: no tests/ directory")

    return TaskSpec(
        task_id=task_id,
        visibility=visibility,
        app_port=_int("app_port", 3000),
        build_timeout_s=_int("build_timeout_s", 600),
        ready_timeout_s=_int("ready_timeout_s", 60),
        run_timeout_s=_int("run_timeout_s", 900),
        tests_dir=tests_dir,
    )


def _main(argv: list[str]) -> int:
    """`python3 -m common.taskspec <tasks_dir> <task_id>` prints the task's
    fields as shell-safe `KEY=value` lines, for scripts/grade.sh to `eval`."""
    if len(argv) != 2:
        print("usage: taskspec.py <tasks_dir> <task_id>", file=sys.stderr)
        return 2
    try:
        task = load_task(Path(argv[0]), argv[1])
    except TaskError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print(f"VISIBILITY={task.visibility}")
    print(f"APP_PORT={task.app_port}")
    print(f"BUILD_TIMEOUT_S={task.build_timeout_s}")
    print(f"READY_TIMEOUT_S={task.ready_timeout_s}")
    print(f"RUN_TIMEOUT_S={task.run_timeout_s}")
    print(f"TESTS_DIR={task.tests_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
