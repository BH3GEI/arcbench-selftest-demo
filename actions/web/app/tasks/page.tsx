'use client';

import { useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';
import Link from 'next/link';
import { Notice, PageHead, RequireAuth, zhError } from '../_ui';

type Task = { id: string; displayName: string };

function TaskList() {
  const { status } = useSession();
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (status !== 'authenticated') return;
    fetch('/api/tasks')
      .then((r) => r.json())
      .then((d) => (d.error ? setError(zhError(d.error)) : setTasks(d.tasks)))
      .catch((e) => setError(String(e)));
  }, [status]);

  return (
    <main id="main" className="wrap">
      <PageHead kicker="提交" title="选择题目" lead="选择要自测的题目，下一步上传 zip。" />

      <section className="section" aria-labelledby="list">
        <h2 id="list" className="sr-only">
          题目列表
        </h2>
        {error && (
          <Notice tone="danger" title="题目列表加载失败">
            {error}
          </Notice>
        )}

        {!tasks && !error && <div className="skeleton" style={{ height: 160 }} aria-busy="true" />}

        {tasks && tasks.length === 0 && <p className="empty">暂无开放自测的题目。</p>}

        {tasks && tasks.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th scope="col" style={{ width: 64 }}>
                  序号
                </th>
                <th scope="col">题目</th>
                <th scope="col">ID</th>
                <th scope="col" className="go">
                  操作
                </th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task, i) => (
                <tr key={task.id}>
                  <td className="num meta">{String(i + 1).padStart(2, '0')}</td>
                  <td>
                    <Link href={`/submit/${encodeURIComponent(task.id)}`} className="rowlink">
                      {task.displayName}
                    </Link>
                  </td>
                  <td className="meta">{task.id}</td>
                  <td className="go">
                    <Link
                      href={`/submit/${encodeURIComponent(task.id)}`}
                      className="btn btn-sm"
                      aria-label={`上传到 ${task.displayName}`}
                    >
                      上传 →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
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
