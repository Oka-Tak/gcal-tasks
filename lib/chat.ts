import crypto from "node:crypto";
import { and, asc, desc, eq, gt, isNull, lt } from "drizzle-orm";
import { db } from "./db";
import { agentJobs, calendars, chats, events, notes, tasklists, tasks } from "./db/schema";
import { extractJson, runAgent, type AgentName } from "./agent";
import { normalizeChoice, type AgentUsage } from "./agents-catalog";
import { listAccounts } from "./accounts";
import { listLogs } from "./logs";
import { ACTION_SPEC, createProposals, listProposals, type ProposalView } from "./actions";

/**
 * Per-task (or general) AI consultation. The DB is the source of truth: every
 * turn is stored in `chats`, and each request rebuilds the prompt from that
 * history (we deliberately do NOT use the CLI's own --resume session, so the
 * whole conversation survives and is readable by other tools).
 *
 * The agent answers as JSON {reply, actions}; actions become `proposals`
 * (lib/actions) that only execute after human approval in the UI.
 */

type TaskRow = typeof tasks.$inferSelect;

export interface ChatMessage {
  id: string;
  role: string;
  content: string | null;
  agent: string | null;
  createdAt: number | null;
  usage?: AgentUsage | null; // from the linked agent_jobs row (assistant turns)
}

function threadOf(taskKey: string | null | undefined): string {
  return taskKey || "general";
}

/** Topic threads (the /ai tab) are "topic:<uuid>"; "general" is the default one. */
export function isTopicThread(t: string): boolean {
  return t === "general" || /^topic:[0-9a-fA-F-]{8,64}$/.test(t);
}

/** Resolve the thread id from an explicit thread (topic) or a taskKey. */
export function resolveThread(opts: { thread?: string | null; taskKey?: string | null }): string {
  if (opts.thread && isTopicThread(opts.thread)) return opts.thread;
  return threadOf(opts.taskKey);
}

export function listMessages(threadId: string): ChatMessage[] {
  return db
    .select({ msg: chats, usage: agentJobs.usage })
    .from(chats)
    .leftJoin(agentJobs, eq(chats.jobId, agentJobs.id))
    .where(eq(chats.threadId, threadId))
    .orderBy(asc(chats.createdAt))
    .all()
    .map(({ msg: m, usage }) => {
      let parsed: AgentUsage | null = null;
      try {
        parsed = usage ? (JSON.parse(usage) as AgentUsage) : null;
      } catch {
        // corrupt usage JSON — just omit it
      }
      return {
        id: m.id,
        role: m.role,
        content: m.content,
        agent: m.agent,
        createdAt: m.createdAt,
        usage: parsed,
      };
    });
}

export function listThreadProposals(threadId: string): ProposalView[] {
  return listProposals(threadId);
}

export interface ThreadInfo {
  id: string;
  title: string;
  updatedAt: number;
  count: number;
}

/** Topic threads (taskKey-less), newest first. "general" always exists. */
export function listThreads(): ThreadInfo[] {
  const rows = db
    .select()
    .from(chats)
    .where(isNull(chats.taskKey))
    .orderBy(asc(chats.createdAt))
    .all();
  const map = new Map<string, ThreadInfo>();
  for (const r of rows) {
    const t = map.get(r.threadId);
    if (!t) {
      map.set(r.threadId, {
        id: r.threadId,
        title: r.role === "user" ? (r.content ?? "").slice(0, 30) : "",
        updatedAt: r.createdAt ?? 0,
        count: 1,
      });
    } else {
      if (!t.title && r.role === "user") t.title = (r.content ?? "").slice(0, 30);
      t.updatedAt = Math.max(t.updatedAt, r.createdAt ?? 0);
      t.count++;
    }
  }
  if (!map.has("general"))
    map.set("general", { id: "general", title: "", updatedAt: 0, count: 0 });
  const list = [...map.values()].map((t) => ({ ...t, title: t.title || "（無題の話題）" }));
  const general = list.find((t) => t.id === "general")!;
  general.title = "メイン";
  return [general, ...list.filter((t) => t.id !== "general").sort((a, b) => b.updatedAt - a.updatedAt)];
}

function saveMessage(
  threadId: string,
  taskKey: string | null,
  role: string,
  content: string,
  agent?: AgentName,
  jobId?: string,
): string {
  const id = crypto.randomUUID();
  db.insert(chats)
    .values({
      id,
      threadId,
      taskKey: taskKey ?? null,
      role,
      content,
      agent: agent ?? null,
      jobId: jobId ?? null,
      createdAt: Date.now(),
    })
    .run();
  return id;
}

function taskFor(taskKey: string): TaskRow | null {
  const [account, tasklist, googleId] = taskKey.split("|");
  if (!account || !tasklist || !googleId) return null;
  return (
    db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.account, account),
          eq(tasks.tasklist, tasklist),
          eq(tasks.googleId, googleId),
        ),
      )
      .get() ?? null
  );
}

function fmtDur(min: number | null): string {
  if (min == null || Number.isNaN(min)) return "?";
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h}時間${m ? `${m}分` : ""}` : `${m}分`;
}

/** A compact, token-cheap summary of recent life-log so the agent can judge capacity. */
function summarizeLogs(): string {
  const all = listLogs(120);
  if (!all.length) return "（ライフログはまだありません）";
  const lines: string[] = [];
  const sleep = all.filter((l) => l.kind === "sleep" && l.startMs);
  if (sleep.length) {
    const recent = sleep.slice(0, 10);
    const durs = recent
      .map((s) =>
        s.startMs && s.endMs
          ? Math.round((s.endMs - s.startMs) / 60000)
          : ((s.metrics?.durationMin as number) ?? null),
      )
      .filter((n): n is number => n != null);
    const avg = durs.length ? Math.round(durs.reduce((a, b) => a + b, 0) / durs.length) : null;
    lines.push(`睡眠: 直近${recent.length}件、平均 ${fmtDur(avg)}。`);
    for (const s of recent.slice(0, 7)) {
      const d = new Date(s.startMs as number);
      const dur = s.startMs && s.endMs ? Math.round((s.endMs - s.startMs) / 60000) : null;
      const score = s.metrics?.score ?? s.metrics?.quality;
      lines.push(
        `  ${d.getMonth() + 1}/${d.getDate()} ${dur != null ? fmtDur(dur) : ""}${score != null ? ` / スコア${score}` : ""}`,
      );
    }
  }
  const others = all.filter((l) => l.kind !== "sleep").slice(0, 12);
  if (others.length) {
    lines.push(
      `その他の記録: ${others.map((o) => `${o.kind}${o.title ? `(${o.title})` : ""}`).join(", ")}`,
    );
  }
  return lines.join("\n");
}

const pad = (n: number) => String(n).padStart(2, "0");

function nowLine(): string {
  const d = new Date();
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  const wd = "日月火水木金土"[d.getDay()];
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}` +
    ` (${wd}曜日)`
  );
}

/** Valid write targets, with the exact IDs the agent must echo back in actions. */
function describeTargets(): string {
  const lines: string[] = [];
  const accts = listAccounts();
  lines.push(`アカウント: ${accts.map((a) => a.email).join(", ") || "（なし）"}`);
  const lists = db.select().from(tasklists).where(isNull(tasklists.deletedAt)).all();
  lines.push("タスクリスト:");
  for (const l of lists)
    lines.push(
      `  ${JSON.stringify({ account: l.account, tasklist: l.googleId, name: l.title })}`,
    );
  const cals = db
    .select()
    .from(calendars)
    .where(isNull(calendars.deletedAt))
    .all()
    .filter((c) => c.accessRole === "owner" || c.accessRole === "writer");
  lines.push("カレンダー（書き込み可）:");
  for (const c of cals)
    lines.push(
      `  ${JSON.stringify({ account: c.account, calendarId: c.googleId, name: c.summary, primary: !!c.primary })}`,
    );
  return lines.join("\n");
}

/** Next 7 days of events from the local mirror (freshest after the UI syncs). */
function upcomingEvents(): string {
  const now = Date.now();
  const rows = db
    .select()
    .from(events)
    .where(
      and(
        isNull(events.deletedAt),
        gt(events.endMs, now),
        lt(events.startMs, now + 7 * 86_400_000),
      ),
    )
    .orderBy(asc(events.startMs))
    .limit(40)
    .all();
  if (!rows.length) return "（今後7日間の予定はありません）";
  return rows
    .map((e) =>
      JSON.stringify({
        account: e.account,
        calendarId: e.calendarId,
        id: e.googleId,
        title: e.summary,
        start: e.start,
        end: e.end,
        allDay: !!e.allDay,
      }),
    )
    .join("\n");
}

/**
 * Free windows over the next 7 days (waking hours minus timed events), so slot
 * proposals land in genuinely open time. All-day events don't block a day.
 */
function freeSlots(): string {
  const WAKE_START = 7 * 60; // 07:00
  const WAKE_END = 23 * 60; // 23:00
  const busy = db
    .select()
    .from(events)
    .where(
      and(
        isNull(events.deletedAt),
        gt(events.endMs, Date.now()),
        lt(events.startMs, Date.now() + 7 * 86_400_000),
      ),
    )
    .all()
    .filter((e) => !e.allDay && e.startMs != null && e.endMs != null);

  const lines: string[] = [];
  for (let i = 0; i < 7; i++) {
    const day = new Date();
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() + i);
    const dayStart = day.getTime();
    // Today starts "now", rounded up to the next 15 minutes.
    const nowMin =
      i === 0 ? Math.ceil((Date.now() - dayStart) / 60000 / 15) * 15 : WAKE_START;
    let cursor = Math.max(WAKE_START, nowMin);
    const dayBusy = busy
      .map((e) => ({
        s: Math.max(0, Math.round(((e.startMs as number) - dayStart) / 60000)),
        e: Math.min(1440, Math.round(((e.endMs as number) - dayStart) / 60000)),
      }))
      .filter((b) => b.e > 0 && b.s < 1440)
      .sort((a, b) => a.s - b.s);
    const slots: string[] = [];
    const hm = (m: number) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
    for (const b of dayBusy) {
      if (b.s > cursor && Math.min(b.s, WAKE_END) - cursor >= 30)
        slots.push(`${hm(cursor)}-${hm(Math.min(b.s, WAKE_END))}`);
      cursor = Math.max(cursor, b.e);
      if (cursor >= WAKE_END) break;
    }
    if (WAKE_END - cursor >= 30) slots.push(`${hm(cursor)}-${hm(WAKE_END)}`);
    const wd = "日月火水木金土"[day.getDay()];
    lines.push(
      `${day.getMonth() + 1}/${day.getDate()}(${wd}) ${slots.length ? slots.join(", ") : "（空きなし）"}`,
    );
  }
  return lines.join("\n");
}

/**
 * The calibration data: how the user's past estimates compared to reality.
 * This is what makes estimates personal instead of generic.
 */
function estimationHistory(): string {
  const rows = db
    .select()
    .from(tasks)
    .where(and(isNull(tasks.deletedAt), eq(tasks.status, "completed")))
    .all()
    .filter((t) => t.actualMin != null)
    .sort((a, b) => (b.googleUpdated ?? "").localeCompare(a.googleUpdated ?? ""))
    .slice(0, 20);
  if (!rows.length) return "（実績データはまだありません。見積りは一般的な相場で。）";
  return rows
    .map((t) => {
      const bits = [`「${t.title}」`];
      bits.push(t.estimatedMin != null ? `見積${t.estimatedMin}分→実績${t.actualMin}分` : `実績${t.actualMin}分`);
      if (t.difficulty != null) bits.push(`難易度${t.difficulty}/5`);
      if (t.energy != null) bits.push(`エネルギー${t.energy}/5`);
      return bits.join(" ");
    })
    .join("\n");
}

/** Open tasks (needsAction), due-dated first, so the agent can reference/update them. */
function openTasks(): string {
  const rows = db
    .select()
    .from(tasks)
    .where(and(isNull(tasks.deletedAt), eq(tasks.status, "needsAction")))
    .all()
    .sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999"))
    .slice(0, 30);
  if (!rows.length) return "（未完了タスクはありません）";
  return rows
    .map((t) =>
      JSON.stringify({
        account: t.account,
        tasklist: t.tasklist,
        id: t.googleId,
        title: t.title,
        due: t.due ? t.due.slice(0, 10) : null,
        dueTime: t.dueTime,
        estimatedMin: t.estimatedMin,
        kanban: t.kanban ?? "todo",
        parent: t.parent ?? undefined, // set = this is a subtask
      }),
    )
    .join("\n");
}

/** Recent notes (lecture transcripts etc.) — titles + a peek, so the agent knows they exist. */
function recentNotes(): string {
  const rows = db
    .select()
    .from(notes)
    .where(isNull(notes.deletedAt))
    .orderBy(desc(notes.createdAt))
    .limit(8)
    .all();
  if (!rows.length) return "（ノートはまだありません）";
  return rows
    .map((n) => {
      const excerpt = (n.content ?? "").replace(/\s+/g, " ").slice(0, 200);
      return `- 「${n.title ?? "(無題)"}」${n.eventKey ? "（予定に紐付き）" : ""}${excerpt ? `: ${excerpt}` : ""}`;
    })
    .join("\n");
}

function buildPrompt(taskRow: TaskRow | null, history: ChatMessage[], message: string): string {
  const out: string[] = [];
  out.push(
    "あなたはユーザー専属のプランニングアシスタントです。日本語で、簡潔かつ実用的に答えてください。",
    "所要時間の見積り・着手のタイミング・タスクの分解・空き時間への配置を、ユーザーのライフログ（睡眠など調子の傾向）と予定を踏まえて提案してください。",
    "見積りのルール: 後述の「見積りと実績」で較正する（見積りが実績より甘い傾向ならバッファを厚く）。",
    "作業枠を予定として提案するときは「空き時間」の中からだけ選び、update_task で estimatedMin も併せて更新する。",
    "段取りのルール: 旅程づくり・複数日にわたる計画・アクションが多数必要になる大きな依頼は、",
    "まず actions を空にして「こういう手順で進めます」という計画を reply で示し、確認を取ってから",
    "次のターンでアクションを出すこと。単純な依頼（タスク1件の追加・予定1件の変更など）は確認不要で直接アクションを出してよい。",
    "ファイル操作はできません。Web検索（WebSearch / WebFetch）は使えるので、最新情報が必要なら検索してから答えてください。最終出力は下記の形式で。",
    "",
    ACTION_SPEC,
    "",
    "# 現在時刻",
    nowLine(),
    "",
    "# 書き込み先（ここにある ID のみ有効）",
    describeTargets(),
    "",
  );
  if (taskRow) {
    out.push("# 対象タスク（この相談の主題）");
    out.push(
      JSON.stringify({
        account: taskRow.account,
        tasklist: taskRow.tasklist,
        id: taskRow.googleId,
        title: taskRow.title,
        notes: taskRow.notes,
        status: taskRow.status,
        due: taskRow.due ? taskRow.due.slice(0, 10) : null,
        dueTime: taskRow.dueTime,
        estimatedMin: taskRow.estimatedMin,
      }),
    );
    out.push("");
  }
  out.push("# 未完了タスク", openTasks(), "");
  out.push("# 今後7日間の予定（ローカルミラー）", upcomingEvents(), "");
  out.push("# 空き時間（07:00〜23:00、予定を除いた枠。作業枠の提案はここから）", freeSlots(), "");
  out.push("# 見積りと実績（このユーザーの較正データ）", estimationHistory(), "");
  out.push("# ユーザーのライフログ要約", summarizeLogs(), "");
  out.push("# 最近のノート（講義の文字起こし等。ユーザーが内容に触れたら参照）", recentNotes(), "");
  if (history.length) {
    out.push("# これまでの会話");
    for (const m of history) {
      out.push(`${m.role === "user" ? "ユーザー" : "アシスタント"}: ${m.content ?? ""}`);
    }
    out.push("");
  }
  out.push(
    "# 新しい発言",
    `ユーザー: ${message}`,
    "",
    '冒頭の出力形式に従い、{"reply": "...", "actions": [...]} の JSON だけを出力してください。',
  );
  return out.join("\n");
}

export interface ChatResult {
  ok: boolean;
  reply?: string;
  proposals?: ProposalView[];
  error?: string;
  jobId: string;
}

export async function sendChat(opts: {
  taskKey?: string | null;
  thread?: string | null;
  message: string;
  agent?: string; // validated against lib/agents-catalog
  model?: string;
  effort?: string;
}): Promise<ChatResult> {
  const threadId = resolveThread(opts);
  const taskKey = opts.thread ? null : opts.taskKey || null;
  const { agent, model, effort } = normalizeChoice(opts.agent, opts.model, opts.effort);
  const history = listMessages(threadId); // before saving the new turn
  const taskRow = taskKey ? taskFor(taskKey) : null;

  saveMessage(threadId, taskKey, "user", opts.message);

  const res = await runAgent(buildPrompt(taskRow, history, opts.message), {
    agent,
    model,
    effort,
    jobKind: "chat",
    allowedTools: ["WebSearch", "WebFetch"], // claude: web only — file tools stay off
  });
  if (!res.ok) return { ok: false, error: res.error, jobId: res.jobId };

  // Parse the {reply, actions} envelope; fall back to the raw text as reply.
  const parsed = extractJson<{ reply?: unknown; actions?: unknown }>(res.text);
  let reply = res.text.trim();
  let rawActions: unknown[] = [];
  if (parsed && typeof parsed === "object" && ("reply" in parsed || "actions" in parsed)) {
    if (typeof parsed.reply === "string" && parsed.reply.trim()) reply = parsed.reply.trim();
    if (Array.isArray(parsed.actions)) rawActions = parsed.actions;
  }

  const chatId = saveMessage(threadId, taskKey, "assistant", reply, agent, res.jobId);
  const proposals = rawActions.length
    ? createProposals({
        threadId,
        chatId,
        jobId: res.jobId,
        rawActions,
      })
    : [];

  return { ok: true, reply, proposals, jobId: res.jobId };
}
