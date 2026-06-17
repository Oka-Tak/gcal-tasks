import { eq } from "drizzle-orm";
import { db } from "./db";
import { accounts, calendars, events, tasklists, tasks } from "./db/schema";
import { encrypt } from "./crypto";

const PALETTE = [
  "#4f46e5",
  "#0891b2",
  "#be185d",
  "#15803d",
  "#b45309",
  "#7c3aed",
  "#0f766e",
];

export type AccountInfo = {
  email: string;
  name: string | null;
  picture: string | null;
  color: string | null;
};

/** Connected accounts for the UI (no tokens). */
export function listAccounts(): AccountInfo[] {
  return db
    .select({
      email: accounts.email,
      name: accounts.name,
      picture: accounts.picture,
      color: accounts.color,
    })
    .from(accounts)
    .all();
}

type OAuthUpsert = {
  email: string;
  name?: string | null;
  picture?: string | null;
  accessToken?: string | null;
  refreshToken?: string | null;
  expiresAt?: number | null; // epoch seconds
  scope?: string | null;
};

/**
 * Add or refresh a connected Google account from an OAuth grant. Google omits
 * the refresh_token on re-consent sometimes, so we keep the existing one when
 * the new grant doesn't include it.
 */
export function upsertAccountFromOAuth(a: OAuthUpsert): void {
  const now = Date.now();
  const existing = db
    .select()
    .from(accounts)
    .where(eq(accounts.email, a.email))
    .get();
  const count = db.select().from(accounts).all().length;
  const color = existing?.color ?? PALETTE[count % PALETTE.length];

  const enc = (v?: string | null) => (v ? encrypt(v) : undefined);
  const accessToken = enc(a.accessToken) ?? existing?.accessToken ?? null;
  const refreshToken = enc(a.refreshToken) ?? existing?.refreshToken ?? null;

  db.insert(accounts)
    .values({
      email: a.email,
      name: a.name ?? existing?.name ?? null,
      picture: a.picture ?? existing?.picture ?? null,
      color,
      accessToken,
      refreshToken,
      expiresAt: a.expiresAt ?? existing?.expiresAt ?? null,
      scope: a.scope ?? existing?.scope ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: accounts.email,
      set: {
        name: a.name ?? existing?.name ?? null,
        picture: a.picture ?? existing?.picture ?? null,
        accessToken,
        refreshToken,
        expiresAt: a.expiresAt ?? existing?.expiresAt ?? null,
        scope: a.scope ?? existing?.scope ?? null,
        updatedAt: now,
      },
    })
    .run();
}

/** Disconnect an account and drop its mirrored rows. */
export function deleteAccount(email: string): void {
  db.delete(events).where(eq(events.account, email)).run();
  db.delete(calendars).where(eq(calendars.account, email)).run();
  db.delete(tasks).where(eq(tasks.account, email)).run();
  db.delete(tasklists).where(eq(tasklists.account, email)).run();
  db.delete(accounts).where(eq(accounts.email, email)).run();
}
