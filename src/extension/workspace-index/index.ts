import { minimatch } from "minimatch"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import sqlite3, { Database } from "sqlite3"
import * as vscode from "vscode"

import { logger } from "../../common/logger"
import { ContentHashAlgorithm, fingerprintContent } from "../tools/fingerprint"

type IndexStatus = "disabled" | "not-initialized" | "scanning" | "indexing" | "ready" | "paused" | "error"
type SearchMode = "auto" | "path" | "symbol" | "literal" | "regex"

export interface WorkspaceIndexState {
  status: IndexStatus
  filesDiscovered: number
  filesIndexed: number
  symbolsIndexed: number
  filesPending: number
  filesSkipped: number
  filesFailed: number
  storageBytes: number
  sqliteCacheLimitBytes: number
  activeSourceBytes: number
  peakSourceBytes: number
  activeWorkers: number
  queueDepth: number
  lastIndexDurationMs?: number
  currentIndexDurationMs?: number
  symbolProviderCalls: number
  discoveryComplete: boolean
  lastSynchronized?: string
  fts5: boolean
  error?: string
}

export interface WorkspaceSearchRequest {
  query: string
  mode?: SearchMode
  scope?: string
  path?: string
  limit?: number
  offset?: number
}

export interface WorkspaceSearchHit {
  uri?: string
  path: string
  line?: number
  column?: number
  category: "path" | "symbol" | "content"
  symbol?: string
  kind?: string
  preview: string
  source: "index" | "live"
}

interface DocRow {
  uri: string
  workspace_uri: string
  relative_path: string
  filename: string
  language_id: string
  fingerprint: string
  hash_algorithm: string
  size: number
  mtime_ms: number | null
  text: string
  indexed_at: string
  skip_reason: string | null
  error: string | null
}

interface SymbolRow {
  uri: string
  name: string
  kind: string
  line: number
  column_no: number
  end_line: number
  end_column: number
  container: string | null
  path: string
}

type SqlValue = string | number | null | Buffer

const run = (database: Database, sql: string, values: SqlValue[] = []): Promise<sqlite3.RunResult> =>
  new Promise((resolve, reject) => {
    database.run(sql, values, function (error) {
      if (error) reject(error)
      else resolve(this)
    })
  })

const get = <T>(database: Database, sql: string, values: SqlValue[] = []): Promise<T | undefined> =>
  new Promise((resolve, reject) => {
    database.get<T>(sql, values, (error, row) => error ? reject(error) : resolve(row))
  })

const rows = <T>(database: Database, sql: string, values: SqlValue[] = []): Promise<T[]> =>
  new Promise((resolve, reject) => {
    database.all<T>(sql, values, (error, result) => error ? reject(error) : resolve(result))
  })

const eachRow = <T>(database: Database, sql: string, values: SqlValue[], visit: (row: T) => void): Promise<number> =>
  new Promise((resolve, reject) => {
    let visitError: unknown
    database.each<T>(sql, values, (error, row) => {
      if (error) visitError = error
      else if (!visitError) {
        try {
          visit(row)
        } catch (error) {
          visitError = error
        }
      }
    }, (error, count) => {
      if (error) reject(error)
      else if (visitError) reject(visitError)
      else resolve(count)
    })
  })

const exec = (database: Database, sql: string): Promise<void> =>
  new Promise((resolve, reject) => database.exec(sql, (error) => error ? reject(error) : resolve()))

const closeDatabase = (database: Database): Promise<void> =>
  new Promise((resolve, reject) => database.close((error) => error ? reject(error) : resolve()))

const openDatabase = (filename: string): Promise<Database> =>
  new Promise((resolve, reject) => {
    const database: Database = new sqlite3.Database(filename, (error) => error ? reject(error) : resolve(database))
  })

const DEFAULT_EXCLUDES = [
  "**/.git/**", "**/node_modules/**", "**/vendor/**", "**/dist/**", "**/build/**",
  "**/out/**", "**/coverage/**", "**/.next/**", "**/target/**", "**/.venv/**",
  "**/venv/**", "**/.vscode-test/**", "**/.cache/**", "**/.turbo/**", "**/.parcel-cache/**",
  "**/*.min.js", "**/*.map", "**/*.lockb", "**/.env", "**/.env.*",
  "**/*.pem", "**/*.key", "**/*credentials*", "**/*secret*"
]
const SCHEMA = `
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS documents (
  uri TEXT PRIMARY KEY, workspace_uri TEXT NOT NULL, relative_path TEXT NOT NULL,
  filename TEXT NOT NULL, language_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
  hash_algorithm TEXT NOT NULL, size INTEGER NOT NULL, mtime_ms REAL,
  text TEXT NOT NULL, indexed_at TEXT NOT NULL, skip_reason TEXT, error TEXT,
  symbols_fingerprint TEXT, scan_id TEXT
);
CREATE INDEX IF NOT EXISTS documents_workspace ON documents(workspace_uri);
CREATE INDEX IF NOT EXISTS documents_path ON documents(relative_path);
CREATE TABLE IF NOT EXISTS symbols (
  document_uri TEXT NOT NULL REFERENCES documents(uri) ON DELETE CASCADE,
  name TEXT NOT NULL, kind TEXT NOT NULL, line INTEGER NOT NULL, column_no INTEGER NOT NULL,
  end_line INTEGER NOT NULL, end_column INTEGER NOT NULL, container TEXT,
  PRIMARY KEY(document_uri,name,kind,line,column_no)
);
CREATE INDEX IF NOT EXISTS symbols_name ON symbols(name);
PRAGMA user_version=3;
`

const globRegex = (glob: string): RegExp => {
  let source = "^"
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index]
    if (character === "*" && glob[index + 1] === "*") {
      if (glob[index + 2] === "/") {
        source += "(?:.*/)?"
        index += 2
      } else {
        source += ".*"
        index += 1
      }
    } else if (character === "*") source += "[^/]*"
    else if (character === "?") source += "[^/]"
    else source += character.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  }
  return new RegExp(`${source}$`, "i")
}
const matches = (value: string, filter: string | undefined): boolean => !filter || minimatch(value, filter, { dot: true, nocase: true })
const pathFilterMatches = (value: string, filter: string | undefined): boolean => {
  const wanted = filter?.trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/\/+$/, "") ?? ""
  if (!wanted) return true
  if (/[*?[\]{}]/.test(wanted)) return minimatch(value, wanted, { dot: true, nocase: true, matchBase: !wanted.includes("/") })
  const lowerValue = value.toLowerCase()
  const lowerWanted = wanted.toLowerCase()
  return lowerValue === lowerWanted || lowerValue.startsWith(`${lowerWanted}/`)
}
const NON_SOURCE_PATH = /(^|\/)(tests?|__tests__|docs?)\/|\.(test|spec)\.|\.md$/i
const contentRank = (query: string, relativePath: string, text: string, offset: number): { offset: number; rank: number } => {
  let rank = 0
  let position = offset
  if (/^[A-Za-z_$][\w$]*$/.test(query)) {
    const name = query.replace(/\$/g, "\\$")
    const definition = new RegExp(`\\b(?:function|class|interface|type|enum|const|let|var|def|fn)\\s+${name}\\b|\\b${name}\\s*[:=]\\s*(?:async\\s+)?(?:function\\b|\\(|\\[)`).exec(text)
    const registration = definition ? null : new RegExp(`\\bname\\s*:\\s*["'\`]${name}["'\`]`).exec(text)
    if (definition) {
      position = definition.index
      rank = 2
    } else if (registration) {
      position = registration.index
      rank = 1
    }
  }
  return { offset: position, rank: rank * 2 + (NON_SOURCE_PATH.test(relativePath) ? 0 : 1) }
}
interface GitIgnoreRule {
  basePath: string
  pattern: string
  negate: boolean
  directory: boolean
}

const isGitIgnored = (relativePath: string, rules: GitIgnoreRule[]): boolean => {
  let ignored = false
  for (const rule of rules) {
    const relativeToRule = path.posix.relative(rule.basePath, relativePath)
    if (relativeToRule.startsWith("../") || relativeToRule === "..") continue
    const pattern = rule.pattern.replace(/^\//, "")
    const matcher = globRegex(pattern)
    const segments = relativeToRule.split("/")
    const matchesRule = pattern.includes("/")
      ? matcher.test(relativeToRule) || (rule.directory && relativeToRule.startsWith(pattern + "/"))
      : segments.some((segment) => matcher.test(segment))
    if (matchesRule) ignored = !rule.negate
  }
  return ignored
}

const vscodeExcludePatterns = (): string[] => {
  const files = vscode.workspace.getConfiguration("files").get<Record<string, boolean>>("exclude", {})
  const search = vscode.workspace.getConfiguration("search").get<Record<string, boolean>>("exclude", {})
  return [...Object.entries(files), ...Object.entries(search)].filter(([, enabled]) => enabled).map(([pattern]) => pattern)
}

const lineColumn = (text: string, offset: number) => {
  const preceding = text.slice(0, offset)
  const newline = preceding.lastIndexOf("\n")
  return { line: preceding.split("\n").length, column: offset - newline }
}

export class WorkspaceIntelligenceIndex implements vscode.Disposable {
  private database?: Database
  private reader?: Database
  private initializing?: Promise<void>
  private scanning?: Promise<void>
  private scanController?: AbortController
  private synchronizing?: Promise<void>
  private activeOperationId?: string
  private repeatAfterCurrent = false
  private clearAfterCurrent = false
  private paused = false
  private disposed = false
  private readonly dirtyUris = new Set<string>()
  private readonly ignoredRules = new Map<string, GitIgnoreRule[]>()
  private readonly pendingUris = new Map<string, vscode.Uri>()
  private readonly pendingDeletes = new Set<string>()
  private readonly fileWatchers: vscode.FileSystemWatcher[] = []
  private deletionTimer?: ReturnType<typeof setTimeout>
  private deletionController?: AbortController
  private readonly watcherListeners: vscode.Disposable[] = []
  private deletionWorker?: Promise<void>
  private updateTimer?: ReturnType<typeof setTimeout>
  private writer: Promise<void> = Promise.resolve()
  private updateWorker?: Promise<void>
  private updateController?: AbortController
  private activeSourceBytes = 0
  private symbolProviderCalls = 0
  private readonly listeners: vscode.Disposable[] = []
  private readonly emitter = new vscode.EventEmitter<WorkspaceIndexState>()
  readonly onDidChange = this.emitter.event
  private state: WorkspaceIndexState = {
    status: "not-initialized", filesDiscovered: 0, filesIndexed: 0,
    symbolsIndexed: 0, filesPending: 0, filesSkipped: 0, filesFailed: 0,
    storageBytes: 0, sqliteCacheLimitBytes: 16 * 1024 * 1024,
    activeSourceBytes: 0, peakSourceBytes: 0, activeWorkers: 0, queueDepth: 0,
    symbolProviderCalls: 0, discoveryComplete: false, fts5: false
  }

  constructor(private readonly storageUri: vscode.Uri) {
    this.listeners.push(
      vscode.workspace.onDidSaveTextDocument((document) => {
        this.dirtyUris.delete(document.uri.toString())
        this.handleFileChange(document.uri)
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (this.isEligibleUri(event.document.uri)) this.dirtyUris.add(event.document.uri.toString())
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        this.dirtyUris.delete(document.uri.toString())
        if (this.automaticSyncEnabled()) this.scheduleUris([document.uri])
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.resetFileWatchers()
        if (this.automaticSyncEnabled()) void this.synchronize(false, true)
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        const watcherConfigurationChanged = event.affectsConfiguration("twinny.indexing.enabled") ||
          event.affectsConfiguration("twinny.indexing.auto") || event.affectsConfiguration("twinny.indexing.include")
        if (watcherConfigurationChanged) this.resetFileWatchers()
        const config = vscode.workspace.getConfiguration("twinny")
        const enabled = config.get<boolean>("indexing.enabled", true)
        const automatic = config.get<boolean>("indexing.auto", true)
        if (!enabled || !automatic) {
          this.cancelQueuedWork(!enabled ? "disabled" : "paused")
          return
        }
        if (watcherConfigurationChanged || event.affectsConfiguration("twinny.contentHash.algorithm") ||
          event.affectsConfiguration("twinny.indexing.exclude") || event.affectsConfiguration("twinny.indexing.maxFileSize") ||
          event.affectsConfiguration("files.exclude") || event.affectsConfiguration("search.exclude")) {
          void this.synchronize(false, true)
        }
      })
    )
    this.resetFileWatchers()
  }

  get snapshot(): WorkspaceIndexState {
    return { ...this.state }
  }

  async start(): Promise<void> {
    if (!vscode.workspace.getConfiguration("twinny").get<boolean>("indexing.enabled", true)) {
      this.update({ status: "disabled" })
      return
    }
    await this.initialize()
    if (vscode.workspace.getConfiguration("twinny").get<boolean>("indexing.auto", true)) void this.synchronize()
    else this.update({ status: this.state.lastSynchronized ? "paused" : "not-initialized" })
  }

  async pause(): Promise<void> {
    this.paused = true
    this.cancelQueuedWork("paused")
  }

  async resume(): Promise<void> {
    this.paused = false
    if (this.synchronizing) {
      this.repeatAfterCurrent = true
      this.update({ status: "indexing" })
      return
    }
    void this.synchronize()
  }

  async rebuild(): Promise<void> {
    if (this.disposed || !vscode.workspace.getConfiguration("twinny").get<boolean>("indexing.enabled", true)) {
      this.update({ status: "disabled" })
      return
    }
    await this.synchronize(true)
  }

  async clearAndRebuild(): Promise<void> {
    await this.rebuild()
  }

  private synchronize(clear = false, repeatAfterCurrent = false): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.synchronizing) {
      logger.info(`[WorkspaceIndex] operation=${this.activeOperationId ?? "unknown"} coalesced request clear=${clear} followup=${repeatAfterCurrent}`)
      if (clear) {
        this.clearAfterCurrent = true
        this.scanController?.abort()
      } else if (repeatAfterCurrent) this.repeatAfterCurrent = true
      return this.synchronizing
    }
    const operationId = randomUUID()
    const operationStartedAt = Date.now()
    this.activeOperationId = operationId
    logger.info(`[WorkspaceIndex] operation=${operationId} start clear=${clear} active_operations=1 inference_requests=0`)
    const operation = (async () => {
      let clearNext = clear
      let pass = 0
      do {
        pass += 1
        this.repeatAfterCurrent = false
        this.clearAfterCurrent = false
        const controller = new AbortController()
        this.scanController = controller
        const scanId = randomUUID()
        logger.info(`[WorkspaceIndex] operation=${operationId} scan=${scanId} pass=${pass} start`)
        const scan = this.scan(clearNext, controller.signal, operationId, scanId)
        this.scanning = scan
        try {
          await scan
          logger.info(`[WorkspaceIndex] operation=${operationId} scan=${scanId} terminal=${controller.signal.aborted ? "cancelled" : this.state.status} duration_ms=${Date.now() - operationStartedAt}`)
        } finally {
          if (this.scanning === scan) this.scanning = undefined
          if (this.scanController === controller) this.scanController = undefined
        }
        clearNext = this.clearAfterCurrent
      } while (!this.disposed && (clearNext || (!this.paused && this.automaticSyncEnabled() && this.repeatAfterCurrent)))
    })().finally(() => {
      if (this.synchronizing === operation) this.synchronizing = undefined
      if (this.activeOperationId === operationId) this.activeOperationId = undefined
      logger.info(`[WorkspaceIndex] operation=${operationId} terminal=${this.disposed ? "disposed" : this.state.status} duration_ms=${Date.now() - operationStartedAt} active_operations=0 inference_requests=0`)
    })
    this.synchronizing = operation
    return operation
  }

  private cancelQueuedWork(status: "disabled" | "paused"): void {
    this.scanController?.abort()
    this.updateController?.abort()
    this.deletionController?.abort()
    if (this.deletionTimer) clearTimeout(this.deletionTimer)
    this.deletionTimer = undefined
    this.pendingDeletes.clear()
    this.repeatAfterCurrent = false
    this.clearAfterCurrent = false
    if (this.updateTimer) clearTimeout(this.updateTimer)
    this.updateTimer = undefined
    this.pendingUris.clear()
    this.update({ status, filesPending: 0, queueDepth: 0 })
    logger.info(`Workspace indexing ${status}; queued file work cancelled`)
  }

  private automaticSyncEnabled(): boolean {
    const config = vscode.workspace.getConfiguration("twinny")
    return !this.disposed && !this.paused && config.get<boolean>("indexing.enabled", true) && config.get<boolean>("indexing.auto", true)
  }

  private resetFileWatchers(): void {
    for (const subscription of this.watcherListeners) subscription.dispose()
    this.watcherListeners.length = 0
    for (const watcher of this.fileWatchers) watcher.dispose()
    this.fileWatchers.length = 0
    const config = vscode.workspace.getConfiguration("twinny")
    if (this.disposed || !config.get<boolean>("indexing.enabled", true) || !config.get<boolean>("indexing.auto", true)) return
    const patterns = new Set([...config.get<string[]>("indexing.include", ["**/*"]), "**/.gitignore"])
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      for (const pattern of patterns) {
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, pattern))
        this.fileWatchers.push(watcher)
        this.watcherListeners.push(
          watcher.onDidCreate((uri) => this.handleFileChange(uri)),
          watcher.onDidChange((uri) => this.handleFileChange(uri)),
          watcher.onDidDelete((uri) => this.handleFileDelete(uri))
        )
      }
    }
  }

  private handleFileChange(uri: vscode.Uri): void {
    if (!this.automaticSyncEnabled()) return
    if (uri.path.endsWith("/.gitignore")) {
      void this.synchronize(false, true)
      return
    }
    void vscode.workspace.fs.stat(uri).then((stat) => {
      if (!this.automaticSyncEnabled()) return
      if (stat.type & vscode.FileType.Directory) void this.synchronize(false, true)
      else this.scheduleUris([uri])
    }, (error) => {
      const message = error instanceof Error ? error.message : String(error)
      if (/FileNotFound|ENOENT/i.test(message)) logger.debug(`Workspace file changed then disappeared: ${uri.toString()}`)
      else this.reportError(`Could not stat changed workspace file ${uri.toString()}`, error)
    })
  }

  private handleFileDelete(uri: vscode.Uri): void {
    if (!this.automaticSyncEnabled()) return
    if (uri.path.endsWith("/.gitignore")) void this.synchronize(false, true)
    else void this.deleteUris([uri.toString()]).catch((error) => this.reportError("Workspace index deletion failed", error))
  }

  private scheduleUris(uris: readonly vscode.Uri[]): void {
    if (!this.automaticSyncEnabled()) return
    let added = 0
    for (const uri of uris) {
      if (!this.isEligibleUri(uri)) continue
      const key = uri.toString()
      if (this.pendingUris.has(key)) continue
      this.pendingUris.set(key, uri)
      added += 1
    }
    if (!added) return
    this.update({ queueDepth: this.pendingUris.size, filesPending: this.pendingUris.size })
    if (this.pendingUris.size === added || this.pendingUris.size % 100 === 0) logger.debug(`Workspace index change queue: ${this.pendingUris.size} unique files`)
    if (this.updateTimer) clearTimeout(this.updateTimer)
    this.updateTimer = setTimeout(() => {
      this.updateTimer = undefined
      void this.flushPendingUris()
    }, 250)
  }

  private async flushPendingUris(): Promise<void> {
    if (this.updateWorker || !this.automaticSyncEnabled() || !this.pendingUris.size) return
    const worker = (async () => {
      await this.synchronizing?.catch(() => undefined)
      await this.initialize()
      const controller = new AbortController()
      this.updateController = controller
      const startedAt = Date.now()
      let processed = 0
      try {
        while (this.pendingUris.size && this.automaticSyncEnabled() && !controller.signal.aborted) {
          const first = this.pendingUris.entries().next().value as [string, vscode.Uri] | undefined
          if (!first) break
          const [key, uri] = first
          this.pendingUris.delete(key)
          this.update({ status: "indexing", discoveryComplete: false, queueDepth: this.pendingUris.size, filesPending: this.pendingUris.size, activeWorkers: 1 })
          const algorithm = vscode.workspace.getConfiguration("twinny").get<ContentHashAlgorithm>("contentHash.algorithm", "xxh64")
          await this.indexFile(uri, algorithm, controller.signal)
          processed += 1
          this.update({ activeWorkers: 0, queueDepth: this.pendingUris.size, filesPending: this.pendingUris.size })
        }
        if (processed && !controller.signal.aborted) {
          const synchronizedAt = new Date().toISOString()
          await this.withWrite(async () => {
            await run(this.database!, "INSERT OR REPLACE INTO index_meta(key,value) VALUES('last_synchronized',?)", [synchronizedAt])
            await run(this.database!, "PRAGMA wal_checkpoint(PASSIVE)")
          })
          await this.refreshCounts()
          const duration = Date.now() - startedAt
          this.update({ status: "ready", discoveryComplete: true, lastSynchronized: synchronizedAt, lastIndexDurationMs: duration, storageBytes: await this.measureDatabaseSize() })
          logger.info(`Workspace incremental sync completed: ${processed} coalesced file updates in ${duration}ms`)
        }
      } catch (error) {
        if (!controller.signal.aborted) this.reportError("Workspace incremental synchronization failed", error)
      } finally {
        if (this.updateController === controller) this.updateController = undefined
        this.update({ activeWorkers: 0, activeSourceBytes: 0, queueDepth: this.pendingUris.size, filesPending: this.pendingUris.size })
      }
    })()
    this.updateWorker = worker
    try {
      await worker
    } finally {
      if (this.updateWorker === worker) this.updateWorker = undefined
      if (this.pendingUris.size && this.automaticSyncEnabled()) void this.flushPendingUris()
    }
  }

  private async deleteUris(uris: string[]): Promise<void> {
    for (const uri of uris) this.pendingDeletes.add(uri)
    if (!this.pendingDeletes.size) return
    this.update({ queueDepth: this.pendingUris.size + this.pendingDeletes.size, filesPending: this.pendingUris.size + this.pendingDeletes.size })
    if (this.deletionTimer) clearTimeout(this.deletionTimer)
    this.deletionTimer = setTimeout(() => {
      this.deletionTimer = undefined
      void this.flushPendingDeletes().catch((error) => this.reportError("Workspace index deletion failed", error))
    }, 250)
  }

  private async flushPendingDeletes(): Promise<void> {
    if (this.deletionWorker || !this.pendingDeletes.size || !this.automaticSyncEnabled()) return
    const worker = (async () => {
      await this.synchronizing?.catch(() => undefined)
      await this.updateWorker?.catch(() => undefined)
      if (!this.automaticSyncEnabled() || !this.pendingDeletes.size) return
      await this.initialize()
      const controller = new AbortController()
      this.deletionController = controller
      let removed = 0
      try {
        while (this.pendingDeletes.size && this.automaticSyncEnabled() && !controller.signal.aborted) {
          const batch = [...this.pendingDeletes].slice(0, 64)
          let batchRemoved = 0
          await this.withWrite(async () => {
            await exec(this.database!, "BEGIN IMMEDIATE")
            try {
              for (const uri of batch) {
                this.throwIfSignalAborted(controller.signal)
                if (await this.removeDocument(uri)) batchRemoved += 1
              }
              await exec(this.database!, "COMMIT")
            } catch (error) {
              await exec(this.database!, "ROLLBACK")
              throw error
            }
          })
          for (const uri of batch) this.pendingDeletes.delete(uri)
          removed += batchRemoved
        }
        if (removed && !controller.signal.aborted) {
          const synchronizedAt = new Date().toISOString()
          await this.withWrite(async () => {
            await run(this.database!, "INSERT OR REPLACE INTO index_meta(key,value) VALUES('last_synchronized',?)", [synchronizedAt])
            await run(this.database!, "PRAGMA wal_checkpoint(PASSIVE)")
          })
          await this.refreshCounts()
          this.update({ status: "ready", lastSynchronized: synchronizedAt, storageBytes: await this.measureDatabaseSize() })
        }
      } finally {
        if (this.deletionController === controller) this.deletionController = undefined
      }
    })()
    this.deletionWorker = worker
    try {
      await worker
    } finally {
      if (this.deletionWorker === worker) this.deletionWorker = undefined
      this.update({ queueDepth: this.pendingUris.size + this.pendingDeletes.size, filesPending: this.pendingUris.size + this.pendingDeletes.size })
      if (this.pendingDeletes.size && this.automaticSyncEnabled()) void this.flushPendingDeletes().catch((error) => this.reportError("Workspace index deletion failed", error))
    }
  }

  async search(request: WorkspaceSearchRequest, scope?: string, signal?: AbortSignal): Promise<{ results: WorkspaceSearchHit[]; total: number }> {
    if (this.disposed) throw new Error("Workspace index has been disposed.")
    if (!vscode.workspace.getConfiguration("twinny").get<boolean>("indexing.enabled", true)) throw new Error("Workspace indexing is disabled in Twinny settings.")
    await this.initialize()
    const query = request.query.trim()
    if (!query) return { results: [], total: 0 }
    this.throwIfSignalAborted(signal)
    const mode = request.mode ?? "auto"
    const database = this.reader!
    const all = await rows<DocRow>(database, "SELECT uri,workspace_uri,relative_path,filename,language_id,fingerprint,hash_algorithm,size,mtime_ms,'' AS text,indexed_at,skip_reason,error FROM documents WHERE skip_reason IS NULL AND error IS NULL")
    const config = vscode.workspace.getConfiguration("twinny")
    const include = config.get<string[]>("indexing.include", ["**/*"])
    const exclude = [...DEFAULT_EXCLUDES, ...config.get<string[]>("indexing.exclude", []), ...vscodeExcludePatterns()]
    const documents = all.filter((doc) => {
      const uri = vscode.Uri.parse(doc.uri)
      const folder = this.folderFor(uri)
      const localPath = folder ? path.posix.relative(folder.uri.path, uri.path) : doc.relative_path
      const selectedScope = request.scope ?? scope
      const scoped = !selectedScope || folder?.uri.toString() === selectedScope || doc.workspace_uri === selectedScope || folder?.uri.fsPath === selectedScope
      const included = include.some((pattern) => matches(localPath, pattern) || matches(doc.relative_path, pattern))
      const excluded = exclude.some((pattern) => matches(localPath, pattern) || matches(doc.relative_path, pattern))
      return scoped && included && !excluded && (pathFilterMatches(localPath, request.path) || pathFilterMatches(doc.relative_path, request.path))
    })
    const documentsByUri = new Map(documents.map((doc) => [doc.uri, doc]))
    const offset = Math.max(0, Math.floor(request.offset ?? 0))
    const limit = Math.max(1, Math.min(100, Math.floor(request.limit ?? 20)))
    const hits: WorkspaceSearchHit[] = []
    let total = 0
    const add = (hit: WorkspaceSearchHit) => {
      total += 1
      if (total > offset && total <= offset + limit) hits.push(hit)
    }
    const pathMatches = (doc: DocRow) => query.includes("*") || query.includes("?")
      ? globRegex(query).test(doc.relative_path)
      : doc.relative_path.toLowerCase().includes(query.toLowerCase()) || doc.filename.toLowerCase().includes(query.toLowerCase())
    if (mode === "path" || mode === "auto") {
      for (const doc of documents) if (pathMatches(doc)) add({ uri: doc.uri, path: doc.relative_path, category: "path", preview: doc.relative_path, source: "index" })
    }
    if (mode === "symbol" || mode === "auto") {
      const searchedLive = new Set<string>()
      const cached = await rows<SymbolRow>(database, "SELECT d.uri AS uri,s.name,s.kind,s.line,s.column_no,s.end_line,s.end_column,s.container,d.relative_path AS path FROM symbols s JOIN documents d ON d.uri=s.document_uri WHERE d.skip_reason IS NULL AND d.error IS NULL AND d.symbols_fingerprint=d.fingerprint AND instr(lower(s.name),lower(?))>0", [query])
      for (const symbol of cached) {
        if (!documentsByUri.has(symbol.uri) || this.dirtyUris.has(symbol.uri)) continue
        add({ uri: symbol.uri, path: symbol.path, line: symbol.line + 1, column: symbol.column_no + 1, category: "symbol", symbol: symbol.name, kind: symbol.kind, preview: `${symbol.kind} ${symbol.name}${symbol.container ? ` (${symbol.container})` : ""}`, source: "index" })
      }
      if (mode === "symbol") {
        const candidates = await rows<{ uri: string; fingerprint: string }>(database, "SELECT uri,fingerprint FROM documents WHERE skip_reason IS NULL AND error IS NULL AND instr(lower(text),lower(?))>0 AND (symbols_fingerprint IS NULL OR symbols_fingerprint<>fingerprint)", [query])
        for (const candidate of candidates) {
          this.throwIfSignalAborted(signal)
          const doc = documentsByUri.get(candidate.uri)
          if (!doc) continue
          const startedAt = Date.now()
          const openDocument = vscode.workspace.textDocuments.find((item) => item.uri.toString() === candidate.uri)
          const symbols = await this.collectSymbols(vscode.Uri.parse(candidate.uri), signal)
          const source = openDocument?.isDirty || this.dirtyUris.has(candidate.uri) ? "live" : "index"
          if (source === "live") searchedLive.add(candidate.uri)
          for (const symbol of symbols) {
            if (!symbol.name.toLowerCase().includes(query.toLowerCase())) continue
            add({ uri: candidate.uri, path: doc.relative_path, line: symbol.range.start.line + 1, column: symbol.range.start.character + 1, category: "symbol", symbol: symbol.name, kind: symbol.kind, preview: `${symbol.kind} ${symbol.name}${symbol.container ? ` (${symbol.container})` : ""}`, source })
          }
          if (source === "index") await this.cacheSymbols(candidate.uri, candidate.fingerprint, symbols)
          const elapsed = Date.now() - startedAt
          if (elapsed >= 1000) logger.info(`Workspace symbol lookup took ${elapsed}ms for ${doc.relative_path}`)
        }
      }
      for (const document of vscode.workspace.textDocuments) {
        const uri = document.uri.toString()
        const indexed = documentsByUri.get(uri)
        if (!indexed || !document.isDirty || !this.dirtyUris.has(uri) || mode !== "symbol" || searchedLive.has(uri)) continue
        if (!document.getText().toLowerCase().includes(query.toLowerCase())) continue
        for (const symbol of await this.collectSymbols(document.uri, signal)) {
          if (!symbol.name.toLowerCase().includes(query.toLowerCase())) continue
          add({ uri, path: indexed.relative_path, line: symbol.range.start.line + 1, column: symbol.range.start.character + 1, category: "symbol", symbol: symbol.name, kind: symbol.kind, preview: `${symbol.kind} ${symbol.name}${symbol.container ? ` (${symbol.container})` : ""}`, source: "live" })
        }
      }
    }
    const contentHits: Array<{ rank: number; hit: WorkspaceSearchHit }> = []
    if (mode === "literal" || mode === "regex" || mode === "auto") {
      let regex: RegExp | undefined
      if (mode === "regex") regex = new RegExp(query, "g")
      const firstTerm = query.split(/\s+/).find(Boolean) ?? query
      const sql = mode === "regex"
        ? "SELECT uri,text FROM documents WHERE skip_reason IS NULL AND error IS NULL"
        : mode === "literal"
          ? "SELECT uri,text FROM documents WHERE skip_reason IS NULL AND error IS NULL AND instr(text,?)>0"
          : this.state.fts5
            ? "SELECT uri,text FROM documents WHERE skip_reason IS NULL AND error IS NULL AND (instr(lower(text),lower(?))>0 OR uri IN (SELECT uri FROM documents_fts WHERE documents_fts MATCH ?))"
            : "SELECT uri,text FROM documents WHERE skip_reason IS NULL AND error IS NULL AND instr(lower(text),lower(?))>0"
      const terms = query.split(/\s+/).filter(Boolean).map((term) => `"${term.replace(/"/g, "\"\"")}"`).join(" AND ")
      const values: SqlValue[] = mode === "literal" ? [query] : mode === "regex" ? [] : this.state.fts5 ? [firstTerm, terms] : [firstTerm]
      const visitContent = (row: { uri: string; text: string }) => {
        if (signal?.aborted || this.dirtyUris.has(row.uri)) return
        const doc = documentsByUri.get(row.uri)
        if (!doc) return
        if (regex) regex.lastIndex = 0
        let offset = regex ? regex.exec(row.text)?.index ?? -1 : row.text.indexOf(query)
        if (offset < 0 && mode === "auto") offset = row.text.toLowerCase().indexOf(firstTerm.toLowerCase())
        if (offset < 0) return
        const ranked = contentRank(query, doc.relative_path, row.text, offset)
        offset = ranked.offset
        const position = lineColumn(row.text, offset)
        const lineStart = row.text.lastIndexOf("\n", offset - 1) + 1
        const lineEnd = row.text.indexOf("\n", offset)
        const preview = row.text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd).trim().slice(0, 240)
        contentHits.push({ rank: ranked.rank, hit: { uri: row.uri, path: doc.relative_path, line: position.line, column: position.column, category: "content", preview, source: "index" } })
      }
      try {
        await eachRow<{ uri: string; text: string }>(database, sql, values, visitContent)
      } catch (error) {
        if (mode !== "auto" || !this.state.fts5) throw error
        logger.debug(`Workspace FTS query fell back to literal matching: ${error instanceof Error ? error.message : String(error)}`)
        await eachRow<{ uri: string; text: string }>(database, "SELECT uri,text FROM documents WHERE skip_reason IS NULL AND error IS NULL AND instr(lower(text),lower(?))>0", [firstTerm], visitContent)
      }
      for (const document of vscode.workspace.textDocuments) {
        const uri = document.uri.toString()
        const indexed = documentsByUri.get(uri)
        if (!indexed || !document.isDirty || !this.dirtyUris.has(uri)) continue
        const text = document.getText()
        if (regex) regex.lastIndex = 0
        let offset = regex ? regex.exec(text)?.index ?? -1 : text.indexOf(query)
        if (offset < 0 && mode === "auto") offset = text.toLowerCase().indexOf(firstTerm.toLowerCase())
        if (offset < 0) continue
        const ranked = contentRank(query, indexed.relative_path, text, offset)
        offset = ranked.offset
        const position = lineColumn(text, offset)
        const lineStart = text.lastIndexOf("\n", offset - 1) + 1
        const lineEnd = text.indexOf("\n", offset)
        const preview = text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd).trim().slice(0, 240)
        contentHits.push({ rank: ranked.rank, hit: { uri, path: indexed.relative_path, line: position.line, column: position.column, category: "content", preview, source: "live" } })
      }
      contentHits
        .sort((a, b) => b.rank - a.rank || a.hit.path.localeCompare(b.hit.path) || (a.hit.line ?? 0) - (b.hit.line ?? 0))
        .forEach(({ hit }) => add(hit))
    }
    this.throwIfSignalAborted(signal)
    return { results: hits, total }
  }

  async openHit(hit: WorkspaceSearchHit): Promise<void> {
    if (!hit.uri) throw new Error("This workspace search result has no source URI")
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(hit.uri))
    const editor = await vscode.window.showTextDocument(document)
    if (hit.line === undefined) return
    const line = Math.max(0, Math.min(document.lineCount - 1, hit.line - 1))
    const character = Math.max(0, Math.min(document.lineAt(line).text.length, (hit.column ?? 1) - 1))
    const position = new vscode.Position(line, character)
    editor.selection = new vscode.Selection(position, position)
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.scanController?.abort()
    this.updateController?.abort()
    this.deletionController?.abort()
    if (this.deletionTimer) clearTimeout(this.deletionTimer)
    this.deletionTimer = undefined
    this.pendingDeletes.clear()
    if (this.updateTimer) clearTimeout(this.updateTimer)
    this.updateTimer = undefined
    this.pendingUris.clear()
    for (const listener of this.listeners) listener.dispose()
    this.resetFileWatchers()
    this.emitter.dispose()
    void Promise.allSettled([this.synchronizing, this.updateWorker, this.deletionWorker, this.writer, this.initializing].filter((value): value is Promise<void> => !!value))
      .then(async () => {
        const reader = this.reader
        const database = this.database
        this.reader = undefined
        this.database = undefined
        if (reader) await closeDatabase(reader)
        if (database) await closeDatabase(database)
      })
      .catch((error) => logger.error(`Workspace index database close failed: ${error instanceof Error ? error.message : String(error)}`))
  }
  private get databasePath(): string {
    return path.join(this.storageUri.fsPath, "workspace-index.sqlite")
  }

  private async initialize(): Promise<void> {
    if (this.database && this.reader) return
    if (!this.initializing) this.initializing = this.open().catch(async (error) => {
      this.initializing = undefined
      const reader = this.reader
      const database = this.database
      this.reader = undefined
      this.database = undefined
      if (reader) await closeDatabase(reader).catch((closeError) => logger.error("Workspace index reader close failed: " + String(closeError)))
      if (database) await closeDatabase(database).catch((closeError) => logger.error("Workspace index database close failed: " + String(closeError)))
      this.reportError("Workspace index initialization failed", error)
      throw error
    })
    await this.initializing
    if (!this.database || !this.reader) throw new Error("Workspace index database did not finish initializing.")
  }

  private reportError(context: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    logger.error(`${context}: ${message}`)
    this.update({ status: "error", error: message })
  }

  private async open(): Promise<void> {
    await fs.mkdir(this.storageUri.fsPath, { recursive: true })
    const database = await openDatabase(this.databasePath)
    if (this.disposed) {
      await closeDatabase(database)
      return
    }
    database.configure("busyTimeout", 5000)
    await exec(database, "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-8192; PRAGMA mmap_size=0; PRAGMA temp_store=FILE; PRAGMA foreign_keys=ON;")
    const version = (await get<{ user_version: number }>(database, "PRAGMA user_version"))?.user_version ?? 0
    if (version > 3) {
      await closeDatabase(database)
      throw new Error(`Workspace index database version ${version} is newer than this Twinny version`)
    }
    await exec(database, SCHEMA)
    const columns = await rows<{ name: string }>(database, "PRAGMA table_info(documents)")
    if (!columns.some((column) => column.name === "symbols_fingerprint")) {
      await run(database, "ALTER TABLE documents ADD COLUMN symbols_fingerprint TEXT")
    }
    if (!columns.some((column) => column.name === "scan_id")) {
      await run(database, "ALTER TABLE documents ADD COLUMN scan_id TEXT")
    }
    try {
      await exec(database, "CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(uri UNINDEXED, relative_path, text)")
      this.state.fts5 = true
    } catch (error) {
      logger.warn(`Workspace index FTS5 unavailable; using literal text search: ${error instanceof Error ? error.message : String(error)}`)
      this.state.fts5 = false
    }
    this.database = database
    const algorithm = vscode.workspace.getConfiguration("twinny").get<ContentHashAlgorithm>("contentHash.algorithm", "xxh64")
    const stored = (await get<{ value: string }>(database, "SELECT value FROM index_meta WHERE key='hash_algorithm'"))?.value
    if (stored && stored !== algorithm) await this.migrateFingerprints(database, algorithm)
    await run(database, "INSERT OR REPLACE INTO index_meta(key,value) VALUES('hash_algorithm',?)", [algorithm])
    const lastSynchronized = (await get<{ value: string }>(database, "SELECT value FROM index_meta WHERE key='last_synchronized'"))?.value
    const indexingConfiguration = JSON.stringify({
      include: vscode.workspace.getConfiguration("twinny").get<string[]>("indexing.include", ["**/*"]),
      exclude: [...DEFAULT_EXCLUDES, ...vscode.workspace.getConfiguration("twinny").get<string[]>("indexing.exclude", []), ...vscodeExcludePatterns()],
      maxFileSize: vscode.workspace.getConfiguration("twinny").get<number>("indexing.maxFileSize", 1048576)
    })
    const previousConfiguration = (await get<{ value: string }>(database, "SELECT value FROM index_meta WHERE key='indexing_configuration'"))?.value
    if (this.disposed) return
    const reader = await openDatabase(this.databasePath)
    if (this.disposed) {
      await closeDatabase(reader)
      return
    }
    reader.configure("busyTimeout", 5000)
    await exec(reader, "PRAGMA cache_size=-8192; PRAGMA mmap_size=0; PRAGMA query_only=ON;")
    this.reader = reader
    const stats = await get<{ indexed: number; symbols: number; skipped: number; failed: number }>(reader, "SELECT SUM(skip_reason IS NULL AND error IS NULL) AS indexed, (SELECT COUNT(*) FROM symbols) AS symbols, SUM(skip_reason IS NOT NULL) AS skipped, SUM(error IS NOT NULL) AS failed FROM documents")
    const storageBytes = await this.measureDatabaseSize()
    this.update({ status: lastSynchronized && previousConfiguration === indexingConfiguration ? "ready" : "not-initialized", lastSynchronized, filesIndexed: stats?.indexed ?? 0, symbolsIndexed: stats?.symbols ?? 0, filesSkipped: stats?.skipped ?? 0, filesFailed: stats?.failed ?? 0, storageBytes })
  }

  private async migrateFingerprints(database: Database, algorithm: ContentHashAlgorithm): Promise<void> {
    let lastUri = ""
    while (!this.disposed) {
      const doc = await get<{ uri: string; text: string }>(database, "SELECT uri,text FROM documents WHERE uri>? ORDER BY uri LIMIT 1", [lastUri])
      if (!doc) break
      const digest = await fingerprintContent(doc.text, algorithm)
      await run(database, "UPDATE documents SET fingerprint=?,hash_algorithm=?,symbols_fingerprint=NULL WHERE uri=?", [digest, algorithm, doc.uri])
      await run(database, "DELETE FROM symbols WHERE document_uri=?", [doc.uri])
      lastUri = doc.uri
    }
  }

  private async *discoverFiles(
    folder: vscode.WorkspaceFolder,
    include: string[],
    exclude: string[],
    signal: AbortSignal
  ): AsyncGenerator<{ uri: vscode.Uri; ignored: boolean; skipReason?: string }> {
    const directories = [folder.uri]
    while (directories.length && !this.isCancelled(signal)) {
      const directory = directories.pop()!
      const entries = await vscode.workspace.fs.readDirectory(directory)
      this.throwIfCancelled(signal)
      for (const [name, type] of entries) {
        const uri = vscode.Uri.joinPath(directory, name)
        const relative = path.posix.relative(folder.uri.path, uri.path)
        if ((type & vscode.FileType.Directory) && !(type & vscode.FileType.SymbolicLink)) {
          const directoryPath = `${relative}/`
          if (!exclude.some((pattern) => matches(relative, pattern) || matches(directoryPath, pattern))) directories.push(uri)
          continue
        }
        if (!include.some((pattern) => matches(relative, pattern)) || exclude.some((pattern) => matches(relative, pattern))) continue
        if (type & vscode.FileType.SymbolicLink) {
          yield { uri, ignored: false, skipReason: "symbolic link not traversed" }
          continue
        }
        yield { uri, ignored: isGitIgnored(relative, this.ignoredRules.get(folder.uri.toString()) ?? []) }
        this.throwIfCancelled(signal)
      }
    }
    this.throwIfCancelled(signal)
  }

  private async scan(_clear: boolean, signal: AbortSignal, operationId: string, scanId: string): Promise<void> {
    const startedAt = Date.now()
    try {
      await this.initialize()
      this.throwIfCancelled(signal)
      const config = vscode.workspace.getConfiguration("twinny")
      const include = config.get<string[]>("indexing.include", ["**/*"])
      const exclude = [...DEFAULT_EXCLUDES, ...config.get<string[]>("indexing.exclude", []), ...vscodeExcludePatterns()]
      this.symbolProviderCalls = 0
      const scanId = randomUUID()
      this.update({ status: "scanning", error: undefined, filesDiscovered: 0, filesPending: 0, filesSkipped: 0, filesFailed: 0, queueDepth: 0, activeWorkers: 0, activeSourceBytes: 0, peakSourceBytes: 0, currentIndexDurationMs: 0, symbolProviderCalls: 0, discoveryComplete: false })
      const folders = vscode.workspace.workspaceFolders ?? []
      const excludeGlob = `{${exclude.join(",")}}`
      const pendingRules = new Map<string, GitIgnoreRule[]>()
      for (const folder of folders) {
        this.throwIfCancelled(signal)
        const ignoreUris = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, "**/.gitignore"), new vscode.RelativePattern(folder, excludeGlob))
        const rules: GitIgnoreRule[] = []
        for (const ignoreUri of ignoreUris) {
          this.throwIfCancelled(signal)
          const text = new TextDecoder("utf-8").decode(await vscode.workspace.fs.readFile(ignoreUri))
          const basePath = path.posix.relative(folder.uri.path, path.posix.dirname(ignoreUri.path))
          for (const rawLine of text.split(/\r?\n/)) {
            const line = rawLine.trim()
            if (!line || line.startsWith("#")) continue
            const negate = line.startsWith("!")
            const patternText = line.replace(/^!/, "").replace(/\\([#!])/g, "$1")
            rules.push({ basePath, pattern: patternText.replace(/\/$/, ""), negate, directory: patternText.endsWith("/") })
          }
        }
        pendingRules.set(folder.uri.toString(), rules)
      }
      for (const [folderUri, rules] of pendingRules) this.ignoredRules.set(folderUri, rules)
      const currentAlgorithm = config.get<ContentHashAlgorithm>("contentHash.algorithm", "xxh64")
      let discovered = 0
      let completed = 0
      let indexed = 0
      let lastProgressUpdate = 0
      this.update({ status: "indexing", filesIndexed: 0, filesPending: 0, queueDepth: 0 })
      logger.info(`[WorkspaceIndex] operation=${operationId} scan=${scanId} discovered workspace_folders=${folders.length}`)
      const work = (async function* (index: WorkspaceIntelligenceIndex): AsyncGenerator<{ uri: vscode.Uri; folder: vscode.WorkspaceFolder; ignored: boolean; skipReason?: string }> {
        for (const folder of folders) {
          for await (const item of index.discoverFiles(folder, include, exclude, signal)) yield { ...item, folder }
        }
      })(this)
      const workers = Array.from({ length: 2 }, async () => {
        while (!this.isCancelled(signal)) {
          const next = await work.next()
          if (next.done) return
          const { uri, folder, ignored: isIgnored, skipReason } = next.value
          discovered += 1
          if (discovered - lastProgressUpdate >= 16) {
            lastProgressUpdate = discovered
            this.update({ filesDiscovered: discovered })
          }
          this.update({ activeWorkers: this.state.activeWorkers + 1 })
          try {
            if (isIgnored || skipReason) {
              const relative = path.posix.relative(folder.uri.path, uri.path)
              const displayPath = folders.length > 1 ? `${folder.name}/${relative}` : relative
              const stat = await vscode.workspace.fs.stat(uri).then((stat) => stat, () => undefined)
              this.throwIfCancelled(signal)
              await this.storeSkipped(uri, folder.uri.toString(), displayPath, stat?.size ?? 0, skipReason ?? "ignored by .gitignore", signal, scanId)
            } else if (await this.indexFile(uri, currentAlgorithm, signal, scanId)) indexed += 1
          } finally {
            completed += 1
            this.update({ activeWorkers: Math.max(0, this.state.activeWorkers - 1), filesDiscovered: discovered, filesIndexed: indexed, currentIndexDurationMs: Date.now() - startedAt })
          }
        }
      })
      try {
        await Promise.all(workers)
      } catch (error) {
        this.scanController?.abort()
        await Promise.allSettled(workers)
        throw error
      }
      if (this.isCancelled(signal)) {
        logger.info(`[WorkspaceIndex] operation=${operationId} scan=${scanId} cancelled completed_files=${completed} queued_work=stopped`)
        return
      }
      const activeWorkspaceUris = [...(vscode.workspace.workspaceFolders ?? [])].map((folder) => folder.uri.toString())
      await this.withWrite(async () => {
        await exec(this.database!, "BEGIN IMMEDIATE")
        try {
          const stalePredicate = activeWorkspaceUris.length
            ? `(workspace_uri NOT IN (${activeWorkspaceUris.map(() => "?").join(",")}) OR (workspace_uri IN (${activeWorkspaceUris.map(() => "?").join(",")}) AND (scan_id IS NULL OR scan_id<>?)))`
            : "1=1"
          const staleValues: SqlValue[] = activeWorkspaceUris.length ? [...activeWorkspaceUris, ...activeWorkspaceUris, scanId] : []
          if (this.state.fts5) await run(this.database!, `DELETE FROM documents_fts WHERE uri IN (SELECT uri FROM documents WHERE ${stalePredicate})`, staleValues)
          await run(this.database!, `DELETE FROM documents WHERE ${stalePredicate}`, staleValues)
          await exec(this.database!, "COMMIT")
        } catch (error) {
          await exec(this.database!, "ROLLBACK")
          throw error
        }
      })
      const synchronizedAt = new Date().toISOString()
      await this.withWrite(async () => {
        await run(this.database!, "INSERT OR REPLACE INTO index_meta(key,value) VALUES('hash_algorithm',?)", [currentAlgorithm])
        await run(this.database!, "INSERT OR REPLACE INTO index_meta(key,value) VALUES('last_synchronized',?)", [synchronizedAt])
        await run(this.database!, "INSERT OR REPLACE INTO index_meta(key,value) VALUES('indexing_configuration',?)", [JSON.stringify({
          include: config.get<string[]>("indexing.include", ["**/*"]),
          exclude: [...DEFAULT_EXCLUDES, ...config.get<string[]>("indexing.exclude", []), ...vscodeExcludePatterns()],
          maxFileSize: config.get<number>("indexing.maxFileSize", 1048576)
        })])
        await run(this.database!, "PRAGMA wal_checkpoint(PASSIVE)")
      })
      await this.refreshCounts()
      const duration = Date.now() - startedAt
      this.update({ status: this.paused ? "paused" : "ready", filesPending: 0, queueDepth: 0, activeWorkers: 0, activeSourceBytes: 0, currentIndexDurationMs: undefined, lastIndexDurationMs: duration, storageBytes: await this.measureDatabaseSize(), lastSynchronized: synchronizedAt, discoveryComplete: true, filesDiscovered: discovered })
      logger.info(`[WorkspaceIndex] operation=${operationId} scan=${scanId} completed indexed=${indexed} discovered=${discovered} duration_ms=${duration} database_bytes=${this.state.storageBytes} peak_source_bytes=${this.state.peakSourceBytes} inference_requests=0`)
    } catch (error) {
      if (this.isCancelled(signal)) {
        logger.info(`[WorkspaceIndex] operation=${operationId} scan=${scanId} cancelled before completion`)
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      logger.error(`[WorkspaceIndex] operation=${operationId} scan=${scanId} failed: ${message}`)
      this.update({ status: "error", error: message, activeWorkers: 0, activeSourceBytes: 0, currentIndexDurationMs: undefined })
    }
  }

  private async indexFile(uri: vscode.Uri, algorithm: ContentHashAlgorithm, signal: AbortSignal, scanId?: string): Promise<boolean> {
    const folder = this.folderFor(uri)
    if (!folder || this.isCancelled(signal)) return false
    const identity = uri.toString()
    const relative = path.posix.relative(folder.uri.path, uri.path)
    const folders = vscode.workspace.workspaceFolders ?? []
    const displayPath = folders.length > 1 ? `${folder.name}/${relative}` : relative
    try {
      const stat = await vscode.workspace.fs.stat(uri)
      this.throwIfCancelled(signal)
      const maxBytes = vscode.workspace.getConfiguration("twinny").get<number>("indexing.maxFileSize", 1048576)
      if (stat.size > maxBytes) {
        await this.storeSkipped(uri, folder.uri.toString(), displayPath, stat.size, "file exceeds configured size limit", signal)
        return false
      }
      const openDocument = vscode.workspace.textDocuments.find((document) => document.uri.toString() === identity)
      if (openDocument?.isDirty) this.dirtyUris.add(identity)
      const bytes = await vscode.workspace.fs.readFile(uri)
      this.throwIfCancelled(signal)
      this.activeSourceBytes += bytes.byteLength
      this.update({ activeSourceBytes: this.activeSourceBytes, peakSourceBytes: Math.max(this.state.peakSourceBytes, this.activeSourceBytes) })
      try {
        let text: string
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
        } catch {
          await this.storeSkipped(uri, folder.uri.toString(), displayPath, stat.size, "file is not valid UTF-8 text", signal)
          return false
        }
        if (text.includes("\0")) {
          await this.storeSkipped(uri, folder.uri.toString(), displayPath, stat.size, "binary content", signal)
          return false
        }
        const fingerprint = await fingerprintContent(text, algorithm)
        this.throwIfCancelled(signal)
        const previous = await get<{ fingerprint: string; size: number; mtime_ms: number | null }>(this.reader!, "SELECT fingerprint,size,mtime_ms FROM documents WHERE uri=?", [identity])
        if (previous?.fingerprint === fingerprint && previous.size === stat.size && previous.mtime_ms === stat.mtime) {
          if (scanId) await run(this.database!, "UPDATE documents SET scan_id=? WHERE uri=?", [scanId, identity])
          if (!openDocument?.isDirty) this.dirtyUris.delete(identity)
          return true
        }
        const indexedAt = new Date().toISOString()
        await this.withWrite(async () => {
          this.throwIfCancelled(signal)
          await exec(this.database!, "BEGIN IMMEDIATE")
          try {
            await run(this.database!, "INSERT OR REPLACE INTO documents(uri,workspace_uri,relative_path,filename,language_id,fingerprint,hash_algorithm,size,mtime_ms,text,indexed_at,skip_reason,error,symbols_fingerprint,scan_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,?)", [identity, folder.uri.toString(), displayPath, path.posix.basename(uri.path), openDocument?.languageId || path.extname(uri.path).slice(1), fingerprint, algorithm, stat.size, stat.mtime, text, indexedAt, null, scanId ?? null])
            await run(this.database!, "DELETE FROM symbols WHERE document_uri=?", [identity])
            if (this.state.fts5) {
              await run(this.database!, "DELETE FROM documents_fts WHERE uri=?", [identity])
              await run(this.database!, "INSERT INTO documents_fts(uri,relative_path,text) VALUES(?,?,?)", [identity, displayPath, text])
            }
            await exec(this.database!, "COMMIT")
          } catch (error) {
            await exec(this.database!, "ROLLBACK")
            throw error
          }
        })
        if (!openDocument?.isDirty) this.dirtyUris.delete(identity)
        return true
      } finally {
        this.activeSourceBytes = Math.max(0, this.activeSourceBytes - bytes.byteLength)
        this.update({ activeSourceBytes: this.activeSourceBytes })
      }
    } catch (error) {
      if (this.isCancelled(signal)) return false
      const message = error instanceof Error ? error.message : String(error)
      await this.recordFailure(uri, folder.uri.toString(), displayPath, message, scanId)
      logger.warn(`Could not index ${displayPath}: ${message}`)
      return false
    }
  }

  private async collectSymbols(uri: vscode.Uri, signal?: AbortSignal): Promise<Array<{ name: string; kind: string; range: vscode.Range; container?: string }>> {
    this.throwIfSignalAborted(signal)
    this.symbolProviderCalls += 1
    this.update({ symbolProviderCalls: this.symbolProviderCalls })
    const startedAt = Date.now()
    try {
      const symbols = await vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined>("vscode.executeDocumentSymbolProvider", uri)
      this.throwIfSignalAborted(signal)
      if (!symbols) return []
      const result: Array<{ name: string; kind: string; range: vscode.Range; container?: string }> = []
      const walk = (items: (vscode.DocumentSymbol | vscode.SymbolInformation)[], container?: string) => {
        for (const symbol of items) {
          if ("location" in symbol) {
            result.push({ name: symbol.name, kind: vscode.SymbolKind[symbol.kind], range: symbol.location.range, container: symbol.containerName })
          } else {
            result.push({ name: symbol.name, kind: vscode.SymbolKind[symbol.kind], range: symbol.range, container })
            walk(symbol.children, symbol.name)
          }
        }
      }
      walk(symbols)
      const elapsed = Date.now() - startedAt
      if (elapsed >= 1000) logger.info(`Workspace symbol provider took ${elapsed}ms for ${uri.toString()}`)
      return result
    } catch (error) {
      if (signal?.aborted || this.disposed) throw error
      logger.warn(`Language-service symbols unavailable for ${uri.toString()}: ${error instanceof Error ? error.message : String(error)}`)
      return []
    }
  }

  private async cacheSymbols(uri: string, fingerprint: string, symbols: Array<{ name: string; kind: string; range: vscode.Range; container?: string }>): Promise<void> {
    if (this.dirtyUris.has(uri) || this.disposed) return
    await this.withWrite(async () => {
      const current = await get<{ fingerprint: string }>(this.database!, "SELECT fingerprint FROM documents WHERE uri=?", [uri])
      if (current?.fingerprint !== fingerprint || this.dirtyUris.has(uri)) return
      await exec(this.database!, "BEGIN IMMEDIATE")
      try {
        await run(this.database!, "DELETE FROM symbols WHERE document_uri=?", [uri])
        await this.storeSymbols(uri, symbols)
        await run(this.database!, "UPDATE documents SET symbols_fingerprint=? WHERE uri=? AND fingerprint=?", [fingerprint, uri, fingerprint])
        await exec(this.database!, "COMMIT")
      } catch (error) {
        await exec(this.database!, "ROLLBACK")
        throw error
      }
    })
    await this.refreshCounts()
  }

  private async storeSymbols(uri: string, symbols: Array<{ name: string; kind: string; range: vscode.Range; container?: string }>): Promise<void> {
    for (const symbol of symbols) {
      await run(this.database!, "INSERT OR IGNORE INTO symbols(document_uri,name,kind,line,column_no,end_line,end_column,container) VALUES(?,?,?,?,?,?,?,?)", [uri, symbol.name, symbol.kind, symbol.range.start.line, symbol.range.start.character, symbol.range.end.line, symbol.range.end.character, symbol.container ?? null])
    }
  }

  private async storeSkipped(uri: vscode.Uri, workspaceUri: string, relative: string, size: number, reason: string, signal?: AbortSignal, scanId?: string): Promise<void> {
    const identity = uri.toString()
    if (signal && this.isCancelled(signal)) return
    this.dirtyUris.delete(identity)
    await this.withWrite(async () => {
      if (signal && this.isCancelled(signal)) return
      await exec(this.database!, "BEGIN IMMEDIATE")
      try {
        await run(this.database!, "DELETE FROM symbols WHERE document_uri=?", [identity])
        if (this.state.fts5) await run(this.database!, "DELETE FROM documents_fts WHERE uri=?", [identity])
        await run(this.database!, "INSERT OR REPLACE INTO documents(uri,workspace_uri,relative_path,filename,language_id,fingerprint,hash_algorithm,size,mtime_ms,text,indexed_at,skip_reason,error,symbols_fingerprint,scan_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,?)", [identity, workspaceUri, relative, path.posix.basename(uri.path), path.extname(uri.path).slice(1), "", "", size, null, "", new Date().toISOString(), reason, scanId ?? null])
        await exec(this.database!, "COMMIT")
      } catch (error) {
        await exec(this.database!, "ROLLBACK")
        throw error
      }
    })
    if (!signal || !this.isCancelled(signal)) this.update({ filesSkipped: this.state.filesSkipped + 1 })
  }

  private async recordFailure(uri: vscode.Uri, workspaceUri: string, relative: string, message: string, scanId?: string): Promise<void> {
    await this.withWrite(async () => {
      await run(this.database!, "INSERT OR REPLACE INTO documents(uri,workspace_uri,relative_path,filename,language_id,fingerprint,hash_algorithm,size,mtime_ms,text,indexed_at,skip_reason,error,symbols_fingerprint,scan_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?)", [uri.toString(), workspaceUri, relative, path.posix.basename(uri.path), path.extname(uri.path).slice(1), "", "", 0, null, "", new Date().toISOString(), null, message, scanId ?? null])
    })
    await this.refreshCounts()
  }

  private async removeDocument(uri: string): Promise<boolean> {
    const prefix = uri.endsWith("/") ? uri : `${uri}/`
    const matchesTree = "uri=? OR substr(uri,1,length(?))=?"
    const values = [uri, prefix, prefix]
    const existing = await get<{ uri: string }>(this.database!, `SELECT uri FROM documents WHERE ${matchesTree} LIMIT 1`, values)
    if (!existing) return false
    for (const dirtyUri of this.dirtyUris) if (dirtyUri === uri || dirtyUri.startsWith(prefix)) this.dirtyUris.delete(dirtyUri)
    if (this.state.fts5) await run(this.database!, `DELETE FROM documents_fts WHERE ${matchesTree}`, values)
    await run(this.database!, `DELETE FROM symbols WHERE document_uri IN (SELECT uri FROM documents WHERE ${matchesTree})`, values)
    await run(this.database!, `DELETE FROM documents WHERE ${matchesTree}`, values)
    return true
  }

  private isEligibleUri(uri: vscode.Uri): boolean {
    const folder = this.folderFor(uri)
    if (!folder) return false
    const localPath = path.posix.relative(folder.uri.path, uri.path)
    const config = vscode.workspace.getConfiguration("twinny")
    const include = config.get<string[]>("indexing.include", ["**/*"])
    const exclude = [...DEFAULT_EXCLUDES, ...config.get<string[]>("indexing.exclude", []), ...vscodeExcludePatterns()]
    return include.some((pattern) => matches(localPath, pattern)) &&
      !exclude.some((pattern) => matches(localPath, pattern)) &&
      !isGitIgnored(localPath, this.ignoredRules.get(folder.uri.toString()) ?? [])
  }

  private folderFor(uri: vscode.Uri): vscode.WorkspaceFolder | undefined {
    return vscode.workspace.getWorkspaceFolder(uri)
  }

  private async refreshCounts(): Promise<void> {
    const stats = await get<{ indexed: number; symbols: number; skipped: number; failed: number }>(this.reader!, "SELECT SUM(skip_reason IS NULL AND error IS NULL) AS indexed, (SELECT COUNT(*) FROM symbols) AS symbols, SUM(skip_reason IS NOT NULL) AS skipped, SUM(error IS NOT NULL) AS failed FROM documents")
    this.update({ filesIndexed: stats?.indexed ?? 0, symbolsIndexed: stats?.symbols ?? 0, filesSkipped: stats?.skipped ?? 0, filesFailed: stats?.failed ?? 0, storageBytes: await this.measureDatabaseSize() })
  }

  private async measureDatabaseSize(): Promise<number> {
    let total = 0
    for (const suffix of ["", "-wal", "-shm"]) {
      const file = `${this.databasePath}${suffix}`
      const stat = await fs.stat(file).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined
        throw error
      })
      total += stat?.size ?? 0
    }
    return total
  }

  private withWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writer.then(operation)
    this.writer = result.then(() => undefined, () => undefined)
    return result
  }

  private throwIfCancelled(signal: AbortSignal): void {
    if (this.isCancelled(signal)) throw new Error("Workspace indexing cancelled")
  }

  private throwIfSignalAborted(signal?: AbortSignal): void {
    if (signal?.aborted || this.disposed) throw new Error("Workspace search cancelled")
  }

  private isCancelled(signal: AbortSignal): boolean {
    return signal.aborted || this.disposed
  }

  private update(patch: Partial<WorkspaceIndexState>): void {
    if (this.disposed || Object.entries(patch).every(([key, value]) => Object.is(this.state[key as keyof WorkspaceIndexState], value))) return
    this.state = { ...this.state, ...patch }
    this.emitter.fire(this.snapshot)
  }
}
