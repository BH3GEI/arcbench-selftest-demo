import { randomUUID } from 'node:crypto';
import { put, head, list, del } from '@vercel/blob';
import type { Submission } from './types';

// Vercel KV turned out to need a marketplace integration with an
// interactive "accept terms" step (no non-interactive provisioning path),
// so all app state — not just the submitted zips — lives in Vercel Blob
// instead.
//
// Submissions: one JSON object per submission at an unguessable UUID path,
// overwritten in place as status changes. Public access, but not listable
// without the project's write token — acceptable at this scale.
//
// Quota: NOT a read-modify-write counter on a single overwritten blob —
// public Blob URLs sit behind a CDN that does not reliably reflect an
// overwrite on the very next read (confirmed empirically: a counter
// written and immediately re-read came back stale, under-counting and
// defeating the limit entirely). Instead each consumed submission writes
// its own small marker blob under a per-user-per-day (or per-day, for the
// global limit) prefix, and the check is "how many markers exist under
// this prefix" via list(), which hits the Blob index rather than a cached
// per-URL CDN response — the same list() call listUserSubmissions() already
// relies on, observed consistent in practice. Release (the compensating
// decrement when the *other* quota check fails) deletes that one marker.

function submissionPath(id: string): string {
  return `state/submissions/${id}.json`;
}

export async function saveSubmission(sub: Submission): Promise<void> {
  await put(submissionPath(sub.id), JSON.stringify(sub), {
    access: 'public',
    addRandomSuffix: false,
    contentType: 'application/json',
    allowOverwrite: true,
  });
}

async function fetchJson<T>(url: string): Promise<T | null> {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) return null;
  return (await res.json()) as T;
}

export async function getSubmission(id: string): Promise<Submission | null> {
  try {
    const info = await head(submissionPath(id));
    return await fetchJson<Submission>(info.url);
  } catch {
    return null;
  }
}

export async function listUserSubmissions(githubId: string, limit = 50): Promise<Submission[]> {
  const { blobs } = await list({ prefix: 'state/submissions/' });
  const all = await Promise.all(blobs.map((b) => fetchJson<Submission>(b.url)));
  return all
    .filter((s): s is Submission => s !== null && s.githubId === githubId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
}

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
