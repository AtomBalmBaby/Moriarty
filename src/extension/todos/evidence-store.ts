/**
 * Stage 1's byte store: one immutable invocation record, one outcome per observation, and
 * content-addressed BLOBs holding the bytes as the tool produced them, recorded before any fitting
 * or context budgeting (Rule 1). The presentation copy in `todo_tool_evidence` stays exactly as
 * Feedback and lookup already read it; this store is the authoritative byte record.
 *
 * Nothing here grants anything (Rule 7): stored bytes and a matching digest convey no permission.
 * States are reported as measured - `complete` only when every received byte is held, `partial` when
 * a policy cap cut the write, `evicted` only after an actual eviction, `unknown` when the bytes cannot
 * be verified, and `storage_error` when the write itself failed. A record that could not be written is
 * never reported as a successful record, and no ID is invented for content the store does not hold.
 */
import { createHash, randomUUID } from "node:crypto"
import fsSync from "node:fs"
import path from "node:path"

import type { CaptureCompleteness, CaptureMode, ExecutionState, ResultCapture, ResultGap, StorageCompleteness, TerminationReason } from "../../common/types"
import type { ToolErrorDetail } from "../tools/arguments"

import { redactEvidence } from "./evidence"
import type { EvidenceStoragePolicy, PolicyReading, PolicySource } from "./evidence-config"
import { type Database, SqliteFile } from "./sqlite"

type SqlValue = string | number | bigint | Buffer | null

/** The streams this store knows. `payload` is a non-command result; `terminal` is a merged PTY transcript. */
export type EvidenceStream = "stdout" | "stderr" | "terminal" | "payload"
export const STREAMS: readonly EvidenceStream[] = ["stdout", "stderr", "terminal", "payload"]
/** A storage write that failed is its own reason; the model-facing contract reports it as inaccessible. */
export type StorageGapReason = ResultGap["reason"] | "storage_error"

/** Above this, bytes are kept as an external byte object the database points at rather than inline. */
export const INLINE_BLOB_LIMIT = 64_000
/** The line index is bounded; a payload with more lines than this reports the bound instead of pretending. */
export const MAX_INDEXED_LINES = 5_000

export interface CapturedResult {
  /** The invocation identity: the row this capture belongs to, kept as `request_id` for replay. */
  invocationId: string
  executionId?: string
  /** Shared across calls in one persistent shell; never an observation identity of its own. */
  sessionId?: string
  batchId?: string
  commandSequence?: number
  toolName: string
  /** Typed original arguments, preserved as sent. A redacted copy is the presentation view, not this. */
  args: Record<string, unknown>
  executed: boolean
  status: ExecutionState
  streams: { stdout?: Buffer; stderr?: Buffer; terminal?: Buffer }
  captureMode: CaptureMode
  chunks: { stream: EvidenceStream; seq: number; bytes: Buffer; receivedAt: string }[]
  inputEvents?: { kind: "stdin_write" | "stdin_close"; byteCount: number; result: string; receivedAt: string }[]
  exitCode?: number
  signal?: string
  terminationReason?: TerminationReason
  error?: ToolErrorDetail
  startedAt: string
  finishedAt?: string
  capture: ResultCapture
}

/** Where a write belongs. The store never decides project identity; the caller supplies it. */
export interface CaptureScope {
  projectId: string
  /** Provenance only, as the repository already keeps it: no ownership cascade from here. */
  listId?: string
  itemId?: string
  /** The bounded presentation copy, written by the repository; the blob keeps the bytes. */
  display?: { output: string; arguments: Record<string, string>; failed: boolean }
}

export interface StoredStreamState {
  stream: EvidenceStream
  /** No ID is reported for content the store does not hold. */
  blobId?: string
  contentDigest?: string
  storageKind: "inline" | "file"
  originalBytes: number
  capturedBytes: number
  storedBytes: number
  encoding: "utf8" | "bytes" | "mixed"
  bytePreservation: "lossless" | "normalized" | "excluded"
  redaction: "none" | "applied" | "excluded_by_policy"
  capturedComplete: CaptureCompleteness
  storageComplete: StorageCompleteness
  gapReason?: StorageGapReason
  /** Retained coverage, in order, as half-open [start,end) ranges. */
  coverage: { fromByte: number; toByte: number }[]
  chunks: number
}

export interface StoredOutcome {
  outcomeId: string
  observationId: string
  projectId: string
  executionRef?: string
  sessionId?: string
  batchId?: string
  commandSequence?: number
  executed: boolean
  status: string
  exitCode?: number
  signal?: string
  terminationReason?: TerminationReason
  captureMode: CaptureMode
  capturedComplete: CaptureCompleteness
  storageComplete: StorageCompleteness
  gapReason?: StorageGapReason
  /** The write itself failed, so no part of this outcome may be read as recorded. */
  state: "recorded" | "pending" | "storage_error"
  reason?: string
  startedAt: string
  finishedAt?: string
  pending: boolean
  streams: StoredStreamState[]
  /** The bounded line index this write produced, reported as what it actually covered. */
  lineIndex: { lines: number; bounded: boolean }
}

export interface ReconciliationReport {
  settled: { outcomeId: string; observationId: string; settledTo: "lost" | "unknown"; reason: string }[]
  byteObjectsChecked: number
  /** Pointers whose bytes are gone or no longer match what the row claims. */
  byteObjectsUnverified: { blobId: string; reason: string }[]
  /** Byte objects on disk with no pointer: reported, never deleted by this store. */
  orphanFiles: string[]
}

/** The two operations this stage's contract freezes; the pending record is written first and the terminal result appended atomically. */
export interface EvidenceStore {
  record(captured: CapturedResult, scope?: CaptureScope): Promise<StoredOutcome>
  pending(invocationId: string, scope?: CaptureScope): Promise<StoredOutcome | undefined>
}

export interface StoreOptions {
  /** Where external byte objects live. The store writes only inside this folder. */
  blobDirectory?: string
  /** Which storage view to use; `file` exercises the staged-write and rename protocol. */
  forceStorageKind?: "inline" | "file"
}

const digestOf = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex")

/** A byte view equals its decode only when re-encoding gives the same bytes back. */
const decodesLosslessly = (bytes: Buffer): boolean => Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes)

const encodingOf = (bytes: Buffer): "utf8" | "bytes" | "mixed" => {
  if (!decodesLosslessly(bytes)) return "bytes"
  return bytes.includes(0) ? "mixed" : "utf8"
}

const rows = <T>(database: Database, sql: string, values: SqlValue[] = []): T[] => database.prepare(sql).all(...values) as T[]
const execute = (database: Database, sql: string, values: SqlValue[] = []) => database.prepare(sql).run(...values)

const PENDING_STATES = ["accepted", "queued", "starting", "running"]
const isPending = (status: string): boolean => PENDING_STATES.includes(status)
const storageStateOf = (storedBytes: number, originalBytes: number, evicted: boolean): StorageCompleteness =>
  evicted ? "evicted" : storedBytes >= originalBytes ? "complete" : storedBytes > 0 ? "partial" : "inaccessible"

const lineRunsOf = (bytes: Buffer, limit: number): { runs: { lineNo: number; byteStart: number; byteEnd: number }[]; bounded: boolean } => {
  const runs: { lineNo: number; byteStart: number; byteEnd: number }[] = []
  let lineNo = 1
  let start = 0
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 10) continue
    if (runs.length >= limit) return { runs, bounded: true }
    runs.push({ lineNo, byteStart: start, byteEnd: index + 1 })
    lineNo += 1
    start = index + 1
  }
  if (start < bytes.length) {
    if (runs.length >= limit) return { runs, bounded: true }
    runs.push({ lineNo, byteStart: start, byteEnd: bytes.length })
  }
  return { runs, bounded: false }
}
interface OutcomeRow {
  id: string
  observation_id: string
  project_id: string
  execution_ref: string | null
  session_id: string | null
  batch_id: string | null
  command_sequence: number | null
  status: string
  exit_code: number | null
  signal: string | null
  termination_reason: string | null
  capture_mode: string
  captured_complete: number
  storage_complete: number
  gap_reason: string | null
  created_at: string
  stdout_blob_id: string | null
  stderr_blob_id: string | null
  terminal_blob_id: string | null
  payload_blob_id: string | null
}

interface BlobRow {
  id: string
  content_digest: string
  storage_kind: string
  relative_path: string | null
  stored_bytes: number
  original_bytes: number
  encoding: string
  byte_preservation: string
  redaction: string
  evicted_at: string | null
}

interface ChunkRangeRow { stream: string; seq: number; byte_start: number; byte_end: number; received_at: string }
interface CountRow { n: number }

/** A recorded gap, read back from the event row that names it. */
interface GapDetails { stream?: string; reason?: string; fromByte?: number; toByte?: number; captured?: number; redaction?: string; indexBounded?: boolean; capturedComplete?: string; storageComplete?: string }

const STREAM_COLUMN: Record<EvidenceStream, string> = { stdout: "stdout_blob_id", stderr: "stderr_blob_id", terminal: "terminal_blob_id", payload: "payload_blob_id" }

const nowIso = (): string => new Date().toISOString()

/** What the tool handed over for one stream, in the order it arrived. */
interface Measurement {
  stream: EvidenceStream
  bytes: Buffer
  chunks: { seq: number; byteStart: number; byteEnd: number; receivedAt: string }[]
}

const measurementsOf = (captured: CapturedResult): Measurement[] => {
  const byStream = new Map<EvidenceStream, Measurement>()
  for (const chunk of [...captured.chunks].sort((left, right) => left.seq - right.seq)) {
    const seen = byStream.get(chunk.stream) ?? { stream: chunk.stream, bytes: Buffer.alloc(0), chunks: [] }
    const start = seen.bytes.length
    seen.bytes = Buffer.concat([seen.bytes, chunk.bytes])
    seen.chunks.push({ seq: chunk.seq, byteStart: start, byteEnd: seen.bytes.length, receivedAt: chunk.receivedAt })
    byStream.set(chunk.stream, seen)
  }
  const buffers: Record<Exclude<EvidenceStream, "payload">, Buffer | undefined> = { stdout: captured.streams.stdout, stderr: captured.streams.stderr, terminal: captured.streams.terminal }
  for (const stream of ["stdout", "stderr", "terminal"] as Exclude<EvidenceStream, "payload">[]) {
    const buffer = buffers[stream]
    if (buffer === undefined || byStream.has(stream)) continue
    byStream.set(stream, { stream, bytes: buffer, chunks: [{ seq: 0, byteStart: 0, byteEnd: buffer.length, receivedAt: captured.startedAt }] })
  }
  return [...byStream.values()].sort((left, right) => STREAMS.indexOf(left.stream) - STREAMS.indexOf(right.stream))
}

const parseGap = (json: string | null): GapDetails => {
  try {
    return JSON.parse(json ?? "{}") as GapDetails
  } catch {
    return {}
  }
}

/** A write that could not happen is reported as what it was: no IDs, no retained claim. */
const unrecorded = (captured: CapturedResult, scope: CaptureScope | undefined, reason: string): StoredOutcome => ({
  outcomeId: "",
  observationId: "",
  projectId: scope?.projectId ?? "",
  executed: captured.executed,
  status: captured.executed ? captured.status : "refused",
  captureMode: captured.captureMode,
  capturedComplete: captured.capture.capturedBytes > 0 ? "partial" : "not_captured",
  storageComplete: "inaccessible",
  gapReason: "storage_error",
  state: "storage_error",
  reason,
  startedAt: captured.startedAt,
  ...(captured.finishedAt === undefined ? {} : { finishedAt: captured.finishedAt }),
  pending: false,
  streams: [],
  lineIndex: { lines: 0, bounded: false }
})

export class ProjectEvidenceStore implements EvidenceStore {
  private readonly sqlite: SqliteFile
  private readonly policySource: PolicySource
  private readonly blobsDirectory: string
  private readonly options: StoreOptions

  constructor(sqlite: SqliteFile, policySource: PolicySource, projectHome: string, options: StoreOptions = {}) {
    this.sqlite = sqlite
    this.policySource = policySource
    this.blobsDirectory = options.blobDirectory ?? path.join(projectHome, ".twinny", "blobs")
    this.options = options
  }

  /** What the next write would use: the file is read again only when it has changed. */
  policy(): Promise<PolicyReading> {
    return this.policySource.effective()
  }

  async record(captured: CapturedResult, scope?: CaptureScope): Promise<StoredOutcome> {
    const reading = await this.policySource.effective()
    if (reading.state === "invalid") return unrecorded(captured, scope, reading.reason)
    if (!scope?.projectId) return unrecorded(captured, scope, "the capture names no project to record in")
    return this.sqlite.write((database) => this.recordInTransaction(database, captured, scope, reading.reading.policy))
  }

  /**
   * Runs inside the caller's transaction so the invocation, outcome, bytes and chunks commit together.
   * The pending record is written first; the terminal result is appended in the same write.
   */
  recordInTransaction(database: Database, captured: CapturedResult, scope: CaptureScope, policy: EvidenceStoragePolicy): StoredOutcome {
    const observationId = this.ensureObservation(database, captured, scope)
    const outcomeId = this.ensurePendingRecord(database, captured, scope, observationId)
    const states: StoredStreamState[] = []
    for (const measurement of measurementsOf(captured)) states.push(this.storeMeasurement(database, scope, policy, outcomeId, captured, measurement))
    this.settleTerminal(database, captured, scope, policy, outcomeId, states)
    return this.readOutcome(database, scope.projectId, outcomeId)!
  }

  /** The pending record on its own, which is what a crash between a chunk and the final status leaves. */
  async beginPending(captured: CapturedResult, scope: CaptureScope): Promise<StoredOutcome> {
    const reading = await this.policySource.effective()
    if (reading.state === "invalid") return unrecorded(captured, scope, reading.reason)
    return this.sqlite.write((database) => {
      const observationId = this.ensureObservation(database, captured, scope)
      const outcomeId = this.ensurePendingRecord(database, captured, scope, observationId)
      for (const measurement of measurementsOf(captured)) {
        for (const chunk of measurement.chunks) {
          if (chunk.byteEnd <= chunk.byteStart) continue
          execute(database, "INSERT INTO evidence_chunks(outcome_id, stream, seq, byte_start, byte_end, received_at) VALUES (?, ?, ?, ?, ?, ?)", [outcomeId, measurement.stream, chunk.seq, chunk.byteStart, chunk.byteEnd, chunk.receivedAt])
        }
      }
      return this.readOutcome(database, scope.projectId, outcomeId)!
    })
  }

  async pending(invocationId: string, scope?: CaptureScope): Promise<StoredOutcome | undefined> {
    if (!scope?.projectId) return undefined
    return this.sqlite.read((database) => {
      const observation = rows<{ id: string }>(database, "SELECT id FROM todo_tool_observations WHERE project_id = ? AND (id = ? OR request_id = ?)", [scope.projectId, invocationId, invocationId])[0]
      if (!observation) return undefined
      return storedOutcomeForObservation(database, scope.projectId, observation.id)
    })
  }

  /**
   * What a reopen settles. A pending record becomes `lost` when bytes had arrived and `unknown` when
   * nothing can be said about it - never a success. Every byte-object pointer is checked against the
   * bytes on disk, and byte objects with no pointer are reported, not deleted.
   */
  reconcile(): Promise<ReconciliationReport> {
    return this.sqlite.write((database) => {
      const settled: ReconciliationReport["settled"] = []
      for (const outcome of rows<OutcomeRow>(database, "SELECT * FROM evidence_outcomes WHERE status IN ('accepted','queued','starting','running') ORDER BY created_at, id")) {
        const received = (rows<CountRow>(database, "SELECT COUNT(*) AS n FROM evidence_chunks WHERE outcome_id = ?", [outcome.id])[0]?.n ?? 0)
        const to = received > 0 ? "lost" : "unknown"
        execute(database, "UPDATE evidence_outcomes SET status = ?, storage_complete = 0, gap_reason = ? WHERE id = ?", [to, received > 0 ? "inaccessible" : "not_captured", outcome.id])
        settled.push({ outcomeId: outcome.id, observationId: outcome.observation_id, settledTo: to, reason: `the record had ${received} recorded chunk${received === 1 ? "" : "s"} and no terminal state` })
      }
      const pointers = rows<BlobRow>(database, "SELECT * FROM evidence_blobs WHERE storage_kind = 'file' ORDER BY created_at, id")
      const unverified: { blobId: string; reason: string }[] = []
      for (const blob of pointers) {
        const file = path.join(this.blobsDirectory, blob.relative_path ?? "")
        let bytes: Buffer
        try {
          bytes = fsSync.readFileSync(file)
        } catch (error) {
          unverified.push({ blobId: blob.id, reason: `the byte object at ${blob.relative_path} could not be read: ${error instanceof Error ? error.message : String(error)}` })
          continue
        }
        if (digestOf(bytes) !== blob.content_digest) {
          unverified.push({ blobId: blob.id, reason: `the bytes on disk digest to ${digestOf(bytes)}, not the ${blob.content_digest} the row claims` })
          continue
        }
      }
      const referenced = new Set(pointers.map((blob) => blob.relative_path))
      const listed = fsSync.existsSync(this.blobsDirectory) ? fsSync.readdirSync(this.blobsDirectory).sort() : []
      return { settled, byteObjectsChecked: pointers.length, byteObjectsUnverified: unverified, orphanFiles: listed.filter((name) => !referenced.has(name)) }
    })
  }

  private ensureObservation(database: Database, captured: CapturedResult, scope: CaptureScope): string {
    const existing = rows<{ id: string }>(database, "SELECT id FROM todo_tool_observations WHERE project_id = ? AND (id = ? OR request_id = ?)", [scope.projectId, captured.invocationId, captured.invocationId])[0]
    if (existing) return existing.id
    const id = randomUUID()
    execute(database,
      "INSERT INTO todo_tool_observations(id, project_id, list_id, item_id, request_id, tool_name, arguments_json, output, failed, exit_code, created_at, execution_id, executed, call_id, host_key, started_at, finished_at, error_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, '', ?, ?, ?)",
      [id, scope.projectId, scope.listId ?? null, scope.itemId ?? null, captured.invocationId, captured.toolName, JSON.stringify(captured.args), scope.display?.output ?? "", scope.display?.failed ? 1 : 0, captured.exitCode ?? null, captured.startedAt, captured.executionId ?? null, captured.executed ? 1 : 0, captured.startedAt, captured.finishedAt ?? null, captured.error ? "refused_before_execution" : null])
    return id
  }

  private ensurePendingRecord(database: Database, captured: CapturedResult, scope: CaptureScope, observationId: string): string {
    const existing = rows<{ id: string }>(database, "SELECT id FROM evidence_outcomes WHERE project_id = ? AND observation_id = ?", [scope.projectId, observationId])[0]
    if (existing) return existing.id
    const id = randomUUID()
    const status = captured.executed && !isPending(captured.status) ? "starting" : captured.status
    execute(database, "INSERT INTO evidence_outcomes(id, observation_id, project_id, execution_ref, session_id, batch_id, command_sequence, status, capture_mode, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [id, observationId, scope.projectId, captured.executionId ?? null, captured.sessionId ?? null, captured.batchId ?? null, captured.commandSequence ?? null, status, captured.captureMode, captured.startedAt])
    return id
  }

  private storeMeasurement(database: Database, scope: CaptureScope, policy: EvidenceStoragePolicy, outcomeId: string, captured: CapturedResult, measurement: Measurement): StoredStreamState {
    const received = measurement.bytes
    const chunks = measurement.chunks.map((chunk) => ({ fromByte: chunk.byteStart, toByte: chunk.byteEnd }))
    if (received.length === 0) {
      // Zero bytes arrived on this stream: no blob row and no ID exists for content the store does not hold, while "no output" and "output not captured" stay different states.
      this.recordGap(database, outcomeId, measurement.stream, "not_captured", 0, 0, measurement.chunks.length, { retained: 0, captured: 0, capturedComplete: "not_captured", storageComplete: "inaccessible" })
      return this.streamState(measurement, undefined, 0, "none", "not_captured", [], false)
    }
    const secretExcluded = policy.redactionMode === "exclude_raw_secrets" && redactEvidence(received.toString("utf8")) !== received.toString("utf8")
    const overBlobCap = policy.enabled && received.length > policy.maxBlobBytes
    if (!policy.enabled || secretExcluded || overBlobCap) {
      // Nothing is retained for this stream, so no blob row exists and no ID is reported for it.
      this.recordGap(database, outcomeId, measurement.stream, secretExcluded ? "redaction" : "storage_limit", 0, received.length, measurement.chunks.length, { retained: 0, captured: received.length, redaction: secretExcluded ? "excluded_by_policy" : "none", capturedComplete: secretExcluded ? "excluded" : "complete" })
      return this.streamState(measurement, undefined, 0, secretExcluded ? "excluded_by_policy" : "none", secretExcluded ? "redaction" : "storage_limit", [], false)
    }
    let room = projectRoom(database, scope.projectId, policy)
    if (room < received.length) room += this.evictForRoom(database, scope.projectId, policy, received.length - room)
    const retained = Math.min(received.length, Math.max(room, 0))
    if (retained <= 0) {
      this.recordGap(database, outcomeId, measurement.stream, "storage_limit", 0, received.length, measurement.chunks.length, { retained: 0, captured: received.length, capturedComplete: "complete" })
      return this.streamState(measurement, undefined, 0, "none", "storage_limit", [], false)
    }
    const bytes = retained >= received.length ? received : received.subarray(0, retained)
    const digest = digestOf(bytes)
    const shared = rows<BlobRow>(database, "SELECT * FROM evidence_blobs WHERE project_id = ? AND content_digest = ?", [scope.projectId, digest])[0]
    if (shared && !shared.evicted_at) {
      // Sharing the bytes never merges the receipt history: each outcome keeps its own chunks.
      this.recordChunks(database, outcomeId, measurement, bytes.length)
      this.linkOutcomeColumn(database, outcomeId, measurement.stream, shared.id)
      return this.streamState(measurement, shared, bytes.length, redactionOfName(shared.redaction), undefined, chunks, false)
    }
    const storageKind = this.options.forceStorageKind ?? (bytes.length > INLINE_BLOB_LIMIT ? "file" : "inline")
    let relativePath: string | null = null
    if (storageKind === "file") {
      try {
        relativePath = this.stageByteObject(digest, bytes)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        this.recordGap(database, outcomeId, measurement.stream, "storage_error", 0, received.length, measurement.chunks.length, { retained: 0, error: reason })
        return this.streamState(measurement, undefined, 0, "none", "storage_error", [], false)
      }
    }
    const blobId = randomUUID()
    execute(database,
      "INSERT INTO evidence_blobs(id, project_id, content_digest, storage_kind, relative_path, inline_bytes, original_bytes, stored_bytes, encoding, byte_preservation, redaction, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [blobId, scope.projectId, digest, storageKind, relativePath, storageKind === "inline" ? bytes : null, received.length, bytes.length, encodingOf(bytes), captured.capture.redaction === "applied" ? "normalized" : "lossless", captured.capture.redaction, nowIso()])
    const stored = rows<BlobRow>(database, "SELECT * FROM evidence_blobs WHERE id = ?", [blobId])[0]
    this.recordChunks(database, outcomeId, measurement, bytes.length)
    const runs = lineRunsOf(bytes, MAX_INDEXED_LINES)
    for (const run of runs.runs) {
      const lineText = bytes.subarray(run.byteStart, run.byteEnd).toString("utf8")
      execute(database, "INSERT INTO evidence_lines(blob_id, line_no, char_start, char_end, byte_start, byte_end) VALUES (?, ?, ?, ?, ?, ?)", [blobId, run.lineNo, 0, lineText.length, run.byteStart, run.byteEnd])
    }
    if (runs.bounded) this.recordGap(database, outcomeId, measurement.stream, "storage_limit", runs.runs.length, bytes.length, measurement.chunks.length, { indexBounded: true, linesIndexed: runs.runs.length, retained: bytes.length, capturedComplete: "complete" })
    if (bytes.length < received.length) this.recordGap(database, outcomeId, measurement.stream, "storage_limit", bytes.length, received.length, measurement.chunks.length, { retained: bytes.length, capturedComplete: "complete" })
    this.linkOutcomeColumn(database, outcomeId, measurement.stream, blobId)
    return this.streamState(measurement, stored, bytes.length, redactionOfName(captured.capture.redaction), bytes.length < received.length ? "storage_limit" : undefined, chunks, false)
  }

  /** Each observation keeps its own receipt history, even when the stored bytes are shared. */
  private recordChunks(database: Database, outcomeId: string, measurement: Measurement, retainedBytes: number): void {
    for (const chunk of measurement.chunks) {
      if (chunk.byteEnd <= chunk.byteStart || chunk.byteStart >= retainedBytes) continue
      execute(database, "INSERT INTO evidence_chunks(outcome_id, stream, seq, byte_start, byte_end, received_at) VALUES (?, ?, ?, ?, ?, ?)", [outcomeId, measurement.stream, chunk.seq, chunk.byteStart, Math.min(chunk.byteEnd, retainedBytes), chunk.receivedAt])
    }
  }
  private streamState(measurement: Measurement, blob: BlobRow | undefined, storedBytes: number, redaction: "none" | "applied" | "excluded_by_policy", gapReason: StorageGapReason | undefined, coverage: { fromByte: number; toByte: number }[], evicted: boolean): StoredStreamState {
    return {
      stream: measurement.stream,
      ...(blob ? { blobId: blob.id, contentDigest: blob.content_digest } : {}),
      storageKind: storageKindOf(blob?.storage_kind ?? "inline"),
      originalBytes: measurement.bytes.length,
      capturedBytes: measurement.bytes.length,
      storedBytes: storedBytes,
      encoding: encodingOfName(blob?.encoding ?? encodingOf(measurement.bytes)),
      bytePreservation: blob ? bytePreservationOf(blob.byte_preservation) : "excluded",
      redaction,
      capturedComplete: evicted ? "complete" : measurement.bytes.length > 0 ? "complete" : "not_captured",
      storageComplete: evicted ? "evicted" : measurement.bytes.length > 0 && storedBytes >= measurement.bytes.length ? "complete" : storedBytes > 0 ? "partial" : "inaccessible",
      ...(gapReason === undefined ? {} : { gapReason }),
      coverage,
      chunks: measurement.chunks.length
    }
  }


  /** Staged write, verify, atomic rename: a SQLite transaction does not make a filesystem object commit. */
  private stageByteObject(digest: string, bytes: Buffer): string {
    fsSync.mkdirSync(this.blobsDirectory, { recursive: true })
    const name = `${digest}.bin`
    const final = path.join(this.blobsDirectory, name)
    if (fsSync.existsSync(final)) {
      if (digestOf(fsSync.readFileSync(final)) !== digest) throw new Error(`the byte object at ${name} does not match its content digest`)
      return name
    }
    const staged = `${name}.tmp`
    fsSync.writeFileSync(path.join(this.blobsDirectory, staged), bytes)
    if (digestOf(fsSync.readFileSync(path.join(this.blobsDirectory, staged))) !== digest) throw new Error("the staged bytes do not match what was written")
    fsSync.renameSync(path.join(this.blobsDirectory, staged), final)
    return name
  }

  private linkOutcomeColumn(database: Database, outcomeId: string, stream: EvidenceStream, blobId: string): void {
    execute(database, `UPDATE evidence_outcomes SET ${STREAM_COLUMN[stream]} = ? WHERE id = ?`, [blobId, outcomeId])
  }

  private recordGap(database: Database, outcomeId: string, stream: EvidenceStream | "output", reason: StorageGapReason, fromByte: number, toByte: number, chunks: number, extra: Record<string, unknown> = {}): void {
    const seq = (rows<CountRow>(database, "SELECT COALESCE(MAX(seq), -1) AS n FROM evidence_io_events WHERE outcome_id = ?", [outcomeId])[0]?.n ?? -1) + 1
    execute(database, "INSERT INTO evidence_io_events(id, outcome_id, seq, kind, byte_count, result, occurred_at, details_json) VALUES (?, ?, ?, 'capture_gap', ?, ?, ?, ?)", [randomUUID(), outcomeId, seq, toByte - fromByte, reason, nowIso(), JSON.stringify({ stream, fromByte, toByte, chunks, ...extra, reason })])
  }


  /**
   * Room for this write. Stage 6 owns the favourite tier; until then this is today's order, oldest
   * first, and only the state it reports is made honest here. Inline bytes are what the database holds,
   * so byte objects on disk are not deleted by this stage.
   */
  private evictForRoom(database: Database, projectId: string, policy: EvidenceStoragePolicy, needed: number): number {
    if (!policy.enabled) return 0
    let freed = 0
    while (freed < needed) {
      const candidate = rows<{ id: string; stored_bytes: number }>(database,
        "SELECT b.id, b.stored_bytes FROM evidence_blobs AS b WHERE b.project_id = ? AND b.evicted_at IS NULL AND b.storage_kind = 'inline' AND NOT EXISTS (SELECT 1 FROM evidence_favourites AS f JOIN evidence_outcomes AS o ON o.observation_id = f.observation_id WHERE o.project_id = b.project_id AND (o.stdout_blob_id = b.id OR o.stderr_blob_id = b.id OR o.terminal_blob_id = b.id OR o.payload_blob_id = b.id)) ORDER BY b.created_at, b.id LIMIT 1", [projectId])[0]
      if (!candidate) break
      execute(database, "UPDATE evidence_blobs SET inline_bytes = NULL, evicted_at = ? WHERE id = ?", [nowIso(), candidate.id])
      for (const owner of rows<OutcomeRow>(database, "SELECT * FROM evidence_outcomes WHERE ? IN (stdout_blob_id, stderr_blob_id, terminal_blob_id, payload_blob_id)", [candidate.id])) {
        const stream = STREAMS.find((name) => blobColumnOf(owner, name) === candidate.id)
        if (!stream) continue
        this.recordGap(database, owner.id, stream, "eviction", 0, candidate.stored_bytes, 0, { evictedBlob: candidate.id, retained: 0, capturedComplete: "complete" })
        execute(database, "UPDATE evidence_outcomes SET storage_complete = 0, gap_reason = 'eviction' WHERE id = ?", [owner.id])
      }
      freed += candidate.stored_bytes
    }
    return freed
  }



  private settleTerminal(database: Database, captured: CapturedResult, scope: CaptureScope, policy: EvidenceStoragePolicy, outcomeId: string, states: StoredStreamState[]): void {
    const status = captured.executed ? captured.status : "refused"
    const received = states.reduce((sum, state) => sum + state.capturedBytes, 0)
    const stored = states.reduce((sum, state) => sum + state.storedBytes, 0)
    const declared = captured.capture.originalBytes
    const capturedComplete: CaptureCompleteness = received === 0 ? "not_captured" : received >= declared ? "complete" : "partial"
    const storageComplete: StorageCompleteness = states.some((state) => state.gapReason === "storage_error") ? "inaccessible" : stored >= received && received > 0 ? "complete" : stored > 0 ? "partial" : "unknown"
    if (declared > received) this.recordGap(database, outcomeId, "output", "capture_limit", received, declared, states.reduce((sum, state) => sum + state.chunks, 0), { measured: received, declared })
    if (received === 0) this.recordGap(database, outcomeId, "output", "not_captured", 0, declared, 0, { captured: 0, retained: 0, capturedComplete: "not_captured" })
    const gap = states.find((state) => state.gapReason !== undefined)
    execute(database,
      "UPDATE evidence_outcomes SET status = ?, exit_code = ?, signal = ?, termination_reason = ?, capture_mode = ?, captured_complete = ?, storage_complete = ?, gap_reason = ? WHERE id = ?",
      [status, captured.exitCode ?? null, captured.signal ?? null, captured.terminationReason ?? null, captured.captureMode, capturedComplete === "complete" ? 1 : 0, storageComplete === "complete" ? 1 : 0, gap?.gapReason ?? null, outcomeId])
    for (const event of captured.inputEvents ?? []) {
      const seq = (rows<CountRow>(database, "SELECT COALESCE(MAX(seq), -1) AS n FROM evidence_io_events WHERE outcome_id = ?", [outcomeId])[0]?.n ?? -1) + 1
      execute(database, "INSERT INTO evidence_io_events(id, outcome_id, seq, kind, byte_count, result, occurred_at, details_json) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)", [randomUUID(), outcomeId, seq, event.kind, event.byteCount, event.result, event.receivedAt])
    }
    if (captured.executed) {
      const seq = (rows<CountRow>(database, "SELECT COALESCE(MAX(seq), -1) AS n FROM evidence_io_events WHERE outcome_id = ?", [outcomeId])[0]?.n ?? -1) + 1
      const kind = captured.terminationReason === "timeout" ? "timeout" : captured.terminationReason === "cancel" ? "cancel" : captured.terminationReason === "spawn_error" ? "spawn_error" : captured.terminationReason === "signal" ? "signal" : "exit"
      execute(database, "INSERT INTO evidence_io_events(id, outcome_id, seq, kind, byte_count, result, occurred_at, details_json) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)", [randomUUID(), outcomeId, seq, kind, status, captured.finishedAt ?? nowIso(), JSON.stringify({ exitCode: captured.exitCode ?? null, signal: captured.signal ?? null })])
    }
    this.mirrorPolicy(database, scope.projectId, policy)
  }

  /** The database row mirrors the effective JSON settings; it is an audit snapshot, not a second setting. */
  private mirrorPolicy(database: Database, projectId: string, policy: EvidenceStoragePolicy): void {
    execute(database,
      "INSERT INTO storage_policy(project_id, max_project_bytes, max_blob_bytes, eviction_order, redaction_mode, enabled) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET max_project_bytes = excluded.max_project_bytes, max_blob_bytes = excluded.max_blob_bytes, eviction_order = excluded.eviction_order, redaction_mode = excluded.redaction_mode, enabled = excluded.enabled",
      [projectId, policy.maxProjectBytes, policy.maxBlobBytes, policy.evictionOrder, policy.redactionMode, policy.enabled ? 1 : 0])
  }

  /** What the store can prove it holds for one outcome, read back from the rows it wrote. */
  readOutcome(database: Database, projectId: string, outcomeId: string): StoredOutcome | undefined {
    return readStoredOutcome(database, projectId, outcomeId)
  }
}

/** The same state the repository reads: what the store measured, not what was claimed. */
export const storedOutcomeForObservation = (database: Database, projectId: string, observationId: string): StoredOutcome | undefined => {
  const outcome = rows<{ id: string }>(database, "SELECT id FROM evidence_outcomes WHERE project_id = ? AND observation_id = ?", [projectId, observationId])[0]
  return outcome ? readStoredOutcome(database, projectId, outcome.id) : undefined
}

const readStoredOutcome = (database: Database, projectId: string, outcomeId: string): StoredOutcome | undefined => {
  const row = rows<OutcomeRow>(database, "SELECT * FROM evidence_outcomes WHERE id = ?", [outcomeId])[0]
  if (!row) return undefined
  // The outcome is read within its own project; a caller outside it gets nothing, not a hint of what project owns it.
  if (row.project_id !== projectId) return undefined
  const gaps = rows<{ details_json: string | null }>(database, "SELECT details_json FROM evidence_io_events WHERE outcome_id = ? AND kind = 'capture_gap' ORDER BY seq", [outcomeId]).map((event) => parseGap(event.details_json))
  const streams: StoredStreamState[] = []
  const blobs: string[] = []
  for (const stream of STREAMS) {
    const blobId = blobColumnOf(row, stream)
    const coverage = rows<ChunkRangeRow>(database, "SELECT stream, seq, byte_start, byte_end, received_at FROM evidence_chunks WHERE outcome_id = ? AND stream = ? ORDER BY seq", [outcomeId, stream])
    const gapsForStream = gaps.filter((gap) => gap.stream === stream)
    if (!blobId && coverage.length === 0 && gapsForStream.length === 0) continue
    const blob = blobId ? rows<BlobRow>(database, "SELECT * FROM evidence_blobs WHERE id = ?", [blobId])[0] : undefined
    if (blob) blobs.push(blob.id)
    const gapForStream = gapsForStream[0]
    // Coverage is what the store retained. Where it retained nothing, the recorded event names what had been received.
    const capturedBytes = coverage.length > 0 ? coverage.reduce((sum, range) => sum + (range.byte_end - range.byte_start), 0) : gapForStream?.captured ?? 0
    streams.push({
      stream,
      ...(blob ? { blobId: blob.id, contentDigest: blob.content_digest } : {}),
      storageKind: storageKindOf(blob?.storage_kind ?? "inline"),
      originalBytes: Math.max(capturedBytes, gapForStream?.toByte ?? 0, blob?.original_bytes ?? 0),
      capturedBytes,
      storedBytes: blob?.stored_bytes ?? 0,
      encoding: encodingOfName(blob?.encoding ?? "bytes"),
      bytePreservation: bytePreservationOf(blob?.byte_preservation ?? "excluded"),
      redaction: redactionOfName(gapForStream?.redaction ?? blob?.redaction ?? "none"),
      capturedComplete: capturedCompletenessOf(gapForStream?.capturedComplete, capturedBytes),
      storageComplete: blob ? storageStateOf(blob.stored_bytes, blob.original_bytes, blob.evicted_at !== null) : "inaccessible",
      ...(gapForStream === undefined ? {} : { gapReason: blob && blob.evicted_at !== null ? "eviction" : reasonOfName(gapForStream.reason) }),
      coverage: coverage.map((range) => ({ fromByte: range.byte_start, toByte: range.byte_end })),
      chunks: coverage.length
    })
  }
  const indexed = blobs.length === 0 ? 0 : (rows<CountRow>(database, `SELECT COUNT(*) AS n FROM evidence_lines WHERE blob_id IN (${blobs.map(() => "?").join(", ")})`, blobs)[0]?.n ?? 0)
  return {
    outcomeId: row.id,
    observationId: row.observation_id,
    projectId: row.project_id,
    ...(row.execution_ref ? { executionRef: row.execution_ref } : {}),
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.batch_id ? { batchId: row.batch_id } : {}),
    ...(row.command_sequence !== null ? { commandSequence: row.command_sequence } : {}),
    executed: !isPending(row.status) && row.status !== "refused",
    status: row.status,
    ...(row.exit_code !== null ? { exitCode: row.exit_code } : {}),
    ...(row.signal ? { signal: row.signal } : {}),
    ...(row.termination_reason ? { terminationReason: terminationOfName(row.termination_reason) } : {}),
    captureMode: captureModeOf(row.capture_mode),
    capturedComplete: gaps.some((gap) => gap.capturedComplete === "not_captured") ? "not_captured" : row.captured_complete === 1 ? "complete" : "partial",
    storageComplete: row.storage_complete === 1 ? "complete" : reasonOfName(row.gap_reason) === "eviction" ? "evicted" : "inaccessible",
    ...(row.gap_reason ? { gapReason: reasonOfName(row.gap_reason) } : {}),
    state: row.gap_reason === "storage_error" || gaps.some((gap) => gap.reason === "storage_error") ? "storage_error" : isPending(row.status) ? "pending" : "recorded",
    startedAt: row.created_at,
    ...(gaps.length > 0 || isPending(row.status) ? { reason: gaps.length > 0 ? `reported through ${gaps.length} recorded gap event${gaps.length === 1 ? "" : "s"}` : "the terminal result never arrived" } : {}),
    pending: isPending(row.status),
    streams,
    lineIndex: { lines: indexed, bounded: gaps.some((gap) => gap.indexBounded === true) }
  }
}

/** The stored names are read back as what they are, never assumed. */
const storageKindOf = (value: string): "inline" | "file" => value === "file" ? "file" : "inline"
const encodingOfName = (value: string): "utf8" | "bytes" | "mixed" => value === "utf8" ? "utf8" : value === "mixed" ? "mixed" : "bytes"
const bytePreservationOf = (value: string): "lossless" | "normalized" | "excluded" => value === "normalized" ? "normalized" : value === "excluded" ? "excluded" : "lossless"
const redactionOfName = (value: string): "none" | "applied" | "excluded_by_policy" => value === "applied" ? "applied" : value === "excluded_by_policy" ? "excluded_by_policy" : "none"
const captureModeOf = (value: string): CaptureMode => value === "pipes" ? "pipes" : value === "pty" ? "pty" : value === "terminal_merged" ? "terminal_merged" : value === "not_applicable" ? "not_applicable" : "unknown"
const terminationOfName = (value: string): TerminationReason => value === "signal" ? "signal" : value === "timeout" ? "timeout" : value === "cancel" ? "cancel" : value === "lost" ? "lost" : value === "spawn_error" ? "spawn_error" : "exit"
const reasonOfName = (value: string | null | undefined): StorageGapReason =>
  value === "capture_limit" ? "capture_limit" : value === "storage_limit" ? "storage_limit" : value === "eviction" ? "eviction" : value === "redaction" ? "redaction" : value === "failure" ? "failure" : value === "not_captured" ? "not_captured" : value === "storage_error" ? "storage_error" : "inaccessible"
const capturedCompletenessOf = (value: string | undefined, capturedBytes: number): CaptureCompleteness =>
  value === "excluded" ? "excluded" : value === "not_captured" ? "not_captured" : value === "partial" ? "partial" : capturedBytes > 0 ? "complete" : "not_captured"

const blobColumnOf = (row: OutcomeRow, stream: EvidenceStream): string | null => {
  if (stream === "stdout") return row.stdout_blob_id
  if (stream === "stderr") return row.stderr_blob_id
  if (stream === "terminal") return row.terminal_blob_id
  return row.payload_blob_id
}

/** Bytes the project still has room for, counted from what the store actually holds. */
const projectRoom = (database: Database, projectId: string, policy: EvidenceStoragePolicy): number => {
  if (!policy.enabled) return -1
  const held = (rows<CountRow>(database, "SELECT COALESCE(SUM(stored_bytes), 0) AS n FROM evidence_blobs WHERE project_id = ? AND evicted_at IS NULL", [projectId])[0]?.n ?? 0)
  return policy.maxProjectBytes - held
}

/**
 * The capture a string-only tool result becomes: the bytes as they were produced, not a fitted or
 * redacted copy of them. A call refused before execution is an attempt, so it records no run and no
 * exit code it did not earn.
 */
export const textCapture = (input: {
  toolName: string
  arguments: Record<string, unknown>
  text: string
  failed: boolean
  exitCode?: number
  requestId: string
  executionId?: string
  error?: ToolErrorDetail
  executed?: boolean
  startedAt?: string
  finishedAt?: string
  streams?: { stdout?: Buffer; stderr?: Buffer; terminal?: Buffer }
  captureMode?: CaptureMode
}): CapturedResult => {
  const bytes = Buffer.from(input.text, "utf8")
  const executed = input.executed ?? input.error === undefined
  return {
    invocationId: input.requestId,
    ...(input.executionId === undefined ? {} : { executionId: input.executionId }),
    toolName: input.toolName,
    args: input.arguments,
    executed,
    status: executed ? "exited" : "unknown",
    streams: input.streams ?? {},
    captureMode: input.captureMode ?? "not_applicable",
    chunks: [{ stream: "payload", seq: 0, bytes, receivedAt: input.startedAt ?? nowIso() }],
    ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
    ...(input.error === undefined ? {} : { error: input.error }),
    startedAt: input.startedAt ?? nowIso(),
    ...(input.finishedAt === undefined ? {} : { finishedAt: input.finishedAt }),
    capture: { originalBytes: bytes.length, capturedBytes: bytes.length, storedBytes: 0, redaction: "none", encoding: encodingOf(bytes) }
  }
}

