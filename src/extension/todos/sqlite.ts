import BetterSqlite from "better-sqlite3"
import { existsSync } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"

import { type ProjectHomeOptions, type ProjectTodoStorage, projectTodoStorageOf, type WorkspaceFolderLocation } from "./project-home"
import { homePathOfDatabase, SOURCE_ROOT_SCHEMA } from "./source-roots"

const SCHEMA = `
CREATE TABLE todo_projects (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE todo_lists (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES todo_projects(id),
  conversation_id TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, conversation_id)
);
CREATE TABLE todo_items (
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
CREATE INDEX todo_items_list_status ON todo_items(list_id, status, created_at);
CREATE TABLE todo_dependencies (
  item_id TEXT NOT NULL REFERENCES todo_items(id) ON DELETE CASCADE,
  depends_on_item_id TEXT NOT NULL REFERENCES todo_items(id) ON DELETE CASCADE,
  PRIMARY KEY(item_id, depends_on_item_id),
  CHECK(item_id != depends_on_item_id)
);
CREATE TABLE todo_events (
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
CREATE INDEX todo_events_list_revision ON todo_events(list_id, list_revision);
CREATE TABLE todo_evidence (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES todo_items(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  result TEXT NOT NULL CHECK(result IN ('observed','passed','failed')),
  created_at TEXT NOT NULL
);
CREATE TABLE todo_requests (
  list_id TEXT NOT NULL REFERENCES todo_lists(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(list_id, request_id)
);
CREATE TABLE todo_intent_plans (
  list_id TEXT PRIMARY KEY REFERENCES todo_lists(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  goal TEXT NOT NULL,
  constraints_json TEXT NOT NULL,
  intent_result_json TEXT NOT NULL,
  answer_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);
CREATE TABLE todo_intent_tasks (
  list_id TEXT NOT NULL REFERENCES todo_lists(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  item_id TEXT NOT NULL UNIQUE REFERENCES todo_items(id) ON DELETE CASCADE,
  dependencies_json TEXT NOT NULL,
  criteria_json TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(list_id, task_id)
);
CREATE TABLE todo_tool_observations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES todo_projects(id),
  list_id TEXT,
  item_id TEXT,
  request_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  arguments_json TEXT NOT NULL,
  output TEXT NOT NULL,
  failed INTEGER NOT NULL,
  exit_code INTEGER,
  created_at TEXT NOT NULL,
  list_revision INTEGER,
  execution_id TEXT,
  executed INTEGER NOT NULL DEFAULT 1 CHECK (executed IN (0,1)),
  call_id TEXT,
  host_key TEXT NOT NULL DEFAULT '',
  started_at TEXT,
  finished_at TEXT,
  outcome_id TEXT REFERENCES evidence_outcomes(id),
  error_code TEXT CHECK (error_code IS NULL OR error_code = 'refused_before_execution'),
  validity_class TEXT CHECK (validity_class IS NULL OR validity_class IN ('current','stale','unknown','historical','superseded')),
  UNIQUE(project_id, request_id)
);
CREATE INDEX todo_tool_observations_list_revision ON todo_tool_observations(list_id, list_revision);
CREATE INDEX todo_tool_observations_execution ON todo_tool_observations(list_id, execution_id);
CREATE INDEX todo_tool_observations_item ON todo_tool_observations(item_id);
CREATE INDEX todo_tool_observations_project ON todo_tool_observations(project_id, created_at);
CREATE TABLE todo_evaluations (
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
CREATE INDEX todo_evaluations_item ON todo_evaluations(item_id, created_at);
CREATE TABLE todo_tool_evidence (
  observation_id TEXT PRIMARY KEY REFERENCES todo_tool_observations(id) ON DELETE CASCADE,
  list_id TEXT,
  content TEXT,
  retained INTEGER NOT NULL DEFAULT 1,
  complete INTEGER NOT NULL,
  original_chars INTEGER NOT NULL,
  preserved_chars INTEGER NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX todo_tool_evidence_list ON todo_tool_evidence(list_id, retained, created_at);
CREATE TABLE todo_child_proposals (
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
CREATE INDEX todo_child_proposals_fingerprint ON todo_child_proposals(list_id, fingerprint, created_at);
CREATE TABLE todo_accepted_evidence (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES todo_projects(id),
  list_id TEXT,
  plan_id TEXT,
  plan_revision INTEGER,
  item_id TEXT,
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
  created_at TEXT NOT NULL,
  registered_tool TEXT
);
CREATE INDEX todo_accepted_evidence_lookup ON todo_accepted_evidence(list_id, symbol, path, superseded_by);
CREATE INDEX todo_accepted_evidence_item ON todo_accepted_evidence(item_id, criterion_index);
CREATE INDEX todo_accepted_evidence_project ON todo_accepted_evidence(project_id, symbol, path);
CREATE INDEX todo_accepted_evidence_observation ON todo_accepted_evidence(observation_id);
CREATE INDEX todo_accepted_evidence_revision ON todo_accepted_evidence(list_id, plan_id, plan_revision);
CREATE TABLE todo_symbol_aliases (
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
CREATE INDEX todo_symbol_aliases_tool ON todo_symbol_aliases(tool_name, path);
CREATE INDEX todo_symbol_aliases_list ON todo_symbol_aliases(list_id);
CREATE TABLE todo_requirement_activations (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL REFERENCES todo_lists(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES todo_items(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('activation','renewal')),
  list_revision INTEGER NOT NULL,
  activated_at INTEGER NOT NULL,
  UNIQUE(list_id, request_id)
);
CREATE INDEX todo_requirement_activations_item ON todo_requirement_activations(list_id, item_id, list_revision);
CREATE TABLE todo_edit_operations (
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
  updated_at INTEGER NOT NULL,
  owner_id TEXT
);
CREATE INDEX todo_edit_operations_target ON todo_edit_operations(list_id, target, status);
CREATE TABLE todo_evidence_usage (
  id TEXT PRIMARY KEY,
  fact_id TEXT NOT NULL REFERENCES todo_accepted_evidence(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES todo_projects(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('lookup', 'reuse')),
  created_at TEXT NOT NULL,
  UNIQUE (fact_id, kind, execution_id)
);
CREATE INDEX todo_evidence_usage_project ON todo_evidence_usage(project_id, fact_id);
CREATE TABLE todo_assessments (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL REFERENCES todo_lists(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES todo_items(id) ON DELETE CASCADE,
  evaluation_id TEXT NOT NULL REFERENCES todo_evaluations(id) ON DELETE CASCADE,
  evaluation_request_id TEXT NOT NULL,
  task_version INTEGER NOT NULL,
  result_version INTEGER NOT NULL,
  plan_revision INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('assessed', 'unavailable')),
  progress_score INTEGER CHECK (progress_score BETWEEN 1 AND 5),
  progress_explanation TEXT,
  verification_score INTEGER CHECK (verification_score BETWEEN 1 AND 5),
  verification_explanation TEXT,
  evidence_refs_json TEXT NOT NULL,
  reason TEXT,
  evaluator_provider TEXT NOT NULL,
  evaluator_model TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (list_id, evaluation_request_id, item_id),
  CHECK (
    (status = 'assessed' AND progress_score IS NOT NULL AND progress_explanation IS NOT NULL
      AND verification_score IS NOT NULL AND verification_explanation IS NOT NULL AND reason IS NULL)
    OR (status = 'unavailable' AND progress_score IS NULL AND progress_explanation IS NULL
      AND verification_score IS NULL AND verification_explanation IS NULL AND reason IS NOT NULL)
  )
);
CREATE INDEX todo_assessments_item ON todo_assessments(item_id, created_at);
CREATE TRIGGER todo_assessments_immutable BEFORE UPDATE ON todo_assessments
BEGIN SELECT RAISE(ABORT, 'TODO assessments are immutable'); END;
CREATE TABLE todo_assessment_current (
  item_id TEXT PRIMARY KEY REFERENCES todo_items(id) ON DELETE CASCADE,
  list_id TEXT NOT NULL REFERENCES todo_lists(id) ON DELETE CASCADE,
  assessment_id TEXT NOT NULL REFERENCES todo_assessments(id) ON DELETE CASCADE
);
CREATE INDEX todo_assessment_current_list ON todo_assessment_current(list_id);
CREATE TABLE todo_assessment_reactions (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  list_id TEXT NOT NULL REFERENCES todo_lists(id) ON DELETE CASCADE,
  assessment_id TEXT NOT NULL REFERENCES todo_assessments(id) ON DELETE CASCADE,
  reaction TEXT CHECK (reaction IS NULL OR reaction IN ('agree', 'disagree', 'facepalm')),
  actor TEXT NOT NULL CHECK (actor = 'user'),
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (list_id, request_id)
);
CREATE INDEX todo_assessment_reactions_assessment ON todo_assessment_reactions(assessment_id, seq);
CREATE TRIGGER todo_assessment_reactions_append_only BEFORE UPDATE ON todo_assessment_reactions
BEGIN SELECT RAISE(ABORT, 'TODO assessment reactions are append-only'); END;
${SOURCE_ROOT_SCHEMA}
CREATE TABLE observation_source (
  observation_id TEXT NOT NULL REFERENCES todo_tool_observations(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  root_id TEXT NOT NULL REFERENCES source_root(root_id),
  path TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('read','created','modified','deleted','moved_from','moved_to')),
  start_line INTEGER,
  end_line INTEGER,
  total_lines INTEGER,
  content_hash TEXT,
  observed_version TEXT NOT NULL DEFAULT 'disk' CHECK(observed_version IN ('disk','buffer')),
  editor_version INTEGER,
  created_at TEXT NOT NULL,
  PRIMARY KEY(observation_id, ordinal)
);
CREATE INDEX observation_source_location ON observation_source(root_id, path);
CREATE INDEX observation_source_hash ON observation_source(content_hash);
CREATE TABLE index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE documents (
  uri TEXT PRIMARY KEY, workspace_uri TEXT NOT NULL, relative_path TEXT NOT NULL,
  filename TEXT NOT NULL, language_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
  hash_algorithm TEXT NOT NULL, size INTEGER NOT NULL, mtime_ms REAL,
  text TEXT NOT NULL, indexed_at TEXT NOT NULL, skip_reason TEXT, error TEXT,
  symbols_fingerprint TEXT, scan_id TEXT
);
CREATE INDEX documents_workspace ON documents(workspace_uri);
CREATE INDEX documents_path ON documents(relative_path);
CREATE INDEX documents_fingerprint ON documents(fingerprint);
CREATE TABLE symbols (
  document_uri TEXT NOT NULL REFERENCES documents(uri) ON DELETE CASCADE,
  name TEXT NOT NULL, kind TEXT NOT NULL, line INTEGER NOT NULL, column_no INTEGER NOT NULL,
  end_line INTEGER NOT NULL, end_column INTEGER NOT NULL, container TEXT,
  PRIMARY KEY(document_uri,name,kind,line,column_no)
);
CREATE INDEX symbols_name ON symbols(name);
CREATE VIRTUAL TABLE documents_fts USING fts5(uri UNINDEXED, relative_path, text);
-- §5.2 v21 additions, frozen by Stage 1 for the later stages. Additive tables only:
-- todo_tool_observations and todo_tool_evidence keep their existing meaning; the blob is
-- the authoritative byte store, and the evidence row stays the redacted presentation copy.
CREATE TABLE evidence_outcomes (
  id TEXT PRIMARY KEY,
  observation_id TEXT NOT NULL UNIQUE REFERENCES todo_tool_observations(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES todo_projects(id),
  execution_ref TEXT,
  session_id TEXT,
  batch_id TEXT,
  command_sequence INTEGER,
  status TEXT NOT NULL CHECK (status IN ('accepted','queued','starting','running','completed','exited','failed_to_start','cancelled','timed_out','lost','refused','unknown')),
  exit_code INTEGER,
  signal TEXT,
  termination_reason TEXT CHECK (termination_reason IS NULL OR termination_reason IN ('exit','signal','timeout','cancel','lost','spawn_error')),
  stdout_blob_id TEXT REFERENCES evidence_blobs(id),
  stderr_blob_id TEXT REFERENCES evidence_blobs(id),
  terminal_blob_id TEXT REFERENCES evidence_blobs(id),
  payload_blob_id TEXT REFERENCES evidence_blobs(id),
  capture_mode TEXT NOT NULL DEFAULT 'unknown' CHECK (capture_mode IN ('pipes','pty','terminal_merged','unknown','not_applicable')),
  captured_complete INTEGER NOT NULL DEFAULT 0 CHECK (captured_complete IN (0,1)),
  storage_complete INTEGER NOT NULL DEFAULT 0 CHECK (storage_complete IN (0,1)),
  gap_reason TEXT CHECK (gap_reason IS NULL OR gap_reason IN ('capture_limit','storage_limit','eviction','redaction','failure','inaccessible','not_captured','storage_error')),
  created_at TEXT NOT NULL
);
CREATE INDEX evidence_outcomes_observation ON evidence_outcomes(observation_id);
CREATE TABLE evidence_blobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES todo_projects(id),
  content_digest TEXT NOT NULL,
  storage_kind TEXT NOT NULL CHECK (storage_kind IN ('inline','file')),
  relative_path TEXT,
  inline_bytes BLOB,
  original_bytes INTEGER NOT NULL,
  stored_bytes INTEGER NOT NULL,
  encoding TEXT NOT NULL DEFAULT 'bytes' CHECK (encoding IN ('utf8','bytes','mixed')),
  byte_preservation TEXT NOT NULL DEFAULT 'lossless' CHECK (byte_preservation IN ('lossless','normalized','excluded')),
  redaction TEXT NOT NULL DEFAULT 'none' CHECK (redaction IN ('none','applied','excluded_by_policy')),
  created_at TEXT NOT NULL,
  evicted_at TEXT,
  UNIQUE (project_id, content_digest)
);
CREATE INDEX evidence_blobs_project ON evidence_blobs(project_id, created_at);
CREATE TABLE evidence_chunks (
  outcome_id TEXT NOT NULL REFERENCES evidence_outcomes(id) ON DELETE CASCADE,
  stream TEXT NOT NULL CHECK (stream IN ('stdout','stderr','terminal','payload')),
  seq INTEGER NOT NULL,
  byte_start INTEGER NOT NULL,
  byte_end INTEGER NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (outcome_id, stream, seq)
);
CREATE INDEX evidence_chunks_order ON evidence_chunks(outcome_id, stream, seq);
CREATE TABLE evidence_io_events (
  id TEXT PRIMARY KEY,
  outcome_id TEXT NOT NULL REFERENCES evidence_outcomes(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('stdin_write','stdin_close','spawn','exit','signal','cancel','timeout','pty_control','capture_gap')),
  byte_count INTEGER,
  result TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  details_json TEXT,
  UNIQUE (outcome_id, seq)
);
CREATE TABLE evidence_lines (
  blob_id TEXT NOT NULL REFERENCES evidence_blobs(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  char_start INTEGER NOT NULL,
  char_end INTEGER NOT NULL,
  byte_start INTEGER NOT NULL,
  byte_end INTEGER NOT NULL,
  PRIMARY KEY (blob_id, line_no)
);
CREATE INDEX evidence_lines_lookup ON evidence_lines(blob_id, byte_start);
CREATE TABLE evidence_dependencies (
  derived_observation_id TEXT NOT NULL REFERENCES todo_tool_observations(id) ON DELETE CASCADE,
  source_observation_id TEXT NOT NULL REFERENCES todo_tool_observations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('source_read','derived_claim','accepted_fact','supersedes')),
  established_at TEXT NOT NULL,
  PRIMARY KEY (derived_observation_id, source_observation_id, kind),
  CHECK (derived_observation_id <> source_observation_id)
);
CREATE INDEX evidence_dependencies_source ON evidence_dependencies(source_observation_id);
CREATE TABLE evidence_favourites (
  observation_id TEXT PRIMARY KEY REFERENCES todo_tool_observations(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES todo_projects(id),
  marked_at TEXT NOT NULL
);
CREATE INDEX evidence_favourites_project ON evidence_favourites(project_id, marked_at);
CREATE TABLE evidence_favourite_requests (
  project_id TEXT NOT NULL REFERENCES todo_projects(id),
  request_id TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('mark','unmark')),
  result TEXT NOT NULL CHECK (result IN ('changed','already','unknown','denied')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, request_id)
);
CREATE TABLE evidence_access_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES todo_projects(id),
  observation_id TEXT NOT NULL REFERENCES todo_tool_observations(id) ON DELETE CASCADE,
  operation TEXT NOT NULL CHECK (operation IN ('get','range','search','find','resolve_current')),
  arguments_json TEXT NOT NULL,
  outcome TEXT NOT NULL,
  execution_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX evidence_access_events_project ON evidence_access_events(project_id, created_at);
CREATE TABLE context_segments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES todo_projects(id),
  conversation_id TEXT NOT NULL,
  execution_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('user_instruction','system_policy','task_state','assistant_reply','evidence_projection')),
  observation_id TEXT REFERENCES todo_tool_observations(id),
  protected INTEGER NOT NULL DEFAULT 0 CHECK (protected IN (0,1)),
  favourite INTEGER NOT NULL DEFAULT 0 CHECK (favourite IN (0,1)),
  age_order INTEGER NOT NULL,
  approx_tokens INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (kind <> 'user_instruction' OR protected = 1)
);
CREATE INDEX context_segments_conversation ON context_segments(conversation_id, kind, age_order);
CREATE INDEX context_segments_observation ON context_segments(observation_id);
CREATE TABLE context_projections (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES todo_projects(id),
  conversation_id TEXT NOT NULL,
  execution_id TEXT,
  request_seq INTEGER NOT NULL,
  capacity_tokens INTEGER NOT NULL,
  threshold_percent INTEGER NOT NULL,
  utilization_before INTEGER NOT NULL,
  utilization_after INTEGER NOT NULL,
  removed_stale INTEGER NOT NULL DEFAULT 0,
  removed_valid INTEGER NOT NULL DEFAULT 0,
  compacted_favourites INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX context_projections_project ON context_projections(project_id, created_at);
CREATE TABLE context_projection_segments (
  projection_id TEXT NOT NULL REFERENCES context_projections(id) ON DELETE CASCADE,
  segment_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('user_instruction','system_policy','task_state','assistant_reply','evidence_projection')),
  observation_id TEXT,
  decision TEXT NOT NULL CHECK (decision IN ('kept','reference','compact_reference','removed')),
  tokens INTEGER NOT NULL,
  PRIMARY KEY (projection_id, segment_id)
);
CREATE TABLE storage_policy (
  project_id TEXT PRIMARY KEY REFERENCES todo_projects(id),
  max_project_bytes INTEGER NOT NULL,
  max_blob_bytes INTEGER NOT NULL,
  eviction_order TEXT NOT NULL DEFAULT 'oldest_unfavourited_first',
  redaction_mode TEXT NOT NULL DEFAULT 'presentation_only',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1))
);
PRAGMA user_version = 21;
`

/** The authoritative native connection type for the TODO database. */
export type Database = BetterSqlite.Database

const CURRENT_SCHEMA_VERSION = 21
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

/** A database at any other version is refused: the development phase has no migrations and nothing is changed. */
const refusedVersion = (version: number, databasePath: string): string => {
  const direction = version > CURRENT_SCHEMA_VERSION ? "newer" : "older"
  return `TODO database version ${version} is ${direction} than this Twinny version (v${CURRENT_SCHEMA_VERSION}), so it was left untouched. To reset this development database, delete ${databasePath} and its -wal and -shm sidecars and reopen; Twinny never migrates or deletes a database by itself.`
}

const schemaVersion = (database: Database): number => Number(database.pragma("user_version", { simple: true }))

const checkedDatabasePaths = new Set<string>()

/** quick_check once per database path per process, which replaces the full integrity_check on every open. */
const verifyIntegrity = (database: Database, databasePath: string): void => {
  if (checkedDatabasePaths.has(databasePath)) return
  const problems = (database.pragma("quick_check") as { quick_check: string }[])
    .map((row) => row.quick_check)
    .filter((message) => message !== "ok")
  if (problems.length > 0) throw new Error(`quick_check failed: ${problems.slice(0, 5).join("; ")}`)
  checkedDatabasePaths.add(databasePath)
}

/** A database path, or a resolver awaited on first use so a failure is reported by the operation that needed the database. */
export type SqliteLocation = string | (() => Promise<string>)

/** Runs once for a connection after the schema is ready, so the owner can register its project identity. */
export type DatabaseOpened = (database: Database, home: string) => void

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
  private readonly onOpened?: DatabaseOpened

  constructor(location: SqliteLocation, onOpened?: DatabaseOpened) {
    this.location = location
    this.onOpened = onOpened
    if (typeof location === "string") this.databasePath = location
    openSqliteFiles.add(this)
  }

  /** The resolved database path: the location as given, or the value the resolver answered with on the first open. */
  get filePath(): string {
    return this.databasePath
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
      verifyIntegrity(database, this.databasePath)
      this.migrate(database)
      this.onOpened?.(database, homePathOfDatabase(this.databasePath))
      if (this.closed) throw new Error("The Twinny TODO database was closed while opening")
      this.database = database
      return database
    } catch (error) {
      database.close()
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`Could not open the Twinny TODO database at ${this.databasePath}: ${reason}. The existing file was left in place and no replacement was created.`)
    }
  }

  /** Version 0 initializes the development schema; version 21 reopens it; any other version is refused. */
  private migrate(database: Database): void {
    const version = schemaVersion(database)
    if (version === 0) {
      database.transaction(() => database.exec(SCHEMA)).immediate()
      return
    }
    if (version !== CURRENT_SCHEMA_VERSION) throw new Error(refusedVersion(version, this.databasePath))
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


const LEGACY_TODO_DATABASE_NAME = "twinny-state.sqlite"
const LEGACY_TODO_SIDECAR = /^twinny-state\.sqlite(?:-wal|-shm|-journal|\.v\d+\.bak|\.\d+\.[0-9a-f-]{36}\.tmp)$/
const SQLITE_HEADER = "SQLite format 3\u0000"
const LOCK_STALE_MS = 120_000
const GITIGNORE_ENTRY = ".twinny/"
const GITIGNORE_EQUIVALENTS = new Set([".twinny", ".twinny/", "/.twinny", "/.twinny/"])

/** The project that owns the project database, decided without workspace folder order. */
export const resolveProjectTodoStorage = (folders: readonly WorkspaceFolderLocation[], options: ProjectHomeOptions = {}): ProjectTodoStorage =>
  projectTodoStorageOf({ folders, ...options })

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
  await ensureProjectGitignore(storage.home)
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
