import fs from "node:fs/promises";
import { probeAgent, runAgent, runAgentAuto, type RunResult } from "./agent";
import { loadPriority } from "./agent-priority";

/**
 * 画像入力ジョブ（レシート取り込み・睡眠スクショ等）のフォールバック:
 *   1. claude（唯一Vision対応のCLI）が優先順位に居て健全なら Read で画像を直読み
 *   2. ダメなら ローカルOCR（PaddleOCR常駐 :9997、無料・外部送信なし）でテキスト化し、
 *      通常のフォールバック連鎖（codex/copilot/agy…）にテキストとして投げる
 * これで claude が limit でも写真取り込みが完全には死なない。
 * 詳細: docs/AGENT-FALLBACK.md
 */

const OCR_URL = process.env.KAIROS_OCR_URL ?? "http://127.0.0.1:9997";

/** ローカルOCR（mnemoの常駐PaddleOCR）。行テキストの配列を返す。 */
export async function localOcr(imageAbs: string): Promise<string[]> {
  const buf = await fs.readFile(imageAbs);
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 90_000);
  try {
    const r = await fetch(`${OCR_URL}/ocr`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Uint8Array(buf),
      signal: ctl.signal,
    });
    if (!r.ok) return [];
    const d = (await r.json()) as { lines?: { text?: string }[] };
    return (d.lines ?? []).map((l) => (l.text ?? "").trim()).filter(Boolean);
  } catch {
    return [];
  } finally {
    clearTimeout(t);
  }
}

export interface VisionResult extends RunResult {
  via: "claude-vision" | "local-ocr";
}

export async function runVisionAuto(opts: {
  visionPrompt: string; // claude が Read で画像を開く前提の文面
  ocrPrompt: (ocrText: string) => string; // OCRテキスト経路用の文面
  imageAbs: string;
  jobKind: string;
  timeoutMs?: number;
}): Promise<VisionResult> {
  // 1) claude vision（優先順位に含まれ、プローブが通る場合のみ）
  const cfg = loadPriority();
  const claudeStep = cfg.order.find((s) => s.agent === "claude");
  if (claudeStep && (!cfg.probe || (await probeAgent("claude")))) {
    const res = await runAgent(opts.visionPrompt, {
      agent: "claude",
      allowedTools: ["Read"],
      imagePaths: [opts.imageAbs],
      jobKind: opts.jobKind,
      timeoutMs: opts.timeoutMs,
    });
    if (res.ok) return { ...res, via: "claude-vision" };
    console.log(`[vision] claude vision 失敗 (${(res.error ?? "").slice(0, 100)}) — ローカルOCRへ`);
  } else {
    console.log(`[vision] claude ${claudeStep ? "プローブ不通" : "優先順位に無し"} — ローカルOCRへ (${opts.jobKind})`);
  }

  // 2) ローカルOCR → テキストで通常フォールバック連鎖
  const lines = await localOcr(opts.imageAbs);
  if (lines.length === 0) {
    return {
      ok: false,
      text: "",
      error: "claude vision もローカルOCRも読めませんでした（owui-ocr.service を確認）",
      jobId: "",
      via: "local-ocr",
    };
  }
  const res = await runAgentAuto(opts.ocrPrompt(lines.join("\n").slice(0, 12_000)), {
    jobKind: `${opts.jobKind}-ocr`,
    timeoutMs: opts.timeoutMs,
  });
  return { ...res, via: "local-ocr" };
}
