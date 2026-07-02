import { auth } from "@/auth";
import { listThreads } from "@/lib/chat";

export const runtime = "nodejs";

/** Topic threads for the /ai tab (task-bound chats are reached from the task modal). */
export async function GET() {
  const session = await auth();
  if (!session?.user)
    return Response.json({ detail: "unauthenticated" }, { status: 401 });
  return Response.json({ threads: listThreads() });
}
