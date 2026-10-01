'use client';

import { useSession } from 'next-auth/react';
import Link from 'next/link';
import {
  DAILY_LIMIT,
  Icon,
  Loading,
  MAX_ZIP_MB,
  QuotaCard,
  SignInButton,
  StatusBadge,
  effectiveStatus,
  formatRelative,
  useSubmissions,
} from './_ui';

function Facts() {
  return (
    <section className="facts" aria-label="使用须知">
      <div className="card card-tight fact">
        <span className="fact-icon">
          <Icon.shield />
        </span>
        <div>
          <h3>不计成绩</h3>
          <p>自测结果只有你自己能看到，不进排行榜，也不影响正式提交。</p>
        </div>
      </div>
      <div className="card card-tight fact">
        <span className="fact-icon">
          <Icon.clock />
        </span>
        <div>
          <h3>每天 {DAILY_LIMIT} 次</h3>
          <p>每天 UTC 0 点重置。评测系统自身出错的提交不计次数。</p>
        </div>
      </div>
      <div className="card card-tight fact">
        <span className="fact-icon">
          <Icon.bolt />
        </span>
        <div>
          <h3>和正式评测同环境</h3>
          <p>用同一套容器和测试跑一遍，提前发现“本地能过、线上挂”的问题。</p>
        </div>
      </div>
    </section>
  );
}

function HowTo() {
  return (
    <section className="card" aria-labelledby="howto">
      <h2 id="howto" style={{ fontSize: 'var(--fs-lg)', marginBottom: 'var(--s-4)' }}>
        怎么用
      </h2>
      <ol className="steps">
        <li>
          <span>
            <strong>打包</strong>：把 app 打成一个 <code>.zip</code>，根目录要有 <code>Dockerfile</code>，不超过{' '}
            {MAX_ZIP_MB} MB。
          </span>
        </li>
        <li>
          <span>
            <strong>选题上传</strong>：选择题目，把 zip 拖进上传框。
          </span>
        </li>
        <li>
          <span>
            <strong>看结果</strong>：通常几分钟出分，可以展开每条测试看报错和截图。
          </span>
        </li>
      </ol>
    </section>
  );
}

export default function HomePage() {
  const { data: session, status } = useSession();
  const { subs, quota } = useSubmissions(status === 'authenticated');

  if (status === 'loading') return <Loading />;

  if (!session) {
    return (
      <main id="main" className="container">
        <section className="hero">
          <span className="eyebrow">ArcBench 选手自测通道</span>
          <h1>上传你的 app，几分钟看到测试结果</h1>
          <p className="lead">
            用和正式评测相同的环境跑一遍题目测试。这里的结果不计入成绩，只是帮你提前排查问题。
          </p>
          <SignInButton large />
          <p className="subtle">只读取你的 GitHub 公开资料，用于区分选手和统计每日次数。</p>
        </section>
        <div className="stack" style={{ paddingBottom: 'var(--s-12)' }}>
          <Facts />
          <HowTo />
        </div>
      </main>
    );
  }

  const recent = subs?.slice(0, 3) ?? null;

  return (
    <main id="main" className="container page">
      <div className="page-head">
        <div>
          <h1>你好，{session.user?.name ?? '选手'}</h1>
          <p className="sub">选一道题上传 zip，几分钟后回来看结果。</p>
        </div>
        <Link href="/tasks" className="btn btn-primary btn-lg">
          <Icon.upload /> 开始自测
        </Link>
      </div>

      <div className="split">
        <section className="stack" aria-labelledby="recent">
          <div className="row">
            <h2 id="recent" style={{ fontSize: 'var(--fs-lg)' }}>
              最近提交
            </h2>
            <span className="spacer" />
            <Link href="/submissions" className="subtle">
              全部记录 →
            </Link>
          </div>
          {!recent && <div className="skeleton" style={{ height: 160 }} />}
          {recent?.length === 0 && (
            <div className="card empty">
              <span className="icon">
                <Icon.file />
              </span>
              <p className="muted">还没有提交过，先选一道题试试。</p>
            </div>
          )}
          {recent && recent.length > 0 && (
            <div className="list">
              {recent.map((s) => (
                <Link key={s.id} href={`/submissions/${s.id}`} className="list-row compact">
                  <span className="c-task" style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{s.taskId}</span>
                  <span className="c-score subtle mono">
                    {s.result && s.result.total > 0 ? `${s.result.passed}/${s.result.total}` : formatRelative(s.createdAt)}
                  </span>
                  <span className="c-status">
                    <StatusBadge status={effectiveStatus(s)} />
                  </span>
                </Link>
              ))}
            </div>
          )}
        </section>
        <div className="stack">
          <QuotaCard quota={quota} />
          <HowTo />
        </div>
      </div>
    </main>
  );
}
