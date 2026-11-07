import * as assert from "node:assert"
import { test } from "node:test"

import { logger } from "../../common/logger"
import { ChatChunk, ChatRequest, InferenceProvider } from "../../extension/inference"
import { guard } from "../../extension/inference/registry"
import {
  createInferenceTrace,
  defaultInferenceEventLevel,
  finishInferenceOperation,
  inferenceEvent,
  startInferenceAttempt,
  startInferenceRequest
} from "../../extension/inference/trace"
import { withTools } from "../../extension/tools/loop"
import { ToolResult, WorkspaceTools } from "../../extension/tools/workspace"

const captureInferenceLogs = async <T>(run: () => Promise<T>) => {
  const records: string[] = []
  const { info, warn, debug, trace } = logger
  logger.info = (message) => records.push(message)
  logger.warn = (message) => records.push(message)
  logger.debug = (message) => records.push(message)
  logger.trace = (message) => records.push(message)
  try {
    return { result: await run(), records }
  } finally {
    logger.info = info
    logger.warn = warn
    logger.debug = debug
    logger.trace = trace
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

type LogLevel = "trace" | "debug" | "info" | "warn" | "error"
interface LevelRecord {
  level: LogLevel
  event: string
  fields: Record<string, unknown>
  raw: string
}

const LOG_RANK: Record<LogLevel, number> = { trace: 0, debug: 1, info: 2, warn: 3, error: 4 }

const captureAllLevels = <T>(run: () => T): { result: T; records: LevelRecord[] } => {
  const records: LevelRecord[] = []
  const original = { trace: logger.trace, debug: logger.debug, info: logger.info, warn: logger.warn, error: logger.error }
  const levels: LogLevel[] = ["trace", "debug", "info", "warn", "error"]
  for (const level of levels) {
    logger[level] = (message: string) => {
      if (!message.startsWith("[Inference] ")) return
      const raw = message
      const fields = JSON.parse(message.slice("[Inference] ".length)) as Record<string, unknown>
      records.push({ level, event: String(fields.event), fields, raw })
    }
  }
  try {
    return { result: run(), records }
  } finally {
    Object.assign(logger, original)
  }
}

/** What a channel set to `threshold` shows: records at or above that level. */
const visibleAt = (threshold: LogLevel, records: LevelRecord[]) =>
  records.filter((record) => LOG_RANK[record.level] >= LOG_RANK[threshold])

const runCompletedRequest = () => {
  const trace = createInferenceTrace({ operationKind: "chat" })
  const finishRequest = startInferenceRequest(trace, { provider: "test", model: "m" })
  const attempt = startInferenceAttempt(trace, { provider: "test", endpoint: "http://localhost:8080/v1?token=secret", model: "m" })
  attempt.response(new Response("{}", { status: 200, headers: { "x-llama-task-id": "7" } }))
  attempt.firstResponse("content")
  attempt.finish("completed")
  finishRequest("completed")
  finishInferenceOperation(trace, "completed", { requests: 1 })
}

test("transport events default to trace, lifecycle to debug, and operation summaries to info", () => {
  for (const event of [
    "http_attempt.dispatched",
    "http_attempt.response_headers",
    "http_attempt.first_byte",
    "http_attempt.first_stream_event",
    "http_attempt.first_response",
    "http_attempt.stream_cleanup",
    "http_attempt.server_task_id"
  ]) {
    assert.equal(defaultInferenceEventLevel(event), "trace", event)
  }
  for (const event of ["request.started", "request.terminal", "http_attempt.terminal", "http_attempt.retry_decision", "provider_attempt.retry_decision", "tool_loop.retry_decision"]) {
    assert.equal(defaultInferenceEventLevel(event), "debug", event)
  }
  assert.equal(defaultInferenceEventLevel("operation.terminal"), "info")
})

test("INFO mode shows operation summaries and no request lifecycle or transport events", () => {
  const { records } = captureAllLevels(runCompletedRequest)
  const shown = visibleAt("info", records).map((record) => record.event)
  assert.deepEqual(shown, ["operation.terminal"])
  for (const event of ["http_attempt.dispatched", "http_attempt.response_headers", "http_attempt.first_response", "http_attempt.terminal", "request.started", "request.terminal"]) {
    assert.ok(records.some((record) => record.event === event), `${event} is still emitted for diagnostics`)
  }
})

test("INFO summaries omit the duplicated timestamp; DEBUG and TRACE keep it", () => {
  const { records } = captureAllLevels(runCompletedRequest)
  const summary = records.find((record) => record.event === "operation.terminal")
  assert.equal(summary?.level, "info")
  assert.equal("timestamp" in (summary?.fields ?? {}), false)
  const lifecycle = records.find((record) => record.event === "request.started")
  assert.equal(lifecycle?.level, "debug")
  assert.equal(typeof lifecycle?.fields.timestamp, "string")
  const transport = records.find((record) => record.event === "http_attempt.response_headers")
  assert.equal(transport?.level, "trace")
  assert.equal(typeof transport?.fields.timestamp, "string")
})

test("DEBUG mode shows request starts, terminal states, and outcomes, but not transport internals", () => {
  const { records } = captureAllLevels(runCompletedRequest)
  const shown = new Set(visibleAt("debug", records).map((record) => record.event))
  for (const event of ["request.started", "request.terminal", "http_attempt.terminal", "operation.terminal"]) {
    assert.ok(shown.has(event), event)
  }
  assert.equal(shown.has("http_attempt.response_headers"), false)
  assert.equal(shown.has("http_attempt.first_response"), false)
})

test("TRACE mode keeps response headers, first-response timing, and correlation identifiers", () => {
  const { records } = captureAllLevels(runCompletedRequest)
  const traced = visibleAt("trace", records)
  const headers = traced.find((record) => record.event === "http_attempt.response_headers")
  assert.equal(headers?.fields.status, 200)
  assert.equal((headers?.fields.response_headers as Record<string, string>)["x-llama-task-id"], "7")
  assert.equal(typeof headers?.fields.operation_id, "string")
  assert.equal(typeof headers?.fields.attempt_id, "string")
  const first = traced.find((record) => record.event === "http_attempt.first_response")
  assert.equal(typeof first?.fields.time_to_first_response_ms, "number")
})

test("endpoint credentials are never written at any level", () => {
  const { records } = captureAllLevels(runCompletedRequest)
  assert.equal(records.some((record) => record.raw.includes("token=secret")), false)
})

test("failed attempts and requests stay visible at WARN and ERROR when TRACE is off", () => {
  const { records } = captureAllLevels(() => {
    const trace = createInferenceTrace({ operationKind: "chat" })
    const finishRequest = startInferenceRequest(trace, { provider: "test", model: "m" })
    const attempt = startInferenceAttempt(trace, { provider: "test", endpoint: "http://localhost:8080", model: "m" })
    attempt.finish("failed", new Error("connect ECONNREFUSED"))
    finishRequest("failed", new Error("connect ECONNREFUSED"))
  })
  const attemptFailure = records.find((record) => record.event === "http_attempt.terminal")
  assert.equal(attemptFailure?.level, "warn")
  const requestFailure = records.find((record) => record.event === "request.terminal")
  assert.equal(requestFailure?.level, "error")
  assert.equal(visibleAt("info", records).some((record) => record.event === "request.terminal"), true)
})

test("an explicit level overrides the event default", () => {
  const { records } = captureAllLevels(() => inferenceEvent("feedback.failed", { reason: "x" }, "warn"))
  assert.equal(records[0]?.level, "warn")
})
