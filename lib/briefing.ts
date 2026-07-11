import fs from "node:fs/promises";
import path from "node:path";
import { and, asc, eq, gte, isNull, lt, lte } from "drizzle-orm";
import { db } from "./db";
import { events, logs, tasks } from "./db/schema";
import { env } from "./env";
import { pushEnabled, sendPush } from "./notify";
import { runAgentAuto } from "./agent";
import { yesterdaySpendLine } from "./money";

/**
 * 朝ブリーフィング: 毎朝 BRIEFING_HOUR に ntfy へ「今日の予定 / 近い締切 /
 * 昨晩の睡眠と昨日の実績 / AIの一言段取り」を1通で配信する。
 * 最終送信日を data ディレクトリのファイルで永続化するので、プロセス再起動を
 * またいでも1日1回に収まる（起動が7時台なら追い送信される）。
 */

const BRIEFING_HOUR = 7; // 07:00 台の最初の deadline tick (60s) で送る
const STAMP_FILE = () => path.join(path.resolve(env.dataDir), ".briefing-last");

const pad = (n: number) => String(n).padStart(2, "0");
const hm = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function todayEvents(now: Date): string[] {
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayEnd = dayStart + 86_400_000;
  const rows = db
    .select()
    .from(events)
    .where(and(lt(events.startMs, dayEnd), gte(events.endMs, dayStart)))
    .orderBy(asc(events.startMs))
    .all()
    .filter((e) => e.status !== "cancelled");
  return rows.slice(0, 10).map((e) =>
    e.allDay ? `・終日 ${e.summary ?? "(無題)"}` : `・${hm(e.startMs ?? 0)}-${hm(e.endMs ?? 0)} ${e.summary ?? "(無題)"}`,
  );
}

function dueTasks(now: Date): string[] {
  const horizon = ymd(new Date(now.getTime() + 3 * 86_400_000));
  const today = ymd(now);
  const rows = db
    .select()
    .from(tasks)
    .where(and(isNull(tasks.deletedAt), eq(tasks.status, "needsAction")))
    .all()
    .filter((t) => {
      const due = t.due?.slice(0, 10);
      return !!due && due >= today && due <= horizon;
    })
    .sort((a, b) => (a.due ?? "").localeCompare(b.due ?? ""));
  return rows.slice(0, 8).map((t) => {
    const due = t.due?.slice(5, 10)?.replace("-", "/");
    const est = t.estimatedMin != null ? ` (${t.estimatedMin}分)` : "";
    return `・${due}${t.dueTime ? ` ${t.dueTime.slice(0, 5)}` : ""}締切 ${t.title ?? "タスク"}${est}`;
  });
}

function yesterdayRecap(now: Date): string[] {
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yStart = dayStart - 86_400_000;
  const rows = db
    .select()
    .from(logs)
    .where(and(isNull(logs.deletedAt), gte(logs.endMs, yStart), lte(logs.startMs, dayStart + 12 * 3_600_000)))
    .all();
  const out: string[] = [];
  // 昨晩の睡眠 = 今日にかけて終わった sleep ログの最長のもの
  const sleeps = rows
    .filter((l) => l.kind === "sleep" && (l.endMs ?? 0) > dayStart - 6 * 3_600_000)
    .sort((a, b) => ((b.endMs ?? 0) - (b.startMs ?? 0)) - ((a.endMs ?? 0) - (a.startMs ?? 0)));
  if (sleeps[0]?.startMs && sleeps[0].endMs) {
    const min = Math.round((sleeps[0].endMs - sleeps[0].startMs) / 60_000);
    out.push(`・睡眠 ${Math.floor(min / 60)}h${pad(min % 60)}m（${hm(sleeps[0].startMs)}→${hm(sleeps[0].endMs)}）`);
  }
  // 昨日の実績合計 (kind別 分数)
  const spent = new Map<string, number>();
  for (const l of rows) {
    if (l.kind === "sleep" || !l.startMs || !l.endMs) continue;
    if (l.endMs <= yStart || l.startMs >= dayStart) continue;
    const overlap = Math.min(l.endMs, dayStart) - Math.max(l.startMs, yStart);
    if (overlap > 0) spent.set(l.kind, (spent.get(l.kind) ?? 0) + Math.round(overlap / 60_000));
  }
  const KIND_JP: Record<string, string> = {
    work: "作業", activity: "活動", meal: "食事", trip: "旅行",
    move: "移動", chore: "家事", dopa: "ドパガキ", r18: "R18", note: "メモ",
  };
  const parts = [...spent.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([k, m]) => `${KIND_JP[k] ?? k} ${m >= 60 ? `${Math.floor(m / 60)}h${pad(m % 60)}m` : `${m}m`}`);
  if (parts.length) out.push(`・昨日の実績: ${parts.join(" / ")}`);
  const spend = yesterdaySpendLine(now);
  if (spend) out.push(spend);
  return out;
}

/** haiku low で一言段取り。失敗したら黙って省く（ブリーフィング自体は届ける）。 */
async function aiOneliner(evLines: string[], taskLines: string[], recap: string[]): Promise<string | null> {
  try {
    const res = await runAgentAuto(
      [
        "あなたは予定アシスタント。以下を見て、今日の段取りアドバイスを日本語で1〜2文だけ出力。",
        "挨拶・前置き・箇条書きは不要。過剰な励ましも不要。具体的に。",
        "# 今日の予定", ...evLines,
        "# 近い締切", ...taskLines,
        "# 昨日", ...recap,
      ].join("\n"),
      { model: "haiku", effort: "low", jobKind: "briefing", timeoutMs: 90_000 },
    );
    const t = res.ok ? res.text.trim() : "";
    return t && t.length < 300 ? t : null;
  } catch {
    return null;
  }
}

/** Called from the 60s deadline tick. Sends at most once per day. `force` = manual test. */
export async function checkMorningBriefing(force = false): Promise<boolean> {
  if (!pushEnabled()) return false;
  const now = new Date();
  if (!force) {
    if (now.getHours() !== BRIEFING_HOUR) return false;
    const today = ymd(now);
    try {
      if ((await fs.readFile(STAMP_FILE(), "utf8")).trim() === today) return false;
    } catch { /* first run */ }
    await fs.writeFile(STAMP_FILE(), today); // stamp first — a crash must not spam
  }

  const evLines = todayEvents(now);
  const taskLines = dueTasks(now);
  const recap = yesterdayRecap(now);
  const ai = await aiOneliner(evLines, taskLines, recap);

  const body = [
    evLines.length ? "📅 今日の予定" : "📅 今日の予定はありません",
    ...evLines,
    ...(taskLines.length ? ["", "⏰ 近い締切", ...taskLines] : []),
    ...(recap.length ? ["", "🌙 昨日", ...recap] : []),
    ...(ai ? ["", `💡 ${ai}`] : []),
  ].join("\n");

  const r = await sendPush({
    title: `☀️ ${now.getMonth() + 1}/${now.getDate()} 朝ブリーフィング`,
    message: body.slice(0, 3500),
    tags: ["sunrise"],
    priority: 3,
    click: env.baseUrl,
  });
  if (!r.ok) console.error("[kairos] briefing push failed:", r.error);
  else console.log("[kairos] morning briefing sent");
  return r.ok;
}
