import { handlers } from "@/auth";

// better-sqlite3 (used by the jwt callback) needs the Node.js runtime.
export const runtime = "nodejs";

export const { GET, POST } = handlers;
