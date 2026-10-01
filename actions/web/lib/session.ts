import { getServerSession } from 'next-auth';
import { authOptions } from './auth';
import { config } from './config';

export type CurrentUser = {
  githubId: string;
  githubLogin: string;
  githubCreatedAt: string | null;
};

export async function getCurrentUser(): Promise<CurrentUser | null> {
  const session = await getServerSession(authOptions);
  const user = session?.user as
    | { githubId?: string; githubLogin?: string; githubCreatedAt?: string }
    | undefined;
  if (!user?.githubId) return null;
  return {
    githubId: user.githubId,
    githubLogin: user.githubLogin ?? 'unknown',
    githubCreatedAt: user.githubCreatedAt ?? null,
  };
}

export function accountAgeDays(createdAt: string | null): number | null {
  if (!createdAt) return null;
  const created = new Date(createdAt).getTime();
  if (Number.isNaN(created)) return null;
  return (Date.now() - created) / (1000 * 60 * 60 * 24);
}

export function accountTooNew(user: CurrentUser): boolean {
  if (config.minAccountAgeDays <= 0) return false;
  const age = accountAgeDays(user.githubCreatedAt);
  if (age === null) return false; // unknown age: fail open, not closed
  return age < config.minAccountAgeDays;
}
