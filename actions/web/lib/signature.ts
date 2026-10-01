import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config';

// Mirrors actions/template/scripts/verify_signature.py in the grader repo:
// signed string is "{submission_id}.{task_id}.{timestamp}", HMAC-SHA256 hex
// digest with the shared SELFTEST_DISPATCH_SIGNING_KEY. Used both to sign
// outbound dispatches (this app -> grader repo) and to verify inbound
// result callbacks (grader repo -> this app's /api/callback).
export function signDispatch(submissionId: string, taskId: string, timestamp: number): string {
  const message = `${submissionId}.${taskId}.${timestamp}`;
  return createHmac('sha256', config.signingKey).update(message).digest('hex');
}

export function verifyCallbackSignature(rawBody: string, headerSignature: string | null): boolean {
  if (!config.signingKey) return true; // signing disabled (local/dev only)
  if (!headerSignature) return false;
  const expected = createHmac('sha256', config.signingKey).update(rawBody).digest('hex');
  const got = headerSignature.replace(/^sha256=/, '').trim().toLowerCase();
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(got, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
