# Security review (pre-production)

Scope: both evaluation channels — the GitHub Actions grader (`actions/`) and
the self-hosted server (`server/`, `cli/`, `runner/`). The system builds and
runs participant-supplied zips (with a Dockerfile) and holds test packs that
must stay confidential. Reviewed 2026-10-01.

Severity: **Critical** = direct compromise of the grader or the test pack;
**High** = leak of test content or of another team's data / quota with no
special skill; **Medium** = DoS or needs a second weakness; **Low** = hygiene.

## Fixed in this pass

| # | Sev | Channel | Issue | Fix |
|---|---|---|---|---|
| F1 | Critical | Actions | `grade.yml` interpolated `client_payload.*` / `inputs.*` with `${{ }}` directly into a `run:` script. A payload value containing `"`, `$(…)` or a newline ran shell in the job (which holds `SELFTEST_CALLBACK_TOKEN`, `APP_DOWNLOAD_TOKEN` and a `contents: write` token) or injected extra `$GITHUB_OUTPUT` keys. | Values go through `env:` and are validated (`submission_id`/`task_id` `^[A-Za-z0-9_-]{1,64}$`, URLs `https://` without whitespace). |
| F2 | High | Actions | `visibility_override` was also read from `repository_dispatch` payloads, so any dispatch could turn a hidden task public and get test titles + error text. | Only honoured for `workflow_dispatch`. |
| F3 | High | Actions | `task_id` was joined into a path unchecked (`tasks/../..`), letting a dispatch mount an arbitrary repo directory as `/pack`. | Format check in `grade.yml` and again in `grade.sh`. |
| F4 | Medium | Actions | `actions/checkout` left the job token in `.git/config` on the same disk the untrusted build runs next to. | `persist-credentials: false`. |
| F5 | Medium | Actions | Download had no protocol, size or time cap (`file://`, `http://`, endless stream). | `--proto =https --proto-redir =https --max-filesize 100M --max-time 120`. |
| F6 | Medium | both | App container kept default capabilities and unbounded logs (a stdout flood fills disk; the server read the whole log into memory). Runner had no pid limit. | `no-new-privileges`, drop `NET_RAW MKNOD SYS_CHROOT AUDIT_WRITE SETFCAP`, swap = memory, json-file logs capped at 10 MB, log reads use `tail=5000`, runner `pids_limit=1024`. |
| F7 | Low | Actions | Full `result.json` (test titles and error text on public tasks) was `cat` into the job log. | Log prints only `status passed/total`. |
| F8 | High | Server | With `SELFTEST_TEAM_TOKENS` unset, any token string became its own team: anyone could act as any team and get unlimited submissions by rotating tokens. | Requests are refused unless `SELFTEST_ALLOW_ANY_TOKEN=1` is set explicitly (tests set it in `tests/conftest.py`). |
| F9 | High | Server | `/artifact?path=` served any file under the results dir, including `report.json` and Playwright `output/*/error-context.md`, which quote the test source. | Only `.png/.jpg` screenshots named in `result.json` are served; `nosniff` header on logs and artifacts. |
| F10 | High | Server | No hidden mode: every result exposed titles, errors, screenshots, runner log (which quotes spec code) and app log. | `SELFTEST_VISIBILITY=hidden` returns status and counts only; log/artifact endpoints 404. |
| F11 | Medium | Server | Upload was read fully into memory before the size check; rejected uploads stayed on disk without consuming quota. | Chunked read with cap; rejected submission dirs are removed. |
| F12 | Medium | Server | No cap on expanded size (50 MB deflate zip → many GB on disk). | `SELFTEST_MAX_UNZIPPED_MB` (default 200) on declared sizes; Python's zip reader enforces declared sizes. |
| F13 | Medium | Server | App images were never removed (janitor only prunes dangling images at startup) → disk fills over time. | Image removed after every evaluation. |
| F14 | — | Server | Functional bug found while testing: `containers.run(network_aliases=…)` is not a docker-py argument, so `run_app` always failed. | Alias set through `networking_config`. |
| F15 | Critical | Actions | Open item #4: a single `grade` job held `contents: write` *and* built/ran the untrusted submission — a container escape got a token that could push to this repo. | Split into `prepare` (signature check, holds `SELFTEST_DISPATCH_SIGNING_KEY`, never touches submission content) / `grade` (`contents: read`, holds only `APP_DOWNLOAD_TOKEN`, builds and runs the submission) / `report` (`contents: write`, holds the callback/signing secrets, only ever reads the already-filtered `result.json` artifact). |
| F16 | High | Actions | Open item #3: the Playwright runner container ran as root, which can only launch Chromium with its own sandbox disabled. | `runner/Dockerfile` now runs the entrypoint as the image's unprivileged `node` user (`PLAYWRIGHT_BROWSERS_PATH=/ms-playwright` made world-readable so the browser install from the root build stage is still reachable), so Chromium's namespace sandbox engages without `--no-sandbox` or extra `--cap-add`. The test-pack mount was already scoped to just the current task (never the whole private pack), so this closes the remaining gap rather than relying on scope alone. |
| F17 | Medium | Actions | Open item #2: `timeout N docker build` only kills the client process — against the legacy builder the daemon keeps building, unbounded, after the client exits. No memory/CPU cap on the build either. | `grade.sh` pins `DOCKER_BUILDKIT=1` (so client-session teardown actually cancels the daemon-side build), adds `--kill-after=10 --signal=TERM`, caps the build with `--memory=2g --memory-swap=2g --cpu-quota=200000 --cpu-period=100000`, and prunes build cache in the cleanup trap. |
| F18 | Medium | Actions | Open item #7 (partial — grader side): the outbound callback signed only the raw body, so a captured POST could be replayed indefinitely within the signature's lifetime. | `report_back.py` now signs `"{timestamp}.{nonce}.{sha256(body)}"` and sends `X-Timestamp`/`X-Nonce`/`X-Signature`. The grader is stateless across runs, so the nonce-dedup *store* has to live on the receiver (documented in `actions/README_ACTIONS.md` "Callback verification" as a contract for the self-test/web side — not implemented there by this pass). |
| F19 | — | Actions | New: a download failure, a runner-harness crash, or (by contract) a dispatch stuck in the Actions queue were all indistinguishable from the participant's own app failing — no way for the self-test service to retry fairly or avoid charging quota for an infra hiccup. | Introduced a `status` vocabulary (`passed`/`failed`/`system_error`/`rejected`) through `grade.sh` → `parse_report.py` → `result.json`; `grade.sh` also retries a runner-harness crash (no report produced, not a decided app-fault exit code) once before reporting `system_error`. Contract documented in `actions/README_ACTIONS.md` "Result fields": `system_error` should be retried once and never charged against the daily quota; `rejected` should not be retried. |

## Open items (larger changes, not done here)

### Critical / High

1. **Server holds the host Docker socket and builds untrusted Dockerfiles on
   the host daemon** (`compose.yml`). Any code execution in the API process
   = root on the host, and every participant build/run shares the host
   kernel. Recommendation: run builds and app containers on a separate
   disposable VM (or one VM per job); use a sandboxed runtime for app and
   runner containers (`--runtime=runsc` gVisor, or Kata); if the socket must
   stay, front it with a socket proxy that only allows the build/create/
   start/logs/remove calls; run the API container as non-root.
2. ~~**Build step has no resource limits and the timeout does not stop
   it.**~~ Fixed for the Actions channel — see F17. `DockerOps.build_image`
   on the **server/** (self-hosted docker-compose) channel still has this
   exact gap (checks the timeout only when a log line arrives, then just
   stops reading while the daemon keeps building) and remains open there:
   build with `docker buildx build` in a subprocess killed on timeout (or a
   per-job builder container), pass memory/CPU limits, put Docker's data
   root on a size-limited volume and prune builder cache after each job,
   pre-pull an allowlist of base images and reject other `FROM` lines or
   run the daemon without registry access during builds.
3. ~~**The runner container holds the whole test pack while its Chromium
   loads participant-controlled pages.**~~ Fixed for the Actions channel —
   see F16 (non-root runner, sandbox engaged; the mount was already scoped
   to the current task only). The **server/** channel's runner still
   launches Chromium as root; apply the same non-root fix there, plus
   `--read-only` root with tmpfs and a current Playwright/Chromium pin.
4. ~~**GITHUB_TOKEN has `contents: write` in the same job that builds and
   runs untrusted code.**~~ Fixed — see F15 (`prepare`/`grade`/`report`
   split). Third-party actions (`actions/checkout`, `actions/upload-` /
   `download-artifact`) are still pinned by tag, not commit SHA — low
   severity (official GitHub-authored actions) but worth doing before a
   real production launch.

### Medium

5. **App logs are a side channel for test content in public mode.** The app
   sees every request the tests make and its log is returned to the team.
   Acceptable for public tasks; hidden mode now withholds it (both channels).
   Pass counts remain an oracle bounded by the daily quota — keep the quota
   low for hidden tasks and do not return per-test timing.
6. **Actions debug artifact** (`debug-<id>`) contains `report.json`,
   runner/app/build logs and Playwright `output/` (error-context files quote
   test source) for 3 days, readable by anyone with read access to the grader
   repo. Recommendation: drop the step in production or limit it to
   maintainers via a separate private repo; keep the grader repo free of
   outside collaborators.
7. **Callback trust.** `CALLBACK_TOKEN` is sent to whatever `callback_url`
   the dispatch carries (now https-only). Partially fixed — see F18: the
   outbound POST now carries a timestamp+nonce HMAC
   (`X-Timestamp`/`X-Nonce`/`X-Signature`), so forging or replaying it needs
   the shared signing key either way. Still open: the *receiver* (self-test
   service / `actions/web`) needs to actually verify those three headers and
   persist seen nonces — not implemented in this repo, since the grader is
   stateless across runs; take the callback URL from a repo variable rather
   than the payload once that lands.
8. **Token in query string** (`?token=` for screenshots/logs) ends up in
   access logs, browser history and Referer. Recommendation: short-lived
   signed URLs per artifact, or an HttpOnly SameSite cookie session.
9. **No TLS; port published on all interfaces.** Recommendation: bind
   `127.0.0.1:8080` in compose and terminate TLS at a reverse proxy; add
   `Content-Security-Policy: default-src 'self'` and `Referrer-Policy:
   no-referrer` to the UI.
10. **Static team tokens, no rate limit on failed auth or on GET endpoints.**
    Recommendation: ≥128-bit random tokens, rotation procedure, per-IP rate
    limit on 401s and polling.

### Low

11. `SELFTEST_EVALUATOR=arcbench` imports `run_submission.py` into the API
    process; make sure the platform runner keeps the same container
    isolation, otherwise participant code would run inside the container
    that holds the Docker socket.
12. The Actions runner image is rebuilt from npm on every run; use a
    prebuilt image pinned by digest (`GRADER_RUNNER_IMAGE`).
13. `runner/Dockerfile`'s optional `APT_MIRROR` example points at a
    third-party mirror; production builds should use official sources only.

## Checked and fine

- Zip handling: absolute paths and `..` rejected in both channels, symlink
  entries rejected (Actions) / never materialised (Python `extractall`),
  file-count caps present.
- App containers: build `--network=none`, run on an `--internal` network,
  read-only root, memory/CPU/pid limits; the test pack is mounted only into
  the runner, never into the app container.
- Team isolation: every submission/log/artifact endpoint checks ownership;
  submission ids are random; quota consume is atomic under a lock.
- Web UI escapes all server-provided text before `innerHTML`; auth via a
  custom header means cross-site form posts cannot submit (no CSRF), and no
  CORS is enabled.
