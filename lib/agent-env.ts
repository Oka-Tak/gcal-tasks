const PASSTHROUGH_ENV = [
  "NODE_ENV",
  "HOME",
  "PATH",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "GH_CONFIG_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS",
] as const;

/**
 * Minimal environment for local CLI agents. Authentication directories and
 * normal process discovery remain available; Kairos/OAuth secrets do not.
 */
export function agentChildEnv(
  source: Record<string, string | undefined> = process.env,
  overrides: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const out: Record<string, string> = { NODE_ENV: source.NODE_ENV ?? "production" };
  for (const key of PASSTHROUGH_ENV) {
    const value = source[key];
    if (value !== undefined) out[key] = value;
  }
  return { ...out, ...overrides } as NodeJS.ProcessEnv;
}
