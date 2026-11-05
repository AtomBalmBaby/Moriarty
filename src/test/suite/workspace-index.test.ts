import * as assert from "assert"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import * as vscode from "vscode"

import { TWINNY_COMMAND_NAME } from "../../common/constants"
import { applyDocumentLineEdits } from "../../extension/edit/line-edit"
import { GenerationTracker } from "../../extension/generations"
import { TwinnyStatusBar } from "../../extension/status-bar"
import { workspaceTools } from "../../extension/tools/workspace"
import { WorkspaceIntelligenceIndex } from "../../extension/workspace-index"

suite("Persistent workspace intelligence index", () => {
  let root: string
  let secondRoot: string
  let storage: string
  let originalFolders: Array<{ uri: vscode.Uri; name: string }>
  let index: WorkspaceIntelligenceIndex

  setup(async () => {
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
    const changed = vscode.workspace.updateWorkspaceFolders(
      0,
      originalFolders.length,
      { uri: vscode.Uri.file(root), name: "index-main" },
      { uri: vscode.Uri.file(secondRoot), name: "index-secondary" },
      { uri: repositoryRoot, name: "twinny-repository" }
    )
    assert.equal(changed, true)
  })

  teardown(async () => {
    index?.dispose()
    const currentCount = vscode.workspace.workspaceFolders?.length ?? 0
    vscode.workspace.updateWorkspaceFolders(0, currentCount, ...originalFolders)
    for (const document of vscode.workspace.textDocuments.filter((entry) => entry.uri.fsPath.startsWith(root + path.sep) || entry.uri.fsPath.startsWith(secondRoot + path.sep))) {
      await vscode.window.showTextDocument(document)
      await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor")
    }
    for (const folder of [root, secondRoot, storage]) fs.rmSync(folder, { recursive: true, force: true })
  })

  test("indexes multiple roots, labels skips, finds read_file, and keeps explicit path searches path-only", async function () {
    this.timeout(120000)
    index = new WorkspaceIntelligenceIndex(vscode.Uri.file(storage))
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
        editLines: applyDocumentLineEdits,
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
    const source = await tools.run({ name: "read_file", args: { path: sourcePath } })
    const expectedHash = source.output.match(/content_hash: ([^;]+);/)?.[1]
    assert.ok(expectedHash)
    const sourceText = fs.readFileSync(path.join(root, sourcePath), "utf8")
    const markerLine = sourceText.split(/\r?\n/).findIndex((line) => line.includes("workspaceSearchAcceptanceMarker")) + 1
    const edit = await tools.run({ name: "edit_lines", args: {
      path: sourcePath,
      expected_hash: expectedHash,
      edits: JSON.stringify([{ operation: "replace", start_line: markerLine, end_line: markerLine, content: ["export const workspaceSearchAcceptanceMarker = 'after'"] }])
    } })
    assert.match(edit.output, /"ok":true/)
    const sourceDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, sourcePath)))
    await sourceDocument.save()
    await new Promise((resolve) => setTimeout(resolve, 600))
    const changedSource = await index.search({ query: "workspaceSearchAcceptanceMarker = 'after'", mode: "literal" }, root)
    assert.equal(changedSource.results[0]?.source, "index")
    const oldUri = vscode.Uri.file(path.join(secondRoot, "src", "other.ts"))
    const renamedUri = vscode.Uri.file(path.join(secondRoot, "src", "renamed.ts"))
    const rename = new vscode.WorkspaceEdit()
    rename.renameFile(oldUri, renamedUri)
    assert.equal(await vscode.workspace.applyEdit(rename), true)
    await new Promise((resolve) => setTimeout(resolve, 600))
    const renamed = await index.search({ query: "multiRootMarker", mode: "literal" }, secondRoot)
    assert.ok(renamed.results.some((hit) => hit.path.endsWith("src/renamed.ts")))
    const remove = new vscode.WorkspaceEdit()
    remove.deleteFile(renamedUri)
    if (!(await vscode.workspace.applyEdit(remove))) {
      await vscode.workspace.fs.delete(renamedUri)
      await index.rebuild()
    }
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.equal((await index.search({ query: "multiRootMarker", mode: "literal" }, secondRoot)).total, 0)
    const uri = vscode.Uri.file(path.join(root, "src", "native.ts"))
    const document = await vscode.workspace.openTextDocument(uri)
    const editor = await vscode.window.showTextDocument(document)
    const start = document.getText().indexOf("read_file")
    await editor.edit((builder) => builder.replace(new vscode.Range(document.positionAt(start), document.positionAt(start + "read_file".length)), "read_file_dirty"))
    const live = await index.search({ query: "read_file_dirty", mode: "literal" }, root)
    assert.equal(live.results[0]?.source, "live")
    await document.save()
    await new Promise((resolve) => setTimeout(resolve, 600))
    const saved = await index.search({ query: "read_file_dirty", mode: "literal" }, root)
    assert.equal(saved.results[0]?.source, "index", JSON.stringify({ state: index.snapshot, dirty: document.isDirty, result: saved.results[0] }))

    const lastSync = index.snapshot.lastSynchronized
    index.dispose()
    index = new WorkspaceIntelligenceIndex(vscode.Uri.file(storage))
    const restored = await index.search({ query: "read_file_dirty", mode: "literal" }, root)
    assert.ok(restored.total > 0)
    assert.equal(index.snapshot.lastSynchronized, lastSync)

    await index.clearAndRebuild()
    assert.ok((await index.search({ query: "read_file_dirty", mode: "literal" }, root)).total > 0)
    assert.ok((await index.search({ query: "workspaceSearchAcceptanceMarker = 'after'", mode: "literal" }, root)).total > 0)
    assert.equal(fs.readFileSync(path.join(storage, "twinny-state.sqlite"), "utf8"), "durable TODO database sentinel")

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
})
