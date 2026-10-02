import { test, expect } from './fixtures/test';

// 全部使用全新、无 cookie 的浏览器上下文（Playwright 每个 test 默认新建 context），
// 天然等价于「未登录」，不需要也不应该 mock /api/auth/session —— 要验证的正是真实未登录响应。
const PROTECTED_PATHS = [
  '/tasks',
  '/submissions',
  '/submit/github-stage-1-req-test',
  '/submissions/00000000-0000-0000-0000-000000000000',
];

for (const path of PROTECTED_PATHS) {
  test(`未登录直接访问 ${path} 显示「需要登录」占位，而不是其它内容或跳转`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('需要登录');
    await expect(page.getByRole('button', { name: '使用 GitHub 登录' })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'));
  });
}
