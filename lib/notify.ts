import { and, eq, isNull, isNotNull, lte } from "drizzle-orm";
import { db } from "./db";
import { tasks } from "./db/schema";
import { env } from "./env";

/**
 * Push notifications via ntfy (https://ntfy.sh or self-hosted on Proxmox).
 * Publishing uses the JSON endpoint (POST to the server root) so Japanese
 * titles/messages survive — plain-text headers would mangle them.
 * Not configured = silently off; every caller handles {ok:false}.
 */

export interface Push {
  title: string;
  message: string;
  priority?: number; // 1(min)..5(urgent), default 3
  tags?: string[]; // ntfy emoji shortcodes, e.g. ["alarm"]
  click?: string; // URL to open on tap
}

export function pushEnabled(): boolean {
  return !!(env.ntfyUrl && env.ntfyTopic);
}

export async function sendPush(n: Push): Promise<{ ok: boolean; error?: string }> {
  if (!pushEnabled())
    return { ok: false, error: "ntfy未設定（KAIROS_NTFY_URL / KAIROS_NTFY_TOPIC を .env.local に）" };
  try {
    const res = await fetch(env.ntfyUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(env.ntfyToken ? { Authorization: `Bearer ${env.ntfyToken}` } : {}),
      },
      body: JSON.stringify({
        topic: env.ntfyTopic,
        title: n.title,
        message: n.message,
        priority: n.priority ?? 3,
        tags: n.tags ?? [],
        ...(n.click ? { click: n.click } : {}),
      }),
    });
    if (!res.ok) return { ok: false, error: `ntfy ${res.status}: ${(await res.text()).slice(0, 200)}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 300) };
  }
}

/**
 * Fire reminders that are due: remindAt has passed and we haven't pushed for
 * that remindAt yet (remindedAt is reset to null whenever remindAt changes).
 * Completed and deleted tasks never fire.
 */
export async function checkReminders(): Promise<number> {
  const now = Date.now();
  const due = db
    .select()
    .from(tasks)
    .where(
      and(
        isNull(tasks.deletedAt),
        isNotNull(tasks.remindAt),
        lte(tasks.remindAt, now),
        eq(tasks.status, "needsAction"),
      ),
    )
    .all()
    .filter((t) => t.remindedAt == null || t.remindedAt < (t.remindAt as number));

  let fired = 0;
  for (const t of due) {
    const bits = [
      t.due ? `期限 ${t.due.slice(0, 10)}${t.dueTime ? ` ${t.dueTime}` : ""}` : null,
      t.estimatedMin != null ? `見積り ${t.estimatedMin}分` : null,
    ].filter(Boolean);
    const r = await sendPush({
      title: `⏰ ${t.title || "タスク"}`,
      message: bits.join(" / ") || "リマインダー",
      tags: ["alarm"],
      priority: 4,
      click: env.baseUrl,
    });
    if (r.ok) {
      db.update(tasks)
        .set({ remindedAt: Date.now() })
        .where(
          and(
            eq(tasks.account, t.account),
            eq(tasks.tasklist, t.tasklist),
            eq(tasks.googleId, t.googleId),
          ),
        )
        .run();
      fired++;
    } else {
      // Leave remindedAt null so the next tick retries.
      console.error(`[kairos] reminder push failed (${t.title}):`, r.error);
    }
  }
  return fired;
}

const TICK_MS = 60_000;

/** Started once per server process from instrumentation.ts. */
export function startReminderLoop(): void {
  if (!pushEnabled()) {
    console.log("[kairos] ntfy not configured — reminder loop off");
    return;
  }
  const g = globalThis as unknown as { __kairosReminderLoop?: ReturnType<typeof setInterval> };
  if (g.__kairosReminderLoop) return; // survive dev HMR re-registration
  const timer = setInterval(() => {
    checkReminders().catch((e) => console.error("[kairos] reminder tick failed:", e));
  }, TICK_MS);
  timer.unref?.(); // never keep the process alive just for reminders
  g.__kairosReminderLoop = timer;
  console.log("[kairos] reminder loop started (60s tick)");
}
