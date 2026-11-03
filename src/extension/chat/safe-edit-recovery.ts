import { createHash } from "node:crypto"

export type CheckpointText = string | null

export interface CheckpointFile {
  path: string
  before: CheckpointText
  expectedHash?: string
}

export interface CheckpointAdapter {
  read(path: string): Promise<CheckpointText | undefined>
  restore(files: CheckpointFile[]): Promise<boolean>
  persist(files: CheckpointFile[]): Promise<void>
  clear(): Promise<void>
}

export const checkpointHash = (text: CheckpointText): string =>
  text === null ? "missing" : createHash("sha256").update(text).digest("hex")

export const MAX_CHECKPOINT_FILES = 32
export const MAX_CHECKPOINT_BYTES = 5 * 1024 * 1024
const MAX_FILE_BYTES = 1024 * 1024

export class SafeEditCheckpoints {
  private readonly _files = new Map<string, CheckpointFile>()
  private _bytes = 0

  constructor(private readonly _adapter: CheckpointAdapter) {}

  async capture(paths: string[]): Promise<void> {
    for (const path of [...new Set(paths)]) {
      if (this._files.has(path)) continue
      if (this._files.size >= MAX_CHECKPOINT_FILES) throw new Error("Safe edit checkpoint limit reached; refusing further workspace changes.")
      const before = await this._adapter.read(path)
      if (before === undefined) throw new Error(`Cannot safely checkpoint ${path}; refusing the workspace change.`)
      const bytes = before === null ? 0 : Buffer.byteLength(before, "utf8")
      if (bytes > MAX_FILE_BYTES || this._bytes + bytes > MAX_CHECKPOINT_BYTES) {
        throw new Error(`Safe edit checkpoint storage limit reached for ${path}; refusing the workspace change.`)
      }
      this._bytes += bytes
      this._files.set(path, { path, before, expectedHash: checkpointHash(before) })
    }
    await this.persist()
  }

  async commit(paths: string[]): Promise<void> {
    for (const path of [...new Set(paths)]) {
      const checkpoint = this._files.get(path)
      if (!checkpoint) continue
      const current = await this._adapter.read(path)
      if (current === undefined) continue
      const previousBytes = checkpoint.before === null ? 0 : Buffer.byteLength(checkpoint.before, "utf8")
      const currentBytes = current === null ? 0 : Buffer.byteLength(current, "utf8")
      const nextBytes = this._bytes - previousBytes + currentBytes
      if (currentBytes > MAX_FILE_BYTES || nextBytes > MAX_CHECKPOINT_BYTES) continue
      this._bytes = nextBytes
      checkpoint.before = current
      checkpoint.expectedHash = checkpointHash(current)
    }
    await this.persist()
  }

  async markChanged(paths: string[]): Promise<void> {
    for (const path of [...new Set(paths)]) {
      const checkpoint = this._files.get(path)
      if (!checkpoint) continue
      const current = await this._adapter.read(path)
      if (current !== undefined) checkpoint.expectedHash = checkpointHash(current)
    }
    await this.persist()
  }

  async rollback(): Promise<{ restored: boolean; reason?: string }> {
    const files = [...this._files.values()]
    if (!files.length) return { restored: false, reason: "No safe file checkpoint is available." }
    for (const file of files) {
      if (file.expectedHash === undefined) return { restored: false, reason: `The current version of ${file.path} was not recorded after the agent operation.` }
      const current = await this._adapter.read(file.path)
      if (current === undefined || checkpointHash(current) !== file.expectedHash) {
        return { restored: false, reason: `${file.path} changed after the agent operation; rollback would overwrite a concurrent edit.` }
      }
    }
    if (!(await this._adapter.restore(files))) return { restored: false, reason: "The editor refused to restore the safe checkpoint." }
    for (const file of files) {
      const restored = await this._adapter.read(file.path)
      if (restored !== file.before) return { restored: false, reason: `Checkpoint verification failed for ${file.path}.` }
    }
    await this._adapter.clear()
    this._files.clear()
    this._bytes = 0
    return { restored: true }
  }

  async clear(): Promise<void> {
    await this._adapter.clear()
    this._files.clear()
    this._bytes = 0
  }

  private persist(): Promise<void> {
    return this._adapter.persist([...this._files.values()].map((file) => ({ ...file })))
  }
}

export class DiagnosticRegressionMonitor {
  private readonly _totals = new Map<string, number>()

  constructor(
    readonly errorSpikeThreshold = 20,
    readonly cumulativeErrorThreshold = 40
  ) {}

  record(file: string, introducedErrors: number): boolean {
    const total = (this._totals.get(file) ?? 0) + introducedErrors
    this._totals.set(file, total)
    return introducedErrors >= this.errorSpikeThreshold || (introducedErrors >= 8 && total >= this.cumulativeErrorThreshold)
  }
}
