import * as assert from "assert"
import { promises as fs } from "fs"
import os from "os"
import path from "path"
import * as vscode from "vscode"

import {
  ACTIVE_CHAT_PROVIDER_STORAGE_KEY,
  ACTIVE_INTENT_PROVIDER_STORAGE_KEY
} from "../../common/constants"
import { ChatCompletionMessage } from "../../common/types"
import {
  buildIntentExecutionPrompt,
  Chat,
  parseIntentCompilerResponse,
  summarizeIntentHistory
} from "../../extension/chat/index"
import { GenerationTracker } from "../../extension/generations"
import { ChatRequest, InferenceProvider, providerRegistry } from "../../extension/inference"
import { ExtensionBridge } from "../../extension/messaging/bridge"

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

  async *chat(request: ChatRequest) {
    this.requests.push(structuredClone(request))
    const payload = {
      objective: "Refine the request for execution.",
      prompt: "Review the file and make the smallest safe implementation change, then validate with a focused test.",
      constraints: ["Preserve existing behavior"],
      exclusions: ["Do not add unrelated features"],
      strategy: "Read the focused files, patch, then run the relevant test.",
      verification: ["Run the relevant test or validation command"],
      assumptions: ["The user intends a minimal, safe change."]
    }
    yield { content: JSON.stringify(payload) }
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
      "assumptions": ["The user intends a minimal, safe change."]
    }`)

    assert.ok(parsed)
    assert.strictEqual(parsed?.objective, "Refine the request for execution.")
    assert.strictEqual(parsed?.prompt.includes("smallest safe implementation change"), true)
    assert.deepStrictEqual(parsed?.constraints, ["Preserve existing behavior"])
  })

  test("rejects malformed compiler output", () => {
    assert.strictEqual(parseIntentCompilerResponse("not valid json"), undefined)
  })

  test("keeps multi-file Home Assistant YAML retrieval authoritative over a single-file script rewrite", () => {
    const original =
      "Retrieve all the YAML files that relate to or are used in the LCARS Operations dashboard and add them to this project."
    const refined =
      "Create a script (or function) that connects to Home Assistant and downloads a specified file."
    const executionPrompt = buildIntentExecutionPrompt(original, refined)

    assert.ok(executionPrompt.includes(original))
    assert.ok(executionPrompt.includes(refined))
    assert.match(executionPrompt, /must not replace, narrow, or omit the original objective, scope, constraints, or requested deliverables/i)
    assert.match(executionPrompt, /follow the original request/i)
  })

  test("preserves a legitimate script-writing request when adding compiler guidance", () => {
    const original =
      "Create a script that connects to Home Assistant and downloads the specified YAML file into this project."
    const refined = "Write a small Python script that downloads the requested YAML file."
    const executionPrompt = buildIntentExecutionPrompt(original, refined)

    assert.ok(executionPrompt.includes(original))
    assert.ok(executionPrompt.includes(refined))
    assert.match(executionPrompt, /Original user request:/)
    assert.match(executionPrompt, /Supplementary Intent refinement:/)
  })

  test("preserves the LCARS typography audit scope, read-only constraint, and report deliverable", () => {
    const original =
      "Audit the typography on the LCARS Operations dashboard and report all findings without modifying any files."
    const refined = "Implement consistent typography across the dashboard components."
    const executionPrompt = buildIntentExecutionPrompt(original, refined)

    assert.ok(executionPrompt.includes(original))
    assert.ok(executionPrompt.includes(refined))
    assert.match(executionPrompt, /follow the original request/i)
  })

  test("skips compile when the setting is disabled or set to always original", async () => {
    const settings = vscode.workspace.getConfiguration("twinny")
    await settings.update("chatToolsIntentCompilerEnabled", false, vscode.ConfigurationTarget.Global)
    await settings.update("chatToolsIntentCompilerMode", "always-original", vscode.ConfigurationTarget.Global)

    const context = {
      globalState: { get: () => undefined, update: async () => undefined },
      workspaceState: { get: () => undefined, update: async () => undefined },
      subscriptions: []
    } as unknown as vscode.ExtensionContext

    const chat = new Chat(new GenerationTracker(), undefined, context, makeBridge(), undefined)
    const result = await chat.compileIntent("Fix the bug in the parser.")
    assert.strictEqual(result, undefined)
    chat.dispose()
  })

  test("builds a refined execution prompt from the provider response", async () => {
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
    const result = await chat.compileIntent("Fix the bug in the parser.")
    assert.ok(result)
    assert.strictEqual(result?.objective.includes("Refine the request"), true)
    assert.match(result?.prompt ?? "", /smallest safe implementation change/)
    assert.ok(model.requests.length > 0)
    chat.dispose()
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
