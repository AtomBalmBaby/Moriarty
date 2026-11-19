import assert from "assert"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import test from "node:test"

import {
  CheckpointAdapter,
  CheckpointFile,
  createDiagnosticObserver,
  DiagnosticRegressionMonitor,
  recoverSignificantEdit,
  SafeEditCheckpoints,
  verifyDiagnosticBaseline
} from "../../extension/chat/safe-edit-recovery"
import { workspaceTools } from "../../extension/tools/workspace"

class MemoryAdapter implements CheckpointAdapter {
  readonly files = new Map<string, string>()
  stored: CheckpointFile[] = []
  userModified = false

  async read(path: string): Promise<string | null | undefined> {
    if (this.userModified && path === "panel.tsx") return "concurrent user edit"
    return this.files.get(path) ?? null
  }

  async restore(files: CheckpointFile[]): Promise<boolean> {
    for (const file of files) {
      if (file.before === null) this.files.delete(file.path)
      else this.files.set(file.path, file.before)
    }
    return true
  }

  async persist(files: CheckpointFile[]): Promise<void> {
    this.stored = files
  }

  async clear(): Promise<void> {
    this.stored = []
  }
}

test("multi-file edit checkpoints restore exact source after a catastrophic regression", async () => {
  const adapter = new MemoryAdapter()
  adapter.files.set("panel.tsx", "valid TSX\n")
  adapter.files.set("panel.css", "valid CSS\n")
  const checkpoints = new SafeEditCheckpoints(adapter)
  await checkpoints.capture(["panel.tsx", "panel.css"])
  adapter.files.set("panel.tsx", "broken TSX\n")
  adapter.files.set("panel.css", "broken CSS\n")
  await checkpoints.markChanged(["panel.tsx", "panel.css"])
  assert.equal(adapter.stored.length, 2)
  assert.deepEqual(await checkpoints.rollback(), { restored: true, contentVerified: true })
  assert.equal(adapter.files.get("panel.tsx"), "valid TSX\n")
  assert.equal(adapter.files.get("panel.css"), "valid CSS\n")
  assert.deepEqual(adapter.stored, [])
})

test("rollback refuses to overwrite a concurrent user edit", async () => {
  const adapter = new MemoryAdapter()
  adapter.files.set("panel.tsx", "valid\n")
  const checkpoints = new SafeEditCheckpoints(adapter)
  await checkpoints.capture(["panel.tsx"])
  adapter.files.set("panel.tsx", "agent edit\n")
  await checkpoints.markChanged(["panel.tsx"])
  adapter.userModified = true
  const result = await checkpoints.rollback()
  assert.equal(result.restored, false)
  assert.match(result.reason ?? "", /concurrent edit/)
  assert.equal(adapter.files.get("panel.tsx"), "agent edit\n")
})

test("unknown, oversized, and missing checkpoint capacity rejects the mutation", async () => {
  const adapter = new MemoryAdapter()
  const checkpoints = new SafeEditCheckpoints(adapter)
  adapter.read = async () => undefined
  await assert.rejects(checkpoints.capture(["unreadable"]), /Cannot safely checkpoint/)
})

test("newly created files are removed by a safe rollback", async () => {
  const adapter = new MemoryAdapter()
  const checkpoints = new SafeEditCheckpoints(adapter)
  await checkpoints.capture(["created.ts"])
  adapter.files.set("created.ts", "generated\n")
  await checkpoints.markChanged(["created.ts"])
  assert.equal((await checkpoints.rollback()).restored, true)
  assert.equal(adapter.files.has("created.ts"), false)
})

test("diagnostic escalation catches a large spike but ignores harmless transient errors", () => {
  const monitor = new DiagnosticRegressionMonitor(20, 40)
  assert.equal(monitor.record("panel.tsx", 1), false)
  assert.equal(monitor.record("panel.tsx", 2), false)
  assert.equal(monitor.record("panel.tsx", 10), false)
  assert.equal(monitor.record("panel.tsx", 167), true)
})

const temporaryWorkspace = () => fs.mkdtempSync(path.join(os.tmpdir(), "twinny-safe-edit-"))

const diskCheckpoints = () => {
  const stored = new Map<string, CheckpointFile[]>()
  const adapter: CheckpointAdapter = {
    async read(file) {
      return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null
    },
    async restore(files) {
      for (const file of files) {
        if (file.before === null) fs.rmSync(file.path, { force: true })
        else fs.writeFileSync(file.path, file.before)
      }
      return true
    },
    async persist(files) { stored.set("active", files) },
    async clear() { stored.clear() }
  }
  return new SafeEditCheckpoints(adapter)
}

test("diagnostic observer waits for delayed events from the expected document version", async () => {
  let version = 1
  let errors: string[] = []
  const listeners = new Set<() => void>()
  const observer = createDiagnosticObserver({
    currentVersion: () => version,
    errors: () => errors,
    onChange: (listener) => { listeners.add(listener); return { dispose: () => listeners.delete(listener) } }
  }, 5, 100)
  const pending = observer.wait(2, true)
  setTimeout(() => { version = 2; errors = ["new error"]; listeners.forEach((listener) => listener()) }, 10)
  const result = await pending
  observer.dispose()
  assert.ok(!("status" in result))
  assert.equal(result.version, 2)
  assert.deepEqual(result.errors, ["new error"])
})

test("diagnostic observer distinguishes stale events, version changes, and timeouts", async () => {
  let version = 1
  const listeners = new Set<() => void>()
  const source = {
    currentVersion: () => version,
    errors: () => ["old error"],
    onChange: (listener: () => void) => { listeners.add(listener); return { dispose: () => listeners.delete(listener) } }
  }
  const staleObserver = createDiagnosticObserver(source, 5, 40)
  const stalePending = staleObserver.wait(2, true)
  listeners.forEach((listener) => listener())
  version = 2
  const stale = await stalePending
  staleObserver.dispose()
  assert.ok("status" in stale)
  if ("status" in stale) assert.equal(stale.status, "stale")

  const changedObserver = createDiagnosticObserver(source, 15, 60)
  const changedPending = changedObserver.wait(2, true)
  version = 2
  listeners.forEach((listener) => listener())
  setTimeout(() => { version = 3 }, 2)
  const changed = await changedPending
  changedObserver.dispose()
  assert.ok("status" in changed)
  if ("status" in changed) assert.equal(changed.status, "version-changed")

  version = 3
  const timeoutObserver = createDiagnosticObserver(source, 5, 10)
  const timeout = await timeoutObserver.wait(3, true)
  timeoutObserver.dispose()
  assert.ok("status" in timeout)
  if ("status" in timeout) assert.equal(timeout.status, "timeout")
})

test("restored 4-diagnostic checkpoint settles by content hash despite 0 restored diagnostics", async () => {
  const adapter = new MemoryAdapter()
  adapter.files.set("panel.tsx", "safe source\n")
  const checkpoints = new SafeEditCheckpoints(adapter)
  await checkpoints.capture(["panel.tsx"])
  adapter.files.set("panel.tsx", "unsafe source\n")
  await checkpoints.markChanged(["panel.tsx"])
  let blocked = false
  const result = await recoverSignificantEdit({
    file: "panel.tsx", introducedErrors: 20, diagnosticsObserved: true, diagnosticCheckAvailable: true,
    rollbackRequested: true,
    baseline: ["baseline error 1", "baseline error 2", "baseline error 3", "baseline error 4"], checkpoints,
    blockMutations: () => { blocked = true },
    clearMutations: () => { blocked = false },
    observeRestoredDiagnostics: async () => ({ errors: [], version: 3 })
  })
  assert.equal(adapter.files.get("panel.tsx"), "safe source\n")
  assert.equal(result?.restored, true)
  assert.equal(result?.fileVerified, true)
  assert.equal(result?.diagnosticsVerified, false)
  assert.equal(result?.diagnosticsStatus, "baseline-mismatch")
  assert.equal(blocked, false)
  assert.match(result?.reason ?? "", /authoritative safe checkpoint by content hash/)
  assert.match(result?.reason ?? "", /4 expected, 0 observed/)
})

test("diagnostic verification reports baseline mismatch and remaining diagnostics explicitly", () => {
  assert.equal(verifyDiagnosticBaseline(["baseline"], { errors: ["baseline"], version: 4 }).verified, true)
  assert.equal(verifyDiagnosticBaseline(["baseline"], { errors: [], version: 4 }).status, "baseline-mismatch")
  const remaining = verifyDiagnosticBaseline([], { errors: ["unexpected"], version: 4 })
  assert.equal(remaining.status, "remaining-diagnostics")
  assert.match(remaining.evidence, /unexpected/)
})

test("diagnostics alone do not trigger checkpoint rollback", async () => {
  const adapter = new MemoryAdapter()
  adapter.files.set("panel.tsx", "safe source\n")
  const checkpoints = new SafeEditCheckpoints(adapter)
  await checkpoints.capture(["panel.tsx"])
  adapter.files.set("panel.tsx", "agent source\n")
  await checkpoints.markChanged(["panel.tsx"])
  const result = await recoverSignificantEdit({
    file: "panel.tsx",
    introducedErrors: 20,
    diagnosticsObserved: true,
    diagnosticCheckAvailable: true,
    baseline: [],
    checkpoints,
    monitor: new DiagnosticRegressionMonitor()
  })
  assert.equal(result, undefined)
  assert.equal(adapter.files.get("panel.tsx"), "agent source\n")
})

test("ordinary successive edit diagnostics reset when the intermediate regression is fixed", () => {
  const monitor = new DiagnosticRegressionMonitor(20, 40)
  assert.equal(monitor.record("panel.tsx", 2), false)
  assert.equal(monitor.record("panel.tsx", 1), false)
  assert.equal(monitor.record("panel.tsx", 0), false)
  assert.equal(monitor.record("panel.tsx", 2), false)
  assert.equal(monitor.record("panel.tsx", 8), false)
  assert.equal(monitor.record("panel.tsx", 8), false)
  assert.equal(monitor.record("panel.tsx", 8), false)
  assert.equal(monitor.record("panel.tsx", 8), false)
  assert.equal(monitor.record("panel.tsx", 8), true)
})

test("edit_file dispatch still refuses clipped replacements while read_file returns complete long lines", async () => {
  const root = temporaryWorkspace()
  const file = path.join(root, "panel.tsx")
  const longLine = "const untouched = " + "x".repeat(300)
  fs.writeFileSync(file, "const before = 1\n" + longLine + "\n")
  let edits = 0
  let planned = ""
  const sink = {
    mode: "apply" as const,
    async edit(_file: string, replacement: { text: string }) { edits++; planned = replacement.text; return { ok: true, message: "applied" } },
    async create() { return { ok: true, message: "created" } }
  }
  const tools = workspaceTools(root, [], { legacyEditFile: true, edits: sink, git: false, instructions: false })
  try {
    const read = await tools.run({ name: "read_file", args: { path: "panel.tsx" } })
    assert.ok(read.output.includes("2: " + longLine))
    assert.ok(!read.output.includes("…"))
    const abbreviated = "2: " + longLine.slice(0, 200) + "…"
    const refused = await tools.run({ name: "edit_file", args: { path: "panel.tsx", find: "const before = 1", replace: abbreviated } })
    assert.equal(refused.failed, true)
    assert.match(refused.output, /replace has a line cut short with …/)
    assert.equal(edits, 0)

    const exact = await tools.run({ name: "read_file", args: { path: "panel.tsx", start_line: "2", full_line: "true" } })
    assert.match(exact.output, new RegExp(longLine))
    const accepted = await tools.run({ name: "edit_file", args: { path: "panel.tsx", find: longLine, replace: longLine.replace("untouched", "updated") } })
    assert.equal(accepted.failed, undefined)
    assert.equal(edits, 1)
    assert.match(planned, /const updated =/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("real edit_file dispatch keeps small and spike diagnostics as post-edit observations", async () => {
  const root = temporaryWorkspace()
  const file = path.join(root, "panel.tsx")
  const initial = "const value = 0\n"
  fs.writeFileSync(file, initial)
  const checkpoints = diskCheckpoints()
  const errors = [2, 1, 0, 20]
  const sink = {
    mode: "apply" as const,
    async edit(target: string, replacement: { original: string; text: string }) {
      await checkpoints.capture([target])
      const before = fs.readFileSync(target, "utf8")
      fs.writeFileSync(target, before.replace(replacement.original, replacement.text))
      await checkpoints.markChanged([target])
      const introducedErrors = errors.shift() ?? 0
      if (introducedErrors === 0) await checkpoints.commit([target])
      return { ok: true, message: "applied; diagnostics: " + introducedErrors }
    },
    async create() { return { ok: true, message: "created" } }
  }
  const tools = workspaceTools(root, [], { legacyEditFile: true, edits: sink, git: false, instructions: false })
  try {
    for (let value = 1; value <= 3; value++) {
      const current = fs.readFileSync(file, "utf8").trim()
      const result = await tools.run({ name: "edit_file", args: { path: "panel.tsx", find: current, replace: "const value = " + value } })
      assert.equal(result.failed, undefined)
    }
    const current = fs.readFileSync(file, "utf8").trim()
    const unsafe = await tools.run({ name: "edit_file", args: { path: "panel.tsx", find: current, replace: "const value = 4" } })
    assert.equal(unsafe.failed, undefined)
    assert.equal(fs.readFileSync(file, "utf8"), "const value = 4\n")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("unsafe catastrophic recovery preserves a concurrent edit and reports content failure", async () => {
  const adapter = new MemoryAdapter()
  adapter.files.set("panel.tsx", "baseline\n")
  const checkpoints = new SafeEditCheckpoints(adapter)
  await checkpoints.capture(["panel.tsx"])
  adapter.files.set("panel.tsx", "agent change\n")
  await checkpoints.markChanged(["panel.tsx"])
  adapter.userModified = true
  const result = await recoverSignificantEdit({
    file: "panel.tsx", introducedErrors: 20, diagnosticsObserved: true, diagnosticCheckAvailable: true, rollbackRequested: true, baseline: [], checkpoints,
    monitor: new DiagnosticRegressionMonitor(),
    blockMutations: () => {},
    observeRestoredDiagnostics: async () => ({ errors: [], version: 2 })
  })
  assert.equal(result?.fileVerified, false)
  assert.match(result?.reason ?? "", /concurrent edit/)
  assert.match(result?.reason ?? "", /Expected content hash/)
  assert.match(result?.reason ?? "", /observed/)
  assert.equal(adapter.files.get("panel.tsx"), "agent change\n")
})

test("a scoped rollback restores only the affected file and keeps other checkpoints", async () => {
  const adapter = new MemoryAdapter()
  adapter.files.set("a.ts", "a before\n")
  adapter.files.set("b.ts", "b before\n")
  const checkpoints = new SafeEditCheckpoints(adapter)
  await checkpoints.capture(["a.ts", "b.ts"])
  adapter.files.set("a.ts", "a broken\n")
  adapter.files.set("b.ts", "b verified\n")
  await checkpoints.markChanged(["a.ts", "b.ts"])
  assert.deepEqual(await checkpoints.rollback(["a.ts"]), { restored: true, contentVerified: true })
  assert.equal(adapter.files.get("a.ts"), "a before\n")
  assert.equal(adapter.files.get("b.ts"), "b verified\n")
  adapter.files.set("b.ts", "b broken\n")
  await checkpoints.markChanged(["b.ts"])
  assert.equal((await checkpoints.rollback(["b.ts"])).restored, true)
  assert.equal(adapter.files.get("b.ts"), "b before\n")
})

const preparedRecovery = async (options: { restore?: boolean; diagnostics?: { errors: string[]; version?: number } | { status: "timeout"; errors: string[]; reason: string } } = {}) => {
  const adapter = new MemoryAdapter()
  adapter.files.set("panel.tsx", "baseline\n")
  const checkpoints = new SafeEditCheckpoints(adapter)
  await checkpoints.capture(["panel.tsx"])
  adapter.files.set("panel.tsx", "agent change\n")
  await checkpoints.markChanged(["panel.tsx"])
  if (options.restore === false) adapter.restore = async () => false
  let blocked = false
  const result = await recoverSignificantEdit({
    file: "panel.tsx", introducedErrors: 20, diagnosticsObserved: true, diagnosticCheckAvailable: true, rollbackRequested: true, baseline: [], checkpoints,
    monitor: new DiagnosticRegressionMonitor(),
    blockMutations: () => { blocked = true },
    clearMutations: () => { blocked = false },
    observeRestoredDiagnostics: async () => options.diagnostics ?? { errors: [], version: 2 }
  })
  return { adapter, result, blocked }
}

test("verified restore with matching diagnostics does not lock further mutations", async () => {
  const { adapter, result, blocked } = await preparedRecovery()
  assert.equal(result?.fileVerified, true)
  assert.equal(result?.diagnosticsVerified, true)
  assert.equal(blocked, false)
  assert.equal(adapter.files.get("panel.tsx"), "baseline\n")
})

test("refused restore keeps further mutations locked", async () => {
  const { result, blocked } = await preparedRecovery({ restore: false })
  assert.equal(result?.fileVerified, false)
  assert.equal(blocked, true)
})

test("verified restore with timeout diagnostics settles content without locking mutations", async () => {
  const { result, blocked } = await preparedRecovery({ diagnostics: { status: "timeout", errors: [], reason: "No diagnostics arrived after restore." } })
  assert.equal(result?.fileVerified, true)
  assert.equal(result?.diagnosticsVerified, false)
  assert.equal(blocked, false)
  assert.match(result?.reason ?? "", /not file-integrity evidence/)
})

test("a throwing rollback is reported as failed and keeps further mutations locked", async () => {
  let blocked = false
  const checkpoints = { rollback: async () => { throw new Error("disk unavailable") } } as unknown as SafeEditCheckpoints
  const result = await recoverSignificantEdit({
    file: "panel.tsx", introducedErrors: 20, diagnosticsObserved: true, diagnosticCheckAvailable: true, rollbackRequested: true, baseline: [], checkpoints,
    monitor: new DiagnosticRegressionMonitor(),
    blockMutations: () => { blocked = true }
  })
  assert.equal(result?.fileVerified, false)
  assert.match(result?.reason ?? "", /Rollback failed: disk unavailable/)
  assert.equal(blocked, true)
})
