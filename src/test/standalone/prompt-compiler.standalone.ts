import assert from "node:assert/strict"
import { test } from "node:test"

import { logger } from "../../common/logger"
import { parsePromptCompilerResponse, PromptCompiler } from "../../extension/chat/prompt-compiler"
import type { RoleInference, RoleResolution } from "../../extension/chat/role-inference"

const captureLogs = async <T>(run: () => Promise<T>) => {
  const records: string[] = []
  const { info, warn } = logger
  logger.info = (message) => records.push(message)
  logger.warn = (message) => records.push(message)
  try {
    return { result: await run(), records }
  } finally {
    logger.info = info
    logger.warn = warn
  }
}

const inferenceEvents = (records: string[]) =>
  records
    .filter((record) => record.startsWith("[Inference] {"))
    .map((record) => JSON.parse(record.slice("[Inference] ".length)) as Record<string, unknown>)

const endpoint = (infer: RoleInference): RoleResolution => ({
  ok: true,
  endpoint: { infer, provider: "scripted", model: "compiler-model", label: "Scripted" }
})

const options = { systemPrompt: async () => "SYSTEM" }

/** Resolves when told to, honouring the abort signal like a real provider. */
const deferred = () => {
  let release!: (value: string) => void
  const calls: Array<{ user: string; signal: AbortSignal }> = []
  const infer: RoleInference = ({ user }, { signal }) => {
    calls.push({ user, signal })
    return new Promise((resolve, reject) => {
      release = resolve
      signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true })
    })
  }
  return { infer, calls, release: (value: string) => release(value) }
}

test("the compiler response must be exactly {prompt}", () => {
  assert.deepEqual(parsePromptCompilerResponse("{\"prompt\":\"  Do it well.  \"}"), { prompt: "Do it well." })
  assert.deepEqual(parsePromptCompilerResponse("<think>x</think>```json\n{\"prompt\":\"Do it\"}\n```"), { prompt: "Do it" })
  assert.ok(parsePromptCompilerResponse("{\"prompt\":\"x\",\"plan\":{}}").error)
  assert.ok(parsePromptCompilerResponse("{\"prompt\":\"  \"}").error)
  assert.ok(parsePromptCompilerResponse("not json").error)
})

test("disabled, it calls no provider", async () => {
  let resolved = 0
  const compiler = new PromptCompiler({ enabled: () => false, resolve: () => { resolved++; return { ok: false, error: "x" } } })
  assert.deepEqual(await compiler.compile({ requestId: "r", prompt: "draft" }, options), { requestId: "r", status: "disabled" })
  assert.equal(resolved, 0)
})

test("compiles exactly once and returns only the text, traced as prompt_compiler", async () => {
  const requests: Array<{ system: string; user: string }> = []
  const compiler = new PromptCompiler({
    enabled: () => true,
    resolve: () => endpoint(async (request) => {
      requests.push(request)
      return JSON.stringify({ prompt: "Compiled draft" })
    })
  })
  const { result, records } = await captureLogs(() =>
    compiler.compile({ requestId: "r1", prompt: "  private draft  ", history: "HISTORY" }, options))
  assert.deepEqual(result, { requestId: "r1", status: "compiled", prompt: "Compiled draft" })
  assert.deepEqual(requests, [{ system: "SYSTEM", user: "HISTORY\n\nCurrent draft:\nprivate draft" }])
  const events = inferenceEvents(records)
  assert.ok(events.some((event) => event.event === "operation.started" && event.kind === "prompt_compiler"))
  const terminal = events.filter((event) => event.event === "operation.terminal")
  assert.equal(terminal.length, 1, "one terminal state")
  assert.equal(terminal[0].state, "completed")
  assert.equal(terminal[0].kind, "prompt_compiler")
  assert.ok(!records.join("\n").includes("private draft"), "the draft is not logged")
  assert.deepEqual(compiler.activeRequestIds, [])
})

test("an empty draft, missing provider, bad response, or provider error fails visibly", async () => {
  const ok = new PromptCompiler({ enabled: () => true, resolve: () => endpoint(async () => "{}") })
  assert.equal((await ok.compile({ requestId: "e", prompt: "   " }, options)).status, "failed")

  const missing = new PromptCompiler({ enabled: () => true, resolve: () => ({ ok: false, error: "Prompt Compiler provider \"x\" is not configured." }) })
  assert.deepEqual(await captureLogs(() => missing.compile({ requestId: "m", prompt: "draft" }, options)).then(({ result }) => result), {
    requestId: "m", status: "failed", error: "Prompt Compiler provider \"x\" is not configured."
  })

  const invalid = await captureLogs(() => ok.compile({ requestId: "i", prompt: "draft" }, options))
  assert.equal(invalid.result.status, "failed")
  assert.match(invalid.result.status === "failed" ? invalid.result.error : "", /unusable response/)

  const failing = new PromptCompiler({
    enabled: () => true,
    resolve: () => endpoint(async () => { throw new Error("ChatGPT Plan could not use the connected ChatGPT session. Sign in again.") })
  })
  const failed = await captureLogs(() => failing.compile({ requestId: "f", prompt: "draft" }, options))
  assert.deepEqual(failed.result, {
    requestId: "f",
    status: "failed",
    error: "Prompt Compiler failed: ChatGPT Plan could not use the connected ChatGPT session. Sign in again."
  })
})

test("a timeout fails with a clear message and aborts the provider request", async () => {
  const slow = deferred()
  const compiler = new PromptCompiler({ enabled: () => true, resolve: () => endpoint(slow.infer), timeoutMs: 20 })
  const { result } = await captureLogs(() => compiler.compile({ requestId: "t", prompt: "draft" }, options))
  assert.equal(result.status, "failed")
  assert.match(result.status === "failed" ? result.error : "", /timed out/)
  assert.equal(slow.calls[0].signal.aborted, true)
})

test("user cancellation aborts the request and reports cancelled", async () => {
  const slow = deferred()
  const compiler = new PromptCompiler({ enabled: () => true, resolve: () => endpoint(slow.infer) })
  const { result, records } = await captureLogs(async () => {
    const running = compiler.compile({ requestId: "c", prompt: "draft" }, options)
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(compiler.activeRequestIds, ["c"])
    assert.equal(compiler.cancel("c", "user"), true)
    return running
  })
  assert.deepEqual(result, { requestId: "c", status: "cancelled" })
  assert.equal(slow.calls[0].signal.aborted, true)
  assert.equal(compiler.cancel("c"), false, "nothing left to cancel")
  const events = inferenceEvents(records)
  assert.ok(events.some((event) => event.event === "operation.cancelled" && event.initiator === "user"))
  assert.deepEqual(events.filter((event) => event.event === "operation.terminal").map((event) => event.state), ["cancelled"])
})

test("a newer compilation supersedes the older; duplicates are refused", async () => {
  const slow = deferred()
  const compiler = new PromptCompiler({ enabled: () => true, resolve: () => endpoint(slow.infer) })
  await captureLogs(async () => {
    const first = compiler.compile({ requestId: "a", prompt: "first" }, options)
    await new Promise((resolve) => setImmediate(resolve))
    const duplicate = await compiler.compile({ requestId: "a", prompt: "first" }, options)
    assert.equal(duplicate.status, "failed")
    const second = compiler.compile({ requestId: "b", prompt: "second" }, options)
    assert.deepEqual(await first, { requestId: "a", status: "cancelled" })
    await new Promise((resolve) => setImmediate(resolve))
    slow.release(JSON.stringify({ prompt: "Second compiled" }))
    assert.deepEqual(await second, { requestId: "b", status: "compiled", prompt: "Second compiled" })
  })
  assert.equal(slow.calls.length, 2)
})

test("a late answer after cancellation is not returned as compiled", async () => {
  let release!: (value: string) => void
  // A provider that ignores the abort signal and answers anyway.
  const compiler = new PromptCompiler({
    enabled: () => true,
    resolve: () => endpoint(() => new Promise((resolve) => { release = resolve }))
  })
  const { result } = await captureLogs(async () => {
    const running = compiler.compile({ requestId: "late", prompt: "draft" }, options)
    await new Promise((resolve) => setImmediate(resolve))
    compiler.cancel("late", "user")
    release(JSON.stringify({ prompt: "Too late" }))
    return running
  })
  assert.deepEqual(result, { requestId: "late", status: "cancelled" })
})

test("trace mode receives the request only when asked", async () => {
  const traced: Array<{ requestId: string }> = []
  const compiler = new PromptCompiler({ enabled: () => true, resolve: () => endpoint(async () => "{\"prompt\":\"x\"}") })
  await captureLogs(() => compiler.compile({ requestId: "n", prompt: "draft" }, options))
  assert.equal(traced.length, 0)
  await captureLogs(() => compiler.compile({ requestId: "y", prompt: "draft" }, { ...options, trace: async (record) => { traced.push(record) } }))
  assert.equal(traced.length, 1)
  assert.equal(traced[0].requestId, "y")
})
