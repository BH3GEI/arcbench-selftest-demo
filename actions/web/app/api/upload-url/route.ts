import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getCurrentUser, accountTooNew } from '@/lib/session';
import { config } from '@/lib/config';
import { taskExists } from '@/lib/github';
import { isTaskListed } from '@/lib/taskVisibility';
import { createUploadIntent, quotaBlocked } from '@/lib/store';
import { maxZipBytes, presignZipUpload } from '@/lib/upload';

// Step 1 of a submission: checks everything that can be checked before the
// upload, then hands out a presigned URL for the browser to PUT the zip to.
// Nothing is charged here; /api/submit charges quota after verifying the
// uploaded object.
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'sign in required' }, { status: 401 });
  if (accountTooNew(user)) {
    return NextResponse.json(
      { error: `GitHub account must be at least ${config.minAccountAgeDays} days old` },
      { status: 403 },
    );
  }

  const body = (await req.json().catch(() => ({}))) as { taskId?: unknown; size?: unknown };
  const taskId = typeof body.taskId === 'string' ? body.taskId : '';
  const size = typeof body.size === 'number' ? body.size : -1;
  if (!taskId || !isTaskListed(taskId) || !(await taskExists(taskId))) {
    return NextResponse.json({ error: 'unknown task' }, { status: 400 });
  }
  if (size <= 0) return NextResponse.json({ error: 'empty file' }, { status: 400 });
  if (size > maxZipBytes()) {
    return NextResponse.json({ error: `zip exceeds ${config.maxZipMb}MB` }, { status: 400 });
  }
  const blocked = await quotaBlocked(user.githubId, config.dailyLimitPerUser, config.dailyLimitGlobal);
  if (blocked === 'user') {
    return NextResponse.json(
      { error: `daily submission limit reached (${config.dailyLimitPerUser}/day)` },
      { status: 429 },
    );
  }
  if (blocked === 'global') {
    return NextResponse.json(
      { error: 'the site has reached its overall daily submission limit, try again tomorrow' },
      { status: 429 },
    );
  }

  const id = randomUUID();
  await createUploadIntent({ id, githubId: user.githubId, taskId, createdAt: Date.now() });
  try {
    return NextResponse.json({ id, uploadUrl: await presignZipUpload(id) });
  } catch (err) {
    return NextResponse.json({ error: `upload failed: ${String(err)}` }, { status: 502 });
  }
}
