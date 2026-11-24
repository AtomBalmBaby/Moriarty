/**
 * Stage 2's read-only evidence access service over Stage 1's byte store (§4.3).
 *
 * It answers from what the store holds: bounded inclusive line ranges, decoded character offsets inside
 * one line, exact stored-byte offsets, fragments of extremely long lines, one stream on its own, and
 * bounded literal or regex search with deterministic continuation. It never re-runs a tool for retrieval,
 * and it never reads current source to answer a query: the content it returns is what was recorded, and
 * the fingerprint it reports is the one as it was observed (Rule 3).
 *
 * The conversions are fixed once here:
 * - line numbers are 1-based inclusive over the stored content;
 * - character offsets count decoded UTF-8 code units from the start of that line, so they can only be
 *   mapped back to bytes when the stored content is valid UTF-8;
 * - byte offsets count stored bytes and are zero-based half-open `[start,end)`;
 * - when `byte_preservation` is `normalized`, a byte query says so in its own words and the span it returns
 *   is bounded to what exists.
 * A missing end means through the end of what is retained. Every result is size-bounded, continuable
 * through a `(stream, byte)` cursor, and reports only coverage it actually has.
 *
 * Nothing here grants anything (Rule 7): project, host key and authorized roots are decided before any
 * content is read, and a denied lookup names no restricted candidate. Redaction is applied to every span
 * before it reaches the model; a policy that forbids exposing raw secrets withholds the text while the
 * bounded count it did measure stays reported. Each retrieval records one lightweight execution event with
 * its arguments and outcome - never a copy of the bytes it read, so no evidence-of-evidence chain is made.
 */
import { createHash, randomUUID } from "node:crypto"
import fsSync from "node:fs"
import path from "node:path"

import type { ResultStream } from "../../common/types"
import { isWithin } from "../tools/access-grants"

import { MAX_EXCERPT_CHARS, type ObservedVersion, redactEvidence, samePath, type SourceRole } from "./evidence"
import type { PolicySource } from "./evidence-config"
import { MAX_INDEXED_LINES, type StoredOutcome, storedOutcomeForObservation, type StoredStreamState } from "./evidence-store"
import { PROJECT_TODO_DIRECTORY } from "./project-home"
import { toPosixPath } from "./source-roots"
import type { SourceValidityBoundary } from "./source-validity"
import { type Database, SqliteFile } from "./sqlite"
import type {
  ByteRange, EvidenceAccess, EvidenceAccessScope, EvidenceFilter, EvidenceMatch, EvidenceObservation,
  RangeRequest, RetrievalState, RetrievedSpan, SearchMode, SearchPage, SearchRequest, SpanCoverage
} from "./types"

type SqlValue = string | number | bigint | Buffer | null

const rows = <T>(database: Database, sql: string, values: SqlValue[] = []): T[] => database.prepare(sql).all(...values) as T[]
const execute = (database: Database, sql: string, values: SqlValue[] = []) => database.prepare(sql).run(...values)

/** One result is delivered inside this bound and continued; a longer one is never returned whole. */
export const MAX_RETRIEVED_PAGE_CHARS = MAX_EXCERPT_CHARS
/** The fragment bound `read_file` uses for one extremely long line, kept the same here. */
export const MAX_LINE_FRAGMENT_CHARS = 10_000
/** A search is bounded computation: what it did not reach is reported as a bound, never as a total. */
const MAX_SEARCH_SCAN_BYTES = 1_000_000
const MAX_SEARCH_MATCHES = 50
const MAX_SEARCH_CONTEXT_LINES = 3
const SEARCH_PREVIEW_CHARS = 200
/** A general lookup stays discoverable without dumping a huge list: bounded and continuable. */
export const DEFAULT_FILTER_LIMIT = 20
export const MAX_FILTER_RESULTS = 100

const STREAM_NAMES: readonly ResultStream[] = ["stdout", "stderr", "terminal", "payload", "output"]

const digestOf = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex")
const keyHash = (key: string): string => createHash("sha256").update(key).digest("hex").slice(0, 16)

/** The part of a request that decides its page, so a cursor belongs to the request that made it. */
const pageKey = (request: object): string => JSON.stringify(Object.entries(request as Record<string, unknown>).filter(([key]) => key !== "cursor").sort())

/** `(stream, byte)` is the page position: pages are ordered by it, so the same cursor gives the same page. */
const cursorOf = (stream: ResultStream, byte: number, key: string): string => `e1:${stream}:${byte}:${keyHash(key)}`

const readCursor = (cursor: string, key: string): { stream: ResultStream; byte: number } | undefined => {
  const parts = cursor.split(":")
  if (parts.length !== 4 || parts[0] !== "e1") return undefined
  const stream = parts[1] as ResultStream
  const byte = Number(parts[2])
  if (!STREAM_NAMES.includes(stream)) return undefined
  if (!Number.isSafeInteger(byte) || byte < 0) return undefined
  if (parts[3] !== keyHash(key)) return undefined
  return { stream, byte }
}

const findCursorOf = (rowid: number, key: string): string => `f1:${rowid}:${keyHash(key)}`

const readFindCursor = (cursor: string, key: string): number | undefined => {
  const parts = cursor.split(":")
  if (parts.length !== 3 || parts[0] !== "f1") return undefined
  const rowid = Number(parts[1])
  if (!Number.isSafeInteger(rowid) || parts[2] !== keyHash(key)) return undefined
  return rowid
}

/** Every retained piece a request reaches, in byte order: a merged view can hold more than one. */
const intersectAll = (from: number, to: number, ranges: ByteRange[]): ByteRange[] => {
  const ordered = [...ranges].sort((left, right) => left.fromByte - right.fromByte)
  const hits: ByteRange[] = []
  for (const range of ordered) {
    const start = Math.max(from, range.fromByte)
    const end = Math.min(to, range.toByte)
    if (end > start) hits.push({ fromByte: start, toByte: end })
  }
  return hits
}

/** The largest byte prefix of a covered span that fits the page bound, cut at a line boundary when one fits. */
const cutToPage = (bytes: Buffer, from: number, to: number, limit: number): number => {
  if (bytes.subarray(from, to).toString("utf8").length <= limit) return to
  let end = from
  let lastLineEnd = from
  for (let index = from; index < to; index += 1) {
    if (bytes.subarray(from, index + 1).toString("utf8").length > limit) break
    end = index + 1
    if (bytes[index] === 10) lastLineEnd = end
  }
  return lastLineEnd > from ? lastLineEnd : end
}

/** A merged presentation has no single byte object, so its lines are read off the ordered view itself. */
const lineRunsOf = (bytes: Buffer, limit: number): LineRow[] => {
  const runs: LineRow[] = []
  let lineNo = 1
  let start = 0
  for (let index = 0; index < bytes.length && runs.length < limit; index += 1) {
    if (bytes[index] !== 10) continue
    const text = bytes.subarray(start, index).toString("utf8")
    runs.push({ line_no: lineNo, char_start: 0, char_end: text.length, byte_start: start, byte_end: index + 1 })
    lineNo += 1
    start = index + 1
  }
  if (start < bytes.length && runs.length < limit) {
    const text = bytes.subarray(start).toString("utf8")
    runs.push({ line_no: lineNo, char_start: 0, char_end: text.length, byte_start: start, byte_end: bytes.length })
  }
  return runs
}

const describeRanges = (ranges: ByteRange[]): string => ranges.length === 0 ? "nothing" : ranges.map((range) => `[${range.fromByte},${range.toByte})`).join(" ")

const isIso = (value: string): boolean => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value) && !Number.isNaN(Date.parse(value))

const escapeLiteral = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

type Target = { ok: true; family: "lines" | "chars" | "bytes" | "whole"; fromByte: number; toByte: number } | { ok: false; reason: string }
type Finder = (bytes: Buffer, from: number, to: number) => { fromByte: number; toByte: number } | undefined
type Pattern = { ok: true; find: Finder } | { ok: false; reason: string }

/** Decoded positions are mapped back to the bytes they came from, never assumed equal to them. */
const textFinder = (pattern: RegExp): Finder => (bytes, from, to) => {
  const text = bytes.subarray(from, to).toString("utf8")
  const match = pattern.exec(text)
  if (match === null) return undefined
  const at = from + Buffer.byteLength(text.slice(0, match.index))
  return { fromByte: at, toByte: at + Buffer.byteLength(match[0]) }
}

/** Exact bounded raw-byte substring search, with the offsets it found staying in stored bytes. */
const byteFinder = (pattern: Buffer): Finder => (bytes, from, to) => {
  for (let index = from; index + pattern.length <= to; index += 1) {
    let matched = true
    for (let offset = 0; offset < pattern.length; offset += 1) {
      if (bytes[index + offset] !== pattern[offset]) {
        matched = false
        break
      }
    }
    if (matched) return { fromByte: index, toByte: index + pattern.length }
  }
  return undefined
}

interface ObservationRow {
  id: string
  project_id: string
  request_id: string
  tool_name: string
  failed: number
  exit_code: number | null
  created_at: string
  execution_id: string | null
  executed: number
  host_key: string
}

interface ReferenceRow { root_id: string; path: string; role: string; content_hash: string | null; observed_version: string }
interface LineRow { line_no: number; char_start: number; char_end: number; byte_start: number; byte_end: number }
interface ChunkRow { seq: number; byte_start: number; byte_end: number; received_at: string }
interface BlobRow { id: string; content_digest: string; storage_kind: string; relative_path: string | null; inline_bytes: Buffer | null; stored_bytes: number; evicted_at: string | null }

/** One stream as the store can prove it: the rows Stage 1 wrote, plus the bytes those rows point at. */
interface StreamView {
  stream: ResultStream
  state: StoredStreamState
  /** Absent when there are no bytes to serve: nothing retained, content evicted, or bytes that cannot be verified. */
  bytes?: Buffer
  blobDigest?: string
  storedBytes: number
  lines: LineRow[]
  chunks: ChunkRow[]
  indexBounded: boolean
  evictedAt?: string
  /** Why the bytes cannot be served as they were stored. */
  unreadable?: string
  /** A merged view names the streams it came from and the byte ranges each contributes. */
  mergedFrom?: { stream: ResultStream; coverage: ByteRange[] }[]
}

interface Snapshot {
  observation?: ObservationRow
  outcome?: StoredOutcome
  references: ReferenceRow[]
  streams: Map<ResultStream, StreamView>
}

export interface EvidenceAccessOptions {
  /** Where Stage 1 filed byte objects. A file-backed blob is read here and verified against its own digest. */
  blobsDirectory?: string
  /** Labelling only: the repository's existing boundary says whether stored content still matches its source. */
  boundary?: SourceValidityBoundary
}

/** The §4.3 service, over the same connection and boundary the repository owns. */
export class ProjectEvidenceAccess implements EvidenceAccess {
  private readonly sqlite: SqliteFile
  private readonly scope: EvidenceAccessScope
  private readonly policySource: PolicySource
  private readonly home: string
  private readonly blobsDirectory: string
  private readonly boundary?: SourceValidityBoundary

  constructor(sqlite: SqliteFile, scope: EvidenceAccessScope, policySource: PolicySource, projectHome: string, options: EvidenceAccessOptions = {}) {
    this.sqlite = sqlite
    this.scope = scope
    this.policySource = policySource
    this.home = toPosixPath(projectHome)
    this.blobsDirectory = options.blobsDirectory ?? path.join(this.home, PROJECT_TODO_DIRECTORY, "blobs")
    this.boundary = options.boundary
  }

  /** Resolve one observation by UUID, the invocation id as an optional alias. */
  async get(observationId: string, callOptions?: { invocationId?: string }): Promise<EvidenceObservation> {
    const snapshot = await this.snapshot(observationId, callOptions?.invocationId)
    if (!snapshot.observation) return { observationId, access: "missing", reason: "no observation with that identity is readable from this project" }
    const decision = this.decide(snapshot)
    const arguments_ = { observationId, ...(callOptions?.invocationId === undefined ? {} : { invocationId: callOptions.invocationId }) }
    await this.record(snapshot, "get", arguments_, decision.ok ? "found" : "denied")
    if (!decision.ok) return { observationId, access: "denied", reason: decision.reason }
    const observation = snapshot.observation
    const result: EvidenceObservation = {
      observationId: observation.id,
      access: "found",
      toolName: observation.tool_name,
      observedAt: observation.created_at,
      executed: observation.executed === 1,
      failed: observation.failed === 1
    }
    if (observation.request_id !== observation.id) result.invocationId = observation.request_id
    if (observation.execution_id !== null) result.executionId = observation.execution_id
    if (observation.exit_code !== null) result.exitCode = observation.exit_code
    const named = snapshot.references.find((reference) => this.mayRead(reference.root_id))
    if (named) result.path = this.canonicalOf(named)
    const hash = this.originalHashOf(snapshot)
    if (hash !== undefined) result.originalHash = hash
    if (!snapshot.outcome) {
      result.reason = "this observation has no recorded outcome, so nothing about its bytes can be reported"
      return result
    }
    result.status = snapshot.outcome.status
    result.completeness = { captured: snapshot.outcome.capturedComplete, stored: snapshot.outcome.storageComplete }
    result.streams = [...snapshot.streams.values()].map((view) => ({ stream: view.stream, coverage: view.state.coverage }))
    result.lineIndex = { lines: snapshot.outcome.lineIndex.lines, bounded: snapshot.outcome.lineIndex.bounded }
    if (await this.labelled(snapshot)) result.historical = true
    return result
  }

  /** Bounded inclusive retrieval over retained content. Nothing here re-runs the tool that produced it. */
  async range(observationId: string, request: RangeRequest): Promise<RetrievedSpan> {
    const snapshot = await this.snapshot(observationId)
    if (!snapshot.observation) return this.spanOf(snapshot, observationId, request, request.stream ?? "output", undefined, "not_retrievable", "no observation with that identity is readable from this project")
    const id = snapshot.observation.id
    const decision = this.decide(snapshot)
    if (!decision.ok) {
      await this.record(snapshot, "range", request, "denied")
      return this.spanOf(snapshot, id, request, request.stream ?? "output", undefined, "not_retrievable", decision.reason)
    }
    const reading = await this.policySource.effective()
    if (reading.state === "invalid") {
      await this.record(snapshot, "range", request, "not_retrievable")
      return this.spanOf(snapshot, id, request, request.stream ?? "output", undefined, "not_retrievable", `the storage policy ${reading.reason}`)
    }
    const served = this.serveStream(snapshot, request.stream, true)
    if (!served.ok) {
      await this.record(snapshot, "range", request, "not_retrievable")
      return this.spanOf(snapshot, id, request, served.stream, undefined, "not_retrievable", served.reason)
    }
    const view = served.view
    if (view.state.storageComplete === "evicted") {
      await this.record(snapshot, "range", request, "evicted")
      return this.spanOf(snapshot, id, request, view.stream, view, "evicted", `the bytes for this stream were evicted at ${view.evictedAt ?? "an unrecorded time"}; the coverage reported is what the store held, not what it still holds`)
    }
    if (!view.bytes) {
      const state: RetrievalState = view.blobDigest !== undefined ? "unknown_content" : "not_retrievable"
      await this.record(snapshot, "range", request, state)
      return this.spanOf(snapshot, id, request, view.stream, view, state, view.unreadable ?? `nothing was retained for this stream (${view.state.gapReason ?? "no recorded gap"})`)
    }
    const target = this.targetOf(request, view)
    if (!target.ok) {
      await this.record(snapshot, "range", request, "not_retrievable")
      return this.spanOf(snapshot, id, request, view.stream, view, "not_retrievable", target.reason)
    }
    const bytes = view.bytes
    const pieces = intersectAll(target.fromByte, target.toByte, view.state.coverage)
    if (pieces.length === 0) {
      await this.record(snapshot, "range", request, "missing_tail")
      return this.spanOf(snapshot, id, request, view.stream, view, "missing_tail", `the requested span lies past retained coverage: the store holds ${describeRanges(view.state.coverage)} of the ${view.state.originalBytes} bytes it received`)
    }
    // A served page can be made of more than one retained piece; each piece is taken whole or cut at the bound.
    const pagePieces: ByteRange[] = []
    let used = 0
    let pageCut = false
    for (const piece of pieces) {
      if (MAX_RETRIEVED_PAGE_CHARS - used <= 0) { pageCut = true; break }
      const end = cutToPage(bytes, piece.fromByte, piece.toByte, MAX_RETRIEVED_PAGE_CHARS - used)
      pagePieces.push({ fromByte: piece.fromByte, toByte: end })
      used += bytes.subarray(piece.fromByte, end).toString("utf8").length
      if (end < piece.toByte) { pageCut = true; break }
    }
    const firstServed = pagePieces[0]
    const lastServed = pagePieces[pagePieces.length - 1]
    const raw = pagePieces.map((piece) => bytes.subarray(piece.fromByte, piece.toByte).toString("utf8")).join("")
    const lineFamily = target.family === "lines" || target.family === "chars"
    // A request that names lines answers with those lines: the separator after the last one is not part of the text.
    const servedText = lineFamily && raw.endsWith("\n") ? raw.slice(0, -1) : raw
    const presented = redactEvidence(servedText)
    if (reading.reading.policy.redactionMode === "exclude_raw_secrets" && presented !== servedText) {
      await this.record(snapshot, "range", request, "not_retrievable")
      return this.spanOf(snapshot, id, request, view.stream, view, "not_retrievable", `the stored bytes hold a raw secret this policy withholds from retrieval, so the text is not returned; coverage stops at byte ${lastServed.toByte}`, { fromByte: firstServed.fromByte, toByte: lastServed.toByte })
    }
    const servedBytes = pagePieces.reduce((sum, piece) => sum + (piece.toByte - piece.fromByte), 0)
    const state: RetrievalState = pageCut ? "partial_prefix" : servedBytes === target.toByte - target.fromByte ? "retained" : "missing_tail"
    const notes: string[] = []
    if (pageCut) notes.push(`the result is larger than its own bound of ${MAX_RETRIEVED_PAGE_CHARS} characters, so this page stops at byte ${lastServed.toByte}`)
    if (servedText !== raw) notes.push("the text is the requested lines without the separator after the last one; the coverage named is the byte span those lines occupy")
    if (view.state.bytePreservation === "normalized") notes.push("the stored bytes are a normalized copy, not the bytes as produced, so byte offsets count the copy")
    if (view.state.encoding !== "utf8") notes.push("the text is a decoding of these bytes, not the bytes themselves")
    if (view.mergedFrom !== undefined) notes.push("this is a merged presentation, ordered by recorded chunk arrival; the ranges below are in the merged view, not in one stored byte object")
    const span = this.spanOf(snapshot, id, request, view.stream, view, state, notes.length > 0 ? notes.join("; ") : undefined, { fromByte: firstServed.fromByte, toByte: lastServed.toByte })
    if (pagePieces.length > 1) span.servedRanges = pagePieces
    if (target.family === "lines" || target.family === "chars") {
      const firstLine = this.lineRowAt(view, target.fromByte)
      const lastLine = this.lineRowAt(view, Math.max(target.fromByte, lastServed.toByte - 1))
      if (firstLine !== undefined && lastLine !== undefined) span.coverage = { fromLine: firstLine.line_no, toLine: lastLine.line_no, fromByte: firstServed.fromByte, toByte: lastServed.toByte }
    }
    span.text = presented
    if (presented !== servedText) span.redactionApplied = true
    if (pageCut) span.continuation = { nextByte: lastServed.toByte, cursor: cursorOf(view.stream, lastServed.toByte, pageKey(request)) }
    await this.record(snapshot, "range", request, state)
    if (await this.labelled(snapshot)) span.historical = true
    return span
  }

  /** Literal and optional regex search over retained output. Zero matches is a successful result. */
  async search(observationId: string, request: SearchRequest): Promise<SearchPage> {
    const mode: SearchMode = request.mode ?? "literal"
    const limit = Math.max(1, Math.min(request.limit ?? MAX_SEARCH_MATCHES, MAX_SEARCH_MATCHES))
    const context = Math.max(0, Math.min(request.contextLines ?? 0, MAX_SEARCH_CONTEXT_LINES))
    const snapshot = await this.snapshot(observationId)
    if (!snapshot.observation) return { observationId, query: request.query, mode, stream: request.stream ?? "output", matchCount: 0, matches: [], state: "not_retrievable", reason: "no observation with that identity is readable from this project" }
    const id = snapshot.observation.id
    const decision = this.decide(snapshot)
    if (!decision.ok) {
      await this.record(snapshot, "search", request, "denied")
      return this.pageOf(id, request, mode, request.stream ?? "output", [], "not_retrievable", decision.reason, 0, limit, context)
    }
    const reading = await this.policySource.effective()
    if (reading.state === "invalid") {
      await this.record(snapshot, "search", request, "not_retrievable")
      return this.pageOf(id, request, mode, request.stream ?? "output", [], "not_retrievable", `the storage policy ${reading.reason}`, 0, limit, context)
    }
    const served = this.serveStream(snapshot, request.stream, false)
    if (!served.ok) {
      await this.record(snapshot, "search", request, "not_retrievable")
      return this.pageOf(id, request, mode, served.stream, [], "not_retrievable", `${served.reason}, so no match count can be claimed`, 0, limit, context)
    }
    const view = served.view
    if (view.state.storageComplete === "evicted") {
      await this.record(snapshot, "search", request, "evicted")
      return this.pageOf(id, request, mode, view.stream, [], "evicted", `the bytes for this stream were evicted at ${view.evictedAt ?? "an unrecorded time"}; no search ran over them`, 0, limit, context)
    }
    if (!view.bytes) {
      const state: RetrievalState = view.blobDigest !== undefined ? "unknown_content" : "not_retrievable"
      await this.record(snapshot, "search", request, state)
      return this.pageOf(id, request, mode, view.stream, [], state, `${view.unreadable ?? `nothing was retained for this stream (${view.state.gapReason ?? "no recorded gap"})`}, so no match count can be claimed`, 0, limit, context)
    }
    const key = pageKey(request)
    if (request.cursor !== undefined) {
      const position = readCursor(request.cursor, key)
      if (position === undefined || position.stream !== view.stream) {
        await this.record(snapshot, "search", request, "not_retrievable")
        return this.pageOf(id, request, mode, view.stream, [], "not_retrievable", `the cursor does not belong to this request; it names ${(request.cursor ?? "").slice(0, 120)}`, 0, limit, context)
      }
    }
    const from = request.cursor === undefined ? 0 : (readCursor(request.cursor, key) as { stream: ResultStream; byte: number }).byte
    const pattern = this.patternFor(mode, request.query, view)
    if (!pattern.ok) {
      await this.record(snapshot, "search", request, "not_retrievable")
      return this.pageOf(id, request, mode, view.stream, [], "not_retrievable", pattern.reason, 0, limit, context)
    }
    const scanned = Math.min(view.bytes.length, MAX_SEARCH_SCAN_BYTES)
    const withholdsSecrets = reading.reading.policy.redactionMode === "exclude_raw_secrets"
    const matches: SearchPage["matches"] = []
    let used = 0
    let pageCut = false
    let lastByte = from
    let position = from
    while (position < scanned && matches.length < limit) {
      const found = pattern.find(view.bytes, position, scanned)
      if (found === undefined) break
      const row = this.lineRowAt(view, found.fromByte)
      const rawText = (row !== undefined ? view.bytes.subarray(row.byte_start, row.byte_end) : view.bytes.subarray(found.fromByte, found.toByte)).toString("utf8").replace(/\n$/, "")
      const full = redactEvidence(rawText)
      const shown = full.slice(0, SEARCH_PREVIEW_CHARS)
      const withheld = withholdsSecrets && full !== rawText
      if (used + shown.length + 1 > MAX_RETRIEVED_PAGE_CHARS) { pageCut = true; break }
      used += shown.length + 1
      const entry: SearchPage["matches"][number] = { ...(row === undefined ? {} : { line: row.line_no }), byte: found.fromByte, preview: withheld ? "" : shown }
      if (withheld) entry.withheld = true
      if (context > 0 && row !== undefined) {
        entry.context = view.lines
          .filter((near) => near.line_no > row.line_no - context && near.line_no < row.line_no + context && near.line_no !== row.line_no)
          .sort((left, right) => left.line_no - right.line_no)
          .map((near) => redactEvidence(view.bytes!.subarray(near.byte_start, near.byte_end).toString("utf8")).replace(/\n$/, "").slice(0, SEARCH_PREVIEW_CHARS))
      }
      matches.push(entry)
      lastByte = found.toByte
      position = found.toByte
    }
    const outOfScanBound = scanned < view.bytes.length
    const outOfMatchBound = matches.length >= limit
    const outOfPageBound = pageCut
    const state: RetrievalState = scanned === 0 && matches.length === 0 ? "unknown_content" : outOfScanBound || outOfMatchBound || outOfPageBound ? "partial_prefix" : "retained"
    const notes: string[] = []
    if (state === "partial_prefix") notes.push(`the count covers only the ${matches.length} matches in the ${scanned} bytes this bounded scan reached, not the whole output`)
    else if (matches.length === 0) notes.push(`zero matches across the ${scanned} bytes scanned is a successful result, not a failure`)
    const page = this.pageOf(id, request, mode, view.stream, matches, state, notes.length > 0 ? notes.join("; ") : undefined, scanned, limit, context)
    if (state === "partial_prefix") page.cursor = cursorOf(view.stream, lastByte, key)
    await this.record(snapshot, "search", request, state)
    if (await this.labelled(snapshot)) page.historical = true
    return page
  }

  /** Filter within the scope this service was given: bounded, ordered by `(created_at, rowid)`, continuable. */
  async find(filter: EvidenceFilter): Promise<EvidenceMatch[]> {
    if (!this.scope.projectId) return []
    // A filter that names another project is refused as a whole; it names nothing this caller cannot name.
    if (filter.project !== undefined && filter.project !== this.scope.projectId) return []
    const reading = await this.policySource.effective()
    if (reading.state === "invalid") return []
    const limit = Math.max(1, Math.min(filter.limit ?? DEFAULT_FILTER_LIMIT, MAX_FILTER_RESULTS))
    const key = pageKey(filter)
    const conditions: string[] = ["observations.project_id = ?"]
    const values: SqlValue[] = [this.scope.projectId]
    const location = filter.path === undefined || filter.path.trim() === "" ? undefined : this.scope.roots.fromCanonical(filter.path.trim())
    if (location !== undefined) {
      if (!this.mayRead(location.rootId)) return []
      conditions.push("EXISTS (SELECT 1 FROM observation_source AS source WHERE source.observation_id = observations.id AND source.root_id = ? AND source.path = ?)")
      values.push(location.rootId, location.path)
    }
    if (filter.contentHash !== undefined) { conditions.push("EXISTS (SELECT 1 FROM observation_source AS source WHERE source.observation_id = observations.id AND source.content_hash = ?)"); values.push(filter.contentHash.trim()) }
    if (filter.toolName !== undefined) { conditions.push("observations.tool_name = ?"); values.push(filter.toolName.trim()) }
    if (filter.status !== undefined) { conditions.push("outcome.status = ?"); values.push(filter.status.trim()) }
    if (filter.failed !== undefined) { conditions.push("observations.failed = ?"); values.push(filter.failed ? 1 : 0) }
    if (filter.executed !== undefined) { conditions.push("observations.executed = ?"); values.push(filter.executed ? 1 : 0) }
    if (filter.executionId !== undefined) { conditions.push("(observations.execution_id = ? OR outcome.execution_ref = ?)"); values.push(filter.executionId.trim(), filter.executionId.trim()) }
    if (filter.since !== undefined) {
      if (!isIso(filter.since)) return []
      conditions.push("observations.created_at >= ?")
      values.push(filter.since)
    }
    if (filter.until !== undefined) {
      if (!isIso(filter.until)) return []
      conditions.push("observations.created_at <= ?")
      values.push(filter.until)
    }
    if (filter.cursor !== undefined) {
      const rowid = readFindCursor(filter.cursor, key)
      if (rowid === undefined) return []
      conditions.push("observations.rowid > ?")
      values.push(rowid)
    }
    const found = await this.sqlite.read((database) => rows<{ id: string; rowid: number }>(database, `SELECT observations.id, observations.rowid FROM todo_tool_observations AS observations LEFT JOIN evidence_outcomes AS outcome ON outcome.observation_id = observations.id WHERE ${conditions.join(" AND ")} ORDER BY observations.created_at, observations.rowid LIMIT ${limit}`, values))
    const matches: EvidenceMatch[] = []
    for (const row of found) {
      const snapshot = await this.snapshot(row.id)
      if (!snapshot.observation || !this.decide(snapshot).ok) continue
      const named = snapshot.references.find((reference) => this.mayRead(reference.root_id))
      // The same path rule the evidence boundary uses: a reference is named only when it is inside what this caller may read.
      if (location !== undefined && (named === undefined || !samePath(this.canonicalOf(named), filter.path!.trim()))) continue
      const state = this.findState(snapshot)
      const match: EvidenceMatch = {
        observationId: snapshot.observation.id,
        toolName: snapshot.observation.tool_name,
        observedAt: snapshot.observation.created_at,
        status: snapshot.outcome?.status ?? "unknown",
        failed: snapshot.observation.failed === 1,
        executed: snapshot.observation.executed === 1,
        state
      }
      if (named !== undefined) match.path = this.canonicalOf(named)
      const hash = this.originalHashOf(snapshot)
      if (hash !== undefined) match.contentHash = hash
      if (snapshot.observation.exit_code !== null) match.exitCode = snapshot.observation.exit_code
      if (snapshot.outcome) {
        match.completeness = { captured: snapshot.outcome.capturedComplete, stored: snapshot.outcome.storageComplete }
        match.streams = [...snapshot.streams.values()].map((view) => ({ stream: view.stream, coverage: view.state.coverage }))
      }
      if (await this.labelled(snapshot)) match.historical = true
      matches.push(match)
      await this.record(snapshot, "find", filter, state)
    }
    const last = found[found.length - 1]
    if (matches.length > 0 && last !== undefined && found.length >= limit) matches[matches.length - 1].cursor = findCursorOf(last.rowid, key)
    return matches
  }

  /** One read: the rows Stage 1 wrote for this observation, plus the bytes those rows point at. */
  private async snapshot(observationId: string, alias?: string): Promise<Snapshot> {
    return this.sqlite.read((database) => {
      const observation = this.resolve(database, observationId, alias)
      if (!observation) return { observation: undefined, references: [], streams: new Map<ResultStream, StreamView>() }
      const outcome = storedOutcomeForObservation(database, this.scope.projectId, observation.id)
      const references = rows<ReferenceRow>(database, "SELECT root_id, path, role, content_hash, observed_version FROM observation_source WHERE observation_id = ? ORDER BY ordinal", [observation.id])
      const streams = new Map<ResultStream, StreamView>()
      for (const state of outcome === undefined ? [] : outcome.streams) {
        const view: StreamView = { stream: state.stream, state, storedBytes: state.storedBytes, lines: [], chunks: [], indexBounded: outcome?.lineIndex.bounded === true }
        if (state.blobId) {
          const blob = rows<BlobRow>(database, "SELECT id, content_digest, storage_kind, relative_path, inline_bytes, stored_bytes, evicted_at FROM evidence_blobs WHERE id = ?", [state.blobId])[0]
          if (blob) {
            view.blobDigest = blob.content_digest
            if (blob.evicted_at !== null) view.evictedAt = blob.evicted_at
            else {
              const read = this.bytesOf(blob)
              if ("bytes" in read) view.bytes = read.bytes
              else view.unreadable = read.reason
            }
            view.lines = rows<LineRow>(database, "SELECT line_no, char_start, char_end, byte_start, byte_end FROM evidence_lines WHERE blob_id = ? ORDER BY line_no", [blob.id])
          }
        }
        if (outcome) view.chunks = rows<ChunkRow>(database, "SELECT seq, byte_start, byte_end, received_at FROM evidence_chunks WHERE outcome_id = ? AND stream = ? ORDER BY seq", [outcome.outcomeId, state.stream])
        streams.set(state.stream, view)
      }
      return { observation, outcome, references, streams }
    })
  }

  private resolve(database: Database, observationId: string, alias?: string): ObservationRow | undefined {
    if (!this.scope.projectId) return undefined
    const wanted = observationId.trim()
    const byId = rows<ObservationRow>(database, "SELECT * FROM todo_tool_observations WHERE project_id = ? AND id = ?", [this.scope.projectId, wanted])[0]
    if (byId) return byId
    const byRequest = rows<ObservationRow>(database, "SELECT * FROM todo_tool_observations WHERE project_id = ? AND request_id = ?", [this.scope.projectId, wanted])[0]
    if (byRequest) return byRequest
    if (!alias) return undefined
    const named = alias.trim()
    return rows<ObservationRow>(database, "SELECT * FROM todo_tool_observations WHERE project_id = ? AND (id = ? OR request_id = ?)", [this.scope.projectId, named, named])[0]
  }

  /** Project, host and roots, decided before any content is read. */
  private decide(snapshot: Snapshot): { ok: true } | { ok: false; reason: string } {
    const observation = snapshot.observation!
    if (observation.project_id !== this.scope.projectId) return { ok: false, reason: "the lookup is decided inside one project, and this record belongs to another" }
    if (this.scope.hostKey && observation.host_key && observation.host_key !== this.scope.hostKey) return { ok: false, reason: "the observation was recorded on a different extension host" }
    if (snapshot.references.length > 0 && !snapshot.references.some((reference) => this.mayRead(reference.root_id))) return { ok: false, reason: "no source reference this observation recorded is inside what this caller may read" }
    return { ok: true }
  }

  private mayRead(rootId: string): boolean {
    const root = this.scope.roots.byId(rootId)
    if (!root) return false
    if (this.scope.authorized) return this.scope.authorized(root)
    // The default is the project's own home. Anything outside it needs a grant from the editor, which this service never holds.
    return isWithin(this.home, root.locator)
  }

  private canonicalOf(reference: ReferenceRow): string {
    return this.scope.roots.canonicalPath({ rootId: reference.root_id, path: reference.path })
  }

  /** The fingerprint as it was observed: the recorded source hash, or the digest of the bytes as stored. */
  private originalHashOf(snapshot: Snapshot): string | undefined {
    const recorded = snapshot.references.find((reference) => reference.content_hash !== null && this.mayRead(reference.root_id))
    if (recorded) return recorded.content_hash ?? undefined
    const stored = [...snapshot.streams.values()].find((view) => view.blobDigest !== undefined)
    return stored === undefined ? undefined : `sha256:${stored.blobDigest}`
  }

  /** Labelling only. The boundary says whether the recorded source still matches; the content served is what was stored. */
  private async labelled(snapshot: Snapshot): Promise<boolean> {
    if (this.boundary === undefined) return false
    for (const reference of snapshot.references) {
      if (reference.content_hash === null || !this.mayRead(reference.root_id)) continue
      const checked = await this.boundary.check({ path: this.canonicalOf(reference), role: reference.role as SourceRole, contentHash: reference.content_hash, observedVersion: reference.observed_version as ObservedVersion })
      if (checked.validity === "stale") return true
    }
    return false
  }

  /** The retrieval itself is an event: arguments and outcome, no copy of the bytes it read. */
  private async record(snapshot: Snapshot, operation: "get" | "range" | "search" | "find", args: object, outcome: string): Promise<void> {
    if (!snapshot.observation) return
    const observationId = snapshot.observation.id
    const project = this.scope.projectId
    await this.sqlite.write((database) => {
      // `execution_id` stays unset: a retrieval runs nothing, and no identity is invented for it.
      execute(database, "INSERT INTO evidence_access_events(id, project_id, observation_id, operation, arguments_json, outcome, execution_id, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)", [randomUUID(), project, observationId, operation, JSON.stringify(args), outcome, new Date().toISOString()])
    })
  }

  /** Which stream a request is answered from. A merged presentation is only offered where chunk order allows it. */
  private serveStream(snapshot: Snapshot, requested: ResultStream | undefined, mergesAllowed: boolean): { ok: true; view: StreamView } | { ok: false; stream: ResultStream; reason: string } {
    const views = [...snapshot.streams.values()]
    if (requested === undefined || requested === "output") {
      if (views.length === 1) return { ok: true, view: views[0] }
      const terminal = views.find((view) => view.stream === "terminal")
      if (terminal !== undefined) return { ok: true, view: terminal }
      if (views.length === 0) return { ok: false, stream: "output", reason: `nothing was retained for this result (${snapshot.outcome?.gapReason ?? "no recorded gap"}): no bytes arrived on it, so no content can be served` }
      return { ok: false, stream: "output", reason: `the request names no stream, and this result recorded ${views.map((view) => view.stream).join(", ")} separately with no captured transcript to answer from` }
    }
    const view = views.find((entry) => entry.stream === requested)
    if (view !== undefined) return { ok: true, view }
    if (requested === "terminal") {
      if (!mergesAllowed) return { ok: false, stream: "terminal", reason: "no merged transcript was captured, and a merged presentation is not searched; each stream can be read on its own" }
      const merged = this.mergedView(snapshot)
      if (merged === undefined) return { ok: false, stream: "terminal", reason: "no merged transcript was captured, and the recorded chunk order does not allow one; each stream can be read on its own" }
      return { ok: true, view: merged }
    }
    return { ok: false, stream: requested, reason: `nothing was recorded for stream ${requested}` }
  }

  /** A merged view exists only where every contributing stream has a chunk order that can be ordered without a tie. */
  private mergedView(snapshot: Snapshot): StreamView | undefined {
    const views = [...snapshot.streams.values()].filter((view) => view.chunks.length > 0 && view.bytes !== undefined)
    if (views.length < 2) return undefined
    const entries = views.flatMap((view) => view.chunks.map((chunk) => ({ stream: view.stream, seq: chunk.seq, receivedAt: chunk.received_at, bytes: view.bytes as Buffer })))
    entries.sort((left, right) => left.receivedAt < right.receivedAt ? -1 : left.receivedAt > right.receivedAt ? 1 : left.seq - right.seq || STREAM_NAMES.indexOf(left.stream) - STREAM_NAMES.indexOf(right.stream))
    for (let index = 1; index < entries.length; index += 1) {
      if (entries[index - 1].receivedAt === entries[index].receivedAt && entries[index - 1].seq === entries[index].seq) return undefined
    }
    let bytes = Buffer.alloc(0)
    const coverage: ByteRange[] = []
    const mergedFrom: { stream: ResultStream; coverage: ByteRange[] }[] = []
    for (const entry of entries) {
      const range = { fromByte: coverage.length === 0 ? 0 : coverage[coverage.length - 1].toByte, toByte: 0 }
      bytes = Buffer.concat([bytes, entry.bytes])
      range.toByte = bytes.length
      coverage.push(range)
      const named = mergedFrom.find((source) => source.stream === entry.stream)
      if (named) named.coverage.push(range)
      else mergedFrom.push({ stream: entry.stream, coverage: [range] })
    }
    const base = views[0]
    return { stream: "terminal", state: { ...base.state, coverage }, bytes, storedBytes: bytes.length, lines: lineRunsOf(bytes, MAX_INDEXED_LINES), chunks: [], indexBounded: false, mergedFrom }
  }

  private bytesOf(blob: BlobRow): { bytes: Buffer } | { reason: string } {
    if (blob.storage_kind === "inline") {
      if (blob.inline_bytes === null) return { reason: "the row names no bytes" }
      return { bytes: blob.inline_bytes }
    }
    const file = path.join(this.blobsDirectory, blob.relative_path ?? "")
    try {
      const bytes = fsSync.readFileSync(file)
      if (digestOf(bytes) !== blob.content_digest) return { reason: `the bytes at ${blob.relative_path} no longer match the digest the row claims, so this content cannot be verified` }
      return { bytes }
    } catch (error) {
      return { reason: `the byte object at ${blob.relative_path} could not be read: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  private targetOf(request: RangeRequest, view: StreamView): Target {
    const chars = request.startChar !== undefined || request.endChar !== undefined
    const bytes = request.startByte !== undefined || request.endByte !== undefined
    // A fragment is one line plus character offsets inside it, so a line named with chars is the char family, not two.
    const lines = !chars && !bytes && (request.startLine !== undefined || request.endLine !== undefined)
    if ([lines, chars, bytes].filter(Boolean).length > 1) return { ok: false, reason: "a range names one coordinate family at a time; this request names lines, characters and stored bytes together" }
    if (bytes) {
      if (!Number.isSafeInteger(request.startByte) || (request.startByte as number) < 0) return { ok: false, reason: "byte offsets are zero-based whole numbers" }
      const end = request.endByte
      if (end !== undefined && (!Number.isSafeInteger(end) || end <= (request.startByte as number))) return { ok: false, reason: "a byte range is half-open [start,end), so end_byte must be greater than start_byte" }
      if (view.mergedFrom !== undefined) return { ok: false, reason: "byte offsets count stored bytes of one stream; a merged presentation has no single byte object" }
      return { ok: true, family: "bytes", fromByte: request.startByte as number, toByte: end ?? view.storedBytes }
    }
    if (chars) {
      if (view.mergedFrom !== undefined) return { ok: false, reason: "character offsets count code units inside one stored line; a merged presentation has no single line index" }
      if (request.endLine !== undefined && request.endLine !== request.startLine) return { ok: false, reason: "character offsets count code units from the start of one line, so end_line must name the same line as start_line" }
      const line = view.lines.find((row) => row.line_no === request.startLine)
      if (line === undefined) return { ok: false, reason: "character offsets count code units from the start of one line, so a line must be named with them" }
      if (view.state.encoding !== "utf8") return { ok: false, reason: `these bytes are ${view.state.encoding}, so decoded character positions cannot be mapped back to stored bytes; use byte offsets` }
      const start = request.startChar as number
      if (!Number.isSafeInteger(start) || start < 1 || start > line.char_end) return { ok: false, reason: `start_char ${start} is past character ${line.char_end} on line ${line.line_no}` }
      const end = Math.min(request.endChar ?? Math.min(line.char_end, start + MAX_LINE_FRAGMENT_CHARS - 1), line.char_end)
      const text = view.bytes === undefined ? "" : view.bytes.subarray(line.byte_start, line.byte_end).toString("utf8").replace(/\n$/, "")
      return { ok: true, family: "chars", fromByte: line.byte_start + Buffer.byteLength(text.slice(0, start - 1)), toByte: line.byte_start + Buffer.byteLength(text.slice(0, end)) }
    }
    if (lines) {
      const start = request.startLine
      if (start === undefined || !Number.isSafeInteger(start) || start < 1) return { ok: false, reason: "line numbers are 1-based whole numbers, so start_line must name one" }
      const end = request.endLine ?? start
      if (!Number.isSafeInteger(end) || end < start) return { ok: false, reason: "a line range is inclusive, so end_line must be at least start_line" }
      if (view.indexBounded && end > view.lines.length) return { ok: false, reason: `the line index stops at ${view.lines.length} lines of the stored content; byte offsets still reach what the store holds` }
      const first = view.lines.find((row) => row.line_no === start)
      const last = view.lines.find((row) => row.line_no === end)
      if (first === undefined || last === undefined) return { ok: false, reason: `line ${end} is not in the stored line index` }
      return { ok: true, family: "lines", fromByte: first.byte_start, toByte: last.byte_end }
    }
    const whole = view.lines.length > 0 ? view.lines[view.lines.length - 1].byte_end : view.storedBytes
    return { ok: true, family: "whole", fromByte: 0, toByte: whole }
  }

  private lineRowAt(view: StreamView, byte: number): LineRow | undefined {
    return view.lines.find((row) => byte >= row.byte_start && byte < row.byte_end)
  }

  private patternFor(mode: SearchMode, query: string, view: StreamView): Pattern {
    if (!query) return { ok: false, reason: "the search names no query" }
    if (mode === "literal") {
      // Byte-exact where the bytes are not decodable text; the tool's own rule otherwise, so a lowercase query reads any case.
      if (view.state.encoding !== "utf8") return { ok: true, find: byteFinder(Buffer.from(query, "utf8")) }
      return { ok: true, find: textFinder(new RegExp(escapeLiteral(query), query === query.toLowerCase() ? "i" : "")) }
    }
    if (view.state.encoding !== "utf8") return { ok: false, reason: `a regex runs over decoded text and these bytes are ${view.state.encoding}; the search was not run` }
    let pattern: RegExp
    try {
      pattern = new RegExp(query, query === query.toLowerCase() ? "i" : "")
    } catch (error) {
      return { ok: false, reason: `the regex does not compile: ${error instanceof Error ? error.message : String(error)}` }
    }
    return { ok: true, find: textFinder(pattern) }
  }

  private findState(snapshot: Snapshot): RetrievalState {
    const views = [...snapshot.streams.values()]
    if (views.some((view) => view.state.storageComplete === "evicted")) return "evicted"
    if (views.some((view) => view.unreadable !== undefined)) return "unknown_content"
    if (views.length === 0 || views.every((view) => view.state.storageComplete === "inaccessible")) return "not_retrievable"
    if (views.some((view) => view.state.storageComplete === "partial")) return "missing_tail"
    return "retained"
  }

  /** What every result reports: what was measured, what the store can name, and no coverage it does not have. */
  private spanOf(snapshot: Snapshot, observationId: string, request: RangeRequest, stream: ResultStream, view: StreamView | undefined, state: RetrievalState, reason: string | undefined, served?: ByteRange): RetrievedSpan {
    const coverage: SpanCoverage = served === undefined ? { fromByte: 0, toByte: 0 } : { fromByte: served.fromByte, toByte: served.toByte }
    if (served === undefined && view !== undefined && view.state.coverage.length > 0) {
      coverage.fromByte = view.state.coverage[0].fromByte
      coverage.toByte = view.state.coverage[view.state.coverage.length - 1].toByte
    }
    const span: RetrievedSpan = { observationId, stream, requested: request, coverage, state }
    if (view !== undefined) {
      span.completeness = { captured: view.state.capturedComplete, stored: view.state.storageComplete }
      span.encoding = view.state.encoding
      span.bytePreservation = view.state.bytePreservation
      if (view.mergedFrom !== undefined) span.mergedFrom = view.mergedFrom
    } else if (snapshot.outcome !== undefined) {
      span.completeness = { captured: snapshot.outcome.capturedComplete, stored: snapshot.outcome.storageComplete }
    }
    const hash = this.originalHashOf(snapshot)
    if (hash !== undefined) span.originalHash = hash
    if (snapshot.observation !== undefined) span.provenance = this.provenanceOf(snapshot)
    if (reason !== undefined) span.reason = reason
    if (view !== undefined && view.mergedFrom !== undefined) span.coordinates = "merged_view"
    return span
  }

  private pageOf(observationId: string, request: SearchRequest, mode: SearchMode, stream: ResultStream, matches: SearchPage["matches"], state: RetrievalState, reason: string | undefined, scanned: number, limit: number, context: number): SearchPage {
    const page: SearchPage = { observationId, query: request.query, mode, stream, matchCount: matches.length, matches, state }
    if (context > 0) page.contextLines = context
    if (reason !== undefined) page.reason = reason
    if (scanned > 0 || state === "partial_prefix") {
      page.scannedBytes = scanned
      page.matchLimit = limit
    }
    return page
  }

  private provenanceOf(snapshot: Snapshot): RetrievedSpan["provenance"] {
    const observation = snapshot.observation!
    const named = snapshot.references.find((reference) => this.mayRead(reference.root_id))
    return { toolName: observation.tool_name, ...(named === undefined ? {} : { path: this.canonicalOf(named) }), observedAt: observation.created_at, ...(observation.execution_id === null ? {} : { executionId: observation.execution_id }) }
  }
}