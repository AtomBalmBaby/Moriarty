/**
 * The model's one read-only window onto what the store already holds: `query_evidence`, answering through
 * Stage 2's §4.3 service. It reads recorded bytes and never re-reads a source or re-runs a command, so a
 * stored result stays the account of what was observed at the time it was made.
 *
 * The model-facing copy is sparse (§4.7, Rule 4): a complete, unexceptional short result stays plain text,
 * and an envelope is written only where integrity, status or retrieval semantics require one. A value with a
 * well-known default is not written; a state that has no default always is. Nothing here grants anything:
 * project, host key and roots are decided by the service before any content is read, a known observation id
 * or a matching fingerprint conveys no permission (Rule 7), and no result claims coverage the store does not
 * have or content it cannot serve (Rule 6). The fingerprint reported is the one as it was observed, never a
 * current one (Rule 3).
 *
 * This file owns Stage 3's envelope shape. It changes no frozen contract: §4.2 fields keep their meaning,
 * and §4.3 stays the service this tool only calls.
 */
import type { ResultStream } from "../../common/types"
import type { ByteRange, EvidenceAccess, EvidenceFilter, RetrievalState, RetrievedSpan, SearchPage, SpanCoverage } from "../todos/types"

import { argumentFailure, type ArgumentReader, argumentReader, describeValue, ToolArgumentError } from "./arguments"
import type { ToolCall } from "./protocol"
import type { Tool, ToolResult, WorkspaceTools } from "./workspace"

/** The tool's name. It is only ever recommended when it is registered, so a message cannot invent it. */
export const QUERY_EVIDENCE_TOOL = "query_evidence"

/** §4.7: a complete, unexceptional short result stays plain text. Past the presentation budget the delivery has to be stated. */
const PLAIN_RESULT_CHARS = 1200

const OPERATIONS = ["get", "range", "search", "find"]
const SEARCH_MODES = ["literal", "regex"]
const STREAMS = ["stdout", "stderr", "terminal", "payload", "output"]

/** Rule 4: what a default would say is not written. A state has no default, so it is never dropped. */
const sparse = (value: Record<string, unknown>): Record<string, unknown> => {
  const kept: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined || item === null) continue
    if (Array.isArray(item) && item.length === 0) continue
    if (typeof item === "object" && !Array.isArray(item) && Object.keys(item as object).length === 0) continue
    kept[key] = item
  }
  return kept
}

const rangesOf = (ranges: ByteRange[]): { from_byte: number; to_byte: number }[] =>
  ranges.map((range) => ({ from_byte: range.fromByte, to_byte: range.toByte }))

const coverageOf = (coverage: SpanCoverage): Record<string, unknown> => sparse({
  from_line: coverage.fromLine,
  to_line: coverage.toLine,
  from_byte: coverage.fromByte,
  to_byte: coverage.toByte
})

const provenanceOf = (provenance?: RetrievedSpan["provenance"]): Record<string, unknown> => sparse({
  tool: provenance?.toolName,
  path: provenance?.path,
  observed_at: provenance?.observedAt,
  execution_id: provenance?.executionId
})

/** A whole number as the tool declares it, with its own lower bound. A byte offset counts from 0. */
const wholeNumber = (a: ArgumentReader, name: string, minimum: number, phrasing: string): number | undefined => {
  const value = a.number(name)
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new ToolArgumentError(argumentFailure("invalid_range", `${QUERY_EVIDENCE_TOOL}: ${name} must be ${phrasing}, got "${describeValue(value)}".`, {
      required_argument: name,
      recovery: `Send ${name} as ${phrasing}.`
    }))
  }
  return value
}

const choiceOf = (a: ArgumentReader, name: string, allowed: string[], fallback: string | undefined): string => {
  const value = a.text(name)?.trim()
  if (value === undefined || value === "") return fallback ?? ""
  if (!allowed.includes(value)) {
    throw new ToolArgumentError(argumentFailure("invalid_argument_type", `${QUERY_EVIDENCE_TOOL}: ${name} must be one of ${allowed.join(", ")}, got "${value}".`, {
      required_argument: name,
      recovery: `Send ${name} as one of ${allowed.join(", ")}, or leave it out.`
    }))
  }
  return value
}

const isIso = (value: string): boolean => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value)

/** What the call asks for, from what it sent: a query is a search, coordinates are a range, no id is a filter. */
const operationOf = (a: ArgumentReader): string => {
  const named = choiceOf(a, "operation", OPERATIONS, undefined)
  if (named) return named
  if (a.text("query")?.trim()) return "search"
  if (["start_line", "end_line", "start_char", "end_char", "start_byte", "end_byte"].some((name) => a.sent(name))) return "range"
  if (!a.text("observation_id")?.trim()) return "find"
  return "get"
}

/** A page is plain text only when there is nothing else to say about it (Rule 4). */
const staysPlain = (span: RetrievedSpan): boolean =>
  span.state === "retained" && !span.redactionApplied && !span.historical &&
  span.continuation === undefined && (span.text?.length ?? 0) <= PLAIN_RESULT_CHARS

/** What the store still holds for this observation, per stream, for a delivery that is not whole. */
const retainedCoverageOf = async (access: EvidenceAccess, observationId: string): Promise<Record<string, unknown> | undefined> => {
  const record = await access.get(observationId)
  if (record.access !== "found" || record.streams === undefined) return undefined
  return sparse({
    streams: record.streams.map((state) => sparse({ stream: state.stream, coverage: rangesOf(state.coverage) })),
    line_index: record.lineIndex === undefined ? undefined : sparse({ lines: record.lineIndex.lines, bounded: record.lineIndex.bounded })
  })
}

const rangeResult = async (access: EvidenceAccess, span: RetrievedSpan): Promise<ToolResult> => {
  const served = span.text ?? ""
  if (staysPlain(span)) {
    const note = span.reason === undefined ? "" : "\n" + span.reason
    return { output: `${served}${note}`, summary: `${QUERY_EVIDENCE_TOOL} · ${span.provenance?.toolName ?? "recorded result"} answered from stored content`, observationId: span.observationId }
  }
  const retained = span.state === "retained" ? undefined : await retainedCoverageOf(access, span.observationId)
  const value = sparse({
    operation: "range",
    state: span.state,
    stream: span.stream,
    coverage: coverageOf(span.coverage),
    served_ranges: span.servedRanges === undefined ? undefined : rangesOf(span.servedRanges),
    text: served || undefined,
    retained,
    completeness: span.completeness,
    original_hash: span.originalHash,
    provenance: provenanceOf(span.provenance),
    continuation: span.continuation === undefined ? undefined : sparse({ next_byte: span.continuation.nextByte, cursor: span.continuation.cursor }),
    historical: span.historical,
    redaction_applied: span.redactionApplied,
    encoding: span.encoding,
    byte_preservation: span.bytePreservation,
    coordinates: span.coordinates,
    merged_from: span.mergedFrom === undefined ? undefined : span.mergedFrom.map((from) => ({ stream: from.stream, coverage: rangesOf(from.coverage) })),
    reason: span.reason
  })
  return { output: JSON.stringify(value), summary: `${QUERY_EVIDENCE_TOOL} · ${span.state} · ${span.stream}`, observationId: span.observationId }
}

const searchResult = (page: SearchPage): ToolResult => {
  const value = sparse({
    operation: "search",
    state: page.state,
    stream: page.stream,
    query: page.query,
    mode: page.mode,
    match_count: page.matchCount,
    matches: page.matches.map((match) => sparse({
      line: match.line,
      byte: match.byte,
      preview: match.preview || undefined,
      withheld: match.withheld,
      context: match.context
    })),
    context_lines: page.contextLines,
    scanned_bytes: page.scannedBytes,
    match_limit: page.matchLimit,
    historical: page.historical,
    cursor: page.cursor,
    reason: page.reason
  })
  return { output: JSON.stringify(value), summary: `${QUERY_EVIDENCE_TOOL} · ${page.state} · ${page.matchCount} match${page.matchCount === 1 ? "" : "es"}`, observationId: page.observationId }
}

const findResult = (filter: EvidenceFilter, matches: { observationId: string; toolName: string; path?: string; contentHash?: string; observedAt: string; status: string; failed: boolean; executed: boolean; exitCode?: number; state: RetrievalState; completeness?: { captured: string; stored: string }; streams?: { stream: ResultStream; coverage: ByteRange[] }[]; historical?: boolean; cursor?: string }[]): ToolResult => {
  const value = sparse({
    operation: "find",
    total: matches.length,
    matches: matches.map((match) => sparse({
      observation_id: match.observationId,
      tool: match.toolName,
      path: match.path,
      content_hash: match.contentHash,
      observed_at: match.observedAt,
      status: match.status,
      failed: match.failed || undefined,
      executed: match.executed || undefined,
      exit_code: match.exitCode,
      state: match.state,
      completeness: match.completeness,
      streams: match.streams === undefined ? undefined : match.streams.map((state) => ({ stream: state.stream, coverage: rangesOf(state.coverage) })),
      historical: match.historical,
      cursor: match.cursor
    })),
    limit: filter.limit,
    reason: matches.length === 0 ? "zero matches is a successful result, not a failure" : undefined
  })
  return { output: JSON.stringify(value), summary: `${QUERY_EVIDENCE_TOOL} · found ${matches.length} observation${matches.length === 1 ? "" : "s"}` }
}

/** The failed-lookup form: what ran, that it is not a result, and the smallest step that could work (Rule 4 keeps it sparse). */
const refusedResult = (operation: string, decision: string, reason: string): ToolResult => ({
  output: JSON.stringify(sparse({ operation, executed: true, ok: false, access: decision, reason, next_step: `name the observation this project recorded for a call you made in this scope, or look it up with ${QUERY_EVIDENCE_TOOL} using a filter inside the same scope` })),
  summary: `${QUERY_EVIDENCE_TOOL} failed · ${operation} was refused`,
  failed: true
})

const queryEvidence = (access: EvidenceAccess): Tool => ({
  name: QUERY_EVIDENCE_TOOL,
  readOnly: true,
  description: "Read what the store already holds for one recorded observation: its facts, a bounded range of its retained content, a bounded search with continuation, or a bounded filtered lookup. It answers from recorded bytes and never re-runs the tool that produced them.",
  guidance: `Call ${QUERY_EVIDENCE_TOOL} with observation_id — a UUID, never a permission — and one coordinate family at a time: 1-based inclusive lines, 1-based characters inside one line, or zero-based half-open stored-byte offsets [start,end). A query means a search; a page that does not fit its own bound returns a cursor to continue the same request, not a rerun. Zero matches is a success. What the store does not hold is reported as a state, never as retrievable, and the hash reported is always the one as it was observed. The project, host and roots are decided by the host before any content is read: a lookup outside that scope names nothing it cannot name. This tool only answers when it is registered here.`,
  parameters: [
    { name: "observation_id", description: "The UUID of the recorded observation to read from.", optional: true, type: "string" },
    { name: "operation", description: "get, range, search or find. Inferred when left out: a query means search, any coordinate means range, no observation_id means find, otherwise get.", optional: true, type: "string" },
    { name: "query", description: "The text to search for (search).", optional: true, type: "string" },
    { name: "mode", description: "literal or regex for a search; literal by default.", optional: true, type: "string" },
    { name: "stream", description: "stdout, stderr, terminal, payload or output; the single recorded stream, or output, is the default.", optional: true, type: "string" },
    { name: "start_line", description: "First line of a range, from 1.", optional: true, type: "integer" },
    { name: "end_line", description: "Last line of a range, inclusive.", optional: true, type: "integer" },
    { name: "start_char", description: "For one line, the 1-based character offset to start at.", optional: true, type: "integer" },
    { name: "end_char", description: "For one line, the inclusive character offset to stop at.", optional: true, type: "integer" },
    { name: "start_byte", description: "A zero-based stored-byte offset, half-open [start,end).", optional: true, type: "integer" },
    { name: "end_byte", description: "The exclusive end of a byte range; must be greater than start_byte.", optional: true, type: "integer" },
    { name: "context_lines", description: "Lines to show around each search match, 0 to 3.", optional: true, type: "integer" },
    { name: "limit", description: "Maximum matches or results in this page.", optional: true, type: "integer" },
    { name: "cursor", description: "A continuation cursor from an earlier page of this same request.", optional: true, type: "string" },
    { name: "path", description: "For find: a workspace-relative source path to filter by.", optional: true, type: "string" },
    { name: "tool", description: "For find: the tool name to filter by.", optional: true, type: "string" },
    { name: "content_hash", description: "For find: the fingerprint as it was observed, not a current one.", optional: true, type: "string" },
    { name: "status", description: "For find: the recorded outcome status to filter by.", optional: true, type: "string" },
    { name: "since", description: "For find: ISO time to start filtering observations from.", optional: true, type: "string" },
    { name: "until", description: "For find: ISO time to filter observations up to.", optional: true, type: "string" }
  ],
  async run(raw) {
    const a = argumentReader(QUERY_EVIDENCE_TOOL, raw)
    const operation = operationOf(a)
    const id = a.text("observation_id")?.trim()
    if (operation !== "find" && !id) {
      throw new ToolArgumentError(argumentFailure("missing_argument", `${QUERY_EVIDENCE_TOOL} needs observation_id for a ${operation}: the UUID of the recorded result to read from.`, {
        required_argument: "observation_id",
        recovery: `Send observation_id, or use ${QUERY_EVIDENCE_TOOL} with operation find inside this project's scope to look one up.`
      }))
    }
    if (operation === "get") {
      const record = await access.get(id as string)
      if (record.access !== "found") return refusedResult("get", record.access, record.reason ?? "the lookup was refused before any content was read")
      const value = sparse({
        operation: "get",
        observation_id: record.observationId,
        invocation_id: record.invocationId,
        tool: record.toolName,
        path: record.path,
        observed_at: record.observedAt,
        execution_id: record.executionId,
        executed: record.executed,
        failed: record.failed,
        status: record.status,
        exit_code: record.exitCode,
        original_hash: record.originalHash,
        completeness: record.completeness,
        streams: record.streams === undefined ? undefined : record.streams.map((state) => ({ stream: state.stream, coverage: rangesOf(state.coverage) })),
        line_index: record.lineIndex === undefined ? undefined : sparse({ lines: record.lineIndex.lines, bounded: record.lineIndex.bounded }),
        historical: record.historical,
        reason: record.reason
      })
      return { output: JSON.stringify(value), summary: `${QUERY_EVIDENCE_TOOL} · get · ${record.toolName ?? "observation"}`, observationId: record.observationId }
    }
    if (operation === "range") {
      const request = sparse({
        stream: choiceOf(a, "stream", STREAMS, undefined) || undefined,
        start_line: wholeNumber(a, "start_line", 1, "a line number from 1"),
        end_line: wholeNumber(a, "end_line", 1, "a line number from 1"),
        start_char: wholeNumber(a, "start_char", 1, "a character offset from 1"),
        end_char: wholeNumber(a, "end_char", 1, "a character offset from 1"),
        start_byte: wholeNumber(a, "start_byte", 0, "a zero-based byte offset"),
        end_byte: wholeNumber(a, "end_byte", 0, "a zero-based byte offset")
      }) as Record<string, number | string>
      const span = await access.range(id as string, {
        stream: request.stream as ResultStream | undefined,
        startLine: request.start_line as number | undefined,
        endLine: request.end_line as number | undefined,
        startChar: request.start_char as number | undefined,
        endChar: request.end_char as number | undefined,
        startByte: request.start_byte as number | undefined,
        endByte: request.end_byte as number | undefined
      })
      return rangeResult(access, span)
    }
    if (operation === "search") {
      const query = a.text("query")?.trim()
      if (!query) {
        throw new ToolArgumentError(argumentFailure("missing_argument", `${QUERY_EVIDENCE_TOOL} needs query for a search; nothing was searched.`, {
          required_argument: "query",
          recovery: "Send query as a JSON string, or use operation range for a bounded span."
        }))
      }
      const page = await access.search(id as string, {
        query,
        mode: (choiceOf(a, "mode", SEARCH_MODES, "literal") || undefined) as "literal" | "regex" | undefined,
        stream: (choiceOf(a, "stream", STREAMS, undefined) || undefined) as ResultStream | undefined,
        contextLines: wholeNumber(a, "context_lines", 0, "a whole number from 0"),
        limit: wholeNumber(a, "limit", 1, "a whole number from 1"),
        cursor: a.text("cursor")?.trim()
      })
      return searchResult(page)
    }
    const filter: EvidenceFilter = {
      path: a.text("path")?.trim(),
      toolName: a.text("tool")?.trim(),
      contentHash: a.text("content_hash")?.trim(),
      status: a.text("status")?.trim(),
      since: isoArgument(a, "since"),
      until: isoArgument(a, "until"),
      limit: wholeNumber(a, "limit", 1, "a whole number from 1"),
      cursor: a.text("cursor")?.trim()
    }
    if (Object.keys(sparse(filter as Record<string, unknown>)).length === 0) {
      throw new ToolArgumentError(argumentFailure("missing_argument", `${QUERY_EVIDENCE_TOOL} find needs at least one filter, so it does not list everything this project holds.`, {
        required_argument: "path, tool, content_hash, status, since or until",
        recovery: `Send one filter, or read one observation with ${QUERY_EVIDENCE_TOOL} using observation_id.`
      }))
    }
    const matches = await access.find(filter)
    return findResult(filter, matches)
  }
})

const isoArgument = (a: ArgumentReader, name: string): string | undefined => {
  const value = a.text(name)?.trim()
  if (value === undefined || value === "") return undefined
  if (!isIso(value)) {
    throw new ToolArgumentError(argumentFailure("invalid_range", `${QUERY_EVIDENCE_TOOL}: ${name} must be an ISO time such as 2026-11-24T00:00:00Z, got "${value}".`, {
      required_argument: name,
      recovery: `Send ${name} as an ISO time, or leave it out.`
    }))
  }
  return value
}

/** Stage 3's one read-only tool, and nothing else: the tool list stays what the model may actually call. */
export const evidenceTools = (access: EvidenceAccess): Tool[] => [queryEvidence(access)]

/**
 * Adds the tool to a set that is assembled elsewhere, without changing how its existing tools dispatch. A
 * call that is not this tool goes to the set's own run, so nothing about an existing tool changes.
 */
export const withEvidenceTools = (tools: WorkspaceTools, access: EvidenceAccess): WorkspaceTools => {
  const tool = queryEvidence(access)
  if (tools.tools.some((candidate) => candidate.name === tool.name)) return tools
  const run = tools.run
  return {
    ...tools,
    tools: [...tools.tools, tool],
    async run(call, context) {
      if (call.name === tool.name) return tool.run(call.args, context)
      return run(call, context)
    }
  }
}

/**
 * A read-only repeat answered from what the store holds for it (Stage 3 instruction 4). The loop's answer key
 * already proves this call names the same tool with the same arguments, so what is checked here is that the
 * record is still the one this call would produce: the scope still reaches it, the source version it recorded
 * still matches, and there is content the store can actually serve. Anything that no longer holds returns
 * undefined, which means the call has to run. A retrieval that cannot be answered is never presented as a result.
 */
export type StoredResultReader = (call: ToolCall, observationId?: string) => Promise<ToolResult | undefined>

export const storedResultAnswerer = (access: EvidenceAccess): StoredResultReader => async (call, observationId) => {
  // A retrieval answers from the store by its own request, so a repeat of it is not a rerun of anything: the
  // loop runs the call again and the service serves the range that call asked for.
  if (!observationId || call.name === QUERY_EVIDENCE_TOOL) return undefined
  const span = await access.range(observationId, {})
  if (span.historical || span.state !== "retained" || !span.text || span.provenance?.toolName !== call.name) return undefined
  const value = sparse({
    operation: "range",
    state: span.state,
    stream: span.stream,
    coverage: coverageOf(span.coverage),
    text: span.text,
    completeness: span.completeness,
    original_hash: span.originalHash,
    provenance: provenanceOf(span.provenance),
    reason: `answered from stored content for these same arguments; the tool was not run again${span.continuation === undefined ? "" : `, continued at byte ${span.continuation.nextByte ?? span.coverage.toByte}`}`
  })
  return {
    output: JSON.stringify(value),
    summary: `${call.name} · repeated, answered from stored evidence and not run again`,
    observationId: span.observationId
  }
}
