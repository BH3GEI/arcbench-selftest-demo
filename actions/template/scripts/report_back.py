#!/usr/bin/env python3
"""Deliver the graded result to the submitter — never by leaving it in the
public Actions log. Two delivery modes:

  - CALLBACK_URL set: POST result.json there (Authorization: Bearer
    CALLBACK_TOKEN if given). This is the integration point for the self-test
    service once it exposes a results-intake endpoint.
  - otherwise: publish a GitHub Release in *this* (private) grader repo,
    tagged with the submission id, with result.json as the only asset. The
    self-test service (or a human with repo access) reads it back out; the
    Actions run log itself is never the channel players see.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.error
import urllib.request


def main() -> int:
    result_path = os.environ.get("RESULT_FILE", "results/result.json")
    if not os.path.isfile(result_path):
        print(f"[report_back] no result file at {result_path}, nothing to send", file=sys.stderr)
        return 1

    with open(result_path, "rb") as f:
        body = f.read()
    result = json.loads(body)
    submission_id = result.get("submission_id", "unknown")

    callback_url = os.environ.get("CALLBACK_URL", "").strip()
    if callback_url:
        req = urllib.request.Request(callback_url, data=body, method="POST")
        req.add_header("Content-Type", "application/json")
        token = os.environ.get("CALLBACK_TOKEN", "").strip()
        if token:
            req.add_header("Authorization", f"Bearer {token}")
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                print(f"[report_back] callback POST -> HTTP {resp.status}")
            return 0
        except urllib.error.URLError as exc:
            print(f"[report_back] callback POST failed: {exc}", file=sys.stderr)
            return 1

    tag = f"result-{submission_id}"
    summary = f"status={result.get('status')} passed={result.get('passed')}/{result.get('total')}"
    subprocess.run(["gh", "release", "delete", tag, "--yes"], check=False,
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    r = subprocess.run(
        ["gh", "release", "create", tag, result_path,
         "--title", f"Result {submission_id}",
         "--notes", summary],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        print(f"[report_back] gh release create failed: {r.stderr}", file=sys.stderr)
        return 1
    print(f"[report_back] published release {tag}: {r.stdout.strip()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
