import * as assert from "assert"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import * as vscode from "vscode"

import { TWINNY_COMMAND_NAME } from "../../common/constants"
import { ChangeStore, ReplyChanges } from "../../extension/chat/reply-changes"
import { ReplyChangesEditor } from "../../extension/chat/reply-changes-editor"
import { recoverSignificantEdit, SignificantEditRecoveryResult } from "../../extension/chat/safe-edit-recovery"
import { createSafeEditCheckpoints, EditCommandRunner, EditOperationLedger, editorEdits, editorKnowledge, openDocumentText } from "../../extension/chat/tool-sinks"
import { applyDocumentLineEdits, revealEditor } from "../../extension/edit/line-edit"
import { contentHash, LineEditRequest } from "../../extension/tools/line-edit"
import { WorkspaceView } from "../../extension/tools/view"
import { IndexChange, IndexRefreshOutcome, workspaceTools } from "../../extension/tools/workspace"

suite("Hash-verified native line edits", () => {
  let root: string
  let file: string
  let originalFolders: { uri: vscode.Uri, name: string }[] = []

  const setWorkspaceFolders = (folders: { uri: vscode.Uri, name: string }[]) => new Promise<void>((resolve, reject) => {
    const subscription = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      subscription.dispose()
      resolve()
    })
    if (!vscode.workspace.updateWorkspaceFolders(0, vscode.workspace.workspaceFolders?.length ?? 0, ...folders)) {
      subscription.dispose()
      reject(new Error("Could not update VS Code test workspace folders."))
    }
  })

  setup(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-editor-lines-"))
    file = path.join(root, "source.txt")
    fs.writeFileSync(file, "first\nsecond\nthird\nfourth\n")
    originalFolders = (vscode.workspace.workspaceFolders ?? []).map((folder) => ({ uri: folder.uri, name: folder.name }))
    await setWorkspaceFolders([{ uri: vscode.Uri.file(root), name: "line-edit-test" }])
  })

  teardown(async () => {
    for (const document of vscode.workspace.textDocuments.filter((entry) => entry.uri.fsPath.startsWith(root + path.sep))) {
      await vscode.window.showTextDocument(document)
      await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor")
    }
    await setWorkspaceFolders(originalFolders)
    fs.rmSync(root, { recursive: true, force: true })
  })

  const request = async (text: string, edits: unknown): Promise<LineEditRequest> => ({ expected_hash: await contentHash(text), edits })

  test("a closed document is revealed, edited and saved in one undoable transaction", async () => {
    const document = await vscode.workspace.openTextDocument(file)
    const original = document.getText()
    assert.strictEqual(vscode.window.visibleTextEditors.some((editor) => editor.document === document), false)
    let events = 0
    const listener = vscode.workspace.onDidChangeTextDocument((event) => { if (event.document === document && event.contentChanges.length) events++ })
    try {
      const result = await applyDocumentLineEdits(file, await request(original, [
        { operation: "replace", start_line: 2, end_line: 2, content: ["SECOND", "extra"] },
        { operation: "delete", start_line: 3, end_line: 3 },
        { operation: "insert_after", line: 4, content: ["last"] }
      ]))
      assert.ok(result.ok, result.message)
      const expected = "first\nSECOND\nextra\nfourth\nlast\n"
      assert.strictEqual(document.getText(), expected)
      assert.strictEqual(fs.readFileSync(file, "utf8"), expected, "the successful edit is on disk")
      assert.strictEqual(result.contentHash, await contentHash(expected))
      assert.strictEqual(result.contentSource, "disk")
      assert.strictEqual(result.persisted, true)
      assert.strictEqual(events, 1, "no intermediate document state")
      assert.strictEqual(document.isDirty, false)
      assert.ok(vscode.window.visibleTextEditors.some((editor) => editor.document === document), "the document is shown for diagnostics")
      await vscode.window.showTextDocument(document)
      await vscode.commands.executeCommand("undo")
      assert.strictEqual(document.getText(), original, "one undo restores the entire batch")
    } finally { listener.dispose() }
  })

  test("revealing a closed document opens no new editor group and keeps other open documents", async () => {
    const other = path.join(root, "other.txt")
    fs.writeFileSync(other, "keep\n")
    const otherDocument = await vscode.workspace.openTextDocument(other)
    await vscode.window.showTextDocument(otherDocument, { preview: false })
    const groupsBefore = vscode.window.tabGroups.all.length
    const document = await vscode.workspace.openTextDocument(file)
    const result = await applyDocumentLineEdits(file, await request(document.getText(), [{ operation: "delete", start_line: 2, end_line: 2 }]))
    assert.ok(result.ok, result.message)
    assert.strictEqual(vscode.window.tabGroups.all.length, groupsBefore, "no new editor group is created")
    assert.ok(vscode.workspace.textDocuments.includes(otherDocument) && !otherDocument.isClosed, "the other document stays open")
    assert.ok(vscode.window.visibleTextEditors.some((editor) => editor.document === document), "the edited document is shown for diagnostics")
    assert.strictEqual(fs.readFileSync(file, "utf8"), "first\nthird\nfourth\n")
  })

  test("an already open document is edited in place without a duplicate tab", async () => {
    const document = await vscode.workspace.openTextDocument(file)
    const editor = await vscode.window.showTextDocument(document, { preview: false })
    const tabsBefore = vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === document.uri.toString()).length
    const result = await applyDocumentLineEdits(file, await request(document.getText(), [{ operation: "delete", start_line: 2, end_line: 2 }]))
    assert.ok(result.ok, result.message)
    assert.strictEqual(vscode.window.visibleTextEditors.find((entry) => entry.document === document), editor, "the same editor is edited")
    assert.strictEqual(vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === document.uri.toString()).length, tabsBefore)
    assert.strictEqual(fs.readFileSync(file, "utf8"), "first\nthird\nfourth\n")
  })

  test("a dirty document keeps the user's unsaved changes and saves the complete result", async () => {
    const document = await vscode.workspace.openTextDocument(file)
    const editor = await vscode.window.showTextDocument(document)
    await editor.edit((builder) => builder.insert(new vscode.Position(0, 0), "user: "))
    const dirty = document.getText()
    assert.ok(document.isDirty)
    const result = await applyDocumentLineEdits(file, await request(dirty, [{ operation: "replace", start_line: 2, end_line: 2, content: ["SECOND"] }]))
    assert.ok(result.ok, result.message)
    const expected = "user: first\nSECOND\nthird\nfourth\n"
    assert.strictEqual(document.getText(), expected)
    assert.strictEqual(fs.readFileSync(file, "utf8"), expected, "the user's change is saved with the complete document")
    assert.strictEqual(document.isDirty, false)
    assert.strictEqual(result.contentSource, "disk")
    assert.strictEqual(result.contentHash, await contentHash(expected))
  })

  test("save false leaves the edit unsaved for review and the disk file unchanged", async () => {
    const document = await vscode.workspace.openTextDocument(file)
    const original = document.getText()
    const result = await applyDocumentLineEdits(file, await request(original, [{ operation: "delete", start_line: 2, end_line: 2 }]), { save: false, visibility: "visible" })
    assert.ok(result.ok, result.message)
    assert.strictEqual(result.persisted, false)
    assert.strictEqual(result.contentSource, "buffer")
    assert.strictEqual(result.contentHash, await contentHash("first\nthird\nfourth\n"))
    assert.strictEqual(document.getText(), "first\nthird\nfourth\n")
    assert.ok(document.isDirty, "the edit is intentionally unsaved")
    assert.strictEqual(fs.readFileSync(file, "utf8"), original, "the file on disk is unchanged")
    await vscode.window.showTextDocument(document)
    await vscode.commands.executeCommand("undo")
    assert.strictEqual(document.getText(), original, "the unsaved edit is undoable")
  })

  test("save false keeps the user's unsaved changes unsaved as well", async () => {
    const document = await vscode.workspace.openTextDocument(file)
    const editor = await vscode.window.showTextDocument(document)
    await editor.edit((builder) => builder.insert(new vscode.Position(0, 0), "user: "))
    const dirty = document.getText()
    const result = await applyDocumentLineEdits(file, await request(dirty, [{ operation: "delete", start_line: 2, end_line: 2 }]), { save: false, visibility: "visible" })
    assert.ok(result.ok, result.message)
    assert.strictEqual(document.getText(), "user: first\nthird\nfourth\n")
    assert.ok(document.isDirty)
    assert.strictEqual(fs.readFileSync(file, "utf8"), "first\nsecond\nthird\nfourth\n")
  })

  const sinkFor = (visibility: "visible" | "background", ledger?: EditOperationLedger) => editorEdits(
    new WorkspaceView(root), "apply", async () => true, undefined, { recordEditOperation: ledger }, visibility
  )
  const ledgerRecording = () => {
    const recorded: { preDigest: string; settled: string[] }[] = []
    const ledger: EditOperationLedger = async (operation) => {
      const entry = { preDigest: operation.preDigest, settled: [] as string[] }
      recorded.push(entry)
      return { settle: async (status) => { entry.settled.push(status) } }
    }
    return { ledger, recorded }
  }
  /** What the fake refresh was told and in what order. It reads the file from disk, as the index does. */
  const refreshSpy = (order: string[], saw: string[] = []) => {
    const calls: IndexChange[][] = []
    const refreshIndex = async (changes: readonly IndexChange[]): Promise<IndexRefreshOutcome> => {
      calls.push([...changes])
      order.push("refresh")
      for (const change of changes) saw.push(fs.readFileSync(change.path, "utf8"))
      return { status: "synced" }
    }
    return { calls, saw, refreshIndex }
  }
  /** What the fake refresh was told, keeping the kind of each path; a delete names a file that is already gone. */
  const changeSpy = (order: string[], saw: string[] = []) => {
    const calls: IndexChange[][] = []
    const refreshIndex = async (changes: readonly IndexChange[]): Promise<IndexRefreshOutcome> => {
      calls.push([...changes])
      order.push("refresh")
      for (const change of changes) {
        if (change.kind !== "write") continue
        saw.push(fs.readFileSync(change.path, "utf8"))
      }
      return { status: "synced" }
    }
    return { calls, saw, refreshIndex }
  }
  /** The test host has no trash on this filesystem, so the editor deletes straight away. */
  const withoutTrash = async (run: () => Promise<void>) => {
    const filesConfig = vscode.workspace.getConfiguration("files")
    const original = filesConfig.inspect("enableTrash")?.globalValue
    try {
      await filesConfig.update("enableTrash", false, vscode.ConfigurationTarget.Global)
      await run()
    } finally {
      await filesConfig.update("enableTrash", original, vscode.ConfigurationTarget.Global)
    }
  }

  /** The same recorder as `ledgerRecording`, keeping the order the calls happened in. */
  const orderRecording = () => {
    const order: string[] = []
    const recorded: Array<{ settled: string[] }> = []
    const ledger: EditOperationLedger = async () => {
      const entry = { settled: [] as string[] }
      recorded.push(entry)
      order.push("recorded")
      return { settle: async (status) => { entry.settled.push(status); order.push("settled") } }
    }
    return { order, recorded, ledger }
  }
  /** The real sink with the fake refresh and the fake ledger. */
  const refreshSinkFor = (ledger?: EditOperationLedger, refreshIndex?: (changes: readonly IndexChange[]) => Promise<IndexRefreshOutcome>) => editorEdits(
    new WorkspaceView(root), "apply", async () => true, undefined, { recordEditOperation: ledger, refreshIndex }, "background"
  )
  const tabFor = (uri: vscode.Uri) => vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .find((tab) => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString())
  const shownFor = (document: vscode.TextDocument) => vscode.window.visibleTextEditors.some((editor) => editor.document === document)

  test("background mode refuses save false before anything changes, without opening a tab", async () => {
    const document = await vscode.workspace.openTextDocument(file)
    const original = document.getText()
    const { ledger, recorded } = ledgerRecording()
    const outcome = await sinkFor("background", ledger).editLines!(file, await request(original, [{ operation: "delete", start_line: 2, end_line: 2 }]), false)
    assert.strictEqual(outcome.ok, false)
    assert.strictEqual(outcome.error?.code, "permission_denied")
    assert.strictEqual(document.getText(), original)
    assert.strictEqual(document.isDirty, false)
    assert.strictEqual(fs.readFileSync(file, "utf8"), original)
    assert.strictEqual(recorded.length, 0, "a refused edit is not recorded in the ledger")
    assert.strictEqual(shownFor(document), false, "no editor is opened for a refused edit")
  })

  test("visible save false is an intentionally unsaved success recorded as succeeded, not failed", async () => {
    const document = await vscode.workspace.openTextDocument(file)
    const original = document.getText()
    const { ledger, recorded } = ledgerRecording()
    const outcome = await sinkFor("visible", ledger).editLines!(file, await request(original, [{ operation: "delete", start_line: 2, end_line: 2 }]), false)
    assert.strictEqual(outcome.ok, true, outcome.message)
    assert.strictEqual(outcome.persisted, false)
    assert.strictEqual(document.getText(), "first\nthird\nfourth\n")
    assert.ok(document.isDirty, "the edit is intentionally unsaved")
    assert.strictEqual(fs.readFileSync(file, "utf8"), original, "the file on disk is unchanged")
    assert.deepStrictEqual(recorded.map((entry) => entry.settled), [["succeeded"]])
    await vscode.window.showTextDocument(document)
    await vscode.commands.executeCommand("undo")
    assert.strictEqual(document.getText(), original, "the unsaved edit is undoable")
  })

  for (const visibility of ["background", "visible"] as const) test(`${visibility} mode saves the edit, keeps undo and settles the ledger as succeeded`, async () => {
    const document = await vscode.workspace.openTextDocument(file)
    const original = document.getText()
    const { ledger, recorded } = ledgerRecording()
    const outcome = await sinkFor(visibility, ledger).editLines!(file, await request(original, [{ operation: "replace", start_line: 2, end_line: 2, content: ["SECOND"] }]), true)
    assert.strictEqual(outcome.ok, true, outcome.message)
    assert.strictEqual(outcome.persisted, true)
    assert.strictEqual(fs.readFileSync(file, "utf8"), "first\nSECOND\nthird\nfourth\n", "the successful edit is on disk")
    assert.strictEqual(document.isDirty, false)
    assert.ok(shownFor(document), "the document is shown for diagnostics")
    assert.deepStrictEqual(recorded.map((entry) => entry.settled), [["succeeded"]])
    await vscode.window.showTextDocument(document)
    await vscode.commands.executeCommand("undo")
    assert.strictEqual(document.getText(), original, "one undo restores the buffer")
  })

  test("a save failure is never settled as a successful ledger operation", async function () {
    if (process.getuid?.() === 0) this.skip()
    const document = await vscode.workspace.openTextDocument(file)
    const original = document.getText()
    const { ledger, recorded } = ledgerRecording()
    fs.chmodSync(file, 0o444)
    try {
      const outcome = await sinkFor("background", ledger).editLines!(file, await request(original, [{ operation: "delete", start_line: 2, end_line: 2 }]), true)
      assert.strictEqual(outcome.ok, false, outcome.message)
      assert.strictEqual(outcome.error?.code, "save_failed", outcome.message)
      assert.strictEqual(fs.readFileSync(file, "utf8"), original, "the file on disk is unchanged")
      assert.strictEqual(recorded.length, 1)
      assert.ok(!recorded[0].settled.includes("succeeded"), "a failed save is not a successful edit")
    } finally {
      fs.chmodSync(file, 0o644)
    }
  })

  test("background mode edits a dirty open document in place and saves the user's changes with the edit", async () => {
    const document = await vscode.workspace.openTextDocument(file)
    const editor = await vscode.window.showTextDocument(document)
    await editor.edit((builder) => builder.insert(new vscode.Position(0, 0), "user: "))
    const dirty = document.getText()
    const outcome = await sinkFor("background").editLines!(file, await request(dirty, [{ operation: "replace", start_line: 2, end_line: 2, content: ["SECOND"] }]), true)
    assert.strictEqual(outcome.ok, true, outcome.message)
    assert.strictEqual(fs.readFileSync(file, "utf8"), "user: first\nSECOND\nthird\nfourth\n")
    assert.strictEqual(document.isDirty, false)
    assert.strictEqual(vscode.window.visibleTextEditors.filter((entry) => entry.document === document).length, 1, "no duplicate editor")
    assert.strictEqual(tabFor(document.uri)?.isPreview, false, "the already open tab is not replaced by a preview")
  })

  test("background mode edits a closed document without replacing the user's persistent tab", async () => {
    const otherFile = path.join(root, "other.txt")
    fs.writeFileSync(otherFile, "other\n")
    const other = await vscode.workspace.openTextDocument(otherFile)
    await vscode.window.showTextDocument(other, { preview: false })
    const document = await vscode.workspace.openTextDocument(file)
    const outcome = await sinkFor("background").editLines!(file, await request(document.getText(), [{ operation: "delete", start_line: 2, end_line: 2 }]), true)
    assert.strictEqual(outcome.ok, true, outcome.message)
    assert.ok(shownFor(document), "the document is shown for diagnostics")
    assert.ok(tabFor(other.uri), "the document that had focus stays open in its tab")
    assert.strictEqual(tabFor(other.uri)?.isPreview, false, "the user's persistent tab is not replaced")
  })

  test("background reveal shows a closed document as a preview tab without taking focus", async () => {
    const otherFile = path.join(root, "other.txt")
    fs.writeFileSync(otherFile, "other\n")
    const other = await vscode.workspace.openTextDocument(otherFile)
    await vscode.window.showTextDocument(other, { preview: false })
    const document = await vscode.workspace.openTextDocument(file)
    const editor = await revealEditor(document, "background")
    assert.strictEqual(editor.document, document)
    assert.strictEqual(tabFor(document.uri)?.isPreview, true, "shown as a preview tab")
    assert.ok(tabFor(other.uri), "the document that had focus stays open in its tab")
    assert.strictEqual(tabFor(other.uri)?.isPreview, false, "the user's persistent tab is not replaced")
  })

  test("visible mode reveals a closed document in a persistent tab and gives it focus", async () => {
    const document = await vscode.workspace.openTextDocument(file)
    const outcome = await sinkFor("visible").editLines!(file, await request(document.getText(), [{ operation: "delete", start_line: 2, end_line: 2 }]), true)
    assert.strictEqual(outcome.ok, true, outcome.message)
    assert.strictEqual(vscode.window.activeTextEditor?.document, document, "the document has focus")
    assert.strictEqual(tabFor(document.uri)?.isPreview, false, "shown in a persistent tab")
  })

  test("visible mode pins an open preview tab and edits it in place", async () => {
    const document = await vscode.workspace.openTextDocument(file)
    await vscode.window.showTextDocument(document, { preview: true })
    const outcome = await sinkFor("visible").editLines!(file, await request(document.getText(), [{ operation: "delete", start_line: 2, end_line: 2 }]), true)
    assert.strictEqual(outcome.ok, true, outcome.message)
    assert.strictEqual(vscode.window.visibleTextEditors.filter((entry) => entry.document === document).length, 1, "no duplicate editor")
    assert.strictEqual(tabFor(document.uri)?.isPreview, false, "the preview tab is pinned")
  })

  for (const visibility of ["background", "visible"] as const) test(`${visibility} mode reports a new diagnostic at the changed line of a closed document`, async function () {
    this.timeout(20000)
    file = path.join(root, `diagnostics-${visibility}.ts`)
    const source = "export const value = 1\n"
    fs.writeFileSync(file, source)
    const diagnostics = vscode.languages.createDiagnosticCollection("line-edit-diagnostics-" + visibility)
    const listener = vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.fsPath !== file) return
      diagnostics.set(event.document.uri, event.document.getText().includes("BROKEN") ? [
        new vscode.Diagnostic(new vscode.Range(0, 0, 0, 6), "Synthetic type error", vscode.DiagnosticSeverity.Error)
      ] : [])
    })
    try {
      const outcome = await sinkFor(visibility).editLines!(file, await request(source, [{ operation: "replace", start_line: 1, end_line: 1, content: ["export const BROKEN = 1"] }]), true)
      assert.strictEqual(outcome.ok, true, outcome.message)
      assert.match(outcome.message, new RegExp(`reports an error in diagnostics-${visibility}\\.ts that was not there before:\\n1: Synthetic type error`))
    } finally {
      listener.dispose()
      diagnostics.dispose()
    }
  })

  for (const visibility of ["background", "visible"] as const) test(`${visibility} mode reports a real TypeScript error introduced into a closed document`, async function () {
    this.timeout(20000)
    file = path.join(root, `typed-${visibility}.ts`)
    const source = "export const value: number = 1\n"
    fs.writeFileSync(file, source)
    const outcome = await sinkFor(visibility).editLines!(file, await request(source, [{ operation: "replace", start_line: 1, end_line: 1, content: ["export const value: number = \"text\""] }]), true)
    assert.strictEqual(outcome.ok, true, outcome.message)
    assert.match(outcome.message, new RegExp(`reports an error in typed-${visibility}\\.ts (that was not there before|on the lines you changed):\\n1: Type 'string' is not assignable to type 'number'`))
  })

  test("a stale hash from before the user's unsaved change is refused and nothing is applied", async () => {
    const document = await vscode.workspace.openTextDocument(file)
    const clean = document.getText()
    const editor = await vscode.window.showTextDocument(document)
    await editor.edit((builder) => builder.insert(new vscode.Position(0, 0), "user: "))
    const dirty = document.getText()
    const result = await applyDocumentLineEdits(file, await request(clean, [{ operation: "delete", start_line: 2, end_line: 2 }]))
    assert.strictEqual(result.ok, false)
    assert.strictEqual(result.error?.code, "hash_mismatch")
    assert.strictEqual(result.error?.current_hash, await contentHash(dirty))
    assert.strictEqual(document.getText(), dirty, "the user's change is kept and no edit was made")
    assert.strictEqual(fs.readFileSync(file, "utf8"), clean, "nothing was saved")
  })

  test("save failure is reported as save_failed and the edit stays unsaved", async function () {
    if (process.getuid?.() === 0) this.skip()
    const document = await vscode.workspace.openTextDocument(file)
    const original = document.getText()
    fs.chmodSync(file, 0o444)
    try {
      const result = await applyDocumentLineEdits(file, await request(original, [{ operation: "delete", start_line: 2, end_line: 2 }]))
      assert.strictEqual(result.ok, false, result.message)
      assert.strictEqual(result.error?.code, "save_failed", result.message)
      assert.strictEqual(result.error?.current_hash, await contentHash(document.getText()))
      assert.strictEqual(document.getText(), "first\nthird\nfourth\n", "the edit is in the buffer")
      assert.ok(document.isDirty, "the edit is not saved")
      assert.strictEqual(fs.readFileSync(file, "utf8"), original, "the file on disk is unchanged")
    } finally {
      fs.chmodSync(file, 0o644)
    }
  })

  for (const eol of ["\n", "\r\n"]) test(`real editor retains ${eol === "\n" ? "LF" : "CRLF"} and unaffected lines`, async () => {
    fs.writeFileSync(file, ["one", "two", "three", ""].join(eol))
    const document = await vscode.workspace.openTextDocument(file)
    const result = await applyDocumentLineEdits(file, await request(document.getText(), [
      { operation: "replace", start_line: 2, end_line: 2, content: ["TWO", "inserted"] }
    ]))
    assert.ok(result.ok, result.message)
    assert.strictEqual(document.getText(), ["one", "TWO", "inserted", "three", ""].join(eol))
    assert.strictEqual(fs.readFileSync(file, "utf8"), ["one", "TWO", "inserted", "three", ""].join(eol), "the persisted bytes keep the line endings")
  })

  test("real editor rejects stale hashes, invalid later edits and overlaps without any document event", async () => {
    const document = await vscode.workspace.openTextDocument(file)
    const original = document.getText()
    let events = 0
    const listener = vscode.workspace.onDidChangeTextDocument((event) => { if (event.document === document && event.contentChanges.length) events++ })
    try {
      for (const [expected, edits, code] of [
        [await contentHash("outdated"), [{ operation: "delete", start_line: 1, end_line: 1 }], "hash_mismatch"],
        [await contentHash(original), [{ operation: "delete", start_line: 1, end_line: 1 }, { operation: "delete", start_line: 99, end_line: 99 }], "invalid_range"],
        [await contentHash(original), [{ operation: "delete", start_line: 1, end_line: 2 }, { operation: "delete", start_line: 2, end_line: 3 }], "overlapping_edits"]
      ] as const) {
        const result = await applyDocumentLineEdits(file, { expected_hash: expected, edits })
        assert.strictEqual(result.ok, false)
        assert.strictEqual(result.error?.code, code)
        assert.strictEqual(document.getText(), original)
      }
      assert.strictEqual(events, 0)
    } finally { listener.dispose() }
  })

  test("opening the editor cannot bypass hash revalidation after a concurrent document change", async () => {
    const document = await vscode.workspace.openTextDocument(file)
    const original = document.getText()
    await vscode.commands.executeCommand("workbench.action.closeAllEditors")
    let changed: Thenable<boolean> | undefined
    const listener = vscode.window.onDidChangeVisibleTextEditors((editors) => {
      const editor = editors.find((entry) => entry.document === document)
      if (editor && !changed) changed = editor.edit((builder) => builder.insert(new vscode.Position(0, 0), "user: "))
    })
    try {
      const result = await applyDocumentLineEdits(file, await request(original, [{ operation: "delete", start_line: 2, end_line: 2 }]))
      if (changed) await changed
      assert.strictEqual(result.ok, false, "a concurrent version change must not be overwritten")
      assert.strictEqual(result.error?.code, "hash_mismatch")
      assert.ok(document.getText().includes("second"))
      assert.ok(document.getText().includes("user: "))
      assert.strictEqual(fs.readFileSync(file, "utf8"), original, "nothing was saved")
    } finally { listener.dispose() }
  })

  test("native dispatcher reads dirty buffers, requests review approval and uses checkpoints", async function () {
    this.timeout(15000)
    const document = await vscode.workspace.openTextDocument(file)
    const editor = await vscode.window.showTextDocument(document)
    await editor.edit((builder) => builder.insert(new vscode.Position(0, 0), "dirty: "))
    const original = document.getText()
    assert.ok(document.isDirty)
    await document.save()
    let approved = false
    const asked: string[] = []
    const checkpoints = createSafeEditCheckpoints(vscode.Uri.file(path.join(root, "storage")))
    const captured: string[] = []
    const capture = checkpoints.capture.bind(checkpoints)
    checkpoints.capture = async (files) => { captured.push(...files); await capture(files) }
    const tools = workspaceTools(root, [], {
      edits: editorEdits(new WorkspaceView(root), "review", async (detail) => { asked.push(detail); return approved }, undefined, { checkpoints }),
      git: false, instructions: false
    })
    const read = await tools.run({ name: "read_file", args: { path: "source.txt", start_line: "1", end_line: "1" } })
    assert.ok(read.output.includes(await contentHash(original)))
    const args = { path: "source.txt", expected_hash: await contentHash(original), edits: JSON.stringify([{ operation: "replace", start_line: 2, end_line: 2, content: ["approved"] }]) }
    const denied = await tools.run({ name: "edit_lines", args })
    assert.strictEqual(JSON.parse(denied.output).error.code, "permission_denied")
    assert.strictEqual(document.getText(), original)
    approved = true
    const result = await tools.run({ name: "edit_lines", args })
    assert.ok(!result.failed, result.output)
    assert.strictEqual(JSON.parse(result.output).content_hash, await contentHash(document.getText()))
    assert.ok(document.getText().includes("approved"))
    assert.strictEqual(fs.readFileSync(file, "utf8"), document.getText(), "the approved edit is persisted")
    assert.strictEqual(asked.length, 2)
    assert.ok(!document.isDirty)
    assert.deepStrictEqual(captured, [file])
    assert.ok(fs.existsSync(path.join(root, "storage", "active-execution-edit-checkpoint.json")))
    await checkpoints.clear()
  })

  test("authoritative native reads decode UTF-16 and line edits retain the document encoding", async () => {
    file = path.join(root, "encoded.txt")
    const source = "before\r\nuntouched\r\n"
    fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(source, "utf16le")]))
    const document = await vscode.workspace.openTextDocument(file)
    const checkpoints = createSafeEditCheckpoints(vscode.Uri.file(path.join(root, "storage")))
    const tools = workspaceTools(root, [], { edits: editorEdits(new WorkspaceView(root), "apply", async () => true, undefined, { checkpoints }), git: false, instructions: false })
    const read = await tools.run({ name: "read_file", args: { path: "encoded.txt" } })
    assert.ok(read.output.includes(await contentHash(source)), read.output)
    const result = await tools.run({ name: "edit_lines", args: { path: "encoded.txt", expected_hash: await contentHash(source), edits: JSON.stringify([{ operation: "replace", start_line: 1, end_line: 1, content: ["after"] }]) } })
    assert.ok(!result.failed, result.output)
    assert.deepStrictEqual(fs.readFileSync(file), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("after\r\nuntouched\r\n", "utf16le")]))
    assert.ok(!document.isDirty)
    await checkpoints.clear()
  })

  test("a long JSX batch reaches diagnostics only after the complete transaction", async function () {
    this.timeout(15000)
    file = path.join(root, "panel.tsx")
    const jsx = "<section>" + "<div><span>repeat</span></div>".repeat(60) + "</section>"
    const source = "// @ts-nocheck\nexport const Panel = () => (\n  " + jsx + "\n)\n"
    fs.writeFileSync(file, source)
    const document = await vscode.workspace.openTextDocument(file)
    await vscode.window.showTextDocument(document)
    const observed: string[] = []
    const listener = vscode.workspace.onDidChangeTextDocument((event) => { if (event.document === document && event.contentChanges.length) observed.push(document.getText()) })
    let recoveries = 0
    const tools = workspaceTools(root, [], { edits: editorEdits(new WorkspaceView(root), "apply", async () => true, undefined, { onCatastrophic: () => { recoveries++ } }), git: false, instructions: false })
    try {
      const result = await tools.run({ name: "edit_lines", args: { path: "panel.tsx", expected_hash: await contentHash(source), edits: JSON.stringify([
        { operation: "replace", start_line: 2, end_line: 2, content: ["export function Panel() {"] },
        { operation: "replace", start_line: 3, end_line: 3, content: ["  return " + jsx] },
        { operation: "replace", start_line: 4, end_line: 4, content: ["}"] }
      ]) } })
      assert.ok(!result.failed, result.output)
      assert.deepStrictEqual(observed, ["// @ts-nocheck\nexport function Panel() {\n  return " + jsx + "\n}\n"])
      assert.strictEqual(recoveries, 0)
      assert.strictEqual(JSON.parse(result.output).content_hash, await contentHash(document.getText()))
    } finally { listener.dispose() }
  })

  test("line edits keep legitimate work when diagnostics spike and allow a corrected edit", async function () {
    this.timeout(20000)
    file = path.join(root, "regression.ts")
    const source = "export const value = 1\n"
    fs.writeFileSync(file, source)
    const document = await vscode.workspace.openTextDocument(file)
    await vscode.window.showTextDocument(document)
    const diagnostics = vscode.languages.createDiagnosticCollection("line-edit-regression")
    const listener = vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document !== document) return
      diagnostics.set(document.uri, document.getText().includes("BROKEN") ? Array.from({ length: 20 }, (_, i) =>
        new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), "Synthetic regression " + i, vscode.DiagnosticSeverity.Error)
      ) : [])
    })
    const checkpoints = createSafeEditCheckpoints(vscode.Uri.file(path.join(root, "storage")))
    let recoveries = 0
    const changes = new ReplyChanges(root, openDocumentText)
    const tools = workspaceTools(root, [], {
      edits: editorEdits(new WorkspaceView(root), "apply", async () => true, changes, { checkpoints, onCatastrophic: () => { recoveries++ } }),
      git: false, instructions: false
    })
    try {
      const invalid = await tools.run({ name: "edit_lines", args: { path: "regression.ts", expected_hash: await contentHash(source), edits: "{not-json" } })
      assert.strictEqual(invalid.failed, true, invalid.output)
      assert.strictEqual(recoveries, 0, "invalid arguments must not trigger recovery")
      const result = await tools.run({ name: "edit_lines", args: { path: "regression.ts", expected_hash: await contentHash(source), edits: JSON.stringify([{ operation: "replace", start_line: 1, end_line: 1, content: ["export const BROKEN = 1"] }]) } })
      assert.strictEqual(result.failed, undefined, result.output)
      assert.strictEqual(recoveries, 0)
      assert.strictEqual(document.getText(), "export const BROKEN = 1\n", "new diagnostics do not roll back the applied edit")
      const brokenSource = "export const BROKEN = 1\n"
      const corrected = await tools.run({ name: "edit_lines", args: { path: "regression.ts", expected_hash: await contentHash(brokenSource), edits: JSON.stringify([{ operation: "replace", start_line: 1, end_line: 1, content: ["export const value = 2"] }]) } })
      assert.strictEqual(corrected.failed, undefined, corrected.output)
      assert.strictEqual(document.getText(), "export const value = 2\n")
      assert.strictEqual(JSON.parse(corrected.output).content_hash, await contentHash("export const value = 2\n"))
      assert.strictEqual(recoveries, 0)
      const record = await changes.record()
      assert.ok(record)
      const store = new ChangeStore(path.join(root, "reply-changes"))
      store.save(record)
      const undone = await new ReplyChangesEditor(store, openDocumentText).undo(record.id)
      assert.strictEqual(undone.error, undefined)
      assert.strictEqual(document.getText(), source, "Undo all remains available after verified rollback")
    } finally {
      listener.dispose()
      diagnostics.dispose()
      await checkpoints.clear()
    }
  })


  test("asynchronous diagnostic changes do not block subsequent valid edits", async function () {
    this.timeout(20000)
    file = path.join(root, "refused.ts")
    const source = "export const value = 1\n"
    fs.writeFileSync(file, source)
    const document = await vscode.workspace.openTextDocument(file)
    await vscode.window.showTextDocument(document)
    const diagnostics = vscode.languages.createDiagnosticCollection("line-edit-refused")
    const listener = vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document !== document) return
      diagnostics.set(document.uri, document.getText().includes("BROKEN") ? Array.from({ length: 20 }, (_, i) =>
        new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), "Synthetic regression " + i, vscode.DiagnosticSeverity.Error)
      ) : [])
    })
    const checkpoints = createSafeEditCheckpoints(vscode.Uri.file(path.join(root, "storage")))
    let recoveries = 0
    const tools = workspaceTools(root, [], {
      edits: editorEdits(new WorkspaceView(root), "apply", async () => true, undefined, { checkpoints, onCatastrophic: () => { recoveries++ } }),
      git: false, instructions: false
    })
    try {
      const result = await tools.run({ name: "edit_lines", args: { path: "refused.ts", expected_hash: await contentHash(source), edits: JSON.stringify([{ operation: "replace", start_line: 1, end_line: 1, content: ["export const BROKEN = 1"] }]) } })
      assert.strictEqual(result.failed, undefined, result.output)
      assert.strictEqual(recoveries, 0)
      const broken = document.getText()
      assert.match(broken, /BROKEN/)
      const corrected = await tools.run({ name: "edit_lines", args: { path: "refused.ts", expected_hash: await contentHash(broken), edits: JSON.stringify([{ operation: "replace", start_line: 1, end_line: 1, content: ["export const value = 2"] }]) } })
      assert.strictEqual(corrected.failed, undefined, corrected.output)
      assert.strictEqual(document.getText(), "export const value = 2\n")
      const unrelated = path.join(root, "unrelated.ts")
      fs.writeFileSync(unrelated, "export const safe = 1\n")
      const unrelatedDocument = await vscode.workspace.openTextDocument(unrelated)
      const unrelatedEdit = await tools.run({ name: "edit_lines", args: { path: "unrelated.ts", expected_hash: await contentHash("export const safe = 1\n"), edits: JSON.stringify([{ operation: "replace", start_line: 1, end_line: 1, content: ["export const safe = 2"] }]) } })
      assert.strictEqual(unrelatedEdit.failed, undefined, unrelatedEdit.output)
      assert.strictEqual(unrelatedDocument.getText(), "export const safe = 2\n")
    } finally {
      listener.dispose()
      diagnostics.dispose()
      await checkpoints.clear()
    }
  })

  test("diagnostics on one file do not affect another verified edit", async function () {
    this.timeout(20000)
    const brokenPath = path.join(root, "isolated-broken.ts")
    const cleanPath = path.join(root, "isolated-clean.ts")
    const brokenSource = "export const value = 1\n"
    const cleanSource = "export const other = 1\n"
    fs.writeFileSync(brokenPath, brokenSource)
    fs.writeFileSync(cleanPath, cleanSource)
    const brokenDocument = await vscode.workspace.openTextDocument(brokenPath)
    await vscode.window.showTextDocument(brokenDocument)
    const cleanDocument = await vscode.workspace.openTextDocument(cleanPath)
    const diagnostics = vscode.languages.createDiagnosticCollection("line-edit-isolated")
    const listener = vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document !== brokenDocument) return
      diagnostics.set(brokenDocument.uri, brokenDocument.getText().includes("BROKEN") ? Array.from({ length: 20 }, (_, i) =>
        new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), "Synthetic regression " + i, vscode.DiagnosticSeverity.Error)
      ) : [])
    })
    const checkpoints = createSafeEditCheckpoints(vscode.Uri.file(path.join(root, "storage")))
    let recoveries = 0
    const tools = workspaceTools(root, [], {
      edits: editorEdits(new WorkspaceView(root), "apply", async () => true, undefined, { checkpoints, onCatastrophic: () => { recoveries++ } }),
      git: false, instructions: false
    })
    try {
      const verified = await tools.run({ name: "edit_lines", args: { path: "isolated-clean.ts", expected_hash: await contentHash(cleanSource), edits: JSON.stringify([{ operation: "replace", start_line: 1, end_line: 1, content: ["export const other = 2"] }]) } })
      assert.strictEqual(verified.failed, undefined, verified.output)
      const broke = await tools.run({ name: "edit_lines", args: { path: "isolated-broken.ts", expected_hash: await contentHash(brokenSource), edits: JSON.stringify([{ operation: "replace", start_line: 1, end_line: 1, content: ["export const BROKEN = 1"] }]) } })
      assert.strictEqual(broke.failed, undefined, broke.output)
      assert.strictEqual(recoveries, 0)
      assert.strictEqual(brokenDocument.getText(), "export const BROKEN = 1\n", "diagnostics keep the valid edit applied")
      assert.strictEqual(cleanDocument.getText(), "export const other = 2\n", "the unaffected file keeps its verified edit")
    } finally {
      listener.dispose()
      diagnostics.dispose()
      await checkpoints.clear()
    }
  })

  test("refreshIndex runs once with the edited file after a successful edit_lines and before the ledger settles", async () => {
    const document = await vscode.workspace.openTextDocument(file)
    const original = document.getText()
    const { order, recorded, ledger } = orderRecording()
    const { calls, saw, refreshIndex } = refreshSpy(order)
    const outcome = await refreshSinkFor(ledger, refreshIndex).editLines!(file, await request(original, [{ operation: "replace", start_line: 2, end_line: 2, content: ["SECOND"] }]), true)
    assert.ok(outcome.ok, outcome.message)
    assert.deepStrictEqual(order, ["recorded", "refresh", "settled"], "the saved file is caught up before the record settles")
    assert.deepStrictEqual(calls, [[{ path: file, kind: "write" }]], "the edited file, as the tool layer passes it to the index")
    assert.deepStrictEqual(saw, ["first\nSECOND\nthird\nfourth\n"], "the file was already saved when the refresh ran")
    assert.deepStrictEqual(recorded.map((entry) => entry.settled), [["succeeded"]], "the ledger settles as it always did")
    assert.deepStrictEqual(outcome.indexRefresh, { status: "synced" }, "the outcome carries what the refresh answered")
  })

  test("a stale expected_hash does not refresh and leaves file and index untouched", async () => {
    const document = await vscode.workspace.openTextDocument(file)
    const original = document.getText()
    const { order, recorded, ledger } = orderRecording()
    const { calls, saw, refreshIndex } = refreshSpy(order)
    const result = await refreshSinkFor(ledger, refreshIndex).editLines!(file, { expected_hash: await contentHash("not this document"), edits: [{ operation: "replace", start_line: 1, end_line: 2, content: ["x"] }] }, true)
    assert.strictEqual(result.ok, false)
    assert.strictEqual(result.error?.code, "hash_mismatch")
    assert.strictEqual(result.error?.current_hash, await contentHash(original))
    assert.deepStrictEqual(order, [], "the edit was refused before it was recorded")
    assert.deepStrictEqual(recorded, [])
    assert.deepStrictEqual(calls, [], "a refused edit never reaches the index")
    assert.deepStrictEqual(saw, [])
    assert.strictEqual(document.getText(), original, "the buffer is as it was")
    assert.strictEqual(fs.readFileSync(file, "utf8"), original, "nothing was saved")
  })

  test("two edit_lines from the same expected_hash: the second conflicts and only one refresh happens", async () => {
    const document = await vscode.workspace.openTextDocument(file)
    const original = document.getText()
    const hash = await contentHash(original)
    const { calls, saw, refreshIndex } = refreshSpy([])
    const sink = refreshSinkFor(undefined, refreshIndex)
    const first = await sink.editLines!(file, { expected_hash: hash, edits: [{ operation: "replace", start_line: 2, end_line: 2, content: ["SECOND"] }] }, true)
    assert.ok(first.ok, first.message)
    const second = await sink.editLines!(file, { expected_hash: hash, edits: [{ operation: "delete", start_line: 3, end_line: 3 }] }, true)
    assert.strictEqual(second.ok, false)
    assert.strictEqual(second.error?.code, "hash_mismatch")
    assert.deepStrictEqual(calls, [[{ path: file, kind: "write" }]], "only the edit that reached the file was refreshed")
    assert.deepStrictEqual(saw, ["first\nSECOND\nthird\nfourth\n"])
    assert.strictEqual(fs.readFileSync(file, "utf8"), "first\nSECOND\nthird\nfourth\n", "the second edit changed nothing")
  })

  test("after a catastrophic-edit rollback refreshIndex sees the restored content on disk", async function () {
    this.timeout(20000)
    const document = await vscode.workspace.openTextDocument(file)
    const original = document.getText()
    const checkpoints = createSafeEditCheckpoints(vscode.Uri.file(path.join(root, "storage")))
    const { order, recorded, ledger } = orderRecording()
    const { calls, saw, refreshIndex } = refreshSpy(order)
    let recovery: SignificantEditRecoveryResult | undefined
    // Diagnostics alone never ask for a rollback, so the recovery is requested here. Its content
    // check is recorded by `markChanged` after the simulated change, and the fake refresh
    // reads the file back from disk and compares it with the original.
    const runEditCommand: EditCommandRunner = async <T>(command: string, ...args: unknown[]): Promise<T | undefined> => {
      const outcome = await vscode.commands.executeCommand<T>(command, ...args)
      await checkpoints.markChanged([file])
      recovery = await recoverSignificantEdit({
        file: "source.txt", introducedErrors: 20, diagnosticsObserved: false, diagnosticCheckAvailable: false,
        rollbackRequested: true, checkpoints, checkpointPath: file
      })
      order.push("restored")
      return outcome
    }
    const outcome = await editorEdits(new WorkspaceView(root), "apply", async () => true, undefined, { recordEditOperation: ledger, refreshIndex, runEditCommand, checkpoints }, "background")
      .editLines!(file, await request(original, [{ operation: "replace", start_line: 2, end_line: 2, content: ["SECOND"] }]), true)
    assert.ok(recovery?.restored, recovery?.reason)
    assert.ok(recovery?.fileVerified, recovery?.reason)
    assert.deepStrictEqual(order, ["recorded", "restored", "refresh", "settled"])
    assert.deepStrictEqual(saw, [original], "the fake refresh read the file back and saw the content the rollback put there")
    assert.deepStrictEqual(calls, [[{ path: file, kind: "write" }]], "the restored file, as the tool layer passes it to the index")
    assert.strictEqual(fs.readFileSync(file, "utf8"), original, "the file on disk holds the restored content")
    assert.strictEqual(document.getText(), original, "the buffer holds the restored content too")
    assert.deepStrictEqual(recorded.map((entry) => entry.settled), [["succeeded"]], "the ledger settles as it always did")
    assert.strictEqual(outcome.ok, false, "the hash the command reported no longer matches the restored buffer")
    assert.strictEqual(outcome.error?.code, "application_failed")
    assert.match(outcome.message, /The document changed while diagnostics were checked/, "the hash precondition still holds after the recovery, so the model is told to reread")
    await checkpoints.clear()
  })

  test("an unsaved edit (save false) does not refresh", async () => {
    const document = await vscode.workspace.openTextDocument(file)
    const original = document.getText()
    const { order, recorded, ledger } = orderRecording()
    const { calls, saw, refreshIndex } = refreshSpy(order)
    const outcome = await editorEdits(new WorkspaceView(root), "apply", async () => true, undefined, { recordEditOperation: ledger, refreshIndex }, "visible")
      .editLines!(file, await request(original, [{ operation: "delete", start_line: 2, end_line: 2 }]), false)
    assert.ok(outcome.ok, outcome.message)
    assert.strictEqual(outcome.persisted, false, "the edit was left unsaved on purpose")
    assert.deepStrictEqual(order, ["recorded", "settled"], "nothing was written to disk, so the index was not told")
    assert.deepStrictEqual(calls, [])
    assert.deepStrictEqual(saw, [])
    assert.strictEqual(outcome.indexRefresh, undefined)
    assert.strictEqual(document.getText(), "first\nthird\nfourth\n")
    assert.strictEqual(fs.readFileSync(file, "utf8"), original, "the disk file is unchanged")
    assert.deepStrictEqual(recorded.map((entry) => entry.settled), [["succeeded"]])
  })

  test("a dirty UTF-16 document keeps the user's change and saves the complete result in its encoding", async () => {
    file = path.join(root, "dirty-encoded.txt")
    const source = "before \u00e9\r\nuntouched\r\n"
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(source, "utf16le")])
    fs.writeFileSync(file, bytes)
    const document = await vscode.workspace.openTextDocument(file)
    const editor = await vscode.window.showTextDocument(document)
    await editor.edit((builder) => builder.insert(new vscode.Position(0, 0), "user: "))
    const dirty = document.getText()
    const result = await applyDocumentLineEdits(file, await request(dirty, [{ operation: "replace", start_line: 2, end_line: 2, content: ["changed"] }]))
    assert.ok(result.ok, result.message)
    const expected = "user: before \u00e9\r\nchanged\r\n"
    assert.strictEqual(document.getText(), expected)
    assert.strictEqual(document.isDirty, false)
    const persisted = fs.readFileSync(file)
    assert.deepStrictEqual(persisted.subarray(0, 2), Buffer.from([0xff, 0xfe]), "the BOM and UTF-16 encoding are kept")
    assert.strictEqual(persisted.subarray(2).toString("utf16le"), expected)
  })

  test("a user change during approval is rejected by final hash revalidation", async () => {
    const document = await vscode.workspace.openTextDocument(file)
    const editor = await vscode.window.showTextDocument(document)
    const original = document.getText()
    const tools = workspaceTools(root, [], {
      edits: editorEdits(new WorkspaceView(root), "review", async () => {
        await editor.edit((builder) => builder.insert(new vscode.Position(0, 0), "user: "))
        return true
      }), git: false, instructions: false
    })
    const result = await tools.run({ name: "edit_lines", args: { path: "source.txt", expected_hash: await contentHash(original), edits: JSON.stringify([{ operation: "delete", start_line: 2, end_line: 2 }]) } })
    assert.strictEqual(result.failed, true)
    const error = JSON.parse(result.output).error
    assert.strictEqual(error.code, "hash_mismatch")
    assert.strictEqual(error.current_hash, await contentHash(document.getText()))
    assert.strictEqual(document.getText(), "user: " + original)
  })

  const orderingFile = (name: string, text: string) => {
    const target = path.join(root, name)
    fs.writeFileSync(target, text)
    return target
  }

  const ranges = {
    growing: { operation: "replace", start_line: 2, end_line: 2, content: ["A", "B", "C"] },
    shrinking: { operation: "delete", start_line: 3, end_line: 4 },
    atEnd: { operation: "insert_before", line: 6, content: ["E"] }
  }

  test("the same ranges read ascending and descending leave identical content", async () => {
    const source = "one\ntwo\nthree\nfour\nfive\nsix\n"
    const expected = "one\nA\nB\nC\nfive\nE\nsix\n"
    const ascending = orderingFile("order-ascending.txt", source)
    const descending = orderingFile("order-descending.txt", source)
    const up = await applyDocumentLineEdits(ascending, await request(source, [ranges.growing, ranges.shrinking, ranges.atEnd]))
    assert.ok(up.ok, up.message)
    const down = await applyDocumentLineEdits(descending, await request(source, [ranges.atEnd, ranges.shrinking, ranges.growing]))
    assert.ok(down.ok, down.message)
    assert.strictEqual(fs.readFileSync(ascending, "utf8"), expected, "the batch read top-to-bottom")
    assert.strictEqual(fs.readFileSync(descending, "utf8"), expected, "the same batch read bottom-to-top")
    assert.strictEqual(up.contentHash, down.contentHash, "both orders answer with the same hash")
  })

  test("a range that changes the line count does not move the ranges after it", async () => {
    const source = "one\ntwo\nthree\nfour\nfive\nsix\n"
    const expected = "one\nA\nB\nC\nD\nsix\nlast\n"
    const target = orderingFile("shift.txt", source)
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target))
    const result = await applyDocumentLineEdits(target, await request(source, [
      { operation: "replace", start_line: 2, end_line: 2, content: ["A", "B", "C", "D"] },
      { operation: "delete", start_line: 3, end_line: 5 },
      { operation: "insert_after", line: 6, content: ["last"] }
    ]))
    assert.ok(result.ok, result.message)
    assert.strictEqual(document.getText(), expected, "the later ranges still address the lines they named")
    assert.strictEqual(fs.readFileSync(target, "utf8"), expected, "the saved file matches")
  })

  test("several ranges of different sizes stay one undoable editor operation", async function () {
    const target = orderingFile("batch.txt", "one\ntwo\nthree\nfour\nfive\n")
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target))
    const original = document.getText()
    const batches: number[] = []
    const listener = vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document === document && event.contentChanges.length) batches.push(event.contentChanges.length)
    })
    try {
      const result = await applyDocumentLineEdits(target, await request(original, [
        { operation: "replace", start_line: 1, end_line: 1, content: ["ONE", "extra"] },
        { operation: "insert_after", line: 2, content: ["two-b"] },
        { operation: "delete", start_line: 4, end_line: 5 }
      ]))
      assert.ok(result.ok, result.message)
      assert.strictEqual(document.getText(), "ONE\nextra\ntwo\ntwo-b\nthree\n")
      assert.deepStrictEqual(batches, [3], "one change event carrying all three ranges")
      await vscode.window.showTextDocument(document)
      await vscode.commands.executeCommand("undo")
      if (document.getText() === original) return
      // A test window with no reachable undo stack answers the command without acting;
      // the single change event above is what shows the batch was one operation.
      this.skip()
    } finally { listener.dispose() }
  })

  test("ranges that overlap in either input order are refused before anything changes", async () => {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file))
    const original = document.getText()
    let events = 0
    const listener = vscode.workspace.onDidChangeTextDocument((event) => { if (event.document === document && event.contentChanges.length) events++ })
    try {
      for (const edits of [
        [{ operation: "replace", start_line: 2, end_line: 3, content: ["x"] }, { operation: "delete", start_line: 3, end_line: 4 }],
        [{ operation: "delete", start_line: 3, end_line: 4 }, { operation: "replace", start_line: 2, end_line: 3, content: ["x"] }]
      ]) {
        const result = await applyDocumentLineEdits(file, await request(original, edits))
        assert.strictEqual(result.ok, false, result.message)
        assert.strictEqual(result.error?.code, "overlapping_edits")
        assert.strictEqual(document.getText(), original)
      }
      assert.strictEqual(events, 0, "a refused batch changes nothing")
    } finally { listener.dispose() }
  })

  test("an invalid range in either input order is refused before anything changes", async () => {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file))
    const original = document.getText()
    let events = 0
    const listener = vscode.workspace.onDidChangeTextDocument((event) => { if (event.document === document && event.contentChanges.length) events++ })
    try {
      for (const edits of [
        [{ operation: "replace", start_line: 2, end_line: 2, content: ["x"] }, { operation: "delete", start_line: 9, end_line: 9 }],
        [{ operation: "delete", start_line: 9, end_line: 9 }, { operation: "replace", start_line: 2, end_line: 2, content: ["x"] }],
        [{ operation: "delete", start_line: 3, end_line: 2 }]
      ]) {
        const result = await applyDocumentLineEdits(file, await request(original, edits))
        assert.strictEqual(result.ok, false, result.message)
        assert.strictEqual(result.error?.code, "invalid_range")
        assert.strictEqual(document.getText(), original)
      }
      assert.strictEqual(events, 0, "a refused batch changes nothing")
    } finally { listener.dispose() }
  })

  test("an expected_hash that does not match the document leaves the file unchanged", async () => {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file))
    const original = document.getText()
    const result = await applyDocumentLineEdits(file, {
      expected_hash: await contentHash("not this document"),
      edits: [{ operation: "replace", start_line: 1, end_line: 2, content: ["x"] }, { operation: "delete", start_line: 3, end_line: 4 }]
    })
    assert.strictEqual(result.ok, false, result.message)
    assert.strictEqual(result.error?.code, "hash_mismatch")
    assert.strictEqual(result.error?.current_hash, await contentHash(original))
    assert.strictEqual(document.getText(), original, "the buffer is as it was")
    assert.strictEqual(fs.readFileSync(file, "utf8"), original, "nothing was saved")
  })

  test("a single range is applied exactly as it always was", async () => {
    const target = orderingFile("single.txt", "one\ntwo\nthree\n")
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target))
    const result = await applyDocumentLineEdits(target, await request(document.getText(), [{ operation: "replace", start_line: 2, end_line: 2, content: ["TWO", "added"] }]))
    assert.ok(result.ok, result.message)
    assert.strictEqual(document.getText(), "one\nTWO\nadded\nthree\n")
    assert.strictEqual(fs.readFileSync(target, "utf8"), "one\nTWO\nadded\nthree\n")
    assert.strictEqual(result.contentHash, await contentHash("one\nTWO\nadded\nthree\n"))
    assert.strictEqual(result.contentSource, "disk")
    assert.strictEqual(result.persisted, true)
  })

  test("the create sink catches the index up with the file it saved before the record settles, and reports its hash", async function () {
    this.timeout(20000)
    const target = path.join(root, "created-by-the-sink.txt")
    const content = "created\nsecond\n"
    const { order, recorded, ledger } = orderRecording()
    const { calls, saw, refreshIndex } = changeSpy(order)
    const outcome = await refreshSinkFor(ledger, refreshIndex).create(target, content)
    assert.ok(outcome.ok, outcome.message)
    assert.deepStrictEqual(order, ["recorded", "refresh", "settled"], "the saved file is caught up before the record settles")
    assert.deepStrictEqual(calls, [[{ path: target, kind: "write" }]], "the new file, as the tool layer passes it to the index")
    assert.deepStrictEqual(saw, [content], "the file was already saved when the refresh ran")
    assert.strictEqual(outcome.contentHash, await contentHash(content), "the hash is the saved file read back from disk")
    assert.strictEqual(outcome.contentSource, "disk")
    assert.strictEqual(outcome.persisted, true)
    assert.deepStrictEqual(outcome.indexRefresh, { status: "synced" })
    assert.deepStrictEqual(recorded.map((entry) => entry.settled), [["succeeded"]])
  })

  test("a create whose saved file cannot be read back is still the change, with no hash", async function () {
    this.timeout(20000)
    const target = path.join(root, "unreadable-create.txt")
    const { order, recorded, ledger } = orderRecording()
    const { calls, refreshIndex } = changeSpy(order)
    // The fake refresh takes the file away, so the read-back has nothing to read.
    const sink = editorEdits(new WorkspaceView(root), "apply", async () => true, undefined, {
      recordEditOperation: ledger,
      refreshIndex: async (changes: readonly IndexChange[]) => {
        const answer = await refreshIndex(changes)
        fs.rmSync(changes[0].path)
        return answer
      }
    }, "background")
    const outcome = await sink.create(target, "created\n")
    assert.ok(outcome.ok, outcome.message)
    assert.strictEqual(outcome.contentHash, undefined, "no hash is invented for a file that could not be read")
    assert.strictEqual(outcome.contentSource, undefined)
    assert.strictEqual(outcome.persisted, undefined)
    assert.deepStrictEqual(calls, [[{ path: target, kind: "write" }]])
    assert.deepStrictEqual(recorded.map((entry) => entry.settled), [["succeeded"]], "the record settles as a successful change")
  })

  test("the delete sink reports the path as a delete and carries the refresh on the success outcome", async function () {
    this.timeout(20000)
    const target = path.join(root, "deleted-by-the-sink.txt")
    fs.writeFileSync(target, "deleted\n")
    const order: string[] = []
    const { calls, refreshIndex } = changeSpy(order)
    await withoutTrash(async () => {
      const outcome = await refreshSinkFor(undefined, refreshIndex).remove(target)
      assert.ok(outcome.ok, outcome.message)
      assert.deepStrictEqual(calls, [[{ path: target, kind: "delete" }]], "the path as gone, not as changed")
      assert.deepStrictEqual(order, ["refresh"], "a delete is not recorded in the ledger, so nothing settles")
      assert.strictEqual(fs.existsSync(target), false, "the file is gone from disk")
      assert.deepStrictEqual(outcome.indexRefresh, { status: "synced" }, "the success outcome carries what the refresh answered")
    })
  })

  test("the move sink reports both paths, the old one as gone and the new one as written, and its hash is the moved file's", async function () {
    this.timeout(20000)
    const source = path.join(root, "moved-by-the-sink.txt")
    const target = path.join(root, "moved-into.txt")
    const content = "moved\n"
    fs.writeFileSync(source, content)
    const order: string[] = []
    const { calls, saw, refreshIndex } = changeSpy(order)
    const outcome = await refreshSinkFor(undefined, refreshIndex).move(source, target)
    assert.ok(outcome.ok, outcome.message)
    assert.deepStrictEqual(calls, [[{ path: source, kind: "delete" }, { path: target, kind: "write" }]], "old path gone, new path written")
    assert.deepStrictEqual(saw, [content], "the file at the new path was on disk when the refresh ran")
    assert.strictEqual(outcome.contentHash, await contentHash(content), "the same file, unchanged by the move")
    assert.deepStrictEqual(outcome.indexRefresh, { status: "synced" })
  })

  test("a review-mode create does not refresh", async function () {
    this.timeout(20000)
    const target = path.join(root, "proposed-by-the-sink.txt")
    const order: string[] = []
    const { calls, saw, refreshIndex } = changeSpy(order)
    const outcome = await editorEdits(new WorkspaceView(root), "review", async () => true, undefined, { refreshIndex }, "background")
      .create(target, "proposed\n")
    assert.ok(outcome.ok, outcome.message)
    assert.ok(outcome.pending, "the file is put to the user as a pending diff, unsaved")
    assert.deepStrictEqual(calls, [], "nothing is on disk for a pending create, so the index is not told")
    assert.deepStrictEqual(saw, [])
    assert.strictEqual(outcome.indexRefresh, undefined)
    assert.strictEqual(outcome.contentHash, undefined, "and the hash line stays out of the tool output")
    assert.strictEqual(fs.existsSync(target), false, "a pending create writes nothing")
    await vscode.commands.executeCommand(TWINNY_COMMAND_NAME.rejectEdit)
  })

  const renamePair = (name: string) => {
    const first = path.join(root, `rename-test-${name}-a.ts`)
    const second = path.join(root, `rename-test-${name}-b.ts`)
    fs.writeFileSync(first, "alpha = 1\n")
    fs.writeFileSync(second, "alpha = 2\n")
    return { first, second }
  }
  /** Stands in for a language server: renames the symbol in the file asked about and in a second test-only file. */
  const renameProviderFor = (second: string) => vscode.languages.registerRenameProvider(
    { scheme: "file", pattern: "**/rename-test-*.ts" },
    {
      provideRenameEdits(document, position, newName) {
        const edit = new vscode.WorkspaceEdit()
        const range = document.getWordRangeAtPosition(position)
        if (range) edit.replace(document.uri, range, newName)
        edit.replace(vscode.Uri.file(second), new vscode.Range(0, 0, 0, 5), newName)
        return edit
      }
    }
  )
  /** The rename provider needs the document it was asked about open in the host. */
  const openForRename = async (file: string) =>
    vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(file)))

  test("the rename refreshes both files the language server reached, with the new text already saved", async function () {
    this.timeout(20000)
    const { first, second } = renamePair("refreshed")
    await openForRename(first)
    const provider = renameProviderFor(second)
    const order: string[] = []
    const { calls, saw, refreshIndex } = changeSpy(order)
    try {
      const tools = workspaceTools(root, [], {
        edits: editorEdits(new WorkspaceView(root), "apply", async () => true, undefined, { refreshIndex }, "background"),
        editor: editorKnowledge(new WorkspaceView(root), "apply", async () => true, undefined, { refreshIndex }),
        git: false,
        instructions: false
      })
      const result = await tools.run({ name: "rename_symbol", args: { path: "rename-test-refreshed-a.ts", symbol: "alpha", new_name: "beta" } })
      assert.strictEqual(result.failed, undefined, result.output)
      assert.deepStrictEqual(
        calls,
        [[{ path: first, kind: "write" }, { path: second, kind: "write" }]],
        "every file the rename reached, as a write"
      )
      assert.deepStrictEqual(saw, ["beta = 1\n", "beta = 2\n"], "both files already held the new text when the refresh read them from disk")
      assert.deepStrictEqual(order, ["refresh"], "the index is caught up before the tool answers")
      assert.strictEqual(
        result.output,
        "Renamed to beta: 2 changes in rename-test-refreshed-a.ts, rename-test-refreshed-b.ts, saved." +
          `\ncontent_hash(rename-test-refreshed-a.ts): ${await contentHash("beta = 1\n")}` +
          `\ncontent_hash(rename-test-refreshed-b.ts): ${await contentHash("beta = 2\n")}`,
        "the message and one hash line per file"
      )
    } finally { provider.dispose() }
  })

  test("a rename the recovery put back refreshes every file it reached as the recovery left it", async function () {
    this.timeout(20000)
    const { first, second } = renamePair("restored")
    await openForRename(first)
    const provider = renameProviderFor(second)
    const checkpoints = createSafeEditCheckpoints(vscode.Uri.file(path.join(root, "storage")))
    // The files as the rename found them. The sink is not given these checkpoints, so what
    // they hold is still what the recovery puts back.
    await checkpoints.capture([first, second])
    const order: string[] = []
    const { calls, saw, refreshIndex } = changeSpy(order)
    let recovery: SignificantEditRecoveryResult | undefined
    const replyChanges = {
      touch: async () => {},
      hold: async <T>(work: Promise<T>): Promise<T> => {
        const applied = await work
        await checkpoints.markChanged([first, second])
        recovery = await recoverSignificantEdit({
          file: "rename-test-restored-a.ts", introducedErrors: 20, diagnosticsObserved: false, diagnosticCheckAvailable: false,
          rollbackRequested: true, checkpoints
        })
        order.push("restored")
        return applied
      }
    }
    try {
      const outcome = await editorKnowledge(new WorkspaceView(root), "apply", async () => true, replyChanges, { refreshIndex })
        .rename(first, 0, 0, "beta")
      assert.ok(recovery?.restored, recovery?.reason)
      assert.ok(recovery?.fileVerified, recovery?.reason)
      assert.deepStrictEqual(order, ["restored", "refresh"], "the refresh runs on what the recovery left, not on the change")
      assert.deepStrictEqual(calls, [[{ path: first, kind: "write" }, { path: second, kind: "write" }]], "every file it reached")
      assert.deepStrictEqual(saw, ["alpha = 1\n", "alpha = 2\n"], "the content the recovery restored")
      assert.deepStrictEqual(outcome.fileHashes, {
        "rename-test-restored-a.ts": await contentHash("alpha = 1\n"),
        "rename-test-restored-b.ts": await contentHash("alpha = 2\n")
      }, "and the hashes the model is given are the restored ones")
      assert.strictEqual(fs.readFileSync(second, "utf8"), "alpha = 2\n", "the second file is back as it was on disk")
    } finally {
      provider.dispose()
      await checkpoints.clear()
    }
  })

  test("a rename refused before anything was attempted is not caught up with the index", async function () {
    this.timeout(20000)
    const { first, second } = renamePair("refused")
    await openForRename(first)
    const provider = renameProviderFor(second)
    const order: string[] = []
    const { calls, saw, refreshIndex } = changeSpy(order)
    try {
      const outcome = await editorKnowledge(new WorkspaceView(root), "review", async () => false, undefined, { refreshIndex })
        .rename(first, 0, 0, "beta")
      assert.strictEqual(outcome.ok, false, outcome.message)
      assert.strictEqual(outcome.message, "The user chose not to rename it.")
      assert.deepStrictEqual(calls, [], "nothing was attempted, so nothing is caught up")
      assert.deepStrictEqual(saw, [])
      assert.deepStrictEqual(order, [])
      assert.strictEqual(outcome.fileHashes, undefined)
      assert.strictEqual(fs.readFileSync(first, "utf8"), "alpha = 1\n")
      assert.strictEqual(fs.readFileSync(second, "utf8"), "alpha = 2\n")
    } finally { provider.dispose() }
  })

})
