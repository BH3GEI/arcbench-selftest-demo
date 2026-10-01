import zipfile
from pathlib import Path

import pytest

from app.validate import ValidationError, extract, validate_zip


def make_zip(path: Path, files: dict[str, str]) -> Path:
    with zipfile.ZipFile(path, "w") as zf:
        for name, content in files.items():
            zf.writestr(name, content)
    return path


def test_accepts_zip_with_root_dockerfile(tmp_path):
    z = make_zip(tmp_path / "app.zip", {"Dockerfile": "FROM scratch", "server.js": "x"})
    validate_zip(z, max_mb=1, max_files=10)
    dest = tmp_path / "out"
    extract(z, dest)
    assert (dest / "Dockerfile").is_file()


def test_rejects_missing_dockerfile(tmp_path):
    z = make_zip(tmp_path / "app.zip", {"server.js": "x"})
    with pytest.raises(ValidationError, match="Dockerfile"):
        validate_zip(z, max_mb=1, max_files=10)


def test_rejects_non_zip(tmp_path):
    z = tmp_path / "app.zip"
    z.write_bytes(b"not a zip")
    with pytest.raises(ValidationError, match="not a zip"):
        validate_zip(z, max_mb=1, max_files=10)


def test_rejects_zip_slip(tmp_path):
    z = tmp_path / "evil.zip"
    with zipfile.ZipFile(z, "w") as zf:
        zf.writestr("Dockerfile", "FROM scratch")
        zf.writestr("../escape.txt", "boom")
    with pytest.raises(ValidationError, match="unsafe path"):
        validate_zip(z, max_mb=1, max_files=10)


def test_rejects_too_many_files(tmp_path):
    z = make_zip(tmp_path / "app.zip", {"Dockerfile": "x", "a": "1", "b": "2"})
    with pytest.raises(ValidationError, match="files"):
        validate_zip(z, max_mb=1, max_files=2)


def test_rejects_oversize(tmp_path):
    z = make_zip(tmp_path / "app.zip", {"Dockerfile": "x" * 1024})
    with pytest.raises(ValidationError, match="MB"):
        validate_zip(z, max_mb=0, max_files=10)
