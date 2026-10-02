import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Submission } from '../lib/types';
import * as fakeBlob from './fakeBlob';

// Shared fakes must be created with vi.hoisted — vi.mock factories run
// before this file's own top-level statements.
const githubMocks = vi.hoisted(() => ({
  dispatchGrade: vi.fn(),
  fetchGraderResult: vi.fn(),
  fetchGraderScreenshots: vi.fn(),
  hasRecentGradeRun: vi.fn(),
  findGradeRun: vi.fn(),
  gradeRunNeverStarted: vi.fn(),
  listTaskIds: vi.fn(),
  taskExists: vi.fn(),
}));

vi.mock('@vercel/blob', async () => await import('./fakeBlob'));
vi.mock('../lib/github', () => githubMocks);

const { createSubmission, getSubmission, reconcileQueued } = await import('../lib/store');

fakeBlob.installFakeBlobFetch();

function makeSubmission(overrides: Partial<Submission>): Submission {
  return {
    id: 'sub-id',
    githubId: 'gh-1',
    githubLogin: 'alice',
    taskId: 'demo-todo',
    createdAt: Date.now(),
    status: 'queued',
    updatedAt: Date.now(),
    result: null,
    ...overrides,
  };
}

const EXTRA = { downloadUrl: 'https://blob.test/app.zip', callbackUrl: 'https://web.test/api/callback' };

beforeEach(() => {
  fakeBlob.resetFakeBlobStore();
  githubMocks.dispatchGrade.mockReset().mockResolvedValue(undefined);
  githubMocks.fetchGraderResult.mockReset().mockResolvedValue(null);
  githubMocks.fetchGraderScreenshots.mockReset().mockResolvedValue(new Map());
  githubMocks.hasRecentGradeRun.mockReset().mockResolvedValue(true);
  githubMocks.findGradeRun.mockReset().mockResolvedValue(null);
  githubMocks.gradeRunNeverStarted.mockReset().mockResolvedValue(false);
});

describe('scenario: the grade-workflow run never appears on GitHub (dispatch "succeeded" but nothing was triggered)', () => {
  it('redispatches exactly once and leaves the submission queued', async () => {
    const createdAt = Date.now() - 4 * 60 * 1000; // past the 3-minute run-check threshold
    await createSubmission(makeSubmission({ id: 'run-missing-1', createdAt }), EXTRA);
    githubMocks.hasRecentGradeRun.mockResolvedValue(false);

    const first = await getSubmission('run-missing-1');
    expect(first?.status).toBe('queued');
    expect(githubMocks.dispatchGrade).toHaveBeenCalledTimes(1);

    const second = await getSubmission('run-missing-1');
    expect(second?.status).toBe('queued');
    // Already redispatched once for this submission — must not redispatch again.
    expect(githubMocks.dispatchGrade).toHaveBeenCalledTimes(1);
    expect(githubMocks.hasRecentGradeRun).toHaveBeenCalledTimes(1);
  });

  it('marks system_error immediately (not after a further 30-minute wait) when the redispatch call itself fails', async () => {
    const createdAt = Date.now() - 4 * 60 * 1000;
    const quotaMarker = 'state/quota/user-gh-1/marker-a.json';
    await fakeBlob.put(quotaMarker, '1');
    await createSubmission(makeSubmission({ id: 'run-missing-2', createdAt }), EXTRA, [quotaMarker]);
    githubMocks.hasRecentGradeRun.mockResolvedValue(false);
    githubMocks.dispatchGrade.mockRejectedValue(new Error('GitHub API 500: internal error'));

    const sub = await getSubmission('run-missing-2');
    expect(sub?.status).toBe('system_error');
    expect(sub?.result?.detail).toMatch(/could not restart grading/);
    expect(fakeBlob.blobs.has(quotaMarker)).toBe(false); // quota refunded
  });

  it('does not redispatch a submission that still has not reached the check threshold', async () => {
    const createdAt = Date.now() - 60 * 1000; // only 1 minute old
    await createSubmission(makeSubmission({ id: 'too-young', createdAt }), EXTRA);
    githubMocks.hasRecentGradeRun.mockResolvedValue(false);

    const sub = await getSubmission('too-young');
    expect(sub?.status).toBe('queued');
    expect(githubMocks.dispatchGrade).not.toHaveBeenCalled();
    expect(githubMocks.hasRecentGradeRun).not.toHaveBeenCalled();
  });
});

describe('scenario: the grader result callback never arrives', () => {
  it('recovers the result from the grade job\'s own artifact after the recovery threshold', async () => {
    const createdAt = Date.now() - 9 * 60 * 1000; // past the 8-minute recovery threshold
    await createSubmission(makeSubmission({ id: 'callback-missing-1', createdAt }), EXTRA);
    githubMocks.hasRecentGradeRun.mockResolvedValue(true); // run exists — callback is just missing
    githubMocks.fetchGraderResult.mockResolvedValue({
      submission_id: 'callback-missing-1',
      task_id: 'demo-todo',
      visibility: 'public',
      status: 'passed',
      passed: 3,
      total: 3,
      detail: 'recovered from artifact',
    });

    const sub = await getSubmission('callback-missing-1');
    expect(sub?.status).toBe('passed');
    expect(sub?.result?.detail).toBe('recovered from artifact');
  });

  it('leaves the submission queued when no artifact is available yet either', async () => {
    const createdAt = Date.now() - 9 * 60 * 1000;
    await createSubmission(makeSubmission({ id: 'callback-missing-2', createdAt }), EXTRA);
    githubMocks.hasRecentGradeRun.mockResolvedValue(true);
    githubMocks.fetchGraderResult.mockResolvedValue(null);

    const sub = await getSubmission('callback-missing-2');
    expect(sub?.status).toBe('queued');
  });
});

describe('scenario: nothing ever arrives — 30-minute timeout', () => {
  it('marks system_error and refunds the quota markers', async () => {
    const createdAt = Date.now() - 31 * 60 * 1000;
    const quotaMarker = 'state/quota/user-gh-1/marker-b.json';
    await fakeBlob.put(quotaMarker, '1');
    await createSubmission(makeSubmission({ id: 'timeout-1', createdAt }), EXTRA, [quotaMarker]);
    githubMocks.hasRecentGradeRun.mockResolvedValue(true);
    githubMocks.fetchGraderResult.mockResolvedValue(null);

    const sub = await getSubmission('timeout-1');
    expect(sub?.status).toBe('system_error');
    expect(sub?.result?.detail).toMatch(/评测超时/);
    expect(fakeBlob.blobs.has(quotaMarker)).toBe(false);
  });

  it('a late real result still wins over an already-recorded timeout', async () => {
    const createdAt = Date.now() - 31 * 60 * 1000;
    await createSubmission(makeSubmission({ id: 'timeout-2', createdAt }), EXTRA);
    githubMocks.hasRecentGradeRun.mockResolvedValue(true);
    githubMocks.fetchGraderResult.mockResolvedValue(null);
    const timedOut = await getSubmission('timeout-2');
    expect(timedOut?.status).toBe('system_error');

    const { recordResult } = await import('../lib/store');
    await recordResult('timeout-2', {
      submission_id: 'timeout-2',
      task_id: 'demo-todo',
      visibility: 'public',
      status: 'passed',
      passed: 1,
      total: 1,
      detail: 'arrived late',
    });

    const after = await getSubmission('timeout-2');
    expect(after?.status).toBe('passed');
  });
});

describe('reconcileQueued — the cron entry point', () => {
  it('sweeps every queued submission without needing a participant to poll', async () => {
    const createdAt = Date.now() - 4 * 60 * 1000;
    await createSubmission(makeSubmission({ id: 'sweep-a', createdAt }), EXTRA);
    await createSubmission(makeSubmission({ id: 'sweep-b', createdAt }), EXTRA);
    githubMocks.hasRecentGradeRun.mockResolvedValue(true);

    const summary = await reconcileQueued();
    expect(summary.checked).toBe(2);
    expect(summary.stillQueued).toBe(2);
  });
});

describe('scenario: the submission\'s own run (matched by run-name) finished but no result arrived', () => {
  it('marks system_error within minutes, refunds quota, when GitHub never started the run (e.g. out of Actions minutes)', async () => {
    const createdAt = Date.now() - 2 * 60 * 1000;
    const quotaMarker = 'state/quota/user-gh-1/marker-ended.json';
    await fakeBlob.put(quotaMarker, '1');
    await createSubmission(makeSubmission({ id: 'run-ended-1', createdAt }), EXTRA, [quotaMarker]);
    githubMocks.findGradeRun.mockResolvedValue({
      id: 42,
      status: 'completed',
      conclusion: 'failure',
      updatedAt: Date.now() - 90 * 1000,
    });
    githubMocks.gradeRunNeverStarted.mockResolvedValue(true);

    const sub = await getSubmission('run-ended-1');
    expect(sub?.status).toBe('system_error');
    expect(sub?.result?.detail).toMatch(/never started on GitHub Actions/);
    expect(fakeBlob.blobs.has(quotaMarker)).toBe(false);
    expect(githubMocks.dispatchGrade).not.toHaveBeenCalled();
  });

  it('recovers the real result from the artifact instead, when the run produced one', async () => {
    const createdAt = Date.now() - 2 * 60 * 1000;
    await createSubmission(makeSubmission({ id: 'run-ended-2', createdAt }), EXTRA);
    githubMocks.findGradeRun.mockResolvedValue({
      id: 43,
      status: 'completed',
      conclusion: 'success',
      updatedAt: Date.now() - 90 * 1000,
    });
    githubMocks.fetchGraderResult.mockResolvedValue({
      submission_id: 'run-ended-2',
      task_id: 'demo-todo',
      visibility: 'public',
      status: 'passed',
      passed: 5,
      total: 5,
      detail: '',
    });

    const sub = await getSubmission('run-ended-2');
    expect(sub?.status).toBe('passed');
  });

  it('keeps waiting while the run is still in progress or only just finished', async () => {
    const createdAt = Date.now() - 2 * 60 * 1000;
    await createSubmission(makeSubmission({ id: 'run-ended-3', createdAt }), EXTRA);
    githubMocks.findGradeRun.mockResolvedValue({
      id: 44,
      status: 'completed',
      conclusion: 'success',
      updatedAt: Date.now() - 5 * 1000, // callback may still be in flight
    });

    const sub = await getSubmission('run-ended-3');
    expect(sub?.status).toBe('queued');
  });
});
