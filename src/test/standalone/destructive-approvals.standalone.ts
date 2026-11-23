import assert from "node:assert/strict"
import { test } from "node:test"
import path from "path"

import { DestructiveApprovalMemento,DestructiveApprovalStore } from "../../extension/chat/destructive-approvals"

const memento = (): DestructiveApprovalMemento & { data: Record<string, unknown> } => {
  const data: Record<string, unknown> = {}
  return {
    data,
    get: <T>(key: string) => data[key] as T | undefined,
    update: async (key: string, value: unknown) => { data[key] = value }
  }
}

test("allow once is intentionally not represented by persistent approval state", async () => {
  const mem = memento()
  const store = new DestructiveApprovalStore(mem, () => "/project")
  assert.equal(store.allows("remove", "/project/untracked.ts"), false)
  assert.equal(store.projectApprovals().length, 0)
})

test("session approval survives later calls but not a recreated store", async () => {
  const mem = memento()
  const first = new DestructiveApprovalStore(mem, () => "/project")
  await first.add("remove", "/project/untracked.ts", "session")
  assert.equal(first.allows("remove", "/project/untracked.ts"), true)

  const next = new DestructiveApprovalStore(mem, () => "/project")
  assert.equal(next.allows("remove", "/project/untracked.ts"), false)
})

test("project approval survives store recreation and matches operation and resource", async () => {
  const mem = memento()
  const first = new DestructiveApprovalStore(mem, () => "/project")
  await first.add("remove", "/project/untracked.ts", "project")

  const next = new DestructiveApprovalStore(mem, () => "/project")
  assert.equal(next.allows("remove", "/project/untracked.ts"), true)
  assert.equal(next.allows("move", "/project/untracked.ts"), false)
  assert.equal(next.allows("remove", "/project/other.ts"), false)
  assert.equal(next.allows("remove", path.join("/project", "untracked.ts")), true)
})

test("project approval does not cross project homes and can be revoked", async () => {
  const mem = memento()
  const alpha = new DestructiveApprovalStore(mem, () => "/alpha")
  await alpha.add("delete-recreate", "/alpha/new.ts", "project")
  assert.equal(alpha.allows("delete-recreate", "/alpha/new.ts"), true)

  const beta = new DestructiveApprovalStore(mem, () => "/beta")
  assert.equal(beta.allows("delete-recreate", "/alpha/new.ts"), false)

  assert.equal(await alpha.revokeProject((grant) => grant.operation === "delete-recreate"), 1)
  assert.equal(alpha.allows("delete-recreate", "/alpha/new.ts"), false)
})

test("denial adds no approval and no unrelated operation is authorized", async () => {
  const mem = memento()
  const store = new DestructiveApprovalStore(mem, () => "/project")
  assert.equal(store.allows("remove", "/project/untracked.ts"), false)
  assert.equal(store.allows("move", "/project/untracked.ts"), false)
  assert.equal(store.allows("rename", "/project/untracked.ts"), false)
  assert.equal(store.projectApprovals().length, 0)
})
