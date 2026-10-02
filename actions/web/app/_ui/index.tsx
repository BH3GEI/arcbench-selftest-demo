'use client';

import { signIn, signOut, useSession } from 'next-auth/react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import type { Submission } from '@/lib/types';

/* ------------------------------------------------------------------ */
/* constants & helpers                                                 */
/* ------------------------------------------------------------------ */

// 与服务端 SELFTEST_WEB_DAILY_LIMIT_PER_USER 默认值一致；若 API 返回 quota 则以 API 为准。
export const DAILY_LIMIT = 10;
export const MAX_ZIP_MB = 50;

// 前端额外识别的状态（后端可能后续加入）；未知状态按原样显示。
// not_run：提交本身有问题（zip 不合规、缺 Dockerfile、构建或启动失败），测试没有执行；计入次数。
export type UiStatus = Submission['status'] | 'running' | 'not_run';

export function effectiveStatus(s: Submission): UiStatus {
  const st = s.status as string;
  if (st === 'rejected') return 'system_error';
  if (st === 'error' && /could not start grading|system[_ ]error/i.test(s.result?.detail ?? '')) {
    return 'system_error';
  }
  if ((st === 'failed' || st === 'error') && s.result && s.result.total === 0) return 'not_run';
  return st as UiStatus;
}

// 评测机返回的英文原因 -> 选手能看懂的中文说明。
const FAILURE_ZH: [RegExp, string, string][] = [
  [
    /zip failed validation/i,
    'zip 包未通过安全检查',
    'zip 中含有不允许的路径（如 ../ 或绝对路径）、解压后体积过大或文件数过多。请在 app 根目录下重新打包后再提交。',
  ],
  [
    /no Dockerfile/i,
    'zip 根目录缺少 Dockerfile',
    'Dockerfile 需要位于 zip 的根目录，不能放在子文件夹里。打包时请选中 app 目录内的文件，而不是外层文件夹。',
  ],
  [/build exceeded/i, '镜像构建超时', '构建时间超过上限。请精简构建步骤，构建过程中无法访问外网。'],
  [/app build failed/i, '镜像构建失败', '请先在本地运行 docker build 确认能构建成功。构建过程中无法访问外网。'],
  [/did not become ready/i, 'app 未能在限定时间内启动', '请检查启动命令，并确认 app 监听 PORT 环境变量指定的端口。'],
  [/test run exceeded/i, '测试运行超时', '测试整体运行时间超过上限。'],
];

const SYSTEM_ZH: [RegExp, string][] = [
  [/test browser failed to start/i, '评测机上的测试浏览器未能启动。'],
  [/download failed/i, '评测机下载提交文件失败。'],
  [/produced no result|crashed or was killed/i, '评测任务异常中断，未产生结果。'],
  [/runner exited|no report|report\.json unreadable|no tests collected/i, '测试执行器异常退出。'],
  [/dispatch rejected/i, '评测请求未通过校验。'],
  [/could not start grading/i, '评测任务未能启动。'],
];

/** system_error 的原因说明（中文）；评测超时等本来就是中文的原样返回。 */
export function systemErrorZh(detail: string): string {
  if (!/[a-z]/i.test(detail)) return detail;
  for (const [re, zh] of SYSTEM_ZH) if (re.test(detail)) return zh;
  return '';
}

export function failureReason(detail: string | undefined): { title: string; hint: string } {
  for (const [re, title, hint] of FAILURE_ZH) if (re.test(detail ?? '')) return { title, hint };
  return { title: 'app 未能运行', hint: '镜像构建或启动失败，测试未执行。请检查 Dockerfile 和启动命令。' };
}

export function isPending(st: UiStatus) {
  return st === 'queued' || st === 'running';
}

const STATUS_META: Record<string, { label: string; tone: string; live?: boolean }> = {
  queued: { label: '排队中', tone: '', live: true },
  running: { label: '运行中', tone: 'pill-info', live: true },
  passed: { label: '全部通过', tone: 'pill-success' },
  failed: { label: '未全部通过', tone: 'pill-danger' },
  error: { label: '运行失败', tone: 'pill-danger' },
  not_run: { label: '未能运行', tone: 'pill-danger' },
  system_error: { label: '系统错误 · 不计次数', tone: 'pill-warning' },
};

export function StatusBadge({ status }: { status: UiStatus }) {
  const m = STATUS_META[status] ?? { label: status, tone: '' };
  return <span className={`pill ${m.tone} ${m.live ? 'pill-live' : ''}`}>{m.label}</span>;
}

/** 今日（UTC，与服务端配额口径一致）已用次数；系统出错的不计。 */
export function usedToday(subs: Submission[]): number {
  const day = new Date().toISOString().slice(0, 10);
  return subs.filter(
    (s) => new Date(s.createdAt).toISOString().slice(0, 10) === day && effectiveStatus(s) !== 'system_error',
  ).length;
}

export function formatTime(ms: number) {
  return new Date(ms).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatRelative(ms: number) {
  const diff = Math.max(0, Date.now() - ms);
  const m = Math.floor(diff / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return formatTime(ms);
}

export function formatDuration(sec: number) {
  if (sec < 60) return `${Math.max(0, Math.round(sec))} 秒`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return s ? `${m} 分 ${s} 秒` : `${m} 分钟`;
}

export function pct(passed: number, total: number) {
  return total > 0 ? Math.round((passed / total) * 100) : 0;
}

const ERROR_ZH: [RegExp, string][] = [
  [/daily submission limit/i, '今日自测次数已用完，UTC 0:00 重置。'],
  [/overall daily submission limit/i, '今日全站自测名额已满，请次日再试。'],
  [/not a zip/i, '文件不是有效的 zip 格式。'],
  [/zip exceeds/i, `文件超过 ${MAX_ZIP_MB} MB 上限。`],
  [/at least \d+ days old/i, 'GitHub 账号注册时间不足，暂不能使用自测。'],
  [/unknown task/i, '题目不存在。'],
  [/sign in required/i, '登录已失效，请重新登录。'],
  [/could not start grading|upload failed/i, '评测系统出错，本次不计次数，请稍后重试。'],
];

export function zhError(msg: string) {
  for (const [re, zh] of ERROR_ZH) if (re.test(msg)) return zh;
  return msg;
}

/* ------------------------------------------------------------------ */
/* theme toggle                                                        */
/* ------------------------------------------------------------------ */

export function ThemeToggle() {
  const [light, setLight] = useState(false);

  useEffect(() => {
    setLight(document.documentElement.dataset.theme === 'light');
  }, []);

  function toggle() {
    const next = !light;
    setLight(next);
    if (next) document.documentElement.dataset.theme = 'light';
    else delete document.documentElement.dataset.theme;
    try {
      localStorage.setItem('theme', next ? 'light' : 'dark');
    } catch {}
  }

  return (
    <button
      type="button"
      className="btn btn-sm btn-text"
      onClick={toggle}
      aria-pressed={light}
      aria-label={light ? '切换到暗色模式' : '切换到亮色模式'}
    >
      {light ? '暗色' : '亮色'}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* header / footer                                                     */
/* ------------------------------------------------------------------ */

const NAV = [
  { href: '/', label: '概览', match: (p: string) => p === '/' },
  { href: '/tasks', label: '提交', match: (p: string) => p.startsWith('/tasks') || p.startsWith('/submit') },
  { href: '/submissions', label: '历史记录', match: (p: string) => p.startsWith('/submissions') },
];

export function SiteHeader() {
  const { data: session } = useSession();
  const pathname = usePathname() || '/';

  return (
    <header className="site-header">
      <div className="wrap bar">
        <Link href="/" className="wordmark" aria-label="ArcBench 自测 首页">
          <span className="name">
            Arc<em>Bench</em>
          </span>
          <span className="sep" aria-hidden="true" />
          <span className="sub">SELF-TEST</span>
        </Link>
        {session && (
          <nav className="nav" aria-label="主导航">
            {NAV.map((n) => (
              <Link key={n.href} href={n.href} aria-current={n.match(pathname) ? 'page' : undefined}>
                {n.label}
              </Link>
            ))}
          </nav>
        )}
        <span className="spacer" />
        <ThemeToggle />
        {session && (
          <span className="user">
            <span className="uname">{session.user?.name}</span>
            <button
              type="button"
              className="btn btn-sm"
              aria-label={session.user?.name ? `退出 ${session.user.name}` : '退出'}
              onClick={() => signOut({ callbackUrl: '/' })}
            >
              退出
            </button>
          </span>
        )}
      </div>
    </header>
  );
}

/* ------------------------------------------------------------------ */
/* offline notice                                                      */
/* ------------------------------------------------------------------ */

/** 断网/弱网时提示当前数据可能来自缓存，不打断阅读。 */
export function OfflineNotice() {
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    setOffline(typeof navigator !== 'undefined' && !navigator.onLine);
    const goOnline = () => setOffline(false);
    const goOffline = () => setOffline(true);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  if (!offline) return null;
  return (
    <div className="offline-notice" role="status" aria-live="polite">
      网络连接异常，当前显示的数据可能不是最新。
    </div>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="wrap bar">
        <span className="mark">
          Arc<em>Bench</em> 自测
        </span>
        <span className="meta">自测结果仅本人可见，不计入正式成绩</span>
      </div>
    </footer>
  );
}

/* ------------------------------------------------------------------ */
/* building blocks                                                     */
/* ------------------------------------------------------------------ */

const SITE_NAME = 'ArcBench 自测';

export function PageHead({
  kicker,
  title,
  lead,
  children,
}: {
  kicker: ReactNode;
  title: ReactNode;
  lead?: ReactNode;
  children?: ReactNode;
}) {
  useEffect(() => {
    if (typeof title !== 'string' || !title) return;
    document.title = title === SITE_NAME ? SITE_NAME : `${title} · ${SITE_NAME}`;
  }, [title]);

  return (
    <div className="page-head">
      <div className="kicker">{kicker}</div>
      <h1>{title}</h1>
      {lead && <p className="lead">{lead}</p>}
      {children && <div className="actions">{children}</div>}
    </div>
  );
}

export function Notice({
  tone = 'info',
  title,
  children,
}: {
  tone?: 'info' | 'warning' | 'danger';
  title?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className={`notice notice-${tone}`} role={tone === 'danger' ? 'alert' : undefined}>
      {title && <strong>{title}</strong>}
      {children && <div>{children}</div>}
    </div>
  );
}

export function ProgressBar({
  value,
  tone,
  indeterminate,
  label,
}: {
  value?: number;
  tone?: 'success' | 'danger';
  indeterminate?: boolean;
  label: string;
}) {
  return (
    <div
      className={`meter ${tone ? `is-${tone}` : ''} ${indeterminate ? 'is-indeterminate' : ''}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : value}
    >
      <span style={indeterminate ? undefined : { width: `${value ?? 0}%` }} />
    </div>
  );
}

export function Loading({ label = '加载中' }: { label?: string }) {
  return (
    <main id="main" className="wrap" aria-busy="true">
      <div className="page-head">
        <div className="skeleton" style={{ height: 14, width: 120 }} />
        <div className="skeleton" style={{ height: 56, width: 320, marginTop: 24 }} />
      </div>
      <div className="section">
        <div className="skeleton" style={{ height: 160 }} />
      </div>
      <span className="sr-only">{label}</span>
    </main>
  );
}

export function SignInButton({ large }: { large?: boolean }) {
  return (
    <button type="button" className={`btn btn-primary ${large ? 'btn-lg' : ''}`} onClick={() => signIn('github')}>
      使用 GitHub 登录
    </button>
  );
}

/** 未登录时显示的占位；登录后渲染 children。 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { data: session, status } = useSession();
  if (status === 'loading') return <Loading />;
  if (!session) {
    return (
      <main id="main" className="wrap">
        <PageHead kicker="自测" title="需要登录" lead="登录后可提交自测并查看本人的提交记录。">
          <SignInButton />
        </PageHead>
      </main>
    );
  }
  return <>{children}</>;
}

/** 拉取当前用户的提交记录（历史页、上传页的剩余次数共用）。 */
// 列表里有排队中/运行中的提交时，每隔这么久自动刷新一次。
const LIST_POLL_MS = 10000;

/** 拉取当前用户的提交记录（首页、历史页、上传页的剩余次数共用）。
 *  有未出结果的提交时自动轮询，切回页面时也会刷新，不会停在旧的「排队中」。 */
export function useSubmissions(enabled: boolean) {
  const [subs, setSubs] = useState<Submission[] | null>(null);
  const [quota, setQuota] = useState<{ used: number; limit: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function load() {
      if (timer) clearTimeout(timer);
      timer = null;
      let pending = false;
      try {
        const d = await fetch('/api/submissions', { cache: 'no-store' }).then((r) => r.json());
        if (!alive) return;
        if (d.error) {
          setError(zhError(d.error));
          return;
        }
        setError(null);
        const list: Submission[] = (d.submissions ?? []).slice().sort(
          (a: Submission, b: Submission) => b.createdAt - a.createdAt,
        );
        setSubs(list);
        const q = d.quota;
        if (q && typeof q.limit === 'number') {
          const used = typeof q.used === 'number' ? q.used : q.limit - (q.remaining ?? 0);
          setQuota({ used, limit: q.limit });
        } else {
          setQuota({ used: usedToday(list), limit: DAILY_LIMIT });
        }
        pending = list.some((s) => isPending(effectiveStatus(s)));
      } catch (e) {
        if (!alive) return;
        // 已有数据时，网络抖动不覆盖列表，下次轮询再试。
        setSubs((prev) => {
          if (!prev) setError(String(e));
          return prev;
        });
        pending = true;
      }
      if (alive && pending) timer = setTimeout(load, LIST_POLL_MS);
    }

    function onVisible() {
      if (document.visibilityState === 'visible') load();
    }

    load();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled]);

  return { subs, quota, error };
}

export function Quota({ quota }: { quota: { used: number; limit: number } | null }) {
  if (!quota) return <div className="skeleton" style={{ height: 96 }} />;
  const remaining = Math.max(0, quota.limit - quota.used);
  return (
    <section aria-labelledby="quota-title">
      <div className="label" id="quota-title">
        今日剩余次数
      </div>
      <div className="quota-num" style={{ marginTop: 'var(--s-3)' }}>
        <span className={remaining === 0 ? 'tone-danger' : undefined}>{remaining}</span>
        <small>/ {quota.limit}</small>
      </div>
      <div className="ticks" aria-hidden="true">
        {Array.from({ length: quota.limit }, (_, i) => (
          <span key={i} className={i < quota.used ? 'used' : ''} />
        ))}
      </div>
      <p className="subtle" style={{ marginTop: 'var(--s-3)' }}>
        每日 UTC 0:00（北京时间 8:00）重置。系统错误的提交不计次数。
      </p>
    </section>
  );
}
