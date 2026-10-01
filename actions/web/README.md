# arcbench self-test web

Participant-facing site for the GitHub Actions grader: sign in with GitHub,
pick a task, upload a zip, watch the result. No leaderboard — results are
only visible to the submitter. Deployed on Vercel; see the repo root
`actions/README_ACTIONS.md` ("Web app" section) for setup (OAuth App,
service token, KV/Blob stores, env vars) and the deployed URL.

- `app/` — Next.js App Router pages + API routes (`app/api/*`).
- `lib/` — GitHub API calls (service token), KV storage, quota, HMAC
  signing (mirrors `actions/template/scripts/verify_signature.py`), auth.
- Holds no task content and no participant app code beyond the lifetime of
  a single grading run (the uploaded zip is deleted from Blob storage once
  the grader's result callback arrives).
