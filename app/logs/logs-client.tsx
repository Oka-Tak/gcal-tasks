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
        <div className="range">睡眠記録</div>
        <div className="spacer" />
      </div>

      <div className="scrollwrap">
      <div className="page">
        <p className="lead">
          スマートウォッチの睡眠スクショなどを取り込むと、AI
          が読み取って記録します。ここに溜めた「実際にやったこと」が、タスクの所要時間を
          あなた基準で見積もるためのナレッジになります（ローカル DB のみ・Google には送りません）。
        </p>

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
