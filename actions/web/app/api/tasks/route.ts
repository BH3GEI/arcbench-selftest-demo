import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/session';
import { listTaskIds } from '@/lib/github';
import { isTaskListed, taskDisplayName } from '@/lib/taskVisibility';

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'sign in required' }, { status: 401 });

  try {
    const taskIds = await listTaskIds();
    const tasks = taskIds
      .filter(isTaskListed)
      .map((id) => ({ id, displayName: taskDisplayName(id) }));
    return NextResponse.json({ tasks });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 502 });
  }
}
