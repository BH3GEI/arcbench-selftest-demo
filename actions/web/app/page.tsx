'use client';

import { signIn, signOut, useSession } from 'next-auth/react';
import Link from 'next/link';

export default function HomePage() {
  const { data: session, status } = useSession();

  if (status === 'loading') return <p className="muted">Loading…</p>;

  if (!session) {
    return (
      <main>
        <h1>arcbench self-test</h1>
        <p>
          Upload your app, get a pass/fail result against a task&apos;s test pack.
          Results are only visible to you — this does not feed a leaderboard.
        </p>
        <button className="btn" onClick={() => signIn('github')}>
          Sign in with GitHub
        </button>
      </main>
    );
  }

  return (
    <main>
      <h1>arcbench self-test</h1>
      <p>
        Signed in as <strong>{session.user?.name}</strong>.{' '}
        <button className="btn" onClick={() => signOut()}>
          Sign out
        </button>
      </p>
      <p>
        <Link href="/tasks">Pick a task to submit to →</Link>
      </p>
      <p>
        <Link href="/submissions">View your submission history →</Link>
      </p>
    </main>
  );
}
