import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import initSqlJs, { Database, SqlJsStatic } from "sql.js"

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
  acceptance_json TEXT NOT NULL,
  dependencies_json TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(list_id, task_id)
);
PRAGMA user_version = 2;
`

export class SqliteFile {
  private readonly databasePath: string
  private readonly lockPath: string
  private readonly wasmPath: string
  private sqlPromise?: Promise<SqlJsStatic>
  private initialization?: Promise<void>

  constructor(databasePath: string, wasmPath: string) {
    this.databasePath = databasePath
    this.lockPath = `${databasePath}.lock`
    this.wasmPath = wasmPath
  }

  initialize(): Promise<void> {
    if (!this.initialization) {
      this.initialization = this.initializeOnce().catch((error) => {
        this.initialization = undefined
        throw error
      })
    }
    return this.initialization
  }

  private async initializeOnce(): Promise<void> {
    await this.withLock(async () => {
      const database = await this.openDatabase()
      try {
        const version = database.exec("PRAGMA user_version")[0]?.values[0]?.[0] ?? 0
        if (typeof version !== "number") throw new Error("Could not read TODO database schema version")
        if (version > 2) throw new Error(`TODO database version ${version} is newer than this Twinny version`)
        if (version === 0) {
          database.run(SCHEMA)
          await this.persist(database)
        } else if (version === 1) {
          database.run("ALTER TABLE todo_items ADD COLUMN source TEXT NOT NULL DEFAULT 'model' CHECK(source IN ('user','model','intent_compiler'))")
          database.run(
            "CREATE TABLE IF NOT EXISTS todo_intent_plans (list_id TEXT PRIMARY KEY REFERENCES todo_lists(id) ON DELETE CASCADE, plan_id TEXT NOT NULL, revision INTEGER NOT NULL, goal TEXT NOT NULL, constraints_json TEXT NOT NULL, intent_result_json TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS todo_intent_tasks (list_id TEXT NOT NULL REFERENCES todo_lists(id) ON DELETE CASCADE, task_id TEXT NOT NULL, item_id TEXT NOT NULL UNIQUE REFERENCES todo_items(id) ON DELETE CASCADE, acceptance_json TEXT NOT NULL, dependencies_json TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(list_id, task_id)); PRAGMA user_version = 2;"
          )
          await this.persist(database)
        }
      } finally {
        database.close()
      }
    })
  }

  async read<T>(operation: (database: Database) => T): Promise<T> {
    await this.initialize()
    const database = await this.openDatabase()
    try {
      return operation(database)
    } finally {
      database.close()
    }
  }

  async write<T>(operation: (database: Database) => T): Promise<T> {
    await this.initialize()
    return this.withLock(async () => {
      const database = await this.openDatabase()
      try {
        database.run("BEGIN IMMEDIATE")
        const result = operation(database)
        database.run("COMMIT")
        await this.persist(database)
        return result
      } catch (error) {
        try {
          database.run("ROLLBACK")
        } catch {
          // The transaction may already have rolled back after a commit error.
        }
        throw error
      } finally {
        database.close()
      }
    })
  }

  private async openDatabase(): Promise<Database> {
    let bytes: Uint8Array | undefined
    try {
      bytes = await fs.readFile(this.databasePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    const sql = await (this.sqlPromise ??= initSqlJs({ locateFile: () => this.wasmPath }))
    const database = new sql.Database(bytes)
    database.run("PRAGMA foreign_keys = ON")
    return database
  }

  private async persist(database: Database): Promise<void> {
    const temporaryPath = `${this.databasePath}.${process.pid}.${randomUUID()}.tmp`
    try {
      const handle = await fs.open(temporaryPath, "wx", 0o600)
      try {
        await handle.writeFile(database.export())
        await handle.sync()
      } finally {
        await handle.close()
      }
      await fs.rename(temporaryPath, this.databasePath)
    } catch (error) {
      try {
        await fs.unlink(temporaryPath)
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError
      }
      throw error
    }
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await fs.mkdir(path.dirname(this.databasePath), { recursive: true })
    const deadline = Date.now() + 15_000
    let lock: Awaited<ReturnType<typeof fs.open>> | undefined
    while (!lock) {
      try {
        lock = await fs.open(this.lockPath, "wx", 0o600)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
        try {
          const stat = await fs.stat(this.lockPath)
          if (Date.now() - stat.mtimeMs > 120_000) {
            await fs.unlink(this.lockPath)
            continue
          }
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError
          continue
        }
        if (Date.now() >= deadline) throw new Error("Timed out waiting for the Twinny TODO database lock")
        await new Promise((resolve) => setTimeout(resolve, 40))
      }
    }
    try {
      await lock.writeFile(`${process.pid}\n`)
      return await operation()
    } finally {
      await lock.close()
      await fs.unlink(this.lockPath)
    }
  }
}
