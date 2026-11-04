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

test("significant recovery verifies restored contents and matching diagnostics independently", async () => {
  const adapter = new MemoryAdapter()
  adapter.files.set("panel.tsx", "safe source\n")
  const checkpoints = new SafeEditCheckpoints(adapter)
  await checkpoints.capture(["panel.tsx"])
  adapter.files.set("panel.tsx", "unsafe source\n")
  await checkpoints.markChanged(["panel.tsx"])
  const result = await recoverSignificantEdit({
    file: "panel.tsx", introducedErrors: 20, diagnosticsObserved: true, diagnosticCheckAvailable: true, baseline: ["baseline error"], checkpoints,
    monitor: new DiagnosticRegressionMonitor(),
    observeRestoredDiagnostics: async () => ({ errors: ["baseline error"], version: 3 })
  })
  assert.equal(adapter.files.get("panel.tsx"), "safe source\n")
  assert.equal(result?.restored, true)
  assert.equal(result?.fileVerified, true)
  assert.equal(result?.diagnosticsVerified, true)
  assert.equal(result?.diagnosticsStatus, "verified")
})

test("diagnostic verification reports baseline mismatch and remaining diagnostics explicitly", () => {
  assert.equal(verifyDiagnosticBaseline(["baseline"], { errors: ["baseline"], version: 4 }).verified, true)
  assert.equal(verifyDiagnosticBaseline(["baseline"], { errors: [], version: 4 }).status, "baseline-mismatch")
  const remaining = verifyDiagnosticBaseline([], { errors: ["unexpected"], version: 4 })
  assert.equal(remaining.status, "remaining-diagnostics")
  assert.match(remaining.evidence, /unexpected/)
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
  const tools = workspaceTools(root, [], { edits: sink, git: false, instructions: false })
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

test("real edit_file dispatch allows temporary small errors and restores content independently of diagnostic verification", async () => {
  const root = temporaryWorkspace()
  const file = path.join(root, "panel.tsx")
  const initial = "const value = 0\n"
  fs.writeFileSync(file, initial)
  const checkpoints = diskCheckpoints()
  const monitor = new DiagnosticRegressionMonitor(20, 40)
  const errors = [2, 1, 0, 20]
  let blocked = false
  const recoveries: Array<NonNullable<Awaited<ReturnType<typeof recoverSignificantEdit>>>> = []
  const sink = {
    mode: "apply" as const,
    async edit(target: string, replacement: { original: string; text: string }) {
      await checkpoints.capture([target])
      const before = fs.readFileSync(target, "utf8")
      fs.writeFileSync(target, before.replace(replacement.original, replacement.text))
      await checkpoints.markChanged([target])
      const introducedErrors = errors.shift() ?? 0
      const recovery = await recoverSignificantEdit({
        file: target,
        introducedErrors,
        diagnosticsObserved: true,
        diagnosticCheckAvailable: true,
        baseline: [],
        checkpoints,
        monitor,
        blockMutations: () => { blocked = true },
        observeRestoredDiagnostics: async () => ({ status: "timeout", errors: [], version: 5, reason: "No diagnostics arrived after restore." })
      })
      if (recovery) {
        recoveries.push(recovery)
        return { ok: false, message: recovery.reason }
      }
      if (introducedErrors === 0) await checkpoints.commit([target])
      return { ok: true, message: "applied", newErrors: introducedErrors }
    },
    async create() { return { ok: true, message: "created" } }
  }
  const tools = workspaceTools(root, [], { edits: sink, git: false, instructions: false })
  try {
    for (let value = 1; value <= 3; value++) {
      const current = fs.readFileSync(file, "utf8").trim()
      const result = await tools.run({ name: "edit_file", args: { path: "panel.tsx", find: current, replace: "const value = " + value } })
      assert.equal(result.failed, undefined)
      assert.equal(recoveries.length, 0)
    }
    const current = fs.readFileSync(file, "utf8").trim()
    const unsafe = await tools.run({ name: "edit_file", args: { path: "panel.tsx", find: current, replace: "const value = 4" } })
    assert.equal(unsafe.failed, true)
    assert.equal(blocked, true)
    assert.equal(fs.readFileSync(file, "utf8"), "const value = 3\n")
    const recovery = recoveries[0]
    assert.ok(recovery)
    assert.equal(recovery.fileVerified, true)
    assert.equal(recovery.diagnosticsVerified, false)
    assert.equal(recovery.diagnosticsStatus, "timeout")
    assert.match(recovery.reason, /Restored and verified file contents/)
    assert.match(recovery.diagnosticEvidence, /No diagnostics arrived after restore/)
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
    file: "panel.tsx", introducedErrors: 20, diagnosticsObserved: true, diagnosticCheckAvailable: true, baseline: [], checkpoints,
    monitor: new DiagnosticRegressionMonitor(),
    observeRestoredDiagnostics: async () => ({ errors: [], version: 2 })
  })
  assert.equal(result?.fileVerified, false)
  assert.match(result?.reason ?? "", /concurrent edit/)
  assert.equal(adapter.files.get("panel.tsx"), "agent change\n")
})
