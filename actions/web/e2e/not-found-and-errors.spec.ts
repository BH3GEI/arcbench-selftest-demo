import { test, expect } from './fixtures/test';

// findings-A #5：自定义 404 页面退化为 Next.js 默认英文页。
test('不存在的路由显示站点自己的中文 404，而不是 Next.js 默认英文页', async ({ page }) => {
  await page.goto('/this-page-does-not-exist-xyz');
  await expect(page.locator('.site-header')).toBeVisible();
  await expect(page.locator('.site-header .wordmark')).toContainText('ArcBench');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('页面不存在');
  await expect(page.getByRole('link', { name: '返回首页' })).toBeVisible();
  await expect(page.getByText('This page could not be found')).toHaveCount(0);
  await expect(page, '404 页面的 <title> 没有像其它页面一样被 PageHead 更新，停留在站点默认标题').toHaveTitle(
    '页面不存在 · ArcBench 自测',
  );
});

// findings-A #1 / #2：取消 GitHub 授权、或回调出错，之前落到 NextAuth 默认无样式英文页。
test.describe('/auth/signin 错误态：取消授权 / 回调失败，使用站点自己的中文样式', () => {
  test('error=Callback（点击取消授权）', async ({ page }) => {
    await page.goto('/auth/signin?error=Callback');
    await expect(page.locator('.site-header')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('登录未完成');
    await expect(page.getByText('GitHub 授权已取消或未完成')).toBeVisible();
    await expect(page.getByRole('button', { name: '重新登录' })).toBeVisible();
    await expect(page.getByText('Try signing in with a different account')).toHaveCount(0);
  });

  test('error=OAuthCallback（授权回调异常）', async ({ page }) => {
    await page.goto('/auth/signin?error=OAuthCallback');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('登录未完成');
    await expect(page.getByText('GitHub 授权已取消，或授权过程被中断')).toBeVisible();
  });

  test('error=SessionRequired（会话过期后的跳转）', async ({ page }) => {
    await page.goto('/auth/signin?error=SessionRequired');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('需要登录');
  });

  test('无 error 参数时显示正常登录入口', async ({ page }) => {
    await page.goto('/auth/signin');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('使用 GitHub 登录');
    await expect(page.getByText('仅读取 GitHub 公开资料')).toBeVisible();
  });
});
