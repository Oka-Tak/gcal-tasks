import assert from "node:assert/strict";
import test from "node:test";
import { agentChildEnv } from "../lib/agent-env";

test("agentChildEnv keeps CLI directories but strips application secrets", () => {
  const child = agentChildEnv({
    HOME: "/home/kairos",
    PATH: "/usr/bin",
    CODEX_HOME: "/home/kairos/.codex",
    AUTH_SECRET: "do-not-pass",
    KAIROS_ENC_KEY: "do-not-pass",
    AUTH_GOOGLE_SECRET: "do-not-pass",
  }, { CLAUDE_CONFIG_DIR: "/home/kairos/.claude-b" });

  assert.equal(child.HOME, "/home/kairos");
  assert.equal(child.PATH, "/usr/bin");
  assert.equal(child.CODEX_HOME, "/home/kairos/.codex");
  assert.equal(child.CLAUDE_CONFIG_DIR, "/home/kairos/.claude-b");
  assert.equal(child.AUTH_SECRET, undefined);
  assert.equal(child.KAIROS_ENC_KEY, undefined);
  assert.equal(child.AUTH_GOOGLE_SECRET, undefined);
});
