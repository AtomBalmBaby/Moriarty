/**
 * Knowing how full a model's context is: asking the server for its token
 * counts and its context size, and the chat's steps saying how a reply
 * ended. A local fake stands in for Ollama and llama.cpp.
 */
import type { TokenJS } from "fluency.js"
import * as assert from "node:assert"
import * as http from "node:http"
import { AddressInfo } from "node:net"
import { test } from "node:test"

import { logger } from "../../common/logger"
import { ChatCompletionMessage, TwinnyProvider } from "../../common/types"
import { ToolSteps } from "../../extension/chat/tool-steps"
import {
  buildBlockingRequest,
  buildStreamingRequest,
  fluencyChat,
  parsableToolArguments
} from "../../extension/inference/adapters/fluency"
import {
  contextCapacityOf,
  forgetContextWindows,
  knownContextCapacity,
  parseContextSetting,
  resolveFallback,
  setContextClock
} from "../../extension/inference/context-window"
import { ChatChunk } from "../../extension/inference/types"
import { ContextUsageStore } from "../../extension/tools/budget"

const provider = (kind: string, extra: Partial<TwinnyProvider> = {}): TwinnyProvider =>
  ({ id: kind, label: kind, provider: kind, type: "chat", modelName: "m", ...extra }) as TwinnyProvider

test("the output cap goes to Chat Completions-style servers as max_tokens, and is omitted when unset", () => {
  for (const kind of ["ollama", "llamacpp", "openai-compatible", "lmstudio"]) {
    const parameters = { maxTokens: 6144 }
    const streamed = buildStreamingRequest(provider(kind), conversation, parameters) as unknown as {
      max_tokens?: number
    }
    const blocking = buildBlockingRequest(provider(kind), conversation, parameters) as unknown as {
      max_tokens?: number
    }
    assert.strictEqual(streamed.max_tokens, 6144, kind)
    assert.strictEqual(blocking.max_tokens, 6144, kind)
    const uncapped = buildStreamingRequest(provider(kind), conversation) as unknown as { max_tokens?: number }
    assert.ok(!("max_tokens" in uncapped), kind)
  }
})

const tool = { name: "grep", description: "search", parameters: { type: "object" } }
const conversation = [
  { role: "system", content: "Be brief." },
  { role: "user", content: "Hi" }
] as ChatCompletionMessage[]

test("OpenAI-style servers are asked to count a streamed request; others are not sent the option", () => {
  for (const kind of ["ollama", "lmstudio", "llamacpp", "litellm", "openai-compatible", "openai"]) {
    assert.deepStrictEqual(
      (buildStreamingRequest(provider(kind), conversation) as { stream_options?: unknown }).stream_options,
      { include_usage: true },
      kind
    )
  }
  for (const kind of ["anthropic", "gemini", "mistral", "qvac"]) {
    assert.ok(!("stream_options" in buildStreamingRequest(provider(kind), conversation)), kind)
  }
})

test("llama.cpp receives a reduced JSON Schema", () => {
  const schema = {
    type: "object",
    properties: {
      title: { type: "string", maxLength: 500, description: "Task title" },
      status: { type: "string", enum: ["pending", "in_progress"] },
      expected_version: { type: "integer", minimum: 1 },
      due: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
      result: { type: "string", enum: ["observed", "passed", "failed"] },
      labels: { type: "array", items: { type: "string", maxLength: 40 } }
    },
    required: ["title", "expected_version"],
    additionalProperties: false
  }
  const toolWithSchema = { name: "twinny_todo_update", description: "Update a task", parameters: schema }
  const llamaRequest = buildStreamingRequest(provider("llamacpp"), conversation, { tools: [toolWithSchema] }) as unknown as {
    tools: Array<{ function: { parameters: Record<string, unknown> } }>
  }
  assert.deepStrictEqual(llamaRequest.tools[0].function.parameters, {
    type: "object",
    properties: {
      title: { type: "string", description: "Task title" },
      status: { type: "string", description: "Allowed values: pending, in_progress." },
      expected_version: { type: "integer" },
      due: {},
      result: { type: "string", description: "Allowed values: observed, passed, failed." },
      labels: { type: "array", items: { type: "string" } }
    },
    required: ["title", "expected_version"]
  })
  const otherRequest = buildStreamingRequest(provider("openai-compatible"), conversation, { tools: [toolWithSchema] }) as unknown as {
    tools: Array<{ function: { parameters: Record<string, unknown> } }>
  }
  assert.deepStrictEqual(otherRequest.tools[0].function.parameters, schema, "other providers retain their exact schemas")
})

test("Anthropic is told to cache the system prompt, tools and steps so far of a tool conversation, and only of one", () => {
  const marked = (request: { messages: unknown[] }) =>
    (request.messages as Array<{ role: string; cache_control?: unknown }>).filter((m) => m.cache_control)
  const withTools = buildStreamingRequest(provider("anthropic"), conversation, { tools: [tool] })
  assert.deepStrictEqual(marked(withTools), [{ role: "system", content: "Be brief.", cache_control: { type: "ephemeral" } }])
  const history = [
    ...conversation,
    { role: "assistant", content: null, tool_calls: [{ id: "a", type: "function", function: { name: "grep", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "a", content: "No matches." }
  ] as unknown as ChatCompletionMessage[]
  const twoResults = [
    ...history,
    { role: "assistant", content: null, tool_calls: [{ id: "b", type: "function", function: { name: "grep", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "b", content: "1: x" },
    { role: "user", content: "Answer now." }
  ] as unknown as ChatCompletionMessage[]
  assert.deepStrictEqual(
    marked(buildStreamingRequest(provider("anthropic"), twoResults)).map((m) => (m as { tool_call_id?: string }).tool_call_id ?? m.role),
    ["system", "b"],
    "the system prompt and the newest tool result: the conversation so far is read back, not paid for again"
  )
  assert.strictEqual(marked(buildStreamingRequest(provider("anthropic"), conversation)).length, 0, "a plain chat is not worth a cache write")
  assert.strictEqual(marked(buildStreamingRequest(provider("ollama"), conversation, { tools: [tool] })).length, 0)
})

test("a server that refuses stream_options is asked again without, and not asked for counts again", async () => {
  const bodies: Array<Record<string, unknown>> = []
  const client = {
    chat: {
      completions: {
        create: async (body: Record<string, unknown>) => {
          bodies.push(body)
          if ("stream_options" in body) throw new Error("400 Extra inputs are not permitted: body.stream_options")
          return (async function* () {
            yield { choices: [{ delta: { content: "Hello" }, finish_reason: "stop" }] }
          })()
        }
      }
    }
  } as unknown as TokenJS
  const strict = provider("openai-compatible", { apiHostname: "strict.example", apiPort: 9 })
  const records: string[] = []
  const { info, warn, debug, trace } = logger
  logger.info = (message) => records.push(message)
  logger.warn = (message) => records.push(message)
  logger.debug = (message) => records.push(message)
  logger.trace = (message) => records.push(message)
  const read = async () => {
    const chunks: ChatChunk[] = []
    for await (const chunk of fluencyChat(client, strict, { model: "m", messages: conversation })) chunks.push(chunk)
    return chunks.map((chunk) => chunk.content).join("")
  }
  try {
    assert.strictEqual(await read(), "Hello")
    assert.strictEqual(await read(), "Hello")
  } finally {
    logger.info = info
    logger.warn = warn
    logger.debug = debug
    logger.trace = trace
  }
  const events = records
    .filter((record) => record.startsWith("[Inference]"))
    .map((record) => JSON.parse(record.slice("[Inference] ".length)) as Record<string, unknown>)
  const dispatched = events.filter((event) => event.event === "provider_attempt.dispatched")
  const terminal = events.filter((event) => event.event === "provider_attempt.terminal")
  assert.strictEqual(dispatched.length, 3)
  assert.strictEqual(terminal.length, 3)
  assert.notStrictEqual(dispatched[0].attempt_id, dispatched[1].attempt_id)
  assert.strictEqual(dispatched[0].request_id, dispatched[1].request_id)
  assert.strictEqual(dispatched[0].operation_id, dispatched[1].operation_id)
  assert.strictEqual(dispatched[0].attempt_number, 1)
  assert.strictEqual(dispatched[1].attempt_number, 2)
  assert.strictEqual(terminal[0].state, "retrying-compatibility")
  assert.strictEqual(terminal[1].state, "completed")
  assert.deepStrictEqual(
    bodies.map((body) => "stream_options" in body),
    [true, false, false],
    "refused once, then left out for that server"
  )
  assert.ok("stream_options" in buildStreamingRequest(provider("openai-compatible", { apiHostname: "other.example" }), conversation))
})

test("SDK cancellation ends its trace and ignores a late response without retrying", async () => {
  let resolveCreate!: (stream: AsyncIterable<unknown>) => void
  const client = {
    chat: {
      completions: {
        create: () => new Promise<AsyncIterable<unknown>>((resolve) => {
          resolveCreate = resolve
        })
      }
    }
  } as unknown as TokenJS
  const controller = new AbortController()
  const records: string[] = []
  const { info, warn, debug, trace } = logger
  logger.info = (message) => records.push(message)
  logger.warn = (message) => records.push(message)
  logger.debug = (message) => records.push(message)
  logger.trace = (message) => records.push(message)
  const chunks: ChatChunk[] = []
  const consume = (async () => {
    for await (const chunk of fluencyChat(
      client,
      provider("openai-compatible"),
      { model: "m", messages: conversation },
      {
        signal: controller.signal,
        trace: { operationId: "sdk-cancel-operation", requestId: "sdk-cancel-request" }
      }
    )) chunks.push(chunk)
  })()
  try {
    await new Promise<void>((resolve) => setImmediate(resolve))
    controller.abort()
    resolveCreate((async function* () {
      yield { choices: [{ delta: { content: "late" }, finish_reason: "stop" }] }
    })())
    await consume
  } finally {
    logger.info = info
    logger.warn = warn
    logger.debug = debug
    logger.trace = trace
  }
  const events = records
    .filter((record) => record.startsWith("[Inference]"))
    .map((record) => JSON.parse(record.slice("[Inference] ".length)) as Record<string, unknown>)
  const terminal = events.filter((event) => event.event === "provider_attempt.terminal")
  assert.strictEqual(chunks.length, 0)
  assert.strictEqual(terminal.length, 1)
  assert.strictEqual(terminal[0].state, "cancelled")
  assert.strictEqual(
    events.filter((event) => event.event === "provider_attempt.late_response").length,
    1
  )
  assert.strictEqual(
    events.find((event) => event.event === "provider_attempt.cancellation_requested")?.transport_abort,
    "not-exposed-by-provider-sdk"
  )
})

const fakeServer = async (routes: Record<string, (body: unknown) => unknown>) => {
  const hits: string[] = []
  const server = http.createServer((req, res) => {
    let raw = ""
    req.on("data", (chunk) => (raw += chunk))
    req.on("end", () => {
      hits.push(`${req.method} ${req.url}`)
      const route = routes[req.url ?? ""]
      const answer = route?.(raw ? JSON.parse(raw) : undefined)
      res.writeHead(answer === undefined ? 404 : 200, { "Content-Type": "application/json" })
      res.end(JSON.stringify(answer ?? {}))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  return { hits, port, close: () => server.close() }
}

const auto = { setting: "Auto", fallback: 65_536 }
const at = (port: number): Partial<TwinnyProvider> => ({
  apiHostname: "127.0.0.1",
  apiPort: port,
  apiProtocol: "http",
  apiPath: "/v1"
})

let now = 0

/** Each discovery test starts with no answers and a clock it controls. */
const discovery = async (run: () => Promise<void>) => {
  forgetContextWindows()
  now = 0
  setContextClock(() => now)
  try {
    await run()
  } finally {
    setContextClock(() => Date.now())
    forgetContextWindows()
  }
}

test("the chat setting is Auto, a whole number of tokens, or invalid; the fallback is a positive whole number", () => {
  assert.deepStrictEqual(parseContextSetting("Auto"), { mode: "auto" })
  assert.deepStrictEqual(parseContextSetting(undefined), { mode: "auto" })
  assert.deepStrictEqual(parseContextSetting(4096), { mode: "override", tokens: 4_096 })
  assert.deepStrictEqual(parseContextSetting(" 65536 "), { mode: "override", tokens: 65_536 })
  for (const bad of ["8k", "0", "-1", 1.5, 0]) {
    assert.strictEqual(parseContextSetting(bad).mode, "invalid", String(bad))
  }
  assert.strictEqual(resolveFallback(undefined), 65_536)
  assert.strictEqual(resolveFallback(0), 65_536)
  assert.strictEqual(resolveFallback(65_536), 65_536)
})

test("Ollama: a loaded model's runtime context is confirmed, an unloaded model's Modelfile num_ctx is configured, and nothing is guessed", () =>
  discovery(async () => {
    let loaded = false
    const server = await fakeServer({
      "/api/ps": () => ({
        models: loaded
          ? [
              { name: "qwen3-coder:30b", model: "qwen3-coder:30b", context_length: 32768 },
              { name: "llama3:latest", model: "llama3:latest", context_length: 4096 }
            ]
          : []
      }),
      "/api/show": (body) => {
        const model = (body as { model: string }).model
        if (model === "tuned") return { parameters: "temperature 0.7\nnum_ctx                        16384" }
        if (model === "qwen3-coder:30b") {
          return { parameters: "temperature 0.7", model_info: { "qwen3moe.context_length": 262144 } }
        }
        return { parameters: "temperature 0.7" }
      }
    })
    try {
      const qwen = provider("ollama", { ...at(server.port), modelName: "qwen3-coder:30b" })
      const unloaded = await contextCapacityOf(qwen, auto)
      assert.deepStrictEqual([unloaded.tokens, unloaded.source, unloaded.confirmed], [65_536, "fallback", false])
      assert.strictEqual(unloaded.advertised, 262_144, "the model's maximum is advertised, not confirmed")
      assert.match(unloaded.warning ?? "", /planning for 65536 tokens/)
      assert.strictEqual(knownContextCapacity(qwen, auto)?.source, "fallback")

      const tuned = await contextCapacityOf(provider("ollama", { ...at(server.port), modelName: "tuned" }), auto)
      assert.deepStrictEqual([tuned.tokens, tuned.source, tuned.confirmed], [16_384, "configured", true])
      assert.match(tuned.warning ?? "", /below the 65536-token minimum/)

      loaded = true
      now = 3_000
      const runtime = await contextCapacityOf(qwen, auto)
      assert.deepStrictEqual([runtime.tokens, runtime.source, runtime.confirmed], [32_768, "runtime", true])
      assert.strictEqual(runtime.advertised, 262_144)

      const llama3 = await contextCapacityOf(provider("ollama", { ...at(server.port), modelName: "llama3" }), auto)
      assert.deepStrictEqual([llama3.tokens, llama3.source], [4_096, "runtime"], "`llama3` and `llama3:latest` are one model")

      const idle = await contextCapacityOf(provider("ollama", { ...at(server.port), modelName: "not-loaded" }), auto)
      assert.strictEqual(idle.source, "fallback")

      const before = server.hits.length
      now = 32_999
      await contextCapacityOf(qwen, auto)
      assert.strictEqual(server.hits.length, before, "a confirmed answer is kept for 30 seconds")
      assert.ok(
        server.hits.every((hit) => / \/api\/(ps|show)$/.test(hit)),
        "only the model listing and its metadata are asked, never a generation request"
      )
    } finally {
      server.close()
    }
  }))

test("llama.cpp: the per-slot context is confirmed with its slot count, whatever the model is called", () =>
  discovery(async () => {
    const server = await fakeServer({
      "/props": () => ({ default_generation_settings: { n_ctx: 8192 }, total_slots: 4 })
    })
    try {
      const capacity = await contextCapacityOf(provider("llamacpp", { ...at(server.port), modelName: "/mnt/models/not-the-served-name.gguf" }), auto)
      assert.deepStrictEqual(
        [capacity.tokens, capacity.source, capacity.confirmed, capacity.slots],
        [8_192, "runtime", true, 4]
      )
      assert.deepStrictEqual(server.hits, ["GET /props"], "a single-model server is asked once, without the model name")
    } finally {
      server.close()
    }
  }))

test("llama.cpp: a router-mode server that gives no size for plain /props is asked for the named model, without loading it", () =>
  discovery(async () => {
    const server = await fakeServer({
      "/props?model=m&autoload=false": () => ({ default_generation_settings: { n_ctx: 8192 }, total_slots: 4 })
    })
    try {
      const capacity = await contextCapacityOf(provider("llamacpp", at(server.port)), auto)
      assert.deepStrictEqual([capacity.tokens, capacity.source, capacity.confirmed], [8_192, "runtime", true])
      assert.deepStrictEqual(server.hits, ["GET /props", "GET /props?model=m&autoload=false"])
    } finally {
      server.close()
    }
  }))

test("llama.cpp: when neither probe confirms a size the fallback applies, and no probe loads a model", () =>
  discovery(async () => {
    const server = await fakeServer({
      "/props?model=m&autoload=false": () => undefined
    })
    try {
      const capacity = await contextCapacityOf(provider("llamacpp", at(server.port)), auto)
      assert.deepStrictEqual([capacity.tokens, capacity.source, capacity.confirmed], [65_536, "fallback", false])
      assert.ok(server.hits.every((hit) => !hit.includes("autoload=true")), "nothing asks for a model to be loaded")
    } finally {
      server.close()
    }
  }))

test("a failed probe is logged with its URL and status, and a server that gives no size is reported; the key is never logged", () =>
  discovery(async () => {
    const server = await fakeServer({
      "/props": () => ({ total_slots: 1 })
    })
    const records: string[] = []
    const { warn } = logger
    logger.warn = (message) => records.push(message)
    try {
      const capacity = await contextCapacityOf(
        provider("llamacpp", { ...at(server.port), modelName: "m", apiKey: "secret-key" }),
        auto
      )
      assert.strictEqual(capacity.source, "fallback")
      assert.ok(
        records.some((record) => record.includes("/props?model=m&autoload=false answered HTTP 404")),
        "the named-model probe that fails is logged with its status"
      )
      assert.ok(
        records.some((record) => record.includes("gave no context size for m")),
        "an answer that confirms no size is logged"
      )
      assert.ok(records.every((record) => !record.includes("secret-key")), "the API key is never logged")
    } finally {
      logger.warn = warn
      server.close()
    }
  }))

test("LM Studio: the loaded context is confirmed; the model's maximum is advertised only", () =>

  discovery(async () => {
    const server = await fakeServer({
      "/api/v0/models": () => ({
        data: [
          { id: "loaded", loaded_context_length: 16384, max_context_length: 131072 },
          { id: "idle", max_context_length: 131072 }
        ]
      })
    })
    try {
      const loaded = await contextCapacityOf(provider("lmstudio", { ...at(server.port), modelName: "loaded" }), auto)
      assert.deepStrictEqual(
        [loaded.tokens, loaded.source, loaded.confirmed, loaded.advertised],
        [16_384, "runtime", true, 131_072]
      )
      const idle = await contextCapacityOf(provider("lmstudio", { ...at(server.port), modelName: "idle" }), auto)
      assert.deepStrictEqual(
        [idle.tokens, idle.source, idle.confirmed, idle.advertised],
        [65_536, "fallback", false, 131_072]
      )
    } finally {
      server.close()
    }
  }))

test("an OpenAI-compatible server: the smallest confirmed size wins; advertised maxima and malformed values confirm nothing", () =>
  discovery(async () => {
    const server = await fakeServer({
      "/v1/models": () => ({
        data: [
          { id: "both", loaded_context_length: 131072, max_model_len: 65536 },
          { id: "maximum", context_length: 262144 },
          { id: "plain" },
          { id: "malformed", loaded_context_length: "8192", max_model_len: -1, context_window: 1.5, max_context_length: 1e12 }
        ]
      })
    })
    try {
      const both = await contextCapacityOf(provider("openai-compatible", { ...at(server.port), modelName: "both" }), auto)
      assert.deepStrictEqual([both.tokens, both.source, both.confirmed], [65_536, "configured", true])
      assert.strictEqual(both.considered.length, 2)
      assert.strictEqual(both.warning, undefined)

      const maximum = await contextCapacityOf(provider("openai-compatible", { ...at(server.port), modelName: "maximum" }), auto)
      assert.deepStrictEqual([maximum.tokens, maximum.source, maximum.confirmed, maximum.advertised], [65_536, "fallback", false, 262_144])

      const plain = await contextCapacityOf(provider("openai-compatible", { ...at(server.port), modelName: "plain" }), auto)
      assert.deepStrictEqual([plain.source, plain.advertised], ["fallback", undefined])

      const malformed = await contextCapacityOf(provider("openai-compatible", { ...at(server.port), modelName: "malformed" }), auto)
      assert.deepStrictEqual([malformed.source, malformed.advertised], ["fallback", undefined])
    } finally {
      server.close()
    }
  }))

test("a user's figure wins over the server; a figure that disagrees with the server or sits below 64K is reported", () =>
  discovery(async () => {
    const server = await fakeServer({
      "/props": () => ({ default_generation_settings: { n_ctx: 65536 } })
    })
    try {
      const llama = provider("llamacpp", at(server.port))
      const above = await contextCapacityOf(llama, { setting: 131_072, fallback: 65_536 })
      assert.deepStrictEqual([above.tokens, above.source], [131_072, "override"])
      assert.match(above.warning ?? "", /the server confirmed 65536/)

      const small = await contextCapacityOf(llama, { setting: 4_096, fallback: 65_536 })
      assert.strictEqual(small.tokens, 4_096)
      assert.match(small.warning ?? "", /below the 65536-token minimum/)

      const same = await contextCapacityOf(llama, { setting: "65536", fallback: 65_536 })
      assert.deepStrictEqual([same.tokens, same.source, same.warning], [65_536, "override", undefined])
    } finally {
      server.close()
    }
  }))

test("a hosted API is not asked and is never assumed to hold 64K; an invalid setting is reported and planned as Auto", () =>
  discovery(async () => {
    for (const kind of ["anthropic", "openai"]) {
      const capacity = await contextCapacityOf(provider(kind), auto)
      assert.deepStrictEqual([capacity.tokens, capacity.source, capacity.confirmed], [65_536, "fallback", false], kind)
    }
    const invalid = await contextCapacityOf(provider("anthropic"), { setting: "8k", fallback: 8_192 })
    assert.deepStrictEqual([invalid.tokens, invalid.source], [8_192, "fallback"])
    assert.match(invalid.warning ?? "", /"8k" is not a token count/)
    assert.match(invalid.warning ?? "", /planning for 8192 tokens/)
  }))

test("answers are kept while fresh, asked again once stale, kept per model, and forgotten on a configuration change", () =>
  discovery(async () => {
    let loaded = false
    const server = await fakeServer({
      "/api/ps": () => ({
        models: loaded ? [{ name: "qwen3-coder:30b", model: "qwen3-coder:30b", context_length: 32768 }] : []
      }),
      "/api/show": () => ({ parameters: "temperature 0.7" })
    })
    try {
      const qwen = provider("ollama", { ...at(server.port), modelName: "qwen3-coder:30b" })
      const tuned = provider("ollama", { ...at(server.port), modelName: "tuned" })

      await contextCapacityOf(qwen, auto)
      const first = server.hits.length
      now = 2_999
      await contextCapacityOf(qwen, auto)
      assert.strictEqual(server.hits.length, first, "an unconfirmed answer is kept for 3 seconds")

      now = 3_000
      loaded = true
      const reloaded = await contextCapacityOf(qwen, auto)
      assert.strictEqual(reloaded.source, "runtime", "a stale unconfirmed answer is asked again")
      assert.strictEqual(server.hits.length, first + 2)

      now = 33_000
      await contextCapacityOf(qwen, auto)
      assert.strictEqual(server.hits.length, first + 4, "a confirmed answer is asked again after 30 seconds")

      const other = await contextCapacityOf(tuned, auto)
      assert.strictEqual(server.hits.length, first + 6, "another model is asked for its own answer")
      assert.strictEqual(other.source, "fallback", "tuned has no num_ctx and is not loaded here")

      forgetContextWindows()
      assert.strictEqual(knownContextCapacity(qwen, auto), undefined)
      await contextCapacityOf(qwen, auto)
      assert.strictEqual(server.hits.length, first + 8, "a configuration change forgets every answer")
    } finally {
      server.close()
    }
  }))


test("a step cut off by a stop says so, and what is kept of a step is held to a size", () => {
  const sent: string[][] = []
  const steps = new ToolSteps((all) => sent.push(all.map((s) => `${s.id}:${s.status}`)))
  steps.start({ id: "0.0", name: "read_file", args: { path: "a.ts" } })
  steps.finish({ id: "0.0", index: 0, mode: "native", summary: "read `a.ts`", output: "x".repeat(9000), promptChars: 0 })
  assert.strictEqual(steps.steps[0].output, "x".repeat(9000), "a result well under the limit is kept whole")
  const large = new ToolSteps(() => {})
  large.start({ id: "0.0", name: "read_file", args: { path: "c.ts" } })
  large.finish({ id: "0.0", index: 0, mode: "native", summary: "read `c.ts`", output: "z".repeat(120_000), promptChars: 0 })
  assert.ok((large.steps[0].output ?? "").length < 100_100)
  assert.match(large.steps[0].output ?? "", /… \(20000 more characters\)$/)
  steps.start({ id: "1.0", name: "create_file", args: { path: "b.ts", content: "y".repeat(50_000) } })
  assert.ok((steps.steps[1].args?.content ?? "").length < 2100, "a created file's whole content is not saved with the conversation")

  steps.start({ id: "1.1", name: "run_command", args: { command: "npm test" } })
  const answer = steps.approve("npm test")
  steps.settle()
  assert.deepStrictEqual(sent.at(-1), ["0.0:done", "1.0:stopped", "1.1:stopped"])
  assert.strictEqual(steps.steps[2].command, undefined, "nothing is left asking for an answer")
  return answer.then((run) => assert.strictEqual(run, false))
})

test("a tool call with no arguments goes back as {} so the SDKs can parse it", () => {
  // Anthropic streams nothing for a tool without parameters; fluency's
  // conversion then ran JSON.parse("") and the next step failed.
  const call = (args: string) =>
    ({ role: "assistant", content: null, tool_calls: [{ id: "t", type: "function", function: { name: "editor_context", arguments: args } }] }) as unknown as ChatCompletionMessage
  const argsOf = (message: ChatCompletionMessage) =>
    (message as unknown as { tool_calls: Array<{ function: { arguments: string } }> }).tool_calls[0].function.arguments
  const [empty, spaces, json, text] = parsableToolArguments([call(""), call("  "), call("{\"path\":\"a\"}"), call("src/a.ts")])
  assert.strictEqual(argsOf(empty), "{}")
  assert.strictEqual(argsOf(spaces), "{}")
  assert.strictEqual(argsOf(json), "{\"path\":\"a\"}")
  assert.deepStrictEqual(JSON.parse(argsOf(text)), { input: "src/a.ts" })
  const sent = buildStreamingRequest(provider("anthropic"), [...conversation, call("")], { tools: [tool] })
  assert.strictEqual(argsOf(sent.messages[2] as ChatCompletionMessage), "{}")
})

test("live usage is the estimate until the server counts, the count replaces it, and another conversation reads none", () => {
  const store = new ContextUsageStore()
  assert.strictEqual(store.read("chat-a"), undefined)
  store.record("chat-a", { tokens: 12_000, counted: false })
  assert.deepStrictEqual(store.read("chat-a"), { tokens: 12_000, counted: false })
  store.record("chat-a", { tokens: 12_400, counted: true })
  assert.deepStrictEqual(store.read("chat-a"), { tokens: 12_400, counted: true })
  assert.strictEqual(store.read("chat-b"), undefined)
  store.record("chat-b", { tokens: 3_000, counted: false })
  assert.strictEqual(store.read("chat-a"), undefined)
  assert.deepStrictEqual(store.read("chat-b"), { tokens: 3_000, counted: false })
})

test("live usage without a conversation id is kept under the empty key, not mistaken for a named conversation", () => {
  const store = new ContextUsageStore()
  store.record(undefined, { tokens: 900, counted: false })
  assert.deepStrictEqual(store.read(""), { tokens: 900, counted: false })
  assert.deepStrictEqual(store.read(undefined), { tokens: 900, counted: false })
  assert.strictEqual(store.read("chat-a"), undefined)
})

