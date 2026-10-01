'use client';

import Link from 'next/link';
import { PageHead } from './_ui';

export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <main id="main" className="wrap">
      <PageHead kicker="出错了" title="页面加载失败" lead="请稍后重试。如果问题持续出现，可以先返回首页。">
        <button type="button" className="btn btn-primary" onClick={reset}>
          重试
        </button>
        <Link href="/" className="btn">
          返回首页
        </Link>
      </PageHead>
    </main>
  );
}
