"""HTTP API + minimal web UI for the self-test channel."""

from __future__ import annotations

import logging
import os
import threading
import time
from pathlib import Path

from fastapi import Cookie, FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response

from common.resultshape import apply_visibility
from common.taskspec import TaskError

from .auth import SESSION_COOKIE, AuthError, VisibilityError, assert_can_view, build_authenticator
from .config import Config, load
from .docker_ops import DockerOps
from .jobs import JobService, QueueFull
from .logging_setup import configure as configure_logging
from .oauth_github import build_router as build_github_router
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
    # role="api": no Docker socket needed or touched by this process at all —
    # a separate role="worker" process drains the queue (see server/app/worker.py).
    service = service or JobService(cfg, store, quota, None if cfg.role == "api" else get_evaluator(cfg))

    app = FastAPI(title="arcbench self-test demo", version="0.1.0")
    if cfg.auth_mode == "github":
        app.include_router(build_github_router(cfg))
    _stop_retention = threading.Event()

    if cfg.force_https:
        @app.middleware("http")
        async def _require_https(request: Request, call_next):
            # Trusts X-Forwarded-Proto, so this only makes sense behind a
            # reverse proxy that sets it itself (deploy/Caddyfile,
            # deploy/nginx.conf.example) — never expose this process
            # directly to the internet (docs/security-review.md item #9).
            proto = request.headers.get("x-forwarded-proto", "https")
            if proto != "https":
                return Response("HTTPS required", status_code=400)
            return await call_next(request)

    @app.on_event("startup")
    def _startup() -> None:
        # Remove labeled leftovers from earlier runs (crash recovery). Not
        # this process's job in the split: it never created any containers.
        if cfg.role != "api":
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

    def team_of(x_team_token: str | None, session: str | None) -> str:
        # Exactly one of these is ever meaningful for a given auth_mode:
        # the header for token/hmac clients (CLI, API), the cookie for
        # github (browser login) — see server/app/oauth_github.py.
        try:
            return authenticator.authenticate(x_team_token or session)
        except AuthError as exc:
            raise HTTPException(status_code=401, detail=str(exc))

    def owned(sub_id: str, x_team_token: str | None, session: str | None) -> tuple[dict, str]:
        team = team_of(x_team_token, session)
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
        if cfg.role == "api":
            # This process never touches Docker by design (see worker.py);
            # a Docker check here would just report the socket it correctly
            # doesn't have.
            return {"ok": True, "docker": "n/a (role=api, see worker.py)"}
        # deep=true also checks the Docker daemon the evaluator depends on —
        # useful for an orchestrator readiness probe, not just liveness.
        try:
            docker_ok = DockerOps(cfg).client.ping()
        except Exception as exc:
            return JSONResponse({"ok": False, "docker": False, "detail": str(exc)[:200]}, status_code=503)
        return {"ok": bool(docker_ok), "docker": bool(docker_ok)}

    @app.get("/api/quota")
    def get_quota(x_team_token: str | None = Header(default=None),
                 session: str | None = Cookie(default=None, alias=SESSION_COOKIE)) -> dict:
        return quota.status(team_of(x_team_token, session))

    @app.get("/api/submissions")
    def list_submissions(x_team_token: str | None = Header(default=None),
                        session: str | None = Cookie(default=None, alias=SESSION_COOKIE)) -> list[dict]:
        return store.list_for_team(team_of(x_team_token, session))

    def no_sniff(resp: FileResponse) -> FileResponse:
        resp.headers["X-Content-Type-Options"] = "nosniff"
        return resp

    @app.post("/api/submissions", status_code=202)
    async def submit(file: UploadFile = File(...), task_id: str = Form(...),
                     x_team_token: str | None = Header(default=None),
                     session: str | None = Cookie(default=None, alias=SESSION_COOKIE)) -> JSONResponse:
        team = team_of(x_team_token, session)
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
    def get_submission(sub_id: str, x_team_token: str | None = Header(default=None),
                       session: str | None = Cookie(default=None, alias=SESSION_COOKIE)) -> dict:
        sub, _ = owned(sub_id, x_team_token, session)
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
                session: str | None = Cookie(default=None, alias=SESSION_COOKIE)) -> FileResponse:
        # No query-string token fallback (docs/security-review.md item #8):
        # it ends up in access logs, browser history, and Referer headers.
        # Browser clients authenticate via the session cookie instead.
        owned(sub_id, x_team_token, session)
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
                     session: str | None = Cookie(default=None, alias=SESSION_COOKIE)) -> FileResponse:
        owned(sub_id, x_team_token, session)
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
