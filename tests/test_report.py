import json

from app.runner import parse_playwright_report


def write_report(tmp_path, report):
    (tmp_path / "report.json").write_text(json.dumps(report))
    return tmp_path / "report.json"


def sample_report(tmp_path):
    shot = tmp_path / "output" / "x" / "failure.png"
    shot.parent.mkdir(parents=True)
    shot.write_bytes(b"png")
    return {
        "suites": [
            {
                "title": "todo.spec.js",
                "specs": [
                    {
                        "title": "shows the heading",
                        "ok": True,
                        "tests": [{"results": [{"status": "passed"}]}],
                    },
                    {
                        "title": "adds a todo",
                        "ok": False,
                        "tests": [
                            {
                                "results": [
                                    {
                                        "status": "failed",
                                        "error": {"message": "\x1b[31mError: expect failed\x1b[0m"},
                                        "attachments": [
                                            {"name": "screenshot", "contentType": "image/png", "path": str(shot)}
                                        ],
                                    }
                                ]
                            }
                        ],
                    },
                ],
                "suites": [],
            }
        ]
    }


def test_parse_mixed_report(tmp_path):
    path = write_report(tmp_path, sample_report(tmp_path))
    tests, err = parse_playwright_report(path, tmp_path)
    assert err is None
    assert len(tests) == 2
    passed, failed = tests
    assert passed.ok and passed.title == "todo.spec.js shows the heading"
    assert not failed.ok
    assert "Error: expect failed" in failed.error
    assert "\x1b" not in failed.error
    assert failed.screenshot == "output/x/failure.png"


def test_missing_report(tmp_path):
    tests, err = parse_playwright_report(tmp_path / "nope.json", tmp_path)
    assert tests == [] and "no report.json" in err


def test_broken_report(tmp_path):
    p = tmp_path / "report.json"
    p.write_text("{not json")
    tests, err = parse_playwright_report(p, tmp_path)
    assert tests == [] and "unreadable" in err
