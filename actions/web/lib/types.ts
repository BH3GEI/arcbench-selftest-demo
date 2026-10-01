export type SubmissionStatus = 'queued' | 'passed' | 'failed' | 'error';

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
  status: 'passed' | 'failed' | 'error';
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
