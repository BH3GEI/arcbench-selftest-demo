"""Submission zip validation and safe extraction — thin wrapper around the
shared `common.zipsafety` core (actions/template/common/zipsafety.py, also
used by the GitHub Actions grader's scripts/safe_unzip.py) so a zip is
accepted or rejected for the same reasons on either channel."""

from __future__ import annotations

from pathlib import Path

from common.zipsafety import ZipSafetyError
from common.zipsafety import extract as _extract
from common.zipsafety import validate as _validate


class ValidationError(Exception):
    pass


def validate_zip(zip_path: Path, max_mb: int, max_files: int, max_unzipped_mb: int = 200) -> None:
    try:
        _validate(zip_path, max_files=max_files,
                 max_zip_bytes=max_mb * 1024 * 1024,
                 max_total_bytes=max_unzipped_mb * 1024 * 1024)
    except ZipSafetyError as exc:
        raise ValidationError(str(exc)) from exc


def extract(zip_path: Path, dest: Path) -> None:
    try:
        _extract(zip_path, dest)
    except ZipSafetyError as exc:
        raise ValidationError(str(exc)) from exc
