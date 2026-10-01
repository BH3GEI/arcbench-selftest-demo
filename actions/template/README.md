# grader (private)

GitHub Actions-based grader for arcbench-style tasks. See the public repo's
`README_ACTIONS.md` for setup, secrets, and how to import a task — this file
is just a pointer kept inside the private repo for convenience.

- `tasks/<task_id>/requirements/` + `tasks/<task_id>/tests/*.spec.ts` — one
  folder per task, same shape as arcbench task folders. Drop one in as-is.
- `.github/workflows/grade.yml` — the entry point (`repository_dispatch` or
  `workflow_dispatch`).
- `scripts/grade.sh` — build app (isolated) -> run app (no outbound network)
  -> run Playwright pack against it (another container, BASE_URL only) ->
  parse -> report back. Never leaves task/test content in the public Actions
  log.
- `runner/` — the Playwright image, pack-agnostic, same Dockerfile as the
  local self-test demo's `runner/`.
