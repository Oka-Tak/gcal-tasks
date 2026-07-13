/**
 * 回別フォルダ名を「<授業名>YYYYMMDD」に統一し、ノート名を
 * 「<授業> 第N回 (M/D)」（カレンダー一致時。説明的な語尾は残す）に揃える。
 * リネームに伴い owui-sync state / folder-notes台帳 / notes-export台帳 /
 * materials.path を一括更新して再push・誤検出・迷子を防ぐ。--dry でプレビュー。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { db } from "../lib/db";
import { notes, materials } from "../lib/db/schema";
import { dateFromFolderName, occurrenceForDate } from "../lib/course-sessions";
import { exportNoteFiles } from "../lib/notes-export";
import { pushNoteToOwui } from "../lib/owui";

async function main() {

  const ROOT = process.env.KAIROS_NOTES_EXPORT!;
  const SYNC_ROOT = "/home/zundamon/onedrive-sync";
  const STATE_F = "/home/zundamon/.local/state/owui-sync.json";
  const LEDGER_F = "/home/zundamon/gcal-tasks/data/folder-notes.json";
  const EXPORT_F = "/home/zundamon/gcal-tasks/data/notes-export.json";
  const DRY = process.argv.includes("--dry");
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const state = JSON.parse(await fs.readFile(STATE_F, "utf8")) as Record<string, unknown>;
  const ledger = JSON.parse(await fs.readFile(LEDGER_F, "utf8")) as { folders: Record<string, { noteId: string | null; files: Record<string, unknown> }> };
  const exportMap = JSON.parse(await fs.readFile(EXPORT_F, "utf8")) as Record<string, string[]>;

  const ymdCompact = (ms: number) => {
    const d = new Date(ms);
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  };

  /* ---- Phase A: フォルダ名の統一 ---- */
  let renamed = 0;
  const courses = (await fs.readdir(ROOT, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !/^20\d\d$/.test(e.name))
    .map((e) => e.name);
  for (const course of courses) {
    const courseAbs = path.join(ROOT, course);
    for (const e of await fs.readdir(courseAbs, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const dateMs = dateFromFolderName(e.name);
      if (!dateMs) continue; // 日付フォルダ以外（kaggle課題等）は触らない
      const canonical = `${course}${ymdCompact(dateMs)}`;
      if (e.name === canonical) continue;
      const oldAbs = path.join(courseAbs, e.name);
      const newAbs = path.join(courseAbs, canonical);
      try {
        await fs.access(newAbs);
        console.log(`  conflict skip: ${course}/${e.name} → ${canonical}（既存）`);
        continue;
      } catch { /* 空いてる */ }
      console.log(`${DRY ? "[dry] " : ""}rename: ${course}/${e.name} → ${canonical}`);
      if (DRY) continue;
      await fs.rename(oldAbs, newAbs);
      // owui-sync state のキー
      const oldRel = path.relative(SYNC_ROOT, oldAbs) + "/";
      const newRel = path.relative(SYNC_ROOT, newAbs) + "/";
      for (const k of Object.keys(state)) {
        if (k.startsWith(oldRel)) {
          state[newRel + k.slice(oldRel.length)] = state[k];
          delete state[k];
        }
      }
      // folder-notes 台帳のキー
      const oldKey = path.join(course, e.name);
      const newKey = path.join(course, canonical);
      if (ledger.folders[oldKey]) {
        ledger.folders[newKey] = ledger.folders[oldKey];
        delete ledger.folders[oldKey];
      }
      // notes-export 台帳のパス
      for (const [nid, paths] of Object.entries(exportMap)) {
        exportMap[nid] = paths.map((p) => (p.startsWith(oldAbs + "/") ? newAbs + p.slice(oldAbs.length) : p));
      }
      // materials.path
      db.run(sql`UPDATE materials SET path = ${newAbs} || substr(path, ${oldAbs.length + 1}) WHERE path LIKE ${oldAbs + "/%"}`);
      renamed++;
    }
  }
  if (!DRY) {
    await fs.writeFile(STATE_F, JSON.stringify(state, null, 1));
    await fs.writeFile(LEDGER_F, JSON.stringify(ledger, null, 1));
    await fs.writeFile(EXPORT_F, JSON.stringify(exportMap, null, 1));
  }
  console.log(`renamed: ${renamed} folders`);

  /* ---- Phase B: ノート名の統一 ---- */
  function leftoverOf(title: string, course: string): string {
    let t = title.split(course).join(" ");
    t = t.replace(/第\s*\d{1,2}\s*[回講]/g, " ");
    t = t.replace(/\(\s*\d{1,2}\/\d{1,2}\s*\)/g, " ");
    t = t.replace(/\d{1,2}\/\d{1,2}/g, " ");
    t = t.replace(/20\d{6}/g, " ");
    t = t.replace(/(^|\D)\d{6}(?!\d)/g, "$1 ");
    t = t.replace(/(^|\D)\d{4}(?!\d)/g, "$1 ");
    t = t.replace(/\.(aac|mp3|m4a|wav|mp4|ogg|opus|flac|webm|txt)\b/gi, " ");
    t = t.replace(/[\s\-_・()（）]+/g, " ").trim();
    return t.length >= 2 ? t : "";
  }

  let retitled = 0;
  for (const [rel, entry] of Object.entries(ledger.folders)) {
    if (!entry.noteId) continue;
    const [course, dirName] = rel.split(path.sep);
    if (!dirName) continue;
    const r = db.select().from(notes).where(eq(notes.id, entry.noteId)).get();
    if (!r || r.deletedAt) continue;
    const dateMs = dateFromFolderName(dirName);
    if (!dateMs) continue;
    const o = occurrenceForDate(course, dateMs);
    const d = new Date(o?.dateMs ?? dateMs);
    const leftover = leftoverOf(r.title ?? "", course);
    // カレンダーに一致する回が無い日（土曜特別講義・補講等）は「<授業> M/D」
    const newTitle = o
      ? `${course} 第${o.n}回 (${d.getMonth() + 1}/${d.getDate()})${leftover ? ` ${leftover}` : ""}`
      : `${course} ${d.getMonth() + 1}/${d.getDate()}${leftover ? ` ${leftover}` : ""}`;
    if (newTitle === r.title) continue;
    console.log(`${DRY ? "[dry] " : ""}title: 「${r.title}」→「${newTitle}」`);
    if (DRY) continue;
    db.update(notes).set({ title: newTitle, updatedAt: Date.now() }).where(eq(notes.id, r.id)).run();
    const fresh = db.select().from(notes).where(eq(notes.id, r.id)).get()!;
    await exportNoteFiles(fresh, o?.dateMs ?? dateMs).catch((e) => console.log("  export failed:", String(e).slice(0, 120)));
    if (fresh.status === "done") {
      const fid = await pushNoteToOwui(
        { id: fresh.id, title: fresh.title, content: fresh.content, transcript: fresh.transcript },
        fresh.notebook,
        fresh.owuiFileId,
      );
      if (fid) db.update(notes).set({ owuiFileId: fid }).where(eq(notes.id, r.id)).run();
      await sleep(1500); // OWUIの埋め込みを飽和させない
    }
    retitled++;
  }
  console.log(`retitled: ${retitled} notes${DRY ? " (dry-run)" : ""}`);

}

void main().catch((e) => {
  console.error("[migrate] failed:", e);
  process.exitCode = 1;
});
