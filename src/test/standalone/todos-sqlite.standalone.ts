import BetterSqlite from "better-sqlite3"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { logger } from "../../common/logger"
import { TodoRepository, TodoWriteDeniedError, trustedTodoPanelApproval, workspaceProjectFingerprint } from "../../extension/todos/repository"
import { type LegacyTodoRetirement, prepareProjectTodoStorage, resolveProjectTodoStorage, retireLegacyTodoDatabase } from "../../extension/todos/sqlite"
import { type TodoCompletionClaim, TodoConflictError } from "../../extension/todos/types"


test("the TODO database opens when process.report yields no report, as in some extension-host processes", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-native-binding-"))
  try {
    const databasePath = path.join(directory, "twinny-state.sqlite")
    // A child process has a fresh better-sqlite3 binding cache, so the open must not depend on earlier opens.
    const script = `
      process.report.getReport = () => undefined
      const { SqliteFile, closeTodoDatabases } = require(process.argv[1])
      new SqliteFile(process.argv[2]).initialize().then(
        () => closeTodoDatabases(),
        (error) => { console.error(error); process.exitCode = 1; closeTodoDatabases() }
      )
    `
    execFileSync(process.execPath, ["-e", script, path.join(__dirname, "../../extension/todos/sqlite.js"), databasePath], { stdio: "pipe" })
    assert.ok(fs.existsSync(databasePath))
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("the repository rejects TODO writes whose writer is not the target conversation, and leaves the list unchanged", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-write-isolation-"))
  try {
    const databasePath = path.join(directory, "twinny-state.sqlite")
    const project = workspaceProjectFingerprint(["file:///write-isolation"])
    const owner = { projectFingerprint: project, conversationId: "owner-chat", writer: "owner-chat" }
    const intruder = { ...owner, writer: "intruder-chat" }
    const repository = new TodoRepository(databasePath)
    const item = await repository.createItem(owner, { title: "Owner task" }, "owner-create")
    const itemCountBefore = (await repository.getList(owner)).items.length
    const before = JSON.stringify(await repository.getList(owner))

    await assert.rejects(async () => repository.createItem(intruder, { title: "Injected task" }, "intruder-create"), TodoWriteDeniedError)
    await assert.rejects(async () => repository.updateItem(intruder, {
      itemId: item.id, expectedVersion: item.version, patch: { title: "Rewritten" }, actor: "model", requestId: "intruder-update"
    }), TodoWriteDeniedError)
    await assert.rejects(async () => repository.addEvidence(intruder, {
      itemId: item.id, kind: "forged", summary: "Forged evidence", result: "passed", requestId: "intruder-evidence"
    }), TodoWriteDeniedError)

    assert.equal(JSON.stringify(await repository.getList(owner)), before, "a denied write must not change the owner's list")
    assert.equal((await repository.getList(owner)).items.length, itemCountBefore)

    const intruderOwnList = { ...intruder, conversationId: "intruder-chat" }
    assert.equal((await repository.getList(intruderOwnList)).items.length, 0, "the intruder's own list is untouched")

    const read = await repository.getList(intruder)
    assert.equal(read.items[0].title, "Owner task", "reading another conversation's TODO list stays allowed")

    const ownWrite = await repository.createItem(owner, { title: "Owner follow-up" }, "owner-followup")
    assert.equal(ownWrite.title, "Owner follow-up", "the owner can still write to its own list")
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("native TODO SQLite repository persists scoped lists, idempotency, and user completion", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-todos-"))
  try {
    const databasePath = path.join(directory, "twinny-state.sqlite")
    const scope = { projectFingerprint: workspaceProjectFingerprint(["file:///project-a"]), conversationId: "chat-a", writer: "chat-a" }
    const repository = new TodoRepository(databasePath)

    const firstSnapshot = await repository.getList(scope)
    const created = await repository.createItem(scope, { title: "Persist this task" }, "request-create")
    const duplicate = await repository.createItem(scope, { title: "Persist this task" }, "request-create")
    assert.equal(duplicate.id, created.id)
    assert.equal((await repository.getList(scope)).items.length, 1)

    const otherChat = await repository.getList({ ...scope, conversationId: "chat-b" })
    const otherProject = await repository.getList({ ...scope, projectFingerprint: "different-project" })
    assert.equal(otherChat.items.length, 0)
    assert.equal(otherProject.items.length, 0)
    assert.notEqual(otherChat.id, firstSnapshot.id)
    const sameRequestInOtherChat = await repository.createItem({ ...scope, conversationId: "chat-b", writer: "chat-b" }, { title: "Isolated retry token" }, "request-create")
    assert.notEqual(sameRequestInOtherChat.id, created.id)
    assert.notEqual(otherChat.id, firstSnapshot.id)

    const reopened = new TodoRepository(databasePath)
    const persisted = await reopened.getList(scope)
    assert.equal(persisted.items[0].id, created.id)
    assert.equal(persisted.items[0].title, "Persist this task")

    const claimed = await reopened.updateItem(scope, {
      itemId: created.id,
      expectedVersion: created.version,
      patch: { status: "completed" },
      actor: "model",
      requestId: "request-model-complete"
    })
    assert.equal(claimed.status, "in_review")
    assert.equal(claimed.verification, "not_checked")

    await assert.rejects(
      reopened.updateItem(scope, {
        itemId: created.id,
        expectedVersion: created.version,
        patch: { title: "Stale overwrite" },
        actor: "user",
        requestId: "request-stale"
      }),
      TodoConflictError
    )

    const userAuthored = await reopened.createItem(scope, { title: "User-owned requirement" }, "request-user-create", "user")
    await assert.rejects(
      reopened.updateItem(scope, {
        itemId: userAuthored.id,
        expectedVersion: userAuthored.version,
        patch: { title: "Overwrite user requirement" },
        actor: "model",
        requestId: "request-user-overwrite"
      }),
      TodoConflictError
    )

    const second = await reopened.createItem(scope, { title: "Second item" }, "request-second")
    const reordered = await reopened.updateItem(scope, {
      itemId: second.id,
      expectedVersion: second.version,
      patch: { sortOrder: 1 },
      actor: "user",
      requestId: "request-reorder"
    })
    assert.equal(reordered.sortOrder, 1)
    assert.deepEqual((await reopened.getList(scope)).items.map((item) => item.title), ["Persist this task", "Second item", "User-owned requirement"])

    const approved = await reopened.completeByUser(scope, created.id, claimed.version, "Reviewed by user", "request-user-complete", trustedTodoPanelApproval)
    assert.equal(approved.status, "completed")
    assert.equal(approved.verification, "waived")
    const reopenedItem = await reopened.updateItem(scope, {
      itemId: approved.id,
      expectedVersion: approved.version,
      patch: { status: "pending" },
      actor: "user",
      requestId: "request-reopen"
    })
    assert.equal(reopenedItem.status, "pending")
    assert.equal(reopenedItem.verification, "not_checked")
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("native TODO repository serializes concurrent writers across repository instances", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-todos-concurrent-"))
  try {
    const databasePath = path.join(directory, "twinny-state.sqlite")
    const scope = { projectFingerprint: "project", conversationId: "chat", writer: "chat" }
    const first = new TodoRepository(databasePath)
    const second = new TodoRepository(databasePath)

    await Promise.all([
      first.createItem(scope, { title: "First" }, "concurrent-first"),
      second.createItem(scope, { title: "Second" }, "concurrent-second")
    ])

    const snapshot = await first.getList(scope)
    assert.deepEqual(snapshot.items.map((item) => item.title).sort(), ["First", "Second"])
    assert.equal(snapshot.items.length, 2)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("native TODO toolset is namespaced, scoped, and sends authoritative snapshots", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-todos-tools-"))
  try {
    const scope = { projectFingerprint: "tool-project", conversationId: "tool-chat", writer: "tool-chat" }
    const repository = new TodoRepository(path.join(directory, "twinny-state.sqlite"))
    let changed = 0
    const tools = (await import("../../extension/tools/todos")).todoWorkspaceTools(repository, scope, () => { changed += 1 })
    assert.deepEqual(tools.tools.map((tool) => tool.name), [
      "twinny_todo_list",
      "twinny_todo_get",
      "twinny_evidence_lookup",
      "twinny_todo_create",
      "twinny_todo_update",
      "twinny_todo_evidence"
    ])

    const created = await tools.run({
      name: "twinny_todo_create",
      args: { title: "Create from native tool", request_id: "tool-create", todo_parent_id: "" }
    })
    assert.equal(created.failed, undefined)
    assert.equal(JSON.parse(created.output).item.parentId, undefined, "an empty optional parent is treated as no parent")
    assert.equal(changed, 1)
    const listed = await tools.run({ name: "twinny_todo_list", args: {} })
    assert.equal(listed.failed, undefined)
    assert.match(listed.output, /Create from native tool/)

    const completionClaim = await tools.run({
      name: "twinny_todo_update",
      args: {
        item_id: JSON.parse(created.output).item_id,
        expected_version: "1",
        request_id: "tool-complete",
        status: "completed"
      }
    })
    assert.equal(JSON.parse(completionClaim.output).task_status, "in_review")
    assert.equal(JSON.parse(completionClaim.output).retry_required, false)
    assert.match(completionClaim.summary, /completion claim accepted/)
    assert.equal(changed, 2)

    const modelCompletion = await tools.run({
      name: "twinny_todo_complete",
      args: {
        item_id: JSON.parse(created.output).item_id,
        expected_version: "2",
        request_id: "tool-model-complete",
        reason: "The user explicitly asked to mark this TODO complete."
      }
    })
    assert.ok(modelCompletion.failed, "the model has no tool that completes or waives a TODO")
    assert.equal(changed, 2)
    const forged = repository.completeByUser(scope, JSON.parse(created.output).item_id, 2, "forged", "tool-forged-complete", { source: "model" } as never)
    await assert.rejects(forged, /Only an explicit user action/)
    const approved = await repository.completeByUser(
      scope, JSON.parse(created.output).item_id, 2, "The user explicitly asked to mark this TODO complete.", "tool-explicit-complete", trustedTodoPanelApproval
    )
    assert.equal(approved.status, "completed")
    assert.equal(approved.verification, "waived")

    const evidence = await tools.run({
      name: "twinny_todo_evidence",
      args: {
        item_id: JSON.parse(created.output).item_id,
        kind: "test",
        summary: "Native TODO create/read/update/evidence test",
        result: "successful",
        request_id: "tool-evidence"
      }
    })
    assert.equal(JSON.parse(evidence.output).result, "passed", "common success wording normalizes to the stored result")
    assert.equal(changed, 3, "the trusted panel completion is not a model tool change, so it does not fire the tool callback")

    const invalidEvidence = await tools.run({
      name: "twinny_todo_evidence",
      args: {
        item_id: JSON.parse(created.output).item_id,
        kind: "test",
        summary: "Invalid result is rejected clearly",
        result: "unknown",
        request_id: "tool-invalid-evidence"
      }
    })
    assert.equal(invalidEvidence.failed, true)
    assert.match(invalidEvidence.output, /^Native TODO tool error:/)
    assert.match(invalidEvidence.output, /must be observed, passed, or failed/)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("concurrent and stale plan revisions are resolved transactionally without losing progress or accepted children", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-revision-todos-"))
  try {
    const databasePath = path.join(directory, "twinny-state.sqlite")
    const scope = { projectFingerprint: workspaceProjectFingerprint(["file:///project-revision"]), conversationId: "chat-revision", writer: "chat-revision" }
    const repository = new TodoRepository(databasePath)
    const makePlan = (revision: number, title = "Inspect parser") => ({
      planId: "plan-revision",
      version: 1 as const,
      revision,
      goal: "Keep the parser reliable",
      constraints: ["Preserve public API"],
      tasks: [
        { id: "inspect", title, description: "Inspect the parser", criteria: [{ id: "parser-inspected", description: "Parser inspected", verification: { kind: "semantic_review" } }], dependencies: [] },
        { id: "verify", title: "Verify parser", description: "Run focused checks", criteria: [{ id: "checks-pass", description: "Checks pass", verification: { kind: "semantic_review" } }], dependencies: ["inspect"] }
      ]
    })
    const intentResult = (plan: ReturnType<typeof makePlan>) => ({ prompt: "Fix the parser", plan })

    const seeded = await repository.synchronizeIntentPlan(scope, makePlan(1), intentResult(makePlan(1)))
    const inspect = seeded.items[0]
    await repository.updateItem(scope, { itemId: inspect.id, expectedVersion: inspect.version, patch: { status: "completed" }, actor: "model", requestId: "revision-claim" })

    const racing = await Promise.allSettled([
      repository.synchronizeIntentPlan(scope, makePlan(2, "Inspect parser A"), intentResult(makePlan(2, "Inspect parser A"))),
      repository.synchronizeIntentPlan(scope, makePlan(2, "Inspect parser B"), intentResult(makePlan(2, "Inspect parser B")))
    ])
    const winners = racing.filter((result) => result.status === "fulfilled")
    const losers = racing.flatMap((result) => result.status === "rejected" ? [result.reason] : [])
    assert.equal(winners.length, 1, "exactly one same-revision plan commits")
    assert.equal(losers.length, 1)
    assert.ok(losers[0] instanceof TodoConflictError)
    const winnerTitle = (await repository.getList(scope)).items.find((item) => item.id === inspect.id)?.title
    assert.ok(winnerTitle === "Inspect parser A" || winnerTitle === "Inspect parser B")
    assert.equal((await repository.getIntentTaskPlan(scope))?.revision, 2)
    assert.equal((await repository.getList(scope)).items.find((item) => item.id === inspect.id)?.status, "in_review", "claimed progress survives the conflict")

    const proposal = {
      parentId: inspect.id,
      title: "Trace the delimiter caller",
      details: "Follow the delimiter branch to its caller.",
      reason: "The parent needs the caller trace.",
      priority: "normal" as const,
      requestId: "child-race"
    }
    const child = await repository.applyChildTodo(scope, proposal, { decision: "accepted", instruction: "Accepted under the parent." })
    assert.equal(child.planRevision, 3)
    const afterChild = await repository.getList(scope)
    const childItem = afterChild.items.find((item) => item.title === "Trace the delimiter caller")
    assert.equal(childItem?.parentId, inspect.id)

    const staleRevision = makePlan(3, "Inspect parser boundaries")
    await assert.rejects(
      repository.synchronizeIntentPlan(scope, staleRevision, intentResult(staleRevision)),
      TodoConflictError,
      "a plan built before the accepted child cannot overwrite its revision"
    )
    assert.deepEqual(await repository.getList(scope), afterChild, "the rejected revision leaves no partial writes")

    const replanned = makePlan(4, "Inspect parser boundaries")
    await repository.synchronizeIntentPlan(scope, replanned, intentResult(replanned))
    const finalList = await repository.getList(scope)
    assert.equal(finalList.items.find((item) => item.id === inspect.id)?.title, "Inspect parser boundaries")
    assert.equal(finalList.items.find((item) => item.id === inspect.id)?.status, "in_review", "verified progress is preserved across the re-plan")
    assert.ok(finalList.items.some((item) => item.id === childItem?.id), "the accepted child survives the re-plan")
    assert.equal((await repository.getIntentTaskPlan(scope))?.revision, 4)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("intent plans reconcile atomically, preserve progress, evidence, and chat isolation", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-intent-todos-"))
  try {
    const databasePath = path.join(directory, "twinny-state.sqlite")
    const scope = { projectFingerprint: workspaceProjectFingerprint(["file:///project-a"]), conversationId: "chat-plan-a", writer: "chat-plan-a" }
    const repository = new TodoRepository(databasePath)
    const makePlan = (revision: number, title = "Inspect parser") => ({
      planId: "plan-parser",
      version: 1 as const,
      revision,
      goal: "Make parser behavior reliable",
      constraints: ["Preserve public API"],
      tasks: [
        { id: "inspect-parser", title, description: "Inspect the parser implementation", criteria: [{ id: "faulty-branch", description: "Identify the faulty branch", verification: { kind: "semantic_review" } }], dependencies: [] },
        { id: "fix-parser", title: "Fix parser", description: "Correct the faulty branch", criteria: [{ id: "regression-test", description: "Regression test passes", verification: { kind: "semantic_review" } }], dependencies: ["inspect-parser"] },
        { id: "verify-parser", title: "Verify parser", description: "Run focused checks", criteria: [{ id: "focused-tests", description: "Focused tests pass", verification: { kind: "semantic_review" } }], dependencies: ["fix-parser"] }
      ]
    })
    const firstPlan = makePlan(1)
    const intentResult = { objective: "Make parser behavior reliable", prompt: "Fix the parser", plan: firstPlan }
    const first = await repository.synchronizeIntentPlan(scope, firstPlan, intentResult)
    assert.equal(first.items.filter((item) => item.source === "intent_compiler").length, 3)
    assert.deepEqual(first.items.map((item) => item.title), ["Inspect parser", "Fix parser", "Verify parser"])
    assert.deepEqual(first.items[0].criteria?.map((criterion) => criterion.description), ["Identify the faulty branch"])
    const repeated = await repository.synchronizeIntentPlan(scope, firstPlan, intentResult)
    assert.equal(repeated.id, first.id)
    assert.equal(repeated.items.length, 3)

    const inspect = first.items[0]
    const claimed = await repository.updateItem(scope, {
      itemId: inspect.id,
      expectedVersion: inspect.version,
      patch: { status: "in_progress" },
      actor: "user",
      requestId: "plan-manual-claim"
    })
    await repository.addEvidence(scope, {
      itemId: inspect.id,
      kind: "review",
      summary: "The parser accepts malformed delimiters.",
      result: "observed",
      requestId: "plan-evidence"
    })
    const revised = makePlan(2, "Inspect parser edge cases")
    revised.tasks[0].description = "Inspect delimiter and recovery behavior"
    const afterRevision = await repository.synchronizeIntentPlan(scope, revised, { ...intentResult, plan: revised })
    const changedTask = afterRevision.items.find((item) => item.id === inspect.id)!
    assert.equal(changedTask.title, "Inspect parser edge cases")
    assert.equal(changedTask.status, "in_progress")
    assert.equal(changedTask.source, "intent_compiler")
    assert.equal(changedTask.version, claimed.version + 1)
    assert.equal((await repository.getItem(scope, inspect.id)).evidence.length, 1)

    const completed = await repository.completeByUser(scope, inspect.id, changedTask.version, "Inspection is complete", "plan-explicit-complete", trustedTodoPanelApproval)
    const thirdRevision = makePlan(3, "Inspect parser boundaries")
    await repository.synchronizeIntentPlan(scope, thirdRevision, { ...intentResult, plan: thirdRevision })
    const completedTask = (await repository.getList({ ...scope, includeCompleted: true })).items.find((item) => item.id === inspect.id)!
    assert.equal(completed.status, "completed")
    assert.equal(completedTask.status, "completed")
    assert.equal(completedTask.verification, "waived")
    assert.equal((await repository.getItem(scope, inspect.id)).evidence.length, 1)

    const otherScope = { ...scope, conversationId: "chat-plan-b", writer: "chat-plan-b" }
    const otherPlan = { ...makePlan(1), planId: "other-plan", goal: "Different chat goal", tasks: [
      { id: "other-task", title: "Other chat task", description: "Keep chat plans isolated", criteria: [{ id: "chat-isolated", description: "Only this chat sees the task", verification: { kind: "semantic_review" } }], dependencies: [] }
    ] }
    await repository.synchronizeIntentPlan(otherScope, otherPlan, { prompt: "Other plan", plan: otherPlan })
    assert.deepEqual((await repository.getList(otherScope)).items.map((item) => item.title), ["Other chat task"])
    assert.equal((await repository.getList(scope)).items.length, 3)

    const revisedWithoutOneTask = { ...makePlan(4, "Inspect parser boundaries"), tasks: makePlan(4, "Inspect parser boundaries").tasks.slice(0, 2) }
    await repository.synchronizeIntentPlan(scope, revisedWithoutOneTask, { ...intentResult, plan: revisedWithoutOneTask })
    assert.equal((await repository.getList({ ...scope, includeCompleted: true })).items.length, 3, "removed plan tasks remain in the native TODO history")
    const beforeInvalid = await repository.getList(scope)
    const invalidPlan = { ...makePlan(5), tasks: [] }
    assert.throws(() => repository.synchronizeIntentPlan(scope, invalidPlan, { plan: invalidPlan }), /Invalid intent plan/)
    assert.deepEqual(await repository.getList(scope), beforeInvalid)
    await assert.rejects(repository.synchronizeIntentPlan(scope, makePlan(3, "Stale plan"), { plan: makePlan(3, "Stale plan") }), /older than the stored revision/)
    assert.deepEqual(await repository.getList(scope), beforeInvalid)

    const reopened = new TodoRepository(databasePath)
    const persistedPlan = await reopened.getIntentTaskPlan(scope)
    assert.equal(persistedPlan?.revision, 4)
    assert.equal(persistedPlan?.tasks.length, 2)
    assert.equal((await reopened.getIntentResult(scope) as { prompt?: string } | undefined)?.prompt, "Fix the parser")
    assert.equal((await reopened.getItem(scope, inspect.id)).item.status, "completed")
    assert.equal((await reopened.getItem(scope, inspect.id)).evidence[0].summary, "The parser accepts malformed delimiters.")
    const context = await reopened.getActiveIntentContext(scope)
    assert.equal(context?.planTaskId, "fix-parser")
    assert.deepEqual(context?.criteria.map((criterion) => criterion.description), ["Regression test passes"])
    assert.equal(context?.goal, "Make parser behavior reliable")
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("a replacement for a completed plan relinks reused task IDs to new items and leaves the completed items intact", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-replacement-todos-"))
  try {
    const databasePath = path.join(directory, "twinny-state.sqlite")
    const scope = { projectFingerprint: workspaceProjectFingerprint(["file:///project-replace"]), conversationId: "chat-replace", writer: "chat-replace" }
    const repository = new TodoRepository(databasePath)
    const planWith = (planId: string, revision: number, tasks: { id: string; title: string }[]) => ({
      planId,
      version: 1 as const,
      revision,
      goal: "Keep the parser working",
      constraints: [],
      tasks: tasks.map((task) => ({ id: task.id, title: task.title, description: `${task.title} details`, criteria: [{ id: `${task.id}-done`, description: `${task.title} is done`, verification: { kind: "semantic_review" as const } }], dependencies: [] }))
    })
    const first = planWith("plan-first", 1, [{ id: "inspect", title: "Inspect parser" }, { id: "verify", title: "Verify parser" }])
    await repository.synchronizeIntentPlan(scope, first, { objective: "Keep the parser working", prompt: "Fix the parser", plan: first })
    for (const item of (await repository.getList({ ...scope, includeCompleted: true })).items) {
      await repository.completeByUser(scope, item.id, item.version, "Verified by user", `complete-${item.id}`, trustedTodoPanelApproval)
    }

    const second = planWith("plan-second", 2, [{ id: "inspect", title: "Inspect renderer" }, { id: "render", title: "Render check" }])
    await repository.synchronizeIntentPlan(scope, second, { objective: "Keep the parser working", prompt: "Check the renderer", plan: second })

    const stored = await repository.getIntentTaskPlan(scope)
    assert.equal(stored?.planId, "plan-second")
    assert.deepEqual(stored?.tasks.map((task) => [task.id, task.title]), [["inspect", "Inspect renderer"], ["render", "Render check"]], "a reused task ID shows its new item")
    const items = (await repository.getList({ ...scope, includeCompleted: true })).items
    assert.deepEqual(items.map((item) => [item.title, item.status]).sort(), [
      ["Inspect parser", "completed"],
      ["Inspect renderer", "pending"],
      ["Render check", "pending"],
      ["Verify parser", "completed"]
    ], "the completed plan's items keep their status and nothing is deleted")
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("failed tool operations report only the active plan's tasks across revisions and replacements, and keep superseded history", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-failure-scope-"))
  try {
    const databasePath = path.join(directory, "twinny-state.sqlite")
    const scope = { projectFingerprint: workspaceProjectFingerprint(["file:///project-failure-scope"]), conversationId: "chat-failure-scope", writer: "chat-failure-scope" }
    const repository = new TodoRepository(databasePath)
    const planWith = (planId: string, revision: number, tasks: { id: string; title: string }[]) => ({
      planId,
      version: 1 as const,
      revision,
      goal: "Keep the parser working",
      constraints: [],
      tasks: tasks.map((task) => ({ id: task.id, title: task.title, description: `${task.title} details`, criteria: [{ id: `${task.id}-done`, description: `${task.title} is done`, verification: { kind: "semantic_review" as const } }], dependencies: [] }))
    })
    const sync = (plan: ReturnType<typeof planWith>) => repository.synchronizeIntentPlan(scope, plan, { objective: plan.goal, prompt: plan.goal, plan })
    const failure = (itemId: string, output: string, executionId = "exec-a") => repository.recordToolObservation(scope, {
      itemId, toolName: "run_command", arguments: { command: "npm test" }, output, failed: true, exitCode: 1, requestId: `fail-${output}`, executionId
    })
    const failureLine = (output: string) => `run_command {"command":"npm test"} (exit 1): ${output}`
    const idOf = (snapshot: { items: { id: string; title: string }[] }, title: string) => snapshot.items.find((item) => item.title === title)!.id

    const first = await sync(planWith("plan-failures", 1, [{ id: "inspect", title: "Inspect parser" }, { id: "fix", title: "Fix parser" }, { id: "verify", title: "Verify parser" }]))
    const inspectOld = idOf(first, "Inspect parser")
    const fixOld = idOf(first, "Fix parser")
    await failure(fixOld, "fix failed in revision one")
    await failure(inspectOld, "inspect failed in revision one")
    assert.deepEqual(await repository.failedToolOperations(scope, "exec-a"), [failureLine("fix failed in revision one"), failureLine("inspect failed in revision one")])

    const revised = await sync(planWith("plan-failures", 2, [{ id: "inspect", title: "Inspect parser" }, { id: "verify", title: "Verify parser" }]))
    const verifyNew = idOf(revised, "Verify parser")
    await failure(verifyNew, "verify failed in revision two")
    assert.deepEqual(await repository.failedToolOperations(scope, "exec-a"), [
      failureLine("inspect failed in revision one"),
      failureLine("verify failed in revision two")
    ], "a task dropped by the revision leaves the report; the still-active task keeps its record")

    const items = (await repository.getList({ ...scope, includeCompleted: true })).items
    for (const item of items) {
      if (item.status !== "completed") await repository.completeByUser(scope, item.id, item.version, "Verified by user", `complete-${item.id}`, trustedTodoPanelApproval)
    }
    const replacement = await sync(planWith("plan-replacement", 3, [{ id: "inspect", title: "Inspect renderer" }]))
    assert.deepEqual(await repository.failedToolOperations(scope, "exec-b"), [], "a completed plan's failures do not leak into its replacement")
    await failure(idOf(replacement, "Inspect renderer"), "renderer failed in replacement", "exec-b")
    assert.deepEqual(await repository.failedToolOperations(scope, "exec-b"), [failureLine("renderer failed in replacement")])
    assert.deepEqual(await repository.failedToolOperations(scope, "exec-a"), [], "a different execution's failures are not reported for this one")
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("a review of a task the plan superseded names the supersession, while unknown and other conversations' items stay generic", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-superseded-review-"))
  try {
    const databasePath = path.join(directory, "twinny-state.sqlite")
    const project = workspaceProjectFingerprint(["file:///project-superseded-review"])
    const scope = { projectFingerprint: project, conversationId: "chat-superseded", writer: "chat-superseded" }
    const other = { projectFingerprint: project, conversationId: "chat-other", writer: "chat-other" }
    const repository = new TodoRepository(databasePath)
    const planWith = (planId: string, revision: number, tasks: { id: string; title: string }[]) => ({
      planId,
      version: 1 as const,
      revision,
      goal: "Keep the parser working",
      constraints: [],
      tasks: tasks.map((task) => ({ id: task.id, title: task.title, description: `${task.title} details`, criteria: [{ id: `${task.id}-done`, description: `${task.title} is done`, verification: { kind: "semantic_review" as const } }], dependencies: [] }))
    })
    const sync = (request: typeof scope, plan: ReturnType<typeof planWith>) => repository.synchronizeIntentPlan(request, plan, { objective: plan.goal, prompt: plan.goal, plan })
    const first = await sync(scope, planWith("plan-review", 1, [{ id: "inspect", title: "Inspect parser" }, { id: "fix", title: "Fix parser" }]))
    const fixId = first.items.find((item) => item.title === "Fix parser")!.id
    await sync(scope, planWith("plan-review", 2, [{ id: "inspect", title: "Inspect parser" }]))
    const otherId = (await sync(other, planWith("plan-other", 1, [{ id: "other", title: "Other chat task" }]))).items[0].id
    const evaluation = {} as Parameters<TodoRepository["applyEvaluation"]>[3]

    await assert.rejects(() => repository.applyEvaluation(scope, fixId, 1, evaluation, "review-superseded"),
      { message: "TODO item belongs to a superseded plan revision and is no longer part of the active plan" })
    await assert.rejects(() => repository.applyEvaluation(scope, "no-such-item", 1, evaluation, "review-unknown"),
      { message: "Review task was not found in the active conversation" })
    await assert.rejects(() => repository.applyEvaluation(scope, otherId, 1, evaluation, "review-other"),
      { message: "Review task was not found in the active conversation" }, "another conversation's item is indistinguishable from an unknown one")
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("evidence records log successes at DEBUG and failures at INFO, so routine evidence stays out of INFO", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-evidence-log-"))
  const lines: { level: "info" | "debug"; message: string }[] = []
  const { info, debug } = logger
  logger.info = (message) => lines.push({ level: "info", message })
  logger.debug = (message) => lines.push({ level: "debug", message })
  try {
    const databasePath = path.join(directory, "twinny-state.sqlite")
    const scope = { projectFingerprint: workspaceProjectFingerprint(["file:///project-evidence-log"]), conversationId: "chat-evidence-log", writer: "chat-evidence-log" }
    const repository = new TodoRepository(databasePath)
    const plan = {
      planId: "plan-evidence-log", version: 1 as const, revision: 1, goal: "Locate the parser", constraints: [],
      tasks: [{ id: "locate", title: "Locate the parser", description: "Find the parser", criteria: [{ id: "parser-located", description: "Parser located", verification: { kind: "semantic_review" } }], dependencies: [] }]
    }
    const [item] = (await repository.synchronizeIntentPlan(scope, plan, { objective: "Locate the parser", prompt: "Where is the parser?", plan })).items
    lines.length = 0
    const observe = (requestId: string, failed: boolean) => repository.recordToolObservation(scope, {
      itemId: item.id, toolName: "read_file", arguments: { path: "src/parser.ts" }, output: failed ? "not found" : "parser body", failed, requestId
    })
    await observe("observe-ok", false)
    await observe("observe-failed", true)

    const recorded = lines.filter((line) => line.message.includes("todo.evidence.recorded"))
    assert.deepEqual(recorded.map((line) => [line.level, line.message.includes("\"failed\":true")]), [["debug", false], ["info", true]])
  } finally {
    logger.info = info
    logger.debug = debug
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("native TODO transitions reject placeholder blocks, recover blocked tasks, and ignore repeated completion claims", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-transition-todos-"))
  try {
    const scope = { projectFingerprint: workspaceProjectFingerprint(["file:///project-transitions"]), conversationId: "chat-transitions", writer: "chat-transitions" }
    const repository = new TodoRepository(path.join(directory, "twinny-state.sqlite"))
    const item = await repository.createItem(scope, { title: "Locate the parser" }, "request-create-transition")

    await assert.rejects(
      repository.updateItem(scope, { itemId: item.id, expectedVersion: item.version, patch: { status: "blocked", blockedReason: "No reason" }, actor: "model", requestId: "block-placeholder" }),
      /specific reason/
    )
    await assert.rejects(
      repository.updateItem(scope, { itemId: item.id, expectedVersion: item.version, patch: { status: "blocked", blockedReason: "tbd" }, actor: "model", requestId: "block-tbd" }),
      /specific reason/
    )

    const blocked = await repository.updateItem(scope, {
      itemId: item.id, expectedVersion: item.version,
      patch: { status: "blocked", blockedReason: "The parser module is missing from the workspace" }, actor: "model", requestId: "block-real"
    })
    assert.equal(blocked.status, "blocked")

    const claimed = await repository.updateItem(scope, {
      itemId: item.id, expectedVersion: blocked.version, patch: { status: "completed" }, actor: "model", requestId: "claim-1"
    })
    assert.equal(claimed.status, "in_review")
    const repeated = await repository.updateItem(scope, {
      itemId: item.id, expectedVersion: claimed.version, patch: { status: "completed" }, actor: "model", requestId: "claim-2"
    })
    assert.equal(repeated.status, "in_review")
    assert.equal(repeated.version, claimed.version, "a repeated completion claim must not bump the version")

    const recovered = await repository.updateItem(scope, {
      itemId: item.id, expectedVersion: repeated.version, patch: { status: "in_progress" }, actor: "model", requestId: "recover"
    })
    assert.equal(recovered.status, "in_progress")
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("model-created TODO reconciliation ignores articles but keeps distinct tasks separate", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-dedupe-todos-"))
  try {
    const scope = { projectFingerprint: workspaceProjectFingerprint(["file:///project-dedupe"]), conversationId: "chat-dedupe", writer: "chat-dedupe" }
    const repository = new TodoRepository(path.join(directory, "twinny-state.sqlite"))
    const planned = await repository.createItem(scope, { title: "Locate and verify the native read_file definition" }, "plan-item", "user")
    const recreated = await repository.createItem(scope, { title: "Locate and verify native read_file definition" }, "model-recreate")
    assert.equal(recreated.id, planned.id)
    const distinct = await repository.createItem(scope, { title: "Locate and verify native edit_lines definition" }, "model-distinct")
    assert.notEqual(distinct.id, planned.id)
    assert.equal((await repository.getList(scope)).items.length, 2)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("the first completion claim is accepted once and repeats are acknowledged without version churn", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-claim-todos-"))
  try {
    const scope = { projectFingerprint: workspaceProjectFingerprint(["file:///project-claims"]), conversationId: "chat-claims", writer: "chat-claims" }
    const repository = new TodoRepository(path.join(directory, "twinny-state.sqlite"))
    const item = await repository.createItem(scope, { title: "Locate the read_file definition" }, "create-claim")

    const first = await repository.claimCompletion(scope, { itemId: item.id, expectedVersion: item.version, requestId: "claim-first" })
    assert.equal(first.disposition, "accepted")
    assert.equal(first.item.status, "in_review")
    assert.equal(first.item.verification, "not_checked")
    assert.equal(first.item.version, item.version + 1)
    assert.equal(first.review, "user_approval")

    const replay = await repository.claimCompletion(scope, { itemId: item.id, expectedVersion: item.version, requestId: "claim-first" })
    assert.deepEqual(replay, JSON.parse(JSON.stringify(first)), "an identical request replays its recorded acknowledgement")

    const newRequest = await repository.claimCompletion(scope, { itemId: item.id, expectedVersion: item.version, requestId: "claim-second" })
    assert.equal(newRequest.disposition, "already_submitted")
    assert.equal(newRequest.item.version, first.item.version)

    const currentVersion = await repository.claimCompletion(scope, { itemId: item.id, expectedVersion: first.item.version, requestId: "claim-third" })
    assert.equal(currentVersion.disposition, "already_submitted")
    assert.equal(currentVersion.item.version, first.item.version)

    await assert.rejects(
      repository.claimCompletion(scope, { itemId: item.id, expectedVersion: first.item.version + 1, requestId: "claim-future" }),
      TodoConflictError
    )

    await repository.completeByUser(scope, item.id, first.item.version, "Reviewed the claim", "user-complete", trustedTodoPanelApproval)
    await assert.rejects(
      repository.claimCompletion(scope, { itemId: item.id, expectedVersion: first.item.version, requestId: "claim-after-complete" }),
      /Cannot claim completion for a completed TODO/
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("eleven repeated completion requests produce one accepted claim, one review lifecycle, and no version churn", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-repeat-claims-"))
  try {
    const scope = { projectFingerprint: workspaceProjectFingerprint(["file:///project-repeat-claims"]), conversationId: "chat-repeat-claims", writer: "chat-repeat-claims" }
    const repository = new TodoRepository(path.join(directory, "twinny-state.sqlite"))
    const item = await repository.createItem(scope, { title: "Locate the native read_file definition" }, "create-repeat")

    const claims: TodoCompletionClaim[] = []
    for (let attempt = 1; attempt <= 11; attempt += 1) {
      const requestId = attempt <= 2 ? "todo1-update" : `todo1-update-${attempt}`
      const expectedVersion = attempt % 3 === 0 ? claims[0].item.version : item.version
      const claim = await repository.claimCompletion(scope, { itemId: item.id, expectedVersion, requestId })
      if (attempt === 2) {
        assert.deepEqual(claim, JSON.parse(JSON.stringify(claims[0])), "an identical request replays its recorded acknowledgement")
      } else if (attempt > 1) {
        assert.equal(claim.disposition, "already_submitted")
      }
      claims.push(claim)
    }

    assert.equal(claims[0].disposition, "accepted")
    assert.ok(claims.every((claim) => claim.item.status === "in_review"))
    assert.ok(claims.every((claim) => claim.item.version === item.version + 1), "no claim may bump the version after the first")
    assert.equal((await repository.getItem(scope, item.id)).item.version, item.version + 1)
    assert.equal((await repository.getItem(scope, item.id)).item.status, "in_review")
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

const TMP_SIDECAR = "twinny-state.sqlite.4242.0f8fad5b-d9cb-469f-a165-8c45a5d2c123.tmp"

const projectLocation = (folders: { scheme: string; fsPath: string }[]) => async () => prepareProjectTodoStorage(resolveProjectTodoStorage(folders))
const projectRepository = (root: string) => new TodoRepository(projectLocation([{ scheme: "file", fsPath: root }]))
const projectScope = (root: string, conversationId = "project-chat") => ({
  projectFingerprint: workspaceProjectFingerprint([`file://${root}`]),
  conversationId,
  writer: conversationId
})
const withDirectory = async (prefix: string, run: (directory: string) => Promise<void>) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  try {
    await run(directory)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}
const makeProject = (directory: string, name = "project") => {
  const root = path.join(directory, name)
  fs.mkdirSync(path.join(root, "src"), { recursive: true })
  return root
}
const legacyDatabaseIn = async (globalStorageDir: string, root: string) => {
  const legacyPath = path.join(globalStorageDir, "twinny-state.sqlite")
  const repository = new TodoRepository(legacyPath)
  try {
    await repository.createItem(projectScope(root), { title: "Legacy task" }, "legacy-create")
  } finally {
    repository.close()
  }
  return legacyPath
}
const blockedReason = (outcome: LegacyTodoRetirement): string => {
  if (outcome.status !== "blocked") assert.fail(`expected a blocked legacy removal, got ${outcome.status}`)
  return outcome.reason
}

test("a project creates .twinny/evidence.sqlite with the current schema and git-ignores it on first initialization", async () => {
  await withDirectory("twinny-project-init-", async (directory) => {
    const root = makeProject(directory)
    await projectRepository(root).initialize()

    const databasePath = path.join(root, ".twinny", "evidence.sqlite")
    assert.equal(fs.existsSync(databasePath), true)
    const database = new BetterSqlite(databasePath, { readonly: true, fileMustExist: true })
    try {
      assert.equal(database.pragma("user_version", { simple: true }), 18)
    } finally {
      database.close()
    }
    assert.equal(fs.readFileSync(path.join(root, ".gitignore"), "utf8"), ".twinny/\n")
  })
})

test("restarting with an unchanged project database preserves its TODO records", async () => {
  await withDirectory("twinny-project-restart-", async (directory) => {
    const root = makeProject(directory)
    const scope = projectScope(root)
    const created = await projectRepository(root).createItem(scope, { title: "Survives restart" }, "restart-create")

    const reopened = await projectRepository(root).getList(scope)
    assert.deepEqual(reopened.items.map((item) => [item.id, item.title]), [[created.id, "Survives restart"]])
  })
})

test("separate projects receive independent project-local databases", async () => {
  await withDirectory("twinny-project-separate-", async (directory) => {
    const first = makeProject(directory, "first")
    const second = makeProject(directory, "second")
    await projectRepository(first).createItem(projectScope(first), { title: "Only in first" }, "first-create")

    assert.equal((await projectRepository(second).getList(projectScope(second))).items.length, 0)
    assert.equal((await projectRepository(first).getList(projectScope(first))).items.length, 1)
    const firstDatabase = path.join(first, ".twinny", "evidence.sqlite")
    const secondDatabase = path.join(second, ".twinny", "evidence.sqlite")
    assert.notEqual(firstDatabase, secondDatabase)
    assert.equal(fs.existsSync(firstDatabase) && fs.existsSync(secondDatabase), true)
  })
})

test("a fresh project database contains no legacy TODOs even when the legacy database holds data for the same project", async () => {
  await withDirectory("twinny-project-fresh-", async (directory) => {
    const globalStorageDir = path.join(directory, "global")
    fs.mkdirSync(globalStorageDir)
    const root = makeProject(directory)
    await legacyDatabaseIn(globalStorageDir, root)
    assert.equal((await new TodoRepository(path.join(globalStorageDir, "twinny-state.sqlite")).getList(projectScope(root))).items.length, 1)

    const fresh = projectRepository(root)
    assert.equal((await fresh.getList(projectScope(root))).items.length, 0)
    assert.deepEqual(await fresh.listAcceptedEvidence(projectScope(root)), [])
  })
})

test("legacy removal deletes only the verified legacy database and its exact sidecars", async () => {
  await withDirectory("twinny-legacy-remove-", async (directory) => {
    const globalStorageDir = path.join(directory, "global")
    fs.mkdirSync(path.join(globalStorageDir, "intent-compiler-traces"), { recursive: true })
    const root = makeProject(directory)
    const legacyPath = await legacyDatabaseIn(globalStorageDir, root)
    const sidecars = ["-wal", "-shm", "-journal", ".v8.bak", ".v12.bak"]
    for (const suffix of sidecars) fs.writeFileSync(`${legacyPath}${suffix}`, "stale")
    fs.writeFileSync(path.join(globalStorageDir, TMP_SIDECAR), "stale")
    const unrelated = ["workspace-index.sqlite", "workspace-index.sqlite-wal", "workspace-index.sqlite-shm", "active-execution-edit-checkpoint.json", "twinny-state.sqlite.notes.txt"]
    for (const name of unrelated) fs.writeFileSync(path.join(globalStorageDir, name), "keep")
    fs.writeFileSync(path.join(globalStorageDir, "intent-compiler-traces", "trace.json"), "{}")

    const outcome = await retireLegacyTodoDatabase(globalStorageDir, path.join(root, ".twinny", "evidence.sqlite"))
    assert.equal(outcome.status, "removed")
    assert.equal(outcome.legacyPath, legacyPath)
    assert.deepEqual(fs.readdirSync(globalStorageDir).sort(), [...unrelated, "intent-compiler-traces"].sort())
    assert.equal(fs.existsSync(`${legacyPath}.lock`), false)
  })
})

test("legacy removal is refused for unverified or live legacy storage and deletes nothing", async () => {
  await withDirectory("twinny-legacy-refuse-", async (directory) => {
    const root = makeProject(directory)
    const activePath = path.join(root, ".twinny", "evidence.sqlite")

    const textDir = path.join(directory, "text")
    fs.mkdirSync(textDir)
    fs.writeFileSync(path.join(textDir, "twinny-state.sqlite"), "not a database")
    const textOutcome = await retireLegacyTodoDatabase(textDir, activePath)
    assert.equal(textOutcome.status, "blocked")
    assert.match(blockedReason(textOutcome), /not a SQLite database/)
    assert.equal(fs.readFileSync(path.join(textDir, "twinny-state.sqlite"), "utf8"), "not a database")

    const linkDir = path.join(directory, "link")
    fs.mkdirSync(linkDir)
    const realPath = await legacyDatabaseIn(path.join(directory, "real"), root)
    fs.symlinkSync(realPath, path.join(linkDir, "twinny-state.sqlite"))
    const linkOutcome = await retireLegacyTodoDatabase(linkDir, activePath)
    assert.equal(linkOutcome.status, "blocked")
    assert.match(blockedReason(linkOutcome), /not a regular file/)
    assert.equal(fs.existsSync(realPath), true)

    const sameDir = path.join(directory, "same")
    fs.mkdirSync(sameDir)
    const samePath = await legacyDatabaseIn(sameDir, root)
    const sameOutcome = await retireLegacyTodoDatabase(sameDir, samePath)
    assert.equal(sameOutcome.status, "blocked")
    assert.match(blockedReason(sameOutcome), /active project database/)
    assert.equal(fs.existsSync(samePath), true)

    const sidecarDir = path.join(directory, "sidecar")
    fs.mkdirSync(sidecarDir)
    const sidecarLegacy = await legacyDatabaseIn(sidecarDir, root)
    fs.symlinkSync(realPath, `${sidecarLegacy}-wal`)
    const sidecarOutcome = await retireLegacyTodoDatabase(sidecarDir, activePath)
    assert.equal(sidecarOutcome.status, "blocked")
    assert.equal(fs.existsSync(sidecarLegacy), true, "a blocked sidecar check must not delete the database")
    assert.equal(fs.lstatSync(`${sidecarLegacy}-wal`).isSymbolicLink(), true)

    const lockedDir = path.join(directory, "locked")
    fs.mkdirSync(lockedDir)
    const lockedLegacy = await legacyDatabaseIn(lockedDir, root)
    fs.writeFileSync(`${lockedLegacy}.lock`, `${process.pid}\n`)
    const lockedOutcome = await retireLegacyTodoDatabase(lockedDir, activePath)
    assert.equal(lockedOutcome.status, "blocked")
    assert.match(blockedReason(lockedOutcome), /holds the legacy database lock/)
    assert.equal(fs.existsSync(lockedLegacy), true)
    assert.equal(fs.existsSync(`${lockedLegacy}.lock`), true, "another process's lock is left in place")
  })
})

test("a stale legacy lock is taken over and an absent legacy database is reported without deletion", async () => {
  await withDirectory("twinny-legacy-stale-", async (directory) => {
    const root = makeProject(directory)
    const activePath = path.join(root, ".twinny", "evidence.sqlite")
    const staleDir = path.join(directory, "stale")
    fs.mkdirSync(staleDir)
    const legacyPath = await legacyDatabaseIn(staleDir, root)
    fs.writeFileSync(`${legacyPath}.lock`, "999999\n")
    const old = new Date(Date.now() - 300_000)
    fs.utimesSync(`${legacyPath}.lock`, old, old)
    assert.equal((await retireLegacyTodoDatabase(staleDir, activePath)).status, "removed")
    assert.equal(fs.existsSync(legacyPath), false)
    assert.equal(fs.existsSync(`${legacyPath}.lock`), false)

    const emptyDir = path.join(directory, "empty")
    fs.mkdirSync(emptyDir)
    assert.equal((await retireLegacyTodoDatabase(emptyDir, activePath)).status, "absent")
    assert.deepEqual(fs.readdirSync(emptyDir), [])
  })
})

test("ambiguous, empty, and non-local workspace folders fail explicitly and create no .twinny directory", async () => {
  await withDirectory("twinny-project-resolve-", async (directory) => {
    const first = makeProject(directory, "first")
    const second = makeProject(directory, "second")
    assert.throws(() => resolveProjectTodoStorage([]), /needs an open project folder/)
    assert.throws(() => resolveProjectTodoStorage([{ scheme: "file", fsPath: first }, { scheme: "file", fsPath: second }]), /cannot choose between multiple workspace folders/)
    assert.throws(() => resolveProjectTodoStorage([{ scheme: "vscode-remote", fsPath: first }]), /not a "vscode-remote" folder/)

    const ambiguous = new TodoRepository(projectLocation([{ scheme: "file", fsPath: first }, { scheme: "file", fsPath: second }]))
    await assert.rejects(ambiguous.getList(projectScope(first)), /cannot choose between multiple workspace folders/)
    const none = new TodoRepository(projectLocation([]))
    await assert.rejects(none.getList(projectScope(first)), /needs an open project folder/)
    assert.equal(fs.existsSync(path.join(first, ".twinny")), false)
    assert.equal(fs.existsSync(path.join(second, ".twinny")), false)
  })
})

test("a symlinked .twinny directory or database is refused rather than followed outside the project", async () => {
  await withDirectory("twinny-project-symlink-", async (directory) => {
    const outside = path.join(directory, "outside")
    fs.mkdirSync(outside)
    const linkedDirectoryRoot = makeProject(directory, "linked-directory")
    fs.symlinkSync(outside, path.join(linkedDirectoryRoot, ".twinny"), "dir")
    await assert.rejects(projectRepository(linkedDirectoryRoot).initialize(), /symbolic link/)
    assert.equal(fs.existsSync(path.join(outside, "evidence.sqlite")), false)

    const linkedFileRoot = makeProject(directory, "linked-file")
    fs.mkdirSync(path.join(linkedFileRoot, ".twinny"))
    fs.symlinkSync(path.join(outside, "elsewhere.sqlite"), path.join(linkedFileRoot, ".twinny", "evidence.sqlite"))
    await assert.rejects(projectRepository(linkedFileRoot).initialize(), /symbolic link/)
    assert.equal(fs.existsSync(path.join(outside, "elsewhere.sqlite")), false)
  })
})

test("the project ignore rule preserves existing .gitignore content and is not duplicated", async () => {
  await withDirectory("twinny-project-gitignore-", async (directory) => {
    const root = makeProject(directory)
    const gitignore = path.join(root, ".gitignore")
    fs.writeFileSync(gitignore, "node_modules/\r\ndist")
    await projectRepository(root).initialize()
    assert.equal(fs.readFileSync(gitignore, "utf8"), "node_modules/\r\ndist\r\n.twinny/\r\n")

    await projectRepository(root).initialize()
    assert.equal(fs.readFileSync(gitignore, "utf8"), "node_modules/\r\ndist\r\n.twinny/\r\n", "an equivalent rule is not added twice")

    const rooted = makeProject(directory, "rooted")
    fs.writeFileSync(path.join(rooted, ".gitignore"), "/.twinny/\n")
    await projectRepository(rooted).initialize()
    assert.equal(fs.readFileSync(path.join(rooted, ".gitignore"), "utf8"), "/.twinny/\n")
  })
})

test("deleting the project database and its sidecars then reopening creates a clean database", async () => {
  await withDirectory("twinny-project-reset-", async (directory) => {
    const root = makeProject(directory)
    const scope = projectScope(root)
    await projectRepository(root).createItem(scope, { title: "Before reset" }, "before-reset")

    const databasePath = path.join(root, ".twinny", "evidence.sqlite")
    for (const suffix of ["", "-wal", "-shm", "-journal", ".lock"]) fs.rmSync(`${databasePath}${suffix}`, { force: true })

    const reopened = projectRepository(root)
    assert.deepEqual((await reopened.getList(scope)).items, [])
    assert.equal(fs.existsSync(databasePath), true)
    await reopened.createItem(scope, { title: "After reset" }, "after-reset")
    assert.deepEqual((await reopened.getList(scope)).items.map((item) => item.title), ["After reset"])
  })
})

test("a project database from a newer Twinny schema is refused and left untouched", async () => {
  await withDirectory("twinny-project-future-", async (directory) => {
    const root = makeProject(directory)
    await projectRepository(root).initialize()
    const databasePath = path.join(root, ".twinny", "evidence.sqlite")
    const database = new BetterSqlite(databasePath)
    database.pragma("user_version = 19")
    database.close()
    const before = fs.readFileSync(databasePath)

    await assert.rejects(projectRepository(root).initialize(), /newer than this Twinny version/)
    assert.deepEqual(fs.readFileSync(databasePath), before, "no automatic reset or deletion occurs")
  })
})

test("a failed intent plan transaction rolls back every item, dependency, task, plan, and event write", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-rollback-todos-"))
  const databasePath = path.join(directory, "twinny-state.sqlite")
  const scope = { projectFingerprint: workspaceProjectFingerprint(["file:///project-rollback"]), conversationId: "chat-rollback", writer: "chat-rollback" }
  const repository = new TodoRepository(databasePath)
  try {
    const planWith = (revision: number, tasks: { id: string; title: string; dependencies: string[] }[]) => ({
      planId: "plan-rollback",
      version: 1 as const,
      revision,
      goal: "Keep the parser working",
      constraints: [],
      tasks: tasks.map((task) => ({ id: task.id, title: task.title, description: `${task.title} details`, criteria: [{ id: `${task.id}-done`, description: `${task.title} is done`, verification: { kind: "semantic_review" as const } }], dependencies: task.dependencies }))
    })
    const sync = (plan: ReturnType<typeof planWith>) => repository.synchronizeIntentPlan(scope, plan, { objective: plan.goal, prompt: plan.goal, plan })
    const readCounts = () => {
      const database = new BetterSqlite(databasePath, { readonly: true, fileMustExist: true })
      try {
        const count = (sql: string) => (database.prepare(sql).get() as { n: number }).n
        return {
          events: count("SELECT COUNT(*) AS n FROM todo_events"),
          items: count("SELECT COUNT(*) AS n FROM todo_items"),
          dependencies: count("SELECT COUNT(*) AS n FROM todo_dependencies"),
          activeTasks: count("SELECT COUNT(*) AS n FROM todo_intent_tasks WHERE active = 1")
        }
      } finally {
        database.close()
      }
    }

    await sync(planWith(1, [
      { id: "inspect", title: "Inspect parser", dependencies: [] },
      { id: "verify", title: "Verify parser", dependencies: ["inspect"] }
    ]))
    const before = await repository.getList(scope)
    const planBefore = await repository.getIntentTaskPlan(scope)
    const countsBefore = readCounts()

    const injecting = new BetterSqlite(databasePath)
    injecting.exec("CREATE TRIGGER fail_new_task BEFORE INSERT ON todo_intent_tasks WHEN NEW.task_id = 'review' BEGIN SELECT RAISE(ABORT, 'injected failure'); END")
    injecting.close()

    const revised = [
      { id: "inspect", title: "Inspect parser deeply", dependencies: [] },
      { id: "verify", title: "Verify parser", dependencies: ["inspect"] },
      { id: "review", title: "Review parser", dependencies: ["verify"] }
    ]
    await assert.rejects(sync(planWith(2, revised)), /injected failure/)
    assert.deepEqual(await repository.getList(scope), before)
    assert.deepEqual(await repository.getIntentTaskPlan(scope), planBefore)
    assert.deepEqual(readCounts(), countsBefore)

    const removing = new BetterSqlite(databasePath)
    removing.exec("DROP TRIGGER fail_new_task")
    removing.close()
    const recovered = await sync(planWith(2, revised))
    assert.deepEqual(recovered.items.map((item) => item.title), ["Inspect parser deeply", "Verify parser", "Review parser"])
    assert.equal((await repository.getIntentTaskPlan(scope))?.revision, 2)
  } finally {
    repository.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

