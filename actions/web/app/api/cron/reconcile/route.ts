import { NextResponse } from 'next/server';
import { reconcileQueued } from '@/lib/store';

// Proactive sweep for every submission stuck at "queued": checks for a
// missing grade-workflow run (redispatch), recovers a result the callback
// never delivered, and times out anything stale. Runs on a schedule so
// nothing depends on a participant having the page open — see
// README_ACTIONS.md "Web app / watchdog" for how this is triggered
// (Vercel's own Cron Jobs are capped at once/day on the Hobby plan, so the
// 5-minute cadence comes from a GitHub Actions schedule calling this route;
// vercel.json's daily cron is just a backstop).
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // not configured (local/dev) — allow
  return req.headers.get('authorization') === `Bearer ${secret}`;
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  try {
    const summary = await reconcileQueued();
    return NextResponse.json({ ok: true, ...summary });
  } catch (err) {
    console.error(`cron/reconcile failed: ${String(err)}`);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
