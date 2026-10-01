import type { DefaultSession } from 'next-auth';

declare module 'next-auth' {
  interface Session {
    user?: DefaultSession['user'] & {
      githubId?: string;
      githubLogin?: string;
      githubCreatedAt?: string;
    };
  }

  interface User {
    githubCreatedAt?: string;
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    githubId?: string;
    githubLogin?: string;
    githubCreatedAt?: string;
  }
}
