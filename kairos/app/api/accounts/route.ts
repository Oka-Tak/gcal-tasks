import { type NextRequest } from "next/server";
import { auth } from "@/auth";
import { listAccounts, deleteAccount } from "@/lib/accounts";

export const runtime = "nodejs";

export async function GET() {
  const session = await auth();
  if (!session?.user) return Response.json({ detail: "unauthenticated" }, { status: 401 });
  return Response.json(listAccounts());
}

export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return Response.json({ detail: "unauthenticated" }, { status: 401 });
  const email = new URL(req.url).searchParams.get("email");
  if (!email) return Response.json({ detail: "missing email" }, { status: 400 });
  deleteAccount(email);
  return Response.json({ ok: true });
}
