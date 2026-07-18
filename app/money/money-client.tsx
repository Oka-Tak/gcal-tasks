"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Dock, MobileTabs } from "../nav";
import { CATEGORY_LABEL } from "@/lib/money-shared";

/** お金管理（軽量ログ型）: クイック入力・レシートAI取込・月次サマリ。 */

type Expense = {
  id: string;
  amountYen: number;
  category: string;
  title: string | null;
  note: string | null;
  whenMs: number;
  source: string | null;
};

type Summary = {
  totalYen: number;
  byCategory: { category: string; yen: number }[];
  prevTotalYen: number;
  prevMonthTotalYen: number;
  days: number;
};

const pad = (n: number) => String(n).padStart(2, "0");
const yen = (n: number) => `¥${n.toLocaleString()}`;
const CATS = Object.keys(CATEGORY_LABEL);

type Draft = { amountYen: number; category: string; title: string | null; note: string | null; whenMs: number | null };

async function api(method: string, url: string, body?: unknown) {
  const r = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) { window.location.href = "/api/auth/signin"; throw new Error("unauthenticated"); }
  if (!r.ok) throw new Error(await r.text());
  return r.status === 204 ? null : r.json();
}

export default function MoneyClient() {
  // React Compilerのオプトアウト: 手動useCallback（load等）のdepsからstate setterを
  // 省く従来スタイルを維持する。この画面は軽く自動メモ化の恩恵は不要。
  "use no memo";
  const now = new Date();
  const [ym, setYm] = useState<{ y: number; m: number }>({ y: now.getFullYear(), m: now.getMonth() + 1 });
  const [items, setItems] = useState<Expense[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // クイック入力
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState("food");
  const [title, setTitle] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  // 明細ファイル取込のドラフト（プレビュー確認用）
  const [drafts, setDrafts] = useState<Draft[] | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api("GET", `/api/money?year=${ym.y}&month=${ym.m}`);
      setItems(r.expenses || []);
      setSummary(r.summary || null);
    } catch (e) {
      setErr(String(e));
    }
  }, [ym, setItems, setSummary, setErr]);

  useEffect(() => {
    // fetch-then-set — false positive for this rule.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function add() {
    const n = Number(amount);
    if (!Number.isFinite(n) || n === 0 || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await api("POST", "/api/money", { amountYen: n, category, title: title.trim() || null });
      setAmount("");
      setTitle("");
      await load();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  const upload = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    setUploading(true);
    setErr(null);
    try {
      // 複数ファイルを並列処理。明細ファイルはドラフトを集約→まとめてプレビュー、
      // 画像（レシート）はサーバ側で即登録される。
      const results = await Promise.all(files.map(async (f) => {
        const fd = new FormData();
        fd.append("file", f);
        const r = await fetch("/api/money", { method: "POST", body: fd });
        const d = (await r.json().catch(() => null)) as { detail?: string; preview?: boolean; drafts?: Draft[]; created?: unknown[] } | null;
        return { name: f.name, ok: r.ok, status: r.status, d };
      }));
      const errors = results.filter((x) => !x.ok).map((x) => `${x.name}: ${x.d?.detail ?? `HTTP ${x.status}`}`);
      const allDrafts = results.flatMap((x) => (x.ok && x.d?.preview && Array.isArray(x.d.drafts) ? x.d.drafts : []));
      const imageRegistered = results.reduce((s, x) => s + (x.ok && Array.isArray(x.d?.created) ? (x.d?.created?.length ?? 0) : 0), 0);
      if (errors.length) setErr(errors.join(" / ").slice(0, 300));
      if (allDrafts.length) setDrafts(allDrafts);
      else if (imageRegistered) await load();
    } catch (e) {
      setErr(`取込: ${String(e).slice(0, 200)}`);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }, [load, setUploading, setErr, setDrafts]);

  const del = useCallback(async (id: string) => {
    if (!confirm("この支出を削除しますか？")) return;
    await api("DELETE", `/api/money?id=${encodeURIComponent(id)}`);
    await load();
  }, [load]);

  const shiftMonth = (d: number) => {
    const dt = new Date(ym.y, ym.m - 1 + d, 1);
    setYm({ y: dt.getFullYear(), m: dt.getMonth() + 1 });
  };

  const isCurrent = ym.y === now.getFullYear() && ym.m === now.getMonth() + 1;
  const pace = summary && summary.prevTotalYen > 0
    ? Math.round(((summary.totalYen - summary.prevTotalYen) / summary.prevTotalYen) * 100)
    : null;

  // 日付見出しでグループ化
  const groups: { day: string; rows: Expense[] }[] = [];
  for (const e of items) {
    const d = new Date(e.whenMs);
    const day = `${d.getMonth() + 1}/${d.getDate()}（${"日月火水木金土"[d.getDay()]}）`;
    const g = groups[groups.length - 1];
    if (g && g.day === day) g.rows.push(e);
    else groups.push({ day, rows: [e] });
  }

  return (
    <div className="app">
      <Dock />
      <div className="main">
        <div className="topbar">
          <span className="ttitle">💰 お金</span>
          <div className="spacer" />
          <button className="btn" onClick={() => shiftMonth(-1)}>←</button>
          <span style={{ margin: "0 8px", fontWeight: 600 }}>{ym.y}/{pad(ym.m)}</span>
          <button className="btn" onClick={() => shiftMonth(1)} disabled={isCurrent}>→</button>
        </div>
        <div className="pagewrap">
          <div className="page">
            {err && <p className="errline">{err}</p>}

            {/* 月次サマリ */}
            {summary && (
              <div className="card">
                <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 28, fontWeight: 700 }}>{yen(summary.totalYen)}</span>
                  {isCurrent && pace != null && (
                    <span className="hint" style={{ color: pace > 10 ? "var(--danger, #d33)" : "var(--muted)" }}>
                      先月の同時点比 {pace >= 0 ? "+" : ""}{pace}%（先月同日 {yen(summary.prevTotalYen)} / 先月計 {yen(summary.prevMonthTotalYen)}）
                    </span>
                  )}
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
                  {summary.byCategory.map((c) => (
                    <span key={c.category} className="hint" style={{ border: "1px solid var(--border)", borderRadius: 999, padding: "2px 10px" }}>
                      {CATEGORY_LABEL[c.category] ?? c.category} {yen(c.yen)}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* クイック入力 + スクショ取込 */}
            <div className="card">
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <input
                  type="number" inputMode="numeric" placeholder="金額(円)"
                  value={amount} onChange={(e) => setAmount(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void add(); }}
                  style={{ width: 110 }}
                />
                <select value={category} onChange={(e) => setCategory(e.target.value)}>
                  {CATS.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
                </select>
                <input
                  placeholder="店名・品目（任意）" value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void add(); }}
                  style={{ flex: 1, minWidth: 140 }}
                />
                <button className="btn btn-primary" onClick={() => void add()} disabled={busy}>追加</button>
                <button className="btn" onClick={() => fileRef.current?.click()} disabled={uploading}>
                  {uploading ? "読み取り中…" : "📷 レシート/スクショ・明細ファイル"}
                </button>
                <input
                  ref={fileRef} type="file" multiple
                  accept="image/*,.csv,.tsv,.txt,.pdf,.xlsx,.xls"
                  hidden
                  onChange={(e) => { const fs = Array.from(e.target.files ?? []); if (fs.length) void upload(fs); }}
                />
              </div>
              <p className="hint" style={{ marginTop: 6 }}>
                レシート・PayPay等の画面を撮って投げると自動で読み取り。銀行・クレカ・家計簿の
                明細ファイル（CSV / PDF / Excel）は支出だけを抽出して一覧で確認→一括登録できます。
                チャットで「昼飯800円」と言っても記録できます。
              </p>
            </div>

            {/* 一覧 */}
            {groups.length === 0 && <p className="hint">この月の記録はまだありません。</p>}
            {groups.map((g) => (
              <div key={g.day} className="sect">
                <h3 style={{ margin: "14px 2px 6px", fontSize: 13, color: "var(--muted)" }}>
                  {g.day} <span style={{ fontWeight: 400 }}>計 {yen(g.rows.reduce((s, r) => s + r.amountYen, 0))}</span>
                </h3>
                {g.rows.map((e) => (
                  <div key={e.id} className="card" style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", marginBottom: 6 }}>
                    <span style={{ minWidth: 84, fontWeight: 600, textAlign: "right" }}>{yen(e.amountYen)}</span>
                    <span className="hint">{CATEGORY_LABEL[e.category] ?? e.category}</span>
                    <span style={{ flex: 1 }}>{e.title ?? ""}{e.source === "screenshot" ? " 📷" : e.source === "import" ? " 📄" : e.source === "agent" ? " 🤖" : ""}</span>
                    <span className="hint">{pad(new Date(e.whenMs).getHours())}:{pad(new Date(e.whenMs).getMinutes())}</span>
                    <button className="btn" onClick={() => void del(e.id)}>✕</button>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
      <MobileTabs />
      {drafts && (
        <ImportPreview
          drafts={drafts}
          onClose={() => setDrafts(null)}
          onDone={async (jumpY, jumpM) => {
            setDrafts(null);
            // 取り込んだ明細の月へ自動で表示を移す（別月なら ym 変更で自動再読込）
            if (jumpY && jumpM && (jumpY !== ym.y || jumpM !== ym.m)) setYm({ y: jumpY, m: jumpM });
            else await load();
          }}
          onError={setErr}
        />
      )}
    </div>
  );
}

/** 明細ファイルから抽出した支出の確認モーダル。行の除外・カテゴリ修正→一括登録。 */
function ImportPreview({ drafts, onClose, onDone, onError }: {
  drafts: Draft[]; onClose: () => void; onDone: (jumpY?: number, jumpM?: number) => void; onError: (m: string) => void;
}) {
  const [rows, setRows] = useState(() => drafts.map((d) => ({ ...d, keep: true })));
  const [busy, setBusy] = useState(false);
  const keepRows = rows.filter((r) => r.keep);
  const total = keepRows.reduce((s, r) => s + r.amountYen, 0);
  const fmtDay = (ms: number | null) => (ms ? new Date(ms).toISOString().slice(0, 10) : "日付不明");
  // 明細がまたぐ月の内訳（プレビュー見出し用）
  const monthsOf = (list: { whenMs: number | null }[]) => {
    const cnt = new Map<string, number>();
    for (const r of list) { const d = r.whenMs ? new Date(r.whenMs) : new Date(); cnt.set(`${d.getFullYear()}/${d.getMonth() + 1}`, (cnt.get(`${d.getFullYear()}/${d.getMonth() + 1}`) ?? 0) + 1); }
    return [...cnt.entries()].sort((a, b) => b[1] - a[1]);
  };
  const monthBreakdown = monthsOf(keepRows);

  const commit = async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/money", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ drafts: keepRows.map(({ keep: _keep, ...d }) => d) }),
      });
      const d = (await r.json().catch(() => null)) as { detail?: string; created?: { whenMs?: number }[]; skipped?: number } | null;
      if (!r.ok) throw new Error(d?.detail ?? `HTTP ${r.status}`);
      const created = d?.created ?? [];
      // 登録された明細のうち最も件数の多い月へ飛ぶ
      const mb = monthsOf(created.map((c) => ({ whenMs: c.whenMs ?? null })));
      const [jy, jm] = mb.length ? mb[0][0].split("/").map(Number) : [undefined, undefined];
      onError((d?.skipped ?? 0) > 0
        ? `${created.length}件を登録（同額・同日の${d!.skipped}件は重複スキップ）${jy ? ` — ${jy}/${jm} を表示` : ""}`
        : `${created.length}件を登録しました${jy ? ` — ${jy}/${jm} を表示` : ""}`);
      onDone(jy, jm);
    } catch (e) {
      onError(`一括登録: ${String(e).slice(0, 200)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="scrim" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ maxWidth: 640, width: "92vw" }}>
        <h3 style={{ marginTop: 0 }}>明細から支出を取込</h3>
        <p className="hint">
          {keepRows.length}件 / 計 {yen(total)}
          {monthBreakdown.length > 0 && <>（{monthBreakdown.map(([m, c]) => `${m} ${c}件`).join("・")}）</>}
          。要らない行はチェックを外してください。既存と同額・同日の行は登録時に自動スキップされます。登録後は明細の月に自動で表示が移ります。
        </p>
        <div style={{ maxHeight: "56vh", overflowY: "auto", margin: "8px 0" }}>
          {rows.map((r, i) => (
            <div key={i} className="card" style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", marginBottom: 4, opacity: r.keep ? 1 : 0.45 }}>
              <input type="checkbox" checked={r.keep} onChange={(e) => setRows((rs) => rs.map((x, j) => j === i ? { ...x, keep: e.target.checked } : x))} />
              <span className="hint" style={{ minWidth: 78 }}>{fmtDay(r.whenMs)}</span>
              <span style={{ minWidth: 78, fontWeight: 600, textAlign: "right" }}>{yen(r.amountYen)}</span>
              <select value={r.category} onChange={(e) => setRows((rs) => rs.map((x, j) => j === i ? { ...x, category: e.target.value } : x))}>
                {CATS.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
              </select>
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.title ?? ""}</span>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="btn" onClick={onClose} disabled={busy}>キャンセル</button>
          <button className="btn btn-primary" onClick={() => void commit()} disabled={busy || keepRows.length === 0}>
            {busy ? "登録中…" : `${keepRows.length}件を登録`}
          </button>
        </div>
      </div>
    </div>
  );
}
