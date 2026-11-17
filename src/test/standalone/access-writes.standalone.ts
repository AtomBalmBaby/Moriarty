import * as assert from "node:assert"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { AccessGrant, AccessStore, GrantMemento } from "../../extension/tools/access-grants"
import { AccessApprover, AccessChoice, AccessPrompt, createAccessPreflight } from "../../extension/tools/access-preflight"
import { EditorSink, FileOpsSink } from "../../extension/tools/more"
import { WorkspaceView } from "../../extension/tools/view"
import { EditSink, workspaceTools } from "../../extension/tools/workspace"

const HOST = "local|test"
const ONCE: AccessChoice = { target: "exact", lifetime: "once" }
const SESSION_READ: AccessChoice = { target: "exact", lifetime: "session" }
const DENY: AccessChoice = "deny"

const memento = (): GrantMemento => {
  const data: Record<string, unknown> = {}
  return {
    get: <T>(key: string) => data[key] as T | undefined,
    update: async (key: string, value: unknown) => {
      data[key] = value
    },
  }
}

type Dirs = { root: string; outsideDir: string; otherDir: string; secret: string; sibling: string }

/** A workspace with a file in it, and two folders outside it holding files. */
const sandbox = async (run: (dirs: Dirs) => Promise<void>) => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "access-writes-")))
  const root = path.join(base, "workspace")
  const outsideDir = path.join(base, "outside")
  const otherDir = path.join(base, "other")
  fs.mkdirSync(root)
  fs.mkdirSync(outsideDir)
  fs.mkdirSync(otherDir)
  const secret = path.join(outsideDir, "notes.txt")
  const sibling = path.join(outsideDir, "sibling.txt")
  fs.writeFileSync(secret, "alpha\nsecret-token\n")
  fs.writeFileSync(sibling, "beta\n")
  fs.writeFileSync(path.join(root, "inside.txt"), "gamma\n")
  try {
    await run({ root, outsideDir, otherDir, secret, sibling })
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
}

type Calls = { create: string[]; remove: string[]; move: string[][] }

const recordingSink = (calls: Calls): EditSink & Partial<FileOpsSink> => ({
  mode: "apply",
  edit: async () => ({ ok: true, message: "edited" }),
  create: async (file) => {
    calls.create.push(file)
    return { ok: true, message: "created" }
  },
  remove: async (file) => {
    calls.remove.push(file)
    return { ok: true, message: "removed" }
  },
  move: async (from, to) => {
    calls.move.push([from, to])
    return { ok: true, message: "moved" }
  },
})

/** Answers from a script in order; running past the script denies, as an absent user would. */
const scripted = (...answers: AccessChoice[]) => {
  const prompts: AccessPrompt[] = []
  const queue = [...answers]
  const approve: AccessApprover = async (prompt) => {
    prompts.push(prompt)
    return queue.shift()
  }
  return { prompts, approve }
}

const dispatcher = (root: string, approve: AccessApprover, calls: Calls, editor?: EditorSink) => {
  const store = new AccessStore(memento(), HOST)
  const view = new WorkspaceView(root, [], undefined, [], [], () =>
    store.grants().map((grant: AccessGrant) => ({ root: grant.root, real: grant.real, scope: grant.scope }))
  )
  const access = createAccessPreflight({ store, view, approve })
  return { store, tools: workspaceTools(view, [], { access, edits: recordingSink(calls), editor }) }
}

const noCalls = (): Calls => ({ create: [], remove: [], move: [] })

test("creating a file outside the workspace asks for write and writes once when approved", () =>
  sandbox(async ({ root, outsideDir }) => {
    const target = path.join(outsideDir, "new.txt")
    const { prompts, approve } = scripted(ONCE)
    const calls = noCalls()
    const { store, tools } = dispatcher(root, approve, calls)

    const result = await tools.run({ name: "create_file", args: { path: target, content: "made\n" } })

    assert.ok(!result.failed, result.output)
    assert.deepEqual(calls.create, [target])
    assert.equal(prompts.length, 1)
    assert.equal(prompts[0].access, "write")
    assert.equal(store.grants().length, 0, "a once grant does not outlive its call")
  }))

test("a read grant does not cover deleting the file", () =>
  sandbox(async ({ root, secret }) => {
    const prompts: AccessPrompt[] = []
    const approve: AccessApprover = async (prompt) => {
      prompts.push(prompt)
      return prompt.access === "read" ? SESSION_READ : DENY
    }
    const calls = noCalls()
    const { tools } = dispatcher(root, approve, calls)

    assert.ok(!(await tools.run({ name: "read_file", args: { path: secret } })).failed)
    const result = await tools.run({ name: "delete_file", args: { path: secret } })

    assert.equal(result.failed, true)
    assert.equal(prompts.at(-1)?.access, "write")
    assert.deepEqual(calls.remove, [])
    assert.ok(fs.existsSync(secret))
  }))

test("deleting an outside file, once approved, removes it once", () =>
  sandbox(async ({ root, secret }) => {
    const { prompts, approve } = scripted(ONCE)
    const calls = noCalls()
    const { tools } = dispatcher(root, approve, calls)

    const result = await tools.run({ name: "delete_file", args: { path: secret } })

    assert.ok(!result.failed, result.output)
    assert.deepEqual(calls.remove, [secret])
    assert.equal(prompts.length, 1)
  }))

test("moving an outside file into the workspace checks its source only", () =>
  sandbox(async ({ root, secret }) => {
    const { prompts, approve } = scripted(ONCE)
    const calls = noCalls()
    const { tools } = dispatcher(root, approve, calls)
    const destination = path.join(root, "moved.txt")

    const result = await tools.run({ name: "move_file", args: { from: secret, to: "moved.txt" } })

    assert.ok(!result.failed, result.output)
    assert.deepEqual(calls.move, [[secret, destination]])
    assert.equal(prompts.length, 1)
  }))

test("moving a workspace file to a denied outside destination moves nothing", () =>
  sandbox(async ({ root, outsideDir }) => {
    const source = path.join(root, "inside.txt")
    const { prompts, approve } = scripted(DENY)
    const calls = noCalls()
    const { tools } = dispatcher(root, approve, calls)

    const result = await tools.run({ name: "move_file", args: { from: source, to: path.join(outsideDir, "gone.txt") } })

    assert.equal(result.failed, true)
    assert.deepEqual(calls.move, [])
    assert.equal(prompts.length, 1)
    assert.ok(fs.existsSync(source))
  }))

test("a move between outside folders checks both paths before moving, so a denied destination leaves the source alone", () =>
  sandbox(async ({ root, otherDir, secret }) => {
    const { prompts, approve } = scripted(ONCE, DENY)
    const calls = noCalls()
    const { tools } = dispatcher(root, approve, calls)

    const result = await tools.run({ name: "move_file", args: { from: secret, to: path.join(otherDir, "moved.txt") } })

    assert.equal(result.failed, true)
    assert.equal(prompts.length, 2)
    assert.equal(prompts[1].access, "write")
    assert.deepEqual(calls.move, [])
    assert.ok(fs.existsSync(secret))
  }))

/** Mimics the editor's rename: it reaches `reach`, asks about the files outside the workspace first, and applies only when none is refused. */
const renamingEditor = (root: string, reach: string[], applied: string[][]): EditorSink =>
  ({
    diagnostics: async () => [],
    references: async () => [],
    definition: async () => [],
    context: async () => ({ activeFile: undefined, openFiles: [] }),
    rename: async (
      _file: string,
      _line: number,
      _character: number,
      _newName: string,
      authorizeOutside?: (files: string[]) => Promise<string | undefined>
    ) => {
      const outside = reach.filter((file) => !file.startsWith(`${root}${path.sep}`))
      const refusal = outside.length === 0 ? undefined : authorizeOutside ? await authorizeOutside(outside) : `outside ${outside[0]}`
      if (refusal) return { ok: false, message: refusal }
      applied.push(reach)
      return { ok: true, message: "renamed", files: reach }
    },
  }) as unknown as EditorSink

test("a rename of an outside symbol needs write approval for the target and for every outside file it reaches", () =>
  sandbox(async ({ root, secret, sibling }) => {
    fs.writeFileSync(secret, "export const widget = 1\n")
    const applied: string[][] = []
    const { prompts, approve } = scripted(ONCE, DENY)
    const { tools } = dispatcher(root, approve, noCalls(), renamingEditor(root, [secret, sibling], applied))

    const result = await tools.run({ name: "rename_symbol", args: { path: secret, symbol: "widget", new_name: "gadget" } })

    assert.equal(result.failed, true)
    assert.deepEqual(applied, [], "nothing is renamed when any reached file is denied")
    assert.equal(prompts.length, 2)
    assert.equal(prompts[1].path, sibling)
    assert.equal(prompts[1].access, "write")
  }))

test("a rename that every reached outside file approves applies once", () =>
  sandbox(async ({ root, secret, sibling }) => {
    fs.writeFileSync(secret, "export const widget = 1\n")
    const applied: string[][] = []
    const { prompts, approve } = scripted(ONCE, ONCE)
    const { tools } = dispatcher(root, approve, noCalls(), renamingEditor(root, [secret, sibling], applied))

    const result = await tools.run({ name: "rename_symbol", args: { path: secret, symbol: "widget", new_name: "gadget" } })

    assert.ok(!result.failed, result.output)
    assert.deepEqual(applied, [[secret, sibling]])
    assert.equal(prompts.length, 2)
  }))

test("a read grant on a rename target does not allow the rename", () =>
  sandbox(async ({ root, secret }) => {
    fs.writeFileSync(secret, "export const widget = 1\n")
    const applied: string[][] = []
    const prompts: AccessPrompt[] = []
    const approve: AccessApprover = async (prompt) => {
      prompts.push(prompt)
      return prompt.access === "read" ? SESSION_READ : DENY
    }
    const { tools } = dispatcher(root, approve, noCalls(), renamingEditor(root, [secret], applied))

    assert.ok(!(await tools.run({ name: "read_file", args: { path: secret } })).failed)
    const result = await tools.run({ name: "rename_symbol", args: { path: secret, symbol: "widget", new_name: "gadget" } })

    assert.equal(result.failed, true)
    assert.deepEqual(applied, [])
    assert.equal(prompts.at(-1)?.access, "write")
  }))
