'use client';

import { useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';
import Link from 'next/link';
import type { Submission } from '@/lib/types';

export default function SubmissionsPage() {
  const { data: session, status } = useSession();
  const [submissions, setSubmissions] = useState<Submission[] | null>(null);

  useEffect(() => {
    if (status !== 'authenticated') return;
    fetch('/api/submissions')
      .then((r) => r.json())
      .then((d) => setSubmissions(d.submissions ?? []));
  }, [status]);

  if (status === 'loading') return <p className="muted">Loading…</p>;
  if (!session) return <p>Please sign in from the home page first.</p>;

  return (
    <main>
      <h1>Your submissions</h1>
      {!submissions && <p className="muted">Loading…</p>}
      {submissions?.length === 0 && <p className="muted">No submissions yet.</p>}
      {submissions?.map((s) => (
        <div className="card" key={s.id}>
          <div>
            <strong>{s.taskId}</strong> — <span className={`status-${s.status}`}>{s.status}</span>
            {s.result && (
              <span className="muted">
                {' '}
                ({s.result.passed}/{s.result.total})
              </span>
            )}
          </div>
          <div className="muted">{new Date(s.createdAt).toLocaleString()}</div>
          <div>
            <Link href={`/submissions/${s.id}`}>View →</Link>
          </div>
        </div>
      ))}
      <p>
        <Link href="/">← back</Link>
      </p>
    </main>
  );
}
