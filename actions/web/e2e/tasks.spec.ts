import { test, expect } from './fixtures/test';
import { mockApi, MOCK_TASKS } from './fixtures/mockApi';

test('题目列表正常渲染，点击进入对应上传页', async ({ page }) => {
  await mockApi(page, { loggedIn: true });
  await page.goto('/tasks');
  await expect(page).toHaveTitle('选择题目 · ArcBench 自测');
  await expect(page.getByRole('link', { name: MOCK_TASKS[0].displayName, exact: true })).toBeVisible();
  await page.getByRole('link', { name: `上传到 ${MOCK_TASKS[0].displayName}` }).click();
  await expect(page).toHaveURL(new RegExp(`/submit/${MOCK_TASKS[0].id}$`));
});

test('题目列表为空时显示空状态文案', async ({ page }) => {
  await mockApi(page, { loggedIn: true, tasks: [] });
  await page.goto('/tasks');
  await expect(page.getByText('暂无开放自测的题目。')).toBeVisible();
});
