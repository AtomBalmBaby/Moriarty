/**
 * What the trace says a tool-loop request is made of. Every row is measured
 * from what is sent, so the rows must add up to the characters of the
 * request, whichever mode, step, or instruction file it has.
 */
import * as assert from "node:assert"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"

import { ChatChunk, ChatRequest, InferenceClient } from "../../extension/inference"
import {
  BreakdownRow,
  buildBreakdown,
  formatCountedTokens,
  formatRequestBreakdown,
  groupDigits,
  RequestBreakdown,
  RowChars
} from "../../extension/tools/context-breakdown"
import { steeringMessage, ToolMode, withTools } from "../../extension/tools/loop"
import { FINAL_ANSWER_PROMPT, toolDefinition } from "../../extension/tools/protocol"
import { workspaceTools } from "../../extension/tools/workspace"

type Call = { id: string; name: string; arguments: string }
type Reply = string | { text?: string; calls?: Call[]; usage?: { promptTokens?: number } }

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
        if (reply.text) yield { content: reply.text }
        if (reply.calls) yield { content: "", toolCalls: reply.calls, finishReason: "stop" }
        if (reply.usage) yield { content: "", usage: reply.usage }
      })()
    }
  } as unknown as InferenceClient
  return { client, requests }
}

const collect = async (stream: AsyncIterable<ChatChunk>) => {
  for await (const _ of stream) void _
}

const workspace = (files: Record<string, string>) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-breakdown-"))
  for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(root, file), content)
  return root
}

const read = (id: string, file: string): Call => ({ id, name: "read_file", arguments: JSON.stringify({ path: file }) })
const ask = (content: string): ChatRequest => ({ model: "m", messages: [{ role: "user", content }] })
const withSystem = (content: string, question: string): ChatRequest => ({
  model: "m",
  messages: [
    { role: "system", content },
    { role: "user", content: question }
  ]
})

/** Every request's characters and breakdown, as the loop reports them. */
const recorder = () => {
  const seen: { chars: number; breakdown: RequestBreakdown }[] = []
  const counted: { step: number; tokens: number }[] = []
  return {
    seen,
    counted,
    options: {
      onRequest: (chars: number, _step: number, _mode: ToolMode, _tokens: number, breakdown: RequestBreakdown) =>
        seen.push({ chars, breakdown }),
      onRequestCounted: (step: number, _breakdown: RequestBreakdown, promptTokens: number) =>
        counted.push({ step, tokens: promptTokens })
    }
  }
}

const chars = (breakdown: RequestBreakdown, row: BreakdownRow) => breakdown.rows.find((line) => line.row === row)!.chars

const assertAddsUp = (seen: { chars: number; breakdown: RequestBreakdown }[]) => {
  assert.ok(seen.length > 0, "the loop reported its requests")
  for (const { chars: sent, breakdown } of seen) {
    assert.strictEqual(breakdown.chars, sent, "the rows add up to the characters sent")
    assert.ok(breakdown.rows.every((line) => line.chars >= 0), "no row is negative")
  }
}

const zeros = (over: Partial<RowChars>): RowChars => ({
  system: 0,
  toolInstructions: 0,
  projectInstructions: 0,
  schemas: 0,
  context: 0,
  history: 0,
  calls: 0,
  results: 0,
  closing: 0,
  ...over
})

test("a native request names its system prompt, schemas, context, history, calls and results", async () => {
  const root = workspace({ "a.ts": "export const a = 1\n" })
  const tools = workspaceTools(root)
  const context = "Task: read a.ts.\nTODO: 1 of 2 done."
  const { client, requests } = scripted([{ calls: [read("1", "a.ts")] }, { text: "a.ts exports a.", usage: { promptTokens: 4321 } }])
  const rec = recorder()
  await collect(
    withTools(client, tools, { mode: "native", requestContext: () => context, ...rec.options }).chat(
      withSystem("You are twinny.", "Read a.ts.")
    )
  )
  assertAddsUp(rec.seen)
  const [first, second] = rec.seen.map((entry) => entry.breakdown)

  assert.strictEqual(chars(first, "system"), "You are twinny.".length + 2, "agent instructions, and the separator after them")
  assert.strictEqual(chars(first, "context"), context.length + 2, "the TODO context, with its separator")
  assert.strictEqual(chars(first, "schemas"), JSON.stringify(tools.tools.map(toolDefinition)).length, "the schemas the loop sends")
  assert.strictEqual(chars(first, "history"), "Read a.ts.".length, "the user's question is history")
  assert.strictEqual(chars(first, "results"), 0)

  const toolMessage = requests[1].messages.find((m) => m.role === "tool")
  assert.strictEqual(chars(second, "results"), String(toolMessage?.content).length, "the tool result is results")
  assert.strictEqual(chars(second, "calls"), "read_file".length + read("1", "a.ts").arguments.length, "the call the model made")
  assert.strictEqual(chars(second, "history"), "Read a.ts.".length, "no assistant text, so only the question")
  assert.deepStrictEqual(rec.counted, [{ step: 1, tokens: 4321 }], "the server's count is set against the second request")
})

test("the closing request offers no schemas and carries the closing prompt", async () => {
  const root = workspace({ "a.ts": "one\n" })
  const { client } = scripted([{ calls: [read("1", "a.ts")] }, "Done without a closing prompt."])
  const rec = recorder()
  await collect(withTools(client, workspaceTools(root), { mode: "native", maxSteps: 1, ...rec.options }).chat(ask("Read.")))
  assertAddsUp(rec.seen)
  const [offered, closing] = rec.seen.map((entry) => entry.breakdown)
  assert.ok(chars(offered, "schemas") > 0)
  assert.strictEqual(chars(closing, "schemas"), 0, "no tools on the last request")
  assert.strictEqual(chars(closing, "closing"), FINAL_ANSWER_PROMPT.length, "the closing prompt is its own turn after a native result")
})

test("text-mode steering counts as history, and the result it follows stays results", async () => {
  const root = workspace({ "a.ts": "one\n" })
  const steer = "Also check b.ts."
  const queue = [steer]
  const { client, requests } = scripted([
    "```tool\n{\"name\": \"read_file\", \"arguments\": {\"path\": \"a.ts\"}}\n```",
    "Done."
  ])
  const rec = recorder()
  await collect(
    withTools(client, workspaceTools(root), { mode: "text", steering: () => queue.splice(0), ...rec.options }).chat(ask("Read."))
  )
  assertAddsUp(rec.seen)
  const [, question, reply, result] = requests[1].messages
  const said = steeringMessage([steer])
  const second = rec.seen[1].breakdown
  assert.strictEqual(chars(second, "results"), String(result.content).length - (2 + said.length), "the result, without the steering")
  assert.strictEqual(
    chars(second, "history"),
    String(question.content).length + String(reply.content).length + 2 + said.length,
    "the question, the reply, and what the user said"
  )
  assert.strictEqual(chars(second, "schemas"), 0, "text mode describes the tools in the system prompt")
  assert.strictEqual(chars(second, "calls"), 0, "text-mode calls are in the reply text")
})

test("the rows add up when instructions and context end in whitespace, in both modes", async () => {
  for (const mode of ["native", "text"] as const) {
    const root = workspace({ "a.ts": "one\n" })
    const tools = { ...workspaceTools(root), instructions: { path: "AGENTS.md", text: "Be brief.\n\n\n" } }
    const { client } = scripted([{ calls: [read("1", "a.ts")] }, "Done."])
    const rec = recorder()
    await collect(
      withTools(client, tools, { mode, requestContext: () => "Task: read a.ts.\n\n", ...rec.options }).chat(
        withSystem("You are twinny.\n", "Read.")
      )
    )
    assertAddsUp(rec.seen)
    assert.ok(chars(rec.seen[0].breakdown, "projectInstructions") > 0, `${mode}: the project instructions have their own row`)
  }
})

test("a request with no system message still adds up, with nothing in the system row", async () => {
  const root = workspace({ "a.ts": "one\n" })
  const { client } = scripted(["Done."])
  const rec = recorder()
  await collect(withTools(client, workspaceTools(root), { mode: "text", ...rec.options }).chat(ask("Hi.")))
  assertAddsUp(rec.seen)
  assert.strictEqual(chars(rec.seen[0].breakdown, "system"), 0)
})

test("the grouping of digits reads as people write numbers", () => {
  assert.strictEqual(groupDigits(0), "0")
  assert.strictEqual(groupDigits(999), "999")
  assert.strictEqual(groupDigits(1000), "1,000")
  assert.strictEqual(groupDigits(10100), "10,100")
  assert.strictEqual(groupDigits(1234567), "1,234,567")
})

test("each row rounds up to tokens, and the total is the sum of the rows", () => {
  const breakdown = buildBreakdown(zeros({ system: 10, schemas: 7 }), 3)
  assert.strictEqual(breakdown.rows.find((line) => line.row === "system")?.tokens, 4)
  assert.strictEqual(breakdown.rows.find((line) => line.row === "schemas")?.tokens, 3)
  assert.strictEqual(breakdown.tokens, 7)
  assert.strictEqual(breakdown.chars, 17)
  assert.strictEqual(breakdown.charsPerToken, 3)
})

test("the trace block lists each part with tokens and characters, then a total", () => {
  const breakdown = buildBreakdown(
    zeros({ system: 3600, schemas: 8400, context: 2700, history: 3000, results: 12600 }),
    3
  )
  const text = formatRequestBreakdown(9, "native", breakdown)
  assert.match(text, /^\[Context\] tool-loop request 9 \(native, ~3\.0 chars per token\)$/m)
  assert.match(text, /^ {2}system \/ agent instructions\s+1,200 tokens\s+\(\s*3,600 chars\)$/m)
  assert.match(text, /^ {2}tool schemas\s+2,800 tokens\s+\(\s*8,400 chars\)$/m)
  assert.match(text, /^ {2}TODO \/ evidence context\s+900 tokens\s+\(\s*2,700 chars\)$/m)
  assert.match(text, /^ {2}tool results\s+4,200 tokens\s+\(\s*12,600 chars\)$/m)
  assert.match(text, /^ {2}-+$/m)
  assert.match(text, /^ {2}total\s+10,100 tokens\s+\(\s*30,300 chars\)$/m)
})

test("the server's count is set against the breakdown's estimate", () => {
  const breakdown = buildBreakdown(zeros({ system: 30900 }), 3)
  assert.strictEqual(breakdown.tokens, 10300)
  assert.strictEqual(
    formatCountedTokens(9, breakdown, 10000),
    "[Context] tool-loop request 9 · server counted 10,000 prompt tokens; breakdown estimated 10,300 (+3.0%)"
  )
  assert.strictEqual(
    formatCountedTokens(9, breakdown, 11000),
    "[Context] tool-loop request 9 · server counted 11,000 prompt tokens; breakdown estimated 10,300 (-6.4%)"
  )
})
