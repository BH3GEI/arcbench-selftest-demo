"""HTTP API + minimal web UI for the self-test channel."""

from __future__ import annotations

import logging
import os
import threading
import time
from pathlib import Path

from fastapi import FastAPI, File, Form, Header, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, JSONResponse

from common.resultshape import apply_visibility
from common.taskspec import TaskError

from .auth import AuthError, VisibilityError, assert_can_view, build_authenticator
from .config import Config, load
from .docker_ops import DockerOps
from .jobs import JobService, QueueFull
from .logging_setup import configure as configure_logging
from .quota import Quota, QuotaExceeded
from .runner import LocalDockerEvaluator
from .store import Store
from .validate import ValidationError

log = logging.getLogger("selftest")


def get_evaluator(cfg: Config) -> LocalDockerEvaluator:
    """Integration seam: return the platform's evaluator here instead of
    LocalDockerEvaluator to reuse the existing arcbench runner. Set
    SELFTEST_EVALUATOR=arcbench to use the run_submission.py adapter
    (see runner_arcbench.py and INTEGRATION.md)."""
    if os.environ.get("SELFTEST_EVALUATOR", "local") == "arcbench":
        from .runner_arcbench import ArcbenchRunnerEvaluator
        return ArcbenchRunnerEvaluator(cfg)
    return LocalDockerEvaluator(cfg, DockerOps(cfg))


def create_app(cfg: Config | None = None, service: JobService | None = None) -> FastAPI:
    cfg = cfg or load()
    configure_logging(cfg)
    store = Store(cfg.data_dir)
    quota = Quota(cfg.data_dir / "quota.db", cfg.daily_limit)
    authenticator = build_authenticator(cfg)
    service = service or JobService(cfg, store, quota, get_evaluator(cfg))

    app = FastAPI(title="arcbench self-test demo", version="0.1.0")
    _stop_retention = threading.Event()

    @app.on_event("startup")
    def _startup() -> None:
        # Remove labeled leftovers from earlier runs (crash recovery).
        try:
            DockerOps(cfg).janitor()
        except Exception as exc:
            log.warning("startup janitor skipped: %s", exc)

        if cfg.retention_hours > 0:
            def _retention_loop() -> None:
                # Hourly is frequent enough relative to a retention window
                # measured in hours/days, and cheap (a handful of SQLite rows).
                while not _stop_retention.wait(3600):
                    try:
                        store.sweep_expired(cfg.retention_hours)
                    except Exception:
                        log.exception("retention sweep failed")
            threading.Thread(target=_retention_loop, name="retention", daemon=True).start()

    @app.on_event("shutdown")
    def _shutdown() -> None:
        _stop_retention.set()

    def team_of(token: str | None) -> str:
        try:
            return authenticator.authenticate(token)
        except AuthError as exc:
            raise HTTPException(status_code=401, detail=str(exc))

    def owned(sub_id: str, token: str | None) -> tuple[dict, str]:
        team = team_of(token)
        sub = store.get(sub_id)
        if not sub:
            raise HTTPException(status_code=404, detail="unknown submission id")
        try:
            assert_can_view(team, sub["team"])
        except VisibilityError as exc:
            raise HTTPException(status_code=403, detail=str(exc))
        return sub, team

    @app.get("/api/health")
    def health(deep: bool = False) -> dict:
        if not deep:
            return {"ok": True}
        # deep=true also checks the Docker daemon the evaluator depends on —
        # useful for an orchestrator readiness probe, not just liveness.
        try:
            docker_ok = DockerOps(cfg).client.ping()
        except Exception as exc:
            return JSONResponse({"ok": False, "docker": False, "detail": str(exc)[:200]}, status_code=503)
        return {"ok": bool(docker_ok), "docker": bool(docker_ok)}

    @app.get("/api/quota")
    def get_quota(x_team_token: str | None = Header(default=None)) -> dict:
        return quota.status(team_of(x_team_token))

    @app.get("/api/submissions")
    def list_submissions(x_team_token: str | None = Header(default=None)) -> list[dict]:
        return store.list_for_team(team_of(x_team_token))

    def no_sniff(resp: FileResponse) -> FileResponse:
        resp.headers["X-Content-Type-Options"] = "nosniff"
        return resp

    @app.post("/api/submissions", status_code=202)
    async def submit(file: UploadFile = File(...), task_id: str = Form(...),
                     x_team_token: str | None = Header(default=None)) -> JSONResponse:
        team = team_of(x_team_token)
        # Read in chunks and stop at the cap instead of buffering any size.
        limit = cfg.max_zip_mb * 1024 * 1024
        chunks, size = [], 0
        while chunk := await file.read(1024 * 1024):
            size += len(chunk)
            if size > limit:
                raise HTTPException(status_code=400, detail=f"zip exceeds {cfg.max_zip_mb} MB")
            chunks.append(chunk)
        data = b"".join(chunks)
        try:
            sub_id = service.submit(team, data, file.filename or "app.zip", task_id)
        except TaskError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        except ValidationError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        except QuotaExceeded as exc:
            raise HTTPException(status_code=429, detail=str(exc))
        except QueueFull as exc:
            raise HTTPException(status_code=503, detail=str(exc))
        return JSONResponse({"id": sub_id, "status": "queued"}, status_code=202)

    @app.get("/api/submissions/{sub_id}")
    def get_submission(sub_id: str, x_team_token: str | None = Header(default=None)) -> dict:
        sub, _ = owned(sub_id, x_team_token)
        payload = {"id": sub["id"], "status": sub["status"], "task_id": sub["task_id"],
                   "created_at": sub["created_at"], "updated_at": sub["updated_at"]}
        result = store.load_result(sub_id)
        if result:
            # hidden tasks: {status, passed, total} only — no tests, no logs,
            # no pack_hash, matching the GitHub Actions grader exactly.
            payload["result"] = apply_visibility(result, result.get("visibility", "public"))
        return payload

    def _is_hidden(sub_id: str) -> bool:
        result = store.load_result(sub_id)
        return bool(result and result.get("visibility") == "hidden")

    @app.get("/api/submissions/{sub_id}/logs/{kind}")
    def get_log(sub_id: str, kind: str,
                x_team_token: str | None = Header(default=None),
                token: str | None = Query(default=None)) -> FileResponse:
        owned(sub_id, x_team_token or token)
        if _is_hidden(sub_id):
            raise HTTPException(status_code=404, detail="log not available for this task")
        if kind not in ("app", "runner"):
            raise HTTPException(status_code=404, detail="kind must be app or runner")
        path = store.result_dir(sub_id) / f"{kind}.log"
        if not path.is_file():
            raise HTTPException(status_code=404, detail="log not available yet")
        return no_sniff(FileResponse(path, media_type="text/plain; charset=utf-8"))

    @app.get("/api/submissions/{sub_id}/artifact")
    def get_artifact(sub_id: str, path: str,
                     x_team_token: str | None = Header(default=None),
                     token: str | None = Query(default=None)) -> FileResponse:
        owned(sub_id, x_team_token or token)
        # Only screenshots named in the result are served. The results dir
        # also holds report.json and Playwright's output/ (error-context
        # files quote the test source), which must not be downloadable.
        result = store.load_result(sub_id) or {}
        allowed = {t.get("screenshot") for t in result.get("tests") or [] if t.get("screenshot")}
        base = store.result_dir(sub_id).resolve()
        target = (base / path).resolve()
        if (_is_hidden(sub_id) or path not in allowed or target.suffix.lower() not in (".png", ".jpg", ".jpeg")
                or not target.is_relative_to(base) or not target.is_file()):
            raise HTTPException(status_code=404, detail="artifact not found")
        return no_sniff(FileResponse(target))

    @app.get("/", include_in_schema=False)
    def index() -> FileResponse:
        return FileResponse(Path(__file__).parent / "static" / "index.html")

    return app


app = create_app()
