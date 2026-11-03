import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { TodoRepository, workspaceProjectFingerprint } from "../../extension/todos/repository"
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

    const approved = await reopened.completeByUser(scope, created.id, claimed.version, "Reviewed by user", "request-user-complete")
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
      "twinny_todo_complete",
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
    assert.match(completionClaim.summary, /twinny_todo_complete/)
    assert.equal(changed, 2)

    const explicitCompletion = await tools.run({
      name: "twinny_todo_complete",
      args: {
        item_id: JSON.parse(created.output).id,
        expected_version: "2",
        request_id: "tool-explicit-complete",
        reason: "The user explicitly asked to mark this TODO complete."
      }
    })
    assert.equal(explicitCompletion.failed, undefined)
    assert.equal(JSON.parse(explicitCompletion.output).status, "completed")
    assert.equal(JSON.parse(explicitCompletion.output).verification, "waived")
    assert.equal(changed, 3)

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
    assert.equal(changed, 4)

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
