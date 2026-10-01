import { NextResponse } from 'next/server';
import { del } from '@vercel/blob';
import { verifyCallbackSignature } from '@/lib/signature';
import { getSubmission, recordResult, claimCallbackNonce } from '@/lib/store';
import type { GradeResult } from '@/lib/types';

// Receives the grader's result (scripts/report_back.py POSTs here when
// CALLBACK_URL is set). Never trust the body until the signature checks out
// — an unauthenticated caller could otherwise overwrite anyone's result.
export async function POST(req: Request) {
  const rawBody = await req.text();
  const signature = req.headers.get('x-signature');
  const timestamp = req.headers.get('x-timestamp');
  const nonce = req.headers.get('x-nonce');
  if (!verifyCallbackSignature(rawBody, timestamp, nonce, signature)) {
    return NextResponse.json({ error: 'bad signature' }, { status: 401 });
  }
  if (nonce && !(await claimCallbackNonce(nonce))) {
    return NextResponse.json({ error: 'replayed callback' }, { status: 409 });
  }

  let result: GradeResult;
  try {
    result = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  const existing = await getSubmission(result.submission_id);
  if (!existing) {
    return NextResponse.json({ error: 'unknown submission' }, { status: 404 });
  }

  await recordResult(existing.id, result);

  // Best-effort cleanup: the app zip has no further use once grading is done.
  try {
    await del(`submissions/${existing.id}.zip`);
  } catch {
    // non-fatal — a leftover blob costs storage, not correctness
  }

  return NextResponse.json({ ok: true });
}
