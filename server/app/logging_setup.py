"""Structured (JSON) or plain-text logging for the whole process, selected by
SELFTEST_LOG_FORMAT/SELFTEST_LOG_LEVEL. Call `configure()` once, before
anything else logs, so every `logging.getLogger(...)` call elsewhere in the
app (main/jobs/runner/docker_ops/store) goes through the same handler."""

from __future__ import annotations

import json
import logging
import sys
import time

from .config import Config


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(record.created)),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        if record.exc_info:
            payload["exc_info"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False)


def configure(cfg: Config) -> None:
    handler = logging.StreamHandler(sys.stdout)
    if cfg.log_format == "json":
        handler.setFormatter(JsonFormatter())
    else:
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    root = logging.getLogger()
    root.handlers = [handler]
    try:
        root.setLevel(cfg.log_level.upper())
    except ValueError:
        root.setLevel(logging.INFO)
        logging.getLogger("selftest").warning("invalid SELFTEST_LOG_LEVEL %r, defaulting to INFO", cfg.log_level)
