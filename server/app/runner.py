"""Evaluation pipeline: from an extracted app source directory to a result.

`Evaluator` is the integration seam for the platform team. The reference
implementation (`LocalDockerEvaluator`) does: docker build (isolated, with a
timeout) -> fresh container on an internal network with PORT injected ->
readiness probe -> Playwright pack run with BASE_URL -> collect per-test
results, failure screenshots, and app logs.

To plug in the existing arcbench runner instead, implement `evaluate()` with
the same contract (or shell out to run_submission.py inside it) and swap the
factory in `main.py`. Input contract: an app source dir with a Dockerfile at
its root, a test pack dir, resource/time limits from Config. Output contract:
an EvalResult whose artifacts_dir contains report artifacts (screenshots,
runner log, app log).
"""

from __future__ import annotations

import json
import logging
import re
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

from .config import Config
from .docker_ops import BuildError, DockerOps
from .packhash import pack_hash

log = logging.getLogger("selftest.runner")

ANSI = re.compile(r"\x1b\[[0-9;]*m")


@dataclass
class TestCaseResult:
    title: str
    ok: bool
    error: str | None = None
    screenshot: str | None = None  # path relative to the results dir


@dataclass
class EvalResult:
    status: str  # "done" | "failed" | "error"
    passed: int = 0
    failed: int = 0
    total: int = 0
    pass_rate: float = 0.0
    pack_hash: str = ""
    tests: list[TestCaseResult] = field(default_factory=list)
    app_log: str = ""
    runner_log: str = ""
    detail: str = ""  # human-readable note for failed/error outcomes
    duration_s: float = 0.0


class Evaluator(Protocol):
    def evaluate(self, job_id: str, app_src: Path, results_dir: Path) -> EvalResult:
        ...


def parse_playwright_report(report_path: Path, results_dir: Path) -> tuple[list[TestCaseResult], str | None]:
    """Turn Playwright's JSON report into per-test results. Returns (tests, parse_error)."""
    if not report_path.is_file():
        return [], "runner produced no report.json"
    try:
        report = json.loads(report_path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        return [], f"report.json unreadable: {exc}"

    tests: list[TestCaseResult] = []

    def rel(path: str | None) -> str | None:
        if not path:
            return None
        try:
            return str(Path(path).resolve().relative_to(results_dir.resolve()))
        except ValueError:
            return Path(path).name

    def walk(suite: dict, prefix: str) -> None:
        title = f"{prefix} {suite.get('title', '')}".strip()
        for spec in suite.get("specs", []):
            name = f"{title} {spec.get('title', '')}".strip()
            ran = [r for t in spec.get("tests", []) for r in t.get("results", []) if r]
            ok = bool(ran) and all(
                r.get("status") in ("passed", "expected") for r in ran
            ) and spec.get("ok", True)
            error, shot = None, None
            if not ok:
                for r in ran:
                    err = (r.get("error") or {}).get("message")
                    if err and error is None:
                        error = ANSI.sub("", err).strip()[:2000]
                    for att in r.get("attachments", []):
                        if att.get("contentType", "").startswith("image/") and shot is None:
                            shot = rel(att.get("path"))
            tests.append(TestCaseResult(title=name, ok=ok, error=error, screenshot=shot))
        for child in suite.get("suites", []):
            walk(child, title)

    for suite in report.get("suites", []):
        walk(suite, "")
    return tests, None


class LocalDockerEvaluator:
    def __init__(self, cfg: Config, ops: DockerOps):
        self.cfg = cfg
        self.ops = ops

    def evaluate(self, job_id: str, app_src: Path, results_dir: Path) -> EvalResult:
        cfg = self.cfg
        results_dir.mkdir(parents=True, exist_ok=True)
        started = time.monotonic()
        short = uuid.uuid4().hex[:8]
        image = f"selftest-app-{short}"
        net_name = f"selftest-net-{short}"
        app_name = f"selftest-app-{short}"
        run_name = f"selftest-run-{short}"
        result = EvalResult(status="error", pack_hash=pack_hash(cfg.pack_dir))
        app_container = None
        try:
            # 0. runner image, built lazily from runner/ on first use
            self.ops.ensure_runner_image()
            # 1. isolated build with a wall-clock timeout
            self.ops.build_image(app_src, image, network_mode=cfg.build_network,
                                 timeout_s=cfg.build_timeout_s)
            # 2. fresh internal network (no internet) + fresh container
            self.ops.create_network(net_name, job_id)
            app_container = self.ops.run_app(image, app_name, net_name, job_id)
            # 3. readiness probe + Playwright run happen inside the runner
            base_url = f"http://app:{cfg.app_port}"
            exit_code, runner_log = self.ops.run_runner(
                run_name, net_name, job_id, base_url,
                cfg.host_pack_dir.resolve(), results_dir.resolve(),
            )
            result.runner_log = ANSI.sub("", runner_log)[-8000:]
            tests, parse_error = parse_playwright_report(results_dir / "report.json", results_dir)
            if exit_code == 3:
                result.status, result.detail = "error", f"app did not become ready within {cfg.ready_timeout_s}s"
            elif tests:
                result.tests = tests
                result.passed = sum(1 for t in tests if t.ok)
                result.failed = len(tests) - result.passed
                result.total = len(tests)
                result.pass_rate = round(100.0 * result.passed / result.total, 1)
                result.status = "done" if result.failed == 0 else "failed"
                if result.failed:
                    result.detail = f"{result.failed}/{result.total} tests failed"
            else:
                result.status = "error"
                result.detail = parse_error or f"runner exited {exit_code} without results"
        except BuildError as exc:
            result.status, result.detail = "error", f"build failed: {exc}"
        except Exception as exc:
            log.exception("evaluation failed")
            result.status, result.detail = "error", str(exc)[:500]
        finally:
            if app_container is not None:
                result.app_log = ANSI.sub("", self.ops.container_logs(app_container))[-8000:]
            self.ops.cleanup_job(job_id)
            result.duration_s = round(time.monotonic() - started, 1)
        return result
