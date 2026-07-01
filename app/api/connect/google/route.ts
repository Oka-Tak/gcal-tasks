import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { connectClient } from "@/lib/google";
import { GOOGLE_SCOPES } from "@/lib/env";

export const runtime = "nodejs";

/** Start OAuth to attach an ADDITIONAL Google account as a data source. */
export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ detail: "unauthenticated" }, { status: 401 });
  }
  const state = crypto.randomUUID();
  const url = connectClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: true,
    scope: GOOGLE_SCOPES,
    state,
  });
  const res = NextResponse.redirect(url);
  res.cookies.set("kairos_connect_state", state, {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/",
    maxAge: 600,
  });
  return res;
}
