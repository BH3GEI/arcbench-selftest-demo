'use client';

import { useSession } from 'next-auth/react';
import Link from 'next/link';
import { taskDisplayName } from '@/lib/taskVisibility';
import {
  DAILY_LIMIT,
  Loading,
  MAX_ZIP_MB,
  PageHead,
  Quota,
  SignInButton,
  StatusBadge,
  effectiveStatus,
  formatTime,
  useSubmissions,
} from './_ui';


function Rules() {
  return (
    <table className="dl">
      <tbody>
        <tr>
          <th scope="row">成绩</th>
          <td>自测结果仅本人可见，不计入正式成绩和排行榜，不影响正式提交。</td>
        </tr>
        <tr>
          <th scope="row">次数</th>
          <td>每人每天 {DAILY_LIMIT} 次，UTC 0:00（北京时间 8:00）重置。评测系统自身出错的提交不计次数。</td>
        </tr>
        <tr>
          <th scope="row">环境</th>
          <td>与正式评测使用相同的容器镜像和测试用例。</td>
        </tr>
        <tr>
          <th scope="row">提交格式</th>
          <td>
            一个 <code>.zip</code> 文件，根目录包含 <code>Dockerfile</code>，不超过 {MAX_ZIP_MB} MB。
          </td>
        </tr>
        <tr>
          <th scope="row">流程</th>
          <td>选择题目，上传 zip，等待构建和测试完成，查看逐条测试结果。</td>
        </tr>
      </tbody>
    </table>
  );
}

export default function HomePage() {
  const { data: session, status } = useSession();
  const { subs, quota } = useSubmissions(status === 'authenticated');

  if (status === 'loading') return <Loading />;

  if (!session) {
    return (
      <main id="main" className="wrap">
        <PageHead
          kicker="自测通道"
          title="ArcBench 自测"
          lead="上传 app 的 zip 包，在正式评测环境中运行题目测试并查看结果。自测结果不计入成绩。"
        >
          <SignInButton large />
          <span className="meta">仅读取 GitHub 公开资料，用于识别选手和统计次数</span>
        </PageHead>
        <section className="section" aria-labelledby="rules">
          <div className="section-title">
            <h2 id="rules">说明</h2>
          </div>
          <Rules />
        </section>
      </main>
    );
  }

  const recent = subs?.slice(0, 3) ?? null;

  return (
    <main id="main" className="wrap">
      <PageHead kicker="概览" title="ArcBench 自测" lead="选择题目并上传 zip，结果通常在几分钟内返回。">
        <Link href="/tasks" className="btn btn-primary btn-lg">
          提交自测
        </Link>
        <Link href="/submissions" className="btn btn-lg">
          历史记录
        </Link>
      </PageHead>

      <div className="section cols">
        <section aria-labelledby="recent">
          <div className="section-title">
            <h2 id="recent">最近提交</h2>
            <span className="spacer" />
            <Link href="/submissions" className="meta">
              全部记录 →
            </Link>
          </div>
          {!recent && <div className="skeleton" style={{ height: 160 }} />}
          {recent?.length === 0 && <p className="empty">暂无提交记录。</p>}
          {recent && recent.length > 0 && (
            <table className="table responsive">
              <thead>
                <tr>
                  <th scope="col">题目</th>
                  <th scope="col">通过</th>
                  <th scope="col">状态</th>
                  <th scope="col">提交时间</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <Link href={`/submissions/${s.id}`} className="rowlink">
                        {taskDisplayName(s.taskId)}
                      </Link>
                    </td>
                    <td className="num">{s.result && s.result.total > 0 ? `${s.result.passed} / ${s.result.total}` : '—'}</td>
                    <td>
                      <StatusBadge status={effectiveStatus(s)} />
                    </td>
                    <td className="meta" data-wide>
                      {formatTime(s.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        <aside className="stack" style={{ gap: 'var(--s-8)' }}>
          <Quota quota={quota} />
          <section aria-labelledby="rules">
            <div className="label" id="rules" style={{ marginBottom: 'var(--s-3)' }}>
              说明
            </div>
            <Rules />
          </section>
        </aside>
      </div>
    </main>
  );
}
