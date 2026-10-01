# Docker compose server

The self-hosted evaluation channel for the self-test demo: one long-running
service you deploy and operate yourself, instead of dispatching runs to a
separate GitHub Actions repo (also available, see the repo's root README, as
an alternative for anyone who doesn't want to run their own server).
Everything — HTTP API, queue, quota, Docker-in-Docker build/run, result
storage — lives in this one process plus its sibling containers.

Nothing in `server/`, `cli/`, or `runner/` is task content for a real
competition — the `examples/` apps and `examples/tests` pack are the same
demo fixtures `actions/`'s `demo-todo` task reuses, just run directly instead
of through a separate repo's workflow.

## Why run your own server

A long-lived process gives you a persistent HTTP API, a results database,
and direct control over build/run isolation without depending on a third
party's CI product. It's the right fit when you already operate
infrastructure and want one service to own quota, auth, and results
end-to-end, or when you need the service always listening instead of
triggered per submission.

## Architecture

```
participant uploads app.zip (Dockerfile at root)
        |
        v
POST /api/submissions (multipart, X-Team-Token header)
        |  server/app/validate.py: size cap, file-count cap, Dockerfile present
        |  server/app/quota.py: per-team daily limit, atomic consume
        v
JobService (server/app/jobs.py) queues the job, SELFTEST_JOB_WORKERS workers drain it
        |
        +-- DockerOps.build_image   docker build --network=none   (app image, isolated build)
        +-- DockerOps.run_app       internal-only network, PORT injected, resource caps
        +-- runner/wait-ready.mjs   poll until the app answers, or READY_TIMEOUT
        +-- DockerOps.run_runner    Playwright container, same internal network,
        |                           BASE_URL=http://app:<port> is the only thing it can reach.
        |                           Test pack (SELFTEST_TEST_PACK_DIR) mounted read-only.
        +-- parse_playwright_report(report.json) -> EvalResult
        +-- store.py persists result + logs under SELFTEST_DATA_DIR
        +-- janitor() removes containers/networks by label on startup and after each job
```

Participants (or the `cli/selftest.py` CLI) poll
`GET /api/submissions/{id}` for status and the parsed result; logs and
artifacts are fetched through separate endpoints scoped to the owning team.

## Setting up the server

1. Clone this repo and `cd` into it.
2. Create a `.env` (or export the vars directly) with at least one team
   token:
   ```
   SELFTEST_TEAM_TOKENS=team-a=token-a,team-b=token-b
   SELFTEST_DAILY_LIMIT=10
   ```
3. `docker compose up --build` — first run also builds the Playwright
   runner image (`runner/Dockerfile`); later runs reuse it unless the
   Dockerfile changes. The server listens on `:8080` and mounts
   `/var/run/docker.sock` to launch sibling containers for each submission.
4. Check it's up: `curl http://127.0.0.1:8080/api/health` -> `{"ok": true}`.
5. From the host (not inside the server container), submit with the CLI:
   ```
   python3 cli/selftest.py --token token-a submit examples/app-todo --wait
   ```
   or walk through all four demo scenarios at once with
   `scripts/e2e-demo.sh`.

No separate repo or external CI account is needed — the server, the queue,
and the result store are all this one stack.

## Importing an arcbench task

The demo ships with a single built-in test pack
(`SELFTEST_TEST_PACK_DIR`, default `examples/tests`) rather than a
per-task folder convention, so "importing a task" means pointing that
variable at an arcbench test pack and, if you want the same request/response
shape arcbench expects, wiring in the real runner:

1. Copy an arcbench task's `tests/*.spec.ts` (plus any shared fixtures) into
   a directory on the host, e.g. `packs/<task_id>/`.
2. Point the server at it before `docker compose up`:
   ```
   SELFTEST_HOST_PACK_DIR=$PWD/packs/<task_id> \
   SELFTEST_TEST_PACK_DIR=/pack \
   docker compose up --build
   ```
   (`SELFTEST_HOST_PACK_DIR` is the path as the Docker daemon sees it on the
   host; `SELFTEST_TEST_PACK_DIR` is the path inside the server container —
   see `server/app/config.py`.)
3. Each result includes `pack_hash` (SHA-256 over every file's path and
   content in the pack, `server/app/packhash.py`) so a participant and the
   operator can confirm they ran the same pack.
4. To reuse arcbench's own evaluation logic (not just its test files) rather
   than this repo's reference `LocalDockerEvaluator`, set
   `SELFTEST_EVALUATOR=arcbench` and follow
   [`../INTEGRATION.md`](../INTEGRATION.md) — it maps every step of the
   `Evaluator` protocol onto `run_submission.py` and lists the env vars that
   must match the real evaluation channel (timeouts, resource limits,
   network isolation).

## Visibility

One switch per deployment (the server runs a single test pack):

- `SELFTEST_VISIBILITY=public` (default) — the owning team sees per-test
  titles, pass/fail, error text, failure screenshots, and the app/runner logs.
- `SELFTEST_VISIBILITY=hidden` — `GET /api/submissions/{id}` returns only
  `status`, `passed`/`failed`/`total`, `pass_rate`, `pack_hash`, `duration_s`;
  the log and artifact endpoints return 404.

In both modes the artifact endpoint only serves screenshots named in the
result, never `report.json` or Playwright's `output/` files.
`assert_can_view` (`server/app/auth.py`) separately ensures a team can never
see another team's submissions.

## What stays the same as the GitHub Actions channel

- **Quota**: `server/app/quota.py`'s per-team daily limit is the same logic
  `actions/README_ACTIONS.md` points to as the thing checked before a run is
  ever dispatched — there's one implementation, used directly here and by
  reference there.
- **Isolation shape**: isolated build (`--network=none`), no-network app
  container, a separate Playwright runner container reaching the app only
  via `BASE_URL`, same Playwright version pin convention as
  `runner/Dockerfile`.
- **Result shape**: `EvalResult` (status, passed/total, pass_rate, duration,
  per-test detail, log paths, `pack_hash`) is the superset the Actions
  channel's `{status, passed, total, tests?}` is derived from.

## Configuration

All environment variables, defaults, and what each maps to are listed in
`server/app/config.py`; the ones worth knowing up front:

| Variable | Default | Meaning |
|---|---|---|
| `SELFTEST_TEAM_TOKENS` | *(empty)* | `team=token,team=token` — required to authenticate any request |
| `SELFTEST_ALLOW_ANY_TOKEN` | `0` | Local development only: with no team tokens, treat any token string as its own team |
| `SELFTEST_VISIBILITY` | `public` | `hidden` returns pass counts only (see Visibility) |
| `SELFTEST_DAILY_LIMIT` | `10` | Submissions per team per day |
| `SELFTEST_APP_PORT` | `3000` | Port injected into the submitted app container |
| `SELFTEST_TEST_PACK_DIR` / `SELFTEST_HOST_PACK_DIR` | `examples/tests` | Container-side / host-side path to the Playwright test pack |
| `SELFTEST_BUILD_TIMEOUT_S` | `600` | App build timeout |
| `SELFTEST_READY_TIMEOUT_S` | `60` | How long to wait for the app to answer before giving up |
| `SELFTEST_RUN_TIMEOUT_S` | `900` | Test execution timeout |
| `SELFTEST_MAX_ZIP_MB` / `SELFTEST_MAX_ZIP_FILES` / `SELFTEST_MAX_UNZIPPED_MB` | `50` / `2000` / `200` | Upload caps enforced by `validate.py` |
| `SELFTEST_APP_MEM` / `SELFTEST_APP_CPUS` / `SELFTEST_APP_PIDS` | `512m` / `1.0` / `256` | Resource limits on the submitted app container |
| `SELFTEST_RUN_NETWORK_INTERNAL` | on | Submitted app and runner share a network with no outbound internet |
| `SELFTEST_JOB_WORKERS` | `1` | Concurrent job workers (builds are otherwise serial) |
| `SELFTEST_EVALUATOR` | `local` | Set to `arcbench` to run submissions through the real runner instead of the reference evaluator (see `INTEGRATION.md`) |

The full table, including every variable `INTEGRATION.md` cross-references
against the real arcbench runner, lives in `server/app/config.py`.

## Keeping task content off participants

- Task content here is just the test pack mounted read-only into the runner
  container (`SELFTEST_TEST_PACK_DIR`); it's never sent to the participant
  or exposed through any API route — only `report.json`'s parsed result is.
- The runner container only receives `BASE_URL`; it has no access to the
  app's source, and the app container has no access to the test pack (two
  separate containers, one shared internal-only network).
- Per-team results are isolated by `assert_can_view` — a team's token can
  only read its own submissions, logs, and artifacts.
- Because this is a single operator-run service (not a repo participants
  can be granted or denied access to), the trust boundary is "whoever can
  reach the HTTP API with a valid team token," not repo membership — keep
  `SELFTEST_TEAM_TOKENS` secret-managed the same way you'd manage any other
  service credential.

## Known limitations

- Visibility is all-or-nothing per team (see above) — no hidden/public
  split per task without adding it.
- Task packs are a single directory per deployment unless you build a
  routing layer in front of `SELFTEST_TEST_PACK_DIR`; there's no
  `tasks/<task_id>/` convention like `actions/template/` ships.
- `SELFTEST_JOB_WORKERS` > 1 runs builds concurrently on one host — make
  sure host CPU/memory and `SELFTEST_APP_PORT` collisions are accounted for
  before raising it.
- The server mounts the Docker socket to launch sibling containers, so it
  needs to run somewhere that socket access is acceptable (typically the
  same host or a dedicated build host, not a shared multi-tenant cluster
  node without additional sandboxing).
- No built-in TLS/ingress — put a reverse proxy in front for anything
  beyond local/LAN use.

## Real run results

Captured 2026-10-01 on a local deployment (colima, Docker 29.5.2, arm64),
pack `examples/tests/` (5 tests, hash `4fdf3851aac8655e…`), daily limit set
to 3 to demo the rejection path. Each row is one
`cli/selftest.py submit <app> --wait` with token `demo-token`:

| Scenario | Submission | Result | Exit code | Notes |
|---|---|---|---|---|
| Healthy app | `examples/app-todo` | **5/5 passed, 100%**, 4.7s | 0 | per-test PASS lines, status `done` |
| Broken app | `examples/app-todo-broken` | **1/5 passed, 20%**, 244s | 1 | 4 failures, each with error text + failure screenshot (mislabeled button, tests hit the 60s timeout as expected) |
| Partially finished app | `examples/app-todo-partial` | **3/5 passed, 60.0%**, 68.9s | 1 | passes heading/add+persist/multi-persist; fails empty-title error text and unimplemented delete |
| Over-quota | 4th submission of the day | **HTTP 429** | 1 | `team 'demo' reached the daily limit of 3 submissions`; `quota` shows used=3, remaining=0 |

Failure screenshots were retrieved end-to-end through
`GET /api/submissions/{id}/artifact?path=…&token=…` (verified PNG, 1280×720);
app and runner logs are served by `GET /api/submissions/{id}/logs/app|runner`.

The quota logic is additionally covered by unit tests
(`tests/test_quota.py`: per-team independence, limit rejection, day rollover;
`tests/test_api.py` / `tests/test_api_flow.py`: HTTP-level 429 and
results visible only to the submitting team).

To reproduce: `SELFTEST_DAILY_LIMIT=3 docker compose up --build`, then
`bash scripts/e2e-demo.sh` — it runs the same four scenarios in order and
prints ok/MISS for each.
