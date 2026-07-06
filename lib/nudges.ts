import { and, eq, isNull } from "drizzle-orm";
import { db } from "./db";
import { tasks } from "./db/schema";
import { env } from "./env";
import { pushEnabled, sendPush } from "./notify";
import { checkMorningBriefing } from "./briefing";

/**
 * Hourly proactive nudges (ntfy), on top of the explicit remindAt reminders:
 *  1. 期限前日 — a task's due date is tomorrow → one push per due value
 *     (rescheduling the task re-arms the nudge via nudgedForDue).
 *  2. タスク区切りませんか — big estimate (>=90min), no subtasks yet → one
 *     push per task, ever (splitNudgedAt), max 2 per tick to avoid spam.
 * Both only fire during waking hours (07–22 server time).
 */

const WAKE_START = 7; // hour, inclusive
const WAKE_END = 22; // hour, exclusive
const SPLIT_MIN_ESTIMATE = 90; // minutes
const SPLIT_MAX_PER_TICK = 2;

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

type TaskRow = typeof tasks.$inferSelect;

function markNudged(t: TaskRow, patch: Partial<typeof tasks.$inferInsert>): void {
  db.update(tasks)
    .set(patch)
    .where(
      and(eq(tasks.account, t.account), eq(tasks.tasklist, t.tasklist), eq(tasks.googleId, t.googleId)),
    )
    .run();
}

export async function checkNudges(): Promise<number> {
  if (!pushEnabled()) return 0;
  const h = new Date().getHours();
  if (h < WAKE_START || h >= WAKE_END) return 0;

  const open = db
    .select()
    .from(tasks)
    .where(and(isNull(tasks.deletedAt), eq(tasks.status, "needsAction")))
    .all();
  let sent = 0;

  // 1) due date is tomorrow
  const tomorrow = ymd(new Date(Date.now() + 86_400_000));
  for (const t of open) {
    const due = t.due?.slice(0, 10);
    if (due !== tomorrow || t.nudgedForDue === t.due) continue;
    const bits = [
      `期限 ${due}${t.dueTime ? ` ${t.dueTime}` : ""}`,
      t.estimatedMin != null ? `見積り ${t.estimatedMin}分` : null,
    ].filter(Boolean);
    const r = await sendPush({
      title: `📅 明日が期限: ${t.title || "タスク"}`,
      message: bits.join(" / "),
      tags: ["calendar"],
      priority: 4,
      click: env.baseUrl,
    });
    if (r.ok) {
      markNudged(t, { nudgedForDue: t.due });
      sent++;
    } else {
      console.error(`[kairos] due-nudge push failed (${t.title}):`, r.error);
    }
  }

  // 2) big task without subtasks → suggest splitting
  const parentIds = new Set(open.map((t) => t.parent).filter(Boolean));
  let splits = 0;
  for (const t of open) {
    if (splits >= SPLIT_MAX_PER_TICK) break;
    if (t.parent) continue; // subtasks don't nudge
    if ((t.estimatedMin ?? 0) < SPLIT_MIN_ESTIMATE) continue;
    if (t.splitNudgedAt != null) continue;
    if (parentIds.has(t.googleId)) continue; // already split
    const r = await sendPush({
      title: `✂️ タスクを区切りませんか: ${t.title || "タスク"}`,
      message: `見積り${t.estimatedMin}分の大きめタスクです。サブタスクに分割すると着手しやすくなります。AIタブで「分割して」と相談すると案を出します`,
      tags: ["scissors"],
      priority: 3,
      click: env.baseUrl,
    });
    if (r.ok) {
      markNudged(t, { splitNudgedAt: Date.now() });
      splits++;
      sent++;
    } else {
      console.error(`[kairos] split-nudge push failed (${t.title}):`, r.error);
    }
  }
  return sent;
}

/**
 * Deadline pushes — unlike the hourly nudges these are urgent, so they run on
 * a 60s tick and are NOT limited to waking hours (a 23:55 deadline must ring
 * at 23:55). Deadline = due date + dueTime, or 23:59 for date-only tasks.
 *  - ⏳ 1時間前 (dueSoonFor marker, per deadline value)
 *  - ⌛ 期限到来 (duePassedFor marker; only within 30min of the deadline so a
 *    restart doesn't blast pushes for long-overdue tasks)
 */
export async function checkDeadlines(): Promise<number> {
  if (!pushEnabled()) return 0;
  const now = Date.now();
  const open = db
    .select()
    .from(tasks)
    .where(and(isNull(tasks.deletedAt), eq(tasks.status, "needsAction")))
    .all();
  let sent = 0;

  for (const t of open) {
    const dueYmd = t.due?.slice(0, 10);
    if (!dueYmd) continue;
    const time = t.dueTime || "23:59";
    const deadline = new Date(`${dueYmd}T${time}:00`).getTime();
    if (Number.isNaN(deadline)) continue;
    const key = `${dueYmd} ${time}`;
    const est = t.estimatedMin != null ? ` / 見積り ${t.estimatedMin}分` : "";

    if (deadline - now > 0 && deadline - now <= 60 * 60_000 && t.dueSoonFor !== key) {
      const r = await sendPush({
        title: `⏳ あと1時間で期限: ${t.title || "タスク"}`,
        message: `期限 ${time}${est}`,
        tags: ["hourglass_flowing_sand"],
        priority: 4,
        click: env.baseUrl,
      });
      if (r.ok) {
        markNudged(t, { dueSoonFor: key });
        sent++;
      } else {
        console.error(`[kairos] due-soon push failed (${t.title}):`, r.error);
      }
    }

    if (now >= deadline && now - deadline <= 30 * 60_000 && t.duePassedFor !== key) {
      const r = await sendPush({
        title: `⌛ 期限になりました: ${t.title || "タスク"}`,
        message: `期限 ${dueYmd} ${time}${est}`,
        tags: ["rotating_light"],
        priority: 5,
        click: env.baseUrl,
      });
      if (r.ok) {
        markNudged(t, { duePassedFor: key });
        sent++;
      } else {
        console.error(`[kairos] due-passed push failed (${t.title}):`, r.error);
      }
    }
  }
  return sent;
}

const DEADLINE_TICK_MS = 60_000;
const TICK_MS = 60 * 60_000; // hourly
const BOOT_DELAY_MS = 30_000; // let the first syncs land before nudging

/** Started once per server process from instrumentation.ts. */
export function startNudgeLoop(): void {
  if (!pushEnabled()) {
    console.log("[kairos] ntfy not configured — nudge loop off");
    return;
  }
  const g = globalThis as unknown as { __kairosNudgeLoop?: ReturnType<typeof setInterval> };
  if (g.__kairosNudgeLoop) return; // survive dev HMR re-registration
  const tick = () =>
    checkNudges()
      .then((n) => { if (n) console.log(`[kairos] nudges sent: ${n}`); })
      .catch((e) => console.error("[kairos] nudge tick failed:", e));
  const first = setTimeout(tick, BOOT_DELAY_MS);
  first.unref?.();
  const timer = setInterval(tick, TICK_MS);
  timer.unref?.();
  g.__kairosNudgeLoop = timer;

  const deadlineTick = () => {
    checkDeadlines()
      .then((n) => { if (n) console.log(`[kairos] deadline pushes sent: ${n}`); })
      .catch((e) => console.error("[kairos] deadline tick failed:", e));
    // 朝ブリーフィング (1日1回、07時台の最初のtickで送信)
    checkMorningBriefing().catch((e) => console.error("[kairos] briefing failed:", e));
  };
  const dTimer = setInterval(deadlineTick, DEADLINE_TICK_MS);
  dTimer.unref?.();
  console.log("[kairos] nudge loop started (60min tick) + deadline loop (60s tick)");
}
