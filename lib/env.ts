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
  // Local data dir for uploads (screenshots) etc. Kept out of git and off the web.
  dataDir: process.env.KAIROS_DATA ?? "./data",
  // ntfy push notifications (optional; unset = notifications off).
  ntfyUrl: (process.env.KAIROS_NTFY_URL ?? "").replace(/\/$/, ""), // e.g. https://ntfy.sh or self-hosted
  ntfyTopic: process.env.KAIROS_NTFY_TOPIC ?? "", // treat as a secret (anyone who knows it can read/send)
  ntfyToken: process.env.KAIROS_NTFY_TOKEN ?? "", // access token for a protected self-hosted server
  // Home-screen widgets (Scriptable/KWGT) can't do the OAuth cookie dance —
  // they authenticate with this bearer-ish token instead. Secret (like ntfyTopic).
  widgetToken: process.env.KAIROS_WIDGET_TOKEN ?? "",
  // Local CLI agents (must be on PATH or given as absolute paths).
  claudeBin: process.env.KAIROS_CLAUDE_BIN ?? "claude",
  codexBin: process.env.KAIROS_CODEX_BIN ?? "codex",
  copilotBin: process.env.KAIROS_COPILOT_BIN ?? "copilot",
  agyBin: process.env.KAIROS_AGY_BIN ?? "agy",
  // Default model alias for claude calls (vision-capable). Override per call.
  claudeModel: process.env.KAIROS_CLAUDE_MODEL ?? "sonnet",
  // Local transcription (whisperX on CPU). Absolute path recommended: the
  // systemd user unit may not have ~/.local/bin on PATH.
  // Open WebUI (the :443 chat) — notes get indexed into its Knowledge there.
  owuiUrl: (process.env.KAIROS_OWUI_URL ?? "http://127.0.0.1:3300").replace(/\/$/, ""),
  whisperxBin: process.env.KAIROS_WHISPERX_BIN ?? "whisperx",
  whisperxModel: process.env.KAIROS_WHISPERX_MODEL ?? "small",
  transcribeTimeoutMs: Number(process.env.KAIROS_TRANSCRIBE_TIMEOUT_MS ?? 3_600_000),
  // Hard ceiling for a single agent invocation.
  agentTimeoutMs: Number(process.env.KAIROS_AGENT_TIMEOUT_MS ?? 180000),
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
