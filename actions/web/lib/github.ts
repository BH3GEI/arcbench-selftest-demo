import { config } from './config';

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
