import * as assert from "node:assert"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { AccessGrant, AccessStore, GrantMemento } from "../../extension/tools/access-grants"
import { AccessApprover, AccessChoice, AccessOutcome, AccessPrompt, accessTargetsOf, createAccessPreflight } from "../../extension/tools/access-preflight"
import { WorkspaceView } from "../../extension/tools/view"

const HOST = "local|test"

const memento = (): GrantMemento => {
  const data: Record<string, unknown> = {}
  return {
    get: <T>(key: string) => data[key] as T | undefined,
    update: async (key: string, value: unknown) => {
      data[key] = value
    },
  }
}

const withDirs = (run: (dirs: { root: string; outside: string; base: string }) => Promise<void>) => async () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "access-preflight-")))
  const root = path.join(base, "workspace")
  const outside = path.join(base, "outside")
  fs.mkdirSync(root)
  fs.mkdirSync(outside)
  try {
    await run({ root, outside, base })
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
}

const viewFor = (root: string, store: AccessStore) =>
  new WorkspaceView(root, [], undefined, [], [], () => store.grants().map((grant: AccessGrant) => ({ root: grant.root, real: grant.real, scope: grant.scope })))

/** An approver that records each prompt and answers with `choice`, or runs `act` first. */
const answering = (choice: AccessChoice | undefined, act?: () => void) => {
  const prompts: AccessPrompt[] = []
  const approve: AccessApprover = async (prompt) => {
    prompts.push(prompt)
    act?.()
    return choice
  }
  return { prompts, approve }
}

const refusalOf = (outcome: AccessOutcome) => (outcome.ok ? "" : outcome.message)

test("accessTargetsOf reads, writes and both move paths", () => {
  assert.deepStrictEqual(accessTargetsOf("read_file", { path: "/tmp/a" }), [{ path: "/tmp/a", access: "read" }])
  assert.deepStrictEqual(accessTargetsOf("grep", { path: "/tmp" }), [{ path: "/tmp", access: "read" }])
  assert.deepStrictEqual(accessTargetsOf("edit_lines", { path: "/tmp/a" }), [{ path: "/tmp/a", access: "write", operation: "edit" }])
  assert.deepStrictEqual(accessTargetsOf("move_file", { from: "/a", to: "/b" }), [
    { path: "/a", access: "write", operation: "move" },
    { path: "/b", access: "write", creates: true, operation: "move" },
  ])
  assert.deepStrictEqual(accessTargetsOf("create_file", { path: "/tmp/new" }), [{ path: "/tmp/new", access: "write", creates: true, operation: "create" }])
  assert.deepStrictEqual(accessTargetsOf("find_files", { path: "*.ts" }), [])
})

test("an approved once grant lets the call through and lasts one call", withDirs(async ({ root, outside }) => {
  const file = path.join(outside, "a.txt")
  fs.writeFileSync(file, "a")
  const store = new AccessStore(undefined, HOST)
  const answer = answering({ target: "exact", lifetime: "once" })
  const preflight = createAccessPreflight({ store, view: viewFor(root, store), approve: answer.approve })
  assert.deepStrictEqual(await preflight.authorize([{ path: file, access: "read" }], "read_file"), { ok: true })
  assert.equal(answer.prompts.length, 1)
  assert.equal(answer.prompts[0].isDirectory, false)
  assert.equal(answer.prompts[0].tool, "read_file")
  assert.equal(answer.prompts[0].access, "read")
  store.endCall()
  await preflight.authorize([{ path: file, access: "read" }], "read_file")
  assert.equal(answer.prompts.length, 2, "a once grant does not outlive its call")
}))

test("session grants stop asking within the host's life", withDirs(async ({ root, outside }) => {
  const file = path.join(outside, "a.txt")
  fs.writeFileSync(file, "a")
  const store = new AccessStore(memento(), HOST)
  const answer = answering({ target: "exact", lifetime: "session" })
  const preflight = createAccessPreflight({ store, view: viewFor(root, store), approve: answer.approve })
  await preflight.authorize([{ path: file, access: "read" }], "read_file")
  store.endCall()
  await preflight.authorize([{ path: file, access: "read" }], "read_file")
  assert.equal(answer.prompts.length, 1, "a session grant survives the call")
}))

test("a denied prompt refuses the call", withDirs(async ({ root, outside }) => {
  const file = path.join(outside, "a.txt")
  fs.writeFileSync(file, "a")
  const store = new AccessStore(undefined, HOST)
  const outcome = await createAccessPreflight({ store, view: viewFor(root, store), approve: answering("deny").approve }).authorize(
    [{ path: file, access: "read" }],
    "read_file"
  )
  assert.equal(outcome.ok, false)
  assert.equal(store.grants().length, 0)
}))

test("dismissing the prompt (undefined) refuses the call", withDirs(async ({ root, outside }) => {
  const file = path.join(outside, "a.txt")
  fs.writeFileSync(file, "a")
  const store = new AccessStore(undefined, HOST)
  const outcome = await createAccessPreflight({ store, view: viewFor(root, store), approve: answering(undefined).approve }).authorize(
    [{ path: file, access: "read" }],
    "read_file"
  )
  assert.equal(outcome.ok, false)
}))

test("unavailable UI (no approver) refuses without prompting", withDirs(async ({ root, outside }) => {
  const file = path.join(outside, "a.txt")
  fs.writeFileSync(file, "a")
  const store = new AccessStore(undefined, HOST)
  const outcome = await createAccessPreflight({ store, view: viewFor(root, store) }).authorize([{ path: file, access: "read" }], "read_file")
  assert.equal(outcome.ok, false)
  assert.equal(store.grants().length, 0)
}))

test("a throwing approver refuses", withDirs(async ({ root, outside }) => {
  const file = path.join(outside, "a.txt")
  fs.writeFileSync(file, "a")
  const store = new AccessStore(undefined, HOST)
  const throwing: AccessApprover = async () => {
    throw new Error("no ui")
  }
  const outcome = await createAccessPreflight({ store, view: viewFor(root, store), approve: throwing }).authorize([{ path: file, access: "read" }], "read_file")
  assert.equal(outcome.ok, false)
  assert.equal(store.grants().length, 0)
}))

test("a call cancelled before asking is refused without a prompt; one cancelled during a prompt is refused and keeps no grant", withDirs(async ({ root, outside }) => {
  const file = path.join(outside, "a.txt")
  fs.writeFileSync(file, "a")
  const store = new AccessStore(undefined, HOST)
  const before = answering({ target: "exact", lifetime: "session" })
  const cancelled = new AbortController()
  cancelled.abort()
  const preflight = createAccessPreflight({ store, view: viewFor(root, store), approve: before.approve })
  assert.equal((await preflight.authorize([{ path: file, access: "read" }], "read_file", cancelled.signal)).ok, false)
  assert.equal(before.prompts.length, 0)

  const during = new AbortController()
  const answer = answering({ target: "exact", lifetime: "session" }, () => during.abort())
  const late = createAccessPreflight({ store, view: viewFor(root, store), approve: answer.approve })
  assert.equal((await late.authorize([{ path: file, access: "read" }], "read_file", during.signal)).ok, false)
  assert.equal(store.grants().length, 0, "a grant from a cancelled prompt is not kept")
}))

test("a folder choice covers the folder, and a directory target's exact choice means this directory", withDirs(async ({ root, outside }) => {
  const dir = path.join(outside, "proj")
  fs.mkdirSync(path.join(dir, "sub"), { recursive: true })
  fs.writeFileSync(path.join(dir, "sub", "x.txt"), "x")
  const store = new AccessStore(undefined, HOST)
  const answer = answering({ target: "folder", lifetime: "session" })
  const preflight = createAccessPreflight({ store, view: viewFor(root, store), approve: answer.approve })
  assert.equal((await preflight.authorize([{ path: path.join(dir, "sub", "x.txt"), access: "read" }], "read_file")).ok, true)
  assert.equal(answer.prompts[0].folder, path.join(dir, "sub"))
  assert.equal((await preflight.authorize([{ path: path.join(dir, "sub", "x.txt"), access: "read" }], "read_file")).ok, true)
  assert.equal(answer.prompts.length, 1)

  const exact = answering({ target: "exact", lifetime: "session" })
  const directory = createAccessPreflight({ store: new AccessStore(undefined, HOST), view: viewFor(root, store), approve: exact.approve })
  await directory.authorize([{ path: dir, access: "read" }], "list_dir")
  assert.equal(exact.prompts[0].isDirectory, true)
}))

test("a file choice does not cover its siblings", withDirs(async ({ root, outside }) => {
  const file = path.join(outside, "a.txt")
  const sibling = path.join(outside, "b.txt")
  fs.writeFileSync(file, "a")
  fs.writeFileSync(sibling, "b")
  const store = new AccessStore(undefined, HOST)
  const answer = answering({ target: "exact", lifetime: "session" })
  const preflight = createAccessPreflight({ store, view: viewFor(root, store), approve: answer.approve })
  await preflight.authorize([{ path: file, access: "read" }], "read_file")
  assert.equal((await preflight.authorize([{ path: sibling, access: "read" }], "read_file")).ok, true)
  assert.equal(answer.prompts.length, 2)
}))

test("a read grant still prompts for a write", withDirs(async ({ root, outside }) => {
  const file = path.join(outside, "a.txt")
  fs.writeFileSync(file, "a")
  const store = new AccessStore(undefined, HOST)
  const answer = answering({ target: "exact", lifetime: "session" })
  const preflight = createAccessPreflight({ store, view: viewFor(root, store), approve: answer.approve })
  await preflight.authorize([{ path: file, access: "read" }], "read_file")
  await preflight.authorize([{ path: file, access: "write" }], "edit_lines")
  assert.equal(answer.prompts.length, 2)
}))

test("a workspace path and a settings folder are never asked about", withDirs(async ({ root, outside }) => {
  const inside = path.join(root, "a.ts")
  fs.writeFileSync(inside, "a")
  const allowedDir = path.join(outside, "allowed")
  fs.mkdirSync(allowedDir)
  const allowedFile = path.join(allowedDir, "z.txt")
  fs.writeFileSync(allowedFile, "z")
  const store = new AccessStore(undefined, HOST)
  const answer = answering("deny")
  const view = new WorkspaceView(root, [], undefined, [], [allowedDir])
  const preflight = createAccessPreflight({ store, view, approve: answer.approve })
  assert.equal((await preflight.authorize([{ path: inside, access: "write" }], "edit_lines")).ok, true)
  assert.equal((await preflight.authorize([{ path: allowedFile, access: "read" }], "read_file")).ok, true)
  assert.equal(answer.prompts.length, 0)
}))

test("a refused path refuses the whole call before any prompt", withDirs(async ({ root, outside }) => {
  const source = path.join(outside, "a.txt")
  fs.writeFileSync(source, "a")
  const hidden = path.join(outside, "node_modules", "dep.js")
  fs.mkdirSync(path.dirname(hidden), { recursive: true })
  fs.writeFileSync(hidden, "x")
  const store = new AccessStore(undefined, HOST)
  const answer = answering({ target: "exact", lifetime: "session" })
  const preflight = createAccessPreflight({ store, view: viewFor(root, store), approve: answer.approve })
  const outcome = await preflight.authorize(
    [
      { path: source, access: "write" },
      { path: hidden, access: "write" },
    ],
    "move_file"
  )
  assert.equal(outcome.ok, false)
  assert.equal(answer.prompts.length, 0, "a refused path is refused before any prompt")
  assert.equal(store.grants().length, 0)
}))

test("a filesystem root is never granted", withDirs(async ({ root }) => {
  const store = new AccessStore(undefined, HOST)
  const answer = answering({ target: "folder", lifetime: "session" })
  const outcome = await createAccessPreflight({ store, view: viewFor(root, store), approve: answer.approve }).authorize(
    [{ path: path.parse(root).root, access: "read" }],
    "list_dir"
  )
  assert.equal(outcome.ok, false)
  assert.equal(answer.prompts.length, 0)
}))

test("an always grant is kept for this host across restarts and not shared with another host", withDirs(async ({ root, outside }) => {
  const file = path.join(outside, "a.txt")
  fs.writeFileSync(file, "a")
  const mem = memento()
  const first = new AccessStore(mem, HOST)
  const answer = answering({ target: "exact", lifetime: "always" })
  await createAccessPreflight({ store: first, view: viewFor(root, first), approve: answer.approve }).authorize([{ path: file, access: "read" }], "read_file")

  const restarted = new AccessStore(mem, HOST)
  const again = answering("deny")
  const readAgain = createAccessPreflight({ store: restarted, view: viewFor(root, restarted), approve: again.approve })
  assert.equal((await readAgain.authorize([{ path: file, access: "read" }], "read_file")).ok, true)
  assert.equal(again.prompts.length, 0)

  const other = new AccessStore(mem, "ssh|other")
  const refused = createAccessPreflight({ store: other, view: viewFor(root, other), approve: again.approve })
  assert.equal((await refused.authorize([{ path: file, access: "read" }], "read_file")).ok, false)
}))

test("an approved file is readable through the view, and nothing beside it", withDirs(async ({ root, outside }) => {
  const file = path.join(outside, "a.txt")
  const sibling = path.join(outside, "b.txt")
  fs.writeFileSync(file, "a")
  fs.writeFileSync(sibling, "b")
  const store = new AccessStore(undefined, HOST)
  const view = viewFor(root, store)
  assert.throws(() => view.resolve(file, "file"), /outside the workspace/)
  await createAccessPreflight({ store, view, approve: answering({ target: "exact", lifetime: "session" }).approve }).authorize([{ path: file, access: "read" }], "read_file")
  assert.equal(view.resolve(file, "file"), file)
  assert.throws(() => view.resolve(sibling, "file"), /outside the workspace/)
}))

test("an approved new file is writable through the view only at its own path", withDirs(async ({ root, outside }) => {
  const created = path.join(outside, "new.txt")
  const other = path.join(outside, "other.txt")
  const store = new AccessStore(undefined, HOST)
  const view = viewFor(root, store)
  await createAccessPreflight({ store, view, approve: answering({ target: "exact", lifetime: "session" }).approve }).authorize([{ path: created, access: "write", creates: true }], "create_file")
  assert.equal(view.resolveNew(created), created)
  assert.throws(() => view.resolveNew(other), /outside the workspace/)
}))

test("a grant does not reach a path whose link was retargeted", withDirs(async ({ root, outside }) => {
  const first = path.join(outside, "first")
  const second = path.join(outside, "second")
  const link = path.join(outside, "link")
  fs.mkdirSync(first)
  fs.mkdirSync(second)
  fs.writeFileSync(path.join(first, "f.txt"), "1")
  fs.writeFileSync(path.join(second, "f.txt"), "2")
  fs.symlinkSync(first, link)
  const store = new AccessStore(undefined, HOST)
  const view = viewFor(root, store)
  await createAccessPreflight({ store, view, approve: answering({ target: "folder", lifetime: "session" }).approve }).authorize(
    [{ path: path.join(link, "f.txt"), access: "read" }],
    "read_file"
  )
  assert.equal(view.resolve(path.join(link, "f.txt"), "file"), path.join(link, "f.txt"))
  fs.unlinkSync(link)
  fs.symlinkSync(second, link)
  assert.throws(() => view.resolve(path.join(link, "f.txt"), "file"), /outside the workspace/)
}))

test("a protected outside path is refused before any prompt, for every access", withDirs(async ({ root, outside }) => {
  const files = [path.join(outside, ".git", "config"), path.join(outside, "node_modules", "pkg", "index.js"), path.join(outside, "deploy.pem")]
  for (const file of files) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, "secret")
  }
  const store = new AccessStore(undefined, HOST)
  const view = new WorkspaceView(root, [], undefined, ["*.pem"], [], () => store.grants().map((grant: AccessGrant) => ({ root: grant.root, real: grant.real, scope: grant.scope })))
  const { prompts, approve } = answering({ target: "exact", lifetime: "always" })
  const preflight = createAccessPreflight({ store, view, approve })
  for (const file of files) {
    for (const access of ["read", "write"] as const) {
      const outcome = await preflight.authorize([{ path: file, access }], "read_file")
      assert.equal(outcome.ok, false, `${file} ${access}`)
    }
  }
  assert.match(refusalOf(await preflight.authorize([{ path: files[2], access: "read" }], "read_file")), /team's rules/)
  assert.match(refusalOf(await preflight.authorize([{ path: files[0], access: "read" }], "read_file")), /ignored/)
  assert.equal(prompts.length, 0)
  assert.deepEqual(store.grants(), [])
}))

test("an outside link into a protected path is refused before any prompt", withDirs(async ({ root, outside }) => {
  const config = path.join(outside, ".git", "config")
  fs.mkdirSync(path.dirname(config))
  fs.writeFileSync(config, "secret")
  const alias = path.join(outside, "alias.txt")
  fs.symlinkSync(config, alias)
  const store = new AccessStore(undefined, HOST)
  const { prompts, approve } = answering({ target: "exact", lifetime: "always" })
  const outcome = await createAccessPreflight({ store, view: viewFor(root, store), approve }).authorize([{ path: alias, access: "read" }], "read_file")
  assert.equal(outcome.ok, false)
  assert.equal(prompts.length, 0)
}))

test("a link inside a granted folder that leads out of it is refused before any prompt, and so is one retargeted out of it", withDirs(async ({ root, outside }) => {
  const granted = path.join(outside, "granted")
  const secret = path.join(outside, "secret")
  fs.mkdirSync(granted)
  fs.mkdirSync(secret)
  fs.writeFileSync(path.join(granted, "own.txt"), "own")
  fs.writeFileSync(path.join(secret, "f.txt"), "secret")
  const escape = path.join(granted, "escape.txt")
  fs.symlinkSync(path.join(secret, "f.txt"), escape)
  const inside = path.join(granted, "inside.txt")
  fs.symlinkSync(path.join(granted, "own.txt"), inside)
  const store = new AccessStore(undefined, HOST)
  const view = viewFor(root, store)
  const { prompts, approve } = answering({ target: "folder", lifetime: "session" })
  const preflight = createAccessPreflight({ store, view, approve })
  assert.equal((await preflight.authorize([{ path: path.join(granted, "own.txt"), access: "read" }], "read_file")).ok, true)
  assert.equal(prompts.length, 1)

  const leaving = await preflight.authorize([{ path: escape, access: "read" }], "read_file")
  assert.equal(leaving.ok, false)
  assert.match(refusalOf(leaving), /leads outside/)
  assert.equal(prompts.length, 1)

  assert.equal((await preflight.authorize([{ path: inside, access: "read" }], "read_file")).ok, true)
  fs.unlinkSync(inside)
  fs.symlinkSync(path.join(secret, "f.txt"), inside)
  const retargeted = await preflight.authorize([{ path: inside, access: "read" }], "read_file")
  assert.equal(retargeted.ok, false)
  assert.match(refusalOf(retargeted), /leads outside/)
  assert.equal(prompts.length, 1)
}))

test("a path in a granted folder that the folder's own rules keep is refused before any prompt", withDirs(async ({ root, outside }) => {
  const granted = path.join(outside, "granted")
  fs.mkdirSync(path.join(granted, "dist"), { recursive: true })
  fs.writeFileSync(path.join(granted, "dist", "bundle.js"), "x")
  fs.writeFileSync(path.join(granted, "own.txt"), "own")
  const store = new AccessStore(undefined, HOST)
  const view = new WorkspaceView(root, ["/dist"], undefined, [], [], () => store.grants().map((grant: AccessGrant) => ({ root: grant.root, real: grant.real, scope: grant.scope })))
  const { prompts, approve } = answering({ target: "folder", lifetime: "session" })
  const preflight = createAccessPreflight({ store, view, approve })
  assert.equal((await preflight.authorize([{ path: path.join(granted, "own.txt"), access: "read" }], "read_file")).ok, true)
  const outcome = await preflight.authorize([{ path: path.join(granted, "dist", "bundle.js"), access: "read" }], "read_file")
  assert.equal(outcome.ok, false)
  assert.match(refusalOf(outcome), /ignored/)
  assert.equal(prompts.length, 1)
}))

test("a prompt names the path and, when a link is involved, where it really leads", withDirs(async ({ root, outside }) => {
  const target = path.join(outside, "target.txt")
  const alias = path.join(outside, "alias.txt")
  fs.writeFileSync(target, "t")
  fs.symlinkSync(target, alias)
  const store = new AccessStore(undefined, HOST)
  const { prompts, approve } = answering({ target: "exact", lifetime: "once" })
  const preflight = createAccessPreflight({ store, view: viewFor(root, store), approve })
  await preflight.authorize([{ path: alias, access: "read" }], "read_file")
  await preflight.authorize([{ path: target, access: "read" }], "read_file")
  assert.equal(prompts[0].path, alias)
  assert.equal(prompts[0].real, fs.realpathSync(target))
  assert.equal(prompts[1].path, target)
  assert.equal(prompts[1].real, undefined)
}))
