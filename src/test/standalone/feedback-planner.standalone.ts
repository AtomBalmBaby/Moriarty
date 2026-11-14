import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { logger } from "../../common/logger"
import type { TodoListSnapshot } from "../../common/types"
import { ChildTodoReviewer, FEEDBACK_PLAN_ATTEMPTS, FEEDBACK_PLAN_PROTOCOL, FeedbackGate, FeedbackPlanner, type FeedbackPlanRepository, findAdministrativeClauses, parseChildTodoDecision, parseFeedbackPlanResponse, requestsTodoMachineryWork, trustedFactsBlock, userRequestsTodoCreation } from "../../extension/chat/feedback-planner"
import { replyText, type RoleInference, type RoleReply, type RoleResolution, structuredReply } from "../../extension/chat/role-inference"
import { readReply } from "../../extension/inference/stream"
import type { ChatChunk } from "../../extension/inference/types"
import { CRITERION_FIELDS } from "../../extension/todos/intent-plan"
import { TodoRepository, trustedTodoPanelApproval } from "../../extension/todos/repository"
import type { AcceptedFact, ChildTodoContext, ChildTodoProposal } from "../../extension/todos/types"

const quietly = async <T>(run: () => Promise<T>) => {
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

const plan = (overrides: Record<string, unknown> = {}) => ({
  planId: "plan-a",
  version: 1,
  revision: 1,
  goal: "Fix the parser",
  constraints: [],
  tasks: [
    { id: "inspect", title: "Inspect parser", description: "Find the bug", criteria: [{ id: "criterion-1", description: "Bug located", verification: { kind: "semantic_review" } }], dependencies: [] },
    { id: "fix", title: "Fix parser", description: "Fix the bug", criteria: [{ id: "criterion-1", description: "Test passes", verification: { kind: "semantic_review" } }], dependencies: ["inspect"] }
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
    await run(new TodoRepository(path.join(directory, "todos.sqlite")))
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

const scope = { projectFingerprint: "project", conversationId: "chat", writer: "chat" }

test("the Feedback plan response is validated before it can write TODOs", () => {
  assert.deepEqual(parseFeedbackPlanResponse("{\"track\":false,\"plan\":null}"), { track: false })
  const parsed = parseFeedbackPlanResponse(JSON.stringify({ track: true, plan: plan() }))
  assert.ok("plan" in parsed && parsed.plan.tasks.length === 2)
  assert.ok("error" in parseFeedbackPlanResponse(JSON.stringify({ track: true, plan: { ...plan(), tasks: [] } })))
  assert.ok("error" in parseFeedbackPlanResponse(JSON.stringify({ track: true, plan: plan(), prompt: "x" })))
  assert.ok("error" in parseFeedbackPlanResponse("nope"))
})

test("an administrative plan gets one corrective retry that names the offending criterion, and is never synced if it stays invalid", async () => {
  const administrative = plan({ goal: "Locate read_file.", tasks: [{ id: "locate", title: "Locate read_file", description: "Find it.", criteria: [{ id: "criterion-1", description: "Create a TODO entry documenting this location.", verification: { kind: "semantic_review" } }], dependencies: [] }] })
  const clean = plan({ goal: "Locate read_file.", tasks: [{ id: "locate", title: "Locate read_file", description: "Find it.", criteria: [{ id: "criterion-1", description: "The path and line numbers of readFile are cited.", verification: { kind: "semantic_review" } }], dependencies: [] }] })
  await withRepository(async (repository) => {
    const sent: string[] = []
    const planner = new FeedbackPlanner({
      enabled: () => true,
      repository: () => repository,
      resolve: () => endpoint(async ({ user }) => {
        sent.push(user)
        return JSON.stringify({ track: true, plan: sent.length === 1 ? administrative : clean })
      })
    })
    const { result } = await quietly(() => planner.start(scope, "Locate read_file."))
    assert.equal(result.status, "planned")
    assert.equal(sent.length, 2, "exactly one corrective retry")
    assert.match(sent[1], /tasks\[0\]\.criteria\[0\]\.description/, "the correction names the offending criterion")
    assert.deepEqual((await repository.getList(scope)).items.map((item) => item.title), ["Locate read_file"])
  })
  await withRepository(async (repository) => {
    let calls = 0
    const planner = new FeedbackPlanner({
      enabled: () => true,
      repository: () => repository,
      resolve: () => endpoint(async () => {
        calls += 1
        return JSON.stringify({ track: true, plan: administrative })
      })
    })
    const { result } = await quietly(() => planner.start(scope, "Locate read_file."))
    assert.equal(result.status, "failed")
    assert.equal(calls, 2, "the first reply and one correction; an identical correction is a repetition, so planning stops")
    assert.equal(await repository.getIntentTaskPlan(scope), undefined, "an invalid plan is never written")
  })
})

const followUpPlan = (overrides: Record<string, unknown> = {}) => plan({
  planId: "plan-b",
  revision: 1,
  goal: "Write the release notes",
  tasks: [{ id: "notes", title: "Write release notes", description: "Draft the notes", criteria: [{ id: "criterion-1", description: "The notes name each change.", verification: { kind: "semantic_review" } }], dependencies: [] }],
  ...overrides
})

const completeAll = async (repository: TodoRepository) => {
  for (const item of (await repository.getList({ ...scope, includeCompleted: true })).items) {
    await repository.completeByUser(scope, item.id, item.version, "Verified by user", `complete-${item.id}`, trustedTodoPanelApproval)
  }
}

test("a follow-up after a completed plan gets an independent planning decision and a new plan, and the completed plan keeps its history", async () => {
  await withRepository(async (repository) => {
    const sent: string[] = []
    const planner = new FeedbackPlanner({
      enabled: () => true,
      repository: () => repository,
      resolve: () => endpoint(async ({ user }) => {
        sent.push(user)
        return JSON.stringify({ track: true, plan: sent.length === 1 ? plan() : followUpPlan() })
      })
    })
    assert.equal((await quietly(() => planner.start(scope, "Fix the parser."))).result.status, "planned")
    await completeAll(repository)
    const { result, records } = await quietly(() => planner.start(scope, "Now write the release notes."))
    assert.equal(result.status, "planned")
    assert.doesNotMatch(sent[1], /plan-a/, "the completed plan is not offered for revision")
    assert.match(sent[1], /complete/i, "the planner is told the earlier plan is finished")
    assert.match(records.join("\n"), /replaces completed plan plan-a/)
    const stored = await repository.getIntentTaskPlan(scope)
    assert.equal(stored?.planId, "plan-b")
    assert.deepEqual(stored?.tasks.map((task) => task.title), ["Write release notes"])
    const items = (await repository.getList({ ...scope, includeCompleted: true })).items
    assert.deepEqual(items.map((item) => [item.title, item.status]), [
      ["Inspect parser", "completed"],
      ["Fix parser", "completed"],
      ["Write release notes", "pending"]
    ])
  })
})

test("a simple question after a completed plan may be untracked, with the reason logged and the completed plan unchanged", async () => {
  await withRepository(async (repository) => {
    let calls = 0
    const planner = new FeedbackPlanner({
      enabled: () => true,
      repository: () => repository,
      resolve: () => endpoint(async () => {
        calls += 1
        return JSON.stringify(calls === 1 ? { track: true, plan: plan() } : { track: false, plan: null })
      })
    })
    await quietly(() => planner.start(scope, "Fix the parser."))
    await completeAll(repository)
    const { result, records } = await quietly(() => planner.start(scope, "What does the parser export?"))
    assert.equal(result.status, "untracked")
    assert.equal(calls, 2, "planning was invoked for the follow-up")
    assert.match(records.join("\n"), /track:false/)
    assert.equal((await repository.getIntentTaskPlan(scope))?.planId, "plan-a")
    const items = (await repository.getList({ ...scope, includeCompleted: true })).items
    assert.deepEqual(items.map((item) => item.status), ["completed", "completed"])
  })
})

test("an empty message is never planned, and the skip is logged with its reason", async () => {
  await withRepository(async (repository) => {
    let calls = 0
    const planner = new FeedbackPlanner({
      enabled: () => true,
      repository: () => repository,
      resolve: () => endpoint(async () => {
        calls += 1
        return JSON.stringify({ track: false, plan: null })
      })
    })
    const { result, records } = await quietly(() => planner.start(scope, "   "))
    assert.equal(result.status, "untracked")
    assert.equal(calls, 0)
    assert.match(records.join("\n"), /not started: the message is empty/)
  })
})

test("a follow-up while the plan is still open revises that plan and cannot replace it", async () => {
  await withRepository(async (repository) => {
    const planner = new FeedbackPlanner({
      enabled: () => true,
      repository: () => repository,
      resolve: () => endpoint(async ({ user }) => JSON.stringify({ track: true, plan: user.includes("Now") ? plan({ planId: "plan-b", revision: 2 }) : plan() }))
    })
    await quietly(() => planner.start(scope, "Fix the parser."))
    assert.equal((await quietly(() => planner.start(scope, "Now also check the lexer."))).result.status, "planned")
    const stored = await repository.getIntentTaskPlan(scope)
    assert.equal(stored?.planId, "plan-a")
    assert.equal(stored?.revision, 2)
    await assert.rejects(
      repository.synchronizeIntentPlan(scope, followUpPlan({ revision: 3 }), {}),
      /preserve the existing planId/
    )
  })
})

test("a completed plan is replaced only by a plan with a higher revision", async () => {
  await withRepository(async (repository) => {
    const planner = new FeedbackPlanner({
      enabled: () => true,
      repository: () => repository,
      resolve: () => endpoint(async () => JSON.stringify({ track: true, plan: plan() }))
    })
    await quietly(() => planner.start(scope, "Fix the parser."))
    await completeAll(repository)
    await assert.rejects(repository.synchronizeIntentPlan(scope, followUpPlan(), {}), /revision/)
    const snapshot = await repository.synchronizeIntentPlan(scope, followUpPlan({ revision: 2 }), {})
    assert.deepEqual(snapshot.items.map((item) => [item.title, item.status]), [
      ["Inspect parser", "completed"],
      ["Fix parser", "completed"],
      ["Write release notes", "pending"]
    ])
    assert.equal((await repository.getIntentTaskPlan(scope))?.planId, "plan-b")
  })
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
        return JSON.stringify({ track: true, plan: users.length === 1 ? plan() : plan({ planId: "renamed", tasks: [...plan().tasks, { id: "verify", title: "Verify", description: "Run tests", criteria: [{ id: "criterion-1", description: "Green", verification: { kind: "semantic_review" } }], dependencies: ["fix"] }] }) })
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
    const untilCalled = async (count: number) => {
      for (let turn = 0; releases.length < count && turn < 10_000; turn++) {
        await new Promise((resolve) => setImmediate(resolve))
      }
      assert.ok(releases.length >= count, `expected ${count} endpoint calls`)
    }
    // Ignores the abort signal, so its answers arrive late.
    const planner = new FeedbackPlanner({
      enabled: () => true,
      repository: () => repository,
      onFailure: (message) => failures.push(message),
      resolve: () => endpoint(() => new Promise((resolve) => releases.push(resolve)))
    })
    const { result: cancelled, records } = await quietly(async () => {
      const running = planner.start(scope, "First request")
      await untilCalled(1)
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
      await untilCalled(2)
      const newer = planner.start(scope, "Newer request")
      await untilCalled(3)
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

/** A read_file lookup plan whose second criterion carries the given verification descriptor. */
const lookupReply = (verification: Record<string, unknown>) => JSON.stringify({
  track: true,
  plan: plan({
    tasks: [{
      id: "lookup",
      title: "Check accepted evidence for read_file",
      description: "Consult persisted project facts about read_file.",
      dependencies: [],
      criteria: [
        { id: "criterion-1", description: "The project-wide accepted evidence lookup has completed.", verification: { kind: "evidence_lookup_completed" } },
        { id: "criterion-2", description: "read_file is described by the descriptor.", verification }
      ]
    }]
  })
})

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
  intentPlanClosed: (request) => repository.intentPlanClosed(request),
  listAcceptedEvidence: (request) => repository.listAcceptedEvidence(request),
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

const tasksOf = (parsed: ReturnType<typeof parseFeedbackPlanResponse>) => {
  assert.ok("plan" in parsed, "a plan was produced")
  return (parsed as { plan: { tasks: { id: string; dependencies: string[] }[] } }).plan.tasks
}

test("a read-only investigation plan with TODO administration is rejected and names each offending clause", () => {
  const objective = "Investigate how read_file resolves paths and report where it can fail. Read-only: do not change any files."
  const reply = {
    track: true,
    plan: plan({
      goal: objective,
      tasks: [
        { id: "todo-init", title: "Create initial TODO entry for the investigation", description: "Record the investigation in the TODO list.", criteria: [{ id: "criterion-1", description: "A TODO entry exists with a clear title and description.", verification: { kind: "semantic_review" } }, { id: "criterion-2", description: "Its status is Open or equivalent.", verification: { kind: "semantic_review" } }], dependencies: [] },
        { id: "trace", title: "Trace read_file path resolution", description: "Read the read_file implementation and its path helpers.", criteria: [{ id: "criterion-1", description: "Path resolution steps are cited from source.", verification: { kind: "semantic_review" } }, { id: "criterion-2", description: "Create a TODO entry documenting this location.", verification: { kind: "semantic_review" } }], dependencies: ["todo-init"] },
        { id: "report", title: "Report failure modes", description: "Summarize where read_file can fail with cited lines.", criteria: [{ id: "criterion-1", description: "Each failure mode cites a source line.", verification: { kind: "semantic_review" } }], dependencies: ["trace"] }
      ]
    })
  }
  const parsed = parseFeedbackPlanResponse(JSON.stringify(reply), objective)
  assert.equal(failureOf(parsed), "administrative")
  const message = "error" in parsed ? parsed.error : ""
  assert.match(message, /tasks\[0\]\.title/)
  assert.match(message, /tasks\[0\]\.description/)
  assert.match(message, /tasks\[0\]\.criteria\[0\]\.description/)
  assert.match(message, /tasks\[1\]\.criteria\[1\]\.description/)
  assert.doesNotMatch(message, /tasks\[2\]/, "clean tasks are not named")
})

test("a plan made only of TODO administration is rejected, so Mycroft does not start", () => {
  const objective = "Investigate read_file and report its failure modes."
  const reply = {
    track: true,
    plan: plan({
      goal: objective,
      tasks: [{ id: "todo-init", title: "Create initial TODO entry for the investigation", description: "Set up tracking.", criteria: [{ id: "criterion-1", description: "A TODO entry exists.", verification: { kind: "semantic_review" } }], dependencies: [] }]
    })
  }
  assert.equal(failureOf(parseFeedbackPlanResponse(JSON.stringify(reply), objective)), "administrative")
})

const administrativeOf = (task: { title: string; description: string; criteria: { id: string; description: string; verification: { kind: string } }[] }, objective = "Locate the native read_file definition.") =>
  findAdministrativeClauses(plan({ goal: objective, tasks: [{ id: "t", dependencies: [], ...task }] }), objective).map((clause) => clause.path)

test("administrative TODO clauses are detected in titles, descriptions, and every criterion", () => {
  assert.deepEqual(administrativeOf({ title: "Use TODOs to track this", description: "", criteria: [] }), ["tasks[0].title"])
  assert.deepEqual(administrativeOf({ title: "Locate read_file", description: "Update the TODO list with progress.", criteria: [] }), ["tasks[0].description"])
  assert.deepEqual(
    administrativeOf({ title: "Locate read_file", description: "", criteria: [{ id: "criterion-1", description: "Path and line range cited.", verification: { kind: "semantic_review" } }, { id: "criterion-2", description: "Create a TODO entry documenting this location.", verification: { kind: "semantic_review" } }, { id: "criterion-3", description: "A TODO entry exists for it.", verification: { kind: "semantic_review" } }] }),
    ["tasks[0].criteria[1].description", "tasks[0].criteria[2].description"]
  )
  assert.deepEqual(administrativeOf({ title: "Locate read_file", description: "", criteria: [{ id: "criterion-1", description: "The TODO status is Done.", verification: { kind: "semantic_review" } }] }), ["tasks[0].criteria[0].description"])
})

test("a legitimate task that touches Twinny's code or a negated TODO mention is not administrative", () => {
  assert.deepEqual(administrativeOf({
    title: "Locate the TODO scanner",
    description: "Record the TODO-related code path and the TODO filter panel handling.",
    criteria: [{ id: "criterion-1", description: "Report the file and line range of the TODO scanner.", verification: { kind: "semantic_review" } }, { id: "criterion-2", description: "Use the TODO filter function to confirm the path.", verification: { kind: "semantic_review" } }, { id: "criterion-3", description: "Do not create any TODO entries.", verification: { kind: "semantic_review" } }]
  }), [])
})

test("quoted UI text and a TODO-named interface do not make a locating task administrative", () => {
  const objective = "Where is the \"Show completed tasks\" text defined in the todos interface?"
  assert.deepEqual(administrativeOf({
    title: "Locate the UI text",
    description: "Find the source file and line range where the text \"Show completed tasks\" is defined in the todos interface.",
    criteria: []
  }, objective), [])
  assert.deepEqual(administrativeOf({
    title: "Locate the UI text",
    description: "Find the source file and line range where the todos interface renders the text \"Show completed tasks\" so it can be updated.",
    criteria: []
  }, objective), [])
})

test("a directing verb outside quotes still makes a TODO instruction administrative", () => {
  const objective = "Where is the \"Show completed tasks\" text defined in the todos interface?"
  assert.deepEqual(administrativeOf({ title: "Locate the UI text", description: "Mark the `todo` as completed once located.", criteria: [] }, objective), ["tasks[0].description"])
  assert.deepEqual(administrativeOf({ title: "Locate the UI text", description: "Create a TODO for the \"Show completed tasks\" text.", criteria: [] }, objective), ["tasks[0].description"])
})

test("an objective about the TODO machinery exempts TODO implementation tasks", () => {
  const objective = "Fix the TODO filter so that completed items stay hidden."
  const tasks = { title: "Create TODO entry fixtures for the filter tests", description: "Update the TODO list used by the filter.", criteria: [{ id: "criterion-1", description: "A TODO entry exists in the fixture.", verification: { kind: "semantic_review" } }] }
  assert.deepEqual(administrativeOf(tasks, objective), [])
  const parsed = parseFeedbackPlanResponse(JSON.stringify({ track: true, plan: plan({ goal: objective, tasks: [{ id: "fix", ...tasks, dependencies: [] }] }) }), objective)
  assert.ok("plan" in parsed, "TODO implementation work is accepted")
})

test("a plan whose administrative clauses are all corrected is accepted on the resubmission", () => {
  const objective = "Locate the native read_file definition and report its path and line range."
  const clean = plan({
    goal: objective,
    tasks: [{ id: "locate", title: "Locate read_file", description: "Find the native definition.", criteria: [{ id: "criterion-1", description: "The file path and line range of readFile are cited.", verification: { kind: "semantic_review" } }], dependencies: [] }]
  })
  const parsed = parseFeedbackPlanResponse(JSON.stringify({ track: true, plan: clean }), objective)
  assert.deepEqual(tasksOf(parsed).map((task) => task.id), ["locate"])
})

test("a request to build or fix TODO functionality keeps its TODO tasks", () => {
  const objective = "Implement a filter for the TODO panel so completed items can be hidden."
  const reply = {
    track: true,
    plan: plan({
      goal: objective,
      tasks: [
        { id: "filter", title: "Create the TODO filter control", description: "Add a checkbox that hides completed TODO items.", criteria: [{ id: "criterion-1", description: "The checkbox hides completed items.", verification: { kind: "semantic_review" } }], dependencies: [] },
        { id: "verify", title: "Test the TODO filter", description: "Check that hidden items stay hidden after reload.", criteria: [{ id: "criterion-1", description: "Hidden items stay hidden.", verification: { kind: "semantic_review" } }], dependencies: ["filter"] }
      ]
    })
  }
  assert.deepEqual(tasksOf(parseFeedbackPlanResponse(JSON.stringify(reply), objective)).map((task) => task.id), ["filter", "verify"])
})

test("a read-only request that mentions TODO code is not treated as TODO administration", () => {
  const objective = "Investigate the TODO scanner and report how it finds comments."
  const reply = {
    track: true,
    plan: plan({
      goal: objective,
      tasks: [{ id: "scan", title: "Record the TODO-related code path", description: "Trace how scanner tokens are read.", criteria: [{ id: "criterion-1", description: "The token path is cited.", verification: { kind: "semantic_review" } }], dependencies: [] }]
    })
  }
  assert.deepEqual(tasksOf(parseFeedbackPlanResponse(JSON.stringify(reply), objective)).map((task) => task.id), ["scan"])
})

test("a negated build verb does not make a read-only request TODO work", () => {
  const objective = "Do not fix anything. Read the TODO handling code and report what it does."
  assert.equal(requestsTodoMachineryWork(objective), false)
  assert.equal(requestsTodoMachineryWork("Implement a filter for the TODO panel."), true)
})

// The read_file acceptance prompt in the HTML form it was sent, recovered verbatim from the extension-host log.
const READ_FILE_ACCEPTANCE_PROMPT = [
  "<h2>Twinny Feedback/TODO Live Acceptance Test</h2>Perform a read-only investigation of the current Twinny repository.",
  "<br><strong>Objective:</strong> Trace how the native <code>read_file</code> tool is registered and executed, from its tool definition through dispatch to the actual filesystem operation.",
  "<br>This is a verification task. Do not modify, create, or delete any files.<br><h3>Tasks</h3><ol>",
  "<li>Locate the native <code>read_file</code> tool definition using workspace search.<br></li>",
  "<li>Identify where the tool is registered and made available to the agent.<br></li>",
  "<li>Trace how an incoming <code>read_file</code> tool call is dispatched to its implementation.<br></li>",
  "<li>Identify where its arguments are validated and where the file is actually read.<br></li>",
  "<li>Verify your findings by reading the relevant source code.<br></li></ol>",
  "<h3>Feedback and TODO requirements</h3><ul>",
  "<li>Use the available native TODO system to track this investigation.<br></li>",
  "<li>Create actionable TODOs before beginning the investigation.<br></li>",
  "<li>Update TODO status as each step progresses.<br></li>",
  "<li>Record actual tool execution evidence for completed work.<br></li>",
  "<li>Do not mark tasks complete without verifying the relevant source.<br></li>",
  "<li>If a tool fails, record the failure and try an appropriate alternative.<br></li>",
  "<li>Reconcile the final TODO states against the work actually performed.<br></li></ul>",
  "<h3>Completion</h3>Provide a concise report containing:<br><ul>",
  "<li>Source file paths and line numbers.<br></li>",
  "<li>The execution path from registration to filesystem access.<br></li>",
  "<li>A PASS, FAIL, or NOT VERIFIED result for each investigation step.<br></li>",
  "<li>Any tool errors encountered.<br></li></ul>",
  "Finish the task normally when all steps have been evaluated.<br>",
  "Do not modify the repository, create documentation, or perform unrelated work."
].join("")

// The objective as the chat turn reads it: tags removed, line breaks kept.
const acceptanceObjective = READ_FILE_ACCEPTANCE_PROMPT.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").trim()

test("the read_file acceptance prompt is a read-only investigation, not TODO administration", () => {
  assert.equal(requestsTodoMachineryWork(acceptanceObjective), false)
  assert.equal(userRequestsTodoCreation(acceptanceObjective), false, "its TODO workflow lines do not authorize root-level creation")
})

test("a build word in a heading does not make a read-only investigation TODO work", () => {
  assert.equal(requestsTodoMachineryWork("Twinny Feedback/TODO Live Acceptance Test\nPerform a read-only investigation of the TODO panel."), false)
  assert.equal(requestsTodoMachineryWork("Feedback/TODO work: test the TODO filter and fix the panel."), true)
})

test("the administrative TODO tasks Feedback produced for the read_file acceptance prompt are rejected, naming each offending clause", () => {
  const reply = {
    track: true,
    plan: plan({
      goal: acceptanceObjective,
      tasks: [
        { id: "todo-create", title: "Create actionable TODOs before beginning the investigation", description: "Create the initial TODO entries.", criteria: [{ id: "criterion-1", description: "A TODO entry exists.", verification: { kind: "semantic_review" } }], dependencies: [] },
        { id: "todo-status", title: "Update TODO status as each step progresses", description: "Keep the TODO statuses current.", criteria: [{ id: "criterion-1", description: "Statuses reflect progress.", verification: { kind: "semantic_review" } }], dependencies: ["todo-create"] },
        { id: "register", title: "Locate read_file registration", description: "Find where the native read_file tool definition is registered and made available to the agent.", criteria: [{ id: "criterion-1", description: "Registration sites are cited with line numbers.", verification: { kind: "semantic_review" } }], dependencies: ["todo-create"] },
        { id: "define", title: "Locate native read_file definition", description: "Find the definition of the native read_file tool.", criteria: [{ id: "criterion-1", description: "Identify the file path and line numbers where read_file is defined.", verification: { kind: "semantic_review" } }, { id: "criterion-2", description: "Create a TODO entry documenting this location.", verification: { kind: "semantic_review" } }], dependencies: [] }
      ]
    })
  }
  const parsed = parseFeedbackPlanResponse(JSON.stringify(reply), acceptanceObjective)
  assert.equal(failureOf(parsed), "administrative")
  const message = "error" in parsed ? parsed.error : ""
  assert.match(message, /tasks\[0\]\.title/)
  assert.match(message, /tasks\[0\]\.description/)
  assert.match(message, /tasks\[1\]\.title/)
  assert.match(message, /tasks\[3\]\.criteria\[1\]\.description/)
  assert.doesNotMatch(message, /tasks\[2\]/, "the legitimate registration task is not named")
  assert.doesNotMatch(message, /tasks\[3\]\.criteria\[0\]\.description/, "the legitimate criterion is not named")

  const repaired = {
    track: true,
    plan: plan({
      goal: acceptanceObjective,
      tasks: [
        { id: "register", title: "Locate read_file registration", description: "Find where the native read_file tool definition is registered and made available to the agent.", criteria: [{ id: "criterion-1", description: "Registration sites are cited with line numbers.", verification: { kind: "semantic_review" } }], dependencies: [] },
        { id: "define", title: "Locate native read_file definition", description: "Find the definition of the native read_file tool.", criteria: [{ id: "criterion-1", description: "Identify the file path and line numbers where read_file is defined.", verification: { kind: "semantic_review" } }], dependencies: ["register"] }
      ]
    })
  }
  assert.deepEqual(tasksOf(parseFeedbackPlanResponse(JSON.stringify(repaired), acceptanceObjective)).map((task) => task.id), ["register", "define"])
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

test("repeated invalid replies stop within the planning budget with one visible failure and write nothing", async () => {
  await withRepository(async (repository) => {
    const requests: Sent[] = []
    const failures: string[] = []
    const planner = plannerWith(repository, scripted(["nope", "still nope", "nope again", "unused"], requests), failures)
    const { result } = await quietly(() => planner.start(scope, "Fix the parser."))
    assert.equal(result.status, "failed")
    assert.equal(requests.length, FEEDBACK_PLAN_ATTEMPTS)
    assert.equal(failures.length, 1)
    assert.match(failures[0], /Feedback could not plan TODOs/)
    assert.equal((await repository.getList(scope)).items.length, 0)
  })
})

test("an invalid identity is corrected from the exact diagnostic and the corrected plan is written", async () => {
  await withRepository(async (repository) => {
    const requests: Sent[] = []
    const planner = plannerWith(repository, scripted([
      lookupReply({ kind: "accepted_fact_exists", identity: "tool", symbol: "read_file" }),
      lookupReply({ kind: "accepted_fact_exists", identity: "registered_tool", symbol: "read_file" })
    ], requests))
    const { result } = await quietly(() => planner.start(scope, "Check read_file."))
    assert.equal(result.status, "planned")
    assert.equal(requests.length, 2)
    assert.match(requests[1].user, /Your previous reply was rejected: Invalid task plan: plan\.tasks\[0\]\.criteria\[1\]\.verification\.identity must be registered_tool or implementation_symbol when given; received "tool"\./)
    assert.ok(await repository.getIntentTaskPlan(scope))
  })
})

test("repeated identical invalid identities stop at the first repeated reply with the exact diagnostic and write nothing", async () => {
  await withRepository(async (repository) => {
    const invalid = lookupReply({ kind: "accepted_fact_exists", identity: "tool", symbol: "read_file" })
    const requests: Sent[] = []
    const failures: string[] = []
    const planner = plannerWith(repository, scripted([invalid, invalid, invalid, invalid], requests), failures)
    const { result } = await quietly(() => planner.start(scope, "Check read_file."))
    assert.equal(result.status, "failed")
    assert.equal(requests.length, 2)
    assert.deepEqual(failures, ["Feedback could not plan TODOs: Invalid task plan: plan.tasks[0].criteria[1].verification.identity must be registered_tool or implementation_symbol when given; received \"tool\". The corrected reply repeated the rejected one, so planning stopped."])
    assert.equal(await repository.getIntentTaskPlan(scope), undefined)
  })
})

test("the planner protocol describes exactly the fields the validator accepts for every verification kind", () => {
  for (const [kind, fields] of Object.entries(CRITERION_FIELDS)) {
    const descriptor = FEEDBACK_PLAN_PROTOCOL.match(new RegExp(`\\{kind: "${kind}"[^}]*\\}`))?.[0]
    assert.ok(descriptor, `the protocol describes ${kind}`)
    const described = [...descriptor.matchAll(/([A-Za-z]+)\??:/g)].map((match) => match[1]).sort()
    assert.deepEqual(described, [...fields].sort(), `the protocol fields for ${kind} match the validator`)
  }
})

test("each identity-bearing kind parses with its identity, with and without the optional path", () => {
  const descriptors = [
    { kind: "accepted_fact_exists", identity: "registered_tool", symbol: "read_file" },
    { kind: "accepted_fact_exists", identity: "implementation_symbol", symbol: "readFile", path: "src/tools.ts" },
    { kind: "source_location", identity: "registered_tool", symbol: "read_file" },
    { kind: "source_range", identity: "implementation_symbol", symbol: "readFile" },
    { kind: "source_fingerprint", identity: "implementation_symbol", symbol: "readFile", path: "src/tools.ts" }
  ]
  for (const verification of descriptors) {
    const parsed = parseFeedbackPlanResponse(lookupReply(verification), "Locate read_file.")
    assert.ok("plan" in parsed, JSON.stringify(verification))
    assert.equal("path" in parsed.plan.tasks[0].criteria[1].verification, verification.path !== undefined, JSON.stringify(verification))
  }
})

test("a source criterion with an unsupported identity is rejected, and a missing identity is accepted as identity-free", () => {
  const unknown = parseFeedbackPlanResponse(lookupReply({ kind: "source_location", identity: "tool", symbol: "read_file" }), "Locate read_file.")
  assert.ok("error" in unknown)
  assert.equal(unknown.error, "Invalid task plan: plan.tasks[0].criteria[1].verification.identity must be registered_tool or implementation_symbol when given; received \"tool\".")
  const missing = parseFeedbackPlanResponse(lookupReply({ kind: "source_fingerprint", symbol: "readFile", path: "src/tools.ts" }), "Locate readFile.")
  assert.ok("plan" in missing, JSON.stringify(missing))
  const verification = missing.plan.tasks[0].criteria[1].verification
  assert.equal("identity" in verification ? verification.identity : undefined, undefined)
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

test("a plan revised by another writer during planning holds the turn with a concrete error", async () => {
  await withRepository(async (repository) => {
    await quietly(() => plannerWith(repository, scripted([validReply()])).start(scope, "Fix the parser."))
    let raced = false
    // The other writer lands after this planning read the stored plan and before it writes its own revision.
    const racing: RoleInference = async () => {
      if (!raced) {
        raced = true
        const stored = await repository.getIntentTaskPlan(scope)
        assert.ok(stored)
        await repository.synchronizeIntentPlan(scope, { ...stored, revision: stored.revision + 1 }, { source: "feedback", goal: stored.goal })
      }
      return validReply()
    }
    const planner = plannerWith(repository, racing)
    const { gate, notices } = gated(planner)
    let turns = 0
    const { result } = await quietly(() =>
      gate.admit(scope.conversationId, planner.start(scope, "Revise the parser."), async () => {
        turns++
        return "reply"
      })
    )
    assert.equal(result, undefined)
    assert.equal(turns, 0)
    assert.equal(notices.length, 1, "the held turn must say why it did not start")
    assert.match(notices[0], /did not start/)
  })
})

test("a successful retry synchronizes the plan before Mycroft starts", async () => {
  await withRepository(async (repository) => {
    const order: string[] = []
    const planner = plannerWith(spied(repository, order), scripted(["nope", "nope", "nope", validReply()]))
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

test("retrying a held turn never starts it unplanned when another conversation planned last", async () => {
  await withRepository(async (repository) => {
    const other = { ...scope, conversationId: "other" }
    const planner = plannerWith(repository, scripted(["nope", "nope", "nope", validReply()]))
    const { gate } = gated(planner)
    let turns = 0
    await quietly(() =>
      gate.admit(scope.conversationId, planner.start(scope, "Fix the parser."), async () => {
        turns++
        return "reply"
      })
    )
    assert.equal(turns, 0)
    await quietly(() => planner.start(other, "Fix the other parser."))
    const { result } = await quietly(() => gate.retry(scope.conversationId))
    assert.equal(turns, 0, "the held turn must not start without a plan of its own")
    assert.equal(result.status, "unavailable")
    assert.equal((await repository.getList(scope)).items.length, 0)
  })
})

test("concurrent Retry actions plan once and start the turn once", async () => {
  await withRepository(async (repository) => {
    const requests: Sent[] = []
    const planner = plannerWith(repository, scripted(["nope", "nope", "nope", validReply()], requests))
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
    assert.equal(requests.length, FEEDBACK_PLAN_ATTEMPTS + 1, "the bounded failed attempts, then one retry planning")
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
    const broken = { ...plan(), tasks: [plan().tasks[0], { ...plan().tasks[1], criteria: "not a list" }] }
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

const childContext: ChildTodoContext = {
  planId: "plan-child",
  revision: 2,
  goal: "Investigate the read path",
  parent: { id: "parent-task", title: "Trace read_file", status: "pending", acceptance: ["The read path is traced"], dependsOn: [] },
  children: [],
  planItems: [{ id: "parent-task", title: "Trace read_file", status: "pending" }, { id: "sibling-task", title: "Locate definition", status: "pending" }]
}

test("administrative child TODO titles and details are refused deterministically, with one bounded correction", async () => {
  const reply = (value: unknown) => JSON.stringify(value)
  const adminAccepted = parseChildTodoDecision(reply({ decision: "accepted", title: "Create a TODO documenting the read_file definition", instruction: "Create it." }), childContext)
  assert.equal(adminAccepted.ok, false, "an accepted child may not carry an administrative title")
  const adminRevised = parseChildTodoDecision(reply({ decision: "revised", details: "Record the handler location in a TODO.", instruction: "Use it." }), childContext)
  assert.equal(adminRevised.ok, false, "a revision may not carry administrative details")
  const concrete = parseChildTodoDecision(reply({ decision: "revised", title: "Trace the read handler dispatch", instruction: "Create it." }), childContext)
  assert.equal(concrete.ok, true)
  const rejected = parseChildTodoDecision(reply({ decision: "rejected", instruction: "Not needed; it only manages TODO records." }), childContext)
  assert.equal(rejected.ok, true, "a rejection applies no title, so it is not administrative work")

  const proposal: ChildTodoProposal = {
    parentId: "parent-task",
    title: "Log the read_file location as a TODO entry",
    details: "Find the handler that serves read_file.",
    reason: "Needed to trace read_file.",
    priority: "normal",
    requestId: "admin-proposal"
  }
  let modelCalls = 0
  const refusing = new ChildTodoReviewer({
    resolve: () => endpoint(async () => {
      modelCalls += 1
      return reply({ decision: "accepted", instruction: "Create it." })
    })
  })
  const refused = await refusing.review(proposal, childContext)
  assert.equal(refused.ok, false)
  assert.match(refused.ok ? "" : refused.error, /TODO administration/)
  assert.equal(modelCalls, 0, "an administrative proposal is refused without a model call")

  const replies = [
    reply({ decision: "accepted", title: "Create a TODO documenting the handler", instruction: "Create it." }),
    reply({ decision: "accepted", title: "Trace the read handler dispatch", instruction: "Create it." })
  ]
  const corrected = new ChildTodoReviewer({ resolve: () => endpoint(async () => replies.shift() ?? "") })
  const outcome = await corrected.review({ ...proposal, title: "Trace the read handler" }, childContext)
  assert.equal(outcome.ok, true)
  assert.equal(outcome.ok && outcome.decision.decision === "accepted" ? outcome.decision.decision : "", "accepted")

  const stuck = new ChildTodoReviewer({ resolve: () => endpoint(async () => reply({ decision: "accepted", title: "Create a TODO documenting the handler", instruction: "Create it." })) })
  assert.equal((await stuck.review({ ...proposal, title: "Trace the read handler" }, childContext)).ok, false, "a second administrative decision fails visibly")

  const exempt = parseChildTodoDecision(reply({ decision: "accepted", title: "Create a TODO fixture for the completion check", instruction: "Create it." }), { ...childContext, goal: "Implement the TODO completion check" })
  assert.equal(exempt.ok, true, "a request about the TODO machinery itself keeps its TODO work")
})

test("past-tense TODO record wording is detected as administrative", () => {
  const plan = { tasks: [{ id: "locate", title: "Locate the read_file definition", description: "", criteria: [{ id: "criterion-1", description: "The location is logged as a TODO entry", verification: { kind: "semantic_review" } }], dependencies: [] }] }
  assert.equal(findAdministrativeClauses(plan, "Where is read_file implemented?").length, 1)
  const concrete = { tasks: [{ id: "locate", title: "Locate the read_file definition", description: "", criteria: [{ id: "criterion-1", description: "The definition is located at a line range", verification: { kind: "semantic_review" } }], dependencies: [] }] }
  assert.equal(findAdministrativeClauses(concrete, "Where is read_file implemented?").length, 0)
})

test("child TODO decisions are accepted only in the schema Feedback was given", () => {
  const reply = (value: unknown) => JSON.stringify(value)
  const accepted = parseChildTodoDecision(reply({ decision: "accepted", instruction: "Create the child under the parent." }), childContext)
  assert.equal(accepted.ok, true)
  if (accepted.ok) assert.equal(accepted.decision.decision, "accepted")

  const unknownPlanTask = parseChildTodoDecision(reply({ decision: "existing_task", item_id: "not-in-plan", instruction: "Use it." }), childContext)
  assert.equal(unknownPlanTask.ok, false, "existing_task must name a TODO that is in the plan")

  const extraKey = parseChildTodoDecision(reply({ decision: "accepted", instruction: "Create it.", execute: true }), childContext)
  assert.equal(extraKey.ok, false, "unexpected keys are rejected")

  const unknownKind = parseChildTodoDecision(reply({ decision: "approved", instruction: "Create it." }), childContext)
  assert.equal(unknownKind.ok, false)

  const reasoningOnly = parseChildTodoDecision({ text: "", reasoning: "thinking", finishReason: "stop" } as RoleReply, childContext)
  assert.equal(reasoningOnly.ok, false)
})

test("only a direct request for one named task authorizes user-directed creation", () => {
  assert.equal(userRequestsTodoCreation("Please create a TODO to track the release notes."), true)
  assert.equal(userRequestsTodoCreation("Add a to-do for the migration."), true)
  assert.equal(userRequestsTodoCreation("Context first.\n- Create the TODO for the migration."), true)
  assert.equal(userRequestsTodoCreation("Trace how read_file reaches its implementation."), false)
  assert.equal(userRequestsTodoCreation("Do not create a TODO for this investigation."), false)
  assert.equal(userRequestsTodoCreation("Explain how the TODO panel displays tasks."), false)
})

test("workflow text about TODO tracking does not authorize root-level creation", () => {
  assert.equal(userRequestsTodoCreation("Use TODOs to track this investigation."), false)
  assert.equal(userRequestsTodoCreation("Create actionable TODOs before beginning the investigation."), false)
  assert.equal(userRequestsTodoCreation("Create initial TODO entries for each source file."), false)
  assert.equal(userRequestsTodoCreation("Update TODO status as each step progresses."), false)
  assert.equal(userRequestsTodoCreation("Record actual tool execution evidence for completed work."), false)
})

test("a stop during child TODO review returns at once, and a late decision is discarded", async () => {
  const requests: string[] = []
  const releases: Array<(value: string) => void> = []
  // Ignores the abort signal, so the decision would arrive late.
  const reviewer = new ChildTodoReviewer({
    resolve: () =>
      endpoint((request) => {
        requests.push(request.user)
        return new Promise((resolve) => releases.push(resolve))
      })
  })
  const proposal: ChildTodoProposal = {
    parentId: "parent-task",
    title: "Locate the read handler",
    details: "Find the handler that serves read_file.",
    reason: "Needed to trace read_file.",
    priority: "normal",
    requestId: "request-stop"
  }
  const controller = new AbortController()
  const review = reviewer.review(proposal, childContext, controller.signal)
  await new Promise((resolve) => setTimeout(resolve, 10))
  controller.abort(new Error("stopped"))
  const outcome = await Promise.race([
    review,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("review did not return after Stop")), 2000).unref())
  ])
  assert.equal(outcome.ok, false)
  releases[0](JSON.stringify({ decision: "accepted", instruction: "Create the child under the parent." }))
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(outcome.ok, false, "a decision that arrives after Stop never authorizes a mutation")
  assert.equal(requests.length, 1, "no correction request starts after Stop")
})

test("the abandoned string acceptanceCriteria contract is rejected with an actionable typed-criteria message", () => {
  const legacy = plan({ tasks: [{ id: "locate", title: "Locate read_file", description: "Find it.", acceptanceCriteria: ["Path and line range cited."], dependencies: [] }] })
  const parsed = parseFeedbackPlanResponse(JSON.stringify({ track: true, plan: legacy }), "Locate read_file.")
  assert.ok("error" in parsed, "a legacy string criterion never becomes an accepted plan")
  assert.match(parsed.error, /acceptanceCriteria is no longer accepted/)
  assert.match(parsed.error, /criteria\[\]/)
})

const acceptedFact = (overrides: Partial<AcceptedFact> = {}): AcceptedFact => ({
  id: "fact-1",
  conversationId: "chat",
  itemId: "item-1",
  criterionIndex: 0,
  criterion: "read_file implementation located",
  toolName: "read_file",
  planId: "plan-a",
  planRevision: 1,
  symbol: "readFile",
  registeredTool: "read_file",
  path: "src/extension/tools/workspace.ts",
  startLine: 169,
  endLine: 220,
  observationId: "observation-1",
  sourceHash: "hash-1",
  acceptedAt: "2026-01-01T00:00:00.000Z",
  ...overrides
})

const locateReadFile = (verification: Record<string, unknown>) => plan({
  tasks: [{ id: "locate", title: "Locate read_file", description: "Find the implementation.", criteria: [{ id: "criterion-1", description: "readFile located", verification }], dependencies: [] }]
})

test("a planner path that contradicts live accepted evidence for the same symbol is reported for repair", () => {
  const guessed = locateReadFile({ kind: "source_location", identity: "implementation_symbol", symbol: "readFile", path: "tools/read_file.ts" })
  const reply = JSON.stringify({ track: true, plan: guessed })
  const parsed = parseFeedbackPlanResponse(reply, "Locate the native read_file tool implementation.", [acceptedFact()])
  assert.ok("error" in parsed, "a guessed path never becomes a binding requirement")
  assert.match(parsed.error, /Invalid task plan/)
  assert.match(parsed.error, /tools\/read_file\.ts/)
  assert.match(parsed.error, /src\/extension\/tools\/workspace\.ts/)
  assert.match(parsed.error, /omit path/)
})

test("the same contradiction is accepted when the request itself names the path", () => {
  const named = locateReadFile({ kind: "source_location", identity: "implementation_symbol", symbol: "readFile", path: "tools/read_file.ts" })
  const parsed = parseFeedbackPlanResponse(JSON.stringify({ track: true, plan: named }), "Check tools/read_file.ts for readFile.", [acceptedFact()])
  assert.ok("plan" in parsed, "a path the user named is the user's own authority, not a guess")
})

test("a plan that omits the path is accepted and never contradicted by accepted evidence", () => {
  const discovery = locateReadFile({ kind: "source_location", identity: "implementation_symbol", symbol: "readFile" })
  const parsed = parseFeedbackPlanResponse(JSON.stringify({ track: true, plan: discovery }), "Locate the native read_file tool implementation.", [acceptedFact()])
  assert.ok("plan" in parsed, "discovery before source-specific verification is expressible without a fabricated path")
})

test("a plan path that matches the live accepted source is accepted", () => {
  const matching = locateReadFile({ kind: "source_location", identity: "implementation_symbol", symbol: "readFile", path: "src/extension/tools/workspace.ts" })
  const parsed = parseFeedbackPlanResponse(JSON.stringify({ track: true, plan: matching }), "Locate readFile.", [acceptedFact()])
  assert.ok("plan" in parsed)
})

test("superseded accepted evidence and the absence of evidence never contradict a planner path", () => {
  const guessed = JSON.stringify({ track: true, plan: locateReadFile({ kind: "source_location", identity: "implementation_symbol", symbol: "readFile", path: "tools/read_file.ts" }) })
  assert.ok("plan" in parseFeedbackPlanResponse(guessed, "Locate readFile.", [acceptedFact({ supersededBy: "fact-2" })]))
  assert.ok("plan" in parseFeedbackPlanResponse(guessed, "Locate readFile.", []))
})

test("the trusted-facts prompt block lists live facts with exact locations and is bounded", () => {
  assert.equal(trustedFactsBlock([]), "")
  assert.equal(trustedFactsBlock([acceptedFact({ supersededBy: "fact-2" })]), "", "superseded facts are not presented as authoritative")
  const block = trustedFactsBlock([acceptedFact()])
  assert.match(block, /^Trusted accepted facts \(authoritative project evidence\):/)
  assert.match(block, /registered tool read_file implemented by readFile at src\/extension\/tools\/workspace\.ts lines 169-220/)
  const many = Array.from({ length: 30 }, (_, index) => acceptedFact({ id: `fact-${index}`, path: `src/file-${index}.ts`, registeredTool: undefined, symbol: `symbol${index}` }))
  assert.equal(trustedFactsBlock(many).split("\n").length, 21, "one heading plus at most twenty facts")
})

const twinnyRegistration = acceptedFact({
  id: "fact-twinny",
  criterion: "twinny_todo_update is registered",
  toolName: "twinny_todo_update",
  symbol: "updateTodos",
  registeredTool: "twinny_todo_update",
  path: "src/extension/todos/tool.ts",
  startLine: 10,
  endLine: 40
})

test("an implementation_symbol that names a registered tool is repaired to identity-free, keeping its kind and target, and the repair is reported", () => {
  const invalid = lookupReply({ kind: "accepted_fact_exists", identity: "implementation_symbol", symbol: "twinny_todo_update" })
  const parsed = parseFeedbackPlanResponse(invalid, "Locate twinny_todo_update.", [twinnyRegistration])
  assert.ok("plan" in parsed, "the registration-named target is repaired, not rejected")
  assert.deepEqual("repairs" in parsed ? parsed.repairs : undefined, ["lookup/criterion-2: implementation_symbol twinny_todo_update -> identity-free"])
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.plan.tasks[0].criteria[1].verification)), { kind: "accepted_fact_exists", symbol: "twinny_todo_update" })
})

test("a registered_tool that names a declaration is repaired to identity-free, and a correct identity is never changed", () => {
  const declaration = parseFeedbackPlanResponse(lookupReply({ kind: "accepted_fact_exists", identity: "registered_tool", symbol: "updateTodos" }), "Locate updateTodos.", [twinnyRegistration])
  assert.ok("plan" in declaration)
  assert.deepEqual("repairs" in declaration ? declaration.repairs : undefined, ["lookup/criterion-2: registered_tool updateTodos -> identity-free"])
  const correct = parseFeedbackPlanResponse(lookupReply({ kind: "accepted_fact_exists", identity: "registered_tool", symbol: "twinny_todo_update" }), "Locate twinny_todo_update.", [twinnyRegistration])
  assert.ok("plan" in correct)
  assert.equal("repairs" in correct, false, "a criterion that agrees with evidence is unchanged")
  assert.equal(JSON.parse(JSON.stringify(correct.plan.tasks[0].criteria[1].verification)).identity, "registered_tool")
})

test("an implementation_symbol that no accepted evidence contradicts is left as written, never silently changed", () => {
  const parsed = parseFeedbackPlanResponse(lookupReply({ kind: "accepted_fact_exists", identity: "implementation_symbol", symbol: "ghostTool" }), "Locate ghostTool.", [twinnyRegistration])
  assert.ok("plan" in parsed)
  assert.equal("repairs" in parsed, false)
  assert.equal(JSON.parse(JSON.stringify(parsed.plan.tasks[0].criteria[1].verification)).identity, "implementation_symbol")
})

test("the twinny_todo_update scenario: accepted registration reaches the planner, the wrong identity is repaired without another call, and the plan is written", async () => {
  await withRepository(async (repository) => {
    const withEvidence: FeedbackPlanRepository = {
      getIntentTaskPlan: (request) => repository.getIntentTaskPlan(request),
      intentPlanClosed: (request) => repository.intentPlanClosed(request),
      listAcceptedEvidence: async () => [twinnyRegistration],
      synchronizeIntentPlan: (request, candidate, intentResult) => repository.synchronizeIntentPlan(request, candidate, intentResult)
    }
    const requests: Sent[] = []
    const planner = plannerWith(withEvidence, scripted([
      lookupReply({ kind: "accepted_fact_exists", identity: "implementation_symbol", symbol: "twinny_todo_update" })
    ], requests))
    const { result } = await quietly(() => planner.start(scope, "Locate twinny_todo_update."))
    assert.equal(result.status, "planned")
    assert.equal(requests.length, 1, "the repair needs no second planning call")
    assert.match(requests[0].user, /registered tool twinny_todo_update implemented by updateTodos/)
    const stored = await repository.getIntentTaskPlan(scope)
    assert.ok(stored)
    assert.deepEqual(JSON.parse(JSON.stringify(stored.tasks[0].criteria[1].verification)), { kind: "accepted_fact_exists", symbol: "twinny_todo_update" })
  })
})

test("a correction carries the rejected reply and the exact diagnostic, and a revised valid criterion is accepted", async () => {
  await withRepository(async (repository) => {
    const rejected = lookupReply({ kind: "accepted_fact_exists", identity: "tool", symbol: "twinny_todo_update" })
    const corrected = lookupReply({ kind: "accepted_fact_exists", identity: "registered_tool", symbol: "twinny_todo_update" })
    const requests: Sent[] = []
    const planner = plannerWith(repository, scripted([rejected, corrected], requests))
    const { result } = await quietly(() => planner.start(scope, "Check twinny_todo_update."))
    assert.equal(result.status, "planned")
    assert.equal(requests.length, 2)
    assert.match(requests[1].user, /Your previous reply was rejected: Invalid task plan: plan\.tasks\[0\]\.criteria\[1\]\.verification\.identity must be registered_tool or implementation_symbol when given; received "tool"\./)
    assert.ok(requests[1].user.includes(JSON.stringify(rejected)), "the correction includes the rejected contract")
    assert.ok(await repository.getIntentTaskPlan(scope))
  })
})

test("a failed plan leaves no planning in flight, so the next message can plan", async () => {
  await withRepository(async (repository) => {
    const invalid = lookupReply({ kind: "accepted_fact_exists", identity: "tool", symbol: "twinny_todo_update" })
    const planner = plannerWith(repository, scripted([invalid, invalid], []))
    const { result } = await quietly(() => planner.start(scope, "Check twinny_todo_update."))
    assert.equal(result.status, "failed")
    assert.equal(planner.pending(), undefined, "a failed planning releases its operation")
    const next = plannerWith(repository, scripted([validReply()]))
    const followUp = await quietly(() => next.start(scope, "Try again."))
    assert.equal(followUp.result.status, "planned")
  })
})

const evidenceRepository = (repository: TodoRepository, facts: AcceptedFact[]): FeedbackPlanRepository => ({
  getIntentTaskPlan: (request) => repository.getIntentTaskPlan(request),
  intentPlanClosed: (request) => repository.intentPlanClosed(request),
  listAcceptedEvidence: async () => facts,
  synchronizeIntentPlan: (request, candidate, intentResult) => repository.synchronizeIntentPlan(request, candidate, intentResult)
})

const rangeTask = (verification: Record<string, unknown>) => ({
  id: "lookup",
  title: "Locate twinny_todo_update",
  description: "Find the registered tool and its implementation range.",
  dependencies: [],
  criteria: [
    { id: "criterion-1", description: "The project-wide accepted evidence lookup has completed.", verification: { kind: "evidence_lookup_completed" } },
    { id: "criterion-2", description: "The twinny_todo_update implementation range is located.", verification }
  ]
})

const rangeAnswer = (identity: string) => [{ id: "range", source: { identity, symbol: "twinny_todo_update" }, fields: ["range"] }]

test("an answer range on a repaired implementation criterion stays consistent: the answer is repaired with it and the plan is written, not failed at persistence", async () => {
  await withRepository(async (repository) => {
    const reply = JSON.stringify({
      track: true,
      plan: plan({
        tasks: [rangeTask({ kind: "source_range", identity: "implementation_symbol", symbol: "twinny_todo_update" })],
        answer: rangeAnswer("implementation_symbol")
      })
    })
    const requests: Sent[] = []
    const planner = plannerWith(evidenceRepository(repository, [twinnyRegistration]), scripted([reply], requests))
    const { result } = await quietly(() => planner.start(scope, "Locate twinny_todo_update."))
    assert.equal(result.status, "planned", "error" in result ? result.error : undefined)
    assert.equal(requests.length, 1, "the repair needs no second planning call")
    const stored = await repository.getIntentTaskPlan(scope)
    assert.ok(stored)
    assert.deepEqual(JSON.parse(JSON.stringify(stored.tasks[0].criteria[1].verification)), { kind: "source_range", symbol: "twinny_todo_update" })
    const context = await repository.getActiveIntentContext(scope)
    assert.deepEqual(JSON.parse(JSON.stringify(context?.answer)), [{ id: "range", source: { symbol: "twinny_todo_update" }, fields: ["range"] }])
  })
})

test("an answer that names an identity its criterion no longer has is returned to planning with the diagnostic, not thrown at persistence", async () => {
  await withRepository(async (repository) => {
    const rejected = JSON.stringify({
      track: true,
      plan: plan({
        tasks: [rangeTask({ kind: "source_range", identity: "implementation_symbol", symbol: "twinny_todo_update" })],
        answer: rangeAnswer("registered_tool")
      })
    })
    const corrected = JSON.stringify({
      track: true,
      plan: plan({
        tasks: [rangeTask({ kind: "source_range", identity: "registered_tool", symbol: "twinny_todo_update" })],
        answer: rangeAnswer("registered_tool")
      })
    })
    const requests: Sent[] = []
    const planner = plannerWith(evidenceRepository(repository, [twinnyRegistration]), scripted([rejected, corrected], requests))
    const { result } = await quietly(() => planner.start(scope, "Locate twinny_todo_update."))
    assert.equal(result.status, "planned", "error" in result ? result.error : undefined)
    assert.equal(requests.length, 2, "the mismatch is corrected by planning, not terminal")
    assert.match(requests[1].user, /Your previous reply was rejected: Invalid task plan: plan\.answer\[0\]\.fields includes range, but no source_range criterion in the plan names twinny_todo_update\./)
  })
})

test("a repaired answer identity is reported with the criterion repair", () => {
  const reply = JSON.stringify({
    track: true,
    plan: plan({
      tasks: [rangeTask({ kind: "source_range", identity: "implementation_symbol", symbol: "twinny_todo_update" })],
      answer: rangeAnswer("implementation_symbol")
    })
  })
  const parsed = parseFeedbackPlanResponse(reply, "Locate twinny_todo_update.", [twinnyRegistration])
  assert.ok("plan" in parsed)
  assert.deepEqual("repairs" in parsed ? parsed.repairs : undefined, [
    "lookup/criterion-2: implementation_symbol twinny_todo_update -> identity-free",
    "answer/range: implementation_symbol twinny_todo_update -> identity-free"
  ])
})
