#!/usr/bin/env python3
"""Turn a Playwright JSON report into the grader's result.json, applying the
task's visibility setting. Delegates the report-walking and visibility
filtering to the shared `common.resultshape` module — the same one
`server/app/runner.py` uses — so results look the same across both channels.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from common.resultshape import apply_visibility, walk_report


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

    result: dict = {
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
            tests = walk_report(report, results_dir=report_path.parent)
        except (OSError, json.JSONDecodeError) as exc:
            result["detail"] = f"report.json unreadable: {exc}"
            tests = []
        if tests:
            passed = sum(1 for t in tests if t["ok"])
            total = len(tests)
            result["passed"] = passed
            result["total"] = total
            result["status"] = "passed" if passed == total else "failed"
            result["detail"] = "" if passed == total else f"{total - passed}/{total} tests failed"
            result["tests"] = tests
        else:
            result["status"] = "error"
            result["detail"] = result["detail"] or "no tests collected"
    else:
        result["status"] = "error"

    result = apply_visibility(result, args.visibility,
                              always_keep=("submission_id", "task_id", "visibility", "detail"))
    Path(args.out).write_text(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
