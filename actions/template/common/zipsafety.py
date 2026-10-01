"""Submitted-app zip safety checks shared by both grading channels: path
traversal, symlinks, file-count/size caps, and an optional Dockerfile-at-root
check. `server/app/validate.py` (local docker-compose server) and
`scripts/safe_unzip.py` (GitHub Actions grader) both delegate here so a zip
is accepted or rejected for the same reasons either way.
"""
from __future__ import annotations

import os
import sys
import zipfile
from pathlib import Path

DEFAULT_MAX_FILES = 2000
DEFAULT_MAX_TOTAL_BYTES = 50 * 1024 * 1024


class ZipSafetyError(Exception):
    pass


def _open(zip_path: Path) -> zipfile.ZipFile:
    try:
        return zipfile.ZipFile(zip_path)
    except zipfile.BadZipFile as exc:
        raise ZipSafetyError("not a zip file") from exc


def validate(zip_path: Path, *, max_files: int = DEFAULT_MAX_FILES,
            max_total_bytes: int = DEFAULT_MAX_TOTAL_BYTES,
            max_zip_bytes: int | None = None,
            require_dockerfile: bool = True) -> None:
    """Raise ZipSafetyError if the zip is unsafe to extract. Does not touch
    the filesystem beyond reading the zip's central directory.

    `max_zip_bytes` (optional) caps the zip *file*'s on-disk size — a plain
    upload-size limit. `max_total_bytes` caps the sum of *uncompressed* entry
    sizes regardless of how small the zip itself is — the zip-bomb check."""
    if max_zip_bytes is not None and zip_path.stat().st_size > max_zip_bytes:
        raise ZipSafetyError(f"zip exceeds {max_zip_bytes // (1024 * 1024)} MB")
    zf = _open(zip_path)
    infos = zf.infolist()
    file_infos = [i for i in infos if not i.is_dir()]
    if len(file_infos) > max_files:
        raise ZipSafetyError(f"zip has more than {max_files} files")

    total = 0
    has_dockerfile = False
    for info in infos:
        name = info.filename
        if name.startswith("/") or ".." in Path(name).parts:
            raise ZipSafetyError(f"unsafe path in zip: {name!r}")
        mode = (info.external_attr >> 16) & 0xFFFF
        if mode and (mode & 0o170000) == 0o120000:
            raise ZipSafetyError(f"symlink not allowed: {name!r}")
        total += info.file_size
        if total > max_total_bytes:
            raise ZipSafetyError(f"zip expands to more than {max_total_bytes // (1024 * 1024)} MB")
        if not info.is_dir() and name == "Dockerfile":
            has_dockerfile = True

    if require_dockerfile and not has_dockerfile:
        raise ZipSafetyError("zip must contain a Dockerfile at its root")


def extract(zip_path: Path, dest: Path) -> None:
    """Extract a zip already proven safe by `validate()`. Still guards
    against a path escaping `dest` (defense in depth)."""
    dest.mkdir(parents=True, exist_ok=True)
    dest_root = os.path.realpath(dest)
    with zipfile.ZipFile(zip_path) as zf:
        for info in zf.infolist():
            target = os.path.realpath(os.path.join(dest_root, info.filename))
            if target != dest_root and not target.startswith(dest_root + os.sep):
                raise ZipSafetyError(f"path escapes destination: {info.filename!r}")
        zf.extractall(dest_root)


def check_and_extract(zip_path: Path, dest: Path, *,
                      max_files: int = DEFAULT_MAX_FILES,
                      max_total_bytes: int = DEFAULT_MAX_TOTAL_BYTES,
                      require_dockerfile: bool = True) -> None:
    validate(zip_path, max_files=max_files, max_total_bytes=max_total_bytes,
             require_dockerfile=require_dockerfile)
    extract(zip_path, dest)


def _main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: zipsafety.py <zip> <dest>", file=sys.stderr)
        return 2
    try:
        # require_dockerfile=False: the Actions grade.sh does its own
        # separate Dockerfile-at-root check right after this call.
        check_and_extract(Path(argv[0]), Path(argv[1]), require_dockerfile=False)
    except ZipSafetyError as exc:
        print(exc, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
