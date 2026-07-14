import { type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { importGakujoAssignments, importGakujoStructured } from "@/lib/gakujo-import";
import { secretMatches } from "@/lib/secret-compare";

export const runtime = "nodejs";

/**
 * gakujo(学務情報システム)の課題一覧をブックマークレットから受け取り、Kairos
 * タスク化する。ブラウザのgakujoオリジンからのクロスオリジンPOSTなので CORS
 * を許可し、認証は KAIROS_WIDGET_TOKEN（秘密）で行う（クッキー認証は使えない）。
 */

const ALLOW_ORIGIN = "https://gakujo.shizuoka.ac.jp";

function cors(origin: string | null): Record<string, string> {
  // gakujo オリジンだけ許可。それ以外は既定を返す（実質ブロック）。
  const o = origin === ALLOW_ORIGIN ? origin : ALLOW_ORIGIN;
  return {
    "Access-Control-Allow-Origin": o,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export function OPTIONS(req: NextRequest) {
  return new Response(null, { status: 204, headers: cors(req.headers.get("origin")) });
}

export async function POST(req: NextRequest) {
  const headers = { ...cors(req.headers.get("origin")), "Content-Type": "application/json" };
  let body: { token?: string; text?: string; assignments?: unknown[] };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ detail: "invalid json" }), { status: 400, headers });
  }
  if (!secretMatches(body.token ?? "", env.widgetToken))
    return new Response(JSON.stringify({ detail: "unauthorized" }), { status: 401, headers });

  // 構造化データ（ユーザースクリプトの決定論パース）優先。無ければテキストをAI抽出。
  const result = Array.isArray(body.assignments)
    ? await importGakujoStructured(body.assignments as never)
    : await importGakujoAssignments(String(body.text ?? ""));
  return new Response(JSON.stringify(result), { status: result.ok ? 200 : 422, headers });
}
