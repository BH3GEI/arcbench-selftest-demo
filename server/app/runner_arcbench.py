"""Optional adapter: drive the platform's existing arcbench runner
(run_submission.py) instead of the demo's LocalDockerEvaluator.

Enable with:
    SELFTEST_EVALUATOR=arcbench
    SELFTEST_ARCBENCH_RUNNER_PATH=/opt/arcbench/run_submission.py

The adapter reuses the runner module's public entry points by name:
  - run_web_template(stdout_file, stderr_file)   build + start the app,
                                                 returns {"base_url": ...}
  - write_playwright_config(base_url)            pin the runner-side config
  - ensure_test_package(...)                     stage the mounted test pack
  - run_playwright_tests_with_progress(out, err) execute the pack
  - parse_playwright_results()                   -> {"passed", "failed",
      "score", "duration_seconds", "tests", "evaluation_status"}

Only the result mapping in `eval_result_from_runner` is final here; the
wiring of module-level paths/constants (PROJECT_DIR, WEB_APP_PORT,
WEB_APP_BASE_URL, SPEC_PATH) is platform-specific and marked TODO(platform).
See INTEGRATION.md for the full contract table.
"""

from __future__ import annotations

import importlib.util
import logging
import os
import sys
import time
from pathlib import Path
from types import ModuleType

from .config import Config
from .packhash import pack_hash
from .runner import EvalResult, TestCaseResult

log = logging.getLogger("selftest.runner.arcbench")


class RunnerLoadError(Exception):
    pass


def load_arcbench_runner(path: Path) -> ModuleType:
    """Import run_submission.py as a module so its functions can be driven
    in-process (same pattern the platform's local simulator uses)."""
    if not path.is_file():
        raise RunnerLoadError(f"arcbench runner not found: {path}")
    spec = importlib.util.spec_from_file_location("arcbench_run_submission", path)
    if spec is None or spec.loader is None:
        raise RunnerLoadError(f"could not load arcbench runner: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def eval_result_from_runner(payload: dict, pack_hash_value: str, duration_s: float) -> EvalResult:
    """Map parse_playwright_results() output onto the demo's EvalResult.

    Expected payload keys (missing keys degrade gracefully):
        passed, failed, score, duration_seconds, tests, evaluation_status
    Each item in `tests` is expected to expose a title, a pass/fail flag,
    and optionally an error message and a screenshot path.
    """
    tests: list[TestCaseResult] = []
    for item in payload.get("tests") or []:
        if not isinstance(item, dict):
            continue
        ok = bool(item.get("ok", item.get("passed", False)))
        tests.append(TestCaseResult(
            title=str(item.get("title") or item.get("name") or "unnamed test"),
            ok=ok,
            error=None if ok else (item.get("error") or item.get("message") or None),
            screenshot=item.get("screenshot") or item.get("screenshot_path") or None,
        ))
    passed = int(payload.get("passed", sum(1 for t in tests if t.ok)))
    failed = int(payload.get("failed", sum(1 for t in tests if not t.ok)))
    total = passed + failed
    if payload.get("evaluation_status") == "skipped":
        return EvalResult(status="error", pack_hash=pack_hash_value,
                          detail="runner skipped evaluation", duration_s=duration_s)
    return EvalResult(
        status="done" if failed == 0 and total > 0 else ("failed" if total > 0 else "error"),
        passed=passed,
        failed=failed,
        total=total,
        pass_rate=round(100.0 * passed / total, 1) if total else 0.0,
        pack_hash=pack_hash_value,
        tests=tests,
        detail="" if failed == 0 else f"{failed}/{total} tests failed",
        duration_s=round(float(payload.get("duration_seconds", duration_s)), 1),
    )


class ArcbenchRunnerEvaluator:
    """Evaluator implementation backed by the platform's run_submission.py.

    Keeps the demo's outer contract: evaluate(job_id, app_src, results_dir)
    -> EvalResult, with artifacts (report, logs) under results_dir.
    """

    def __init__(self, cfg: Config, runner_path: Path | None = None):
        self.cfg = cfg
        self.runner_path = runner_path or Path(
            os.environ.get("SELFTEST_ARCBENCH_RUNNER_PATH", "/opt/arcbench/run_submission.py")
        )

    def evaluate(self, job_id: str, app_src: Path, results_dir: Path) -> EvalResult:
        started = time.monotonic()
        results_dir.mkdir(parents=True, exist_ok=True)
        try:
            runner = load_arcbench_runner(self.runner_path)
        except RunnerLoadError as exc:
            return EvalResult(status="error", detail=str(exc))

        payload = self._drive(runner, app_src, results_dir)
        duration = time.monotonic() - started
        result = eval_result_from_runner(payload, pack_hash(self.cfg.pack_dir), duration)
        for name in ("app.log", "runner.log"):
            path = results_dir / name
            if path.is_file():
                setattr(result, "app_log" if name == "app.log" else "runner_log",
                        path.read_text(errors="replace")[-8000:])
        return result

    def _drive(self, runner: ModuleType, app_src: Path, results_dir: Path) -> dict:
        """Call the runner's entry points in order. Adjust the attribute
        wiring to the platform runner's actual module layout."""
        # TODO(platform): point the runner at this submission, e.g.
        #   runner.PROJECT_DIR = app_src            # extracted app source
        #   runner.SPEC_PATH   = <stage spec json>  # per-stage spec
        # and export the pack mount so ensure_test_package stages it.
        app_log_path = results_dir / "app.log"
        runner_log_path = results_dir / "runner.log"
        with app_log_path.open("w") as app_out, runner_log_path.open("w") as runner_out:
            started = runner.run_web_template(app_out, runner_out)
            base_url = started["base_url"]
            try:
                runner.write_playwright_config(base_url)
                runner.ensure_test_package(runner_out, runner_out)
                runner.run_playwright_tests_with_progress(runner_out, runner_out)
            finally:
                app_process = started.get("app_process")
                if app_process is not None:
                    app_process.terminate()
        return runner.parse_playwright_results()
