const DAY_MS = 86_400_000;

export function eventOverlapsDay(startMs: number, endMs: number, dayStartMs: number): boolean {
  return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > dayStartMs && startMs < dayStartMs + DAY_MS;
}

export function eventSegmentForDay(
  startMs: number,
  endMs: number,
  dayStartMs: number,
): { startMinute: number; endMinute: number } | null {
  if (!eventOverlapsDay(startMs, endMs, dayStartMs)) return null;
  const startMinute = Math.max(0, Math.floor((Math.max(startMs, dayStartMs) - dayStartMs) / 60_000));
  const endMinute = Math.min(1440, Math.ceil((Math.min(endMs, dayStartMs + DAY_MS) - dayStartMs) / 60_000));
  return endMinute > startMinute ? { startMinute, endMinute } : null;
}
