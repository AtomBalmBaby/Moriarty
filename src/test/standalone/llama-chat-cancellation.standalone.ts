import * as assert from "node:assert"
import { test } from "node:test"

import { API_PROVIDERS } from "../../common/constants"
import { logger } from "../../common/logger"
import { TwinnyProvider } from "../../common/types"
import { ChatRequest } from "../../extension/inference"
import { fluencyChat } from "../../extension/inference/adapters/fluency"

const provider: TwinnyProvider = {
  id: "llama-test",
  label: "llama.cpp test",
  modelName: "test-model",
  provider: API_PROVIDERS.LlamaCpp,
  type: "chat",
  apiHostname: "mycroft",
  apiPort: 8081,
  apiProtocol: "http",
  apiPath: "/v1",
  apiKey: "must-not-be-logged"
}

const request: ChatRequest = {
  model: provider.modelName,
  messages: [{ role: "user", content: "test prompt" }]
}

const collect = async (stream: AsyncIterable<{ content: string }>) => {
  const content: string[] = []
  for await (const chunk of stream) content.push(chunk.content)
  return content
}

const withFetch = async <T>(fetcher: typeof fetch, run: () => Promise<T>) => {
  const original = globalThis.fetch
  globalThis.fetch = fetcher
  try {
    return await run()
  } finally {
    globalThis.fetch = original
  }
}

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

test("llama.cpp streaming completes through the abortable HTTP path", async () => {
  let url = ""
  let authorization = ""
  const { records } = await captureInferenceLogs(() =>
    withFetch(async (input, init) => {
      url = String(input)
      authorization = new Headers(init?.headers).get("authorization") ?? ""
      return new Response([
        `data: ${JSON.stringify({ choices: [{ delta: { content: "hello" }, finish_reason: null }] })}`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 1 } })}`,
        "data: [DONE]"
      ].join("\n\n"), {
        status: 200,
        headers: { "x-request-id": "server-request-9", "x-llama-task-id": "llama-task-9" }
      })
    }, async () => {
      const chunks = await collect(fluencyChat({} as never, provider, request, {
        trace: {
          operationId: "operation-http-success",
          requestId: "request-http-success",
          toolLoopStep: 2,
          maxToolLoopSteps: 5
        }
      }))
      assert.deepStrictEqual(chunks, ["hello", ""])
    })
  )
  const lifecycle = events(records)
  const dispatched = lifecycle.find((event) => event.event === "http_attempt.dispatched")
  const response = lifecycle.find((event) => event.event === "http_attempt.response_headers")
  const terminal = lifecycle.filter((event) => event.event === "http_attempt.terminal")
  assert.equal(dispatched?.operation_id, "operation-http-success")
  assert.equal(dispatched?.request_id, "request-http-success")
  assert.equal(dispatched?.tool_loop_step, 2)
  assert.equal(dispatched?.max_tool_loop_steps, 5)
  assert.equal(typeof dispatched?.attempt_id, "string")
  assert.equal(response?.server_request_id, "server-request-9")
  assert.equal(response?.server_task_id, "llama-task-9")
  assert.equal(response?.server_task_id_source, "explicit-llama-task-response-header")
  assert.equal(terminal.length, 1)
  assert.equal(terminal[0].state, "completed")
  assert.ok(lifecycle.some((event) => event.event === "http_attempt.first_byte"))
  assert.ok(lifecycle.some((event) => event.event === "http_attempt.stream_cleanup"))
  assert.equal(records.join("\n").includes("test prompt"), false)
  assert.equal(records.join("\n").includes("must-not-be-logged"), false)
  assert.equal(url, "http://mycroft:8081/v1/chat/completions")
  assert.match(authorization, /^Bearer /)
})

test("HTTP retries receive distinct attempt IDs under the same request ID", async () => {
  let requests = 0
  const retryProvider = { ...provider, apiPath: "/v1/retry-trace" }
  const { records } = await captureInferenceLogs(() =>
    withFetch(async () => {
      requests += 1
      if (requests === 1) return new Response("unknown field stream_options", { status: 400 })
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}`, { status: 200 })
    }, async () => {
      await collect(fluencyChat({} as never, retryProvider, request, {
        trace: { operationId: "operation-retry", requestId: "request-retry" }
      }))
    })
  )
  assert.equal(requests, 2)
  const lifecycle = events(records)
  const attempts = lifecycle.filter((event) => event.event === "http_attempt.dispatched")
  assert.equal(attempts.length, 2)
  assert.ok(attempts.every((event) => event.operation_id === "operation-retry"))
  assert.ok(attempts.every((event) => event.request_id === "request-retry"))
  assert.notEqual(attempts[0].attempt_id, attempts[1].attempt_id)
  assert.equal(lifecycle.filter((event) => event.event === "http_attempt.retry_decision").length, 1)
  assert.equal(lifecycle.filter((event) => event.event === "http_attempt.terminal").length, 2)
})

test("cancelled llama.cpp attempts log signal propagation and one terminal state", async () => {
  const controller = new AbortController()
  let fetchSignal: AbortSignal | undefined
  const { records } = await captureInferenceLogs(() =>
    withFetch(async (_input, init) => {
      fetchSignal = init?.signal ?? undefined
      return new Promise<Response>((_resolve, reject) => {
        fetchSignal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })
      })
    }, async () => {
      const iterator = fluencyChat({} as never, provider, request, {
        signal: controller.signal,
        trace: { operationId: "operation-user-cancel", requestId: "request-user-cancel" }
      })[Symbol.asyncIterator]()
      const pending = iterator.next()
      await new Promise((resolve) => setImmediate(resolve))
      controller.abort(new DOMException("Twinny user stop", "AbortError"))
      await assert.rejects(pending, /abort|cancel/i)
      assert.equal(fetchSignal?.aborted, true)
    })
  )
  const lifecycle = events(records)
  assert.ok(lifecycle.some((event) => event.event === "http_attempt.abort_propagated"))
  const terminal = lifecycle.filter((event) => event.event === "http_attempt.terminal")
  assert.equal(terminal.length, 1)
  assert.equal(terminal[0].state, "cancelled")
})

test("caller cancellation aborts an in-flight llama.cpp fetch and prevents retries", async () => {
  const controller = new AbortController()
  let fetchSignal: AbortSignal | undefined
  let requests = 0
  await withFetch(async (_input, init) => {
    void _input
    requests += 1
    fetchSignal = init?.signal ?? undefined
    return new Promise<Response>((_resolve, reject) => {
      fetchSignal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })
    })
  }, async () => {
    const iterator = fluencyChat({} as never, provider, request, { signal: controller.signal })[Symbol.asyncIterator]()
    const pending = iterator.next()
    await new Promise((resolve) => setImmediate(resolve))
    controller.abort()
    await assert.rejects(pending, /abort|cancel/i)
    assert.equal(fetchSignal?.aborted, true)
    assert.equal(requests, 1)
  })
})

test("a late response from an abort-ignoring fetch cannot revive a cancelled request", async () => {
  const controller = new AbortController()
  let fetchStarted!: () => void
  let resolveResponse!: (response: Response) => void
  const started = new Promise<void>((resolve) => (fetchStarted = resolve))
  const response = new Promise<Response>((resolve) => (resolveResponse = resolve))

  await withFetch(async () => {
    fetchStarted()
    return response
  }, async () => {
    const iterator = fluencyChat({} as never, provider, request, { signal: controller.signal })[Symbol.asyncIterator]()
    const pending = iterator.next()
    await started
    controller.abort()
    resolveResponse(
      new Response("{\"choices\":[{\"delta\":{\"content\":\"late\"}}]}\n", {
        headers: { "Content-Type": "application/x-ndjson" }
      })
    )
    await assert.rejects(pending, /cancel|abort/i)
  })
})

test("llama.cpp retries stream_options rejection once, but not a cancelled request", async () => {
  let requests = 0
  await withFetch(async () => {
    requests += 1
    if (requests === 1) return new Response("unknown field stream_options", { status: 400 })
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}`, { status: 200 })
  }, async () => {
    assert.deepStrictEqual(await collect(fluencyChat({} as never, provider, request)), ["ok"])
  })
  assert.equal(requests, 2)

  const controller = new AbortController()
  requests = 0
  await withFetch(async () => {
    requests += 1
    controller.abort()
    return new Response("stream_options request aborted", { status: 400 })
  }, async () => {
    await assert.rejects(collect(fluencyChat({} as never, provider, request, { signal: controller.signal })), /cancel|abort/i)
  })
  assert.equal(requests, 1, "an aborted attempt is never retried")
})

test("llama.cpp request timeout fails once without dispatching a retry", async () => {
  let requests = 0
  await withFetch(async () => {
    requests += 1
    throw new DOMException("request timed out", "TimeoutError")
  }, async () => {
    await assert.rejects(collect(fluencyChat({} as never, provider, request)), /timed out/i)
  })
  assert.equal(requests, 1)
})
