import * as assert from "assert"
import { promises as fs } from "fs"
import os from "os"
import path from "path"
import * as vscode from "vscode"

import {
  ACTIVE_CHAT_PROVIDER_STORAGE_KEY,
  ACTIVE_INTENT_PROVIDER_STORAGE_KEY,
  TODO_EVENT_NAME
} from "../../common/constants"
import { ChatCompletionMessage } from "../../common/types"
import { Chat, parseIntentCompilerResponse, summarizeIntentHistory } from "../../extension/chat/index"
import { GenerationTracker } from "../../extension/generations"
import { ChatRequest, InferenceProvider, providerRegistry } from "../../extension/inference"
import { ExtensionBridge } from "../../extension/messaging/bridge"
import { TodoRepository, workspaceProjectFingerprint } from "../../extension/todos/repository"

const makeBridge = () => ({
  emit: () => undefined,
  request: async () => undefined,
  on: () => undefined,
  once: () => undefined,
  off: () => undefined,
  dispose: () => undefined
}) as unknown as ExtensionBridge

class ScriptedCompilerModel implements InferenceProvider {
  public readonly id = "scripted-intent-compiler"
  public requests: ChatRequest[] = []
  public output?: string

  async *chat(request: ChatRequest) {
    this.requests.push(structuredClone(request))
    const payload = {
      objective: "Refine the request for execution.",
      prompt: "Review the file and make the smallest safe implementation change, then validate with a focused test.",
      constraints: ["Preserve existing behavior"],
      exclusions: ["Do not add unrelated features"],
      strategy: "Read the focused files, patch, then run the relevant test.",
      verification: ["Run the relevant test or validation command"],
      assumptions: ["The user intends a minimal, safe change."],
      plan: {
        planId: "parser-plan",
        version: 1,
        revision: 1,
        goal: "Make parser behavior reliable",
        constraints: ["Preserve public API"],
        tasks: [
          { id: "inspect-parser", title: "Inspect parser", description: "Inspect parser behavior", acceptanceCriteria: ["Identify faulty branch"], dependencies: [] },
          { id: "fix-parser", title: "Fix parser", description: "Correct faulty branch", acceptanceCriteria: ["Regression test passes"], dependencies: ["inspect-parser"] },
          { id: "verify-parser", title: "Verify parser", description: "Run focused tests", acceptanceCriteria: ["Focused tests pass"], dependencies: ["fix-parser"] }
        ]
      }
    }
    yield { content: this.output ?? JSON.stringify(payload) }
  }

  capabilities() {
    return ["chat" as const]
  }
}

suite("Intent compiler", () => {
  test("parses a structured compiler response", () => {
    const parsed = parseIntentCompilerResponse(`{
      "objective": "Refine the request for execution.",
      "prompt": "Review the file and make the smallest safe implementation change, then validate with a focused test.",
      "constraints": ["Preserve existing behavior"],
      "exclusions": ["Do not add unrelated features"],
      "strategy": "Read the focused files, patch, then run the relevant test.",
      "verification": ["Run the relevant test or validation command"],
      "assumptions": ["The user intends a minimal, safe change."],
      "plan": {"planId":"parser-plan","version":1,"revision":1,"goal":"Make parser behavior reliable","constraints":[],"tasks":[{"id":"inspect-parser","title":"Inspect parser","description":"Inspect parser behavior","acceptanceCriteria":["Identify faulty branch"],"dependencies":[]}]}
    }`)

    assert.ok(parsed)
    assert.strictEqual(parsed?.objective, "Refine the request for execution.")
    assert.strictEqual(parsed?.prompt.includes("smallest safe implementation change"), true)
    assert.deepStrictEqual(parsed?.constraints, ["Preserve existing behavior"])
  })

  test("rejects malformed compiler output", () => {
    assert.strictEqual(parseIntentCompilerResponse("not valid json"), undefined)
  })

  test("rejects compiler JSON that violates the required protocol shape", () => {
    assert.strictEqual(parseIntentCompilerResponse(JSON.stringify({ objective: "Goal", prompt: "Do it" })), undefined)
    assert.strictEqual(parseIntentCompilerResponse(JSON.stringify({
      objective: "Goal", prompt: "Do it", constraints: [], exclusions: [], strategy: "", verification: [], assumptions: [], extra: true
    })), undefined)
  })

  test("skips compile when the setting is disabled or set to always original", async () => {
    const settings = vscode.workspace.getConfiguration("twinny")
    await settings.update("chatToolsIntentCompilerEnabled", false, vscode.ConfigurationTarget.Global)
    await settings.update("chatToolsIntentCompilerMode", "always-original", vscode.ConfigurationTarget.Global)

    const context = {
      extensionUri: vscode.Uri.file(path.resolve(__dirname, "../../..")),
      globalState: { get: () => undefined, update: async () => undefined },
      workspaceState: { get: () => undefined, update: async () => undefined },
      subscriptions: []
    } as unknown as vscode.ExtensionContext

    const chat = new Chat(new GenerationTracker(), undefined, context, makeBridge(), undefined)
    const result = await chat.compileIntent("Fix the bug in the parser.")
    assert.strictEqual(result, undefined)
    chat.dispose()
  })

  test("compilation synchronizes a structured plan into the real chat-scoped TODO repository", async () => {
    const settings = vscode.workspace.getConfiguration("twinny")
    const previousEnabled = settings.get<boolean>("chatToolsIntentCompilerEnabled", false)
    const previousMode = settings.get<string>("chatToolsIntentCompilerMode", "ask")
    await settings.update("chatToolsIntentCompilerEnabled", true, vscode.ConfigurationTarget.Global)
    await settings.update("chatToolsIntentCompilerMode", "always-refined", vscode.ConfigurationTarget.Global)
    const provider = {
      id: "scripted-intent-provider",
      label: "Scripted compiler",
      modelName: "scripted-intent-model",
      provider: "scripted-intent-compiler",
      type: "intent" as const
    }
    const model = new ScriptedCompilerModel()
    providerRegistry.register("scripted-intent-compiler", { id: "scripted-intent-compiler", create: () => model })
    const context = {
      extensionUri: vscode.Uri.file(path.resolve(__dirname, "../../..")),
      globalState: { get: (key: string) => key === ACTIVE_INTENT_PROVIDER_STORAGE_KEY ? provider : undefined, update: async () => undefined },
      workspaceState: { get: () => undefined, update: async () => undefined },
      subscriptions: []
    } as unknown as vscode.ExtensionContext
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "twinny-intent-sync-"))
    const repository = new TodoRepository(path.join(root, "todos.sqlite"), path.join(context.extensionUri.fsPath, "out", "sql-wasm.wasm"))
    const emitted: string[] = []
    const bridge = { ...makeBridge(), emit: (event: string) => emitted.push(event) } as unknown as ExtensionBridge
    const chat = new Chat(new GenerationTracker(), undefined, context, bridge, undefined, undefined, repository)
    const scope = {
      projectFingerprint: workspaceProjectFingerprint((vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.toString(true))),
      conversationId: "intent-sync-chat"
    }
    try {
      const first = await chat.compileIntent("Fix the parser.", [], undefined, scope.conversationId)
      assert.ok(first?.plan)
      const firstList = await repository.getList(scope)
      assert.equal(firstList.items.filter((item) => item.source === "intent_compiler").length, 3)
      assert.ok(emitted.includes(TODO_EVENT_NAME.changed))
      assert.deepEqual(firstList.items.map((item) => item.title), ["Inspect parser", "Fix parser", "Verify parser"])
      assert.equal((await repository.getIntentResult(scope) as { originalPrompt?: string } | undefined)?.originalPrompt, "Fix the parser.")

      await chat.compileIntent("Fix the parser.", [], undefined, scope.conversationId)
      const repeated = await repository.getList(scope)
      assert.equal(repeated.id, firstList.id)
      assert.equal(repeated.items.length, 3)
      assert.equal(repeated.items.filter((item) => item.source === "intent_compiler").length, 3)
      assert.ok(model.requests[1].messages.some((message) => typeof message.content === "string" && message.content.includes("Existing native TODO plan")))
      assert.ok(first?.plan.tasks.every((task) => task.acceptanceCriteria.length > 0))

      model.output = "malformed compiler output"
      assert.equal(await chat.compileIntent("Keep the existing TODOs.", [], undefined, scope.conversationId), undefined)
      assert.deepEqual(await repository.getList(scope), repeated)
    } finally {
      chat.dispose()
      await fs.rm(root, { recursive: true, force: true })
      await settings.update("chatToolsIntentCompilerEnabled", previousEnabled, vscode.ConfigurationTarget.Global)
      await settings.update("chatToolsIntentCompilerMode", previousMode, vscode.ConfigurationTarget.Global)
    }
  })

  test("compilation independently resolves default, custom, and None instructions while enforcing JSON", async () => {
    const settings = vscode.workspace.getConfiguration("twinny")
    await settings.update("chatToolsIntentCompilerEnabled", true, vscode.ConfigurationTarget.Global)
    await settings.update("chatToolsIntentCompilerMode", "always-refined", vscode.ConfigurationTarget.Global)
    await settings.update("intentBaseInstructionsMode", "default", vscode.ConfigurationTarget.Global)
    await settings.update("intentBaseInstructionsFile", "", vscode.ConfigurationTarget.Global)
    await settings.update("chatBaseInstructionsMode", "default", vscode.ConfigurationTarget.Global)

    const provider = {
      id: "scripted-intent-provider",
      label: "Scripted compiler",
      modelName: "scripted-intent-model",
      provider: "scripted-intent-compiler",
      type: "intent" as const
    }
    const model = new ScriptedCompilerModel()
    providerRegistry.register("scripted-intent-compiler", { id: "scripted-intent-compiler", create: () => model })

    const context = {
      extensionUri: vscode.Uri.file(path.resolve(__dirname, "../../..")),
      globalState: {
        get: (key: string) => {
          if (key === ACTIVE_INTENT_PROVIDER_STORAGE_KEY) return provider
          return undefined
        },
        update: async () => undefined
      },
      workspaceState: { get: () => undefined, update: async () => undefined },
      subscriptions: []
    } as unknown as vscode.ExtensionContext

    const chat = new Chat(new GenerationTracker(), undefined, context, makeBridge(), undefined)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "twinny-intent-instructions-"))
    const customFile = path.join(root, "compiler.md")
    try {
      const result = await chat.compileIntent("Fix the bug in the parser.")
      assert.ok(result)
      assert.strictEqual(result?.objective.includes("Refine the request"), true)
      assert.match(result?.prompt ?? "", /smallest safe implementation change/)
      let system = String(model.requests[0].messages[0]?.content ?? "")
      assert.match(system, /Refine a user request for a coding agent without changing its intent/)
      assert.match(system, /Return exactly one valid JSON object/)
      assert.doesNotMatch(system, /You are a helpful, respectful and honest coding assistant/)

      await fs.writeFile(customFile, "Compiler-only custom instructions")
      await settings.update("intentBaseInstructionsFile", customFile, vscode.ConfigurationTarget.Global)
      await settings.update("intentBaseInstructionsMode", "custom", vscode.ConfigurationTarget.Global)
      await chat.compileIntent("Use the custom compiler profile.")
      system = String(model.requests[1].messages[0]?.content ?? "")
      assert.match(system, /Compiler-only custom instructions/)
      assert.doesNotMatch(system, /Refine a user request for a coding agent/)
      assert.match(system, /Return exactly one valid JSON object/)

      await settings.update("intentBaseInstructionsMode", "none", vscode.ConfigurationTarget.Global)
      await chat.compileIntent("Run with no optional compiler instructions.")
      system = String(model.requests[2].messages[0]?.content ?? "")
      assert.doesNotMatch(system, /Compiler-only custom instructions/)
      assert.match(system, /Return exactly one valid JSON object/)
    } finally {
      await settings.update("intentBaseInstructionsMode", "default", vscode.ConfigurationTarget.Global)
      await settings.update("intentBaseInstructionsFile", "", vscode.ConfigurationTarget.Global)
      await settings.update("chatBaseInstructionsMode", "default", vscode.ConfigurationTarget.Global)
      await fs.rm(root, { recursive: true, force: true })
      chat.dispose()
    }
  })

  test("chat effective prompt preview uses only chat instructions", async () => {
    const settings = vscode.workspace.getConfiguration("twinny")
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "twinny-chat-instructions-"))
    const chatFile = path.join(root, "chat.md")
    const intentFile = path.join(root, "intent.md")
    await fs.writeFile(chatFile, "Chat-only base instructions")
    await fs.writeFile(intentFile, "Compiler-only base instructions")
    await settings.update("chatBaseInstructionsFile", chatFile, vscode.ConfigurationTarget.Global)
    await settings.update("chatBaseInstructionsMode", "custom", vscode.ConfigurationTarget.Global)
    await settings.update("intentBaseInstructionsFile", intentFile, vscode.ConfigurationTarget.Global)
    await settings.update("intentBaseInstructionsMode", "custom", vscode.ConfigurationTarget.Global)
    const context = {
      extensionUri: vscode.Uri.file(path.resolve(__dirname, "../../..")),
      globalState: { get: () => undefined, update: async () => undefined },
      workspaceState: { get: () => undefined, update: async () => undefined },
      subscriptions: []
    } as unknown as vscode.ExtensionContext
    const chat = new Chat(new GenerationTracker(), undefined, context, makeBridge(), undefined)
    try {
      const preview = await chat.previewPromptInstructions("off")
      assert.match(preview.chatEffective, /Chat-only base instructions/)
      assert.doesNotMatch(preview.chatEffective, /Compiler-only base instructions/)
      assert.match(preview.intentEffective, /Compiler-only base instructions/)
      assert.doesNotMatch(preview.intentEffective, /Chat-only base instructions/)

      await settings.update("chatBaseInstructionsMode", "none", vscode.ConfigurationTarget.Global)
      const nonePreview = await chat.previewPromptInstructions("off")
      assert.equal(nonePreview.chat.mode, "none")
      assert.doesNotMatch(nonePreview.chatEffective, /Chat-only base instructions/)
      assert.match(nonePreview.intentEffective, /Compiler-only base instructions/)
    } finally {
      await settings.update("chatBaseInstructionsMode", "default", vscode.ConfigurationTarget.Global)
      await settings.update("chatBaseInstructionsFile", "", vscode.ConfigurationTarget.Global)
      await settings.update("intentBaseInstructionsMode", "default", vscode.ConfigurationTarget.Global)
      await settings.update("intentBaseInstructionsFile", "", vscode.ConfigurationTarget.Global)
      await fs.rm(root, { recursive: true, force: true })
      chat.dispose()
    }
  })

  test("uses the selected intent provider for compilation and keeps chat execution independent", async () => {
    const settings = vscode.workspace.getConfiguration("twinny")
    await settings.update("chatToolsIntentCompilerEnabled", true, vscode.ConfigurationTarget.Global)
    await settings.update("chatToolsIntentCompilerMode", "always-refined", vscode.ConfigurationTarget.Global)

    const intentProvider = {
      id: "intent-provider-a",
      label: "Intent Provider A",
      modelName: "intent-model-a",
      provider: "scripted-intent-compiler",
      type: "intent" as const,
      apiHostname: "intent.example.test",
      apiPort: 8080,
      apiProtocol: "https",
      apiPath: "/v1"
    }
    const chatProvider = {
      id: "chat-provider-b",
      label: "Chat Provider B",
      modelName: "chat-model-b",
      provider: "scripted-chat-executor",
      type: "chat" as const,
      apiHostname: "chat.example.test",
      apiPort: 9090,
      apiProtocol: "https",
      apiPath: "/v1"
    }
    const intentModel = new ScriptedCompilerModel()
    const chatModel = new ScriptedCompilerModel()
    providerRegistry.register("scripted-intent-compiler", { id: "scripted-intent-compiler", create: () => intentModel })
    providerRegistry.register("scripted-chat-executor", { id: "scripted-chat-executor", create: () => chatModel })

    const context = {
      extensionUri: vscode.Uri.file(path.resolve(__dirname, "../../..")),
      globalState: {
        get: (key: string) => {
          if (key === ACTIVE_INTENT_PROVIDER_STORAGE_KEY) return intentProvider
          if (key === ACTIVE_CHAT_PROVIDER_STORAGE_KEY) return chatProvider
          return undefined
        },
        update: async () => undefined
      },
      workspaceState: { get: () => undefined, update: async () => undefined },
      subscriptions: []
    } as unknown as vscode.ExtensionContext

    const chat = new Chat(new GenerationTracker(), undefined, context, makeBridge(), undefined)
    assert.strictEqual(chat.getIntentProvider()?.modelName, "intent-model-a")
    assert.strictEqual(chat.getProvider()?.modelName, "chat-model-b")

    const result = await chat.compileIntent("Fix the parser.")
    assert.ok(result)
    assert.deepStrictEqual(intentModel.requests.map((request) => request.model), ["intent-model-a"])
    assert.deepStrictEqual(chatModel.requests, [])
    chat.dispose()
  })

  test("includes prior prompt/response history in the compiler request", async () => {
    const settings = vscode.workspace.getConfiguration("twinny")
    await settings.update("chatToolsIntentCompilerEnabled", true, vscode.ConfigurationTarget.Global)
    await settings.update("chatToolsIntentCompilerMode", "always-refined", vscode.ConfigurationTarget.Global)
    await settings.update("chatToolsIntentCompilerMaxTurns", 2, vscode.ConfigurationTarget.Global)
    await settings.update("chatToolsIntentCompilerTrace", false, vscode.ConfigurationTarget.Global)

    const provider = {
      id: "scripted-intent-provider",
      label: "Scripted compiler",
      modelName: "scripted-intent-model",
      provider: "scripted-intent-compiler",
      type: "intent" as const
    }
    const model = new ScriptedCompilerModel()
    providerRegistry.register("scripted-intent-compiler", { id: "scripted-intent-compiler", create: () => model })

    const context = {
      extensionUri: vscode.Uri.file(path.resolve(__dirname, "../../..")),
      globalState: {
        get: (key: string) => {
          if (key === ACTIVE_INTENT_PROVIDER_STORAGE_KEY) return provider
          return undefined
        },
        update: async () => undefined
      },
      workspaceState: { get: () => undefined, update: async () => undefined },
      subscriptions: []
    } as unknown as vscode.ExtensionContext

    const chat = new Chat(new GenerationTracker(), undefined, context, makeBridge(), undefined)
    const history: ChatCompletionMessage[] = [
      { role: "user", content: "First task prompt" },
      { role: "assistant", content: "First task response" },
      { role: "user", content: "Second task prompt" },
      { role: "assistant", content: "Second task response" }
    ]

    await chat.compileIntent("Fix the bug in the parser.", history, 2)
    assert.ok(model.requests.length > 0)
    assert.match(String(model.requests[0].messages[1]?.content ?? ""), /Historical prior prompt\/response turns/)
    assert.match(String(model.requests[0].messages[1]?.content ?? ""), /Second task prompt/)
    chat.dispose()
  })

  test("uses the selected execution prompt when a refined prompt differs from the original user wording", () => {
    const history: ChatCompletionMessage[] = [
      {
        role: "user",
        content: "Original user wording",
        originalPrompt: "Original user wording",
        prompt: "Refined execution prompt"
      },
      { role: "assistant", content: "Final response" }
    ]

    const summary = summarizeIntentHistory(history, 1)
    assert.strictEqual(summary.pairs.length, 1)
    assert.strictEqual(summary.pairs[0].prompt, "Refined execution prompt")
    assert.strictEqual(summary.pairs[0].response, "Final response")
  })

  test("keeps earlier user restrictions in historical context instead of active task policy", async () => {
    const settings = vscode.workspace.getConfiguration("twinny")
    await settings.update("chatToolsIntentCompilerEnabled", true, vscode.ConfigurationTarget.Global)
    await settings.update("chatToolsIntentCompilerMode", "always-refined", vscode.ConfigurationTarget.Global)

    const provider = {
      id: "scripted-intent-provider",
      label: "Scripted compiler",
      modelName: "scripted-intent-model",
      provider: "scripted-intent-compiler",
      type: "intent" as const
    }
    const model = new ScriptedCompilerModel()
    providerRegistry.register("scripted-intent-compiler", { id: "scripted-intent-compiler", create: () => model })

    const context = {
      extensionUri: vscode.Uri.file(path.resolve(__dirname, "../../..")),
      globalState: {
        get: (key: string) => {
          if (key === ACTIVE_INTENT_PROVIDER_STORAGE_KEY) return provider
          return undefined
        },
        update: async () => undefined
      },
      workspaceState: { get: () => undefined, update: async () => undefined },
      subscriptions: []
    } as unknown as vscode.ExtensionContext

    const chat = new Chat(new GenerationTracker(), undefined, context, makeBridge(), undefined)
    const systemPrompt = await (chat as unknown as { _context: { systemPrompt: () => Promise<string> } })._context.systemPrompt()
    assert.match(systemPrompt, /historical context only/i)
    assert.match(systemPrompt, /current user request/i)

    await chat.compileIntent("Fix the confirmed inconsistencies in the file.", [
      { role: "user", content: "Audit the file. Do not modify files." },
      { role: "assistant", content: "I audited the file and found inconsistencies." },
      { role: "user", content: "Fix the confirmed inconsistencies in the file." },
      { role: "assistant", content: "I found the issues and can fix them." }
    ], 2)

    assert.ok(model.requests.length > 0)
    assert.match(String(model.requests[0].messages[0]?.content ?? ""), /historical context only/i)
    chat.dispose()
  })

  test("summarizes only completed history pairs for intent compiler diagnostics", () => {
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
    assert.strictEqual(summary.pairs[1].promptLength, "Second task prompt".length)
    assert.strictEqual(summary.pairs[1].responseLength, "Second task response".length)
  })

  test("trace mode is off by default and writes a raw request body for intent compiler requests", async () => {
    const settings = vscode.workspace.getConfiguration("twinny")
    const traceOff = settings.get<boolean>("chatToolsIntentCompilerTrace", false)
    assert.strictEqual(traceOff, false)

    await settings.update("chatToolsIntentCompilerEnabled", true, vscode.ConfigurationTarget.Global)
    await settings.update("chatToolsIntentCompilerMode", "always-refined", vscode.ConfigurationTarget.Global)
    await settings.update("chatToolsIntentCompilerTrace", true, vscode.ConfigurationTarget.Global)

    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "twinny-intent-trace-"))
    const provider = {
      id: "scripted-intent-provider",
      label: "Scripted compiler",
      modelName: "scripted-intent-model",
      provider: "scripted-intent-compiler",
      type: "intent" as const
    }
    const model = new ScriptedCompilerModel()
    providerRegistry.register("scripted-intent-compiler", { id: "scripted-intent-compiler", create: () => model })

    const context = {
      extensionUri: vscode.Uri.file(path.resolve(__dirname, "../../..")),
      globalState: {
        get: (key: string) => {
          if (key === ACTIVE_INTENT_PROVIDER_STORAGE_KEY) return provider
          return undefined
        },
        update: async () => undefined
      },
      workspaceState: { get: () => undefined, update: async () => undefined },
      globalStorageUri: { fsPath: temp },
      storageUri: { fsPath: temp },
      subscriptions: []
    } as unknown as vscode.ExtensionContext

    const chat = new Chat(new GenerationTracker(), undefined, context, makeBridge(), undefined)
    const history: ChatCompletionMessage[] = [
      { role: "user", content: "First task prompt" },
      { role: "assistant", content: "First task response" }
    ]

    const result = await chat.compileIntent("Fix the parser.", history, 1)
    assert.ok(result)
    const traceDir = path.join(temp, "intent-compiler-traces")
    const files = await fs.readdir(traceDir)
    assert.strictEqual(files.length, 1)

    const traceText = await fs.readFile(path.join(traceDir, files[0]), "utf8")
    const trace = JSON.parse(traceText)
    assert.ok(trace.requestId)
    assert.ok(/"model":\s*"scripted-intent-model"/.test(trace.requestBody))
    assert.ok(trace.requestBody.includes("Fix the parser."))
    assert.ok(trace.response.includes("Refine the request for execution."))
    assert.strictEqual(trace.historySummary.selectedPairs[0].prompt, "First task prompt")
    assert.match(trace.requestBody, /"role":\s*"user"/)
    assert.doesNotMatch(JSON.stringify(trace), /api[_-]?key|token|secret|password/i)
    assert.doesNotMatch(JSON.stringify(trace), /Bearer\s+[A-Za-z0-9._~+/=-]+/)

    chat.dispose()
    await settings.update("chatToolsIntentCompilerTrace", false, vscode.ConfigurationTarget.Global)
  })

  test("writes separate traces for separate intent-compiler requests", async () => {
    const settings = vscode.workspace.getConfiguration("twinny")
    await settings.update("chatToolsIntentCompilerEnabled", true, vscode.ConfigurationTarget.Global)
    await settings.update("chatToolsIntentCompilerMode", "always-refined", vscode.ConfigurationTarget.Global)
    await settings.update("chatToolsIntentCompilerTrace", true, vscode.ConfigurationTarget.Global)

    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "twinny-intent-trace-multi-"))
    const provider = {
      id: "scripted-intent-provider",
      label: "Scripted compiler",
      modelName: "scripted-intent-model",
      provider: "scripted-intent-compiler",
      type: "intent" as const
    }
    const model = new ScriptedCompilerModel()
    providerRegistry.register("scripted-intent-compiler", { id: "scripted-intent-compiler", create: () => model })

    const context = {
      extensionUri: vscode.Uri.file(path.resolve(__dirname, "../../..")),
      globalState: {
        get: (key: string) => {
          if (key === ACTIVE_INTENT_PROVIDER_STORAGE_KEY) return provider
          return undefined
        },
        update: async () => undefined
      },
      workspaceState: { get: () => undefined, update: async () => undefined },
      globalStorageUri: { fsPath: temp },
      storageUri: { fsPath: temp },
      subscriptions: []
    } as unknown as vscode.ExtensionContext

    const chat = new Chat(new GenerationTracker(), undefined, context, makeBridge(), undefined)
    await chat.compileIntent("Fix the parser.", [], 0)
    await chat.compileIntent("Fix the parser again.", [], 0)

    const traceDir = path.join(temp, "intent-compiler-traces")
    const files = await fs.readdir(traceDir)
    assert.strictEqual(files.length, 2)
    const traces = await Promise.all(files.map(async (file) => JSON.parse(await fs.readFile(path.join(traceDir, file), "utf8"))))
    assert.notStrictEqual(traces[0].requestId, traces[1].requestId)
    assert.notStrictEqual(traces[0].requestBody, traces[1].requestBody)

    chat.dispose()
    await settings.update("chatToolsIntentCompilerTrace", false, vscode.ConfigurationTarget.Global)
  })
})
