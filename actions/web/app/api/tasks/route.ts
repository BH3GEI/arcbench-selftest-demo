import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/session';
import { listTaskIds } from '@/lib/github';

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'sign in required' }, { status: 401 });

  try {
    const taskIds = await listTaskIds();
    return NextResponse.json({ taskIds });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}
