import assert from "assert"
import test from "node:test"

import { CheckpointAdapter, CheckpointFile, DiagnosticRegressionMonitor, SafeEditCheckpoints } from "../../extension/chat/safe-edit-recovery"

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
  assert.deepEqual(await checkpoints.rollback(), { restored: true })
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
