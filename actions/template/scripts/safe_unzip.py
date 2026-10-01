#!/usr/bin/env python3
"""Thin CLI wrapper around the shared `common.zipsafety` core (the same
module `server/app/validate.py` uses) so a submitted app zip is accepted or
rejected identically on both grading channels. The Dockerfile-at-root check
is left to scripts/grade.sh, which runs it as a separate, explicit step.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from common.zipsafety import ZipSafetyError, check_and_extract


def main(zip_path: str, dest: str) -> int:
    try:
        check_and_extract(Path(zip_path), Path(dest), require_dockerfile=False)
    except ZipSafetyError as exc:
        print(exc, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("usage: safe_unzip.py <zip> <dest>", file=sys.stderr)
        sys.exit(2)
    sys.exit(main(sys.argv[1], sys.argv[2]))
