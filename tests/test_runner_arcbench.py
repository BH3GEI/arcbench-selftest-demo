from app.runner_arcbench import eval_result_from_runner


def test_maps_runner_payload_to_eval_result():
    payload = {
        "passed": 2,
        "failed": 1,
        "score": 66.7,
        "duration_seconds": 12.34,
        "tests": [
            {"title": "login works", "ok": True},
            {"title": "create org", "ok": True},
            {"title": "invite member", "ok": False, "error": "timeout", "screenshot": "shots/1.png"},
        ],
        "evaluation_status": "done",
    }
    result = eval_result_from_runner(payload, pack_hash_value="abc123", duration_s=99.0)
    assert result.status == "failed"
    assert result.passed == 2 and result.failed == 1 and result.total == 3
    assert result.pass_rate == 66.7
    assert result.pack_hash == "abc123"
    assert result.duration_s == 12.3  # rounded to 1 decimal, like the reference evaluator
    assert result.tests[2].error == "timeout"
    assert result.tests[2].screenshot == "shots/1.png"
    assert result.detail == "1/3 tests failed"


def test_all_passed_is_done():
    result = eval_result_from_runner({"passed": 3, "failed": 0, "tests": []},
                                     pack_hash_value="h", duration_s=1.0)
    assert result.status == "done"
    assert result.pass_rate == 100.0


def test_skipped_evaluation_is_error():
    result = eval_result_from_runner({"passed": 0, "failed": 0, "tests": [],
                                      "evaluation_status": "skipped"},
                                     pack_hash_value="h", duration_s=1.0)
    assert result.status == "error"
    assert "skipped" in result.detail
