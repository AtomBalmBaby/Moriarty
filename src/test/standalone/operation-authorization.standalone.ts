import * as assert from "node:assert"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { claimWrites, coversWrites, OperationAuthorization, WriteRequest } from "../../extension/tools/operation-authorization"

const HOST = "remote|ssh-a"

const withDir = (run: (dir: string) => void) => () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "operation-auth-")))
  try {
    run(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test("a claim covering exactly the approved write succeeds once", withDir((dir) => {
  const file = path.join(dir, "a.txt")
  const requests: WriteRequest[] = [{ operation: "edit", absolute: file }]
  const authorization = OperationAuthorization.issue(HOST, requests)
  assert.equal(claimWrites(authorization, requests, HOST), true)
  assert.equal(claimWrites(authorization, requests, HOST), false, "a spent authorization must not be claimed again")
}))

test("a peek before the claim neither spends the authorization nor is needed for it", withDir((dir) => {
  const file = path.join(dir, "a.txt")
  const requests: WriteRequest[] = [{ operation: "edit", absolute: file }]
  const authorization = OperationAuthorization.issue(HOST, requests)
  assert.equal(coversWrites(authorization, requests, HOST), true)
  assert.equal(coversWrites(authorization, requests, HOST), true, "a peek does not spend the authorization")
  assert.equal(claimWrites(authorization, requests, HOST), true)
  assert.equal(coversWrites(authorization, requests, HOST), false, "a spent authorization no longer covers the write")
}))

test("a claim with the wrong operation, path or host fails without spending the authorization", withDir((dir) => {
  const file = path.join(dir, "a.txt")
  const other = path.join(dir, "b.txt")
  const authorization = OperationAuthorization.issue(HOST, [{ operation: "create", absolute: file }])
  assert.equal(claimWrites(authorization, [{ operation: "edit", absolute: file }], HOST), false)
  assert.equal(claimWrites(authorization, [{ operation: "create", absolute: other }], HOST), false)
  assert.equal(claimWrites(authorization, [{ operation: "create", absolute: file }], "remote|ssh-b"), false)
  assert.equal(claimWrites(authorization, [{ operation: "create", absolute: file }], HOST), true)
}))

test("a multi-path authorization needs every approved path, each once", withDir((dir) => {
  const [from, to] = [path.join(dir, "a.txt"), path.join(dir, "b.txt")]
  const authorization = OperationAuthorization.issue(HOST, [
    { operation: "move", absolute: from },
    { operation: "move", absolute: to },
  ])
  assert.equal(claimWrites(authorization, [{ operation: "move", absolute: from }], HOST), false, "a partial claim must fail")
  assert.equal(claimWrites(authorization, [{ operation: "move", absolute: from }, { operation: "move", absolute: from }], HOST), false, "a duplicate must not stand in for another path")
  assert.equal(claimWrites(authorization, [{ operation: "move", absolute: to }, { operation: "move", absolute: from }], HOST), true)
}))

test("an ended authorization cannot be claimed", withDir((dir) => {
  const requests: WriteRequest[] = [{ operation: "remove", absolute: path.join(dir, "a.txt") }]
  const authorization = OperationAuthorization.issue(HOST, requests)
  authorization.end()
  assert.equal(claimWrites(authorization, requests, HOST), false)
}))

test("forged or copied authorizations are refused", withDir((dir) => {
  const requests: WriteRequest[] = [{ operation: "edit", absolute: path.join(dir, "a.txt") }]
  assert.equal(claimWrites({}, requests, HOST), false)
  assert.equal(claimWrites(undefined, requests, HOST), false)
  const real = OperationAuthorization.issue(HOST, requests)
  const copy: unknown = Object.create(Object.getPrototypeOf(real))
  assert.equal(claimWrites(copy, requests, HOST), false)
  assert.equal(claimWrites(real, requests, HOST), true, "the genuine authorization is unaffected by the forgeries")
}))

test("a symlink retargeted after approval no longer matches the approved target", withDir((dir) => {
  const first = path.join(dir, "first.txt")
  const second = path.join(dir, "second.txt")
  const link = path.join(dir, "link.txt")
  fs.writeFileSync(first, "one")
  fs.writeFileSync(second, "two")
  fs.symlinkSync(first, link)
  const requests: WriteRequest[] = [{ operation: "edit", absolute: link }]
  const authorization = OperationAuthorization.issue(HOST, requests)
  fs.unlinkSync(link)
  fs.symlinkSync(second, link)
  assert.equal(claimWrites(authorization, requests, HOST), false)
}))

type AuthModule = {
  OperationAuthorization: { issue: (host: string, requests: readonly WriteRequest[]) => unknown }
  claimWrites: (authorization: unknown, requests: readonly WriteRequest[], host: string) => boolean
}

test("an authorization issued by another copy of this module is accepted, a forgery still is not", withDir((dir) => {
  const requests: WriteRequest[] = [{ operation: "edit", absolute: path.join(dir, "a.txt") }]
  // In the extension host the shipped extension runs as a bundle that holds its own copy of this
  // module, so what one copy approves is claimed by the other. That is the same rule, so the set of
  // what was approved is held once for the process.
  const id = path.resolve(__dirname, "../../extension/tools/operation-authorization.js")
  delete require.cache[id]
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const other = require(id) as AuthModule
  assert.notEqual(other.OperationAuthorization, OperationAuthorization, "the second copy is a separate module instance")
  assert.equal(claimWrites(other.OperationAuthorization.issue(HOST, requests), requests, HOST), true, "what this process approved is claimed whichever copy runs the claim")
  assert.equal(other.claimWrites(OperationAuthorization.issue(HOST, requests), requests, HOST), true, "and the other way round")
  assert.equal(claimWrites(Object.create(OperationAuthorization.prototype), requests, HOST), false, "a forgery is still refused")
  delete require.cache[id]
}))
