"""Content hash of a test pack, shown to users so both sides can verify they
ran against the exact same pack."""

from __future__ import annotations

import hashlib
import re
from pathlib import Path


def pack_hash(pack_dir: Path) -> str:
    if not pack_dir.is_dir():
        raise FileNotFoundError(f"test pack directory not found: {pack_dir}")
    digest = hashlib.sha256()
    for path in sorted(p for p in pack_dir.rglob("*") if p.is_file()):
        rel = path.relative_to(pack_dir).as_posix()
        digest.update(rel.encode())
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def count_tests(pack_dir: Path) -> int:
    """Best-effort count of `test` declarations in the pack."""
    total = 0
    for path in pack_dir.rglob("*"):
        if path.suffix in (".ts", ".js") and path.is_file():
            try:
                total += len(re.findall(r"\btest\b", path.read_text(encoding="utf-8", errors="replace")))
            except OSError:
                continue
    return total
