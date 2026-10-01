"""CLI tests: argument parsing, output formatting, exit codes. The HTTP layer
is monkeypatched so nothing touches the network."""

from __future__ import annotations

import io
import zipfile

import pytest

from cli import selftest as cli


def test_zip_dir_includes_dockerfile(tmp_path):
    src = tmp_path / "app"
    src.mkdir()
    (src / "Dockerfile").write_text("FROM scratch")
    (src / "server.js").write_text("ok")
    data = cli.zip_dir(src)
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        names = set(zf.namelist())
    assert names == {"Dockerfile", "server.js"}


def test_multipart_contains_field_and_data():
    body, content_type = cli.multipart("file", "app.zip", b"zipbytes")
    assert content_type.startswith("multipart/form-data; boundary=")
    assert b'name="file"' in body
    assert b"app.zip" in body
    assert b"zipbytes" in body


def test_submit_missing_path_fails(capsys):
    code = cli.main(["submit", "/no/such/path"])
    assert code == 1
    assert "not found" in capsys.readouterr().err


def test_submit_directory_without_dockerfile_fails(tmp_path, capsys):
    src = tmp_path / "app"
    src.mkdir()
    (src / "server.js").write_text("ok")
    code = cli.main(["submit", str(src)])
    assert code == 1
    assert "Dockerfile" in capsys.readouterr().err


def test_submit_zip_posts_and_prints_id(tmp_path, monkeypatch, capsys):
    src = tmp_path / "app"
    src.mkdir()
    (src / "Dockerfile").write_text("FROM scratch")

    calls = []

    def fake_request(args, method, path, body=None, content_type=None):
        calls.append((method, path))
        return {"id": "abc123", "status": "queued"}

    monkeypatch.setattr(cli, "request", fake_request)
    code = cli.main(["submit", str(src)])
    assert code == 0
    assert calls == [("POST", "/api/submissions")]
    assert "abc123" in capsys.readouterr().out


def test_submit_with_wait_polls_until_done(tmp_path, monkeypatch, capsys):
    src = tmp_path / "app"
    src.mkdir()
    (src / "Dockerfile").write_text("FROM scratch")

    responses = iter([
        {"id": "abc123", "status": "queued"},
        {"id": "abc123", "status": "running"},
        {"id": "abc123", "status": "done", "result": {"pack_hash": "x" * 20, "passed": 1,
                                                       "total": 1, "pass_rate": 100.0, "duration_s": 1.0,
                                                       "tests": [{"title": "t1", "ok": True}]}},
    ])

    def fake_request(args, method, path, body=None, content_type=None):
        return next(responses)

    monkeypatch.setattr(cli, "request", fake_request)
    monkeypatch.setattr(cli.time, "sleep", lambda _: None)
    code = cli.main(["submit", str(src), "--wait"])
    assert code == 0
    out = capsys.readouterr().out
    assert "status=done" in out
    assert "PASS" in out


def test_submit_with_wait_times_out(tmp_path, monkeypatch, capsys):
    src = tmp_path / "app"
    src.mkdir()
    (src / "Dockerfile").write_text("FROM scratch")

    def fake_request(args, method, path, body=None, content_type=None):
        return {"id": "abc123", "status": "running"}

    monkeypatch.setattr(cli, "request", fake_request)
    monkeypatch.setattr(cli.time, "sleep", lambda _: None)
    code = cli.main(["submit", str(src), "--wait", "--wait-timeout", "0"])
    assert code == 2
    assert "deadline expired" in capsys.readouterr().err


def test_result_done_returns_zero(monkeypatch, capsys):
    monkeypatch.setattr(cli, "request", lambda *a, **k: {
        "id": "abc123", "status": "done",
        "result": {"pack_hash": "x" * 20, "passed": 2, "total": 2, "pass_rate": 100.0, "duration_s": 3.0, "tests": []},
    })
    assert cli.main(["result", "abc123"]) == 0
    assert "status=done" in capsys.readouterr().out


def test_result_failed_returns_one(monkeypatch):
    monkeypatch.setattr(cli, "request", lambda *a, **k: {"id": "abc123", "status": "failed"})
    assert cli.main(["result", "abc123"]) == 1


def test_result_running_returns_two(monkeypatch):
    monkeypatch.setattr(cli, "request", lambda *a, **k: {"id": "abc123", "status": "running"})
    assert cli.main(["result", "abc123"]) == 2


def test_quota_prints_usage(monkeypatch, capsys):
    monkeypatch.setattr(cli, "request", lambda *a, **k: {
        "team": "team-a", "used": 3, "limit": 10, "remaining": 7,
    })
    assert cli.main(["quota"]) == 0
    assert "team=team-a" in capsys.readouterr().out


def test_api_error_from_request_is_reported(monkeypatch, capsys):
    def fake_request(args, method, path, body=None, content_type=None):
        raise cli.ApiError(429, "team reached the daily limit")

    monkeypatch.setattr(cli, "request", fake_request)
    code = cli.main(["quota"])
    assert code == 1
    assert "429" in capsys.readouterr().err


def test_token_defaults_to_demo_token(monkeypatch):
    captured = {}

    def fake_request(args, method, path, body=None, content_type=None):
        captured["token"] = args.token
        return {"team": "demo-token", "used": 0, "limit": 10, "remaining": 10}

    monkeypatch.setattr(cli, "request", fake_request)
    cli.main(["quota"])
    assert captured["token"] == "demo-token"


def test_custom_token_and_server_are_used(monkeypatch):
    captured = {}

    def fake_request(args, method, path, body=None, content_type=None):
        captured["token"] = args.token
        captured["server"] = args.server
        return {"team": "my-team", "used": 0, "limit": 10, "remaining": 10}

    monkeypatch.setattr(cli, "request", fake_request)
    cli.main(["--token", "my-token", "--server", "http://example:9999", "quota"])
    assert captured["token"] == "my-token"
    assert captured["server"] == "http://example:9999"
