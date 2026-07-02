"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BotIcon, PersonIcon, TerminalIcon } from "./icons";

/**
 * The chat surface shared by the /ai tab (topic threads) and the per-task
 * modal. Slack-style flat rows (avatar / name / time / text); proposals render
 * as attachment cards and execute only via the approve buttons.
 */

export type ChatMsg = { id: string; role: string; content: string | null; agent?: string | null; createdAt?: number | null };
export type Proposal = {
  id: string; kind: string; summary: string | null; payload: Record<string, unknown>;
  status: string; error?: string | null; createdAt?: number | null;
};

const PROPOSAL_KIND: Record<string, string> = {
  create_task: "タスク作成", update_task: "タスク更新",
  create_event: "予定作成", update_event: "予定変更",
};

const WD = ["日", "月", "火", "水", "木", "金", "土"];
const pad = (n: number) => String(n).padStart(2, "0");
const enc = encodeURIComponent;

const MODELS: { value: string; label: string }[] = [
  { value: "haiku", label: "haiku（軽い）" },
  { value: "sonnet", label: "sonnet（標準）" },
  { value: "opus", label: "opus（重い・計画向き）" },
];

async function api(method: string, url: string, body?: unknown) {
  const r = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

function fmtTime(at?: number | null): string {
  if (!at) return "";
  const d = new Date(at);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === new Date().toDateString()
    ? hm
    : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

function Avatar({ role, agent }: { role: string; agent?: string | null }) {
  return (
    <div className={`cavatar ${role}${agent === "codex" ? " codex" : ""}`}>
      {role === "user" ? <PersonIcon size={19} /> : agent === "codex" ? <TerminalIcon size={19} /> : <BotIcon size={19} />}
    </div>
  );
}

function fmtWhen(v: unknown): string {
  if (typeof v !== "string" || !v) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  return `${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]}) ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A one-line human-readable rendering of what approving would do. */
function proposalDetail(p: Proposal): string {
  const pl = p.payload || {};
  if (p.kind === "create_task") {
    const bits = [`「${pl.title}」`];
    if (pl.due) bits.push(`期限 ${pl.due}${pl.dueTime ? ` ${pl.dueTime}` : ""}`);
    if (pl.estimatedMin) bits.push(`見積 ${pl.estimatedMin}分`);
    if (pl.remindAt) bits.push(`通知 ${fmtWhen(new Date(pl.remindAt as number).toISOString())}`);
    return bits.join(" ・ ");
  }
  if (p.kind === "create_event") {
    return `「${pl.title}」 ${fmtWhen(pl.start)} 〜 ${fmtWhen(pl.end)}`;
  }
  const skip = new Set(["account", "tasklist", "calendarId", "id", "allDay"]);
  return Object.entries(pl)
    .filter(([k, v]) => !skip.has(k) && v !== undefined)
    .map(([k, v]) => {
      if (k === "start" || k === "end") return `${k}: ${fmtWhen(v)}`;
      if (k === "remindAt" && typeof v === "number") return `通知: ${fmtWhen(new Date(v).toISOString())}`;
      return `${k}: ${JSON.stringify(v)}`;
    })
    .join(" ・ ");
}

export function ChatPane({ thread, taskKey, autoMessage, emptyHint, onExecuted, onActivity }: {
  thread?: string | null; // topic thread id ("general" / "topic:<uuid>")
  taskKey?: string | null; // task-bound chat (modal)
  autoMessage?: string;
  emptyHint?: string;
  onExecuted: () => void; // an approved proposal changed calendar/tasks data
  onActivity?: () => void; // a turn completed (thread titles may have changed)
}) {
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [input, setInput] = useState("");
  const [agent, setAgent] = useState<"claude" | "codex">("claude");
  const [model, setModel] = useState("haiku");
  const [busy, setBusy] = useState(false);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [batch, setBatch] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const autoSent = useRef(false);

  // remember the last agent/model choice across sessions
  useEffect(() => {
    const a = localStorage.getItem("kairos-agent");
    const m = localStorage.getItem("kairos-model");
    // one-time localStorage read on mount — intentional.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (a === "codex" || a === "claude") setAgent(a);
    if (m && MODELS.some((x) => x.value === m)) setModel(m);
  }, []);
  const pickAgent = (a: "claude" | "codex") => { setAgent(a); localStorage.setItem("kairos-agent", a); };
  const pickModel = (m: string) => { setModel(m); localStorage.setItem("kairos-model", m); };

  const qs = thread ? `thread=${enc(thread)}` : taskKey ? `taskKey=${enc(taskKey)}` : "";
  const load = useCallback(async () => {
    const r = await api("GET", `/api/chat${qs ? `?${qs}` : ""}`);
    setMsgs(r.messages || []);
    setProposals(r.proposals || []);
    setLoaded(true);
  }, [qs]);

  useEffect(() => {
    // load() awaits the network before setState — false positive for this rule.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, proposals, busy]);

  const sendMessage = useCallback(async (m: string) => {
    if (!m || busy) return;
    setBusy(true);
    setErr(null);
    setMsgs((prev) => [...prev, { id: `tmp-${Date.now()}`, role: "user", content: m, createdAt: Date.now() }]);
    try {
      const r = await api("POST", "/api/chat", { thread, taskKey, message: m, agent, model });
      if (!r.ok) setErr(r.error || "応答に失敗しました");
      await load();
      onActivity?.();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }, [busy, thread, taskKey, agent, model, load, onActivity]);

  useEffect(() => {
    if (!loaded || !autoMessage || autoSent.current || busy) return;
    autoSent.current = true;
    void sendMessage(autoMessage);
  }, [loaded, autoMessage, busy, sendMessage]);

  const send = useCallback(() => {
    const m = input.trim();
    if (!m || busy) return;
    setInput("");
    void sendMessage(m);
  }, [input, busy, sendMessage]);

  const decide = useCallback(async (id: string, decision: "approve" | "reject") => {
    if (deciding || batch) return;
    setDeciding(id);
    setErr(null);
    try {
      const r = await api("PATCH", "/api/proposals", { id, decision });
      await load();
      if (decision === "approve" && r.ok) onExecuted();
    } catch (e) {
      setErr(String(e));
    } finally {
      setDeciding(null);
    }
  }, [deciding, batch, load, onExecuted]);

  const pendings = proposals.filter((p) => p.status === "pending");

  // "この段取りでOK" — run every pending proposal, in order, one at a time.
  const approveAll = useCallback(async () => {
    if (deciding || batch || pendings.length === 0) return;
    setBatch(true);
    setErr(null);
    try {
      for (const p of [...pendings].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))) {
        setDeciding(p.id);
        await api("PATCH", "/api/proposals", { id: p.id, decision: "approve" });
        await load(); // show progress card-by-card
      }
      onExecuted();
    } catch (e) {
      setErr(String(e));
      await load();
    } finally {
      setDeciding(null);
      setBatch(false);
    }
  }, [deciding, batch, pendings, load, onExecuted]);

  const timeline = [
    ...msgs.map((m) => ({ at: m.createdAt ?? 0, key: `m:${m.id}`, msg: m, prop: undefined as Proposal | undefined })),
    ...proposals.map((p) => ({ at: p.createdAt ?? 0, key: `p:${p.id}`, msg: undefined as ChatMsg | undefined, prop: p })),
  ].sort((a, b) => a.at - b.at);

  return (
    <>
      <div className="chatlog">
        {loaded && timeline.length === 0 && (
          <p className="hint">{emptyHint ?? "何でも聞いてください。タスク登録・予定の相談・見積りができます。提案はあなたが承認するまで実行されません。"}</p>
        )}
        {timeline.map((t) =>
          t.msg ? (
            <div key={t.key} className="crow">
              <Avatar role={t.msg.role} agent={t.msg.agent} />
              <div className="cbody">
                <div className="chead">
                  <span className="cname">{t.msg.role === "user" ? "あなた" : (t.msg.agent ?? "AI")}</span>
                  <span className="ctime">{fmtTime(t.msg.createdAt)}</span>
                </div>
                <div className="ctext">{t.msg.content}</div>
              </div>
            </div>
          ) : t.prop ? (
            <div key={t.key} className={`proposal ${t.prop.status}`}>
              <div className="phead">
                <span className="pkind">{PROPOSAL_KIND[t.prop.kind] ?? t.prop.kind}</span>
                <span className="psum">{t.prop.summary}</span>
              </div>
              {proposalDetail(t.prop) && <div className="pdetail">{proposalDetail(t.prop)}</div>}
              {t.prop.status === "pending" ? (
                <div className="pbtns">
                  <button className="btn btn-primary" disabled={!!deciding || batch}
                    onClick={() => void decide(t.prop!.id, "approve")}>
                    {deciding === t.prop.id ? "実行中…" : "承認して実行"}
                  </button>
                  <button className="btn" disabled={!!deciding || batch} onClick={() => void decide(t.prop!.id, "reject")}>却下</button>
                </div>
              ) : (
                <div className={`pstat ${t.prop.status}`}>
                  {t.prop.status === "done" ? "✓ 実行済み"
                    : t.prop.status === "rejected" ? "× 却下しました"
                    : `！ ${t.prop.error || "エラー"}`}
                </div>
              )}
            </div>
          ) : null,
        )}
        {busy && (
          <div className="crow">
            <Avatar role="assistant" agent={agent} />
            <div className="cbody">
              <div className="chead"><span className="cname">{agent}</span></div>
              <div className="ctext thinking">考え中…</div>
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>
      {pendings.length > 1 && (
        <div className="batchrow">
          <button className="btn btn-primary" disabled={!!deciding || batch} onClick={() => void approveAll()}>
            {batch ? "順に実行中…" : `✔ ${pendings.length}件すべて承認して順に実行`}
          </button>
        </div>
      )}
      {err && <p className="errline" style={{ marginTop: 8 }}>{err}</p>}
      <div className="chatbar">
        <div className="agentpick">
          <select value={agent} onChange={(e) => pickAgent(e.target.value as "claude" | "codex")} title="エージェント">
            <option value="claude">claude</option>
            <option value="codex">codex</option>
          </select>
          {agent === "claude" && (
            <select value={model} onChange={(e) => pickModel(e.target.value)} title="モデル（軽い⇄重い）">
              {MODELS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          )}
        </div>
        <textarea
          rows={2}
          value={input}
          placeholder="メッセージ（⌘/Ctrl+Enter で送信）"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } }}
        />
        <button className="btn btn-primary" disabled={busy || !input.trim()} onClick={send}>送信</button>
      </div>
    </>
  );
}
