'use client';

import { useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';
import Link from 'next/link';
import { Icon, Notice, RequireAuth, zhError } from '../_ui';

function TaskList() {
  const { status } = useSession();
  const [taskIds, setTaskIds] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (status !== 'authenticated') return;
    fetch('/api/tasks')
      .then((r) => r.json())
      .then((d) => (d.error ? setError(zhError(d.error)) : setTaskIds(d.taskIds)))
      .catch((e) => setError(String(e)));
  }, [status]);

  return (
    <main id="main" className="container page">
      <div className="page-head">
        <div>
          <h1>选择题目</h1>
          <p className="sub">选一道题，上传你的 app 跑一遍它的测试。</p>
        </div>
      </div>

      {error && (
        <Notice tone="danger" title="题目列表加载失败">
          {error}
        </Notice>
      )}

      {!taskIds && !error && (
        <div className="grid" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton" style={{ height: 120 }} />
          ))}
        </div>
      )}

      {taskIds && taskIds.length === 0 && (
        <div className="card empty">
          <span className="icon">
            <Icon.file />
          </span>
          <h2 style={{ fontSize: 'var(--fs-lg)' }}>暂时没有可自测的题目</h2>
          <p className="muted">题目开放后会出现在这里。</p>
        </div>
      )}

      {taskIds && taskIds.length > 0 && (
        <ul className="grid" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {taskIds.map((id) => (
            <li key={id}>
              <Link href={`/submit/${encodeURIComponent(id)}`} className="card card-link stack" style={{ gap: 'var(--s-3)' }}>
                <span className="fact-icon">
                  <Icon.file />
                </span>
                <span style={{ fontWeight: 650, fontSize: 'var(--fs-lg)', overflowWrap: 'anywhere' }}>{id}</span>
                <span className="row subtle" style={{ gap: 'var(--s-1)' }}>
                  上传并自测 <Icon.chevron size={14} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

export default function TasksPage() {
  return (
    <RequireAuth>
      <TaskList />
    </RequireAuth>
  );
}
