"use client";

import { useCallback, useEffect, useState } from "react";
import { MobileTabs, TopTabs } from "../nav";

/**
 * Kanban board over Google Tasks. Columns are LOCAL-ONLY (`tasks.kanban`,
 * preserved by sync) — except 完了, which maps to the Google-visible
 * status=completed, so checking off here shows up on your phone too.
 */

type Task = {
  account: string; tasklist: string; id: string; title: string; notes?: string | null;
  status: string; due?: string | null; dueTime?: string | null;
  estimatedMin?: number | null; kanban?: string | null;
};
type ListMeta = { account: string; id: string; title: string | null };

const COLS = ["todo", "doing", "waiting", "done"] as const;
type Col = (typeof COLS)[number];
const COL_LABEL: Record<Col, string> = {
  todo: "未着手", doing: "進行中", waiting: "保留", done: "完了",
};
const DONE_LIMIT = 15;

const colOf = (t: Task): Col => {
  if (t.status === "completed") return "done";
  const k = t.kanban;
  return k === "doing" || k === "waiting" ? k : "todo";
};

async function api(method: string, url: string, body?: unknown) {
  const r = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

const dueDate = (t: Task) => (t.due ? new Date(`${t.due.slice(0, 10)}T00:00:00`) : null);

export default function BoardClient() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [lists, setLists] = useState<ListMeta[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await api("GET", "/api/tasks");
    setTasks(r.tasks || []);
    setLists(r.lists || []);
    setLoaded(true);
  }, []);

  useEffect(() => {
    // load() awaits the network before setState — false positive for this rule.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load().catch((e) => setErr(String(e)));
  }, [load]);

  const keyOf = (t: Task) => `${t.account}|${t.tasklist}|${t.id}`;
  const listTitle = (t: Task) =>
    lists.find((l) => l.account === t.account && l.id === t.tasklist)?.title ?? "";

  const move = useCallback(async (t: Task, target: Col) => {
    const k = keyOf(t);
    if (busyKey || colOf(t) === target) return;
    setBusyKey(k);
    setErr(null);
    // optimistic move
    setTasks((prev) => prev.map((x) => (keyOf(x) === k
      ? { ...x,
          status: target === "done" ? "completed" : "needsAction",
          kanban: target === "done" ? x.kanban : target }
      : x)));
    try {
      const body: Record<string, unknown> = { account: t.account, tasklist: t.tasklist, id: t.id };
      if (target === "done") body.status = "completed";
      else {
        body.kanban = target;
        if (t.status === "completed") body.status = "needsAction";
      }
      await api("PATCH", "/api/tasks", body);
    } catch (e) {
      setErr(String(e));
      await load(); // roll back to server truth
    } finally {
      setBusyKey(null);
    }
  }, [busyKey, load]);

  const now = new Date(); now.setHours(0, 0, 0, 0);

  const columns = COLS.map((col) => {
    let items = tasks.filter((t) => colOf(t) === col);
    items.sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999") || a.title.localeCompare(b.title));
    let hidden = 0;
    if (col === "done") {
      items = items.reverse(); // most recently due first-ish
      hidden = Math.max(0, items.length - DONE_LIMIT);
      items = items.slice(0, DONE_LIMIT);
    }
    return { col, items, hidden };
  });

  return (
    <div className="app">
      <div className="topbar">
        <span className="brand">Kairos</span>
        <TopTabs />
        <div className="spacer" />
        <button className="btn" onClick={() => void load()} title="再読み込み">⟳</button>
      </div>
      {err && <p className="errline" style={{ margin: "8px 12px" }}>{err}</p>}
      <div className="board">
        {!loaded && <p className="hint" style={{ padding: 16 }}>読み込み中…</p>}
        {loaded && columns.map(({ col, items, hidden }) => (
          <div
            key={col}
            className={`bcol ${col}`}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => {
              const t = tasks.find((x) => keyOf(x) === dragKey);
              if (t) void move(t, col);
              setDragKey(null);
            }}
          >
            <div className="bhead">{COL_LABEL[col]}<span className="bcount">{items.length + hidden}</span></div>
            <div className="bcards">
              {items.map((t) => {
                const dd = dueDate(t);
                const over = dd && col !== "done" && dd < now;
                const ci = COLS.indexOf(col);
                return (
                  <div
                    key={keyOf(t)}
                    className={`bcard${col === "done" ? " done" : ""}${busyKey === keyOf(t) ? " busy" : ""}`}
                    draggable
                    onDragStart={() => setDragKey(keyOf(t))}
                    onDragEnd={() => setDragKey(null)}
                  >
                    <div className="btitle">{t.title || "(無題)"}</div>
                    <div className="bmeta">
                      {dd && <span className={`bdue${over ? " over" : ""}`}>{dd.getMonth() + 1}/{dd.getDate()}{t.dueTime ? ` ${t.dueTime}` : ""}</span>}
                      {t.estimatedMin != null && <span className="best">⏱ {t.estimatedMin}分</span>}
                      <span className="blist">{listTitle(t)}</span>
                    </div>
                    <div className="bmove">
                      <button disabled={ci === 0 || !!busyKey} onClick={() => void move(t, COLS[ci - 1])} title={ci > 0 ? `${COL_LABEL[COLS[ci - 1]]}へ` : ""}>‹</button>
                      <button disabled={ci === COLS.length - 1 || !!busyKey} onClick={() => void move(t, COLS[ci + 1])} title={ci < COLS.length - 1 ? `${COL_LABEL[COLS[ci + 1]]}へ` : ""}>›</button>
                    </div>
                  </div>
                );
              })}
              {hidden > 0 && <div className="bmore">他 {hidden} 件の完了タスク</div>}
              {items.length === 0 && hidden === 0 && <div className="bempty">なし</div>}
            </div>
          </div>
        ))}
      </div>
      <MobileTabs />
    </div>
  );
}
