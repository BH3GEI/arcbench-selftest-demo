function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  graderRepoOwner: process.env.GRADER_REPO_OWNER || '',
  graderRepoName: process.env.GRADER_REPO_NAME || '',
  graderServiceToken: process.env.GRADER_SERVICE_TOKEN || '',
  signingKey: process.env.SELFTEST_DISPATCH_SIGNING_KEY || '',
  internalCheckKey: process.env.INTERNAL_CHECK_KEY || '',

  dailyLimitPerUser: int('SELFTEST_WEB_DAILY_LIMIT_PER_USER', 10),
  dailyLimitGlobal: int('SELFTEST_WEB_DAILY_LIMIT_GLOBAL', 200),
  maxZipMb: int('SELFTEST_WEB_MAX_ZIP_MB', 50),
  minAccountAgeDays: int('SELFTEST_WEB_MIN_ACCOUNT_AGE_DAYS', 7),
};

export function graderRepoConfigured(): boolean {
  return Boolean(config.graderRepoOwner && config.graderRepoName && config.graderServiceToken);
}
