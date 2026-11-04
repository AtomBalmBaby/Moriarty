import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import initSqlJs, { Database, SqlValue } from "sql.js"
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
  text TEXT NOT NULL, indexed_at TEXT NOT NULL, skip_reason TEXT, error TEXT
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
PRAGMA user_version=1;
`

const rows = <T>(database: Database, sql: string, values: SqlValue[] = []): T[] => {
  const statement = database.prepare(sql)
  try {
    statement.bind(values)
    const result: T[] = []
    while (statement.step()) result.push(statement.getAsObject() as T)
    return result
  } finally {
    statement.free()
  }
}

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
const matches = (value: string, filter: string | undefined): boolean => !filter || globRegex(filter).test(value)
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
  private sqlPromise?: ReturnType<typeof initSqlJs>
  private initializing?: Promise<void>
  private scanning?: Promise<void>
  private synchronizing: Promise<void> = Promise.resolve()
  private cancelled = false
  private paused = false
  private disposed = false
  private readonly overlays = new Map<string, string>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly listeners: vscode.Disposable[] = []
  private readonly emitter = new vscode.EventEmitter<WorkspaceIndexState>()
  readonly onDidChange = this.emitter.event
  private state: WorkspaceIndexState = {
    status: "not-initialized", filesDiscovered: 0, filesIndexed: 0,
    symbolsIndexed: 0, filesPending: 0, filesSkipped: 0, filesFailed: 0,
    storageBytes: 0, fts5: false
  }

  constructor(private readonly storageUri: vscode.Uri, private readonly extensionPath: string) {
    this.listeners.push(
      vscode.workspace.onDidCreateFiles((event) => {
        if (!this.automaticSyncEnabled()) return
        if (event.files.some((uri) => uri.path.endsWith("/.gitignore"))) void this.synchronize().catch((error) => this.reportError("Workspace ignore-rule synchronization failed", error))
        else this.scheduleUris(event.files)
      }),
      vscode.workspace.onDidDeleteFiles((event) => {
        if (!this.automaticSyncEnabled()) return
        if (event.files.some((uri) => uri.path.endsWith("/.gitignore"))) void this.synchronize().catch((error) => this.reportError("Workspace ignore-rule synchronization failed", error))
        else void this.deleteUris(event.files.map((uri) => uri.toString())).catch((error) => this.reportError("Workspace index deletion failed", error))
      }),
      vscode.workspace.onDidRenameFiles((event) => {
        if (!this.automaticSyncEnabled()) return
        if (event.files.some((file) => file.oldUri.path.endsWith("/.gitignore") || file.newUri.path.endsWith("/.gitignore"))) {
          void this.synchronize().catch((error) => this.reportError("Workspace ignore-rule synchronization failed", error))
          return
        }
        void this.deleteUris(event.files.map((file) => file.oldUri.toString()))
          .then(() => this.scheduleUris(event.files.map((file) => file.newUri)))
          .catch((error) => this.reportError("Workspace index rename failed", error))
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (!this.automaticSyncEnabled()) return
        if (document.uri.path.endsWith("/.gitignore")) void this.synchronize().catch((error) => this.reportError("Workspace ignore-rule synchronization failed", error))
        else this.scheduleUris([document.uri])
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (this.isEligibleUri(event.document.uri)) this.overlays.set(event.document.uri.toString(), event.document.getText())
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        if (this.overlays.has(document.uri.toString())) this.overlays.set(document.uri.toString(), document.getText())
        this.scheduleUris([document.uri])
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        if (this.automaticSyncEnabled()) void this.synchronize().catch((error) => this.reportError("Workspace index folder synchronization failed", error))
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        const config = vscode.workspace.getConfiguration("twinny")
        if (event.affectsConfiguration("twinny.indexing.enabled")) {
          if (!config.get<boolean>("indexing.enabled", true)) {
            this.cancelled = true
            this.update({ status: "disabled" })
          } else if (config.get<boolean>("indexing.auto", true)) {
            void this.synchronize().catch((error) => this.reportError("Workspace index reconfiguration failed", error))
          } else {
            this.update({ status: this.state.lastSynchronized ? "paused" : "not-initialized" })
          }
        } else if (event.affectsConfiguration("twinny.indexing.auto")) {
          if (config.get<boolean>("indexing.auto", true) && config.get<boolean>("indexing.enabled", true)) {
            void this.synchronize().catch((error) => this.reportError("Workspace index automatic-sync configuration failed", error))
          }
          else if (!config.get<boolean>("indexing.auto", true)) this.update({ status: this.state.lastSynchronized ? "paused" : "not-initialized" })
        } else if (!config.get<boolean>("indexing.enabled", true)) this.update({ status: "disabled" })
        else if (event.affectsConfiguration("twinny.contentHash.algorithm") || event.affectsConfiguration("twinny.indexing.include") ||
          event.affectsConfiguration("twinny.indexing.exclude") || event.affectsConfiguration("twinny.indexing.maxFileSize") ||
          event.affectsConfiguration("files.exclude") || event.affectsConfiguration("search.exclude") ||
          (event.affectsConfiguration("twinny.indexing.auto") && config.get<boolean>("indexing.auto", true))) {
          void this.synchronize().catch((error) => this.reportError("Workspace index configuration synchronization failed", error))
        }
      })
    )
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
    if (vscode.workspace.getConfiguration("twinny").get<boolean>("indexing.auto", true)) {
      void this.synchronize().catch((error) => this.reportError("Workspace index startup synchronization failed", error))
    }
    else this.update({ status: this.state.lastSynchronized ? "paused" : "not-initialized" })
  }

  async pause(): Promise<void> {
    this.paused = true
    this.update({ status: "paused" })
  }

  async resume(): Promise<void> {
    this.paused = false
    if (!this.scanning) void this.synchronize().catch((error) => this.reportError("Workspace index resume failed", error))
    else this.update({ status: "indexing" })
  }

  async rebuild(): Promise<void> {
    if (this.disposed || !vscode.workspace.getConfiguration("twinny").get<boolean>("indexing.enabled", true)) {
      this.update({ status: "disabled" })
      return
    }
    await this.synchronize(true)
  }
  private synchronize(clear = false): Promise<void> {
    if (this.scanning) this.cancelled = true
    const operation = this.synchronizing.then(async () => {
      if (this.disposed) return
      await this.initialize()
      if (this.disposed) return
      if (this.scanning) {
        this.cancelled = true
        await this.scanning.catch(() => undefined)
      }
      if (clear) {
        this.database!.run("DELETE FROM symbols; DELETE FROM documents;")
        if (this.state.fts5) this.database!.run("DELETE FROM documents_fts")
        await this.persist()
        this.update({ filesIndexed: 0, symbolsIndexed: 0, filesSkipped: 0, filesFailed: 0 })
      }
      this.cancelled = false
      const scan = this.scan()
      this.scanning = scan
      try {
        await scan
      } finally {
        if (this.scanning === scan) this.scanning = undefined
      }
    })
    this.synchronizing = operation.catch(() => undefined)
    return operation
  }

  async clearAndRebuild(): Promise<void> {
    await this.rebuild()
  }

  async search(request: WorkspaceSearchRequest, scope?: string, signal?: AbortSignal): Promise<{ results: WorkspaceSearchHit[]; total: number }> {
    if (this.disposed) throw new Error("Workspace index has been disposed.")
    if (!vscode.workspace.getConfiguration("twinny").get<boolean>("indexing.enabled", true)) {
      throw new Error("Workspace indexing is disabled in Twinny settings.")
    }
    await this.initialize()
    const query = request.query.trim()
    if (!query) return { results: [], total: 0 }
    if (signal?.aborted) throw new Error("Workspace search cancelled")
    const mode = request.mode ?? "auto"
    const all = rows<DocRow>(this.database!, "SELECT uri,workspace_uri,relative_path,filename,language_id,fingerprint,hash_algorithm,size,mtime_ms,'' AS text,indexed_at,skip_reason,error FROM documents WHERE skip_reason IS NULL AND error IS NULL")
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
      return scoped && included && !excluded && matches(doc.relative_path, request.path)
    })
    const documentsByUri = new Map(documents.map((doc) => [doc.uri, doc]))
    const hits: WorkspaceSearchHit[] = []
    const seen = new Set<string>()
    const add = (hit: WorkspaceSearchHit) => {
      const key = `${hit.path}:${hit.line ?? 0}:${hit.category}:${hit.symbol ?? ""}`
      if (!seen.has(key)) { seen.add(key); hits.push(hit) }
    }
    const pathMatches = (doc: DocRow) => (query.includes("*") || query.includes("?") ? globRegex(query).test(doc.relative_path) : doc.relative_path.toLowerCase().includes(query.toLowerCase()) || doc.filename.toLowerCase().includes(query.toLowerCase()))
    if (mode === "path" || mode === "auto") {
      for (const doc of documents) if (pathMatches(doc)) add({ uri: doc.uri, path: doc.relative_path, category: "path", preview: doc.relative_path, source: "index" })
    }
    if (mode === "symbol" || mode === "auto") {
      const symbols = rows<SymbolRow>(this.database!, "SELECT d.uri AS uri,s.name,s.kind,s.line,s.column_no,s.end_line,s.end_column,s.container,d.relative_path AS path FROM symbols s JOIN documents d ON d.uri=s.document_uri WHERE d.skip_reason IS NULL AND d.error IS NULL")
      const wanted = query.toLowerCase()
      for (const symbol of symbols) {
        if (this.overlays.has(symbol.uri) || !documentsByUri.has(symbol.uri) || !symbol.name.toLowerCase().includes(wanted)) continue
        add({ uri: symbol.uri, path: symbol.path, line: symbol.line + 1, column: symbol.column_no + 1, category: "symbol", symbol: symbol.name, kind: symbol.kind, preview: `${symbol.kind} ${symbol.name}${symbol.container ? ` (${symbol.container})` : ""}`, source: "index" })
      }
      for (const openDocument of vscode.workspace.textDocuments) {
        const uri = openDocument.uri.toString()
        const doc = documentsByUri.get(uri)
        if (!doc || !this.overlays.has(uri)) continue
        for (const symbol of await this.collectSymbols(openDocument)) {
          if (!symbol.name.toLowerCase().includes(wanted)) continue
          add({ uri, path: doc.relative_path, line: symbol.range.start.line + 1, column: symbol.range.start.character + 1, category: "symbol", symbol: symbol.name, kind: symbol.kind, preview: symbol.kind + " " + symbol.name + (symbol.container ? " (" + symbol.container + ")" : ""), source: "live" })
        }
      }
    }
    if (mode === "literal" || mode === "regex" || mode === "auto") {
      let contentRows: DocRow[] = []
      if (mode === "regex") {
        contentRows = rows<DocRow>(this.database!, "SELECT * FROM documents WHERE skip_reason IS NULL AND error IS NULL")
      } else if (mode === "literal") {
        contentRows = rows<DocRow>(this.database!, "SELECT * FROM documents WHERE skip_reason IS NULL AND error IS NULL AND instr(text,?) > 0", [query])
      } else {
        const firstTerm = query.split(/\s+/).find(Boolean) ?? query
        const terms = query.split(/\s+/).filter(Boolean).map((term) => `"${term.replace(/"/g, "\"\"")}"`).join(" AND ")
        if (this.state.fts5) {
          try {
            contentRows = rows<DocRow>(this.database!, "SELECT * FROM documents WHERE skip_reason IS NULL AND error IS NULL AND (instr(lower(text),lower(?)) > 0 OR uri IN (SELECT uri FROM documents_fts WHERE documents_fts MATCH ?))", [firstTerm, terms])
          } catch (error) {
            logger.debug(`Workspace FTS query fell back to literal matching: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        if (!contentRows.length) {
          contentRows = rows<DocRow>(this.database!, "SELECT * FROM documents WHERE skip_reason IS NULL AND error IS NULL AND instr(lower(text),lower(?)) > 0", [firstTerm])
        }
      }
      const candidates = new Map(contentRows.filter((doc) => documentsByUri.has(doc.uri)).map((doc) => [doc.uri, doc]))
      for (const doc of documents) {
        const live = this.overlays.get(doc.uri)
        if (live !== undefined) candidates.set(doc.uri, { ...doc, text: live })
      }
      const regex = mode === "regex" ? new RegExp(query, "g") : undefined
      const firstTerm = query.split(/\s+/).find(Boolean) ?? query
      for (const doc of candidates.values()) {
        if (signal?.aborted) throw new Error("Workspace search cancelled")
        const live = this.overlays.get(doc.uri)
        const text = live ?? doc.text
        if (regex) regex.lastIndex = 0
        let index = mode === "regex" ? regex!.exec(text)?.index ?? -1 : text.indexOf(query)
        if (index < 0 && mode === "auto") index = text.toLowerCase().indexOf(firstTerm.toLowerCase())
        if (index < 0) continue
        const position = lineColumn(text, index)
        const lines = text.split(/\r?\n/)
        add({ uri: doc.uri, path: doc.relative_path, line: position.line, column: position.column, category: "content", preview: lines[position.line - 1]?.trim().slice(0, 240) ?? "", source: live === undefined ? "index" : "live" })
      }
    }
    const total = hits.length
    const offset = Math.max(0, Math.floor(request.offset ?? 0))
    const limit = Math.max(1, Math.min(100, Math.floor(request.limit ?? 20)))
    return { results: hits.slice(offset, offset + limit), total }
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
    this.disposed = true
    this.cancelled = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    for (const listener of this.listeners) listener.dispose()
    const database = this.database
    if (this.scanning) void this.scanning.finally(() => database?.close())
    else database?.close()
    this.emitter.dispose()
  }

  private get databasePath(): string {
    return path.join(this.storageUri.fsPath, "workspace-index.sqlite")
  }

  private async initialize(): Promise<void> {
    if (this.database) return
    if (!this.initializing) this.initializing = this.open().catch((error) => {
      this.initializing = undefined
      this.reportError("Workspace index initialization failed", error)
      throw error
    })
    await this.initializing
  }

  private reportError(context: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    logger.error(`${context}: ${message}`)
    this.update({ status: "error", error: message })
  }

  private async open(): Promise<void> {
    await fs.mkdir(this.storageUri.fsPath, { recursive: true })
    const bytes = await fs.readFile(this.databasePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    const sql = await (this.sqlPromise ??= initSqlJs({ locateFile: () => path.join(this.extensionPath, "out", "sql-wasm.wasm") }))
    const database = new sql.Database(bytes)
    if (this.disposed) { database.close(); return }
    const version = rows<{ user_version: number }>(database, "PRAGMA user_version")[0]?.user_version ?? 0
    if (version > 1) { database.close(); throw new Error(`Workspace index database version ${version} is newer than this Twinny version`) }
    database.run(SCHEMA)
    try {
      database.run("CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(uri UNINDEXED, relative_path, text)")
      this.state.fts5 = true
    } catch (error) {
      logger.warn(`Workspace index FTS5 unavailable; using literal text search: ${error instanceof Error ? error.message : String(error)}`)
      this.state.fts5 = false
    }
    if (this.state.fts5) {
      database.run("DELETE FROM documents_fts")
      database.run("INSERT INTO documents_fts(uri,relative_path,text) SELECT uri,relative_path,text FROM documents WHERE skip_reason IS NULL AND error IS NULL")
    }
    this.database = database
    const algorithm = vscode.workspace.getConfiguration("twinny").get<ContentHashAlgorithm>("contentHash.algorithm", "xxh64")
    const stored = rows<{ value: string }>(database, "SELECT value FROM index_meta WHERE key='hash_algorithm'")[0]?.value
    if (stored && stored !== algorithm) await this.migrateFingerprints(algorithm)
    database.run("INSERT OR REPLACE INTO index_meta(key,value) VALUES('hash_algorithm',?)", [algorithm])
    const lastSynchronized = rows<{ value: string }>(database, "SELECT value FROM index_meta WHERE key='last_synchronized'")[0]?.value
    const indexingConfiguration = JSON.stringify({
      include: vscode.workspace.getConfiguration("twinny").get<string[]>("indexing.include", ["**/*"]),
      exclude: [...DEFAULT_EXCLUDES, ...vscode.workspace.getConfiguration("twinny").get<string[]>("indexing.exclude", []), ...vscodeExcludePatterns()],
      maxFileSize: vscode.workspace.getConfiguration("twinny").get<number>("indexing.maxFileSize", 1048576)
    })
    const previousConfiguration = rows<{ value: string }>(database, "SELECT value FROM index_meta WHERE key='indexing_configuration'")[0]?.value
    database.run("INSERT OR REPLACE INTO index_meta(key,value) VALUES('indexing_configuration',?)", [indexingConfiguration])
    await this.persist()
    const stats = rows<{ indexed: number; symbols: number; skipped: number; failed: number }>(database, "SELECT SUM(skip_reason IS NULL AND error IS NULL) AS indexed, (SELECT COUNT(*) FROM symbols) AS symbols, SUM(skip_reason IS NOT NULL) AS skipped, SUM(error IS NOT NULL) AS failed FROM documents")[0]
    const storage = await fs.stat(this.databasePath).catch(() => undefined)
    this.update({ status: lastSynchronized && previousConfiguration === indexingConfiguration ? "ready" : "not-initialized", lastSynchronized, filesIndexed: stats?.indexed ?? 0, symbolsIndexed: stats?.symbols ?? 0, filesSkipped: stats?.skipped ?? 0, filesFailed: stats?.failed ?? 0, storageBytes: storage?.size ?? 0 })
  }

  private async migrateFingerprints(algorithm: ContentHashAlgorithm): Promise<void> {
    const database = this.database!
    const docs = rows<DocRow>(database, "SELECT * FROM documents")
    for (const doc of docs) {
      const digest = await fingerprintContent(doc.text, algorithm)
      database.run("UPDATE documents SET fingerprint=?,hash_algorithm=? WHERE uri=?", [digest, algorithm, doc.uri])
    }
  }

  private async scan(): Promise<void> {
    try {
      await this.initialize()
      const config = vscode.workspace.getConfiguration("twinny")
      const include = config.get<string[]>("indexing.include", ["**/*"])
      const exclude = [...DEFAULT_EXCLUDES, ...config.get<string[]>("indexing.exclude", []), ...vscodeExcludePatterns()]
      this.update({ status: "scanning", error: undefined, filesDiscovered: 0, filesPending: 0 })
      const discovered = new Map<string, vscode.Uri>()
      const ignored = new Map<string, { uri: vscode.Uri; folder: vscode.WorkspaceFolder }>()
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        for (const pattern of include) {
          const excludeGlob = `{${exclude.join(",")}}`
          const files = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, pattern), new vscode.RelativePattern(folder, excludeGlob))
          for (const uri of files) discovered.set(uri.toString(), uri)
        }
        const ignoreUris = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, "**/.gitignore"))
        const rules: GitIgnoreRule[] = []
        for (const ignoreUri of ignoreUris) {
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
        for (const uri of discovered.values()) {
          if (vscode.workspace.getWorkspaceFolder(uri)?.uri.toString() !== folder.uri.toString()) continue
          const localPath = path.posix.relative(folder.uri.path, uri.path)
          if (isGitIgnored(localPath, rules)) ignored.set(uri.toString(), { uri, folder })
        }
      }
      for (const { uri, folder } of ignored.values()) {
        const localPath = path.posix.relative(folder.uri.path, uri.path)
        const displayPath = (vscode.workspace.workspaceFolders?.length ?? 0) > 1 ? `${folder.name}/${localPath}` : localPath
        const stat = await vscode.workspace.fs.stat(uri)
        this.storeSkipped(uri, folder.uri.toString(), displayPath, stat.size, "ignored by .gitignore")
      }
      const currentAlgorithm = config.get<ContentHashAlgorithm>("contentHash.algorithm", "xxh64")
      const files = [...discovered.values()].filter((uri) => !ignored.has(uri.toString()))
      this.update({ status: this.paused ? "paused" : "indexing", filesDiscovered: discovered.size, filesIndexed: 0, filesPending: files.length })
      let cursor = 0
      let completed = 0
      let indexed = 0
      const workers = Array.from({ length: Math.min(4, files.length) }, async () => {
        while (cursor < files.length && !this.cancelled && !this.disposed) {
          while (this.paused && !this.cancelled) await new Promise((resolve) => setTimeout(resolve, 200))
          if (this.cancelled || this.disposed) return
          const uri = files[cursor++]
          if (await this.indexFile(uri, currentAlgorithm)) indexed += 1
          completed += 1
          this.update({ filesIndexed: indexed, filesPending: Math.max(0, files.length - completed) })
        }
      })
      await Promise.all(workers)
      if (this.cancelled || this.disposed) return
      const activeWorkspaceUris = new Set((vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.toString()))
      const stale = rows<{ uri: string; workspace_uri: string }>(this.database!, "SELECT uri,workspace_uri FROM documents")
        .filter((doc) => !discovered.has(doc.uri) || !activeWorkspaceUris.has(doc.workspace_uri))
      for (const doc of stale) this.removeDocument(doc.uri)
      const synchronizedAt = new Date().toISOString()
      this.database!.run("INSERT OR REPLACE INTO index_meta(key,value) VALUES('hash_algorithm',?)", [currentAlgorithm])
      this.database!.run("INSERT OR REPLACE INTO index_meta(key,value) VALUES('last_synchronized',?)", [synchronizedAt])
      this.database!.run("INSERT OR REPLACE INTO index_meta(key,value) VALUES('indexing_configuration',?)", [JSON.stringify({
        include: config.get<string[]>("indexing.include", ["**/*"]),
        exclude: [...DEFAULT_EXCLUDES, ...config.get<string[]>("indexing.exclude", []), ...vscodeExcludePatterns()],
        maxFileSize: config.get<number>("indexing.maxFileSize", 1048576)
      })])
      await this.persist()
      const storage = await fs.stat(this.databasePath)
      const stats = rows<{ indexed: number; symbols: number; skipped: number; failed: number }>(this.database!, "SELECT SUM(skip_reason IS NULL AND error IS NULL) AS indexed, (SELECT COUNT(*) FROM symbols) AS symbols, SUM(skip_reason IS NOT NULL) AS skipped, SUM(error IS NOT NULL) AS failed FROM documents")[0]
      this.update({ status: this.paused ? "paused" : "ready", filesIndexed: stats?.indexed ?? 0, symbolsIndexed: stats?.symbols ?? 0, filesSkipped: stats?.skipped ?? 0, filesFailed: stats?.failed ?? 0, filesPending: 0, storageBytes: storage.size, lastSynchronized: synchronizedAt })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error(`Workspace indexing failed: ${message}`)
      this.update({ status: "error", error: message })
    }
  }

  private async indexFile(uri: vscode.Uri, algorithm: ContentHashAlgorithm): Promise<boolean> {
    const folder = this.folderFor(uri)
    if (!folder) return false
    const identity = uri.toString()
    const relative = path.posix.relative(folder.uri.path, uri.path)
    const displayPath = (vscode.workspace.workspaceFolders?.length ?? 0) > 1 ? `${folder.name}/${relative}` : relative
    try {
      const stat = await vscode.workspace.fs.stat(uri)
      if (this.cancelled || this.disposed) return false
      const maxBytes = vscode.workspace.getConfiguration("twinny").get<number>("indexing.maxFileSize", 1048576)
      if (stat.size > maxBytes) {
        this.overlays.delete(identity)
        this.storeSkipped(uri, folder.uri.toString(), displayPath, stat.size, "file exceeds configured size limit")
        return false
      }
      const doc = await vscode.workspace.openTextDocument(uri)
      if (doc.isDirty) this.overlays.set(identity, doc.getText())
      const bytes = await vscode.workspace.fs.readFile(uri)
      if (this.cancelled || this.disposed) return false
      let text: string
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      } catch {
        this.storeSkipped(uri, folder.uri.toString(), displayPath, stat.size, "file is not valid UTF-8 text")
        return false
      }
      if (text.includes("\0")) {
        this.storeSkipped(uri, folder.uri.toString(), displayPath, stat.size, "binary content")
        return false
      }
      const symbols = doc.isDirty ? [] : await this.collectSymbols(doc)
      if (this.cancelled || this.disposed) return false
      const fingerprint = await fingerprintContent(text, algorithm)
      if (this.cancelled || this.disposed) return false
      const previous = rows<DocRow>(this.database!, "SELECT fingerprint,size,mtime_ms FROM documents WHERE uri=?", [identity])[0]
      if (previous?.fingerprint === fingerprint && previous.size === stat.size && previous.mtime_ms === stat.mtime) {
        if (!doc.isDirty) this.overlays.delete(identity)
        return true
      }
      const indexedAt = new Date().toISOString()
      this.database!.run("BEGIN")
      try {
        this.database!.run("INSERT OR REPLACE INTO documents(uri,workspace_uri,relative_path,filename,language_id,fingerprint,hash_algorithm,size,mtime_ms,text,indexed_at,skip_reason,error) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL)", [identity, folder.uri.toString(), displayPath, path.posix.basename(uri.path), doc.languageId || path.extname(uri.path).slice(1), fingerprint, algorithm, stat.size, stat.mtime, text, indexedAt, null])
        this.database!.run("DELETE FROM symbols WHERE document_uri=?", [identity])
        if (this.state.fts5) {
          this.database!.run("DELETE FROM documents_fts WHERE uri=?", [identity])
          this.database!.run("INSERT INTO documents_fts(uri,relative_path,text) VALUES(?,?,?)", [identity, displayPath, text])
        }
        this.storeSymbols(identity, symbols)
        this.database!.run("COMMIT")
        if (!doc.isDirty) this.overlays.delete(identity)
      } catch (error) {
        this.database!.run("ROLLBACK")
        throw error
      }
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.database!.run("INSERT OR REPLACE INTO documents(uri,workspace_uri,relative_path,filename,language_id,fingerprint,hash_algorithm,size,mtime_ms,text,indexed_at,skip_reason,error) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", [identity, folder.uri.toString(), displayPath, path.posix.basename(uri.path), path.extname(uri.path).slice(1), "", "", 0, null, "", new Date().toISOString(), null, message])
      this.update({ filesFailed: this.state.filesFailed + 1 })
      logger.warn(`Could not index ${displayPath}: ${message}`)
      return false
    }
  }

  private async collectSymbols(document: vscode.TextDocument): Promise<Array<{ name: string; kind: string; range: vscode.Range; container?: string }>> {
    let symbols: (vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined
    try {
      symbols = await vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined>("vscode.executeDocumentSymbolProvider", document.uri)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.warn("Language-service symbols unavailable for " + document.uri.toString() + ": " + message)
      return []
    }
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
    return result
  }

  private storeSymbols(uri: string, symbols: Array<{ name: string; kind: string; range: vscode.Range; container?: string }>): void {
    for (const symbol of symbols) {
      this.database!.run("INSERT OR IGNORE INTO symbols(document_uri,name,kind,line,column_no,end_line,end_column,container) VALUES(?,?,?,?,?,?,?,?)", [uri, symbol.name, symbol.kind, symbol.range.start.line, symbol.range.start.character, symbol.range.end.line, symbol.range.end.character, symbol.container ?? null])
    }
  }

  private storeSkipped(uri: vscode.Uri, workspaceUri: string, relative: string, size: number, reason: string): void {
    this.overlays.delete(uri.toString())
    this.database!.run("DELETE FROM symbols WHERE document_uri=?", [uri.toString()])
    if (this.state.fts5) this.database!.run("DELETE FROM documents_fts WHERE uri=?", [uri.toString()])
    this.database!.run("INSERT OR REPLACE INTO documents(uri,workspace_uri,relative_path,filename,language_id,fingerprint,hash_algorithm,size,mtime_ms,text,indexed_at,skip_reason,error) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL)", [uri.toString(), workspaceUri, relative, path.posix.basename(uri.path), path.extname(uri.path).slice(1), "", "", size, null, "", new Date().toISOString(), reason])
    this.update({ filesSkipped: this.state.filesSkipped + 1 })
  }

  private removeDocument(uri: string): void {
    this.database!.run("DELETE FROM symbols WHERE document_uri=?", [uri])
    this.database!.run("DELETE FROM documents WHERE uri=?", [uri])
    if (this.state.fts5) this.database!.run("DELETE FROM documents_fts WHERE uri=?", [uri])
  }

  private async deleteUris(uris: string[]): Promise<void> {
    await this.initialize()
    for (const uri of uris) this.removeDocument(uri)
    const synchronizedAt = new Date().toISOString()
    this.database!.run("INSERT OR REPLACE INTO index_meta(key,value) VALUES('last_synchronized',?)", [synchronizedAt])
    await this.persist()
    await this.refreshCounts()
    this.update({ lastSynchronized: synchronizedAt })
  }

  private automaticSyncEnabled(): boolean {
    const config = vscode.workspace.getConfiguration("twinny")
    return !this.disposed && !this.paused && config.get<boolean>("indexing.enabled", true) && config.get<boolean>("indexing.auto", true)
  }

  private scheduleUris(uris: readonly vscode.Uri[]): void {
    for (const uri of uris) {
      const key = uri.toString()
      const previous = this.timers.get(key)
      if (previous) clearTimeout(previous)
      this.timers.set(key, setTimeout(() => {
        this.timers.delete(key)
        if (this.disposed) return
        const config = vscode.workspace.getConfiguration("twinny")
        if (!config.get<boolean>("indexing.enabled", true) || !config.get<boolean>("indexing.auto", true) || this.paused) return
        const algorithm = config.get<ContentHashAlgorithm>("contentHash.algorithm", "xxh64")
        void (async () => {
          await this.scanning?.catch(() => undefined)
          await this.initialize()
          await this.indexFile(uri, algorithm)
          const synchronizedAt = new Date().toISOString()
          this.database!.run("INSERT OR REPLACE INTO index_meta(key,value) VALUES('last_synchronized',?)", [synchronizedAt])
          await this.persist()
          await this.refreshCounts()
          this.update({ status: this.scanning ? this.state.status : "ready", lastSynchronized: synchronizedAt })
        })().catch((error) => this.reportError(`Workspace index update failed for ${uri.toString()}`, error))
      }, 250))
    }
  }

  private isEligibleUri(uri: vscode.Uri): boolean {
    return !!this.folderFor(uri) && !DEFAULT_EXCLUDES.some((pattern) => globRegex(pattern).test(uri.path))
  }

  private folderFor(uri: vscode.Uri): vscode.WorkspaceFolder | undefined {
    return vscode.workspace.getWorkspaceFolder(uri)
  }

  private async refreshCounts(): Promise<void> {
    const stats = rows<{ indexed: number; symbols: number; skipped: number; failed: number }>(this.database!, "SELECT SUM(skip_reason IS NULL AND error IS NULL) AS indexed, (SELECT COUNT(*) FROM symbols) AS symbols, SUM(skip_reason IS NOT NULL) AS skipped, SUM(error IS NOT NULL) AS failed FROM documents")[0]
    const storage = await fs.stat(this.databasePath).catch(() => undefined)
    this.update({ filesIndexed: stats?.indexed ?? 0, symbolsIndexed: stats?.symbols ?? 0, filesSkipped: stats?.skipped ?? 0, filesFailed: stats?.failed ?? 0, storageBytes: storage?.size ?? 0 })
  }

  private async persist(): Promise<void> {
    const temporary = `${this.databasePath}.${randomUUID()}.tmp`
    await fs.writeFile(temporary, this.database!.export(), { mode: 0o600 })
    await fs.rename(temporary, this.databasePath)
  }

  private update(patch: Partial<WorkspaceIndexState>): void {
    this.state = { ...this.state, ...patch }
    this.emitter.fire(this.snapshot)
  }
}
