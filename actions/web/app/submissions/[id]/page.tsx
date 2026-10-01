'use client';

import { use, useEffect, useRef, useState } from 'react';
import { useSession } from 'next-auth/react';
import Link from 'next/link';
import type { Submission } from '@/lib/types';

const POLL_MS = 4000;

export default function SubmissionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: session, status } = useSession();
  const [submission, setSubmission] = useState<Submission | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (status !== 'authenticated') return;

    let stopped = false;
    async function poll() {
      try {
        const res = await fetch(`/api/submissions/${id}`, { cache: 'no-store' });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error || `error (${res.status})`);
          return;
        }
        if (stopped) return;
        setSubmission(data.submission);
        if (data.submission.status === 'queued') {
          timer.current = setTimeout(poll, POLL_MS);
        }
      } catch (err) {
        if (!stopped) setError(String(err));
      }
    }
    poll();
    return () => {
      stopped = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [status, id]);

  if (status === 'loading') return <p className="muted">Loading…</p>;
  if (!session) return <p>Please sign in from the home page first.</p>;
  if (error) return <p className="status-error">{error}</p>;
  if (!submission) return <p className="muted">Loading submission…</p>;

  const r = submission.result;

  return (
    <main>
      <h1>{submission.taskId}</h1>
      <p>
        Status: <span className={`status-${submission.status}`}>{submission.status}</span>
        {submission.status === 'queued' && <span className="muted"> — checking again automatically…</span>}
      </p>

      {r && (
        <div className="card">
          <p>
            <strong>
              {r.passed} / {r.total}
            </strong>{' '}
            passed
            {r.detail && <span className="muted"> — {r.detail}</span>}
          </p>
          {r.tests && (
            <div>
              {r.tests.map((t, i) => (
                <div className="test-row" key={i}>
                  <span className={t.ok ? 'status-passed' : 'status-failed'}>{t.ok ? '✓' : '✗'}</span>{' '}
                  {t.title}
                  {!t.ok && t.error && <pre>{t.error}</pre>}
                </div>
              ))}
            </div>
          )}
          {!r.tests && (
            <p className="muted">This task&apos;s results are hidden — only the pass count is shown.</p>
          )}
        </div>
      )}

      <p>
        <Link href="/submissions">← back to history</Link>
      </p>
    </main>
  );
}
