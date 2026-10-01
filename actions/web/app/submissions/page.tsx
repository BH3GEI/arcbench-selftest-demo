'use client';

import { useSession } from 'next-auth/react';
import Link from 'next/link';
import {
  Icon,
  Notice,
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
    <main id="main" className="container page">
      <div className="page-head">
        <div>
          <h1>历史记录</h1>
          <p className="sub">
            {remaining === null ? '你提交过的所有自测。' : `今天还剩 ${remaining} / ${quota!.limit} 次自测。`}
          </p>
        </div>
        <Link href="/tasks" className="btn btn-primary">
          <Icon.upload size={16} /> 新的自测
        </Link>
      </div>

      {error && (
        <Notice tone="danger" title="加载失败">
          {error}
        </Notice>
      )}

      {!subs && !error && <div className="skeleton" style={{ height: 240 }} aria-busy="true" />}

      {subs?.length === 0 && (
        <div className="card empty">
          <span className="icon">
            <Icon.file />
          </span>
          <h2 style={{ fontSize: 'var(--fs-lg)' }}>还没有提交记录</h2>
          <p className="muted">选一道题上传 zip，结果会出现在这里。</p>
          <Link href="/tasks" className="btn btn-primary">
            去提交
          </Link>
        </div>
      )}

      {subs && subs.length > 0 && (
        <div className="list" role="list">
          <div className="list-row list-head" aria-hidden="true">
            <span>题目</span>
            <span>状态</span>
            <span>得分</span>
            <span>提交时间</span>
            <span />
          </div>
          {subs.map((s) => {
            const st = effectiveStatus(s);
            const r = s.result;
            const p = r ? pct(r.passed, r.total) : 0;
            const all = r && r.total > 0 && r.passed === r.total;
            return (
              <Link key={s.id} href={`/submissions/${s.id}`} className="list-row" role="listitem">
                <span className="c-task" style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>
                  {s.taskId}
                </span>
                <span className="c-status">
                  <StatusBadge status={st} />
                </span>
                <span className="c-score">
                  {r && r.total > 0 && st !== 'system_error' ? (
                    <span className="mini-bar">
                      <span className="mono" style={{ minWidth: 48 }}>
                        {r.passed}/{r.total}
                      </span>
                      <ProgressBar value={p} tone={all ? 'success' : r.passed === 0 ? 'danger' : undefined} label={`通过率 ${p}%`} />
                    </span>
                  ) : (
                    <span className="subtle">{isPending(st) ? '评测中…' : '—'}</span>
                  )}
                </span>
                <span className="c-time subtle">{formatTime(s.createdAt)}</span>
                <span className="c-go subtle" aria-hidden="true">
                  <Icon.chevron />
                </span>
              </Link>
            );
          })}
        </div>
      )}
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
