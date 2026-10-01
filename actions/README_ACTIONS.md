# GitHub Actions grader

A serverless evaluation channel for the self-test demo, built on GitHub
Actions — an alternative to this repo's local `docker compose` server (see
the repo's root README for both). Task content and test packs live in a
**separate private repository**; this public repo only ships the template
used to create that private repo, plus this guide.

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
3. Add repo secrets (Settings -> Secrets and variables -> Actions) — see
   "Secrets & least privilege" below for how to scope each one:
   - `SELFTEST_DISPATCH_SIGNING_KEY` — shared HMAC secret, same value on the
     self-test service and in this repo. Authenticates dispatches *and*
     is how per-team quota lands on the Actions side — see "Submitter
     identity & quota". Strongly recommended for production; the check
     silently no-ops if unset (useful for local testing only).
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

Task folders use the same shape as arcbench already does — one command
imports a folder in as-is, no manual reformatting:

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

```
cd <grader-repo-clone>
python3 scripts/import_task.py /path/to/arcbench/task --task-id my-task --visibility public
git commit -m "Import task my-task" && git push
```

`scripts/import_task.py` reads the arcbench task's own `requirements.yaml`
(whatever shape — nested, differently-named fields are fine, it uses PyYAML:
`pip install pyyaml` if missing) and derives this grader's flat
`requirements.yaml`, filling in `app_port`/`build_timeout_s`/
`ready_timeout_s`/`run_timeout_s` with sane defaults for anything the source
doesn't specify. It copies `requirements.md`, `reference/`, `assets/` and
`tests/*.spec.ts` across unchanged, stages the result with `git add`, and
**refuses to run** if the destination repo's git remote looks like this
public demo repo — real task content only ever goes to a private grader
repo. Review the diff it stages (especially `visibility` and the timeouts)
before committing; `--visibility` is required unless the source file already
has one.

Equivalent manual steps, if you'd rather not use the script: copy the folder
to `tasks/<task_id>`, hand-write a flat `requirements.yaml` with at least
`visibility: public|hidden` (the grader parses it with `grep`/`cut`, not a
YAML library, to keep the Actions runner dependency-free), commit, push,
trigger a run with that `task_id` to confirm it grades.

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

## Web app

A participant-facing site in `actions/web/` (Next.js, deployed on Vercel) —
this is how participants actually use the grader; nobody gets access to the
grader repo or triggers `workflow_dispatch`/`repository_dispatch` by hand.
Not a leaderboard: results are only ever shown to the person who submitted.

**Flow**: GitHub OAuth sign-in -> pick a task (name only, from the grader
repo's `tasks/` directory listing) -> upload a zip -> queued/running/result
view that polls until done -> history of your own past submissions.

```
participant's browser
  |
  v
Next.js app on Vercel (actions/web/)
  +-- GitHub OAuth (NextAuth) -- identifies the participant; their GitHub
  |   OAuth access token is never stored or exposed to the browser, only
  |   used by NextAuth during the login handshake itself
  +-- Vercel Functions (API routes), server-side only:
  |     - lists tasks/ dir names via a separate service PAT (not the
  |       participant's token) — same least-privilege token this doc's
  |       "Secrets & least privilege" section already describes
  |     - validates the upload (zip magic bytes, size cap), checks
  |       per-user + global daily quota and account-age gate
  |     - uploads the zip to Vercel Blob, gets back a URL
  |     - calls the grader repo's /dispatches API with a signed payload
  |       (same HMAC scheme as "Submitter identity & quota" above — this
  |       app signs outbound, the grader verifies; the grader signs its
  |       result callback, this app verifies that too)
  +-- /api/callback receives the grader's signed result, stores it
  +-- participant polls /api/submissions/<id> until status != queued
```

**State**: no database — everything (submission records, daily quota
counters) is small JSON objects in Vercel Blob (`state/submissions/*.json`,
`state/quota/*.json`), keyed by an unguessable UUID (submissions) or a
predictable-but-non-sensitive key (quota counters). Vercel KV would have
been a more natural fit for the counters, but provisioning it currently
requires a marketplace integration with an interactive "accept terms" step
(no non-interactive path) — documented as a known limitation below rather
than worked around.

**Setup**:

1. `actions/web/` is deployed as its own Vercel project with **Root
   Directory** unset and deployed via `vercel deploy --prod --cwd
   actions/web` (not Git-connected — this public repo gets many unrelated
   commits, and an auto-deploy on every one of them would be pure waste;
   deploy manually when `actions/web/` actually changes).
2. Connect a Vercel Blob store to the project (`vercel storage create
   <name> --type blob --access public`, then `vercel storage connect
   <name> --project <project>`). No static token needed — the SDK picks up
   `BLOB_STORE_ID` + the platform's own OIDC token automatically.
3. **Disable deployment protection** (`ssoProtection` / password
   protection) — Vercel's own project-level auth gate defaults to blocking
   every `*.vercel.app` URL behind team SSO, which would stop participants
   before they ever reach this app's own GitHub login. The site's auth is
   GitHub OAuth, not Vercel's.
4. Set project env vars (see `actions/web/.env.example` for the full list
   and descriptions): `GITHUB_OAUTH_CLIENT_ID` / `_SECRET` (from the OAuth
   App below), `NEXTAUTH_SECRET` (`openssl rand -base64 32`), `NEXTAUTH_URL`
   (the deployed URL), `GRADER_SERVICE_TOKEN` / `GRADER_REPO_OWNER` /
   `GRADER_REPO_NAME` (same grader repo this whole doc is about),
   `SELFTEST_DISPATCH_SIGNING_KEY` (same value as the grader repo's secret
   of the same name — this app and the grader sign/verify each other with
   it), and optionally the `SELFTEST_WEB_*` abuse-prevention knobs.
5. **Create the GitHub OAuth App** (must be done by a human on github.com —
   there's no API for this part): go to
   `https://github.com/settings/applications/new`, set
   - Application name: anything descriptive, e.g. "arcbench self-test"
   - Homepage URL: the deployed site's URL
   - Authorization callback URL: `<deployed-url>/api/auth/callback/github`

   Register, then "Generate a new client secret" on the app's page. Put the
   Client ID and that secret into `GITHUB_OAUTH_CLIENT_ID` /
   `GITHUB_OAUTH_CLIENT_SECRET`, redeploy.

**Abuse prevention** (`SELFTEST_WEB_*` env vars, see `.env.example`):
per-GitHub-account daily submission limit (default 10), a separate global
daily limit across all users (protects against runaway Actions spend, not
just one user), a zip size cap, and a minimum-GitHub-account-age gate
(rejects brand-new accounts, default 7 days, 0 disables it). All four are
checked server-side in `/api/submit` before anything is uploaded or
dispatched; an unknown account-creation date fails *open* (doesn't block),
since the GitHub API field is self-reported, optional and not worth hard-
failing legitimate users over.

Quota is **not** a read-modify-write counter on one overwritten Blob object
— that was the first implementation, and it was broken: public Blob URLs
sit behind a CDN that does not reliably reflect an overwrite on the very
next read, so a write-then-read-back check silently under-counted and let
every submission through regardless of the limit (caught by testing the
boundary directly, not by inspection — see "Verified run"). Fixed by
writing one small marker blob per consumed submission under a per-user
(or, for the global limit) per-day prefix, and counting via `list()`
instead of reading a single URL — the same `list()` call the submission
history already relied on, which behaved consistently. Verified: the 11th
same-day submission from one account is rejected with 429, the 10th is
not.

The same CDN-staleness bug hit submission status too: the grader's result
callback used to overwrite `state/submissions/<id>.json`, got HTTP 200 back,
and the participant's poll kept reading the pre-overwrite "queued" version
indefinitely — found by actually polling a real submission through to
completion, not by inspection. Fixed the same way: a submission is now an
append-only pair of objects, `state/submissions/<id>/created.json` (written
once at submit time) and `.../result.json` (written once by the callback,
if at all), assembled on read via `list()` rather than re-fetching a URL
that might have changed since it was first cached. Also moved the
submission record's creation to *before* the grader is dispatched (it used
to happen after) — the grader can call back faster than that write used to
land, and the callback looks the record up by id.

**Known limitations**: the list-then-write quota check still isn't a true
atomic increment — a race under heavy *concurrent* submissions from the
same account in the same instant could let one or two extra through. Not
a correctness issue at the scale this targets, and strictly better than
the original counter (which enforced nothing at all). No Vercel KV (see
above). The service token used for the grader repo (listing tasks,
dispatching) needs the same least-privilege scoping called out in "Secrets
& least privilege" — it currently reuses a broad personal token for this
verification, replace before real production use. No rate limiting on the
API routes themselves beyond the quota checks (a participant could hammer
`/api/submissions` freely; harmless since it's read-only and scoped to
their own data, but worth a note).

## Submitter identity & quota

`repository_dispatch` can be called by anyone holding a token with write
access to the grader repo — in production that should only ever be the
self-test service's own credential, but the grader checks anyway
(`scripts/verify_signature.py`, called first thing in `grade.sh`):

- The self-test service signs `"{submission_id}.{task_id}.{timestamp}"` with
  HMAC-SHA256 using the shared `SELFTEST_DISPATCH_SIGNING_KEY`, **only after
  its own `quota.try_consume()` succeeds**, and sends `submission_timestamp`
  + `submission_signature` (hex digest) in `client_payload`.
- The grader recomputes the HMAC and rejects (status `error`, detail
  `"dispatch rejected: ..."`) if it doesn't match, or if the timestamp is
  more than 300s old (replay protection) — no build, no run, no callback to
  the (now untrusted) `callback_url`.
- This is also where **per-team daily quota lands on the Actions side**: a
  valid, fresh signature is itself proof quota was already checked
  server-side. The grader deliberately does not re-implement a stateful
  per-team counter — that logic (and its storage) stays exactly where it
  already is, in `server/app/quota.py`, which both channels share.
- The same key signs the outbound callback too (`X-Signature: sha256=...`
  header on the `CALLBACK_URL` POST, in `report_back.py`), so the self-test
  service can confirm a result actually came from this grader.
- No key configured → the check no-ops (always passes). That's intentional
  for local `workflow_dispatch` testing; set the secret before going live.

## Concurrency, resource limits & retries

- **Concurrency**: a `prepare` job hashes `submission_id` into one of
  `GRADE_LANES` (default 4, set in `grade.yml`) lanes; the `grade` job's
  `concurrency: group: grade-lane-<N>` serializes within a lane. This bounds
  total parallelism to `GRADE_LANES` regardless of burst size, and
  incidentally re-dispatching the same `submission_id` always serializes
  against its own earlier run (same hash → same lane). Raise `GRADE_LANES` to
  trade isolation-per-lane for more throughput, within whatever concurrent-job
  limit your GitHub plan/org allows.
- **Timeouts**: per-task `build_timeout_s`/`ready_timeout_s`/`run_timeout_s`
  from `requirements.yaml` (defaults 600/60/900s), plus a job-level
  `timeout-minutes: 20` backstop in `grade.yml` in case something hangs
  outside those three checkpoints.
- **Resource caps**: app container — 512MB memory (swap capped equal, so it
  can't page around the limit), 1 CPU, 256 pids, read-only root fs with a
  64MB noexec `/tmp`, `no-new-privileges`, a handful of Linux capabilities
  dropped, log output capped (`--log-opt max-size=10m --log-opt max-file=1`).
  Runner container — 2GB memory, 2 CPUs, 1024 pids, `no-new-privileges`.
- **Download caps**: HTTPS only (`--proto =https`), 100MB max file size,
  120s max transfer time — a hostile or broken `download_url` can't fill the
  job's disk or hang it indefinitely.
- **Retries**: only for infra calls that have nothing to do with the
  submission's own correctness — downloading the app zip, pulling a
  prebuilt `GRADER_RUNNER_IMAGE` (3 attempts, 5s apart). Building the
  submitted app and running its tests are never retried: a flaky network
  shouldn't get 3 tries disguised as 1, and a genuinely broken submission
  shouldn't get extra attempts either. If a run fails on infra flakiness,
  the self-test service re-dispatches (same `submission_id` → same lane, so
  no pile-up).
- **Cleanup**: a `trap cleanup EXIT` in `grade.sh` always removes the app
  container, runner container, network and app image by name — runs even on
  early failure. Debug artifacts (`.gradework/results`, build/app/runner
  logs + `result.json`) upload with `retention-days: 3`. Result releases
  (`result-<submission_id>`) have no automatic expiry; prune old ones
  periodically, e.g. `gh release list -R <org>/<grader-repo> --limit 200 |
  awk '{print $3}' | xargs -n1 gh release delete -R <org>/<grader-repo>
  --yes` for ones past your retention window.

## Secrets & least privilege

- `SELFTEST_DISPATCH_SIGNING_KEY` / `SELFTEST_CALLBACK_TOKEN` — random
  secrets you generate (e.g. `openssl rand -hex 32`), not derived from any
  account's credentials. Rotate by updating both sides together.
- `APP_DOWNLOAD_TOKEN` — scope this to **read-only access to wherever app
  zips are stored**, nothing else. Do not reuse a personal PAT with full
  `repo` scope here (the verification run for this template used one for
  convenience, documented in "Verified run" below — don't copy that part).
  A fine-grained PAT scoped to just the storage location/repo, or a signed
  URL from object storage, is the production shape.
- The self-test service's own dispatch credential needs exactly: write
  access to the grader repo (to call the `dispatches` API) — nothing else.
  A GitHub App installed only on the grader repo, or a fine-grained PAT
  scoped to that one repo, both work; a classic PAT with org-wide `repo`
  scope is more than necessary.
- `GITHUB_TOKEN` (the job's own, automatic, never a stored secret): scoped
  per job in `grade.yml` — `prepare` gets `contents: read` (it doesn't even
  check out the repo), `grade` gets `contents: write` (needed only for the
  fallback Release). Neither job gets `actions:`, `issues:`, `packages:`, or
  anything else — GitHub denies every permission not explicitly listed once
  you specify a `permissions:` map.
- Both `checkout@v4` steps set `persist-credentials: false` so the job token
  never sits in `.git/config` on disk, where the process tree building an
  untrusted submission could otherwise reach it.

## Cost / usage estimate

GitHub-hosted `ubuntu-latest` runners: a `demo-todo`-sized run (4-5 tests,
rebuilding the Playwright image each time) takes roughly 1-4 minutes of
job time depending on whether a test times out. Rough minutes/month:

```
minutes/month ≈ submissions/day × avg_run_minutes × 30
```

At 10 submissions/team/day (the existing default daily limit) and, say, 20
teams: 200 submissions/day × ~2 min average × 30 ≈ 12,000 minutes/month.
Private repos get 2,000-50,000 free minutes/month depending on plan (GitHub
Free: 2,000; Team: 3,000; Enterprise: 50,000), billed per-minute beyond that
at standard GitHub Actions rates. Two easy levers to cut this: set
`GRADER_RUNNER_IMAGE` to a prebuilt image (saves ~1-2 min/run of Playwright
install) and/or require re-submission cooldowns upstream in the self-test
service (already true via the existing daily quota).

## What stays the same as the local channel

- **Quota**: authority unchanged — still `server/app/quota.py`'s per-team
  daily limit, checked before a submission is ever dispatched. What's new on
  the Actions side is the signed-dispatch proof described above, not a
  second counter.
- **Isolation shape**: isolated build, no-network app container, a separate
  test runner container reaching the app only via `BASE_URL`, same Playwright
  version pin as `runner/Dockerfile` in this repo.
- **Result shape**: `{status, passed, total, tests?}` — a subset of this
  repo's `EvalResult` tailored to what a visibility-aware caller needs.

## Known limitations

- The Playwright runner image is built fresh each run (~1-2 min) unless
  `GRADER_RUNNER_IMAGE` is set to a prebuilt image reference (push one to
  GHCR once per Playwright version bump and set that env in the workflow).
- The grader-side `requirements.yaml` stays flat on purpose (parsed with
  `grep`/`cut`, no runner dependency); `scripts/import_task.py` is what
  absorbs arbitrary nested arcbench shapes at import time, not the grader.
- No automatic screenshot-on-failure artifact upload in this template (the
  report still includes the error message for `visibility: public` tasks).
- A repo collaborator with write/read access to the grader repo can still
  see task content and run results directly — the isolation here is "no
  participant access to this repo," not a sandbox against repo admins.
- `GRADE_LANES` bounds parallelism but isn't a real queue: two unrelated
  submissions that hash to the same lane wait on each other, and there's no
  priority or fairness — fine at the scale this template targets, not a
  substitute for a proper job queue at much higher volume.
- GitHub Actions concurrent-job and monthly-minutes limits apply like any
  other workflow; very high submission volume may need self-hosted runners.

## 上线清单

- [ ] 私有 grader 仓库已从 `actions/template/` 初始化，且确认其 git remote
      不是本公开仓库（`scripts/import_task.py` 会自动拒绝写入看起来像公开仓库的目标）。
- [ ] 三个 secrets 已按「Secrets & least privilege」配置且权限最小化：
      `SELFTEST_DISPATCH_SIGNING_KEY`、`SELFTEST_CALLBACK_TOKEN`（或改用私有
      Release 兜底）、`APP_DOWNLOAD_TOKEN`（若需要，建议只读、限定存储位置，
      不要用个人完整 `repo` scope 的 token）。
- [ ] 自测服务侧的 dispatch 凭证（GitHub App 或 PAT）只拥有对 grader 仓库发
      `repository_dispatch` 所需的最小权限，且只存在服务端，不进 grader 仓库。
- [ ] `SELFTEST_DISPATCH_SIGNING_KEY` 在自测服务与 grader 仓库两侧为同一值，
      且确认自测服务只在 `quota.try_consume()` 成功后才签名、带新鲜 timestamp。
- [ ] 每道正式题目都用 `scripts/import_task.py` 导入，并至少跑过一次真实
      run（好 app、坏 app 各一次）确认链路通。
- [ ] `GRADER_RUNNER_IMAGE`（可选）已指向预构建镜像，避免每次评测都重新装
      Playwright/Chromium；或接受首次构建的 1-2 分钟开销。
- [ ] `GRADE_LANES`（默认 4）与预期并发提交量匹配，并结合组织的 Actions
      并发 job 上限一起估算过吞吐（见「Cost / usage estimate」）。
- [ ] 回归验证：好 / 坏 / hidden / 部分通过 / 签名错误被拒 均按预期表现——
      结果见下方「Verified run」。
- [ ] README 中列出的 secrets 名称与仓库实际配置的 secrets 一致，且没有遗留
      验证阶段临时用的个人 token（本模板验证时用过一个，已在下方「Verified
      run」里注明，正式上线前应替换）。

## 运维

**监控看哪里**

- 每次评测的 Actions run 列表：`gh run list -R <org>/<grader-repo>`。run 的
  success/failure 只反映「评测流程本身是否跑完」，不等于「题目是否通过」——
  是否通过看 `result.json` 的 `passed/total`；run failure 可能是选手 app 真
  的没通过测试，也可能是下载失败/app 未就绪等 infra 问题（区别在 `detail`
  字段的文字）。
- 结果交付：未配置 `CALLBACK_URL` 时用 `gh release list -R
  <org>/<grader-repo>`；配置了的话看自测服务自己的回调接收日志。
- 用量/配额：GitHub 组织的 Actions usage 页面（分钟数、并发 job 数）+
  自测服务自身的配额使用情况（`GET /api/quota`，见仓库根 README）。

**出故障怎么处理**

- `detail` 是 infra 类报错（`download failed` / `app did not become ready
  within Ns` / `runner exited N without a report` / `app build failed or
  exceeded Ns`）→ 先下载该 run 的 `debug-<submission_id>` artifact（保留 3
  天），看 `build.log` / `app.log` / `runner.log`；多数是选手 app 本身的问
  题，不是 grader 的 bug。
- `detail` 以 `dispatch rejected:` 开头 → 签名或新鲜度问题。先确认自测服务
  与 grader 仓库两侧 `SELFTEST_DISPATCH_SIGNING_KEY` 是否一致，再检查服务端
  签名时间戳是否有明显时钟偏移（默认容忍窗口 300 秒，见
  `scripts/verify_signature.py` 的 `--max-age-s`）。
- 整体吞吐变慢、submission 排队明显 → 检查是不是同一个 `submission_id` 被
  重复 dispatch（会一直排在同一 lane 里串行），或是已经顶到组织的 Actions
  并发 job 上限；必要时调大 `GRADE_LANES`。
- Playwright/Chromium 相关的 runner 镜像构建失败 → 多为上游 `node`/
  `playwright` 基础镜像变更，先本地 `docker build ./runner` 复现；临时缓解
  可把 `runner/Dockerfile` 里的 `PLAYWRIGHT_VERSION` 锁定到上一个已知可用
  版本，或切到一个提前验证过的 `GRADER_RUNNER_IMAGE`。

**怎么回滚**

- grader 仓库是独立的 git 仓库，每次改动都是一个 commit：`git revert
  <bad-commit>` 是首选（私有仓库、无下游 fork，`git reset --hard
  <last-good> && git push --force-with-lease` 也可以，但 revert 更安全、留
  痕迹）。
- 某道题目导入错了（如 `visibility` 弄反、内容有误）→ 用
  `scripts/import_task.py ... --force` 重新导入覆盖，或直接 `git revert`
  那次导入对应的 commit。
- 工作流本身（`grade.yml` / `scripts/*`）改坏了 → 先用 `workflow_dispatch`
  手动跑一次 `demo-todo` 的好 / 坏两种 app，确认链路恢复正常，再对正式题目
  放量。

## Verified run

Tested against a real private repo (`BH3GEI/arcbench-grader-demo`, private,
initialized from this template) with the `demo-todo` task (5 tests),
`SELFTEST_DISPATCH_SIGNING_KEY` configured, covering every required outcome
end to end — triggered with `workflow_dispatch`, apps downloaded from the
private repo itself over HTTPS with a bearer token (the same download path a
pre-signed submission URL would use), each dispatch carrying a real HMAC
signature computed the same way the self-test service would.

- **Good app** (`examples/app-todo`, `visibility: public`) — 5/5 pass. Run:
  https://github.com/BH3GEI/arcbench-grader-demo/actions/runs/36866086278
  Result: `{"status":"passed","passed":5,"total":5}`, published at
  https://github.com/BH3GEI/arcbench-grader-demo/releases/tag/result-final2-good-001
- **Broken app** (`examples/app-todo-broken`, `visibility: public`) — 1/5
  pass, 4 failures each with error text. Run:
  https://github.com/BH3GEI/arcbench-grader-demo/actions/runs/36866099951
  Result: `{"status":"failed","passed":1,"total":5,"detail":"4/5 tests failed"}`,
  published at
  https://github.com/BH3GEI/arcbench-grader-demo/releases/tag/result-final2-bad-001
- **Hidden task** (good app, `visibility_override: hidden`) — only
  `passed`/`total` (5/5), no `tests` key at all. Run:
  https://github.com/BH3GEI/arcbench-grader-demo/actions/runs/36866112520
  Result: `{"status":"passed","passed":5,"total":5,"visibility":"hidden"}`,
  published at
  https://github.com/BH3GEI/arcbench-grader-demo/releases/tag/result-final2-hidden-001
- **Partially-finished app** ("60 分" case — `examples/app-todo-partial`,
  deleting unimplemented, wrong error text) — 3/5 pass, matching the app's
  own documented expectation. Run:
  https://github.com/BH3GEI/arcbench-grader-demo/actions/runs/36866937339
  Result: `{"status":"failed","passed":3,"total":5,"detail":"2/5 tests failed"}`
  with real per-test error text (a timeout and a failed assertion), published
  at https://github.com/BH3GEI/arcbench-grader-demo/releases/tag/result-final3-partial-001
- **Wrong dispatch signature** — rejected before any build/run, no callback
  attempted. Run (job fails fast, ~45s, no build/run steps execute):
  https://github.com/BH3GEI/arcbench-grader-demo/actions/runs/36866133193
  Result: `{"status":"error","detail":"dispatch rejected: signature mismatch"}`
- **Real stage-1 task import** — `scripts/import_task.py` against an actual
  first-stage task folder (12 spec files + a shared support helper, flat
  `requirements.yaml` directly under the task root rather than nested in a
  `requirements/` dir — a layout the script didn't handle yet; fixed as part
  of this verification, see "Three bugs" below), imported with one command
  and graded with an unrelated stand-in app (`examples/app-todo`, since the
  point here is proving the import + grading pipeline handles a real task
  shape, not scoring). Task name/content intentionally omitted here. Run:
  https://github.com/BH3GEI/arcbench-grader-demo/actions/runs/36870510661
  Result: `{"status":"failed","passed":0,"total":30,"detail":"30/30 tests
  failed"}` — all 30 real scenarios from the imported spec files actually
  executed against the stand-in app inside the isolated runner container
  (mix of assertion failures and timeouts in the per-test error text, as
  expected for an unrelated app), not a plumbing error.
- **Quota exceeded** — this one has no Actions run by design: the self-test
  service checks quota *before* dispatching (unchanged, see "Submitter
  identity & quota"), so an over-quota submission never reaches the grader
  at all. Verified at the layer that actually enforces it instead —
  `server/app/quota.py`'s own `Quota`, exercised directly: 3 consecutive
  `try_consume()` calls against a `limit=3` quota succeed (remaining 2, 1, 0),
  the 4th raises `QuotaExceeded: team 'demo-team' reached the daily limit of
  3 submissions`, and `status()` correctly reports `used=3, remaining=0`
  afterwards. Same code path `tests/test_quota.py` already covers.

Four bugs surfaced and were fixed during this verification (all isolated to
the Actions template, not this repo's local `docker compose` channel):
globally-installed `@playwright/test` wasn't resolvable from the read-only
mounted test pack (fixed with `NODE_PATH` in `runner/Dockerfile`), per-test
error messages were being read off the wrong report node (fixed in
`scripts/parse_report.py`), the partial-app test fixture didn't actually
get committed the first time (`*.zip` is gitignored on purpose; test
fixtures need `git add -f`, same as the earlier good/bad ones — caught by
the resulting "download failed" and fixed by re-adding), and
`scripts/import_task.py` only looked for a nested `requirements/` directory
until a real task folder showed up with `requirements.yaml`/`reference/`
directly at the task root — fixed to detect and support both layouts.
