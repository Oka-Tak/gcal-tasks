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

export default function AiClient() {
  const [threads, setThreads] = useState<ThreadInfo[]>([]);
  const [current, setCurrent] = useState("general");
  const [drafts, setDrafts] = useState<ThreadInfo[]>([]); // new topics with no messages yet

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
    </div>
  );
}
