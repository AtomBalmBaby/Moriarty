import assert from "node:assert/strict"
import { test } from "node:test"

import type { TwinnyProvider } from "../../common/types"
import { ChatGeneration } from "../../extension/chat/generation"
import { OperationLifecycle } from "../../extension/chat/operation-lifecycle"
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

test("stopping before a request is dispatched starts no model request", async () => {
  const generation = new ChatGeneration(bridge, new GenerationTracker())
  const { calls, inference } = streamingClient()
  generation.abort("user")
  assert.equal(await generation.generate(inference, chatRequest, provider), "")
  assert.equal(calls.started, 0)
  generation.dispose()
})
