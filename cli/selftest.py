#!/usr/bin/env python3
"""selftest: CLI for the arcbench self-test demo. Standard library only.

usage:
  selftest.py submit ./my-app --task TASK_ID [--wait]  # zip a directory and submit it
  selftest.py submit app.zip --task TASK_ID [--wait]   # or a ready-made zip
  selftest.py result SUBMISSION_ID
  selftest.py log SUBMISSION_ID [--kind app|runner]
  selftest.py quota

exit codes (submit --wait / result): 0 = all tests passed, 1 = not passed or
request failed, 2 = local wait deadline expired.
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
import zipfile
from pathlib import Path

DEFAULT_SERVER = "http://127.0.0.1:8080"


class ApiError(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(f"HTTP {status}: {detail}")
        self.status = status
        self.detail = detail


def request(args, method: str, path: str, body: bytes | None = None,
            content_type: str | None = None) -> dict:
    req = urllib.request.Request(args.server + path, method=method, data=body)
    req.add_header("X-Team-Token", args.token)
    if content_type:
        req.add_header("Content-Type", content_type)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        try:
            detail = json.loads(detail).get("detail", detail)
        except json.JSONDecodeError:
            pass
        raise ApiError(exc.code, str(detail))
    except urllib.error.URLError as exc:
        raise ApiError(0, f"cannot reach {args.server}: {exc.reason}")
    return json.loads(raw) if raw else {}


def zip_dir(src: Path) -> bytes:
    with tempfile.NamedTemporaryFile(suffix=".zip", delete=False) as tmp:
        tmp_path = Path(tmp.name)
    try:
        with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for path in sorted(src.rglob("*")):
                if path.is_file():
                    zf.write(path, path.relative_to(src).as_posix())
        return tmp_path.read_bytes()
    finally:
        tmp_path.unlink(missing_ok=True)


def multipart(filename: str, data: bytes, fields: dict[str, str]) -> tuple[bytes, str]:
    """Build a multipart/form-data body: each `fields` entry as a plain form
    field, plus `data` as the "file" part."""
    boundary = f"----selftest-{uuid.uuid4().hex}"
    chunks = []
    for name, value in fields.items():
        chunks.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
        )
    chunks.append(
        (f"--{boundary}\r\n"
         f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
         f"Content-Type: application/zip\r\n\r\n").encode() + data + b"\r\n"
    )
    chunks.append(f"--{boundary}--\r\n".encode())
    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


def print_result(record: dict) -> None:
    status = record.get("status")
    result = record.get("result")
    print(f"{record['id']}  status={status}")
    if not result:
        return
    print(f"pack={result.get('pack_hash', '')[:16]}  "
          f"passed={result.get('passed')}/{result.get('total')}  "
          f"pass_rate={result.get('pass_rate')}%  duration={result.get('duration_s')}s")
    if result.get("detail"):
        print(f"detail: {result['detail']}")
    for t in result.get("tests", []):
        mark = "PASS" if t.get("ok") else "FAIL"
        print(f"  {mark}  {t.get('title')}")
        if not t.get("ok"):
            if t.get("error"):
                first = str(t["error"]).splitlines()[0][:200]
                print(f"        error: {first}")
            if t.get("screenshot"):
                print(f"        screenshot: {t['screenshot']}")


def cmd_submit(args) -> int:
    src = Path(args.path)
    if src.is_dir():
        if not (src / "Dockerfile").is_file():
            print(f"error: {src} has no Dockerfile at its root", file=sys.stderr)
            return 1
        data = zip_dir(src)
        filename = src.name + ".zip"
    elif src.is_file():
        data = src.read_bytes()
        filename = src.name
    else:
        print(f"error: {src} not found", file=sys.stderr)
        return 1
    body, content_type = multipart(filename, data, {"task_id": args.task})
    try:
        record = request(args, "POST", "/api/submissions", body, content_type)
    except ApiError as exc:
        print(f"submit failed: {exc}", file=sys.stderr)
        return 1
    sub_id = record["id"]
    print(f"submitted {sub_id} (status=queued)")
    if not args.wait:
        return 0
    deadline = time.monotonic() + args.wait_timeout
    while time.monotonic() < deadline:
        time.sleep(2)
        record = request(args, "GET", f"/api/submissions/{sub_id}")
        if record["status"] in ("done", "failed", "error"):
            print_result(record)
            return 0 if record["status"] == "done" else 1
    print(f"wait deadline expired; submission {sub_id} still running", file=sys.stderr)
    return 2


def cmd_result(args) -> int:
    record = request(args, "GET", f"/api/submissions/{args.id}")
    print_result(record)
    status = record.get("status")
    if status == "done":
        return 0
    return 1 if status in ("failed", "error") else 2


def cmd_log(args) -> int:
    req = urllib.request.Request(f"{args.server}/api/submissions/{args.id}/logs/{args.kind}")
    req.add_header("X-Team-Token", args.token)
    with urllib.request.urlopen(req, timeout=30) as resp:
        sys.stdout.write(resp.read().decode("utf-8", errors="replace"))
    return 0


def cmd_quota(args) -> int:
    record = request(args, "GET", "/api/quota")
    print(f"team={record['team']}  used={record['used']}/{record['limit']}  remaining={record['remaining']}")
    return 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="selftest", description=__doc__)
    parser.add_argument("--server", default=DEFAULT_SERVER)
    parser.add_argument("--token", default="demo-token", help="team token (default: demo-token)")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("submit", help="submit an app directory or zip")
    p.add_argument("path")
    p.add_argument("--task", required=True, help="task id, e.g. demo-todo")
    p.add_argument("--wait", action="store_true")
    p.add_argument("--wait-timeout", type=int, default=1800)
    p.set_defaults(fn=cmd_submit)

    p = sub.add_parser("result", help="show a submission's result")
    p.add_argument("id")
    p.set_defaults(fn=cmd_result)

    p = sub.add_parser("log", help="print app or runner log")
    p.add_argument("id")
    p.add_argument("--kind", choices=["app", "runner"], default="app")
    p.set_defaults(fn=cmd_log)

    p = sub.add_parser("quota", help="show today's quota")
    p.set_defaults(fn=cmd_quota)

    args = parser.parse_args(argv)
    try:
        return args.fn(args)
    except ApiError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
