import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { logger } from "../../common/logger"
import type { TodoListSnapshot } from "../../common/types"
import { FeedbackPlanner, parseFeedbackPlanResponse } from "../../extension/chat/feedback-planner"
import type { RoleInference, RoleResolution } from "../../extension/chat/role-inference"
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
