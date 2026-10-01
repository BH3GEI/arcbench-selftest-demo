"""Thin wrappers over the Docker SDK. Everything the evaluator creates is
labeled `selftest.managed=<job_id>` so cleanup is reliable, including after a
crash: `janitor` removes leftovers on startup."""

from __future__ import annotations

import logging
import subprocess
import time
from pathlib import Path

import docker
from docker.errors import ImageNotFound, NotFound
from docker.types import LogConfig

from .config import Config

log = logging.getLogger("selftest.docker")

# Bounded on-disk container logs, so a submission that floods stdout cannot
# fill the host disk or blow up the server when the log is read back.
CAPPED_LOGS = LogConfig(type=LogConfig.types.JSON, config={"max-size": "10m", "max-file": "1"})
# Default Docker capabilities a web app does not need.
APP_CAP_DROP = ["NET_RAW", "MKNOD", "SYS_CHROOT", "AUDIT_WRITE", "SETFCAP"]


class BuildError(Exception):
    pass


class DockerOps:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.client = docker.from_env()

    # ------------------------------------------------------------------ images
    def ensure_runner_image(self) -> None:
        """Build the runner image from the runner/ context if it is missing,
        so `docker compose up --build` is the only command needed."""
        try:
            self.client.images.get(self.cfg.runner_image)
            return
        except ImageNotFound:
            pass
        ctx = Path(self.cfg.runner_context_dir)
        if not (ctx / "Dockerfile").is_file():
            raise BuildError(
                f"runner image {self.cfg.runner_image!r} not found and no build context at {ctx} "
                "(set SELFTEST_RUNNER_IMAGE to a pre-built image or mount ./runner)"
            )
        log.info("building runner image %s from %s", self.cfg.runner_image, ctx)
        self.build_image(ctx, self.cfg.runner_image, network_mode=None, timeout_s=1800)

    def build_image(self, context: Path, tag: str, network_mode: str | None, timeout_s: int,
                    mem_limit: str | None = None, cpus: float | None = None) -> None:
        """Shells out to the `docker` CLI rather than the SDK's
        `images.build()`: that call already blocks until the daemon finishes
        the *entire* build before returning anything to iterate, so checking
        elapsed time against the returned log lines never actually stops a
        build that's still running — only our own wait for it. A real
        subprocess with `timeout=` kills the CLI client on expiry, which
        drops its connection to the daemon and aborts the build with it, the
        same mechanism `actions/template/scripts/grade.sh` already relies on
        (`timeout "$BUILD_TIMEOUT_S" docker build ...`)."""
        cmd = ["docker", "build", "--rm", "--force-rm", "-t", tag]
        if network_mode:
            cmd.append(f"--network={network_mode}")
        if mem_limit:
            cmd += [f"--memory={mem_limit}", f"--memory-swap={mem_limit}"]
        if cpus:
            cmd += ["--cpu-period=100000", f"--cpu-quota={int(cpus * 100000)}"]
        cmd += ["--label", f"{self.cfg.label}=build", str(context)]
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_s)
        except subprocess.TimeoutExpired as exc:
            raise BuildError(f"docker build exceeded {timeout_s}s") from exc
        except OSError as exc:
            raise BuildError(f"could not run docker build: {exc}") from exc
        if proc.returncode != 0:
            raise BuildError((proc.stderr or proc.stdout or "docker build failed").strip()[-2000:])

    # ------------------------------------------------------------------ networks
    def create_network(self, name: str, job_id: str) -> str:
        net = self.client.networks.create(
            name,
            driver="bridge",
            internal=self.cfg.run_network_internal,  # internal = no outbound internet
            labels={self.cfg.label: job_id},
        )
        return net.id

    # ------------------------------------------------------------------ containers
    def run_app(self, image: str, name: str, network: str, job_id: str, app_port: int):
        cfg = self.cfg
        # containers.run()'s `network=` + `networking_config=` combo silently
        # drops the alias on this docker-py version (the container connects
        # with Aliases: None) — create unattached, then explicitly connect to
        # the job's network with the "app" alias the Playwright runner
        # resolves, matching the GitHub Actions grader's
        # `docker run --network-alias app`.
        container = self.client.containers.create(
            image,
            name=name,
            environment={"PORT": str(app_port)},
            mem_limit=cfg.app_mem,
            memswap_limit=cfg.app_mem,
            nano_cpus=int(cfg.app_cpus * 1e9),
            pids_limit=cfg.app_pids,
            read_only=cfg.app_read_only,
            tmpfs={"/tmp": "rw,noexec,size=64m"} if cfg.app_read_only else None,
            security_opt=["no-new-privileges"],
            cap_drop=APP_CAP_DROP,
            log_config=CAPPED_LOGS,
            labels={cfg.label: job_id},
        )
        self.client.networks.get(network).connect(container, aliases=["app"])
        try:
            self.client.networks.get("bridge").disconnect(container, force=True)
        except Exception:
            pass  # no default bridge attachment to remove
        container.start()
        container.reload()
        return container

    def run_runner(self, name: str, network: str, job_id: str, base_url: str,
                   host_pack_dir: Path, host_results_dir: Path,
                   ready_timeout_s: int, run_timeout_s: int) -> tuple[int, str]:
        """Run the Playwright runner to completion. Returns (exit_code, logs)."""
        cfg = self.cfg
        container = self.client.containers.run(
            cfg.runner_image,
            detach=True,
            name=name,
            network=network,
            environment={
                "BASE_URL": base_url,
                "READY_TIMEOUT": str(ready_timeout_s),
            },
            volumes={
                str(host_pack_dir): {"bind": "/pack", "mode": "ro"},
                str(host_results_dir): {"bind": "/results", "mode": "rw"},
            },
            mem_limit="2g",
            nano_cpus=int(2 * 1e9),
            pids_limit=1024,
            security_opt=["no-new-privileges"],
            log_config=CAPPED_LOGS,
            labels={cfg.label: job_id},
        )
        deadline = time.monotonic() + run_timeout_s
        while True:
            container.reload()
            if container.status != "running":
                break
            if time.monotonic() > deadline:
                log.warning("runner %s exceeded %ss, killing", name, run_timeout_s)
                try:
                    container.kill()
                except Exception:
                    pass
                return 124, f"runner exceeded {run_timeout_s}s and was killed"
            time.sleep(1)
        logs = container.logs(tail=5000).decode("utf-8", errors="replace")
        exit_code = int(container.attrs["State"].get("ExitCode", 1))
        try:
            container.remove(force=True)
        except Exception:
            pass
        return exit_code, logs

    def container_logs(self, container) -> str:
        try:
            return container.logs(tail=5000).decode("utf-8", errors="replace")
        except Exception as exc:
            return f"<could not read app logs: {exc}>"

    # ------------------------------------------------------------------ cleanup
    def remove_image(self, tag: str) -> None:
        """Drop a submission's app image so built layers do not pile up on disk."""
        try:
            self.client.images.remove(tag, force=True)
        except Exception:
            pass

    def cleanup_job(self, job_id: str) -> None:
        for c in self.client.containers.list(all=True, filters={"label": f"{self.cfg.label}={job_id}"}):
            try:
                c.remove(force=True)
            except Exception:
                pass
        for n in self.client.networks.list(filters={"label": f"{self.cfg.label}={job_id}"}):
            try:
                n.remove()
            except Exception:
                pass

    def janitor(self) -> None:
        """Remove leftovers from earlier runs (e.g. after a service restart)."""
        try:
            for c in self.client.containers.list(all=True, filters={"label": self.cfg.label}):
                try:
                    c.remove(force=True)
                except Exception:
                    pass
            for n in self.client.networks.list(filters={"label": self.cfg.label}):
                try:
                    n.remove()
                except NotFound:
                    pass
                except Exception:
                    pass
            self.client.images.prune(filters={"label": self.cfg.label})
        except Exception as exc:
            log.warning("janitor failed: %s", exc)
