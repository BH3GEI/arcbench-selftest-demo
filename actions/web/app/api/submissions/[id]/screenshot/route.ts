import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/session';
import { getScreenshot, getSubmission } from '@/lib/store';

// GET /api/submissions/<id>/screenshot?path=<path from result.json>
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'sign in required' }, { status: 401 });

  const { id } = await params;
  const path = new URL(req.url).searchParams.get('path') || '';
  const submission = await getSubmission(id);
  if (!submission || submission.githubId !== user.githubId) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  const image = await getScreenshot(submission, path);
  if (!image) return NextResponse.json({ error: 'screenshot not available' }, { status: 404 });
  return new NextResponse(new Uint8Array(image), {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'private, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
