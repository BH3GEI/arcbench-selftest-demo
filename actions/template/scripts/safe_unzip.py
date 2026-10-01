#!/usr/bin/env python3
"""Extract a submitted app zip with basic safety limits: no path traversal,
no symlinks, bounded file count and total size. Mirrors the checks the local
demo's server/app/validate.py applies before a submission is ever built."""
from __future__ import annotations

import os
import sys
import zipfile

MAX_FILES = 2000
MAX_TOTAL_BYTES = 50 * 1024 * 1024


def main(zip_path: str, dest: str) -> int:
    try:
        zf = zipfile.ZipFile(zip_path)
    except zipfile.BadZipFile:
        print("not a valid zip file", file=sys.stderr)
        return 1

    infos = zf.infolist()
    if len(infos) > MAX_FILES:
        print(f"too many files in zip: {len(infos)} > {MAX_FILES}", file=sys.stderr)
        return 1

    total = 0
    dest_root = os.path.realpath(dest)
    for info in infos:
        name = info.filename
        if name.startswith("/") or ".." in name.split("/"):
            print(f"unsafe path in zip: {name}", file=sys.stderr)
            return 1
        # Reject symlinks (upper 16 bits of external_attr hold unix mode).
        mode = (info.external_attr >> 16) & 0xFFFF
        if mode and (mode & 0o170000) == 0o120000:
            print(f"symlink not allowed: {name}", file=sys.stderr)
            return 1
        total += info.file_size
        if total > MAX_TOTAL_BYTES:
            print(f"zip too large: > {MAX_TOTAL_BYTES} bytes", file=sys.stderr)
            return 1
        target = os.path.realpath(os.path.join(dest_root, name))
        if target != dest_root and not target.startswith(dest_root + os.sep):
            print(f"path escapes destination: {name}", file=sys.stderr)
            return 1

    zf.extractall(dest_root)
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("usage: safe_unzip.py <zip> <dest>", file=sys.stderr)
        sys.exit(2)
    sys.exit(main(sys.argv[1], sys.argv[2]))
