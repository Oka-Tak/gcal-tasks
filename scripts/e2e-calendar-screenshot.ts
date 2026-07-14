import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { loadEnvConfig } from "@next/env";
import { encode } from "@auth/core/jwt";

const BASE_URL = process.env.KAIROS_E2E_URL ?? "http://127.0.0.1:3000";
const CDP_PORT = 9222;
const CHROME = process.env.CHROME_BIN ?? "/usr/bin/google-chrome";
const SCREENSHOT_DIR = process.env.KAIROS_E2E_SCREENSHOT_DIR ?? "/tmp";

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

type CdpMessage = {
  id?: number;
  result?: unknown;
  error?: { message?: string };
  method?: string;
  params?: Record<string, unknown>;
};

async function waitForCdp(): Promise<string> {
  for (let i = 0; i < 50; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (response.ok) {
        const data = await response.json() as { webSocketDebuggerUrl?: string };
        if (data.webSocketDebuggerUrl) return data.webSocketDebuggerUrl;
      }
    } catch { /* Chrome is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Chrome DevTools endpoint did not start");
}

async function main() {
  loadEnvConfig(process.cwd());
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is required");
  const secureCookie = new URL(BASE_URL).protocol === "https:";
  const cookieName = secureCookie ? "__Secure-authjs.session-token" : "authjs.session-token";

  const token = await encode({
    token: { sub: "kairos-e2e", name: "Kairos E2E", email: "e2e@local" },
    secret,
    salt: cookieName,
    maxAge: 60 * 60,
  });

  const chrome = spawn(CHROME, [
    "--headless=new",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=/tmp/kairos-e2e-chrome-${process.pid}`,
    "about:blank",
  ], { stdio: "ignore" });

  let ws: WebSocket | null = null;
  try {
    ws = new WebSocket(await waitForCdp());
    await new Promise<void>((resolve, reject) => {
      ws!.addEventListener("open", () => resolve(), { once: true });
      ws!.addEventListener("error", () => reject(new Error("CDP websocket failed")), { once: true });
    });

    let id = 0;
    const pending = new Map<number, Pending>();
    const diagnostics: string[] = [];
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as CdpMessage;
      if (!message.id) {
        if (message.method === "Runtime.exceptionThrown") diagnostics.push(JSON.stringify(message.params));
        if (message.method === "Network.loadingFailed") diagnostics.push(JSON.stringify(message.params));
        if (message.method === "Log.entryAdded") diagnostics.push(JSON.stringify(message.params));
        return;
      }
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message ?? "CDP error"));
      else entry.resolve(message.result);
    });
    const call = <T>(method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
      new Promise<T>((resolve, reject) => {
        const callId = ++id;
        pending.set(callId, { resolve: resolve as (value: unknown) => void, reject });
        ws!.send(JSON.stringify({ id: callId, method, params, ...(sessionId ? { sessionId } : {}) }));
      });

    const { targetId } = await call<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await call<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    await call("Page.enable", {}, sessionId);
    await call("Network.enable", {}, sessionId);
    await call("Runtime.enable", {}, sessionId);
    await call("Log.enable", {}, sessionId);
    await call("Emulation.setDeviceMetricsOverride", {
      width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false,
    }, sessionId);
    await call("Network.setCookie", {
      name: cookieName,
      value: token,
      url: BASE_URL,
      path: "/",
      httpOnly: true,
      secure: secureCookie,
      sameSite: "Lax",
    }, sessionId);
    await call("Page.navigate", { url: BASE_URL }, sessionId);
    await new Promise((resolve) => setTimeout(resolve, 12_000));

    const evaluate = <T>(expression: string) => call<{ result: { value?: T } }>(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    ).then((result) => result.result.value);
    const body = await evaluate<string>("document.body.innerText");
    const hasViewButtons = await evaluate<boolean>(
      "['月','週','日'].every((label) => [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === label))",
    );
    if (!body || body.includes("Google アカウントに接続してください") || !hasViewButtons) {
      throw new Error(`authenticated calendar did not render; body=${JSON.stringify(body?.slice(0, 500))}; diagnostics=${diagnostics.slice(-10).join(" | ")}`);
    }

    const capture = async (name: string) => {
      const result = await call<{ data: string }>("Page.captureScreenshot", { format: "png", fromSurface: true }, sessionId);
      const output = `${SCREENSHOT_DIR}/kairos-${name}.png`;
      await fs.writeFile(output, Buffer.from(result.data, "base64"));
      console.log(output);
    };

    await evaluate("[...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === '月')?.click()");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await capture("month-e2e");
    await evaluate("[...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === '週')?.click()");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await capture("week-e2e");
  } finally {
    ws?.close();
    chrome.kill("SIGTERM");
  }
}

void main().catch((error) => {
  console.error(`[e2e] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
