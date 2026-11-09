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
        if (version > 14) throw new Error(`TODO database version ${version} is newer than this Twinny version`)
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
        if (version > 0 && version < 3) {
          database.run(SCHEMA.slice(SCHEMA.indexOf("CREATE TABLE IF NOT EXISTS todo_tool_observations"), SCHEMA.indexOf("PRAGMA user_version = 4;") + "PRAGMA user_version = 4;".length))
          await this.persist(database)
        } else if (version === 3) {
          database.run(SCHEMA.slice(SCHEMA.indexOf("CREATE TABLE IF NOT EXISTS todo_tool_evidence"), SCHEMA.indexOf("PRAGMA user_version = 4;") + "PRAGMA user_version = 4;".length))
          await this.persist(database)
        }
        if (version > 0 && version < 5) {
          database.run(SCHEMA.slice(SCHEMA.indexOf("CREATE TABLE IF NOT EXISTS todo_child_proposals"), SCHEMA.indexOf("CREATE TABLE IF NOT EXISTS todo_accepted_evidence")))
          await this.persist(database)
        }
        if (version > 0 && version < 6) {
          database.run(SCHEMA.slice(SCHEMA.indexOf("CREATE TABLE IF NOT EXISTS todo_accepted_evidence"), SCHEMA.indexOf("PRAGMA user_version = 6;") + "PRAGMA user_version = 6;".length))
          await this.persist(database)
        }
        if (version > 0 && version < 7) {
          database.run(SCHEMA.slice(SCHEMA.indexOf("CREATE TABLE IF NOT EXISTS todo_symbol_aliases"), SCHEMA.indexOf("PRAGMA user_version = 7;") + "PRAGMA user_version = 7;".length))
          await this.persist(database)
        }
        if (version > 0 && version < 8) {
          const taskColumns = database.exec("PRAGMA table_info(todo_intent_tasks)")[0]?.values.map((row) => row[1]) ?? []
          if (!taskColumns.includes("criteria_json")) database.run("ALTER TABLE todo_intent_tasks ADD COLUMN criteria_json TEXT")
          database.run("PRAGMA user_version = 8")
          await this.persist(database)
        }
        if (version > 0 && version < 9) {
          // Pre-typed plans have no criteria_json. Their links are deactivated, never deleted, and the file is kept as a backup.
          await fs.copyFile(this.databasePath, `${this.databasePath}.v8.bak`)
          database.run("UPDATE todo_intent_tasks SET active = 0 WHERE criteria_json IS NULL")
          const taskColumns = database.exec("PRAGMA table_info(todo_intent_tasks)")[0]?.values.map((row) => row[1]) ?? []
          if (taskColumns.includes("acceptance_json")) database.run("ALTER TABLE todo_intent_tasks DROP COLUMN acceptance_json")
          database.run("PRAGMA user_version = 9")
          await this.persist(database)
        }
        if (version > 0 && version < 10) {
          // Observations record the list revision that ordered them. Legacy rows stay NULL and sort before any new observation.
          const observationColumns = database.exec("PRAGMA table_info(todo_tool_observations)")[0]?.values.map((row) => row[1]) ?? []
          if (!observationColumns.includes("list_revision")) database.run("ALTER TABLE todo_tool_observations ADD COLUMN list_revision INTEGER")
          database.run("CREATE INDEX IF NOT EXISTS todo_tool_observations_list_revision ON todo_tool_observations(list_id, list_revision); PRAGMA user_version = 10")
          await this.persist(database)
        }
        if (version > 0 && version < 11) {
          // Activations are host-owned and additive: no existing row changes, and a v10 database gains an empty table.
          database.run(SCHEMA.slice(SCHEMA.indexOf("CREATE TABLE IF NOT EXISTS todo_requirement_activations"), SCHEMA.indexOf("PRAGMA user_version = 11;") + "PRAGMA user_version = 11;".length))
          await this.persist(database)
        }
        if (version > 0 && version < 12) {
          // Edit operations are additive: an existing database gains an empty ledger and no existing row changes.
          database.run(SCHEMA.slice(SCHEMA.indexOf("CREATE TABLE IF NOT EXISTS todo_edit_operations"), SCHEMA.indexOf("PRAGMA user_version = 12;") + "PRAGMA user_version = 12;".length))
          await this.persist(database)
        }
        if (version < 13) {
          await this.migrateEditOperationsToV13(database, version)
        }
        if (version < 14) {
          await this.migrateEditOperationsToV14(database)
        }
      } finally {
        database.close()
      }
    })
  }

  // v13 makes an operation's task optional so project-scoped edits can be recorded without an active TODO.
  // Fresh databases pass through here after SCHEMA creates the v12 shape. Only the NOT NULL item column is rebuilt.
  private async migrateEditOperationsToV13(database: Database, version: number): Promise<void> {
    const columns = database.exec("PRAGMA table_info(todo_edit_operations)")[0]?.values ?? []
    const itemColumn = columns.find((row) => row[1] === "item_id")
    if (itemColumn?.[3] === 1) {
      if (version > 0) await fs.copyFile(this.databasePath, `${this.databasePath}.v12.bak`)
      database.run(`
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
    database.run("PRAGMA user_version = 13")
    await this.persist(database)
  }

  // v14 records the extension host that dispatched each edit. The column is additive; rows from earlier versions keep
  // a NULL owner, which another host can never settle as absent.
  private async migrateEditOperationsToV14(database: Database): Promise<void> {
    const columns = database.exec("PRAGMA table_info(todo_edit_operations)")[0]?.values ?? []
    if (!columns.some((row) => row[1] === "owner_id")) database.run("ALTER TABLE todo_edit_operations ADD COLUMN owner_id TEXT")
    database.run("PRAGMA user_version = 14")
    await this.persist(database)
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
