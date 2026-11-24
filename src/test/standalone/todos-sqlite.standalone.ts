import BetterSqlite from "better-sqlite3"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { logger } from "../../common/logger"
import { observedSourceReferences } from "../../extension/todos/evidence"
import { resolveProjectHome } from "../../extension/todos/project-home"
import { DEFAULT_EVIDENCE_STORAGE_LIMITS, TodoRepository, TodoWriteDeniedError, trustedTodoPanelApproval, workspaceProjectFingerprint } from "../../extension/todos/repository"
import { type SourceBoundaryOptions } from "../../extension/todos/source-validity"
import { type LegacyTodoRetirement, prepareProjectTodoStorage, resolveProjectTodoStorage, retireLegacyTodoDatabase, SqliteFile } from "../../extension/todos/sqlite"
import { type TodoCompletionClaim, TodoConflictError } from "../../extension/todos/types"
import { fingerprintContent } from "../../extension/tools/fingerprint"
import { get, run, transaction } from "../../extension/workspace-index/sql"


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

test("recordToolObservation inserts one v21 read_file observation with 13 matching columns and values", async () => {
  await withDirectory("twinny-tool-observation-", async (directory) => {
    const databasePath = path.join(directory, "project.sqlite")
    const scope = { projectFingerprint: "project", conversationId: "chat-observation", writer: "chat-observation" }
    const repository = new TodoRepository(databasePath)
    const plan = {
      planId: "plan-read-file", version: 1 as const, revision: 1, goal: "Inspect the source",
      constraints: [], tasks: [{
        id: "read", title: "Read parser", description: "Read src/parser.ts",
        criteria: [{ id: "read-done", description: "The file was read", verification: { kind: "semantic_review" as const } }],
        dependencies: []
      }]
    }
    try {
      const [item] = (await repository.synchronizeIntentPlan(scope, plan, { objective: plan.goal, prompt: "Read the parser", plan })).items
      const observation = await repository.recordToolObservation(scope, {
        itemId: item.id,
        toolName: "read_file",
        arguments: { path: "src/parser.ts" },
        output: "export function parse() {}",
        failed: false,
        exitCode: 0,
        requestId: "observe-read-file",
        executionId: "execution-read-file"
      })
      assert.equal(observation.toolName, "read_file")

      const database = new BetterSqlite(databasePath, { readonly: true, fileMustExist: true })
      try {
        assert.equal(database.pragma("user_version", { simple: true }), 21)
        const row = database.prepare(
          "SELECT tool_name, item_id, exit_code, execution_id FROM todo_tool_observations WHERE request_id = ?"
        ).get("observe-read-file") as { tool_name: string; item_id: string; exit_code: number; execution_id: string }
        assert.deepEqual(row, {
          tool_name: "read_file",
          item_id: item.id,
          exit_code: 0,
          execution_id: "execution-read-file"
        })
      } finally {
        database.close()
      }
    } finally {
      repository.close()
    }
  })
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

test("a project creates .twinny/project.sqlite with the v21 schema and git-ignores it on first initialization", async () => {
  await withDirectory("twinny-project-init-", async (directory) => {
    const root = makeProject(directory)
    await projectRepository(root).initialize()

    const databasePath = path.join(root, ".twinny", "project.sqlite")
    assert.equal(fs.existsSync(databasePath), true)
    const database = new BetterSqlite(databasePath, { readonly: true, fileMustExist: true })
    try {
      assert.equal(database.pragma("user_version", { simple: true }), 21)
      assert.equal(database.pragma("integrity_check", { simple: true }), "ok")
      assert.equal((database.prepare("SELECT COUNT(*) AS n FROM pragma_foreign_key_check").get() as { n: number }).n, 0)

      const tables = database.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'documents_fts_%' ORDER BY name"
      ).all().map((row) => (row as { name: string }).name)
      assert.deepEqual(tables, [
        "context_projection_segments", "context_projections", "context_segments", "documents", "documents_fts",
        "evidence_access_events", "evidence_blobs", "evidence_chunks", "evidence_dependencies",
        "evidence_favourite_requests", "evidence_favourites", "evidence_io_events", "evidence_lines",
        "evidence_outcomes", "index_meta", "observation_source", "source_root", "storage_policy", "symbols",
        "todo_accepted_evidence", "todo_assessment_current", "todo_assessment_reactions", "todo_assessments",
        "todo_child_proposals", "todo_dependencies", "todo_edit_operations", "todo_evaluations", "todo_events",
        "todo_evidence", "todo_evidence_usage", "todo_intent_plans", "todo_intent_tasks", "todo_items",
        "todo_lists", "todo_projects", "todo_requests", "todo_requirement_activations", "todo_symbol_aliases",
        "todo_tool_evidence", "todo_tool_observations"
      ])
      const indexes = database.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY name"
      ).all().map((row) => (row as { name: string }).name)
      assert.equal(indexes.length, 39)
      assert.ok(indexes.includes("todo_tool_observations_item"))
      assert.ok(indexes.includes("todo_tool_observations_project"))
      assert.ok(indexes.includes("documents_fingerprint"))
      assert.ok(indexes.includes("source_root_one_home"))
      // The indexes Stage 1 freezes for the later stages, named as §5.2 requires.
      for (const name of ["evidence_outcomes_observation", "evidence_blobs_project", "evidence_chunks_order", "evidence_lines_lookup",
        "evidence_dependencies_source", "evidence_favourites_project", "evidence_access_events_project", "context_projections_project"]) {
        assert.ok(indexes.includes(name), `the v21 inventory names ${name}`)
      }
      const triggers = database.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name"
      ).all().map((row) => (row as { name: string }).name)
      assert.deepEqual(triggers, ["todo_assessment_reactions_append_only", "todo_assessments_immutable"], "the v21 inventory keeps the v20 triggers unchanged")
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
    const firstDatabase = path.join(first, ".twinny", "project.sqlite")
    const secondDatabase = path.join(second, ".twinny", "project.sqlite")
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

    const outcome = await retireLegacyTodoDatabase(globalStorageDir, path.join(root, ".twinny", "project.sqlite"))
    assert.equal(outcome.status, "removed")
    assert.equal(outcome.legacyPath, legacyPath)
    assert.deepEqual(fs.readdirSync(globalStorageDir).sort(), [...unrelated, "intent-compiler-traces"].sort())
    assert.equal(fs.existsSync(`${legacyPath}.lock`), false)
  })
})

test("legacy removal is refused for unverified or live legacy storage and deletes nothing", async () => {
  await withDirectory("twinny-legacy-refuse-", async (directory) => {
    const root = makeProject(directory)
    const activePath = path.join(root, ".twinny", "project.sqlite")

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
    const activePath = path.join(root, ".twinny", "project.sqlite")
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

test("multi-root project home is stable, overridable, saved-workspace-aware, and rejects unsupported roots", async () => {
  await withDirectory("twinny-project-resolve-", async (directory) => {
    const first = makeProject(directory, "first")
    const second = makeProject(directory, "second")
    assert.throws(() => resolveProjectTodoStorage([]), /needs an open project folder/)
    assert.throws(() => resolveProjectTodoStorage([{ scheme: "vscode-remote", fsPath: first }]), /not a "vscode-remote" folder/)

    const folders = [{ scheme: "file", fsPath: first }, { scheme: "file", fsPath: second }]
    const forward = resolveProjectTodoStorage(folders)
    const reverse = resolveProjectTodoStorage([...folders].reverse())
    assert.equal(forward.databasePath, reverse.databasePath)
    assert.equal(forward.databasePath, path.join(first, ".twinny", "project.sqlite"))
    assert.equal(resolveProjectHome({ folders, workspaceFile: path.join(directory, "saved.code-workspace") }), directory)
    assert.equal(resolveProjectHome({ folders, projectHome: path.join(directory, "override") }), path.join(directory, "override"))

    const none = new TodoRepository(projectLocation([]))
    await assert.rejects(none.getList(projectScope(first)), /needs an open project folder/)
  })
})

test("a symlinked .twinny directory or database is refused rather than followed outside the project", async () => {
  await withDirectory("twinny-project-symlink-", async (directory) => {
    const outside = path.join(directory, "outside")
    fs.mkdirSync(outside)
    const linkedDirectoryRoot = makeProject(directory, "linked-directory")
    fs.symlinkSync(outside, path.join(linkedDirectoryRoot, ".twinny"), "dir")
    await assert.rejects(projectRepository(linkedDirectoryRoot).initialize(), /symbolic link/)
    assert.equal(fs.existsSync(path.join(outside, "project.sqlite")), false)

    const linkedFileRoot = makeProject(directory, "linked-file")
    fs.mkdirSync(path.join(linkedFileRoot, ".twinny"))
    fs.symlinkSync(path.join(outside, "elsewhere.sqlite"), path.join(linkedFileRoot, ".twinny", "project.sqlite"))
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

test("deleting a TODO list retains observations, retained output, source references, and accepted facts", async () => {
  await withDirectory("twinny-evidence-retention-", async (directory) => {
    const databasePath = path.join(directory, "project.sqlite")
    const scope = { projectFingerprint: "project", conversationId: "chat-retention", writer: "chat-retention" }
    const repository = new TodoRepository(databasePath)
    const plan = {
      planId: "plan-retention", version: 1 as const, revision: 1, goal: "Retain evidence",
      constraints: [], tasks: [{
        id: "inspect", title: "Inspect parser", description: "Read parser source",
        criteria: [{ id: "parser-read", description: "Parser source was read", verification: { kind: "semantic_review" as const } }],
        dependencies: []
      }]
    }
    try {
      const [item] = (await repository.synchronizeIntentPlan(scope, plan, { objective: plan.goal, prompt: "Read the parser", plan })).items
      const observation = await repository.recordToolObservation(scope, {
        itemId: item.id,
        toolName: "read_file",
        arguments: { path: "src/parser.ts" },
        output: "export function parse() {}",
        failed: false,
        requestId: "retention-observation",
        evidenceOutput: "src/parser.ts (lines 1–1 of 1)\ncontent_hash: sha256:" + "a".repeat(64) + "; total_lines: 1\n1: export function parse() {}"
      })

      const database = new BetterSqlite(databasePath)
      try {
        database.pragma("foreign_keys = ON")
        const list = database.prepare("SELECT id, project_id FROM todo_lists WHERE conversation_id = ?").get(scope.conversationId) as { id: string; project_id: string }
        database.prepare(
          "INSERT INTO todo_accepted_evidence(id, project_id, list_id, plan_id, plan_revision, item_id, criterion_index, criterion, observation_id, tool_name, symbol, path, start_line, end_line, source_hash, superseded_by, registered_tool, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)"
        ).run(
          "accepted-retention", list.project_id, list.id, "plan-retention", 1, item.id, 0,
          "Parser source was read", observation.id, "read_file", "parse", "src/parser.ts", 1, 1,
          "sha256:" + "a".repeat(64), "read_file", "2026-11-18T00:00:00.000Z"
        )
        database.prepare("DELETE FROM todo_lists WHERE id = ?").run(list.id)
      } finally {
        database.close()
      }

      const reopened = new BetterSqlite(databasePath, { readonly: true, fileMustExist: true })
      try {
        const counts = {
          observations: (reopened.prepare("SELECT COUNT(*) AS n FROM todo_tool_observations").get() as { n: number }).n,
          retained: (reopened.prepare("SELECT COUNT(*) AS n FROM todo_tool_evidence WHERE retained = 1").get() as { n: number }).n,
          sources: (reopened.prepare("SELECT COUNT(*) AS n FROM observation_source").get() as { n: number }).n,
          accepted: (reopened.prepare("SELECT COUNT(*) AS n FROM todo_accepted_evidence").get() as { n: number }).n
        }
        assert.deepEqual(counts, { observations: 1, retained: 1, sources: 1, accepted: 1 })
      } finally {
        reopened.close()
      }
    } finally {
      repository.close()
    }
  })
})

test("deleting a task and its conversation leaves the project observation, its retained output and its source reference searchable", async () => {
  await withDirectory("twinny-task-retention-", async (directory) => {
    const databasePath = path.join(directory, "project.sqlite")
    const scope = { projectFingerprint: "project", conversationId: "chat-task-retention", writer: "chat-task-retention" }
    const repository = new TodoRepository(databasePath)
    const plan = {
      planId: "plan-task-retention", version: 1 as const, revision: 1, goal: "Retain the read",
      constraints: [], tasks: [{
        id: "inspect", title: "Inspect parser", description: "Read parser source",
        criteria: [{ id: "parser-read", description: "Parser source was read", verification: { kind: "semantic_review" as const } }],
        dependencies: []
      }]
    }
    try {
      const [item] = (await repository.synchronizeIntentPlan(scope, plan, { objective: plan.goal, prompt: "Read the parser", plan })).items
      const observation = await repository.recordToolObservation(scope, {
        itemId: item.id,
        toolName: "read_file",
        arguments: { path: "src/parser.ts", start_line: "1", end_line: "1" },
        output: "export function parse() {}",
        failed: false,
        requestId: "task-retention-observation",
        evidenceOutput: "src/parser.ts (lines 1–1 of 1)\ncontent_hash: sha256:" + "b".repeat(64) + "; total_lines: 1\n1: export function parse() {}"
      })
      const database = new BetterSqlite(databasePath)
      try {
        database.pragma("foreign_keys = ON")
        const list = database.prepare("SELECT id FROM todo_lists WHERE conversation_id = ?").get(scope.conversationId) as { id: string }
        database.prepare("DELETE FROM todo_items WHERE id = ?").run(item.id)
        database.prepare("DELETE FROM todo_lists WHERE id = ?").run(list.id)
      } finally {
        database.close()
      }
      const reopened = new TodoRepository(databasePath)
      try {
        assert.deepEqual((await reopened.getList({ ...scope, includeCompleted: true })).items, [], "the task and its conversation are gone")
        const found = await reopened.projectObservations({ projectFingerprint: scope.projectFingerprint, writer: scope.writer }, { path: "src/parser.ts" })
        assert.deepEqual(found.map((entry) => entry.observationId), [observation.id], "the project record outlives the task and the conversation that recorded it")
        assert.equal(found[0].itemId, item.id, "the record still names the task that made it as provenance")
        assert.equal(found[0].retained, true, "the retained output is still stored for the project")
        const stored = new BetterSqlite(databasePath, { readonly: true, fileMustExist: true })
        try {
          assert.ok((stored.prepare("SELECT content FROM todo_tool_evidence WHERE observation_id = ?").get(observation.id) as { content: string }).content.includes("export function parse() {}"), "the retained output is still readable")
          assert.deepEqual(stored.prepare("SELECT role, path FROM observation_source WHERE observation_id = ?").raw().get(observation.id), ["read", "src/parser.ts"], "the source reference is still there")
        } finally {
          stored.close()
        }
      } finally {
        reopened.close()
      }
    } finally {
      repository.close()
    }
  })
})


test("deleting the project database and its sidecars then reopening creates a clean database", async () => {
  await withDirectory("twinny-project-reset-", async (directory) => {
    const root = makeProject(directory)
    const scope = projectScope(root)
    const before = projectRepository(root)
    await before.createItem(scope, { title: "Before reset" }, "before-reset")
    before.close()

    const databasePath = path.join(root, ".twinny", "project.sqlite")
    for (const suffix of ["", "-wal", "-shm", "-journal", ".lock"]) fs.rmSync(`${databasePath}${suffix}`, { force: true })

    const reopened = projectRepository(root)
    assert.deepEqual((await reopened.getList(scope)).items, [])
    assert.equal(fs.existsSync(databasePath), true)
    await reopened.createItem(scope, { title: "After reset" }, "after-reset")
    assert.deepEqual((await reopened.getList(scope)).items.map((item) => item.title), ["After reset"])
  })
})

test("a project database from an older unsupported schema is refused and left untouched", async () => {
  await withDirectory("twinny-project-old-", async (directory) => {
    const root = makeProject(directory)
    await projectRepository(root).initialize()
    const databasePath = path.join(root, ".twinny", "project.sqlite")
    const database = new BetterSqlite(databasePath)
    database.pragma("user_version = 19")
    database.close()
    const before = fs.readFileSync(databasePath)

    await assert.rejects(projectRepository(root).initialize(), /older than this Twinny version/)
    assert.deepEqual(fs.readFileSync(databasePath), before, "no automatic migration or deletion occurs")
  })
})

test("a project database from a newer Twinny schema is refused and left untouched", async () => {
  await withDirectory("twinny-project-future-", async (directory) => {
    const root = makeProject(directory)
    await projectRepository(root).initialize()
    const databasePath = path.join(root, ".twinny", "project.sqlite")
    const database = new BetterSqlite(databasePath)
    database.pragma("user_version = 22")
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

test("the index tables and the TODO tables coexist in one database and two connections can read and write both", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-index-and-todo-tables-"))
  try {
    const databasePath = path.join(directory, "project.sqlite")
    const repository = new TodoRepository(databasePath)
    const indexConnection = new SqliteFile(databasePath)
    const scope = { projectFingerprint: workspaceProjectFingerprint(["file:///coexisting-tables"]), conversationId: "coexist-chat", writer: "coexist-chat" }

    const documentsRow = {
      uri: "file:///coexist.ts",
      workspaceUri: "file:///coexist.ts",
      relativePath: "coexist.ts",
      filename: "coexist.ts",
      languageId: "typescript",
      fingerprint: "xxh64:0",
      hashAlgorithm: "xxh64",
      size: 12,
      mtimeMs: 1,
      text: "coexist marker text",
      indexedAt: new Date().toISOString()
    }
    await indexConnection.read((database) => transaction(database, () => run(database,
      "INSERT INTO documents(uri,workspace_uri,relative_path,filename,language_id,fingerprint,hash_algorithm,size,mtime_ms,text,indexed_at,skip_reason,error,symbols_fingerprint,scan_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)",
      [documentsRow.uri, documentsRow.workspaceUri, documentsRow.relativePath, documentsRow.filename, documentsRow.languageId, documentsRow.fingerprint, documentsRow.hashAlgorithm, documentsRow.size, documentsRow.mtimeMs, documentsRow.text, documentsRow.indexedAt, null]
    )))

    const item = await repository.createItem(scope, { title: "Shared project database" }, "request-create")
    const todoRow = await indexConnection.read((database) => get<{ id: string; title: string }>(database, "SELECT id, title FROM todo_items WHERE id = ?", [item.id]))
    assert.deepEqual(todoRow, { id: item.id, title: "Shared project database" }, "the index connection reads the row the repository wrote")

    // TodoRepository has no raw query, so the row it owns is read through the index side and the index row through a second connection on the same path.
    const reader = new BetterSqlite(databasePath, { readonly: true, fileMustExist: true })
    try {
      assert.deepEqual(
        reader.prepare("SELECT relative_path, text FROM documents WHERE uri = ?").get([documentsRow.uri]) as { relative_path: string; text: string },
        { relative_path: documentsRow.relativePath, text: documentsRow.text },
        "the documents row is visible from another connection on the same database"
      )
      const tables = new Set((reader.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name))
      assert.ok(tables.has("documents") && tables.has("todo_items"), "both table groups are in one schema")
    } finally {
      reader.close()
    }

    indexConnection.close()
    repository.close()
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

/** A file inside the project home, which is the source the repository's boundary reads. */
const homeSource = (root: string, file: string, text: string): string => {
  const target = path.join(root, file)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, text)
  return target
}

/** One native read_file output as the tool writes it, so the recorded reference carries the whole-file hash it showed. */
const shownRead = async (file: string, text: string): Promise<string> => {
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n")
  const hash = await fingerprintContent(text)
  return `${file} (lines 1–${lines.length} of ${lines.length})\ncontent_hash: ${hash}; total_lines: ${lines.length}\n${lines.map((line, index) => `${index + 1}: ${line}`).join("\n")}`
}

/** The references one result proves, from the production parser, as the chat hook hands them to the repository. */
const referencesFor = (name: string, args: Record<string, string>, output: string, origin?: { origin: "disk" | "buffer"; editorVersion?: number }) =>
  observedSourceReferences({ name, args, output, failed: false, ...(origin === undefined ? {} : { origin }) })

const boundaryRepository = (root: string, source: SourceBoundaryOptions) =>
  new TodoRepository(projectLocation([{ scheme: "file", fsPath: root }]), DEFAULT_EVIDENCE_STORAGE_LIMITS, () => [root], source)

/** Records one result through the repository with no task active, the way the chat hook does. */
const recordRead = async (repository: TodoRepository, scope: ReturnType<typeof projectScope>, file: string, text: string, requestId: string, itemId?: string) => {
  const output = await shownRead(file, text)
  return repository.recordToolObservation(scope, {
    ...(itemId === undefined ? {} : { itemId }),
    toolName: "read_file",
    arguments: { path: file },
    output: `read ${file}`,
    failed: false,
    requestId,
    evidenceOutput: output,
    sources: referencesFor("read_file", { path: file }, output)
  })
}
test("the boundary checks each reference as it is stored and again on every later retrieval, and matching content restored makes the same record valid again", async () => {
  await withDirectory("twinny-validity-boundary-", async (directory) => {
    const root = makeProject(directory)
    const file = "src/parser.ts"
    const original = "export function parse() {}\n"
    homeSource(root, file, original)
    const repository = boundaryRepository(root, {})
    const scope = projectScope(root)
    try {
      const stored = await recordRead(repository, scope, file, original, "boundary-store")
      assert.equal(stored.validity?.validity, "valid", "the reference is checked against the source at the moment it is stored")
      assert.deepEqual(stored.validity?.references.map((reference) => [reference.path, reference.role, reference.validity, reference.checkedAgainst]), [[file, "read", "valid", "disk"]])
      assert.equal(stored.validity?.references[0].persistedSource, true, "the check read the saved file")

      fs.writeFileSync(path.join(root, file), `${original}// changed\n`)
      const stale = await repository.projectObservations(scope, { path: file })
      assert.equal(stale[0].validity?.validity, "stale", "the same record reads stale once the file changes")
      assert.equal(stale[0].validity?.references[0].contentHash, await fingerprintContent(original), "the recorded fingerprint is kept as history and never rewritten")

      fs.rmSync(path.join(root, file))
      const gone = await repository.projectObservations(scope, { path: file })
      assert.equal(gone[0].validity?.validity, "invalid", "a file that is gone is invalid")

      homeSource(root, file, original)
      const restored = await repository.projectObservations(scope, { path: file })
      assert.equal(restored[0].validity?.validity, "valid", "matching content restored makes the same record valid again on the next retrieval")
    } finally {
      repository.close()
    }
  })
})

test("every public evidence path reports the same state for the same record, decided by the repository's own boundary with no reader supplied by the caller", async () => {
  await withDirectory("twinny-validity-paths-", async (directory) => {
    const root = makeProject(directory)
    const file = "src/parser.ts"
    const original = "export function parse() {}\n"
    homeSource(root, file, original)
    const repository = boundaryRepository(root, {})
    const scope = projectScope(root)
    const plan = {
      planId: "plan-validity-paths", version: 1 as const, revision: 1, goal: "Report validity on every path", constraints: [],
      tasks: [{ id: "inspect", title: "Inspect parser", description: "Read parser source", criteria: [{ id: "read", description: "Parser source was read", verification: { kind: "semantic_review" as const } }], dependencies: [] }]
    }
    try {
      const [item] = (await repository.synchronizeIntentPlan(scope, plan, { objective: plan.goal, prompt: "Read the parser", plan })).items
      const stored = await recordRead(repository, scope, file, original, "paths-store", item.id)
      assert.equal(stored.validity?.validity, "valid", "no caller supplied a reader")
      fs.writeFileSync(path.join(root, file), `${original}// changed\n`)
      const throughLookup = await repository.projectObservations(scope, { path: file })
      const throughPlan = await repository.listIntentEvidence(scope)
      const review = (await repository.getReviewPackages(scope, { includeOpen: true }))[0]
      assert.deepEqual(
        [throughLookup[0].validity?.validity, throughPlan[0].validity?.validity, review.retainedEvidence[0].validity?.validity],
        ["stale", "stale", "stale"],
        "every path answers with the state the same boundary decided"
      )
      assert.deepEqual(review.retainedEvidence[0].validity?.references.map((reference) => [reference.path, reference.validity]), [[file, "stale"]], "the Feedback package carries the per-reference state, not only an aggregate")
      assert.equal(throughLookup[0].itemId, item.id, "the record still names the task that made it as provenance")
    } finally {
      repository.close()
    }
  })
})

test("several references of one result get their own states and one aggregate, invalid over stale over valid", async () => {
  await withDirectory("twinny-validity-aggregate-", async (directory) => {
    const root = makeProject(directory)
    const from = "src/a.ts"
    const to = "src/b.ts"
    const kept = "src/c.ts"
    const movedText = "export const a = 1\n"
    const keptText = "export const c = 3\n"
    const repository = boundaryRepository(root, {})
    const scope = projectScope(root)
    try {
      const movedHash = await fingerprintContent(movedText)
      homeSource(root, from, movedText)
      homeSource(root, kept, keptText)
      fs.renameSync(path.join(root, from), path.join(root, to))
      const moveOutput = `moved ${from} to ${to}\ncontent_hash: ${movedHash} (unchanged by the move)`
      const moved = await repository.recordToolObservation(scope, {
        toolName: "move_file",
        arguments: { from, to },
        output: `moved ${from} to ${to}`,
        failed: false,
        requestId: "aggregate-move",
        evidenceOutput: moveOutput,
        sources: referencesFor("move_file", { from, to }, moveOutput)
      })
      assert.deepEqual(moved.validity?.references.map((reference) => [reference.role, reference.path, reference.validity]), [["moved_from", from, "invalid"], ["moved_to", to, "valid"]], "the reference for the path that is gone is invalid while the one that matches is valid")
      assert.equal(moved.validity?.validity, "invalid", "invalid beats every other state in the aggregate")

      const allMatch = await recordRead(repository, scope, kept, keptText, "aggregate-read")
      assert.equal(allMatch.validity?.validity, "valid", "a result whose references all match is valid")

      fs.writeFileSync(path.join(root, kept), `${keptText}// changed\n`)
      const renameOutput = `renamed across two files\ncontent_hash(${kept}): ${await fingerprintContent(keptText)}\ncontent_hash(${to}): ${movedHash}`
      const renamed = await repository.recordToolObservation(scope, {
        toolName: "rename_symbol",
        arguments: { name: "thing" },
        output: "renamed thing across two files",
        failed: false,
        requestId: "aggregate-rename",
        evidenceOutput: renameOutput,
        sources: referencesFor("rename_symbol", { name: "thing" }, renameOutput)
      })
      assert.deepEqual(renamed.validity?.references.map((reference) => [reference.path, reference.validity]), [[kept, "stale"], [to, "valid"]], "the per-reference states stay separate")
      assert.equal(renamed.validity?.validity, "stale", "stale beats valid when nothing is invalid")
    } finally {
      repository.close()
    }
  })
})

test("a reference recorded under an authorized external root is checked at that root, not the project home", async () => {
  await withDirectory("twinny-validity-external-", async (directory) => {
    const root = makeProject(directory)
    const target = path.join(directory, "authorized", "nginx.conf")
    const text = "worker_processes 4;\n"
    homeSource(root, "src/keep.ts", "export const keep = 1\n")
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, text)
    const repository = boundaryRepository(root, {})
    const scope = projectScope(root)
    try {
      const stored = await recordRead(repository, scope, target, text, "external-store")
      assert.equal(stored.validity?.validity, "valid", "the file is judged at the root it belongs to")
      assert.equal(stored.validity?.references[0].path, target, "the reference keeps its absolute canonical path")
      const rows = new BetterSqlite(path.join(root, ".twinny", "project.sqlite"), { readonly: true, fileMustExist: true })
      try {
        assert.ok(rows.prepare("SELECT root_id FROM source_root WHERE kind = 'external'").get(), "the reference was stored under its own external root")
      } finally {
        rows.close()
      }
      fs.writeFileSync(target, "worker_processes 8;\n")
      const changed = await repository.projectObservations(scope, { path: target })
      assert.equal(changed[0].validity?.validity, "stale", "the same record is judged against the file at its own root")
    } finally {
      repository.close()
    }
  })
})

test("a buffer reference is judged against the document the editor has open, and against the saved file after that document closes", async () => {
  await withDirectory("twinny-validity-buffer-", async (directory) => {
    const root = makeProject(directory)
    const file = "src/parser.ts"
    const saved = "export function parse() {}\n"
    const bufferText = `${saved}// an unsaved change\n`
    const documents = new Map<string, { text: string; version: number }>()
    const repository = boundaryRepository(root, { openDocument: (absolute) => documents.get(absolute) })
    const scope = projectScope(root)
    try {
      homeSource(root, file, saved)
      const absolute = path.join(root, file)
      documents.set(absolute, { text: bufferText, version: 7 })
      const output = await shownRead(file, bufferText)
      const stored = await repository.recordToolObservation(scope, {
        toolName: "read_file",
        arguments: { path: file },
        output: `read ${file}`,
        failed: false,
        requestId: "buffer-store",
        evidenceOutput: output,
        sources: referencesFor("read_file", { path: file }, output, { origin: "buffer", editorVersion: 7 })
      })
      assert.equal(stored.validity?.validity, "valid", "the open buffer still matches the fingerprint it was read at")
      assert.equal(stored.validity?.references[0].checkedAgainst, "buffer", "the open document decided the state")
      assert.equal(stored.validity?.references[0].persistedSource, false, "a buffer check says nothing about the saved file, so a buffer read cannot certify a persisted write")
      const rows = new BetterSqlite(path.join(root, ".twinny", "project.sqlite"), { readonly: true, fileMustExist: true })
      try {
        assert.deepEqual(rows.prepare("SELECT observed_version, editor_version FROM observation_source").raw().get(), ["buffer", 7], "the stored reference names the version it was read from")
      } finally {
        rows.close()
      }

      documents.set(absolute, { text: `${bufferText}// a later unsaved change\n`, version: 8 })
      const changedBuffer = await repository.projectObservations(scope, { path: file })
      assert.deepEqual([changedBuffer[0].validity?.validity, changedBuffer[0].validity?.references[0].checkedAgainst], ["stale", "buffer"], "the open buffer changed, so the reference is stale while the document is open")

      documents.delete(absolute)
      const closed = await repository.projectObservations(scope, { path: file })
      assert.deepEqual([closed[0].validity?.validity, closed[0].validity?.references[0].checkedAgainst], ["stale", "disk"], "after the buffer closes the saved file decides")

      fs.writeFileSync(absolute, bufferText)
      const reopened = await repository.projectObservations(scope, { path: file })
      assert.deepEqual([reopened[0].validity?.validity, reopened[0].validity?.references[0].checkedAgainst], ["valid", "disk"], "matching content saved makes it valid again")
    } finally {
      repository.close()
    }
  })
})

test("a file that is gone is invalid while a file that cannot be read stays on the existing error path", async () => {
  await withDirectory("twinny-validity-unreadable-", async (directory) => {
    const root = makeProject(directory)
    const file = "src/parser.ts"
    const text = "export function parse() {}\n"
    const target = homeSource(root, file, text)
    const repository = boundaryRepository(root, {})
    const scope = projectScope(root)
    try {
      const stored = await recordRead(repository, scope, file, text, "unreadable-store")
      assert.equal(stored.validity?.validity, "valid")
      fs.chmodSync(target, 0)
      try {
        const unreadable = await repository.projectObservations(scope, { path: file })
        assert.equal(unreadable[0].validity?.validity, "unverifiable", "a file that exists but cannot be read is not reported as invalid")
        assert.match(unreadable[0].validity?.references[0].reason ?? "", /could not be read/)
      } finally {
        fs.chmodSync(target, 0o600)
      }
      fs.rmSync(target)
      const gone = await repository.projectObservations(scope, { path: file })
      assert.equal(gone[0].validity?.validity, "invalid", "once the file is gone the same record is invalid, not unreadable")
    } finally {
      repository.close()
    }
  })
})

test("a result that recorded no fingerprint gets no invented hash and no file validity", async () => {
  await withDirectory("twinny-validity-command-", async (directory) => {
    const root = makeProject(directory)
    const repository = boundaryRepository(root, {})
    const scope = projectScope(root)
    try {
      const output = `sha256 ${"a".repeat(64)}  src/parser.ts`
      const stored = await repository.recordToolObservation(scope, {
        toolName: "run_command",
        arguments: { command: "sha256sum src/parser.ts" },
        output: "the command exited 0",
        failed: false,
        exitCode: 0,
        requestId: "command-store",
        evidenceOutput: output
      })
      assert.equal(stored.validity?.validity, undefined, "a result with no recorded reference has no file state")
      assert.deepEqual(stored.validity?.references ?? [], [])
      const rows = new BetterSqlite(path.join(root, ".twinny", "project.sqlite"), { readonly: true, fileMustExist: true })
      try {
        assert.equal((rows.prepare("SELECT COUNT(*) AS n FROM observation_source").get() as { n: number }).n, 0, "no file reference was invented for the command")
      } finally {
        rows.close()
      }
      const found = await repository.projectObservations(scope, { toolName: "run_command" })
      assert.equal(found[0].validity?.validity, undefined, "the lookup reports no file state either")
    } finally {
      repository.close()
    }
  })
})

test("project evidence survives the deletion of the task and the list that recorded it, and its source state is read again on every later retrieval", async () => {
  await withDirectory("twinny-validity-deletion-", async (directory) => {
    const root = makeProject(directory)
    const file = "src/parser.ts"
    const text = "export function parse() {}\n"
    homeSource(root, file, text)
    const repository = boundaryRepository(root, {})
    const scope = projectScope(root)
    const plan = {
      planId: "plan-validity-deletion", version: 1 as const, revision: 1, goal: "Keep evidence after deletion", constraints: [],
      tasks: [{ id: "inspect", title: "Inspect parser", description: "Read parser source", criteria: [{ id: "read", description: "Parser source was read", verification: { kind: "semantic_review" as const } }], dependencies: [] }]
    }
    try {
      const [item] = (await repository.synchronizeIntentPlan(scope, plan, { objective: plan.goal, prompt: "Read the parser", plan })).items
      const stored = await recordRead(repository, scope, file, text, "deletion-store", item.id)
      assert.equal(stored.validity?.validity, "valid")
      fs.rmSync(path.join(root, file))
      const rows = new BetterSqlite(path.join(root, ".twinny", "project.sqlite"), { fileMustExist: true })
      try {
        rows.prepare("PRAGMA foreign_keys = ON").run()
        const list = rows.prepare("SELECT id FROM todo_lists WHERE conversation_id = ?").get(scope.conversationId) as { id: string }
        rows.prepare("DELETE FROM todo_items WHERE id = ?").run(item.id)
        rows.prepare("DELETE FROM todo_lists WHERE id = ?").run(list.id)
      } finally {
        rows.close()
      }
      const after = await repository.projectObservations(scope, { path: file })
      assert.deepEqual(after.map((entry) => entry.observationId), [stored.id], "the project record outlives the task and the conversation that recorded it")
      assert.equal(after[0].itemId, item.id, "its task provenance is still recorded")
      assert.equal(after[0].validity?.validity, "invalid", "the reference the record made for a file that is gone is invalid")
      homeSource(root, file, text)
      assert.equal((await repository.projectObservations(scope, { path: file }))[0].validity?.validity, "valid", "the same record is valid again once its content is restored")
    } finally {
      repository.close()
    }
  })
})

test("the repository exposes the read-only access service through its own project and validity boundary", async () => {
  await withDirectory("twinny-access-boundary-", async (directory) => {
    const root = makeProject(directory)
    const repository = projectRepository(root)
    try {
      await repository.initialize()
      const scope = projectScope(root, "access-chat")
      const stored = await repository.recordToolObservation(scope, {
        toolName: "read_file",
        arguments: { path: "src/a.ts" },
        output: "line one\nline two",
        failed: false,
        exitCode: 0,
        requestId: "observe-access",
        executionId: "execution-access"
      })
      const access = await repository.evidenceAccess(scope)
      const looked = await access.get(stored.id)
      assert.equal(looked.access, "found", "the service answers for the project the repository resolved")
      assert.equal(looked.observationId, stored.id)
      assert.equal((await access.range(stored.id, { startLine: 1, endLine: 1 })).text, "line one", "the text as it was recorded, not a reread of the source")
      await assert.rejects(async () => repository.evidenceAccess({ ...scope, projectFingerprint: workspaceProjectFingerprint(["file:///another-project"]) }), /holds no project for this fingerprint/, "a second project is not reached through this boundary")
      const before = JSON.stringify(await repository.projectObservations(scope))
      await access.search(stored.id, { query: "line" })
      await access.find({ toolName: "read_file", limit: 5 })
      assert.equal(JSON.stringify(await repository.projectObservations(scope)), before, "a read-only service changes no record the boundary decided")
    } finally {
      repository.close()
    }
  })
})
