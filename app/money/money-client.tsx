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

  const load = useCallback(async () => {
    try {
      const r = await api("GET", `/api/money?year=${ym.y}&month=${ym.m}`);
      setItems(r.expenses || []);
      setSummary(r.summary || null);
    } catch (e) {
      setErr(String(e));
    }
  }, [ym]);

  useEffect(() => {
    // fetch-then-set — false positive for this rule.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const add = useCallback(async () => {
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
  }, [amount, category, title, busy, load]);

  const upload = useCallback(async (f: File) => {
    setUploading(true);
    setErr(null);
    try {
      const fd = new FormData();
      fd.append("file", f);
      const r = await fetch("/api/money", { method: "POST", body: fd });
      if (!r.ok) throw new Error((await r.json().catch(() => null))?.detail ?? `HTTP ${r.status}`);
      await load();
    } catch (e) {
      setErr(`スクショ取込: ${String(e).slice(0, 200)}`);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }, [load]);

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
                  {uploading ? "読み取り中…" : "📷 レシート/スクショ"}
                </button>
                <input
                  ref={fileRef} type="file" accept="image/*" hidden
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }}
                />
              </div>
              <p className="hint" style={{ marginTop: 6 }}>
                レシート・PayPay等の画面を撮って投げると自動で読み取ります。チャットで「昼飯800円」と言っても記録できます。
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
                    <span style={{ flex: 1 }}>{e.title ?? ""}{e.source === "screenshot" ? " 📷" : e.source === "agent" ? " 🤖" : ""}</span>
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
    </div>
  );
}
