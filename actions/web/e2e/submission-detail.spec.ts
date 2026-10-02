import { test, expect } from './fixtures/test';
import {
  mockApi,
  SUB_FAILED,
  SUB_HIDDEN,
  SUB_NOT_RUN,
  SUB_PASSED,
  SUB_QUEUED,
  SUB_SYSTEM_ERROR,
} from './fixtures/mockApi';

test('全部通过：得分卡片为绿色，无"未通过"筛选默认态', async ({ page }) => {
  await mockApi(page, { loggedIn: true });
  await page.goto(`/submissions/${SUB_PASSED.id}`);
  await expect(page).toHaveTitle(/ArcBench 自测/);
  await expect(page.getByText('全部通过', { exact: true })).toBeVisible();
  await expect(page.locator('.score-num')).toContainText('3');
  await expect(page.getByRole('button', { name: /^全部 3$/ })).toHaveAttribute('aria-pressed', 'true');
});

test.describe('部分失败：截图链接、报错文本、无英文摘要残留', () => {
  test('得分摘要不包含未翻译的英文原文（如 "x/x tests failed"）', async ({ page }) => {
    await mockApi(page, { loggedIn: true });
    await page.goto(`/submissions/${SUB_FAILED.id}`);
    await expect(page.getByText(/tests failed/i)).toHaveCount(0);
  });

  test('默认筛选为"未通过"，展开后报错文本和截图正常显示，截图链接能真正打开（非死链）', async ({ page }) => {
    await mockApi(page, { loggedIn: true });
    await page.goto(`/submissions/${SUB_FAILED.id}`);

    await expect(page.getByRole('button', { name: /^未通过 2$/ })).toHaveAttribute('aria-pressed', 'true');

    const firstFailed = page.locator('details.test').first();
    await firstFailed.locator('summary').click();
    await expect(firstFailed.locator('pre')).toContainText('Test timeout');

    const link = firstFailed.locator('a[target=_blank]').first();
    const href = await link.getAttribute('href');
    expect(href, '截图链接应指向本站的 /api/submissions/<id>/screenshot 接口，而不是裸拼接的相对路径死链').toContain(
      `/api/submissions/${SUB_FAILED.id}/screenshot?path=`,
    );

    const img = firstFailed.locator('img');
    await expect(img).toBeVisible();
    await expect.poll(async () => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
  });
});

test('app 没能启动（not_run）：提示文案是"未能运行"类说明，不是"未全部通过"的测试叙事', async ({ page }) => {
  await mockApi(page, { loggedIn: true });
  await page.goto(`/submissions/${SUB_NOT_RUN.id}`);
  await expect(page.getByText('未能运行', { exact: true })).toBeVisible();
  await expect(page.getByText('zip 根目录缺少 Dockerfile', { exact: true })).toBeVisible();
  await expect(page.getByText('Dockerfile 需要位于 zip 的根目录')).toBeVisible();
});

test('系统错误：不计次数提示 + 原始信息可展开 + 可重新提交', async ({ page }) => {
  await mockApi(page, { loggedIn: true });
  await page.goto(`/submissions/${SUB_SYSTEM_ERROR.id}`);
  await expect(page.getByText('评测系统出错，本次不计次数，请稍后重试')).toBeVisible();
  await expect(page.getByRole('link', { name: '重新提交' })).toBeVisible();
});

test('隐藏测试题：只显示通过数量，不展示测试明细', async ({ page }) => {
  await mockApi(page, { loggedIn: true });
  await page.goto(`/submissions/${SUB_HIDDEN.id}`);
  await expect(page.getByText('本题只公布通过数量，不显示每条测试的内容和报错。')).toBeVisible();
  await expect(page.getByRole('heading', { name: '测试明细' })).toHaveCount(0);
});

test('排队中：等待组件显示时间线与自动刷新提示', async ({ page }) => {
  await mockApi(page, { loggedIn: true });
  await page.goto(`/submissions/${SUB_QUEUED.id}`);
  await expect(page.getByRole('heading', { name: '排队中' })).toBeVisible();
  await expect(page.getByText('页面每 4 秒自动刷新')).toBeVisible();
});

test('访问不存在的提交 id：统一提示"提交记录不存在"，不是 500 或裸错误', async ({ page }) => {
  await mockApi(page, { loggedIn: true });
  await page.goto('/submissions/does-not-exist-id');
  await expect(page.getByText('提交记录不存在。')).toBeVisible();
});
