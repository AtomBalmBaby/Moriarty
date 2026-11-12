import assert from "assert"
import Module from "module"
import test from "node:test"

import type { Conversation } from "../../common/types"
import type { ConversationHistory as ConversationHistoryType } from "../../extension/chat/conversation-history"

const vscodeStub = {
  workspace: {
    getConfiguration: () => ({ get: () => undefined }),
    onDidChangeConfiguration: () => ({ dispose() {} })
  },
  window: { createOutputChannel: () => ({ appendLine() {}, append() {}, show() {}, dispose() {} }) },
  EventEmitter: class {
    event = () => ({ dispose() {} })
    fire() {}
    dispose() {}
  }
}

type ModuleLoader = { _load: (request: string, ...rest: unknown[]) => unknown }
const loader = Module as unknown as ModuleLoader
const originalLoad = loader._load
loader._load = function (request: string, ...rest: unknown[]) {
  return request === "vscode" ? vscodeStub : originalLoad.call(this, request, ...rest)
}
// Required after the vscode stub is installed, so it cannot be a hoisted import.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ConversationHistory } = require("../../extension/chat/conversation-history") as {
  ConversationHistory: typeof ConversationHistoryType
}

loader._load = originalLoad

const message = (role: "user" | "assistant", content: string) => ({ role, content }) as never

const conversation = (id: string, title: string, messages = [message("user", `${title} question`), message("assistant", "answer")]): Conversation =>
  ({ id, title, messages }) as Conversation

const harness = (stored: Record<string, Conversation>, activeId: string, titleReply = "Locate run_command") => {
  const state = new Map<string, unknown>([
    ["twinny.conversations", stored],
    ["twinny.active-conversation", stored[activeId]]
  ])
  const emitted: Array<{ name: string; payload: unknown }> = []
  const prompts: string[] = []
  const context = {
    globalState: {
      get: (key: string) => state.get(key),
      update: async (key: string, value: unknown) => {
        state.set(key, value)
      }
    }
  }
  const bridge = {
    handleAll() {
      return this
    },
    emit: (name: string, payload: unknown) => emitted.push({ name, payload })
  }
  const chat = {
    replying: false,
    discardReply() {},
    generateSimpleCompletion: async (prompt: string) => {
      prompts.push(prompt)
      return titleReply
    }
  }
  const history = new ConversationHistory(context as never, bridge as never, chat as never)
  const saved = () => state.get("twinny.conversations") as Record<string, Conversation>
  const active = () => state.get("twinny.active-conversation") as Conversation
  return { history, saved, active, emitted, prompts }
}

test("a late save for a non-active conversation writes its own record and leaves the active one alone", async () => {
  const b = conversation("conv-b", "Conversation B")
  const { history, saved, active } = harness({ "conv-a": conversation("conv-a", "Draft A"), "conv-b": b }, "conv-b")
  await history.saveConversation(conversation("conv-a", "Draft A", [message("user", "where is run_command defined?"), message("assistant", "in workspace.ts")]))
  assert.equal(saved()["conv-a"].title, "Locate run_command")
  assert.equal(saved()["conv-a"].messages.length, 2)
  assert.equal(saved()["conv-b"].messages.length, b.messages.length, "conversation B keeps its own messages")
  assert.equal(saved()["conv-b"].title, "Conversation B")
  assert.equal(active().id, "conv-b", "a save for another conversation does not change the active one")
  assert.equal(active().messages[0].content, "Conversation B question")
})

test("the title model receives the saved conversation's first exchange and its title lands on that conversation", async () => {
  const { history, saved, prompts } = harness({ "conv-a": conversation("conv-a", "Draft A") }, "conv-a")
  await history.saveConversation(conversation("conv-a", "Draft A", [message("user", "where is run_command defined?"), message("assistant", "in workspace.ts")]))
  assert.equal(prompts.length, 1)
  assert.match(prompts[0], /Message 1: "where is run_command defined\?"/)
  assert.match(prompts[0], /Message 2: "in workspace.ts"/)
  assert.equal(saved()["conv-a"].title, "Locate run_command")
})

test("a pinned title is kept and the model is not asked again", async () => {
  const pinned = { ...conversation("conv-a", "Pinned by user"), pinnedTitle: true }
  const { history, saved, prompts } = harness({ "conv-a": pinned }, "conv-a")
  await history.saveConversation(conversation("conv-a", "x", [message("user", "q"), message("assistant", "a")]))
  assert.equal(prompts.length, 0)
  assert.equal(saved()["conv-a"].title, "Pinned by user")
})

test("saving the active conversation refreshes the active record and emits it", async () => {
  const { history, saved, active, emitted } = harness({ "conv-a": conversation("conv-a", "Draft A") }, "conv-a")
  await history.saveConversation(conversation("conv-a", "Draft A", [message("user", "q"), message("assistant", "a")]))
  assert.equal(active().title, "Locate run_command")
  assert.equal(active().messages.length, 2)
  assert.equal(saved()["conv-a"].messages.length, 2)
  assert.ok(emitted.some((event) => (event.payload as Conversation)?.id === "conv-a"))
})
