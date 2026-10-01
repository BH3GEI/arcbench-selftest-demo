import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/session';
import { getSubmission } from '@/lib/store';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'sign in required' }, { status: 401 });

  const { id } = await params;
  const submission = await getSubmission(id);
  if (!submission || submission.githubId !== user.githubId) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  return NextResponse.json({ submission });
}
