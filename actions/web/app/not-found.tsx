import Link from 'next/link';
import { PageHead } from './_ui';

export default function NotFound() {
  return (
    <main id="main" className="wrap">
      <PageHead kicker="404" title="页面不存在" lead="链接可能有误，或页面已被移除。">
        <Link href="/" className="btn btn-primary">
          返回首页
        </Link>
        <Link href="/submissions" className="btn">
          查看提交记录
        </Link>
      </PageHead>
    </main>
  );
}
