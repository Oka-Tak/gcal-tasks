import { auth } from "@/auth";
import { listAccounts } from "@/lib/accounts";

export const runtime = "nodejs";

export async function GET() {
  const session = await auth();
  if (!session?.user) return Response.json({ authed: false, accounts: [] });
  return Response.json({
    authed: true,
    user: {
      email: session.user.email,
      name: session.user.name,
      image: session.user.image,
    },
    accounts: listAccounts(),
  });
}
