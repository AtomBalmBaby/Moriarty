import * as assert from "assert"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import * as vscode from "vscode"

import { createSafeEditCheckpoints, editorEdits } from "../../extension/chat/tool-sinks"
import { applyDocumentLineEdits } from "../../extension/edit/line-edit"
import { contentHash, LineEditRequest } from "../../extension/tools/line-edit"
import { WorkspaceView } from "../../extension/tools/view"
import { workspaceTools } from "../../extension/tools/workspace"

suite("Hash-verified native line edits", () => {
  let root: string
  let file: string

  setup(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-editor-lines-"))
    file = path.join(root, "source.txt")
    fs.writeFileSync(file, "first\nsecond\nthird\nfourth\n")
  })

  teardown(async () => {
    for (const document of vscode.workspace.textDocuments.filter((entry) => entry.uri.fsPath.startsWith(root + path.sep))) {
      await vscode.window.showTextDocument(document)
      await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor")
    }
    fs.rmSync(root, { recursive: true, force: true })
  })

  const request = (text: string, edits: unknown): LineEditRequest => ({ expected_hash: contentHash(text), edits })

  test("real editor applies all operations once, preserves dirty text, and undo reverses the batch", async () => {
    const document = await vscode.workspace.openTextDocument(file)
    const editor = await vscode.window.showTextDocument(document)
    await editor.edit((builder) => builder.replace(new vscode.Range(0, 0, 0, 5), "dirty"))
    const original = document.getText()
    let events = 0
    const listener = vscode.workspace.onDidChangeTextDocument((event) => { if (event.document === document && event.contentChanges.length) events++ })
    try {
      const result = await applyDocumentLineEdits(file, request(original, [
        { operation: "replace", start_line: 2, end_line: 2, content: ["SECOND", "extra"] },
        { operation: "delete", start_line: 3, end_line: 3 },
        { operation: "insert_after", line: 4, content: ["last"] }
      ]))
      assert.ok(result.ok, result.message)
      assert.strictEqual(document.getText(), "dirty\nSECOND\nextra\nfourth\nlast\n")
      assert.strictEqual(result.contentHash, contentHash(document.getText()))
      assert.strictEqual(events, 1, "no intermediate document state")
      assert.ok(document.isDirty)
      assert.strictEqual(fs.readFileSync(file, "utf8"), "first\nsecond\nthird\nfourth\n")
      await vscode.commands.executeCommand("undo")
      assert.strictEqual(document.getText(), original, "one undo restores the entire batch but retains the prior user edit")
    } finally { listener.dispose() }
  })

  for (const eol of ["\n", "\r\n"]) test(`real editor retains ${eol === "\n" ? "LF" : "CRLF"} and unaffected lines`, async () => {
    fs.writeFileSync(file, ["one", "two", "three", ""].join(eol))
    const document = await vscode.workspace.openTextDocument(file)
    const result = await applyDocumentLineEdits(file, request(document.getText(), [
      { operation: "replace", start_line: 2, end_line: 2, content: ["TWO", "inserted"] }
    ]))
    assert.ok(result.ok, result.message)
    assert.strictEqual(document.getText(), ["one", "TWO", "inserted", "three", ""].join(eol))
  })

  test("real editor rejects stale hashes, invalid later edits and overlaps without any document event", async () => {
    const document = await vscode.workspace.openTextDocument(file)
    const original = document.getText()
    let events = 0
    const listener = vscode.workspace.onDidChangeTextDocument((event) => { if (event.document === document && event.contentChanges.length) events++ })
    try {
      for (const [expected, edits, code] of [
        [contentHash("outdated"), [{ operation: "delete", start_line: 1, end_line: 1 }], "hash_mismatch"],
        [contentHash(original), [{ operation: "delete", start_line: 1, end_line: 1 }, { operation: "delete", start_line: 99, end_line: 99 }], "invalid_range"],
        [contentHash(original), [{ operation: "delete", start_line: 1, end_line: 2 }, { operation: "delete", start_line: 2, end_line: 3 }], "overlapping_edits"]
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
      const result = await applyDocumentLineEdits(file, request(original, [{ operation: "delete", start_line: 2, end_line: 2 }]))
      if (changed) await changed
      assert.strictEqual(result.ok, false, "a concurrent version change must not be overwritten")
      assert.ok(result.error?.code === "hash_mismatch" || result.error?.code === "application_failed")
      assert.ok(document.getText().includes("second"))
      assert.ok(document.getText().includes("user: "))
    } finally { listener.dispose() }
  })

  test("native dispatcher reads dirty buffers, requests review approval and uses checkpoints", async function () {
    this.timeout(15000)
    const document = await vscode.workspace.openTextDocument(file)
    const editor = await vscode.window.showTextDocument(document)
    await editor.edit((builder) => builder.insert(new vscode.Position(0, 0), "dirty: "))
    const original = document.getText()
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
    assert.ok(read.output.includes(contentHash(original)))
    const args = { path: "source.txt", expected_hash: contentHash(original), edits: JSON.stringify([{ operation: "replace", start_line: 2, end_line: 2, content: ["approved"] }]) }
    const denied = await tools.run({ name: "edit_lines", args })
    assert.strictEqual(JSON.parse(denied.output).error.code, "permission_denied")
    assert.strictEqual(document.getText(), original)
    approved = true
    const result = await tools.run({ name: "edit_lines", args })
    assert.ok(!result.failed, result.output)
    assert.strictEqual(JSON.parse(result.output).content_hash, contentHash(document.getText()))
    assert.ok(document.getText().includes("approved"))
    assert.strictEqual(asked.length, 2)
    assert.ok(document.isDirty)
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
    assert.ok(read.output.includes(contentHash(source)), read.output)
    const result = await tools.run({ name: "edit_lines", args: { path: "encoded.txt", expected_hash: contentHash(source), edits: JSON.stringify([{ operation: "replace", start_line: 1, end_line: 1, content: ["after"] }]) } })
    assert.ok(!result.failed, result.output)
    assert.ok(await document.save())
    assert.deepStrictEqual(fs.readFileSync(file), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("after\r\nuntouched\r\n", "utf16le")]))
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
      const result = await tools.run({ name: "edit_lines", args: { path: "panel.tsx", expected_hash: contentHash(source), edits: JSON.stringify([
        { operation: "replace", start_line: 2, end_line: 2, content: ["export function Panel() {"] },
        { operation: "replace", start_line: 3, end_line: 3, content: ["  return " + jsx] },
        { operation: "replace", start_line: 4, end_line: 4, content: ["}"] }
      ]) } })
      assert.ok(!result.failed, result.output)
      assert.deepStrictEqual(observed, ["// @ts-nocheck\nexport function Panel() {\n  return " + jsx + "\n}\n"])
      assert.strictEqual(recoveries, 0)
      assert.strictEqual(JSON.parse(result.output).content_hash, contentHash(document.getText()))
    } finally { listener.dispose() }
  })

  test("line edits retain catastrophic diagnostic recovery and block subsequent mutations", async function () {
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
    const tools = workspaceTools(root, [], {
      edits: editorEdits(new WorkspaceView(root), "apply", async () => true, undefined, { checkpoints, onCatastrophic: () => { recoveries++ } }),
      git: false, instructions: false
    })
    try {
      const result = await tools.run({ name: "edit_lines", args: { path: "regression.ts", expected_hash: contentHash(source), edits: JSON.stringify([{ operation: "replace", start_line: 1, end_line: 1, content: ["export const BROKEN = 1"] }]) } })
      assert.strictEqual(result.failed, true, result.output)
      assert.strictEqual(recoveries, 1)
      assert.strictEqual(document.getText(), source, "the existing safe checkpoint restored the complete snapshot")
      const blocked = await tools.run({ name: "edit_lines", args: { path: "regression.ts", expected_hash: contentHash(source), edits: JSON.stringify([{ operation: "delete", start_line: 1, end_line: 1 }]) } })
      assert.strictEqual(JSON.parse(blocked.output).error.code, "permission_denied")
      assert.strictEqual(document.getText(), source)
    } finally {
      listener.dispose()
      diagnostics.dispose()
      await checkpoints.clear()
    }
  })


  test("dirty UTF-16 checkpoint recovery preserves both buffer text and exact disk bytes", async () => {
    file = path.join(root, "dirty-encoded.txt")
    const source = "before \u00e9\r\nuntouched\r\n"
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(source, "utf16le")])
    fs.writeFileSync(file, bytes)
    const document = await vscode.workspace.openTextDocument(file)
    const editor = await vscode.window.showTextDocument(document)
    await editor.edit((builder) => builder.insert(new vscode.Position(0, 0), "user: "))
    const dirty = document.getText()
    const checkpoints = createSafeEditCheckpoints(vscode.Uri.file(path.join(root, "storage")))
    try {
      await checkpoints.capture([file])
      const result = await applyDocumentLineEdits(file, request(dirty, [{ operation: "replace", start_line: 2, end_line: 2, content: ["changed"] }]))
      assert.ok(result.ok, result.message)
      await checkpoints.markChanged([file])
      const restored = await checkpoints.rollback()
      assert.ok(restored.restored, restored.reason)
      assert.strictEqual(document.getText(), dirty)
      assert.ok(document.isDirty)
      assert.deepStrictEqual(fs.readFileSync(file), bytes)
    } finally { await checkpoints.clear() }
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
    const result = await tools.run({ name: "edit_lines", args: { path: "source.txt", expected_hash: contentHash(original), edits: JSON.stringify([{ operation: "delete", start_line: 2, end_line: 2 }]) } })
    assert.strictEqual(result.failed, true)
    const error = JSON.parse(result.output).error
    assert.strictEqual(error.code, "hash_mismatch")
    assert.strictEqual(error.current_hash, contentHash(document.getText()))
    assert.strictEqual(document.getText(), "user: " + original)
  })

})
