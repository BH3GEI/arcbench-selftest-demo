import { test, expect } from './fixtures/test';

// findings-D #1：主题按钮可见文字与 aria-label 语义相反，屏幕阅读器用户会被误导。
test('主题切换按钮：可见文字与 aria-label 都指向同一个「切换后的目标状态」', async ({ page }) => {
  await page.goto('/');
  const btn = page.getByRole('button', { name: /切换到(暗色|亮色)模式/ });
  await expect(btn).toBeVisible();

  const label1 = await btn.getAttribute('aria-label');
  const text1 = (await btn.textContent())?.trim();
  // 可见文字「暗色」= 点击后变暗 => aria-label 必须是「切换到暗色模式」，反之亦然。
  expect(label1).toBe(`切换到${text1}模式`);

  await btn.click();
  await expect(btn).not.toHaveText(text1 ?? '');
  const label2 = await btn.getAttribute('aria-label');
  const text2 = (await btn.textContent())?.trim();
  expect(label2).toBe(`切换到${text2}模式`);
});

test('主题切换后刷新页面保持，不闪回', async ({ page }) => {
  await page.goto('/');
  const btn = page.getByRole('button', { name: /切换到(暗色|亮色)模式/ });
  const before = await page.evaluate(() => document.documentElement.dataset.theme || 'dark');
  await btn.click();
  const after = await page.evaluate(() => document.documentElement.dataset.theme || 'dark');
  expect(after).not.toBe(before);

  await page.reload();
  const persisted = await page.evaluate(() => document.documentElement.dataset.theme || 'dark');
  expect(persisted).toBe(after);
});

// findings-D #5：首次访问、系统偏好是亮色时，站点应跟随系统，而不是硬编码暗色。
test('首次访问（无 localStorage 记录）且系统偏好亮色时，默认渲染亮色主题', async ({ browser }) => {
  const context = await browser.newContext({ colorScheme: 'light' });
  const page = await context.newPage();
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  expect(theme).toBe('light');
  await context.close();
});
