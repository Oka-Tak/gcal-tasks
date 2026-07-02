/** Runs once per server start (Next.js instrumentation hook). */
export async function register() {
  // Only in the real Node server — not during build, not in edge workers.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { startReminderLoop } = await import("./lib/notify");
  startReminderLoop();
}
