# GitHub Actions grader

A second evaluation channel for the self-test demo, built on GitHub Actions
instead of this repo's local `docker compose` server. Task content and test
packs live in a **separate private repository**; this public repo only ships
the template used to create that private repo, plus this guide.

Nothing in `actions/` (workflow, scripts, the `demo-todo` example task) is
task content for a real competition — `demo-todo` reuses the same public
`examples/app-todo` app and test pack already in this repo, just repackaged
to prove the pipeline end to end.

## Why a separate repo

GitHub Actions logs and run pages are visible to anyone with read access to
the repo they run in. A grader that only ever runs in a **private** repo,
with no outside collaborators, keeps task statements, reference solutions,
and test assertions off anything a participant could reach. The self-test
service (or a maintainer) triggers runs there; participants never get repo
access and never see an Actions run.

## Architecture

```
participant uploads app.zip (Dockerfile at root)
        |
        v
self-test service: existing quota check (server/app/quota.py, unchanged)
        |  passes -> POST /repos/<org>/<grader-repo>/dispatches
        |  { event_type: "grade-submission",
        |    client_payload: { submission_id, task_id, download_url, callback_url? } }
        v
private grader repo: .github/workflows/grade.yml
        |
        +-- download app.zip, validate (Dockerfile present, no path escapes,
        |   size/file-count caps)
        +-- docker build --network=none         (app image, isolated build)
        +-- docker network create --internal    (no outbound internet)
        +-- docker run app container            (network alias "app")
        +-- docker build runner image (or docker pull a prebuilt one)
        +-- docker run runner container on the SAME internal network,
        |   BASE_URL=http://app:<port> — this is the only thing it can reach.
        |   Only now is the task's tests/ directory mounted (read-only) into
        |   this container. The app container never sees it; the runner
        |   container never sees the app's source.
        +-- parse report.json, apply the task's visibility setting
        +-- report back (callback URL, or a private GitHub Release in the
        |   grader repo — never the Actions log)
        +-- cleanup (containers, network, image) via a trap, always runs
```

Every step after "download" runs inside the single Actions job; nothing is
streamed to the job's public-within-the-repo log except high-level step
names. `docker run` output for the app and the Playwright pack is redirected
to files and only read back by `parse_report.py`, never printed.

## Setting up the private grader repo

1. Create a new **private** repository, e.g. `BH3GEI/arcbench-grader-demo`.
2. Copy the contents of this repo's `actions/template/` directory into the
   new repo's root and push to `main`.
3. Add repo secrets (Settings -> Secrets and variables -> Actions):
   - `SELFTEST_CALLBACK_TOKEN` — bearer token the self-test service expects
     on its results-intake endpoint. Optional: omit it and the grader falls
     back to publishing a GitHub Release (`result-<submission_id>`) with
     `result.json` as the only asset instead of calling back.
   - `APP_DOWNLOAD_TOKEN` — only if submitted app zips are stored somewhere
     that needs a bearer token to download (sent as `Authorization: Bearer`).
     Leave unset for plain pre-signed URLs.
4. On the self-test service side (not in this repo): a GitHub App or PAT
   with `repo` scope on the grader repo, used only to call the
   `POST /repos/<org>/<grader-repo>/dispatches` API. This credential lives on
   the service, not in the grader repo, and participants never see it.
5. Trigger a run either by having the self-test service call the dispatch
   API above, or manually via `gh workflow run grade.yml -f
   submission_id=... -f task_id=... -f download_url=...` for testing.

## Importing an arcbench task

Task folders use the same shape as arcbench already does — copy one in
as-is, no reformatting:

```
tasks/<task_id>/
  requirements/
    requirements.yaml   # flat key: value — see demo-todo for the fields read
    requirements.md
    reference/           # optional, not read by the grader
    assets/               # optional, not read by the grader
  tests/
    *.spec.ts
```

Steps:

1. `cp -r <arcbench-task-folder> tasks/<task_id>` in the grader repo.
2. Make sure `requirements.yaml` is a **flat** `key: value` list (the grader
   parses it with `grep`/`cut`, not a YAML library, to avoid extra installs
   on the runner) with at least `visibility: public` or `visibility:
   hidden`. Copy the other fields from `tasks/demo-todo/requirements/requirements.yaml`
   (`app_port`, `build_timeout_s`, `ready_timeout_s`, `run_timeout_s`) and
   adjust per task if needed — if your arcbench `requirements.yaml` is
   nested, flatten just these fields into a sibling file or swap
   `scripts/grade.sh`'s `req()` lookup for a real YAML parser (`pip install
   pyyaml` in a setup step).
3. `git add tasks/<task_id> && git commit && git push`.
4. Trigger a run with that `task_id` to confirm it grades.

Nothing else changes — `requirements.md`, `reference/`, `assets/` are carried
along for human reference but are not read by the grader itself; only
`requirements.yaml` and `tests/*.spec.ts` are.

## Visibility

Set in each task's `requirements.yaml`:

- `visibility: public` — the result includes per-test titles and pass/fail,
  plus one error message per failing test. No screenshots are produced by
  this template (the local demo does for its own channel; add an artifact
  upload step here if you want the same for Actions).
- `visibility: hidden` — the result is reduced to `{status, passed, total}`
  only. No titles, no error text.

`workflow_dispatch` also accepts `visibility_override` to exercise either
path without editing a task's file — intended for testing the grader itself,
not for production use (`repository_dispatch` payloads should rely on the
task's own setting).

## What stays the same as the local channel

- **Quota**: unchanged. The self-test service's existing per-team daily
  limit (`server/app/quota.py`) is checked before a submission is ever
  dispatched to Actions; the grader repo has no quota logic of its own.
- **Isolation shape**: isolated build, no-network app container, a separate
  test runner container reaching the app only via `BASE_URL`, same Playwright
  version pin as `runner/Dockerfile` in this repo.
- **Result shape**: `{status, passed, total, tests?}` — a subset of this
  repo's `EvalResult` tailored to what a visibility-aware caller needs.

## Known limitations

- The Playwright runner image is built fresh each run (~1-2 min) unless
  `GRADER_RUNNER_IMAGE` is set to a prebuilt image reference (push one to
  GHCR once per Playwright version bump and set that env in the workflow).
- `requirements.yaml` parsing is intentionally flat-only; nested arcbench
  configs need the parser swap noted above.
- No automatic screenshot-on-failure artifact upload in this template (the
  report still includes the error message for `visibility: public` tasks).
- A repo collaborator with write/read access to the grader repo can still
  see task content and run results directly — the isolation here is "no
  participant access to this repo," not a sandbox against repo admins.
- GitHub Actions concurrent-job and monthly-minutes limits apply like any
  other workflow; very high submission volume may need self-hosted runners.

## Verified run

Tested against a real private repo (`BH3GEI/arcbench-grader-demo`, private,
initialized from this template) with the `demo-todo` task, covering all
three required outcomes end to end (triggered with `workflow_dispatch`,
downloading each app from the private repo itself over HTTPS with a bearer
token — the same download path a pre-signed submission URL would use).

- **Good app** (`examples/app-todo`, `visibility: public`) — all 4 tests
  pass. Run: https://github.com/BH3GEI/arcbench-grader-demo/actions/runs/36860025835
  Result: `{"status":"passed","passed":4,"total":4}`, published at
  https://github.com/BH3GEI/arcbench-grader-demo/releases/tag/result-demo-good-002
- **Broken app** (`examples/app-todo-broken`, `visibility: public`) — 1/4
  tests pass, the 3 failures include per-test error text. Run:
  https://github.com/BH3GEI/arcbench-grader-demo/actions/runs/36860750858
  Result: `{"status":"failed","passed":1,"total":4,"detail":"3/4 tests failed"}`
  with each failing test's error message, published at
  https://github.com/BH3GEI/arcbench-grader-demo/releases/tag/result-demo-bad-003
- **Hidden task** (good app, `visibility_override: hidden`) — only
  `passed`/`total` returned, no titles, no error text. Run:
  https://github.com/BH3GEI/arcbench-grader-demo/actions/runs/36860070293
  Result: `{"status":"passed","passed":4,"total":4,"visibility":"hidden"}` —
  no `tests` key at all, published at
  https://github.com/BH3GEI/arcbench-grader-demo/releases/tag/result-demo-hidden-002

Two bugs surfaced and were fixed during this verification (both only in the
Actions template, not in this repo's local `docker compose` channel):
globally-installed `@playwright/test` wasn't resolvable from the read-only
mounted test pack (fixed with `NODE_PATH` in `runner/Dockerfile`), and
per-test error messages were being read off the wrong report node (fixed in
`scripts/parse_report.py`).
