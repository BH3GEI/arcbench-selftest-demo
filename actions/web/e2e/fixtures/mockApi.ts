import type { Page } from '@playwright/test';
import type { GradeResult, Submission } from '../../lib/types';

/**
 * 整站回归检查用的网络层 mock：不走真实 GitHub OAuth、不消耗真实配额、不触发真实评测。
 * 只拦截前端会发的几个 API，返回固定的模拟数据，驱动页面渲染出各种状态组合。
 */

export const MOCK_USER = {
  name: 'regress-bot',
  email: 'regress-bot@example.com',
  image: 'https://avatars.githubusercontent.com/u/1?v=4',
  githubId: '999001',
  githubLogin: 'regress-bot',
  githubCreatedAt: '2015-01-01T00:00:00Z',
};

export const MOCK_TASKS = [{ id: 'github-stage-1-req-test', displayName: 'GitHub 题 · 第一阶段' }];

function makeResult(over: Partial<GradeResult> = {}): GradeResult {
  return {
    submission_id: 'sub',
    task_id: 'github-stage-1-req-test',
    visibility: 'public',
    status: 'passed',
    passed: 0,
    total: 0,
    detail: '',
    tests: [],
    ...over,
  };
}

export function makeSubmission(over: Partial<Submission> = {}): Submission {
  const now = Date.now();
  return {
    id: 'sub-0000',
    githubId: MOCK_USER.githubId,
    githubLogin: MOCK_USER.githubLogin,
    taskId: 'github-stage-1-req-test',
    status: 'passed',
    createdAt: now,
    updatedAt: now,
    result: makeResult(),
    ...over,
  };
}

/** 全部通过：30/30。 */
export const SUB_PASSED = makeSubmission({
  id: 'sub-passed',
  status: 'passed',
  result: makeResult({
    status: 'passed',
    passed: 3,
    total: 3,
    detail: '',
    tests: [
      { title: 'REQ-1-1-1: 注册新账号', ok: true, error: null },
      { title: 'REQ-1-1-2: 登录', ok: true, error: null },
      { title: 'REQ-1-1-3: 创建组织', ok: true, error: null },
    ],
  }),
});

/** 部分通过，失败用例带报错文本 + 一张截图（用于验证截图链接可打开、无英文残留）。 */
export const SUB_FAILED = makeSubmission({
  id: 'sub-failed',
  status: 'failed',
  result: makeResult({
    status: 'failed',
    passed: 1,
    total: 3,
    // 真实评测机会把这种英文摘要塞进 detail；前端应该把它过滤掉，不直接展示。
    detail: '3/3 tests failed',
    tests: [
      { title: 'REQ-1-1-1: 注册新账号', ok: true, error: null },
      {
        title: 'REQ-1-1-2: 登录',
        ok: false,
        error: 'Test timeout of 60000ms exceeded.\nwaiting for locator("button[type=submit]")',
        screenshot: 'REQ-1-1-2-login/test-failed-1.png',
      },
      {
        title: 'REQ-1-1-3: 创建组织',
        ok: false,
        error: 'expect(locator).toBeVisible() failed',
        screenshot: 'REQ-1-1-3-org/test-failed-1.png',
      },
    ],
  }),
});

/** app 没能启动：0 条测试执行（not_run），不应该和“部分失败”共用同一个徽标文案。 */
export const SUB_NOT_RUN = makeSubmission({
  id: 'sub-not-run',
  status: 'error',
  result: makeResult({
    status: 'error',
    passed: 0,
    total: 0,
    detail: 'no Dockerfile at the root of the submitted app',
    tests: [],
  }),
});

/** 评测系统自己出错，不计次数。 */
export const SUB_SYSTEM_ERROR = makeSubmission({
  id: 'sub-system-error',
  status: 'system_error',
  result: makeResult({ status: 'system_error', passed: 0, total: 0, detail: 'could not start grading', tests: [] }),
});

/** 排队中：用于 Waiting 组件。 */
export const SUB_QUEUED = makeSubmission({
  id: 'sub-queued',
  status: 'queued',
  createdAt: Date.now() - 45_000,
  result: null,
});

/** 隐藏测试题：只显示通过数，不展示每条内容。 */
export const SUB_HIDDEN = makeSubmission({
  id: 'sub-hidden',
  status: 'failed',
  result: makeResult({ status: 'failed', passed: 2, total: 5, visibility: 'hidden', detail: '', tests: undefined }),
});

const SUBMISSION_BY_ID: Record<string, Submission> = {
  [SUB_PASSED.id]: SUB_PASSED,
  [SUB_FAILED.id]: SUB_FAILED,
  [SUB_NOT_RUN.id]: SUB_NOT_RUN,
  [SUB_SYSTEM_ERROR.id]: SUB_SYSTEM_ERROR,
  [SUB_QUEUED.id]: SUB_QUEUED,
  [SUB_HIDDEN.id]: SUB_HIDDEN,
};

// 1x1 透明 png，用来让截图 <img> 真的加载成功（而不是 404），验证链接本身可打开。
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

export type MockOpts = {
  /** 不传则视为未登录（/api/auth/session 返回空对象）。 */
  loggedIn?: boolean;
  tasks?: typeof MOCK_TASKS;
  submissions?: Submission[];
  quota?: { used: number; limit: number };
  /** 额外的按 id 返回的提交详情；默认已包含上面 SUB_* 全部样例。 */
  extraDetails?: Record<string, Submission>;
};

export async function mockApi(page: Page, opts: MockOpts = {}) {
  const { loggedIn = false, tasks = MOCK_TASKS, submissions = [], quota, extraDetails } = opts;
  const detailById = { ...SUBMISSION_BY_ID, ...extraDetails };

  await page.route('**/api/auth/session', async (route) => {
    if (!loggedIn) return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    const body = {
      user: { name: MOCK_USER.name, email: MOCK_USER.email, image: MOCK_USER.image },
      expires: new Date(Date.now() + 3600_000).toISOString(),
    };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });

  await page.route('**/api/tasks', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tasks }) });
  });

  await page.route('**/api/submissions', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const used = quota?.used ?? submissions.length;
    const limit = quota?.limit ?? 10;
    const body = { submissions, quota: { used, limit, remaining: Math.max(0, limit - used) } };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });

  await page.route('**/api/submissions/*', async (route) => {
    const url = new URL(route.request().url());
    const id = url.pathname.split('/').pop()!;
    const submission = detailById[id];
    if (!submission) {
      return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'not found' }) });
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ submission }) });
  });

  await page.route('**/api/submissions/*/screenshot*', async (route) => {
    await route.fulfill({ status: 200, contentType: 'image/png', body: PNG_1X1 });
  });
}
