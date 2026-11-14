import BetterSqlite from "better-sqlite3"
import { existsSync } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"

const SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS todo_projects (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS todo_lists (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES todo_projects(id),
  conversation_id TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, conversation_id)
);
CREATE TABLE IF NOT EXISTS todo_items (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL REFERENCES todo_lists(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES todo_items(id),
  title TEXT NOT NULL,
  details TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending','in_progress','in_review','blocked','completed','cancelled')),
  verification TEXT NOT NULL CHECK(verification IN ('not_checked','passed','failed','waived')),
  priority TEXT NOT NULL CHECK(priority IN ('low','normal','high','urgent')),
  created_by TEXT NOT NULL CHECK(created_by IN ('user','model')),
  source TEXT NOT NULL DEFAULT 'model' CHECK(source IN ('user','model','intent_compiler')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  blocked_reason TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS todo_items_list_status ON todo_items(list_id, status, created_at);
CREATE TABLE IF NOT EXISTS todo_dependencies (
  item_id TEXT NOT NULL REFERENCES todo_items(id) ON DELETE CASCADE,
  depends_on_item_id TEXT NOT NULL REFERENCES todo_items(id) ON DELETE CASCADE,
  PRIMARY KEY(item_id, depends_on_item_id),
  CHECK(item_id != depends_on_item_id)
);
CREATE TABLE IF NOT EXISTS todo_events (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL REFERENCES todo_lists(id) ON DELETE CASCADE,
  item_id TEXT REFERENCES todo_items(id) ON DELETE SET NULL,
  list_revision INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL CHECK(actor IN ('user','model','system')),
  request_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS todo_events_list_revision ON todo_events(list_id, list_revision);
CREATE TABLE IF NOT EXISTS todo_evidence (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES todo_items(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  result TEXT NOT NULL CHECK(result IN ('observed','passed','failed')),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS todo_requests (
  list_id TEXT NOT NULL REFERENCES todo_lists(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(list_id, request_id)
);
CREATE TABLE IF NOT EXISTS todo_intent_plans (
  list_id TEXT PRIMARY KEY REFERENCES todo_lists(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  goal TEXT NOT NULL,
  constraints_json TEXT NOT NULL,
  intent_result_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS todo_intent_tasks (
  list_id TEXT NOT NULL REFERENCES todo_lists(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  item_id TEXT NOT NULL UNIQUE REFERENCES todo_items(id) ON DELETE CASCADE,
  dependencies_json TEXT NOT NULL,
  criteria_json TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(list_id, task_id)
);
CREATE TABLE IF NOT EXISTS todo_tool_observations (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL REFERENCES todo_lists(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES todo_items(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  arguments_json TEXT NOT NULL,
  output TEXT NOT NULL,
  failed INTEGER NOT NULL,
  exit_code INTEGER,
  created_at TEXT NOT NULL,
  list_revision INTEGER,
  UNIQUE(list_id, request_id)
);
CREATE INDEX IF NOT EXISTS todo_tool_observations_list_revision ON todo_tool_observations(list_id, list_revision);
CREATE TABLE IF NOT EXISTS todo_evaluations (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL REFERENCES todo_lists(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES todo_items(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  task_version INTEGER NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('accept','revise','needs_evidence','blocked')),
  evaluation_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(list_id, request_id)
);
CREATE INDEX IF NOT EXISTS todo_evaluations_item ON todo_evaluations(item_id, created_at);
CREATE TABLE IF NOT EXISTS todo_tool_evidence (
  observation_id TEXT PRIMARY KEY REFERENCES todo_tool_observations(id) ON DELETE CASCADE,
  list_id TEXT NOT NULL REFERENCES todo_lists(id) ON DELETE CASCADE,
  content TEXT,
  retained INTEGER NOT NULL DEFAULT 1,
  complete INTEGER NOT NULL,
  original_chars INTEGER NOT NULL,
  preserved_chars INTEGER NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS todo_tool_evidence_list ON todo_tool_evidence(list_id, retained, created_at);
PRAGMA user_version = 4;
CREATE TABLE IF NOT EXISTS todo_child_proposals (
  list_id TEXT NOT NULL REFERENCES todo_lists(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  parent_id TEXT NOT NULL REFERENCES todo_items(id),
  decision TEXT NOT NULL CHECK(decision IN ('accepted','existing_task','revised','rejected','needs_clarification')),
  item_id TEXT REFERENCES todo_items(id),
  plan_revision INTEGER NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(list_id, request_id)
);
CREATE INDEX IF NOT EXISTS todo_child_proposals_fingerprint ON todo_child_proposals(list_id, fingerprint, created_at);
CREATE TABLE IF NOT EXISTS todo_accepted_evidence (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL REFERENCES todo_lists(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL,
  plan_revision INTEGER NOT NULL,
  item_id TEXT NOT NULL REFERENCES todo_items(id) ON DELETE CASCADE,
  criterion_index INTEGER NOT NULL,
  criterion TEXT NOT NULL,
  observation_id TEXT NOT NULL REFERENCES todo_tool_observations(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  symbol TEXT NOT NULL,
  path TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  source_hash TEXT NOT NULL,
  superseded_by TEXT REFERENCES todo_accepted_evidence(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS todo_accepted_evidence_lookup ON todo_accepted_evidence(list_id, symbol, path, superseded_by);
CREATE INDEX IF NOT EXISTS todo_accepted_evidence_item ON todo_accepted_evidence(item_id, criterion_index);
CREATE INDEX IF NOT EXISTS todo_accepted_evidence_observation ON todo_accepted_evidence(observation_id);
CREATE INDEX IF NOT EXISTS todo_accepted_evidence_revision ON todo_accepted_evidence(list_id, plan_id, plan_revision);
PRAGMA user_version = 6;
CREATE TABLE IF NOT EXISTS todo_symbol_aliases (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL REFERENCES todo_lists(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  implementation TEXT NOT NULL,
  path TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  observation_id TEXT NOT NULL REFERENCES todo_tool_observations(id) ON DELETE CASCADE,
  source_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS todo_symbol_aliases_tool ON todo_symbol_aliases(tool_name, path);
CREATE INDEX IF NOT EXISTS todo_symbol_aliases_list ON todo_symbol_aliases(list_id);
PRAGMA user_version = 7;
CREATE TABLE IF NOT EXISTS todo_requirement_activations (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL REFERENCES todo_lists(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES todo_items(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('activation','renewal')),
  list_revision INTEGER NOT NULL,
  activated_at INTEGER NOT NULL,
  UNIQUE(list_id, request_id)
);
CREATE INDEX IF NOT EXISTS todo_requirement_activations_item ON todo_requirement_activations(list_id, item_id, list_revision);
PRAGMA user_version = 11;
CREATE TABLE IF NOT EXISTS todo_edit_operations (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL REFERENCES todo_lists(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES todo_items(id) ON DELETE CASCADE,
  target TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('apply','review')),
  pre_digest TEXT NOT NULL,
  post_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('dispatched','succeeded','failed','reconciled_applied','reconciled_absent','diverged')),
  detail TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS todo_edit_operations_target ON todo_edit_operations(list_id, target, status);
PRAGMA user_version = 12;
`

/** The authoritative native connection type for the TODO database. */
export type Database = BetterSqlite.Database

const CURRENT_SCHEMA_VERSION = 18
const BUSY_TIMEOUT_MS = 5000

/**
 * The prebuilt binary for this runtime, or undefined to let better-sqlite3 choose. better-sqlite3 detects musl by reading
 * process.report.getReport().header without a guard, and that throws in some extension-host processes where the report
 * is undefined. Like the lancedb build patch, a missing report is treated as glibc.
 */
const sqlitePrebuildBinding = (): string | undefined => {
  const report = process.report?.getReport?.() as { header?: { glibcVersionRuntime?: unknown } } | undefined
  const musl = process.platform === "linux" && report?.header !== undefined && !report.header.glibcVersionRuntime
  const target = `${musl ? "linuxmusl" : process.platform}-${process.arch}`
  const binding = path.join(path.dirname(require.resolve("better-sqlite3")), "..", "prebuilds", `${target}.node`)
  return existsSync(binding) ? binding : undefined
}

const tableColumns = (database: Database, table: string): { name: string; notnull: number }[] =>
  database.pragma(`table_info(${table})`) as { name: string; notnull: number }[]

const schemaVersion = (database: Database): number => Number(database.pragma("user_version", { simple: true }))

const verifyIntegrity = (database: Database): void => {
  const problems = (database.pragma("integrity_check") as { integrity_check: string }[])
    .map((row) => row.integrity_check)
    .filter((message) => message !== "ok")
  if (problems.length > 0) throw new Error(`integrity_check failed: ${problems.slice(0, 5).join("; ")}`)
}

/** A database path, or a resolver awaited on first use so a failure is reported by the operation that needed the database. */
export type SqliteLocation = string | (() => Promise<string>)

/**
 * The one authoritative native SQLite connection for a TODO database, opened on first use and kept until close().
 * Durability: WAL with synchronous=FULL, so a committed transaction is fsynced before its write resolves.
 * WAL requires a local filesystem; the database must not be placed on network storage.
 */
const openSqliteFiles = new Set<SqliteFile>()

export class SqliteFile {
  private databasePath = ""
  private readonly location: SqliteLocation
  private connection?: Promise<Database>
  private database?: Database
  private closed = false

  constructor(location: SqliteLocation) {
    this.location = location
    if (typeof location === "string") this.databasePath = location
    openSqliteFiles.add(this)
  }

  initialize(): Promise<void> {
    return this.open().then(() => undefined)
  }

  private open(): Promise<Database> {
    if (this.closed) return Promise.reject(new Error("The Twinny TODO database is closed"))
    if (!this.connection) {
      this.connection = this.openDatabase().catch((error) => {
        this.connection = undefined
        throw error
      })
    }
    return this.connection
  }

  private async openDatabase(): Promise<Database> {
    if (typeof this.location !== "string") this.databasePath = await this.location()
    await fs.mkdir(path.dirname(this.databasePath), { recursive: true })
    const nativeBinding = sqlitePrebuildBinding()
    const database = nativeBinding ? new BetterSqlite(this.databasePath, { nativeBinding }) : new BetterSqlite(this.databasePath)
    try {
      database.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`)
      database.pragma("foreign_keys = ON")
      database.pragma("synchronous = FULL")
      if (database.pragma("journal_mode = WAL", { simple: true }) !== "wal") throw new Error("SQLite did not enable WAL journaling")
      verifyIntegrity(database)
      this.migrate(database)
      if (this.closed) throw new Error("The Twinny TODO database was closed while opening")
      this.database = database
      return database
    } catch (error) {
      database.close()
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`Could not open the Twinny TODO database at ${this.databasePath}: ${reason}. The existing file was left in place and no replacement was created.`)
    }
  }

  private migrate(database: Database): void {
    const version = schemaVersion(database)
    if (version > CURRENT_SCHEMA_VERSION) throw new Error(`TODO database version ${version} is newer than this Twinny version`)
    if (version === CURRENT_SCHEMA_VERSION) return
    if (version > 0) this.backup(database, version)
    database.transaction(() => {
      const current = schemaVersion(database)
      if (current > CURRENT_SCHEMA_VERSION) throw new Error(`TODO database version ${current} is newer than this Twinny version`)
      this.applyMigrations(database, current)
    }).immediate()
  }

  // VACUUM INTO writes a consistent snapshot, including WAL content, and cannot run inside a transaction.
  // Each backup gets a new name, so an earlier backup is never overwritten.
  private backup(database: Database, version: number): void {
    database.prepare("VACUUM INTO ?").run(`${this.databasePath}.v${version}.${Date.now()}.bak`)
  }

  private applyMigrations(database: Database, version: number): void {
    if (version === 0) {
      database.exec(SCHEMA)
    } else if (version === 1) {
      database.exec("ALTER TABLE todo_items ADD COLUMN source TEXT NOT NULL DEFAULT 'model' CHECK(source IN ('user','model','intent_compiler'))")
      database.exec(
        "CREATE TABLE IF NOT EXISTS todo_intent_plans (list_id TEXT PRIMARY KEY REFERENCES todo_lists(id) ON DELETE CASCADE, plan_id TEXT NOT NULL, revision INTEGER NOT NULL, goal TEXT NOT NULL, constraints_json TEXT NOT NULL, intent_result_json TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS todo_intent_tasks (list_id TEXT NOT NULL REFERENCES todo_lists(id) ON DELETE CASCADE, task_id TEXT NOT NULL, item_id TEXT NOT NULL UNIQUE REFERENCES todo_items(id) ON DELETE CASCADE, acceptance_json TEXT NOT NULL, dependencies_json TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(list_id, task_id)); PRAGMA user_version = 2;"
      )
    }
    if (version > 0 && version < 3) {
      database.exec(SCHEMA.slice(SCHEMA.indexOf("CREATE TABLE IF NOT EXISTS todo_tool_observations"), SCHEMA.indexOf("PRAGMA user_version = 4;") + "PRAGMA user_version = 4;".length))
    } else if (version === 3) {
      database.exec(SCHEMA.slice(SCHEMA.indexOf("CREATE TABLE IF NOT EXISTS todo_tool_evidence"), SCHEMA.indexOf("PRAGMA user_version = 4;") + "PRAGMA user_version = 4;".length))
    }
    if (version > 0 && version < 5) {
      database.exec(SCHEMA.slice(SCHEMA.indexOf("CREATE TABLE IF NOT EXISTS todo_child_proposals"), SCHEMA.indexOf("CREATE TABLE IF NOT EXISTS todo_accepted_evidence")))
    }
    if (version > 0 && version < 6) {
      database.exec(SCHEMA.slice(SCHEMA.indexOf("CREATE TABLE IF NOT EXISTS todo_accepted_evidence"), SCHEMA.indexOf("PRAGMA user_version = 6;") + "PRAGMA user_version = 6;".length))
    }
    if (version > 0 && version < 7) {
      database.exec(SCHEMA.slice(SCHEMA.indexOf("CREATE TABLE IF NOT EXISTS todo_symbol_aliases"), SCHEMA.indexOf("PRAGMA user_version = 7;") + "PRAGMA user_version = 7;".length))
    }
    if (version > 0 && version < 8) {
      if (!tableColumns(database, "todo_intent_tasks").some((column) => column.name === "criteria_json")) database.exec("ALTER TABLE todo_intent_tasks ADD COLUMN criteria_json TEXT")
      database.exec("PRAGMA user_version = 8")
    }
    if (version > 0 && version < 9) {
      // Pre-typed plans have no criteria_json. Their links are deactivated, never deleted; the pre-migration backup keeps the original rows.
      database.exec("UPDATE todo_intent_tasks SET active = 0 WHERE criteria_json IS NULL")
      if (tableColumns(database, "todo_intent_tasks").some((column) => column.name === "acceptance_json")) database.exec("ALTER TABLE todo_intent_tasks DROP COLUMN acceptance_json")
      database.exec("PRAGMA user_version = 9")
    }
    if (version > 0 && version < 10) {
      // Observations record the list revision that ordered them. Legacy rows stay NULL and sort before any new observation.
      if (!tableColumns(database, "todo_tool_observations").some((column) => column.name === "list_revision")) database.exec("ALTER TABLE todo_tool_observations ADD COLUMN list_revision INTEGER")
      database.exec("CREATE INDEX IF NOT EXISTS todo_tool_observations_list_revision ON todo_tool_observations(list_id, list_revision); PRAGMA user_version = 10")
    }
    if (version > 0 && version < 11) {
      // Activations are host-owned and additive: no existing row changes, and a v10 database gains an empty table.
      database.exec(SCHEMA.slice(SCHEMA.indexOf("CREATE TABLE IF NOT EXISTS todo_requirement_activations"), SCHEMA.indexOf("PRAGMA user_version = 11;") + "PRAGMA user_version = 11;".length))
    }
    if (version > 0 && version < 12) {
      // Edit operations are additive: an existing database gains an empty ledger and no existing row changes.
      database.exec(SCHEMA.slice(SCHEMA.indexOf("CREATE TABLE IF NOT EXISTS todo_edit_operations"), SCHEMA.indexOf("PRAGMA user_version = 12;") + "PRAGMA user_version = 12;".length))
    }
    if (version < 13) this.migrateEditOperationsToV13(database)
    if (version < 14) this.migrateEditOperationsToV14(database)
    if (version < 15) this.migrateIntentPlanAnswerToV15(database)
    if (version < 16) this.migrateAcceptedEvidenceToV16(database)
    if (version < 17) this.migrateObservationExecutionToV17(database)
    if (version < 18) this.migrateEvidenceUsageToV18(database)
  }

  // v13 makes an operation's task optional so project-scoped edits can be recorded without an active TODO.
  // Fresh databases pass through here after SCHEMA creates the v12 shape. Only the NOT NULL item column is rebuilt.
  private migrateEditOperationsToV13(database: Database): void {
    const itemColumn = tableColumns(database, "todo_edit_operations").find((column) => column.name === "item_id")
    if (itemColumn?.notnull === 1) {
      database.exec(`
CREATE TABLE todo_edit_operations_v13 (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL REFERENCES todo_lists(id) ON DELETE CASCADE,
  item_id TEXT REFERENCES todo_items(id) ON DELETE CASCADE,
  target TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('apply','review')),
  pre_digest TEXT NOT NULL,
  post_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('dispatched','succeeded','failed','reconciled_applied','reconciled_absent','diverged')),
  detail TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT INTO todo_edit_operations_v13 (id, list_id, item_id, target, mode, pre_digest, post_digest, status, detail, created_at, updated_at)
  SELECT id, list_id, item_id, target, mode, pre_digest, post_digest, status, detail, created_at, updated_at FROM todo_edit_operations;
DROP TABLE todo_edit_operations;
ALTER TABLE todo_edit_operations_v13 RENAME TO todo_edit_operations;
CREATE INDEX IF NOT EXISTS todo_edit_operations_target ON todo_edit_operations(list_id, target, status);
`)
    }
    database.exec("PRAGMA user_version = 13")
  }

  // v14 records the extension host that dispatched each edit. The column is additive; rows from earlier versions keep
  // a NULL owner, which another host can never settle as absent.
  private migrateEditOperationsToV14(database: Database): void {
    if (!tableColumns(database, "todo_edit_operations").some((column) => column.name === "owner_id")) database.exec("ALTER TABLE todo_edit_operations ADD COLUMN owner_id TEXT")
    database.exec("PRAGMA user_version = 14")
  }

  // v15 stores the objective answer requirements of an intent plan. The column is additive; plans from earlier versions
  // have no requirements, which is the same as a plan that asks for none.
  private migrateIntentPlanAnswerToV15(database: Database): void {
    if (!tableColumns(database, "todo_intent_plans").some((column) => column.name === "answer_json")) database.exec("ALTER TABLE todo_intent_plans ADD COLUMN answer_json TEXT NOT NULL DEFAULT '[]'")
    database.exec("PRAGMA user_version = 15")
  }

  // v16 makes an accepted evidence row the single authority for a tool registration it proves: registered_tool names the
  // tool, and symbol names the implementation. Rows from earlier versions keep a NULL registered_tool and are not
  // backfilled from todo_symbol_aliases, because those rows came from the removed line-indentation heuristic. The alias
  // table is kept unchanged as history and is no longer written or read.
  private migrateAcceptedEvidenceToV16(database: Database): void {
    if (!tableColumns(database, "todo_accepted_evidence").some((column) => column.name === "registered_tool")) database.exec("ALTER TABLE todo_accepted_evidence ADD COLUMN registered_tool TEXT")
    database.exec("PRAGMA user_version = 16")
  }

  // v17 records the host-generated execution that produced each tool observation, so failures can be reported for the
  // execution that made them. Rows from earlier versions keep a NULL execution_id: they stay as history and are never
  // attributed to a later execution. No rows are rewritten or deleted.
  private migrateObservationExecutionToV17(database: Database): void {
    if (!tableColumns(database, "todo_tool_observations").some((column) => column.name === "execution_id")) database.exec("ALTER TABLE todo_tool_observations ADD COLUMN execution_id TEXT")
    database.exec("CREATE INDEX IF NOT EXISTS todo_tool_observations_execution ON todo_tool_observations(list_id, execution_id)")
    database.exec("PRAGMA user_version = 17")
  }

  // v18 records project-wide accepted-evidence usage. One row per fact, kind, and execution, so repeated identical
  // requests within one execution count once, while each execution in any conversation of the project counts once.
  // Usage rows never change the accepted fact they reference; they are removed only if their fact is removed.
  private migrateEvidenceUsageToV18(database: Database): void {
    database.exec(`
CREATE TABLE IF NOT EXISTS todo_evidence_usage (
  id TEXT PRIMARY KEY,
  fact_id TEXT NOT NULL REFERENCES todo_accepted_evidence(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES todo_projects(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('lookup', 'reuse')),
  created_at TEXT NOT NULL,
  UNIQUE (fact_id, kind, execution_id)
);
CREATE INDEX IF NOT EXISTS todo_evidence_usage_project ON todo_evidence_usage(project_id, fact_id);
PRAGMA user_version = 18;`)
  }

  async read<T>(operation: (database: Database) => T): Promise<T> {
    return operation(await this.open())
  }

  async write<T>(operation: (database: Database) => T): Promise<T> {
    const database = await this.open()
    return database.transaction(() => {
      const result = operation(database)
      if (result instanceof Promise) throw new Error("TODO database writes must complete synchronously")
      return result
    }).immediate()
  }

  close(): void {
    this.closed = true
    this.connection = undefined
    this.database?.close()
    this.database = undefined
    openSqliteFiles.delete(this)
  }
}

/** Closes every TODO database connection so a checkpoint completes before the extension host exits. */
export const closeTodoDatabases = (): void => {
  for (const file of [...openSqliteFiles]) file.close()
}

export const PROJECT_TODO_DIRECTORY = ".twinny"
export const PROJECT_TODO_DATABASE_NAME = "evidence.sqlite"

const LEGACY_TODO_DATABASE_NAME = "twinny-state.sqlite"
const LEGACY_TODO_SIDECAR = /^twinny-state\.sqlite(?:-wal|-shm|-journal|\.v\d+\.bak|\.\d+\.[0-9a-f-]{36}\.tmp)$/
const SQLITE_HEADER = "SQLite format 3\u0000"
const LOCK_STALE_MS = 120_000
const GITIGNORE_ENTRY = ".twinny/"
const GITIGNORE_EQUIVALENTS = new Set([".twinny", ".twinny/", "/.twinny", "/.twinny/"])

export interface WorkspaceFolderLocation {
  readonly scheme: string
  readonly fsPath: string
}

export interface ProjectTodoStorage {
  readonly projectRoot: string
  readonly databasePath: string
}

/** Resolves the single project that owns the TODO database. Never selects one root from several. */
export const resolveProjectTodoStorage = (folders: readonly WorkspaceFolderLocation[]): ProjectTodoStorage => {
  if (folders.length === 0) {
    throw new Error("Twinny TODO storage needs an open project folder to create .twinny/evidence.sqlite")
  }
  if (folders.length > 1) {
    throw new Error("Twinny TODO storage cannot choose between multiple workspace folders; open a single project folder")
  }
  const [folder] = folders
  if (folder.scheme !== "file") {
    throw new Error(`Twinny TODO storage needs a local project folder, not a "${folder.scheme}" folder`)
  }
  const projectRoot = path.resolve(folder.fsPath)
  return {
    projectRoot,
    databasePath: path.join(projectRoot, PROJECT_TODO_DIRECTORY, PROJECT_TODO_DATABASE_NAME)
  }
}

const refuseSymbolicLink = async (target: string): Promise<void> => {
  try {
    if ((await fs.lstat(target)).isSymbolicLink()) {
      throw new Error(`Refusing to use ${target} for TODO storage because it is a symbolic link`)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
}

/** Creates `.twinny/`, ensures it is git-ignored, and returns the database path. Symlinked storage is refused. */
export const prepareProjectTodoStorage = async (storage: ProjectTodoStorage): Promise<string> => {
  const directory = path.dirname(storage.databasePath)
  await refuseSymbolicLink(directory)
  await fs.mkdir(directory, { recursive: true })
  await refuseSymbolicLink(storage.databasePath)
  await ensureProjectGitignore(storage.projectRoot)
  return storage.databasePath
}

/** Appends `.twinny/` to the project's .gitignore without changing existing lines. */
export const ensureProjectGitignore = async (projectRoot: string): Promise<void> => {
  const gitignorePath = path.join(projectRoot, ".gitignore")
  await refuseSymbolicLink(gitignorePath)
  let existing: string | undefined
  try {
    existing = await fs.readFile(gitignorePath, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  if (existing === undefined) {
    await fs.writeFile(gitignorePath, `${GITIGNORE_ENTRY}\n`, { flag: "wx" })
    return
  }
  if (existing.split(/\r?\n/).some((line) => GITIGNORE_EQUIVALENTS.has(line.trim()))) return
  const eol = existing.includes("\r\n") ? "\r\n" : "\n"
  const separator = existing.length > 0 && !existing.endsWith("\n") ? eol : ""
  await fs.appendFile(gitignorePath, `${separator}${GITIGNORE_ENTRY}${eol}`)
}

export type LegacyTodoRetirement =
  | { readonly status: "absent"; readonly legacyPath: string }
  | { readonly status: "removed"; readonly legacyPath: string; readonly removed: readonly string[] }
  | { readonly status: "blocked"; readonly legacyPath: string; readonly reason: string }

const acquireLegacyLock = async (lockPath: string): Promise<boolean> => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await (await fs.open(lockPath, "wx", 0o600)).close()
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
    try {
      const stat = await fs.stat(lockPath)
      if (Date.now() - stat.mtimeMs <= LOCK_STALE_MS) return false
      await fs.unlink(lockPath)
    } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError
    }
  }
  return false
}

const readSqliteHeader = async (file: string): Promise<string> => {
  const handle = await fs.open(file, "r")
  try {
    const buffer = Buffer.alloc(SQLITE_HEADER.length)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead).toString("latin1")
  } finally {
    await handle.close()
  }
}

/**
 * One-time removal of the extension-global TODO database. Deletes only `twinny-state.sqlite` and its exact
 * SQLite sidecar names, and only after verifying the main file is a regular SQLite database not held by another
 * Twinny process (via the same `.lock` protocol the repository uses). Anything unexpected blocks the removal.
 */
export const retireLegacyTodoDatabase = async (globalStorageDir: string, activeDatabasePath: string): Promise<LegacyTodoRetirement> => {
  const legacyPath = path.join(globalStorageDir, LEGACY_TODO_DATABASE_NAME)
  if (path.resolve(legacyPath) === path.resolve(activeDatabasePath)) {
    return { status: "blocked", legacyPath, reason: "the legacy path is the active project database" }
  }
  const lockPath = `${legacyPath}.lock`
  if (!(await acquireLegacyLock(lockPath))) {
    return { status: "blocked", legacyPath, reason: "another Twinny process holds the legacy database lock" }
  }
  try {
    try {
      if (!(await fs.lstat(legacyPath)).isFile()) {
        return { status: "blocked", legacyPath, reason: "the legacy path is not a regular file" }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "absent", legacyPath }
      throw error
    }
    if ((await readSqliteHeader(legacyPath)) !== SQLITE_HEADER) {
      return { status: "blocked", legacyPath, reason: "the legacy path is not a SQLite database" }
    }
    const sidecars = (await fs.readdir(globalStorageDir))
      .filter((name) => LEGACY_TODO_SIDECAR.test(name))
      .map((name) => path.join(globalStorageDir, name))
    for (const sidecar of sidecars) {
      if (!(await fs.lstat(sidecar)).isFile()) {
        return { status: "blocked", legacyPath, reason: `${sidecar} is not a regular file` }
      }
    }
    const removed: string[] = []
    for (const sidecar of sidecars) {
      await fs.unlink(sidecar)
      removed.push(sidecar)
    }
    await fs.unlink(legacyPath)
    removed.push(legacyPath)
    return { status: "removed", legacyPath, removed }
  } finally {
    await fs.unlink(lockPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
    })
  }
}
