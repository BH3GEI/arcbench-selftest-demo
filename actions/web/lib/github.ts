import { inflateRawSync } from 'node:zlib';
import { config } from './config';
import type { GradeResult } from './types';

const API = 'https://api.github.com';

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${config.graderServiceToken}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

// Lists tasks/<task_id>/ directory names only — never reads task content
// (requirements.yaml, tests/) from the web tier. Matches the product
// requirement: participants pick a task by name, nothing else is exposed
// through this app.
export async function listTaskIds(): Promise<string[]> {
  const url = `${API}/repos/${config.graderRepoOwner}/${config.graderRepoName}/contents/tasks`;
  const res = await fetch(url, { headers: headers(), cache: 'no-store' });
  if (res.status === 404) return [];
  if (!res.ok) {
    throw new Error(`listTaskIds: GitHub API ${res.status}: ${await res.text()}`);
  }
  const entries = (await res.json()) as Array<{ name: string; type: string }>;
  return entries.filter((e) => e.type === 'dir').map((e) => e.name).sort();
}

export async function taskExists(taskId: string): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(taskId)) return false;
  const ids = await listTaskIds();
  return ids.includes(taskId);
}

export async function dispatchGrade(payload: {
  submissionId: string;
  taskId: string;
  downloadUrl: string;
  callbackUrl: string;
  timestamp: number;
  signature: string;
}): Promise<void> {
  const url = `${API}/repos/${config.graderRepoOwner}/${config.graderRepoName}/dispatches`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event_type: 'grade-submission',
      client_payload: {
        submission_id: payload.submissionId,
        task_id: payload.taskId,
        download_url: payload.downloadUrl,
        callback_url: payload.callbackUrl,
        submission_timestamp: String(payload.timestamp),
        submission_signature: payload.signature,
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`dispatchGrade: GitHub API ${res.status}: ${await res.text()}`);
  }
}

// Downloads the grader repo's newest unexpired artifact with this exact
// name (needs Actions read access on the service token). Any failure just
// means "not available".
async function fetchArtifactZip(name: string): Promise<Buffer | null> {
  const repo = `${API}/repos/${config.graderRepoOwner}/${config.graderRepoName}`;
  const res = await fetch(`${repo}/actions/artifacts?name=${encodeURIComponent(name)}&per_page=5`, {
    headers: headers(),
    cache: 'no-store',
  });
  if (!res.ok) return null;
  const { artifacts } = (await res.json()) as {
    artifacts: { archive_download_url: string; expired: boolean }[];
  };
  const artifact = artifacts.find((a) => !a.expired);
  if (!artifact) return null;

  // The download endpoint redirects to signed blob storage; follow it by hand
  // so the GitHub token is never sent to that other host.
  const redirect = await fetch(artifact.archive_download_url, {
    headers: headers(),
    redirect: 'manual',
    cache: 'no-store',
  });
  const location = redirect.headers.get('location');
  const zipRes = location ? await fetch(location, { cache: 'no-store' }) : redirect;
  if (!zipRes.ok) return null;
  return Buffer.from(await zipRes.arrayBuffer());
}

// Recovery path for a result whose callback never landed (see store.ts
// reconcile): the grade job uploads its result.json as the artifact
// `result-<submission_id>` — the exact file the report job POSTs.
export async function fetchGraderResult(submissionId: string): Promise<GradeResult | null> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(submissionId)) return null;
  const zip = await fetchArtifactZip(`result-${submissionId}`);
  const json = zip ? readZipEntry(zip, 'result.json') : null;
  return json ? (JSON.parse(json.toString('utf8')) as GradeResult) : null;
}

// Failure screenshots only exist inside the grade job's debug artifact
// (`debug-<submission_id>`, the whole results dir); result.json carries
// their paths relative to it. Returns the requested entries that exist.
export async function fetchGraderScreenshots(
  submissionId: string,
  paths: string[],
): Promise<Map<string, Buffer>> {
  const found = new Map<string, Buffer>();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(submissionId) || paths.length === 0) return found;
  const zip = await fetchArtifactZip(`debug-${submissionId}`);
  if (!zip) return found;
  for (const p of paths) {
    const data = readZipEntry(zip, p);
    if (data) found.set(p, data);
  }
  return found;
}

// Minimal zip reader for the one small file inside an Actions artifact:
// walk the central directory, then inflate (or copy) that entry's data.
function readZipEntry(zip: Buffer, name: string): Buffer | null {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65535); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) return null;
    const method = zip.readUInt16LE(p + 10);
    const compSize = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const entryName = zip.toString('utf8', p + 46, p + 46 + nameLen);
    if (entryName === name) {
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(start, start + compSize);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data);
      return null;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}
