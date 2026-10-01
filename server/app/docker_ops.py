"""Thin wrappers over the Docker SDK. Everything the evaluator creates is
labeled `selftest.managed=<job_id>` so cleanup is reliable, including after a
crash: `janitor` removes leftovers on startup."""

from __future__ import annotations

import logging
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

    def build_image(self, context: Path, tag: str, network_mode: str | None, timeout_s: int) -> None:
        started = time.monotonic()
        try:
            _, logs = self.client.images.build(
                path=str(context),
                tag=tag,
                rm=True,
                forcerm=True,
                network_mode=network_mode,
                labels={self.cfg.label: "build"},
            )
            for chunk in logs:
                if time.monotonic() - started > timeout_s:
                    raise BuildError(f"docker build exceeded {timeout_s}s")
                if "error" in chunk:
                    raise BuildError(str(chunk["error"])[:500])
        except BuildError:
            raise
        except Exception as exc:  # docker.errors.BuildError and friends
            raise BuildError(str(exc)[:500]) from exc

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
    def run_app(self, image: str, name: str, network: str, job_id: str):
        cfg = self.cfg
        return self.client.containers.run(
            image,
            detach=True,
            name=name,
            network=network,
            # docker-py has no network_aliases kwarg; aliases go through
            # the endpoint config of the network being joined.
            networking_config={network: self.client.api.create_endpoint_config(aliases=["app"])},
            environment={"PORT": str(cfg.app_port)},
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

    def run_runner(self, name: str, network: str, job_id: str, base_url: str,
                   host_pack_dir: Path, host_results_dir: Path) -> tuple[int, str]:
        """Run the Playwright runner to completion. Returns (exit_code, logs)."""
        cfg = self.cfg
        container = self.client.containers.run(
            cfg.runner_image,
            detach=True,
            name=name,
            network=network,
            environment={
                "BASE_URL": base_url,
                "READY_TIMEOUT": str(cfg.ready_timeout_s),
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
        deadline = time.monotonic() + cfg.run_timeout_s
        while True:
            container.reload()
            if container.status != "running":
                break
            if time.monotonic() > deadline:
                log.warning("runner %s exceeded %ss, killing", name, cfg.run_timeout_s)
                try:
                    container.kill()
                except Exception:
                    pass
                return 124, f"runner exceeded {cfg.run_timeout_s}s and was killed"
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
