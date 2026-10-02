import { createHash, randomUUID } from 'node:crypto';
import { put, list, del } from './r2';
import type { Submission, GradeResult, SubmissionStatus } from './types';
import {
  dispatchGrade,
  fetchGraderResult,
  fetchGraderScreenshots,
  findGradeRun,
  gradeRunNeverStarted,
  hasRecentGradeRun,
} from './github';
import { signDispatch } from './signature';

// Vercel KV turned out to need a marketplace integration with an
// interactive "accept terms" step (no non-interactive provisioning path),
// so all app state lives in Vercel Blob instead. That came with a sharp
// edge, found by testing (not by inspection): public Blob URLs sit behind
// a CDN that does NOT reliably reflect an overwrite (`allowOverwrite`) on
// the very next read. A quota counter that wrote-then-read-back the same
// URL silently under-counted forever (fixed — see tryConsumeUserQuota).
// The submission record had the identical bug: the grader's result
// callback overwrote `state/submissions/<id>.json`, returned 200, and the
// participant's poll kept reading the pre-overwrite ("queued") version
// indefinitely.
//
// Fix, applied uniformly: never overwrite a blob. Each submission is a
// small append-only set of objects under `state/submissions/<id>/` —
// `created.json` written once at submit time, `result.json` written once
// (if at all) by the callback or recovered from the grader, `timeout.json`
// written once if no result ever arrives — and reads always go through
// list() (which behaved consistently in testing, same as it already did
// for listUserSubmissions) rather than re-fetching a URL that might have
// been written to since it was first cached.
//
// A result can also be missing because the grader never managed to deliver
// it: a callback rejected by a signature mismatch during a key rotation, a
// grade job cancelled before it reported, a dispatch the grader refused,
// or — the failure mode this was built for — a dispatch call that reported
// success but never actually created a run on the grader repo. Reconciling
// only on read (a participant polling the page) meant a submission left
// unattended just sat at "queued" forever, so it also runs proactively from
// a scheduler (see /api/cron/reconcile) on every queued submission:
//   - from RUN_ENDED_CHECK_AFTER_MS, if this submission's run (grade.yml's
//     run-name carries the submission id) has already finished without a
//     result reaching us — including a run GitHub never started, e.g. out of
//     Actions minutes — recover its artifact or mark system_error right away
//     (see checkRunEnded);
//   - after RUN_CHECK_AFTER_MS, confirm a grade-workflow run actually exists
//     on GitHub; if not, redispatch once (see reconcileQueued/claimRedispatch);
//   - after RECOVER_AFTER_MS, pull the grade job's own result artifact from
//     the grader repo (same file the report job would have POSTed);
//   - after STALE_AFTER_MS with still nothing, write `timeout.json` — a
//     system_error that releases the quota slot. A late real result.json
//     still wins over it (see assembleSubmission).
const RUN_CHECK_AFTER_MS = 3 * 60 * 1000;
// Once the submission's own run (matched by run-name) has finished, its
// callback normally lands within seconds; after this grace with still no
// result, the run is over and nothing more will come.
const RUN_ENDED_CHECK_AFTER_MS = 60 * 1000;
const RUN_ENDED_GRACE_MS = 45 * 1000;
const RUN_ENDED_RETRY_MS = 30 * 1000;
const RECOVER_AFTER_MS = 8 * 60 * 1000;
const RECOVER_RETRY_MS = 60 * 1000;
const STALE_AFTER_MS = 30 * 60 * 1000;

function submissionDir(id: string): string {
  return `state/submissions/${id}/`;
}

type StoredCreated = Omit<Submission, 'status' | 'result' | 'updatedAt'> & {
  // Needed to redispatch from the cron reconciler without the participant
  // involved — never sent to the browser (not part of the Submission type).
  downloadUrl: string;
  callbackUrl: string;
  // Quota marker paths consumed by this submission, released if the
  // platform (not the participant) fails it. Never sent to the browser.
  quotaMarkers?: string[];
};
type StoredResult = { status: SubmissionStatus; result: GradeResult; updatedAt: number };

export async function createSubmission(
  sub: Submission,
  extra: { downloadUrl: string; callbackUrl: string },
  quotaMarkers: (string | null)[] = [],
): Promise<void> {
  const created: StoredCreated = {
    id: sub.id,
    githubId: sub.githubId,
    githubLogin: sub.githubLogin,
    taskId: sub.taskId,
    createdAt: sub.createdAt,
    downloadUrl: extra.downloadUrl,
    callbackUrl: extra.callbackUrl,
    quotaMarkers: quotaMarkers.filter((m): m is string => Boolean(m)),
  };
  await put(`${submissionDir(sub.id)}created.json`, JSON.stringify(created), {
    access: 'public',
    addRandomSuffix: false,
    contentType: 'application/json',
  });
}

function normalizeStatus(status: string): 'passed' | 'failed' | 'system_error' {
  if (status === 'passed' || status === 'failed') return status;
  // 'rejected' (the grader refused our own signed dispatch) and 'error'
  // (could not start grading) are both platform-side failures.
  return 'system_error';
}

async function writeOnce(path: string, payload: StoredResult): Promise<boolean> {
  try {
    await put(path, JSON.stringify(payload), {
      access: 'public',
      addRandomSuffix: false,
      contentType: 'application/json',
    });
    return true;
  } catch (err) {
    // put() without allowOverwrite refuses an existing path: first write wins.
    if (/already exists/i.test(String(err))) return false;
    throw err;
  }
}

async function releaseQuotaMarkers(created: StoredCreated | null): Promise<void> {
  await Promise.all((created?.quotaMarkers ?? []).map((m) => removeMarker(m)));
}

/** Returns false if a result was already recorded for this submission. */
export async function recordResult(id: string, result: GradeResult): Promise<boolean> {
  const status = normalizeStatus(result.status);
  const payload: StoredResult = { status, result: { ...result, status }, updatedAt: Date.now() };
  const written = await writeOnce(`${submissionDir(id)}result.json`, payload);
  if (written && status === 'system_error') {
    await releaseQuotaMarkers(await readCreated(id));
  }
  return written;
}

async function fetchJson<T>(url: string): Promise<T | null> {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) return null;
  return (await res.json()) as T;
}

function assembleSubmission(
  created: StoredCreated,
  result: StoredResult | null,
  timeout: StoredResult | null,
): Submission {
  const r = result ?? timeout;
  return {
    id: created.id,
    githubId: created.githubId,
    githubLogin: created.githubLogin,
    taskId: created.taskId,
    createdAt: created.createdAt,
    status: r?.status ?? 'queued',
    result: r?.result ?? null,
    updatedAt: r?.updatedAt ?? created.createdAt,
  };
}

type BlobUrls = { created?: string; result?: string; timeout?: string };

const FILE_KEYS: Record<string, keyof BlobUrls> = {
  'created.json': 'created',
  'result.json': 'result',
  'timeout.json': 'timeout',
};

async function listAll(prefix: string) {
  const blobs: { pathname: string; url: string; uploadedAt: Date }[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix, cursor, limit: 1000 });
    blobs.push(...page.blobs);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return blobs;
}

async function urlsFor(id: string): Promise<BlobUrls> {
  const urls: BlobUrls = {};
  for (const b of await listAll(submissionDir(id))) {
    const key = FILE_KEYS[b.pathname.slice(submissionDir(id).length)];
    if (key) urls[key] = b.url;
  }
  return urls;
}

async function readCreated(id: string): Promise<StoredCreated | null> {
  const { created } = await urlsFor(id);
  return created ? fetchJson<StoredCreated>(created) : null;
}

// Redispatch marker, same first-write-wins trick as writeOnce: claiming it
// is both "only try this once per submission" and a race guard against two
// cron ticks (or a cron tick and a page read) both deciding to redispatch.
async function claimRedispatch(id: string): Promise<boolean> {
  try {
    await put(`${submissionDir(id)}redispatch.json`, String(Date.now()), {
      access: 'public',
      addRandomSuffix: false,
      contentType: 'application/json',
    });
    return true;
  } catch (err) {
    if (/already exists/i.test(String(err))) return false;
    throw err;
  }
}

async function redispatchSubmission(created: StoredCreated): Promise<void> {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signDispatch(created.id, created.taskId, timestamp);
  await dispatchGrade({
    submissionId: created.id,
    taskId: created.taskId,
    downloadUrl: created.downloadUrl,
    callbackUrl: created.callbackUrl,
    timestamp,
    signature,
  });
}

// After RUN_CHECK_AFTER_MS, confirm the original dispatch actually produced
// a run on the grader repo; if not, redispatch exactly once. A redispatch
// that itself fails (GitHub API down, bad token, etc.) is a platform fault
// known right now — no reason to make the participant wait out the full
// STALE_AFTER_MS for the same answer.
async function checkRunAndMaybeRedispatch(created: StoredCreated): Promise<Submission | null> {
  const age = Date.now() - created.createdAt;
  if (age < RUN_CHECK_AFTER_MS) return null;
  if (!(await claimRedispatch(created.id))) return null;

  const hasRun = await hasRecentGradeRun(created.createdAt, created.id);
  if (hasRun) return null;

  try {
    await redispatchSubmission(created);
    console.error(`reconcile: redispatched ${created.id} — no grade-workflow run was found after ${age}ms`);
    return null;
  } catch (err) {
    console.error(`reconcile: redispatch failed for ${created.id}: ${String(err)}`);
    const result: GradeResult = {
      submission_id: created.id,
      task_id: created.taskId,
      visibility: 'public',
      status: 'system_error',
      passed: 0,
      total: 0,
      detail: `could not restart grading after the original dispatch produced no run: ${String(err)}`,
    };
    await recordResult(created.id, result);
    return getStoredSubmission(created.id);
  }
}

const lastRecoveryAttempt = new Map<string, number>();

async function reconcile(created: StoredCreated): Promise<Submission | null> {
  const ended = await checkRunEnded(created);
  if (ended) return ended;

  const redispatched = await checkRunAndMaybeRedispatch(created);
  if (redispatched) return redispatched;

  const age = Date.now() - created.createdAt;
  if (age < RECOVER_AFTER_MS) return null;

  const last = lastRecoveryAttempt.get(created.id) ?? 0;
  if (Date.now() - last > RECOVER_RETRY_MS) {
    lastRecoveryAttempt.set(created.id, Date.now());
    const recovered = await fetchGraderResult(created.id).catch(() => null);
    if (recovered && recovered.submission_id === created.id) {
      await recordResult(created.id, recovered);
      const fresh = await getStoredSubmission(created.id);
      if (fresh && fresh.status !== 'queued') return fresh;
    }
  }

  if (age < STALE_AFTER_MS) return null;
  return giveUp(created, `评测超时：${Math.round(STALE_AFTER_MS / 60000)} 分钟内未收到评测结果。`);
}

// No result is coming: record a system_error (doesn't count, quota slot
// released). Written as timeout.json, so a late real result.json still wins.
async function giveUp(created: StoredCreated, detail: string): Promise<Submission> {
  const result: GradeResult = {
    submission_id: created.id,
    task_id: created.taskId,
    visibility: 'public',
    status: 'system_error',
    passed: 0,
    total: 0,
    detail,
  };
  const timeout: StoredResult = { status: 'system_error', result, updatedAt: Date.now() };
  if (await writeOnce(`${submissionDir(created.id)}timeout.json`, timeout)) {
    await releaseQuotaMarkers(created);
  }
  return assembleSubmission(created, null, timeout);
}

const lastRunEndedCheck = new Map<string, number>();

async function checkRunEnded(created: StoredCreated): Promise<Submission | null> {
  if (Date.now() - created.createdAt < RUN_ENDED_CHECK_AFTER_MS) return null;
  if (Date.now() - (lastRunEndedCheck.get(created.id) ?? 0) < RUN_ENDED_RETRY_MS) return null;
  lastRunEndedCheck.set(created.id, Date.now());

  const run = await findGradeRun(created.id, created.createdAt).catch(() => undefined);
  if (!run || run.status !== 'completed' || Date.now() - run.updatedAt < RUN_ENDED_GRACE_MS) return null;

  const recovered = await fetchGraderResult(created.id).catch(() => null);
  if (recovered && recovered.submission_id === created.id) {
    await recordResult(created.id, recovered);
    const fresh = await getStoredSubmission(created.id);
    if (fresh && fresh.status !== 'queued') return fresh;
  }
  const neverStarted = await gradeRunNeverStarted(run.id).catch(() => false);
  return giveUp(
    created,
    neverStarted
      ? `grading never started on GitHub Actions (run ${run.id})`
      : `grade run ${run.id} ended (${run.conclusion ?? 'unknown'}) without delivering a result`,
  );
}

async function loadSubmission(urls: BlobUrls): Promise<{ created: StoredCreated; sub: Submission } | null> {
  if (!urls.created) return null;
  const [created, result, timeout] = await Promise.all([
    fetchJson<StoredCreated>(urls.created),
    urls.result ? fetchJson<StoredResult>(urls.result) : Promise.resolve(null),
    urls.timeout ? fetchJson<StoredResult>(urls.timeout) : Promise.resolve(null),
  ]);
  if (!created) return null;
  return { created, sub: assembleSubmission(created, result, timeout) };
}

async function getStoredSubmission(id: string): Promise<Submission | null> {
  return (await loadSubmission(await urlsFor(id)))?.sub ?? null;
}

async function withReconcile(loaded: { created: StoredCreated; sub: Submission } | null) {
  if (!loaded) return null;
  if (loaded.sub.status !== 'queued') return loaded.sub;
  return (await reconcile(loaded.created)) ?? loaded.sub;
}

export async function getSubmission(id: string): Promise<Submission | null> {
  return withReconcile(await loadSubmission(await urlsFor(id)));
}

async function allSubmissions(): Promise<{ created: StoredCreated; sub: Submission }[]> {
  const byId = new Map<string, BlobUrls>();
  for (const b of await listAll('state/submissions/')) {
    const rest = b.pathname.slice('state/submissions/'.length);
    const [id, file] = rest.split('/');
    const key = file ? FILE_KEYS[file] : undefined;
    if (!id || !key) continue;
    const entry = byId.get(id) ?? {};
    entry[key] = b.url;
    byId.set(id, entry);
  }
  const loaded = await Promise.all(Array.from(byId.values()).map(loadSubmission));
  return loaded.filter((l): l is { created: StoredCreated; sub: Submission } => l !== null);
}

// Called by /api/cron/reconcile so stuck submissions get checked on a
// schedule, not only when a participant happens to have the page open.
export type ReconcileSummary = { checked: number; stillQueued: number };

export async function reconcileQueued(): Promise<ReconcileSummary> {
  const queued = (await allSubmissions()).filter((l) => l.sub.status === 'queued');
  const results = await Promise.all(queued.map((l) => reconcile(l.created)));
  const stillQueued = results.filter((r) => r === null || r.status === 'queued').length;
  return { checked: queued.length, stillQueued };
}

export async function listUserSubmissions(githubId: string, limit = 50): Promise<Submission[]> {
  const mine = (await allSubmissions())
    .filter((l) => l.created.githubId === githubId)
    .sort((a, b) => b.created.createdAt - a.created.createdAt)
    .slice(0, limit);
  const subs = await Promise.all(mine.map(withReconcile));
  return subs.filter((s): s is Submission => s !== null);
}

// --- Failure screenshots: copied out of the grader's debug artifact (which
// expires after a few days) into Blob, served only through the owner-checked
// /api/submissions/<id>/screenshot route. ---

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
const missingScreenshots = new Map<string, number>();

function screenshotPaths(result: GradeResult | null): string[] {
  const paths = new Set<string>();
  for (const t of result?.tests ?? []) if (t.screenshot) paths.add(t.screenshot);
  return [...paths];
}

function screenshotBlobPath(id: string, rel: string): string {
  return `${submissionDir(id)}shots/${createHash('sha256').update(rel).digest('hex').slice(0, 32)}.png`;
}

export async function cacheScreenshots(id: string, result: GradeResult | null): Promise<Map<string, Buffer>> {
  const shots = await fetchGraderScreenshots(id, screenshotPaths(result));
  const valid = new Map<string, Buffer>();
  for (const [rel, data] of shots) {
    if (data.length > MAX_SCREENSHOT_BYTES || !data.subarray(0, 4).equals(PNG_MAGIC)) continue;
    valid.set(rel, data);
  }
  await Promise.all(
    [...valid].map(([rel, data]) =>
      put(screenshotBlobPath(id, rel), data, {
        access: 'public',
        addRandomSuffix: false,
        contentType: 'image/png',
      }).catch(() => undefined), // already cached by a concurrent request
    ),
  );
  return valid;
}

/** Only paths listed in this submission's own result are served. */
export async function getScreenshot(sub: Submission, rel: string): Promise<Buffer | null> {
  if (!screenshotPaths(sub.result).includes(rel)) return null;
  const { blobs } = await list({ prefix: screenshotBlobPath(sub.id, rel) });
  if (blobs[0]) {
    const res = await fetch(blobs[0].url, { cache: 'no-store' });
    if (res.ok) return Buffer.from(await res.arrayBuffer());
  }
  // Not cached yet (e.g. graded before caching existed): pull the artifact
  // once, but don't hammer GitHub for one that has already expired.
  if (Date.now() - (missingScreenshots.get(sub.id) ?? 0) < 5 * 60 * 1000) return null;
  const cached = await cacheScreenshots(sub.id, sub.result).catch(() => new Map<string, Buffer>());
  if (!cached.size) missingScreenshots.set(sub.id, Date.now());
  return cached.get(rel) ?? null;
}

// --- Typical grading time, from real recent submissions (submit -> result),
// for the waiting page's estimate. Cached per instance for a few minutes. ---

const DEFAULT_TYPICAL_S = 8 * 60;
let typicalCache: { at: number; seconds: number } | null = null;

export async function typicalGradingSeconds(): Promise<number> {
  if (typicalCache && Date.now() - typicalCache.at < 5 * 60 * 1000) return typicalCache.seconds;
  const created = new Map<string, number>();
  const results: { id: string; url: string; at: number }[] = [];
  for (const b of await listAll('state/submissions/')) {
    const [id, file] = b.pathname.slice('state/submissions/'.length).split('/');
    if (file === 'created.json') created.set(id, b.uploadedAt.getTime());
    if (file === 'result.json') results.push({ id, url: b.url, at: b.uploadedAt.getTime() });
  }
  const recent = results
    .filter((r) => created.has(r.id))
    .sort((a, b) => b.at - a.at)
    .slice(0, 30);
  const samples = (
    await Promise.all(
      recent.map(async (r) => {
        const stored = await fetchJson<StoredResult>(r.url).catch(() => null);
        // Platform failures end early and say nothing about a normal run.
        if (stored?.status !== 'passed' && stored?.status !== 'failed') return null;
        const seconds = (r.at - created.get(r.id)!) / 1000;
        return seconds > 0 && seconds < STALE_AFTER_MS / 1000 ? seconds : null;
      }),
    )
  )
    .filter((x): x is number => x !== null)
    .sort((a, b) => a - b);
  // 75th percentile: an estimate most submissions finish within.
  const seconds = samples.length >= 3 ? Math.round(samples[Math.floor(samples.length * 0.75)]) : DEFAULT_TYPICAL_S;
  typicalCache = { at: Date.now(), seconds };
  return seconds;
}

// --- Direct-to-Blob uploads: the browser PUTs the zip to a presigned URL
// (Vercel functions cap request bodies at 4.5MB), so /api/upload-url first
// records who may submit that upload id, for which task. /api/submit checks
// this intent before charging quota. ---

type UploadIntent = { id: string; githubId: string; taskId: string; createdAt: number };

export async function createUploadIntent(intent: UploadIntent): Promise<void> {
  await put(`state/uploads/${intent.id}.json`, JSON.stringify(intent), {
    access: 'public',
    addRandomSuffix: false,
    contentType: 'application/json',
  });
}

export async function readUploadIntent(id: string): Promise<UploadIntent | null> {
  const { blobs } = await list({ prefix: `state/uploads/${id}.json` });
  return blobs[0] ? fetchJson<UploadIntent>(blobs[0].url) : null;
}

export async function submissionExists(id: string): Promise<boolean> {
  return Boolean((await urlsFor(id)).created);
}

// --- Callback replay protection: one marker per nonce, first write wins
// (put() without allowOverwrite rejects a path that already exists). ---

export async function claimCallbackNonce(nonce: string): Promise<boolean> {
  const path = `state/callback-nonces/${nonce}.json`;
  try {
    await put(path, '1', { access: 'public', addRandomSuffix: false, contentType: 'application/json' });
    return true;
  } catch {
    return false;
  }
}

// --- Quota: same append-only, list()-counted approach (see module doc). ---

function today(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD, UTC
}

function quotaPrefix(scope: string): string {
  return `state/quota/${scope}/${today()}/`;
}

async function countMarkers(prefix: string): Promise<number> {
  const { blobs } = await list({ prefix });
  return blobs.length;
}

async function addMarker(prefix: string): Promise<string> {
  const path = `${prefix}${randomUUID()}.json`;
  await put(path, '1', { access: 'public', addRandomSuffix: false, contentType: 'application/json' });
  return path;
}

async function removeMarker(path: string | null): Promise<void> {
  if (!path) return;
  try {
    await del(path);
  } catch {
    // best-effort — a leftover marker just makes that one slot look used
  }
}

/** Read-only check, so a participant out of quota isn't asked to upload first. */
export async function quotaBlocked(
  githubId: string,
  userLimit: number,
  globalLimit: number,
): Promise<'user' | 'global' | null> {
  const [user, global] = await Promise.all([
    countMarkers(quotaPrefix(`user-${githubId}`)),
    countMarkers(quotaPrefix('global')),
  ]);
  if (user >= userLimit) return 'user';
  if (global >= globalLimit) return 'global';
  return null;
}

export type QuotaConsumption = { ok: boolean; markerPath: string | null };

export async function tryConsumeUserQuota(githubId: string, limit: number): Promise<QuotaConsumption> {
  const prefix = quotaPrefix(`user-${githubId}`);
  const current = await countMarkers(prefix);
  if (current >= limit) return { ok: false, markerPath: null };
  return { ok: true, markerPath: await addMarker(prefix) };
}

export async function releaseUserQuota(markerPath: string | null): Promise<void> {
  await removeMarker(markerPath);
}

export async function tryConsumeGlobalQuota(limit: number): Promise<QuotaConsumption> {
  const prefix = quotaPrefix('global');
  const current = await countMarkers(prefix);
  if (current >= limit) return { ok: false, markerPath: null };
  return { ok: true, markerPath: await addMarker(prefix) };
}

export async function releaseGlobalQuota(markerPath: string | null): Promise<void> {
  await removeMarker(markerPath);
}
