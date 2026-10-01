import { put, head, list } from '@vercel/blob';
import type { Submission } from './types';

// Vercel KV turned out to need a marketplace integration with an
// interactive "accept terms" step (no non-interactive provisioning path),
// so all app state — not just the submitted zips — lives in Vercel Blob
// instead: one JSON object per submission, one per quota counter. Paths use
// an unguessable UUID (submissions) or a predictable-but-not-sensitive key
// (quota counters), and are world-readable (Blob's "public" access) but not
// listable without the project's write token — acceptable at this scale.
// Known limitation: read-modify-write quota increments aren't atomic like a
// real KV INCR would be, so a rare race under heavy concurrent submissions
// from the same user could let one or two extra requests through. Fine for
// a self-test tool; swap for a proper counter if that ever matters.

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

function quotaPath(scope: string, date: string): string {
  return `state/quota/${scope}/${date}.json`;
}

async function readCount(path: string): Promise<number> {
  try {
    const info = await head(path);
    const data = await fetchJson<{ count: number }>(info.url);
    return data?.count ?? 0;
  } catch {
    return 0;
  }
}

async function writeCount(path: string, count: number): Promise<void> {
  await put(path, JSON.stringify({ count }), {
    access: 'public',
    addRandomSuffix: false,
    contentType: 'application/json',
    allowOverwrite: true,
  });
}

function today(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD, UTC
}

export async function tryConsumeUserQuota(githubId: string, limit: number): Promise<boolean> {
  const path = quotaPath(`user-${githubId}`, today());
  const current = await readCount(path);
  if (current >= limit) return false;
  await writeCount(path, current + 1);
  return true;
}

export async function releaseUserQuota(githubId: string): Promise<void> {
  const path = quotaPath(`user-${githubId}`, today());
  const current = await readCount(path);
  await writeCount(path, Math.max(0, current - 1));
}

export async function tryConsumeGlobalQuota(limit: number): Promise<boolean> {
  const path = quotaPath('global', today());
  const current = await readCount(path);
  if (current >= limit) return false;
  await writeCount(path, current + 1);
  return true;
}

export async function releaseGlobalQuota(): Promise<void> {
  const path = quotaPath('global', today());
  const current = await readCount(path);
  await writeCount(path, Math.max(0, current - 1));
}
