import * as assert from "assert"
import BetterSqlite from "better-sqlite3"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import * as vscode from "vscode"

import { TWINNY_COMMAND_NAME } from "../../common/constants"
import { editorEdits } from "../../extension/chat/tool-sinks"
import { applyDocumentLineEdits } from "../../extension/edit/line-edit"
import { GenerationTracker } from "../../extension/generations"
import { TwinnyStatusBar } from "../../extension/status-bar"
import { PROJECT_FINGERPRINT, TodoRepository } from "../../extension/todos/repository"
import { WorkspaceView } from "../../extension/tools/view"
import { workspaceTools } from "../../extension/tools/workspace"
import { WorkspaceIntelligenceIndex } from "../../extension/workspace-index"

suite("Persistent workspace intelligence index", () => {
  let root: string
  let secondRoot: string
  let storage: string
  let originalFolders: Array<{ uri: vscode.Uri; name: string }>
  let index: WorkspaceIntelligenceIndex
  const waitUntil = async (condition: () => Promise<boolean>) => {
    for (let attempt = 0; attempt < 50 && !(await condition()); attempt++) await new Promise((resolve) => setTimeout(resolve, 200))
  }
  // VS Code ignores workspace-folder updates while a previous one is still unconfirmed by the main thread,
  // so each change is awaited until onDidChangeWorkspaceFolders reports it.
  const updateWorkspaceFolders = async (start: number, deleteCount: number, ...folders: Array<{ uri: vscode.Uri; name: string }>) => {
    let subscription: vscode.Disposable | undefined
    const confirmed = new Promise<void>((resolve) => {
      subscription = vscode.workspace.onDidChangeWorkspaceFolders(() => resolve())
    })
    const changed = vscode.workspace.updateWorkspaceFolders(start, deleteCount, ...folders)
    if (changed) await confirmed
    subscription?.dispose()
    return changed
  }

  setup(async function () {
    this.timeout(30000)
    root = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-index-main-"))
    secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-index-secondary-"))
    storage = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-index-storage-"))
    fs.mkdirSync(path.join(root, "src", "extension", "tools"), { recursive: true })
    fs.mkdirSync(path.join(root, "src"), { recursive: true })
    fs.mkdirSync(path.join(secondRoot, "src"), { recursive: true })
    fs.writeFileSync(path.join(root, "src", "native.ts"), "export function read_file(path: string) { return path }\nconst identifier = 'WorkspaceTools'\n")
    const implementation = fs.readFileSync(path.resolve(__dirname, "../../../src/extension/tools/workspace.ts"), "utf8")
    fs.writeFileSync(path.join(root, "src", "extension", "tools", "workspace.ts"), implementation + "\nexport const workspaceSearchAcceptanceMarker = 'before'\n")
    fs.writeFileSync(path.join(secondRoot, "src", "other.ts"), "export const multiRootMarker = 'foo.bar'\n")
    fs.writeFileSync(path.join(root, ".gitignore"), "private.ts\n")
    fs.writeFileSync(path.join(root, "private.ts"), "export const privateCredential = true\n")
    fs.writeFileSync(path.join(root, "large.txt"), "x".repeat(1_100_000))
    fs.writeFileSync(path.join(storage, "twinny-state.sqlite"), "durable TODO database sentinel")
    originalFolders = (vscode.workspace.workspaceFolders ?? []).map((folder) => ({ uri: folder.uri, name: folder.name }))
    const repositoryRoot = vscode.Uri.file(path.resolve(__dirname, "../../.."))
    const changed = await updateWorkspaceFolders(
      0,
      originalFolders.length,
      { uri: vscode.Uri.file(root), name: "index-main" },
      { uri: vscode.Uri.file(secondRoot), name: "index-secondary" },
      { uri: repositoryRoot, name: "twinny-repository" }
    )
    assert.equal(changed, true)
  })

  teardown(async function () {
    this.timeout(30000)
    index?.dispose()
    const currentCount = vscode.workspace.workspaceFolders?.length ?? 0
    await updateWorkspaceFolders(0, currentCount, ...originalFolders)
    for (const document of vscode.workspace.textDocuments.filter((entry) => entry.uri.fsPath.startsWith(root + path.sep) || entry.uri.fsPath.startsWith(secondRoot + path.sep))) {
      await vscode.window.showTextDocument(document)
      await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor")
    }
    for (const folder of [root, secondRoot, storage]) fs.rmSync(folder, { recursive: true, force: true })
  })

  test("indexes multiple roots, labels skips, finds read_file, and keeps explicit path searches path-only", async function () {
    this.timeout(120000)
    index = new WorkspaceIntelligenceIndex(path.join(storage, "project.sqlite"))
    await index.rebuild()
    const state = index.snapshot
    assert.equal(state.status, "ready")
    assert.ok(state.filesIndexed >= 2)
    assert.ok(state.filesSkipped >= 1, "oversized file is explicitly skipped")
    assert.equal(state.filesPending, 0)
    assert.equal(state.queueDepth, 0)
    assert.equal(state.activeWorkers, 0)
    assert.equal(state.discoveryComplete, true)
    assert.equal(state.symbolProviderCalls, 0, "initial indexing must not request language-service symbols")
    assert.ok(state.peakSourceBytes <= 2 * 1_048_576, "file buffers must be bounded by two workers and the configured file size")
    assert.ok(state.storageBytes > 0, "database size comes from the actual SQLite files")
    console.log("[workspace-index-measurement] " + JSON.stringify({
      filesDiscovered: state.filesDiscovered,
      filesIndexed: state.filesIndexed,
      filesSkipped: state.filesSkipped,
      filesFailed: state.filesFailed,
      durationMs: state.lastIndexDurationMs,
      databaseBytes: state.storageBytes,
      peakFileBufferBytes: state.peakSourceBytes,
      sqliteCacheLimitBytes: state.sqliteCacheLimitBytes,
      symbolsIndexed: state.symbolsIndexed,
      symbolProviderCalls: state.symbolProviderCalls
    }))
    const synchronizedAt = state.lastSynchronized
    await new Promise((resolve) => setTimeout(resolve, 600))
    assert.equal(index.snapshot.lastSynchronized, synchronizedAt, "idle indexes must not schedule recurring scans")

    const literal = await index.search({ query: "read_file", mode: "literal" }, root)
    const repositoryUri = vscode.Uri.file(path.resolve(__dirname, "../../.."))
    const nativeTool = await index.search({ query: "read_file", mode: "literal", limit: 100 }, repositoryUri.toString())
    assert.ok(nativeTool.results.some((hit) => hit.path.endsWith("src/extension/tools/workspace.ts")), "real repository search must locate the native read_file implementation")
    assert.ok(literal.results.some((hit) => hit.path.endsWith("src/extension/tools/workspace.ts") && hit.category === "content" && hit.line && hit.column), JSON.stringify(literal))
    assert.ok((await index.search({ query: "workspace.ts", mode: "path" }, root)).total > 0)
    assert.ok((await index.search({ query: "index-main/src/extension/**/*.ts", mode: "path" }, root)).total > 0)
    assert.ok((await index.search({ query: "workspaceSearchAcceptanceMarker\\s*=\\s*'before'", mode: "regex" }, root)).total > 0)
    const firstPage = await index.search({ query: "export", mode: "literal", limit: 1 }, root)
    const secondPage = await index.search({ query: "export", mode: "literal", limit: 1, offset: 1 }, root)
    assert.ok(firstPage.total > 1)
    assert.notEqual(firstPage.results[0]?.path, secondPage.results[0]?.path)
    const otherRoot = await index.search({ query: "multiRootMarker", mode: "literal" }, secondRoot)
    assert.ok(otherRoot.results.some((hit) => hit.path.endsWith("src/other.ts")))
    assert.ok((await index.search({ query: "foo.bar", mode: "literal" }, secondRoot)).total > 0)
    assert.equal((await index.search({ query: "fooXbar", mode: "literal" }, secondRoot)).total, 0)
    assert.equal((await index.search({ query: "multiRootMarker", mode: "literal" }, root)).total, 0)
    assert.equal((await index.search({ query: "privateCredential", mode: "literal" }, root)).total, 0, ".gitignore files stay outside the index")

    const tools = workspaceTools(root, [], {
      workspaceSearch: index,
      edits: {
        mode: "apply",
        read: async (file) => (await vscode.workspace.openTextDocument(vscode.Uri.file(file))).getText(),
        edit: async () => ({ ok: false, message: "Unused in this test." }),
        editLines: (file, request, save) => applyDocumentLineEdits(file, request, { save, visibility: "background" }),
        create: async () => ({ ok: false, message: "Unused in this test." })
      },
      git: false,
      instructions: false
    })
    assert.ok(tools.tools.some((tool) => tool.name === "search_workspace"))
    const search = await tools.run({ name: "search_workspace", args: { query: "read_file", mode: "literal" } })
    assert.match(search.output, /src\/extension\/tools\/workspace\.ts/)
    const fallback = await tools.run({ name: "find_files", args: { pattern: "read_file" } })
    assert.match(fallback.output, /Automatic symbol\/content fallback/)
    assert.match(fallback.output, /src\/extension\/tools\/workspace\.ts/)
    const pathOnly = await tools.run({ name: "find_files", args: { pattern: "read_file", mode: "path" } })
    assert.equal(pathOnly.output, "No files match.")
    const sourcePath = "src/extension/tools/workspace.ts"
    const sourceText = fs.readFileSync(path.join(root, sourcePath), "utf8")
    const markerLine = sourceText.split(/\r?\n/).findIndex((line) => line.includes("workspaceSearchAcceptanceMarker")) + 1
    const source = await tools.run({ name: "read_file", args: { path: sourcePath, start_line: String(markerLine), end_line: String(markerLine) } })
    const expectedHash = source.output.match(/content_hash: ([^;]+);/)?.[1]
    assert.ok(expectedHash)
    const edit = await tools.run({ name: "edit_lines", args: {
      path: sourcePath,
      expected_hash: expectedHash,
      edits: JSON.stringify([{ operation: "replace", start_line: markerLine, end_line: markerLine, content: ["export const workspaceSearchAcceptanceMarker = 'after'"] }])
    } })
    assert.match(edit.output, /"ok":true/)
    const sourceDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, sourcePath)))
    await sourceDocument.save()
    const changedQuery = { query: "workspaceSearchAcceptanceMarker = 'after'", mode: "literal" as const }
    await waitUntil(async () => (await index.search(changedQuery, root)).results[0]?.source === "index")
    const changedSource = await index.search(changedQuery, root)
    assert.equal(changedSource.results[0]?.source, "index")
    const oldUri = vscode.Uri.file(path.join(secondRoot, "src", "other.ts"))
    const renamedUri = vscode.Uri.file(path.join(secondRoot, "src", "renamed.ts"))
    const rename = new vscode.WorkspaceEdit()
    rename.renameFile(oldUri, renamedUri)
    assert.equal(await vscode.workspace.applyEdit(rename), true)
    await waitUntil(async () => (await index.search({ query: "multiRootMarker", mode: "literal" }, secondRoot)).results.some((hit) => hit.path.endsWith("src/renamed.ts")))
    const renamed = await index.search({ query: "multiRootMarker", mode: "literal" }, secondRoot)
    assert.ok(renamed.results.some((hit) => hit.path.endsWith("src/renamed.ts")))
    const remove = new vscode.WorkspaceEdit()
    remove.deleteFile(renamedUri)
    if (!(await vscode.workspace.applyEdit(remove))) {
      await vscode.workspace.fs.delete(renamedUri)
      await index.rebuild()
    }
    await waitUntil(async () => (await index.search({ query: "multiRootMarker", mode: "literal" }, secondRoot)).total === 0)
    const uri = vscode.Uri.file(path.join(root, "src", "native.ts"))
    const document = await vscode.workspace.openTextDocument(uri)
    const editor = await vscode.window.showTextDocument(document)
    const start = document.getText().indexOf("read_file")
    await editor.edit((builder) => builder.replace(new vscode.Range(document.positionAt(start), document.positionAt(start + "read_file".length)), "read_file_dirty"))
    const live = await index.search({ query: "read_file_dirty", mode: "literal" }, root)
    assert.equal(live.results[0]?.source, "live")
    await document.save()
    await waitUntil(async () => (await index.search({ query: "read_file_dirty", mode: "literal" }, root)).results[0]?.source === "index")
    const saved = await index.search({ query: "read_file_dirty", mode: "literal" }, root)
    assert.equal(saved.results[0]?.source, "index", JSON.stringify({ state: index.snapshot, dirty: document.isDirty, result: saved.results[0] }))

    const lastSync = index.snapshot.lastSynchronized
    index.dispose()
    index = new WorkspaceIntelligenceIndex(path.join(storage, "project.sqlite"))
    const restored = await index.search({ query: "read_file_dirty", mode: "literal" }, root)
    assert.ok(restored.total > 0)
    assert.equal(index.snapshot.lastSynchronized, lastSync)

    await index.clearAndRebuild()
    assert.ok((await index.search({ query: "read_file_dirty", mode: "literal" }, root)).total > 0)
    assert.ok((await index.search({ query: "workspaceSearchAcceptanceMarker = 'after'", mode: "literal" }, root)).total > 0)
    assert.equal(fs.readFileSync(path.join(storage, "twinny-state.sqlite"), "utf8"), "durable TODO database sentinel", "the index leaves unrelated files in its storage directory alone")

    fs.mkdirSync(path.join(root, "test"), { recursive: true })
    fs.writeFileSync(path.join(root, "src", "extension", "tools", "registry.ts"), "export function read_file(path: string) { return path }\nexport const tools = [{ name: \"read_file\" }]\n")
    fs.writeFileSync(path.join(root, "test", "registry.test.ts"), "read_file('a')\nread_file('b')\n")
    await index.rebuild()

    const scoped = await index.search({ query: "read_file", mode: "auto", path: "src" }, root)
    assert.ok(scoped.total > 0, "a bare directory filter must match nested files")
    assert.ok(scoped.results.every((hit) => /(^|\/)src\//.test(hit.path)), "directory filter keeps only its subtree")
    assert.ok(scoped.results.some((hit) => hit.path.endsWith("src/extension/tools/registry.ts")))
    assert.ok((await index.search({ query: "read_file", mode: "auto", path: "src/extension/tools/" }, root)).total > 0, "trailing slash is accepted")
    assert.ok((await index.search({ query: "read_file", mode: "auto", path: "./src/**/*.ts" }, root)).total > 0, "glob filters still apply")
    assert.ok((await index.search({ query: "read_file", mode: "auto", path: "src/extension" }, root)).total > 0)

    const unfiltered = await index.search({ query: "read_file", mode: "auto" }, root)
    assert.ok(unfiltered.total > scoped.total, "unfiltered search still includes test files")
    const firstContent = unfiltered.results.find((hit) => hit.category === "content")
    assert.ok(firstContent && !/(^|\/)test\//.test(firstContent.path), "source definitions rank above test references")

    const pageOne = await index.search({ query: "read_file", mode: "auto", path: "src", limit: 1 }, root)
    assert.equal(pageOne.results.length, 1)
    assert.equal(pageOne.total, scoped.total, "pagination keeps the filtered total")

    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right)
    const globalState: vscode.Memento & { setKeysForSync(keys: readonly string[]): void } = {
      keys: () => [],
      setKeysForSync: () => {},
      get: <T>(_key: string, defaultValue?: T) => defaultValue,
      update: async () => {}
    }
    const statusBar = new TwinnyStatusBar(item, { globalState }, new GenerationTracker(), index)
    const tooltip = () => typeof item.tooltip === "string" ? item.tooltip : item.tooltip?.value ?? ""
    try {
      statusBar.refresh()
      assert.equal(item.command, TWINNY_COMMAND_NAME.statusBarMenu)
      assert.match(tooltip(), /Workspace index: ready/)
      assert.match(tooltip(), /Auto-suggest is (on|off)/)
      assert.ok(tooltip().includes(`${index.snapshot.filesIndexed} files indexed`))
      assert.match(tooltip(), /last sync /)
      const displayedSync = index.snapshot.lastSynchronized
      assert.ok(displayedSync)
      assert.ok(!tooltip().includes(displayedSync))

      let stateChanges = 0
      const stateSubscription = index.onDidChange(() => stateChanges++)
      await index.pause()
      await new Promise((resolve) => setTimeout(resolve, 350))
      assert.match(tooltip(), /Workspace index: paused/)
      assert.ok(item.text.includes("debug-pause"))
      const changesAfterPausing = stateChanges
      await index.pause()
      assert.equal(stateChanges, changesAfterPausing, "unchanged index state should not refresh the status item")
      stateSubscription.dispose()
    const waitForState = (predicate: (state: WorkspaceIntelligenceIndex["snapshot"]) => boolean, description: string) => new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timeout)
        subscription.dispose()
        if (error) reject(error)
        else resolve()
      }
      const subscription = index.onDidChange((current) => {
        if (predicate(current)) finish()
      })
      const timeout = setTimeout(() => finish(new Error(`Timed out waiting for ${description}`)), 15000)
      if (predicate(index.snapshot)) finish()
    })
    const scanStarted = waitForState((current) => current.status === "scanning" || current.status === "indexing", "scan start")
    await index.pause()
    await index.resume()
    await scanStarted
    const scanStopped = waitForState((current) => current.status === "paused" && current.activeWorkers === 0 && current.activeSourceBytes === 0, "cancelled workers to stop")
    await index.pause()
    await scanStopped
    assert.equal(index.snapshot.queueDepth, 0, "pause clears discovered work immediately")
    const resumed = waitForState((current) => current.status === "ready" && current.discoveryComplete, "resumed scan completion")
    await index.resume()
    await resumed
    } finally {
      statusBar.dispose()
    }
  })

  test("a file outside the workspace folders is refused until its folder is allowed", async function () {
    this.timeout(120000)
    const target = path.join(storage, "outside.ts")
    const apply = editorEdits(new WorkspaceView(root), "apply", async () => true)

    const refused = await apply.create(target, "export const x = 1\n")
    assert.equal(refused.ok, false, "the storage folder is outside every one of the three")
    assert.match(refused.message, /outside the workspace/)

    const previous = vscode.workspace.getConfiguration("twinny").get<string[]>("chatToolsAllowedPaths", [])
    try {
      await vscode.workspace.getConfiguration("twinny").update("chatToolsAllowedPaths", [storage], vscode.ConfigurationTarget.Global)
      const created = await apply.create(target, "export const x = 1\n")
      assert.ok(created.ok, created.message)
      assert.equal(fs.readFileSync(target, "utf8"), "export const x = 1\n")
    } finally {
      await vscode.workspace.getConfiguration("twinny").update("chatToolsAllowedPaths", previous, vscode.ConfigurationTarget.Global)
    }
  })

  test("the index lives in the project database: after rebuild the file holds indexed documents and PRAGMA user_version is 20", async function () {
    this.timeout(120000)
    const databasePath = path.join(storage, "project.sqlite")
    index = new WorkspaceIntelligenceIndex(databasePath)
    await index.rebuild()
    assert.equal(index.snapshot.status, "ready")
    assert.ok(index.snapshot.filesIndexed > 0)
    // The index connection is closed first so the read-only open reads a checkpointed database.
    index.dispose()
    const database = new BetterSqlite(databasePath, { readonly: true, fileMustExist: true })
    try {
      assert.equal(database.pragma("user_version", { simple: true }), 20, "the schema version belongs to todos/sqlite.ts")
      const tables = new Set((database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name))
      assert.ok(tables.has("documents") && tables.has("todo_items"), "one database holds both table groups")
      assert.ok((database.prepare("SELECT COUNT(*) AS n FROM documents").get() as { n: number }).n > 0, "the rebuilt file holds indexed documents")
    } finally {
      database.close()
    }
  })

  test("deleting the database files and rebuilding recreates the index tables and the TODO tables", async function () {
    this.timeout(120000)
    const databasePath = path.join(storage, "project.sqlite")
    index = new WorkspaceIntelligenceIndex(databasePath)
    await index.rebuild()
    assert.ok((await index.search({ query: "multiRootMarker", mode: "literal" }, secondRoot)).total > 0, "the first rebuild wrote the index tables")
    index.dispose()
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${databasePath}${suffix}`, { force: true })
    assert.equal(fs.existsSync(databasePath), false, "the project database files were deleted")
    index = new WorkspaceIntelligenceIndex(databasePath)
    await index.rebuild()
    assert.ok((await index.search({ query: "multiRootMarker", mode: "literal" }, secondRoot)).total > 0, "the index tables were recreated")
    const repository = new TodoRepository(databasePath)
    try {
      const scope = { projectFingerprint: PROJECT_FINGERPRINT, conversationId: "index-suite-conversation", writer: "index-suite-conversation" }
      const created = await repository.createItem(scope, { title: "TODO work on the same file" }, "index-suite-create")
      assert.equal((await repository.getList(scope)).items[0]?.id, created.id, "a TodoRepository on the same path works afterwards")
    } finally {
      repository.close()
    }
  })
  test("refresh makes an edited file searchable immediately, with no polling", async function () {
    this.timeout(120000)
    index = new WorkspaceIntelligenceIndex(path.join(storage, "project.sqlite"))
    const file = path.join(root, "refresh-search.ts")
    fs.writeFileSync(file, "export const refreshToken = 'before'\n")
    assert.deepEqual(await index.refresh([{ path: file, kind: "write" }]), { status: "synced" })
    const before = await index.search({ query: "refreshToken = 'before'", mode: "literal" }, root)
    assert.ok(before.results.some((hit) => hit.path.endsWith("refresh-search.ts") && hit.source === "index"), JSON.stringify(before))
    fs.writeFileSync(file, "export const refreshToken = 'after'\n")
    assert.deepEqual(await index.refresh([{ path: file, kind: "write" }]), { status: "synced" })
    const after = await index.search({ query: "refreshToken = 'after'", mode: "literal" }, root)
    assert.ok(after.results.some((hit) => hit.path.endsWith("refresh-search.ts")), JSON.stringify(after))
    assert.equal((await index.search({ query: "refreshToken = 'before'", mode: "literal" }, root)).total, 0, "the replaced token is gone at once, with no polling")
  })

  test("refresh of a created file finds it at once and refresh of a deleted file removes it at once", async function () {
    this.timeout(120000)
    index = new WorkspaceIntelligenceIndex(path.join(storage, "project.sqlite"))
    const file = path.join(root, "src", "created-by-refresh.ts")
    fs.writeFileSync(file, "export const created_by_refresh = 1\n")
    assert.deepEqual(await index.refresh([{ path: file, kind: "write" }]), { status: "synced" })
    assert.ok((await index.search({ query: "created-by-refresh", mode: "path" }, root)).total > 0, "the path search finds the new file at once")
    assert.ok((await index.search({ query: "created_by_refresh", mode: "literal" }, root)).total > 0, "the content search finds it at once")
    fs.rmSync(file)
    assert.deepEqual(await index.refresh([{ path: file, kind: "delete" }]), { status: "synced" })
    assert.equal((await index.search({ query: "created-by-refresh", mode: "path" }, root)).total, 0, "the path search is empty at once")
    assert.equal((await index.search({ query: "created_by_refresh", mode: "literal" }, root)).total, 0, "the content search is empty at once")
    assert.deepEqual(await index.refresh([{ path: path.join(root, "src", "never-indexed.ts"), kind: "delete" }]), { status: "synced" }, "a delete with no row is a synced no-op")
  })

  test("refresh does not wait for a running scan and a refreshed new file survives that scan's sweep", async function () {
    this.timeout(120000)
    index = new WorkspaceIntelligenceIndex(path.join(storage, "project.sqlite"))
    const config = vscode.workspace.getConfiguration("twinny")
    const previousAuto = config.get<boolean>("indexing.auto", true)
    // The watchers are turned off for this test so the only row for the extra file is the one refresh writes.
    try {
      await config.update("indexing.auto", false, vscode.ConfigurationTarget.Global)
      // Let the configuration event settle before the scan starts, so the change handler cannot cancel it.
      await new Promise((resolve) => setTimeout(resolve, 500))
      const load = path.join(root, "scanload")
      fs.mkdirSync(load, { recursive: true })
      for (let file = 0; file < 300; file++) fs.writeFileSync(path.join(load, `load${file}.ts`), `export const scanLoad${file} = 1\n`)
      const scan = index.rebuild()
      // Workers still active means the scan is mid-discovery, so the survivor is ahead of that sweep.
      await waitUntil(async () => (index.snapshot.status === "scanning" || index.snapshot.status === "indexing") && index.snapshot.filesDiscovered >= 300 && index.snapshot.activeWorkers > 0 && !index.snapshot.discoveryComplete)
      assert.ok(!index.snapshot.discoveryComplete, "the scan was still running when the extra file was created")
      const survivor = path.join(load, "survivor.ts")
      fs.writeFileSync(survivor, "export const survivesTheSweep = 1\n")
      assert.deepEqual(await index.refresh([{ path: survivor, kind: "write" }]), { status: "synced" })
      assert.ok(!index.snapshot.discoveryComplete, "the refresh answered while that scan was still running")
      await scan
      assert.ok((await index.search({ query: "survivor.ts", mode: "path" }, root)).total > 0, "the refreshed row survived the end-of-scan sweep")
      assert.ok((await index.search({ query: "survivesTheSweep", mode: "literal" }, root)).total > 0)
    } finally {
      await config.update("indexing.auto", previousAuto, vscode.ConfigurationTarget.Global)
    }
  })

  test("refresh is skipped with a reason outside the indexed workspace folders and when indexing is disabled", async function () {
    this.timeout(120000)
    index = new WorkspaceIntelligenceIndex(path.join(storage, "project.sqlite"))
    assert.deepEqual(await index.refresh([{ path: path.join(storage, "outside.ts"), kind: "write" }]), { status: "skipped", reason: "outside the indexed workspace folders" })
    const config = vscode.workspace.getConfiguration("twinny")
    const previous = config.get<boolean>("indexing.enabled", true)
    try {
      await config.update("indexing.enabled", false, vscode.ConfigurationTarget.Global)
      assert.deepEqual(await index.refresh([{ path: path.join(root, "src", "native.ts"), kind: "write" }]), { status: "skipped", reason: "indexing is disabled" })
    } finally {
      await config.update("indexing.enabled", previous, vscode.ConfigurationTarget.Global)
    }
  })

  test("a refresh of a missing file written as \"write\" reports failed with a reason", async function () {
    this.timeout(120000)
    index = new WorkspaceIntelligenceIndex(path.join(storage, "project.sqlite"))
    const missing = path.join(root, "src", "missing-for-refresh.ts")
    const outcome = await index.refresh([{ path: missing, kind: "write" }])
    assert.equal(outcome.status, "failed", JSON.stringify(outcome))
    const reason = outcome.status === "failed" ? outcome.reason : ""
    assert.match(reason, /missing-for-refresh\.ts/, "the reason names the file")
    assert.match(reason, /FileNotFound|ENOENT|could not be indexed/, "and says why")
  })

  test("oversized, binary and non-UTF-8 files keep their skip rows after a full scan", async function () {
    this.timeout(120000)
    const databasePath = path.join(storage, "project.sqlite")
    index = new WorkspaceIntelligenceIndex(databasePath)
    fs.writeFileSync(path.join(root, "oversized.txt"), "x".repeat(1_100_000))
    fs.writeFileSync(path.join(root, "binary.bin"), new Uint8Array([0x6e, 0x6f, 0x00]))
    fs.writeFileSync(path.join(root, "invalid-utf8.bin"), new Uint8Array([0xff, 0xfe, 0x0a]))
    await index.rebuild()
    const reported = index.snapshot.filesSkipped
    assert.ok(reported >= 4, `the scan reported ${reported} skipped files`)
    // The index connection is closed first so the read-only open reads a checkpointed database.
    index.dispose()
    const database = new BetterSqlite(databasePath, { readonly: true, fileMustExist: true })
    try {
      const rows = database.prepare("SELECT filename, skip_reason FROM documents WHERE skip_reason IS NOT NULL ORDER BY filename").all() as Array<{ filename: string; skip_reason: string }>
      assert.equal(rows.length, reported, "the scan's sweep left every skip row alone")
      const reasons = new Map(rows.map((row) => [row.filename, row.skip_reason]))
      assert.equal(reasons.get("oversized.txt"), "file exceeds configured size limit")
      assert.equal(reasons.get("binary.bin"), "binary content")
      assert.equal(reasons.get("invalid-utf8.bin"), "file is not valid UTF-8 text")
    } finally {
      database.close()
    }
  })

  test("a slower scan never overwrites a newer refreshed entry", async function () {
    this.timeout(120000)
    const databasePath = path.join(storage, "project.sqlite")
    index = new WorkspaceIntelligenceIndex(databasePath)
    const file = path.join(root, "src", "newer-row.ts")
    fs.writeFileSync(file, "export const newerRowMarker = 1\n")
    assert.deepEqual(await index.refresh([{ path: file, kind: "write" }]), { status: "synced" })
    const uri = vscode.Uri.file(file).toString()
    const database = new BetterSqlite(databasePath)
    try {
      database.pragma("busy_timeout = 5000")
      const select = "SELECT mtime_ms FROM documents WHERE uri = ?"
      const row = database.prepare(select).get(uri) as { mtime_ms: number | null } | undefined
      assert.ok(row, "the refresh wrote the row")
      const newer = (row?.mtime_ms ?? 0) + 60_000
      database.prepare("UPDATE documents SET mtime_ms = ? WHERE uri = ?").run(newer, uri)
      assert.deepEqual(await index.refresh([{ path: file, kind: "write" }]), { status: "synced" })
      assert.equal((database.prepare(select).get(uri) as { mtime_ms: number | null }).mtime_ms, newer, "the newer row was left alone")
    } finally {
      database.close()
    }
  })

  test("edit_lines is visible to search_workspace immediately after it returns", async function () {
    this.timeout(120000)
    index = new WorkspaceIntelligenceIndex(path.join(storage, "project.sqlite"))
    const target = path.join(root, "src", "immediate-visibility.ts")
    fs.writeFileSync(target, "export const stageEightToken = 'before'\n")
    assert.deepEqual(await index.refresh([{ path: target, kind: "write" }]), { status: "synced" }, "the file starts in the index")
    const tools = workspaceTools(root, [], {
      workspaceSearch: index,
      edits: editorEdits(new WorkspaceView(root), "apply", async () => true, undefined, { refreshIndex: index.refresh.bind(index) }),
      git: false,
      instructions: false
    })
    const read = await tools.run({ name: "read_file", args: { path: "src/immediate-visibility.ts" } })
    const expectedHash = read.output.match(/content_hash: ([^;]+);/)?.[1]
    assert.ok(expectedHash, read.output)
    const edit = await tools.run({ name: "edit_lines", args: { path: "src/immediate-visibility.ts", expected_hash: expectedHash, edits: JSON.stringify([{ operation: "replace", start_line: 1, end_line: 1, content: ["export const stageEightToken = 'after'"] }]) } })
    assert.ok(!edit.failed, edit.output)
    const found = JSON.parse(edit.output)
    assert.equal(found.index_refresh, undefined, "the sink refreshed this file through the wired provider")
    const search = await tools.run({ name: "search_workspace", args: { query: "stageEightToken = 'after'", mode: "literal" } })
    const hits = JSON.parse(search.output) as { total: number; results: Array<{ path: string; source: string }> }
    assert.ok(hits.total > 0, "search_workspace finds the new token at once, with no polling: " + search.output)
    assert.ok(hits.results.some((hit) => hit.path.endsWith("immediate-visibility.ts") && hit.source === "index"), "and from the index, not from a live read: " + search.output)
    const gone = await tools.run({ name: "search_workspace", args: { query: "stageEightToken = 'before'", mode: "literal" } })
    assert.equal(JSON.parse(gone.output).total, 0, "the replaced token is gone at once")
  })

})
