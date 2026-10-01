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
export type UiStatus = Submission['status'] | 'running' | 'system_error';

export function effectiveStatus(s: Submission): UiStatus {
  const st = s.status as UiStatus;
  if (st === 'error' && /could not start grading|system[_ ]error/i.test(s.result?.detail ?? '')) {
    return 'system_error';
  }
  return st;
}

export function isPending(st: UiStatus) {
  return st === 'queued' || st === 'running';
}

const STATUS_META: Record<string, { label: string; tone: string; live?: boolean }> = {
  queued: { label: '排队中', tone: '', live: true },
  running: { label: '运行中', tone: 'badge-info', live: true },
  passed: { label: '全部通过', tone: 'badge-success' },
  failed: { label: '部分未通过', tone: 'badge-danger' },
  error: { label: '运行出错', tone: 'badge-warning' },
  system_error: { label: '系统出错·不计次', tone: 'badge-warning' },
};

export function StatusBadge({ status }: { status: UiStatus }) {
  const m = STATUS_META[status] ?? { label: status, tone: '' };
  return <span className={`badge ${m.tone} ${m.live ? 'badge-live' : ''}`}>{m.label}</span>;
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
  [/daily submission limit/i, '今天的自测次数已经用完，明天（UTC 0 点）会重置。'],
  [/overall daily submission limit/i, '今天全站的自测名额已满，请明天再试。'],
  [/not a zip/i, '这不是有效的 .zip 文件，请重新打包后上传。'],
  [/zip exceeds/i, `文件超过 ${MAX_ZIP_MB} MB，请删掉 node_modules、构建产物等再打包。`],
  [/at least \d+ days old/i, 'GitHub 账号注册时间太短，暂时不能使用自测。'],
  [/unknown task/i, '找不到这道题目，请返回题目列表重新选择。'],
  [/sign in required/i, '登录已失效，请重新登录。'],
  [/could not start grading|upload failed/i, '评测系统出错，本次不计次数，请稍后重试。'],
];

export function zhError(msg: string) {
  for (const [re, zh] of ERROR_ZH) if (re.test(msg)) return zh;
  return msg;
}

/* ------------------------------------------------------------------ */
/* icons (inline SVG, aria-hidden)                                     */
/* ------------------------------------------------------------------ */

type IconProps = { size?: number };
const svg = (path: ReactNode, size = 18) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    {path}
  </svg>
);
export const Icon = {
  upload: ({ size }: IconProps) =>
    svg(
      <>
        <path d="M12 16V4" />
        <path d="m6 10 6-6 6 6" />
        <path d="M4 20h16" />
      </>,
      size,
    ),
  check: ({ size }: IconProps) => svg(<path d="m5 12 5 5 9-10" />, size ?? 14),
  x: ({ size }: IconProps) =>
    svg(
      <>
        <path d="M6 6l12 12" />
        <path d="M18 6 6 18" />
      </>,
      size ?? 14,
    ),
  chevron: ({ size }: IconProps) => svg(<path d="m9 6 6 6-6 6" />, size ?? 16),
  info: ({ size }: IconProps) =>
    svg(
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v5" />
        <path d="M12 8h.01" />
      </>,
      size,
    ),
  alert: ({ size }: IconProps) =>
    svg(
      <>
        <path d="M12 3 2 20h20L12 3z" />
        <path d="M12 10v4" />
        <path d="M12 17h.01" />
      </>,
      size,
    ),
  file: ({ size }: IconProps) =>
    svg(
      <>
        <path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z" />
        <path d="M14 3v5h5" />
      </>,
      size,
    ),
  shield: ({ size }: IconProps) => svg(<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z" />, size),
  bolt: ({ size }: IconProps) => svg(<path d="M13 2 4 14h7l-1 8 9-12h-7z" />, size),
  clock: ({ size }: IconProps) =>
    svg(
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>,
      size,
    ),
  eyeOff: ({ size }: IconProps) =>
    svg(
      <>
        <path d="M3 3l18 18" />
        <path d="M10.6 6.1A10 10 0 0 1 12 6c6 0 9.5 6 9.5 6a17 17 0 0 1-3 3.6" />
        <path d="M6.6 6.6C3.9 8.3 2.5 12 2.5 12S6 18 12 18a9.6 9.6 0 0 0 4.4-1" />
      </>,
      size,
    ),
  sun: ({ size }: IconProps) =>
    svg(
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </>,
      size,
    ),
  moon: ({ size }: IconProps) => svg(<path d="M21 13A9 9 0 1 1 11 3a7 7 0 0 0 10 10z" />, size),
  github: ({ size = 18 }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  ),
};

/* ------------------------------------------------------------------ */
/* theme toggle                                                        */
/* ------------------------------------------------------------------ */

export function ThemeToggle() {
  const [dark, setDark] = useState<boolean | null>(null);

  useEffect(() => {
    const attr = document.documentElement.dataset.theme;
    setDark(attr ? attr === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches);
  }, []);

  function toggle() {
    const next = !dark;
    setDark(next);
    document.documentElement.dataset.theme = next ? 'dark' : 'light';
    try {
      localStorage.setItem('theme', next ? 'dark' : 'light');
    } catch {}
  }

  return (
    <button
      type="button"
      className="btn btn-ghost btn-icon"
      onClick={toggle}
      aria-label={dark ? '切换到亮色模式' : '切换到暗色模式'}
      title={dark ? '切换到亮色模式' : '切换到暗色模式'}
    >
      {dark ? <Icon.sun /> : <Icon.moon />}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* header / footer                                                     */
/* ------------------------------------------------------------------ */

const NAV = [
  { href: '/tasks', label: '提交自测', match: ['/tasks', '/submit'] },
  { href: '/submissions', label: '历史记录', match: ['/submissions'] },
];

export function SiteHeader() {
  const { data: session } = useSession();
  const pathname = usePathname() || '/';

  return (
    <header className="site-header">
      <div className="container">
        <Link href="/" className="brand" aria-label="ArcBench 自测 首页">
          <span className="brand-mark" aria-hidden="true">
            AB
          </span>
          <span>ArcBench 自测</span>
          <span className="brand-tag">不计成绩</span>
        </Link>
        {session && (
          <nav className="nav" aria-label="主导航">
            {NAV.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                aria-current={n.match.some((m) => pathname.startsWith(m)) ? 'page' : undefined}
              >
                {n.label}
              </Link>
            ))}
          </nav>
        )}
        <span className="spacer" />
        <ThemeToggle />
        {session && (
          <span className="user-chip">
            {session.user?.image && <img src={session.user.image} alt="" />}
            <span className="name">{session.user?.name}</span>
            <button type="button" className="btn btn-sm" onClick={() => signOut({ callbackUrl: '/' })}>
              退出
            </button>
          </span>
        )}
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="container row">
        <span>ArcBench 自测通道 · 结果仅你本人可见，不计入正式成绩和排行榜</span>
      </div>
    </footer>
  );
}

/* ------------------------------------------------------------------ */
/* building blocks                                                     */
/* ------------------------------------------------------------------ */

export function Notice({
  tone = 'info',
  title,
  children,
}: {
  tone?: 'info' | 'warning' | 'danger';
  title?: ReactNode;
  children?: ReactNode;
}) {
  const icon = tone === 'info' ? <Icon.info /> : <Icon.alert />;
  return (
    <div className={`notice notice-${tone}`} role={tone === 'danger' ? 'alert' : undefined}>
      <span className="icon">{icon}</span>
      <div>
        {title && <strong>{title}</strong>}
        {children && <div className={title ? 'muted' : undefined}>{children}</div>}
      </div>
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
      className={`progress ${tone ? `is-${tone}` : ''} ${indeterminate ? 'is-indeterminate' : ''}`}
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

export function Loading({ label = '加载中…' }: { label?: string }) {
  return (
    <main id="main" className="container page" aria-busy="true">
      <div className="skeleton" style={{ height: 32, width: 220 }} />
      <div className="skeleton" style={{ height: 140 }} />
      <div className="skeleton" style={{ height: 220 }} />
      <span className="sr-only">{label}</span>
    </main>
  );
}

export function SignInButton({ large }: { large?: boolean }) {
  return (
    <button
      type="button"
      className={`btn btn-primary ${large ? 'btn-lg' : ''}`}
      onClick={() => signIn('github')}
    >
      <Icon.github /> 使用 GitHub 登录
    </button>
  );
}

/** 未登录时显示的占位；登录后渲染 children。 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { data: session, status } = useSession();
  if (status === 'loading') return <Loading />;
  if (!session) {
    return (
      <main id="main" className="container page">
        <div className="card empty">
          <span className="icon">
            <Icon.shield />
          </span>
          <h2>请先登录</h2>
          <p className="muted">登录后才能提交自测和查看你的记录。</p>
          <SignInButton />
        </div>
      </main>
    );
  }
  return <>{children}</>;
}

/** 拉取当前用户的提交记录（历史页、上传页的剩余次数共用）。 */
export function useSubmissions(enabled: boolean) {
  const [subs, setSubs] = useState<Submission[] | null>(null);
  const [quota, setQuota] = useState<{ used: number; limit: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    fetch('/api/submissions', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        if (d.error) return setError(zhError(d.error));
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
      })
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [enabled]);

  return { subs, quota, error };
}

export function QuotaCard({ quota }: { quota: { used: number; limit: number } | null }) {
  if (!quota) return <div className="card skeleton" style={{ height: 132 }} />;
  const remaining = Math.max(0, quota.limit - quota.used);
  return (
    <section className="card" aria-labelledby="quota-title">
      <div className="card-title" id="quota-title">
        今日剩余次数
      </div>
      <div className="quota">
        <span className={`big ${remaining === 0 ? 'tone-danger' : ''}`}>{remaining}</span>
        <span className="muted">/ {quota.limit} 次</span>
      </div>
      <div className="dots" aria-hidden="true">
        {Array.from({ length: quota.limit }, (_, i) => (
          <span key={i} className={i < quota.used ? 'used' : ''} />
        ))}
      </div>
      <p className="subtle" style={{ marginTop: 'var(--s-3)' }}>
        每天 UTC 0 点（北京时间 8 点）重置；系统出错的提交不计次数。
      </p>
    </section>
  );
}
