import * as assert from "node:assert"
import { test } from "node:test"

import { API_PROVIDERS } from "../../common/constants"
import { logger } from "../../common/logger"
import { TwinnyProvider } from "../../common/types"
import { ChatRequest } from "../../extension/inference"
import { fluencyChat } from "../../extension/inference/adapters/fluency"
import { isInferenceError, isRetryableProviderFailure } from "../../extension/inference/errors"

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

const sse = (...payloads: unknown[]) =>
  payloads.map((payload) => `data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`).join("")

const content = (text: string) => ({ choices: [{ delta: { content: text } }] })

const failureOf = async (stream: AsyncIterable<{ content: string }>) => {
  const received: string[] = []
  try {
    for await (const chunk of stream) received.push(chunk.content)
  } catch (error) {
    return { received, error }
  }
  return { received, error: undefined }
}

test("a llama.cpp parser failure streamed in-band is a typed failure, not a silent empty reply", async () => {
  let requests = 0
  const parserError = { error: { code: 500, message: "Failed to parse input at pos 12: <tool_call>", type: "server_error" } }
  await withFetch(async () => {
    requests += 1
    return new Response(sse(parserError), { status: 200 })
  }, async () => {
    const { received, error } = await failureOf(fluencyChat({} as never, provider, request))
    assert.deepStrictEqual(received, [])
    assert.ok(isInferenceError(error), "the failure is an InferenceError")
    assert.equal(error.kind, "provider-unavailable")
    assert.equal(error.status, 500)
    assert.equal(error.reason, "parser-failure")
    assert.match(error.message, /Failed to parse input at pos 12/)
    assert.equal(isRetryableProviderFailure(error), true)
  })
  assert.equal(requests, 1, "the adapter itself does not retry a parser failure")
})

test("an HTTP 500 parser error keeps the server's words, and the warning reaches the log", async () => {
  const body = JSON.stringify({ error: { code: 500, message: "Failed to parse input at pos 3", type: "server_error" } })
  const { result, records } = await captureInferenceLogs(() => withFetch(async () => new Response(body, { status: 500 }), async () =>
    failureOf(fluencyChat({} as never, provider, request))
  ))
  assert.ok(isInferenceError(result.error))
  assert.equal(result.error.reason, "parser-failure")
  assert.equal(result.error.status, 500)
  assert.ok(records.some((record) => record.includes("Failed to parse input at pos 3")), "the parser message is logged")
})

test("an HTTP 400 is a bad request: typed, and never retried", async () => {
  let requests = 0
  await withFetch(async () => {
    requests += 1
    return new Response("messages must not be empty", { status: 400 })
  }, async () => {
    const { error } = await failureOf(fluencyChat({} as never, provider, request))
    assert.ok(isInferenceError(error))
    assert.equal(error.reason, "bad-request")
    assert.equal(error.status, 400)
    assert.equal(isRetryableProviderFailure(error), false)
  })
  assert.equal(requests, 1)
})

test("a stream that never carries JSON is a malformed response, not an empty reply", async () => {
  await withFetch(async () => new Response("<html>proxy error</html>", { status: 200 }), async () => {
    const { received, error } = await failureOf(fluencyChat({} as never, provider, request))
    assert.deepStrictEqual(received, [])
    assert.ok(isInferenceError(error))
    assert.equal(error.kind, "inference-failure")
    assert.equal(error.reason, "malformed-response")
    assert.match(error.message, /proxy error/)
    assert.equal(isRetryableProviderFailure(error), true)
  })
})

test("a stray non-JSON line between good chunks is skipped and the reply still completes", async () => {
  const { records } = await captureInferenceLogs(() => withFetch(async () => new Response(
    sse(content("a")) + "keep-alive noise\n" + sse(content("b"), { choices: [{ delta: {}, finish_reason: "stop" }] }),
    { status: 200 }
  ), async () => assert.deepStrictEqual(await collect(fluencyChat({} as never, provider, request)), ["a", "b", ""])));
  assert.ok(records.some((record) => record.includes("were not JSON and were skipped")))
})

test("a reply cut off by the connection after some text is interrupted, and that text is kept", async () => {
  const encoder = new TextEncoder()
  let sent = false
  const cut = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true
        controller.enqueue(encoder.encode(sse(content("partial"))))
        return
      }
      controller.error(new TypeError("terminated"))
    }
  })
  await withFetch(async () => new Response(cut, { status: 200 }), async () => {
    const { received, error } = await failureOf(fluencyChat({} as never, provider, request))
    assert.deepStrictEqual(received, ["partial"])
    assert.ok(isInferenceError(error))
    assert.equal(error.reason, "interrupted")
    assert.equal(error.kind, "provider-unavailable")
    assert.equal(isRetryableProviderFailure(error), true)
  })
})

test("a final line cut off mid-JSON after real content is interrupted, not silently dropped", async () => {
  await withFetch(async () => new Response(sse(content("half")) + "data: {\"choices\":[{\"delta\":{\"content\":\"tr", { status: 200 }), async () => {
    const { received, error } = await failureOf(fluencyChat({} as never, provider, request))
    assert.deepStrictEqual(received, ["half"])
    assert.ok(isInferenceError(error))
  })
})
