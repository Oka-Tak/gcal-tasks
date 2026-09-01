import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  index,
} from "drizzle-orm/sqlite-core";

/**
 * Connected Google accounts (data sources). One row per account; tokens are
 * encrypted at rest (see lib/crypto). This is NOT Auth.js's table — we manage
 * data-source tokens ourselves so multiple Google accounts attach cleanly.
 */
export const accounts = sqliteTable("accounts", {
  email: text("email").primaryKey(),
  name: text("name"),
  picture: text("picture"),
  color: text("color"),
  accessToken: text("access_token"), // encrypted
  refreshToken: text("refresh_token"), // encrypted
  expiresAt: integer("expires_at"), // epoch seconds
  scope: text("scope"),
  createdAt: integer("created_at"),
  updatedAt: integer("updated_at"),
});

/** Mirror of each account's calendarList. */
export const calendars = sqliteTable(
  "calendars",
  {
    account: text("account").notNull(),
    googleId: text("google_id").notNull(),
    summary: text("summary"),
    color: text("color"),
    primary: integer("primary", { mode: "boolean" }),
    accessRole: text("access_role"),
    selected: integer("selected", { mode: "boolean" }),
    syncedAt: integer("synced_at"),
    deletedAt: integer("deleted_at"),
  },
  (t) => [primaryKey({ columns: [t.account, t.googleId] })],
);

/** Mirror of calendar events (Google is source of truth for these fields). */
export const events = sqliteTable(
  "events",
  {
    account: text("account").notNull(),
    calendarId: text("calendar_id").notNull(),
    googleId: text("google_id").notNull(),
    summary: text("summary"),
    description: text("description"),
    location: text("location"),
    start: text("start"), // raw: rfc3339 dateTime, or YYYY-MM-DD for all-day
    end: text("end"),
    allDay: integer("all_day", { mode: "boolean" }),
    startMs: integer("start_ms"), // epoch ms for range queries
    endMs: integer("end_ms"),
    status: text("status"),
    color: text("color"),
    attendees: text("attendees"), // JSON string
    meet: text("meet"),
    attachments: text("attachments"), // JSON string
    htmlLink: text("html_link"),
    organizer: text("organizer"),
    recurring: integer("recurring", { mode: "boolean" }),
    googleUpdated: text("google_updated"),
    syncedAt: integer("synced_at"),
    deletedAt: integer("deleted_at"),
  },
  (t) => [
    primaryKey({ columns: [t.account, t.calendarId, t.googleId] }),
    index("events_range").on(t.startMs, t.endMs),
  ],
);

/** Mirror of each account's task lists. */
export const tasklists = sqliteTable(
  "tasklists",
  {
    account: text("account").notNull(),
    googleId: text("google_id").notNull(),
    title: text("title"),
    syncedAt: integer("synced_at"),
    deletedAt: integer("deleted_at"),
  },
  (t) => [primaryKey({ columns: [t.account, t.googleId] })],
);

/**
 * Mirror of tasks PLUS local-only columns Google cannot store. `dueTime` is the
 * whole point of having a DB: Google Tasks holds date only, so the time-of-day
 * lives here and never round-trips to Google. Sync preserves these columns.
 */
export const tasks = sqliteTable(
  "tasks",
  {
    account: text("account").notNull(),
    tasklist: text("tasklist").notNull(),
    googleId: text("google_id").notNull(),
    title: text("title"),
    notes: text("notes"),
    status: text("status"), // needsAction | completed
    due: text("due"), // date-only (rfc3339 midnight) from Google
    position: text("position"),
    parent: text("parent"),
    googleUpdated: text("google_updated"),
    // local-only (never sent to Google):
    dueTime: text("due_time"), // 'HH:MM'
    remindAt: integer("remind_at"), // epoch ms — when to push a reminder (ntfy)
    remindedAt: integer("reminded_at"), // epoch ms — when the push actually fired (reset on remindAt change)
    nudgedForDue: text("nudged_for_due"), // the `due` value the day-before nudge fired for (re-fires when due moves)
    splitNudgedAt: integer("split_nudged_at"), // epoch ms — "タスク区切りませんか" nudge fired (once per task)
    dueSoonFor: text("due_soon_for"), // "YYYY-MM-DD HH:MM" deadline the 1-hour-before push fired for
    duePassedFor: text("due_passed_for"), // "YYYY-MM-DD HH:MM" deadline the expired push fired for
    sortOrder: integer("sort_order"), // local ordering (future)
    kanban: text("kanban"), // board column: todo | doing | waiting (null = todo; done = status)
    // planning flywheel (local-only): the agent estimates, you record actuals.
    estimatedMin: integer("estimated_min"), // estimated effort in minutes
    actualMin: integer("actual_min"), // measured actual effort (feeds future estimates)
    difficulty: integer("difficulty"), // 1-5, your felt difficulty
    energy: integer("energy"), // 1-5, energy this needs / you had
    asap: integer("asap", { mode: "boolean" }), // 期限ASAP — 何より先に（締切順の最上位）
    priority: integer("priority"), // 1(低)〜5(最優先)。手動 or AI推定（task-enrich）
    syncedAt: integer("synced_at"),
    deletedAt: integer("deleted_at"),
  },
  (t) => [primaryKey({ columns: [t.account, t.tasklist, t.googleId] })],
);

/**
 * Life-log / "actuals": what you really did — sleep, meals, work, trips. This is
 * the knowledge base the planning agent reads to judge how long a task takes for
 * YOU. Local-only by design (Kairos DB is source of truth; no Google mirror).
 * Sleep rows are typically created by vision-extracting a Xiaomi watch screenshot.
 */
export const logs = sqliteTable(
  "logs",
  {
    id: text("id").primaryKey(), // uuid
    kind: text("kind").notNull(), // sleep | meal | work | trip | activity | note
    title: text("title"),
    note: text("note"),
    startMs: integer("start_ms"), // epoch ms
    endMs: integer("end_ms"),
    tags: text("tags"), // JSON string[] (free-form)
    metrics: text("metrics"), // JSON object, e.g. {durationMin, quality, deepMin, remMin, kcal}
    source: text("source"), // screenshot | manual | agent
    imagePath: text("image_path"), // original upload path (local), if from a screenshot
    createdAt: integer("created_at"),
    updatedAt: integer("updated_at"),
    deletedAt: integer("deleted_at"),
  },
  (t) => [index("logs_range").on(t.startMs, t.endMs), index("logs_kind").on(t.kind)],
);

/**
 * Notes — the NotebookLM-ish layer. A note usually starts from an uploaded
 * audio file (lecture/meeting): whisperx transcribes it locally, then an agent
 * turns the transcript into structured markdown. Notes can attach to a
 * calendar event (eventKey = account|calendarId|googleId) or stand alone.
 * Local-only; never mirrored to Google.
 */
export const notes = sqliteTable(
  "notes",
  {
    id: text("id").primaryKey(), // uuid
    eventKey: text("event_key"), // account|calendarId|googleId (null = standalone)
    title: text("title"),
    content: text("content"), // markdown (agent summary, then user-editable)
    transcript: text("transcript"), // raw whisperx text
    status: text("status").notNull(), // transcribing | summarizing | done | error
    error: text("error"),
    audioPath: text("audio_path"), // local upload (inside data dir)
    jobId: text("job_id"), // agent_jobs row of the summarize step
    notebook: text("notebook"), // Open WebUI collection name (RAGの棚)
    owuiFileId: text("owui_file_id"), // OWUI file id — 編集時の置き換えに必要
    createdAt: integer("created_at"),
    updatedAt: integer("updated_at"),
    deletedAt: integer("deleted_at"),
  },
  (t) => [index("notes_event").on(t.eventKey)],
);

/**
 * 1ノート複数音源（前半/後半、日本語の講義+英語の上映など）。音源ごとに
 * 言語・文字起こし・状態を持ち、全音源が済んだら結合して要約する。
 * 旧ノートの notes.audio_path は残しつつ、新規はこちらに一本化。
 */
/**
 * 日常の生活ルール（寮の夕食・風呂・洗濯・睡眠・バイト等）。タスクではないが
 * プランナーの制約になる: block=その時間は埋まる、deadline=その時刻までに
 * 済ませる区切り（例: 20:10までに帰宅しないと夕食が食べられない）、
 * sleep=就寝(startHM)〜起床(endHM)の推奨枠（1日の可処分時間の境界）。
 */
export const routines = sqliteTable("routines", {
  id: text("id").primaryKey(), // uuid
  label: text("label").notNull(), // 例: 寮の夕食 / 洗濯 / 推奨睡眠
  kind: text("kind").notNull(), // block | deadline | sleep
  days: text("days"), // "mon,tue,…"（null = 毎日）
  startHm: text("start_hm"), // "18:30"（deadlineはnull可）
  endHm: text("end_hm"), // "20:10"
  note: text("note"),
  active: integer("active", { mode: "boolean" }).notNull(),
  createdAt: integer("created_at"),
  updatedAt: integer("updated_at"),
});

export const noteAudios = sqliteTable(
  "note_audios",
  {
    id: text("id").primaryKey(), // uuid
    noteId: text("note_id").notNull(),
    seq: integer("seq").notNull(), // 結合順 (1,2,…)
    label: text("label"), // 表示名（元ファイル名など）
    audioPath: text("audio_path").notNull(),
    language: text("language"), // ja(既定) | en | … | auto
    transcript: text("transcript"),
    status: text("status").notNull(), // pending | transcribing | done | error
    error: text("error"),
    createdAt: integer("created_at"),
  },
  (t) => [index("note_audios_note").on(t.noteId)],
);

/**
 * NotebookLM的な「ソース資料」: ノートブック（=OWUIコレクション）に任意の
 * ファイル（pdf/pptx/docx等）を追加して RAG から引けるようにする。
 * 実体は data/materials/ に保存し、OWUI へは pushLocalFileToOwui で登録。
 */
/**
 * 用語集: ユーザー固有の専門用語・団体・略語（TRS・セキュ活・学情など）。
 * AIが文脈を誤解しないよう、チャット/タスク推定/mnemoブリッジのプロンプトに
 * 注入され、OWUIのRAGにも1ファイルとして登録される。UIはプランカードの📖。
 */
export const glossary = sqliteTable("glossary", {
  id: text("id").primaryKey(), // uuid
  term: text("term").notNull(), // 例: TRS
  aliases: text("aliases"), // 別名・読み（カンマ区切り）
  definition: text("definition"), // 「（編集してください）」の間はプロンプトに入れない
  createdAt: integer("created_at"),
  updatedAt: integer("updated_at"),
});

export const materials = sqliteTable(
  "materials",
  {
    id: text("id").primaryKey(), // uuid
    notebook: text("notebook").notNull(), // OWUI collection name
    eventKey: text("event_key"), // 紐づけ元の予定（あれば）
    filename: text("filename").notNull(),
    path: text("path").notNull(), // local absolute path
    size: integer("size"),
    owuiFileId: text("owui_file_id"),
    createdAt: integer("created_at"),
    deletedAt: integer("deleted_at"),
  },
  (t) => [index("materials_notebook").on(t.notebook)],
);

/**
 * Agent invocation ledger. Every call to a local CLI agent (claude/codex) is
 * recorded here so the knowledge trail is durable and readable later (Proxmox
 * Claude Code). Today routes run agents inline and write the result back; this
 * table is the seam to move execution to a separate local worker before publishing.
 */
export const agentJobs = sqliteTable(
  "agent_jobs",
  {
    id: text("id").primaryKey(), // uuid
    kind: text("kind").notNull(), // extract-sleep | chat | estimate | schedule
    agent: text("agent"), // claude | codex
    status: text("status").notNull(), // queued | running | done | error
    payload: text("payload"), // JSON input (prompt, image path, etc.)
    result: text("result"), // JSON output (parsed) or raw text
    error: text("error"),
    usage: text("usage"), // JSON AgentUsage (tokens/cost/credits/duration), best-effort per CLI
    createdAt: integer("created_at"),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
  },
  (t) => [index("agent_jobs_status").on(t.status)],
);

/**
 * Agent-proposed actions awaiting human approval. The agent NEVER writes to
 * Google or the DB directly — chat turns emit proposals, the UI renders them,
 * and only an explicit human approval executes (prompt-injection guard: content
 * from calendars/mail/images can at worst produce a visible proposal, not an
 * action). This is also the seam for the future generalized approval queue
 * (email drafts, repo fixes enqueue here too).
 */
export const proposals = sqliteTable(
  "proposals",
  {
    id: text("id").primaryKey(), // uuid
    threadId: text("thread_id"), // chats.threadId this came from (null = other source)
    chatId: text("chat_id"), // the assistant chat turn that carried it
    jobId: text("job_id"), // agent_jobs id
    kind: text("kind").notNull(), // create_task | update_task | create_event | update_event
    summary: text("summary"), // agent's one-line description (display only)
    payload: text("payload").notNull(), // JSON action arguments (validated on create AND on execute)
    status: text("status").notNull(), // pending | done | rejected | error
    result: text("result"), // JSON outcome of execution
    error: text("error"),
    createdAt: integer("created_at"),
    decidedAt: integer("decided_at"),
  },
  (t) => [
    index("proposals_status").on(t.status),
    index("proposals_thread").on(t.threadId),
  ],
);

/**
 * Per-task (or general) conversations with the agent. The DB — not the CLI's own
 * --resume session — is the source of truth, so the whole history survives and is
 * readable by other tools. `taskKey` = "account|tasklist|googleId" (null = general).
 */
export const chats = sqliteTable(
  "chats",
  {
    id: text("id").primaryKey(), // uuid
    threadId: text("thread_id").notNull(), // groups a conversation
    taskKey: text("task_key"), // "account|tasklist|googleId" or null
    role: text("role").notNull(), // user | assistant | system
    content: text("content"),
    agent: text("agent"), // claude | codex (for assistant turns)
    jobId: text("job_id"), // link to agent_jobs
    createdAt: integer("created_at"),
  },
  (t) => [index("chats_thread").on(t.threadId)],
);

/**
 * お金管理（軽量ログ型）: 支出1件=1行。amountYen は支出が正、返金・収入は負。
 * category は UI の定義リスト（food/daily/…）が実質の型。レシート等のスクショ
 * から AI 取り込みした場合は source="screenshot" + imagePath を持つ。
 */
export const expenses = sqliteTable(
  "expenses",
  {
    id: text("id").primaryKey(), // uuid
    amountYen: integer("amount_yen").notNull(),
    category: text("category").notNull(), // 値は lib/money-shared.ts の EXPENSE_CATEGORIES を正とする（food/cafe/daily/apparel/health/transport/lodging/fun/book/sub/phone/social/other）
    title: text("title"), // 店名や品目 例 "セブン 昼食"
    note: text("note"),
    whenMs: integer("when_ms").notNull(), // 支払い日時 (epoch ms)
    source: text("source"), // manual | screenshot | agent | sub
    kind: text("kind").default("spot"), // spot（都度）| sub（サブスクから自動計上）
    subscriptionId: text("subscription_id"), // kind=sub のとき、生成元サブスク
    imagePath: text("image_path"),
    createdAt: integer("created_at"),
    updatedAt: integer("updated_at"),
    deletedAt: integer("deleted_at"),
  },
  (t) => [index("expenses_when").on(t.whenMs)],
);

/**
 * サブスク（定期課金）のマスター。都度の支出とは別建て。月表示のたびに
 * lib/subscriptions.ts がその月ぶんを expenses に冪等生成する（kind=sub）ので、
 * 毎月の手入力が不要になる。金額変更は以後の生成に効き、過去分は実際の請求額として残す。
 */
export const subscriptions = sqliteTable(
  "subscriptions",
  {
    id: text("id").primaryKey(), // uuid
    name: text("name").notNull(), // サービス名 例 "Netflix"
    amountYen: integer("amount_yen").notNull(), // 月額
    category: text("category").notNull().default("sub"), // 表示上の属性（sub / fun 等、EXPENSE_CATEGORIES）
    billingDay: integer("billing_day").notNull().default(1), // 課金日 1-28（月末揺れ回避で28上限）
    note: text("note"),
    active: integer("active").notNull().default(1), // 1=稼働中 / 0=停止（以後は計上しない）
    startMs: integer("start_ms").notNull(), // この月から計上を始める
    createdAt: integer("created_at"),
    updatedAt: integer("updated_at"),
    deletedAt: integer("deleted_at"),
  },
  (t) => [index("subscriptions_active").on(t.active)],
);

/**
 * 地点間の移動時間キャッシュ。移動手段(mode)はユーザーが指定し、minutes は
 * その手段での片道所要分。AI(Web検索)が埋めることも、手で直すこともできる。
 * from/to は正規化済みの地点名を辞書順で格納する（方向を区別しない）。
 */
export const travelRoutes = sqliteTable(
  "travel_routes",
  {
    id: text("id").primaryKey(),
    fromPlace: text("from_place").notNull(),
    toPlace: text("to_place").notNull(),
    mode: text("mode").notNull().default("未指定"), // 徒歩 | 自転車 | バス | 電車 | 車 | 公共交通
    minutes: integer("minutes"), // 片道の所要分（null = 未調査）
    note: text("note"),
    source: text("source"), // manual | ai
    createdAt: integer("created_at"),
    updatedAt: integer("updated_at"),
    deletedAt: integer("deleted_at"),
  },
  (t) => [index("travel_routes_pair").on(t.fromPlace, t.toPlace)],
);
