import type { ReactNode } from 'react';
import { Providers } from './providers';
import { SiteFooter, SiteHeader } from './_ui';
import './globals.css';

export const metadata = {
  title: 'ArcBench 自测',
  description: '上传你的 app，用正式评测环境跑一遍测试，几分钟看到结果。不计入成绩和排行榜。',
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f6f7f9' },
    { media: '(prefers-color-scheme: dark)', color: '#0b0d12' },
  ],
};

// 在首帧前应用用户手动选择的主题，避免闪烁。
const themeInit = `try{var t=localStorage.getItem('theme');if(t==='dark'||t==='light')document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body>
        <a className="skip-link" href="#main">
          跳到主要内容
        </a>
        <Providers>
          <SiteHeader />
          {children}
          <SiteFooter />
        </Providers>
      </body>
    </html>
  );
}
