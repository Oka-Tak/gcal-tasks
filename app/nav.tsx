"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { CalendarIcon, KanbanIcon, BotIcon, ClockIcon, CheckCircleIcon, NoteIcon, CoinIcon } from "./icons";

/**
 * App-wide navigation: an Ubuntu-style icon dock on the left (desktop) and a
 * persistent bottom tab bar on mobile. Every page renders both.
 */

const TABS = [
  { href: "/", Icon: CalendarIcon, label: "予定表" },
  { href: "/board", Icon: KanbanIcon, label: "ボード" },
  { href: "/ai", Icon: BotIcon, label: "AIアシスタント" },
  { href: "/logs", Icon: ClockIcon, label: "記録（実績）" },
  { href: "/money", Icon: CoinIcon, label: "お金" },
  { href: "/notes", Icon: NoteIcon, label: "ノート" },
];

// Sibling app: mnemo — Open WebUI frontend (:443) over the mnemo bridge.
const MNEMO_URL = "https://zundamon-ubuntu-alc6.tail7507d4.ts.net/";

export function Dock() {
  const path = usePathname();
  return (
    <aside className="dock desktop-only">
      <Link href="/" className="dbrand" title="Kairos">K</Link>
      {TABS.map(({ href, Icon, label }) => (
        <Link
          key={href}
          href={href}
          data-label={label}
          className={`dicon${path === href ? " on" : ""}`}
        >
          <Icon size={24} />
        </Link>
      ))}
      <a href={MNEMO_URL} className="dicon dmnemo" data-label="mnemo（チャット）"
        target="_blank" rel="noopener noreferrer">M</a>
    </aside>
  );
}

/**
 * On the calendar page, 予定表/タスク switch panes in place (pass pane+onPane);
 * on every other page they navigate home ("/?pane=tasks" opens the task pane).
 */
export function MobileTabs({ pane, onPane }: {
  pane?: "cal" | "tasks";
  onPane?: (p: "cal" | "tasks") => void;
}) {
  const path = usePathname();
  const local = path === "/" && !!onPane;
  return (
    <nav className="mobiletabs">
      {local ? (
        <>
          <button className={pane === "cal" ? "on" : ""} onClick={() => onPane!("cal")}><CalendarIcon size={22} />予定表</button>
          <button className={pane === "tasks" ? "on" : ""} onClick={() => onPane!("tasks")}><CheckCircleIcon size={22} />タスク</button>
        </>
      ) : (
        <>
          <Link href="/"><CalendarIcon size={22} />予定表</Link>
          <Link href="/?pane=tasks"><CheckCircleIcon size={22} />タスク</Link>
        </>
      )}
      <Link href="/board" className={path === "/board" ? "on" : ""}><KanbanIcon size={22} />ボード</Link>
      <Link href="/ai" className={path === "/ai" ? "on" : ""}><BotIcon size={22} />AI</Link>
      <Link href="/logs" className={path === "/logs" ? "on" : ""}><ClockIcon size={22} />記録</Link>
      <Link href="/money" className={path === "/money" ? "on" : ""}><CoinIcon size={22} />お金</Link>
      <Link href="/notes" className={path === "/notes" ? "on" : ""}><NoteIcon size={22} />ノート</Link>
    </nav>
  );
}
