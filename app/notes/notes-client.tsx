"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Dock, MobileTabs } from "../nav";
import { RefreshIcon } from "../icons";

/**
 * Notes (NotebookLM-ish): audio → whisperX transcript → agent markdown note.
 * The list polls while any note is still transcribing/summarizing.
 */

export type NoteView = {
  id: string; eventKey: string | null; title: string; content: string | null;
  transcript: string | null; status: string; error: string | null;
  hasAudio: boolean; createdAt: number | null; updatedAt: number | null;
};

const pad = (n: number) => String(n).padStart(2, "0");
const fmtDate = (ms: number | null) => {
  if (!ms) return "";
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const STATUS_LABEL: Record<string, string> = {
  transcribing: "文字起こし中…",
  summarizing: "ノート作成中…",
  done: "",
  error: "エラー",
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

/* ------------------------------------------------------------ audio upload */
export function AudioUpload({ eventKey, eventLabel, onStarted, compact }: {
  eventKey?: string | null; eventLabel?: string | null;
  onStarted: () => void; compact?: boolean;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [notebook, setNotebook] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const go = async () => {
    if (!file || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("title", title.trim() || file.name);
      if (notebook.trim()) fd.append("notebook", notebook.trim());
      if (eventKey) fd.append("eventKey", eventKey);
      if (eventLabel) fd.append("eventLabel", eventLabel);
      const r = await fetch("/api/notes/ingest", { method: "POST", body: fd });
      if (!r.ok) throw new Error(await r.text());
      setFile(null);
      setTitle("");
      if (fileRef.current) fileRef.current.value = "";
      onStarted();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={compact ? "" : "card"}>
      {!compact && <h3>🎙 音声からノートを作る</h3>}
      {err && <p className="errline">{err}</p>}
      <div className="uprow">
        <input ref={fileRef} type="file" accept="audio/*,.m4a,.mp3,.wav,.ogg,.opus,.mp4"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <input placeholder="タイトル（例: 経営管理 第12回）" value={title}
          style={{ flex: 1, minWidth: 140 }}
          onChange={(e) => setTitle(e.target.value)} />
        {!compact && (
          <input placeholder="分類（例: 経営管理）※AIチャットの検索単位" value={notebook}
            style={{ flex: 1, minWidth: 120 }}
            onChange={(e) => setNotebook(e.target.value)} />
        )}
        <button className="btn btn-primary" disabled={!file || busy} onClick={() => void go()}>
          {busy ? "アップロード中…" : "文字起こし開始"}
        </button>
      </div>
      {!compact && (
        <p className="hint" style={{ margin: "6px 0 0" }}>
          whisperX がこの PC 上で文字起こしし（音声は外部に出ません）、AI が Markdown
          ノートに整理します。講義1コマで数分〜かかります。ページを閉じても処理は続きます。
        </p>
      )}
    </div>
  );
}

/* -------------------------------------------------------------- note modal */
function NoteModal({ id, onClose, onChanged }: {
  id: string; onClose: () => void; onChanged: () => void;
}) {
  const [note, setNote] = useState<NoteView | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [title, setTitle] = useState("");
  const [showTranscript, setShowTranscript] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await api("GET", `/api/notes?id=${encodeURIComponent(id)}`);
    setNote(r.note);
    return r.note as NoteView;
  }, [id]);

  useEffect(() => {
    // fetch-then-set — false positive for this rule.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load().catch((e) => setErr(String(e)));
  }, [load]);

  // poll while the pipeline is still running
  useEffect(() => {
    if (!note || (note.status !== "transcribing" && note.status !== "summarizing")) return;
    const t = setInterval(() => void load().catch(() => {}), 4000);
    return () => clearInterval(t);
  }, [note, load]);

  const save = async () => {
    try {
      await api("PATCH", "/api/notes", { id, title, content: draft });
      setEditing(false);
      await load();
      onChanged();
    } catch (e) {
      setErr(String(e));
    }
  };

  const del = async () => {
    if (!confirm("このノートを削除しますか？")) return;
    await api("DELETE", `/api/notes?id=${encodeURIComponent(id)}`);
    onChanged();
    onClose();
  };

  return (
    <div className="scrim" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal wide">
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          {editing ? (
            <input style={{ flex: 1 }} value={title} onChange={(e) => setTitle(e.target.value)} />
          ) : (
            <h3 style={{ margin: 0, flex: 1 }}>{note?.title ?? "…"}</h3>
          )}
          <button className="btn" onClick={onClose}>閉じる</button>
        </div>
        {err && <p className="errline">{err}</p>}
        {!note ? <p className="hint">読み込み中…</p> : (
          <div className="notebody">
            {(note.status === "transcribing" || note.status === "summarizing") && (
              <p className="hint">⏳ {STATUS_LABEL[note.status]}（自動更新されます）</p>
            )}
            {note.status === "error" && <p className="errline">{note.error}</p>}
            {editing ? (
              <textarea className="mono noteedit" value={draft} onChange={(e) => setDraft(e.target.value)} />
            ) : note.content ? (
              <div className="md"><ReactMarkdown remarkPlugins={[remarkGfm]}>{note.content}</ReactMarkdown></div>
            ) : note.status === "done" ? (
              <p className="hint">（本文なし）</p>
            ) : null}
            {note.transcript && (
              <div className="tsfold">
                <button className="link" onClick={() => setShowTranscript((v) => !v)}>
                  {showTranscript ? "▾" : "▸"} 文字起こし全文（{Math.round(note.transcript.length / 1000)}k字）
                </button>
                {showTranscript && <pre className="pre ts">{note.transcript}</pre>}
              </div>
            )}
          </div>
        )}
        {note && (
          <div className="modal-foot">
            <button className="link-danger" onClick={() => void del()}>削除</button>
            <div className="spacer" />
            {editing ? (
              <>
                <button className="btn" onClick={() => setEditing(false)}>キャンセル</button>
                <button className="btn btn-primary" onClick={() => void save()}>保存</button>
              </>
            ) : (
              <button className="btn" disabled={note.status !== "done" && note.status !== "error"}
                onClick={() => { setEditing(true); setDraft(note.content ?? ""); setTitle(note.title); }}>
                編集
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ===================================================================== page */
export default function NotesClient() {
  const [items, setItems] = useState<NoteView[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const r = await api("GET", "/api/notes");
      setItems(r.notes || []);
    } catch (e) {
      setErr(String(e));
    }
  }, []);

  useEffect(() => {
    // "/notes?open=<id>" (from an event's note list) opens that note directly.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    const o = new URLSearchParams(window.location.search).get("open");
    if (o) setOpen(o);
    void reload();
  }, [reload]);

  // poll while anything is in-flight
  useEffect(() => {
    if (!items.some((n) => n.status === "transcribing" || n.status === "summarizing")) return;
    const t = setInterval(() => void reload(), 5000);
    return () => clearInterval(t);
  }, [items, reload]);

  return (
    <div className="app">
      <Dock />
      <div className="main">
      <div className="topbar">
        <span className="brand">Kairos</span>
        <div className="range">ノート</div>
        <div className="spacer" />
        <button className="btn" onClick={() => void reload()} title="再読み込み"><RefreshIcon size={16} /></button>
      </div>
      <div className="scrollwrap">
      <div className="page">
        {err && <p className="errline">{err}</p>}
        <AudioUpload onStarted={() => void reload()} />
        <h2 className="sect">ノート一覧</h2>
        {items.length === 0 && <p className="hint">まだノートがありません。音声を投げるか、予定の詳細から作れます。</p>}
        <div className="loglist">
          {items.map((n) => (
            <button key={n.id} className="logcard notecard" onClick={() => setOpen(n.id)}>
              <div className="lk">{n.hasAudio ? "🎙" : "📝"}</div>
              <div className="lmain">
                <div className="lt">{n.title}</div>
                <div className="lmeta">
                  {fmtDate(n.createdAt)}
                  {n.status !== "done" && ` ・ ${STATUS_LABEL[n.status] ?? n.status}`}
                  {n.eventKey && " ・ 📅 予定に紐付き"}
                </div>
                {n.status === "error" && <div className="lnote" style={{ color: "var(--danger)" }}>{n.error}</div>}
              </div>
            </button>
          ))}
        </div>
      </div>
      </div>
      </div>
      <MobileTabs />
      {open && <NoteModal id={open} onClose={() => setOpen(null)} onChanged={() => void reload()} />}
    </div>
  );
}
