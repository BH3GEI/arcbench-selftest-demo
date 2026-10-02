import { test, expect } from './fixtures/test';
import { mockApi, SUB_FAILED, SUB_PASSED, SUB_QUEUED, SUB_SYSTEM_ERROR, makeSubmission } from './fixtures/mockApi';

test.describe('首页 / 未登录', () => {
  test('落地页文案与登录入口', async ({ page }) => {
    await mockApi(page, { loggedIn: false });
    await page.goto('/');
    await expect(page).toHaveTitle('ArcBench 自测');
    await expect(page.getByRole('button', { name: '使用 GitHub 登录' })).toBeVisible();
    await expect(page.getByText('仅读取 GitHub 公开资料')).toBeVisible();
    await expect(page.getByRole('row', { name: /成绩/ })).toContainText('不计入正式成绩');
    await expect(page.getByRole('row', { name: /次数/ })).toContainText('10');
  });

  test('未登录时不展示导航与最近提交', async ({ page }) => {
    await mockApi(page, { loggedIn: false });
    await page.goto('/');
    await expect(page.getByRole('navigation', { name: '主导航' })).toHaveCount(0);
    await expect(page.getByText('最近提交')).toHaveCount(0);
  });
});

test.describe('首页 / 已登录（mock session + mock 提交数据）', () => {
  test('问候语、开始自测入口', async ({ page }) => {
    await mockApi(page, { loggedIn: true, submissions: [] });
    await page.goto('/');
    await expect(page.getByRole('link', { name: '提交自测' })).toBeVisible();
    await expect(page.getByText('暂无提交记录。')).toBeVisible();
  });

  test('最近提交最多显示 3 条，而不是全部', async ({ page }) => {
    const subs = [
      makeSubmission({ id: 's1', createdAt: Date.now() - 1000 }),
      makeSubmission({ id: 's2', createdAt: Date.now() - 2000 }),
      makeSubmission({ id: 's3', createdAt: Date.now() - 3000 }),
      makeSubmission({ id: 's4', createdAt: Date.now() - 4000 }),
      makeSubmission({ id: 's5', createdAt: Date.now() - 5000 }),
    ];
    await mockApi(page, { loggedIn: true, submissions: subs });
    await page.goto('/');
    const rows = page.locator('table.table tbody tr');
    await expect(rows).toHaveCount(3);
  });

  test('排队中的提交，通过列显示「—」而不是「评测中」', async ({ page }) => {
    await mockApi(page, { loggedIn: true, submissions: [SUB_QUEUED] });
    await page.goto('/');
    const row = page.locator('table.table tbody tr').first();
    await expect(row).toContainText('—');
    await expect(row).not.toContainText('评测中');
  });

  test('今日剩余次数（配额）正确显示，用尽时变红', async ({ page }) => {
    await mockApi(page, { loggedIn: true, submissions: [SUB_PASSED], quota: { used: 10, limit: 10 } });
    await page.goto('/');
    const remaining = page.locator('.quota-num span').first();
    await expect(remaining).toHaveText('0');
    await expect(remaining).toHaveClass(/tone-danger/);
  });

  test('状态徽章：全部通过 / 未全部通过 / 系统错误 文案各自正确', async ({ page }) => {
    await mockApi(page, { loggedIn: true, submissions: [SUB_PASSED, SUB_FAILED, SUB_SYSTEM_ERROR] });
    await page.goto('/');
    await expect(page.getByText('全部通过', { exact: true })).toBeVisible();
    await expect(page.getByText('未全部通过', { exact: true })).toBeVisible();
    await expect(page.getByText('系统错误 · 不计次数')).toBeVisible();
  });
});
