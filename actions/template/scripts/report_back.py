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

Anti-forgery / anti-replay on the callback POST: the signed string is
"{timestamp}.{nonce}.{sha256(body)}" (not the raw body alone), with
X-Timestamp/X-Nonce/X-Signature headers carrying the three pieces. This lets
the receiver reject a stale POST (stale timestamp) and a captured-and-
resent one (seen nonce) even *within* the freshness window, the same two
checks scripts/verify_signature.py already applies to the inbound dispatch.
The receiver needs to persist seen nonces for at least the freshness window
it enforces — the grader itself is stateless across runs and can't do that
dedup; see README_ACTIONS.md "Callback verification" for the exact contract
the self-test/web side should implement.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.request


def _callback_request(callback_url: str, body: bytes) -> urllib.request.Request:
    req = urllib.request.Request(callback_url, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    token = os.environ.get("CALLBACK_TOKEN", "").strip()
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    # Same shared secret used to verify inbound dispatches (see
    # verify_signature.py) also signs outbound results, so the self-test
    # service can confirm a result really came from this grader and
    # wasn't dropped in by anything else that can reach its callback URL
    # — and, with timestamp+nonce folded into the signed string, can't
    # be forged or replayed (not even a byte-for-byte resend of a
    # previously valid POST, which a body-only HMAC would accept forever
    # within the freshness window).
    signing_key = os.environ.get("SELFTEST_DISPATCH_SIGNING_KEY", "").strip()
    if signing_key:
        timestamp = str(int(time.time()))
        nonce = secrets.token_hex(16)
        body_hash = hashlib.sha256(body).hexdigest()
        message = f"{timestamp}.{nonce}.{body_hash}".encode()
        sig = hmac.new(signing_key.encode(), message, hashlib.sha256).hexdigest()
        req.add_header("X-Timestamp", timestamp)
        req.add_header("X-Nonce", nonce)
        req.add_header("X-Signature", f"sha256={sig}")
    return req


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
        # Retried on network errors and 5xx only (a fresh timestamp+nonce per
        # attempt, since the receiver may already have claimed the previous
        # nonce). A 4xx is a decided answer — retrying won't change it.
        delays = [0, 5, 20]
        for attempt, delay in enumerate(delays, 1):
            time.sleep(delay)
            try:
                with urllib.request.urlopen(_callback_request(callback_url, body), timeout=30) as resp:
                    print(f"[report_back] callback POST -> HTTP {resp.status}")
                return 0
            except urllib.error.HTTPError as exc:
                print(f"[report_back] callback POST -> HTTP {exc.code} (attempt {attempt})", file=sys.stderr)
                if exc.code < 500:
                    return 1
            except urllib.error.URLError as exc:
                print(f"[report_back] callback POST failed: {exc} (attempt {attempt})", file=sys.stderr)
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
