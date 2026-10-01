'use client';

import { use, useState } from 'react';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

export default function SubmitPage({ params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = use(params);
  const { data: session, status } = useSession();
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (status === 'loading') return <p className="muted">Loading…</p>;
  if (!session) return <p>Please sign in from the home page first.</p>;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.set('taskId', taskId);
      form.set('file', file);
      const res = await fetch('/api/submit', { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || `upload failed (${res.status})`);
        setBusy(false);
        return;
      }
      router.push(`/submissions/${data.id}`);
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>Submit to {taskId}</h1>
      <p className="muted">Upload a .zip with a Dockerfile at its root.</p>
      <form onSubmit={onSubmit}>
        <input
          type="file"
          accept=".zip"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          required
        />
        <p>
          <button className="btn" type="submit" disabled={!file || busy}>
            {busy ? 'Submitting…' : 'Submit'}
          </button>
        </p>
      </form>
      {error && <p className="status-error">{error}</p>}
      <p>
        <Link href="/tasks">← back to tasks</Link>
      </p>
    </main>
  );
}
