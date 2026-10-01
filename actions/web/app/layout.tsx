import type { ReactNode } from 'react';
import { Providers } from './providers';
import { OfflineNotice, SiteFooter, SiteHeader } from './_ui';
import './globals.css';

export const metadata = {
  title: 'ArcBench 自测',
  description: '在正式评测环境中运行题目测试并查看结果。自测结果不计入正式成绩。',
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { color: '#060607' },
  ],
};

// 有用户手动选择时以它为准；否则首次访问跟随系统亮/暗偏好。在首帧前执行，避免闪烁。
const themeInit = `try{
  var t=localStorage.getItem('theme');
  if(t==='light')document.documentElement.dataset.theme='light';
  else if(t!=='dark'&&window.matchMedia('(prefers-color-scheme: light)').matches)document.documentElement.dataset.theme='light';
}catch(e){}`;

// 与比赛平台相同的字体。
const FONTS =
  'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Noto+Sans+SC:wght@400;500;600;700&family=Space+Grotesk:wght@400;500;600;700&display=swap';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link rel="stylesheet" href={FONTS} />
      </head>
      <body>
        <a className="skip-link" href="#main">
          跳到正文
        </a>
        <Providers>
          <SiteHeader />
          <OfflineNotice />
          {children}
          <SiteFooter />
        </Providers>
      </body>
    </html>
  );
}
