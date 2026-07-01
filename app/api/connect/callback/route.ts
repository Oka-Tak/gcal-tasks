import { google } from "googleapis";
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/auth";
import { connectClient } from "@/lib/google";
import { upsertAccountFromOAuth } from "@/lib/accounts";

export const runtime = "nodejs";

/** Finish the connect-account flow: exchange code, store encrypted tokens. */
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ detail: "unauthenticated" }, { status: 401 });
  }
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieState = req.cookies.get("kairos_connect_state")?.value;
  if (!code || !state || state !== cookieState) {
    return NextResponse.json({ detail: "invalid OAuth state" }, { status: 400 });
  }

  const client = connectClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  const info = await google.oauth2({ version: "v2", auth: client }).userinfo.get();
  const email = info.data.email;
  if (!email) {
    return NextResponse.json({ detail: "no email on grant" }, { status: 502 });
  }

  upsertAccountFromOAuth({
    email,
    name: info.data.name ?? null,
    picture: info.data.picture ?? null,
    accessToken: tokens.access_token ?? null,
    refreshToken: tokens.refresh_token ?? null,
    expiresAt: tokens.expiry_date ? Math.floor(tokens.expiry_date / 1000) : null,
    scope: tokens.scope ?? null,
  });

  const res = NextResponse.redirect(new URL("/", req.url));
  res.cookies.delete("kairos_connect_state");
  return res;
}
