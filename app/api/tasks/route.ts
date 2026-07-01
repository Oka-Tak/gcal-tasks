import { and, eq, isNull } from "drizzle-orm";
import { type NextRequest } from "next/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { tasklists, tasks } from "@/lib/db/schema";
import { tasksFor } from "@/lib/google";
import { listAccounts } from "@/lib/accounts";
import { syncTasklists, syncTasks } from "@/lib/sync";
import { taskRequestBody, serializeTask } from "@/lib/serialize";

export const runtime = "nodejs";

async function requireUser() {
  const session = await auth();
  return session?.user ? session : null;
}

export async function GET() {
  if (!(await requireUser()))
    return Response.json({ detail: "unauthenticated" }, { status: 401 });

  for (const a of listAccounts()) {
    try {
      const lists = await syncTasklists(a.email);
      for (const l of lists) if (l.id) await syncTasks(a.email, l.id);
    } catch (e) {
      console.error(`[kairos] task sync failed for ${a.email}:`, e);
    }
  }

  const lists = db
    .select()
    .from(tasklists)
    .where(isNull(tasklists.deletedAt))
    .all()
    .map((l) => ({ account: l.account, id: l.googleId, title: l.title }));
  const rows = db.select().from(tasks).where(isNull(tasks.deletedAt)).all().map(serializeTask);
  return Response.json({ lists, tasks: rows });
}

export async function POST(req: NextRequest) {
  if (!(await requireUser()))
    return Response.json({ detail: "unauthenticated" }, { status: 401 });
  const body = await req.json();
  const { account, tasklist } = body;
  if (!account || !tasklist)
    return Response.json({ detail: "account/tasklist required" }, { status: 400 });

  const created = await tasksFor(account).tasks.insert({
    tasklist,
    requestBody: taskRequestBody(body),
  });
  await syncTasks(account, tasklist);
  if (body.dueTime !== undefined && created.data.id) {
    db.update(tasks)
      .set({ dueTime: body.dueTime || null })
      .where(
        and(
          eq(tasks.account, account),
          eq(tasks.tasklist, tasklist),
          eq(tasks.googleId, created.data.id),
        ),
      )
      .run();
  }
  return Response.json({ id: created.data.id });
}

export async function PATCH(req: NextRequest) {
  if (!(await requireUser()))
    return Response.json({ detail: "unauthenticated" }, { status: 401 });
  const body = await req.json();
  const { account, tasklist, id } = body;
  if (!account || !tasklist || !id)
    return Response.json({ detail: "account/tasklist/id required" }, { status: 400 });

  // Only call Google when a Google-owned field changed; dueTime is local-only.
  const hasGoogle = ["title", "notes", "status", "due"].some((k) => k in body);
  if (hasGoogle) {
    await tasksFor(account).tasks.patch({
      tasklist,
      task: id,
      requestBody: taskRequestBody(body),
    });
  }
  await syncTasks(account, tasklist); // refresh Google fields, preserve local-only
  if ("dueTime" in body) {
    db.update(tasks)
      .set({ dueTime: body.dueTime || null })
      .where(
        and(eq(tasks.account, account), eq(tasks.tasklist, tasklist), eq(tasks.googleId, id)),
      )
      .run();
  }
  return Response.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  if (!(await requireUser()))
    return Response.json({ detail: "unauthenticated" }, { status: 401 });
  const sp = new URL(req.url).searchParams;
  const account = sp.get("account");
  const tasklist = sp.get("tasklist");
  const id = sp.get("id");
  if (!account || !tasklist || !id)
    return Response.json({ detail: "account/tasklist/id required" }, { status: 400 });

  await tasksFor(account).tasks.delete({ tasklist, task: id });
  db.update(tasks)
    .set({ deletedAt: Date.now() })
    .where(
      and(eq(tasks.account, account), eq(tasks.tasklist, tasklist), eq(tasks.googleId, id)),
    )
    .run();
  return Response.json({ ok: true });
}
