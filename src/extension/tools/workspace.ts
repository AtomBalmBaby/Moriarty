/**
 * The tools a chat model works with in one workspace folder: reading and
 * searching, and, where the host gives them somewhere to go, editing files
 * and running commands. Plain Node, no VS Code, so the same tools run in
 * the extension and in a headless eval; what needs the editor (edits,
 * the terminal, language servers) comes in as a sink.
 *
 * Everything stays inside the root and out of what `.gitignore` ignores
 * (see `view.ts`). Every result is capped, and says so, because a small
 * model's context fills after a couple of whole files.
 */
import type { CaptureMode, ToolResultIntegrity } from "../../common/types"
import { diagnosticEvent } from "../diagnostics"
import type { GitServiceOptions } from "../git/service"
import type { SourceEvent } from "../todos/dependency-index"
import { TodoRepository } from "../todos/repository"
import type { EvidenceAccess, TodoWriteRequest } from "../todos/types"

import { AccessPreflight,accessTargetsOf } from "./access-preflight"
import { argumentFailure, argumentObject, argumentReader, checkDeclaredArguments, jsonType, positiveNumberArgument, structuredErrorResult, textArgument, ToolArgumentError,type ToolArguments, type ToolErrorDetail } from "./arguments"
import { formatResultIntegrity } from "./budget"
import { planReplacement, Replacement } from "./edit"
import { evidenceTools } from "./evidence"
import { indexChangeNote } from "./helpers"
import { FolderInstructions, folderInstructionsNote, InstructionFile, readRootInstructions } from "./instructions"
import { contentHash, ContentSource, EditReconciliation, LINE_EDIT_OPERATIONS, LineEditError, LineEditFailure, lineEditFailure, LineEditFailureCode, LineEditRequest, RefreshedRange, RequestedEditVerification } from "./line-edit"
import { coerceArguments, JsonSchema, McpToolSpec } from "./mcp"
import {
  deleteFile,
  diagnostics,
  editorContext,
  EditorSink,
  FileOpsSink,
  findFiles,
  findReferences,
  git,
  goToDefinition,
  insideGitRepository,
  moveFile,
  renameSymbol
} from "./more"
import type { OperationAuthorization, WriteOperation } from "./operation-authorization"
import { ToolCall, ToolSpec } from "./protocol"
import { type FingerprintCandidates, normalizeFingerprint, type ResolvedSource, type ResolvedTarget, resolveSourceTarget, type SourceResolverOptions } from "./source-resolver"
import { type TodoToolOptions,todoTools } from "./todos"
import { clip, linesOf, MAX_SEARCH_FILES, plural, ToolInputError, WorkspaceView } from "./view"

export interface ToolResult {
  /** What the model is sent. */
  output: string
  /** One line for the user: what was looked at and what came of it. */
  summary: string
  /** Structured completeness and source provenance for this result and later transformations. */
  integrity?: ToolResultIntegrity
  /** Raw tool output before context/result budgeting; retained for evidence provenance. */
  rawOutput?: string
  /** Completeness and provenance of the raw tool output before context/result budgeting. */
  rawIntegrity?: ToolResultIntegrity
  /** The tool refused or went wrong; the output says why. */
  failed?: boolean
  /**
   * The model should answer now without another tool: an edit is waiting
   * for review, and the open file shows both sides of it until then.
   */
  final?: boolean
  /**
   * What the model reads ahead of the output, and the user does not see in
   * the step: the instructions of a folder the call reached.
   */
  preface?: string
  execution?: {
    command: string
    exitCode?: number
    output: string
    /** Which stored byte stream each part of this result refers to, when the host captured them apart.
     * A reference names bytes that exist; it never stands in for bytes that were not received.
     */
    streams?: { stdout?: string; stderr?: string; terminal?: string }
    captureMode?: CaptureMode
  }
  /** The bytes as they arrived on each stream, before any presentation view. Stage 10 fills these from the real command sink. */
  rawStreams?: { stdout?: Buffer; stderr?: Buffer; terminal?: Buffer }
  /** The observation this result is an account of: the one the host recorded for this call, or the one a retrieval answered from. Written only when there is a real one. */
  observationId?: string
  /** Structured fields the host records with this observation. Verification reads them; the model does not see them. */
  observation?: { arguments: Record<string, string> }
  /** Why the call was refused, when the tool can name the condition precisely. */
  error?: ToolErrorDetail
}

/** What a running tool is told: when the user has stopped the reply, the write its approval allows, and the file the shared resolver settled on. */
export interface ToolContext {
  signal?: AbortSignal
  write?: OperationAuthorization
  diagnostic?: {
    operationId?: string
    requestId?: string
    step?: number
  }
  /**
   * The file this call is about: the one the call named, or the one its content
   * fingerprint uniquely resolved to.
   */
  source?: ResolvedSource
}

export interface Tool extends ToolSpec {
  run(args: ToolArguments, context?: ToolContext): Promise<ToolResult>
}

const MIN_READ_LINES = 100
const DEFAULT_READ_LINES = 1000
const MAX_READ_LINES = 5000
const MAX_GREP_MATCHES = 40
/** Matches shown per file, so one noisy file does not hide the others. */
const MAX_GREP_PER_FILE = 10
/** Files named, with their match counts, beyond the ones whose lines are shown. */
const MAX_GREP_OTHER_FILES = 15
/** With this few matches in all, each is shown with the lines around it. */
const GREP_CONTEXT_MATCHES = 6
const GREP_CONTEXT_LINES = 2
const MAX_LIST_ENTRIES = 150
const MAX_SYMBOL_MATCHES = 15
/** A search gives up after this long and says what it did not reach. */
const SEARCH_BUDGET_MS = 8000
/** Longer lines (minified code) are matched on their start only, which bounds a slow pattern. */
const MAX_MATCHED_LINE_CHARS = 2000

/**
 * Where edits go: the editor in the extension, a scratch copy in the eval.
 * `apply` edits land at once and the model can carry on; `review` edits
 * wait as a diff for the user, and the model stops there. `read` gives a
 * file as the editor has it, unsaved changes included, when it is open.
 */
export interface EditSink {
  mode: "apply" | "review"
  read?(file: string): Promise<string | undefined>
  /** Make or show the change; resolves to what the model is told. `write` is the call's approval for a file outside the workspace. */
  edit(file: string, replacement: Replacement, write?: OperationAuthorization): Promise<EditOutcome>
  editLines?(file: string, request: LineEditRequest, save: boolean, write?: OperationAuthorization): Promise<EditOutcome>
  /** Make or show a new file; resolves to what the model is told. */
  create(file: string, content: string, write?: OperationAuthorization, invocationId?: string): Promise<EditOutcome>
}

/** One file the index should catch up with: an absolute file-system path, and what happened to it. */
export interface IndexChange { path: string; kind: "write" | "delete" }
/** How a `refresh` answered for the whole batch: the rows are current, there was nothing to do, or why it could not be done. */
export type IndexRefreshOutcome = { status: "synced" } | { status: "skipped"; reason: string } | { status: "failed"; reason: string }

export interface EditOutcome {
  ok: boolean
  error?: LineEditFailure
  contentHash?: string
  /** `disk` when the saved file was read back to produce contentHash. */
  contentSource?: ContentSource
  /** Whether the edit is saved to disk; `false` when it was left unsaved on purpose. */
  persisted?: boolean
  postSave?: EditReconciliation
  requestedEdits?: RequestedEditVerification
  previousHash?: string
  intendedHash?: string
  sourceVersion?: "changed" | "unchanged"
  previousSourceVersion?: "superseded"
  refreshedRanges?: RefreshedRange[]
  transformationNotice?: string
  totalLines?: number
  finalText?: string
  createStatus?: "created" | "created_and_transformed" | "already_exists" | "conflicted" | "unresolved"
  operationId?: string
  /** What the index refresh did for this change, when the tool refreshed it. */
  indexRefresh?: IndexRefreshOutcome
  message: string
  pending?: boolean
  /** Errors the editor reports in the file since the change; the message names them. */
  newErrors?: number
}

/** ` · 2 new errors`, for a step's line, when the change left any. */
const errorsNote = (outcome: EditOutcome) =>
  outcome.newErrors ? ` · ${plural(outcome.newErrors, "new error")}` : ""
/** What the model is told when a change landed but the index could not be told about it: the edit stands and is not to be repeated. Failed calls are logged by the loop. */
const indexRefreshNote = (outcome: EditOutcome) => {
  const refresh = outcome.indexRefresh
  if (!refresh || refresh.status !== "failed") return ""
  return ` Saved, but the search index could not be refreshed (${refresh.reason}); the edit is complete and must not be repeated. search_workspace may show stale results for this file until the index recovers.`
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** The text itself as a pattern; lowercase means any case. */
const literalPattern = (pattern: string) =>
  new RegExp(escapeRegex(pattern), pattern === pattern.toLowerCase() ? "i" : "")

/** A pattern as a regex; one that does not compile is searched for literally. Lowercase means any case. */
const searchPattern = (pattern: string) => {
  try {
    return new RegExp(pattern, pattern === pattern.toLowerCase() ? "i" : "")
  } catch {
    return literalPattern(pattern)
  }
}

/** Lines that declare `name` in the languages people mostly write. */
const definitionPattern = (name: string) => {
  const n = escapeRegex(name)
  return new RegExp(
    [
      `\\b(?:function\\*?|class|interface|type|enum|struct|trait|impl|def|fn|func|module|namespace|record|object)\\s+${n}\\b`,
      `\\b(?:const|let|var|val)\\s+${n}\\s*[=:]`,
      `^\\s*(?:(?:public|private|protected|static|readonly|async|override|abstract|get|set)\\s+)+\\*?${n}\\s*[(<=:]`,
      `^\\s*${n}\\s*\\([^)]*\\)\\s*(?::[^=]*)?\\{\\s*$`,
      `\\btype\\s+${n}\\s+(?:struct|interface)\\b`
    ].join("|")
  )
}

const listDir = (view: WorkspaceView): Tool => ({
  name: "list_dir",
  readOnly: true,
  description: "The files and folders in a directory.",
  parameters: [{ name: "path", description: "The directory; the workspace root by default.", optional: true }],
  async run(raw) {
    const a = argumentReader("list_dir", raw)
    const dir = a.text("path")
    const absolute = view.resolve(dir, "dir")
    const entries = view.entries(absolute)
    const shown = entries.slice(0, MAX_LIST_ENTRIES)
    const more = entries.length - shown.length
    const where = view.relative(absolute)
    return {
      output:
        shown.map((e) => (e.dir ? `${e.name}/` : e.name)).join("\n") +
        (more > 0 ? `\n… ${more} more` : "") || "(empty)",
      summary: `listed ${where === "." ? "the workspace root" : `\`${where}\``} · ${plural(entries.length, "entry", "entries")}`
    }
  }
})

const clampReadLines = (limit: number | undefined) => {
  const value = Number.isFinite(limit) ? Math.round(limit as number) : DEFAULT_READ_LINES
  return Math.min(MAX_READ_LINES, Math.max(MIN_READ_LINES, value))
}

/** A line number, read at the shared boundary with this tool's wording. */
const lineArgument = (rel: string, name: string, args: ToolArguments) =>
  positiveNumberArgument(rel, name, args, "a line number from 1")

/** The read settings, read through the host's configuration reader, so the mapping from settings to the tool is testable without VS Code. */
export const readFileSettings = (get: <T>(key: string, fallback: T) => T) => ({
  readFileMaxLines: clampReadLines(get("chatToolsMaxReadLines", DEFAULT_READ_LINES)),
  readFileAllowFullFile: get<boolean>("chatToolsAllowFullFileReadsBeyondMaxReadLines", false) === true
})

/** Most read calls named in an over-limit error; a longer file gets a count of the rest. */
const MAX_SUGGESTED_READS = 5

/** The read calls covering lines from..last, at most `limit` each and at most MAX_SUGGESTED_READS named. */
const suggestedReads = (from: number, last: number, limit: number) => {
  const shown: string[] = []
  let next = from
  while (next <= last && shown.length < MAX_SUGGESTED_READS) {
    shown.push(`  start_line=${next}, end_line=${Math.min(last, next + limit - 1)}`)
    next += limit
  }
  const rest = last - next + 1
  if (rest > 0) shown.push(`  … ${plural(Math.ceil(rest / limit), "more read")} of up to ${limit} lines, through line ${last}`)
  return shown.join("\n")
}

const overLimitMessage = (rel: string, from: number, last: number, total: number, limit: number, wholeFile: boolean) => {
  const subject = wholeFile
    ? `${rel} contains ${plural(total, "line")}.`
    : `${rel} lines ${from}–${last} are ${plural(last - from + 1, "line")}.`
  const remedy = wholeFile
    ? "Or enable the full-file limit override in Twinny settings: \"Allow Full-File Reads Beyond Maximum Lines\" (twinny.chatToolsAllowFullFileReadsBeyondMaxReadLines)."
    : "The full-file override does not apply to ranges; ranges stay within the maximum."
  return `read_file: ${subject}\nConfigured maximum: ${plural(limit, "line")}.\n\nUse multiple read_file calls:\n${suggestedReads(from, last, limit)}\n\n${remedy}`
}

const readFile = (view: WorkspaceView, maxLines = DEFAULT_READ_LINES, sink?: EditSink, allowFullFile = false): Tool => {
  const limit = clampReadLines(maxLines)
  const MAX_LINE_FRAGMENT_CHARS = 10_000
  return {
    name: "read_file",
    readOnly: true,
    hashAddressable: true,
    description: `A file's lines, numbered. Pass only path, or full_file set to true, to read the whole file; a whole file longer than ${limit} lines is refused with suggested ranges, unless the user has allowed longer full-file reads. Read a range with start_line and end_line (start_line alone reads to the end of the file); a single line is start_line and end_line set to the same number. A range longer than ${limit} lines is refused, not cut short. Source lines are complete. Includes the content fingerprint of the entire authoritative editor document (including unsaved changes), for edit_lines. With no path, expected_hash resolves the file when it names exactly one current file the caller may use.`,
    // full_line is still accepted for earlier calls but is not advertised: start_line and end_line set to the same number already read one line.
    parameters: [
      { name: "path", description: "The file; optional when expected_hash names exactly one current file the caller may use.", optional: true, type: "string" },
      { name: "full_file", description: "true to read the whole file.", optional: true, type: "boolean" },
      { name: "start_line", description: "First line to read, from 1. Omit to start at the top of the file.", optional: true, type: "integer" },
      { name: "end_line", description: "Last line to read, inclusive. Omit to read to the end of the file. Must not be before start_line.", optional: true, type: "integer" },
      { name: "start_char", description: "For one oversized source line, 1-based character offset at which to return a bounded fragment.", optional: true, type: "integer" },
      { name: "end_char", description: "For one oversized source line, inclusive character offset. Omitting it reads up to 10,000 characters.", optional: true, type: "integer" },
      { name: "expected_hash", description: "The content fingerprint read_file gave for this file. With no path, it resolves the file when it names exactly one current file the caller may use.", optional: true, type: "string" }
    ],
    async run(raw, context) {
      const a = argumentReader("read_file", raw)
      const file = a.text("path") ?? context?.source?.path
      if (!file) throw new ToolInputError("read_file needs a path, or an expected_hash that names exactly one file.")
      const absolute = view.resolve(file, "file")
      const rel = view.relative(absolute)
      /** A character offset: the number as it came, or its text spelling. Anything else is refused, not made into text. */
      const offsetText = (name: string): string | undefined => {
        const value = raw[name]
        if (!a.sent(name)) return undefined
        if (value === null)
          throw new ToolArgumentError(argumentFailure("invalid_argument_type", `${rel}: ${name} must be a character offset, not null.`, { required_argument: name }))
        if (typeof value !== "string" && typeof value !== "number")
          throw new ToolArgumentError(argumentFailure("invalid_argument_type", `${rel}: ${name} must be a character offset, not ${jsonType(value)}.`, { required_argument: name }))
        return String(value).trim()
      }
      const text = (await sink?.read?.(absolute)) ?? await view.text(absolute)
      if (text === undefined) throw new ToolInputError(`${rel} is binary or too large to read.`)
      const fullFile = a.flag("full_file", rel)
      // full_file takes precedence: range and full_line arguments sent with it are ignored, not validated.
      const single = fullFile ? false : a.flag("full_line", rel)
      const start = fullFile ? undefined : lineArgument(rel, "start_line", raw)
      const end = fullFile ? undefined : lineArgument(rel, "end_line", raw)
      const lines = linesOf(text)
      const fingerprint = await contentHash(text)
      const metadata = `content_hash: ${fingerprint}; total_lines: ${lines.length}`
      if (!lines.length) {
        const integrity: ToolResultIntegrity = {
          status: "complete",
          requested: { kind: "whole_file" },
          selected: { startLine: 0, endLine: 0, totalLines: 0 },
          delivered: { startLine: 0, endLine: 0, totalLines: 0 },
          source: { kind: "file", path: rel, contentHash: fingerprint, totalLines: 0 },
          rawChars: 0,
          deliveredChars: 0
        }
        return { output: `${rel} (lines 0–0 of 0)\n${metadata}`, summary: `read \`${rel}\` · empty`, integrity, rawOutput: `${rel} (lines 0–0 of 0)\n${metadata}` }
      }
      if (single) {
        if (start === undefined) {
          throw new ToolInputError(`${rel}: full_line needs start_line, the one line to read. full_line does not choose a line; pass start_line, or drop full_line to read a range.`)
        }
        if (start > lines.length) {
          throw new ToolInputError(`${rel}: full_line start_line ${start} is past the last line, ${lines.length}. Pass a start_line from 1 to ${lines.length}.`)
        }
        if (end !== undefined && end !== start) {
          throw new ToolInputError(`${rel}: full_line returns exactly one line, but end_line ${end} differs from start_line ${start}. For a range, drop full_line and pass start_line and end_line. For one line, drop end_line.`)
        }
        const line = lines[start - 1]
        const charStartRaw = offsetText("start_char")
        const charEndRaw = offsetText("end_char")
        const charStart = charStartRaw === undefined || charStartRaw === "" ? undefined : Number(charStartRaw)
        const charEnd = charEndRaw === undefined || charEndRaw === "" ? undefined : Number(charEndRaw)
        if ((charStart !== undefined && (!Number.isSafeInteger(charStart) || charStart < 1)) ||
            (charEnd !== undefined && (!Number.isSafeInteger(charEnd) || charEnd < 1))) {
          throw new ToolInputError(`${rel}: start_char and end_char must be positive character offsets within line ${start}.`)
        }
        if (charStart !== undefined && charEnd !== undefined && charEnd < charStart) {
          throw new ToolInputError(`${rel}: end_char ${charEnd} is before start_char ${charStart} on line ${start}.`)
        }
        if (charStart === undefined && charEnd !== undefined) {
          throw new ToolInputError(`${rel}: end_char needs start_char for line ${start}.`)
        }
        if (charStart === undefined && line.length > MAX_LINE_FRAGMENT_CHARS) {
          const endChar = Math.min(MAX_LINE_FRAGMENT_CHARS, line.length)
          const fragment = line.slice(0, endChar)
          const integrity: ToolResultIntegrity = {
            status: "partial",
            requested: { kind: "line", range: { startLine: start, endLine: start } },
            selected: { startLine: start, endLine: start, totalLines: lines.length },
            delivered: { startLine: start, endLine: start, totalLines: lines.length },
            source: { kind: "file", path: rel, contentHash: fingerprint, totalLines: lines.length },
            truncation: { stage: "per_result_cap", reason: "oversized source line", omittedChars: line.length - endChar, omittedLines: 0, nextCharStart: endChar + 1 },
            rawChars: line.length,
            deliveredChars: endChar
          }
          const rawOutput = `${rel} (line ${start} fragment characters 1–${endChar} of ${line.length})\n${metadata}\n${start}: ${fragment}`
          return {
            output: `${rawOutput}\n${formatResultIntegrity(integrity)}`,
            summary: `read \`${rel}:${start}\` · line exceeds budget · partial`,
            integrity,
            rawOutput
          }
        }
        if (charStart !== undefined) {
          const requestedEnd = charEnd ?? Math.min(line.length, charStart + MAX_LINE_FRAGMENT_CHARS - 1)
          const endChar = Math.min(requestedEnd, line.length)
          const fragment = line.slice(charStart - 1, endChar)
          const complete = endChar >= line.length
          const integrity: ToolResultIntegrity = {
            status: complete ? "complete" : "partial",
            requested: {
              kind: "line_fragment",
              range: { startLine: start, endLine: start },
              lineFragment: { line: start, startChar: charStart, endChar, totalChars: line.length, contentHash: fingerprint }
            },
            selected: { startLine: start, endLine: start, totalLines: lines.length },
            delivered: { startLine: start, endLine: start, totalLines: lines.length },
            source: { kind: "file", path: rel, contentHash: fingerprint, totalLines: lines.length },
            ...(complete ? {} : { truncation: { stage: "per_result_cap", reason: "line fragment requested", omittedChars: line.length - endChar, nextCharStart: endChar + 1 } }),
            rawChars: line.length,
            deliveredChars: fragment.length
          }
          const rawOutput = `${rel} (line ${start} fragment characters ${charStart}–${endChar} of ${line.length})\n${metadata}\n${start}: ${fragment}`
          return {
            output: complete ? rawOutput : `${rawOutput}\n${formatResultIntegrity(integrity)}`,
            summary: complete ? `read \`${rel}:${start}\` · full line` : `read \`${rel}:${start}\` · partial line characters ${charStart}–${endChar}`,
            integrity,
            rawOutput
          }
        }
        const integrity: ToolResultIntegrity = {
          status: "complete",
          requested: { kind: "line", range: { startLine: start, endLine: start } },
          selected: { startLine: start, endLine: start, totalLines: lines.length },
          delivered: { startLine: start, endLine: start, totalLines: lines.length },
          source: { kind: "file", path: rel, contentHash: fingerprint, totalLines: lines.length },
          rawChars: line.length,
          deliveredChars: line.length
        }
        const rawOutput = `${rel} (full line ${start})\n${metadata}\n${start}: ${line}`
        return { output: rawOutput, summary: `read \`${rel}:${start}\` · full line`, integrity, rawOutput }
      }
      const from = start ?? 1
      if (from > lines.length) {
        throw new ToolInputError(`${rel} has only ${plural(lines.length, "line")}.`)
      }
      if (end !== undefined && end < from) {
        throw new ToolInputError(`${rel}: end_line ${end} is before start_line ${from}. Pass an end_line from ${from} onward, or drop end_line to read from start_line.`)
      }
      const last = Math.min(end ?? lines.length, lines.length)
      const wholeFile = fullFile || (start === undefined && end === undefined)
      if (last - from + 1 > limit && !(wholeFile && allowFullFile)) {
        throw new ToolInputError(overLimitMessage(rel, from, last, lines.length, limit, wholeFile))
      }
      if (offsetText("start_char") !== undefined || offsetText("end_char") !== undefined) {
        if (from !== last) {
          throw new ToolInputError(`${rel}: start_char and end_char are only valid for exactly one source line; set start_line and end_line to the same line.`)
        }
        const charStartRaw = offsetText("start_char")
        const charEndRaw = offsetText("end_char")
        if (charStartRaw === "") throw new ToolInputError(`${rel}: start_char is required for a line fragment.`)
        const charStart = Number(charStartRaw)
        const charEnd = charEndRaw === undefined || charEndRaw === "" ? undefined : Number(charEndRaw)
        if (!Number.isSafeInteger(charStart) || charStart < 1 ||
            (charEnd !== undefined && (!Number.isSafeInteger(charEnd) || charEnd < 1))) {
          throw new ToolInputError(`${rel}: start_char and end_char must be positive character offsets within line ${from}.`)
        }
        if (charEnd !== undefined && charEnd < charStart) {
          throw new ToolInputError(`${rel}: end_char ${charEnd} is before start_char ${charStart} on line ${from}.`)
        }
        const line = lines[from - 1]
        if (charStart > line.length) throw new ToolInputError(`${rel}: start_char ${charStart} is past character ${line.length} on line ${from}.`)
        const endChar = Math.min(charEnd ?? Math.min(line.length, charStart + MAX_LINE_FRAGMENT_CHARS - 1), line.length)
        const fragment = line.slice(charStart - 1, endChar)
        const complete = endChar >= line.length
        const integrity: ToolResultIntegrity = {
          status: complete ? "complete" : "partial",
          requested: {
            kind: "line_fragment",
            range: { startLine: from, endLine: from },
            lineFragment: { line: from, startChar: charStart, endChar, totalChars: line.length, contentHash: fingerprint }
          },
          selected: { startLine: from, endLine: from, totalLines: lines.length },
          delivered: { startLine: from, endLine: from, totalLines: lines.length },
          source: { kind: "file", path: rel, contentHash: fingerprint, totalLines: lines.length },
          ...(complete ? {} : { truncation: { stage: "per_result_cap", reason: "line fragment requested", omittedChars: line.length - endChar, nextCharStart: endChar + 1 } }),
          rawChars: line.length,
          deliveredChars: fragment.length
        }
        const rawOutput = `${rel} (line ${from} fragment characters ${charStart}–${endChar} of ${line.length})\n${metadata}\n${from}: ${fragment}`
        return {
          output: complete ? rawOutput : `${rawOutput}\n${formatResultIntegrity(integrity)}`,
          summary: complete ? `read \`${rel}:${from}\` · full line` : `read \`${rel}:${from}\` · partial line characters ${charStart}–${endChar}`,
          integrity,
          rawOutput
        }
      }
      const body = lines
        .slice(from - 1, last)
        .map((line, i) => `${from + i}: ${line}`)
        .join("\n")
      const integrity: ToolResultIntegrity = {
        status: "complete",
        requested: wholeFile
          ? { kind: "whole_file" }
          : { kind: "range", range: { startLine: from, endLine: last } },
        selected: { startLine: from, endLine: last, totalLines: lines.length },
        delivered: { startLine: from, endLine: last, totalLines: lines.length },
        source: { kind: "file", path: rel, contentHash: fingerprint, totalLines: lines.length },
        rawChars: body.length,
        deliveredChars: body.length
      }
      const rawOutput = `${rel} (lines ${from}–${last} of ${lines.length})\n${metadata}\n${body}`
      return {
        output: rawOutput,
        summary: wholeFile ? `read \`${rel}\` · whole file` : `read \`${rel}:${from}–${last}\``,
        integrity,
        rawOutput
      }
    }
  }
}

const INTERNAL_IDENTIFIER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A bare UUID is a TODO or other internal identifier, which is never workspace text; the TODO list and evidence lookup hold it. */
const rejectInternalIdentifier = (tool: string, query: string) => {
  if (INTERNAL_IDENTIFIER.test(query)) {
    throw new ToolInputError(`${tool} was given an internal identifier, not workspace text. Task and evidence records are not in the workspace; search for the source name, such as a function, tool, or file name, instead.`)
  }
}

const grep = (view: WorkspaceView): Tool => ({
  name: "grep",
  readOnly: true,
  description:
    "Lines matching a regular expression, across the workspace or under one directory, grouped by file (`12:` is a match, `12-` a line beside one). An all-lowercase pattern ignores case.",
  parameters: [
    { name: "pattern", description: "A JavaScript regular expression." },
    { name: "path", description: "A directory to search under, or one file; the whole workspace by default.", optional: true }
  ],
  async run(raw, context) {
    const a = argumentReader("grep", raw)
    const pattern = a.text("pattern")
    const dir = a.text("path")
    if (!pattern) throw new ToolInputError("grep needs a pattern.")
    rejectInternalIdentifier("grep", pattern.trim())
    const target = dir ? view.resolve(dir, "any") : undefined
    /** An authorized folder outside the root is searched by walking it here; `files()` stays the workspace's own. */
    const outside = target !== undefined && view.isExternal(target)
    const scope = target ? view.relative(target) : "."
    const started = Date.now()
    const search = async (regex: RegExp) => {
      /** Files whose matches are shown: their lines, and which of them matched (0-based). */
      const shownFiles: { file: string; lines: string[]; hits: number[]; count: number }[] = []
      /** Files with matches that got no lines of their own, with how many each has. */
      const others: { file: string; count: number }[] = []
      let shown = 0
      let total = 0
      let unsearched = 0
      const all = outside && target ? await view.filesUnder(target) : await view.files()
      /** A walk that stopped at its limit is not an empty search; the model needs to know which one it got. */
      const capped = outside && target !== undefined && all.length >= MAX_SEARCH_FILES
      for (const [index, file] of all.entries()) {
        const rel = view.relative(file)
        if (scope !== "." && rel !== scope && !rel.startsWith(`${scope}/`)) continue
        if (context?.signal?.aborted || Date.now() - started > SEARCH_BUDGET_MS) {
          unsearched = all.length - index
          break
        }
        const text = await view.text(file)
        if (!text) continue
        const lines = linesOf(text)
        const hits: number[] = []
        let count = 0
        lines.forEach((line, i) => {
          const probe = line.length > MAX_MATCHED_LINE_CHARS ? line.slice(0, MAX_MATCHED_LINE_CHARS) : line
          if (!regex.test(probe)) return
          count++
          if (hits.length < MAX_GREP_PER_FILE && shown + hits.length < MAX_GREP_MATCHES) hits.push(i)
        })
        if (!count) continue
        total += count
        if (!hits.length) {
          others.push({ file: rel, count })
          continue
        }
        shown += hits.length
        shownFiles.push({ file: rel, lines, hits, count })
      }
      // A handful of matches come with the lines around them, as `rg -C`
      // prints them: what the model wants next is nearly always right there,
      // and a read to fetch it would cost a whole request.
      const around = total <= GREP_CONTEXT_MATCHES ? GREP_CONTEXT_LINES : 0
      const blocks = shownFiles.map(({ file, lines, hits, count }) => {
        const rows: string[] = []
        let printed = -1
        for (const hit of hits) {
          const from = Math.max(printed + 1, hit - around)
          if (around && printed !== -1 && from > printed + 1) rows.push("--")
          for (let i = from; i <= Math.min(lines.length - 1, hit + around); i++) {
            // A later match inside this one's context is printed as a match when its turn comes.
            if (i > hit && hits.includes(i)) break
            // With context the indentation stays, so the lines read as the code they are.
            rows.push(`${i + 1}${i === hit ? ":" : "-"} ${clip(around ? lines[i].trimEnd() : lines[i].trim())}`)
            printed = i
          }
        }
        return [file, ...rows, ...(count > hits.length ? [`… ${count - hits.length} more in this file`] : [])].join("\n")
      })
      return { blocks, others, total, files: blocks.length + others.length, unsearched, capped }
    }

    // A pattern is tried as written, then as the models tend to mean it,
    // until something matches.
    const attempts: { regex: RegExp; note?: string }[] = [
      { regex: searchPattern(pattern) },
      // `ctrl+i` or `foo()`, meaning the text rather than the regex.
      ...(/[.*+?^${}()|[\]\\]/.test(pattern)
        ? [
            {
              regex: literalPattern(pattern),
              note: "(Nothing matched as a regular expression; these match the text as written.)"
            }
          ]
        : []),
      // `ctrl\\+i`: escaped for the regex, then once more for the JSON it came in.
      ...(pattern.includes("\\\\")
        ? [
            {
              regex: searchPattern(pattern.replace(/\\\\/g, "\\")),
              note: "(Nothing matched as written; these match with each doubled backslash read as one.)"
            }
          ]
        : [])
    ]
    let found = await search(attempts[0].regex)
    let note: string | undefined
    for (const attempt of attempts.slice(1)) {
      if (found.total) break
      const again = await search(attempt.regex)
      if (again.total) [found, note] = [again, attempt.note]
    }

    const { blocks, others, total, files, unsearched, capped } = found
    // Where else it matched, busiest first: enough for a narrower search.
    const elsewhere = [...others].sort((a, b) => b.count - a.count)
    const named = elsewhere.slice(0, MAX_GREP_OTHER_FILES).map(({ file, count }) => `${file} (${count})`)
    const notes = [
      ...(elsewhere.length
        ? [
            `… also in ${named.join(", ")}` +
              (elsewhere.length > named.length ? ` and ${plural(elsewhere.length - named.length, "more file")}` : "") +
              "; narrow the pattern or the path"
          ]
        : []),
      ...(unsearched > 0 ? [`… stopped early: ${plural(unsearched, "file")} not searched; narrow the path`] : []),
      ...(capped ? [`… stopped early: only the first ${MAX_SEARCH_FILES} files were searched; narrow the path`] : [])
    ]
    return {
      output: blocks.length ? [...(note ? [note] : []), ...blocks, ...notes].join("\n") : ["No matches.", ...notes].join("\n"),
      summary:
        `searched for \`${pattern}\`${scope !== "." ? ` in \`${scope}\`` : ""} · ` +
        (total ? `${plural(total, "match", "matches")} in ${plural(files, "file")}` : "no matches")
    }
  }
})

const findSymbol = (view: WorkspaceView): Tool => ({
  name: "find_symbol",
  readOnly: true,
  description: "Where a function, class, method, type or variable is defined.",
  parameters: [{ name: "name", description: "The symbol's name, exactly as written in code." }],
  async run(raw, context) {
    const a = argumentReader("find_symbol", raw)
    const name = a.text("name")
    const wanted = name?.trim()
    if (!wanted) throw new ToolInputError("find_symbol needs a name.")
    const regex = definitionPattern(wanted)
    const found: string[] = []
    const started = Date.now()
    for (const file of await view.files()) {
      if (found.length >= MAX_SYMBOL_MATCHES) break
      if (context?.signal?.aborted || Date.now() - started > SEARCH_BUDGET_MS) break
      const text = await view.text(file)
      if (!text?.includes(wanted)) continue
      linesOf(text).forEach((line, i) => {
        if (found.length < MAX_SYMBOL_MATCHES && line.length <= MAX_MATCHED_LINE_CHARS && regex.test(line)) {
          found.push(`${view.relative(file)}:${i + 1}: ${clip(line.trim())}`)
        }
      })
    }
    return {
      output: found.length
        ? found.join("\n")
        : `No definition of ${wanted} found. Try grep for where it is used.`,
      summary: `looked up \`${wanted}\` · ${found.length ? plural(found.length, "definition") : "not found"}`
    }
  }
})

const EDIT_DESCRIPTION = {
  apply:
    "Change a file by replacing an exact piece of it. The change is applied and saved straight away; the user can undo it.",
  review:
    "Propose changing a file by replacing an exact piece of it. The user reviews the change as a diff in the editor and nothing is saved until they accept it. One edit at a time."
}

const EDIT_GUIDANCE = {
  apply:
    "When the user asks you to change code, read the lines first, then call edit_file, once per change, until the task is done; use create_file for a new file. Then say briefly what you changed.",
  review:
    "When the user asks you to change code, read the lines first, then call edit_file (or create_file for a new file). The user reviews each change before it is applied, so propose one and say briefly what it does."
}

const MAX_NEW_FILE_CHARS = 100_000

const createFile = (view: WorkspaceView, sink: EditSink): Tool => ({
  name: "create_file",
  description:
    (sink.mode === "apply"
      ? "Create a new file with the given content; missing folders are made. It is written straight away."
      : "Propose a new file with the given content. The user reviews it before it is saved.") +
    " The file must not exist yet; to change an existing file, read it and use edit_lines.",
  parameters: [
    { name: "path", description: "Where the new file goes, relative to the workspace root, or an absolute path inside an allowed folder." },
    { name: "content", description: "The whole file." }
  ],
  async run(raw, context) {
    const a = argumentReader("create_file", raw)
    const file = a.text("path")
    const content = a.text("content")
    if (content === undefined) throw new ToolInputError("create_file needs content.")
    if (content.length > MAX_NEW_FILE_CHARS) throw new ToolInputError("That file is too large to create in one go.")
    const absolute = view.resolveNew(file)
    const rel = view.relative(absolute)
    const outcome = await sink.create(absolute, content, context?.write, context?.diagnostic?.requestId)
    if (!outcome.ok) {
      const rich = outcome.createStatus || outcome.contentHash || outcome.finalText
      if (!rich) return { output: outcome.message, summary: `\`${rel}\` not created · ${outcome.message}`, failed: true }
      const text = outcome.finalText ?? ""
      const ranges = outcome.createStatus === "unresolved" && text
        ? [{ startLine: 1, endLine: linesOf(text).length }]
        : []
      const body = text ? linesOf(text).map((line, index) => `${index + 1}: ${line}`).join("\n") : ""
      const rawOutput = [
        `create_file: ${outcome.createStatus ?? "unresolved"}`,
        `save: ${outcome.persisted ? "completed" : "unresolved"}`,
        ...(outcome.contentHash ? [`final_hash: ${outcome.contentHash}`] : []),
        ...(outcome.intendedHash ? [`intended_hash: ${outcome.intendedHash}`] : []),
        "source_version: changed",
        ...(outcome.operationId ? [`operation_id: ${outcome.operationId}`] : []),
        ...(ranges.length ? [`refreshed_ranges:\n${rel}:${ranges[0].startLine}-${ranges[0].endLine}\n${body}`] : [])
      ].join("\n")
      return { output: rawOutput, summary: `\`${rel}\` not created · ${outcome.message}`, failed: true, rawOutput }
    }
    view.forgetFiles()
    if (outcome.createStatus || outcome.finalText) {
      const finalText = outcome.finalText ?? content
      const totalLines = outcome.totalLines ?? linesOf(finalText).length
      const body = linesOf(finalText).map((line, index) => `${index + 1}: ${line}`).join("\n")
      const rawOutput = [
        `create_file: ${outcome.createStatus ?? "created"}`,
        `save: ${outcome.persisted ? "completed" : "pending"}`,
        `post_save: ${outcome.postSave === "applied_and_transformed" ? "transformed" : "exact"}`,
        `requested_edits: ${outcome.requestedEdits ?? "verified"}`,
        ...(outcome.contentHash ? [`content_hash: ${outcome.contentHash}`, `final_hash: ${outcome.contentHash}`, `next_expected_hash: ${outcome.contentHash}`] : []),
        ...(outcome.intendedHash ? [`intended_hash: ${outcome.intendedHash}`] : []),
        "source_version: changed",
        "previous_source_version: superseded",
        `total_lines: ${totalLines}`,
        ...(outcome.operationId ? [`operation_id: ${outcome.operationId}`] : []),
        ...(outcome.transformationNotice ? [`transformation_notice: ${outcome.transformationNotice}`] : []),
        "",
        `${rel} (lines 1-${totalLines} of ${totalLines})`,
        `content_hash: ${outcome.contentHash ?? ""}; total_lines: ${totalLines}`,
        body
      ].filter((line, index, array) => !(index === array.length - 1 && line === "")).join("\n")
      return {
        output: rawOutput,
        summary: `${outcome.createStatus === "created_and_transformed" ? "created and transformed" : "created"} \`${rel}\` · ${plural(totalLines, "line")}${errorsNote(outcome)}`,
        final: outcome.pending,
        rawOutput
      }
    }
    const hash = outcome.contentHash ? `\ncontent_hash: ${outcome.contentHash}; total_lines: ${linesOf(content).length}` : ""
    return {
      output: outcome.message + hash + indexChangeNote(outcome),
      summary: `${outcome.pending ? "proposed a new file" : "created"} \`${rel}\` · ${plural(linesOf(content).length, "line")}${errorsNote(outcome)}`,
      final: outcome.pending
    }
  }
})

// Shared by tool sets/conversations: checkpoint, transaction and recovery stay together.
let mutationTail: Promise<unknown> = Promise.resolve()
const serializeMutation = <T>(run: () => Promise<T>): Promise<T> => {
  const result = mutationTail.then(run)
  mutationTail = result.then(() => undefined, () => undefined)
  return result
}

/** The one-line result for an edit_lines refusal: the error as JSON, for the model to read. Failed calls are logged by the loop. */
const lineEditErrorResult = (error: LineEditFailure): ToolResult => ({
  output: JSON.stringify({ ok: false, error, ...(error.current_hash ? { hash_algorithm: error.current_hash.split(":")[0] } : {}) }),
  summary: `edit_lines failed · ${error.message}`,
  failed: true
})

const numberedRangeText = (path: string, text: string, range: RefreshedRange): string => {
  const lines = text ? text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n") : []
  const start = Math.max(1, range.startLine)
  const end = Math.min(lines.length, range.endLine)
  if (!lines.length || end < start) return `${path}:${start}-${end}`
  return `${path}:${start}-${end}\n` + lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join("\n")
}

const lineEditOutcomeErrorResult = (view: WorkspaceView, absolute: string, outcome: EditOutcome): ToolResult => {
  if (!outcome.error) return lineEditErrorResult(lineEditFailure("application_failed", outcome.message))
  const sourceVersion = outcome.sourceVersion ?? outcome.error.source_version ?? "unchanged"
  const mutationOccurred = outcome.error.mutation_occurred
    ?? (outcome.postSave === "conflicted" ? true : outcome.postSave === "unresolved" ? undefined : false)
  const rel = view.relative(absolute)
  const refreshed = (outcome.refreshedRanges ?? outcome.error.refreshed_ranges ?? []).map((range) => {
    const raw = range as RefreshedRange & { start_line?: number; end_line?: number }
    return {
      path: rel,
      start_line: raw.start_line ?? raw.startLine,
      end_line: raw.end_line ?? raw.endLine,
      ...(raw.uncertain ? { uncertain: true } : {})
    }
  })
  const error = {
    ...outcome.error,
    ...(outcome.finalText !== undefined ? { current_text: outcome.finalText } : {}),
    ...(outcome.totalLines !== undefined ? { total_lines: outcome.totalLines } : {}),
    ...(refreshed.length ? { refreshed_ranges: refreshed } : {}),
    ...(mutationOccurred === undefined ? { mutation_occurred: undefined } : { mutation_occurred: mutationOccurred }),
    source_version: sourceVersion
  }
  const recoveryText = outcome.finalText ?? outcome.error.current_text
  const recoveryRanges = outcome.refreshedRanges ?? outcome.error.refreshed_ranges
  const excerpts = recoveryText !== undefined
    ? (recoveryRanges ?? []).map((range) => {
        const raw = range as RefreshedRange & { start_line?: number; end_line?: number }
        return numberedRangeText(rel, recoveryText, {
          startLine: raw.start_line ?? raw.startLine,
          endLine: raw.end_line ?? raw.endLine,
          uncertain: raw.uncertain
        })
      }).join("\n")
    : ""
  const output: Record<string, unknown> = {
    ok: false,
    error,
    ...(outcome.error.current_hash ? { hash_algorithm: outcome.error.current_hash.split(":")[0] } : {}),
    ...(outcome.contentHash ? { content_hash: outcome.contentHash, final_hash: outcome.contentHash, next_expected_hash: outcome.contentHash } : {}),
    ...(!outcome.contentHash && outcome.error.current_hash ? { current_hash: outcome.error.current_hash } : {}),
    ...(outcome.previousHash ? { previous_hash: outcome.previousHash } : {}),
    ...(outcome.intendedHash ? { intended_hash: outcome.intendedHash } : {}),
    ...(outcome.postSave ? { post_save: outcome.postSave === "applied_exactly" ? "exact" : outcome.postSave === "applied_and_transformed" ? "transformed" : outcome.postSave } : {}),
    ...(outcome.requestedEdits ? { requested_edits: outcome.requestedEdits } : {}),
    ...(refreshed.length ? { refreshed_ranges: refreshed } : {}),
    source_version: sourceVersion,
    ...(outcome.previousSourceVersion ? { previous_source_version: outcome.previousSourceVersion } : {}),
    ...(excerpts ? { recovery_source: excerpts } : {})
  }
  const rawOutput = JSON.stringify(output)
  return { output: rawOutput, summary: `edit_lines failed · ${outcome.error.message}`, failed: true, rawOutput }
}

const editLines = (view: WorkspaceView, apply: NonNullable<EditSink["editLines"]>, resolve: (args: ToolArguments, context?: ToolContext) => Promise<ResolvedTarget>): Tool => ({
  name: "edit_lines",
  description:
    "The standard way to change an existing source file. Edit complete source lines atomically, guarded by expected_hash from read_file (the fingerprint of the entire editor buffer). " +
    "All coordinates refer to the SAME original snapshot, not earlier edits, and ranges may be supplied in any order; they are applied from the bottom of the file upwards. Lines are 1-based; a terminal newline is not an extra line. " +
    "replace/delete use inclusive start_line/end_line, or line as shorthand for both start_line and end_line (for example line=2 replaces/deletes only line 2). Combining line with start_line or end_line is ambiguous and refused. insert_before accepts 1 through total_lines+1; insert_after accepts 1 through total_lines. " +
    "For an empty document only insert_before line=1 or insert_after line=0 is valid. EOF insertion preserves the final-newline convention. " +
    "content is an array of complete lines without newline characters (use [''] for a blank line). " +
    "Use `replace_text` for small modifications within an existing line, especially long lines. Supply the whole-file `expected_hash`, the original 1-based line number, and the exact substring to replace. Do not reproduce the complete line. Its fields are line, old_text and new_text: old_text must occur exactly once on that line, matching is literal and case-sensitive with no fallback to another line, an empty new_text removes the match, and neither operand may hold a newline. A missing or ambiguous match refuses the whole batch before anything changes. " +
    "Overlaps, same-boundary insertions and insertions touching a replaced/deleted boundary are rejected. " +
    "A stale_hash leaves everything unchanged and returns current_hash; reread, never retry blindly. " +
    "Uses existing edit permissions; review/protected files require approval. Edits apply to the editor buffer, so the user's unsaved changes in the file are kept (and saved with it when save is true). The document is shown in an editor so diagnostics are checked: in background mode (the default) it is used in place if already open, otherwise shown as a preview tab without taking focus; in visible mode it is shown in a persistent tab that takes focus. By default (save true) the complete document is saved and read back: persisted is true, content_source is disk, and content_hash is the saved file's fingerprint, the expected_hash for the next edit to the same file. save false is only for when the task instructions ask for it and the editor mode is visible; otherwise it is refused with permission_denied and nothing changes. A save false edit is left unsaved for review: persisted is false, the file on disk is unchanged, and a build from disk does not include it. If saving fails the error code is save_failed: the edit stays in the unsaved editor buffer, the file on disk may not have it, and current_hash is the buffer's fingerprint.",
  guidance:
    "To change existing source: read_file for its numbered lines and content_hash, then call edit_lines with that expected_hash and the line operations. " +
    "Use the content_hash it returns for the next edit to the same file. Reread only after a stale_hash, or when the lines you need were not in the last read. " +
    "Use `replace_text` for small modifications within an existing line, especially long lines. Supply the whole-file `expected_hash`, the original 1-based line number, and the exact substring to replace. Do not reproduce the complete line. " +
    "A file can also be named by the fingerprint read_file gave for it: with no path, expected_hash resolves the one current file it matches. When more than one file matches, nothing is chosen and the call is refused with ambiguous_hash.",
    // A fingerprint read_file gave can name the file on its own, when it matches exactly one.
    hashAddressable: true,
  parameters: [
    { name: "path", description: "Workspace-relative file path; optional when expected_hash names exactly one current file the tools may use.", optional: true, type: "string" },
    { name: "expected_hash", description: "Prefixed content_hash from read_file; legacy unprefixed 64-character SHA-256 is accepted.", type: "string" },
    { name: "edits", description: "Array of line operations in any order, all against the original snapshot. Each has operation: replace {operation,start_line,end_line,content} or delete {operation,start_line,end_line}, insert_before/insert_after {operation,line,content}, or replace_text {operation,line,old_text,new_text} for one exact substring inside one line.", type: "array" },
    { name: "save", description: "Optional, default true. false leaves the edit unsaved for review; only allowed when the editor mode is visible and the task instructions say so.", optional: true, type: "boolean" }
  ],
  schema: {
    type: "object",
    required: ["expected_hash", "edits"],
    additionalProperties: false,
    properties: {
      path: { type: "string" },
      expected_hash: { type: "string", pattern: "^(xxh64:[a-f0-9]{16}|xxh3_128:[a-f0-9]{32}|sha256:[a-f0-9]{64}|[a-f0-9]{64})$", description: "Full-document content_hash from read_file." },
      save: { type: "boolean", description: "Default true: save the complete document to disk. false: leave the edit unsaved in the editor; only allowed when the editor mode is visible and the task instructions ask for it." },
      edits: {
        type: "array", minItems: 1,
        description: "Line operations in any order, all against the original snapshot. Each object's key is operation, set to replace, delete, insert_before, insert_after or replace_text; not type, op or action.",
        items: {
          type: "object",
          description: "replace and delete use start_line and end_line (inclusive, 1-based), or line as shorthand for both. Do not combine line with start_line or end_line. insert_before and insert_after use line. replace_text uses line plus the exact old_text and new_text, so a long line does not have to be retyped. replace and inserts require content, an array of complete lines.",
          required: ["operation"],
          properties: {
            operation: { type: "string", enum: LINE_EDIT_OPERATIONS, description: "The change to make; this key is required." },
            start_line: { type: "integer", minimum: 1, description: "replace or delete: first line, 1-based." },
            end_line: { type: "integer", minimum: 1, description: "replace or delete: last line, 1-based, inclusive." },
            line: { type: "integer", minimum: 0, description: "insert_before: insert before this line (1 or more). insert_after: insert after this line (0 inserts at the top). replace_text: the line to search, 1-based, in the snapshot expected_hash names." },
            content: { type: "array", minItems: 1, items: { type: "string" }, description: "replace or insert: the new complete lines, without newline characters." },
            old_text: { type: "string", minLength: 1, pattern: "^[^\\r\\n]+$", description: "replace_text: the exact substring to replace, copied from the line as read_file printed it. It must occur once on that line." },
            new_text: { type: "string", pattern: "^[^\\r\\n]*$", description: "replace_text: what that substring becomes. An empty string removes it." }
          },
          oneOf: LINE_EDIT_OPERATIONS.map((operation) => {
            const insertion = operation.startsWith("insert_")
            const substring = operation === "replace_text"
            return {
              type: "object", additionalProperties: false,
              required: ["operation", ...(substring ? ["line", "old_text", "new_text"] : insertion ? ["line"] : []), ...(operation === "delete" || substring ? [] : ["content"])],
              properties: {
                operation: { type: "string", enum: [operation] },
                ...(substring ? {
                  line: { type: "integer", minimum: 1 },
                  old_text: { type: "string", minLength: 1, pattern: "^[^\\r\\n]+$" },
                  new_text: { type: "string", pattern: "^[^\\r\\n]*$" }
                } : insertion ? { line: { type: "integer", minimum: operation === "insert_after" ? 0 : 1 } } : {
                  line: { type: "integer", minimum: 1, description: "Shorthand for start_line and end_line for one line." },
                  start_line: { type: "integer", minimum: 1 }, end_line: { type: "integer", minimum: 1 }
                }),
                ...(operation === "delete" || substring ? {} : { content: { type: "array", minItems: 1, items: { type: "string", pattern: "^[^\\r\\n]*$" } } })
              },
              ...(substring || insertion ? {} : {
                anyOf: [
                  { required: ["line"] },
                  { required: ["start_line", "end_line"] }
                ],
                not: {
                  anyOf: [
                    { required: ["line", "start_line"] },
                    { required: ["line", "end_line"] }
                  ]
                }
              })
            }
          })
        }
      }
    }
  },
  async run(raw, context) {
    const a = argumentReader("edit_lines", raw)
    const hash = normalizeFingerprint(a.raw("expected_hash"))
    if (!hash) return lineEditErrorResult(lineEditFailure("invalid_hash", "edit_lines needs expected_hash: the content fingerprint read_file gave for this file.", undefined, { required_argument: "expected_hash", recovery: "Read the file to get its fingerprint, then edit that." }))
    const source = context?.source ?? (await resolve(raw, context))
    if (!source.ok) return lineEditErrorResult(lineEditFailure(source.detail.code, source.detail.message, source.detail.current_hash, {
      required_argument: source.detail.required_argument,
      candidates: source.detail.candidates,
      recovery: source.detail.recovery,
      ...(source.detail.code === "stale_hash" || source.detail.code === "hash_mismatch" ? { source_version: "unchanged", mutation_occurred: false } : {})
    }))
    const absolute = source.absolute
    // A real boolean stays a boolean: false means do not save, and an absent field keeps the default.
    const save = a.sent("save") ? a.flag("save") : true
    const operations = a.raw("edits")
    if (!Array.isArray(operations)) return lineEditErrorResult(lineEditFailure(
      "invalid_argument_type",
      "edit_lines requires edits to be a JSON array of operation objects, not a string or other value.",
      undefined,
      { required_argument: "edits", recovery: "Read the file again if stale, then send edits as an array, for example [{\"operation\":\"replace\",\"start_line\":1,\"end_line\":1,\"content\":[\"new\"]}]." }
    ))
    const outcome = await apply(source.absolute, { expected_hash: hash, edits: operations }, save, context?.write ?? source.write)
    if (!outcome.ok) return lineEditOutcomeErrorResult(view, absolute, outcome)
    if (!outcome.contentHash) return lineEditErrorResult(lineEditFailure("application_failed", "The editor did not return the resulting document hash."))
    if (outcome.postSave || outcome.finalText !== undefined) {
      const rel = view.relative(absolute)
      const ranges = outcome.refreshedRanges ?? []
      const output: Record<string, unknown> = {
        ok: true,
        path: rel,
        save: outcome.persisted === false ? "unsaved" : "completed",
        post_save: outcome.postSave === "applied_and_transformed"
          ? "transformed"
          : outcome.postSave === "applied_exactly"
            ? "exact"
            : outcome.postSave,
        requested_edits: outcome.requestedEdits ?? "verified",
        previous_hash: outcome.previousHash,
        intended_hash: outcome.intendedHash,
        content_hash: outcome.contentHash,
        final_hash: outcome.contentHash,
        next_expected_hash: outcome.contentHash,
        hash_algorithm: outcome.contentHash.split(":")[0],
        content_source: outcome.contentSource,
        persisted: outcome.persisted ?? false,
        source_version: outcome.sourceVersion ?? "changed",
        previous_source_version: outcome.previousSourceVersion ?? "superseded",
        ...(outcome.transformationNotice ? { transformation_notice: outcome.transformationNotice } : {}),
        ...(outcome.totalLines !== undefined ? { total_lines: outcome.totalLines } : {}),
        refreshed_ranges: ranges.map((range) => ({
          path: rel,
          start_line: range.startLine,
          end_line: range.endLine,
          ...(range.uncertain ? { uncertain: true } : {})
        })),
        index_refresh: outcome.indexRefresh?.status === "failed" ? { status: "failed", reason: outcome.indexRefresh.reason } : undefined,
        message: outcome.message + indexRefreshNote(outcome)
      }
      const excerpts = outcome.finalText !== undefined
        ? ranges.map((range) => numberedRangeText(rel, outcome.finalText!, range)).join("\n")
        : ""
      const richOutput = excerpts ? { ...output, refreshed_source: excerpts } : output
      const rawOutput = JSON.stringify(richOutput)
      return {
        output: rawOutput,
        summary: `edited \`${rel}\` by lines${errorsNote(outcome)}`,
        rawOutput
      }
    }
    return {
      output: JSON.stringify({ ok: true, path: view.relative(absolute), content_hash: outcome.contentHash, hash_algorithm: outcome.contentHash.split(":")[0], content_source: outcome.contentSource, persisted: outcome.persisted ?? false, index_refresh: outcome.indexRefresh?.status === "failed" ? { status: "failed", reason: outcome.indexRefresh.reason } : undefined, message: outcome.message + indexRefreshNote(outcome) }),
      summary: `edited \`${view.relative(absolute)}\` by lines${errorsNote(outcome)}`
    }
  }
})

/** Retired exact-text replacement; registered only when `legacyEditFile` is set. Models edit with `edit_lines`. */
const editFile = (view: WorkspaceView, sink: EditSink): Tool => ({
  name: "edit_file",
  description: `${EDIT_DESCRIPTION[sink.mode]} Copy find from read_file output, without the line numbers, with enough lines that it matches once.`,
  guidance: EDIT_GUIDANCE[sink.mode],
  parameters: [
    { name: "path", description: "The file to change." },
    { name: "find", description: "Text already in the file, copied exactly." },
    { name: "replace", description: "What it becomes." }
  ],
  async run(raw, context) {
    const a = argumentReader("edit_file", raw)
    const file = a.text("path")
    const find = a.text("find")
    const replace = a.text("replace")
    if (!file) throw new ToolInputError("edit_file needs a path.")
    if (find === undefined || replace === undefined) {
      throw new ToolInputError("edit_file needs find and replace.")
    }
    const absolute = view.resolve(file, "file")
    const rel = view.relative(absolute)
    const text = await view.text(absolute)
    if (text === undefined) throw new ToolInputError(`${rel} is binary or too large to edit.`)
    const plan = planReplacement(text, find, replace)
    if (typeof plan === "string") throw new ToolInputError(`${rel}: ${plan}${/[.\n]$/.test(plan) ? "" : "."}`)
    const lines =
      plan.startLine === plan.endLine ? `${plan.startLine + 1}` : `${plan.startLine + 1}–${plan.endLine + 1}`
    const outcome = await sink.edit(absolute, plan, context?.write)
    if (!outcome.ok) {
      return { output: outcome.message, summary: `\`${rel}\` not changed · ${outcome.message}`, failed: true }
    }
    return {
      output: outcome.message + indexRefreshNote(outcome),
      summary: `${outcome.pending ? "proposed an edit to" : "edited"} \`${rel}:${lines}\`${errorsNote(outcome)}`,
      final: outcome.pending
    }
  }
})

export interface WorkspaceTools {
  tools: Tool[]
  /** A line naming the top-level entries, so the model starts oriented. */
  orientation: string
  /** The root's instructions for agents (`AGENTS.md`), for the system prompt. */
  instructions?: InstructionFile
  /** The instruction files used so far: the root's, then each folder's as a tool reached it. */
  instructionFiles?(): string[]
  run(call: ToolCall, context?: ToolContext): Promise<ToolResult>
}

/**
 * Where commands run: a terminal in the extension. `ask` puts each one to
 * the user first; `allow` runs it straight away.
 */
export interface CommandSink {
  mode: "ask" | "allow"
  run(command: string, signal?: AbortSignal): Promise<CommandOutcome>
}

export interface CommandOutcome {
  /** False when the user skipped it. */
  ran: boolean
  /** The tail of what it printed, ANSI stripped. */
  output: string
  exitCode?: number
  /**
   * The wait ran out before the command ended: `running` when it was left
   * to carry on (a server in the terminal), `stopped` when it was ended.
   */
  timedOut?: "running" | "stopped"
  /** It was stopped by the user's stop on its step; the reply carries on. */
  stoppedByUser?: boolean
  /** Per-stream byte references, when separate pipes were attached at launch. Never invented after the fact.
   * A merged PTY transcript is one `terminal` stream, not a stdout and a stderr.
   */
  streams?: { stdout?: string; stderr?: string; terminal?: string }
  captureMode?: CaptureMode
}

/** A hit from the embeddings index. Lines are 0-based, inclusive. */
export interface CodeHit {
  file: string
  startLine: number
  endLine: number
  score: number
  content: string
}

/** Search by meaning over the workspace's embeddings index. */
export interface CodeSearch {
  search(query: string): Promise<CodeHit[]>
}

const MAX_COMMAND_CHARS = 65536 /*1000 chars, WTF kind of shell command is this? 64 KiB, a reasonable upper limit */
const MAX_SEARCH_OUTPUT_CHARS = 6000

const runCommand = (sink: CommandSink): Tool => ({
  name: "run_command",
  description:
    "Run a shell command in the workspace root and get its exit code and the end of its output: tests, builds, type checks." +
    (sink.mode === "ask" ? " The user is asked before it runs and may skip it." : " It runs straight away."),
  guidance:
    "Use run_command to check your work (tests, type checks, builds). Never run commands that delete files, rewrite history or install software unless the user asked for exactly that. Nothing can answer a prompt, and you get the output after two minutes at most: no interactive commands, servers or watch modes.",
  parameters: [{ name: "command", description: "One command line for the user's shell." }],
  async run(raw, context) {
    const a = argumentReader("run_command", raw)
    const command = a.text("command")
    const line = command?.trim()
    if (!line) throw new ToolInputError("run_command needs a command.")
    if (line.length > MAX_COMMAND_CHARS) throw new ToolInputError("That command is too long; write a shorter one.")
    const outcome = await sink.run(line, context?.signal)
    if (!outcome.ran) {
      return {
        output: "The user chose not to run this command. Carry on without it, or ask the user.",
        summary: `\`${line}\` skipped`
      }
    }
    if (outcome.stoppedByUser) {
      return {
        execution: { command: line, output: outcome.output },
        output: `$ ${line}\n(stopped by the user before it ended; this is its output so far)\n${outcome.output.trim() || "(no output)"}`,
        summary: `\`${line}\` stopped`
      }
    }
    const status =
      outcome.timedOut === "running"
        ? "still running when the wait ran out; this is its output so far"
        : outcome.timedOut === "stopped"
          ? "stopped: it ran longer than the wait allows; this is its output so far"
          : outcome.exitCode === undefined
            ? "finished; the shell did not report an exit code"
            : `exit code ${outcome.exitCode}`
    const outcomeWord = outcome.timedOut
      ? outcome.timedOut === "running" ? "still running" : "timed out"
      : outcome.exitCode === undefined ? "done" : `exit ${outcome.exitCode}`
    return {
      failed: outcome.timedOut === "running" || (outcome.exitCode !== undefined && outcome.exitCode !== 0),
      execution: { command: line, output: outcome.output, exitCode: outcome.exitCode, ...(outcome.streams === undefined ? {} : { streams: outcome.streams }), ...(outcome.captureMode === undefined ? {} : { captureMode: outcome.captureMode }) },
      output: `$ ${line}\n(${status})\n${outcome.output.trim() || "(no output)"}`,
      summary: `ran \`${line}\` · ${outcomeWord}`
    }
  }
})

const searchCode = (view: WorkspaceView, index: CodeSearch): Tool => ({
  name: "search_code",
  readOnly: true,
  description:
    "Find code by what it does, described in plain words (\"where retries are scheduled\", \"how the token is refreshed\"). Searches the workspace's embeddings index; use grep instead for an exact name.",
  guidance:
    "Start with search_code when you do not know where something lives; it finds code by meaning.",
  parameters: [{ name: "query", description: "What the code does, in a few words." }],
  async run(raw) {
    const a = argumentReader("search_code", raw)
    const query = a.text("query")
    const wanted = query?.trim()
    if (!wanted) throw new ToolInputError("search_code needs a query.")
    // The index is built from the same files, but it is older than the
    // rules: nothing ignored since comes back through it.
    const hits = (await index.search(wanted)).filter((hit) => view.visible(hit.file))
    const blocks: string[] = []
    let used = 0
    for (const hit of hits) {
      const header = `${view.relative(hit.file)}:${hit.startLine + 1}-${hit.endLine + 1} (relevance ${hit.score.toFixed(2)})`
      const block = `${header}\n${hit.content.trimEnd()}`
      if (used + block.length > MAX_SEARCH_OUTPUT_CHARS) {
        blocks.push(`${header}\n… (not shown; read_file it)`)
        continue
      }
      blocks.push(block)
      used += block.length
    }
    return {
      output: blocks.length
        ? blocks.join("\n\n")
        : "Nothing in the index matched well. Try other words, or grep for a name.",
      summary: `searched the index for \`${wanted}\` · ${plural(hits.length, "hit")}`
    }
  }
})

const searchWorkspace = (view: WorkspaceView, index: WorkspaceSearchProvider): Tool => ({
  name: "search_workspace",
  readOnly: true,
  description: "Search indexed workspace paths, language-service symbols, and source contents. Use auto for a combined search, path for names, symbol for definitions, literal for exact identifiers/punctuation, or regex for regular expressions.",
  guidance: "Search results are discovery aids only. Use read_file for the authoritative current editor buffer and its content_hash before making any edit; edit_lines verifies that fingerprint.",
  parameters: [
    { name: "query", description: "Filename, symbol, exact source text, or regular expression." },
    { name: "mode", description: "auto, path, symbol, literal, or regex; defaults to auto.", optional: true },
    { name: "path", description: "Optional workspace-relative file, directory prefix (for example src/extension), or glob (for example src/**/*.ts) filter.", optional: true },
    { name: "limit", description: "Maximum result count, 1-100.", optional: true, type: "integer" },
    { name: "offset", description: "Zero-based result offset for pagination.", optional: true, type: "integer" }
  ],
  schema: {
    type: "object",
    required: ["query"],
    additionalProperties: false,
    properties: {
      query: { type: "string", minLength: 1 },
      mode: { type: "string", enum: ["auto", "path", "symbol", "literal", "regex"], default: "auto" },
      path: { type: "string", description: "Workspace-relative file, directory prefix (for example src/extension), or glob (for example src/**/*.ts)." },
      limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      offset: { type: "integer", minimum: 0, default: 0 }
    }
  },
  async run(raw, context) {
    const a = argumentReader("search_workspace", raw)
    const query = a.text("query")
    const mode = a.text("mode")
    const pathArg = a.text("path")
    const limit = a.number("limit")
    const offset = a.number("offset")
    const wanted = query?.trim()
    if (!wanted) throw new ToolInputError("search_workspace needs a nonempty query.")
    rejectInternalIdentifier("search_workspace", wanted)
    const selectedMode = mode || "auto"
    if (selectedMode !== "auto" && selectedMode !== "path" && selectedMode !== "symbol" && selectedMode !== "literal" && selectedMode !== "regex") {
      throw new ToolInputError("search_workspace mode must be auto, path, symbol, literal, or regex.")
    }
    const pageSize = limit === undefined ? 20 : Number(limit)
    const pageOffset = offset === undefined ? 0 : Number(offset)
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100 || !Number.isSafeInteger(pageOffset) || pageOffset < 0) {
      throw new ToolInputError("limit must be 1-100 and offset must be a nonnegative integer.")
    }
    const result = await index.search({ query: wanted, mode: selectedMode, path: pathArg || undefined, limit: pageSize, offset: pageOffset }, view.root, context?.signal)
    return {
      output: JSON.stringify({ query: wanted, mode: selectedMode, total: result.total, offset: pageOffset, limit: pageSize, results: result.results.map((hit) => ({
        path: hit.path,
        line: hit.line,
        column: hit.column,
        category: hit.category,
        symbol: hit.symbol,
        kind: hit.kind,
        preview: hit.preview,
        source: hit.source
      })) }),
      summary: `searched workspace for \`${wanted}\` · ${plural(result.total, "match")}`
    }
  }
})

/** What the tools can reach beyond reading files, when the host provides it. */
export interface ToolExtras {
  edits?: EditSink & Partial<FileOpsSink>
  /**
   * Registers the retired exact-text `edit_file` for internal callers and tests.
   * Model-facing sessions never set it; they edit with `edit_lines`.
   */
  legacyEditFile?: boolean
  commands?: CommandSink
  codeSearch?: CodeSearch
  workspaceSearch?: WorkspaceSearchProvider
  /** The editor's language servers and open files. */
  editor?: EditorSink
  /** The maximum number of lines a single `read_file` result may show. */
  readFileMaxLines?: number
  /** Whether a whole-file `read_file` may return more lines than `readFileMaxLines`; off by default. */
  readFileAllowFullFile?: boolean
  /** Whether `git` is offered when the root is in a repository; on by default. */
  git?: boolean
  /** Whether the project's `AGENTS.md` files are read; on by default. */
  instructions?: boolean
  /** The canonical native TODO service and host-trusted chat scope. */
  todos?: { repository: TodoRepository; scope: TodoWriteRequest; onChanged: () => void; options?: TodoToolOptions }
  /** Tools from MCP servers the user set up, and how to call one. */
  mcp?: McpSink
  /**
   * Asks before a call touches a path outside the workspace. Without it,
   * such paths are refused, as they always were.
   */
  access?: AccessPreflight
  /**
   * Where the project keeps fingerprints, for a call that names a file by its
   * content instead of its path. Candidates only: the current content decides.
   */
  fingerprintIndex?: FingerprintCandidates
  /** Files open in the editor, whose buffer may not be what the index recorded. */
  openFiles?: () => string[]
  /** Stage 2's read-only access service for this project, when the host holds one: it registers `query_evidence`. Without it the tool is not offered, so no message may recommend it. */
  evidence?: { access: EvidenceAccess }
  /** Stage 3's Git service options, when the host has the stores and the conversation this call belongs to. */
  gitOptions?: Omit<GitServiceOptions, "view">
}

/**
 * Where MCP tools go: the host has the servers running, puts each call to
 * the user as it says, and turns the answer into a result.
 */
export interface McpSink {
  tools: McpToolSpec[]
  call(tool: McpToolSpec, args: Record<string, unknown>, context?: ToolContext): Promise<ToolResult>
}

const mcpTool = (spec: McpToolSpec, sink: McpSink): Tool => ({
  ...spec,
  run: (args, context) => sink.call(spec, coerceArguments(spec.schema as JsonSchema | undefined, args), context)
})

/** Arguments that name a place in the workspace, whose folders' instructions apply. */
const PLACE_ARGUMENTS = ["path", "from", "to"]

/**
 * The reading tools, plus `search_code`, the editor's tools, `create_file`,
 * `edit_lines` and its kin, and `run_command`, when there is an index to search, an
 * editor to ask, somewhere for edits to go and a terminal to run in.
 * `root` is the folder, or a view of it the host already made (so its
 * sinks can share the view's rules).
 */
export const workspaceTools = (
  root: string | WorkspaceView,
  ignoredGlobs: string[] = [],
  extras: ToolExtras = {}
): WorkspaceTools => {
  const { edits, commands, codeSearch, workspaceSearch, editor, readFileMaxLines, readFileAllowFullFile } = extras
  const view =
    typeof root === "string" ? new WorkspaceView(root, ignoredGlobs, edits?.read?.bind(edits)) : root
  /** The shared resolver: a call may name its file by the fingerprint it was given. */
  const resolverOptions: SourceResolverOptions = {
    view,
    index: extras.fingerprintIndex,
    openFiles: extras.openFiles,
    cache: new Map<string, string[]>(),
    authorize: (targets, tool, signal) =>
      extras.access ? extras.access.authorize(targets, tool, signal) : Promise.resolve({ ok: true })
  }

  /** What a mutating tool does to the file it names, for the write that allows it. */
  const mutationOperationOf = (name: string): WriteOperation | undefined => {
    if (name === "create_file") return "create"
    if (name === "delete_file") return "remove"
    if (name === "move_file") return "move"
    return name === "edit_lines" ? "edit" : undefined
  }

  /** A tool that can be pointed at a file by content, resolved the same way for every caller. */
  const resolveFor = (tool: string, kind: "read" | "write", operation?: WriteOperation) =>
    (args: ToolArguments, context?: ToolContext): Promise<ResolvedTarget> =>
      resolveSourceTarget(resolverOptions, { tool, args, kind, operation, signal: context?.signal })
  const tools = [
    ...(codeSearch ? [searchCode(view, codeSearch)] : []),
    ...(editor ? [editorContext(view, editor)] : []),
    listDir(view),
    findFiles(view, workspaceSearch),
    ...(workspaceSearch ? [searchWorkspace(view, workspaceSearch)] : []),
    readFile(view, readFileMaxLines, edits, readFileAllowFullFile),
    grep(view),
    findSymbol(view),
    ...(editor ? [goToDefinition(view, editor), findReferences(view, editor), diagnostics(view, editor)] : []),
    ...(extras.git !== false && insideGitRepository(view.root) ? [git(view, { ...(extras.gitOptions ?? {}), access: extras.access })] : [])
  ]
  if (edits && extras.legacyEditFile) tools.push(editFile(view, edits))
  if (edits) tools.push(createFile(view, edits))
  if (edits?.editLines) tools.push(editLines(view, edits.editLines.bind(edits), resolveFor("edit_lines", "write", "edit")))
  if (edits && editor) tools.push(renameSymbol(view, editor, extras.access))
  if (edits?.remove && edits.move) {
    const ops = { remove: edits.remove.bind(edits), move: edits.move.bind(edits) }
    tools.push(moveFile(view, ops), deleteFile(view, ops))
  }
  if (commands) tools.push(runCommand(commands))
  if (extras.todos) tools.push(...todoTools(extras.todos.repository, extras.todos.scope, extras.todos.onChanged, extras.todos.options))
  if (extras.evidence) tools.push(...evidenceTools(extras.evidence.access))
  for (const spec of extras.mcp?.tools ?? []) tools.push(mcpTool(spec, extras.mcp!))
  const top = view.entries(view.root).map((e) => (e.dir ? `${e.name}/` : e.name))
  const reading = extras.instructions !== false
  const instructions = reading ? readRootInstructions(view.root) : undefined
  const folders = reading ? new FolderInstructions(view) : undefined
  /** A finished call with the instructions of the folders it reached, the first time the reply reaches them. */
  const withFolderInstructions = (call: ToolCall, result: ToolResult): ToolResult => {
    if (!folders || result.failed) return result
    const found = PLACE_ARGUMENTS.flatMap((name) => { const place = textArgument("workspace", name, call.args); return place ? folders.for(place) : [] })
    return found.length ? { ...result, preface: found.map(folderInstructionsNote).join("\n\n") } : result
  }
  return {
    tools,
    orientation: `The workspace root contains: ${top.slice(0, 40).join(", ")}${top.length > 40 ? ", …" : ""}`,
    instructions,
    instructionFiles: () => [...(instructions ? [instructions.path] : []), ...(folders?.given ?? [])],
    async run(call, context) {
      const tool = tools.find((t) => t.name === call.name)
      if (!tool) {
        return {
          output: `There is no tool called ${call.name}. The tools are ${tools.map((t) => t.name).join(", ")}.`,
          summary: `asked for an unknown tool \`${call.name}\``,
          failed: true
        }
      }
      return runTool(tool, call, context)
    }
  }

  async function runTool(tool: Tool, call: ToolCall, context?: ToolContext): Promise<ToolResult> {
    let write: OperationAuthorization | undefined
    const startedAt = Date.now()
    diagnosticEvent("toolcalls", "tool.native.execution.start", context?.diagnostic ?? {}, {
      toolName: call.name,
      implementationType: "native",
      parsedArguments: call.args,
      authorizationDecision: "checking"
    })
    try {
      const args = argumentObject(call.args, call.name)
      checkDeclaredArguments(call.name, tool.parameters, args)
      /** Whether this call reads, as the tool says when the call itself decides (a typed git operation). */
      const reads = tool.readOnlyFor ? tool.readOnlyFor(args) : tool.readOnly
      /** The file this call is about: the one it named, or the one its content fingerprint names. */
      let source: ResolvedSource | undefined
      if (tool.hashAddressable && !textArgument(call.name, "path", args)) {
        const resolved = await resolveSourceTarget(resolverOptions, { tool: call.name, args, kind: reads ? "read" : "write", operation: mutationOperationOf(call.name), signal: context?.signal })
        if (!resolved.ok) return structuredErrorResult(resolved.detail, call.name)
        source = resolved
      }
      if (extras.access && !source?.write) {
        const outcome = await extras.access.authorize(accessTargetsOf(call.name, args, view.root), call.name, context?.signal)
        if (!outcome.ok) {
          const refused = structuredErrorResult(
            argumentFailure("permission_denied", outcome.message, { required_argument: "path" }),
            call.name
          )
          diagnosticEvent("toolcalls", "tool.native.execution.finish", context?.diagnostic ?? {}, {
            toolName: call.name,
            implementationType: "native",
            parsedArguments: call.args,
            authorizationDecision: "denied",
            durationMs: Date.now() - startedAt,
            result: refused
          })
          return refused
        }
        write = outcome.write
      } else if (source?.write) {
        write = source.write
      }
      const run = () => {
        if (!reads && context?.signal?.aborted) throw new ToolInputError("The execution stopped before this tool could run.")
        // The write approval comes only from this call's authorization, never from the caller's context.
        return tool.run(args, { ...context, write, source })
      }
      const result = withFolderInstructions(call, await (reads ? run() : serializeMutation(run)))
      diagnosticEvent("toolcalls", "tool.native.execution.finish", context?.diagnostic ?? {}, {
        toolName: call.name,
        implementationType: "native",
        parsedArguments: call.args,
        authorizationDecision: write ? "approved-with-write" : "approved",
        durationMs: Date.now() - startedAt,
        rawResult: result,
        modelVisibleResult: result.output
      })
      return result
    } catch (error) {
      // Whatever goes wrong inside a tool is the model's to read and work
      // around; it never ends the reply. A refusal of the model's input is
      // given whole (it may show the lines to use instead); anything else,
      // and the step's summary, keeps to the first line.
      if (error instanceof ToolArgumentError) {
        if (call.name === "edit_lines") {
          const result = lineEditErrorResult(lineEditFailure(error.detail.code as LineEditFailureCode, error.detail.message, error.detail.current_hash, {
            required_argument: error.detail.required_argument,
            candidates: error.detail.candidates,
            recovery: error.detail.recovery
          }))
          diagnosticEvent("toolcalls", "tool.native.execution.finish", context?.diagnostic ?? {}, {
            toolName: call.name,
            implementationType: "native",
            parsedArguments: call.args,
            authorizationDecision: "approved",
            durationMs: Date.now() - startedAt,
            result,
            error: { name: error.name, message: error.message }
          })
          return result
        }
          if (!context?.diagnostic) {
            return {
              output: error.detail.message,
              summary: `${call.name} failed · ${error.detail.message.split("\n")[0]}`,
              failed: true
            }
          }
        const result = structuredErrorResult(error.detail, call.name)
        diagnosticEvent("toolcalls", "tool.native.execution.finish", context?.diagnostic ?? {}, {
          toolName: call.name,
          implementationType: "native",
          parsedArguments: call.args,
          authorizationDecision: "approved",
          durationMs: Date.now() - startedAt,
          result,
          error: { name: error.name, message: error.message }
        })
        return result
      }
      if (error instanceof LineEditError) {
        let detail = error.detail
        if (detail.code === "stale_hash" || detail.code === "hash_mismatch") {
          detail = {
            ...detail,
            source_version: "unchanged",
            mutation_occurred: false
          }
        }
        if ((detail.code === "stale_hash" || detail.code === "hash_mismatch") && context?.source?.absolute) {
          const text = await view.text(context.source.absolute)
          if (text !== undefined) {
            const lines = linesOf(text)
            const requested = typeof call.args.edits === "string" ? [] : Array.isArray(call.args.edits) ? call.args.edits as Array<Record<string, unknown>> : []
            const targets = requested.flatMap((edit) => {
              const line = typeof edit.line === "number" ? edit.line : typeof edit.start_line === "number" ? edit.start_line : undefined
              return line === undefined ? [] : [{ startLine: Math.max(1, line - 3), endLine: Math.min(Math.max(1, lines.length), line + 3) }]
            })
            const ranges = targets.length
              ? targets.sort((a, b) => a.startLine - b.startLine).reduce<Array<{ startLine: number, endLine: number }>>((merged, range) => {
                  const last = merged[merged.length - 1]
                  if (last && range.startLine <= last.endLine + 1) last.endLine = Math.max(last.endLine, range.endLine)
                  else merged.push({ ...range })
                  return merged
                }, [])
              : lines.length ? [{ startLine: 1, endLine: Math.min(lines.length, 7) }] : []
            detail = lineEditFailure(detail.code, detail.message, detail.current_hash, {
              current_text: text,
              total_lines: lines.length,
              refreshed_ranges: ranges,
              source_version: "unchanged",
              mutation_occurred: false
            })
          }
        }
        const result = lineEditErrorResult(detail)
        diagnosticEvent("toolcalls", "tool.native.execution.finish", context?.diagnostic ?? {}, {
          toolName: call.name,
          implementationType: "native",
          parsedArguments: call.args,
          authorizationDecision: "approved",
          durationMs: Date.now() - startedAt,
          result,
          error: { name: error.name, message: error.message }
        })
        return result
      }
      if (call.name === "edit_lines") {
        const message = error instanceof Error ? error.message : String(error)
        const result = lineEditErrorResult(lineEditFailure("application_failed", message))
        diagnosticEvent("toolcalls", "tool.native.execution.finish", context?.diagnostic ?? {}, {
          toolName: call.name,
          implementationType: "native",
          parsedArguments: call.args,
          authorizationDecision: "approved",
          durationMs: Date.now() - startedAt,
          result,
          error: { name: error instanceof Error ? error.name : "Error", message }
        })
        return result
      }
      const full = error instanceof Error ? error.message : String(error)
      const message = full.split("\n")[0]
      const result = error instanceof ToolInputError
        ? { output: full, summary: `${call.name} failed · ${message}`, failed: true }
        : { output: `${call.name} could not run: ${message}`, summary: `${call.name} failed · ${message}`, failed: true }
      diagnosticEvent("toolcalls", "tool.native.execution.finish", context?.diagnostic ?? {}, {
        toolName: call.name,
        implementationType: "native",
        parsedArguments: call.args,
        authorizationDecision: "approved",
        durationMs: Date.now() - startedAt,
        result,
        error: { name: error instanceof Error ? error.name : "Error", message: full }
      })
      return result
    } finally {
      // A once grant was for this call alone, and so is its write approval.
      extras.access?.endCall()
      write?.end()
    }
  }
}

export type WorkspaceSearchMode = "auto" | "path" | "symbol" | "literal" | "regex"
export interface WorkspaceSearchHit { uri?: string; path: string; line?: number; column?: number; category: "path" | "symbol" | "content"; symbol?: string; kind?: string; preview: string; source: "index" | "live" }
export interface WorkspaceSearchProvider {
  search(request: { query: string; mode?: WorkspaceSearchMode; path?: string; limit?: number; offset?: number }, scope?: string, signal?: AbortSignal): Promise<{ results: WorkspaceSearchHit[]; total: number }>
  /** Catch the index up with the files a dedicated native mutation just saved. */
  refresh?(changes: readonly IndexChange[]): Promise<IndexRefreshOutcome>
  /** Optional fingerprint leads and coverage from the unified project index. */
  candidatesFor?(fingerprint: string): Promise<string[]>
  coverage?(shown: string[]): Promise<{ complete: boolean; fresh: boolean; unexamined?: number; reason?: string }>
  /** Stage 4: the source changes an index observed (rename, create, delete, external change). Reporting one claims no state. */
  observeSourceEvents?(listener: (event: SourceEvent) => void): void
}
