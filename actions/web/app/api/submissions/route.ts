import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/session';
import { listUserSubmissions } from '@/lib/store';

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'sign in required' }, { status: 401 });

  const submissions = await listUserSubmissions(user.githubId);
  return NextResponse.json({ submissions });
}
