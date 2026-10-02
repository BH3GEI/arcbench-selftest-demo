import { NextResponse } from 'next/server';
import { getSubmission } from '@/lib/store';
import { verifyInternalKey, INTERNAL_CHECK_GITHUB_ID } from '@/lib/internalCheck';

// Poll path for the scheduled synthetic check — same secret-header gate as
// /api/internal/submit, and scoped to only ever return submissions created
// under INTERNAL_CHECK_GITHUB_ID, so this key can't be used to read a real
// participant's result.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!verifyInternalKey(req)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const { id } = await params;
  const submission = await getSubmission(id);
  if (!submission || submission.githubId !== INTERNAL_CHECK_GITHUB_ID) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  return NextResponse.json({ submission });
}
