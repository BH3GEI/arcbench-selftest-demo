#!/usr/bin/env python3
"""Verify the self-test service's HMAC signature on a dispatch request before
grading anything.

Why: repository_dispatch can be called by anyone holding a token with write
access to the grader repo. In production that's only the self-test service's
own service credential, but defense in depth is cheap here — and this same
signature is where per-team daily quota enforcement actually lands on the
Actions side (see README_ACTIONS.md "Quota"): the self-test service signs a
short-lived token *after* its own quota.try_consume() succeeds, so a valid,
fresh signature is itself proof that quota was already checked. The grader
never re-implements a stateful counter.

Signed string: "{submission_id}.{task_id}.{timestamp}"
Header/field:  HMAC-SHA256 over that string, hex digest, shared secret from
               the SELFTEST_DISPATCH_SIGNING_KEY secret.
Freshness:     timestamp (unix seconds) must be within --max-age-s of now,
               so a captured signature can't be replayed indefinitely.

Exits 0 and prints nothing if valid. Exits 1 with a reason on stderr
otherwise. Does not log the secret or the signature.
"""
from __future__ import annotations

import argparse
import hashlib
import hmac
import os
import sys
import time


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--submission-id", required=True)
    ap.add_argument("--task-id", required=True)
    ap.add_argument("--timestamp", required=True, help="unix seconds the self-test service signed at")
    ap.add_argument("--signature", required=True, help="hex HMAC-SHA256")
    ap.add_argument("--max-age-s", type=int, default=300)
    args = ap.parse_args()

    secret = os.environ.get("SELFTEST_DISPATCH_SIGNING_KEY", "")
    if not secret:
        # No key configured: signature checking is off (e.g. local/manual
        # workflow_dispatch testing). grade.sh only calls this script when a
        # signature was actually supplied, so an operator who wants this
        # enforced in production just has to set the secret.
        return 0

    if not args.signature:
        print("missing signature", file=sys.stderr)
        return 1

    try:
        ts = int(args.timestamp)
    except ValueError:
        print("bad timestamp", file=sys.stderr)
        return 1

    now = int(time.time())
    if abs(now - ts) > args.max_age_s:
        print(f"signature timestamp outside the {args.max_age_s}s freshness window", file=sys.stderr)
        return 1

    message = f"{args.submission_id}.{args.task_id}.{ts}".encode()
    expected = hmac.new(secret.encode(), message, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, args.signature.strip().lower()):
        print("signature mismatch", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
