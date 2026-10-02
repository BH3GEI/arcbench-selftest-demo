import { timingSafeEqual } from 'node:crypto';
import { config } from './config';

// Identity used for the scheduled synthetic check's own submissions, so
// they never collide with (or get mistaken for) a real participant's
// history. See app/api/internal/* and README_ACTIONS.md "Internal
// synthetic check" for the full security boundary.
export const INTERNAL_CHECK_GITHUB_ID = 'internal-selftest-checker';

export function verifyInternalKey(req: Request): boolean {
  const expected = config.internalCheckKey;
  if (!expected) return false; // unset: internal endpoints stay closed
  const got = req.headers.get('x-internal-key') || '';
  if (!got) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
