import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { put } from '@vercel/blob';
import { getCurrentUser, accountTooNew } from '@/lib/session';
import { config } from '@/lib/config';
import { taskExists, dispatchGrade } from '@/lib/github';
import { signDispatch } from '@/lib/signature';
import { saveSubmission, tryConsumeUserQuota, tryConsumeGlobalQuota, releaseUserQuota } from '@/lib/store';
import type { Submission } from '@/lib/types';

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04"

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'sign in required' }, { status: 401 });

  if (accountTooNew(user)) {
    return NextResponse.json(
      { error: `GitHub account must be at least ${config.minAccountAgeDays} days old` },
      { status: 403 },
    );
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

  const userOk = await tryConsumeUserQuota(user.githubId, config.dailyLimitPerUser);
  if (!userOk) {
    return NextResponse.json(
      { error: `daily submission limit reached (${config.dailyLimitPerUser}/day)` },
      { status: 429 },
    );
  }
  const globalOk = await tryConsumeGlobalQuota(config.dailyLimitGlobal);
  if (!globalOk) {
    await releaseUserQuota(user.githubId);
    return NextResponse.json(
      { error: 'the site has reached its overall daily submission limit, try again tomorrow' },
      { status: 429 },
    );
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
    await releaseUserQuota(user.githubId);
    return NextResponse.json({ error: `upload failed: ${String(err)}` }, { status: 502 });
  }

  const baseUrl = process.env.NEXTAUTH_URL || new URL(req.url).origin;
  const callbackUrl = `${baseUrl}/api/callback`;
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signDispatch(submissionId, taskId, timestamp);

  try {
    await dispatchGrade({ submissionId, taskId, downloadUrl: blobUrl, callbackUrl, timestamp, signature });
  } catch (err) {
    return NextResponse.json({ error: `could not start grading: ${String(err)}` }, { status: 502 });
  }

  const now = Date.now();
  const submission: Submission = {
    id: submissionId,
    githubId: user.githubId,
    githubLogin: user.githubLogin,
    taskId,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    result: null,
  };
  await saveSubmission(submission);

  return NextResponse.json({ id: submissionId });
}
