"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Dock, MobileTabs } from "../nav";
import { RefreshIcon } from "../icons";

/**
 * Notes (NotebookLM-ish): audio → whisperX transcript → agent markdown note.
 * The list polls while any note is still transcribing/summarizing.
 */

export type NoteAudioView = {
  id: string; seq: number; label: string | null; language: string | null;
  status: string; error: string | null;
};

export type NoteView = {
  id: string; eventKey: string | null; title: string; content: string | null;
  transcript: string | null; status: string; error: string | null;
  hasAudio: boolean; audios: NoteAudioView[]; notebook: string | null;
  createdAt: number | null; updatedAt: number | null;
  sources?: number; folder?: string | null; // 一覧APIのみ: 紐付きフォルダのソース数
};

/* NotebookLM風カード: 授業(notebook)ごとに決まった絵文字と色相 */
const NB_EMOJI = ["📚", "🎓", "📊", "🧠", "🤖", "⚙️", "🔬", "🧮", "🌏", "📝", "💡", "🏛️", "📐", "🎯", "🎨", "🗄️", "📡", "⚖️", "🚀", "💬"];
function nbHash(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + (c.codePointAt(0) ?? 0)) >>> 0;
  return h;
}
function nbEmoji(n: NoteView): string {
  if (n.status === "error") return "⚠️";
  return NB_EMOJI[nbHash(n.notebook ?? n.title) % NB_EMOJI.length];
}
function nbTint(n: NoteView): CSSProperties {
  const h = nbHash(n.notebook ?? n.title) % 360;
  return {
    background: `linear-gradient(135deg, hsl(${h} 32% 17%), hsl(${h} 26% 13%))`,
    borderColor: `hsl(${h} 30% 28%)`,
  };
}

const LANG_LABEL: Record<string, string> = { ja: "日本語", en: "英語", auto: "自動判定" };

function LangSelect({ value, onChange, title }: {
  value: string; onChange: (v: string) => void; title?: string;
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} title={title ?? "音声の言語"}>
      <option value="ja">日本語</option>
      <option value="en">英語</option>
      <option value="auto">自動判定</option>
    </select>
  );
}

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
  onStarted: (noteId?: string, merged?: boolean, title?: string) => void; compact?: boolean;
}) {
  const [files, setFiles] = useState<{ file: File; lang: string }[]>([]);
  const [title, setTitle] = useState("");
  const [notebook, setNotebook] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const go = async () => {
    if (files.length === 0 || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const fd = new FormData();
      for (const f of files) {
        fd.append("file", f.file);
        fd.append("language", f.lang);
      }
      fd.append("title", title.trim() || files[0].file.name);
      if (notebook.trim()) fd.append("notebook", notebook.trim());
      if (eventKey) fd.append("eventKey", eventKey);
      if (eventLabel) fd.append("eventLabel", eventLabel);
      const r = await fetch("/api/notes/ingest", { method: "POST", body: fd });
      if (!r.ok) throw new Error(await r.text());
      const d = (await r.json()) as { id: string; merged?: boolean; title?: string };
      setFiles([]);
      setTitle("");
      if (fileRef.current) fileRef.current.value = "";
      onStarted(d.id, d.merged, d.title);
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
        <input ref={fileRef} type="file" multiple accept="audio/*,.m4a,.mp3,.wav,.ogg,.opus,.mp4"
          onChange={(e) => setFiles(Array.from(e.target.files ?? []).map((file) => ({ file, lang: "ja" })))} />
        <input placeholder="タイトル（例: 経営管理 第12回）" value={title}
          style={{ flex: 1, minWidth: 140 }}
          onChange={(e) => setTitle(e.target.value)} />
        {files.length === 1 && (
          <LangSelect value={files[0].lang}
            onChange={(lang) => setFiles((fs) => [{ ...fs[0], lang }])} />
        )}
        {!compact && (
          <input placeholder="分類（例: 経営管理）※AIチャットの検索単位" value={notebook}
            style={{ flex: 1, minWidth: 120 }}
            onChange={(e) => setNotebook(e.target.value)} />
        )}
        <button className="btn btn-primary" disabled={files.length === 0 || busy} onClick={() => void go()}>
          {busy ? "アップロード中…" : files.length > 1 ? `${files.length}本を1セットで開始` : "文字起こし開始"}
        </button>
      </div>
      {files.length > 1 && (
        <div style={{ margin: "6px 0 0", display: "grid", gap: 4 }}>
          {files.map((f, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className="hint" style={{ margin: 0 }}>音源{i + 1}</span>
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.file.name}</span>
              <LangSelect value={f.lang} title={`音源${i + 1}の言語`}
                onChange={(lang) => setFiles((fs) => fs.map((x, j) => (j === i ? { ...x, lang } : x)))} />
              <button className="btn" title="この音源を外す"
                onClick={() => setFiles((fs) => fs.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
          <p className="hint" style={{ margin: 0 }}>
            複数ファイルは順番に文字起こしして1つのノートにまとめます（前半/後半、日本語の講義+英語の上映など、音源ごとに言語を選べます）。
          </p>
        </div>
      )}
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
  const [titleEdit, setTitleEdit] = useState(false); // タイトルだけのインライン編集
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

  // タイトルだけの保存（文字起こし中でも可能）
  const saveTitle = async () => {
    try {
      await api("PATCH", "/api/notes", { id, title: title.trim() || "(無題)" });
      setTitleEdit(false);
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

  // 文字起こしのやり直し（幻覚ループ・言語ミス時のリカバリ）。audioId 指定でその音源だけ。
  // language="keep" = ♻全更新（各音源の言語設定のまま全部やり直し + 資料も取り直して再要約）
  const redo = async (language: string, audioId?: string, label?: string) => {
    const target = audioId ? `音源「${label ?? ""}」` : "全音源";
    const how = language === "keep" ? "現在の言語設定のまま" : `${LANG_LABEL[language] ?? language}で`;
    if (!confirm(`${target}を${how}再文字起こしします。現在の文字起こしと要約は上書きされます。よろしいですか？`)) return;
    try {
      await api("POST", "/api/notes/redo", { id, language, ...(audioId ? { audioId } : {}) });
      await load();
      onChanged();
    } catch (e) {
      setErr(String(e).slice(0, 200));
    }
  };

  // 音源の追加（選んだ言語で即アップロード → 追加分だけ文字起こし → 再要約）
  const [addLang, setAddLang] = useState("ja");
  const addRef = useRef<HTMLInputElement>(null);
  const addAudios = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    try {
      const fd = new FormData();
      fd.append("id", id);
      for (const f of Array.from(list)) {
        fd.append("file", f);
        fd.append("language", addLang);
      }
      const r = await fetch("/api/notes/audio", { method: "POST", body: fd });
      if (!r.ok) throw new Error(await r.text());
      if (addRef.current) addRef.current.value = "";
      await load();
      onChanged();
    } catch (e) {
      setErr(String(e).slice(0, 200));
    }
  };

  // 要約だけ作り直す（文字起こしはそのまま、フォルダの資料を取り直す）
  const [resumBusy, setResumBusy] = useState(false);
  const resummarize = async () => {
    setResumBusy(true);
    setErr(null);
    try {
      await api("POST", "/api/notes/resummarize", { id });
      await load(); // summarizing に変わる → ポーリングが引き継ぐ
      onChanged();
    } catch (e) {
      setErr(String((e as Error).message ?? e).slice(0, 200));
    } finally {
      setResumBusy(false);
    }
  };

  // 資料の追加（ノートのフォルダに保存 → RAG登録 → 資料込みで再要約）
  const matRef = useRef<HTMLInputElement>(null);
  const [matBusy, setMatBusy] = useState(false);
  const addMaterials = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    setMatBusy(true);
    try {
      const fd = new FormData();
      fd.append("id", id);
      for (const f of Array.from(list)) fd.append("file", f);
      const r = await fetch("/api/notes/material", { method: "POST", body: fd });
      if (!r.ok) throw new Error(await r.text());
      if (matRef.current) matRef.current.value = "";
      await load();
      onChanged();
    } catch (e) {
      setErr(String(e).slice(0, 200));
    } finally {
      setMatBusy(false);
    }
  };

  return (
    <div className="scrim" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal wide">
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          {editing || titleEdit ? (
            <input
              style={{ flex: 1 }} value={title} autoFocus
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && titleEdit) void saveTitle();
                if (e.key === "Escape" && titleEdit) setTitleEdit(false);
              }}
            />
          ) : (
            <h3 style={{ margin: 0, flex: 1 }}>{note?.title ?? "…"}</h3>
          )}
          {!editing && (titleEdit ? (
            <button className="btn btn-primary" onClick={() => void saveTitle()}>保存</button>
          ) : (
            <button className="btn" title="タイトルを編集"
              onClick={() => { setTitle(note?.title ?? ""); setTitleEdit(true); }}>✏️</button>
          ))}
          <button className="btn" onClick={onClose}>閉じる</button>
        </div>
        {err && <p className="errline">{err}</p>}
        {!note ? <p className="hint">読み込み中…</p> : (
          <div className="notebody">
            {(note.status === "transcribing" || note.status === "summarizing") && (
              <p className="hint" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                ⏳ {STATUS_LABEL[note.status]}（自動更新されます）
                {note.status === "transcribing" && (
                  <button className="btn" title="文字起こしを停止（音源は残ります。🔁そのまま再実行 や ♻全更新 で再開できます）"
                    onClick={() => {
                      void api("POST", "/api/notes/stop", { id }).then(() => { void load(); onChanged(); })
                        .catch((e) => setErr(String((e as Error).message ?? e).slice(0, 150)));
                    }}>⏹ 停止</button>
                )}
              </p>
            )}
            {note.status === "error" && <p className="errline">{note.error}</p>}
            {note.audios.length > 0 && (
              <div className="tsfold">
                <p className="hint" style={{ margin: "4px 0" }}>🎙 音源（{note.audios.length}）</p>
                {note.audios.map((a) => (
                  <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "2px 0" }}>
                    <span className="hint" style={{ margin: 0 }}>#{a.seq}</span>
                    <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {a.label ?? "(無題)"}
                    </span>
                    <span className="hint" style={{ margin: 0 }}>
                      {LANG_LABEL[a.language ?? "ja"] ?? a.language}
                      {a.status === "pending" && " ・待機中"}
                      {a.status === "transcribing" && " ・文字起こし中…"}
                      {a.status === "error" && ` ・失敗: ${(a.error ?? "").slice(0, 60)}`}
                    </span>
                    {(note.status === "done" || note.status === "error") && (
                      <select
                        className="btn" defaultValue="" title="この音源だけ再文字起こし（他の音源は触らない）"
                        onChange={(e) => { if (e.target.value) { void redo(e.target.value, a.id, a.label ?? `#${a.seq}`); e.target.value = ""; } }}
                      >
                        <option value="" disabled>🔁</option>
                        <option value="keep">そのまま再実行</option>
                        <option value="ja">日本語で</option>
                        <option value="en">英語で</option>
                        <option value="auto">自動判定で</option>
                      </select>
                    )}
                  </div>
                ))}
              </div>
            )}
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
            {note.hasAudio && !editing && (note.status === "done" || note.status === "error") && (
              <>
                <button className="btn"
                  title="全更新 — 全音源を各言語設定のまま再文字起こしし、フォルダの資料も取り直して要約を作り直します"
                  onClick={() => void redo("keep")}>♻ 全更新</button>
                <select
                  className="btn" defaultValue="" title="言語を変えて全音源をやり直す（幻覚ループ・言語ミス時）"
                  onChange={(e) => { if (e.target.value) { void redo(e.target.value); e.target.value = ""; } }}
                >
                  <option value="" disabled>🔁 言語変更…</option>
                  <option value="ja">日本語で</option>
                  <option value="en">英語で</option>
                  <option value="auto">自動判定で</option>
                </select>
              </>
            )}
            {!editing && (note.status === "done" || note.status === "error") && (
              <>
                <input ref={addRef} type="file" multiple hidden
                  accept="audio/*,.m4a,.mp3,.wav,.ogg,.opus,.mp4"
                  onChange={(e) => void addAudios(e.target.files)} />
                <LangSelect value={addLang} onChange={setAddLang} title="追加する音源の言語" />
                <button className="btn" title="このノートに音源を追加（結合して要約し直す）"
                  onClick={() => addRef.current?.click()}>＋音源追加</button>
                <input ref={matRef} type="file" multiple hidden
                  accept=".pdf,.pptx,.docx,.xlsx,.csv,.md,.txt,.html"
                  onChange={(e) => void addMaterials(e.target.files)} />
                <button className="btn" disabled={matBusy}
                  title="このノートに資料(pdf/pptx等)を追加 — フォルダに保存し、資料の内容も踏まえて要約し直します"
                  onClick={() => matRef.current?.click()}>{matBusy ? "追加中…" : "＋資料追加"}</button>
                <button className="btn" disabled={resumBusy}
                  title="要約だけ作り直す（文字起こしはそのまま）。OneDrive側でフォルダに置いた資料もすぐ反映されます"
                  onClick={() => void resummarize()}>{resumBusy ? "…" : "🔄 要約を更新"}</button>
              </>
            )}
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

/* ----------------------------------------------------------- materials card */
type Material = { id: string; notebook: string; filename: string; size: number | null; inRag: boolean; createdAt: number | null };

/* ---------------------------------------------------------- course folders */
type FolderInfo = { folder: string; notebook: string; files: number; notes: number };

type SessionRow = {
  n: number | null; ymd: string; dateMs: number; future: boolean;
  folder: string | null; files: string[];
  fileNo: number | null; noMismatch: boolean;
  noteId: string | null; noteStatus: string | null; noteTitle: string | null;
};
type CourseViewResp = {
  course: string; sessions: SessionRow[]; looseFiles: string[];
  otherFolders: { name: string; files: number }[];
};

const WDAY = ["日", "月", "火", "水", "木", "金", "土"];
function fmtYmdShort(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00`);
  return `${d.getMonth() + 1}/${d.getDate()}(${WDAY[d.getDay()]})`;
}

/**
 * 授業ビュー: カレンダーから割り出した「第N回=何月何日」に、その回のフォルダ・
 * 資料・ノートを対応付ける。資料がある回はその場でノート生成でき、フォルダに
 * 後からファイルを置けば5分毎のスキャンがノートを自動更新する。
 */
function CourseFoldersCard({ selected, onSelect, onOpenNote, onNotesChanged }: {
  selected: string | null; onSelect: (notebook: string | null) => void;
  onOpenNote: (noteId: string) => void; onNotesChanged: () => void;
}) {
  const [items, setItems] = useState<FolderInfo[]>([]);
  const [openCourse, setOpenCourse] = useState<string | null>(null);
  const [view, setView] = useState<CourseViewResp | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // 実行中アクションのymd
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    void api("GET", "/api/notebooks").then((r) => setItems(r.notebooks || [])).catch(() => {});
  }, []);

  const loadView = useCallback(async (course: string) => {
    try {
      setView(await api("GET", `/api/notebooks?course=${encodeURIComponent(course)}`));
    } catch {
      setView({ course, sessions: [], looseFiles: [], otherFolders: [] });
    }
  }, []);

  // 作成中のノートがある間は自動更新
  useEffect(() => {
    if (!openCourse || !view?.sessions.some((s) => s.noteStatus === "transcribing" || s.noteStatus === "summarizing")) return;
    const t = setInterval(() => void loadView(openCourse), 8000);
    return () => clearInterval(t);
  }, [openCourse, view, loadView]);

  const toggle = async (f: FolderInfo) => {
    if (openCourse === f.folder) {
      setOpenCourse(null);
      setView(null);
      onSelect(null);
      return;
    }
    setOpenCourse(f.folder);
    setView(null);
    setMsg(null);
    onSelect(f.notebook);
    await loadView(f.folder);
  };

  const createNote = async (s: SessionRow) => {
    if (!openCourse) return;
    setBusy(s.ymd);
    setMsg(null);
    try {
      await api("POST", "/api/notebooks", { course: openCourse, ymd: s.ymd });
      await loadView(openCourse);
      onNotesChanged();
    } catch (e) {
      setMsg(String((e as Error).message ?? e).slice(0, 200));
    } finally {
      setBusy(null);
    }
  };

  const prepareFolder = async (s: SessionRow) => {
    if (!openCourse) return;
    setBusy(s.ymd);
    try {
      const r = await api("POST", "/api/notebooks", { course: openCourse, ymd: s.ymd, prepare: true });
      setMsg(`📁 ${r.folder} を作成しました。資料や録音をここに置くと自動でノート化されます`);
      await loadView(openCourse);
    } catch (e) {
      setMsg(String((e as Error).message ?? e).slice(0, 200));
    } finally {
      setBusy(null);
    }
  };

  const bulk = async () => {
    if (!openCourse) return;
    setBusy("bulk");
    try {
      const r = await api("POST", "/api/notebooks", { course: openCourse, bulk: true });
      setMsg(r.queued > 0
        ? `${r.queued}回分をキューに入れました（5分毎に2件ずつ自動生成されます）`
        : "対象なし（資料がありノート未作成の回はありません）");
    } catch (e) {
      setMsg(String((e as Error).message ?? e).slice(0, 200));
    } finally {
      setBusy(null);
    }
  };

  if (items.length === 0) return null;
  const creatable = view?.sessions.filter((s) => !s.future && s.files.length > 0 && !s.noteId).length ?? 0;
  return (
    <div className="card">
      <h3>📚 授業（OneDrive: 授業資料 × カレンダー）</h3>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {items.map((f) => (
          <button key={f.folder}
            className={`btn${selected === f.notebook ? " btn-primary" : ""}`}
            onClick={() => void toggle(f)}
            title={`資料${f.files}件 / ノート${f.notes}件`}>
            {f.folder} <span className="hint" style={{ margin: 0 }}>{f.files}📄{f.notes > 0 ? ` ${f.notes}📝` : ""}</span>
          </button>
        ))}
      </div>
      {openCourse && (
        <div style={{ marginTop: 8 }}>
          {view === null ? <p className="hint">読み込み中…</p> : (
            <>
              {view.sessions.length === 0 && <p className="hint">カレンダーにこの授業の予定が見つかりません。</p>}
              <div style={{ maxHeight: 320, overflowY: "auto" }}>
                {view.sessions.map((s) => (
                  <div key={s.ymd}
                    style={{ display: "flex", gap: 8, alignItems: "center", padding: "2px 0", opacity: s.future ? 0.5 : 1 }}>
                    <span style={{ width: 52, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                      {(s.fileNo ?? s.n) != null ? `第${s.fileNo ?? s.n}回` : "—"}
                    </span>
                    {s.noMismatch && (
                      <span title={`⚠ 資料は「第${s.fileNo}回」表記なのにカレンダー数えでは${s.n}番目 — 休講の予定がカレンダーに残っていてズレている可能性。フォルダの日付を確認してください`}
                        style={{ flex: "none", cursor: "help" }}>⚠</span>
                    )}
                    <span style={{ width: 64 }}>{fmtYmdShort(s.ymd)}</span>
                    <span className="hint" style={{ margin: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                      title={s.files.join("\n") || (s.folder ? "（ファイルなし）" : "（フォルダ未作成）")}>
                      {s.files.length > 0 ? `📄${s.files.length}件` : s.folder ? "空" : ""}
                      {s.files.length > 0 && ` — ${s.files.join(" / ")}`}
                    </span>
                    {s.noteId ? (
                      <button className="btn" onClick={() => onOpenNote(s.noteId!)}
                        title={s.noteTitle ?? ""}>
                        {s.noteStatus === "done" ? "📝開く"
                          : s.noteStatus === "error" ? "⚠開く"
                          : "⏳作成中"}
                      </button>
                    ) : s.future ? null : s.files.length > 0 ? (
                      <button className="btn" disabled={busy != null}
                        title="この回の資料・録音からノートを生成"
                        onClick={() => void createNote(s)}>
                        {busy === s.ymd ? "…" : "ノート作成"}
                      </button>
                    ) : !s.folder ? (
                      <button className="btn" disabled={busy != null}
                        title="この回のフォルダを作る（あとで資料や録音を置くだけで自動ノート化）"
                        onClick={() => void prepareFolder(s)}>
                        {busy === s.ymd ? "…" : "📁"}
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
              {(view.looseFiles.length > 0 || view.otherFolders.length > 0) && (
                <p className="hint" style={{ margin: "6px 0 0" }}
                  title={[...view.looseFiles, ...view.otherFolders.map((o) => `${o.name}/`)].join("\n")}>
                  回に紐付かない: {view.looseFiles.length > 0 && `未整理ファイル${view.looseFiles.length}件 `}
                  {view.otherFolders.map((o) => `📁${o.name}(${o.files})`).join(" ")}
                </p>
              )}
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6, flexWrap: "wrap" }}>
                <button className="btn" disabled={busy != null}
                  title="全回のノートを横断して試験対策の総まとめノートを生成（再実行で作り直し）"
                  onClick={() => {
                    setBusy("summary");
                    void api("POST", "/api/notebooks", { course: openCourse, summary: true })
                      .then((r) => { onOpenNote(r.noteId); onNotesChanged(); })
                      .catch((e) => setMsg(String((e as Error).message ?? e).slice(0, 150)))
                      .finally(() => setBusy(null));
                  }}>
                  {busy === "summary" ? "…" : "📚 総まとめ（テスト対策）"}
                </button>
                {creatable > 1 && (
                  <button className="btn" disabled={busy != null} onClick={() => void bulk()}>
                    {busy === "bulk" ? "…" : `資料がある${creatable}回分をまとめてノート化`}
                  </button>
                )}
                <span className="hint" style={{ margin: 0 }}>
                  チャット(OWUI)では「#」→「講義: {openCourse}」でこの授業だけを参照できます。
                </span>
              </div>
              {msg && <p className="hint" style={{ margin: "4px 0 0" }}>{msg}</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function fmtSize(n: number | null): string {
  if (n == null) return "";
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}MB` : `${Math.round(n / 1000)}KB`;
}

/** NotebookLM的なソース資料: ノートブック（RAGの棚）にファイルを追加・削除。 */
function MaterialsCard() {
  const [items, setItems] = useState<Material[]>([]);
  const [notebooks, setNotebooks] = useState<string[]>([]);
  const [notebook, setNotebook] = useState("");
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [openList, setOpenList] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    const r = await api("GET", "/api/materials");
    setItems(r.materials || []);
    setNotebooks(r.notebooks || []);
  }, []);
  useEffect(() => {
    // fetch-then-set — false positive for this rule.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload().catch((e) => setErr(String(e)));
  }, [reload]);

  const upload = useCallback(async (files: FileList) => {
    setUploading(true);
    setErr(null);
    try {
      const fd = new FormData();
      for (const f of Array.from(files)) fd.append("files", f);
      if (notebook.trim()) fd.append("notebook", notebook.trim());
      const r = await fetch("/api/materials", { method: "POST", body: fd });
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail ?? `HTTP ${r.status}`);
      if (d.errors?.length) setErr(d.errors.join(" / "));
      setOpenList(true);
      await reload();
    } catch (e) {
      setErr(String(e).slice(0, 300));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }, [notebook, reload]);

  const del = useCallback(async (m: Material) => {
    if (!confirm(`資料「${m.filename}」を削除しますか？（RAGからも外れます）`)) return;
    await api("DELETE", `/api/materials?id=${encodeURIComponent(m.id)}`);
    await reload();
  }, [reload]);

  // ノートブックごとにグループ
  const groups = new Map<string, Material[]>();
  for (const m of items) {
    const g = groups.get(m.notebook) ?? [];
    g.push(m);
    groups.set(m.notebook, g);
  }

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <strong>📚 資料（RAGのソース）</strong>
        <input
          list="notebook-list" placeholder="ノートブック（空=Kairos ノート）"
          value={notebook} onChange={(e) => setNotebook(e.target.value)}
          style={{ flex: 1, minWidth: 180 }}
        />
        <datalist id="notebook-list">
          {notebooks.map((n) => <option key={n} value={n} />)}
        </datalist>
        <button className="btn btn-primary" onClick={() => fileRef.current?.click()} disabled={uploading}>
          {uploading ? "登録中…" : "＋ ファイル追加"}
        </button>
        <input
          ref={fileRef} type="file" hidden multiple
          accept=".pdf,.docx,.pptx,.xlsx,.csv,.txt,.md,.html"
          onChange={(e) => { if (e.target.files?.length) void upload(e.target.files); }}
        />
      </div>
      <p className="hint" style={{ margin: "6px 0 0" }}>
        pdf / pptx / docx / xlsx などを棚（ノートブック）に追加すると、チャットのAIが自動で参照します。
      </p>
      {err && <p className="errline">{err}</p>}
      {items.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <button className="link" onClick={() => setOpenList((v) => !v)}>
            {openList ? "▾" : "▸"} 登録済み {items.length}件
          </button>
          {openList && [...groups.entries()].map(([nb, ms]) => (
            <div key={nb} style={{ marginTop: 6 }}>
              <div className="lmeta" style={{ fontWeight: 600 }}>{nb}</div>
              {ms.map((m) => (
                <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0" }}>
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    🗂 {m.filename}
                  </span>
                  <span className="lmeta">{fmtSize(m.size)}{m.inRag ? "" : " ・⚠RAG未登録"}</span>
                  <button className="btn" onClick={() => void del(m)}>✕</button>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ===================================================================== page */
export default function NotesClient() {
  const [items, setItems] = useState<NoteView[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<string | null>(null); // 授業フォルダで絞り込み

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
    const o = new URLSearchParams(window.location.search).get("open");
    if (o) queueMicrotask(() => setOpen(o));
    const timer = window.setTimeout(() => void reload(), 0);
    return () => window.clearTimeout(timer);
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
        <AudioUpload onStarted={(noteId) => { void reload(); if (noteId) setOpen(noteId); }} />
        <CourseFoldersCard selected={filter} onSelect={setFilter}
          onOpenNote={setOpen} onNotesChanged={() => void reload()} />
        <MaterialsCard />
        <h2 className="sect">
          ノート一覧{filter && <> — {filter.replace(/^講義:\s*/, "")} <button className="btn" onClick={() => setFilter(null)}>✕</button></>}
        </h2>
        {items.length === 0 && <p className="hint">まだノートがありません。音声を投げるか、予定の詳細から作れます。</p>}
        <div className="notegrid">
          {items.filter((n) => !filter || n.notebook === filter).map((n) => (
            <button key={n.id} className="nbcard" style={nbTint(n)} onClick={() => setOpen(n.id)}
              title={n.folder ? `📁 ${n.folder}` : n.notebook ?? ""}>
              <div className="nbemoji">{nbEmoji(n)}</div>
              <div className="nbtitle">{n.title}</div>
              <div className="nbmeta">
                {fmtDate(n.createdAt)} ・ ソース{n.sources ?? (n.hasAudio ? n.audios.length : 0)}個
                {n.status !== "done" && <span className="nbstat"> ・ {STATUS_LABEL[n.status] ?? n.status}</span>}
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
