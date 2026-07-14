import { and, asc, eq, gte, isNull, lt } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { events, tasks } from "@/lib/db/schema";
import { glossaryBlock } from "@/lib/glossary";
import { buildPlan } from "@/lib/planner";
import { listRoutines } from "@/lib/routines";

export const runtime = "nodejs";

/**
 * Claude Web（claude.ai）に貼り付ける自己完結コンテキストを生成する。
 * Kairos は tailnet 内なので claude.ai から直接は読めない — 代わりに
 * 予定・タスク・プラン・生活ルール・用語集を1枚のMarkdownに固めて渡す。
 * プランカードの📋ボタンがこれをクリップボードへコピーする。
 */

const pad = (n: number) => String(n).padStart(2, "0");
const hm = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const mdw = (ms: number) => {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}(${"日月火水木金土"[d.getDay()]})`;
};

export async function GET() {
  const session = await auth();
  if (!session?.user) return Response.json({ detail: "unauthenticated" }, { status: 401 });

  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const horizon = dayStart + 3 * 86_400_000;

  const evs = db
    .select()
    .from(events)
    .where(and(isNull(events.deletedAt), gte(events.endMs, dayStart), lt(events.startMs, horizon)))
    .orderBy(asc(events.startMs))
    .all()
    .filter((e) => e.status !== "cancelled");
  const open = db
    .select()
    .from(tasks)
    .where(and(isNull(tasks.deletedAt), eq(tasks.status, "needsAction")))
    .all();
  const parents = open.filter((t) => !t.parent && (t.asap || t.due))
    .sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999"));
  const kidsOf = (id: string) => open.filter((c) => c.parent === id);

  const plan = buildPlan(2);
  const routines = listRoutines().filter((r) => r.active);
  const terms = glossaryBlock(3000);

  const md = [
    "以下は私（大学生）の予定・タスク・生活ルールのスナップショットです。これを前提に相談に乗ってください。",
    `# 現在時刻: ${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()} ${hm(now.getTime())}`,
    "",
    "# 直近3日の予定",
    ...evs.slice(0, 25).map((e) =>
      e.allDay ? `- ${mdw(e.startMs!)} 終日 ${e.summary ?? ""}` : `- ${mdw(e.startMs!)} ${hm(e.startMs!)}-${hm(e.endMs!)} ${e.summary ?? ""}`),
    "",
    "# 未完了タスク（締切順、⚡=ASAP、P=優先度、分=見積り）",
    ...parents.slice(0, 25).flatMap((t) => {
      const head = `- ${t.asap ? "⚡" : ""}${t.due ? `${t.due.slice(5, 10).replace("-", "/")}${t.dueTime ? ` ${t.dueTime}` : ""}締切 ` : ""}${t.title ?? ""}${t.priority ? ` [P${t.priority}]` : ""}${t.estimatedMin ? ` [${t.estimatedMin}分]` : ""}`;
      return [head, ...kidsOf(t.googleId).map((c) => `    - ${c.status === "completed" ? "✅" : "□"} ${c.title ?? ""}${c.estimatedMin ? ` [${c.estimatedMin}分]` : ""}`)];
    }),
    "",
    "# 今日〜明日のプラン（空き時間へのタスク自動割り当て）",
    ...plan.blocks.slice(0, 20).map((b) =>
      b.kind === "deadline" ? `- ${mdw(b.startMs)} ${hm(b.startMs)} ⏰ ${b.title}` : `- ${mdw(b.startMs)} ${hm(b.startMs)}-${hm(b.endMs)} ${b.title}`),
    ...plan.warnings.map((w) => `- ⚠ ${w}`),
    "",
    "# 生活ルール",
    ...routines.map((r) =>
      `- ${r.label}: ${r.kind === "deadline" ? `${r.endHm}までに` : r.kind === "sleep" ? `就寝${r.startHm}〜起床${r.endHm}` : `${r.startHm}-${r.endHm}`}${r.days ? `（${r.days}）` : ""}${r.note ? ` — ${r.note}` : ""}`),
    ...(terms ? ["", "# 用語集（私固有の用語・団体）", terms] : []),
  ].join("\n");

  return Response.json({ markdown: md, chars: md.length });
}
