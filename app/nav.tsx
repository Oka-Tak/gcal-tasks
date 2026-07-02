"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * App-wide navigation: an Ubuntu-style icon dock on the left (desktop) and a
 * persistent bottom tab bar on mobile. Every page renders both.
 */

const TABS = [
  { href: "/", icon: "📅", label: "予定表" },
  { href: "/board", icon: "📋", label: "ボード" },
  { href: "/ai", icon: "🤖", label: "AIアシスタント" },
  { href: "/logs", icon: "📓", label: "記録・ナレッジ" },
];

export function Dock() {
  const path = usePathname();
  return (
    <aside className="dock desktop-only">
      <Link href="/" className="dbrand" title="Kairos">K</Link>
      {TABS.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          data-label={t.label}
          className={`dicon${path === t.href ? " on" : ""}`}
        >
          {t.icon}
        </Link>
      ))}
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
          <button className={pane === "cal" ? "on" : ""} onClick={() => onPane!("cal")}><span>📅</span>予定表</button>
          <button className={pane === "tasks" ? "on" : ""} onClick={() => onPane!("tasks")}><span>✓</span>タスク</button>
        </>
      ) : (
        <>
          <Link href="/"><span>📅</span>予定表</Link>
          <Link href="/?pane=tasks"><span>✓</span>タスク</Link>
        </>
      )}
      <Link href="/board" className={path === "/board" ? "on" : ""}><span>📋</span>ボード</Link>
      <Link href="/ai" className={path === "/ai" ? "on" : ""}><span>🤖</span>AI</Link>
      <Link href="/logs" className={path === "/logs" ? "on" : ""}><span>📓</span>記録</Link>
    </nav>
  );
}
