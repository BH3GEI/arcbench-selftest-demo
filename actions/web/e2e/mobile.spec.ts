import { devices } from '@playwright/test';
import { test, expect } from './fixtures/test';
import { mockApi, MOCK_USER } from './fixtures/mockApi';

// findings-D #4：窄屏（≤390px）header 曾把用户名整个从可访问树里移除（display:none），
// 只留退出按钮，用户完全看不到自己登录的是哪个账号。
// 用 Chromium 模拟 iPhone 13 的视口/UA/触屏，而不是切到 iPhone 13 预设默认的 WebKit
// （当前只装了 Chromium，这里只关心窄屏布局，不需要真实 Safari 引擎）。
test.use({ ...devices['iPhone 13'], defaultBrowserType: 'chromium' });

test('移动端窄屏下仍能看到（哪怕截断的）登录用户名，不是被整个隐藏', async ({ page }) => {
  await mockApi(page, { loggedIn: true, submissions: [] });
  await page.goto('/');

  const uname = page.locator('.user .uname');
  await expect(uname).toBeVisible();
  await expect(uname).toHaveText(MOCK_USER.name);

  const signOutBtn = page.getByRole('button', { name: /退出/ });
  await expect(signOutBtn).toBeVisible();
});

test('移动端导航在窄屏下换行展示，不裁切、不重叠', async ({ page }) => {
  await mockApi(page, { loggedIn: true, submissions: [] });
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: '主导航' });
  await expect(nav).toBeVisible();
  const box = await nav.boundingBox();
  expect(box?.width).toBeGreaterThan(0);
});
