import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { env, GOOGLE_SCOPES, isAllowed } from "@/lib/env";
import { upsertAccountFromOAuth } from "@/lib/accounts";

/**
 * Auth.js handles the app login/session (who may use Kairos), gated by
 * ALLOWED_EMAILS as the application-level gate behind the tailnet boundary. The Google
 * data-source tokens are stored in our own `accounts` table (see lib/accounts),
 * seeded here from the login grant — additional accounts attach via
 * /api/connect/google.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  secret: env.authSecret,
  session: { strategy: "jwt" },
  providers: [
    Google({
      clientId: env.googleClientId,
      clientSecret: env.googleClientSecret,
      authorization: {
        params: {
          scope: GOOGLE_SCOPES.join(" "),
          access_type: "offline",
          prompt: "consent", // ensure a refresh_token is issued
        },
      },
    }),
  ],
  callbacks: {
    signIn({ profile }) {
      return isAllowed(profile?.email);
    },
    jwt({ token, account, profile }) {
      // On initial sign-in, persist this Google account as a data source.
      if (account && profile?.email) {
        upsertAccountFromOAuth({
          email: profile.email,
          name: (profile.name as string | undefined) ?? null,
          picture: (profile.picture as string | undefined) ?? null,
          accessToken: account.access_token ?? null,
          refreshToken: account.refresh_token ?? null,
          expiresAt: account.expires_at ?? null,
          scope: account.scope ?? null,
        });
        token.email = profile.email;
      }
      return token;
    },
    session({ session, token }) {
      if (token.email && session.user) session.user.email = token.email;
      return session;
    },
  },
});
