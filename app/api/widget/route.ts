import { type NextRequest } from "next/server";
import { and, asc, gt, gte, isNull, lt } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { events, expenses, logs, tasks } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { secretMatches } from "@/lib/secret-compare";

export const runtime = "nodejs";

/**
 * ホーム画面ウィジェット用の軽量JSON。クッキー認証が使えない環境
 * (iOS Scriptable / Android KWGT) 向けに ?token= で認証する。
 * 読み取り専用・トークンは .env.local の KAIROS_WIDGET_TOKEN（秘密）。
 */

const pad = (n: number) => String(n).padStart(2, "0");
const hm = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export async function GET(req: NextRequest) {
  const token = new URL(req.url).searchParams.get("token") ?? "";
  if (!secretMatches(token, env.widgetToken))
    return Response.json({ detail: "unauthorized" }, { status: 401 });

  const now = new Date();
  const nowMs = now.getTime();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayEnd = dayStart + 86_400_000;

  // 予定: 進行中〜48時間先を8件まで
  const evRows = db
    .select()
    .from(events)
    .where(and(isNull(events.deletedAt), gt(events.endMs, nowMs), lt(events.startMs, nowMs + 48 * 3_600_000)))
    .orderBy(asc(events.startMs))
    .all()
    .filter((e) => e.status !== "cancelled")
    // 祝日など複数カレンダーに同じ予定が居るので title+start でdedupe
    .filter((e, i, arr) => arr.findIndex((x) => x.summary === e.summary && x.startMs === e.startMs) === i)
    .slice(0, 8);
  const evs = evRows.map((e) => ({
    title: e.summary ?? "(無題)",
    start: e.startMs ?? 0,
    end: e.endMs ?? 0,
    allDay: !!e.allDay,
    when: e.allDay
      ? ((e.startMs ?? 0) < dayEnd ? "今日 終日" : "明日 終日")
      : `${(e.startMs ?? 0) < dayEnd ? "" : "明日"}${hm(e.startMs ?? 0)}-${hm(e.endMs ?? 0)}`,
    ongoing: !e.allDay && (e.startMs ?? 0) <= nowMs,
  }));

  // 締切: 3日以内の未完了タスク5件
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const horizon = new Date(nowMs + 3 * 86_400_000);
  const horizonYmd = `${horizon.getFullYear()}-${pad(horizon.getMonth() + 1)}-${pad(horizon.getDate())}`;
  const dueRows = db
    .select()
    .from(tasks)
    .where(and(isNull(tasks.deletedAt), eq(tasks.status, "needsAction")))
    .all()
    .filter((t) => {
      const due = t.due?.slice(0, 10);
      return !!due && due >= today && due <= horizonYmd;
    })
    .sort((a, b) => (a.due ?? "").localeCompare(b.due ?? ""))
    .slice(0, 5);
  const dues = dueRows.map((t) => ({
    title: t.title ?? "タスク",
    due: `${Number(t.due!.slice(5, 7))}/${Number(t.due!.slice(8, 10))}${t.dueTime ? ` ${t.dueTime.slice(0, 5)}` : ""}`,
    isToday: t.due!.slice(0, 10) === today,
  }));

  // 昨晩の睡眠
  const sleepRow = db
    .select()
    .from(logs)
    .where(and(isNull(logs.deletedAt), eq(logs.kind, "sleep"), gt(logs.endMs, dayStart - 6 * 3_600_000)))
    .all()
    .sort((a, b) => ((b.endMs ?? 0) - (b.startMs ?? 0)) - ((a.endMs ?? 0) - (a.startMs ?? 0)))[0];
  const sleep = sleepRow?.startMs && sleepRow.endMs
    ? (() => {
        const min = Math.round((sleepRow.endMs - sleepRow.startMs) / 60_000);
        return `${Math.floor(min / 60)}h${pad(min % 60)}m`;
      })()
    : null;

  // 今日の支出
  const spentToday = db
    .select()
    .from(expenses)
    .where(and(isNull(expenses.deletedAt), gte(expenses.whenMs, dayStart), lt(expenses.whenMs, dayEnd)))
    .all()
    .reduce((s, r) => s + r.amountYen, 0);

  return Response.json(
    {
      generatedAt: nowMs,
      events: evs,
      dues,
      sleep,
      spentTodayYen: spentToday,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
