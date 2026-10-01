// Display names and listing visibility for tasks in the grader repo's
// tasks/ directory. Tasks not listed here default to listed (shown with
// their raw id) — add an entry only to rename or hide one.

const DISPLAY_NAMES: Record<string, string> = {
  'github-stage-1': 'GitHub 题 · 第一阶段',
};

const UNLISTED_TASK_IDS = new Set<string>(['demo-todo']);

export function isTaskListed(taskId: string): boolean {
  return !UNLISTED_TASK_IDS.has(taskId);
}

export function taskDisplayName(taskId: string): string {
  return DISPLAY_NAMES[taskId] || taskId;
}
