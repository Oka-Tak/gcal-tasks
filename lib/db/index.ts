import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "node:path";
import { env } from "../env";
import * as schema from "./schema";

type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;

// Singleton across Next.js hot reloads / route invocations.
const g = globalThis as unknown as { __kairosDb?: DrizzleDb };

function create(): DrizzleDb {
  const sqlite = new Database(env.dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000");
  const d = drizzle(sqlite, { schema });
  // A partially migrated schema is unsafe to serve. Let startup/request fail
  // loudly so the operator fixes the migration instead of seeing later data
  // corruption or unrelated route errors.
  migrate(d, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  return d;
}

function getDb(): DrizzleDb {
  return (g.__kairosDb ??= create());
}

// Lazy proxy: the SQLite file is opened on first real query (request time),
// never at import/build time.
export const db = new Proxy({} as DrizzleDb, {
  get(_t, prop) {
    const real = getDb() as unknown as Record<string | symbol, unknown>;
    const v = real[prop];
    return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(real) : v;
  },
});

export { schema };
