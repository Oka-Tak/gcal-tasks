import { and, eq, isNull } from "drizzle-orm";
import { db } from "./db";
import { tasks } from "./db/schema";
import { env } from "./env";
import fs from "node:fs/promises";
import path from "node:path";
import { pushEnabled, sendPush } from "./notify";
import { muteMatcher } from "./notify-mute";
import { checkMorningBriefing } from "./briefing";
import { enrichTasks } from "./task-enrich";
import { parentTaskIdentity, taskIdentity } from "./task-identity";

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
  const muted = muteMatcher();
  let sent = 0;

  // 1) due date is tomorrow
  const tomorrow = ymd(new Date(Date.now() + 86_400_000));
  for (const t of open) {
    if (muted(t.title)) continue;
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
  const parentIds = new Set(open.map(parentTaskIdentity).filter((key): key is string => !!key));
  let splits = 0;
  for (const t of open) {
    if (splits >= SPLIT_MAX_PER_TICK) break;
    if (muted(t.title)) continue;
    if (t.parent) continue; // subtasks don't nudge
    if ((t.estimatedMin ?? 0) < SPLIT_MIN_ESTIMATE) continue;
    if (t.splitNudgedAt != null) continue;
    if (parentIds.has(taskIdentity(t))) continue; // already split
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
  const muted = muteMatcher();
  let sent = 0;

  for (const t of open) {
    if (muted(t.title)) continue;
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

/**
 * 毎日0時台の最初のtickでAI一括推定（見積り・優先度・サブタスク分割）を回す。
 * 実行日はファイルで永続化（再起動をまたいでも1日1回）。朝ブリーフィング前の
 * 実行と合わせて1日2回、どちらも空欄だけ埋めるので冪等。
 */
const ENRICH_STAMP = () => path.join(path.resolve(env.dataDir), ".enrich-last");
const dstamp = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
async function checkNightlyEnrich(): Promise<void> {
  const now = new Date();
  if (now.getHours() !== 0) return;
  const today = dstamp(now);
  try {
    if ((await fs.readFile(ENRICH_STAMP(), "utf8")).trim() === today) return;
  } catch { /* first run */ }
  await fs.mkdir(path.dirname(ENRICH_STAMP()), { recursive: true }).catch(() => {});
  await fs.writeFile(ENRICH_STAMP(), today); // 先に刻む — クラッシュで連打しない
  const r = await enrichTasks({ limit: 15 });
  if (r.updated) console.log(`[kairos] nightly enrich: ${r.lines.join(" / ")}`);
  // 用語集のRAGコピーも夜間に置き換える（mnemo側での編集はKairosのpushを通らないため）
  const { pushGlossaryToOwui } = await import("./glossary");
  await pushGlossaryToOwui().catch((e) => console.log("[kairos] glossary push skipped:", String(e).slice(0, 100)));
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
    // 0時のAI一括推定（見積り・優先度・サブタスク分割）
    checkNightlyEnrich().catch((e) => console.error("[kairos] nightly enrich failed:", e));
  };
  const dTimer = setInterval(deadlineTick, DEADLINE_TICK_MS);
  dTimer.unref?.();
  console.log("[kairos] nudge loop started (60min tick) + deadline loop (60s tick)");
}
