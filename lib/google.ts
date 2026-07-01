import { google } from "googleapis";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { accounts } from "./db/schema";
import { encrypt, decrypt } from "./crypto";
import { env } from "./env";

/**
 * An OAuth2 client primed with a stored account's tokens. googleapis refreshes
 * the access token automatically when expired and emits "tokens"; we re-encrypt
 * and persist whatever it hands back (new access token, and a rotated refresh
 * token if Google sends one).
 */
export function oauthClientFor(email: string) {
  const row = db.select().from(accounts).where(eq(accounts.email, email)).get();
  if (!row) throw new Error(`account not connected: ${email}`);

  const client = new google.auth.OAuth2(
    env.googleClientId,
    env.googleClientSecret,
    `${env.baseUrl}/api/connect/callback`,
  );
  client.setCredentials({
    access_token: row.accessToken ? decrypt(row.accessToken) : undefined,
    refresh_token: row.refreshToken ? decrypt(row.refreshToken) : undefined,
    expiry_date: row.expiresAt ? row.expiresAt * 1000 : undefined,
  });

  client.on("tokens", (t) => {
    const set: Record<string, unknown> = { updatedAt: Date.now() };
    if (t.access_token) set.accessToken = encrypt(t.access_token);
    if (t.refresh_token) set.refreshToken = encrypt(t.refresh_token);
    if (t.expiry_date) set.expiresAt = Math.floor(t.expiry_date / 1000);
    db.update(accounts).set(set).where(eq(accounts.email, email)).run();
  });

  return client;
}

export function calendarFor(email: string) {
  return google.calendar({ version: "v3", auth: oauthClientFor(email) });
}

export function tasksFor(email: string) {
  return google.tasks({ version: "v1", auth: oauthClientFor(email) });
}

/** Build a bare client for the connect-account OAuth flow (no stored tokens). */
export function connectClient() {
  return new google.auth.OAuth2(
    env.googleClientId,
    env.googleClientSecret,
    `${env.baseUrl}/api/connect/callback`,
  );
}
