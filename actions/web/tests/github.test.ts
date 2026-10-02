import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { dispatchGrade, findGradeRun, hasRecentGradeRun } from '../lib/github';

const basePayload = {
  submissionId: 'sub-1',
  taskId: 'demo-todo',
  downloadUrl: 'https://blob.test/sub-1.zip',
  callbackUrl: 'https://web.test/api/callback',
  timestamp: 1700000000,
  signature: 'deadbeef',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('dispatchGrade — scenario: the GitHub dispatch call fails', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('succeeds without retrying when the first response is 204', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(dispatchGrade(basePayload)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries exactly once after a non-204 response and succeeds on the retry', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('server hiccup', { status: 502 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(dispatchGrade(basePayload)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('treats a thrown network error as a failed attempt and still retries', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(dispatchGrade(basePayload)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after two failed attempts and throws with the failure reason', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('forbidden', { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(dispatchGrade(basePayload)).rejects.toThrow(/403/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('hasRecentGradeRun — presence check used by the watchdog', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('reports a run as present when the Actions API lists one', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ workflow_runs: [{ id: 1 }] }), { status: 200 })),
    );
    await expect(hasRecentGradeRun(Date.now())).resolves.toBe(true);
  });

  it('reports no run when the Actions API lists none — the bug this guards against', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ workflow_runs: [] }), { status: 200 })));
    await expect(hasRecentGradeRun(Date.now())).resolves.toBe(false);
  });

  it('fails open (reports present) when the Actions API itself errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    await expect(hasRecentGradeRun(Date.now())).resolves.toBe(true);
  });

  it('fails open on a non-ok HTTP response too', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })));
    await expect(hasRecentGradeRun(Date.now())).resolves.toBe(true);
  });
});

describe('run matching by run-name (grade.yml: run-name: Grade <submission_id>)', () => {
  const runs = (titles: string[]) =>
    new Response(
      JSON.stringify({
        workflow_runs: titles.map((t, i) => ({
          id: i + 1,
          display_title: t,
          status: 'completed',
          conclusion: 'failure',
          updated_at: '2026-10-02T03:30:00Z',
        })),
      }),
      { status: 200 },
    );

  it('only counts a run titled with this submission once run-names are in use', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(runs(['Grade other-submission-1'])));
    await expect(hasRecentGradeRun(Date.now(), 'sub-1234-abcd')).resolves.toBe(false);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(runs(['Grade other-submission-1', 'Grade sub-1234-abcd'])));
    await expect(hasRecentGradeRun(Date.now(), 'sub-1234-abcd')).resolves.toBe(true);
  });

  it('falls back to "any run" against a grader workflow without run-names', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(runs(['grade-submission'])));
    await expect(hasRecentGradeRun(Date.now(), 'sub-1234-abcd')).resolves.toBe(true);
  });

  it('findGradeRun returns the matching run, null when untitled, undefined on API error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(runs(['Grade sub-1234-abcd'])));
    await expect(findGradeRun('sub-1234-abcd', Date.now())).resolves.toMatchObject({ id: 1, status: 'completed' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(runs(['grade-submission'])));
    await expect(findGradeRun('sub-1234-abcd', Date.now())).resolves.toBeNull();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
    await expect(findGradeRun('sub-1234-abcd', Date.now())).resolves.toBeUndefined();
  });
});
