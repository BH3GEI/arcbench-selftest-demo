import { defineConfig, devices } from '@playwright/test';

// 整站回归检查：全部针对线上自测站跑，不依赖本地 dev server，不提交真实 zip。
const BASE_URL = process.env.E2E_BASE_URL || 'https://arcbench-selftest-web.vercel.app';

export default defineConfig({
  testDir: '.',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  // 对线上站点跑、机器上常有其它并发任务抢网络，网络抖动重试一次再判定失败。
  retries: 1,
  workers: 3,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'report', open: 'never' }],
  ],
  outputDir: 'test-results',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
    // 用完整版 Chromium 跑 headless，不依赖另外单独下载的 chromium-headless-shell 包。
    channel: 'chromium',
  },
});
