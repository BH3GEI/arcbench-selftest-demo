'use client';

import { use, useEffect, useRef, useState } from 'react';
import { useSession } from 'next-auth/react';
import Link from 'next/link';
import type { Submission, TestCaseResult } from '@/lib/types';
import { taskDisplayName } from '@/lib/taskVisibility';
import {
  Notice,
  PageHead,
  ProgressBar,
  RequireAuth,
  StatusBadge,
  effectiveStatus,
  failureReason,
  systemErrorZh,
  formatDuration,
  formatTime,
  isPending,
  pct,
  zhError,
  type UiStatus,
} from '../../_ui';

const POLL_MS = 4000;
// 服务端没有给出 typicalSeconds（按近期真实提交统计）时的兜底值。
const TYPICAL_SECONDS = 8 * 60;
// 与服务端 store.ts 的 STALE_AFTER_MS 一致。
const GIVE_UP_MINUTES = 30;

// 后端可能附带的可选字段（截图、排队位置、预计等待），没有就不显示。
type TestExtra = TestCaseResult & { screenshot?: string | null; screenshots?: string[]; durationMs?: number };
type SubmissionExtra = Submission & { queuePosition?: number; etaSeconds?: number; typicalSeconds?: number | null };

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
  const typical = typeof s.typicalSeconds === 'number' ? s.typicalSeconds : TYPICAL_SECONDS;
  const eta = typeof s.etaSeconds === 'number' ? s.etaSeconds : Math.max(0, typical - elapsed);
  const queued = st === 'queued';
  const steps = ['已上传', '排队', '构建镜像', '运行测试', '生成结果'];
  const active = queued ? 1 : 3;

  return (
    <section className="section" aria-live="polite" aria-labelledby="wait-title">
      <div className="section-title">
        <h2 id="wait-title">{queued ? '排队中' : '评测中'}</h2>
      </div>
      <table className="dl" style={{ maxWidth: 560 }}>
        <tbody>
          <tr>
            <th scope="row">当前阶段</th>
            <td>
              {queued
                ? typeof s.queuePosition === 'number'
                  ? `排队中，前方 ${s.queuePosition} 个提交`
                  : '等待评测机'
                : '构建镜像并运行测试'}
            </td>
          </tr>
          <tr>
            <th scope="row">已等待</th>
            <td className="mono">{formatDuration(elapsed)}</td>
          </tr>
          <tr>
            <th scope="row">预计剩余</th>
            <td className="mono">{eta > 0 ? `约 ${formatDuration(Math.ceil(eta / 30) * 30)}` : '超出常规耗时，请继续等待'}</td>
          </tr>
          <tr>
            <th scope="row">通常耗时</th>
            <td>约 {Math.max(1, Math.round(typical / 60))} 分钟（按近期提交统计，测试失败越多耗时越长）</td>
          </tr>
        </tbody>
      </table>
      <ol className="steps-line" aria-label="评测进度">
        {steps.map((label, i) => (
          <li
            key={label}
            className={i < active ? 'done' : i === active ? 'active' : ''}
            aria-current={i === active ? 'step' : undefined}
          >
            {label}
          </li>
        ))}
      </ol>
      <p className="subtle" style={{ marginTop: 'var(--s-5)' }}>
        页面每 {POLL_MS / 1000} 秒自动刷新。可离开本页，稍后在历史记录中查看结果。超过 {GIVE_UP_MINUTES}{' '}
        分钟仍无结果会自动标记为系统错误，不扣次数，可直接重新提交。
      </p>
    </section>
  );
}

// 评测机返回的原始英文信息，折叠起来，便于反馈问题时引用。
function RawDetail({ detail }: { detail: string }) {
  if (!/[a-z]/i.test(detail)) return null;
  return (
    <details>
      <summary className="meta">原始信息</summary>
      <pre>{detail}</pre>
    </details>
  );
}

function Score({ s, hidden }: { s: Submission; hidden: boolean }) {
  const r = s.result!;
  const p = pct(r.passed, r.total);
  const all = r.total > 0 && r.passed === r.total;
  const tone = all ? 'success' : r.passed === 0 ? 'danger' : undefined;
  return (
    <section className="section" aria-labelledby="score-title">
      <div className="section-title">
        <h2 id="score-title">得分</h2>
      </div>
      <div className="score">
        <div className="score-num" aria-label={`通过 ${r.passed} 个，共 ${r.total} 个`}>
          <span className={all ? 'tone-success' : undefined}>{r.passed}</span>
          <span className="d">/ {r.total}</span>
        </div>
        <div className="score-side">
          <span className="pct">
            通过率 {p}% · {all ? '全部通过' : `${r.total - r.passed} 个未通过`}
          </span>
          <ProgressBar value={p} tone={tone} label={`通过率 ${p}%`} />
        </div>
      </div>
      {r.detail && !/^\d+\/\d+ tests failed$/.test(r.detail) && (
        <p className="subtle" style={{ marginTop: 'var(--s-4)' }}>{r.detail}</p>
      )}
      {hidden && (
        <div style={{ marginTop: 'var(--s-5)' }}>
          <Notice title="隐藏测试">本题只公布通过数量，不显示每条测试的内容和报错。</Notice>
        </div>
      )}
    </section>
  );
}

function Screenshot({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  if (failed) {
    return (
      <span className="shot-broken">
        <span>截图加载失败，可能是网络连接异常</span>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => {
            setFailed(false);
            setAttempt((n) => n + 1);
          }}
        >
          重试
        </button>
      </span>
    );
  }

  return (
    <a href={src} target="_blank" rel="noreferrer">
      <img key={attempt} src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} />
    </a>
  );
}

function TestRow({ t, submissionId }: { t: TestExtra; submissionId: string }) {
  // 评测机给的是相对评测结果目录的路径，经本站接口（校验本人）读取。
  const shots = [...(t.screenshots ?? []), ...(t.screenshot ? [t.screenshot] : [])].map((p) =>
    /^https?:\/\//.test(p) ? p : `/api/submissions/${submissionId}/screenshot?path=${encodeURIComponent(p)}`,
  );
  const hasBody = Boolean((!t.ok && t.error) || shots.length);
  const head = (
    <>
      <span className="t-state">
        <span className={`pill ${t.ok ? 'pill-success' : 'pill-danger'}`}>{t.ok ? 'PASS' : 'FAIL'}</span>
      </span>
      <span className="t-title">{t.title}</span>
      {typeof t.durationMs === 'number' && <span className="meta">{(t.durationMs / 1000).toFixed(1)}s</span>}
    </>
  );
  if (!hasBody) {
    return (
      <div className="test">
        <div className="test-head">{head}</div>
      </div>
    );
  }
  return (
    <details className="test">
      <summary>
        {head}
        <span className="toggle" aria-hidden="true" />
      </summary>
      <div className="test-body">
        {!t.ok && t.error && (
          <>
            <span className="label">报错</span>
            <pre>{t.error}</pre>
          </>
        )}
        {shots.length > 0 && <span className="label">截图</span>}
        {shots.map((src, i) => (
          <Screenshot key={i} src={src} alt={`测试「${t.title}」截图 ${i + 1}`} />
        ))}
      </div>
    </details>
  );
}

function Tests({ tests, submissionId }: { tests: TestExtra[]; submissionId: string }) {
  const failed = tests.filter((t) => !t.ok).length;
  const [filter, setFilter] = useState<'all' | 'fail' | 'pass'>(failed ? 'fail' : 'all');
  const shown = tests.filter((t) => (filter === 'all' ? true : filter === 'fail' ? !t.ok : t.ok));
  const opts: [typeof filter, string][] = [
    ['fail', `未通过 ${failed}`],
    ['pass', `通过 ${tests.length - failed}`],
    ['all', `全部 ${tests.length}`],
  ];
  return (
    <section className="section" aria-labelledby="tests-title">
      <div className="section-title">
        <h2 id="tests-title">测试明细</h2>
        <span className="spacer" />
        <span className="meta">点击未通过的测试查看报错和截图</span>
      </div>
      <div className="tabs" role="group" aria-label="筛选测试">
        {opts.map(([k, label]) => (
          <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)}>
            {label}
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <p className="empty">{filter === 'fail' ? '没有未通过的测试。' : '无测试。'}</p>
      ) : (
        <div>
          {shown.map((t, i) => (
            <TestRow key={`${filter}-${i}`} t={t} submissionId={submissionId} />
          ))}
        </div>
      )}
    </section>
  );
}

function Detail({ id }: { id: string }) {
  const { status } = useSession();
  const [submission, setSubmission] = useState<SubmissionExtra | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const submissionLoaded = useRef(false);

  useEffect(() => {
    if (status !== 'authenticated') return;

    let stopped = false;
    async function poll() {
      try {
        const res = await fetch(`/api/submissions/${id}`, { cache: 'no-store' });
        const data = await res.json();
        if (!res.ok) {
          // 已经在等结果时，偶发的 5xx 不打断轮询。
          if (res.status >= 500 && !stopped && submissionLoaded.current) {
            timer.current = setTimeout(poll, POLL_MS);
            return;
          }
          setError(res.status === 404 ? '提交记录不存在。' : zhError(data.error || `加载失败（${res.status}）`));
          return;
        }
        submissionLoaded.current = true;
        if (stopped) return;
        setSubmission(data.submission);
        if (isPending(data.submission.status)) {
          timer.current = setTimeout(poll, POLL_MS);
        }
      } catch (err) {
        if (stopped) return;
        if (submissionLoaded.current) timer.current = setTimeout(poll, POLL_MS);
        else setError(String(err));
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
      <main id="main" className="wrap">
        <PageHead kicker={<Link href="/submissions">历史记录</Link>} title="无法加载结果" />
        <div className="section">
          <Notice tone="danger">{error}</Notice>
        </div>
      </main>
    );
  }

  if (!submission) {
    return (
      <main id="main" className="wrap" aria-busy="true">
        <div className="page-head">
          <div className="skeleton" style={{ height: 14, width: 120 }} />
          <div className="skeleton" style={{ height: 56, width: 320, marginTop: 24 }} />
        </div>
        <span className="sr-only">正在加载结果</span>
      </main>
    );
  }

  const st = effectiveStatus(submission);
  const r = submission.result;
  const hidden = Boolean(r && (r.visibility === 'hidden' || !r.tests));
  const resubmit = `/submit/${encodeURIComponent(submission.taskId)}`;

  return (
    <main id="main" className="wrap">
      <PageHead
        kicker={
          <>
            <Link href="/submissions">历史记录</Link> / 结果
          </>
        }
        title={taskDisplayName(submission.taskId)}
      >
        <StatusBadge status={st} />
        <span className="meta">提交于 {formatTime(submission.createdAt)}</span>
        <span className="meta">编号 {submission.id.slice(0, 8)}</span>
        <span className="meta">题目 ID {submission.taskId}</span>
        <span className="spacer" />
        <Link href={resubmit} className="btn">
          再次提交
        </Link>
      </PageHead>

      {isPending(st) && <Waiting s={submission} st={st} />}

      {st === 'system_error' && (
        <section className="section stack">
          <Notice tone="warning" title="评测系统出错，本次不计次数，请稍后重试">
            问题出在评测系统，与提交的 app 无关。{r?.detail ? systemErrorZh(r.detail) : ''}
          </Notice>
          {r?.detail && <RawDetail detail={r.detail} />}
          <div>
            <Link href={resubmit} className="btn btn-primary">
              重新提交
            </Link>
          </div>
        </section>
      )}

      {st === 'not_run' && r && (
        <section className="section stack">
          <Notice tone="danger" title={failureReason(r.detail).title}>
            {failureReason(r.detail).hint} 本次计入当日次数。
          </Notice>
          {r.detail && <RawDetail detail={r.detail} />}
          <div>
            <Link href={resubmit} className="btn btn-primary">
              修改后重新提交
            </Link>
          </div>
        </section>
      )}

      {r && !isPending(st) && st !== 'system_error' && r.total > 0 && <Score s={submission} hidden={hidden} />}

      {r && !hidden && r.tests && r.tests.length > 0 && <Tests tests={r.tests as TestExtra[]} submissionId={submission.id} />}
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
