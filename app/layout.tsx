import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Kairos",
  description: "Unified Google Calendar + Tasks, self-hosted.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
