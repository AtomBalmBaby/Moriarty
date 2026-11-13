import assert from "node:assert/strict"
import { test } from "node:test"

import { EVENT_NAME } from "../../common/constants"
import type { TwinnyProvider } from "../../common/types"
import { FeedbackGate, FeedbackPlanner, type FeedbackPlanRepository } from "../../extension/chat/feedback-planner"
import { ChatGeneration } from "../../extension/chat/generation"
import { OperationLifecycle } from "../../extension/chat/operation-lifecycle"
import type { RoleResolution } from "../../extension/chat/role-inference"
import { GenerationTracker } from "../../extension/generations"
import type { ChatRequest, InferenceClient } from "../../extension/inference"
import type { ExtensionBridge } from "../../extension/messaging/bridge"

const recorder = () => {
  const events: string[] = []
  const lifecycle = new OperationLifecycle(
    () => events.push("opened"),
    () => events.push("terminal")
  )
  return { events, lifecycle }
}

test("a single operation announces opened then one terminal", async () => {
  const { events, lifecycle } = recorder()
  const result = await lifecycle.run(async () => "reply")
  assert.equal(result, "reply")
  assert.deepEqual(events, ["opened", "terminal"])
  assert.equal(lifecycle.active, false)
})

test("continuations inside an operation keep it open until the outermost run settles", async () => {
  const { events, lifecycle } = recorder()
  await lifecycle.run(async () => {
    await lifecycle.run(async () => {
      assert.equal(lifecycle.active, true)
    })
    // A gap between requests: the operation is still open, so Stop stays.
    assert.equal(lifecycle.active, true)
    assert.deepEqual(events, ["opened", "opened"])
  })
  assert.deepEqual(events, ["opened", "opened", "terminal"])
})

test("a failing operation still reaches its terminal state", async () => {
  const { events, lifecycle } = recorder()
  await assert.rejects(lifecycle.run(async () => {
    throw new Error("provider failed")
  }), /provider failed/)
  assert.deepEqual(events, ["opened", "terminal"])
  assert.equal(lifecycle.active, false)
})

test("a reconnected webview hears about an open operation only", async () => {
  const { events, lifecycle } = recorder()
  lifecycle.reannounce()
  assert.deepEqual(events, [])
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  const pending = lifecycle.run(() => gate)
  lifecycle.reannounce()
  assert.deepEqual(events, ["opened", "opened"])
  release()
  await pending
  assert.deepEqual(events, ["opened", "opened", "terminal"])
})

test("no operation is active between sequential operations", async () => {
  const { events, lifecycle } = recorder()
  await lifecycle.run(async () => undefined)
  await lifecycle.run(async () => undefined)
  assert.deepEqual(events, ["opened", "terminal", "opened", "terminal"])
})

const untilAborted = (signal: AbortSignal) => new Promise<void>((resolve) => {
  if (signal.aborted) resolve()
  else signal.addEventListener("abort", () => resolve(), { once: true })
})

const streamingClient = () => {
  const calls = { started: 0, signal: undefined as AbortSignal | undefined }
  const inference = {
    chat: (_request: unknown, options: { signal: AbortSignal }) => {
      calls.started += 1
      calls.signal = options.signal
      return (async function* () {
        yield { content: "partial" }
        await untilAborted(options.signal)
      })()
    }
  }
  return { calls, inference: inference as unknown as InferenceClient }
}

const chatRequest = { model: "test", messages: [] } as unknown as ChatRequest
const provider = { provider: "llamacpp", modelName: "test", label: "test", apiHostname: "" } as unknown as TwinnyProvider
const bridge = { emit: () => undefined } as unknown as ExtensionBridge

test("stopping mid-stream aborts the request, and no later request starts", async () => {
  const generation = new ChatGeneration(bridge, new GenerationTracker())
  const { calls, inference } = streamingClient()
  const reply = generation.generate(inference, chatRequest, provider)
  await new Promise((resolve) => setImmediate(resolve))
  generation.abort("user")
  await reply
  assert.equal(calls.signal?.aborted, true)
  assert.equal(generation.cancelled, true)
  assert.equal(await generation.generate(inference, chatRequest, provider), "")
  assert.equal(calls.started, 1)
  generation.dispose()
})

test("a held answer still streams its reasoning, and only its text waits for the delivery gate", async () => {
  const emitted: string[] = []
  const recording = { emit: (type: string) => emitted.push(type) } as unknown as ExtensionBridge
  const generation = new ChatGeneration(recording, new GenerationTracker())
  const inference = {
    async *chat() {
      yield { content: "", reasoning: "Weighing the source" }
      yield { content: "read_file is at lines 218 to 282", finishReason: "stop" as const }
    }
  } as unknown as InferenceClient
  await generation.generate(inference, chatRequest, provider, "", { hold: () => true })
  assert.equal(emitted.filter((type) => type === EVENT_NAME.twinnyOnReasoning).length, 1)
  assert.equal(emitted.filter((type) => type === EVENT_NAME.twinnyOnCompletion).length, 0)
  generation.dispose()
})

test("a held answer released as unverified keeps the reason, with its detail bounded", async () => {
  const shown: { content: string; meta?: { unverified?: { reason: string; detail?: string } } }[] = []
  const recording = {
    emit: (type: string, data?: unknown) => {
      if (type === EVENT_NAME.twinnyAddMessage) shown.push(data as (typeof shown)[number])
    }
  } as unknown as ExtensionBridge
  const generation = new ChatGeneration(recording, new GenerationTracker())
  const inference = {
    async *chat() {
      yield { content: "read_file is at lines 218 to 282", finishReason: "stop" as const }
    }
  } as unknown as InferenceClient
  await generation.generate(inference, chatRequest, provider, "", { hold: () => true })
  assert.equal(shown.length, 0)
  generation.releaseHeld({ reason: "delivery", detail: "x".repeat(400) })
  assert.equal(shown.length, 1)
  assert.equal(shown[0].content, "read_file is at lines 218 to 282")
  assert.equal(shown[0].meta?.unverified?.reason, "delivery")
  assert.equal(shown[0].meta?.unverified?.detail?.length, 300)
  generation.dispose()
})

test("a held answer released without a verdict carries no unverified marker", async () => {
  const shown: { meta?: { unverified?: unknown } }[] = []
  const recording = {
    emit: (type: string, data?: unknown) => {
      if (type === EVENT_NAME.twinnyAddMessage) shown.push(data as (typeof shown)[number])
    }
  } as unknown as ExtensionBridge
  const generation = new ChatGeneration(recording, new GenerationTracker())
  const inference = {
    async *chat() {
      yield { content: "read_file is at lines 218 to 282", finishReason: "stop" as const }
    }
  } as unknown as InferenceClient
  await generation.generate(inference, chatRequest, provider, "", { hold: () => true })
  generation.releaseHeld()
  assert.equal(shown.length, 1)
  assert.equal(shown[0].meta?.unverified, undefined)
  generation.dispose()
})

test("stopping before a request is dispatched starts no model request", async () => {
  const generation = new ChatGeneration(bridge, new GenerationTracker())
  const { calls, inference } = streamingClient()
  generation.abort("user")
  assert.equal(await generation.generate(inference, chatRequest, provider), "")
  assert.equal(calls.started, 0)
  generation.dispose()
})

const settle = () => new Promise((resolve) => setImmediate(resolve))

const scope = { projectFingerprint: "project", conversationId: "chat", writer: "chat" }

/** A TODO store whose planning reads never answer, as a wedged database would not. */
const stalledRepository = (overrides: Partial<FeedbackPlanRepository> = {}) => ({
  getIntentTaskPlan: () => new Promise<never>(() => undefined),
  intentPlanClosed: async () => false,
  listAcceptedEvidence: async () => [],
  synchronizeIntentPlan: async () => {
    throw new Error("the planning under test must not write")
  },
  ...overrides
}) as unknown as FeedbackPlanRepository

const readyRepository = (overrides: Partial<FeedbackPlanRepository> = {}) =>
  stalledRepository({ getIntentTaskPlan: async () => undefined, ...overrides })

const untracked = JSON.stringify({ track: false, plan: null })

/** Mirrors the chat host: a message runs Feedback planning and then the gate-held turn, inside one operation. */
const chatHarness = (repository: () => FeedbackPlanRepository | undefined, reply: () => Promise<string> = async () => untracked) => {
  const { events, lifecycle } = recorder()
  const inference = { calls: 0 }
  const planner = new FeedbackPlanner({
    enabled: () => true,
    repository,
    resolve: () => ({
      ok: true,
      endpoint: {
        infer: async () => {
          inference.calls += 1
          return reply()
        },
        provider: "scripted",
        model: "feedback-model",
        label: "Scripted"
      }
    }) as unknown as RoleResolution
  })
  const gate = new FeedbackGate({ planner, busy: () => false, notify: () => undefined })
  const dispatches = { count: 0 }
  const send = (prompt: string) => lifecycle.run(() => gate.admit("chat", planner.start(scope, prompt), async () => {
    dispatches.count += 1
    return "reply"
  }))
  return { events, lifecycle, planner, gate, inference, dispatches, send }
}

test("cancel ends an operation whose Feedback planning is stalled", async () => {
  // Regression: a stalled planning read kept the webview busy and Cancel had no effect.
  let repository: () => FeedbackPlanRepository = () => stalledRepository()
  const chat = chatHarness(() => repository())
  const pending = chat.send("Fix the parser.")
  await settle()
  assert.equal(chat.lifecycle.active, true)
  const planning = chat.planner.pending()
  // Host abort() cancels Feedback planning, then the operation.
  chat.planner.cancel("user")
  assert.equal(chat.lifecycle.cancel("user"), true)
  assert.equal(await pending, undefined)
  assert.deepEqual(chat.events, ["opened", "terminal"])
  assert.equal(chat.lifecycle.active, false)
  assert.equal((await planning)?.status, "cancelled")
  assert.equal(chat.inference.calls, 0)
  assert.equal(chat.dispatches.count, 0)

  repository = () => readyRepository()
  assert.equal(await chat.send("well?"), "reply")
  assert.deepEqual(chat.events, ["opened", "terminal", "opened", "terminal"])
  assert.equal(chat.dispatches.count, 1)
})

test("a repeated cancel reports one terminal and an idle operation reports none", async () => {
  const { events, lifecycle } = recorder()
  assert.equal(lifecycle.cancel("user"), false)
  const pending = lifecycle.run(() => new Promise<never>(() => undefined))
  assert.equal(lifecycle.cancel("user"), true)
  assert.equal(lifecycle.cancel("user"), false)
  assert.equal(await pending, undefined)
  assert.deepEqual(events, ["opened", "terminal"])
})

test("late results of a cancelled operation neither reopen it nor overwrite a newer one", async () => {
  const { events, lifecycle } = recorder()
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  let continuationRan = false
  const stale = lifecycle.run(async () => {
    await gate
    // A continuation of the cancelled turn must not join or reopen a newer operation.
    await lifecycle.run(async () => { continuationRan = true })
    return "late reply"
  })
  assert.equal(lifecycle.cancel("user"), true)
  assert.equal(await stale, undefined)
  const newer = lifecycle.run(async () => "newer reply")
  release()
  assert.equal(await newer, "newer reply")
  assert.equal(continuationRan, false)
  assert.deepEqual(events, ["opened", "terminal", "opened", "terminal"])
  assert.equal(lifecycle.active, false)
})

test("each operation has its own id, and the work inside it reports that id, even after cancel", async () => {
  const terminals: string[] = []
  const lifecycle = new OperationLifecycle(() => undefined, (operationId) => terminals.push(operationId))
  let inside: string | undefined
  await lifecycle.run(async () => {
    inside = lifecycle.contextOperationId
  })
  assert.equal(inside, terminals[0])

  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  let abandoned: string | undefined
  let abandonedCancelled = false
  const pending = lifecycle.run(async () => {
    await gate
    abandoned = lifecycle.contextOperationId
    abandonedCancelled = lifecycle.contextCancelled
  })
  const cancelled = lifecycle.operationId
  lifecycle.cancel("user")
  await pending
  release()
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.notEqual(cancelled, terminals[0])
  assert.equal(terminals[1], cancelled)
  assert.equal(abandoned, cancelled)
  assert.equal(abandonedCancelled, true)
  assert.equal(lifecycle.contextCancelled, false)
  assert.notEqual(terminals[0], terminals[1])
})

test("operation ids stay unique across sequential operations, so a persisted task never matches a new one", async () => {
  const terminals: string[] = []
  const lifecycle = new OperationLifecycle(() => undefined, (operationId) => terminals.push(operationId))
  for (let index = 0; index < 5; index += 1) {
    await lifecycle.run(async () => undefined)
  }
  assert.equal(new Set(terminals).size, 5)
})

test("a Feedback planner exception ends the operation, and the next message runs", async () => {
  let broken = true
  const chat = chatHarness(() => {
    if (broken) throw new Error("TODO storage closed")
    return readyRepository()
  })
  await assert.rejects(chat.send("Fix the parser."), /TODO storage closed/)
  assert.deepEqual(chat.events, ["opened", "terminal"])
  assert.equal(chat.lifecycle.active, false)
  broken = false
  assert.equal(await chat.send("Fix the parser."), "reply")
  assert.deepEqual(chat.events, ["opened", "terminal", "opened", "terminal"])
})

test("a rejected Feedback read fails the plan, holds the turn, and ends the operation", async () => {
  const chat = chatHarness(() => readyRepository({
    getIntentTaskPlan: async () => {
      throw new Error("database is locked")
    }
  }))
  assert.equal(await chat.send("Fix the parser."), undefined)
  assert.equal(chat.dispatches.count, 0)
  assert.deepEqual(chat.events, ["opened", "terminal"])
  assert.equal(chat.lifecycle.active, false)
})

test("an intent write exception stops the turn before the model is dispatched", async () => {
  const chat = chatHarness(() => readyRepository({
    synchronizeIntentPlan: async () => {
      throw new Error("intent write failed")
    }
  }), async () => JSON.stringify({
    track: true,
    plan: {
      planId: "plan-a",
      version: 1,
      revision: 1,
      goal: "Fix the parser",
      constraints: [],
      tasks: [{ id: "inspect", title: "Inspect parser", description: "Find the bug", criteria: [{ id: "criterion-1", description: "Bug located", verification: { kind: "semantic_review" } }], dependencies: [] }]
    }
  }))
  assert.equal(await chat.send("Fix the parser."), undefined)
  assert.equal(chat.dispatches.count, 0)
  assert.deepEqual(chat.events, ["opened", "terminal"])
})

test("a conversation switch during pending planning does not dispatch the old turn", async () => {
  let finishRead: () => void = () => undefined
  const read = new Promise<undefined>((resolve) => { finishRead = () => resolve(undefined) })
  const chat = chatHarness(() => readyRepository({ getIntentTaskPlan: () => read }))
  const pending = chat.send("Fix the parser.")
  await settle()
  chat.gate.clear()
  finishRead()
  assert.equal(await pending, undefined)
  assert.equal(chat.dispatches.count, 0)
  assert.deepEqual(chat.events, ["opened", "terminal"])
})

/** A plan whose criterion names a tool with the identity the validator rejects, as the Intent model returned it. */
const invalidIdentity = JSON.stringify({
  track: true,
  plan: {
    planId: "plan-a",
    version: 1,
    revision: 1,
    goal: "Check twinny_todo_update.",
    constraints: [],
    tasks: [{
      id: "lookup",
      title: "Check twinny_todo_update",
      description: "Consult accepted evidence.",
      dependencies: [],
      criteria: [
        { id: "criterion-1", description: "The lookup completed.", verification: { kind: "evidence_lookup_completed" } },
        { id: "criterion-2", description: "twinny_todo_update is described.", verification: { kind: "accepted_fact_exists", identity: "tool", symbol: "twinny_todo_update" } }
      ]
    }]
  }
})

test("a repeated rejected plan ends its operation without dispatch, and the next message plans and runs", async () => {
  let answer = invalidIdentity
  const chat = chatHarness(() => readyRepository(), async () => answer)
  assert.equal(await chat.send("Check twinny_todo_update."), undefined)
  assert.deepEqual(chat.events, ["opened", "terminal"])
  assert.equal(chat.lifecycle.active, false)
  assert.equal(chat.inference.calls, 2, "the identical correction is a repetition, so planning stops")
  assert.equal(chat.dispatches.count, 0)

  answer = untracked
  assert.equal(await chat.send("well?"), "reply")
  assert.deepEqual(chat.events, ["opened", "terminal", "opened", "terminal"])
  assert.equal(chat.dispatches.count, 1)
})

test("cancel during a correction of a rejected plan ends the operation once, and a late correction revives nothing", async () => {
  let calls = 0
  let late: ((reply: string) => void) | undefined
  const chat = chatHarness(() => readyRepository(), () => {
    calls += 1
    if (calls === 1) return Promise.resolve(invalidIdentity)
    return new Promise<string>((resolve) => { late = resolve })
  })
  const pending = chat.send("Check twinny_todo_update.")
  await settle()
  assert.equal(chat.lifecycle.active, true)
  assert.equal(calls, 2, "the correction is in flight")

  chat.planner.cancel("user")
  assert.equal(chat.lifecycle.cancel("user"), true)
  assert.equal(await pending, undefined)
  assert.deepEqual(chat.events, ["opened", "terminal"])

  late?.(untracked)
  await settle()
  assert.equal(chat.dispatches.count, 0, "a late correction cannot start the cancelled turn")
  assert.deepEqual(chat.events, ["opened", "terminal"])
  assert.equal(chat.lifecycle.active, false)
})
