import * as assert from "node:assert"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { AccessGrant, AccessStore, GrantMemento } from "../../extension/tools/access-grants"
import { AccessApprover, AccessChoice, AccessPrompt, createAccessPreflight } from "../../extension/tools/access-preflight"
import { contentHash } from "../../extension/tools/line-edit"
import { WorkspaceView } from "../../extension/tools/view"
import { workspaceTools } from "../../extension/tools/workspace"

const HOST = "local|test"
const SECRET = "alpha\nsecret-token\n"

const memento = (): GrantMemento => {
  const data: Record<string, unknown> = {}
  return {
    get: <T>(key: string) => data[key] as T | undefined,
    update: async (key: string, value: unknown) => {
      data[key] = value
    },
  }
}

/** A workspace, plus a file outside it that holds a secret, in a scratch directory. */
const sandbox = async (run: (dirs: { root: string; secret: string; outsideDir: string }) => Promise<void>) => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "access-dispatch-")))
  const root = path.join(base, "workspace")
  const outsideDir = path.join(base, "outside")
  fs.mkdirSync(root)
  fs.mkdirSync(outsideDir)
  const secret = path.join(outsideDir, "notes.txt")
  fs.writeFileSync(secret, SECRET)
  try {
    await run({ root, secret, outsideDir })
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
}

/** The native dispatcher, wired to an access store and an approver the test controls. */
const dispatcher = (root: string, approve: AccessApprover | undefined) => {
  const store = new AccessStore(memento(), HOST)
  const view = new WorkspaceView(root, [], undefined, [], [], () =>
    store.grants().map((grant: AccessGrant) => ({ root: grant.root, real: grant.real, scope: grant.scope }))
  )
  const access = createAccessPreflight({ store, view, approve })
  return { store, tools: workspaceTools(view, [], { access }) }
}

const counting = (choice: AccessChoice | undefined) => {
  const prompts: AccessPrompt[] = []
  const approve: AccessApprover = async (prompt) => {
    prompts.push(prompt)
    return choice
  }
  return { prompts, approve }
}

const readSecret = (tools: ReturnType<typeof dispatcher>["tools"], file: string, signal?: AbortSignal) =>
  tools.run({ name: "read_file", args: { path: file } }, signal ? { signal } : undefined)

test("an approved outside read resumes in the same call, once, with the whole-file hash", () =>
  sandbox(async ({ root, secret }) => {
    const { prompts, approve } = counting({ target: "exact", lifetime: "once" })
    const { store, tools } = dispatcher(root, approve)

    const result = await readSecret(tools, secret)

    assert.ok(!result.failed, result.output)
    assert.match(result.output, /secret-token/)
    assert.ok(result.output.includes(`content_hash: ${await contentHash(SECRET)}`), result.output)
    assert.equal(prompts.length, 1)
    assert.equal(prompts[0].access, "read")
    assert.equal(store.grants().length, 0, "a once grant does not outlive its call")
  }))

test("a denied outside read fails and never reads the file", () =>
  sandbox(async ({ root, secret }) => {
    const { prompts, approve } = counting("deny")
    const { tools } = dispatcher(root, approve)

    const result = await readSecret(tools, secret)

    assert.equal(result.failed, true)
    assert.doesNotMatch(result.output, /secret-token/)
    assert.equal(prompts.length, 1)
  }))

test("a once grant prompts again on the next call", () =>
  sandbox(async ({ root, secret }) => {
    const { prompts, approve } = counting({ target: "exact", lifetime: "once" })
    const { tools } = dispatcher(root, approve)

    assert.ok(!(await readSecret(tools, secret)).failed)
    assert.ok(!(await readSecret(tools, secret)).failed)
    assert.equal(prompts.length, 2)
  }))

test("a session grant covers later calls without a second prompt", () =>
  sandbox(async ({ root, secret }) => {
    const { prompts, approve } = counting({ target: "exact", lifetime: "session" })
    const { tools } = dispatcher(root, approve)

    assert.ok(!(await readSecret(tools, secret)).failed)
    const again = await readSecret(tools, secret)
    assert.ok(!again.failed)
    assert.match(again.output, /secret-token/)
    assert.equal(prompts.length, 1)
  }))

test("a folder grant covers a sibling file in the same outside folder", () =>
  sandbox(async ({ root, secret, outsideDir }) => {
    const sibling = path.join(outsideDir, "other.txt")
    fs.writeFileSync(sibling, "other\n")
    const { prompts, approve } = counting({ target: "folder", lifetime: "session" })
    const { tools } = dispatcher(root, approve)

    assert.ok(!(await readSecret(tools, secret)).failed)
    const result = await tools.run({ name: "read_file", args: { path: sibling } })
    assert.ok(!result.failed, result.output)
    assert.equal(prompts.length, 1)
  }))

test("a cancelled call is refused before any prompt", () =>
  sandbox(async ({ root, secret }) => {
    const { prompts, approve } = counting({ target: "exact", lifetime: "once" })
    const { tools } = dispatcher(root, approve)
    const controller = new AbortController()
    controller.abort()

    const result = await readSecret(tools, secret, controller.signal)

    assert.equal(result.failed, true)
    assert.doesNotMatch(result.output, /secret-token/)
    assert.equal(prompts.length, 0)
  }))

test("an approver that throws fails closed", () =>
  sandbox(async ({ root, secret }) => {
    const approve: AccessApprover = async () => {
      throw new Error("no ui")
    }
    const { tools } = dispatcher(root, approve)

    const result = await readSecret(tools, secret)

    assert.equal(result.failed, true)
    assert.doesNotMatch(result.output, /secret-token/)
  }))

test("without an access preflight an outside read is still refused", () =>
  sandbox(async ({ root, secret }) => {
    const tools = workspaceTools(root)

    const result = await readSecret(tools, secret)

    assert.equal(result.failed, true)
    assert.doesNotMatch(result.output, /secret-token/)
  }))

test("a workspace link that leads outside is refused through the dispatcher without a prompt", () =>
  sandbox(async ({ root, secret }) => {
    const link = path.join(root, "notes-link.txt")
    fs.symlinkSync(secret, link)
    const { prompts, approve } = counting({ target: "exact", lifetime: "always" })
    const { tools, store } = dispatcher(root, approve)

    const result = await readSecret(tools, link)

    assert.equal(result.failed, true)
    assert.doesNotMatch(result.output, /secret-token/)
    assert.equal(prompts.length, 0)
    assert.deepEqual(store.grants(), [])
  }))
