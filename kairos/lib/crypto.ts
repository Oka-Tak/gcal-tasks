import crypto from "node:crypto";
import { env } from "./env";

/**
 * AES-256-GCM for encrypting Google tokens at rest. Any KAIROS_ENC_KEY string is
 * accepted and hashed to a 32-byte key, so a passphrase works as well as a raw key.
 * Format: base64(iv).base64(authTag).base64(ciphertext)
 */
function key(): Buffer {
  if (!env.encKey) throw new Error("KAIROS_ENC_KEY is not set");
  return crypto.createHash("sha256").update(env.encKey).digest();
}

export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, enc].map((b) => b.toString("base64")).join(".");
}

export function decrypt(blob: string): string {
  const [ivB, tagB, dataB] = blob.split(".");
  if (!ivB || !tagB || !dataB) throw new Error("malformed ciphertext");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key(),
    Buffer.from(ivB, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagB, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
