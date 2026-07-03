"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Dock, MobileTabs } from "../nav";

/* ------------------------------------------------------------------ types */
type LogItem = {
  id: string;
  kind: string;
  title: string | null;
  note: string | null;
  startMs: number | null;
  endMs: number | null;
  tags: string[];
  metrics: Record<string, unknown>;
  source: string | null;
  hasImage: boolean;
  createdAt: number | null;
};

type Draft = {
  kind: string;
  title: string | null;
  note: string | null;
  start: string | null;
  end: string | null;
  startMs: number | null;
  endMs: number | null;
  tags: string[];
  metrics: Record<string, unknown>;
  source: string;
  imagePath?: string;
};

/* ---------------------------------------------------------------- helpers */
const pad = (n: number) => String(n).padStart(2, "0");

function toLocalInput(s: string | null): string {
  if (!s) return "";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s.slice(0, 16);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtDateTime(ms: number | null): string {
  if (ms == null) return "—";
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function durMin(a: number | null, b: number | null): number | null {
  if (a == null || b == null) return null;
  return Math.round((b - a) / 60000);
}

function fmtDur(min: number | null | undefined): string {
  if (min == null || Number.isNaN(min)) return "";
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h}h${m ? pad(m) : ""}` : `${m}m`;
}

const KIND_LABEL: Record<string, string> = {
  sleep: "😴 睡眠",
  meal: "🍙 食事",
  work: "💻 作業",
  trip: "🧳 旅行",
  activity: "🏃 活動",
  note: "📝 メモ",
};

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

const isoLocal = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
};

const TIMER_KEY = "kairos-timer"; // {startMs, kind, title} — survives reloads/navigation
const TIMER_KINDS = ["work", "activity", "meal", "trip", "note"] as const;

/* ------------------------------------------------------- Studyplus-style timer */
function TimerCard({ onSaved }: { onSaved: () => void }) {
  const [running, setRunning] = useState<{ startMs: number; kind: string; title: string } | null>(null);
  const [kind, setKind] = useState("work");
  const [title, setTitle] = useState("");
  const [now, setNow] = useState(Date.now());
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // restore a timer that was started before a reload / on another page visit
  useEffect(() => {
    try {
      const raw = localStorage.getItem(TIMER_KEY);
      if (raw) {
        const t = JSON.parse(raw);
        // one-time localStorage read on mount — intentional.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        if (typeof t?.startMs === "number") setRunning(t);
      }
    } catch { /* corrupt state — ignore */ }
  }, []);

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);

  const start = () => {
    const t = { startMs: Date.now(), kind, title: title.trim() };
    localStorage.setItem(TIMER_KEY, JSON.stringify(t));
    setRunning(t);
  };
  const discard = () => {
    if (!confirm("計測を破棄しますか？")) return;
    localStorage.removeItem(TIMER_KEY);
    setRunning(null);
  };
  const stop = async () => {
    if (!running) return;
    setSaving(true);
    setErr(null);
    try {
      await api("POST", "/api/logs", {
        kind: running.kind,
        title: (running.title || title).trim() || KIND_LABEL[running.kind] || running.kind,
        start: isoLocal(running.startMs),
        end: isoLocal(Date.now()),
        tags: [],
        metrics: {},
        source: "timer",
      });
      localStorage.removeItem(TIMER_KEY);
      setRunning(null);
      setTitle("");
      onSaved();
    } catch (e) {
      setErr(String(e));
    } finally {
      setSaving(false);
    }
  };

  const elapsed = running ? Math.max(0, Math.floor((now - running.startMs) / 1000)) : 0;
  const hh = Math.floor(elapsed / 3600), mm = Math.floor((elapsed % 3600) / 60), ss = elapsed % 60;

  return (
    <section className={`card timer${running ? " live" : ""}`}>
      <h3>⏱ 計測して記録</h3>
      {err && <p className="errline">{err}</p>}
      {!running ? (
        <div className="timerrow">
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            {TIMER_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k] ?? k}</option>)}
          </select>
          <input
            placeholder="何をする？（例: レポート執筆）"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") start(); }}
          />
          <button className="btn btn-primary" onClick={start}>開始</button>
        </div>
      ) : (
        <div className="timerrow">
          <span className="tclock">{hh > 0 && `${hh}:`}{pad(mm)}:{pad(ss)}</span>
          <span className="tlabel">{KIND_LABEL[running.kind] ?? running.kind}
            {running.title ? ` — ${running.title}` : ""}</span>
          <div className="spacer" />
          <button className="btn" onClick={discard}>破棄</button>
          <button className="btn btn-primary" disabled={saving} onClick={() => void stop()}>
            {saving ? "保存中…" : "終了して保存"}
          </button>
        </div>
      )}
      <p className="hint" style={{ margin: "6px 0 0" }}>
        計測中はページを離れても続きます。記録した実績はカレンダーの「実績」表示と AI の見積り較正に使われます。
      </p>
    </section>
  );
}

/* ----------------------------------------------------- record after the fact */
function ManualCard({ onSaved }: { onSaved: () => void }) {
  const [kind, setKind] = useState("work");
  const [title, setTitle] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    if (!start || !end) { setErr("開始と終了を入れてください"); return; }
    if (Date.parse(end) <= Date.parse(start)) { setErr("終了は開始より後にしてください"); return; }
    setSaving(true);
    setErr(null);
    try {
      await api("POST", "/api/logs", {
        kind,
        title: title.trim() || KIND_LABEL[kind] || kind,
        note: note.trim() || null,
        start, end,
        tags: [], metrics: {}, source: "manual",
      });
      setTitle(""); setStart(""); setEnd(""); setNote("");
      onSaved();
    } catch (e) {
      setErr(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="card">
      <h3>あとから記録</h3>
      {err && <p className="errline">{err}</p>}
      <div className="row2">
        <div className="field">
          <label>種類</label>
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            {TIMER_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k] ?? k}</option>)}
          </select>
        </div>
        <div className="field">
          <label>タイトル</label>
          <input value={title} placeholder="例: 数学の課題" onChange={(e) => setTitle(e.target.value)} />
        </div>
      </div>
      <div className="row2">
        <div className="field">
          <label>開始</label>
          <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
        </div>
        <div className="field">
          <label>終了</label>
          <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
        </div>
      </div>
      <div className="field">
        <label>メモ（任意）</label>
        <input value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <div className="modal-foot">
        <div className="spacer" />
        <button className="btn btn-primary" disabled={saving} onClick={() => void save()}>
          {saving ? "保存中…" : "記録する"}
        </button>
      </div>
    </section>
  );
}

/* =================================================================== page */
export default function LogsClient() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [metricsText, setMetricsText] = useState("{}");
  const [err, setErr] = useState<string | null>(null);
  const [raw, setRaw] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    try {
      const res = await api("GET", "/api/logs");
      setLogs(res.logs || []);
      setAuthed(true);
    } catch (e) {
      if ((e as { unauth?: boolean })?.unauth) setAuthed(false);
      else console.error(e);
    }
  }, []);

  useEffect(() => {
    // reload() awaits a fetch before any setState, so this is not a synchronous
    // setState-in-effect — the lint rule's heuristic flags it as a false positive.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload]);

  const analyze = useCallback(async () => {
    if (!file) return;
    setBusy(true);
    setErr(null);
    setRaw(null);
    setDraft(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("kind", "sleep");
      const r = await fetch("/api/logs/ingest", { method: "POST", body: fd });
      if (r.status === 401) {
        setAuthed(false);
        return;
      }
      const res = await r.json();
      if (res.ok && res.draft) {
        const d: Draft = res.draft;
        setDraft(d);
        setMetricsText(JSON.stringify(d.metrics ?? {}, null, 2));
      } else {
        setErr(res.error || "解析に失敗しました");
        setRaw(res.raw || null);
      }
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }, [file]);

  const save = useCallback(async () => {
    if (!draft) return;
    let metrics: Record<string, unknown> = {};
    try {
      metrics = metricsText.trim() ? JSON.parse(metricsText) : {};
    } catch {
      setErr("metrics の JSON が不正です");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      await api("POST", "/api/logs", { ...draft, metrics });
      setDraft(null);
      setFile(null);
      if (fileRef.current) fileRef.current.value = "";
      await reload();
    } catch (e) {
      setErr(String(e));
    } finally {
      setSaving(false);
    }
  }, [draft, metricsText, reload]);

  const remove = useCallback(
    async (id: string) => {
      if (!confirm("この記録を削除しますか？")) return;
      await api("DELETE", `/api/logs?id=${encodeURIComponent(id)}`);
      await reload();
    },
    [reload],
  );

  if (authed === false) {
    return (
      <div className="center">
        <h1>Kairos</h1>
        <p>ログインが必要です。</p>
        <Link className="btn btn-primary" href="/">
          カレンダーへ戻ってログイン
        </Link>
      </div>
    );
  }

  const dur = draft ? durMin(Date.parse(draft.start ?? ""), Date.parse(draft.end ?? "")) : null;

  return (
    <div className="app">
      <Dock />
      <div className="main">
      <div className="topbar">
        <span className="brand">Kairos</span>
        <div className="range">記録（実績）</div>
        <div className="spacer" />
      </div>

      <div className="scrollwrap">
      <div className="page">
        <p className="lead">
          「実際にやったこと」の記録＝裏カレンダーです。タイマーで測るか、あとから手で記録します。
          溜めた実績はカレンダーの「実績」表示に出て、タスクの所要時間をあなた基準で
          見積もるためのナレッジになります（ローカル DB のみ・Google には送りません）。
        </p>

        {/* ---- timer / manual ---- */}
        <TimerCard onSaved={() => void reload()} />
        <ManualCard onSaved={() => void reload()} />

        {/* ---- ingest ---- */}
        <section className="card">
          <h3>スクショから取り込む（睡眠）</h3>
          <div className="uprow">
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            <button className="btn btn-primary" disabled={!file || busy} onClick={analyze}>
              {busy ? "解析中…" : "AI で解析"}
            </button>
          </div>
          <p className="hint" style={{ margin: "6px 0 0" }}>
            ローカルの claude が画像を読み取ります（数十秒かかることがあります）。保存前に内容を確認できます。
          </p>
        </section>

        {/* ---- error ---- */}
        {err && !draft && (
          <section className="card err">
            <strong>エラー:</strong> {err}
            {raw && <pre className="pre">{raw}</pre>}
          </section>
        )}

        {/* ---- preview / confirm ---- */}
        {draft && (
          <section className="card">
            <h3>確認して保存</h3>
            {err && <p className="errline">{err}</p>}
            <div className="row2">
              <div className="field">
                <label>種類</label>
                <input
                  value={draft.kind}
                  onChange={(e) => setDraft({ ...draft, kind: e.target.value })}
                />
              </div>
              <div className="field">
                <label>見出し</label>
                <input
                  value={draft.title ?? ""}
                  onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                />
              </div>
            </div>
            <div className="row2">
              <div className="field">
                <label>就寝 / 開始</label>
                <input
                  type="datetime-local"
                  value={toLocalInput(draft.start)}
                  onChange={(e) => setDraft({ ...draft, start: e.target.value })}
                />
              </div>
              <div className="field">
                <label>起床 / 終了</label>
                <input
                  type="datetime-local"
                  value={toLocalInput(draft.end)}
                  onChange={(e) => setDraft({ ...draft, end: e.target.value })}
                />
              </div>
            </div>
            {dur != null && <p className="hint">長さ: {fmtDur(dur)}</p>}
            <div className="field">
              <label>metrics (JSON)</label>
              <textarea
                rows={7}
                className="mono"
                value={metricsText}
                onChange={(e) => setMetricsText(e.target.value)}
              />
            </div>
            <div className="field">
              <label>タグ（カンマ区切り）</label>
              <input
                value={draft.tags.join(", ")}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    tags: e.target.value
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
              />
            </div>
            <div className="field">
              <label>メモ</label>
              <textarea
                rows={2}
                value={draft.note ?? ""}
                onChange={(e) => setDraft({ ...draft, note: e.target.value })}
              />
            </div>
            <div className="modal-foot">
              <button className="btn" onClick={() => setDraft(null)}>
                破棄
              </button>
              <div className="spacer" />
              <button className="btn btn-primary" disabled={saving} onClick={save}>
                {saving ? "保存中…" : "保存"}
              </button>
            </div>
          </section>
        )}

        {/* ---- recent ---- */}
        <h2 className="sect">最近の記録</h2>
        {logs.length === 0 && <p className="hint">まだ記録がありません。</p>}
        <div className="loglist">
          {logs.map((l) => {
            const d = durMin(l.startMs, l.endMs);
            const score = (l.metrics?.score ?? l.metrics?.quality) as number | undefined;
            return (
              <div key={l.id} className="logcard">
                <div className="lk">{KIND_LABEL[l.kind] ?? l.kind}</div>
                <div className="lmain">
                  <div className="lt">{l.title || "(無題)"}</div>
                  <div className="lmeta">
                    {fmtDateTime(l.startMs)}
                    {l.endMs != null && ` → ${fmtDateTime(l.endMs)}`}
                    {d != null && ` ・ ${fmtDur(d)}`}
                    {score != null && ` ・ スコア ${score}`}
                    {l.source === "screenshot" && " ・ 📷"}
                  </div>
                  {l.note && <div className="lnote">{l.note}</div>}
                </div>
                <button className="link-danger" onClick={() => remove(l.id)} title="削除">
                  ×
                </button>
              </div>
            );
          })}
        </div>
      </div>
      </div>
      </div>
      <MobileTabs />
    </div>
  );
}
