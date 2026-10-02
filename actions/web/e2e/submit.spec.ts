import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect } from './fixtures/test';
import { mockApi, makeSubmission } from './fixtures/mockApi';

const TASK_PATH = '/submit/github-stage-1-req-test';

// Playwright 的 setInputFiles 内联 buffer 上限是 50MB，超过要先落盘再传路径。
function makeOversizedZipPath(): string {
  const file = path.join(os.tmpdir(), 'e2e-oversized.zip');
  if (!fs.existsSync(file) || fs.statSync(file).size !== 51 * 1024 * 1024) {
    fs.writeFileSync(file, Buffer.alloc(51 * 1024 * 1024));
  }
  return file;
}

test.describe('上传页 / 客户端文件校验（不触发真实提交）', () => {
  test('非 .zip 扩展名 → 前端直接拦截，不发请求', async ({ page }) => {
    await mockApi(page, { loggedIn: true, submissions: [] });
    await page.goto(TASK_PATH);
    await page.locator('#zip').setInputFiles({ name: 'app.txt', mimeType: 'text/plain', buffer: Buffer.from('hi') });
    await expect(page.getByText('仅支持 .zip 文件。')).toBeVisible();
    await expect(page.getByRole('button', { name: '提交自测' })).toBeDisabled();
  });

  test('空文件（0 字节）→ 前端提示文件为空', async ({ page }) => {
    await mockApi(page, { loggedIn: true, submissions: [] });
    await page.goto(TASK_PATH);
    await page.locator('#zip').setInputFiles({ name: 'empty.zip', mimeType: 'application/zip', buffer: Buffer.alloc(0) });
    await expect(page.getByText('文件为空。')).toBeVisible();
  });

  test('超过 50MB → 前端提示超限，且带出准确的 MB 数字', async ({ page }) => {
    await mockApi(page, { loggedIn: true, submissions: [] });
    await page.goto(TASK_PATH);
    await page.locator('#zip').setInputFiles(makeOversizedZipPath());
    await expect(page.getByText(/超过 50 MB 上限/)).toBeVisible();
  });

  test('合法 zip → 文件名/大小展示正确，可移除', async ({ page }) => {
    await mockApi(page, { loggedIn: true, submissions: [] });
    await page.goto(TASK_PATH);
    await page.locator('#zip').setInputFiles({ name: 'good-app.zip', mimeType: 'application/zip', buffer: Buffer.from('PK\x03\x04fake') });
    await expect(page.getByText('good-app.zip')).toBeVisible();
    await expect(page.getByRole('button', { name: '提交自测' })).toBeEnabled();
    await page.getByRole('button', { name: '移除' }).click();
    await expect(page.getByText('good-app.zip')).toHaveCount(0);
  });
});

test('今日次数用完：提交按钮 disabled，显示次数用完提示', async ({ page }) => {
  const used10 = Array.from({ length: 10 }, (_, i) => makeSubmission({ id: `q-${i}`, createdAt: Date.now() - i * 1000 }));
  await mockApi(page, { loggedIn: true, submissions: used10, quota: { used: 10, limit: 10 } });
  await page.goto(TASK_PATH);
  await expect(page.getByText('今日次数已用完')).toBeVisible();
  await page.locator('#zip').setInputFiles({ name: 'good-app.zip', mimeType: 'application/zip', buffer: Buffer.from('PK\x03\x04fake') });
  await expect(page.getByRole('button', { name: '提交自测' })).toBeDisabled();
});

// findings-B #5：原生文件选择控件缺少中文 aria-label，屏幕阅读器读到的是默认英文 "Choose File"。
test('文件选择控件应有中文 aria-label（而不是依赖浏览器默认的英文 Choose File）', async ({ page }) => {
  await mockApi(page, { loggedIn: true, submissions: [] });
  await page.goto(TASK_PATH);
  const ariaLabel = await page.locator('#zip').getAttribute('aria-label');
  expect(ariaLabel, 'input#zip 缺少 aria-label，屏幕阅读器会读到浏览器默认的英文 "Choose File"').toBeTruthy();
});

// findings-B #4：zip 格式要求没写明具体监听端口，只写"题目要求的端口"。
test('zip 格式要求应明确写出监听端口依据（如 PORT 环境变量），而不是只说"题目要求的端口"', async ({ page }) => {
  await mockApi(page, { loggedIn: true, submissions: [] });
  await page.goto(TASK_PATH);
  const row = page.getByRole('row', { name: /运行/ });
  await expect(row, '"运行" 一行应提示具体监听依据（如 PORT 环境变量），帮助选手确定 Dockerfile 该 EXPOSE 哪个端口').toContainText(/PORT/);
});

// findings-A #4：直接深链接访问一个不在题目列表里的 taskId，前端不做任何校验，照常渲染完整可交互表单。
test('直接访问不存在/未列出的题目 ID，应提示题目不存在，而不是照常渲染完整上传表单', async ({ page }) => {
  await mockApi(page, { loggedIn: true, submissions: [] }); // tasks 列表里不含 demo-todo-hidden
  await page.goto('/submit/demo-todo-hidden');
  await expect(
    page.getByText(/题目不存在|未开放|无法找到/),
    '访问未列出的题目 ID 时应提前提示"题目不存在"，而不是让用户打包、上传后才在提交时被 400 拒绝',
  ).toBeVisible();
});
