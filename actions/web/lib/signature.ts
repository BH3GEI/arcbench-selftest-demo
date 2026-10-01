import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config';

// Mirrors actions/template/scripts/verify_signature.py in the grader repo:
// signed string is "{submission_id}.{task_id}.{timestamp}", HMAC-SHA256 hex
// digest with the shared SELFTEST_DISPATCH_SIGNING_KEY. Used to sign
// outbound dispatches (this app -> grader repo).
export function signDispatch(submissionId: string, taskId: string, timestamp: number): string {
  const message = `${submissionId}.${taskId}.${timestamp}`;
  return createHmac('sha256', config.signingKey).update(message).digest('hex');
}

// Mirrors scripts/report_back.py in the grader repo: the result callback
// signs "{timestamp}.{nonce}.{sha256(body)}" (not the raw body alone) so a
// captured-and-resent POST can't be replayed, and carries the three pieces
// in X-Timestamp/X-Nonce/X-Signature. The timestamp freshness check is done
// here; nonce replay dedup is the caller's job (see claimCallbackNonce).
const CALLBACK_MAX_AGE_S = 300;

export function verifyCallbackSignature(
  rawBody: string,
  timestamp: string | null,
  nonce: string | null,
  headerSignature: string | null,
): boolean {
  if (!config.signingKey) return true; // signing disabled (local/dev only)
  if (!headerSignature || !timestamp || !nonce) return false;
  const ts = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > CALLBACK_MAX_AGE_S) return false;
  const bodyHash = createHash('sha256').update(rawBody).digest('hex');
  const message = `${timestamp}.${nonce}.${bodyHash}`;
  const expected = createHmac('sha256', config.signingKey).update(message).digest('hex');
  const got = headerSignature.replace(/^sha256=/, '').trim().toLowerCase();
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(got, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
