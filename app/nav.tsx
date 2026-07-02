"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * App-wide navigation: browser-style tabs on desktop (topbar), a persistent
 * bottom tab bar on mobile. Every page renders both — no more back buttons.
 */

const TABS = [
  { href: "/", icon: "📅", label: "予定表" },
  { href: "/board", icon: "📋", label: "ボード" },
  { href: "/ai", icon: "🤖", label: "AI" },
  { href: "/logs", icon: "📓", label: "記録" },
];

export function TopTabs() {
  const path = usePathname();
  return (
    <nav className="toptabs desktop-only">
      {TABS.map((t) => (
        <Link key={t.href} href={t.href} className={path === t.href ? "on" : ""}>
          {t.icon} {t.label}
        </Link>
      ))}
    </nav>
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
