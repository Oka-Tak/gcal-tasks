"use client";

import { useCallback, useEffect, useState } from "react";
import { ChatPane } from "../chat-pane";
import { Dock, MobileTabs } from "../nav";
import { PlusIcon } from "../icons";

/**
 * The AI assistant tab: topic threads in a Floorp-workspace-style sidebar
 * (chips on mobile), each thread its own conversation with the planning agent.
 */

type ThreadInfo = { id: string; title: string; updatedAt: number; count: number };

type UsageBucket = {
  key: string; calls: number; errors: number; inputTokens: number; outputTokens: number;
  totalTokens: number; costUsd: number; credits: number; durationMs: number;
};
type QuotaLimit = { label: string; remainingPercent: number; resetsAt?: number | null; detail?: string };
type AgentQuota = { agent: string; plan?: string; asOf?: number | null; limits: QuotaLimit[]; error?: string };
type UsageReport = {
  days: number; byDay: UsageBucket[]; byModel: UsageBucket[]; total: UsageBucket;
  quotas: AgentQuota[];
};

const fmtTok = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k`
  : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

function UsageModal({ onClose }: { onClose: () => void }) {
  const [report, setReport] = useState<UsageReport | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    // fetch-then-set — false positive for this rule.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetch("/api/usage")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(setReport)
      .catch((e) => setErr(String(e)));
  }, []);

  const pad2 = (n: number) => String(n).padStart(2, "0");
  const fmtReset = (ms?: number | null) => {
    if (!ms) return "";
    const d = new Date(ms);
    return `${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())} リセット`;
  };

  const row = (b: UsageBucket) => (
    <tr key={b.key}>
      <td>{b.key}</td>
      <td>{b.calls}{b.errors > 0 && <span className="uerr"> ({b.errors}✕)</span>}</td>
      <td>{b.totalTokens ? fmtTok(b.totalTokens) : "—"}</td>
      <td>{b.costUsd ? `$${b.costUsd.toFixed(2)}` : "—"}</td>
      <td>{b.credits ? b.credits.toFixed(2) : "—"}</td>
    </tr>
  );
  const head = (label: string) => (
    <thead><tr><th>{label}</th><th>回数</th><th>tok</th><th>USD</th><th>cr</th></tr></thead>
  );

  return (
    <div className="scrim" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <div style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
          <h3 style={{ margin: 0, flex: 1 }}>AI使用量（直近{report?.days ?? 30}日）</h3>
          <button className="btn" onClick={onClose}>閉じる</button>
        </div>
        {err && <p className="errline">{err}</p>}
        {!report && !err && <p className="hint">読み込み中…</p>}
        {report && (
          <div className="usagewrap">
            <h4 className="usect">残り枠</h4>
            {report.quotas.map((q) => (
              <div key={q.agent} className="quota">
                <div className="qhead">
                  <span className="qname">{q.agent}</span>
                  {q.plan && <span className="qplan">{q.plan}</span>}
                </div>
                {q.error && <div className="qerr">{q.error}</div>}
                {q.limits.map((l) => (
                  <div key={l.label} className="qrow">
                    <span className="qlabel">{l.label}</span>
                    <span className="qbar">
                      <span
                        className={`qfill${l.remainingPercent < 15 ? " low" : l.remainingPercent < 40 ? " mid" : ""}`}
                        style={{ width: `${l.remainingPercent}%` }}
                      />
                    </span>
                    <span className="qpct">残り{Math.round(l.remainingPercent)}%</span>
                    <span className="qreset">{l.detail ?? fmtReset(l.resetsAt)}</span>
                  </div>
                ))}
              </div>
            ))}
            <h4 className="usect">使った量（直近{report.days}日）</h4>
            <p className="hint" style={{ margin: "0 0 4px" }}>
              合計 {report.total.calls} 回 ・ {fmtTok(report.total.totalTokens)} tok
              {report.total.costUsd > 0 && ` ・ $${report.total.costUsd.toFixed(2)}`}
              {report.total.credits > 0 && ` ・ ${report.total.credits.toFixed(2)} cr`}
              （agy はトークン等を報告しないため回数のみ）
            </p>
            <table className="usagetbl">{head("モデル")}<tbody>{report.byModel.map(row)}</tbody></table>
            <table className="usagetbl">{head("日")}<tbody>{report.byDay.slice(0, 14).map(row)}</tbody></table>
          </div>
        )}
      </div>
    </div>
  );
}

export default function AiClient() {
  const [threads, setThreads] = useState<ThreadInfo[]>([]);
  const [current, setCurrent] = useState("general");
  const [drafts, setDrafts] = useState<ThreadInfo[]>([]); // new topics with no messages yet
  const [showUsage, setShowUsage] = useState(false);

  const loadThreads = useCallback(async () => {
    const r = await fetch("/api/chat/threads").then((x) => x.json());
    const list: ThreadInfo[] = r.threads || [];
    setThreads(list);
    // a draft that got its first message is now server-side — drop the local copy
    setDrafts((prev) => prev.filter((d) => !list.some((t) => t.id === d.id)));
  }, []);

  useEffect(() => {
    // fetch-then-set — false positive for this rule.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadThreads();
  }, [loadThreads]);

  const newThread = () => {
    const t = { id: `topic:${crypto.randomUUID()}`, title: "新しい話題", updatedAt: Date.now(), count: 0 };
    setDrafts((prev) => [t, ...prev]);
    setCurrent(t.id);
  };

  const all = [...drafts, ...threads];

  return (
    <div className="app">
      <Dock />
      <div className="main">
      <div className="topbar">
        <span className="brand">Kairos</span>
        <div className="range">AIアシスタント</div>
        <div className="spacer" />
        <button className="btn" onClick={() => setShowUsage(true)} title="AI使用量">使用量</button>
        <button className="btn" onClick={newThread}><PlusIcon size={15} />新しい話題</button>
      </div>
      <div className="aiwrap">
        <nav className="threads">
          {all.map((t) => (
            <button key={t.id} className={`titem${t.id === current ? " on" : ""}`} onClick={() => setCurrent(t.id)}>
              <span className="ttitle">{t.title}</span>
              {t.count > 0 && <span className="tcount">{Math.floor(t.count / 2)}</span>}
            </button>
          ))}
        </nav>
        <main className="chatmain">
          <ChatPane
            key={current} // reset pane state when switching threads
            thread={current}
            emptyHint="この話題について何でもどうぞ。旅程などの大きな依頼は、まず段取りを提示して確認してから順に実行します。"
            onExecuted={() => {}}
            onActivity={() => void loadThreads()}
          />
        </main>
      </div>
      </div>
      <MobileTabs />
      {showUsage && <UsageModal onClose={() => setShowUsage(false)} />}
    </div>
  );
}
