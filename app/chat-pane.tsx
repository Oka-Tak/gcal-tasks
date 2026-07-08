"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BotIcon, PersonIcon, TerminalIcon } from "./icons";
import { AGENT_CATALOG, AGENT_NAMES, isAgentName, type AgentName, type AgentUsage } from "@/lib/agents-catalog";

/**
 * The chat surface shared by the /ai tab (topic threads) and the per-task
 * modal. Slack-style flat rows (avatar / name / time / text); proposals render
 * as attachment cards and execute only via the approve buttons.
 */

export type ChatMsg = {
  id: string; role: string; content: string | null; agent?: string | null;
  createdAt?: number | null; usage?: AgentUsage | null;
};
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

/** Last-used model per agent (falling back to the pre-multi-agent key). */
function storedModel(a: AgentName): string {
  const models = AGENT_CATALOG[a].models;
  const saved = localStorage.getItem(`kairos-model-${a}`) ?? localStorage.getItem("kairos-model");
  return models.some((m) => m.id === saved) ? (saved as string) : models[0].id;
}

/** Last-used effort for an agent+model ("" = the model has no effort knob). */
function storedEffort(a: AgentName, modelId: string): string {
  const def = AGENT_CATALOG[a].models.find((m) => m.id === modelId);
  if (!def?.efforts) return "";
  const saved = localStorage.getItem(`kairos-effort-${a}-${modelId}`);
  return saved && def.efforts.includes(saved) ? saved : (def.defaultEffort ?? def.efforts[0]);
}

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
  const other = agent && agent !== "claude"; // codex / copilot / agy get their own tint
  return (
    <div className={`cavatar ${role}${other ? ` ${agent}` : ""}`}>
      {role === "user" ? <PersonIcon size={19} /> : other ? <TerminalIcon size={19} /> : <BotIcon size={19} />}
    </div>
  );
}

function fmtTok(n: number): string {
  return n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** One muted line under an assistant message: model ・ tokens ・ cost ・ time. */
function usageLine(u?: AgentUsage | null): string | null {
  if (!u) return null;
  const bits: string[] = [];
  if (u.model) bits.push(u.effort ? `${u.model} (${u.effort})` : u.model);
  if (u.inputTokens != null || u.outputTokens != null) {
    let t = `↑${u.inputTokens != null ? fmtTok(u.inputTokens) : "?"} ↓${u.outputTokens != null ? fmtTok(u.outputTokens) : "?"}`;
    if (u.cachedTokens) t += ` (cache ${fmtTok(u.cachedTokens)})`;
    bits.push(t);
  } else if (u.totalTokens != null) {
    bits.push(`${fmtTok(u.totalTokens)} tok`);
  }
  if (u.costUsd != null) bits.push(`$${u.costUsd.toFixed(u.costUsd < 0.1 ? 3 : 2)}`);
  if (u.credits != null) bits.push(`${u.credits} cr`);
  if (u.durationMs != null) bits.push(`${u.durationMs < 10_000 ? (u.durationMs / 1000).toFixed(1) : Math.round(u.durationMs / 1000)}s`);
  return bits.length ? bits.join(" ・ ") : null;
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
  const [files, setFiles] = useState<File[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const [agent, setAgent] = useState<AgentName>("claude");
  const [model, setModel] = useState("haiku");
  const [effort, setEffort] = useState("");
  const [busy, setBusy] = useState(false);
  const [liveLog, setLiveLog] = useState<string[]>([]); // 実行中の動作ログ (SSE)
  const [power, setPower] = useState(false); // このメッセージだけ claude に Bash/gh/Read を許可
  const [deciding, setDeciding] = useState<string | null>(null);
  const [batch, setBatch] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [showJump, setShowJump] = useState(false); // "↓ 最新へ" when scrolled up
  const logRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true); // stick to the bottom unless the user scrolled up
  const firstScroll = useRef(true);
  const autoSent = useRef(false);

  // remember the last agent/model/effort choice across sessions
  useEffect(() => {
    const saved = localStorage.getItem("kairos-agent");
    const a: AgentName = isAgentName(saved) ? saved : "claude";
    const m = storedModel(a);
    // one-time localStorage read on mount — intentional.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAgent(a);
    setModel(m);
    setEffort(storedEffort(a, m));
  }, []);
  const pickAgent = (a: AgentName) => {
    const m = storedModel(a);
    setAgent(a); setModel(m); setEffort(storedEffort(a, m));
    localStorage.setItem("kairos-agent", a);
  };
  const pickModel = (m: string) => {
    setModel(m); setEffort(storedEffort(agent, m));
    localStorage.setItem(`kairos-model-${agent}`, m);
  };
  const pickEffort = (e: string) => {
    setEffort(e);
    localStorage.setItem(`kairos-effort-${agent}-${model}`, e);
  };

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

  const scrollToEnd = useCallback((smooth: boolean) => {
    const el = logRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, []);

  // Claude-web-style pinning: open at the latest message instantly; afterwards
  // follow new messages only while the user is at the bottom — never yank them
  // back down while they're reading history.
  useEffect(() => {
    if (!loaded) return;
    if (firstScroll.current) {
      firstScroll.current = false;
      scrollToEnd(false);
      return;
    }
    if (pinnedRef.current) scrollToEnd(true);
  }, [msgs, proposals, busy, loaded, scrollToEnd]);

  const onLogScroll = () => {
    const el = logRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    pinnedRef.current = atBottom;
    setShowJump(!atBottom);
  };

  const sendMessage = useCallback(async (m: string, attach: File[] = []) => {
    if ((!m && attach.length === 0) || busy) return;
    setBusy(true);
    setErr(null);
    const shown = attach.length ? `${m}\n📎 ${attach.map((f) => f.name).join(", ")}` : m;
    setMsgs((prev) => [...prev, { id: `tmp-${Date.now()}`, role: "user", content: shown, createdAt: Date.now() }]);
    setLiveLog([]);
    try {
      // ?stream=1 → SSE: {t:"ev"} 動作ログ行 → {t:"done", ...結果}
      let resp: Response;
      if (attach.length) {
        const fd = new FormData();
        fd.append("message", m);
        if (thread) fd.append("thread", thread);
        if (taskKey) fd.append("taskKey", taskKey);
        fd.append("agent", agent);
        fd.append("model", model);
        if (effort) fd.append("effort", effort);
        if (power) fd.append("power", "1");
        for (const f of attach) fd.append("files", f);
        resp = await fetch("/api/chat?stream=1", { method: "POST", body: fd });
      } else {
        resp = await fetch("/api/chat?stream=1", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ thread, taskKey, message: m, agent, model, effort: effort || undefined, power }),
        });
      }
      if (!resp.ok || !resp.body) throw new Error(await resp.text());
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let sse = "";
      let r: { ok?: boolean; error?: string } = {};
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        sse += dec.decode(value, { stream: true });
        let nl;
        while ((nl = sse.indexOf("\n\n")) >= 0) {
          const raw = sse.slice(0, nl);
          sse = sse.slice(nl + 2);
          if (!raw.startsWith("data: ")) continue;
          let ev: { t?: string; line?: string; ok?: boolean; error?: string };
          try { ev = JSON.parse(raw.slice(6)); } catch { continue; }
          if (ev.t === "ev" && ev.line) setLiveLog((prev) => [...prev.slice(-40), ev.line as string]);
          else if (ev.t === "done") r = ev;
        }
      }
      if (!r.ok) setErr(r.error || "応答に失敗しました");
      await load();
      onActivity?.();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
      setLiveLog([]);
    }
  }, [busy, thread, taskKey, agent, model, effort, load, onActivity]);

  useEffect(() => {
    if (!loaded || !autoMessage || autoSent.current || busy) return;
    autoSent.current = true;
    void sendMessage(autoMessage);
  }, [loaded, autoMessage, busy, sendMessage]);

  const send = useCallback(() => {
    const m = input.trim();
    if ((!m && files.length === 0) || busy) return;
    setInput("");
    const attach = files;
    setFiles([]);
    if (fileRef.current) fileRef.current.value = "";
    void sendMessage(m || "（添付ファイルを見てください）", attach);
  }, [input, files, busy, sendMessage]);

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
      <div className="chatwrap">
      <div className="chatlog" ref={logRef} onScroll={onLogScroll}>
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
                {t.msg.role === "assistant" && usageLine(t.msg.usage) && (
                  <div className="cusage">{usageLine(t.msg.usage)}</div>
                )}
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
              {liveLog.length > 0 && (
                // column-reverse + 逆順配列 = 常に最新行へ自動追従
                <div className="livelog">
                  {[...liveLog].reverse().map((l, i) => <div key={liveLog.length - i} className="liveline">{l}</div>)}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      {showJump && (
        <button className="jumpdown" title="最新へ"
          onClick={() => { pinnedRef.current = true; setShowJump(false); scrollToEnd(true); }}>
          ↓
        </button>
      )}
      </div>
      {pendings.length > 1 && (
        <div className="batchrow">
          <button className="btn btn-primary" disabled={!!deciding || batch} onClick={() => void approveAll()}>
            {batch ? "順に実行中…" : `✔ ${pendings.length}件すべて承認して順に実行`}
          </button>
        </div>
      )}
      {err && <p className="errline" style={{ marginTop: 8 }}>{err}</p>}
      {files.length > 0 && (
        <div className="attachrow">
          {files.map((f, i) => (
            <span key={`${f.name}-${i}`} className="attachchip">
              📎 {f.name}
              <button onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))} title="外す">×</button>
            </span>
          ))}
        </div>
      )}
      <div className="chatbar">
        <input
          ref={fileRef}
          type="file"
          multiple
          accept="image/*,.pdf,.txt,.md,.csv"
          style={{ display: "none" }}
          onChange={(e) => {
            const picked = [...(e.target.files ?? [])];
            if (picked.length) setFiles((prev) => [...prev, ...picked].slice(0, 4));
          }}
        />
        <button
          className={`btn attachbtn${agent !== "claude" ? " dim" : ""}`}
          title={agent === "claude" ? "ファイルを添付（画像・PDF・テキスト）" : "添付を読めるのは claude です（他エージェントには内容が渡りません）"}
          onClick={() => fileRef.current?.click()}
        >📎</button>
        <div className="agentpick">
          <select value={agent} onChange={(e) => pickAgent(e.target.value as AgentName)} title="エージェント">
            {AGENT_NAMES.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
          {AGENT_CATALOG[agent].models.length > 1 && (
            <select value={model} onChange={(e) => pickModel(e.target.value)} title="モデル">
              {AGENT_CATALOG[agent].models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          )}
          {(() => {
            const efforts = AGENT_CATALOG[agent].models.find((m) => m.id === model)?.efforts;
            return efforts ? (
              <select value={effort} onChange={(e) => pickEffort(e.target.value)} title="エフォート（思考の深さ）">
                {efforts.map((e) => <option key={e} value={e}>{e}</option>)}
              </select>
            ) : null;
          })()}
          {agent === "claude" && (
            <button
              type="button"
              className={`btn powerbtn${power ? " on" : ""}`}
              title={power
                ? "コマンド許可: ON — このメッセージは claude が Bash/gh/ファイル読取まで使えます（承認済み）"
                : "コマンド許可: OFF — 通常は Web 検索のみ。ON にすると gh・シェル・ローカル読取を許可します"}
              onClick={() => setPower((v) => !v)}
            >🔧{power ? " 許可中" : ""}</button>
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
