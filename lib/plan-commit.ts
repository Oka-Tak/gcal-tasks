import { and, eq, isNull, like } from "drizzle-orm";
import { db } from "./db";
import { listAccounts } from "./accounts";
import { calendars, events, tasks } from "./db/schema";
import { calendarFor } from "./google";
import { createEvent } from "./mutations";
import { syncCalendars, syncEvents } from "./sync";

/**
 * プランの確定: 🧭プランは流動的な「予定の仮決め案」で、ユーザーが📌で確定した
 * ブロックだけを専用カレンダー「Kairos プラン」のGoogle予定に昇格させる。
 *  - 確定枠はスマホ含むどこからでも見え、プランナーは「埋まった時間」として避ける
 *  - 予定の説明欄のマーカーでタスクと紐付け、プランナーは確定済み分数を
 *    そのタスクの残り見積りから差し引く（同じ作業を二重に置かない）
 *  - タスク完了時、未来の確定枠は自動削除（過去の枠は実績として残す）
 */

export const PLAN_CAL_NAME = "Kairos プラン";
const MARKER_PREFIX = "[kairos-plan: ";
export const planMarker = (taskKey: string) => `${MARKER_PREFIX}${taskKey}]`;

/** 予定の説明からタスクキーを取り出す（無ければ null）。 */
export function taskKeyOfPlanEvent(description: string | null | undefined): string | null {
  const m = description?.match(/\[kairos-plan: ([^\]]+)\]/);
  return m ? m[1] : null;
}

/** アカウントの「Kairos プラン」カレンダーID（無ければ作成して同期）。 */
export async function ensurePlanCalendar(account: string): Promise<string> {
  const existing = db
    .select()
    .from(calendars)
    .where(and(eq(calendars.account, account), isNull(calendars.deletedAt), eq(calendars.summary, PLAN_CAL_NAME)))
    .get();
  if (existing) return existing.googleId;
  const created = await calendarFor(account).calendars.insert({
    requestBody: { summary: PLAN_CAL_NAME, description: "Kairos の確定済み作業枠（🧭プランから📌で昇格）" },
  });
  const id = created.data.id;
  if (!id) throw new Error("Google Calendar returned no id");
  // 色を落ち着いた灰系に（失敗しても機能には影響なし）
  await calendarFor(account)
    .calendarList.patch({ calendarId: id, requestBody: { colorId: "19" } })
    .catch(() => {});
  await syncCalendars(account); // ローカルミラーに反映（書き込み検証が参照する）
  return id;
}

/** プランブロックを確定して Google 予定にする。 */
export async function commitPlanBlock(opts: {
  taskKey?: string; // account|tasklist|googleId（タスク枠のとき）
  startMs: number;
  endMs: number;
  /** 移動枠を確定するとき（taskKey の代わり）。title は「移動: A → B」等。 */
  travelTitle?: string;
  note?: string;
}): Promise<{ eventId: string; calendarId: string }> {
  if (!(opts.endMs > opts.startMs)) throw new Error("時間帯が不正です");

  // 移動枠: タスクに紐づかないので、既定アカウントのプランカレンダーへ置く
  if (opts.travelTitle) {
    const first = listAccounts()[0];
    if (!first) throw new Error("アカウントがありません");
    const calendarId = await ensurePlanCalendar(first.email);
    const { id } = await createEvent({
      account: first.email,
      calendarId,
      summary: `🚶 ${opts.travelTitle}`,
      description: opts.note ?? "",
      allDay: false,
      start: new Date(opts.startMs).toISOString(),
      end: new Date(opts.endMs).toISOString(),
    });
    return { eventId: id, calendarId };
  }

  if (!opts.taskKey) throw new Error("taskKey か travelTitle が要ります");
  const [account, tasklist, googleId] = opts.taskKey.split("|");
  if (!account || !tasklist || !googleId) throw new Error("taskKey が不正です");
  const t = db
    .select()
    .from(tasks)
    .where(and(eq(tasks.account, account), eq(tasks.tasklist, tasklist), eq(tasks.googleId, googleId)))
    .get();
  if (!t || t.deletedAt) throw new Error("タスクが見つかりません");

  const calendarId = await ensurePlanCalendar(account);
  const { id } = await createEvent({
    account,
    calendarId,
    summary: `🧭 ${t.title ?? "(無題)"}`,
    description: planMarker(opts.taskKey),
    allDay: false,
    start: new Date(opts.startMs).toISOString(),
    end: new Date(opts.endMs).toISOString(),
  });
  return { eventId: id, calendarId };
}

/**
 * タスクの確定済み分数（未来の確定枠の合計、分）。プランナーが残り見積りから
 * 差し引く。進行中の枠は残り時間ぶんだけ数える。
 */
export function committedFutureMinutes(now = Date.now()): Map<string, number> {
  const rows = db
    .select()
    .from(events)
    .where(and(isNull(events.deletedAt), like(events.description, `%${MARKER_PREFIX}%`)))
    .all()
    .filter((e) => e.status !== "cancelled" && e.endMs != null && e.endMs > now);
  const out = new Map<string, number>();
  for (const e of rows) {
    const key = taskKeyOfPlanEvent(e.description);
    if (!key) continue;
    const ms = e.endMs! - Math.max(e.startMs ?? e.endMs!, now);
    out.set(key, (out.get(key) ?? 0) + Math.round(ms / 60_000));
  }
  return out;
}

/** タスク完了時: 未来の確定枠を自動削除（過去の枠は実績として残す）。 */
export async function deleteFuturePlanBlocks(taskKey: string): Promise<number> {
  const now = Date.now();
  const rows = db
    .select()
    .from(events)
    .where(and(isNull(events.deletedAt), like(events.description, `%${planMarker(taskKey)}%`)))
    .all()
    .filter((e) => e.status !== "cancelled" && (e.startMs ?? 0) > now);
  let deleted = 0;
  const touched = new Set<string>();
  for (const e of rows) {
    try {
      await calendarFor(e.account).events.delete({ calendarId: e.calendarId, eventId: e.googleId });
      touched.add(`${e.account}|${e.calendarId}|${e.startMs}|${e.endMs}`);
      deleted++;
    } catch (err) {
      console.log(`[plan-commit] 確定枠の削除に失敗: ${String(err).slice(0, 120)}`);
    }
  }
  // ミラーへ反映（対象カレンダーだけ、枠の周辺ウィンドウで）
  for (const key of touched) {
    const [account, calendarId, s, e] = key.split("|");
    const cal = db
      .select()
      .from(calendars)
      .where(and(eq(calendars.account, account), eq(calendars.googleId, calendarId)))
      .get();
    const min = new Date(Number(s) - 86_400_000).toISOString();
    const max = new Date(Number(e) + 86_400_000).toISOString();
    await syncEvents(account, calendarId, cal?.color ?? "#8a94a3", min, max).catch(() => {});
  }
  if (deleted) console.log(`[plan-commit] タスク完了により確定枠${deleted}件を削除 (${taskKey})`);
  return deleted;
}
