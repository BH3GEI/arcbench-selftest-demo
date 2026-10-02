import { test, expect } from './fixtures/test';
import { mockApi, SUB_FAILED, SUB_NOT_RUN, SUB_PASSED, SUB_QUEUED, SUB_SYSTEM_ERROR } from './fixtures/mockApi';

const ALL = [SUB_PASSED, SUB_FAILED, SUB_NOT_RUN, SUB_SYSTEM_ERROR, SUB_QUEUED];

test('历史记录列表：标题、剩余次数文案、空状态', async ({ page }) => {
  await mockApi(page, { loggedIn: true, submissions: [] });
  await page.goto('/submissions');
  await expect(page).toHaveTitle('提交记录 · ArcBench 自测');
  await expect(page.getByText('暂无提交记录。')).toBeVisible();
});

test('历史记录列表：今日剩余次数文案与配额一致', async ({ page }) => {
  await mockApi(page, { loggedIn: true, submissions: [SUB_PASSED], quota: { used: 3, limit: 10 } });
  await page.goto('/submissions');
  await expect(page.getByText('今日剩余 7 / 10 次')).toBeVisible();
});

test('历史记录列表：各状态徽章文案互不混淆', async ({ page }) => {
  await mockApi(page, { loggedIn: true, submissions: ALL });
  await page.goto('/submissions');

  const rows = page.locator('table.table tbody tr');
  await expect(rows).toHaveCount(ALL.length);

  await expect(page.getByText('全部通过', { exact: true })).toBeVisible();
  await expect(page.getByText('未全部通过', { exact: true })).toBeVisible();
  await expect(page.getByText('系统错误 · 不计次数')).toBeVisible();
  await expect(page.getByText('排队中', { exact: true })).toBeVisible();

  // findings-D #3：app 没能启动（0 条测试执行）应该和"有跑但没全过"用不同徽标，不能都叫"未全部通过"。
  await expect(
    page.getByText('未能运行', { exact: true }),
    'app 没能启动（0 条测试执行）应使用独立徽标文案，不能与"未全部通过"混用',
  ).toBeVisible();
});

test('排队/运行中的提交，"通过"列显示「—」而不是别的词', async ({ page }) => {
  await mockApi(page, { loggedIn: true, submissions: [SUB_QUEUED] });
  await page.goto('/submissions');
  const row = page.locator('table.table tbody tr').first();
  await expect(row).toContainText('—');
});

test('点击一行跳转到对应的结果详情页', async ({ page }) => {
  await mockApi(page, { loggedIn: true, submissions: [SUB_PASSED] });
  await page.goto('/submissions');
  await page.getByRole('link', { name: /查看/ }).click();
  await expect(page).toHaveURL(new RegExp(`/submissions/${SUB_PASSED.id}$`));
});
