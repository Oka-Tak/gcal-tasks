import { and, eq, isNull } from "drizzle-orm";
import { db } from "./db";
import { travelRoutes } from "./db/schema";

/**
 * 予定の「場所」から移動を読み取るための土台。
 *
 * 方針:
 *  - 学内の建物（情13 / 共通講義棟31 / 工3-31 …）は徒歩数分圏なので1つの地点に畳む。
 *    畳まないと「情13→共通講義棟31」まで移動扱いになり、プランが穴だらけになる。
 *  - オンライン（URL / "オンライン"）は移動ゼロの地点として扱う。
 *  - 所要時間は travel_routes にキャッシュする。移動手段はユーザーが指定し、
 *    AI(Web検索)はその手段での分数だけを埋める。
 */

/** 学内建物の判定（静大浜松キャンパス）。 */
const CAMPUS_RE = /(情\s*\d|共通講義棟|共\s*\d|工\s*\d|総\s*\d|TC\s*Room|浜松キャンパス|S-port)/i;
const ONLINE_RE = /^https?:\/\/|オンライン|zoom|meet\.google|teams|mattermost/i;

export const CAMPUS = "静岡大学 浜松キャンパス";
export const ONLINE = "(オンライン)";

/** 生の location 文字列を、移動計算に使う地点名へ正規化する。 */
export function normalizePlace(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  if (ONLINE_RE.test(s)) return ONLINE;
  if (CAMPUS_RE.test(s)) return CAMPUS;
  // 「乗車：A／下車：B」のような書式は下車地を採用
  const m = s.match(/下車[：:]\s*([^／/,]+)/);
  if (m) return normalizePlace(m[1]) ?? m[1].trim();
  // 住所付き（"施設名, 日本、〒..."）は施設名だけ残す
  return s.split(/[,、]/)[0].trim().slice(0, 80);
}

/** 移動が要る組み合わせか（同一地点・オンライン絡みは移動ゼロ）。 */
export function needsTravel(from: string | null, to: string | null): boolean {
  if (!from || !to) return false;
  if (from === to) return false;
  if (from === ONLINE || to === ONLINE) return false;
  return true;
}

export interface Route {
  from: string;
  to: string;
  mode: string;
  minutes: number | null;
  note: string | null;
}

/** キャッシュ済みの所要時間を引く（両方向とも同じ扱い）。 */
export function lookupRoute(from: string, to: string): Route | null {
  const [a, b] = [from, to].sort();
  const r = db
    .select()
    .from(travelRoutes)
    .where(and(eq(travelRoutes.fromPlace, a), eq(travelRoutes.toPlace, b), isNull(travelRoutes.deletedAt)))
    .get();
  return r ? { from: r.fromPlace, to: r.toPlace, mode: r.mode, minutes: r.minutes, note: r.note } : null;
}

/** 所要時間を登録/更新（手入力・AI推定の両方から使う）。 */
export function upsertRoute(from: string, to: string, patch: { mode?: string; minutes?: number | null; note?: string | null; source?: string }): void {
  const [a, b] = [from, to].sort();
  const now = Date.now();
  const cur = db
    .select()
    .from(travelRoutes)
    .where(and(eq(travelRoutes.fromPlace, a), eq(travelRoutes.toPlace, b)))
    .get();
  if (cur) {
    db.update(travelRoutes)
      .set({
        ...(patch.mode !== undefined && { mode: patch.mode }),
        ...(patch.minutes !== undefined && { minutes: patch.minutes }),
        ...("note" in patch && { note: patch.note ?? null }),
        ...(patch.source !== undefined && { source: patch.source }),
        deletedAt: null,
        updatedAt: now,
      })
      .where(eq(travelRoutes.id, cur.id))
      .run();
    return;
  }
  db.insert(travelRoutes)
    .values({
      id: crypto.randomUUID(),
      fromPlace: a,
      toPlace: b,
      mode: patch.mode ?? "未指定",
      minutes: patch.minutes ?? null,
      note: patch.note ?? null,
      source: patch.source ?? "manual",
      createdAt: now,
      updatedAt: now,
    })
    .run();
}
