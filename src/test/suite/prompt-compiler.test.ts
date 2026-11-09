import * as assert from "assert"
import { promises as fs } from "fs"
import os from "os"
import path from "path"
import * as vscode from "vscode"

import {
  ACTIVE_CHAT_PROVIDER_STORAGE_KEY,
  ACTIVE_INTENT_PROVIDER_STORAGE_KEY,
  EVENT_NAME,
  TODO_EVENT_NAME,
  USER
} from "../../common/constants"
import {
  FEEDBACK_ENABLED_KEY,
  FEEDBACK_PROVIDER_KEY,
  isFeedbackEnabled,
  isPromptCompilerEnabled,
  PROMPT_COMPILER_ENABLED_KEY,
  PROMPT_COMPILER_INSTRUCTIONS_FILE_KEY,
  PROMPT_COMPILER_INSTRUCTIONS_MODE_KEY,
  PROMPT_COMPILER_MAX_TURNS_KEY,
  PROMPT_COMPILER_PROVIDER_KEY,
  PROMPT_COMPILER_TRACE_KEY
} from "../../common/feedback-settings"
import { ChatCompletionMessage } from "../../common/types"
import type { FeedbackPlanner } from "../../extension/chat/feedback-planner"
import { Chat, summarizeIntentHistory } from "../../extension/chat/index"
import { GenerationTracker } from "../../extension/generations"
import { ChatRequest, InferenceProvider, providerRegistry } from "../../extension/inference"
import { ExtensionBridge } from "../../extension/messaging/bridge"
import { TodoRepository, workspaceProjectFingerprint } from "../../extension/todos/repository"

const makeBridge = (emitted: Array<{ event: string; data: unknown }> = []) => ({
  emit: (event: string, data: unknown) => emitted.push({ event, data }),
  request: async () => undefined,
  handle: () => undefined,
  on: () => undefined,
  once: () => undefined,
  off: () => undefined,
  dispose: () => undefined
}) as unknown as ExtensionBridge

const COMPILED = "Review the parser, make the smallest safe fix, then run its focused test."
const PLAN = {
  planId: "parser-plan",
  version: 1,
  revision: 1,
  goal: "Make parser behavior reliable",
  constraints: ["Preserve public API"],
  tasks: [
    { id: "inspect-parser", title: "Inspect parser", description: "Inspect parser behavior", criteria: [{ id: "criterion-1", description: "Identify faulty branch", verification: { kind: "semantic_review" } }], dependencies: [] },
    { id: "fix-parser", title: "Fix parser", description: "Correct faulty branch", criteria: [{ id: "criterion-1", description: "Regression test passes", verification: { kind: "semantic_review" } }], dependencies: ["inspect-parser"] },
    { id: "verify-parser", title: "Verify parser", description: "Run focused tests", criteria: [{ id: "criterion-1", description: "Focused tests pass", verification: { kind: "semantic_review" } }], dependencies: ["fix-parser"] }
  ]
}

/** Answers as the Prompt Compiler or as Feedback, from the protocol in its system prompt. */
class ScriptedRoleModel implements InferenceProvider {
  public readonly id = "scripted-role-model"
  public requests: ChatRequest[] = []
  public compilerOutput?: string
  public feedbackOutput?: string
  public failWith?: Error

  async *chat(request: ChatRequest) {
    this.requests.push(structuredClone(request))
    if (this.failWith) throw this.failWith
    const system = String(request.messages[0]?.content ?? "")
    yield {
      content: /track \(boolean\)/.test(system)
        ? this.feedbackOutput ?? JSON.stringify({ track: true, plan: PLAN })
        : this.compilerOutput ?? JSON.stringify({ prompt: COMPILED })
    }
  }

  capabilities() {
    return ["chat" as const]
  }
}

const roleProvider = {
  id: "scripted-feedback-provider",
  label: "Scripted feedback",
  modelName: "scripted-role-model",
  provider: "scripted-role-model",
  type: "intent" as const
}

const makeContext = (extra: Record<string, unknown> = {}, globals: Record<string, unknown> = { [ACTIVE_INTENT_PROVIDER_STORAGE_KEY]: roleProvider }) => ({
  extensionUri: vscode.Uri.file(path.resolve(__dirname, "../../..")),
  globalState: { get: (key: string) => globals[key], update: async () => undefined },
  workspaceState: { get: () => undefined, update: async () => undefined },
  subscriptions: [],
  ...extra
}) as unknown as vscode.ExtensionContext

const SETTING_KEYS = [
  FEEDBACK_ENABLED_KEY,
  FEEDBACK_PROVIDER_KEY,
  PROMPT_COMPILER_ENABLED_KEY,
  PROMPT_COMPILER_PROVIDER_KEY,
  PROMPT_COMPILER_MAX_TURNS_KEY,
  PROMPT_COMPILER_TRACE_KEY,
  PROMPT_COMPILER_INSTRUCTIONS_MODE_KEY,
  PROMPT_COMPILER_INSTRUCTIONS_FILE_KEY,
  "chatToolsIntentCompilerEnabled",
  "chatToolsIntentCompilerMode",
  "chatToolsFeedbackEvaluatorEnabled",
  "chatBaseInstructionsMode",
  "chatBaseInstructionsFile"
]

const resetSettings = async () => {
  const settings = vscode.workspace.getConfiguration("twinny")
  for (const key of SETTING_KEYS) await settings.update(key, undefined, vscode.ConfigurationTarget.Global)
}

const setSetting = (key: string, value: unknown) =>
  vscode.workspace.getConfiguration("twinny").update(key, value, vscode.ConfigurationTarget.Global)

const feedbackPlanner = (chat: Chat) => (chat as unknown as { _feedbackPlanner: FeedbackPlanner })._feedbackPlanner

suite("Prompt Compiler and Feedback", () => {
  let model: ScriptedRoleModel

  setup(async () => {
    await resetSettings()
    model = new ScriptedRoleModel()
    providerRegistry.register("scripted-role-model", { id: "scripted-role-model", create: () => model })
  })

  teardown(resetSettings)

  test("the compiler is a disabled capability by default and never calls a provider then", async () => {
    const chat = new Chat(new GenerationTracker(), undefined, makeContext(), makeBridge(), undefined)
    try {
      assert.equal(isPromptCompilerEnabled(vscode.workspace.getConfiguration("twinny")), false)
      const result = await chat.compilePrompt({ requestId: "disabled-1", prompt: "Fix the parser." })
      assert.equal(result.status, "disabled")
      assert.deepEqual(model.requests, [])
    } finally {
      chat.dispose()
    }
  })

  test("a legacy automatic mode alone does not enable compilation; a legacy enable flag does", async () => {
    const settings = () => vscode.workspace.getConfiguration("twinny")
    await setSetting("chatToolsIntentCompilerMode", "always-refined")
    assert.equal(isPromptCompilerEnabled(settings()), false)
    await setSetting("chatToolsIntentCompilerEnabled", true)
    assert.equal(isPromptCompilerEnabled(settings()), true)
    await setSetting(PROMPT_COMPILER_ENABLED_KEY, false)
    assert.equal(isPromptCompilerEnabled(settings()), false, "the new key wins over its legacy value")
    await setSetting("chatToolsFeedbackEvaluatorEnabled", false)
    assert.equal(isFeedbackEnabled(settings()), false)
    await setSetting(FEEDBACK_ENABLED_KEY, true)
    assert.equal(isFeedbackEnabled(settings()), true)
  })

  test("compiling returns only text for the composer: it creates no TODOs and sends no chat", async () => {
    await setSetting(PROMPT_COMPILER_ENABLED_KEY, true)
    const chatModel = new ScriptedRoleModel()
    providerRegistry.register("scripted-chat-executor", { id: "scripted-chat-executor", create: () => chatModel })
    const chatProvider = { ...roleProvider, id: "chat-provider", modelName: "chat-model", provider: "scripted-chat-executor", type: "chat" as const }
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "twinny-compile-only-"))
    const context = makeContext({}, { [ACTIVE_INTENT_PROVIDER_STORAGE_KEY]: roleProvider, [ACTIVE_CHAT_PROVIDER_STORAGE_KEY]: chatProvider })
    const repository = new TodoRepository(path.join(root, "todos.sqlite"), path.join(context.extensionUri.fsPath, "out", "sql-wasm.wasm"))
    const emitted: Array<{ event: string; data: unknown }> = []
    const chat = new Chat(new GenerationTracker(), undefined, context, makeBridge(emitted), undefined, undefined, repository)
    const scope = {
      projectFingerprint: workspaceProjectFingerprint((vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.toString(true))),
      conversationId: "compile-only-chat"
    }
    try {
      const result = await chat.compilePrompt({ requestId: "compile-1", prompt: "Fix the parser.", conversationId: scope.conversationId })
      assert.deepEqual(result, { requestId: "compile-1", status: "compiled", prompt: COMPILED })
      assert.equal(model.requests.length, 1, "compiled exactly once")
      assert.equal(model.requests[0].model, "scripted-role-model")
      assert.deepEqual(chatModel.requests, [])
      assert.equal((await repository.getList(scope)).items.length, 0)
      assert.ok(!emitted.some(({ event }) => event === TODO_EVENT_NAME.changed))
    } finally {
      chat.dispose()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("a compiler failure is reported on its own and leaves Feedback working", async () => {
    await setSetting(PROMPT_COMPILER_ENABLED_KEY, true)
    await setSetting(PROMPT_COMPILER_PROVIDER_KEY, "missing-compiler-provider")
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "twinny-compile-isolation-"))
    const context = makeContext()
    const repository = new TodoRepository(path.join(root, "todos.sqlite"), path.join(context.extensionUri.fsPath, "out", "sql-wasm.wasm"))
    const chat = new Chat(new GenerationTracker(), undefined, context, makeBridge(), undefined, undefined, repository)
    const scope = { projectFingerprint: "isolation-project", conversationId: "isolation-chat", writer: "isolation-chat" }
    try {
      const compiled = await chat.compilePrompt({ requestId: "compile-missing", prompt: "Fix the parser." })
      assert.equal(compiled.status, "failed")
      assert.match(compiled.status === "failed" ? compiled.error : "", /missing-compiler-provider/)
      assert.deepEqual(model.requests, [], "no silent fallback to another provider")

      const planned = await feedbackPlanner(chat).start(scope, "Fix the parser.")
      assert.equal(planned.status, "planned")
      assert.equal((await repository.getList(scope)).items.length, 3)
    } finally {
      chat.dispose()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("Feedback plans TODOs for an ordinary prompt with the compiler disabled, without duplicates", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "twinny-feedback-plan-"))
    const context = makeContext()
    const repository = new TodoRepository(path.join(root, "todos.sqlite"), path.join(context.extensionUri.fsPath, "out", "sql-wasm.wasm"))
    const emitted: Array<{ event: string; data: unknown }> = []
    const chat = new Chat(new GenerationTracker(), undefined, context, makeBridge(emitted), undefined, undefined, repository)
    const scope = { projectFingerprint: "feedback-project", conversationId: "feedback-chat", writer: "feedback-chat" }
    try {
      assert.equal(isPromptCompilerEnabled(vscode.workspace.getConfiguration("twinny")), false)
      const first = await feedbackPlanner(chat).start(scope, "Fix the parser.")
      assert.equal(first.status, "planned")
      const list = await repository.getList(scope)
      assert.deepEqual(list.items.map((item) => item.title), ["Inspect parser", "Fix parser", "Verify parser"])
      assert.ok(emitted.some(({ event }) => event === TODO_EVENT_NAME.changed))

      assert.equal((await feedbackPlanner(chat).start(scope, "Fix the parser.")).status, "planned")
      const repeated = await repository.getList(scope)
      assert.equal(repeated.id, list.id)
      assert.equal(repeated.items.length, 3)
      assert.ok(String(model.requests[1].messages[1]?.content ?? "").includes("parser-plan"), "the existing plan is offered for revision")

      model.feedbackOutput = "not json"
      const failed = await feedbackPlanner(chat).start(scope, "Keep the plan.")
      assert.equal(failed.status, "failed")
      assert.deepEqual((await repository.getList(scope)).items.map((item) => item.id), repeated.items.map((item) => item.id))
      assert.ok(emitted.some(({ event, data }) => event === EVENT_NAME.twinnyNotification && /Feedback/.test(String(data))))
    } finally {
      chat.dispose()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("an ordinary chat with agent mode off still gets Feedback TODOs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "twinny-feedback-agent-off-"))
    const context = makeContext({}, { [ACTIVE_CHAT_PROVIDER_STORAGE_KEY]: roleProvider, [ACTIVE_INTENT_PROVIDER_STORAGE_KEY]: roleProvider })
    const repository = new TodoRepository(path.join(root, "todos.sqlite"), path.join(context.extensionUri.fsPath, "out", "sql-wasm.wasm"))
    const emitted: Array<{ event: string; data: unknown }> = []
    const chat = new Chat(new GenerationTracker(), undefined, context, makeBridge(emitted), undefined, undefined, repository)
    try {
      await chat.completion([{ role: USER, content: "Fix the parser." }], [], "off", "agent-off-chat")
      await feedbackPlanner(chat).pending()
      const changed = emitted.filter(({ event }) => event === TODO_EVENT_NAME.changed).map(({ data }) => data as { conversationId: string; items: unknown[] })
      assert.ok(changed.some((snapshot) => snapshot.conversationId === "agent-off-chat" && snapshot.items.length === 3))
      const chatRequest = model.requests.find((request) => !/track \(boolean\)/.test(String(request.messages[0]?.content ?? "")))
      assert.ok(chatRequest, "the chat turn reached the model")
      assert.ok(String(chatRequest.messages[0]?.content ?? "").includes("twinny_active_intent_task"), "the first model call already sees the plan")
    } finally {
      chat.dispose()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("a compiled execution prompt still starts Feedback and the first chat request sees the plan", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "twinny-feedback-compiled-"))
    const context = makeContext({}, { [ACTIVE_CHAT_PROVIDER_STORAGE_KEY]: roleProvider, [ACTIVE_INTENT_PROVIDER_STORAGE_KEY]: roleProvider })
    const repository = new TodoRepository(path.join(root, "todos.sqlite"), path.join(context.extensionUri.fsPath, "out", "sql-wasm.wasm"))
    const emitted: Array<{ event: string; data: unknown }> = []
    const chat = new Chat(new GenerationTracker(), undefined, context, makeBridge(emitted), undefined, undefined, repository)
    try {
      await chat.completion([{ role: USER, content: "fix parser", prompt: "Refined execution prompt: fix the parser and add a regression test." }], [], "off", "compiled-chat")
      await feedbackPlanner(chat).pending()
      const changed = emitted.filter(({ event }) => event === TODO_EVENT_NAME.changed).map(({ data }) => data as { conversationId: string; items: unknown[] })
      assert.ok(changed.some((snapshot) => snapshot.conversationId === "compiled-chat" && snapshot.items.length > 0), "compiled prompts create TODOs")
      const chatRequest = model.requests.find((request) => !/track \(boolean\)/.test(String(request.messages[0]?.content ?? "")))
      assert.ok(String(chatRequest?.messages[0]?.content ?? "").includes("twinny_active_intent_task"), "the first model call already sees the plan")
    } finally {
      chat.dispose()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("Feedback disabled plans nothing and calls no provider", async () => {
    await setSetting(FEEDBACK_ENABLED_KEY, false)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "twinny-feedback-off-"))
    const context = makeContext()
    const repository = new TodoRepository(path.join(root, "todos.sqlite"), path.join(context.extensionUri.fsPath, "out", "sql-wasm.wasm"))
    const chat = new Chat(new GenerationTracker(), undefined, context, makeBridge(), undefined, undefined, repository)
    try {
      assert.equal((await feedbackPlanner(chat).start({ projectFingerprint: "p", conversationId: "c", writer: "c" }, "Fix it.")).status, "disabled")
      assert.deepEqual(model.requests, [])
    } finally {
      chat.dispose()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("a Feedback provider error is visible and does not masquerade as an empty plan", async () => {
    model.failWith = Object.assign(new Error("401 Unauthorized"), { status: 401 })
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "twinny-feedback-auth-"))
    const context = makeContext()
    const repository = new TodoRepository(path.join(root, "todos.sqlite"), path.join(context.extensionUri.fsPath, "out", "sql-wasm.wasm"))
    const emitted: Array<{ event: string; data: unknown }> = []
    const chat = new Chat(new GenerationTracker(), undefined, context, makeBridge(emitted), undefined, undefined, repository)
    try {
      const outcome = await feedbackPlanner(chat).start({ projectFingerprint: "p", conversationId: "auth", writer: "auth" }, "Fix it.")
      assert.equal(outcome.status, "failed")
      assert.match(outcome.error ?? "", /Feedback \(Scripted feedback\)/)
      assert.ok(emitted.some(({ event }) => event === EVENT_NAME.twinnyNotification))
      assert.equal(model.requests.length, 1, "no retry loop")
    } finally {
      chat.dispose()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("compilation resolves default, custom, and None instructions while enforcing JSON", async () => {
    await setSetting(PROMPT_COMPILER_ENABLED_KEY, true)
    const chat = new Chat(new GenerationTracker(), undefined, makeContext(), makeBridge(), undefined)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "twinny-compiler-instructions-"))
    const customFile = path.join(root, "compiler.md")
    try {
      await chat.compilePrompt({ requestId: "instr-default", prompt: "Fix the bug in the parser." })
      let system = String(model.requests[0].messages[0]?.content ?? "")
      assert.match(system, /Refine a user request for a coding agent without changing its intent/)
      assert.match(system, /Return exactly one valid JSON object/)
      assert.doesNotMatch(system, /You are a helpful, respectful and honest coding assistant/)

      await fs.writeFile(customFile, "Compiler-only custom instructions")
      await setSetting(PROMPT_COMPILER_INSTRUCTIONS_FILE_KEY, customFile)
      await setSetting(PROMPT_COMPILER_INSTRUCTIONS_MODE_KEY, "custom")
      await chat.compilePrompt({ requestId: "instr-custom", prompt: "Use the custom compiler profile." })
      system = String(model.requests[1].messages[0]?.content ?? "")
      assert.match(system, /Compiler-only custom instructions/)
      assert.doesNotMatch(system, /Refine a user request for a coding agent/)
      assert.match(system, /Return exactly one valid JSON object/)

      await setSetting(PROMPT_COMPILER_INSTRUCTIONS_MODE_KEY, "none")
      await chat.compilePrompt({ requestId: "instr-none", prompt: "Run with no optional compiler instructions." })
      system = String(model.requests[2].messages[0]?.content ?? "")
      assert.doesNotMatch(system, /Compiler-only custom instructions/)
      assert.match(system, /Return exactly one valid JSON object/)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
      chat.dispose()
    }
  })

  test("chat effective prompt preview uses only chat instructions", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "twinny-chat-instructions-"))
    const chatFile = path.join(root, "chat.md")
    const compilerFile = path.join(root, "compiler.md")
    await fs.writeFile(chatFile, "Chat-only base instructions")
    await fs.writeFile(compilerFile, "Compiler-only base instructions")
    await setSetting("chatBaseInstructionsFile", chatFile)
    await setSetting("chatBaseInstructionsMode", "custom")
    await setSetting(PROMPT_COMPILER_INSTRUCTIONS_FILE_KEY, compilerFile)
    await setSetting(PROMPT_COMPILER_INSTRUCTIONS_MODE_KEY, "custom")
    const chat = new Chat(new GenerationTracker(), undefined, makeContext({}, {}), makeBridge(), undefined)
    try {
      const preview = await chat.previewPromptInstructions("off")
      assert.match(preview.chatEffective, /Chat-only base instructions/)
      assert.doesNotMatch(preview.chatEffective, /Compiler-only base instructions/)
      assert.match(preview.intentEffective, /Compiler-only base instructions/)
      assert.doesNotMatch(preview.intentEffective, /Chat-only base instructions/)

      await setSetting("chatBaseInstructionsMode", "none")
      const nonePreview = await chat.previewPromptInstructions("off")
      assert.equal(nonePreview.chat.mode, "none")
      assert.doesNotMatch(nonePreview.chatEffective, /Chat-only base instructions/)
      assert.match(nonePreview.intentEffective, /Compiler-only base instructions/)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
      chat.dispose()
    }
  })

  test("legacy base-instruction settings are still honored", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "twinny-legacy-instructions-"))
    const compilerFile = path.join(root, "compiler.md")
    await fs.writeFile(compilerFile, "Legacy compiler instructions")
    await setSetting("intentBaseInstructionsFile", compilerFile)
    await setSetting("intentBaseInstructionsMode", "custom")
    const chat = new Chat(new GenerationTracker(), undefined, makeContext({}, {}), makeBridge(), undefined)
    try {
      const preview = await chat.previewPromptInstructions("off")
      assert.match(preview.intentEffective, /Legacy compiler instructions/)
    } finally {
      await setSetting("intentBaseInstructionsFile", undefined)
      await setSetting("intentBaseInstructionsMode", undefined)
      await fs.rm(root, { recursive: true, force: true })
      chat.dispose()
    }
  })

  test("includes bounded prior prompt/response history as context only", async () => {
    await setSetting(PROMPT_COMPILER_ENABLED_KEY, true)
    await setSetting(PROMPT_COMPILER_MAX_TURNS_KEY, 1)
    const chat = new Chat(new GenerationTracker(), undefined, makeContext(), makeBridge(), undefined)
    const history: ChatCompletionMessage[] = [
      { role: "user", content: "First task prompt" },
      { role: "assistant", content: "First task response" },
      { role: "user", content: "Second task prompt" },
      { role: "assistant", content: "Second task response" }
    ]
    try {
      await chat.compilePrompt({ requestId: "history-1", prompt: "Fix the bug in the parser.", history })
      const user = String(model.requests[0].messages[1]?.content ?? "")
      assert.match(user, /Historical prior prompt\/response turns/)
      assert.match(user, /Second task prompt/)
      assert.doesNotMatch(user, /First task prompt/, "maxTurns bounds the history")
      assert.match(user, /Current draft:\nFix the bug in the parser\./)
    } finally {
      chat.dispose()
    }
  })

  test("uses the selected execution prompt when a refined prompt differs from the original user wording", () => {
    const history: ChatCompletionMessage[] = [
      { role: "user", content: "Original user wording", originalPrompt: "Original user wording", prompt: "Refined execution prompt" },
      { role: "assistant", content: "Final response" }
    ]
    const summary = summarizeIntentHistory(history, 1)
    assert.strictEqual(summary.pairs.length, 1)
    assert.strictEqual(summary.pairs[0].prompt, "Refined execution prompt")
    assert.strictEqual(summary.pairs[0].response, "Final response")
  })

  test("summarizes only completed history pairs", () => {
    const history: ChatCompletionMessage[] = [
      { role: "user", content: "First task prompt" },
      { role: "assistant", content: "First task response" },
      { role: "user", content: "Second task prompt" },
      { role: "assistant", content: "Second task response" },
      { role: "user", content: "Current prompt in progress" }
    ]
    const summary = summarizeIntentHistory(history, 2)
    assert.strictEqual(summary.maxLevels, 2)
    assert.strictEqual(summary.pairs.length, 2)
    assert.strictEqual(summary.pairs[0].promptLength, "First task prompt".length)
    assert.strictEqual(summary.pairs[1].responseLength, "Second task response".length)
  })

  test("trace mode is off by default and writes one credential-free trace per request when on", async () => {
    assert.strictEqual(vscode.workspace.getConfiguration("twinny").get<boolean>(PROMPT_COMPILER_TRACE_KEY), false)
    await setSetting(PROMPT_COMPILER_ENABLED_KEY, true)
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "twinny-compiler-trace-"))
    const chat = new Chat(new GenerationTracker(), undefined, makeContext({ globalStorageUri: { fsPath: temp }, storageUri: { fsPath: temp } }), makeBridge(), undefined)
    const traceDir = path.join(temp, "prompt-compiler-traces")
    try {
      await chat.compilePrompt({ requestId: "trace-off", prompt: "No trace." })
      await assert.rejects(fs.readdir(traceDir))

      await setSetting(PROMPT_COMPILER_TRACE_KEY, true)
      await chat.compilePrompt({ requestId: "trace-1", prompt: "Fix the parser.", history: [{ role: "user", content: "First task prompt" }, { role: "assistant", content: "First task response" }] })
      await chat.compilePrompt({ requestId: "trace-2", prompt: "Fix the parser again." })
      const files = await fs.readdir(traceDir)
      assert.strictEqual(files.length, 2)
      const traces = await Promise.all(files.map(async (file) => JSON.parse(await fs.readFile(path.join(traceDir, file), "utf8"))))
      assert.deepEqual(traces.map((trace) => trace.requestId).sort(), ["trace-1", "trace-2"])
      for (const trace of traces) {
        assert.equal(trace.provider.modelName, "scripted-role-model")
        assert.match(trace.request.user, /Fix the parser/)
        assert.match(trace.response, /"prompt"/)
        assert.doesNotMatch(JSON.stringify(trace), /api[_-]?key|Bearer\s+[A-Za-z0-9._~+/=-]+/i)
      }
    } finally {
      chat.dispose()
      await fs.rm(temp, { recursive: true, force: true })
    }
  })
})
