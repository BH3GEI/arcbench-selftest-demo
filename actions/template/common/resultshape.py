"""Playwright JSON report -> structured per-test results, plus the shared
visibility filter. `server/app/runner.py` (local docker-compose server) and
`scripts/parse_report.py` (GitHub Actions grader) both delegate here so two
channels produce the same result shape for the same report.json and the
same task visibility.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

ANSI = re.compile(r"\x1b\[[0-9;]*m")


def walk_report(report: dict, results_dir: Path | None = None) -> list[dict[str, Any]]:
    """Flatten Playwright's suite/spec tree into per-test dicts:
    {title, ok, error, screenshot}. `error` is ANSI-stripped and capped at
    2000 chars; both `error`/`screenshot` are None on a passing test.
    `screenshot` is a path relative to `results_dir` when given, else the
    bare filename."""
    tests: list[dict[str, Any]] = []

    def rel(path: str | None) -> str | None:
        if not path:
            return None
        if results_dir is None:
            return Path(path).name
        # Attachments carry the *container* path as seen by the Playwright
        # runner (whose /results is this results_dir bind-mounted elsewhere),
        # not a path resolvable from wherever this code happens to run —
        # strip the known mount prefix instead of trying to resolve() across
        # mounts (both runner/playwright.config.js and the Actions template's
        # use outputDir '/results/output').
        if path.startswith("/results/"):
            return path[len("/results/"):]
        try:
            return str(Path(path).resolve().relative_to(results_dir.resolve()))
        except ValueError:
            return Path(path).name

    def _walk(suite: dict, prefix: str) -> None:
        title = f"{prefix} {suite.get('title', '')}".strip()
        for spec in suite.get("specs", []):
            name = f"{title} {spec.get('title', '')}".strip()
            ran = [r for t in spec.get("tests", []) for r in t.get("results", []) if r]
            ok = bool(ran) and all(r.get("status") in ("passed", "expected") for r in ran) \
                and spec.get("ok", True)
            error: str | None = None
            screenshot: str | None = None
            if not ok:
                for r in ran:
                    err = (r.get("error") or {}).get("message")
                    if err and error is None:
                        error = ANSI.sub("", err).strip()[:2000]
                    for att in r.get("attachments", []):
                        if att.get("contentType", "").startswith("image/") and screenshot is None:
                            screenshot = rel(att.get("path"))
            tests.append({"title": name, "ok": ok, "error": error, "screenshot": screenshot})
        for child in suite.get("suites", []):
            _walk(child, title)

    for suite in report.get("suites", []):
        _walk(suite, "")
    return tests


def apply_visibility(result: dict[str, Any], visibility: str, *,
                     always_keep: tuple[str, ...] = ()) -> dict[str, Any]:
    """`hidden` reduces `result` to status/passed/total plus any caller-named
    metadata fields (`always_keep`) — no test titles, no error text, no
    screenshots. `public` (or anything else) returns `result` unchanged."""
    if visibility != "hidden":
        return result
    keep = {"status", "passed", "total", *always_keep}
    return {k: v for k, v in result.items() if k in keep}
