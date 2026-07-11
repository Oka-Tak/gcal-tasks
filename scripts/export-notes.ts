import { eq, isNull } from "drizzle-orm";
import { db } from "../lib/db";
import { notes } from "../lib/db/schema";
import { exportNoteFiles } from "../lib/notes-export";
import { notebookFor } from "../lib/notes";

/** 既存の完成ノートを全てフォルダ還流し直す（初回バックフィル・修復用）。 */
async function main() {
  const rows = db.select().from(notes).where(isNull(notes.deletedAt)).all();
  for (const r of rows.filter((r) => r.status === "done")) {
    await exportNoteFiles({ ...r, notebook: r.notebook ?? notebookFor(null, r.eventKey) });
    console.log(`[export-notes] ${r.title}`);
  }
}

void main();
