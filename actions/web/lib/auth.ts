import type { NextAuthOptions } from 'next-auth';
import GitHubProvider from 'next-auth/providers/github';

// Deliberately minimal: we only need the participant's GitHub identity
// (id, login, avatar) and account-creation date (for the account-age abuse
// check) — never the GitHub access token itself, so it's never put in the
// session and never reaches the browser. No extra OAuth scopes requested
// beyond the provider default (read:user).
export const authOptions: NextAuthOptions = {
  providers: [
    GitHubProvider({
      clientId: process.env.GITHUB_OAUTH_CLIENT_ID || '',
      clientSecret: process.env.GITHUB_OAUTH_CLIENT_SECRET || '',
      profile(profile) {
        return {
          id: String(profile.id),
          name: profile.login,
          email: profile.email ?? undefined,
          image: profile.avatar_url,
          githubCreatedAt: profile.created_at as string,
        };
      },
    }),
  ],
  session: { strategy: 'jwt' },
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.githubId = user.id;
        token.githubLogin = user.name ?? undefined;
        token.githubCreatedAt = (user as { githubCreatedAt?: string }).githubCreatedAt;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        (session.user as { githubId?: string }).githubId = token.githubId as string;
        (session.user as { githubLogin?: string }).githubLogin = token.githubLogin as string;
        (session.user as { githubCreatedAt?: string }).githubCreatedAt = token.githubCreatedAt as string;
      }
      return session;
    },
  },
};
