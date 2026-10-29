/**
 * One agent reply from end to end, as close to a live window as a test
 * host gets: a typed message goes through the chat, a scripted model
 * reads a file, edits it and runs a command through the real tools, the
 * editor applies the edit, the reply is handed to the webview with its
 * steps, the project's instructions, the errors check and the files it
 * changed, and undo puts the workspace back.
 */
import * as assert from "assert"
import { execFileSync } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import * as vscode from "vscode"

import { ACTIVE_CHAT_PROVIDER_STORAGE_KEY, EVENT_NAME, GLOBAL_STORAGE_KEY } from "../../common/constants"
import { ChatCompletionMessage, ReplyChangesView, ToolStepView, TwinnyProvider } from "../../common/types"
import { Chat } from "../../extension/chat/index"
import { GenerationTracker } from "../../extension/generations"
import { ChatRequest, InferenceProvider, providerRegistry } from "../../extension/inference"
import { ExtensionBridge } from "../../extension/messaging/bridge"

/** A model that answers each request with the next scripted reply. */
class ScriptedModel implements InferenceProvider {
  public readonly id = "scripted-agent"
  public requests: ChatRequest[] = []

  constructor(private readonly _replies: string[]) {}

  capabilities() {
    return ["chat" as const]
  }

  async *chat(request: ChatRequest) {
    this.requests.push(structuredClone(request))
    const reply = this._replies.shift() ?? "Done."
    for (let i = 0; i < reply.length; i += 9) yield { content: reply.slice(i, i + 9) }
  }
}

const provider: TwinnyProvider = {
  id: "scripted",
  label: "Scripted",
  modelName: "scripted-model",
  provider: "scripted-agent",
  type: "chat"
}

/** The chat, working in a folder of the test's choosing. */
class ChatIn extends Chat {
  public root = ""
  protected workspaceRoot() {
    return this.root
  }
}

const call = (name: string, args: Record<string, string>) =>
  "```tool\n" + JSON.stringify({ name, arguments: args }) + "\n```"

const openWorkspace = async (root: string): Promise<() => Promise<void>> => {
  const index = vscode.workspace.workspaceFolders?.length ?? 0
  const update = (deleteCount: number, folder?: vscode.WorkspaceFolder) => new Promise<void>((resolve, reject) => {
    const subscription = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      subscription.dispose()
      resolve()
    })
    if (!vscode.workspace.updateWorkspaceFolders(index, deleteCount, ...(folder ? [folder] : []))) {
      subscription.dispose()
      reject(new Error("Could not update VS Code test workspace folders."))
    }
  })
  await update(0, { uri: vscode.Uri.file(root), name: "agent-reply-test" } as vscode.WorkspaceFolder)
  return async () => update(1)
}

const fakeWebview = () => {
  let listener: ((message: unknown) => void) | undefined
  const sent: unknown[] = []
  return {
    sent,
    onDidReceiveMessage: (handler: (message: unknown) => void) => {
      listener = handler
      return { dispose() {} }
    },
    postMessage: (payload: unknown) => {
      sent.push(payload)
    },
    dispatch: (message: unknown) => {
      listener?.(message)
    }
  }
}

suite("Agent reply, end to end", function () {
  this.timeout(60000)

  test("the webview message channel drives the same Chat completion and tool loop as a user prompt", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-webview-message-"))
    const file = path.join(root, "a.ts")
    fs.writeFileSync(file, "export const a = 1\n")
    const closeWorkspace = await openWorkspace(root)

    const model = new ScriptedModel([
      call("read_file", { path: "a.ts" }),
      call("edit_file", { path: "a.ts", find: "export const a = 1", replace: "export const a = 2" }),
      "Done."
    ])
    providerRegistry.register("scripted-agent", { id: "scripted-agent", create: () => model })

    const stored: Record<string, unknown> = {
      [ACTIVE_CHAT_PROVIDER_STORAGE_KEY]: provider,
      [`${EVENT_NAME.twinnyGlobalContext}-${GLOBAL_STORAGE_KEY.agentMode}`]: true
    }
    const context = {
      globalState: {
        get: (key: string) => stored[key],
        update: async (key: string, value: unknown) => {
          if (value === undefined) delete stored[key]
          else stored[key] = value
        }
      },
      workspaceState: { get: () => undefined, update: async () => undefined },
      subscriptions: [],
      extensionUri: vscode.Uri.file(root)
    } as unknown as vscode.ExtensionContext

    const webview = fakeWebview()
    const bridge = new ExtensionBridge(webview as unknown as vscode.Webview)
    const chat = new ChatIn(new GenerationTracker(), undefined, context, bridge, undefined)
    chat.root = root
    bridge.handleAll({
      [EVENT_NAME.twinnyChatMessage]: async ({ messages, mentions, agentSelection }) => {
        await chat.completion(messages, mentions, agentSelection)
      }
    })

    try {
      await (bridge as unknown as {
        _dispatch: (message: { type: string; data: unknown }) => Promise<void>
      })._dispatch({
        type: EVENT_NAME.twinnyChatMessage,
        data: {
          messages: [{ role: "user", content: "Update the constant in a.ts to 2." }],
          mentions: []
        }
      })

      const finalContent = model.requests[0].messages.at(-1)?.content
      assert.ok(
        typeof finalContent === "string"
          ? finalContent === "Update the constant in a.ts to 2."
          : Array.isArray(finalContent) && finalContent.some((part) => "text" in part && part.text === "Update the constant in a.ts to 2.")
      )
      assert.ok(fs.readFileSync(file, "utf8").includes("export const a = 2"))
      assert.ok(
        (webview.sent as unknown[]).some(
          (payload) =>
            typeof payload === "object" &&
            payload !== null &&
            "type" in payload &&
            payload.type === EVENT_NAME.twinnyAddMessage
        )
      )
    } finally {
      chat.dispose()
      bridge.dispose()
      await closeWorkspace()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("an MCP server's tool is asked for first, and Always run keeps the tool, not the call", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-agent-mcp-"))
    const settings = vscode.workspace.getConfiguration("twinny")
    await settings.update(
      "chatToolsMcpServers",
      {
        fake: {
          command: process.execPath,
          args: [path.join(__dirname, "support", "fake-mcp-server.js")],
          env: { ELECTRON_RUN_AS_NODE: "1" }
        }
      },
      vscode.ConfigurationTarget.Global
    )
    const model = new ScriptedModel([
      call("fake__add", { a: "2", b: "3" }),
      call("fake__add", { a: "4", b: "5" }),
      "5 and 9."
    ])
    providerRegistry.register("scripted-agent", { id: "scripted-agent", create: () => model })
    const stored: Record<string, unknown> = {
      [ACTIVE_CHAT_PROVIDER_STORAGE_KEY]: provider,
      [`${EVENT_NAME.twinnyGlobalContext}-${GLOBAL_STORAGE_KEY.agentMode}`]: true
    }
    const context = {
      globalState: { get: (key: string) => stored[key], update: async (key: string, value: unknown) => void (stored[key] = value) },
      workspaceState: { get: () => undefined, update: async () => undefined },
      subscriptions: []
    } as unknown as vscode.ExtensionContext
    // The bridge answers the chat it belongs to, made just below.
    const chatRef: { current?: ChatIn } = {}
    const asked: string[] = []
    const bridge = {
      emit: (type: string, data: unknown) => {
        if (type !== EVENT_NAME.twinnyToolSteps) return
        const waiting = (data as ToolStepView[]).find((step) => step.status === "waiting")
        if (!waiting || asked.includes(waiting.id)) return
        asked.push(waiting.id)
        assert.strictEqual(waiting.mcpTool, "fake/add")
        setTimeout(() => chatRef.current?.answerToolApproval(waiting.id, true, true), 10)
      }
    } as unknown as ExtensionBridge
    const chat = new ChatIn(new GenerationTracker(), undefined, context, bridge, undefined)
    chatRef.current = chat
    chat.root = root
    try {
      const reply = await chat.completion([{ role: "user", content: "Add twice." } as ChatCompletionMessage])
      assert.strictEqual(reply, "5 and 9.")
      assert.ok(model.requests[0].messages.some((m) => String(m.content).includes("fake__add {a, b, options?, loud?}")))
      assert.match(JSON.stringify(model.requests[1].messages.at(-1)?.content), /5 \(a:number,b:number\)/)
      assert.match(JSON.stringify(model.requests[2].messages.at(-1)?.content), /9 \(a:number,b:number\)/)
      assert.strictEqual(asked.length, 1, "asked once: Always run held for the second call with other arguments")
      assert.deepStrictEqual(stored[`${EVENT_NAME.twinnyGlobalContext}-${GLOBAL_STORAGE_KEY.alwaysRunMcpTools}`], ["fake/add"])
    } finally {
      chat.dispose()
      await settings.update("chatToolsMcpServers", undefined, vscode.ConfigurationTarget.Global)
    }
  })

  test("global MCP approval survives a new chat and can be changed without a new chat", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-agent-mcp-global-"))
    const settings = vscode.workspace.getConfiguration("twinny")
    const previousApproval = settings.inspect<boolean>("mcpNeverAskAgain")?.globalValue
    const previousCommands = settings.inspect<string>("chatToolsCommands")?.globalValue
    const previousServers = settings.inspect<Record<string, unknown>>("chatToolsMcpServers")?.globalValue
    const fakeServer = {
      command: process.execPath,
      args: [path.join(__dirname, "support", "fake-mcp-server.js")],
      env: { ELECTRON_RUN_AS_NODE: "1" }
    }
    await settings.update("chatToolsMcpServers", { fake: fakeServer }, vscode.ConfigurationTarget.Global)
    await settings.update("mcpNeverAskAgain", true, vscode.ConfigurationTarget.Global)

    const stored: Record<string, unknown> = {
      [EVENT_NAME.twinnyGlobalContext + "-" + GLOBAL_STORAGE_KEY.agentMode]: true,
      [ACTIVE_CHAT_PROVIDER_STORAGE_KEY]: provider
    }
    const context = {
      globalState: { get: (key: string) => stored[key], update: async (key: string, value: unknown) => void (stored[key] = value) },
      workspaceState: { get: () => undefined, update: async () => undefined },
      subscriptions: []
    } as unknown as vscode.ExtensionContext
    const asked: string[] = []
    let model = new ScriptedModel([call("fake__add", { a: "1", b: "2" }), "first done"])
    providerRegistry.register("scripted-agent", { id: "scripted-agent", create: () => model })
    const firstRef: { current?: ChatIn } = {}
    const firstBridge = {
      emit: (type: string, data: unknown) => {
        if (type !== EVENT_NAME.twinnyToolSteps) return
        const waiting = (data as ToolStepView[]).find((step) => step.status === "waiting")
        if (!waiting) return
        asked.push(waiting.mcpTool ?? "")
        setTimeout(() => firstRef.current?.answerToolApproval(waiting.id, true), 10)
      }
    } as unknown as ExtensionBridge
    const firstChat = new ChatIn(new GenerationTracker(), undefined, context, firstBridge, undefined)
    firstRef.current = firstChat
    firstChat.root = root
    let secondChat: ChatIn | undefined
    let ordinaryChat: ChatIn | undefined
    try {
      assert.strictEqual(await firstChat.completion([{ role: "user", content: "Add." } as ChatCompletionMessage]), "first done")
      assert.match(JSON.stringify(model.requests[1].messages.at(-1)?.content), /3 \(a:number,b:number\)/)
      assert.strictEqual(asked.length, 0, "the global setting bypasses the real Chat approval callback")
      firstChat.dispose()

      model = new ScriptedModel([
        call("fake__add", { a: "4", b: "5" }),
        "second done",
        call("fake__fail", {}),
        "error returned"
      ])
      const secondRef: { current?: ChatIn } = {}
      const secondBridge = {
        emit: (type: string, data: unknown) => {
          if (type !== EVENT_NAME.twinnyToolSteps) return
          const waiting = (data as ToolStepView[]).find((step) => step.status === "waiting")
          if (!waiting) return
          asked.push(waiting.mcpTool ?? "")
          setTimeout(() => secondRef.current?.answerToolApproval(waiting.id, true), 10)
        }
      } as unknown as ExtensionBridge
      secondChat = new ChatIn(new GenerationTracker(), undefined, context, secondBridge, undefined)
      secondRef.current = secondChat
      secondChat.root = root
      assert.strictEqual(await secondChat.completion([{ role: "user", content: "Add again." } as ChatCompletionMessage]), "second done")
      assert.strictEqual(asked.length, 0, "a newly created conversation keeps the user's global choice")

      await settings.update("mcpNeverAskAgain", false, vscode.ConfigurationTarget.Global)
      assert.strictEqual(await secondChat.completion([{ role: "user", content: "Fail." } as ChatCompletionMessage]), "error returned")
      assert.deepStrictEqual(asked, ["fake/fail"], "turning the setting off restores the interactive approval path")
      assert.match(JSON.stringify(model.requests[3].messages.at(-1)?.content), /no such issue/)

      await settings.update("mcpNeverAskAgain", true, vscode.ConfigurationTarget.Global)
      await settings.update("chatToolsCommands", "ask", vscode.ConfigurationTarget.Global)
      const ordinaryModel = new ScriptedModel([call("run_command", { command: "echo twinny-ordinary-tool" }), "command complete"])
      model = ordinaryModel
      const ordinaryRef: { current?: ChatIn } = {}
      const ordinaryBridge = {
        emit: (type: string, data: unknown) => {
          if (type !== EVENT_NAME.twinnyToolSteps) return
          const waiting = (data as ToolStepView[]).find((step) => step.status === "waiting")
          if (!waiting) return
          asked.push(waiting.mcpTool ?? "ordinary")
          setTimeout(() => ordinaryRef.current?.answerToolApproval(waiting.id, true), 10)
        }
      } as unknown as ExtensionBridge
      ordinaryChat = new ChatIn(new GenerationTracker(), undefined, context, ordinaryBridge, undefined)
      ordinaryRef.current = ordinaryChat
      ordinaryChat.root = root
      assert.strictEqual(await ordinaryChat.completion([{ role: "user", content: "Run the harmless command." } as ChatCompletionMessage]), "command complete")
      assert.deepStrictEqual(asked, ["fake/fail", "ordinary"], "global MCP approval does not auto-approve ordinary tools")
      assert.match(JSON.stringify(ordinaryModel.requests[1].messages.at(-1)?.content), /twinny-ordinary-tool/)
    } finally {
      firstChat.dispose()
      secondChat?.dispose()
      ordinaryChat?.dispose()
      providerRegistry.unregister("scripted-agent")
      await settings.update("mcpNeverAskAgain", previousApproval, vscode.ConfigurationTarget.Global)
      await settings.update("chatToolsCommands", previousCommands, vscode.ConfigurationTarget.Global)
      await settings.update("chatToolsMcpServers", previousServers, vscode.ConfigurationTarget.Global)
    }
  })

  teardown(async () => {
    providerRegistry.unregister("scripted-agent")
    await vscode.commands.executeCommand("workbench.action.closeAllEditors")
  })

  test("reads, edits and runs through the real tools, hands the reply over with what it changed, and undoes it", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-agent-e2e-"))
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" })
    git("init", "-q")
    git("config", "user.email", "t@example.com")
    git("config", "user.name", "T")
    fs.mkdirSync(path.join(root, "src"))
    fs.writeFileSync(path.join(root, "AGENTS.md"), "Keep exports named.\n")
    fs.writeFileSync(path.join(root, "src", "a.ts"), "export const a = 1\n")
    git("add", ".")
    git("commit", "-qm", "first")
    const closeWorkspace = await openWorkspace(root)

    const model = new ScriptedModel([
      call("read_file", { path: "src/a.ts" }),
      call("edit_file", { path: "src/a.ts", find: "export const a = 1", replace: "export const a: string = 2" }),
      call("edit_file", { path: "src/a.ts", find: "export const a: string = 2", replace: "export const a = 2" }),
      call("run_command", { command: "echo made > made.txt" }),
      "I set a to 2 and made made.txt."
    ])
    providerRegistry.register("scripted-agent", { id: "scripted-agent", create: () => model })
    const emitted: { type: string; data: unknown }[] = []
    const bridge = { emit: (type: string, data: unknown) => emitted.push({ type, data }) } as unknown as ExtensionBridge
    const stored: Record<string, unknown> = {
      [ACTIVE_CHAT_PROVIDER_STORAGE_KEY]: provider,
      [`${EVENT_NAME.twinnyGlobalContext}-${GLOBAL_STORAGE_KEY.agentMode}`]: true,
      [`${EVENT_NAME.twinnyGlobalContext}-${GLOBAL_STORAGE_KEY.autoRunCommands}`]: true
    }
    const context = {
      globalState: { get: (key: string) => stored[key], update: async () => undefined },
      workspaceState: { get: () => undefined, update: async () => undefined },
      storageUri: vscode.Uri.file(path.join(root, ".git", "twinny-storage")),
      subscriptions: []
    } as unknown as vscode.ExtensionContext
    const chat = new ChatIn(new GenerationTracker(), undefined, context, bridge, undefined)
    chat.root = root
    try {
      const reply = await chat.completion([{ role: "user", content: "Make a two, and make a file." } as ChatCompletionMessage])
      assert.strictEqual(reply, "I set a to 2 and made made.txt.")

      // What the model was told and given back.
      const system = String(model.requests[0].messages[0].content)
      assert.match(system, /from AGENTS\.md[\s\S]*Keep exports named\./, "the project's instructions are in the prompt")
      const results = model.requests.map((request) => JSON.stringify(request.messages[request.messages.length - 1].content))
      assert.match(results[1], /1: export const a = 1/, "the file read comes back to the model")
      assert.match(results[2], /Type 'number' is not assignable to type 'string'/, "the error its edit caused comes back with the edit")
      assert.doesNotMatch(results[3], /not assignable/, "and the fix brings none")
      assert.match(results[4], /exit code 0/)

      // What the workspace now holds.
      assert.strictEqual(fs.readFileSync(path.join(root, "src", "a.ts"), "utf8"), "export const a = 2\n")
      assert.strictEqual(fs.readFileSync(path.join(root, "made.txt"), "utf8"), "made\n")

      // What the webview was handed.
      const steps = emitted.filter((e) => e.type === EVENT_NAME.twinnyToolSteps).pop()?.data as ToolStepView[]
      assert.deepStrictEqual(
        steps.map((s) => [s.name, s.status]),
        [
          ["read_file", "done"],
          ["edit_file", "done"],
          ["edit_file", "done"],
          ["run_command", "done"]
        ]
      )
      assert.match(steps[1].summary, /· 1 new error$/)
      const added = emitted.filter((e) => e.type === EVENT_NAME.twinnyAddMessage).pop()?.data as ChatCompletionMessage
      assert.strictEqual(added.content, "I set a to 2 and made made.txt.")
      assert.deepStrictEqual(added.meta?.instructions, ["AGENTS.md"])
      assert.match(added.toolNotes ?? "", /run_command/)
      const changes = added.changes as ReplyChangesView
      assert.deepStrictEqual(
        changes.files.map((f) => [f.path, f.status, f.added, f.removed]),
        [
          ["made.txt", "created", 1, 0],
          ["src/a.ts", "modified", 1, 1]
        ]
      )

      // And the way back.
      const undone = await chat.undoChanges(changes.id)
      assert.strictEqual(undone.error, undefined)
      assert.strictEqual(fs.readFileSync(path.join(root, "src", "a.ts"), "utf8"), "export const a = 1\n")
      assert.ok(!fs.existsSync(path.join(root, "made.txt")))
      assert.ok(undone.view?.files.every((f) => f.undone))
    } finally {
      chat.dispose()
      await closeWorkspace()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("a message sent mid-reply reaches the model at its next step; using every step says so in the reply", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-agent-steer-"))
    fs.writeFileSync(path.join(root, "a.ts"), "export const a = 1\n")
    fs.writeFileSync(path.join(root, "b.ts"), "export const b = 2\n")
    const settings = vscode.workspace.getConfiguration("twinny")
    await settings.update("chatToolsMaxSteps", 4, vscode.ConfigurationTarget.Global)
    const model = new ScriptedModel([
      call("read_file", { path: "a.ts" }),
      call("read_file", { path: "b.ts" }),
      call("list_dir", {}),
      call("find_files", { pattern: "*.ts" }),
      "a is 1 and b is 2; I ran out of steps before checking the rest."
    ])
    providerRegistry.register("scripted-agent", { id: "scripted-agent", create: () => model })
    const stored: Record<string, unknown> = {
      [ACTIVE_CHAT_PROVIDER_STORAGE_KEY]: provider,
      [`${EVENT_NAME.twinnyGlobalContext}-${GLOBAL_STORAGE_KEY.agentMode}`]: true
    }
    const context = {
      globalState: { get: (key: string) => stored[key], update: async () => undefined },
      workspaceState: { get: () => undefined, update: async () => undefined },
      subscriptions: []
    } as unknown as vscode.ExtensionContext
    const chatRef: { current?: ChatIn } = {}
    const emitted: { type: string; data: unknown }[] = []
    let offered = false
    const bridge = {
      emit: (type: string, data: unknown) => {
        emitted.push({ type, data })
        // The user types while the first read runs.
        if (type === EVENT_NAME.twinnyToolSteps && !offered && (data as ToolStepView[]).length) {
          offered = true
          chatRef.current?.steer("q1", "Look at b.ts too.")
          chatRef.current?.steer("q2", "Never mind this one.")
          chatRef.current?.steer("q2")
        }
      }
    } as unknown as ExtensionBridge
    const chat = new ChatIn(new GenerationTracker(), undefined, context, bridge, undefined)
    chatRef.current = chat
    chat.root = root
    // Offered with no agent reply working: never taken by the next one.
    chat.steer("q0", "Too early.")
    try {
      await chat.completion([{ role: "user", content: "What are a and b?" } as ChatCompletionMessage])
      const sent = model.requests.map((request) => JSON.stringify(request.messages))
      assert.ok(!sent[1].includes("Too early.") && !sent[1].includes("Never mind"), sent[1])
      assert.match(String(model.requests[1].messages.at(-1)?.content), /While you were working, the user wrote:\n\nLook at b\.ts too\./)
      assert.ok(!sent[0].includes("Look at b.ts"), "not before the step it arrived during")

      const steps = emitted.filter((e) => e.type === EVENT_NAME.twinnyToolSteps).pop()?.data as ToolStepView[]
      assert.deepStrictEqual(
        steps.map((s) => [s.name, s.said ?? false]),
        [
          ["read_file", false],
          ["said", true],
          ["read_file", false],
          ["list_dir", false],
          ["find_files", false]
        ]
      )
      assert.strictEqual(steps[1].id, "said.q1")
      const added = emitted.filter((e) => e.type === EVENT_NAME.twinnyAddMessage).pop()?.data as ChatCompletionMessage
      assert.strictEqual(added.meta?.outOfSteps, true)
      assert.match(added.toolNotes ?? "", /The user, while you worked: Look at b\.ts too\./)

      // Once the reply is over, an offer stays the webview's to send as a turn.
      chat.steer("q3", "Late.")
      model.requests = []
      await chat.completion([{ role: "user", content: "Again?" } as ChatCompletionMessage])
      assert.ok(!JSON.stringify(model.requests.map((r) => r.messages)).includes("Late."))
    } finally {
      chat.dispose()
      await settings.update("chatToolsMaxSteps", undefined, vscode.ConfigurationTarget.Global)
    }
  })
})
