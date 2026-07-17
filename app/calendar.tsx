"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { signIn, signOut } from "next-auth/react";
import { ChatPane } from "./chat-pane";
import { AudioUpload } from "./notes/notes-client";
import { Dock, MobileTabs } from "./nav";
import { BotIcon, ClockIcon, PlusIcon, RefreshIcon } from "./icons";
import { eventOverlapsDay, eventSegmentForDay } from "@/lib/calendar-segments";

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
  asap?: boolean | null; priority?: number | null;
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
  asap: boolean; priority: string; // ASAP期限 / 優先度1-5
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
  // 🧭プラン: 空き時間へのタスク自動配置をグリッドに薄く重ねる（既定ON）
  const [planBlocks, setPlanBlocks] = useState<PlanBlock[]>([]);
  const [showPlan, setShowPlan] = useState(true);
  const reloadSeq = useRef(0);
  const taskReloadSeq = useRef(0);

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
    if (localStorage.getItem("kairos-show-plan") === "0") setShowPlan(false);
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

  const reloadPlan = useCallback(() => {
    api("GET", "/api/plan?days=7").then((p) => setPlanBlocks(p.blocks || [])).catch(() => {});
  }, []);
  useEffect(() => {
    if (!authed) return;
    reloadPlan();
    const t = setInterval(reloadPlan, 5 * 60_000);
    return () => clearInterval(t);
  }, [authed, tasks, reloadPlan]);

  const reloadTasks = useCallback(async () => {
    const seq = ++taskReloadSeq.current;
    const tk = await api("GET", "/api/tasks");
    if (seq !== taskReloadSeq.current) return;
    setLists(tk.lists);
    setTasks(tk.tasks);
  }, []);

  const reload = useCallback(async () => {
    const seq = ++reloadSeq.current;
    const taskSeq = ++taskReloadSeq.current;
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
      if (seq !== reloadSeq.current) return;
      setEvents(evs);
      setCalendars(cals);
      setActuals(lg.logs || []);
      if (taskSeq === taskReloadSeq.current) {
        setLists(tk.lists);
        setTasks(tk.tasks);
      }
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
        asap: false, priority: "",
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
        asap: !!t.asap, priority: numStr(t.priority),
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
      asap: d.asap, priority: num(d.priority),
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
      const e = new Date(ev.end);
      const dayStart = startOfDay(day).getTime();
      const segment = eventSegmentForDay(s.getTime(), e.getTime(), dayStart);
      if (!segment) continue;
      const sm = segment.startMinute;
      const em = segment.endMinute;
      out.push({ key: `e:${ev.account}:${ev.calendarId}:${ev.id}:${dayStart}`, color: ev.color || "#4285f4", label: ev.summary, s: sm, e: em, isTask: false, done: false, onClick: () => openDetail(ev) });
    }
    for (const t of tasks) {
      const dd = taskDueDate(t);
      if (!dd || !sameDay(dd, day) || !t.dueTime) continue;
      const sm = minsOf(t.dueTime);
      out.push({ key: `t:${t.account}:${t.id}`, color: acctColor(t.account), label: t.title || "(無題)", s: sm, e: sm + 30, isTask: true, done: t.status === "completed", onClick: () => openTask(t) });
    }
    return out;
  }

  // 🧭プラン overlay: /api/plan のタスク配置をこの日の分オフセットに変換
  function dayPlan(day: Date) {
    const dayStart = startOfDay(day).getTime();
    const out: { key: string; label: string; s: number; e: number; taskKey?: string }[] = [];
    for (const b of planBlocks) {
      if (b.kind !== "task") continue;
      const s = Math.max(0, Math.round((b.startMs - dayStart) / 60000));
      const e = Math.min(1440, Math.round((b.endMs - dayStart) / 60000));
      if (e <= 0 || s >= 1440 || e - s < 10) continue;
      out.push({ key: `p:${b.startMs}:${b.taskKey ?? ""}`, label: b.title, s, e, taskKey: b.taskKey });
    }
    return out;
  }

  // プランブロックのクリック → そのタスクを開く（「予定に見えるのに押せない」対策）
  function openPlanTask(taskKey?: string) {
    if (!taskKey) return;
    const [account, tasklist, id] = taskKey.split("|");
    const t = tasks.find((x) => x.account === account && x.tasklist === tasklist && x.id === id);
    if (t) openTask(t);
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
        <button className={`btn planbtn${showPlan ? " on" : ""}`}
          title="🧭プラン: 空き時間へのタスク自動配置を薄く重ねる"
          onClick={() => setShowPlan((v) => { localStorage.setItem("kairos-show-plan", v ? "0" : "1"); return !v; })}>
          🧭
        </button>
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
                planFor={!showActual && showPlan ? dayPlan : undefined}
                onPlanClick={openPlanTask}
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
  planFor?: (d: Date) => { key: string; label: string; s: number; e: number; taskKey?: string }[];
  onPlanClick?: (taskKey?: string) => void;
  onEvent: (e: Ev) => void; onTask: (t: Task) => void; onSlot: (d: Date) => void;
}) {
  const { view, anchor, events, tasksDue, dayTimed, planFor, onPlanClick, onEvent, onTask, onSlot } = props;
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
                {/* 🧭プラン: 空き時間へのタスク自動配置（薄い点線、クリック透過） */}
                {planFor?.(d).map((p) => (
                  <div key={p.key} className={`planov${p.taskKey ? " clickable" : ""}`}
                    title={`🧭 プラン（仮）: ${p.label} — クリックでタスクを開く。📌はプランカードから`}
                    style={{ top: `${p.s / 60 * HOUR_H}px`, height: `${(p.e - p.s) / 60 * HOUR_H - 2}px` }}
                    onClick={(ev) => { ev.stopPropagation(); onPlanClick?.(p.taskKey); }}>
                    <span>🧭 {p.label}</span>
                  </div>
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
            const en = new Date(e.end);
            const dayStart = startOfDay(d);
            if (!eventOverlapsDay(s.getTime(), en.getTime(), dayStart.getTime())) return;
            const startsToday = sameDay(s, d);
            const label = startsToday ? `${pad(s.getHours())}:${pad(s.getMinutes())}` : "↪";
            items.push({ key: `e:${e.account}:${e.calendarId}:${e.id}`, sort: startsToday ? s.getHours() * 60 + s.getMinutes() : 0, node: <div className="mchip" style={{ background: e.color || "#4285f4", color: inkFor(e.color || "#4285f4") }} onClick={(ev) => { ev.stopPropagation(); onEvent(e); }}><span className="mt">{label}</span>{e.summary}</div> });
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
  // 既定は締切順（明示的に手動へ切り替えた場合だけ従う）
  const [byDue, setByDue] = useState(true);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (localStorage.getItem("kairos-task-sort") === "manual") setByDue(false);
  }, []);
  const toggle = () => setByDue((v) => { localStorage.setItem("kairos-task-sort", v ? "manual" : "due"); return !v; });
  return (
    <div className="rail">
      <PlanCard refreshKey={tasks} />
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

/* ------------------------------------------------------- planner + routines */
type PlanBlock = { kind: "task" | "deadline"; title: string; startMs: number; endMs: number; taskKey?: string; note?: string };
type PlanResp = {
  blocks: PlanBlock[];
  now: { kind: string; title: string; untilMs: number | null; note?: string } | null;
  warnings: string[];
  generatedAt: number;
};
type Routine = {
  id: string; label: string; kind: string; days: string | null;
  startHm: string | null; endHm: string | null; note: string | null; active: boolean;
};

const hmOf = (ms: number) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

/**
 * 「今なにをするか」— 予定・生活ルーチンで埋まっていない空き時間に、
 * ASAP>優先度>締切順でタスクを自動配置したプラン（/api/plan、AI不使用・即答）。
 */
function PlanCard({ refreshKey }: { refreshKey: unknown }) {
  const [plan, setPlan] = useState<PlanResp | null>(null);
  // 非表示（折りたたみ）: ヘッダー1行だけ残して本体を隠す。設定は永続化。
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (localStorage.getItem("kairos-plan-card") === "min") setCollapsed(true);
  }, []);
  const toggleCollapsed = () =>
    setCollapsed((v) => { localStorage.setItem("kairos-plan-card", v ? "open" : "min"); return !v; });
  const [openRoutines, setOpenRoutines] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const reload = useCallback(() => {
    api("GET", "/api/plan").then(setPlan).catch(() => {});
  }, []);
  useEffect(() => { reload(); }, [reload, refreshKey]);
  useEffect(() => {
    const t = setInterval(reload, 5 * 60_000);
    return () => clearInterval(t);
  }, [reload]);

  const enrich = async () => {
    setEnriching(true);
    setMsg(null);
    try {
      const r = await api("POST", "/api/plan", { enrich: true });
      setPlan(r.plan);
      setMsg(r.updated > 0 ? `AI推定: ${r.lines.slice(0, 3).join(" / ")}` : "推定対象なし（見積り・優先度は入っています）");
    } catch (e) {
      setMsg(String((e as Error).message ?? e).slice(0, 120));
    } finally {
      setEnriching(false);
    }
  };

  // 📌確定: 流動プランのブロックを「Kairos プラン」カレンダーのGoogle予定に昇格
  const [pinning, setPinning] = useState<string | null>(null);
  const pin = async (b: PlanBlock) => {
    setPinning(`${b.taskKey}:${b.startMs}`);
    setMsg(null);
    try {
      await api("POST", "/api/plan/commit", { taskKey: b.taskKey, startMs: b.startMs, endMs: b.endMs });
      setMsg(`📌 ${hmOf(b.startMs)}-${hmOf(b.endMs)} を予定として確定しました`);
      reload();
    } catch (e) {
      setMsg(String((e as Error).message ?? e).slice(0, 150));
    } finally {
      setPinning(null);
    }
  };

  if (!plan) return null;
  const today = new Date(plan.generatedAt); today.setHours(23, 59, 59, 0);
  const todays = plan.blocks.filter((b) => b.startMs <= today.getTime()).slice(0, 6);
  if (collapsed) {
    return (
      <div className="card plancard plancard-min">
        <button className="plancard-head" onClick={toggleCollapsed} title="クリックで展開">
          <h3 style={{ margin: 0, flex: 1, textAlign: "left" }}>🧭 今やること</h3>
          <span className="hint" style={{ margin: 0 }}>▸</span>
        </button>
      </div>
    );
  }
  return (
    <div className="card plancard">
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <button className="plancard-head" style={{ flex: 1 }} onClick={toggleCollapsed} title="クリックで折りたたみ">
          <h3 style={{ margin: 0, flex: 1, textAlign: "left" }}>🧭 今やること</h3>
          <span className="hint" style={{ margin: 0 }}>▾</span>
        </button>
        <button className="btn" disabled={enriching} onClick={() => void enrich()}
          title="締切ありタスクをRAG(授業ノート等)でクロールして見積り・優先度をAI推定">
          {enriching ? "推定中…" : "🤖 AI推定"}
        </button>
        <button className="btn" title="予定・タスク・プラン・用語集をまとめてコピー（Claude Web等に貼り付ける用）"
          onClick={() => {
            void api("GET", "/api/export/claude").then(async (r) => {
              await navigator.clipboard.writeText(r.markdown);
              setMsg(`📋 コンテキストをコピーしました（${Math.round(r.chars / 1000)}k字）— Claude等に貼り付けてください`);
            }).catch((e) => setMsg(String(e).slice(0, 120)));
          }}>📋</button>
        <a className="btn" href="https://zundamon-ubuntu-alc6.tail7507d4.ts.net:8443/glossary"
          target="_blank" rel="noopener noreferrer"
          title="用語集 — 自分固有の専門用語・団体をAIに教える（mnemoで編集）">📖</a>
        <button className="btn" onClick={() => setOpenRoutines(true)} title="寮食・風呂・洗濯・睡眠などの生活ルール">⚙</button>
      </div>
      {plan.now && (
        <div className="plannow">
          {plan.now.kind === "event" ? "📅 " : plan.now.kind === "routine" ? "🏠 " : plan.now.kind === "task" ? "▶ " : ""}
          {plan.now.title}
          {plan.now.untilMs && <span className="lmeta">（〜{hmOf(plan.now.untilMs)}）</span>}
        </div>
      )}
      <div className="planlist">
        {todays.map((b, i) => (
          <div key={i} className={`planrow${b.kind === "deadline" ? " dl" : ""}${b.endMs <= plan.generatedAt ? " past" : ""}`}>
            <span className="pt">{b.kind === "deadline" ? `${hmOf(b.startMs)} ⏰` : `${hmOf(b.startMs)}-${hmOf(b.endMs)}`}</span>
            <span className="pl">{b.title}</span>
            {b.kind === "task" && b.taskKey && b.endMs > plan.generatedAt && (
              <button className="pinbtn" disabled={pinning != null}
                title="この枠で確定 — 「Kairos プラン」カレンダーの予定になり、プランの組み直しで動かなくなります"
                onClick={() => void pin(b)}>{pinning === `${b.taskKey}:${b.startMs}` ? "…" : "📌"}</button>
            )}
          </div>
        ))}
        {todays.length === 0 && <p className="hint" style={{ margin: 0 }}>今日はもう割り当てなし</p>}
      </div>
      {plan.warnings.slice(0, 2).map((w, i) => <p key={i} className="errline" style={{ margin: "4px 0 0" }}>⚠ {w}</p>)}
      {msg && <p className="hint" style={{ margin: "4px 0 0" }}>{msg}</p>}
      {openRoutines && <RoutinesModal onClose={() => { setOpenRoutines(false); reload(); }} />}
    </div>
  );
}

const R_KIND_LABEL: Record<string, string> = { block: "時間確保", deadline: "締切", sleep: "睡眠" };
const R_DAYS = [["mon", "月"], ["tue", "火"], ["wed", "水"], ["thu", "木"], ["fri", "金"], ["sat", "土"], ["sun", "日"]] as const;

/** 生活ルール（寮食・風呂・洗濯・睡眠・バイト等）のCRUD。プランナーの制約になる。 */
function RoutinesModal({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<Routine[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState({ label: "", kind: "block", days: "", startHm: "", endHm: "" });
  const reload = useCallback(async () => {
    const r = await api("GET", "/api/routines");
    setItems(r.routines || []);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload().catch((e) => setErr(String(e)));
  }, [reload]);
  const save = async (w: Partial<Routine> & { label: string; kind: string }) => {
    try {
      await api("POST", "/api/routines", w);
      await reload();
      setErr(null);
    } catch (e) {
      setErr(String((e as Error).message ?? e).slice(0, 120));
    }
  };
  const del = async (id: string) => {
    await api("DELETE", `/api/routines?id=${encodeURIComponent(id)}`).catch(() => {});
    await reload();
  };
  const toggleDay = (days: string, key: string) => {
    const set = new Set(days.split(",").map((s) => s.trim()).filter(Boolean));
    if (set.has(key)) set.delete(key); else set.add(key);
    return [...set].join(",");
  };
  return (
    <Scrim onClose={onClose}>
      <h3>⚙ 生活ルール</h3>
      <p className="hint" style={{ marginTop: 0 }}>
        タスクではない日常の枠。プランはこの時間を避けて組まれます。締切=「その時刻までに」(例: 寮の夕食は20:10までに帰宅)、睡眠=就寝〜起床が1日の境界。曜日指定なし=毎日。
      </p>
      {items.map((r) => (
        <div key={r.id} className="routine-row">
          <input style={{ flex: 1, minWidth: 90 }} defaultValue={r.label}
            onBlur={(e) => { if (e.target.value !== r.label) void save({ ...r, label: e.target.value }); }} />
          <select value={r.kind} onChange={(e) => void save({ ...r, kind: e.target.value })}>
            {Object.entries(R_KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <input type="time" defaultValue={r.startHm ?? ""} title={r.kind === "sleep" ? "就寝" : "開始"}
            onBlur={(e) => { if (e.target.value !== (r.startHm ?? "")) void save({ ...r, startHm: e.target.value || null }); }} />
          <input type="time" defaultValue={r.endHm ?? ""} title={r.kind === "sleep" ? "起床" : r.kind === "deadline" ? "この時刻までに" : "終了"}
            onBlur={(e) => { if (e.target.value !== (r.endHm ?? "")) void save({ ...r, endHm: e.target.value || null }); }} />
          <span className="rdays">
            {R_DAYS.map(([k, v]) => (
              <button key={k} className={`daybtn${(r.days ?? "").includes(k) ? " on" : ""}`}
                onClick={() => void save({ ...r, days: toggleDay(r.days ?? "", k) })}>{v}</button>
            ))}
          </span>
          <input type="checkbox" checked={r.active} title="有効/無効"
            onChange={(e) => void save({ ...r, active: e.target.checked })} />
          <button className="link-danger" onClick={() => void del(r.id)}>✕</button>
        </div>
      ))}
      <div className="routine-row" style={{ marginTop: 8 }}>
        <input style={{ flex: 1, minWidth: 90 }} placeholder="例: 風呂 / 洗濯 / バイト" value={draft.label}
          onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
        <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })}>
          {Object.entries(R_KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <input type="time" value={draft.startHm} onChange={(e) => setDraft({ ...draft, startHm: e.target.value })} />
        <input type="time" value={draft.endHm} onChange={(e) => setDraft({ ...draft, endHm: e.target.value })} />
        <button className="btn btn-primary" disabled={!draft.label.trim()}
          onClick={() => { void save({ label: draft.label, kind: draft.kind, startHm: draft.startHm || null, endHm: draft.endHm || null, days: draft.days || null }); setDraft({ label: "", kind: "block", days: "", startHm: "", endHm: "" }); }}>
          追加
        </button>
      </div>
      {err && <p className="errline">{err}</p>}
      <div className="modal-foot" style={{ marginTop: 12 }}>
        <div className="spacer" />
        <button className="btn btn-primary" onClick={onClose}>閉じる</button>
      </div>
    </Scrim>
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
  // 締切順: ASAP最優先 → 期日昇順（時刻タイブレーク、期限なしは末尾）→ 優先度降順
  const dueKey = (t: Task) =>
    `${t.asap ? "0" : "1"}|${t.due ? `${t.due.slice(0, 10)}T${t.dueTime ?? "23:59"}` : "9999-99-99"}|${9 - (t.priority ?? 0)}`;
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
          <div className="title">
            {t.asap && !isDone && <span className="asap">ASAP</span>}
            {(t.priority ?? 0) >= 4 && !isDone && <span className="prio" title={`優先度${t.priority}`}>{"!".repeat((t.priority ?? 4) - 3)}</span>}
            {t.title || "(無題)"}
          </div>
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

/**
 * 予定の説明はGoogleからHTMLで来ることがある（<br>や<a>が生のまま見えて
 * 読めなかった実害） — タグを落として改行を戻し、URLはリンク化。長文は折りたたむ。
 */
function DescText({ html }: { html: string }) {
  const [full, setFull] = useState(false);
  const text = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr)>/gi, "\n")
    .replace(/<a\s[^>]*href="([^"]+)"[^>]*>[\s\S]*?<\/a>/gi, " $1 ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const shown = full || text.length <= 420 ? text : text.slice(0, 420) + "…";
  const parts = shown.split(/(https?:\/\/[^\s<>"）)]+)/g);
  return (
    <span style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
      {parts.map((p, i) =>
        /^https?:\/\//.test(p)
          ? <a key={i} href={p} target="_blank" rel="noopener noreferrer">{p.length > 60 ? p.slice(0, 57) + "…" : p}</a>
          : p,
      )}
      {text.length > 420 && (
        <button className="link" style={{ display: "block", marginTop: 4 }} onClick={() => setFull((v) => !v)}>
          {full ? "▾ 折りたたむ" : "▸ すべて表示"}
        </button>
      )}
    </span>
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
        {ev.description && <div className="det-row"><span className="k">詳細</span><span className="v"><DescText html={ev.description} /></span></div>}
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
        <div className="field"><label>期限（日付）</label><input type="date" value={draft.due} onChange={(e) => set({ due: e.target.value })} disabled={draft.asap} /></div>
        <div className="field"><label>時刻</label><input type="time" value={draft.dueTime} onChange={(e) => set({ dueTime: e.target.value })} disabled={!draft.due || draft.asap} /></div>
      </div>
      <div className="chk" style={{ marginBottom: 8 }}>
        <input type="checkbox" id="asap-chk" checked={draft.asap} onChange={(e) => set({ asap: e.target.checked })} />
        <label htmlFor="asap-chk" style={{ margin: 0 }}>⚡ ASAP — できるだけ早く（締切順の最上位・プランの先頭に入ります）</label>
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
        <div className="field"><label>優先度（1-5、5=最優先）</label>
          <select value={draft.priority} onChange={(e) => set({ priority: e.target.value })}>
            {levels.map((v) => <option key={v} value={v}>{v || "—"}</option>)}
          </select>
        </div>
        <div className="field"><label>難易度（1-5）</label>
          <select value={draft.difficulty} onChange={(e) => set({ difficulty: e.target.value })}>
            {levels.map((v) => <option key={v} value={v}>{v || "—"}</option>)}
          </select>
        </div>
      </div>
      <div className="row2">
        <div className="field"><label>エネルギー（1-5）</label>
          <select value={draft.energy} onChange={(e) => set({ energy: e.target.value })}>
            {levels.map((v) => <option key={v} value={v}>{v || "—"}</option>)}
          </select>
        </div>
        <div className="field" />
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

/**
 * バックグラウンドAI（要約・推定・取り込み等）のフォールバック優先順位。
 * claudeがlimitでも次のエージェントに自動で流れる。詳細: docs/AGENT-FALLBACK.md
 */
function AgentPriorityEditor() {
  const [order, setOrder] = useState("");
  const [probe, setProbe] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    api("GET", "/api/agents").then((r) => {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setOrder((r.priority?.order ?? []).map((s: { agent: string }) => s.agent).join(", "));
      setProbe(r.priority?.probe !== false);
    }).catch(() => {});
  }, []);
  const save = async () => {
    setMsg("保存中…");
    try {
      const r = await api("PUT", "/api/agents", { order: order.split(/[,\s]+/).filter(Boolean), probe });
      setOrder(r.priority.order.map((s: { agent: string }) => s.agent).join(", "));
      setMsg(`保存しました: ${r.priority.order.map((s: { agent: string }) => s.agent).join(" → ")}`);
    } catch (e) {
      setMsg(String((e as Error).message ?? e).slice(0, 150));
    }
  };
  return (
    <div>
      <div className="acct-row">
        <input style={{ flex: 1 }} value={order} onChange={(e) => setOrder(e.target.value)}
          placeholder="claude, codex, copilot, agy" />
        <button className="btn" onClick={() => void save()}>保存</button>
      </div>
      <div className="chk" style={{ margin: "4px 0 0" }}>
        <input type="checkbox" id="probe-chk" checked={probe} onChange={(e) => setProbe(e.target.checked)} />
        <label htmlFor="probe-chk" style={{ margin: 0 }}>実行前に最安モデルで生存確認（プローブ、結果は10分キャッシュ）</label>
      </div>
      <p className="hint" style={{ margin: "4px 0 0" }}>
        要約・タスク推定・写真取り込みなどのバックグラウンドAIは、この順に試して失敗したら次へ流れます。
        claudeがlimitのときは自動で2番手以降へ。画像系はclaude不調時ローカルOCR+テキストLLMに切り替わります。
      </p>
      {msg && <p className="hint" style={{ margin: "4px 0 0" }}>{msg}</p>}
    </div>
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
      <h3 style={{ marginTop: 18 }}>バックグラウンドAIの優先順位</h3>
      <AgentPriorityEditor />
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
