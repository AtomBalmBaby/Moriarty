/**
 * The tool loop under pressure: a context too small for what the tools
 * return, a user who stops mid-tool, servers that count tokens and servers
 * that refuse things, and models that call too much, too late or not at
 * all. Scripted clients stand in for the model; the tools are real.
 */
import * as assert from "node:assert"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"

import { shouldResumeQueuedChat } from "../../common/messaging/chat-stop"
import { ChatCompletionMessage } from "../../common/types"
import { buildChatTurn } from "../../extension/chat/turn"
import { ChatChunk, ChatRequest, InferenceClient, InferenceError, InferenceErrorKind, InferenceOptions, isCancelled, isInferenceError } from "../../extension/inference"
import { abortable } from "../../extension/inference/stream"
import {
  ContextDiagnostics,
  DEFAULT_CHARS_PER_TOKEN,
  fitResult,
  planContext,
  SMALL_CONTEXT_TOKENS,
  TokenEstimator,
  trimmedResult
} from "../../extension/tools/budget"
import { contentHash } from "../../extension/tools/line-edit"
import {
  flattenToolHistory,
  GENERATION_LIMIT_DEFAULTS,
  generationLimitsFrom,
  GenerationMonitor,
  NO_GENERATION_LIMITS,
  ResultBudget,
  ToolLoopUsage,
  ToolStep,
  withTools
} from "../../extension/tools/loop"
import { ToolResult, WorkspaceTools, workspaceTools } from "../../extension/tools/workspace"
import { parsePeerFrame } from "../../protocol/peer"

type Call = { id: string; name: string; arguments: string }
type Reply =
  | string
  | {
    text?: string
    calls?: Call[]
    fail?: string
    /** Thrown once the text has been streamed, as a provider error would be. */
    error?: Error
    usage?: { promptTokens?: number; completionTokens?: number }
  }

/** A client that plays the scripted replies in turn and records each request. */
const scripted = (replies: Reply[]) => {
  const requests: ChatRequest[] = []
  const client = {
    id: "scripted",
    chat(request: ChatRequest) {
      requests.push(structuredClone(request))
      const next = replies.shift() ?? ""
      const reply = typeof next === "string" ? { text: next } : next
      return (async function* (): AsyncGenerator<ChatChunk> {
        if (reply.fail) throw new Error(reply.fail)
        const text = reply.text ?? ""
        for (let i = 0; i < text.length; i += 7) yield { content: text.slice(i, i + 7) }
        if (reply.error) throw reply.error
        if (reply.calls) yield { content: "", toolCalls: reply.calls, finishReason: "stop" }
        if (reply.usage) yield { content: "", usage: reply.usage }
      })()
    }
  } as unknown as InferenceClient
  return { client, requests }
}

const collect = async (stream: AsyncIterable<ChatChunk>) => {
  const chunks: ChatChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return { text: chunks.map((chunk) => chunk.content).join(""), chunks }
}

const workspace = (files: Record<string, string>) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-loop-"))
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), content)
  }
  return root
}

const read = (id: string, file: string): Call => ({ id, name: "read_file", arguments: JSON.stringify({ path: file }) })
const ask = (content: string): ChatRequest => ({ model: "m", messages: [{ role: "user", content }] })

/** Tools made of one function, for what real files cannot stage. */
const fakeTools = (run: (name: string, signal?: AbortSignal) => Promise<ToolResult>): WorkspaceTools => ({
  tools: [{ name: "wait", description: "Waits.", parameters: [], run: async () => ({ output: "", summary: "" }) }],
  orientation: "",
  run: (call, context) => run(call.name, context?.signal)
})

test("a context is shared out by its size", () => {
  const small = planContext(4096)
  const local = planContext(32_768)
  const hosted = planContext(200_000)
  assert.deepStrictEqual([small.limit, small.target, small.resultChars, small.notesChars], [2868, 1864, 2703, 1200])
  assert.deepStrictEqual([local.limit, local.resultChars, local.notesChars], [27_444, 21_626, 6000])
  for (const plan of [small, local, hosted]) {
    assert.strictEqual(plan.limit + plan.reserved + plan.margin, plan.window, "the prompt budget, reply reserve and margin fill the window exactly")
  }
  assert.deepStrictEqual([hosted.resultChars, hosted.notesChars], [100_000, 6000], "the default cap is large enough to keep a whole result in context")
  assert.ok(small.window < SMALL_CONTEXT_TOKENS && local.window > SMALL_CONTEXT_TOKENS)

  assert.strictEqual(planContext(200_000, 10_000).resultChars, 10_000, "a tiny cap clamps the tool result ceiling")
  assert.strictEqual(planContext(200_000, Number.NaN).resultChars, 100_000, "invalid caps fall back to the default while keeping the context scaling")
  assert.strictEqual(planContext(200_000, 0).resultChars, 2000, "non-positive caps clamp to the minimum room")

  const estimator = new TokenEstimator()
  assert.strictEqual(estimator.tokens(3300), 1000)
  estimator.observe(8000, 2000)
  assert.strictEqual(estimator.tokens(4000), 1000, "what the server counted corrects the next estimate")
  estimator.observe(8000, undefined)
  estimator.observe(100, 90)
  assert.strictEqual(estimator.charsPerToken, 4, "no count, or a request too small to learn from, changes nothing")

  const long = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n")
  const cut = fitResult(long, 200)
  assert.ok(cut.startsWith("line 0\n") && /\nline \d+\n… cut to fit the model's context \(\d+ more characters\)/.test(cut))
  assert.strictEqual(fitResult("short", 200), "short")
  assert.strictEqual(
    trimmedResult("src/a.ts (lines 1–150 of 900)\n1: import…\n2: …"),
    "src/a.ts (lines 1–150 of 900)\n[The rest was trimmed to save context. Run the tool again if you need it.]"
  )
})

test("old results are trimmed, oldest first, when the next request would not fit the context", async () => {
  const body = Array.from({ length: 60 }, (_, i) => `const value${i} = "${"x".repeat(30)}"`).join("\n")
  const root = workspace({ "a.ts": body, "b.ts": body, "c.ts": body, "d.ts": body })
  const { client, requests } = scripted([
    { calls: [read("1", "a.ts")] },
    { calls: [read("2", "b.ts")] },
    { calls: [read("3", "c.ts")] },
    { calls: [read("4", "d.ts")] },
    "All four read."
  ])
  const trims: number[] = []
  const estimates: number[] = []
  await collect(
    withTools(client, workspaceTools(root), {
      mode: "native",
      contextWindow: () => 4096,
      onTrim: (results) => trims.push(results),
      onRequest: (_chars, _step, _mode, tokens) => estimates.push(tokens)
    }).chat(ask("Read them all."))
  )
  const plan = planContext(4096)
  assert.ok(estimates.every((tokens) => tokens <= plan.limit), `every request fits: ${estimates.join(", ")}`)
  assert.ok(trims.length >= 1, "something had to go")
  const results = (request: ChatRequest) =>
    request.messages.filter((m) => m.role === "tool").map((m) => String(m.content))
  const last = results(requests[4])
  assert.strictEqual(last.length, 4, "every call keeps its result message, so the conversation stays well formed")
  assert.strictEqual(
    last[0],
    "a.ts (lines 1–60 of 60)\n[The rest was trimmed to save context. Run the tool again if you need it.]"
  )
  assert.match(last[3], /^d\.ts \(lines 1–60 of 60\)\ncontent_hash: xxh64:[a-f0-9]{16}; total_lines: 60\n1: const value0/, "the newest result is whole")
  assert.ok(last[3].length <= plan.resultChars + 120, "and held to its share of the context")
  // Without a known context nothing is trimmed.
  const untrimmed = scripted([{ calls: [read("1", "a.ts")] }, { calls: [read("2", "b.ts")] }, "Done."])
  await collect(withTools(untrimmed.client, workspaceTools(root), { mode: "native" }).chat(ask("Read two.")))
  assert.ok(results(untrimmed.requests[2]).every((content) => content.includes("const value59")))
})

/** Earlier turns long enough that the conversation itself, not the tool results, fills most of the window. */
const longHistory = (turns: number): ChatRequest["messages"] =>
  Array.from({ length: turns }, (_, i) => [
    { role: "user" as const, content: `Earlier question ${i}: ${"detail ".repeat(40)}` },
    { role: "assistant" as const, content: `Earlier answer ${i}: ${"reply ".repeat(40)}` }
  ]).flat()

test("a fresh read stays readable when an older read must be trimmed to fit", async () => {
  const body = Array.from({ length: 60 }, (_, i) => `const value${i} = "${"x".repeat(30)}"`).join("\n")
  const root = workspace({ "a.ts": body, "b.ts": body })
  const { client, requests } = scripted([{ calls: [read("1", "a.ts")] }, { calls: [read("2", "b.ts")] }, "Done."])
  await collect(
    withTools(client, workspaceTools(root), { mode: "native", contextWindow: () => 4096 }).chat({
      model: "m",
      messages: [...longHistory(6), { role: "user", content: "Read both." }]
    })
  )
  const fresh = requests[2].messages.filter((m) => m.role === "tool").map((m) => String(m.content)).pop() ?? ""
  assert.ok(fresh.includes("const value20"), `the fresh read is shown beyond its first line:\n${fresh}`)
})

test("a fresh read that cannot fit is left out with a notice, and running it again is refused rather than looping", async () => {
  const body = Array.from({ length: 60 }, (_, i) => `const value${i} = "${"x".repeat(30)}"`).join("\n")
  const root = workspace({ "a.ts": body })
  const { client, requests } = scripted([
    { calls: [read("1", "a.ts")] },
    { calls: [read("2", "a.ts")] },
    { calls: [read("3", "a.ts")] },
    { calls: [read("4", "a.ts")] },
    "Stopped for lack of room."
  ])
  const budgets: ResultBudget[] = []
  const reply = await collect(
    withTools(client, workspaceTools(root), {
      mode: "native",
      contextWindow: () => 4096,
      onBudget: (entry) => budgets.push(entry)
    }).chat({ model: "m", messages: [...longHistory(40), { role: "user", content: "Read it." }] })
  )
  assert.ok(requests.length <= 5, `the loop stops by itself, after ${requests.length} requests`)
  assert.strictEqual(reply.text.includes("Stopped for lack of room."), true)
  const tools = requests[1].messages.filter((m) => m.role === "tool").map((m) => String(m.content))
  assert.match(tools[0], /^\[Not included: this result \(\d+ characters\) did not fit in the model's context/, "a fresh result that cannot fit is named as left out")
  const repeated = requests.flatMap((request) => request.messages.filter((m) => m.role === "tool").map((m) => String(m.content)))
  assert.ok(repeated.some((content) => content.includes("was not run again")), "a repeat of the left-out read is refused, not run again")
  assert.ok(
    budgets.some((entry) => entry.name === "read_file" && entry.reason === "omitted: no room" && entry.retained === false),
    "the diagnostics say the result was omitted and not retained"
  )
  assert.ok(budgets.every((entry) => !("content" in entry)), "diagnostics carry sizes and ids, never the content")
})

test("a small fresh read is kept whole beside a large conversation", async () => {
  const root = workspace({ "one.ts": "export const one = 1\n" })
  const { client, requests } = scripted([{ calls: [read("1", "one.ts")] }, "Read."])
  await collect(
    withTools(client, workspaceTools(root), { mode: "native", contextWindow: () => 4096 }).chat({
      model: "m",
      messages: [...longHistory(6), { role: "user", content: "Read it." }]
    })
  )
  const fresh = requests[1].messages.filter((m) => m.role === "tool").map((m) => String(m.content)).pop() ?? ""
  assert.match(fresh, /1: export const one = 1/, "the one-line read keeps its line")
})

test("a fresh read cut to the room left keeps its beginning and says so", async () => {
  const body = Array.from({ length: 60 }, (_, i) => `const value${i} = "${"x".repeat(30)}"`).join("\n")
  const root = workspace({ "a.ts": body })
  const { client, requests } = scripted([{ calls: [read("1", "a.ts")] }, "Read."])
  const budgets: ResultBudget[] = []
  await collect(
    withTools(client, workspaceTools(root), {
      mode: "native",
      contextWindow: () => 4096,
      onBudget: (entry) => budgets.push(entry)
    }).chat({ model: "m", messages: [...longHistory(8), { role: "user", content: "Read it." }] })
  )
  const fresh = requests[1].messages.filter((m) => m.role === "tool").map((m) => String(m.content)).pop() ?? ""
  assert.ok(fresh.includes("const value0") && fresh.includes("cut to fit the model's context"), "the cut keeps the start and names the cut")
  assert.ok(budgets.some((entry) => entry.id === "0.0" && entry.reason === "cut to remaining room" && entry.retained === true))
})

const CAPACITIES = [4_096, 16_384, 65_536, 131_072, 262_144]
const SAMPLE = Array.from({ length: 60 }, (_, i) => `const value${i} = "${"x".repeat(30)}"`).join("\n")

/** Conversation sized to a share of the window's prompt budget, so fresh results have to fit beside it. */
const historyFilling = (window: number, share: number): ChatRequest["messages"] => {
  const perTurn = longHistory(1).reduce((chars, message) => chars + String(message.content).length, 0)
  return longHistory(Math.ceil((planContext(window).limit * DEFAULT_CHARS_PER_TOKEN * share) / perTurn))
}

const toolOutputs = (request: ChatRequest) => request.messages.filter((m) => m.role === "tool").map((m) => String(m.content))

test("each context capacity splits into a prompt budget, reply reserve and margin that fill it exactly", () => {
  const plans = CAPACITIES.map((window) => planContext(window))
  for (const plan of plans) {
    assert.strictEqual(plan.limit + plan.reserved + plan.margin, plan.window, `${plan.window}: nothing is over-committed`)
    assert.ok(plan.reserved > 0 && plan.reserved <= 2048, `${plan.window}: the reply keeps room within its cap`)
    assert.ok(plan.target > 0 && plan.target <= plan.limit, `${plan.window}: the target sits inside the prompt budget`)
    assert.ok(plan.resultChars >= 2000 && plan.resultChars <= 100_000, `${plan.window}: a result's share stays within its bounds`)
  }
  assert.ok(plans.every((plan, i) => i === 0 || plan.limit > plans[i - 1].limit), "more capacity means more prompt budget")
  assert.ok(planContext(131_072).limit > planContext(65_536).limit * 1.9, "128K is budgeted from its own capacity, not a 64K-sized one")
  assert.ok(planContext(262_144).limit > 200_000, "256K is represented in full")
})

test("every inference request reports its capacity, budget and removals at each context size", async () => {
  for (const window of CAPACITIES) {
    const plan = planContext(window)
    const root = workspace({ "a.ts": SAMPLE, "b.ts": SAMPLE })
    const { client, requests } = scripted([{ calls: [read("1", "a.ts")] }, { calls: [read("2", "b.ts")] }, "Done."])
    const diagnostics: ContextDiagnostics[] = []
    await collect(
      withTools(client, workspaceTools(root), {
        mode: "native",
        contextWindow: () => window,
        onContext: (entry) => diagnostics.push(entry)
      }).chat({ model: "m", messages: [...historyFilling(window, 0.4), { role: "user", content: "Read both." }] })
    )
    assert.strictEqual(diagnostics.length, requests.length, `${window}: one diagnostic per request`)
    for (const entry of diagnostics) {
      assert.strictEqual(entry.capacity.tokens, window, `${window}: the request reports the capacity it was planned for`)
      assert.strictEqual(entry.promptBudget, plan.limit, `${window}: the budget is the plan's`)
      assert.strictEqual(entry.reserved + entry.margin + entry.promptBudget, window, `${window}: budget, reserve and margin fill the window`)
      assert.ok(entry.exhausted || entry.estimatedPromptTokens <= entry.promptBudget, `${window}: an unexhausted request fits its budget`)
      assert.ok(entry.exhausted || entry.utilizationPercent <= 100, `${window}: utilization stays within capacity`)
      assert.ok(entry.removed.olderResults.results === 0 || entry.reason.includes("older result"), `${window}: every trim is named in the reason`)
    }
    const fresh = toolOutputs(requests[2]).pop() ?? ""
    assert.ok(
      window < 16_384 ? fresh.includes("const value0") || fresh.includes("[Not included:") : fresh.includes("const value0"),
      `${window}: the fresh read is shown, or at the deliberate 4K limit named as left out, never dropped silently`
    )
    if (window >= 16_384) assert.ok(fresh.includes("const value59"), `${window}: a small fresh read is kept whole`)
  }
})

test("switching the model mid-task recalculates the capacity and keeps the task's results", async () => {
  let window = 131_072
  const root = workspace({ "a.ts": SAMPLE, "b.ts": SAMPLE })
  const { client, requests } = scripted([{ calls: [read("1", "a.ts")] }, { calls: [read("2", "b.ts")] }, "Done."])
  const diagnostics: ContextDiagnostics[] = []
  await collect(
    withTools(client, workspaceTools(root), {
      mode: "native",
      contextWindow: () => window,
      onContext: (entry) => {
        diagnostics.push(entry)
        if (entry.request === 1) window = 4096
      }
    }).chat({ model: "large", messages: [{ role: "user", content: "Read both." }] })
  )
  assert.deepStrictEqual(diagnostics.map((entry) => entry.capacity.tokens), [131_072, 4096, 4096])
  assert.strictEqual(diagnostics[1].promptBudget, planContext(4096).limit, "the smaller model's budget replaces the larger one")
  assert.strictEqual(toolOutputs(requests[2]).length, 2, "both results are still in the conversation after the switch")
  assert.ok(requests[2].messages.some((m) => String(m.content) === "Read both."), "the task itself is kept")
})

test("a conversation too large for its window is reported as exhausted, and the reply still ends", async () => {
  const { client } = scripted(["Stopped for lack of room."])
  const diagnostics: ContextDiagnostics[] = []
  const reply = await collect(
    withTools(client, workspaceTools(workspace({})), {
      mode: "native",
      contextWindow: () => 4096,
      onContext: (entry) => diagnostics.push(entry)
    }).chat({ model: "m", messages: [...historyFilling(4096, 3), { role: "user", content: "Continue." }] })
  )
  assert.ok(diagnostics.some((entry) => entry.exhausted && entry.reason.includes("still over budget")), "the overflow is observable")
  assert.strictEqual(reply.text, "Stopped for lack of room.", "the reply still completes")
})

for (const window of [65_536, 131_072]) {
  test(`a sustained ${window}-token session keeps fresh observations, TODO and evidence across a new instruction`, async () => {
    const todo = "TODO\n- [x] read a.ts\n- [ ] edit b.ts"
    const root = workspace({ "a.ts": SAMPLE, "b.ts": SAMPLE })
    const { client, requests } = scripted([
      { calls: [read("1", "a.ts")] },
      { calls: [{ id: "2", name: "grep", arguments: JSON.stringify({ pattern: "value5 " }) }] },
      { calls: [read("3", "b.ts")] },
      "Read both; value5 is in both files.",
      "Noted: the next change goes in b.ts."
    ])
    const diagnostics: ContextDiagnostics[] = []
    const onContext = (entry: ContextDiagnostics) => diagnostics.push(entry)
    const history = historyFilling(window, 0.4)
    const first = await collect(
      withTools(client, workspaceTools(root), { mode: "native", contextWindow: () => window, requestContext: () => todo, onContext }).chat({
        model: "m",
        messages: [...history, { role: "user", content: "Read both and find value5." }]
      })
    )
    const turn = [...history, { role: "user" as const, content: "Read both and find value5." }, { role: "assistant" as const, content: first.text }]
    await collect(
      withTools(client, workspaceTools(root), { mode: "native", contextWindow: () => window, requestContext: () => todo, onContext }).chat({
        model: "m",
        messages: [...turn, { role: "user", content: "Now note the next change." }]
      })
    )

    assert.strictEqual(diagnostics.length, 5, "every request, across both turns, is reported")
    assert.ok(diagnostics.every((entry) => entry.capacity.tokens === window && entry.promptBudget === planContext(window).limit))
    assert.ok(diagnostics.slice(0, 4).every((entry) => entry.fresh.omitted === 0 && entry.fresh.cut === 0), "no fresh result is cut or omitted")
    assert.ok(requests.slice(0, 4).every((request) => JSON.stringify(request.messages).includes("edit b.ts")), "the TODO is in every request of the turn")

    const finalOutputs = toolOutputs(requests[3])
    assert.ok(finalOutputs.at(-1)?.includes("const value59") && finalOutputs.at(-1)?.includes("content_hash: xxh64:"), "the fresh read is whole and carries its fingerprint")
    assert.ok(finalOutputs.some((output) => output.includes("value5")), "the search output survives")
    assert.strictEqual(finalOutputs.join("\n").split("const value0 = ").length - 1, 2, "each file's first line is kept once per result, not duplicated")
    assert.ok(String(requests[4].messages.at(-1)?.content).includes("Now note the next change."), "the new instruction is in the continued request")
  })
}

/** A client that sends its first chunks, then goes quiet until the host aborts the request. */
const stalled = (chunks: ChatChunk[], requests: ChatRequest[]) =>
  ({
    id: "stalled",
    chat(request: ChatRequest, options?: InferenceOptions) {
      requests.push(structuredClone(request))
      return (async function* (): AsyncGenerator<ChatChunk> {
        for (const chunk of chunks) yield chunk
        await new Promise<never>((_, reject) => {
          const signal = options?.signal
          if (signal?.aborted) reject(signal.reason)
          else signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
        })
      })()
    }
  }) as unknown as InferenceClient

test("a request's silence and duration are measured apart, and output resets the silence", () => {
  let now = 0
  const clock = () => now
  const quiet = new GenerationMonitor({ maxDurationMs: 10_000, noProgressMs: 3_000, maxOutputTokens: 0 }, clock)
  now = 2_000
  quiet.output()
  now = 4_000
  assert.strictEqual(quiet.exceeded(), undefined, "two seconds of silence is within the limit")
  now = 5_100
  assert.strictEqual(quiet.exceeded()?.reason, "no_progress")

  now = 0
  const long = new GenerationMonitor({ maxDurationMs: 10_000, noProgressMs: 3_000, maxOutputTokens: 0 }, clock)
  for (now = 1_000; now <= 9_000; now += 1_000) long.output()
  now = 10_000
  assert.strictEqual(long.exceeded()?.reason, "duration_limit", "duration counts from the start, whatever the output")
})

test("no limits never stop a request, and configured limits are clamped to sane values", () => {
  let now = 0
  const free = new GenerationMonitor(NO_GENERATION_LIMITS, () => now)
  now = 10 ** 9
  assert.strictEqual(free.timed, false)
  assert.strictEqual(free.exceeded(), undefined)
  assert.deepStrictEqual(
    generationLimitsFrom({ durationSeconds: Number.NaN, noProgressSeconds: 99_999, outputTokens: -5 }),
    { maxDurationMs: 900_000, noProgressMs: 7_200_000, maxOutputTokens: 0 }
  )
})

test("each inference request is capped at 6144 output tokens by default, and a user's own cap is kept", () => {
  assert.strictEqual(GENERATION_LIMIT_DEFAULTS.outputTokens, 6144)
  assert.strictEqual(
    generationLimitsFrom({ ...GENERATION_LIMIT_DEFAULTS }).maxOutputTokens,
    6144
  )
  assert.strictEqual(
    generationLimitsFrom({ durationSeconds: 900, noProgressSeconds: 300, outputTokens: 4096 }).maxOutputTokens,
    4096
  )
  assert.strictEqual(
    generationLimitsFrom({ durationSeconds: 900, noProgressSeconds: 300, outputTokens: 0 }).maxOutputTokens,
    0
  )
})

test("a request gone silent is stopped, the stop is reported, and it is not retried", async () => {
  const requests: ChatRequest[] = []
  const stops: string[] = []
  const { text } = await collect(
    withTools(stalled([{ content: "Looking at the file" }], requests), workspaceTools(workspace({})), {
      mode: "native",
      generationLimits: () => ({ maxDurationMs: 0, noProgressMs: 1_000, maxOutputTokens: 0 }),
      onGenerationStop: (stop) => stops.push(stop.reason)
    }).chat(ask("Read a.ts."))
  )
  assert.deepStrictEqual(stops, ["no_progress"])
  assert.strictEqual(requests.length, 1, "a stopped request is not sent again")
  assert.ok(text.startsWith("Looking at the file"), "what arrived before the stop is kept")
  assert.ok(text.includes("Stopped: the model sent no output for 1 seconds."), "the stop is shown in place of a finished reply")
})

test("a request that runs past its duration keeps the tool results it already had", async () => {
  const root = workspace({ "a.ts": "export const a = 1\n" })
  const requests: ChatRequest[] = []
  const script = scripted([{ calls: [read("1", "a.ts")] }])
  const stalling = stalled([], requests)
  let turn = 0
  const client = {
    id: "after-a-tool",
    chat(request: ChatRequest, options?: InferenceOptions) {
      turn++
      return turn === 1 ? script.client.chat(request) : stalling.chat(request, options)
    }
  } as unknown as InferenceClient
  const stops: string[] = []
  const { text } = await collect(
    withTools(client, workspaceTools(root), {
      mode: "native",
      generationLimits: () => ({ maxDurationMs: 1_000, noProgressMs: 0, maxOutputTokens: 0 }),
      onGenerationStop: (stop) => stops.push(stop.reason)
    }).chat(ask("Read a.ts."))
  )
  assert.deepStrictEqual(stops, ["duration_limit"])
  assert.strictEqual(requests.length, 1)
  assert.ok(JSON.stringify(requests[0].messages).includes("const a = 1"), "the completed read is still in the next request")
  assert.ok(text.includes("Stopped: this request ran past its 1 second limit"))
})

test("a reply cut short by the output limit runs none of the calls it was writing", async () => {
  const requests: ChatRequest[] = []
  const stops: string[] = []
  let ran = 0
  const client = {
    id: "length",
    chat(request: ChatRequest) {
      requests.push(structuredClone(request))
      return (async function* (): AsyncGenerator<ChatChunk> {
        yield { content: "", toolCalls: [read("1", "a.ts")] }
        yield { content: "", finishReason: "length" }
      })()
    }
  } as unknown as InferenceClient
  const { text } = await collect(
    withTools(client, workspaceTools(workspace({ "a.ts": "export const a = 1\n" })), {
      mode: "native",
      generationLimits: () => ({ maxDurationMs: 0, noProgressMs: 0, maxOutputTokens: 256 }),
      onToolResult: () => void ran++,
      onGenerationStop: (stop) => stops.push(stop.reason)
    }).chat(ask("Read a.ts."))
  )
  assert.strictEqual(ran, 0, "a call from a truncated reply is never run")
  assert.strictEqual(requests.length, 1)
  assert.strictEqual(requests[0].maxTokens, 256, "the output budget is sent to the server")
  assert.deepStrictEqual(stops, ["output_limit"])
  assert.ok(text.includes("reached its output limit"))
})

test("a request without an output budget sends none", async () => {
  const { client, requests } = scripted(["Done."])
  await collect(withTools(client, workspaceTools(workspace({})), { mode: "native" }).chat(ask("Hi.")))
  assert.strictEqual(requests[0].maxTokens, undefined)
})

test("the reply reports what the server counted: the largest prompt, all the output", async () => {
  const root = workspace({ "a.ts": "export const a = 1\n" })
  const { client } = scripted([
    { calls: [read("1", "a.ts")], usage: { promptTokens: 900, completionTokens: 20 } },
    { calls: [read("2", "a.ts")], usage: { promptTokens: 1400, completionTokens: 25 } },
    { text: "It is 1.", usage: { promptTokens: 1250, completionTokens: 5 } }
  ])
  const seen: ToolLoopUsage[] = []
  const { chunks } = await collect(
    withTools(client, workspaceTools(root), { mode: "native", onUsage: (usage) => seen.push(usage) }).chat(ask("What is a?"))
  )
  assert.deepStrictEqual(seen.at(-1), { promptTokens: 1400, completionTokens: 50 })
  assert.deepStrictEqual(chunks.at(-1), { content: "", usage: { promptTokens: 1400, completionTokens: 50 } })
})

test("stopping the reply does not wait for a tool that is still running", async () => {
  const stop = new AbortController()
  let toolSawStop = false
  const tools = fakeTools(
    (_name, signal) =>
      new Promise<ToolResult>(() => {
        signal?.addEventListener("abort", () => (toolSawStop = true))
      })
  )
  const { client } = scripted([{ calls: [{ id: "1", name: "wait", arguments: "{}" }] }])
  const events: string[] = []
  const started = Date.now()
  setTimeout(() => stop.abort(), 30)
  await assert.rejects(
    collect(
      withTools(client, tools, {
        mode: "native",
        onToolStart: (start) => events.push(`start ${start.name}`),
        onNotes: (notes) => events.push(`notes ${notes}`),
        onEnd: () => events.push("end")
      }).chat(ask("Wait."), { signal: stop.signal } as InferenceOptions)
    ),
    (error) => isCancelled(error)
  )
  assert.ok(Date.now() - started < 2000)
  assert.ok(toolSawStop, "the tool is told, so a command can be interrupted")
  assert.deepStrictEqual(events, ["start wait", "notes undefined", "end"], "the host hears the reply is over")
})

test("a stop between two calls of one reply means the second is never dispatched", async () => {
  const stop = new AbortController()
  const dispatched: string[] = []
  const tools = fakeTools((name) => {
    dispatched.push(name)
    return Promise.resolve({ output: "done", summary: "done" })
  })
  const { client, requests } = scripted([{
    calls: [
      { id: "1", name: "wait", arguments: "{\"n\":1}" },
      { id: "2", name: "wait", arguments: "{\"n\":2}" }
    ]
  }])
  await assert.rejects(
    collect(withTools(client, tools, {
      mode: "native",
      onToolResult: () => stop.abort()
    }).chat(ask("Wait twice."), { signal: stop.signal } as InferenceOptions)),
    (error) => isCancelled(error)
  )
  assert.equal(dispatched.length, 1, "the second call is not dispatched after the stop")
  assert.equal(requests.length, 1, "no further model request starts")
})

test("a stopped reply still keeps what its tools did, for the next turn", async () => {
  const root = workspace({ "a.ts": "export const a = 1\n" })
  const stop = new AbortController()
  const { client } = scripted([{ calls: [read("1", "a.ts")] }, { fail: "unreachable" }])
  const notes: Array<string | undefined> = []
  const stopping = {
    ...client,
    chat: (request: ChatRequest, options?: InferenceOptions) => {
      if (request.messages.some((m) => m.role === "tool")) stop.abort()
      return client.chat(request, options)
    }
  } as InferenceClient
  await assert.rejects(
    collect(
      withTools(stopping, workspaceTools(root), { mode: "native", onNotes: (n) => notes.push(n) }).chat(ask("Read."), {
        signal: stop.signal
      } as InferenceOptions)
    )
  )
  assert.deepStrictEqual(notes, [
    "read_file {\"path\":\"a.ts\"}\na.ts (lines 1–1 of 1)\n" +
    `content_hash: ${await contentHash("export const a = 1\n")}; total_lines: 1\n1: export const a = 1`
  ])
})

test("calls beyond what one reply may run are named to the model, not dropped in silence", async () => {
  const root = workspace({ "a.ts": "export const a = 1\n" })
  const { client, requests } = scripted([
    { calls: Array.from({ length: 10 }, (_, i) => read(`c${i}`, "a.ts")) },
    "Read."
  ])
  const steps: string[] = []
  await collect(
    withTools(client, workspaceTools(root), { mode: "native", onStep: (step) => steps.push(step.id) }).chat(ask("Read a lot."))
  )
  assert.strictEqual(steps.length, 8)
  const [, , assistant, ...rest] = requests[1].messages as unknown as Array<Record<string, unknown>>
  assert.strictEqual((assistant.tool_calls as unknown[]).length, 8, "the conversation records only the calls that ran")
  const outputs = rest.map((m) => String(m.content))
  assert.match(outputs[7], /\n\(2 more calls in the same reply were not run; make them again if still needed\.\)$/)
  assert.ok(outputs.slice(0, 7).every((output) => !output.includes("not run")))
})

test("arguments that are not JSON go back to the server as an empty object, with the error as the result", async () => {
  const root = workspace({ "a.ts": "x\n" })
  const { client, requests } = scripted([{ calls: [{ id: "1", name: "read_file", arguments: "{path: a.ts" }] }, "Sorry."])
  await collect(withTools(client, workspaceTools(root), { mode: "native" }).chat(ask("Read.")))
  const [, , assistant, result] = requests[1].messages as unknown as Array<Record<string, unknown>>
  assert.deepStrictEqual((assistant.tool_calls as Array<{ function: unknown }>)[0].function, { name: "read_file", arguments: "{}" })
  assert.match(String(result.content), /^Your tool call could not be read: the arguments were not valid JSON \(.+\)\.\nYou wrote:\n~~~\n\{path: a\.ts\n~~~$/)
})

test("native arguments with the slips small models make are mended, not refused", async () => {
  const root = workspace({ "a.ts": "x\n" })
  const { client, requests } = scripted([
    { calls: [{ id: "1", name: "read_file", arguments: "{path: \"a.ts\",}" }] },
    "Read it."
  ])
  const steps: ToolStep[] = []
  await collect(withTools(client, workspaceTools(root), { mode: "native", onStep: (step) => steps.push(step) }).chat(ask("Read.")))
  assert.strictEqual(steps[0].parseError, undefined)
  assert.strictEqual(steps[0].summary, "read `a.ts` · whole file")
  const assistant = requests[1].messages[2] as unknown as { tool_calls: Array<{ function: { arguments: string } }> }
  assert.strictEqual(assistant.tool_calls[0].function.arguments, "{\"path\":\"a.ts\"}", "the conversation carries the mended arguments")
})

test("an error that names tools after tools have run is the reply's error, not a restart in text", async () => {
  const root = workspace({ "a.ts": "x\n" })
  const { client } = scripted([
    { calls: [read("1", "a.ts")] },
    { fail: "400 messages.2: `tool_result` blocks must follow a `tool_use` block" }
  ])
  const fallbacks: string[] = []
  await assert.rejects(
    collect(
      withTools(client, workspaceTools(root), { mode: "native", onFallback: (reason) => fallbacks.push(reason) }).chat(ask("Read."))
    ),
    /tool_result/
  )
  assert.deepStrictEqual(fallbacks, [], "what the tools found is not thrown away for a second attempt")
})

test("a server that wants tools declared beside tool history gets the history as plain messages for the last request", async () => {
  const root = workspace({ "a.ts": "export const a = 1\n" })
  const { client, requests } = scripted([
    { calls: [read("1", "a.ts")] },
    { fail: "400 tools must be provided when messages contain tool calls" },
    "a is 1."
  ])
  const { text } = await collect(
    withTools(client, workspaceTools(root), { mode: "native", maxSteps: 1, stepLines: false }).chat(ask("What is a?"))
  )
  assert.strictEqual(text, "a is 1.")
  const retry = requests[2]
  assert.strictEqual(retry.tools, undefined)
  assert.deepStrictEqual(retry.messages.map((m) => m.role), ["system", "user", "assistant", "user"])
  assert.strictEqual(retry.messages[2].content, "```tool\n{\"name\":\"read_file\",\"arguments\":{\"path\":\"a.ts\"}}\n```")
  assert.match(
    String(retry.messages[3].content),
    /^<tool_result name="read_file">\na\.ts \(lines 1–1 of 1\)\ncontent_hash: xxh64:[a-f0-9]{16}; total_lines: 1\n1: export const a = 1\n<\/tool_result>\n\nYou are out of tool calls/
  )
})

test("tool history flattens to plain messages, results of one reply together", () => {
  const flat = flattenToolHistory([
    { role: "system", content: "s" },
    { role: "user", content: "q" },
    {
      role: "assistant",
      content: "Looking.",
      tool_calls: [
        { id: "a", type: "function", function: { name: "grep", arguments: "{\"pattern\":\"x\"}" } },
        { id: "b", type: "function", function: { name: "list_dir", arguments: "not json" } }
      ]
    },
    { role: "tool", tool_call_id: "a", content: "No matches." },
    { role: "tool", tool_call_id: "b", content: "src/" }
  ] as unknown as ChatCompletionMessage[])
  assert.deepStrictEqual(flat.map((m) => m.role), ["system", "user", "assistant", "user"])
  assert.strictEqual(
    flat[2].content,
    "Looking.\n```tool\n{\"name\":\"grep\",\"arguments\":{\"pattern\":\"x\"}}\n```\n```tool\n{\"name\":\"list_dir\",\"arguments\":{}}\n```"
  )
  assert.strictEqual(
    flat[3].content,
    "<tool_result name=\"grep\">\nNo matches.\n</tool_result>\n\n<tool_result name=\"list_dir\">\nsrc/\n</tool_result>"
  )
})

test("a call written on the last request is neither run nor shown", async () => {
  const root = workspace({ "a.ts": "x\n" })
  const call = "```tool\n{\"name\": \"read_file\", \"arguments\": {\"path\": \"a.ts\"}}\n```"
  const { client, requests } = scripted([call, `Still looking.\n${call}`])
  const steps: string[] = []
  const { text } = await collect(
    withTools(client, workspaceTools(root), { maxSteps: 1, stepLines: false, onStep: (s) => steps.push(s.summary) }).chat(ask("Read."))
  )
  assert.strictEqual(requests.length, 2)
  assert.strictEqual(steps.length, 1)
  assert.strictEqual(text, "Still looking.\n")

  const only = scripted([call, call])
  const blank = await collect(
    withTools(only.client, workspaceTools(root), { maxSteps: 1, stepLines: false }).chat(ask("Read."))
  )
  assert.match(blank.text, /^I ran out of tool steps for this reply/, "a reply is never left blank")
})

test("a model that answers nothing after its tools still leaves a line to read", async () => {
  const root = workspace({ "a.ts": "x\n" })
  const { client } = scripted([{ calls: [read("1", "a.ts")] }, ""])
  const { text } = await collect(withTools(client, workspaceTools(root), { mode: "native", stepLines: false }).chat(ask("Read.")))
  assert.strictEqual(text, "The model finished without writing a reply; the steps above show what it did.")
})

test("in text mode a call is taken the moment its JSON closes and recorded with its closing marker", async () => {
  const root = workspace({ "a.ts": "x\n" })
  // The model rambles on after the call; none of that is read, shown or kept.
  const { client, requests } = scripted([
    "```tool\n{\"name\": \"read_file\", \"arguments\": {\"path\": \"a.ts\"}} and then I think the file says hello",
    "It says x."
  ])
  const { text } = await collect(withTools(client, workspaceTools(root), { stepLines: false }).chat(ask("Read.")))
  assert.strictEqual(text, "It says x.")
  assert.strictEqual(
    requests[1].messages[2].content,
    "```tool\n{\"name\": \"read_file\", \"arguments\": {\"path\": \"a.ts\"}}\n```"
  )
})

test("the previous reply's tool notes travel with the next question, once", async () => {
  const turn = await buildChatTurn(
    [
      { role: "user", content: "<p>first</p>" },
      { role: "assistant", content: "Old answer.", toolNotes: "grep {\"pattern\":\"old\"}\nold result" },
      { role: "user", content: "<p>second</p>" },
      { role: "assistant", content: "It is in a.ts.", toolNotes: "read_file {\"path\":\"a.ts\"}\n1: x" },
      { role: "user", content: "<p>and b?</p>" }
    ] as ChatCompletionMessage[],
    { systemPrompt: async () => "s", additionalContext: async () => "Selected Code:\nfoo" }
  )
  const texts = turn.map((message) =>
    typeof message.content === "string"
      ? message.content
      : (message.content as Array<{ text: string }>).map((part) => part.text).join("")
  )
  assert.deepStrictEqual(texts.slice(1, 5), ["first", "Old answer.", "second", "It is in a.ts."], "replies go back as they were shown")
  assert.strictEqual(
    texts[5],
    "[For reference: the tool calls and results behind your previous reply. The user did not see them.]\nread_file {\"path\":\"a.ts\"}\n1: x\n\n[The user's new message:]\nand b?\n\nSelected Code:\nfoo",
    "the notes come first, so the message ends on what the user is asking now"
  )
  assert.ok(!texts.join("\n").includes("old result"), "an older reply's notes are not carried any further")
  for (const message of turn) assert.deepStrictEqual(Object.keys(message).sort(), ["content", "role"])
})

test("a reply that failed after its tools ran still hands its notes on, past the error message", async () => {
  const turn = await buildChatTurn(
    [
      { role: "user", content: "<p>first</p>" },
      { role: "assistant", content: "", toolNotes: "read_file {\"path\":\"a.ts\"}\n1: x" },
      { role: "assistant", content: "The provider failed: 500." },
      { role: "user", content: "<p>try again</p>" }
    ] as ChatCompletionMessage[],
    { systemPrompt: async () => "s", additionalContext: async () => "" }
  )
  const last = turn[turn.length - 1].content as Array<{ text: string }>
  assert.match(last.map((part) => part.text).join(""), /^\[For reference: [^\n]*\]\nread_file \{"path":"a\.ts"\}\n1: x\n\n\[The user's new message:\]\ntry again$/)
})

test("a reply stopped before any text still takes its turn, and its tools' notes still travel", async () => {
  const turn = await buildChatTurn(
    [
      { role: "user", content: "<p>rename it</p>" },
      { role: "assistant", content: "", toolNotes: "edit_file {\"path\":\"a.ts\"}\nApplied and saved." },
      { role: "user", content: "<p>continue</p>" }
    ] as ChatCompletionMessage[],
    { systemPrompt: async () => "s", additionalContext: async () => "" }
  )
  const text = (message: ChatCompletionMessage) =>
    typeof message.content === "string" ? message.content : (message.content as Array<{ text: string }>)[0].text
  assert.deepStrictEqual(turn.map((m) => m.role), ["system", "user", "assistant", "user"])
  assert.strictEqual(text(turn[2]), "(This reply was stopped before any text was written.)")
  assert.match(text(turn[3]), /Applied and saved\.\n\n\[The user's new message:\]\ncontinue$/)
})

test("a reply saved with a tool transcript by an earlier build goes back as it was shown", async () => {
  const turn = await buildChatTurn(
    [
      { role: "user", content: "<p>q</p>" },
      { role: "assistant", content: "It is in a.ts.", prompt: "[What I looked at in the workspace before answering]\nread_file {}\n1: x\n\n[My answer]\nIt is in a.ts." },
      { role: "user", content: "<p>and?</p>" }
    ] as ChatCompletionMessage[],
    { systemPrompt: async () => "s", additionalContext: async () => "" }
  )
  assert.deepStrictEqual(turn[2].content, [{ type: "text", text: "It is in a.ts." }])
})

test("a stop while the loop falls back to text mode sends no second request", async () => {
  const root = workspace({ "a.ts": "export const a = 1\n" })
  const { client, requests } = scripted([{ fail: "Invalid request: unknown field \"tools\"." }, "must not run"])
  const stop = new AbortController()
  await assert.rejects(
    collect(withTools(client, workspaceTools(root), { mode: "native", onFallback: () => stop.abort() }).chat(ask("What is in a.ts?"), { signal: stop.signal })),
    isCancelled
  )
  assert.equal(requests.length, 1, "the retry request never starts after Stop")
})

test("a gateway from before tools refuses the field by name, and the loop carries on in text", async () => {
  const root = workspace({ "a.ts": "export const a = 1\n" })
  const { client, requests } = scripted([
    { fail: "Invalid request: unknown field \"tools\"." },
    "```tool\n{\"name\":\"read_file\",\"args\":{\"path\":\"a.ts\"}}\n```",
    "It exports a."
  ])
  const fallbacks: string[] = []
  const { text } = await collect(
    withTools(client, workspaceTools(root), { mode: "native", onFallback: (_reason, what) => fallbacks.push(what) }).chat(ask("What is in a.ts?"))
  )
  assert.deepStrictEqual(fallbacks, ["tools"])
  assert.ok(requests[0].tools?.length)
  assert.ok(!requests[1].tools, "asked again without the field the gateway refused")
  assert.match(text, /It exports a\./)
  // The call was keyed `args`, and its path still reached the tool.
  assert.match(String(requests[2].messages[requests[2].messages.length - 1].content), /a\.ts \(lines 1–1 of 1\)\ncontent_hash: xxh64:[a-f0-9]{16}; total_lines: 1\n1: export const a = 1/)
})

const failure = (reason: "interrupted" | "bad-request" | "parser-failure", kind: InferenceErrorKind = "provider-unavailable") =>
  new InferenceError(kind, `provider ${reason}`, { reason, status: reason === "bad-request" ? 400 : 500 })

test("a provider failure before any output is sent again, and no tool runs twice", async () => {
  const root = workspace({ "a.ts": "const a = 1\n" })
  const { client, requests } = scripted([
    { calls: [read("1", "a.ts")] },
    { error: failure("interrupted") },
    "Done."
  ])
  const decisions: string[] = []
  const reply = await collect(
    withTools(client, workspaceTools(root), {
      mode: "native",
      providerRetryDelayMs: 0,
      onRequest: () => decisions.push("request")
    }).chat(ask("Read it."))
  )
  assert.ok(reply.text.endsWith("Done."), `the answer follows the tool note: ${reply.text}`)
  assert.strictEqual(requests.length, 3, "the failed request is sent again once")
  assert.deepStrictEqual(requests[2].messages, requests[1].messages, "the retry carries exactly the request that failed")
  const results = requests[2].messages.filter((m) => m.role === "tool")
  assert.strictEqual(results.length, 1, "the read ran once, before the failure")
  assert.strictEqual(decisions.length, 3)
})

test("a provider failure after output is shown is not sent again", async () => {
  const { client, requests } = scripted([{ text: "The answer begins here and then the stream dies.", error: failure("interrupted") }])
  await assert.rejects(
    collect(withTools(client, workspaceTools(workspace({})), { mode: "native", providerRetryDelayMs: 0 }).chat(ask("Answer."))),
    (error: unknown) => isInferenceError(error) && error.reason === "interrupted"
  )
  assert.strictEqual(requests.length, 1, "what the user has seen is not repeated")
})

test("a failure the provider will not change on retry is thrown at once", async () => {
  const { client, requests } = scripted([{ error: failure("bad-request", "inference-failure") }])
  await assert.rejects(
    collect(withTools(client, workspaceTools(workspace({})), { mode: "native", providerRetryDelayMs: 0 }).chat(ask("Answer."))),
    (error: unknown) => isInferenceError(error) && error.reason === "bad-request"
  )
  assert.strictEqual(requests.length, 1)
})

test("provider retries are bounded, and a successful request starts the count again", async () => {
  const exhausted = scripted([{ error: failure("parser-failure") }, { error: failure("parser-failure") }, { error: failure("parser-failure") }])
  await assert.rejects(
    collect(withTools(exhausted.client, workspaceTools(workspace({})), { mode: "native", providerRetryDelayMs: 0 }).chat(ask("Answer."))),
    (error: unknown) => isInferenceError(error) && error.reason === "parser-failure"
  )
  assert.strictEqual(exhausted.requests.length, 3, "two retries, then the last failure is thrown")

  const { client, requests } = scripted([
    { error: failure("interrupted") },
    { calls: [read("1", "a.ts")] },
    { error: failure("interrupted") },
    { error: failure("interrupted") },
    "Done."
  ])
  const reply = await collect(
    withTools(client, workspaceTools(workspace({ "a.ts": "x\n" })), { mode: "native", providerRetryDelayMs: 0 }).chat(ask("Read it."))
  )
  assert.ok(reply.text.endsWith("Done."))
  assert.strictEqual(requests.length, 5, "a success between failures restores the retry budget")
})

test("a retry waits, and a stop during the wait sends nothing further", async () => {
  const { client, requests } = scripted([{ error: failure("interrupted") }, "Done."])
  const host = new AbortController()
  const started = Date.now()
  const stream = collect(
    withTools(client, workspaceTools(workspace({})), { mode: "native", providerRetryDelayMs: 5000 }).chat(ask("Answer."), { signal: host.signal })
  )
  setTimeout(() => host.abort(new Error("host stopped")), 50)
  await assert.rejects(stream, (error: unknown) => isCancelled(error))
  assert.ok(Date.now() - started < 2000, "the wait ends when the host stops")
  assert.strictEqual(requests.length, 1, "no second request after the stop")
})

test("arguments keyed args, input or params reach the tool", async () => {
  const root = workspace({ "a.ts": "export const a = 1\n" })
  for (const key of ["args", "input", "params"]) {
    const { client } = scripted([`\`\`\`tool\n{"name": "read_file", "${key}": {"path": "a.ts"}}\n\`\`\``, "Done."])
    const steps: ToolStep[] = []
    await collect(withTools(client, workspaceTools(root), { onStep: (step) => steps.push(step) }).chat(ask("Read.")))
    assert.strictEqual(steps[0].failed, undefined, key)
    assert.match(steps[0].output, /1: export const a = 1/, key)
  }
})

test("an answer that talks about tool-call tags is an answer, not a broken call", async () => {
  const root = workspace({ "a.ts": "x\n" })
  for (const mode of ["text", "native"] as const) {
    for (const answer of [
      "Qwen wraps calls in `<tool_call>` tags, which Ollama strips from the reply.",
      "Qwen wraps calls in <tool_call> tags, which Ollama strips from the reply."
    ]) {
      const { client, requests } = scripted([answer])
      const steps: ToolStep[] = []
      const { text } = await collect(
        withTools(client, workspaceTools(root), { mode, maxSteps: 2, onStep: (step) => steps.push(step) }).chat(ask("How?"))
      )
      assert.strictEqual(text, answer, `${mode}: ${answer}`)
      assert.strictEqual(steps.length, 0)
      assert.strictEqual(requests.length, 1)
    }
  }
})

test("on the last request a stray call is left out and the answer after it is kept", async () => {
  const root = workspace({ "a.ts": "export const a = 1\n" })
  const call = "```tool\n{\"name\": \"read_file\", \"arguments\": {\"path\": \"a.ts\"}}\n```"
  const { client } = scripted([call, `Let me check once more:\n${call}\nSince I am out of calls: a is 1.`])
  const { text } = await collect(withTools(client, workspaceTools(root), { maxSteps: 1, stepLines: false }).chat(ask("What is a?")))
  assert.strictEqual(text, "Let me check once more:\n\nSince I am out of calls: a is 1.")
})

test("text held back in case it began a call is shown when the calls come natively", async () => {
  const root = workspace({ "a.ts": "export const a = 1\n" })
  const { client } = scripted([
    { text: "Current code:\n```ts\nconst a = 1\n```", calls: [read("1", "a.ts")] },
    { text: "Checking whether a <", calls: [read("2", "a.ts")] },
    "Done."
  ])
  const { text } = await collect(withTools(client, workspaceTools(root), { mode: "native", stepLines: false }).chat(ask("Look.")))
  assert.strictEqual(text, "Current code:\n```ts\nconst a = 1\n```Checking whether a <Done.")
})

test("call markup a server leaves in the text beside native calls is not shown", async () => {
  const root = workspace({ "a.ts": "export const a = 1\n" })
  const { client } = scripted([
    { text: "Reading it.\n<tool_call>\n{\"name\": \"read_file\", \"arguments\": {\"path\": \"a.ts\"", calls: [read("1", "a.ts")] },
    "Done."
  ])
  const { text } = await collect(withTools(client, workspaceTools(root), { mode: "native", stepLines: false }).chat(ask("Read.")))
  assert.strictEqual(text, "Reading it.\nDone.")
})

test("a call fenced as JSON inside tool_call tags is still a call", async () => {
  const root = workspace({ "a.ts": "export const a = 1\n" })
  const { client } = scripted(["<tool_call>\n```json\n{\"name\": \"read_file\", \"arguments\": {\"path\": \"a.ts\"}}\n```\n</tool_call>", "It is 1."])
  const steps: ToolStep[] = []
  const { text } = await collect(
    withTools(client, workspaceTools(root), { stepLines: false, onStep: (step) => steps.push(step) }).chat(ask("What is a?"))
  )
  assert.strictEqual(steps[0]?.name, "read_file")
  assert.strictEqual(steps[0]?.failed, undefined)
  assert.strictEqual(text, "It is 1.")
})

test("the next turn's notes keep what a tool returned, not the folder's instructions ahead of it", async () => {
  const root = workspace({ "lib/AGENTS.md": "x".repeat(3000), "lib/a.ts": "export const answer = 42\n" })
  const { client } = scripted([{ calls: [read("1", "lib/a.ts")] }, "42."])
  let notes: string | undefined
  await collect(withTools(client, workspaceTools(root), { mode: "native", onNotes: (n) => (notes = n) }).chat(ask("Read.")))
  assert.match(notes ?? "", /1: export const answer = 42/)
  assert.doesNotMatch(notes ?? "", /xxxx/)
})

test("a reply that ends on an edit waiting for review says so, not that it ran out of steps", async () => {
  const { client } = scripted([{ calls: [{ id: "1", name: "wait", arguments: "{}" }] }, ""])
  const tools = fakeTools(async () => ({ output: "Proposed.", summary: "proposed an edit", final: true }))
  const { text } = await collect(withTools(client, tools, { mode: "native", stepLines: false }).chat(ask("Fix it.")))
  assert.strictEqual(text, "The change is waiting in the editor for you to accept or reject.")
})

test("calls made together share the room, so the next request has every result whole", async () => {
  const body = Array.from({ length: 400 }, (_, i) => `export const value${i} = ${i}`).join("\n")
  const root = workspace({ "a.ts": body, "b.ts": body, "c.ts": body, "d.ts": body })
  const { client, requests } = scripted([
    { calls: ["a", "b", "c", "d"].map((name, i) => read(String(i), `${name}.ts`)) },
    "Read all four."
  ])
  const trims: number[] = []
  await collect(
    withTools(client, workspaceTools(root), { mode: "native", contextWindow: () => 8192, onTrim: (n) => trims.push(n) }).chat(ask("Read them."))
  )
  const results = requests[1].messages.filter((m) => m.role === "tool").map((m) => String(m.content))
  assert.strictEqual(results.length, 4)
  assert.ok(results.every((result) => !result.includes("[The rest was trimmed")), "none trimmed before the model saw it")
  assert.deepStrictEqual(trims, [])
})

test("a teammate's computer hands back its model's tool calls, and nothing shaped otherwise", () => {
  const frame = (chunk: unknown) => parsePeerFrame(JSON.stringify({ type: "chunk", id: "j1", chunk }))
  const calls = [{ id: "call_a", name: "read_file", arguments: "{}" }]
  assert.deepStrictEqual(frame({ content: "", toolCalls: calls, finishReason: "stop", extra: 1 }), {
    type: "chunk",
    id: "j1",
    chunk: { content: "", finishReason: "stop", toolCalls: calls }
  })
  assert.throws(() => frame({ content: "", toolCalls: [{ id: "a", name: "x", arguments: {} }] }), /toolCalls/)
})

test("a text call that cannot be read is quoted back with what the parser said", async () => {
  const root = workspace({ "a.ts": "x\n" })
  const { client, requests } = scripted(["```tool\n{\"name\": \"read_file\", \"arguments\": {\"path\": 'a.ts'}}\n```", "Done."])
  await collect(withTools(client, workspaceTools(root), { mode: "text" }).chat(ask("Read.")))
  const result = String(requests[1].messages[requests[1].messages.length - 1].content)
  assert.match(result, /could not be read: the call was not valid JSON \(.+\)\./)
  // Read as far as the object went: the stream is cut there, before the closing fence.
  assert.ok(result.includes("You wrote:\n~~~\n```tool\n{\"name\": \"read_file\", \"arguments\": {\"path\": 'a.ts'}}\n~~~"), result)
  assert.match(result, /line breaks inside strings written as \\n/)
})

test("a call repeated with nothing changed in between is answered with a pointer, not run again", async () => {
  const root = workspace({ "a.ts": "one\n", "b.ts": "two\n" })
  const { client, requests } = scripted([
    { calls: [read("1", "a.ts")] },
    { calls: [{ id: "2", name: "read_file", arguments: JSON.stringify({ path: " a.ts " }) }] },
    { calls: [read("3", "b.ts")] },
    "Both read."
  ])
  const steps: ToolStep[] = []
  const tools = workspaceTools(root)
  let runs = 0
  const counting: WorkspaceTools = { ...tools, run: (call, context) => (runs++, tools.run(call, context)) }
  await collect(withTools(client, counting, { mode: "native", onStep: (step) => steps.push(step) }).chat(ask("Read.")))
  assert.strictEqual(runs, 2, "the repeat never reached the tool")
  assert.strictEqual(steps[1].summary, "read `a.ts` · whole file · repeated, not run again")
  const repeat = requests[2].messages[requests[2].messages.length - 1]
  assert.match(String(repeat.content), /^You already called read_file with these same arguments in this reply/)
  assert.ok(requests[3].tools, "one repeat is not enough to stop the reply's tools")
})

test("three consecutive empty searches stop the tool loop and request a final answer", async () => {
  const root = workspace({ "src/a.ts": "export const value = 1\n" })
  const { client, requests } = scripted([
    { calls: [{ id: "1", name: "find_files", arguments: JSON.stringify({ pattern: "missing-one" }) }] },
    { calls: [{ id: "2", name: "find_files", arguments: JSON.stringify({ pattern: "missing-two" }) }] },
    { calls: [{ id: "3", name: "find_files", arguments: JSON.stringify({ pattern: "missing-three" }) }] },
    "I could not find a matching file."
  ])
  const steps: ToolStep[] = []
  await collect(withTools(client, workspaceTools(root), { mode: "native", maxSteps: 100, onStep: (step) => steps.push(step) }).chat(ask("Find it.")))
  assert.equal(steps.length, 3)
  assert.ok(steps.every((step) => step.summary.endsWith("· none")))
  assert.equal(requests.length, 4, "after three empty searches only one final answer request is made")
  assert.equal(requests[3].tools, undefined, "the final answer request cannot start another search cycle")
})

test("three consecutive failed tools stop the tool loop and request a final answer", async () => {
  const root = workspace({ "src/a.ts": "export const value = 1\n" })
  const { client, requests } = scripted([
    { calls: [{ id: "1", name: "read_file", arguments: JSON.stringify({ path: "missing-one.ts" }) }] },
    { calls: [{ id: "2", name: "read_file", arguments: JSON.stringify({ path: "missing-two.ts" }) }] },
    { calls: [{ id: "3", name: "read_file", arguments: JSON.stringify({ path: "missing-three.ts" }) }] },
    "I could not read those files."
  ])
  const steps: ToolStep[] = []
  await collect(withTools(client, workspaceTools(root), { mode: "native", maxSteps: 100, onStep: (step) => steps.push(step) }).chat(ask("Read them.")))
  assert.equal(steps.length, 3)
  assert.ok(steps.every((step) => step.failed))
  assert.equal(requests.length, 4, "after three failed calls only one final answer request is made")
  assert.equal(requests[3].tools, undefined)
})

test("identical invalid calls end the tool loop after three failures instead of repeating", async () => {
  const root = workspace({ "src/a.ts": "one\ntwo\nthree\n" })
  const invalid = JSON.stringify({ path: "src/a.ts", start_line: "1", end_line: "3", full_line: "true" })
  const { client, requests } = scripted([
    { calls: [{ id: "1", name: "read_file", arguments: invalid }] },
    { calls: [{ id: "2", name: "read_file", arguments: invalid }] },
    { calls: [{ id: "3", name: "read_file", arguments: invalid }] },
    "I could not read it with full_line."
  ])
  const steps: ToolStep[] = []
  await collect(withTools(client, workspaceTools(root), { mode: "native", maxSteps: 100, onStep: (step) => steps.push(step) }).chat(ask("Read it.")))
  assert.equal(steps.length, 3)
  assert.ok(steps.every((step) => step.failed && /full_line/.test(step.summary)), steps.map((step) => step.summary).join("\n"))
  assert.equal(requests.length, 4, "three identical failures end the loop with one final answer request")
  assert.equal(requests[3].tools, undefined)
})

test("an already-stopped tool loop does not send another model request", async () => {
  const stop = new AbortController()
  stop.abort()
  const { client, requests } = scripted(["must not run"])
  await assert.rejects(collect(withTools(client, workspaceTools(workspace({}),), { mode: "native" }).chat(ask("Stop."), { signal: stop.signal })), isCancelled)
  assert.equal(requests.length, 0)
})

test("an already-aborted inference signal does not start a provider request", async () => {
  const controller = new AbortController()
  controller.abort()
  let started = false
  const source: AsyncIterable<string> = {
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          started = true
          return { done: false as const, value: "unexpected" }
        },
        return: async () => ({ done: true as const, value: undefined })
      }
    }
  }
  await assert.rejects(async () => {
    for await (const chunk of abortable(source, controller.signal)) void chunk
  }, isCancelled)
  assert.equal(started, false)
})

test("a read after a change runs again, and so does one whose result was trimmed away", async () => {
  const root = workspace({ "a.ts": "one\n" })
  const edits = {
    mode: "apply" as const,
    edit: async (file: string) => {
      fs.writeFileSync(file, "two\n")
      return { ok: true, message: "Applied." }
    },
    create: async () => ({ ok: true, message: "Created." })
  }
  const { client } = scripted([
    { calls: [read("1", "a.ts")] },
    { calls: [{ id: "2", name: "edit_file", arguments: JSON.stringify({ path: "a.ts", find: "one", replace: "two" }) }] },
    { calls: [read("3", "a.ts")] },
    "Changed."
  ])
  const steps: ToolStep[] = []
  await collect(withTools(client, workspaceTools(root, [], { edits }), { mode: "native", onStep: (step) => steps.push(step) }).chat(ask("Change.")))
  assert.strictEqual(steps[2].summary, "read `a.ts` · whole file")
  assert.match(steps[2].output, /1: two/)

  const body = Array.from({ length: 60 }, (_, i) => `const value${i} = "${"x".repeat(30)}"`).join("\n")
  const big = workspace({ "a.ts": body, "b.ts": body, "c.ts": body })
  const again = scripted([
    { calls: [read("1", "a.ts")] },
    { calls: [read("2", "b.ts")] },
    { calls: [read("3", "c.ts")] },
    { calls: [read("4", "a.ts")] },
    "Read."
  ])
  const later: ToolStep[] = []
  await collect(
    withTools(again.client, workspaceTools(big), { mode: "native", contextWindow: () => 4096, onStep: (step) => later.push(step) }).chat(
      ask("Read.")
    )
  )
  assert.ok(!later[3].summary.includes("repeated"), "a.ts was trimmed out of the context, so it is read again")
})

test("a model going round in circles is asked for its answer instead of using up every step", async () => {
  const root = workspace({ "a.ts": "one\n" })
  const { client, requests } = scripted([
    { calls: [read("1", "a.ts")] },
    { calls: [read("2", "a.ts")] },
    { calls: [read("3", "a.ts")] },
    { calls: [read("4", "a.ts")] },
    "It says one."
  ])
  let outOfSteps = 0
  const { text } = await collect(
    withTools(client, workspaceTools(root), { mode: "native", stepLines: false, onOutOfSteps: () => outOfSteps++ }).chat(ask("Read."))
  )
  assert.strictEqual(requests.length, 5)
  assert.strictEqual(requests[4].tools, undefined, "after three repeats the next request offers no tools")
  assert.match(String(requests[4].messages[requests[4].messages.length - 1].content), /out of tool calls/)
  assert.strictEqual(text, "It says one.")
  assert.strictEqual(outOfSteps, 0, "going round in circles is not running out of steps")

  const unreadable = scripted(["```tool\n{oops}\n```", "```tool\n{oops}\n```", "```tool\n{oops}\n```", ""])
  const { text: said } = await collect(
    withTools(unreadable.client, workspaceTools(root), { mode: "text", stepLines: false }).chat(ask("Read."))
  )
  assert.strictEqual(unreadable.requests.length, 4, "three unreadable calls in a row, then the answer")
  assert.match(said, /going round in circles/)
})

test("using every step is reported, so the chat can offer to continue", async () => {
  const root = workspace({ "a.ts": "one\n", "b.ts": "two\n" })
  const { client } = scripted([{ calls: [read("1", "a.ts")] }, { calls: [read("2", "b.ts")] }, ""])
  let outOfSteps = 0
  const { text } = await collect(
    withTools(client, workspaceTools(root), { mode: "native", maxSteps: 2, stepLines: false, onOutOfSteps: () => outOfSteps++ }).chat(
      ask("Read.")
    )
  )
  assert.strictEqual(outOfSteps, 1)
  assert.match(text, /ran out of tool steps .* Continue, and I will carry on/)

  const early = scripted([{ calls: [read("1", "a.ts")] }, "Done."])
  let reported = 0
  await collect(withTools(early.client, workspaceTools(root), { mode: "native", maxSteps: 2, onOutOfSteps: () => reported++ }).chat(ask("Read.")))
  assert.strictEqual(reported, 0)
})

test("what the user sends mid-reply reaches the model at its next step, and the next turn's notes", async () => {
  const root = workspace({ "a.ts": "one\n", "b.ts": "two\n" })
  const waiting = ["Look in b.ts instead."]
  let asked = 0
  let notes: string | undefined
  const steering = () => (asked++, waiting.splice(0))
  const { client, requests } = scripted([{ calls: [read("1", "a.ts")] }, { calls: [read("2", "b.ts")] }, "b.ts says two."])
  await collect(
    withTools(client, workspaceTools(root), { mode: "native", steering, onNotes: (n) => (notes = n) }).chat(ask("Read a.ts."))
  )
  assert.strictEqual(asked, 2, "asked before each request after the first")
  const second = requests[1].messages
  assert.deepStrictEqual(second.slice(-2).map((m) => m.role), ["tool", "user"])
  assert.strictEqual(
    second[second.length - 1].content,
    "While you were working, the user wrote:\n\nLook in b.ts instead.\n\nTake that into account and carry on."
  )
  assert.strictEqual(requests[2].messages.filter((m) => m.role === "user").length, 2, "said once, kept in the conversation")
  assert.match(notes ?? "", /The user, while you worked: Look in b\.ts instead\./)

  const text = scripted(["```tool\n{\"name\": \"read_file\", \"arguments\": {\"path\": \"a.ts\"}}\n```", "Done."])
  const queue = ["Also check b.ts.", "And be brief."]
  await collect(withTools(text.client, workspaceTools(root), { mode: "text", steering: () => queue.splice(0) }).chat(ask("Read.")))
  const last = text.requests[1].messages[text.requests[1].messages.length - 1]
  assert.strictEqual(last.role, "user")
  assert.match(
    String(last.content),
    /^<tool_result name="read_file">[\s\S]*<\/tool_result>\n\nWhile you were working, the user wrote these messages:\n\nAlso check b\.ts\.\n\nAnd be brief\.\n\nTake that/
  )
})

test("what the user said mid-reply in text mode outlasts the result it followed being trimmed", async () => {
  const body = Array.from({ length: 60 }, (_, i) => `const value${i} = "${"x".repeat(30)}"`).join("\n")
  const root = workspace({ "a.ts": body, "b.ts": body, "c.ts": body, "d.ts": body })
  const readCall = (file: string) => "```tool\n" + JSON.stringify({ name: "read_file", arguments: { path: file } }) + "\n```"
  const { client, requests } = scripted([readCall("a.ts"), readCall("b.ts"), readCall("c.ts"), readCall("d.ts"), "All read."])
  const waiting = ["Only the constants matter."]
  let trims = 0
  await collect(
    withTools(client, workspaceTools(root), {
      mode: "text",
      contextWindow: () => 4096,
      steering: () => waiting.splice(0),
      onTrim: (n) => (trims += n)
    }).chat(ask("Read them."))
  )
  assert.ok(trims > 0, "the first result was trimmed")
  const first = String(requests[requests.length - 1].messages[3].content)
  assert.match(first, /^<tool_result name="read_file">\n[\s\S]*trimmed to save context[\s\S]*<\/tool_result>\n\nWhile you were working, the user wrote:\n\nOnly the constants matter\./)
})

test("a read that failed is tried again rather than pointed back to", async () => {
  const root = workspace({ "a.ts": "one\n" })
  const { client } = scripted([
    { calls: [read("1", "missing.ts")] },
    { calls: [read("2", "missing.ts")] },
    "Not there."
  ])
  const steps: ToolStep[] = []
  await collect(withTools(client, workspaceTools(root), { mode: "native", onStep: (step) => steps.push(step) }).chat(ask("Read.")))
  assert.ok(steps[1].failed && !steps[1].summary.includes("repeated"), steps[1].summary)
})

test("run_command exposes trusted output and exit-code provenance to the completed-tool callback", async () => {
  const root = workspace({ "README.md": "test" })
  const tools = workspaceTools(root, [], {
    instructions: false,
    commands: {
      mode: "allow",
      run: async (command) => ({ ran: true, output: `verified ${command}`, exitCode: 0 })
    }
  })
  const { client } = scripted([
    { calls: [{ id: "command-1", name: "run_command", arguments: JSON.stringify({ command: "npm test" }) }] },
    "The command passed."
  ])
  const observations: { name: string; exitCode?: number; output?: string }[] = []
  await collect(withTools(client, tools, {
    mode: "native",
    onToolResult: (call, result) => { observations.push({ name: call.name, exitCode: result.execution?.exitCode, output: result.execution?.output }) }
  }).chat(ask("Run the tests.")))
  assert.deepStrictEqual(observations, [{ name: "run_command", exitCode: 0, output: "verified npm test" }])
})


test("a catastrophic tool result stops the current batch before another mutation dispatch", async () => {
  const calls: string[] = []
  let stopped = false
  const { client, requests } = scripted([{ calls: [
    { id: "1", name: "edit_file", arguments: JSON.stringify({ path: "panel.tsx" }) },
    { id: "2", name: "edit_file", arguments: JSON.stringify({ path: "panel.tsx" }) }
  ] }, "should not be requested"])
  const tools: WorkspaceTools = {
    tools: [{ name: "edit_file", description: "edit", parameters: [], run: async () => ({ output: "", summary: "" }) }],
    orientation: "",
    run: async (call) => {
      calls.push(call.name)
      return { output: "catastrophic regression", summary: "regression", failed: true }
    }
  }
  await collect(withTools(client, tools, {
    mode: "native",
    shouldStop: () => stopped,
    onToolResult: async () => { stopped = true }
  }).chat(ask("edit")))
  assert.deepStrictEqual(calls, ["edit_file"], "the blocked second call never reaches WorkspaceTools.run")
  assert.equal(requests.length, 1, "no implementing-model continuation request is issued inside the unsafe turn")
})

test("a stopped chat restores queued messages instead of dispatching another request", () => {
  assert.equal(shouldResumeQueuedChat(false, false), true, "normal completion drains the queue")
  assert.equal(shouldResumeQueuedChat(true, false), false, "a user stop does not drain the queue")
  assert.equal(shouldResumeQueuedChat(false, true), false, "a host cancellation does not drain the queue")
})

const turnText = (message: ChatCompletionMessage): string =>
  typeof message.content === "string"
    ? message.content
    : (message.content as Array<{ text: string }>).map((part) => part.text).join("")

test("a Markdown message reaches the model as written, in history and as the new question", async () => {
  const context = { systemPrompt: async () => "s", additionalContext: async () => "" }
  const markdown = "## Steps\n\n1. **Read** `a.ts`\n\n> note <u>this</u>\n\n```ts\nconst a = 1\n```"
  const turn = await buildChatTurn(
    [
      { role: "user", content: markdown, contentFormat: "markdown" },
      { role: "assistant", content: "Read it." },
      { role: "user", content: markdown, contentFormat: "markdown" }
    ] as ChatCompletionMessage[],
    context
  )
  assert.strictEqual(turnText(turn[1]), markdown, "history keeps the Markdown")
  assert.strictEqual(turnText(turn[3]), markdown, "the new question keeps the Markdown")
})

test("an HTML message from before Markdown composing reaches the model as its plain text", async () => {
  const context = { systemPrompt: async () => "s", additionalContext: async () => "" }
  const turn = await buildChatTurn(
    [{ role: "user", content: "<p>Use <strong>bold</strong> &amp; go</p>" }] as ChatCompletionMessage[],
    context
  )
  assert.strictEqual(turnText(turn[turn.length - 1]), "Use bold & go")
})

test("a continued Markdown question keeps its Markdown, after the previous reply's notes", async () => {
  const context = { systemPrompt: async () => "s", additionalContext: async () => "" }
  const turn = await buildChatTurn(
    [
      { role: "user", content: "- a\n- b", contentFormat: "markdown" },
      { role: "assistant", content: "", toolNotes: "read_file {\"path\":\"a.ts\"}\n1: x" },
      { role: "user", content: "1. **go on**", contentFormat: "markdown" }
    ] as ChatCompletionMessage[],
    context
  )
  assert.ok(turnText(turn[turn.length - 1]).endsWith("1. **go on**"), "the question is the Markdown the user wrote")
})
