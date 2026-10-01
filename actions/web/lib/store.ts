import { randomUUID } from 'node:crypto';
import { put, list, del } from '@vercel/blob';
import type { Submission, GradeResult, SubmissionStatus } from './types';

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
// (if at all) by the callback — and reads always go through list() (which
// behaved consistently in testing, same as it already did for
// listUserSubmissions) rather than re-fetching a URL that might have been
// written to since it was first cached.

function submissionDir(id: string): string {
  return `state/submissions/${id}/`;
}

type StoredCreated = Omit<Submission, 'status' | 'result' | 'updatedAt'>;
type StoredResult = { status: SubmissionStatus; result: GradeResult; updatedAt: number };

export async function createSubmission(sub: Submission): Promise<void> {
  const created: StoredCreated = {
    id: sub.id,
    githubId: sub.githubId,
    githubLogin: sub.githubLogin,
    taskId: sub.taskId,
    createdAt: sub.createdAt,
  };
  await put(`${submissionDir(sub.id)}created.json`, JSON.stringify(created), {
    access: 'public',
    addRandomSuffix: false,
    contentType: 'application/json',
  });
}

export async function recordResult(id: string, result: GradeResult): Promise<void> {
  const payload: StoredResult = { status: result.status, result, updatedAt: Date.now() };
  await put(`${submissionDir(id)}result.json`, JSON.stringify(payload), {
    access: 'public',
    addRandomSuffix: false,
    contentType: 'application/json',
  });
}

async function fetchJson<T>(url: string): Promise<T | null> {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) return null;
  return (await res.json()) as T;
}

function assembleSubmission(created: StoredCreated, result: StoredResult | null): Submission {
  return {
    ...created,
    status: result?.status ?? 'queued',
    result: result?.result ?? null,
    updatedAt: result?.updatedAt ?? created.createdAt,
  };
}

export async function getSubmission(id: string): Promise<Submission | null> {
  const { blobs } = await list({ prefix: submissionDir(id) });
  const createdBlob = blobs.find((b) => b.pathname.endsWith('/created.json'));
  if (!createdBlob) return null;
  const resultBlob = blobs.find((b) => b.pathname.endsWith('/result.json'));
  const [created, result] = await Promise.all([
    fetchJson<StoredCreated>(createdBlob.url),
    resultBlob ? fetchJson<StoredResult>(resultBlob.url) : Promise.resolve(null),
  ]);
  if (!created) return null;
  return assembleSubmission(created, result);
}

export async function listUserSubmissions(githubId: string, limit = 50): Promise<Submission[]> {
  const { blobs } = await list({ prefix: 'state/submissions/' });
  const byId = new Map<string, { created?: string; result?: string }>();
  for (const b of blobs) {
    const rest = b.pathname.slice('state/submissions/'.length);
    const [id, file] = rest.split('/');
    if (!id || !file) continue;
    const entry = byId.get(id) ?? {};
    if (file === 'created.json') entry.created = b.url;
    if (file === 'result.json') entry.result = b.url;
    byId.set(id, entry);
  }

  const submissions = await Promise.all(
    Array.from(byId.values()).map(async ({ created, result }) => {
      if (!created) return null;
      const c = await fetchJson<StoredCreated>(created);
      if (!c) return null;
      const r = result ? await fetchJson<StoredResult>(result) : null;
      return assembleSubmission(c, r);
    }),
  );

  return submissions
    .filter((s): s is Submission => s !== null && s.githubId === githubId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
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
