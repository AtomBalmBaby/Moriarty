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

import { ACTIVE_CHAT_PROVIDER_STORAGE_KEY, ACTIVE_INTENT_PROVIDER_STORAGE_KEY, EVENT_NAME, GLOBAL_STORAGE_KEY } from "../../common/constants"
import { ChatCompletionMessage, ReplyChangesView, ToolStepView, TwinnyProvider } from "../../common/types"
import { AgentRegistry } from "../../extension/agents/registry"
import { Chat } from "../../extension/chat/index"
import { createSafeEditCheckpoints } from "../../extension/chat/tool-sinks"
import { GenerationTracker } from "../../extension/generations"
import { ChatRequest, InferenceProvider, providerRegistry } from "../../extension/inference"
import { ExtensionBridge } from "../../extension/messaging/bridge"
import { TodoRepository, workspaceProjectFingerprint } from "../../extension/todos/repository"

/** A model that answers each request with the next scripted reply. */
class ScriptedModel implements InferenceProvider {
  public readonly id = "scripted-agent"
  public requests: ChatRequest[] = []

  constructor(private readonly _replies: string[], private readonly _planReply?: string) {}

  capabilities() {
    return ["chat" as const]
  }

  async *chat(request: ChatRequest) {
    this.requests.push(structuredClone(request))
    const system = String(request.messages[0]?.content ?? "")
    const planning = this._planReply !== undefined && /track \(boolean\)/.test(system)
    const reply = planning ? this._planReply! : this._replies.shift() ?? "Done."
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

  test("native TODO tools remain available in ordinary chat when Agent mode is off", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-chat-todos-"))
    const model = new ScriptedModel([
      call("twinny_todo_create", { title: "Verify native TODO persistence", request_id: "create-todo" }),
      "Created the TODO."
    ])
    providerRegistry.register("scripted-agent", { id: "scripted-agent", create: () => model })
    // Feedback is on by default and plans every send; the planner answers that the request needs no new plan.
    const planner = new ScriptedModel([JSON.stringify({ track: false, plan: null })])
    providerRegistry.register("scripted-planner", { id: "scripted-planner", create: () => planner })
    const plannerProvider: TwinnyProvider = { ...provider, id: "scripted-planner", provider: "scripted-planner", type: "intent" }
    const stored: Record<string, unknown> = { [ACTIVE_CHAT_PROVIDER_STORAGE_KEY]: provider, [ACTIVE_INTENT_PROVIDER_STORAGE_KEY]: plannerProvider }
    const context = {
      extensionUri: vscode.Uri.file(path.resolve(__dirname, "../../..")),
      globalStorageUri: vscode.Uri.file(path.join(directory, ".twinny-global-storage")),
      globalState: { get: (key: string) => stored[key], update: async (key: string, value: unknown) => void (stored[key] = value) },
      workspaceState: { get: () => undefined, update: async () => undefined },
      subscriptions: []
    } as unknown as vscode.ExtensionContext
    const bridge = new ExtensionBridge(fakeWebview() as unknown as vscode.Webview)
    const repository = new TodoRepository(
      path.join(directory, "todos.sqlite"),
      path.join(context.extensionUri.fsPath, "out", "sql-wasm.wasm")
    )
    const chat = new Chat(new GenerationTracker(), undefined, context, bridge, undefined, undefined, repository)

    try {
      await chat.completion([{ role: "user", content: "Create a native TODO." }], [], "off", "ordinary-chat")
      const snapshot = await repository.getList({
        projectFingerprint: workspaceProjectFingerprint((vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.toString(true))),
        conversationId: "ordinary-chat"
      })
      assert.deepStrictEqual(snapshot.items.map((item) => item.title), ["Verify native TODO persistence"])
      await new Promise((resolve) => setTimeout(resolve, 50))
    } finally {
      bridge.dispose()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  test("chat remains responsive and does not invoke review when automatic feedback is disabled", async () => {
    const settings = vscode.workspace.getConfiguration("twinny")
    const previousFeedback = settings.inspect<boolean>("feedback.enabled")?.globalValue
    await settings.update("feedback.enabled", false, vscode.ConfigurationTarget.Global)
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-feedback-disabled-"))
    const chatModel = new ScriptedModel(["The chat is still working."])
    const evaluatorModel = new ScriptedModel(["{ malformed }"])
    providerRegistry.register("scripted-agent", { id: "scripted-agent", create: () => chatModel })
    providerRegistry.register("scripted-reviewer", { id: "scripted-reviewer", create: () => evaluatorModel })
    const evaluatorProvider: TwinnyProvider = { ...provider, id: "scripted-reviewer", provider: "scripted-reviewer", type: "intent" }
    const stored: Record<string, unknown> = {
      [ACTIVE_CHAT_PROVIDER_STORAGE_KEY]: provider,
      [ACTIVE_INTENT_PROVIDER_STORAGE_KEY]: evaluatorProvider
    }
    const context = {
      extensionUri: vscode.Uri.file(path.resolve(__dirname, "../../..")),
      globalStorageUri: vscode.Uri.file(path.join(directory, ".twinny-global-storage")),
      globalState: { get: (key: string) => stored[key], update: async (key: string, value: unknown) => void (stored[key] = value) },
      workspaceState: { get: () => undefined, update: async () => undefined },
      subscriptions: []
    } as unknown as vscode.ExtensionContext
    const repository = new TodoRepository(path.join(directory, "todos.sqlite"), path.join(context.extensionUri.fsPath, "out", "sql-wasm.wasm"))
    const scope = { projectFingerprint: workspaceProjectFingerprint((vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.toString(true))), conversationId: "feedback-disabled-chat" }
    const plan = { planId: "feedback-disabled-plan", version: 1 as const, revision: 1, goal: "Verify one task", constraints: [], tasks: [
      { id: "review-me", title: "Review me", description: "A task to remain in review", acceptanceCriteria: ["Source inspected"], dependencies: [] as string[] }
    ] }
    const item = (await repository.synchronizeIntentPlan(scope, plan, { prompt: "Verify one task" })).items[0]
    await repository.updateItem(scope, { itemId: item.id, expectedVersion: item.version, patch: { status: "completed" }, actor: "model", requestId: "feedback-disabled-claim" })
    const chat = new Chat(new GenerationTracker(), undefined, context, new ExtensionBridge(fakeWebview() as unknown as vscode.Webview), undefined, undefined, repository)
    try {
      await chat.completion([{ role: "user", content: "Keep chatting." }], [], "off", scope.conversationId)
      await new Promise((resolve) => setTimeout(resolve, 50))
      assert.equal(chatModel.requests.length, 1)
      assert.equal(evaluatorModel.requests.length, 0)
      assert.equal((await repository.getList(scope)).items[0].status, "in_review")
    } finally {
      chat.dispose()
      fs.rmSync(directory, { recursive: true, force: true })
      await settings.update("feedback.enabled", previousFeedback, vscode.ConfigurationTarget.Global)
    }
  })

  test("the implementing chat receives only its bounded active intent-task projection", async () => {
    const settings = vscode.workspace.getConfiguration("twinny")
    const previousFeedback = settings.inspect<boolean>("feedback.enabled")?.globalValue
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-task-context-"))
    const model = new ScriptedModel(["Done.", "Done."])
    providerRegistry.register("scripted-agent", { id: "scripted-agent", create: () => model })
    // Only the enabled turn plans; the existing synchronized plan already covers the request.
    const planner = new ScriptedModel([JSON.stringify({ track: false, plan: null })])
    providerRegistry.register("scripted-task-planner", { id: "scripted-task-planner", create: () => planner })
    const plannerProvider: TwinnyProvider = { ...provider, id: "scripted-task-planner", provider: "scripted-task-planner", type: "intent" }
    const stored: Record<string, unknown> = { [ACTIVE_CHAT_PROVIDER_STORAGE_KEY]: provider, [ACTIVE_INTENT_PROVIDER_STORAGE_KEY]: plannerProvider }
    const context = {
      extensionUri: vscode.Uri.file(path.resolve(__dirname, "../../..")),
      globalStorageUri: vscode.Uri.file(path.join(directory, ".twinny-global-storage")),
      globalState: { get: (key: string) => stored[key], update: async (key: string, value: unknown) => void (stored[key] = value) },
      workspaceState: { get: () => undefined, update: async () => undefined },
      subscriptions: []
    } as unknown as vscode.ExtensionContext
    const repository = new TodoRepository(
      path.join(directory, "todos.sqlite"),
      path.join(context.extensionUri.fsPath, "out", "sql-wasm.wasm")
    )
    const scope = {
      projectFingerprint: workspaceProjectFingerprint((vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.toString(true))),
      conversationId: "bounded-task-chat"
    }
    const plan = {
      planId: "bounded-context-plan",
      version: 1 as const,
      revision: 1,
      goal: "Implement the requested feature while preserving existing behavior.",
      constraints: ["Preserve existing behavior"],
      tasks: [
        { id: "active-task", title: "Implement the focused change", description: "Modify only the relevant feature surface.", acceptanceCriteria: ["The active task acceptance criterion is visible to the model."], dependencies: [] },
        { id: "other-task", title: "Do not project unrelated task", description: "This should not be included in the active task context.", acceptanceCriteria: ["Not part of this request"], dependencies: ["active-task"] }
      ]
    }
    await repository.synchronizeIntentPlan(scope, plan, { prompt: "Implement the feature", plan })
    const chat = new Chat(new GenerationTracker(), undefined, context, new ExtensionBridge(fakeWebview() as unknown as vscode.Webview), undefined, undefined, repository)
    try {
      await settings.update("feedback.enabled", false, vscode.ConfigurationTarget.Global)
      await chat.completion([{ role: "user", content: "Implement it." }], [], "off", scope.conversationId)
      const disabledSystem = String(model.requests[0].messages[0]?.content ?? "")
      assert.doesNotMatch(disabledSystem, /twinny_active_intent_task/)

      // Feedback, not the Prompt Compiler, decides whether the active task is projected.
      await settings.update("feedback.enabled", true, vscode.ConfigurationTarget.Global)
      await chat.completion([{ role: "user", content: "Continue implementing it." }], [], "off", scope.conversationId)
      const enabledSystem = String(model.requests[1].messages[0]?.content ?? "")
      const taskProjection = enabledSystem.slice(enabledSystem.indexOf("Active task from Twinny's native TODO plan"))
      assert.match(taskProjection, /twinny_active_intent_task/)
      assert.match(taskProjection, /The active task acceptance criterion is visible to the model\./)
      assert.match(taskProjection, /"status":"pending"/)
      assert.doesNotMatch(taskProjection, /This should not be included in the active task context\./)
      assert.doesNotMatch(taskProjection, /Not part of this request/)
      assert.match(taskProjection, /\(pending, verification not_checked, version 1\) Do not project unrelated task/, "sibling tasks appear only as plan status rows")
      assert.ok(taskProjection.length < 4000, `Task context was unexpectedly large: ${taskProjection.length} characters`)
      assert.match(enabledSystem, /You are a helpful, respectful and honest coding assistant/)
    } finally {
      chat.dispose()
      await settings.update("feedback.enabled", previousFeedback, vscode.ConfigurationTarget.Global)
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  test("an incomplete implementation report automatically dispatches a corrective turn", async () => {
    const settings = vscode.workspace.getConfiguration("twinny")
    const previousFeedback = settings.inspect<boolean>("feedback.enabled")?.globalValue
    await settings.update("feedback.enabled", true, vscode.ConfigurationTarget.Global)
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-reconcile-continuation-"))
    const chatModel = new ScriptedModel(["Implementation report: all requested work is complete.", "I will now inspect and implement the requested changes."])
    const criterion = "The existing TODO panel is updated."
    const evaluation = (decision: "revise" | "blocked") => JSON.stringify({
      schemaVersion: 1,
      taskId: "panel-task-1",
      decision,
      criteria: [{ criterion, status: decision === "revise" ? "failed" : "unverified", evidenceRefs: [] }],
      problems: decision === "revise" ? ["No source changes were made."] : [],
      correctiveInstructions: decision === "revise" ? ["Edit the existing TODO panel instead of reporting a proposed implementation."] : [],
      explanation: decision === "revise" ? "The requested implementation is not present." : "Execution stopped for this deterministic integration test.",
      scores: { completion: 0, correctness: 0, alignment: 0 }
    })
    const evaluatorModel = new ScriptedModel([evaluation("revise"), evaluation("blocked")], JSON.stringify({ track: false }))
    const agentProvider = { ...provider, id: "reconciliation-agent", provider: "reconciliation-agent" }
    const evaluatorProvider: TwinnyProvider = { ...provider, id: "reconciliation-evaluator", provider: "reconciliation-evaluator", type: "intent" }
    providerRegistry.register("reconciliation-agent", { id: "reconciliation-agent", create: () => chatModel })
    providerRegistry.register("reconciliation-evaluator", { id: "reconciliation-evaluator", create: () => evaluatorModel })
    const stored: Record<string, unknown> = {
      [ACTIVE_CHAT_PROVIDER_STORAGE_KEY]: agentProvider,
      [ACTIVE_INTENT_PROVIDER_STORAGE_KEY]: evaluatorProvider
    }
    const context = {
      extensionUri: vscode.Uri.file(path.resolve(__dirname, "../../..")),
      globalStorageUri: vscode.Uri.file(path.join(directory, ".twinny-global-storage")),
      globalState: { get: (key: string) => stored[key], update: async (key: string, value: unknown) => void (stored[key] = value) },
      workspaceState: { get: () => undefined, update: async () => undefined },
      subscriptions: []
    } as unknown as vscode.ExtensionContext
    const repository = new TodoRepository(path.join(directory, "todos.sqlite"), path.join(context.extensionUri.fsPath, "out", "sql-wasm.wasm"))
    const goal = "Implement the requested TODO panel improvements."
    const scope = {
      projectFingerprint: workspaceProjectFingerprint((vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.toString(true))),
      conversationId: "premature-surrender-regression"
    }
    const plan = {
      planId: "premature-surrender-plan",
      version: 1 as const,
      revision: 1,
      goal,
      constraints: ["Modify the existing component; do not delete it."],
      tasks: Array.from({ length: 9 }, (_, index) => ({
        id: `panel-task-${index + 1}`,
        title: `Implement panel requirement ${index + 1}`,
        description: `Make and verify panel change ${index + 1}.`,
        acceptanceCriteria: [criterion],
        dependencies: [] as string[]
      }))
    }
    await repository.synchronizeIntentPlan(scope, plan, { prompt: goal, plan })
    const chat = new Chat(new GenerationTracker(), undefined, context, new ExtensionBridge(fakeWebview() as unknown as vscode.Webview), undefined, undefined, repository)
    try {
      await chat.completion([{ role: "user", content: goal }], [], "off", scope.conversationId)
      assert.equal(chatModel.requests.length, 2, "the same user request must cause an automatic second agent turn")
      assert.equal(evaluatorModel.requests.filter((request) => !/track \(boolean\)/.test(String(request.messages[0]?.content ?? ""))).length, 2, "each implementing turn must receive independent evaluation")
      const continuation = chatModel.requests[1].messages.map((message) => String(message.content ?? "")).join("\n")
      assert.match(continuation, /Implement the requested TODO panel improvements/)
      assert.match(continuation, /Modify the existing component; do not delete it/)
      assert.match(continuation, /Edit the existing TODO panel instead of reporting a proposed implementation/)
      assert.equal((await repository.getList({ ...scope, includeCompleted: true })).items.filter((item) => item.status === "completed").length, 0)
    } finally {
      chat.dispose()
      fs.rmSync(directory, { recursive: true, force: true })
      await settings.update("feedback.enabled", previousFeedback, vscode.ConfigurationTarget.Global)
    }
  })

  test("safe edit rollback preserves a dirty editor buffer and its distinct disk contents", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-dirty-buffer-checkpoint-"))
    const file = path.join(root, "panel.tsx")
    fs.writeFileSync(file, "disk before\n")
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file))
    const setText = async (text: string) => {
      const edit = new vscode.WorkspaceEdit()
      edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text)
      assert.equal(await vscode.workspace.applyEdit(edit), true)
    }
    const checkpoints = createSafeEditCheckpoints(vscode.Uri.file(path.join(root, "global-storage")))
    try {
      await setText("user's unsaved buffer\n")
      assert.equal(document.isDirty, true)
      await checkpoints.capture([file])
      await setText("agent regression\n")
      assert.equal(await document.save(), true)
      await checkpoints.markChanged([file])
      assert.deepEqual(await checkpoints.rollback(), { restored: true })
      assert.equal(document.getText(), "user's unsaved buffer\n")
      assert.equal(fs.readFileSync(file, "utf8"), "disk before\n")
    } finally {
      await vscode.commands.executeCommand("workbench.action.closeAllEditors")
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("a recovery deletion of an in-scope component is rejected and automatically reviewed", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-destructive-recovery-"))
    const file = path.join(root, "src", "webview", "todo-panel.tsx")
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, "export const TodoPanel = () => <div />\n")
    const closeWorkspace = await openWorkspace(root)
    const settings = vscode.workspace.getConfiguration("twinny")
    const previousFeedback = settings.inspect<boolean>("feedback.enabled")?.globalValue
    await settings.update("feedback.enabled", true, vscode.ConfigurationTarget.Global)
    const criterion = "The existing TODO panel remains and is updated."
    const review = (decision: "revise" | "blocked") => JSON.stringify({
      schemaVersion: 1,
      taskId: "todo-panel-task",
      decision,
      criteria: [{ criterion, status: decision === "revise" ? "failed" : "unverified", evidenceRefs: [] }],
      problems: decision === "revise" ? ["The component was not modified safely."] : [],
      correctiveInstructions: decision === "revise" ? ["Keep the existing component and make the requested edits in place."] : [],
      explanation: decision === "revise" ? "The requested component must not be deleted." : "Execution stopped for this deterministic integration test.",
      scores: { completion: 0, correctness: 0, alignment: 0 }
    })
    const agentModel = new ScriptedModel([
      call("delete_file", { path: "src/webview/todo-panel.tsx" }),
      "The attempted deletion was rejected; I will continue safely."
    ])
    // Feedback plans for every ordinary send; the existing plan already covers this request.
    const evaluatorModel = new ScriptedModel([JSON.stringify({ track: false, plan: null }), review("revise"), review("blocked")])
    const agentProvider = { ...provider, id: "destructive-recovery-agent", provider: "destructive-recovery-agent" }
    const evaluatorProvider: TwinnyProvider = { ...provider, id: "destructive-recovery-evaluator", provider: "destructive-recovery-evaluator", type: "intent" }
    providerRegistry.register("destructive-recovery-agent", { id: "destructive-recovery-agent", create: () => agentModel })
    providerRegistry.register("destructive-recovery-evaluator", { id: "destructive-recovery-evaluator", create: () => evaluatorModel })
    const stored: Record<string, unknown> = {
      [ACTIVE_CHAT_PROVIDER_STORAGE_KEY]: agentProvider,
      [ACTIVE_INTENT_PROVIDER_STORAGE_KEY]: evaluatorProvider,
      [`${EVENT_NAME.twinnyGlobalContext}-${GLOBAL_STORAGE_KEY.agentMode}`]: true
    }
    const context = {
      extensionUri: vscode.Uri.file(path.resolve(__dirname, "../../..")),
      globalStorageUri: vscode.Uri.file(path.join(root, ".twinny-global-storage")),
      globalState: { get: (key: string) => stored[key], update: async (key: string, value: unknown) => void (stored[key] = value) },
      workspaceState: { get: () => undefined, update: async () => undefined },
      subscriptions: []
    } as unknown as vscode.ExtensionContext
    const repository = new TodoRepository(path.join(root, "todos.sqlite"), path.join(context.extensionUri.fsPath, "out", "sql-wasm.wasm"))
    const goal = "Modify src/webview/todo-panel.tsx with collapsible TODO cards; do not delete the component."
    const scope = {
      projectFingerprint: workspaceProjectFingerprint((vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.toString(true))),
      conversationId: "destructive-recovery-regression"
    }
    const plan = {
      planId: "destructive-recovery-plan",
      version: 1 as const,
      revision: 1,
      goal,
      constraints: ["Preserve the existing TODO panel component."],
      tasks: [{ id: "todo-panel-task", title: "Update the TODO panel", description: "Implement the requested card changes in place.", acceptanceCriteria: [criterion], dependencies: [] as string[] }]
    }
    await repository.synchronizeIntentPlan(scope, plan, { prompt: goal, plan })
    const chat = new ChatIn(new GenerationTracker(), undefined, context, new ExtensionBridge(fakeWebview() as unknown as vscode.Webview), undefined, undefined, repository)
    chat.root = root
    try {
      await chat.completion([{ role: "user", content: goal }], [], "off", scope.conversationId)
      assert.equal(fs.readFileSync(file, "utf8"), "export const TodoPanel = () => <div />\n")
      assert.equal(evaluatorModel.requests.length, 3, "one Feedback plan request and two reviews")
      assert.match(JSON.stringify(evaluatorModel.requests[0].messages), /Existing TODO plan/)
      assert.ok(agentModel.requests.length >= 3, "the delete call, its result, and an automatic corrective turn must reach the implementing provider")
      assert.match(JSON.stringify(agentModel.requests[1].messages.at(-1)?.content), /Not deleted:.*conflicts/i)
      const continuation = agentModel.requests.slice(2).flatMap((request) => request.messages).map((message) => String(message.content ?? "")).join("\n")
      assert.match(continuation, /Preserve the existing TODO panel component/)
      assert.match(continuation, /Keep the existing component and make the requested edits in place/)
    } finally {
      chat.dispose()
      await closeWorkspace()
      await settings.update("feedback.enabled", previousFeedback, vscode.ConfigurationTarget.Global)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

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
      extensionUri: vscode.Uri.file(path.resolve(__dirname, "../../..")),
      globalStorageUri: vscode.Uri.file(path.join(root, ".twinny-global-storage")),
      globalState: {
        get: (key: string) => stored[key],
        update: async (key: string, value: unknown) => {
          if (value === undefined) delete stored[key]
          else stored[key] = value
        }
      },
      workspaceState: { get: () => undefined, update: async () => undefined },
      subscriptions: []
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
    const previousApproval = settings.inspect<boolean>("mcpNeverAskAgain")?.globalValue
    await settings.update("mcpNeverAskAgain", false, vscode.ConfigurationTarget.Global)
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
      extensionUri: vscode.Uri.file(path.resolve(__dirname, "../../..")),
      globalStorageUri: vscode.Uri.file(path.join(root, ".twinny-global-storage")),
      globalState: { get: (key: string) => stored[key], update: async (key: string, value: unknown) => void (stored[key] = value) },
      workspaceState: { get: () => undefined, update: async () => undefined },
      subscriptions: []
    } as unknown as vscode.ExtensionContext
    // The bridge answers the chat it belongs to, made just below.
    const chatRef: { current?: ChatIn } = {}
    const asked: string[] = []
    const bridge = {
      handle: () => undefined,
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
      await settings.update("mcpNeverAskAgain", previousApproval, vscode.ConfigurationTarget.Global)
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
      extensionUri: vscode.Uri.file(path.resolve(__dirname, "../../..")),
      globalStorageUri: vscode.Uri.file(path.join(root, ".twinny-global-storage")),
      globalState: { get: (key: string) => stored[key], update: async (key: string, value: unknown) => void (stored[key] = value) },
      workspaceState: { get: () => undefined, update: async () => undefined },
      subscriptions: []
    } as unknown as vscode.ExtensionContext
    const asked: string[] = []
    let model = new ScriptedModel([call("fake__add", { a: "1", b: "2" }), "first done"])
    providerRegistry.register("scripted-agent", { id: "scripted-agent", create: () => model })
    const firstRef: { current?: ChatIn } = {}
    const firstBridge = {
      handle: () => undefined,
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
        handle: () => undefined,
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
        handle: () => undefined,
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
    const bridge = { handle: () => undefined, emit: (type: string, data: unknown) => emitted.push({ type, data }) } as unknown as ExtensionBridge
    const stored: Record<string, unknown> = {
      [ACTIVE_CHAT_PROVIDER_STORAGE_KEY]: provider,
      [`${EVENT_NAME.twinnyGlobalContext}-${GLOBAL_STORAGE_KEY.agentMode}`]: true,
      [`${EVENT_NAME.twinnyGlobalContext}-${GLOBAL_STORAGE_KEY.autoRunCommands}`]: true
    }
    const context = {
      extensionUri: vscode.Uri.file(path.resolve(__dirname, "../../..")),
      globalStorageUri: vscode.Uri.file(path.join(root, ".twinny-global-storage")),
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
      extensionUri: vscode.Uri.file(path.resolve(__dirname, "../../..")),
      globalStorageUri: vscode.Uri.file(path.join(root, ".twinny-global-storage")),
      globalState: { get: (key: string) => stored[key], update: async () => undefined },
      workspaceState: { get: () => undefined, update: async () => undefined },
      subscriptions: []
    } as unknown as vscode.ExtensionContext
    const chatRef: { current?: ChatIn } = {}
    const emitted: { type: string; data: unknown }[] = []
    let offered = false
    const bridge = {
      handle: () => undefined,
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
  test("Chat Base Instructions=None leaves eligible agent tools intact and profile restrictions resolve safely", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-agent-tool-resolution-"))
    const profilePath = path.join(root, ".github", "agents", "plan.agent.md")
    fs.mkdirSync(path.dirname(profilePath), { recursive: true })
    const closeWorkspace = await openWorkspace(root)
    const settings = vscode.workspace.getConfiguration("twinny")
    const previousAgents = settings.inspect("agents")?.globalValue
    const previousBaseMode = settings.inspect("chatBaseInstructionsMode")?.globalValue
    const previousMcpServers = settings.inspect("chatToolsMcpServers")?.globalValue
    const model = new ScriptedModel(["Done.", "Done.", "Done.", "Done."])
    const providerKind = "llamacpp"
    const previousAdapter = providerRegistry.get(providerKind)
    const configuredProvider: TwinnyProvider = { ...provider, provider: providerKind }
    providerRegistry.register(providerKind, { id: "scripted-llamacpp", create: () => model })
    const stored: Record<string, unknown> = { [ACTIVE_CHAT_PROVIDER_STORAGE_KEY]: configuredProvider }
    const context = {
      extensionUri: vscode.Uri.file(path.resolve(__dirname, "../../..")),
      globalStorageUri: vscode.Uri.file(path.join(root, ".twinny-storage")),
      globalState: {
        get: (key: string) => stored[key],
        update: async (key: string, value: unknown) => { stored[key] = value }
      },
      workspaceState: { get: () => undefined, update: async () => undefined },
      subscriptions: []
    } as unknown as vscode.ExtensionContext
    const registry = new AgentRegistry(context)
    const bridgeMessages: Array<{ type: string; data: unknown }> = []
    const bridge = { handle: () => undefined, emit: (type: string, data?: unknown) => bridgeMessages.push({ type, data }) } as unknown as ExtensionBridge
    const chat = new ChatIn(new GenerationTracker(), undefined, context, bridge, undefined)
    chat.root = root

    const runWithProfile = async (frontmatter: string, prompt: string) => {
      fs.writeFileSync(profilePath, `---\nname: Plan\n${frontmatter}---\n\nPlan the requested audit.`)
      const registered = await registry.list()
      const profile = registered.find((item) => item.path === vscode.Uri.file(profilePath).toString())
      assert.ok(profile?.valid, "temporary agent profile should parse and register")
      await chat.completion([{ role: "user", content: prompt }], [], profile.id)
      return model.requests.at(-1)
    }

    try {
      await settings.update("agents", {
        autoDiscover: false,
        definitions: [{ id: "test-plan-profile", path: profilePath, enabled: true }],
        searchPaths: [],
        excludedPaths: []
      }, vscode.ConfigurationTarget.Global)
      await settings.update("chatToolsMcpServers", {}, vscode.ConfigurationTarget.Global)

      await settings.update("chatBaseInstructionsMode", "default", vscode.ConfigurationTarget.Global)
      const defaultInstructions = await runWithProfile("", "Audit the project with normal tools under the built-in base.")
      const defaultTools = defaultInstructions?.tools?.map((tool) => tool.name) ?? []
      assert.ok(defaultTools.includes("read_file"), "an undeclared tools field must retain eligible tools")
      assert.ok(defaultTools.length > 1, "the agent should retain multiple normally eligible tools")

      await settings.update("chatBaseInstructionsMode", "none", vscode.ConfigurationTarget.Global)
      const unrestricted = await runWithProfile("", "Audit the project with normal tools and no base instructions.")
      const normalTools = unrestricted?.tools?.map((tool) => tool.name) ?? []
      assert.deepStrictEqual(normalTools, defaultTools, "None mode must not change the resolved tool set")
      assert.doesNotMatch(String(unrestricted?.messages[0]?.content), /You are a helpful, respectful and honest coding assistant/)

      const restricted = await runWithProfile("tools:\n  - vscode/readFile\n", "Audit with the declared read tool only.")
      assert.deepStrictEqual(restricted?.tools?.map((tool) => tool.name), ["read_file"])

      const unresolved = await runWithProfile("tools:\n  - vscode/webSearch\n", "Audit with the unavailable web search tool.")
      assert.ok(!unresolved?.tools?.some((tool) => tool.name === "read_file"), "unmatched restrictions must not grant alternatives")
      const notice = bridgeMessages.map(({ data }) => String(data ?? "")).find((message) => message.includes("Unmatched names: vscode/webSearch"))
      assert.ok(notice, "unmatched tool names and alternatives should be reported")
      assert.match(notice ?? "", /Available alternatives: .*read_file/)
    } finally {
      chat.dispose()
      await settings.update("agents", previousAgents, vscode.ConfigurationTarget.Global)
      await settings.update("chatBaseInstructionsMode", previousBaseMode, vscode.ConfigurationTarget.Global)
      await settings.update("chatToolsMcpServers", previousMcpServers, vscode.ConfigurationTarget.Global)
      if (previousAdapter) providerRegistry.register(providerKind, previousAdapter)
      else providerRegistry.unregister(providerKind)
      await closeWorkspace()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("agent tool restrictions can be ignored without touching the profile", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-agent-tool-override-"))
    const profilePath = path.join(root, ".github", "agents", "plan.agent.md")
    fs.mkdirSync(path.dirname(profilePath), { recursive: true })
    fs.writeFileSync(path.join(root, "a.ts"), "export const a = 1\n")
    const closeWorkspace = await openWorkspace(root)

    const model = new ScriptedModel(["Done."])
    providerRegistry.register("scripted-agent", { id: "scripted-agent", create: () => model })

    const stored: Record<string, unknown> = {
      [ACTIVE_CHAT_PROVIDER_STORAGE_KEY]: provider,
      [`${EVENT_NAME.twinnyGlobalContext}-${GLOBAL_STORAGE_KEY.agentMode}`]: true
    }
    const context = {
      extensionUri: vscode.Uri.file(path.resolve(__dirname, "../../..")),
      globalStorageUri: vscode.Uri.file(path.join(root, ".twinny-global-storage")),
      globalState: {
        get: (key: string) => stored[key],
        update: async (key: string, value: unknown) => {
          if (value === undefined) delete stored[key]
          else stored[key] = value
        }
      },
      workspaceState: { get: () => undefined, update: async () => undefined },
      subscriptions: []
    } as unknown as vscode.ExtensionContext

const bridgeMessages: Array<{ type: string; data: unknown }> = []
    const bridge = { handle: () => undefined, emit: (type: string, data?: unknown) => bridgeMessages.push({ type, data }) } as unknown as ExtensionBridge
    const chat = new ChatIn(new GenerationTracker(), undefined, context, bridge, undefined)
    chat.root = root

    const settings = vscode.workspace.getConfiguration("twinny")
    const previousAgents = settings.inspect("agents")?.globalValue
    const previousMcpServers = settings.inspect("chatToolsMcpServers")?.globalValue

    const writeProfile = (frontmatter: string) => {
      fs.writeFileSync(profilePath, `---\nname: Plan\n${frontmatter}user-invocable: true\n---\n\nPlan the requested audit.\n`)
    }

    const runWith = async (ignoreRestrictions: boolean, frontmatter: string) => {
      await settings.update(
        "agents",
        {
          autoDiscover: false,
          searchPaths: [],
          excludedPaths: [],
          definitions: [{ id: "test-plan-override", path: profilePath, enabled: true }],
          ignoreAgentToolRestrictions: ignoreRestrictions
        },
        vscode.ConfigurationTarget.Global
      )
      writeProfile(frontmatter)
      await chat.completion([{ role: "user", content: "Audit the project." } as ChatCompletionMessage], [], "test-plan-override")
      return model.requests.at(-1)!
    }

    const notification = (): string[] =>
      bridgeMessages.map(({ data }) => String(data ?? "")).filter((message) => message.includes("Ignored the agent profile's tool restrictions"))

    try {
      await settings.update("chatToolsMcpServers", {}, vscode.ConfigurationTarget.Global)

      // Override off: the profile's declaration still restricts the tools.
      const restricted = await runWith(false, "tools:\n  - vscode/readFile\n")
      if (restricted.tools) {
        assert.deepStrictEqual(restricted.tools.map((tool) => tool.name), ["read_file"])
      } else {
        const prompt = restricted.messages.map((message) => String((message as ChatCompletionMessage).content ?? "")).join("\n")
        assert.match(prompt, /read_file/, "text-mode providers receive the selected read tool instructions")
        assert.doesNotMatch(prompt, /name: edit_file|"name":"edit_file"/, "text-mode providers do not receive deselected edit instructions")
      }

      // Override on: incompatible Copilot tool names no longer suppress eligible tools,
      // and the outgoing provider request is authoritative.
      const ignored = await runWith(true, "tools:\n  - browser\n  - todo\n  - vscode/webSearch\n")
      assert.match(fs.readFileSync(profilePath, "utf8"), /browser/, "ignoring restrictions does not rewrite the agent profile")
      // When the provider includes tools in the request, verify they are exposed.
      // When the provider mode is "text", tools might not be included in the request,
      // so we rely on the diagnostic message instead.
      if (ignored.tools) {
        const ignoredNames = ignored.tools.map((tool) => tool.name)
        assert.ok(ignoredNames.includes("read_file"), "read_file must be offered despite the incompatible declaration")
        assert.ok(ignoredNames.length > 1, "the agent must receive Twinny's normally eligible tools")
      }
      assert.match(notification().pop() ?? "", /Ignored the agent profile's tool restrictions; \d+ eligible tools? exposed to the provider./)

      // Override on: an explicitly empty tools: [] does not suppress eligible tools.
      const emptied = await runWith(true, "tools: []\n")
      // When the provider includes tools, check that read_file is among them.
      // When the provider mode is "text", tools might not be included,
      // so we rely on the diagnostic message instead.
      if (emptied.tools) {
        const emptyNames = emptied.tools.map((tool) => tool.name)
        assert.ok(emptyNames.includes("read_file"), "an empty tools declaration must not suppress eligible tools")
      } else {
        assert.match(notification().pop() ?? "", /Ignored the agent profile's tool restrictions; \d+ eligible tools? exposed to the provider./)
      }

      // Override on: a profile without a tools declaration behaves normally.
      const diagnosticsBefore = notification().length
      const plain = await runWith(true, "")
      // When the provider includes tools, check that read_file is among them.
      // When the provider mode is "text", tools might not be included,
      // so we rely on the diagnostic message instead.
      if (plain.tools) {
        const plainNames = plain.tools.map((tool) => tool.name)
        assert.ok(plainNames.includes("read_file") && plainNames.length > 1, "no declaration means no restriction")
      }
      assert.strictEqual(notification().length, diagnosticsBefore, "no tools declaration means nothing to ignore")

      // Override on: the profile's instructions remain intact and the file itself is unedited.
      const system = ignored.messages.at(0)
      assert.ok(system && String((system as ChatCompletionMessage).content).includes("Plan the requested audit."))

      // Override off again: the restriction is back in force.
      const back = await runWith(false, "tools:\n  - vscode/readFile\n")
      // When the provider includes tools, verify that only read_file is available.
      // When the provider mode is "text", tools might not be included,
      // so we check the diagnostic message instead.
      if (back.tools) {
        assert.deepStrictEqual(back.tools.map((tool) => tool.name), ["read_file"])
      } else {
        const prompt = back.messages.map((message) => String((message as ChatCompletionMessage).content ?? "")).join("\n")
        assert.match(prompt, /read_file/, "text-mode providers receive the selected read tool instructions")
        assert.doesNotMatch(prompt, /name: edit_file|"name":"edit_file"/, "text-mode providers do not receive deselected edit instructions")
      }

      // The setting round-trips through the configuration system.
      assert.strictEqual((settings.inspect("agents")?.globalValue as { ignoreAgentToolRestrictions?: boolean } | undefined)?.ignoreAgentToolRestrictions, false)
    } finally {
      chat.dispose()
      await settings.update("agents", previousAgents, vscode.ConfigurationTarget.Global)
      await settings.update("chatToolsMcpServers", previousMcpServers, vscode.ConfigurationTarget.Global)
      providerRegistry.unregister("scripted-agent")
      await closeWorkspace()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

})
