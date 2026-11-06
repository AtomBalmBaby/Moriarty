import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { TodoRepository, trustedTodoPanelApproval, workspaceProjectFingerprint } from "../../extension/todos/repository"
import { TodoConflictError } from "../../extension/todos/types"

const wasmPath = path.join(process.cwd(), "out", "sql-wasm.wasm")

test("native TODO SQLite repository persists scoped lists, idempotency, and user completion", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-todos-"))
  try {
    const databasePath = path.join(directory, "twinny-state.sqlite")
    const scope = { projectFingerprint: workspaceProjectFingerprint(["file:///project-a"]), conversationId: "chat-a" }
    const repository = new TodoRepository(databasePath, wasmPath)

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
    const sameRequestInOtherChat = await repository.createItem({ ...scope, conversationId: "chat-b" }, { title: "Isolated retry token" }, "request-create")
    assert.notEqual(sameRequestInOtherChat.id, created.id)
    assert.notEqual(otherChat.id, firstSnapshot.id)

    const reopened = new TodoRepository(databasePath, wasmPath)
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
    const scope = { projectFingerprint: "project", conversationId: "chat" }
    const first = new TodoRepository(databasePath, wasmPath)
    const second = new TodoRepository(databasePath, wasmPath)

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
    const scope = { projectFingerprint: "tool-project", conversationId: "tool-chat" }
    const repository = new TodoRepository(path.join(directory, "twinny-state.sqlite"), wasmPath)
    let changed = 0
    const tools = (await import("../../extension/tools/todos")).todoWorkspaceTools(repository, scope, () => { changed += 1 })
    assert.deepEqual(tools.tools.map((tool) => tool.name), [
      "twinny_todo_list",
      "twinny_todo_get",
      "twinny_todo_create",
      "twinny_todo_update",
      "twinny_todo_evidence"
    ])

    const created = await tools.run({
      name: "twinny_todo_create",
      args: { title: "Create from native tool", request_id: "tool-create", parent_id: "" }
    })
    assert.equal(created.failed, undefined)
    assert.equal(JSON.parse(created.output).parentId, undefined, "an empty optional parent is treated as no parent")
    assert.equal(changed, 1)
    const listed = await tools.run({ name: "twinny_todo_list", args: {} })
    assert.equal(listed.failed, undefined)
    assert.match(listed.output, /Create from native tool/)

    const completionClaim = await tools.run({
      name: "twinny_todo_update",
      args: {
        item_id: JSON.parse(created.output).id,
        expected_version: "1",
        request_id: "tool-complete",
        status: "completed"
      }
    })
    assert.equal(JSON.parse(completionClaim.output).status, "in_review")
    assert.match(completionClaim.summary, /in_review/)
    assert.match(completionClaim.summary, /awaits evidence or the user's approval/)
    assert.equal(changed, 2)

    const modelCompletion = await tools.run({
      name: "twinny_todo_complete",
      args: {
        item_id: JSON.parse(created.output).id,
        expected_version: "2",
        request_id: "tool-model-complete",
        reason: "The user explicitly asked to mark this TODO complete."
      }
    })
    assert.ok(modelCompletion.failed, "the model has no tool that completes or waives a TODO")
    assert.equal(changed, 2)
    const forged = repository.completeByUser(scope, JSON.parse(created.output).id, 2, "forged", "tool-forged-complete", { source: "model" } as never)
    await assert.rejects(forged, /Only an explicit user action/)
    const approved = await repository.completeByUser(
      scope, JSON.parse(created.output).id, 2, "The user explicitly asked to mark this TODO complete.", "tool-explicit-complete", trustedTodoPanelApproval
    )
    assert.equal(approved.status, "completed")
    assert.equal(approved.verification, "waived")

    const evidence = await tools.run({
      name: "twinny_todo_evidence",
      args: {
        item_id: JSON.parse(created.output).id,
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
        item_id: JSON.parse(created.output).id,
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

test("intent plans reconcile atomically, preserve progress, evidence, and chat isolation", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-intent-todos-"))
  try {
    const databasePath = path.join(directory, "twinny-state.sqlite")
    const scope = { projectFingerprint: workspaceProjectFingerprint(["file:///project-a"]), conversationId: "chat-plan-a" }
    const repository = new TodoRepository(databasePath, wasmPath)
    const makePlan = (revision: number, title = "Inspect parser") => ({
      planId: "plan-parser",
      version: 1 as const,
      revision,
      goal: "Make parser behavior reliable",
      constraints: ["Preserve public API"],
      tasks: [
        { id: "inspect-parser", title, description: "Inspect the parser implementation", acceptanceCriteria: ["Identify the faulty branch"], dependencies: [] },
        { id: "fix-parser", title: "Fix parser", description: "Correct the faulty branch", acceptanceCriteria: ["Regression test passes"], dependencies: ["inspect-parser"] },
        { id: "verify-parser", title: "Verify parser", description: "Run focused checks", acceptanceCriteria: ["Focused tests pass"], dependencies: ["fix-parser"] }
      ]
    })
    const firstPlan = makePlan(1)
    const intentResult = { objective: "Make parser behavior reliable", prompt: "Fix the parser", plan: firstPlan }
    const first = await repository.synchronizeIntentPlan(scope, firstPlan, intentResult)
    assert.equal(first.items.filter((item) => item.source === "intent_compiler").length, 3)
    assert.deepEqual(first.items.map((item) => item.title), ["Inspect parser", "Fix parser", "Verify parser"])
    assert.deepEqual(first.items[0].acceptanceCriteria, ["Identify the faulty branch"])
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

    const otherScope = { ...scope, conversationId: "chat-plan-b" }
    const otherPlan = { ...makePlan(1), planId: "other-plan", goal: "Different chat goal", tasks: [
      { id: "other-task", title: "Other chat task", description: "Keep chat plans isolated", acceptanceCriteria: ["Only this chat sees the task"], dependencies: [] }
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

    const reopened = new TodoRepository(databasePath, wasmPath)
    const persistedPlan = await reopened.getIntentTaskPlan(scope)
    assert.equal(persistedPlan?.revision, 4)
    assert.equal(persistedPlan?.tasks.length, 2)
    assert.equal((await reopened.getIntentResult(scope) as { prompt?: string } | undefined)?.prompt, "Fix the parser")
    assert.equal((await reopened.getItem(scope, inspect.id)).item.status, "completed")
    assert.equal((await reopened.getItem(scope, inspect.id)).evidence[0].summary, "The parser accepts malformed delimiters.")
    const context = await reopened.getActiveIntentContext(scope)
    assert.equal(context?.planTaskId, "fix-parser")
    assert.deepEqual(context?.acceptanceCriteria, ["Regression test passes"])
    assert.equal(context?.goal, "Make parser behavior reliable")
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
