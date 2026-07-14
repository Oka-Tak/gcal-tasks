import crypto from "node:crypto";

/** Constant-time comparison that also handles unequal input lengths safely. */
export function secretMatches(provided: string, expected: string): boolean {
  if (!expected) return false;
  const digest = (value: string) => crypto.createHash("sha256").update(value, "utf8").digest();
  return crypto.timingSafeEqual(digest(provided), digest(expected));
}
