import * as assert from "assert"
import * as vscode from "vscode"

import { ACTIVE_CHAT_PROVIDER_STORAGE_KEY } from "../../common/constants"
import { Chat, parseIntentCompilerResponse } from "../../extension/chat/index"
import { GenerationTracker } from "../../extension/generations"
import { ChatRequest, InferenceProvider, providerRegistry } from "../../extension/inference"
import { ExtensionBridge } from "../../extension/messaging/bridge"

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

  test("skips compile when the setting is disabled or set to always original", async () => {
    const settings = vscode.workspace.getConfiguration("twinny")
    await settings.update("chatToolsIntentCompilerEnabled", false, vscode.ConfigurationTarget.Global)
    await settings.update("chatToolsIntentCompilerMode", "always-original", vscode.ConfigurationTarget.Global)

    const context = {
      globalState: { get: () => undefined, update: async () => undefined },
      workspaceState: { get: () => undefined, update: async () => undefined },
      subscriptions: []
    } as unknown as vscode.ExtensionContext

    const chat = new Chat(new GenerationTracker(), undefined, context, {} as unknown as ExtensionBridge, undefined)
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
      type: "chat"
    }
    const model = new ScriptedCompilerModel()
    providerRegistry.register("scripted-intent-compiler", { id: "scripted-intent-compiler", create: () => model })

    const context = {
      globalState: {
        get: (key: string) => {
          if (key === ACTIVE_CHAT_PROVIDER_STORAGE_KEY) return provider
          return undefined
        },
        update: async () => undefined
      },
      workspaceState: { get: () => undefined, update: async () => undefined },
      subscriptions: []
    } as unknown as vscode.ExtensionContext

    const chat = new Chat(new GenerationTracker(), undefined, context, {} as unknown as ExtensionBridge, undefined)
    const result = await chat.compileIntent("Fix the bug in the parser.")
    assert.ok(result)
    assert.strictEqual(result?.objective.includes("Refine the request"), true)
    assert.match(result?.prompt ?? "", /smallest safe implementation change/)
    assert.ok(model.requests.length > 0)
    chat.dispose()
  })
})
