"""Configuration for the self-test service. Everything is env-driven."""

from __future__ import annotations

import os
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


@dataclass(frozen=True)
class Config:
    # Paths inside this process (container paths when running under compose).
    data_dir: Path = field(default_factory=lambda: Path(os.environ.get("SELFTEST_DATA_DIR", "./data")))
    pack_dir: Path = field(default_factory=lambda: Path(os.environ.get("SELFTEST_TEST_PACK_DIR", "./examples/tests")))
    # Matching paths as seen by the Docker daemon (host paths). The daemon
    # resolves bind mounts itself, so runner containers need host-side paths.
    host_data_dir: Path = field(default_factory=lambda: Path(os.environ.get("SELFTEST_HOST_DATA_DIR", os.environ.get("SELFTEST_DATA_DIR", "./data"))))
    host_pack_dir: Path = field(default_factory=lambda: Path(os.environ.get("SELFTEST_HOST_PACK_DIR", os.environ.get("SELFTEST_TEST_PACK_DIR", "./examples/tests"))))
    host_runner_dir: Path = field(default_factory=lambda: Path(os.environ.get("SELFTEST_HOST_RUNNER_DIR", "./runner")))
    runner_context_dir: Path = field(default_factory=lambda: Path(os.environ.get("SELFTEST_RUNNER_CONTEXT_DIR", "./runner")))

    runner_image: str = os.environ.get("SELFTEST_RUNNER_IMAGE", "selftest-runner:local")
    app_port: int = _int("SELFTEST_APP_PORT", 3000)

    daily_limit: int = _int("SELFTEST_DAILY_LIMIT", 10)
    team_tokens: dict[str, str] = field(default_factory=lambda: parse_team_tokens(os.environ.get("SELFTEST_TEAM_TOKENS", "")))

    max_zip_mb: int = _int("SELFTEST_MAX_ZIP_MB", 50)
    max_zip_files: int = _int("SELFTEST_MAX_ZIP_FILES", 2000)

    build_timeout_s: int = _int("SELFTEST_BUILD_TIMEOUT_S", 600)
    ready_timeout_s: int = _int("SELFTEST_READY_TIMEOUT_S", 60)
    run_timeout_s: int = _int("SELFTEST_RUN_TIMEOUT_S", 900)
    job_workers: int = _int("SELFTEST_JOB_WORKERS", 1)

    # Build-time isolation for submitted apps.
    build_network: str = os.environ.get("SELFTEST_BUILD_NETWORK", "none")

    # Run-time isolation and resource limits for submitted apps.
    app_mem: str = os.environ.get("SELFTEST_APP_MEM", "512m")
    app_cpus: float = _float("SELFTEST_APP_CPUS", 1.0)
    app_pids: int = _int("SELFTEST_APP_PIDS", 256)
    app_read_only: bool = os.environ.get("SELFTEST_APP_READ_ONLY", "1") != "0"
    run_network_internal: bool = os.environ.get("SELFTEST_RUN_NETWORK_INTERNAL", "1") != "0"

    label: str = "selftest.managed"

    def resolve(self) -> "Config":
        self.data_dir.mkdir(parents=True, exist_ok=True)
        return self


def load() -> Config:
    return Config().resolve()
