"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { signIn, signOut } from "next-auth/react";
import { ChatPane } from "./chat-pane";
import { AudioUpload } from "./notes/notes-client";
import { Dock, MobileTabs } from "./nav";
import { BotIcon, ClockIcon, PlusIcon, RefreshIcon } from "./icons";

/* ------------------------------------------------------------------ types */
type Account = { email: string; name?: string | null; picture?: string | null; color?: string | null };
type Cal = { account: string; id: string; summary: string | null; color: string | null; primary: boolean };
type Attendee = { email?: string; name?: string; response?: string; organizer?: boolean; self?: boolean };
type Ev = {
  account: string; id: string; calendarId: string; color: string | null; summary: string;
  location?: string | null; description?: string | null; allDay: boolean;
  start: string; end: string; attendees: Attendee[]; meet?: string | null;
  attachments: { title?: string; url?: string }[]; htmlLink?: string | null;
  organizer?: string | null; recurring: boolean;
};
type Task = {
  account: string; tasklist: string; id: string; title: string; notes?: string | null;
  status: string; due?: string | null; dueTime?: string | null; parent?: string | null;
  estimatedMin?: number | null; actualMin?: number | null;
  difficulty?: number | null; energy?: number | null; remindAt?: number | null;
};
type ListMeta = { account: string; id: string; title: string | null };
type ActualLog = {
  id: string; kind: string; title: string | null;
  startMs: number | null; endMs: number | null;
};

type View = "month" | "week" | "day";

type Modal =
  | { kind: "detail"; ev: Ev }
  | { kind: "event"; isNew: boolean; ev?: Ev; draft: EventDraft }
  | { kind: "task"; isNew: boolean; draft: TaskDraft }
  | { kind: "chat"; taskKey: string; taskTitle: string; autoMessage?: string }
  | { kind: "accounts" }
  | null;

type EventDraft = {
  account: string; calendarId: string; summary: string; allDay: boolean;
  start: string; end: string; location: string; description: string;
};
type TaskDraft = {
  account: string; tasklist: string; id?: string; title: string;
  due: string; dueTime: string; notes: string; done: boolean;
  est: string; actual: string; difficulty: string; energy: string; // planning flywheel (as input strings)
  remind: string; // datetime-local — ntfy push reminder
};

/* ------------------------------------------------------------ date helpers */
const HOUR_H = 44, HOURS = 24;
const WD = ["日", "月", "火", "水", "木", "金", "土"];
const WD_MON = ["月", "火", "水", "木", "金", "土", "日"];
const pad = (n: number) => String(n).padStart(2, "0");
const startOfDay = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const startOfWeek = (d: Date) => { const x = startOfDay(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localInput = (d: Date) => `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
function toRFC3339(d: Date) {
  const off = -d.getTimezoneOffset(), s = off >= 0 ? "+" : "-";
  return `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:00${s}${pad(Math.abs(off) / 60 | 0)}:${pad(Math.abs(off) % 60)}`;
}
const enc = encodeURIComponent;
// Google's pastel event colors need dark text; saturated ones need light.
function inkFor(bg: string | null | undefined): string {
  if (!bg || !/^#[0-9a-fA-F]{6}$/.test(bg)) return "#fff";
  const r = parseInt(bg.slice(1, 3), 16), g = parseInt(bg.slice(3, 5), 16), b = parseInt(bg.slice(5, 7), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#0b1014" : "#fff";
}
const taskDueDate = (t: Task) => (t.due ? new Date(`${t.due.slice(0, 10)}T00:00:00`) : null);
const minsOf = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + (m || 0); };

function viewDays(view: View, anchor: Date): Date[] {
  if (view === "day") return [startOfDay(anchor)];
  const s = startOfWeek(anchor);
  return Array.from({ length: 7 }, (_, i) => addDays(s, i));
}
function rangeFor(view: View, anchor: Date): [Date, Date] {
  if (view === "month") {
    const gs = startOfWeek(new Date(anchor.getFullYear(), anchor.getMonth(), 1));
    return [gs, addDays(gs, 42)];
  }
  const ds = viewDays(view, anchor);
  return [startOfDay(ds[0]), addDays(startOfDay(ds[ds.length - 1]), 1)];
}

async function api(method: string, url: string, body?: unknown) {
  const r = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) throw { unauth: true };
  if (!r.ok) throw new Error(await r.text());
  return r.status === 204 ? null : r.json();
}

/** 起動即描画のための localStorage キャッシュ (stale-while-revalidate)。 */
const CACHE_KEY = "kairos-cache-v1";
interface CacheShape {
  accounts: Account[];
  calendars: Cal[];
  events: Ev[];
  lists: ListMeta[];
  tasks: Task[];
  actuals: ActualLog[];
  savedAt: number;
}

/* =================================================================== app */
export default function Calendar() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [view, setView] = useState<View>("week");
  const [anchor, setAnchor] = useState<Date>(new Date());
  const [calendars, setCalendars] = useState<Cal[]>([]);
  const [events, setEvents] = useState<Ev[]>([]);
  const [lists, setLists] = useState<ListMeta[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [modal, setModal] = useState<Modal>(null);
  const [pane, setPane] = useState<"cal" | "tasks">("cal"); // mobile: which pane is visible
  const [actuals, setActuals] = useState<ActualLog[]>([]); // 裏カレンダー: logs in range
  const [showActual, setShowActual] = useState(false);

  const acctColor = useCallback(
    (email: string) => accounts.find((a) => a.email === email)?.color || "#888",
    [accounts],
  );

  // boot: who are we?
  useEffect(() => {
    (async () => {
      const st = await fetch("/api/status").then((r) => r.json());
      setAccounts(st.accounts || []);
      setAuthed(!!st.authed);
      if (!st.authed) localStorage.removeItem(CACHE_KEY); // ログアウト状態でキャッシュを残さない
    })().catch(() => setAuthed(false));
  }, []);

  // Phones start in day view — a 7-column week is unreadable at 390px.
  // "/?pane=tasks" (from another page's tab bar) opens the task pane directly.
  useEffect(() => {
    // One-time device check on mount; intentional single re-render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (window.matchMedia("(max-width: 720px)").matches) setView("day");
    if (new URLSearchParams(window.location.search).get("pane") === "tasks") setPane("tasks");
    if (localStorage.getItem("kairos-show-actual") === "1") setShowActual(true);
    // stale-while-revalidate: 前回のデータを即座に表示し、裏で reload() が置き換える。
    // authed も楽観的に true にして全面スピナーを飛ばす（未ログインなら /api/status が折り返す）。
    try {
      const c = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null") as CacheShape | null;
      if (c && Date.now() - (c.savedAt ?? 0) < 7 * 86_400_000) {
        setAccounts(c.accounts ?? []);
        setCalendars(c.calendars ?? []);
        setEvents(c.events ?? []);
        setLists(c.lists ?? []);
        setTasks(c.tasks ?? []);
        setActuals(c.actuals ?? []);
        setAuthed(true);
      }
    } catch { /* 壊れたキャッシュは無視 */ }
  }, []);
  const pickActual = (on: boolean) => {
    setShowActual(on);
    localStorage.setItem("kairos-show-actual", on ? "1" : "0");
    if (on && view === "month") setView("week"); // 実績 is a time-grid view
  };

  const reloadTasks = useCallback(async () => {
    const tk = await api("GET", "/api/tasks");
    setLists(tk.lists);
    setTasks(tk.tasks);
  }, []);

  const reload = useCallback(async () => {
    try {
      const [min, max] = rangeFor(view, anchor);
      // 5系統を並列に（以前は直列の滝で体感が重かった）
      const [evs, cals, lg, tk, st] = await Promise.all([
        api("GET", `/api/events?timeMin=${enc(min.toISOString())}&timeMax=${enc(max.toISOString())}`),
        api("GET", "/api/calendars"),
        api("GET", `/api/logs?timeMin=${enc(min.toISOString())}&timeMax=${enc(max.toISOString())}`),
        api("GET", "/api/tasks"),
        fetch("/api/status").then((r) => r.json()),
      ]);
      setEvents(evs);
      setCalendars(cals);
      setActuals(lg.logs || []);
      setLists(tk.lists);
      setTasks(tk.tasks);
      setAccounts(st.accounts || []);
      // 次回起動を即描画するためのキャッシュ (stale-while-revalidate)
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({
          accounts: st.accounts || [], calendars: cals, events: evs,
          lists: tk.lists, tasks: tk.tasks, actuals: lg.logs || [], savedAt: Date.now(),
        } satisfies CacheShape));
      } catch { /* 容量超過などは無視（表示には影響しない） */ }
    } catch (e) {
      if ((e as { unauth?: boolean })?.unauth) setAuthed(false);
      else console.error(e);
    }
  }, [view, anchor]);

  useEffect(() => {
    // Data-fetch effect: reload() awaits the network before any setState, so the
    // state updates are async, not the synchronous cascade this rule guards against.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (authed) void reload();
  }, [authed, reload]);

  /* ---------- navigation ---------- */
  function step(dir: number) {
    if (view === "month") setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + dir, 1));
    else if (view === "day") setAnchor(addDays(anchor, dir));
    else setAnchor(addDays(anchor, 7 * dir));
  }
  const goToDay = (d: Date) => { setView("day"); setAnchor(new Date(d)); };

  /* ---------- task ops ---------- */
  async function toggleDone(t: Task) {
    await api("PATCH", "/api/tasks", {
      account: t.account, tasklist: t.tasklist, id: t.id,
      status: t.status === "completed" ? "needsAction" : "completed",
    });
    await reloadTasks();
  }
  async function quickAddTask(list: ListMeta, title: string) {
    if (!title.trim()) return;
    try {
      await api("POST", "/api/tasks", { account: list.account, tasklist: list.id, title: title.trim() });
    } catch (e) {
      alert(`タスクを追加できませんでした: ${e}`);
      return;
    }
    await reloadTasks();
  }

  /* ---------- modal helpers ---------- */
  function openDetail(ev: Ev) { setModal({ kind: "detail", ev }); }
  function openEvent(ev?: Ev, presetStart?: Date) {
    let start: Date, end: Date, allDay = false;
    if (ev) {
      allDay = ev.allDay;
      if (allDay) { start = new Date(`${ev.start}T09:00`); end = addDays(new Date(`${ev.end}T00:00:00`), -1); end.setHours(10, 0, 0, 0); }
      else { start = new Date(ev.start); end = new Date(ev.end); }
    } else { start = presetStart || new Date(); end = new Date(start.getTime() + 3600000); }
    const first = calendars[0];
    setModal({
      kind: "event", isNew: !ev, ev,
      draft: {
        account: ev?.account || first?.account || "",
        calendarId: ev?.calendarId || first?.id || "",
        summary: ev?.summary || "",
        allDay, start: localInput(start), end: localInput(end),
        location: ev?.location || "", description: ev?.description || "",
      },
    });
  }
  function openNewTask(l: ListMeta, title = "") {
    setModal({
      kind: "task", isNew: true,
      draft: {
        account: l.account, tasklist: l.id, title,
        due: "", dueTime: "", notes: "", done: false,
        est: "", actual: "", difficulty: "", energy: "", remind: "",
      },
    });
  }
  function openTask(t: Task) {
    const numStr = (n: number | null | undefined) => (n != null ? String(n) : "");
    setModal({
      kind: "task", isNew: false,
      draft: {
        account: t.account, tasklist: t.tasklist, id: t.id, title: t.title,
        due: t.due ? ymd(new Date(t.due.slice(0, 10) + "T00:00:00")) : "",
        dueTime: t.dueTime || "", notes: t.notes || "", done: t.status === "completed",
        est: numStr(t.estimatedMin), actual: numStr(t.actualMin),
        difficulty: numStr(t.difficulty), energy: numStr(t.energy),
        remind: t.remindAt ? localInput(new Date(t.remindAt)) : "",
      },
    });
  }

  async function saveEvent() {
    if (modal?.kind !== "event") return;
    const d = modal.draft;
    const payload: Record<string, unknown> = {
      summary: d.summary, location: d.location, description: d.description, allDay: d.allDay,
    };
    if (d.allDay) { payload.start = ymd(new Date(d.start)); payload.end = ymd(addDays(new Date(d.end), 1)); }
    else { payload.start = toRFC3339(new Date(d.start)); payload.end = toRFC3339(new Date(d.end)); }
    if (modal.isNew) {
      if (!d.calendarId) { alert("カレンダーがありません"); return; }
      await api("POST", "/api/events", { ...payload, account: d.account, calendarId: d.calendarId });
    } else {
      await api("PATCH", "/api/events", { ...payload, account: d.account, calendarId: d.calendarId, id: modal.ev!.id });
    }
    setModal(null); await reload();
  }
  async function deleteEvent() {
    if (modal?.kind !== "event" || !modal.ev) return;
    const e = modal.ev;
    await api("DELETE", `/api/events?account=${enc(e.account)}&calendarId=${enc(e.calendarId)}&id=${enc(e.id)}`);
    setModal(null); await reload();
  }
  async function saveTask() {
    if (modal?.kind !== "task") return;
    const d = modal.draft;
    const num = (s: string) => (s && Number.isFinite(Number(s)) ? Math.round(Number(s)) : null);
    const fields = {
      title: d.title, notes: d.notes, due: d.due || null, dueTime: d.dueTime || null,
      estimatedMin: num(d.est), actualMin: num(d.actual),
      difficulty: num(d.difficulty), energy: num(d.energy),
      remindAt: d.remind ? Date.parse(d.remind) : null,
    };
    try {
      if (modal.isNew) {
        await api("POST", "/api/tasks", { ...fields, account: d.account, tasklist: d.tasklist });
      } else {
        await api("PATCH", "/api/tasks", {
          ...fields, account: d.account, tasklist: d.tasklist, id: d.id,
          status: d.done ? "completed" : "needsAction",
        });
      }
    } catch (e) {
      alert(`タスクを保存できませんでした: ${e}`);
      return;
    }
    setModal(null); await reloadTasks();
  }
  async function deleteTask() {
    if (modal?.kind !== "task") return;
    const d = modal.draft;
    await api("DELETE", `/api/tasks?account=${enc(d.account)}&tasklist=${enc(d.tasklist)}&id=${enc(d.id!)}`);
    setModal(null); await reloadTasks();
  }
  async function disconnect(email: string) {
    if (!confirm(`${email} を切断しますか？`)) return;
    await api("DELETE", `/api/accounts?email=${enc(email)}`);
    setModal(null); await reload();
  }

  /* ---------- derived ---------- */
  const tasksDue = (day: Date) =>
    tasks.filter((t) => { const dd = taskDueDate(t); return dd && sameDay(dd, day); });

  // timed items for a day column: timed events + tasks that have a time-of-day
  function dayTimed(day: Date) {
    const out: { key: string; color: string; label: string; s: number; e: number; isTask: boolean; done: boolean; onClick: () => void }[] = [];
    for (const ev of events) {
      if (ev.allDay) continue;
      const s = new Date(ev.start);
      if (!sameDay(s, day)) continue;
      const e = new Date(ev.end);
      const sm = s.getHours() * 60 + s.getMinutes();
      const em = Math.max(e.getHours() * 60 + e.getMinutes(), sm + 20);
      out.push({ key: `e:${ev.account}:${ev.id}`, color: ev.color || "#4285f4", label: ev.summary, s: sm, e: em, isTask: false, done: false, onClick: () => openDetail(ev) });
    }
    for (const t of tasks) {
      const dd = taskDueDate(t);
      if (!dd || !sameDay(dd, day) || !t.dueTime) continue;
      const sm = minsOf(t.dueTime);
      out.push({ key: `t:${t.account}:${t.id}`, color: acctColor(t.account), label: t.title || "(無題)", s: sm, e: sm + 30, isTask: true, done: t.status === "completed", onClick: () => openTask(t) });
    }
    return out;
  }

  // 裏カレンダー: logs clamped to this day's 0–1440 minute window
  // (sleep crosses midnight, so one log can paint blocks on two days).
  function dayActuals(day: Date) {
    const dayStart = startOfDay(day).getTime();
    const out: { key: string; color: string; label: string; s: number; e: number; isTask: boolean; done: boolean; onClick: () => void }[] = [];
    const COLOR: Record<string, string> = {
      sleep: "#748ffc", work: "#1fae83", activity: "#69db7c",
      meal: "#f2c14e", trip: "#b197fc", note: "#8a94a3",
    };
    const EMOJI: Record<string, string> = {
      sleep: "😴", meal: "🍙", work: "💻", trip: "🧳", activity: "🏃",
      move: "🚃", chore: "🧺", dopa: "📱", r18: "🔞", note: "📝",
    };
    for (const l of actuals) {
      if (l.startMs == null || l.endMs == null) continue;
      const s = Math.max(0, Math.round((l.startMs - dayStart) / 60000));
      const e = Math.min(1440, Math.round((l.endMs - dayStart) / 60000));
      if (e <= 0 || s >= 1440 || e - s < 5) continue;
      out.push({
        key: `${l.id}:${dayStart}`,
        color: COLOR[l.kind] ?? "#8a94a3",
        label: `${EMOJI[l.kind] ?? "・"} ${l.title || l.kind}`,
        s, e: Math.max(e, s + 20), isTask: false, done: false,
        onClick: () => { window.location.href = "/logs"; },
      });
    }
    return out;
  }

  if (authed === null) return <div className="center"><p>読み込み中…</p></div>;
  if (authed === false) {
    return (
      <div className="center">
        <h1>Kairos</h1>
        <p>Google アカウントに接続してください。</p>
        <button className="btn btn-primary" onClick={() => signIn("google")}>Google で接続</button>
      </div>
    );
  }

  const rangeLabel =
    view === "month" ? `${anchor.getFullYear()}年${anchor.getMonth() + 1}月`
    : view === "day" ? `${anchor.getFullYear()}年${anchor.getMonth() + 1}月${anchor.getDate()}日 (${WD[anchor.getDay()]})`
    : (() => { const ds = viewDays(view, anchor); const a = ds[0], b = ds[6]; return `${a.getFullYear()}年${a.getMonth() + 1}月${a.getDate()}日 – ${b.getMonth() + 1}月${b.getDate()}日`; })();

  return (
    <div className="app">
      <Dock />
      <div className="main">
      <div className="topbar">
        <span className="brand">Kairos</span>
        <div className="range">{rangeLabel}</div>
        <div className="brk" />
        <div className="nav">
          <button onClick={() => step(-1)} title="前へ">‹</button>
          <button onClick={() => setAnchor(new Date())}>今日</button>
          <button onClick={() => step(1)} title="次へ">›</button>
        </div>
        <div className="seg">
          {(["month", "week", "day"] as View[]).map((v) => (
            <button key={v} className={view === v ? "on" : ""} onClick={() => { setView(v); if (v === "month") pickActual(false); }}>
              {v === "month" ? "月" : v === "week" ? "週" : "日"}
            </button>
          ))}
        </div>
        <div className="seg" title="表＝Google の予定 / 裏＝実際にやったこと（記録）">
          <button className={!showActual ? "on" : ""} onClick={() => pickActual(false)}>予定</button>
          <button className={showActual ? "on" : ""} onClick={() => pickActual(true)}>実績</button>
        </div>
        <div className="spacer" />
        <button className="btn btn-primary desktop-only" onClick={() => openEvent()}><PlusIcon size={15} />予定</button>
        <button className="btn" onClick={reload} title="再読み込み"><RefreshIcon size={16} /></button>
        <button className="who" onClick={() => setModal({ kind: "accounts" })} title="アカウント">
          {accounts.map((a) => <span key={a.email} className="dot" style={{ background: a.color || "#888" }} />)}
          <span className="who-label">{accounts.length === 1 ? accounts[0].email : accounts.length ? `${accounts.length} アカウント` : "接続なし"}</span>
        </button>
      </div>

      <div className={`body${pane === "tasks" ? " show-tasks" : ""}`}>
        <div className="cal">
          {view === "month"
            ? <MonthView anchor={anchor} events={events} tasksDue={tasksDue} acctColor={acctColor} onDay={goToDay} onEvent={openDetail} onTask={openTask} />
            : <TimeView view={view} anchor={anchor}
                events={showActual ? [] : events}
                tasksDue={showActual ? () => [] : tasksDue}
                dayTimed={showActual ? dayActuals : dayTimed}
                onEvent={openDetail} onTask={openTask}
                onSlot={showActual ? () => {} : (d) => openEvent(undefined, d)} />}
        </div>
        <TasksRail
          lists={lists} tasks={tasks} multi={accounts.length > 1} acctColor={acctColor}
          onToggle={toggleDone} onOpen={openTask} onAdd={quickAddTask} onAddDetail={openNewTask}
        />
      </div>
      </div>

      <button className="fab" onClick={() => openEvent()} title="予定を追加"><PlusIcon size={26} /></button>
      <MobileTabs pane={pane} onPane={setPane} />

      {modal?.kind === "detail" && <DetailModal ev={modal.ev} calendars={calendars} accounts={accounts} onClose={() => setModal(null)} onEdit={() => openEvent(modal.ev)} />}
      {modal?.kind === "event" && (
        <EventModal
          modal={modal} calendars={calendars}
          set={(patch) => setModal((m) => (m?.kind === "event" ? { ...m, draft: { ...m.draft, ...patch } } : m))}
          onSave={saveEvent} onDelete={deleteEvent} onClose={() => setModal(null)}
        />
      )}
      {modal?.kind === "task" && (
        <TaskModal
          isNew={modal.isNew}
          draft={modal.draft}
          set={(patch) => setModal((m) => (m?.kind === "task" ? { ...m, draft: { ...m.draft, ...patch } } : m))}
          subtasks={tasks.filter((t) => t.account === modal.draft.account && t.tasklist === modal.draft.tasklist && t.parent === modal.draft.id)}
          onToggleSub={(t) => void toggleDone(t)}
          onOpenSub={(t) => openTask(t)}
          onAddSub={(title) => {
            const d = modal.draft;
            if (!title.trim() || !d.id) return;
            void api("POST", "/api/tasks", { account: d.account, tasklist: d.tasklist, title: title.trim(), parent: d.id })
              .then(reloadTasks)
              .catch((e) => alert(`サブタスクを追加できませんでした: ${e}`));
          }}
          onSave={saveTask} onDelete={deleteTask} onClose={() => setModal(null)}
          onChat={() => {
            const d = modal.draft;
            if (d.id) setModal({ kind: "chat", taskKey: `${d.account}|${d.tasklist}|${d.id}`, taskTitle: d.title });
          }}
          onEstimate={() => {
            const d = modal.draft;
            if (d.id) setModal({
              kind: "chat", taskKey: `${d.account}|${d.tasklist}|${d.id}`, taskTitle: d.title,
              autoMessage: "このタスクの所要時間を、私の見積り実績とライフログ（調子）から見積もって、estimatedMin を更新する提案を出して。あわせて期限までの空き時間から作業枠の候補を予定作成の提案として1〜2個出して。理由も一言添えて。",
            });
          }}
        />
      )}
      {modal?.kind === "chat" && (
        <ChatModal taskKey={modal.taskKey} taskTitle={modal.taskTitle} autoMessage={modal.autoMessage} onClose={() => setModal(null)} onExecuted={() => void reload()} />
      )}
      {modal?.kind === "accounts" && (
        <AccountsModal accounts={accounts} onClose={() => setModal(null)} onDisconnect={disconnect} onSignOut={() => signOut()} />
      )}
    </div>
  );
}

/* =============================================================== time view */
function packColumns<T extends { s: number; e: number }>(items: T[]) {
  const sorted = items.slice().sort((a, b) => a.s - b.s || a.e - b.e);
  const out: { item: T; col: number; ncols: number }[] = [];
  let cluster: T[] = [], clusterEnd = -1;
  const flush = () => {
    const cols: number[] = [];
    const placed = cluster.map((it) => {
      let c = 0; while (cols[c] !== undefined && cols[c] > it.s) c++;
      cols[c] = it.e; return { item: it, col: c };
    });
    const n = cols.length;
    placed.forEach((p) => out.push({ ...p, ncols: n }));
    cluster = []; clusterEnd = -1;
  };
  for (const it of sorted) {
    if (cluster.length && it.s >= clusterEnd) flush();
    cluster.push(it); clusterEnd = Math.max(clusterEnd, it.e);
  }
  if (cluster.length) flush();
  return out;
}

function TimeView(props: {
  view: View; anchor: Date; events: Ev[];
  tasksDue: (d: Date) => Task[];
  dayTimed: (d: Date) => { key: string; color: string; label: string; s: number; e: number; isTask: boolean; done: boolean; onClick: () => void }[];
  onEvent: (e: Ev) => void; onTask: (t: Task) => void; onSlot: (d: Date) => void;
}) {
  const { view, anchor, events, tasksDue, dayTimed, onEvent, onTask, onSlot } = props;
  const ds = viewDays(view, anchor);
  const cols = `var(--gutter) repeat(${ds.length},1fr)`;
  const now = new Date();

  return (
    <>
      <div className="dayhead" style={{ gridTemplateColumns: cols }}>
        <div className="corner" />
        {ds.map((d) => {
          const wd = d.getDay();
          return (
            <div key={+d} className={`dh ${wd === 6 ? "sat" : wd === 0 ? "sun" : ""} ${sameDay(d, now) ? "today" : ""}`}>
              <div className="wd">{WD[wd]}</div>
              <div className="dn">{d.getDate()}</div>
            </div>
          );
        })}
      </div>

      <div className="allday" style={{ gridTemplateColumns: cols }}>
        <div className="lbl">終日</div>
        {ds.map((d) => (
          <div key={+d} className="ad-col">
            {events.filter((e) => e.allDay).map((e) => {
              const s = new Date(`${e.start}T00:00:00`), en = new Date(`${e.end}T00:00:00`);
              if (!(d >= s && d < en)) return null;
              return <div key={`${e.account}:${e.id}`} className="chip" style={{ background: e.color || "#4285f4", color: inkFor(e.color || "#4285f4") }} onClick={() => onEvent(e)}>{e.summary}</div>;
            })}
            {tasksDue(d).filter((t) => !t.dueTime).map((t) => (
              <div key={`${t.account}:${t.id}`} className={`chip task${t.status === "completed" ? " done" : ""}`} onClick={() => onTask(t)}>
                <span>✓</span>{t.title || "(無題)"}
              </div>
            ))}
          </div>
        ))}
      </div>

      <div className="gridwrap" ref={(el) => { if (el && !el.dataset.scrolled) { el.scrollTop = 8 * HOUR_H; el.dataset.scrolled = "1"; } }}>
        <div className="grid" style={{ gridTemplateColumns: cols }}>
          <div className="gutter">
            {Array.from({ length: HOURS }, (_, h) => (
              <div key={h} className="hr">{h > 0 && <span>{pad(h)}:00</span>}</div>
            ))}
          </div>
          {ds.map((d) => {
            const packed = packColumns(dayTimed(d));
            return (
              <div key={+d} className="col">
                {Array.from({ length: HOURS }, (_, h) => (
                  <div key={h} className="hr" onClick={() => { const s = new Date(d); s.setHours(h, 0, 0, 0); onSlot(s); }} />
                ))}
                {packed.map(({ item, col, ncols }) => (
                  <div
                    key={item.key}
                    className={`ev${item.isTask ? " taskev" : ""}${item.done ? " done" : ""}`}
                    style={{
                      top: `${item.s / 60 * HOUR_H}px`,
                      height: `${(item.e - item.s) / 60 * HOUR_H - 2}px`,
                      left: `calc(${col / ncols * 100}% + 1px)`,
                      width: `calc(${100 / ncols}% - 3px)`,
                      background: item.isTask ? undefined : item.color,
                      color: item.isTask ? undefined : inkFor(item.color),
                    }}
                    onClick={(ev) => { ev.stopPropagation(); item.onClick(); }}
                  >
                    <div className="t">{item.isTask ? `✓ ${item.label}` : item.label}</div>
                    <div className="time">{pad(Math.floor(item.s / 60))}:{pad(item.s % 60)}</div>
                  </div>
                ))}
                {sameDay(d, now) && (
                  <div className="nowline" style={{ top: `${(now.getHours() * 60 + now.getMinutes()) / 60 * HOUR_H}px` }} />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

/* ============================================================== month view */
function MonthView(props: {
  anchor: Date; events: Ev[]; tasksDue: (d: Date) => Task[]; acctColor: (e: string) => string;
  onDay: (d: Date) => void; onEvent: (e: Ev) => void; onTask: (t: Task) => void;
}) {
  const { anchor, events, tasksDue, onDay, onEvent, onTask } = props;
  const gs = startOfWeek(new Date(anchor.getFullYear(), anchor.getMonth(), 1));
  const mo = anchor.getMonth();
  const now = new Date();
  const LIMIT = 4;

  return (
    <div className="month">
      <div className="wdrow">{WD_MON.map((x) => <div key={x}>{x}</div>)}</div>
      <div className="cells">
        {Array.from({ length: 42 }, (_, i) => {
          const d = addDays(gs, i);
          type Item = { key: string; sort: number; node: ReactNode };
          const items: Item[] = [];
          events.filter((e) => e.allDay).forEach((e) => {
            const s = new Date(`${e.start}T00:00:00`), en = new Date(`${e.end}T00:00:00`);
            if (d >= s && d < en) items.push({ key: `a:${e.account}:${e.id}`, sort: -1, node: <div className="mchip" style={{ background: e.color || "#4285f4", color: inkFor(e.color || "#4285f4") }} onClick={(ev) => { ev.stopPropagation(); onEvent(e); }}>{e.summary}</div> });
          });
          events.filter((e) => !e.allDay).forEach((e) => {
            const s = new Date(e.start);
            if (!sameDay(s, d)) return;
            items.push({ key: `e:${e.account}:${e.id}`, sort: s.getHours() * 60 + s.getMinutes(), node: <div className="mchip" style={{ background: e.color || "#4285f4", color: inkFor(e.color || "#4285f4") }} onClick={(ev) => { ev.stopPropagation(); onEvent(e); }}><span className="mt">{pad(s.getHours())}:{pad(s.getMinutes())}</span>{e.summary}</div> });
          });
          tasksDue(d).forEach((t) => {
            const sort = t.dueTime ? minsOf(t.dueTime) : 1e6;
            items.push({ key: `t:${t.account}:${t.id}`, sort, node: <div className={`mchip task${t.status === "completed" ? " done" : ""}`} onClick={(ev) => { ev.stopPropagation(); onTask(t); }}>✓ {t.title || "(無題)"}</div> });
          });
          items.sort((a, b) => a.sort - b.sort);
          return (
            <div key={+d} className={`mcell${d.getMonth() !== mo ? " dim" : ""}${sameDay(d, now) ? " today" : ""}`}
                 onClick={(e) => { if (e.target === e.currentTarget) onDay(d); }}>
              <div className="mnum" onClick={(e) => { e.stopPropagation(); onDay(d); }}>{d.getDate()}</div>
              {items.slice(0, LIMIT).map((it) => <div key={it.key}>{it.node}</div>)}
              {items.length > LIMIT && <div className="mmore" onClick={(e) => { e.stopPropagation(); onDay(d); }}>+{items.length - LIMIT} 件</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* =============================================================== tasks rail */
function TasksRail(props: {
  lists: ListMeta[]; tasks: Task[]; multi: boolean; acctColor: (e: string) => string;
  onToggle: (t: Task) => void; onOpen: (t: Task) => void; onAdd: (l: ListMeta, title: string) => void;
  onAddDetail: (l: ListMeta, title: string) => void;
}) {
  const { lists, tasks, multi, acctColor, onToggle, onOpen, onAdd, onAddDetail } = props;
  const now = startOfDay(new Date());
  const [byDue, setByDue] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (localStorage.getItem("kairos-task-sort") === "due") setByDue(true);
  }, []);
  const toggle = () => setByDue((v) => { localStorage.setItem("kairos-task-sort", v ? "manual" : "due"); return !v; });
  return (
    <div className="rail">
      <div className="railhead">
        <h2>タスク</h2>
        <div className="spacer" />
        <button className={`sortbtn${byDue ? " on" : ""}`} onClick={toggle}
          title={byDue ? "締切順で表示中（クリックで手動並びに戻す）" : "締切順に並べ替え"}>
          {byDue ? "⏰ 締切順" : "↕ 並べ替え"}
        </button>
      </div>
      {lists.map((l) => (
        <TList
          key={`${l.account}|${l.id}`}
          list={l}
          items={tasks.filter((t) => t.account === l.account && t.tasklist === l.id)}
          multi={multi} acctColor={acctColor} now={now} byDue={byDue}
          onToggle={onToggle} onOpen={onOpen} onAdd={onAdd} onAddDetail={onAddDetail}
        />
      ))}
    </div>
  );
}

/** One task list: add row on top, open tasks, completed behind a fold. */
function TList(props: {
  list: ListMeta; items: Task[]; multi: boolean; acctColor: (e: string) => string; now: Date; byDue: boolean;
  onToggle: (t: Task) => void; onOpen: (t: Task) => void; onAdd: (l: ListMeta, title: string) => void;
  onAddDetail: (l: ListMeta, title: string) => void;
}) {
  const { list: l, items, multi, acctColor, now, byDue, onToggle, onOpen, onAdd, onAddDetail } = props;
  const [showDone, setShowDone] = useState(false);
  const byDone = (a: Task, b: Task) => Number(a.status === "completed") - Number(b.status === "completed");
  // 締切順: 早い順、時刻はタイブレーク、期限なしは末尾
  const dueKey = (t: Task) => (t.due ? `${t.due.slice(0, 10)}T${t.dueTime ?? "23:59"}` : "9999-99-99");
  const byDueSort = (a: Task, b: Task) => dueKey(a) < dueKey(b) ? -1 : dueKey(a) > dueKey(b) ? 1 : 0;
  const sortActive = <T extends Task>(arr: T[]) => (byDue ? arr.slice().sort(byDueSort) : arr);
  const parents = items.filter((t) => !t.parent);
  const active = sortActive(parents.filter((t) => t.status !== "completed"));
  const done = parents.filter((t) => t.status === "completed");
  const kidsOf = (id: string) => sortActive(items.filter((t) => t.parent === id).sort(byDone));
  const row = (t: Task, sub: boolean) => {
    const isDone = t.status === "completed";
    const dd = taskDueDate(t);
    const over = dd && !isDone && dd < now;
    return (
      <div key={`${t.account}:${t.id}`} className={`task${isDone ? " done" : ""}${sub ? " sub" : ""}`}>
        <div className={`cbox${isDone ? " on" : ""}`} onClick={() => onToggle(t)} />
        <div className="body2" onClick={() => onOpen(t)}>
          <div className="title">{t.title || "(無題)"}</div>
          {dd && <div className={`due${over ? " over" : ""}`}>{dd.getMonth() + 1}/{dd.getDate()}{t.dueTime ? ` ${t.dueTime}` : ""}</div>}
        </div>
      </div>
    );
  };
  return (
    <div className="tlist">
      <div className="name">
        {multi && <span className="dot" style={{ background: acctColor(l.account) }} />}
        {l.title}
      </div>
      <AddRow onAdd={(v) => onAdd(l, v)} onDetail={(v) => onAddDetail(l, v)} />
      {active.map((t) => [row(t, false), ...kidsOf(t.id).map((c) => row(c, true))])}
      {done.length > 0 && (
        <>
          <button className="donetoggle" onClick={() => setShowDone((s) => !s)}>
            {showDone ? "▾" : "▸"} 完了済み {done.length}件
          </button>
          {showDone && done.map((t) => [row(t, false), ...kidsOf(t.id).map((c) => row(c, true))])}
        </>
      )}
    </div>
  );
}

function AddRow({ onAdd, onDetail, placeholder }: {
  onAdd: (v: string) => void; onDetail?: (v: string) => void; placeholder?: string;
}) {
  const [v, setV] = useState("");
  const go = () => { onAdd(v); setV(""); };
  return (
    <div className="addrow">
      <input placeholder={placeholder ?? "タスクを追加"} value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") go(); }} />
      {onDetail && (
        <button onClick={() => { onDetail(v); setV(""); }} title="期限・時刻・通知などを付けて追加">詳細</button>
      )}
      <button onClick={go} title="タイトルだけで追加">+</button>
    </div>
  );
}

/* =================================================================== modals */
function Scrim({ children, onClose, wide }: { children: ReactNode; onClose: () => void; wide?: boolean }) {
  return <div className="scrim" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}><div className={wide ? "modal wide" : "modal"}>{children}</div></div>;
}

function fmtAllDay(e: Ev) {
  const s = new Date(`${e.start}T00:00:00`), en = addDays(new Date(`${e.end}T00:00:00`), -1);
  return sameDay(s, en) ? `${s.getMonth() + 1}/${s.getDate()} 終日` : `${s.getMonth() + 1}/${s.getDate()} – ${en.getMonth() + 1}/${en.getDate()} 終日`;
}
function fmtTimed(e: Ev) {
  const s = new Date(e.start), en = new Date(e.end);
  const t = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const date = `${s.getMonth() + 1}/${s.getDate()} (${WD[s.getDay()]})`;
  return sameDay(s, en) ? `${date} ${t(s)}–${t(en)}` : `${date} ${t(s)} – ${en.getMonth() + 1}/${en.getDate()} ${t(en)}`;
}

/** The event's notes: list + audio upload (transcribe→summarize pipeline). */
function EventNotes({ ev }: { ev: Ev }) {
  const eventKey = `${ev.account}|${ev.calendarId}|${ev.id}`;
  const eventLabel = `${ev.summary} ${ev.allDay ? fmtAllDay(ev) : fmtTimed(ev)}`;
  const [items, setItems] = useState<{ id: string; title: string; status: string; hasAudio: boolean }[]>([]);
  const matRef = useRef<HTMLInputElement>(null);
  const [matMsg, setMatMsg] = useState<string | null>(null);

  // 資料追加: この予定の棚（講義: <予定名>）へRAG登録
  const uploadMaterials = useCallback(async (files: FileList) => {
    setMatMsg("登録中…");
    try {
      const fd = new FormData();
      for (const f of Array.from(files)) fd.append("files", f);
      fd.append("eventKey", eventKey);
      const r = await fetch("/api/materials", { method: "POST", body: fd });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail ?? `HTTP ${r.status}`);
      setMatMsg(d.errors?.length ? `⚠ ${d.errors[0]}` : `✓ ${d.created.length}件を資料に追加`);
    } catch (e) {
      setMatMsg(`⚠ ${String(e).slice(0, 120)}`);
    } finally {
      if (matRef.current) matRef.current.value = "";
    }
  }, [eventKey]);

  const reload = useCallback(async () => {
    const r = await api("GET", `/api/notes?eventKey=${enc(eventKey)}`);
    setItems(r.notes || []);
  }, [eventKey]);

  useEffect(() => {
    // fetch-then-set — false positive for this rule.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload().catch(() => {});
  }, [reload]);

  // poll while the pipeline runs so the status label updates in place
  useEffect(() => {
    if (!items.some((n) => n.status === "transcribing" || n.status === "summarizing")) return;
    const t = setInterval(() => void reload().catch(() => {}), 5000);
    return () => clearInterval(t);
  }, [items, reload]);

  return (
    <div className="det-row"><span className="k">ノート</span><span className="v">
      {items.map((n) => (
        <div key={n.id}>
          <a href={`/notes?open=${n.id}`}>
            {n.hasAudio ? "🎙" : "📝"} {n.title}
            {n.status === "transcribing" ? "（文字起こし中…）"
              : n.status === "summarizing" ? "（ノート作成中…）"
              : n.status === "error" ? "（エラー）" : ""}
          </a>
        </div>
      ))}
      <AudioUpload compact eventKey={eventKey} eventLabel={eventLabel} onStarted={() => void reload()} />
      <div style={{ marginTop: 4 }}>
        <button className="btn" onClick={() => matRef.current?.click()}>📚 資料を追加</button>
        <input
          ref={matRef} type="file" hidden multiple
          accept=".pdf,.docx,.pptx,.xlsx,.csv,.txt,.md,.html"
          onChange={(e) => { if (e.target.files?.length) void uploadMaterials(e.target.files); }}
        />
        {matMsg && <span className="lmeta" style={{ marginLeft: 8 }}>{matMsg}</span>}
      </div>
    </span></div>
  );
}

function DetailModal({ ev, calendars, accounts, onClose, onEdit }: { ev: Ev; calendars: Cal[]; accounts: Account[]; onClose: () => void; onEdit: () => void }) {
  const cal = calendars.find((c) => c.account === ev.account && c.id === ev.calendarId);
  const acct = accounts.find((a) => a.email === ev.account);
  const rs = (r?: string) => ({ accepted: ["ok", "✓"], declined: ["no", "✕"], tentative: ["maybe", "?"] } as Record<string, string[]>)[r || ""] || ["", "・"];

  // not for me: この予定のタイトルを通知ミュート（朝ブリーフィング・ナッジ除外）に出し入れ
  const [muteKeys, setMuteKeys] = useState<string[] | null>(null);
  useEffect(() => {
    api("GET", "/api/notify").then((r) => setMuteKeys(r.mute ?? [])).catch(() => setMuteKeys([]));
  }, []);
  const norm = (s: string) => s.normalize("NFKC").toLowerCase();
  const evTitle = (ev.summary ?? "").trim();
  const mutedBy = (muteKeys ?? []).filter((k) => evTitle && norm(evTitle).includes(norm(k)));
  const toggleMute = async () => {
    if (muteKeys === null || !evTitle) return;
    const next = mutedBy.length > 0 ? muteKeys.filter((k) => !mutedBy.includes(k)) : [...muteKeys, evTitle];
    try {
      const r = await api("PUT", "/api/notify", { mute: next });
      setMuteKeys(r.mute ?? next);
    } catch { /* 保存失敗 — ボタン再押下で再試行 */ }
  };

  return (
    <Scrim onClose={onClose}>
      <div className="det-title"><span className="det-bar" style={{ background: ev.color || "#4285f4" }} /><span>{ev.summary}</span></div>
      <div style={{ marginTop: 10 }}>
        <div className="det-row"><span className="k">日時</span><span className="v">{ev.allDay ? fmtAllDay(ev) : fmtTimed(ev)}</span></div>
        {(cal || acct) && <div className="det-row"><span className="k">予定表</span><span className="v"><span className="acct-pill"><span className="dot" style={{ background: ev.color || "#4285f4" }} />{cal?.summary || ""}{acct ? ` · ${acct.email}` : ""}</span></span></div>}
        {ev.location && <div className="det-row"><span className="k">場所</span><span className="v">{ev.location}</span></div>}
        {ev.meet && <div className="det-row"><span className="k">通話</span><span className="v"><a href={ev.meet} target="_blank" rel="noopener noreferrer">{ev.meet}</a></span></div>}
        {ev.description && <div className="det-row"><span className="k">詳細</span><span className="v">{ev.description}</span></div>}
        {ev.attendees?.length > 0 && (
          <div className="det-row"><span className="k">参加者</span><span className="v">
            {ev.attendees.map((a, i) => { const [c, g] = rs(a.response); return <div key={i} className="att"><span className={`rs ${c}`}>{g}</span><span>{a.name || a.email}{a.organizer ? " (主催)" : ""}</span></div>; })}
          </span></div>
        )}
        {ev.attachments?.length > 0 && (
          <div className="det-row"><span className="k">添付</span><span className="v">
            {ev.attachments.map((a, i) => <div key={i}><a href={a.url} target="_blank" rel="noopener noreferrer">{a.title || a.url}</a></div>)}
          </span></div>
        )}
        <EventNotes ev={ev} />
      </div>
      <div className="modal-foot" style={{ marginTop: 14 }}>
        {ev.htmlLink && <a className="btn" href={ev.htmlLink} target="_blank" rel="noopener noreferrer">Google で開く</a>}
        <button className="btn" disabled={muteKeys === null || !evTitle}
          title={mutedBy.length > 0
            ? `通知ミュート中（キーワード: ${mutedBy.join(", ")}）— 押すと解除`
            : "この予定のタイトルを通知ミュートに追加 — 朝ブリーフィングや期限ナッジに出なくなります"}
          onClick={() => void toggleMute()}>
          {muteKeys === null ? "…" : mutedBy.length > 0 ? "🔕 ミュート中" : "🔕 not for me"}
        </button>
        <div className="spacer" />
        <button className="btn" onClick={onEdit}>編集</button>
        <button className="btn btn-primary" onClick={onClose}>閉じる</button>
      </div>
    </Scrim>
  );
}

function EventModal({ modal, calendars, set, onSave, onDelete, onClose }: {
  modal: Extract<Modal, { kind: "event" }>; calendars: Cal[];
  set: (p: Partial<EventDraft>) => void; onSave: () => void; onDelete: () => void; onClose: () => void;
}) {
  const d = modal.draft;
  const calIdx = calendars.findIndex((c) => c.account === d.account && c.id === d.calendarId);
  return (
    <Scrim onClose={onClose}>
      <h3>{modal.isNew ? "予定を追加" : "予定を編集"}</h3>
      <div className="field"><label>タイトル</label><input value={d.summary} onChange={(e) => set({ summary: e.target.value })} /></div>
      <div className="field"><label>カレンダー</label>
        <select value={calIdx} disabled={!modal.isNew} onChange={(e) => { const c = calendars[+e.target.value]; if (c) set({ account: c.account, calendarId: c.id }); }}>
          {calendars.map((c, i) => <option key={`${c.account}:${c.id}`} value={i}>{c.account} — {c.summary}</option>)}
        </select>
      </div>
      <div className="chk" style={{ marginBottom: 10 }}><input type="checkbox" checked={d.allDay} onChange={(e) => set({ allDay: e.target.checked })} /><label style={{ margin: 0 }}>終日</label></div>
      <div className="row2">
        <div className="field"><label>開始</label><input type="datetime-local" value={d.start} onChange={(e) => set({ start: e.target.value })} /></div>
        <div className="field"><label>終了</label><input type="datetime-local" value={d.end} onChange={(e) => set({ end: e.target.value })} /></div>
      </div>
      <div className="field"><label>場所</label><input value={d.location} onChange={(e) => set({ location: e.target.value })} /></div>
      <div className="field"><label>詳細</label><textarea value={d.description} onChange={(e) => set({ description: e.target.value })} /></div>
      <div className="modal-foot">
        {!modal.isNew && <button className="link-danger" onClick={onDelete}>削除</button>}
        <div className="spacer" />
        <button className="btn" onClick={onClose}>キャンセル</button>
        <button className="btn btn-primary" onClick={onSave}>保存</button>
      </div>
    </Scrim>
  );
}

function TaskModal({ isNew, draft, set, subtasks, onToggleSub, onOpenSub, onAddSub, onSave, onDelete, onClose, onChat, onEstimate }: {
  isNew: boolean; draft: TaskDraft; set: (p: Partial<TaskDraft>) => void;
  subtasks: Task[]; onToggleSub: (t: Task) => void; onOpenSub: (t: Task) => void; onAddSub: (title: string) => void;
  onSave: () => void; onDelete: () => void; onClose: () => void; onChat: () => void; onEstimate: () => void;
}) {
  const levels = ["", "1", "2", "3", "4", "5"];
  const subDone = subtasks.filter((s) => s.status === "completed").length;
  return (
    <Scrim onClose={onClose}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <h3 style={{ margin: 0, flex: 1 }}>{isNew ? "タスクを追加" : "タスクを編集"}</h3>
        {!isNew && <>
          <button className="btn" onClick={onEstimate} title="AIに所要時間の見積りと作業枠の配置を提案させる"><ClockIcon size={15} />AIで見積り</button>
          <button className="btn" onClick={onChat} title="このタスクをAIに相談"><BotIcon size={15} />AIに相談</button>
        </>}
      </div>
      <div className="field"><label>タイトル</label><input value={draft.title} onChange={(e) => set({ title: e.target.value })} /></div>
      <div className="row2">
        <div className="field"><label>期限（日付）</label><input type="date" value={draft.due} onChange={(e) => set({ due: e.target.value })} /></div>
        <div className="field"><label>時刻</label><input type="time" value={draft.dueTime} onChange={(e) => set({ dueTime: e.target.value })} disabled={!draft.due} /></div>
      </div>
      <div className="hint">時刻は Kairos のみで保持（Google Tasks は日付しか持てない）。スマホの Google には出ません。</div>
      <div className="field"><label>リマインド通知（ntfy）</label><input type="datetime-local" value={draft.remind} onChange={(e) => set({ remind: e.target.value })} /></div>
      <div className="field"><label>メモ</label><textarea value={draft.notes} onChange={(e) => set({ notes: e.target.value })} /></div>
      {draft.id && (
        <div className="subsec">
          <div className="subhead">
            <label>サブタスク</label>
            {subtasks.length > 0 && <span className="subprog">{subDone} / {subtasks.length}</span>}
          </div>
          {subtasks.length > 0 && (
            <div className="subbar"><div className="subfill" style={{ width: `${Math.round((subDone / subtasks.length) * 100)}%` }} /></div>
          )}
          {subtasks.map((s) => {
            const done = s.status === "completed";
            return (
              <div key={`${s.account}:${s.id}`} className={`task${done ? " done" : ""}`}>
                <div className={`cbox${done ? " on" : ""}`} onClick={() => onToggleSub(s)} />
                <div className="body2" onClick={() => onOpenSub(s)}>
                  <div className="title">{s.title || "(無題)"}</div>
                </div>
              </div>
            );
          })}
          <AddRow onAdd={onAddSub} placeholder="サブタスクを追加（GitHubのsub-issue風）" />
        </div>
      )}
      <div className="row2">
        <div className="field"><label>見積り（分）</label><input type="number" min={1} value={draft.est} onChange={(e) => set({ est: e.target.value })} /></div>
        <div className="field"><label>実績（分）</label><input type="number" min={1} value={draft.actual} onChange={(e) => set({ actual: e.target.value })} /></div>
      </div>
      <div className="row2">
        <div className="field"><label>難易度（1-5）</label>
          <select value={draft.difficulty} onChange={(e) => set({ difficulty: e.target.value })}>
            {levels.map((v) => <option key={v} value={v}>{v || "—"}</option>)}
          </select>
        </div>
        <div className="field"><label>エネルギー（1-5）</label>
          <select value={draft.energy} onChange={(e) => set({ energy: e.target.value })}>
            {levels.map((v) => <option key={v} value={v}>{v || "—"}</option>)}
          </select>
        </div>
      </div>
      <div className="hint">完了時に実績（かかった分数）を記録すると、AIの見積りがあなた仕様に較正されていきます。</div>
      {!isNew && (
        <div className="chk" style={{ marginBottom: 12 }}><input type="checkbox" checked={draft.done} onChange={(e) => set({ done: e.target.checked })} /><label style={{ margin: 0 }}>完了</label></div>
      )}
      <div className="modal-foot">
        {!isNew && <button className="link-danger" onClick={onDelete}>削除</button>}
        <div className="spacer" />
        <button className="btn" onClick={onClose}>キャンセル</button>
        <button className="btn btn-primary" onClick={onSave}>{isNew ? "追加" : "保存"}</button>
      </div>
    </Scrim>
  );
}

function AccountsModal({ accounts, onClose, onDisconnect, onSignOut }: {
  accounts: Account[]; onClose: () => void; onDisconnect: (e: string) => void; onSignOut: () => void;
}) {
  const [notify, setNotify] = useState<{ enabled: boolean } | null>(null);
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const [mute, setMute] = useState("");
  const [muteMsg, setMuteMsg] = useState<string | null>(null);
  useEffect(() => {
    api("GET", "/api/notify")
      .then((r) => { setNotify(r); setMute((r.mute ?? []).join(", ")); })
      .catch(() => setNotify({ enabled: false }));
  }, []);
  const saveMute = async () => {
    setMuteMsg("保存中…");
    try {
      const r = await api("PUT", "/api/notify", { mute: mute.split(/[,、\n]/).map((s) => s.trim()).filter(Boolean) });
      setMute((r.mute ?? []).join(", "));
      setMuteMsg(r.mute.length ? `保存しました（${r.mute.length}語）` : "保存しました（ミュートなし）");
    } catch (e) {
      setMuteMsg(`失敗: ${String(e)}`);
    }
  };
  const sendTest = async () => {
    setTestMsg("送信中…");
    try {
      const r = await fetch("/api/notify", { method: "POST" }).then((x) => x.json());
      setTestMsg(r.ok ? "送信しました。スマホの ntfy アプリを確認してください。" : `失敗: ${r.error}`);
    } catch (e) {
      setTestMsg(`失敗: ${String(e)}`);
    }
  };
  return (
    <Scrim onClose={onClose}>
      <h3>アカウント</h3>
      {accounts.length === 0 && <p style={{ color: "var(--muted)" }}>接続中のアカウントはありません。</p>}
      {accounts.map((a) => (
        <div key={a.email} className="acct-row">
          <span className="dot" style={{ background: a.color || "#888" }} />
          <span className="em">{a.email}</span>
          <button className="link-danger" onClick={() => onDisconnect(a.email)}>切断</button>
        </div>
      ))}
      <h3 style={{ marginTop: 18 }}>通知（ntfy）</h3>
      <div className="acct-row">
        <span className="em" style={{ color: "var(--muted)", fontSize: 12.5 }}>
          {notify == null ? "確認中…" : notify.enabled
            ? "設定済み。リマインドはスマホにプッシュされます。"
            : ".env.local に KAIROS_NTFY_URL / KAIROS_NTFY_TOPIC を設定すると有効になります。"}
        </span>
        <button className="btn" disabled={!notify?.enabled} onClick={() => void sendTest()}>テスト送信</button>
      </div>
      {testMsg && <p className="hint" style={{ margin: "4px 0 0" }}>{testMsg}</p>}
      <div className="field" style={{ marginTop: 10 }}>
        <label>通知ミュート（カンマ区切りのキーワード）</label>
        <input
          value={mute}
          onChange={(e) => setMute(e.target.value)}
          placeholder="例: SecHack, 説明会"
          onKeyDown={(e) => { if (e.key === "Enter") void saveMute(); }}
        />
        <div className="hint" style={{ marginTop: 4 }}>
          タイトルにこれらの語を含む予定・タスクは朝ブリーフィングや期限ナッジから除外されます（大文字小文字・全角半角は区別しません）。自分で設定したリマインダーはミュートされません。
        </div>
        <div style={{ marginTop: 6 }}>
          <button className="btn" onClick={() => void saveMute()}>ミュートを保存</button>
          {muteMsg && <span className="hint" style={{ marginLeft: 8 }}>{muteMsg}</span>}
        </div>
      </div>
      <div className="modal-foot" style={{ marginTop: 14 }}>
        <a className="btn btn-primary" href="/api/connect/google">+ アカウントを追加</a>
        <button className="btn" onClick={onSignOut}>サインアウト</button>
        <div className="spacer" />
        <button className="btn" onClick={onClose}>閉じる</button>
      </div>
    </Scrim>
  );
}

function ChatModal({ taskKey, taskTitle, autoMessage, onClose, onExecuted }: {
  taskKey: string; taskTitle: string; autoMessage?: string; onClose: () => void; onExecuted: () => void;
}) {
  return (
    <Scrim onClose={onClose} wide>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <h3 style={{ margin: 0, flex: 1, display: "flex", alignItems: "center", gap: 7 }}><BotIcon size={17} />AI相談 — {taskTitle || "タスク"}</h3>
        <button className="btn" onClick={onClose}>閉じる</button>
      </div>
      <ChatPane
        taskKey={taskKey}
        autoMessage={autoMessage}
        emptyHint="このタスクについて相談しましょう。例:「どう進めればいい？」「どれくらい時間かかりそう？」"
        onExecuted={onExecuted}
      />
    </Scrim>
  );
}
