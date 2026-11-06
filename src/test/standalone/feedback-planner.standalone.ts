import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { logger } from "../../common/logger"
import type { TodoListSnapshot } from "../../common/types"
import { FeedbackGate, FeedbackPlanner, type FeedbackPlanRepository,parseFeedbackPlanResponse } from "../../extension/chat/feedback-planner"
import { replyText, type RoleInference, type RoleReply, type RoleResolution,structuredReply } from "../../extension/chat/role-inference"
import { readReply } from "../../extension/inference/stream"
import type { ChatChunk } from "../../extension/inference/types"
import { TodoRepository } from "../../extension/todos/repository"

const wasmPath = path.join(process.cwd(), "out", "sql-wasm.wasm")

const quietly = async <T>(run: () => Promise<T>) => {
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

const plan = (overrides: Record<string, unknown> = {}) => ({
  planId: "plan-a",
  version: 1,
  revision: 1,
  goal: "Fix the parser",
  constraints: [],
  tasks: [
    { id: "inspect", title: "Inspect parser", description: "Find the bug", acceptanceCriteria: ["Bug located"], dependencies: [] },
    { id: "fix", title: "Fix parser", description: "Fix the bug", acceptanceCriteria: ["Test passes"], dependencies: ["inspect"] }
  ],
  ...overrides
})

const endpoint = (infer: RoleInference): RoleResolution => ({
  ok: true,
  endpoint: { infer, provider: "scripted", model: "feedback-model", label: "Scripted" }
})

const withRepository = async (run: (repository: TodoRepository) => Promise<void>) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-feedback-planner-"))
  try {
    await run(new TodoRepository(path.join(directory, "todos.sqlite"), wasmPath))
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

const scope = { projectFingerprint: "project", conversationId: "chat" }

test("the Feedback plan response is validated before it can write TODOs", () => {
  assert.deepEqual(parseFeedbackPlanResponse("{\"track\":false,\"plan\":null}"), { track: false })
  const parsed = parseFeedbackPlanResponse(JSON.stringify({ track: true, plan: plan() }))
  assert.ok("plan" in parsed && parsed.plan.tasks.length === 2)
  assert.ok("error" in parseFeedbackPlanResponse(JSON.stringify({ track: true, plan: { ...plan(), tasks: [] } })))
  assert.ok("error" in parseFeedbackPlanResponse(JSON.stringify({ track: true, plan: plan(), prompt: "x" })))
  assert.ok("error" in parseFeedbackPlanResponse("nope"))
})

test("plans TODOs from an ordinary prompt with no compiler involved, and does not duplicate them", async () => {
  await withRepository(async (repository) => {
    const users: string[] = []
    const snapshots: TodoListSnapshot[] = []
    const planner = new FeedbackPlanner({
      enabled: () => true,
      repository: () => repository,
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      // A model that renames the plan and forgets to bump its revision.
      resolve: () => endpoint(async ({ user }) => {
        users.push(user)
        return JSON.stringify({ track: true, plan: users.length === 1 ? plan() : plan({ planId: "renamed", tasks: [...plan().tasks, { id: "verify", title: "Verify", description: "Run tests", acceptanceCriteria: ["Green"], dependencies: ["fix"] }] }) })
      })
    })
    const { result: first } = await quietly(() => planner.start(scope, "Fix the parser."))
    assert.equal(first.status, "planned")
    assert.deepEqual((await repository.getList(scope)).items.map((item) => item.title), ["Inspect parser", "Fix parser"])
    assert.equal(users[0], "Fix the parser.")

    const { result: again } = await quietly(() => planner.start(scope, "Also verify it."))
    assert.equal(again.status, "planned")
    const list = await repository.getList(scope)
    assert.deepEqual(list.items.map((item) => item.title), ["Inspect parser", "Fix parser", "Verify"])
    assert.match(users[1], /Existing TODO plan/)
    assert.equal((await repository.getIntentTaskPlan(scope))?.planId, "plan-a", "the stored identity is kept")
    assert.equal(snapshots.length, 2)
  })
})

test("an untracked message plans nothing; disabled Feedback calls nothing", async () => {
  await withRepository(async (repository) => {
    let calls = 0
    const resolve = () => endpoint(async () => { calls++; return "{\"track\":false,\"plan\":null}" })
    const planner = new FeedbackPlanner({ enabled: () => true, repository: () => repository, resolve })
    assert.equal((await quietly(() => planner.start(scope, "What does this do?"))).result.status, "untracked")
    assert.equal((await repository.getList(scope)).items.length, 0)

    const disabled = new FeedbackPlanner({ enabled: () => false, repository: () => repository, resolve })
    assert.equal((await disabled.start(scope, "Fix it.")).status, "disabled")
    assert.equal(calls, 1)
  })
})

test("provider failures are reported, never shown as an empty plan, and not retried", async () => {
  await withRepository(async (repository) => {
    const failures: string[] = []
    let calls = 0
    const planner = new FeedbackPlanner({
      enabled: () => true,
      repository: () => repository,
      onFailure: (message) => failures.push(message),
      resolve: () => endpoint(async () => { calls++; throw new Error("ChatGPT Plan could not use the connected ChatGPT session. Sign in again.") })
    })
    const { result } = await quietly(() => planner.start(scope, "Fix it."))
    assert.equal(result.status, "failed")
    assert.match(result.error ?? "", /Sign in again/)
    assert.equal(failures.length, 1)
    assert.equal(calls, 1)

    const unavailable = new FeedbackPlanner({
      enabled: () => true,
      repository: () => repository,
      onFailure: (message) => failures.push(message),
      resolve: () => ({ ok: false, error: "Feedback has no provider." })
    })
    assert.deepEqual((await quietly(() => unavailable.start(scope, "Fix it."))).result, { status: "unavailable", error: "Feedback has no provider." })
    assert.equal(failures.at(-1), "Feedback has no provider.")
  })
})

test("a timeout is reported and leaves existing TODOs alone", async () => {
  await withRepository(async (repository) => {
    await repository.synchronizeIntentPlan(scope, plan(), { source: "test" })
    const before = await repository.getList(scope)
    const failures: string[] = []
    const planner = new FeedbackPlanner({
      enabled: () => true,
      repository: () => repository,
      timeoutMs: 20,
      onFailure: (message) => failures.push(message),
      resolve: () => endpoint((_request, { signal }) => new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true })))
    })
    const { result } = await quietly(() => planner.start(scope, "Fix it."))
    assert.equal(result.status, "failed")
    assert.match(result.error ?? "", /timed out/)
    assert.equal(failures.length, 1)
    assert.deepEqual((await repository.getList(scope)).items, before.items)
  })
})

test("cancelled, superseded and late answers never write or revive TODOs", async () => {
  await withRepository(async (repository) => {
    const releases: Array<(value: string) => void> = []
    const failures: string[] = []
    // Ignores the abort signal, so its answers arrive late.
    const planner = new FeedbackPlanner({
      enabled: () => true,
      repository: () => repository,
      onFailure: (message) => failures.push(message),
      resolve: () => endpoint(() => new Promise((resolve) => releases.push(resolve)))
    })
    const { result: cancelled, records } = await quietly(async () => {
      const running = planner.start(scope, "First request")
      await new Promise((resolve) => setTimeout(resolve, 10))
      planner.cancel("user")
      releases[0](JSON.stringify({ track: true, plan: plan({ planId: "late" }) }))
      return running
    })
    assert.ok(["cancelled", "stale"].includes(cancelled.status))
    assert.equal((await repository.getList(scope)).items.length, 0)
    assert.equal(failures.length, 0, "a cancellation is not a failure")
    assert.ok(records.some((record) => record.includes("operation.cancelled")))

    const { result: outcomes } = await quietly(async () => {
      const older = planner.start(scope, "Older request")
      await new Promise((resolve) => setTimeout(resolve, 10))
      const newer = planner.start(scope, "Newer request")
      await new Promise((resolve) => setTimeout(resolve, 10))
      releases[1](JSON.stringify({ track: true, plan: plan({ planId: "older", goal: "Older" }) }))
      releases[2](JSON.stringify({ track: true, plan: plan({ planId: "newer", goal: "Newer" }) }))
      return Promise.all([older, newer])
    })
    assert.ok(["cancelled", "stale"].includes(outcomes[0].status))
    assert.equal(outcomes[1].status, "planned")
    assert.equal((await repository.getIntentTaskPlan(scope))?.planId, "newer")
    assert.equal((await repository.getList(scope)).items.length, 2, "no duplicate TODOs")
  })
})

test("pending() exposes the planning in flight so the turn can reconcile against it", async () => {
  await withRepository(async (repository) => {
    const planner = new FeedbackPlanner({
      enabled: () => true,
      repository: () => repository,
      resolve: () => endpoint(async () => JSON.stringify({ track: true, plan: plan() }))
    })
    assert.equal(planner.pending(), undefined)
    const { result } = await quietly(async () => {
      void planner.start(scope, "Fix it.")
      const pending = planner.pending()
      assert.ok(pending)
      return pending
    })
    assert.equal(result.status, "planned")
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(planner.pending(), undefined)
  })
})

test("planning status moves through planning, failed and retry, and retry replans the last message", async () => {
  await withRepository(async (repository) => {
    const statuses: string[] = []
    let calls = 0
    const planner = new FeedbackPlanner({
      enabled: () => true,
      repository: () => repository,
      onStatus: ({ state, error }) => statuses.push(error ? `${state}:${error}` : state),
      resolve: () => endpoint(async () => {
        calls += 1
        if (calls === 1) throw new Error("Feedback key rejected")
        return JSON.stringify({ track: true, plan: plan() })
      })
    })
    await quietly(() => planner.start(scope, "Fix the parser."))
    assert.deepEqual(statuses, ["planning", "failed:Feedback provider failed: Feedback key rejected"])

    const { result } = await quietly(() => planner.retry(scope.conversationId))
    assert.equal(result.status, "planned")
    assert.deepEqual(statuses, ["planning", "failed:Feedback provider failed: Feedback key rejected", "planning", "planned"])
    assert.equal((await repository.getList(scope)).items.length, 2)
  })
})

test("a superseded planning never reports its outcome, only the newest does", async () => {
  await withRepository(async (repository) => {
    const statuses: string[] = []
    const calls: Array<{ user: string; resolve: (value: string) => void }> = []
    const planner = new FeedbackPlanner({
      enabled: () => true,
      repository: () => repository,
      onStatus: ({ state }) => statuses.push(state),
      resolve: () => endpoint(({ user }) => new Promise((resolve) => calls.push({ user, resolve })))
    })
    const older = planner.start(scope, "First message.")
    const newer = planner.start(scope, "Second message.")
    const newest = async () => {
      const deadline = Date.now() + 2000
      while (!calls.some((call) => call.user.startsWith("Second message.")) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      return calls.find((call) => call.user.startsWith("Second message."))
    }
    const call = await newest()
    assert.ok(call, "the newest planning reaches the Feedback provider")
    call.resolve(JSON.stringify({ track: true, plan: plan() }))
    assert.equal((await newer).status, "planned")
    // An older call may have been aborted before the provider saw it; a late answer must still stay silent.
    calls.filter((other) => other.user.startsWith("First message.")).forEach((other) => other.resolve(JSON.stringify({ track: true, plan: plan({ planId: "stale" }) })))
    assert.notEqual((await older).status, "planned")
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(statuses, ["planning", "planning", "planned"])
  })
})

type Sent = { user: string; json?: boolean }

const validReply = () => JSON.stringify({ track: true, plan: plan() })

const failureOf = (parsed: ReturnType<typeof parseFeedbackPlanResponse>) => ("error" in parsed ? parsed.failure : undefined)

async function* streamOf(...parts: Partial<ChatChunk>[]): AsyncIterable<ChatChunk> {
  for (const part of parts) yield { content: "", ...part } as ChatChunk
}

const asRole = (reply: { content: string; reasoningChars: number; finishReason?: RoleReply["finishReason"] }): RoleReply => ({
  text: reply.content,
  reasoningChars: reply.reasoningChars,
  ...(reply.finishReason ? { finishReason: reply.finishReason } : {})
})

/** Answers in order from `replies`, recording each request sent. */
const scripted = (replies: Array<string | RoleReply>, requests: Sent[] = []): RoleInference => async (request) => {
  requests.push(request)
  const next = replies.shift()
  if (next === undefined) throw new Error("no scripted reply left")
  return next
}

/** A provider call that only ends when its request is cancelled. */
const untilAborted = (signal: AbortSignal) =>
  new Promise<never>((_resolve, reject) => {
    const fail = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
    if (signal.aborted) fail()
    else signal.addEventListener("abort", fail, { once: true })
  })

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** Records the order in which the repository is asked to write the plan. */
const spied = (repository: TodoRepository, order: string[]): FeedbackPlanRepository => ({
  getIntentTaskPlan: (request) => repository.getIntentTaskPlan(request),
  synchronizeIntentPlan: (request, candidate, result) => {
    order.push("sync")
    return repository.synchronizeIntentPlan(request, candidate, result)
  }
})

const plannerWith = (repository: FeedbackPlanRepository, infer: RoleInference, failures: string[] = []) =>
  new FeedbackPlanner({
    enabled: () => true,
    resolve: () => endpoint(infer),
    repository: () => repository,
    onFailure: (message) => failures.push(message)
  })

const gated = (planner: FeedbackPlanner) => {
  const notices: string[] = []
  const gate = new FeedbackGate({ planner, busy: () => false, notify: (message) => notices.push(message) })
  return { gate, notices }
}

test("a Cerebras-style streamed JSON reply is assembled before it is parsed", async () => {
  const reply = await readReply(streamOf(
    { content: "{\"track\":true," },
    { content: "\"plan\":" + JSON.stringify(plan()) },
    { content: "}" },
    { finishReason: "stop" }
  ))
  assert.equal(reply.finishReason, "stop")
  const parsed = parseFeedbackPlanResponse(asRole(reply))
  assert.ok("plan" in parsed && parsed.plan.tasks.length === 2)
})

test("separate reasoning deltas are counted but never leak into the parsed answer", async () => {
  const reply = await readReply(streamOf({ reasoning: "Weigh the two tasks first. " }, { content: validReply() }, { finishReason: "stop" }))
  assert.ok(reply.reasoningChars > 0)
  assert.equal(reply.content, validReply())
  assert.ok("plan" in parseFeedbackPlanResponse(asRole(reply)))
})

test("a plan wrapped in a Markdown fence or a harmony final channel is accepted", () => {
  assert.ok("plan" in parseFeedbackPlanResponse("```json\n" + validReply() + "\n```"))
  const harmony = "<|channel|>analysis<|message|>Compare the tasks.<|end|><|start|>assistant<|channel|>final<|message|>" + validReply()
  assert.ok("plan" in parseFeedbackPlanResponse(harmony))
})

test("empty and reasoning-only replies are named, not reported as invalid JSON", () => {
  assert.equal(failureOf(parseFeedbackPlanResponse("")), "empty")
  assert.equal(failureOf(parseFeedbackPlanResponse({ text: "", reasoningChars: 480, finishReason: "stop" })), "reasoning-only")
})

test("truncated JSON is reported as cut off, never completed into a plan", () => {
  const partial = "{\"track\":true,\"plan\":{\"planId\":\"plan-a\""
  assert.equal(failureOf(parseFeedbackPlanResponse({ text: partial, finishReason: "length" })), "output-limit")
  assert.equal(failureOf(parseFeedbackPlanResponse({ text: partial, finishReason: "stop" })), "truncated")
})

test("malformed JSON is a syntax failure", () => {
  const parsed = parseFeedbackPlanResponse("{\"track\":true,}")
  assert.equal(failureOf(parsed), "syntax")
  assert.ok("error" in parsed && parsed.error.startsWith("The provider response was not valid JSON"))
})

test("valid JSON with an invalid TODO schema is a schema failure", () => {
  assert.equal(failureOf(parseFeedbackPlanResponse(JSON.stringify({ track: true, plan: { ...plan(), tasks: [{ id: "x" }] } }))), "schema")
  assert.equal(failureOf(parseFeedbackPlanResponse(JSON.stringify({ track: "yes", plan: plan() }))), "schema")
})

test("an unsupported structured-output parameter is retried once without it, and remembered", async () => {
  const modes: boolean[] = []
  const call = async (json: boolean): Promise<RoleReply> => {
    modes.push(json)
    if (json) throw new Error("response_format is not supported for this model")
    return { text: validReply() }
  }
  const signal = new AbortController().signal
  assert.ok(replyText(await structuredReply("test-unsupported-json", call, signal)).includes("track"))
  await structuredReply("test-unsupported-json", call, signal)
  assert.deepEqual(modes, [true, false, false])
})

test("other provider failures are not mistaken for an unsupported parameter", async () => {
  let attempts = 0
  const signal = new AbortController().signal
  await assert.rejects(
    structuredReply("test-auth-failure", async () => {
      attempts++
      throw new Error("401 invalid API key")
    }, signal),
    /401/
  )
  assert.equal(attempts, 1)
})

test("one invalid reply is corrected by a single follow-up call that carries the schema error", async () => {
  await withRepository(async (repository) => {
    const requests: Sent[] = []
    const planner = plannerWith(repository, scripted(["not json", validReply()], requests))
    const { result } = await quietly(() => planner.start(scope, "Fix the parser."))
    assert.equal(result.status, "planned")
    assert.equal(requests.length, 2)
    assert.ok(requests.every((request) => request.json === true))
    assert.match(requests[1].user, /Your previous reply was rejected/)
    assert.equal((await repository.getList(scope)).items.length, 2)
  })
})

test("repeated invalid replies stop with one visible failure and write nothing", async () => {
  await withRepository(async (repository) => {
    const requests: Sent[] = []
    const failures: string[] = []
    const planner = plannerWith(repository, scripted(["nope", "still nope"], requests), failures)
    const { result } = await quietly(() => planner.start(scope, "Fix the parser."))
    assert.equal(result.status, "failed")
    assert.equal(requests.length, 2)
    assert.equal(failures.length, 1)
    assert.match(failures[0], /Feedback could not plan TODOs/)
    assert.equal((await repository.getList(scope)).items.length, 0)
  })
})

test("a reply stopped at the output limit is reported without a correction call", async () => {
  await withRepository(async (repository) => {
    const requests: Sent[] = []
    const planner = plannerWith(repository, scripted([{ text: "{\"track\":true,\"plan\":{", finishReason: "length" }], requests))
    const { result } = await quietly(() => planner.start(scope, "Fix the parser."))
    assert.equal(result.status, "failed")
    assert.match(result.error ?? "", /output limit/)
    assert.equal(requests.length, 1)
  })
})

test("a failed initial plan does not start Mycroft", async () => {
  await withRepository(async (repository) => {
    const planner = plannerWith(repository, scripted(["nope", "nope"]))
    const { gate, notices } = gated(planner)
    const dispatched: string[] = []
    const { result } = await quietly(() =>
      gate.admit(scope.conversationId, planner.start(scope, "Fix the parser."), async () => {
        dispatched.push("turn")
        return "reply"
      })
    )
    assert.equal(result, undefined)
    assert.deepEqual(dispatched, [])
    assert.equal(notices.length, 1)
    assert.match(notices[0], /did not start/)
    assert.equal((await repository.getList(scope)).items.length, 0)
  })
})

test("a successful retry synchronizes the plan before Mycroft starts", async () => {
  await withRepository(async (repository) => {
    const order: string[] = []
    const planner = plannerWith(spied(repository, order), scripted(["nope", "nope", validReply()]))
    const { gate } = gated(planner)
    const turn = async () => {
      order.push("dispatch")
      return "reply"
    }
    await quietly(() => gate.admit(scope.conversationId, planner.start(scope, "Fix the parser."), turn))
    assert.deepEqual(order, [])
    const { result } = await quietly(() => gate.retry(scope.conversationId))
    assert.equal(result.status, "planned")
    assert.deepEqual(order, ["sync", "dispatch"])
    assert.equal((await repository.getList(scope)).items.length, 2)
  })
})

test("concurrent Retry actions plan once and start the turn once", async () => {
  await withRepository(async (repository) => {
    const requests: Sent[] = []
    const planner = plannerWith(repository, scripted(["nope", "nope", validReply()], requests))
    const { gate } = gated(planner)
    let turns = 0
    await quietly(() =>
      gate.admit(scope.conversationId, planner.start(scope, "Fix the parser."), async () => {
        turns++
        return "reply"
      })
    )
    const { result: [first, second] } = await quietly(() => Promise.all([gate.retry(scope.conversationId), gate.retry(scope.conversationId)]))
    assert.equal(first.status, "planned")
    assert.equal(second.status, "planned")
    assert.equal(turns, 1)
    assert.equal(requests.length, 3, "two failed attempts, then one retry planning")
    assert.equal((await repository.getList(scope)).items.length, 2)
  })
})

test("cancelling planning prevents the turn from starting", async () => {
  await withRepository(async (repository) => {
    const planner = plannerWith(repository, (_request, { signal }) => untilAborted(signal))
    const { gate, notices } = gated(planner)
    let turns = 0
    const admitted = quietly(() =>
      gate.admit(scope.conversationId, planner.start(scope, "Fix the parser."), async () => {
        turns++
        return "reply"
      })
    )
    planner.cancel("user")
    const { result } = await admitted
    assert.equal(result, undefined)
    assert.equal(turns, 0)
    assert.deepEqual(notices, [], "a cancelled plan holds the turn silently")
    assert.equal((await repository.getList(scope)).items.length, 0)
  })
})

test("a late answer from an obsolete provider cannot change the active plan", async () => {
  await withRepository(async (repository) => {
    const old = deferred<string>()
    const current = deferred<string>()
    const planner = plannerWith(repository, (request) => (request.user.startsWith("Old") ? old.promise : current.promise))
    const first = planner.start(scope, "Old request.")
    const second = planner.start(scope, "New request.")
    current.resolve(JSON.stringify({ track: true, plan: plan({ planId: "new" }) }))
    assert.equal((await second).status, "planned")
    old.resolve(JSON.stringify({ track: true, plan: plan({ planId: "old", goal: "Stale goal" }) }))
    assert.equal((await first).status, "stale")
    assert.equal((await repository.getIntentTaskPlan(scope))?.planId, "new")
  })
})

test("existing user-created TODOs are preserved when a plan is synchronized", async () => {
  await withRepository(async (repository) => {
    await repository.createItem(scope, { title: "Ship the release notes" }, "user-request", "user")
    const planner = plannerWith(repository, scripted([validReply()]))
    const { result } = await quietly(() => planner.start(scope, "Fix the parser."))
    assert.equal(result.status, "planned")
    const titles = (await repository.getList(scope)).items.map((item) => item.title)
    assert.equal(titles.filter((title) => title === "Ship the release notes").length, 1)
    assert.ok(titles.includes("Inspect parser"))
  })
})

test("a plan with one invalid task writes no TODOs at all", async () => {
  await withRepository(async (repository) => {
    const order: string[] = []
    const broken = { ...plan(), tasks: [plan().tasks[0], { ...plan().tasks[1], acceptanceCriteria: "not a list" }] }
    const reply = JSON.stringify({ track: true, plan: broken })
    const planner = plannerWith(spied(repository, order), scripted([reply, reply]))
    const { result } = await quietly(() => planner.start(scope, "Fix the parser."))
    assert.equal(result.status, "failed")
    assert.deepEqual(order, [])
    assert.equal(await repository.getIntentTaskPlan(scope), undefined)
    assert.equal((await repository.getList(scope)).items.length, 0)
  })
})

test("with Feedback disabled, the turn runs without planning", async () => {
  await withRepository(async (repository) => {
    const planner = new FeedbackPlanner({
      enabled: () => false,
      resolve: () => endpoint(scripted([])),
      repository: () => repository
    })
    const { gate, notices } = gated(planner)
    const dispatched: string[] = []
    const turn = async () => {
      dispatched.push("turn")
      return "reply"
    }
    assert.equal(await gate.admit(scope.conversationId, planner.start(scope, "Fix it."), turn), "reply")
    assert.equal(await gate.admit(scope.conversationId, undefined, turn), "reply")
    assert.deepEqual(dispatched, ["turn", "turn"])
    assert.deepEqual(notices, [])
  })
})
