import * as assert from "node:assert"
import { test } from "node:test"

import { logger } from "../../common/logger"
import { ChatChunk, ChatRequest, InferenceProvider } from "../../extension/inference"
import { guard } from "../../extension/inference/registry"
import { withTools } from "../../extension/tools/loop"
import { ToolResult, WorkspaceTools } from "../../extension/tools/workspace"

const captureInferenceLogs = async <T>(run: () => Promise<T>) => {
  const records: string[] = []
  const info = logger.info
  const warn = logger.warn
  logger.info = (message) => records.push(message)
  logger.warn = (message) => records.push(message)
  try {
    return { result: await run(), records }
  } finally {
    logger.info = info
    logger.warn = warn
  }
}

const events = (records: string[]) =>
  records
    .filter((record) => record.startsWith("[Inference] {"))
    .map((record) => JSON.parse(record.slice("[Inference] ".length)) as Record<string, unknown>)

const collect = async (source: AsyncIterable<ChatChunk>) => {
  const result: ChatChunk[] = []
  for await (const chunk of source) result.push(chunk)
  return result
}

const ask = (content = "private prompt") =>
  ({ model: "trace-model", messages: [{ role: "user", content }] }) satisfies ChatRequest

test("guard records a successful logical request without logging private prompt text", async () => {
  const provider: InferenceProvider = {
    id: "trace-provider",
    capabilities: () => ["chat"],
    chat: () =>
      (async function* () {
        yield { content: "answer" }
      })()
  }
  const client = guard(provider)
  const { records } = await captureInferenceLogs(() =>
    collect(client.chat(ask(), {
      trace: {
        operationId: "operation-success",
        requestId: "request-success",
        endpoint: "http://localhost:8081/v1"
      }
    }))
  )
  const lifecycle = events(records)
  assert.deepStrictEqual(lifecycle.map((event) => event.event), ["request.started", "request.terminal"])
  assert.ok(lifecycle.every((event) => event.operation_id === "operation-success"))
  assert.ok(lifecycle.every((event) => event.request_id === "request-success"))
  assert.equal(lifecycle[0].endpoint, "http://localhost:8081/v1")
  assert.equal(records.join("\n").includes("private prompt"), false)
})

test("tool loop requests share one operation and preserve parent, step, and maximum", async () => {
  let turn = 0
  const provider: InferenceProvider = {
    id: "trace-agent",
    capabilities: () => ["chat"],
    chat: () =>
      (async function* () {
        turn++
        if (turn === 1) {
          yield {
            content: "",
            toolCalls: [{ id: "call-1", name: "lookup", arguments: "{}" }],
            finishReason: "stop"
          }
        } else {
          yield { content: "done", finishReason: "stop" }
        }
      })()
  }
  const toolResult: ToolResult = { output: "found", summary: "found" }
  const workspace: WorkspaceTools = {
    tools: [{
      name: "lookup",
      description: "Look up a test value.",
      parameters: [],
      run: async () => toolResult
    }],
    orientation: "",
    run: async () => toolResult
  }
  const client = withTools(guard(provider), workspace, { mode: "native", maxSteps: 3 })
  const { records } = await captureInferenceLogs(() =>
    collect(client.chat(ask(), {
      trace: { operationId: "operation-agent", requestId: "request-chat-root" }
    }))
  )
  const starts = events(records).filter((event) => event.event === "request.started")
  assert.equal(starts.length, 2)
  assert.deepStrictEqual(starts.map((event) => event.tool_loop_step), [1, 2])
  assert.ok(starts.every((event) => event.operation_id === "operation-agent"))
  assert.ok(starts.every((event) => event.parent_request_id === "request-chat-root"))
  assert.ok(starts.every((event) => event.max_tool_loop_steps === 3))
  assert.notEqual(starts[0].request_id, starts[1].request_id)
})

test("a host cancellation before dispatch records the reason and sends no provider request", async () => {
  let providerCalls = 0
  const provider: InferenceProvider = {
    id: "trace-cancel",
    capabilities: () => ["chat"],
    chat: () => {
      providerCalls++
      return (async function* () {
        yield { content: "unexpected" }
      })()
    }
  }
  const client = guard(provider)
  const controller = new AbortController()
  controller.abort(new DOMException("Twinny host cancellation", "AbortError"))
  const { records } = await captureInferenceLogs(async () => {
    await assert.rejects(
      collect(client.chat(ask(), {
        signal: controller.signal,
        trace: { operationId: "operation-host-stop", requestId: "request-not-sent" }
      })),
      /cancel/i
    )
  })
  assert.equal(providerCalls, 0)
  const lifecycle = events(records)
  assert.ok(lifecycle.some((event) =>
    event.event === "operation.cancelled" &&
    event.operation_id === "operation-host-stop" &&
    event.initiator === "host"
  ))
  assert.ok(lifecycle.some((event) =>
    event.event === "request.cancelled_before_dispatch" &&
    event.request_id === "request-not-sent"
  ))
})
