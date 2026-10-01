// Runner-side Playwright config. The pack under test does not ship its own
// config; this file is what keeps baseURL, timeouts, concurrency and failure
// artifacts identical for every submission and every channel.
module.exports = {
  testDir: process.env.PACK_TEST_DIR || '/work/pack',
  timeout: Number(process.env.TEST_TIMEOUT_MS || 60000),
  retries: 0,
  workers: Number(process.env.RUNNER_WORKERS || 2),
  reporter: [['json', { outputFile: '/results/report.json' }], ['line']],
  outputDir: '/results/output',
  use: {
    headless: true,
    baseURL: process.env.BASE_URL,
    screenshot: 'only-on-failure',
    // Explicit, not just relying on Playwright's default: never disable the
    // browser's own sandbox even though we also run as a non-root user
    // (run.sh) and restrict the mount to this task's own tests only.
    launchOptions: { chromiumSandbox: true },
  },
};
