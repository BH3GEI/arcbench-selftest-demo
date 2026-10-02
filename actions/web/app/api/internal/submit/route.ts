import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { put } from '@vercel/blob';
import { config } from '@/lib/config';
import { taskExists, dispatchGrade } from '@/lib/github';
import { signDispatch } from '@/lib/signature';
import { createSubmission, recordResult } from '@/lib/store';
import { verifyInternalKey, INTERNAL_CHECK_GITHUB_ID } from '@/lib/internalCheck';

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04"

// Submission path for the scheduled synthetic check only — gated on a
// shared secret header instead of a GitHub session, so the check can run
// the real submit -> grade -> result pipeline end to end without a login
// and without ever touching a participant's daily quota (no
// tryConsumeUserQuota/tryConsumeGlobalQuota call here). Unlike /api/submit
// it accepts unlisted demo tasks (e.g. demo-todo), since that's the known-
// score fixture the check submits. Never linked from the UI; disabled
// entirely unless INTERNAL_CHECK_KEY is configured.
export async function POST(req: Request) {
  if (!verifyInternalKey(req)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const form = await req.formData();
  const taskId = String(form.get('taskId') || '');
  const file = form.get('file');
  if (!taskId || !(file instanceof Blob)) {
    return NextResponse.json({ error: 'taskId and file are required' }, { status: 400 });
  }
  if (!(await taskExists(taskId))) {
    return NextResponse.json({ error: 'unknown task' }, { status: 400 });
  }

  const maxBytes = config.maxZipMb * 1024 * 1024;
  if (file.size > maxBytes) {
    return NextResponse.json({ error: `zip exceeds ${config.maxZipMb}MB` }, { status: 400 });
  }
  const head = Buffer.from(await file.slice(0, 4).arrayBuffer());
  if (!head.equals(ZIP_MAGIC)) {
    return NextResponse.json({ error: 'not a zip file' }, { status: 400 });
  }

  const submissionId = randomUUID();

  let blobUrl: string;
  try {
    const blob = await put(`submissions/${submissionId}.zip`, file, {
      access: 'public',
      addRandomSuffix: false,
    });
    blobUrl = blob.url;
  } catch (err) {
    return NextResponse.json({ error: `upload failed: ${String(err)}` }, { status: 502 });
  }

  const now = Date.now();
  await createSubmission({
    id: submissionId,
    githubId: INTERNAL_CHECK_GITHUB_ID,
    githubLogin: INTERNAL_CHECK_GITHUB_ID,
    taskId,
    createdAt: now,
    status: 'queued',
    updatedAt: now,
    result: null,
  });

  const baseUrl = process.env.NEXTAUTH_URL || new URL(req.url).origin;
  const callbackUrl = `${baseUrl}/api/callback`;
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signDispatch(submissionId, taskId, timestamp);

  try {
    await dispatchGrade({ submissionId, taskId, downloadUrl: blobUrl, callbackUrl, timestamp, signature });
  } catch (err) {
    await recordResult(submissionId, {
      submission_id: submissionId,
      task_id: taskId,
      visibility: 'public',
      status: 'system_error',
      passed: 0,
      total: 0,
      detail: `could not start grading: ${String(err)}`,
    });
    return NextResponse.json({ error: `could not start grading: ${String(err)}` }, { status: 502 });
  }

  return NextResponse.json({ id: submissionId });
}
