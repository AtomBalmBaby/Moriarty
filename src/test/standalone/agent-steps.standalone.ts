/**
 * The tool steps one agent reply may take. `twinny.chatToolsMaxSteps` accepts 4
 * to 1000, but the chat used to resolve the limit with a ceiling of its own
 * (100), so a reply configured for 1000 ran out of steps at 100. These tests
 * keep the range the setting declares and the number the tool loop is given
 * the same thing, and keep one step meaning one model request however many
 * calls that request carries.
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { agentStepLimit, agentStepLimitNotice, MAX_STEPS_SETTING, MIN_STEPS_SETTING } from "../../common/agents"
import { DEFAULT_AGENT_STEPS } from "../../common/constants/misc"
import { ChatChunk, ChatRequest, InferenceClient } from "../../extension/inference"
import { ToolStep, withTools } from "../../extension/tools/loop"
import { workspaceTools } from "../../extension/tools/workspace"

const properties = (JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
  contributes: { configuration: { properties: Record<string, Record<string, unknown>> } }
}).contributes.configuration.properties

type Call = { id: string; name: string; arguments: string }
type Reply = string | { calls: Call[] }

/** A client that plays the scripted replies in turn and records each request. */
const scripted = (replies: Reply[]) => {
  const requests: ChatRequest[] = []
  const client = {
    id: "scripted",
    chat(request: ChatRequest) {
      requests.push(structuredClone(request))
      const next = replies.shift() ?? ""
      const reply = typeof next === "string" ? { text: next, calls: undefined } : { text: "", calls: next.calls }
      return (async function* (): AsyncGenerator<ChatChunk> {
        for (let i = 0; i < reply.text.length; i += 7) yield { content: reply.text.slice(i, i + 7) }
        if (reply.calls) yield { content: "", toolCalls: reply.calls, finishReason: "stop" }
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-step-limit-"))
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), content)
  }
  return root
}

const read = (id: string, file: string): Call => ({ id, name: "read_file", arguments: JSON.stringify({ path: file }) })
const ask = (content: string): ChatRequest => ({ model: "m", messages: [{ role: "user", content }] })

test("the range the settings declare is the range the code uses", () => {
  const setting = properties["twinny.chatToolsMaxSteps"]
  assert.equal(setting.type, "number")
  assert.equal(setting.minimum, MIN_STEPS_SETTING, "the code's minimum is the setting's")
  assert.equal(setting.maximum, MAX_STEPS_SETTING, "the code's maximum is the setting's, not a lower ceiling")
  assert.equal(setting.default, DEFAULT_AGENT_STEPS)
})

test("a configured step limit of 1000 is used as it was set", () => {
  assert.deepStrictEqual(agentStepLimit(1000, DEFAULT_AGENT_STEPS), { configured: 1000, effective: 1000 })
  assert.equal(agentStepLimitNotice(agentStepLimit(1000, DEFAULT_AGENT_STEPS)), undefined, "nothing to report when the two are the same number")
  // The ceiling of 100 imposed itself on every number above it; none of these is bounded now.
  for (const steps of [MIN_STEPS_SETTING, 12, 30, 100, 101, 150, 500, 999, MAX_STEPS_SETTING]) {
    assert.equal(agentStepLimit(steps, DEFAULT_AGENT_STEPS).effective, steps, `${steps} tool steps`)
  }
  assert.equal(agentStepLimit(2, DEFAULT_AGENT_STEPS).effective, MIN_STEPS_SETTING, "below the declared minimum")
  assert.equal(agentStepLimit(2000, DEFAULT_AGENT_STEPS).effective, MAX_STEPS_SETTING, "above the declared maximum")
  assert.equal(agentStepLimit(undefined, DEFAULT_AGENT_STEPS).effective, DEFAULT_AGENT_STEPS, "unset keeps the setting's default")
  assert.equal(agentStepLimit(Number.NaN, DEFAULT_AGENT_STEPS).effective, DEFAULT_AGENT_STEPS, "not a number")
  assert.equal(agentStepLimit(0, DEFAULT_AGENT_STEPS).effective, MIN_STEPS_SETTING, "zero is bounded by the declared minimum")
  assert.equal(agentStepLimit(-5, DEFAULT_AGENT_STEPS).effective, MIN_STEPS_SETTING, "a negative value is bounded by the declared minimum, as it was")
  assert.equal(agentStepLimit(1000.4, DEFAULT_AGENT_STEPS).effective, 1000, "rounded, as the other settings are")
})

test("when the reply cannot use the number the settings hold, the notice names both", () => {
  const high = agentStepLimit(2000, DEFAULT_AGENT_STEPS)
  const notice = agentStepLimitNotice(high) ?? ""
  assert.match(notice, /you set 2000/, notice)
  assert.match(notice, /replies use 1000/, notice)
  assert.ok(!notice.includes("you set 1000"), notice)

  const low = agentStepLimit(1, DEFAULT_AGENT_STEPS)
  const said = agentStepLimitNotice(low) ?? ""
  assert.match(said, /you set 1/, said)
  assert.match(said, /replies use 4/, said)

  assert.equal(agentStepLimitNotice(agentStepLimit(40, DEFAULT_AGENT_STEPS)), undefined, "a value inside the range is not reported")
})

test("the tool loop runs to a limit of 1000, not to a ceiling of 100", async () => {
  const files = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`a${i}.ts`, `line ${i}\n`]))
  const root = workspace(files)
  try {
    const limit = agentStepLimit(1000, DEFAULT_AGENT_STEPS)
    const { client, requests } = scripted([
      ...Array.from({ length: 101 }, (_, i) => ({ calls: [read(String(i), `a${i}.ts`)] })),
      "Read them all."
    ])
    let outOfSteps = 0
    const { text } = await collect(
      withTools(client, workspaceTools(root), { mode: "native", stepLines: false, maxSteps: limit.effective, onOutOfSteps: () => outOfSteps++ }).chat(ask("Read them."))
    )
    assert.equal(requests.length, 102, "the reply went past the 100 the code used to impose")
    assert.equal(outOfSteps, 0, "1000 steps were available, so it did not run out")
    assert.equal(text, "Read them all.")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("one step is one model request, whatever it carries, and running out is reported at the limit", async () => {
  const root = workspace({
    "a1.ts": "one\n",
    "a2.ts": "two\n",
    "b1.ts": "three\n",
    "b2.ts": "four\n",
    "c1.ts": "five\n",
    "c2.ts": "six\n",
    "d1.ts": "seven\n",
    "d2.ts": "eight\n"
  })
  try {
    const limit = agentStepLimit(4, DEFAULT_AGENT_STEPS)
    assert.equal(limit.effective, 4, "inside the range, so the number is used as it was set")
    const { client, requests } = scripted([
      { calls: [read("1", "a1.ts"), read("2", "a2.ts")] },
      { calls: [read("3", "b1.ts"), read("4", "b2.ts")] },
      { calls: [read("5", "c1.ts"), read("6", "c2.ts")] },
      { calls: [read("7", "d1.ts"), read("8", "d2.ts")] },
      "Eight calls, four requests."
    ])
    const steps: ToolStep[] = []
    let outOfSteps = 0
    await collect(
      withTools(client, workspaceTools(root), {
        mode: "native",
        stepLines: false,
        maxSteps: limit.effective,
        onStep: (step) => steps.push(step),
        onOutOfSteps: () => outOfSteps++
      }).chat(ask("Read them."))
    )
    assert.equal(new Set(steps.map((step) => step.index)).size, 4, "eight calls in four requests")
    assert.equal(steps.length, 8, "each call is still shown as its own step")
    assert.equal(requests.length, 5, "the request that answers is not a step of its own")
    assert.equal(outOfSteps, 1, "the answer came on the request the limit ended, which offered no tools")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("both agent-loop construction paths take the limit from the same place", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "src/extension/chat/index.ts"), "utf8")
  assert.equal((source.match(/maxSteps: this\.agentStepsForReply\(\)/g) ?? []).length, 2, "the native TODO tools path and the agent tools path")
  assert.ok(/private agentStepsForReply\(\): number \{/.test(source), "the two paths share one resolution")
  assert.ok(!/Math\.min\(MAX_STEPS_SETTING/.test(source), "neither path applies a ceiling of its own")
})
