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
private grader repo: .github/workflows/grade.yml — THREE jobs, each holding
only the secrets/permissions it needs (see "Secrets & least privilege"):

  prepare (contents: read, holds SELFTEST_DISPATCH_SIGNING_KEY)
        +-- validate/normalize every untrusted input
        +-- verify the dispatch's HMAC signature (scripts/verify_signature.py)
        |   — never checks out or runs anything derived from the submission,
        |   so holding the signing key here is safe
        v
  grade (contents: read, holds ONLY APP_DOWNLOAD_TOKEN) — builds and runs
  the fully untrusted submission; no write access, no callback/signing
  secrets, so a container escape here can't push to this repo or forge a
  result
        +-- download app.zip, validate (Dockerfile present, no path escapes,
        |   size/file-count caps)
        +-- docker build --network=none, resource-capped, really killed on
        |   timeout                               (app image, isolated build)
        +-- docker network create --internal    (no outbound internet)
        +-- docker run app container            (network alias "app")
        +-- docker build runner image (or docker pull a prebuilt one)
        +-- docker run runner container, non-root, on the SAME internal
        |   network, BASE_URL=http://app:<port> — the only thing it can
        |   reach. Only now is the task's tests/ directory mounted
        |   (read-only) into this container. The app container never sees
        |   it; the runner container never sees the app's source.
        +-- parse report.json, apply the task's visibility setting ->
        |   result.json (status is one of passed/failed/system_error/
        |   rejected — see "Result fields")
        +-- cleanup (containers, network, image, build cache) via a trap,
        |   always runs
        +-- upload result.json as a build artifact for the next job
        v
  report (contents: write, holds SELFTEST_CALLBACK_TOKEN +
  SELFTEST_DISPATCH_SIGNING_KEY) — runs even if `grade` failed/timed out
        +-- download the result.json artifact (synthesize a system_error
        |   one if `grade` produced none at all)
        +-- report back (signed callback URL, or a private GitHub Release
            in the grader repo — never the Actions log)
```

`docker run` output for the app and the Playwright pack is redirected to
files and only read back by `parse_report.py`, never printed to the job log.

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
(rejects brand-new accounts, default 7 days, 0 disables it). An unknown
account-creation date fails *open* (doesn't block), since the GitHub API
field is self-reported, optional and not worth hard-failing legitimate users
over.

**Upload flow.** Vercel functions reject request bodies over 4.5MB, so the
zip never passes through one: (1) `/api/upload-url` checks the account age,
the task, the declared size and remaining quota (read-only), records an
upload intent (`state/uploads/<id>.json`: who, which task) and returns a
presigned Blob PUT URL for exactly `submissions/<id>.zip` — no overwrite,
size cap and zip content types enforced by Blob itself, valid 15 minutes.
It is issued with the project's OIDC Blob credentials (`issueSignedToken` +
`presignUrl`), so no `BLOB_READ_WRITE_TOKEN` is needed. (2) The browser PUTs
the file there. (3) `/api/submit {uploadId}` checks the intent belongs to
this user, re-checks the stored object (size, `PK\x03\x04` magic; a bad
object is deleted), and only then charges quota and dispatches. A zip that
is uploaded but never submitted costs nothing but storage.

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
- The same key signs the outbound callback too, in `report_back.py` — see
  "Callback verification" below for the exact header contract.
- No key configured → the check no-ops (always passes). That's intentional
  for local `workflow_dispatch` testing; set the secret before going live.

## Internal synthetic check

A scheduled job (private ops repo, Actions `schedule` + `workflow_dispatch`,
every 2 hours) submits a known-good fixture app through the real
submit -> dispatch -> grade -> callback -> poll pipeline and checks the
result matches what's expected, so a break shows up before a participant
hits it. It needs its own way to submit and poll without a GitHub login and
without spending a real participant's daily quota, so `actions/web` exposes
two endpoints just for it:

- `POST /api/internal/submit`, `GET /api/internal/submissions/<id>` —
  otherwise identical to `/api/submit` and `/api/submissions/<id>`, except:
  no session required, no `tryConsumeUserQuota`/`tryConsumeGlobalQuota`
  call (so it never touches the per-user/global counters a real submission
  consumes), and the submission is recorded under the fixed identity
  `internal-selftest-checker` instead of a `githubId` — which the GET side
  also uses to make sure this endpoint can only ever read back a submission
  it created itself, never a participant's.
- Both are gated on a shared secret: header `X-Internal-Key` must
  timing-safe-equal the `INTERNAL_CHECK_KEY` env var
  (`lib/internalCheck.ts`). **Unset by default** — with no key configured
  both routes just return 403, so they're inert until someone deliberately
  turns them on. Set the same value as the private repo's
  `INTERNAL_CHECK_KEY` Actions secret; rotate by changing both together.
- Unlike `/api/submit`, the internal submit path accepts unlisted/demo task
  ids (it skips `isTaskListed`, keeping only `taskExists`) — the check's
  fixture app targets `demo-todo`, which is intentionally hidden from the
  participant-facing task list.
- Neither route is linked from any page; a leaked key only grants "submit
  one more fixture run and read it back" against this one fixed identity,
  not access to any participant's app, quota, or result.

## Watchdog: no submission stays queued forever

Reconciling a stuck submission used to happen only on read (`getSubmission`
reconciles a `queued` record it's about to return) — fine as long as the
participant keeps the page open, useless if they close the tab. A dispatch
whose GitHub API call "succeeded" but never actually produced a run on the
grader repo (the failure this was built for — no error anywhere, just
nothing happening) could sit at "queued" indefinitely with nobody polling.

`GET /api/cron/reconcile` runs the same reconciliation over *every* queued
submission, proactively:

- After 3 minutes, confirm a `grade.yml` run actually exists on the grader
  repo (`hasRecentGradeRun` in `lib/github.ts`). Repository-dispatch runs
  carry no queryable trace of their `client_payload`, so this can only
  check that *some* run started around the right time — enough to catch
  "zero runs ever appeared", not to disambiguate near-simultaneous
  submissions. If none is found, redispatch exactly once
  (`claimRedispatch`/`checkRunAndMaybeRedispatch` in `lib/store.ts`); if the
  redispatch call itself fails, mark `system_error` and refund quota right
  away instead of waiting out the full timeout.
- After 8 minutes, same artifact-recovery pull as the on-read path.
- After 30 minutes with still nothing, `system_error` + quota refund.

`dispatchGrade` itself also retries once on any non-204 response (or a
thrown network error) before giving up, logging the reason either way.

**Trigger.** Vercel's own Cron Jobs are capped at once/day on the Hobby
plan this project runs on — any sub-daily schedule fails to deploy, so a
real 5-minute cadence can't come from `vercel.json` alone. The actual timer
is `.github/workflows/selftest-watchdog.yml` (GitHub Actions `schedule`,
every 5 minutes) calling the route with
`Authorization: Bearer ${{ secrets.SELFTEST_CRON_SECRET }}`; `vercel.json`
still carries a once-daily cron hitting the same route as a backstop in
case that workflow is ever suspended (GitHub disables schedules after 60
days of repo inactivity). Set `CRON_SECRET` (Vercel project env) and the
repo secret `SELFTEST_CRON_SECRET` to the same value — empty disables the
auth check (local dev only).

## Callback verification

`report_back.py` POSTs `result.json` to `CALLBACK_URL` with three headers,
signed together so none can be stripped or reused independently:

- `X-Timestamp` — unix seconds when the grader sent the callback.
- `X-Nonce` — 32 hex chars, random per callback.
- `X-Signature: sha256=<hex>` — HMAC-SHA256 over
  `"{X-Timestamp}.{X-Nonce}.{sha256-hex(body)}"` using the shared
  `SELFTEST_DISPATCH_SIGNING_KEY`.

The receiver (self-test service / `actions/web/api/callback`) should, in
order: (1) recompute the signature over the same three-part string and
reject on mismatch — this is the anti-forgery check; (2) reject if
`X-Timestamp` is more than ~300s old — anti-replay for anything older than
the window; (3) reject if `X-Nonce` was already seen for this
`submission_id` within that window — anti-replay for a byte-for-byte resend
*inside* the window, which (1)+(2) alone would still accept. (3) needs a
small persisted set of recently-seen nonces (a few minutes' TTL is enough);
the grader itself is stateless across runs and can't do this dedup, so it
has to live on the receiving side — same place quota state already lives
(`server/app/quota.py` / the web app's Blob store), not in this repo.

## Result fields

`result.json` — the shape both the callback POST and the fallback GitHub
Release asset carry — always has:

```
{
  "submission_id": "...", "task_id": "...", "visibility": "public|hidden",
  "status": "passed|failed|system_error|rejected",
  "passed": 0, "total": 0, "detail": "...",
  "tests": [...]   // visibility: public and status reached "scored" only
}
```

`status` distinguishes **who it counts against**:

- `passed` / `failed` — a real, participant-attributable result: the app
  built and started, the test pack ran to completion, and either every test
  passed or `detail`/`tests` says which didn't (or, for `failed` without a
  report, *why* nothing ran — bad zip, no Dockerfile, build failed, the app
  never became ready, or the run itself timed out). Counts against the
  daily quota like any other graded submission.
- `system_error` — an infra fault, not the participant's: the download
  failed (after retries) or the Playwright harness crashed before producing
  a report (also retried once automatically inside `grade.sh` before this
  status is reported). The caller should **retry the dispatch once and must
  not charge the daily quota** for this result. This also covers a case the
  grader can't see from inside the job at all: if `repository_dispatch`
  itself sits queued longer than the self-test service is willing to wait
  (busy runners), the service should treat that timeout the same way —
  system_error, retry once, no quota charge — on its own side, since no
  grader code ever ran to report anything.
- `rejected` — the dispatch didn't authenticate (bad/missing/stale HMAC
  signature) or named an unknown `task_id`. Not a real submission at all;
  retrying won't help without fixing the caller, so don't auto-retry this
  one and don't charge quota either.

This status vocabulary and the retry/quota rule are the contract; rendering
it for participants (a "we hit a glitch, retrying" vs. a real failure
message) is the web app's job, not this repo's.

## Concurrency, resource limits & retries

- **Concurrency**: no `concurrency:` group on the `grade` job. Parallelism
  is bounded by the GitHub plan/org concurrent-job limit, and jobs beyond it
  wait in GitHub's own runner queue. An earlier version serialized jobs into
  `GRADE_LANES` lanes with `concurrency: group: grade-lane-<N>`, but a
  concurrency group keeps at most one *pending* job: a burst of three or more
  submissions in one lane cancelled the waiting ones, their `report` job was
  skipped, and those submitters never got a result. (`lane` is still
  computed in `prepare`, for logs only.) The `report` job runs on
  `always()`, so even a cancelled or skipped `grade` job yields a
  `system_error` result instead of silence.
- **Timeouts**: per-task `build_timeout_s`/`ready_timeout_s`/`run_timeout_s`
  from `requirements.yaml` (defaults 600/60/900s), plus a job-level
  `timeout-minutes: 20` backstop in `grade.yml` in case something hangs
  outside those three checkpoints.
- **Build termination is real, not cosmetic**: a plain `timeout N docker
  build` only kills the *client* process — against the legacy (non-BuildKit)
  builder the daemon-side build keeps running and consuming CPU/RAM/disk
  indefinitely (docs/security-review.md open item #2). `grade.sh` pins
  `DOCKER_BUILDKIT=1` explicitly (BuildKit cancels the daemon-side build when
  the client's session is torn down), adds `--kill-after=10 --signal=TERM`
  so a client that ignores SIGTERM gets SIGKILLed, and caps the build itself
  with `--memory=2g --memory-swap=2g --cpu-quota=200000 --cpu-period=100000`
  as defense in depth. The cleanup trap also runs `docker builder prune -f`
  so a killed build's cache doesn't accumulate on the runner.
- **Resource caps**: app container — 512MB memory (swap capped equal, so it
  can't page around the limit), 1 CPU, 256 pids, read-only root fs with a
  64MB noexec `/tmp`, `no-new-privileges`, a handful of Linux capabilities
  dropped, log output capped (`--log-opt max-size=10m --log-opt max-file=1`).
  Runner container — 2GB memory, 2 CPUs, 1024 pids, `no-new-privileges`,
  runs as the image's unprivileged `node` user, see "Browser sandbox".
- **Browser sandbox**: Chromium's own sandbox stays on. It needs
  unprivileged user namespaces, which GitHub's ubuntu-24.04 runner blocks by
  default through AppArmor (`No usable sandbox!`). The `grade` job therefore
  runs `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`
  first — the runner is a throwaway VM, so this only affects that one job —
  and starts the runner container with Playwright's official seccomp
  profile (`runner/seccomp_profile.json`, copied from microsoft/playwright
  `utils/docker/seccomp_profile.json`: Docker's default profile plus
  `clone`/`setns`/`unshare`) rather than `--cap-add=SYS_ADMIN`.
  Fallback: `CHROMIUM_SANDBOX=0` (env for `scripts/grade.sh`) launches
  Chromium with `--no-sandbox`. That trade-off is acceptable only because
  the runner container's other limits still hold: it contains just the
  current task's `tests/` (never the whole private task pack), holds no
  secrets or tokens, has no internet access (internal Docker network), and
  can reach only the app container. A browser exploit there could read
  that one task's tests and nothing else.
- **Download caps**: HTTPS only (`--proto =https`), 100MB max file size,
  120s max transfer time — a hostile or broken `download_url` can't fill the
  job's disk or hang it indefinitely.
- **Retries**: infra calls get one automatic retry inside the same job
  before anything is reported back — downloading the app zip and pulling a
  prebuilt `GRADER_RUNNER_IMAGE` (3 attempts, 5s apart, unchanged), and now
  also the Playwright runner itself: if it crashes before producing
  `report.json` for a reason that isn't "app never became ready" or "run
  timed out" (both decided, participant-attributable outcomes), `grade.sh`
  reruns the runner container once more against the same already-built app
  before giving up with `status=system_error`. Building the submitted app
  and actually running its tests to a decided outcome are never retried: a
  flaky network shouldn't get 3 tries disguised as 1, and a genuinely broken
  submission shouldn't get extra attempts either. If a `system_error` makes
  it all the way to the callback, the self-test service should re-dispatch
  once more itself and not charge quota for it — see "Result fields".
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
  If zips are downloaded from this repo itself (as in this template's own
  test runs, via `raw.githubusercontent.com`), replace it the same way as
  `GRADER_SERVICE_TOKEN` above but with **`Contents: Read-only`** (this
  token lives in the `grade` job, which runs fully untrusted code — it
  should never be able to write anything even if that job is compromised).
  A fine-grained PAT scoped to just the storage location/repo, or a signed
  URL from object storage, is the production shape; a signed URL needs no
  token here at all (the strictly least-privilege option, since nothing
  long-lived is exposed to the `grade` job's environment).
- The self-test service's own dispatch credential (`GRADER_SERVICE_TOKEN` in
  `actions/web`'s env — see "Web app" above) needs exactly: write access to
  the grader repo, to call the `dispatches` API and list the `tasks/`
  directory — nothing else. It currently reuses a broad personal token; swap
  it for a fine-grained PAT scoped to just the grader repo:
  1. On github.com, sign in as the account that owns/administers the grader
     repo, go to `https://github.com/settings/personal-access-tokens/new`.
  2. **Resource owner**: that account. **Repository access**: "Only select
     repositories" -> the grader repo only (e.g.
     `BH3GEI/arcbench-grader-demo`) — never "All repositories".
  3. **Permissions -> Repository permissions**: `Contents: Read and write`
     (needed for the `dispatches` API and for listing `tasks/`). Leave
     everything else "No access".
  4. Set an expiration (90 days, or your org's policy), generate, copy the
     token value once (GitHub never shows it again).
  5. Set it as `GRADER_SERVICE_TOKEN` in the `actions/web` Vercel project's
     env vars (replacing the old broad personal token), then redeploy.
  6. Revoke the old personal token once the new one is confirmed working —
     `https://github.com/settings/tokens`.
  A GitHub App installed only on the grader repo is an equally valid
  alternative to a fine-grained PAT here.
- `GITHUB_TOKEN` (the job's own, automatic, never a stored secret): scoped
  per job in `grade.yml` — `prepare` and `grade` both get `contents: read`;
  only `report` gets `contents: write` (needed for the fallback Release),
  and `report` never builds or runs anything derived from the submission.
  No job gets `actions:`, `issues:`, `packages:`, or anything else — GitHub
  denies every permission not explicitly listed once you specify a
  `permissions:` map.
- Secret exposure is scoped to match: `prepare` holds only
  `SELFTEST_DISPATCH_SIGNING_KEY` (used before anything untrusted is
  touched); `grade` — the job that builds and runs the submission — holds
  only `APP_DOWNLOAD_TOKEN`; `report` holds `SELFTEST_CALLBACK_TOKEN` and
  `SELFTEST_DISPATCH_SIGNING_KEY` (to sign the outbound callback) but never
  sees the submission's code. A full container escape in `grade` therefore
  cannot push to this repo, forge a signed callback, or read the dispatch
  signing key.
- All three `checkout@v4` steps set `persist-credentials: false` so the job
  token never sits in `.git/config` on disk, where the process tree building
  an untrusted submission could otherwise reach it.

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
- [ ] 组织的 Actions 并发 job 上限与预期并发提交量匹配，估算过吞吐
      （见「Cost / usage estimate」）。
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

- 先看 `result.json` 的 `status` 分流：`failed` 才是选手 app 自己的问题
  （`detail` 形如 `app did not become ready within Ns` / `app build failed
  or exceeded Ns` / `N/total tests failed`）；`system_error` 是评测系统基
  础设施的问题（`download failed` / `runner exited N without a report
  after N attempt(s)`，后者已经在 `grade.sh` 里自动重试过一次才报出来）——
  自测服务侧应对 `system_error` 重试一次且不计入当日配额，不要当成选手的
  锅去找选手。两者都先下载该 run 的 `debug-<submission_id>` artifact（保留
  3 天），看 `build.log` / `app.log` / `runner.log` 定位。
- `status` 是 `rejected`（`detail` 以 `dispatch rejected:` 开头，或
  `unknown task_id:`）→ 这不是一次真实提交，不要重试。签名问题先确认自测
  服务与 grader 仓库两侧 `SELFTEST_DISPATCH_SIGNING_KEY` 是否一致，再检查
  服务端签名时间戳是否有明显时钟偏移（默认容忍窗口 300 秒，见
  `scripts/verify_signature.py` 的 `--max-age-s`）。
- 整体吞吐变慢、submission 排队明显 → 多半是已经顶到组织的 Actions 并发
  job 上限，多出的 job 会在 GitHub 的 runner 队列里等待，不会被取消。
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

## Verified run — 2026-10-01 hardening pass

Re-verified end to end against `BH3GEI/arcbench-grader-demo` after the
`prepare`/`grade`/`report` job split, the `system_error`/`rejected` status
vocabulary, the non-root Playwright runner, the real build-timeout kill, and
the timestamp+nonce callback signing — i.e. confirming the hardening didn't
just look right but actually grades correctly end to end. Each run's three
jobs (`prepare` -> `grade` -> `report`) completed and the result (delivered
via the fallback GitHub Release — no `CALLBACK_URL` configured for this
test) matched expectations:

- **Good app** (`test-fixtures/app-todo-good.zip`, `demo-todo`) — 5/5 pass.
  Run: https://github.com/BH3GEI/arcbench-grader-demo/actions/runs/36894381492
  Result: `{"status":"passed","passed":5,"total":5}` with full per-test
  titles (`visibility: public`), release `result-harden1-good-001`.
- **Bad app** (`app-todo-bad.zip`) — 1/5 pass. Run:
  https://github.com/BH3GEI/arcbench-grader-demo/actions/runs/36894391530
  Result: `{"status":"failed","passed":1,"total":5}`, release
  `result-harden1-bad-001` — confirms a build-that-builds-but-fails-tests
  app is `failed` (participant fault), not `system_error`.
- **Hidden task** (good app against `demo-todo-hidden`, real
  `visibility: hidden` task, not an override) — 5/5 pass, reduced to
  `{"status":"passed","passed":5,"total":5}` with no `tests` key at all.
  Run: https://github.com/BH3GEI/arcbench-grader-demo/actions/runs/36894412387
  release `result-harden1-hidden-001`.
- **Partial app ("60 分" case)** (`app-todo-partial.zip`) — 3/5 pass (60%).
  Run: https://github.com/BH3GEI/arcbench-grader-demo/actions/runs/36894432667
  Result: `{"status":"failed","passed":3,"total":5}`, release
  `result-harden1-partial-001`.
- **system_error simulation** — `download_url` pointed at a path that
  doesn't exist in the repo (404), a real-shape infra fault (storage/URL
  problem, nothing to do with the participant's app). Run:
  https://github.com/BH3GEI/arcbench-grader-demo/actions/runs/36894441712
  Result: `{"status":"system_error","passed":0,"total":0,"detail":"download
  failed"}`, release `result-harden1-syserr-001` — confirms this path is
  distinguishable from `failed` end to end, exactly the distinction the
  self-test/web side needs to retry-without-charging-quota (see "Result
  fields"). (The `report` job's GitHub-reported conclusion on this one run
  showed `cancelled` despite every one of its steps, including the release
  publish, completing successfully and the release existing with the
  correct body — a GitHub Actions run-finalization display quirk, not a
  pipeline defect; not reproduced on the other four runs.)
- Chromium's own sandbox is confirmed engaged, not just configured: all
  four scored runs above executed real Playwright tests inside the
  non-root (`USER node`) runner container and produced correct per-test
  results — a sandbox/permissions regression from running non-root would
  have shown up as `system_error` ("runner exited N without a report"),
  which none of them did.
- Dispatch signatures for all five runs were computed with a freshly
  rotated `SELFTEST_DISPATCH_SIGNING_KEY` (the grader repo's previous value
  was a leftover from the last person who tested it, and isn't retrievable
  from a write-only Actions secret) — **if anything else is already relying
  on the old value, it needs to be updated to match**, since the grader
  repo now expects a new one. No `SELFTEST_CALLBACK_TOKEN` is configured in
  this repo, so the timestamp+nonce callback signing code path (vs. the
  Release-fallback path exercised above) is covered by `report_back.py`'s
  own logic review, not a live HTTP POST in this run — exercising it for
  real needs a deployed callback endpoint to point `CALLBACK_URL` at.

## Verified run — initial, 2026-09-xx

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
