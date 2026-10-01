"""Configuration for the self-test service. Everything is env-driven."""

from __future__ import annotations

import os
import socket
from dataclasses import dataclass, field
from pathlib import Path


def _int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except ValueError:
        raise SystemExit(f"config: {name} must be an integer, got {raw!r}")


def _float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    try:
        return float(raw)
    except ValueError:
        raise SystemExit(f"config: {name} must be a number, got {raw!r}")


def parse_team_tokens(raw: str) -> dict[str, str]:
    """Parse 'team-a=token-a,team-b=token-b' into {token: team}."""
    mapping: dict[str, str] = {}
    for pair in raw.split(","):
        pair = pair.strip()
        if not pair:
            continue
        if "=" not in pair:
            raise SystemExit(f"config: SELFTEST_TEAM_TOKENS entry {pair!r} must be team=token")
        team, token = pair.split("=", 1)
        team, token = team.strip(), token.strip()
        if not team or not token:
            raise SystemExit(f"config: SELFTEST_TEAM_TOKENS entry {pair!r} must be team=token")
        mapping[token] = team
    return mapping


def parse_team_secrets(raw: str) -> dict[str, str]:
    """Parse 'team-a=secret-a,team-b=secret-b' into {team: secret}, for
    SELFTEST_AUTH_MODE=hmac."""
    mapping: dict[str, str] = {}
    for pair in raw.split(","):
        pair = pair.strip()
        if not pair:
            continue
        if "=" not in pair:
            raise SystemExit(f"config: SELFTEST_TEAM_SECRETS entry {pair!r} must be team=secret")
        team, secret = pair.split("=", 1)
        team, secret = team.strip(), secret.strip()
        if not team or not secret:
            raise SystemExit(f"config: SELFTEST_TEAM_SECRETS entry {pair!r} must be team=secret")
        mapping[team] = secret
    return mapping


@dataclass(frozen=True)
class Config:
    # Paths inside this process (container paths when running under compose).
    data_dir: Path = field(default_factory=lambda: Path(os.environ.get("SELFTEST_DATA_DIR", "./data")))
    # Task definitions: <tasks_dir>/<task_id>/{requirements/requirements.yaml,tests/}.
    # Same directory the GitHub Actions grader reads (see common/taskspec.py).
    tasks_dir: Path = field(default_factory=lambda: Path(os.environ.get("SELFTEST_TASKS_DIR", "./tasks")))
    # Matching paths as seen by the Docker daemon (host paths). The daemon
    # resolves bind mounts itself, so runner containers need host-side paths.
    host_data_dir: Path = field(default_factory=lambda: Path(os.environ.get("SELFTEST_HOST_DATA_DIR", os.environ.get("SELFTEST_DATA_DIR", "./data"))))
    host_tasks_dir: Path = field(default_factory=lambda: Path(os.environ.get("SELFTEST_HOST_TASKS_DIR", os.environ.get("SELFTEST_TASKS_DIR", "./tasks"))))
    host_runner_dir: Path = field(default_factory=lambda: Path(os.environ.get("SELFTEST_HOST_RUNNER_DIR", "./runner")))
    runner_context_dir: Path = field(default_factory=lambda: Path(os.environ.get("SELFTEST_RUNNER_CONTEXT_DIR", "./runner")))

    runner_image: str = os.environ.get("SELFTEST_RUNNER_IMAGE", "selftest-runner:local")

    daily_limit: int = _int("SELFTEST_DAILY_LIMIT", 10)
    team_tokens: dict[str, str] = field(default_factory=lambda: parse_team_tokens(os.environ.get("SELFTEST_TEAM_TOKENS", "")))
    # Local development only: with no SELFTEST_TEAM_TOKENS, accept any token
    # string as its own team id. Off unless explicitly enabled, so a server
    # deployed without tokens refuses requests instead of trusting any caller.
    allow_any_token: bool = field(default_factory=lambda: os.environ.get("SELFTEST_ALLOW_ANY_TOKEN", "0") == "1")
    # "public": owning team sees per-test titles, errors, screenshots, logs.
    # "hidden": owning team sees only status and pass counts.
    visibility: str = field(default_factory=lambda: os.environ.get("SELFTEST_VISIBILITY", "public"))

    # Pluggable auth (server/app/auth.py): "token" (default, SELFTEST_TEAM_TOKENS),
    # "hmac" (signed/expiring token, SELFTEST_TEAM_SECRETS), or "sso" (bring
    # your own Authenticator — see auth.build_authenticator).
    auth_mode: str = os.environ.get("SELFTEST_AUTH_MODE", "token")
    team_secrets: dict[str, str] = field(default_factory=lambda: parse_team_secrets(os.environ.get("SELFTEST_TEAM_SECRETS", "")))

    max_zip_mb: int = _int("SELFTEST_MAX_ZIP_MB", 50)
    max_zip_files: int = _int("SELFTEST_MAX_ZIP_FILES", 2000)
    max_unzipped_mb: int = _int("SELFTEST_MAX_UNZIPPED_MB", 200)

    # app_port and build/ready/run timeouts are per-task (requirements.yaml),
    # not global, so both channels read the same per-task knobs.
    job_workers: int = _int("SELFTEST_JOB_WORKERS", 1)
    # Submissions queued beyond this (including the ones currently running)
    # are rejected with 503 rather than growing an unbounded in-memory queue.
    job_queue_max: int = _int("SELFTEST_JOB_QUEUE_MAX", 100)

    # How long finished submissions (zip, extracted source, results, logs)
    # are kept before a periodic sweep deletes them. 0 disables the sweep.
    retention_hours: int = _int("SELFTEST_RETENTION_HOURS", 24 * 30)

    log_level: str = os.environ.get("SELFTEST_LOG_LEVEL", "INFO")
    log_format: str = os.environ.get("SELFTEST_LOG_FORMAT", "text")  # "text" | "json"

    # Build-time isolation for submitted apps.
    build_network: str = os.environ.get("SELFTEST_BUILD_NETWORK", "none")

    # Run-time isolation and resource limits for submitted apps.
    app_mem: str = os.environ.get("SELFTEST_APP_MEM", "512m")
    app_cpus: float = _float("SELFTEST_APP_CPUS", 1.0)
    app_pids: int = _int("SELFTEST_APP_PIDS", 256)
    app_read_only: bool = os.environ.get("SELFTEST_APP_READ_ONLY", "1") != "0"
    run_network_internal: bool = os.environ.get("SELFTEST_RUN_NETWORK_INTERNAL", "1") != "0"

    # Scoped per deployment (defaults to this container's hostname) so two
    # instances sharing one Docker daemon — e.g. a second checkout of this
    # same project — can't have their startup janitor() sweep each other's
    # in-flight containers; a bare "selftest.managed" label key would match
    # across deployments since Docker labels aren't namespaced by project.
    label: str = os.environ.get("SELFTEST_LABEL", f"selftest.managed.{socket.gethostname()}")

    def resolve(self) -> "Config":
        self.data_dir.mkdir(parents=True, exist_ok=True)
        return self


def load() -> Config:
    return Config().resolve()
