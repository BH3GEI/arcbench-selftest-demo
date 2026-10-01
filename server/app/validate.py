"""Submission zip validation and safe extraction."""

from __future__ import annotations

import zipfile
from pathlib import Path


class ValidationError(Exception):
    pass


def validate_zip(zip_path: Path, max_mb: int, max_files: int) -> None:
    if not zipfile.is_zipfile(zip_path):
        raise ValidationError("not a zip file")
    if zip_path.stat().st_size > max_mb * 1024 * 1024:
        raise ValidationError(f"zip exceeds {max_mb} MB")
    with zipfile.ZipFile(zip_path) as zf:
        names = [i.filename for i in zf.infolist() if not i.is_dir()]
        if len(names) > max_files:
            raise ValidationError(f"zip has more than {max_files} files")
        if "Dockerfile" not in names:
            raise ValidationError("zip must contain a Dockerfile at its root")
        for name in names:
            p = Path(name)
            if p.is_absolute() or ".." in p.parts:
                raise ValidationError(f"unsafe path in zip: {name!r}")


def extract(zip_path: Path, dest: Path) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path) as zf:
        for info in zf.infolist():
            target = dest / info.filename
            if not target.resolve().is_relative_to(dest.resolve()):
                raise ValidationError(f"unsafe path in zip: {info.filename!r}")
        zf.extractall(dest)
