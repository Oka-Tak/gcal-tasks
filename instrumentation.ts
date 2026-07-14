/** Runs once per server start (Next.js instrumentation hook). */
export async function register() {
  // Only in the real Node server — not during build, not in edge workers.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { startReminderLoop } = await import("./lib/notify");
  startReminderLoop();
  const { startNudgeLoop } = await import("./lib/nudges");
  startNudgeLoop();
  const { startFolderNotesLoop } = await import("./lib/folder-notes");
  startFolderNotesLoop();
  // 再起動で中断された文字起こし・要約を自動再開（少し待って他の起動処理を先に）
  const { resumeInterruptedNotes } = await import("./lib/notes");
  setTimeout(() => {
    void resumeInterruptedNotes().catch((e) => console.error("[kairos] resume failed:", e));
  }, 15_000);
}
