import * as assert from "assert"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import * as vscode from "vscode"

import { chatAccessApprover } from "../../extension/chat/access-approval"
import { EditCommandRunner, editorEdits, editorKnowledge, type EditSafetyOptions } from "../../extension/chat/tool-sinks"
import { AccessGrant, AccessStore, GrantMemento } from "../../extension/tools/access-grants"
import { currentAccessHostKey } from "../../extension/tools/access-host"
import { AccessApprover, AccessChoice, AccessPrompt, createAccessPreflight } from "../../extension/tools/access-preflight"
import { contentHash } from "../../extension/tools/line-edit"
import { OperationAuthorization } from "../../extension/tools/operation-authorization"
import { ToolCall } from "../../extension/tools/protocol"
import { WorkspaceView } from "../../extension/tools/view"
import { ToolResult, workspaceTools } from "../../extension/tools/workspace"
import { WorkspaceIntelligenceIndex } from "../../extension/workspace-index"

suite("Native file access outside the workspace, in the extension host", function () {
  this.timeout(60000)

  let scratch = ""
  let root = ""
  let outside = ""
  let logFile = ""
  let text = ""

  setup(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-file-access-"))
    root = path.join(scratch, "workspace")
    outside = path.join(scratch, "outside")
    fs.mkdirSync(root)
    fs.mkdirSync(outside)
    fs.mkdirSync(path.join(scratch, "outside-twin"))
    logFile = path.join(outside, "test.log")
    text = "first line\nsecond line\nthird line\n"
    fs.writeFileSync(logFile, text)
    fs.writeFileSync(path.join(outside, "other.log"), "other\n")
    fs.writeFileSync(path.join(scratch, "outside-twin", "twin.log"), "twin\n")
  })

  teardown(() => {
    fs.rmSync(scratch, { recursive: true, force: true })
  })

  const memory = (): GrantMemento => {
    const data = new Map<string, unknown>()
    return {
      get: <T>(key: string) => data.get(key) as T | undefined,
      update: async (key: string, value: unknown) => {
        data.set(key, value)
      }
    }
  }

  type Choose = (prompt: AccessPrompt, signal?: AbortSignal) => AccessChoice | undefined | Promise<AccessChoice | undefined>

  /** The production view, grants and preflight over the real tool dispatcher, with the approver under test. */
  /**
   * With `writes`, changes go through the real editor edit sink, applying without a further question. The
   * host defaults to the one the edit service checks, so an approved write can reach the editor.
   */
  const harness = (choose: Choose, stored?: GrantMemento, host = currentAccessHostKey(), writes = false, runEditCommand?: EditCommandRunner, withEditor = false) => {
    const store = new AccessStore(stored, host)
    const view = new WorkspaceView(root, [], undefined, [], [], () =>
      store.grants().map((grant: AccessGrant) => ({ root: grant.root, real: grant.real, scope: grant.scope }))
    )
    const asked: AccessPrompt[] = []
    const approve: AccessApprover = async (prompt, signal) => {
      asked.push(prompt)
      return choose(prompt, signal)
    }
    const edits = writes ? editorEdits(view, "apply", async () => true, undefined, { runEditCommand }) : undefined
    const editor = withEditor ? editorKnowledge(view, "apply", async () => true) : undefined
    const tools = workspaceTools(view, [], { access: createAccessPreflight({ store, view, approve }), edits, editor })
    return { store, asked, tools }
  }

  // VS Code ignores a workspace-folder change until the previous one is confirmed, so each change is awaited.
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

  const read = (tools: ReturnType<typeof harness>["tools"], file: string, extra: Record<string, string> = {}, signal?: AbortSignal): Promise<ToolResult> =>
    tools.run({ name: "read_file", args: { path: file, ...extra } }, signal ? { signal } : undefined)

  const once: AccessChoice = { target: "exact", lifetime: "once" }
  const sessionFile: AccessChoice = { target: "exact", lifetime: "session" }

  test("a /tmp log is asked for once, the same read resumes, and it returns the whole-file hash", async () => {
    const h = harness(() => once)
    const result = await read(h.tools, logFile, { start_line: "2", end_line: "2" })
    assert.equal(h.asked.length, 1)
    assert.equal(h.asked[0].tool, "read_file")
    assert.equal(h.asked[0].access, "read")
    assert.ok(!result.failed, result.output)
    assert.ok(result.output.includes("second line"), "the requested range is read")
    assert.ok(result.output.includes(`content_hash: ${await contentHash(text)}`), "the hash covers the whole file, not the range")
    assert.ok(result.output.includes("total_lines: 3"))
  })

  test("a once grant lapses when its call ends, so the next read asks again", async () => {
    const h = harness(() => once)
    await read(h.tools, logFile)
    await read(h.tools, logFile)
    assert.equal(h.asked.length, 2)
  })

  test("a session grant covers later reads in the same host session, and not a new session", async () => {
    const h = harness(() => sessionFile)
    assert.ok(!(await read(h.tools, logFile)).failed)
    assert.ok(!(await read(h.tools, logFile)).failed)
    assert.equal(h.asked.length, 1)

    const restarted = harness(() => undefined)
    const denied = await read(restarted.tools, logFile)
    assert.ok(denied.failed)
    assert.equal(restarted.asked.length, 1, "a new session asks again")
  })

  test("a file grant does not cover a neighbour, and a folder grant covers descendants but not a similarly named sibling", async () => {
    const file = harness(() => sessionFile)
    await read(file.tools, logFile)
    await read(file.tools, path.join(outside, "other.log"))
    assert.equal(file.asked.length, 2, "a neighbour in the same folder is asked for")

    const folder = harness(() => ({ target: "folder", lifetime: "session" }))
    await read(folder.tools, logFile)
    fs.mkdirSync(path.join(outside, "deep"))
    fs.writeFileSync(path.join(outside, "deep", "nested.log"), "nested\n")
    assert.ok(!(await read(folder.tools, path.join(outside, "deep", "nested.log"))).failed)
    assert.equal(folder.asked.length, 1, "descendants are covered")

    await read(folder.tools, path.join(scratch, "outside-twin", "twin.log"))
    assert.equal(folder.asked.length, 2, "a sibling with the same prefix is asked for")
  })

  test("deny, a thrown approver and an unexpected answer each refuse the read", async () => {
    const denied = harness(() => "deny")
    const refused = await read(denied.tools, logFile)
    assert.ok(refused.failed)
    assert.ok(refused.output.includes("not granted"), refused.output)

    const thrown = harness(() => {
      throw new Error("no window")
    })
    assert.ok((await read(thrown.tools, logFile)).failed)

    const unexpected = harness(() => undefined)
    assert.ok((await read(unexpected.tools, logFile)).failed)
  })

  test("always grants persist for this host, and a revoke makes the next read ask again", async () => {
    const stored = memory()
    const first = harness(() => ({ target: "exact", lifetime: "always" }), stored)
    assert.ok(!(await read(first.tools, logFile)).failed)

    const later = harness(() => "deny", stored)
    assert.ok(!(await read(later.tools, logFile)).failed, "the stored grant applies to a new store")
    assert.equal(later.asked.length, 0)

    await later.store.revoke(() => true)
    const afterRevoke = harness(() => "deny", stored)
    assert.ok((await read(afterRevoke.tools, logFile)).failed)
    assert.equal(afterRevoke.asked.length, 1)
  })

  test("an always grant made on one host does not apply on another", async () => {
    const stored = memory()
    const local = harness(() => ({ target: "exact", lifetime: "always" }), stored, "local|machine")
    await read(local.tools, logFile)
    const remote = harness(() => "deny", stored, "ssh-remote+server|machine")
    assert.ok((await read(remote.tools, logFile)).failed)
    assert.equal(remote.asked.length, 1)
  })

  const folderSession: AccessChoice = { target: "folder", lifetime: "session" }
  const edited = "first line\nsecond, edited\nthird line\n"
  const editLines = (file: string, hash: string): ToolCall => ({
    name: "edit_lines",
    args: { path: file, expected_hash: hash, edits: JSON.stringify([{ operation: "replace", start_line: 2, end_line: 2, content: ["second, edited"] }]) }
  })

  test("approved outside writes reach the real editor edit sink, and each applies once", async () => {
    const h = harness(() => folderSession, undefined, currentAccessHostKey(), true)
    const before = await read(h.tools, logFile)
    assert.ok(!before.failed, before.output)

    const changed = await h.tools.run(editLines(logFile, await contentHash(text)))
    assert.ok(!changed.failed, changed.output)
    assert.equal(fs.readFileSync(logFile, "utf8"), edited)

    const created = await h.tools.run({ name: "create_file", args: { path: path.join(outside, "made.txt"), content: "made\n" } })
    assert.ok(!created.failed, created.output)
    assert.equal(fs.readFileSync(path.join(outside, "made.txt"), "utf8"), "made\n")

    const moved = await h.tools.run({ name: "move_file", args: { from: logFile, to: path.join(outside, "moved.log") } })
    assert.ok(!moved.failed, moved.output)
    assert.equal(fs.existsSync(logFile), false)
    assert.equal(fs.readFileSync(path.join(outside, "moved.log"), "utf8"), edited)

    // Deletion is covered with the other deletion cases below.
    assert.equal(h.asked.filter((prompt) => prompt.access === "write").length, 1, "the folder grant covers the later writes without asking again")
  })

  test("a denied outside write never reaches the real editor edit sink", async () => {
    const h = harness((prompt) => (prompt.access === "read" ? folderSession : "deny"), undefined, currentAccessHostKey(), true)
    assert.ok(!(await read(h.tools, logFile)).failed)

    const results = [
      await h.tools.run(editLines(logFile, await contentHash(text))),
      await h.tools.run({ name: "create_file", args: { path: path.join(outside, "made.txt"), content: "made\n" } }),
      await h.tools.run({ name: "delete_file", args: { path: path.join(outside, "other.log") } }),
      await h.tools.run({ name: "move_file", args: { from: logFile, to: path.join(outside, "moved.log") } })
    ]

    for (const result of results) assert.equal(result.failed, true, result.output)
    assert.equal(fs.readFileSync(logFile, "utf8"), text)
    assert.equal(fs.existsSync(path.join(outside, "made.txt")), false)
    assert.equal(fs.existsSync(path.join(outside, "other.log")), true)
    assert.equal(fs.existsSync(path.join(outside, "moved.log")), false)
  })

  test("a move is refused whole when either outside path is denied, so nothing moves", async () => {
    const twin = path.join(scratch, "outside-twin")
    const deniedDestination = harness((prompt) => (prompt.path.startsWith(twin + path.sep) ? "deny" : folderSession), undefined, currentAccessHostKey(), true)
    const movedAway = await deniedDestination.tools.run({ name: "move_file", args: { from: logFile, to: path.join(twin, "moved.log") } })
    assert.equal(movedAway.failed, true, movedAway.output)
    assert.equal(fs.readFileSync(logFile, "utf8"), text)
    assert.equal(fs.existsSync(path.join(twin, "moved.log")), false)
    assert.equal(fs.readFileSync(path.join(twin, "twin.log"), "utf8"), "twin\n")

    const deniedSource = harness((prompt) => (prompt.path === logFile ? "deny" : folderSession), undefined, currentAccessHostKey(), true)
    const movedIn = await deniedSource.tools.run({ name: "move_file", args: { from: logFile, to: path.join(outside, "moved.log") } })
    assert.equal(movedIn.failed, true, movedIn.output)
    assert.equal(fs.readFileSync(logFile, "utf8"), text)
    assert.equal(fs.existsSync(path.join(outside, "moved.log")), false)
  })

  test("a protected path outside the workspace is refused for reads and writes, with no prompt", async () => {
    const config = path.join(outside, ".git", "config")
    fs.mkdirSync(path.dirname(config))
    fs.writeFileSync(config, "[remote]\nsecret = yes\n")
    const h = harness(() => folderSession, undefined, currentAccessHostKey(), true)

    const readResult = await read(h.tools, config)
    const created = await h.tools.run({ name: "create_file", args: { path: path.join(outside, ".git", "hooks", "post"), content: "x" } })

    assert.equal(readResult.failed, true)
    assert.equal(created.failed, true)
    assert.equal(h.asked.length, 0)
    assert.equal(fs.readFileSync(config, "utf8"), "[remote]\nsecret = yes\n")
    assert.equal(fs.existsSync(path.join(outside, ".git", "hooks", "post")), false)
  })

  test("a symlink inside an approved folder that leads out of it is refused with no prompt, and no write goes through it", async () => {
    const target = path.join(scratch, "outside-twin", "twin.log")
    fs.writeFileSync(target, "escaped-content-marker\n")
    const h = harness(() => folderSession, undefined, currentAccessHostKey(), true)
    assert.ok(!(await read(h.tools, logFile)).failed)
    const asked = h.asked.length
    const escape = path.join(outside, "escape.log")
    fs.symlinkSync(target, escape)

    const readResult = await read(h.tools, escape)
    const deleted = await h.tools.run({ name: "delete_file", args: { path: escape } })

    assert.equal(readResult.failed, true)
    assert.match(readResult.output, /leads outside/)
    assert.doesNotMatch(readResult.output, /escaped-content-marker/)
    assert.equal(deleted.failed, true)
    assert.equal(h.asked.length, asked, "the escape is refused before any prompt")
    assert.equal(fs.readFileSync(target, "utf8"), "escaped-content-marker\n")
  })

  const publicOutcome = (value: unknown) => value as { ok: boolean; message: string } | undefined

  const activateExtension = async () => {
    const extension = vscode.extensions.getExtension("rjmacarthy.twinny")
    assert.ok(extension, "the extension under test is loaded")
    await extension.activate()
  }

  test("public chat file commands refuse outside paths without a verified write, even with a session grant", async () => {
    await activateExtension()
    const h = harness(() => folderSession, undefined, currentAccessHostKey(), true)
    assert.ok(!(await read(h.tools, logFile)).failed, "the session grant is in place")
    const made = path.join(outside, "public.txt")

    const created = publicOutcome(await vscode.commands.executeCommand("twinny.chatFileCreate", made, "public\n", "apply"))
    const edited = publicOutcome(await vscode.commands.executeCommand("twinny.chatFileEdit", { file: logFile, lineEdits: [] }, "apply"))

    assert.equal(created?.ok, false)
    assert.equal(edited?.ok, false)
    assert.equal(fs.existsSync(made), false)
    assert.equal(fs.readFileSync(logFile, "utf8"), text)
  })

  test("a forged write token is refused by the public commands", async () => {
    await activateExtension()
    const made = path.join(outside, "forged.txt")
    const forgeries: unknown[] = [{}, Object.create(OperationAuthorization.prototype)]

    for (const forged of forgeries) {
      const created = publicOutcome(await vscode.commands.executeCommand("twinny.chatFileCreate", made, "forged\n", "apply", forged))
      assert.equal(created?.ok, false)
    }
    assert.equal(fs.existsSync(made), false)
  })

  test("a captured write token is single-use: replaying it through a public command is refused", async () => {
    await activateExtension()
    const commands: unknown[][] = []
    const recording: EditCommandRunner = (command, ...args) => {
      commands.push([command, ...args])
      return vscode.commands.executeCommand(command, ...args)
    }
    const h = harness(() => folderSession, undefined, currentAccessHostKey(), true, recording)
    assert.ok(!(await read(h.tools, logFile)).failed)
    const made = path.join(outside, "made.txt")
    assert.ok(!(await h.tools.run({ name: "create_file", args: { path: made, content: "made\n" } })).failed)
    const issued = commands.find((call) => call[0] === "twinny.chatFileCreate")
    assert.ok(issued, "the approved create reached the edit command")
    fs.rmSync(made)

    const replayed = publicOutcome(await vscode.commands.executeCommand("twinny.chatFileCreate", made, "again\n", "apply", issued[4]))

    assert.equal(replayed?.ok, false)
    assert.equal(fs.existsSync(made), false)
  })

  test("an approved external read never enters the workspace index, and an in-folder control does", async function () {
    this.timeout(120000)
    const external = path.join(outside, "external-secret.log")
    fs.writeFileSync(external, "externalOnlyToken\n")
    fs.writeFileSync(path.join(root, "inside.txt"), "positiveControlToken\n")
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-file-access-storage-"))
    const originalFolders = (vscode.workspace.workspaceFolders ?? []).map((folder) => ({ uri: folder.uri, name: folder.name }))
    let index: WorkspaceIntelligenceIndex | undefined
    try {
      assert.equal(await updateWorkspaceFolders(0, originalFolders.length, { uri: vscode.Uri.file(root), name: "access-root" }), true)
      const h = harness(() => sessionFile)

      const result = await read(h.tools, external)
      assert.ok(!result.failed, result.output)
      assert.match(result.output, /externalOnlyToken/)

      index = new WorkspaceIntelligenceIndex(vscode.Uri.file(storage))
      await index.rebuild()
      assert.equal(index.snapshot.status, "ready")
      assert.ok((await index.search({ query: "positiveControlToken", mode: "literal" }, root)).total > 0, "control: the file inside the folder is indexed")
      assert.equal((await index.search({ query: "externalOnlyToken", mode: "literal" }, root)).total, 0, "the approved external file is not indexed")
      assert.equal((await index.search({ query: "external-secret", mode: "path" }, root)).total, 0, "nor is it indexed by its path")
    } finally {
      index?.dispose()
      await updateWorkspaceFolders(0, vscode.workspace.workspaceFolders?.length ?? 0, ...originalFolders)
      fs.rmSync(storage, { recursive: true, force: true })
    }
  })

  suite("deletion and move through the editor", () => {
    const workspaceApi = vscode.workspace as unknown as { applyEdit: (edit: vscode.WorkspaceEdit) => Thenable<boolean> }
    const filesConfig = vscode.workspace.getConfiguration("files")
    let original: (edit: vscode.WorkspaceEdit) => Thenable<boolean>
    let originalTrash: unknown
    let handedOff = 0

    // The test host has no trash on this filesystem, so deletes run with trash off. Production behavior is unchanged.
    setup(async () => {
      original = workspaceApi.applyEdit
      handedOff = 0
      originalTrash = filesConfig.inspect("enableTrash")?.globalValue
      await filesConfig.update("enableTrash", false, vscode.ConfigurationTarget.Global)
      workspaceApi.applyEdit = (edit) => {
        handedOff += 1
        return original.call(vscode.workspace, edit)
      }
    })

    teardown(async () => {
      workspaceApi.applyEdit = original
      await filesConfig.update("enableTrash", originalTrash, vscode.ConfigurationTarget.Global)
    })

    test("an approved outside delete is handed to the editor once and removes the file from disk", async () => {
      const target = path.join(outside, "other.log")
      const h = harness(() => folderSession, undefined, currentAccessHostKey(), true)
      const deleted = await h.tools.run({ name: "delete_file", args: { path: target } })
      assert.ok(!deleted.failed, deleted.output)
      assert.equal(handedOff, 1)
      assert.equal(fs.existsSync(target), false)
    })

    test("an unapproved outside delete or move is refused before the editor is asked, and changes nothing", async () => {
      const view = new WorkspaceView(root, [], undefined, [], [], () => [])
      const sink = editorEdits(view, "apply", async () => true)
      const removed = await sink.remove(path.join(outside, "other.log"))
      const moved = await sink.move(logFile, path.join(outside, "moved.log"))
      assert.equal(removed.ok, false)
      assert.equal(moved.ok, false)
      assert.equal(handedOff, 0)
      assert.equal(fs.existsSync(path.join(outside, "other.log")), true)
      assert.equal(fs.readFileSync(logFile, "utf8"), text)
      assert.equal(fs.existsSync(path.join(outside, "moved.log")), false)
    })
    test("an unapproved outside edit, line edit or create is refused before its file is copied for a checkpoint", async () => {
      const copied: string[] = []
      const checkpoints = {
        capture: async (files: string[]) => {
          copied.push(...files)
        },
        markChanged: async () => undefined,
        commit: async () => undefined
      } as unknown as NonNullable<EditSafetyOptions["checkpoints"]>
      const view = new WorkspaceView(root, [], undefined, [], [], () => [])
      const sink = editorEdits(view, "apply", async () => true, undefined, { checkpoints })
      const made = path.join(outside, "made.txt")

      const edited = await sink.edit(logFile, { startLine: 2, endLine: 2, original: "second line", text: "second, edited" })
      const lined = await sink.editLines?.(logFile, { expected_hash: await contentHash(text), edits: [] }, true)
      const created = await sink.create(made, "made\n")

      assert.equal(edited.ok, false)
      assert.equal(lined?.ok, false)
      assert.equal(created.ok, false)
      assert.deepEqual(copied, [], "nothing outside is copied without an approval")
      assert.equal(handedOff, 0)
      assert.equal(fs.readFileSync(logFile, "utf8"), text)
      assert.equal(fs.existsSync(made), false)
    })
  })

  suite("rename through the editor", () => {
    let provider: vscode.Disposable | undefined
    let renames = 0
    let twin = ""

    setup(async () => {
      renames = 0
      twin = path.join(scratch, "outside-twin", "twin.log")
      fs.writeFileSync(logFile, "alpha = 1\n")
      fs.writeFileSync(twin, "alpha = 2\n")
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(logFile)))
      // Stands in for a language server: renames the symbol in the file asked about and in a sibling outside the workspace.
      provider = vscode.languages.registerRenameProvider(
        { scheme: "file" },
        {
          provideRenameEdits(document, position, newName) {
            renames += 1
            const edit = new vscode.WorkspaceEdit()
            const range = document.getWordRangeAtPosition(position)
            if (range) edit.replace(document.uri, range, newName)
            edit.replace(vscode.Uri.file(twin), new vscode.Range(0, 0, 0, 5), newName)
            return edit
          }
        }
      )
    })

    teardown(async () => {
      provider?.dispose()
      await vscode.commands.executeCommand("workbench.action.closeAllEditors")
    })

    test("a rename is refused whole when a file it would reach outside the workspace is denied, and changes nothing", async () => {
      const h = harness((prompt) => (prompt.path === twin ? "deny" : folderSession), undefined, currentAccessHostKey(), true, undefined, true)
      const renamed = await h.tools.run({ name: "rename_symbol", args: { path: logFile, symbol: "alpha", new_name: "beta" } })
      assert.equal(renamed.failed, true, renamed.output)
      assert.equal(renames, 1, "the rename was asked for, and refused before anything applied")
      assert.equal(fs.readFileSync(logFile, "utf8"), "alpha = 1\n")
      assert.equal(fs.readFileSync(twin, "utf8"), "alpha = 2\n")
    })

    test("an approved rename reaches the real editor sink and renames each file once", async () => {
      const h = harness(() => folderSession, undefined, currentAccessHostKey(), true, undefined, true)
      const renamed = await h.tools.run({ name: "rename_symbol", args: { path: logFile, symbol: "alpha", new_name: "beta" } })
      assert.ok(!renamed.failed, renamed.output)
      assert.equal(renames, 1)
      assert.equal(fs.readFileSync(logFile, "utf8"), "beta = 1\n")
      assert.equal(fs.readFileSync(twin, "utf8"), "beta = 2\n")
    })
  })

  suite("the VS Code prompt", () => {
    const window = vscode.window as unknown as { showQuickPick: unknown }
    let original: unknown

    setup(() => {
      original = window.showQuickPick
    })

    teardown(() => {
      window.showQuickPick = original
    })

    test("offers the seven choices for a file, with Deny last and Read access shown in the title", async () => {
      let labels: string[] = []
      let options: vscode.QuickPickOptions | undefined
      window.showQuickPick = async (items: readonly vscode.QuickPickItem[], opts: vscode.QuickPickOptions) => {
        labels = items.map((item) => item.label)
        options = opts
        return undefined
      }
      const h = harness((prompt, signal) => chatAccessApprover(prompt, signal))
      const result = await read(h.tools, logFile)
      assert.deepEqual(labels, [
        "Allow file once",
        "Allow folder once",
        "Allow file for session",
        "Allow folder for session",
        "Always allow file",
        "Always allow folder",
        "Deny"
      ])
      assert.equal(options?.ignoreFocusOut, true)
      assert.ok(options?.title?.includes("read access"), options?.title)
      assert.ok(result.failed, "a dismissed prompt denies")
    })

    test("a directory uses this directory for its exact choices", async () => {
      let labels: string[] = []
      window.showQuickPick = async (items: readonly vscode.QuickPickItem[]) => {
        labels = items.map((item) => item.label)
        return undefined
      }
      const h = harness((prompt, signal) => chatAccessApprover(prompt, signal))
      await h.tools.run({ name: "list_dir", args: { path: outside } })
      assert.equal(labels[0], "Allow this directory once")
      assert.ok(labels.includes("Always allow this directory"))
    })

    test("choosing Allow file for session resumes the read and keeps the grant", async () => {
      window.showQuickPick = async (items: readonly vscode.QuickPickItem[]) => items.find((item) => item.label === "Allow file for session")
      const h = harness((prompt, signal) => chatAccessApprover(prompt, signal))
      const result = await read(h.tools, logFile)
      assert.ok(!result.failed, result.output)
      assert.ok(result.output.includes("first line"))
      assert.ok(!(await read(h.tools, logFile)).failed)
      assert.equal(h.asked.length, 1)
    })

    test("a cancelled prompt denies and never resumes the read", async () => {
      window.showQuickPick = (_items: readonly vscode.QuickPickItem[], _options: vscode.QuickPickOptions, token?: vscode.CancellationToken) =>
        new Promise((resolve) => token?.onCancellationRequested(() => resolve(undefined)))
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 50)
      const h = harness((prompt, signal) => chatAccessApprover(prompt, signal))
      const result = await read(h.tools, logFile, {}, controller.signal)
      assert.ok(result.failed)
      assert.ok(result.output.includes("not granted"), result.output)
    })

    test("unavailable UI denies rather than hanging", async () => {
      window.showQuickPick = async () => {
        throw new Error("no window available")
      }
      const h = harness((prompt, signal) => chatAccessApprover(prompt, signal))
      assert.ok((await read(h.tools, logFile)).failed)
    })
  })
})
