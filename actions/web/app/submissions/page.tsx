'use client';

import { useSession } from 'next-auth/react';
import Link from 'next/link';
import { taskDisplayName } from '@/lib/taskVisibility';
import {
  Notice,
  PageHead,
  ProgressBar,
  RequireAuth,
  StatusBadge,
  effectiveStatus,
  formatTime,
  isPending,
  pct,
  useSubmissions,
} from '../_ui';

function History() {
  const { status } = useSession();
  const { subs, quota, error } = useSubmissions(status === 'authenticated');
  const remaining = quota ? Math.max(0, quota.limit - quota.used) : null;

  return (
    <main id="main" className="wrap">
      <PageHead
        kicker="历史记录"
        title="提交记录"
        lead={remaining === null ? '本人全部自测提交。' : `本人全部自测提交。今日剩余 ${remaining} / ${quota!.limit} 次。`}
      >
        <Link href="/tasks" className="btn btn-primary">
          提交自测
        </Link>
      </PageHead>

      <section className="section" aria-labelledby="list">
        <h2 id="list" className="sr-only">
          提交列表
        </h2>
        {error && (
          <Notice tone="danger" title="加载失败">
            {error}
          </Notice>
        )}

        {!subs && !error && <div className="skeleton" style={{ height: 240 }} aria-busy="true" />}

        {subs?.length === 0 && (
          <div className="empty">
            <p>暂无提交记录。</p>
            <Link href="/tasks" className="btn">
              提交自测
            </Link>
          </div>
        )}

        {subs && subs.length > 0 && (
          <table className="table responsive">
            <thead>
              <tr>
                <th scope="col">题目</th>
                <th scope="col">状态</th>
                <th scope="col" style={{ width: '28%' }}>
                  通过
                </th>
                <th scope="col">提交时间</th>
                <th scope="col" className="go">
                  <span className="sr-only">操作</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {subs.map((s) => {
                const st = effectiveStatus(s);
                const r = s.result;
                const p = r ? pct(r.passed, r.total) : 0;
                const all = r && r.total > 0 && r.passed === r.total;
                return (
                  <tr key={s.id}>
                    <td>
                      <Link href={`/submissions/${s.id}`} className="rowlink">
                        {taskDisplayName(s.taskId)}
                      </Link>
                    </td>
                    <td>
                      <StatusBadge status={st} />
                    </td>
                    <td data-wide>
                      {r && r.total > 0 && st !== 'system_error' ? (
                        <span className="row" style={{ gap: 'var(--s-3)', flexWrap: 'nowrap' }}>
                          <span className="num" style={{ minWidth: 56 }}>
                            {r.passed} / {r.total}
                          </span>
                          <span style={{ flex: 1 }}>
                            <ProgressBar
                              value={p}
                              tone={all ? 'success' : r.passed === 0 ? 'danger' : undefined}
                              label={`通过率 ${p}%`}
                            />
                          </span>
                        </span>
                      ) : (
                        <span className="meta">{isPending(st) ? '评测中' : '—'}</span>
                      )}
                    </td>
                    <td className="meta" data-wide>
                      {formatTime(s.createdAt)}
                    </td>
                    <td className="go">
                      <Link href={`/submissions/${s.id}`} className="meta" aria-label={`查看 ${taskDisplayName(s.taskId)} 的结果`}>
                        查看 →
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}

export default function SubmissionsPage() {
  return (
    <RequireAuth>
      <History />
    </RequireAuth>
  );
}
