# Server ↔ Actions parity

Goal: the local docker-compose server (`server/`, `cli/`, `runner/`) and the
GitHub Actions grader template (`actions/template/`) grade the same task the
same way, differing only in *where* the containers run. This doc is the
reference for both channels; `server-docs` (prose docs, README updates)
should link here rather than duplicate the table.

## 1. What changed, by requirement

| # | Requirement | Before | After |
|---|---|---|---|
| 1 | Shared task format | Server had **no task concept** — one global example pack (`examples/tests`) baked into `Config`. Actions already used `tasks/<task_id>/{requirements/requirements.yaml,tests/}`. | Server now loads tasks from the **same directory shape** Actions uses. Concretely: `actions/template/tasks/` is the real, portable directory (self-contained — this is what gets copied into a new private grader repo per `README_ACTIONS.md` step 2); a root-level `tasks` symlink (`tasks -> actions/template/tasks`) lets the server read it directly with zero duplication. An arcbench task folder dropped into `actions/template/tasks/<id>/` is immediately usable by **both** channels. |
| 2 | Visibility (`public`/`hidden`) | Server always returned the full result (tests, logs, pack_hash, timings) to the submitting team. | Each task's `requirements.yaml` sets `visibility`. The server's `/api/submissions/{id}` response filters the stored result through the same `apply_visibility()` function the logic is specified in (`common/resultshape.py`): **hidden tasks get exactly `{status, passed, total}`**, nothing else. `logs/{kind}` and `artifact` endpoints additionally 403 outright for hidden tasks (no titles, no error text, no screenshots — stricter than Actions needs to be since Actions never persists those behind an API in the first place). |
| 3 | App / Playwright container separation | Already correct in both channels — not changed in shape, only fixed to actually work (see §3 below). | App container: `--network=none` build, isolated internal network, no test-pack mount, only `BASE_URL` reachable from the runner. Playwright container: mounted with the task's `tests/` **read-only**, created and started only *after* the app container exists. Identical sequencing to `scripts/grade.sh`. |
| 4 | Timeouts / resource limits / quota | Server's build/ready/run timeouts and `app_port` were **global config**, not per-task. | `build_timeout_s`, `ready_timeout_s`, `run_timeout_s`, `app_port` now come from the task's `requirements.yaml` via `common/taskspec.py`, same fields `grade.sh` reads. Resource caps (`--memory=512m --cpus=1.0 --pids-limit=256` for the app, `2g`/`2.0` for the runner) were already numerically identical between `docker_ops.py` and `grade.sh`; unchanged. Quota (`server/app/quota.py`) is unchanged and, per `README_ACTIONS.md`'s architecture, is the gate the (hypothetical) dispatch-to-Actions path reuses before ever calling the grader repo — there is nothing Actions-side to duplicate. |
| 5 | Shared module (zip safety, result parsing, visibility, task loading) | Server and Actions each had their own zip-validation and Playwright-report-walking code, independently written and subtly different (see bug list below). | `actions/template/common/` (stdlib-only Python) is the single implementation; `server/app/validate.py`, `server/app/runner.py`, `server/app/jobs.py`, `server/app/main.py` import it directly (root `common` symlink), and `actions/template/scripts/{safe_unzip,parse_report}.py` + `scripts/grade.sh` (task lookup) call the same functions. See §2. |

## 2. The shared `common/` module

Real files live at `actions/template/common/` (so the Actions grader template
stays self-contained/portable when copied into a new private repo per
`README_ACTIONS.md` step 2); a `common` symlink at the repo root lets the
server import the identical module with no copy-paste.

- **`taskspec.py`** — flat `requirements.yaml` parser + `TaskSpec` (task_id,
  visibility, app_port, build/ready/run timeouts, tests_dir). `load_task()`
  is called directly from Python (`server/app/jobs.py`, `server/app/runner.py`);
  `scripts/grade.sh` shells out to it via `python3 -m common.taskspec <tasks_dir> <task_id>`,
  which prints `KEY=value` lines for `eval`.
- **`zipsafety.py`** — path-traversal/symlink/file-count/size checks plus
  optional Dockerfile-at-root enforcement. `server/app/validate.py` wraps it
  (keeping its existing `ValidationError` type so no caller changed);
  `scripts/safe_unzip.py` is now a 15-line CLI shim over the same function.
- **`resultshape.py`** — `walk_report()` flattens a Playwright JSON report
  into `{title, ok, error, screenshot}` dicts (the version proven correct by
  `tests/test_report.py`'s fixtures was kept as the canonical one — the two
  channels' pre-existing implementations actually disagreed subtly on how a
  spec's pass/fail was derived; see bug list). `apply_visibility(result,
  visibility, always_keep=...)` is the one visibility filter both channels
  call: the server uses it with no extra keys (→ strict `{status, passed,
  total}`), Actions' `parse_report.py` calls it with
  `always_keep=("submission_id","task_id","visibility","detail")` to keep its
  existing (slightly richer) hidden shape unchanged.

## 3. Bugs found and fixed while making the server channel actually run

None of these are part of the "make it match Actions" scope by themselves,
but the server channel never actually worked end-to-end via Docker before
this pass (only unit-tested with a fake evaluator), so they blocked
verification and are worth a maintainer's attention:

- **`docker_ops.py` `run_app`**: `containers.run(network=..., network_aliases=["app"])`
  is not a valid docker-py kwarg (raises `TypeError`); `network=` +
  `networking_config=` together silently drop the alias on this docker-py
  version. Fixed by `create()` + explicit `network.connect(container,
  aliases=["app"])` + disconnect-default-bridge + `start()` — verified against
  a plain `docker run --network-alias app` control.
- **`runner.py` `evaluate()`**: the results directory passed to the sibling
  Playwright container's bind mount was the **server container's own**
  path (`/data/results/<id>`), not the Docker **host**'s path — works by
  coincidence with a fake evaluator in tests, fails for real (`report.json`
  written to the wrong physical directory) whenever the server itself runs
  in its own container with the host's Docker socket mounted, which is
  this project's whole deployment model. Fixed by computing
  `host_data_dir / results_dir.relative_to(data_dir)`, mirroring the
  existing `host_tasks_dir` pattern.
- **Cross-deployment janitor collision**: `DockerOps.janitor()` (startup
  cleanup) filtered by a bare `"selftest.managed"` label key. Two
  deployments of this same project sharing one Docker daemon (e.g. two
  checkouts under active development on the same machine) would each sweep
  the other's in-flight containers. Labels are now scoped by hostname by
  default (`SELFTEST_LABEL`, defaults to `selftest.managed.<hostname>`) —
  confirmed as the cause of an in-flight job losing its runner container
  mid-grade during this verification pass.

## 4. Production-readiness additions

- **Config**: every new knob above is env-driven with an in-code default;
  `.env.example` documents all of them (auth, quota, tasks dir, queue
  limits, retention, logging, labels).
- **Pluggable auth** (`server/app/auth.py`): `Authenticator` protocol.
  `token` (default, `SELFTEST_TEAM_TOKENS`) and `hmac` (signed/expiring
  `team.timestamp.signature`, `SELFTEST_TEAM_SECRETS`) ship built in;
  `SELFTEST_AUTH_MODE=sso` is a documented extension point
  (`build_authenticator()`), not a stub that silently no-ops.
- **Quota**: unchanged, already SQLite-backed (`server/app/quota.py`).
- **Job queue & concurrency**: `JobService` now tracks in-flight submissions
  and rejects new ones with HTTP 503 past `SELFTEST_JOB_QUEUE_MAX` instead of
  growing an unbounded queue; `SELFTEST_JOB_WORKERS` (unchanged) bounds
  concurrent builds.
- **Cleanup / retention**: container/network/image cleanup was already
  present (`DockerOps.cleanup_job`/`janitor`); added a `SELFTEST_RETENTION_HOURS`
  sweep (hourly background thread, `Store.sweep_expired`) that deletes
  finished submissions' zip/source/results/logs past the retention window —
  in-flight submissions are never swept regardless of age.
- **Structured logging & health**: `SELFTEST_LOG_FORMAT=json` (`server/app/logging_setup.py`)
  for machine-parseable logs; `GET /api/health` stays a fast liveness check,
  `GET /api/health?deep=true` additionally pings the Docker daemon the
  evaluator depends on, for an orchestrator readiness probe.
- **compose.yml**: added `mem_limit`/`cpus` on the server service, a
  `healthcheck`, and an optional `proxy` service (Caddy, behind
  `--profile proxy`) for HTTPS termination. `restart: unless-stopped` and the
  data volumes were already present.
- **HTTPS reverse proxy examples**: `deploy/Caddyfile` (wired into
  `compose.yml`'s `proxy` profile, automatic Let's Encrypt) and
  `deploy/nginx.conf.example` (bring your own certs) — both set generous
  body-size and timeout limits since submissions are zip uploads and
  grading runs can take minutes.

## 5. Verification

Ran against the live server channel (`docker build` + `docker run`, no
`docker compose` plugin available in this environment, equivalent flags),
all against the shared `tasks/demo-todo` (5 tests — see note below) and
`tasks/demo-todo-hidden` (same tests, `visibility: hidden`):

| App | Task | Expected | Got |
|---|---|---|---|
| `examples/app-todo` (good) | `demo-todo` (public) | all pass | **5/5 passed**, `pass_rate=100.0` |
| `examples/app-todo-broken` | `demo-todo` (public) | mostly fail | **1/5 passed**, per-test error text present (e.g. `Test timeout of 60000ms exceeded.`) |
| `examples/app-todo-partial` | `demo-todo` (public) | 60% | **3/5 passed, pass_rate=60.0** |
| `examples/app-todo` (good) | `demo-todo-hidden` (hidden) | `{status,passed,total}` only | `{"status":"done","passed":5,"total":5}` — no `tests`, no `pack_hash`, no logs; `GET .../logs/app` → **404** |

This matches the Actions channel's own verified-run pattern in
`actions/README_ACTIONS.md` (good app all-pass, broken app mostly-fail with
error text, hidden task reduced to pass/total) using the same test pack.

**Note on the test pack**: `tasks/demo-todo` was unified to the full 5-test
pack (`examples/tests/todo.spec.js`'s tests, same conventions, `.ts` instead
of `.js`) that the local channel's own demo story (`scripts/e2e-demo.sh`,
`examples/app-todo-partial`) was already built around — rather than the
4-test subset the Actions template previously shipped. This is why the
numbers above (5/5, 1/5, 3/5) differ from the 4/4, 1/4 pair recorded as a
historical Actions run in `README_ACTIONS.md`'s "Verified run" section; that
section documents a real run against the pre-unification pack and is a
historical record, not a live assertion — `server-docs` may want to add a
note there rather than rewrite it.

## 6. Merged with concurrent security-hardening work

A separate pass landed on `main` while this work was in progress (commit
`c924aef` and the Actions-side HMAC-dispatch/retry/import-task commits) and
had to be reconciled via rebase. Where both touched the same concern, this is
what survived and why:

- **Network alias wiring**: that pass found and fixed the same docker-py bug
  independently (`networking_config` passed directly to `containers.run()`).
  This branch keeps the `create()` + explicit `network.connect(..., aliases=["app"])`
  + disconnect-default-bridge approach instead, because it's the one verified
  against a live `docker run --network-alias app` control during this pass's
  Docker-based verification (§3) — the inline `networking_config` form was
  never confirmed to actually set the alias on this docker-py version.
- **Visibility**: that pass added a single global `SELFTEST_VISIBILITY`
  config value. This branch's per-task `requirements.yaml` visibility (§1)
  is the one kept — a global switch can't express "task A is public, task B
  is hidden," which is what both the lead's requirement and arcbench's own
  task format need. `apply_visibility()` still masks hidden results to
  exactly `{status, passed, total}`.
- **Everything orthogonal was kept from both sides**: dev-mode auth gated
  behind `SELFTEST_ALLOW_ANY_TOKEN` (rather than always trusting an
  unconfigured server), screenshot-artifact serving restricted to paths
  literally named in the result plus an image-extension allowlist (not just
  "under the results dir"), a dual zip-size cap (compressed upload size +
  uncompressed zip-bomb check, both now in `common/zipsafety.py`), streamed
  upload reads with an early cutoff, container hardening
  (`no-new-privileges`, capability drops, capped log size), rejected-upload
  cleanup (no orphaned `app.zip` on disk), and `X-Content-Type-Options:
  nosniff` on served files. Hidden-task log/artifact denials were
  standardized on HTTP 404 (not 403) to match that pass's existing tests and
  its "never reveal why" pattern.

`server-docs` should also refresh `server/README_SERVER.md` — it still
describes the pre-task-format flow (`SELFTEST_TEST_PACK_DIR`, no `task_id`
in the submit example) and needs the task-based flow from §1 above.
