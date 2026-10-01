#!/usr/bin/env python3
"""Turn a Playwright JSON report into the grader's result.json, applying the
task's visibility setting. For visibility: hidden, only a pass/total count
survives — no test titles, no error text, no screenshot paths.

The suite-walking logic mirrors server/app/runner.py::parse_playwright_report
in the local demo so results look the same across both channels.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ANSI = re.compile(r"\x1b\[[0-9;]*m")


def walk(report: dict) -> list[dict]:
    tests: list[dict] = []

    def _walk(suite: dict, prefix: str) -> None:
        title = f"{prefix} {suite.get('title', '')}".strip()
        for spec in suite.get("specs", []):
            name = f"{title} {spec.get('title', '')}".strip()
            ran = [t for t in spec.get("tests", []) if t.get("results")]
            ok = bool(ran) and all(t.get("status") in ("passed", "expected") for t in ran) \
                and spec.get("ok", True)
            error = None
            if not ok:
                for t in ran:
                    for res in t.get("results", []):
                        err = (res.get("error") or {}).get("message")
                        if err and error is None:
                            error = ANSI.sub("", err).strip()[:2000]
            tests.append({"title": name, "ok": ok, "error": error})
        for child in suite.get("suites", []):
            _walk(child, title)

    for suite in report.get("suites", []):
        _walk(suite, "")
    return tests


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--submission-id", required=True)
    ap.add_argument("--task-id", required=True)
    ap.add_argument("--visibility", default="public", choices=["public", "hidden"])
    ap.add_argument("--status", default="error")
    ap.add_argument("--detail", default="")
    ap.add_argument("--report", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    result = {
        "submission_id": args.submission_id,
        "task_id": args.task_id,
        "visibility": args.visibility,
        "status": "error",
        "passed": 0,
        "total": 0,
        "detail": args.detail,
    }

    report_path = Path(args.report)
    if args.status == "scored" and report_path.is_file():
        try:
            report = json.loads(report_path.read_text())
            tests = walk(report)
        except (OSError, json.JSONDecodeError) as exc:
            result["detail"] = f"report.json unreadable: {exc}"
            tests = []
        if tests:
            passed = sum(1 for t in tests if t["ok"])
            result["passed"] = passed
            result["total"] = len(tests)
            result["status"] = "passed" if passed == len(tests) else "failed"
            result["detail"] = "" if passed == len(tests) else f"{len(tests) - passed}/{len(tests)} tests failed"
            if args.visibility == "public":
                result["tests"] = tests
            # hidden: passed/total only, no per-test detail at all.
        else:
            result["status"] = "error"
            result["detail"] = result["detail"] or "no tests collected"
    else:
        result["status"] = "error"

    Path(args.out).write_text(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
