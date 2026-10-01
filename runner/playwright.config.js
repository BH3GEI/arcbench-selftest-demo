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
    // Chromium's own sandbox needs unprivileged user namespaces, which
    // Ubuntu 23.10+ disables by default (AppArmor) — confirmed via a real
    // "FATAL: ... No usable sandbox!" failure on GitHub's ubuntu-latest,
    // and `--security-opt apparmor=unconfined` on the container did NOT
    // restore it (docs/parity.md, docs/security-review.md open item #3).
    // Falling back to Chromium's own suggested workaround; the container
    // itself still runs as a non-root user (run.sh), on an internal
    // (no-internet) network, with no-new-privileges — defense in depth
    // that doesn't depend on this one layer.
    launchOptions: { chromiumSandbox: false },
  },
};
