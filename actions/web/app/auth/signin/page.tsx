'use client';

import { Suspense } from 'react';
import { signIn, useSession } from 'next-auth/react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Loading, Notice, PageHead } from '../../_ui';

// NextAuth 的错误码 -> 中文说明。用户在 GitHub 授权页点「取消」时是 Callback / OAuthCallback。
const AUTH_ERRORS: Record<string, { title: string; body: string }> = {
  Callback: { title: '登录未完成', body: 'GitHub 授权已取消或未完成。可以重新登录。' },
  OAuthCallback: { title: '登录未完成', body: 'GitHub 授权已取消，或授权过程被中断。请重新登录。' },
  OAuthSignin: { title: '无法跳转到 GitHub', body: '暂时无法发起 GitHub 授权，请稍后重试。' },
  OAuthAccountNotLinked: { title: '登录未完成', body: '该 GitHub 账号暂时无法登录，请重试。' },
  AccessDenied: { title: '没有登录权限', body: '该 GitHub 账号暂时不能使用自测。' },
  SessionRequired: { title: '需要登录', body: '登录后可提交自测并查看本人的提交记录。' },
  Configuration: { title: '登录服务暂时不可用', body: '登录服务配置异常，请稍后重试。' },
};
const FALLBACK = { title: '登录未完成', body: '登录过程出现问题，请重新登录。' };

// 只接受站内相对路径，避免被拼成跳转到外站的链接。
function safeCallback(raw: string | null): string {
  if (!raw) return '/';
  try {
    const u = new URL(raw, window.location.origin);
    if (u.origin !== window.location.origin) return '/';
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return '/';
  }
}

function SignInContent() {
  const params = useSearchParams();
  const { data: session, status } = useSession();
  const error = params.get('error');
  const callbackUrl = safeCallback(params.get('callbackUrl'));

  if (status === 'loading') return <Loading />;

  if (session && !error) {
    return (
      <main id="main" className="wrap">
        <PageHead kicker="登录" title="已登录" lead={`当前账号：${session.user?.name ?? ''}`}>
          <Link href={callbackUrl} className="btn btn-primary">
            继续
          </Link>
          <Link href="/" className="btn">
            返回首页
          </Link>
        </PageHead>
      </main>
    );
  }

  const info = error ? AUTH_ERRORS[error] ?? FALLBACK : null;

  return (
    <main id="main" className="wrap">
      <PageHead
        kicker="登录"
        title={info ? info.title : '使用 GitHub 登录'}
        lead={info ? undefined : '登录后可提交自测并查看本人的提交记录。仅读取 GitHub 公开资料。'}
      >
        <button type="button" className="btn btn-primary" onClick={() => signIn('github', { callbackUrl })}>
          {info ? '重新登录' : '使用 GitHub 登录'}
        </button>
        <Link href="/" className="btn">
          返回首页
        </Link>
      </PageHead>
      {info && (
        <section className="section">
          <Notice tone="warning">{info.body}</Notice>
        </section>
      )}
    </main>
  );
}

export default function SignInPage() {
  return (
    <Suspense fallback={<Loading />}>
      <SignInContent />
    </Suspense>
  );
}
