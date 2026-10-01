// system_error = the grading platform failed (not the participant's app);
// it never counts against the daily quota.
export type SubmissionStatus = 'queued' | 'passed' | 'failed' | 'error' | 'system_error';

export type TestCaseResult = {
  title: string;
  ok: boolean;
  error: string | null;
};

// Shape delivered by the grader's scripts/report_back.py callback — kept in
// sync with actions/template/scripts/parse_report.py's result.json.
export type GradeResult = {
  submission_id: string;
  task_id: string;
  visibility: 'public' | 'hidden';
  // 'rejected' only comes from a dispatch the grader couldn't authenticate;
  // store.ts normalizes it (and 'error') to system_error on the way in.
  status: 'passed' | 'failed' | 'error' | 'system_error' | 'rejected';
  passed: number;
  total: number;
  detail: string;
  tests?: TestCaseResult[];
};

export type Submission = {
  id: string;
  githubId: string;
  githubLogin: string;
  taskId: string;
  status: SubmissionStatus;
  createdAt: number;
  updatedAt: number;
  result: GradeResult | null;
};
