import { test as base, expect } from '@playwright/test';

/**
 * 当前环境里 Google Fonts（fonts.googleapis.com / fonts.gstatic.com）不可达，
 * 而站点 layout.tsx 里引用了外部字体 <link>，默认 page.goto 等 'load' 事件会因此
 * 挂到超时。全站测试统一改成等 'domcontentloaded'（不等外部字体/图片加载完），
 * 不影响我们要断言的站内文本/结构。
 */
export const test = base.extend({
  page: async ({ page }, use) => {
    const originalGoto = page.goto.bind(page);
    page.goto = ((url, options) => originalGoto(url, { waitUntil: 'domcontentloaded', ...options })) as typeof page.goto;
    await use(page);
  },
});

export { expect };
