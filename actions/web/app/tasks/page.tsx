'use client';

import { useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';
import Link from 'next/link';

export default function TasksPage() {
  const { data: session, status } = useSession();
  const [taskIds, setTaskIds] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (status !== 'authenticated') return;
    fetch('/api/tasks')
      .then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : setTaskIds(d.taskIds)))
      .catch((e) => setError(String(e)));
  }, [status]);

  if (status === 'loading') return <p className="muted">Loading…</p>;
  if (!session) return <p>Please sign in from the home page first.</p>;

  return (
    <main>
      <h1>Tasks</h1>
      {error && <p className="status-error">{error}</p>}
      {!taskIds && !error && <p className="muted">Loading tasks…</p>}
      {taskIds && taskIds.length === 0 && <p className="muted">No tasks available yet.</p>}
      {taskIds?.map((id) => (
        <div className="card" key={id}>
          <strong>{id}</strong>
          <div>
            <Link href={`/submit/${encodeURIComponent(id)}`}>Submit →</Link>
          </div>
        </div>
      ))}
      <p>
        <Link href="/">← back</Link>
      </p>
    </main>
  );
}
