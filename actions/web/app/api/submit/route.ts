import { NextResponse } from 'next/server';
import { getCurrentUser, accountTooNew } from '@/lib/session';
import { config } from '@/lib/config';
import { dispatchGrade } from '@/lib/github';
import { signDispatch } from '@/lib/signature';
import { checkUploadedZip } from '@/lib/upload';
import {
  createSubmission,
  readUploadIntent,
  recordResult,
  submissionExists,
  tryConsumeUserQuota,
  tryConsumeGlobalQuota,
  releaseUserQuota,
  releaseGlobalQuota,
} from '@/lib/store';

const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INTENT_MAX_AGE_MS = 60 * 60 * 1000;

// Step 2 of a submission (step 1: /api/upload-url, then the browser PUTs the
// zip straight to Blob). Verifies the upload belongs to this user and really
// is a zip within the size cap, and only then charges quota and dispatches.
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'sign in required' }, { status: 401 });

  if (accountTooNew(user)) {
    return NextResponse.json(
      { error: `GitHub account must be at least ${config.minAccountAgeDays} days old` },
      { status: 403 },
    );
  }

  const body = (await req.json().catch(() => ({}))) as { uploadId?: unknown };
  const submissionId = typeof body.uploadId === 'string' ? body.uploadId : '';
  if (!UPLOAD_ID.test(submissionId)) {
    return NextResponse.json({ error: 'uploadId is required' }, { status: 400 });
  }
  const intent = await readUploadIntent(submissionId);
  if (!intent || intent.githubId !== user.githubId || Date.now() - intent.createdAt > INTENT_MAX_AGE_MS) {
    return NextResponse.json({ error: 'upload not found' }, { status: 400 });
  }
  if (await submissionExists(submissionId)) {
    return NextResponse.json({ id: submissionId }); // double click / retry: already submitted
  }
  const taskId = intent.taskId;

  const upload = await checkUploadedZip(submissionId);
  if (!upload.ok) return NextResponse.json({ error: upload.error }, { status: upload.status });
  const blobUrl = upload.url;

  const userQuota = await tryConsumeUserQuota(user.githubId, config.dailyLimitPerUser);
  if (!userQuota.ok) {
    return NextResponse.json(
      { error: `daily submission limit reached (${config.dailyLimitPerUser}/day)` },
      { status: 429 },
    );
  }
  const globalQuota = await tryConsumeGlobalQuota(config.dailyLimitGlobal);
  if (!globalQuota.ok) {
    await releaseUserQuota(userQuota.markerPath);
    return NextResponse.json(
      { error: 'the site has reached its overall daily submission limit, try again tomorrow' },
      { status: 429 },
    );
  }

  const baseUrl = process.env.NEXTAUTH_URL || new URL(req.url).origin;
  const callbackUrl = `${baseUrl}/api/callback`;

  // Written *before* dispatching: the grader can finish and call back
  // faster than you'd expect, and the callback looks this record up by id
  // — it must already exist. downloadUrl/callbackUrl are kept here too so
  // the cron reconciler can redispatch later without the participant.
  const now = Date.now();
  try {
    await createSubmission(
      {
        id: submissionId,
        githubId: user.githubId,
        githubLogin: user.githubLogin,
        taskId,
        createdAt: now,
        status: 'queued',
        updatedAt: now,
        result: null,
      },
      { downloadUrl: blobUrl, callbackUrl },
      [userQuota.markerPath, globalQuota.markerPath],
    );
  } catch (err) {
    // A concurrent submit of the same upload got there first (created.json is
    // write-once): give this request's quota back and point at that one.
    await releaseUserQuota(userQuota.markerPath);
    await releaseGlobalQuota(globalQuota.markerPath);
    if (await submissionExists(submissionId)) return NextResponse.json({ id: submissionId });
    throw err;
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signDispatch(submissionId, taskId, timestamp);

  try {
    await dispatchGrade({ submissionId, taskId, downloadUrl: blobUrl, callbackUrl, timestamp, signature });
  } catch (err) {
    // system_error releases this submission's quota markers itself.
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
