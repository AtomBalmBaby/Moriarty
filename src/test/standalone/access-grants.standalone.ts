import * as assert from "node:assert"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import {
  accessAllows,
  accessHostKey,
  AccessStore,
  canonicalPath,
  GrantMemento,
  isFilesystemRoot,
  isWithin,
  makeGrant,
} from "../../extension/tools/access-grants"

const memento = (initial: Record<string, unknown> = {}): GrantMemento & { data: Record<string, unknown> } => {
  const data = { ...initial }
  return {
    data,
    get: <T>(key: string) => data[key] as T | undefined,
    update: async (key: string, value: unknown) => {
      data[key] = value
    },
  }
}

const withTemp = (run: (dir: string) => Promise<void> | void) => async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "access-grants-")))
  try {
    await run(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test("isWithin matches whole segments only", () => {
  assert.equal(isWithin("/a/b", "/a/b"), true)
  assert.equal(isWithin("/a/b", "/a/b/c/d"), true)
  assert.equal(isWithin("/a/b", "/a/bc"), false)
  assert.equal(isWithin("/a/b", "/a"), false)
  assert.equal(isWithin("/a/b", "/a/b/../x"), false)
})

test("filesystem roots are recognized", () => {
  assert.equal(isFilesystemRoot("/"), true)
  assert.equal(isFilesystemRoot("/tmp"), false)
})

test("write covers read; read never covers write", () => {
  const base = { root: "/x", real: "/x", scope: "file" as const, host: "h", lifetime: "once" as const }
  assert.equal(accessAllows({ ...base, access: "write" }, "read"), true)
  assert.equal(accessAllows({ ...base, access: "write" }, "write"), true)
  assert.equal(accessAllows({ ...base, access: "read" }, "read"), true)
  assert.equal(accessAllows({ ...base, access: "read" }, "write"), false)
})

test("a file grant covers only that file", withTemp(async (dir) => {
  const file = path.join(dir, "a.txt")
  const sibling = path.join(dir, "b.txt")
  fs.writeFileSync(file, "a")
  fs.writeFileSync(sibling, "b")
  const store = new AccessStore(undefined, "h")
  await store.add(makeGrant(file, "file", "read", "session", "h"))
  assert.ok(store.covering(file, "read"))
  assert.equal(store.covering(sibling, "read"), undefined)
}))

test("a folder grant covers the folder and below, not prefix siblings", withTemp(async (dir) => {
  const folder = path.join(dir, "proj")
  const inside = path.join(folder, "deep", "x.txt")
  const prefixSibling = path.join(dir, "proj-other", "y.txt")
  fs.mkdirSync(path.dirname(inside), { recursive: true })
  fs.mkdirSync(path.dirname(prefixSibling), { recursive: true })
  fs.writeFileSync(inside, "x")
  fs.writeFileSync(prefixSibling, "y")
  const store = new AccessStore(undefined, "h")
  await store.add(makeGrant(folder, "folder", "read", "session", "h"))
  assert.ok(store.covering(inside, "read"))
  assert.equal(store.covering(prefixSibling, "read"), undefined)
}))

test("a read grant does not authorize writes", withTemp(async (dir) => {
  const file = path.join(dir, "a.txt")
  fs.writeFileSync(file, "a")
  const store = new AccessStore(undefined, "h")
  await store.add(makeGrant(file, "file", "read", "session", "h"))
  assert.equal(store.covering(file, "write"), undefined)
}))

test("a write grant covers reads of the same path", withTemp(async (dir) => {
  const file = path.join(dir, "a.txt")
  fs.writeFileSync(file, "a")
  const store = new AccessStore(undefined, "h")
  await store.add(makeGrant(file, "file", "write", "session", "h"))
  assert.ok(store.covering(file, "read"))
  assert.ok(store.covering(file, "write"))
}))

test("once grants last until endCall", withTemp(async (dir) => {
  const file = path.join(dir, "a.txt")
  fs.writeFileSync(file, "a")
  const store = new AccessStore(undefined, "h")
  await store.add(makeGrant(file, "file", "read", "once", "h"))
  assert.ok(store.covering(file, "read"))
  store.endCall()
  assert.equal(store.covering(file, "read"), undefined)
}))

test("session grants survive endCall but are not persisted", withTemp(async (dir) => {
  const file = path.join(dir, "a.txt")
  fs.writeFileSync(file, "a")
  const mem = memento()
  const store = new AccessStore(mem, "h")
  await store.add(makeGrant(file, "file", "read", "session", "h"))
  store.endCall()
  assert.ok(store.covering(file, "read"))
  assert.equal(mem.data["alwaysAllowedFileAccess"], undefined)
  assert.equal(new AccessStore(mem, "h").covering(file, "read"), undefined)
}))

test("always grants persist through the memento and reload", withTemp(async (dir) => {
  const file = path.join(dir, "a.txt")
  fs.writeFileSync(file, "a")
  const mem = memento()
  await new AccessStore(mem, "h").add(makeGrant(file, "file", "read", "always", "h"))
  const reloaded = new AccessStore(mem, "h")
  assert.ok(reloaded.covering(file, "read"))
  assert.equal(reloaded.always().length, 1)
}))

test("always grants are host-scoped", withTemp(async (dir) => {
  const file = path.join(dir, "a.txt")
  fs.writeFileSync(file, "a")
  const mem = memento()
  await new AccessStore(mem, "local").add(makeGrant(file, "file", "read", "always", "local"))
  const remote = new AccessStore(mem, "ssh")
  assert.equal(remote.covering(file, "read"), undefined)
  assert.equal(remote.always().length, 0)
}))

test("the host key separates servers that share a remote kind, machine id or hostname", () => {
  const alpha = { remoteName: "ssh-remote", authority: "ssh-remote+alpha", machineId: "m-1", hostname: "alpha" }
  const key = accessHostKey(alpha)
  assert.equal(accessHostKey({ ...alpha }), key)
  assert.notEqual(accessHostKey({ ...alpha, authority: "ssh-remote+beta" }), key)
  assert.notEqual(accessHostKey({ ...alpha, machineId: "m-2" }), key)
  assert.notEqual(accessHostKey({ ...alpha, hostname: "beta" }), key)
  assert.notEqual(accessHostKey({ machineId: "m-1", hostname: "alpha" }), key, "local is not a remote")
  assert.notEqual(accessHostKey({ ...alpha, remoteName: "dev-container" }), key)
})

test("always grants made under one host key are not visible under another with the same remote kind", withTemp(async (dir) => {
  const file = path.join(dir, "a.txt")
  fs.writeFileSync(file, "a")
  const mem = memento()
  const alpha = accessHostKey({ remoteName: "ssh-remote", authority: "ssh-remote+alpha", machineId: "m-1", hostname: "alpha" })
  const beta = accessHostKey({ remoteName: "ssh-remote", authority: "ssh-remote+beta", machineId: "m-1", hostname: "alpha" })
  await new AccessStore(mem, alpha).add(makeGrant(file, "file", "read", "always", alpha))
  assert.ok(new AccessStore(mem, alpha).covering(file, "read"))
  assert.equal(new AccessStore(mem, beta).covering(file, "read"), undefined)
}))

test("revoke removes matching always grants for this host only", withTemp(async (dir) => {
  const file = path.join(dir, "a.txt")
  fs.writeFileSync(file, "a")
  const mem = memento()
  await new AccessStore(mem, "local").add(makeGrant(file, "file", "read", "always", "local"))
  await new AccessStore(mem, "ssh").add(makeGrant(file, "file", "read", "always", "ssh"))
  const local = new AccessStore(mem, "local")
  assert.equal(await local.revoke(() => true), 1)
  assert.equal(new AccessStore(mem, "local").covering(file, "read"), undefined)
  assert.ok(new AccessStore(mem, "ssh").covering(file, "read"))
}))

test("a grant does not apply once the path is retargeted by a link", withTemp(async (dir) => {
  const target = path.join(dir, "real-target")
  const link = path.join(dir, "link")
  const other = path.join(dir, "other-target")
  fs.mkdirSync(target)
  fs.mkdirSync(other)
  fs.writeFileSync(path.join(target, "f.txt"), "t")
  fs.writeFileSync(path.join(other, "f.txt"), "o")
  fs.symlinkSync(target, link)
  const store = new AccessStore(undefined, "h")
  await store.add(makeGrant(link, "folder", "read", "session", "h"))
  assert.ok(store.covering(path.join(link, "f.txt"), "read"))
  fs.unlinkSync(link)
  fs.symlinkSync(other, link)
  assert.equal(store.covering(path.join(link, "f.txt"), "read"), undefined)
}))

test("canonicalPath resolves the existing part of a new path", withTemp(async (dir) => {
  const real = path.join(dir, "folder")
  fs.mkdirSync(real)
  const link = path.join(dir, "alias")
  fs.symlinkSync(real, link)
  assert.equal(canonicalPath(path.join(link, "new.txt")), path.join(real, "new.txt"))
}))
