/**
 * Central env access. Values are read lazily where possible so a missing secret
 * only fails the request that needs it, not the whole build.
 */
function list(v: string | undefined): string[] {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export const env = {
  // Google OAuth client (shared by Auth.js login and the connect-account flow).
  googleClientId: process.env.AUTH_GOOGLE_ID ?? "",
  googleClientSecret: process.env.AUTH_GOOGLE_SECRET ?? "",
  // Auth.js session secret.
  authSecret: process.env.AUTH_SECRET ?? "",
  // Public base URL (https behind the Cloudflare Tunnel; loopback in dev).
  baseUrl: (process.env.AUTH_URL ?? "http://localhost:3000").replace(/\/$/, ""),
  // Who may sign in (defence in depth behind Cloudflare Access). Empty = allow any.
  allowedEmails: list(process.env.ALLOWED_EMAILS),
  // Key material for encrypting Google tokens at rest (any string; hashed to 32B).
  encKey: process.env.KAIROS_ENC_KEY ?? "",
  // SQLite file. Other tools (Proxmox Claude Code) can read this directly.
  dbPath: process.env.KAIROS_DB ?? "./kairos.db",
};

export const GOOGLE_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/tasks",
];

export function isAllowed(email: string | null | undefined): boolean {
  if (!email) return false;
  if (env.allowedEmails.length === 0) return true;
  return env.allowedEmails.includes(email.toLowerCase());
}
