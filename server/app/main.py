"""HTTP API + minimal web UI for the self-test channel."""

from __future__ import annotations

import logging
import os
from pathlib import Path

from fastapi import FastAPI, File, Header, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, JSONResponse

from .auth import AuthError, VisibilityError, assert_can_view, team_for_token
from .config import Config, load
from .docker_ops import DockerOps
from .jobs import JobService
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
    store = Store(cfg.data_dir)
    quota = Quota(cfg.data_dir / "quota.db", cfg.daily_limit)
    service = service or JobService(cfg, store, quota, get_evaluator(cfg))

    app = FastAPI(title="arcbench self-test demo", version="0.1.0")

    @app.on_event("startup")
    def _startup() -> None:
        # Remove labeled leftovers from earlier runs (crash recovery).
        try:
            DockerOps(cfg).janitor()
        except Exception as exc:
            log.warning("startup janitor skipped: %s", exc)

    def team_of(token: str | None) -> str:
        try:
            return team_for_token(cfg, token)
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
    def health() -> dict:
        return {"ok": True}

    @app.get("/api/quota")
    def get_quota(x_team_token: str | None = Header(default=None)) -> dict:
        return quota.status(team_of(x_team_token))

    @app.get("/api/submissions")
    def list_submissions(x_team_token: str | None = Header(default=None)) -> list[dict]:
        return store.list_for_team(team_of(x_team_token))

    hidden = cfg.visibility == "hidden"
    # Fields a team may see of its own result when the task is hidden.
    HIDDEN_FIELDS = ("status", "passed", "failed", "total", "pass_rate", "pack_hash", "duration_s")

    def no_sniff(resp: FileResponse) -> FileResponse:
        resp.headers["X-Content-Type-Options"] = "nosniff"
        return resp

    @app.post("/api/submissions", status_code=202)
    async def submit(file: UploadFile = File(...),
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
            sub_id = service.submit(team, data, file.filename or "app.zip")
        except ValidationError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        except QuotaExceeded as exc:
            raise HTTPException(status_code=429, detail=str(exc))
        return JSONResponse({"id": sub_id, "status": "queued"}, status_code=202)

    @app.get("/api/submissions/{sub_id}")
    def get_submission(sub_id: str, x_team_token: str | None = Header(default=None)) -> dict:
        sub, _ = owned(sub_id, x_team_token)
        payload = {"id": sub["id"], "status": sub["status"],
                   "created_at": sub["created_at"], "updated_at": sub["updated_at"]}
        result = store.load_result(sub_id)
        if result:
            if hidden:
                result = {k: result.get(k) for k in HIDDEN_FIELDS}
            payload["result"] = result
        return payload

    @app.get("/api/submissions/{sub_id}/logs/{kind}")
    def get_log(sub_id: str, kind: str,
                x_team_token: str | None = Header(default=None),
                token: str | None = Query(default=None)) -> FileResponse:
        owned(sub_id, x_team_token or token)
        if kind not in ("app", "runner"):
            raise HTTPException(status_code=404, detail="kind must be app or runner")
        if hidden:
            raise HTTPException(status_code=404, detail="logs are not available for this task")
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
        if (hidden or path not in allowed or target.suffix.lower() not in (".png", ".jpg", ".jpeg")
                or not target.is_relative_to(base) or not target.is_file()):
            raise HTTPException(status_code=404, detail="artifact not found")
        return no_sniff(FileResponse(target))

    @app.get("/", include_in_schema=False)
    def index() -> FileResponse:
        return FileResponse(Path(__file__).parent / "static" / "index.html")

    return app


app = create_app()
