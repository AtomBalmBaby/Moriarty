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

export type DiagnosticVerificationStatus =
  | "verified"
  | "baseline-mismatch"
  | "remaining-diagnostics"
  | "timeout"
  | "stale"
  | "version-changed"
  | "unavailable"

export interface DiagnosticObservation {
  status: Exclude<DiagnosticVerificationStatus, "verified" | "baseline-mismatch" | "remaining-diagnostics">
  errors: string[]
  version?: number
  reason: string
}

export interface DiagnosticVerification {
  status: DiagnosticVerificationStatus
  verified: boolean
  reason: string
  evidence: string
}

export interface DiagnosticWatchSource {
  currentVersion(): number | undefined
  errors(): string[]
  onChange(listener: () => void): { dispose(): void }
}

export const createDiagnosticObserver = (
  source: DiagnosticWatchSource,
  quietMs: number,
  maxWaitMs: number
): { wait(expectedVersion: number, requireEvent?: boolean): Promise<DiagnosticObservation | { errors: string[]; version: number }>; dispose(): void } => {
  let eventSeen = false
  let eventVersion: number | undefined
  let expectedVersion: number | undefined
  let waiting: ((observation: DiagnosticObservation | { errors: string[]; version: number }) => void) | undefined
  let quiet: NodeJS.Timeout | undefined
  let timeout: NodeJS.Timeout | undefined
  const complete = (expectedVersion: number, requireEvent: boolean) => {
    if (!waiting) return
    clearTimeout(quiet)
    clearTimeout(timeout)
    const resolve = waiting
    waiting = undefined
    const version = source.currentVersion()
    if (version === undefined) {
      resolve({ status: "unavailable", errors: source.errors(), reason: "The editor document is no longer available." })
    } else if (version !== expectedVersion) {
      resolve({ status: "version-changed", version, errors: source.errors(), reason: "The document version changed while diagnostics were settling (expected " + expectedVersion + ", observed " + version + ")." })
    } else if (requireEvent && !eventSeen) {
      resolve({ status: "timeout", version, errors: source.errors(), reason: "No diagnostic update arrived for document version " + version + " within " + maxWaitMs + "ms." })
    } else if (requireEvent && eventVersion !== expectedVersion) {
      resolve({ status: "stale", version, errors: source.errors(), reason: "The latest diagnostic update was observed at document version " + (eventVersion ?? "unknown") + ", not the restored or edited version " + expectedVersion + "." })
    } else {
      resolve({ version, errors: source.errors() })
    }
  }
  const listener = source.onChange(() => {
    eventSeen = true
    eventVersion = source.currentVersion()
    if (waiting) {
      clearTimeout(quiet)
      quiet = setTimeout(() => complete(expectedVersion ?? -1, true), quietMs)
    }
  })
  return {
    wait(expectedVersionArg, requireEvent = true) {
      if (waiting) throw new Error("A diagnostic observer can only wait for one snapshot.")
      return new Promise((resolve) => {
        waiting = resolve
        expectedVersion = expectedVersionArg
        timeout = setTimeout(() => complete(expectedVersionArg, requireEvent), maxWaitMs)
        if (eventSeen) quiet = setTimeout(() => complete(expectedVersionArg, requireEvent), quietMs)
        else if (!requireEvent) quiet = setTimeout(() => complete(expectedVersionArg, false), quietMs)
      })
    },
    dispose() {
      listener.dispose()
      clearTimeout(quiet)
      clearTimeout(timeout)
      if (waiting) {
        const resolve = waiting
        waiting = undefined
        resolve({ status: "unavailable", errors: source.errors(), reason: "Diagnostic observation was cancelled." })
      }
    }
  }
}

export const verifyDiagnosticBaseline = (
  baseline: string[],
  observation: DiagnosticObservation | { errors: string[]; version?: number }
): DiagnosticVerification => {
  if ("status" in observation) {
    return {
      status: observation.status,
      verified: false,
      reason: observation.reason,
      evidence: "Diagnostic observation at document version " + (observation.version ?? "unknown") + ": " + observation.errors.length + " errors; " + observation.reason
    }
  }
  const expected = [...baseline].sort()
  const actual = [...observation.errors].sort()
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    return {
      status: "verified",
      verified: true,
      reason: "Restored diagnostics match the pre-edit baseline.",
      evidence: "Diagnostics verified at document version " + (observation.version ?? "unknown") + "; " + actual.length + " baseline errors remain."
    }
  }
  const remaining = [...actual]
  for (const error of expected) {
    const index = remaining.indexOf(error)
    if (index >= 0) remaining.splice(index, 1)
  }
  const status = remaining.length ? "remaining-diagnostics" : "baseline-mismatch"
  const detail = remaining.length
    ? "Restored document still has " + remaining.length + " diagnostic" + (remaining.length === 1 ? "" : "s") + " not present in the baseline."
    : "Restored diagnostics differ from the baseline (" + expected.length + " expected, " + actual.length + " observed)."
  return {
    status,
    verified: false,
    reason: detail,
    evidence: "Diagnostics at document version " + (observation.version ?? "unknown") + ": " + actual.length + " observed; " + detail + (remaining.length ? " New diagnostics: " + remaining.slice(0, 5).join("; ") : "")
  }
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

  async rollback(): Promise<{ restored: boolean; contentVerified: boolean; reason?: string }> {
    const files = [...this._files.values()]
    if (!files.length) return { restored: false, contentVerified: false, reason: "No safe file checkpoint is available." }
    for (const file of files) {
      if (file.expectedHash === undefined) return { restored: false, contentVerified: false, reason: `The current version of ${file.path} was not recorded after the agent operation.` }
      const current = await this._adapter.read(file.path)
      if (current === undefined || checkpointHash(current) !== file.expectedHash) {
        return { restored: false, contentVerified: false, reason: `${file.path} changed after the agent operation; rollback would overwrite a concurrent edit.` }
      }
    }
    if (!(await this._adapter.restore(files))) return { restored: false, contentVerified: false, reason: "The editor refused to restore the safe checkpoint." }
    for (const file of files) {
      const restored = await this._adapter.read(file.path)
      if (restored !== file.before) return { restored: false, contentVerified: false, reason: `Checkpoint verification failed for ${file.path}.` }
    }
    await this._adapter.clear()
    this._files.clear()
    this._bytes = 0
    return { restored: true, contentVerified: true }
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

export interface SignificantEditRecoveryInput {
  file: string
  introducedErrors: number
  diagnosticsObserved: boolean
  diagnosticCheckAvailable: boolean
  baseline?: string[]
  diagnosticFailure?: DiagnosticObservation
  checkpoints?: SafeEditCheckpoints
  monitor?: DiagnosticRegressionMonitor
  errorSpikeThreshold?: number
  observeRestoredDiagnostics?(): Promise<DiagnosticObservation | { errors: string[]; version?: number }>
  blockMutations?(): void
}

export interface SignificantEditRecoveryResult {
  catastrophic: true
  restored: boolean
  fileVerified: boolean
  diagnosticsVerified: boolean
  diagnosticsStatus: DiagnosticVerificationStatus
  reason: string
  diagnosticEvidence: string
}

export const recoverSignificantEdit = async (input: SignificantEditRecoveryInput): Promise<SignificantEditRecoveryResult | undefined> => {
  if (!input.diagnosticsObserved) return undefined
  const catastrophic = input.monitor?.record(input.file, input.introducedErrors) ?? (input.introducedErrors >= (input.errorSpikeThreshold ?? 20))
  if (!catastrophic) return undefined
  input.blockMutations?.()
  const rollback = input.checkpoints
    ? await input.checkpoints.rollback()
    : { restored: false, contentVerified: false, reason: "No safe checkpoint service is available." }
  let verification = input.diagnosticFailure
    ? verifyDiagnosticBaseline(input.baseline ?? [], input.diagnosticFailure)
    : verifyDiagnosticBaseline(input.baseline ?? [], {
        status: "unavailable",
        errors: [],
        reason: input.diagnosticCheckAvailable
          ? "Rollback diagnostics were not observed."
          : "A stable pre-edit diagnostic baseline was unavailable."
      })
  if (rollback.restored && input.baseline && input.diagnosticCheckAvailable && input.observeRestoredDiagnostics) {
    verification = verifyDiagnosticBaseline(input.baseline, await input.observeRestoredDiagnostics())
  }
  const fileVerified = rollback.contentVerified
  const reason = !fileVerified
    ? "Could not safely restore file contents: " + rollback.reason
    : verification.verified
      ? "Restored and verified the safe file checkpoint; diagnostics match the pre-edit baseline."
      : "Restored and verified file contents, but diagnostic verification " + verification.status + ": " + verification.reason
  return {
    catastrophic: true,
    restored: rollback.restored,
    fileVerified,
    diagnosticsVerified: verification.verified,
    diagnosticsStatus: verification.status,
    reason,
    diagnosticEvidence: verification.evidence
  }
}
export class DiagnosticRegressionMonitor {
  private readonly _totals = new Map<string, { errors: number; edits: number }>()
  private readonly _transactionEdits = 8

  constructor(
    readonly errorSpikeThreshold = 20,
    readonly cumulativeErrorThreshold = 40
  ) {}

  record(file: string, introducedErrors: number): boolean {
    if (introducedErrors <= 0) {
      this._totals.delete(file)
      return false
    }
    if (introducedErrors >= this.errorSpikeThreshold) return true
    const previous = this._totals.get(file)
    const transaction = !previous || previous.edits >= this._transactionEdits
      ? { errors: introducedErrors, edits: 1 }
      : { errors: previous.errors + introducedErrors, edits: previous.edits + 1 }
    this._totals.set(file, transaction)
    return introducedErrors >= 8 && transaction.errors >= this.cumulativeErrorThreshold
  }
}
