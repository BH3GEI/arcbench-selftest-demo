'use client';

import { use, useEffect, useRef, useState } from 'react';
import { useSession } from 'next-auth/react';
import Link from 'next/link';
import type { Submission, TestCaseResult } from '@/lib/types';
import {
  Icon,
  Notice,
  ProgressBar,
  RequireAuth,
  StatusBadge,
  effectiveStatus,
  formatDuration,
  formatTime,
  isPending,
  pct,
  zhError,
  type UiStatus,
} from '../../_ui';

const POLL_MS = 4000;
// 没有服务端预估时的典型耗时（构建 + 跑测试），仅用于提示。
const TYPICAL_SECONDS = 5 * 60;

// 后端可能附带的可选字段（截图、排队位置、预计等待），没有就不显示。
type TestExtra = TestCaseResult & { screenshot?: string | null; screenshots?: string[]; durationMs?: number };
type SubmissionExtra = Submission & { queuePosition?: number; etaSeconds?: number; startedAt?: number };

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function Waiting({ s, st }: { s: SubmissionExtra; st: UiStatus }) {
  const now = useNow(true);
  const elapsed = (now - s.createdAt) / 1000;
  const eta = typeof s.etaSeconds === 'number' ? s.etaSeconds : Math.max(0, TYPICAL_SECONDS - elapsed);
  const queued = st === 'queued';
  const steps = ['已上传', '排队', '构建镜像', '运行测试', '出结果'];
  const active = queued ? 1 : 3;

  return (
    <section className="card stack" style={{ gap: 'var(--s-5)' }} aria-live="polite">
      <div className="waiting">
        <span className={`orbit ${queued ? 'is-queued' : ''}`} aria-hidden="true" />
        <div className="stack" style={{ gap: 'var(--s-1)' }}>
          <h2 style={{ fontSize: 'var(--fs-xl)' }}>{queued ? '正在排队' : '正在评测'}</h2>
          <p className="muted">
            {queued && typeof s.queuePosition === 'number'
              ? `前面还有 ${s.queuePosition} 个提交。`
              : queued
                ? '等待评测机空闲，马上开始。'
                : '正在构建你的 app 并运行测试。'}
          </p>
          <p className="subtle">
            已等待 {formatDuration(elapsed)}
            {eta > 0 ? ` · 预计还需约 ${formatDuration(Math.ceil(eta / 30) * 30)}` : ' · 比平时稍久，请再等一下'}
          </p>
        </div>
      </div>
      <ol className="timeline" aria-label="评测进度">
        {steps.map((label, i) => (
          <li key={label} className={i < active ? 'done' : i === active ? 'active' : ''} aria-current={i === active ? 'step' : undefined}>
            {label}
          </li>
        ))}
      </ol>
      <p className="subtle">页面会自动刷新，你可以先离开，稍后在「历史记录」里查看结果。</p>
    </section>
  );
}

function Score({ s }: { s: Submission }) {
  const r = s.result!;
  const p = pct(r.passed, r.total);
  const all = r.total > 0 && r.passed === r.total;
  const tone = all ? 'success' : r.passed === 0 ? 'danger' : undefined;
  return (
    <section className="card score" aria-label="得分">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="card-title" style={{ margin: 0 }}>
          通过测试
        </span>
        <span className={`subtle ${all ? 'tone-success' : ''}`}>
          {all ? '全部通过' : `${r.total - r.passed} 条未通过`}
        </span>
      </div>
      <div className="score-num">
        <span className={`n ${all ? 'tone-success' : ''}`}>{r.passed}</span>
        <span className="d">/ {r.total}</span>
        <span className={`pct ${tone ? `tone-${tone}` : ''}`}>{p}%</span>
      </div>
      <ProgressBar value={p} tone={tone} label={`通过率 ${p}%`} />
      {r.detail && <p className="subtle">{r.detail}</p>}
    </section>
  );
}

function TestRow({ t }: { t: TestExtra }) {
  const shots = [...(t.screenshots ?? []), ...(t.screenshot ? [t.screenshot] : [])];
  const hasBody = Boolean((!t.ok && t.error) || shots.length);
  const head = (
    <>
      <span className={`t-icon ${t.ok ? 'ok' : 'bad'}`}>{t.ok ? <Icon.check /> : <Icon.x />}</span>
      <span className="t-title">{t.title}</span>
      <span className="sr-only">{t.ok ? '通过' : '未通过'}</span>
      {typeof t.durationMs === 'number' && <span className="subtle mono">{(t.durationMs / 1000).toFixed(1)}s</span>}
    </>
  );
  if (!hasBody) {
    return (
      <div className="test">
        <div className="test-head">
          {head}
          <span style={{ width: 16 }} />
        </div>
      </div>
    );
  }
  return (
    <details className="test">
      <summary>
        {head}
        <span className="chev">
          <Icon.chevron />
        </span>
      </summary>
      <div className="test-body">
        {!t.ok && t.error && (
          <>
            <span className="subtle">报错信息</span>
            <pre>{t.error}</pre>
          </>
        )}
        {shots.map((src, i) => (
          <a key={i} href={src} target="_blank" rel="noreferrer">
            <img src={src} alt={`「${t.title}」的测试截图 ${i + 1}`} loading="lazy" />
          </a>
        ))}
      </div>
    </details>
  );
}

function Tests({ tests }: { tests: TestExtra[] }) {
  const failed = tests.filter((t) => !t.ok).length;
  const [filter, setFilter] = useState<'all' | 'fail' | 'pass'>(failed ? 'fail' : 'all');
  const shown = tests.filter((t) => (filter === 'all' ? true : filter === 'fail' ? !t.ok : t.ok));
  const opts: [typeof filter, string][] = [
    ['all', `全部 ${tests.length}`],
    ['fail', `未通过 ${failed}`],
    ['pass', `通过 ${tests.length - failed}`],
  ];
  return (
    <section className="stack" aria-labelledby="tests-title">
      <div className="row">
        <h2 id="tests-title" style={{ fontSize: 'var(--fs-lg)' }}>
          测试明细
        </h2>
        <span className="spacer" />
        <div className="tabs" role="group" aria-label="筛选测试">
          {opts.map(([k, label]) => (
            <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {shown.length === 0 ? (
        <div className="card empty">
          <p className="muted">{filter === 'fail' ? '没有未通过的测试 🎉' : '这里没有测试'}</p>
        </div>
      ) : (
        <div className="tests">
          {shown.map((t, i) => (
            <TestRow key={`${filter}-${i}`} t={t} />
          ))}
        </div>
      )}
      {failed > 0 && filter !== 'pass' && <p className="subtle">点击未通过的测试可展开查看报错和截图。</p>}
    </section>
  );
}

function Detail({ id }: { id: string }) {
  const { status } = useSession();
  const [submission, setSubmission] = useState<SubmissionExtra | null>(null);
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
          setError(res.status === 404 ? '找不到这条提交记录。' : zhError(data.error || `加载失败（${res.status}）`));
          return;
        }
        if (stopped) return;
        setSubmission(data.submission);
        if (isPending(data.submission.status)) {
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

  if (error) {
    return (
      <main id="main" className="container page">
        <Notice tone="danger" title="无法加载结果">
          {error}
        </Notice>
        <p>
          <Link href="/submissions">← 返回历史记录</Link>
        </p>
      </main>
    );
  }

  if (!submission) {
    return (
      <main id="main" className="container page" aria-busy="true">
        <div className="skeleton" style={{ height: 32, width: 240 }} />
        <div className="skeleton" style={{ height: 180 }} />
        <span className="sr-only">正在加载结果…</span>
      </main>
    );
  }

  const st = effectiveStatus(submission);
  const r = submission.result;
  const hidden = r?.visibility === 'hidden' || (r && !r.tests);

  return (
    <main id="main" className="container page">
      <div className="page-head">
        <div>
          <p className="subtle">
            <Link href="/submissions">历史记录</Link> / 结果
          </p>
          <h1 style={{ marginTop: 'var(--s-1)', overflowWrap: 'anywhere' }}>{submission.taskId}</h1>
          <p className="sub row" style={{ gap: 'var(--s-2)' }}>
            <StatusBadge status={st} />
            <span className="subtle">提交于 {formatTime(submission.createdAt)}</span>
          </p>
        </div>
        <Link href={`/submit/${encodeURIComponent(submission.taskId)}`} className="btn">
          <Icon.upload size={16} /> 再交一次
        </Link>
      </div>

      {isPending(st) && <Waiting s={submission} st={st} />}

      {st === 'system_error' && (
        <section className="card stack" style={{ alignItems: 'flex-start' }}>
          <Notice tone="warning" title="评测系统出错，本次不计次数，请稍后重试">
            这是评测系统自身的问题，不是你的 app 出了错。
          </Notice>
          {r?.detail && <p className="subtle mono" style={{ overflowWrap: 'anywhere' }}>{r.detail}</p>}
          <Link href={`/submit/${encodeURIComponent(submission.taskId)}`} className="btn btn-primary">
            重新提交
          </Link>
        </section>
      )}

      {st === 'error' && r && r.total === 0 && (
        <section className="card stack">
          <Notice tone="danger" title="app 没能跑起来">
            构建或启动失败，测试没有执行。请检查 Dockerfile 和启动命令后再试。
          </Notice>
          {r.detail && <pre>{r.detail}</pre>}
        </section>
      )}

      {r && st !== 'system_error' && !isPending(st) && r.total > 0 && <Score s={submission} />}

      {r && !isPending(st) && st !== 'system_error' && r.total > 0 && hidden && (
        <div className="card row" style={{ gap: 'var(--s-3)' }}>
          <span className="fact-icon">
            <Icon.eyeOff />
          </span>
          <p className="muted" style={{ flex: 1, minWidth: 200 }}>
            这道题是隐藏测试题，只显示通过数量，不显示每条测试的内容和报错。
          </p>
        </div>
      )}

      {r && !hidden && r.tests && r.tests.length > 0 && <Tests tests={r.tests as TestExtra[]} />}
    </main>
  );
}

export default function SubmissionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <RequireAuth>
      <Detail id={id} />
    </RequireAuth>
  );
}
