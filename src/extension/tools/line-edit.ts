import { diffLines } from "../edit/diff"

import { fingerprintContent, verifyContentFingerprint } from "./fingerprint"
import { linesOf } from "./view"

export const contentHash = fingerprintContent

export type LineEditFailureCode = "hash_mismatch" | "invalid_range" | "overlapping_edits" | "document_unavailable" | "permission_denied" | "application_failed" | "save_failed" | "missing_target" | "invalid_hash" | "hash_not_found" | "ambiguous_hash" | "hash_unproven" | "malformed_arguments" | "missing_argument" | "invalid_argument_type"

/** `disk` when the saved file's bytes were read back and match; `buffer` when the text was not read from disk (left unsaved, or the bytes cannot be compared). */
export type ContentSource = "disk" | "buffer"

export interface LineEditFailure {
  code: LineEditFailureCode
  message: string
  current_hash?: string
  current_text?: string
  total_lines?: number
  refreshed_ranges?: RefreshedRange[]
  source_version?: "changed" | "unchanged"
  mutation_occurred?: boolean
  /** The argument the call was missing or sent with the wrong type. */
  required_argument?: string
  /** Paths the caller may be told about, when more than one file answers. */
  candidates?: string[]
  /** The smallest step that would make the same call work. */
  recovery?: string
}

export class LineEditError extends Error {
  constructor(readonly detail: LineEditFailure) {
    super(detail.message)
  }
}

export interface LineEditRequest {
  expected_hash: string
  edits: unknown
}

export interface LinePatch {
  start: number
  end: number
  text: string
  kind?: "replace_text" | "replace" | "delete" | "insert"
  startLine?: number
  endLine?: number
  line?: number
  oldText?: string
  newText?: string
  originalText?: string
  intendedText?: string
}

export interface RefreshedRange {
  startLine: number
  endLine: number
  uncertain?: boolean
}

export type EditReconciliation = "applied_exactly" | "applied_and_transformed" | "conflicted" | "unresolved"
export type RequestedEditVerification = "verified" | "conflicted" | "unresolved"

const normalizedLine = (line: string): string =>
  line.replace(/\r$/, "").trim().replace(/\s+/g, " ")

const textLines = (text: string): string[] => linesOf(text)

const mappingFromLineDiff = (before: string, after: string): Array<number | undefined> => {
  const beforeLines = textLines(before)
  const afterLines = textLines(after)
  const mapping = new Array<number | undefined>(beforeLines.length)
  let beforeIndex = 0
  let afterIndex = 0
  for (const entry of diffLines(beforeLines, afterLines)) {
    if (entry.kind === "equal") {
      mapping[beforeIndex++] = afterIndex++ + 1
    } else if (entry.kind === "remove") {
      beforeIndex++
    } else {
      afterIndex++
    }
  }
  return mapping
}

const mappedLine = (mapping: readonly (number | undefined)[], sourceLine: number): number => {
  const exact = mapping[sourceLine - 1]
  if (exact !== undefined) return exact
  for (let index = sourceLine - 2; index >= 0; index--) {
    if (mapping[index] !== undefined) return Math.max(1, mapping[index]! + sourceLine - index - 1)
  }
  for (let index = sourceLine; index < mapping.length; index++) {
    if (mapping[index] !== undefined) return Math.max(1, mapping[index]! - (index - sourceLine + 1))
  }
  return sourceLine
}

const boundedRange = (line: number, radius: number, totalLines: number): { startLine: number, endLine: number } => ({
  startLine: Math.max(1, line - radius),
  endLine: Math.min(Math.max(1, totalLines), line + radius)
})

const expandAndMergeRanges = (ranges: RefreshedRange[], totalLines: number): RefreshedRange[] => {
  const expanded = ranges
    .filter((range) => range.endLine >= 1)
    .map((range) => ({
      startLine: Math.max(1, range.startLine - 3),
      endLine: Math.min(Math.max(1, totalLines), range.endLine + 3),
      uncertain: range.uncertain
    }))
    .sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine)
  const merged: RefreshedRange[] = []
  for (const range of expanded) {
    const last = merged[merged.length - 1]
    if (last && range.startLine <= last.endLine + 1) {
      last.endLine = Math.max(last.endLine, range.endLine)
      last.uncertain = last.uncertain || range.uncertain
    } else {
      merged.push({ ...range })
    }
  }
  return merged
}

/** Diff regions in final line coordinates, plus the directly affected requested regions. */
export const refreshedRangesForEdit = (
  original: string,
  intended: string,
  final: string,
  patches: readonly LinePatch[]
): RefreshedRange[] => {
  const totalLines = textLines(final).length
  if (!totalLines) return []
  const ranges: RefreshedRange[] = []
  const mapping = mappingFromLineDiff(original, final)

  for (const patch of patches) {
    if (patch.kind === "replace_text" && patch.line !== undefined) {
      ranges.push({ startLine: mappedLine(mapping, patch.line), endLine: mappedLine(mapping, patch.line) })
    } else if (patch.kind === "replace" && patch.startLine !== undefined && patch.endLine !== undefined) {
      if (patch.startLine === 1 && patch.endLine === textLines(original).length) {
        ranges.push({ startLine: 1, endLine: totalLines })
      } else {
        ranges.push({
          startLine: mappedLine(mapping, patch.startLine),
          endLine: mappedLine(mapping, patch.endLine)
        })
      }
    } else if (patch.kind === "delete" && patch.startLine !== undefined) {
      if (patch.startLine === 1 && patch.endLine === textLines(original).length) {
        ranges.push({ startLine: 1, endLine: Math.max(1, totalLines) })
      } else {
        ranges.push({
          startLine: mappedLine(mapping, patch.startLine),
          endLine: mappedLine(mapping, patch.endLine ?? patch.startLine)
        })
      }
    } else if (patch.kind === "insert" && patch.line !== undefined) {
      ranges.push({ startLine: mappedLine(mapping, patch.line), endLine: mappedLine(mapping, patch.line) })
    }
  }

  const intendedLines = textLines(intended)
  const finalLines = textLines(final)
  let finalIndex = 0
  for (const entry of diffLines(intendedLines, finalLines)) {
    if (entry.kind === "equal") {
      finalIndex++
    } else if (entry.kind === "add") {
      ranges.push({ startLine: finalIndex + 1, endLine: finalIndex + 1 })
      finalIndex++
    } else {
      ranges.push({ startLine: Math.min(finalLines.length, finalIndex + 1), endLine: Math.min(finalLines.length, finalIndex + 1) })
    }
  }
  return expandAndMergeRanges(ranges, totalLines)
}

const windowLines = (text: string, range: { startLine: number, endLine: number }): string[] =>
  textLines(text).slice(Math.max(0, range.startLine - 1), Math.max(0, range.endLine))

const sequenceInWindow = (window: readonly string[], wanted: readonly string[]): boolean => {
  if (!wanted.length) return false
  const normalized = window
    .map((line) => normalizedLine(line).replace(/\s+/g, ""))
    .filter((line) => line.length > 0)
  const target = wanted.map((line) => normalizedLine(line).replace(/\s+/g, "")).filter((line) => line.length > 0)
  if (!target.length) return false
  for (let index = 0; index <= normalized.length - target.length; index++) {
    if (target.every((line, offset) => normalized[index + offset] === line)) return true
  }
  return false
}

const sequenceInText = (text: string, wanted: readonly string[]): boolean => {
  const window = textLines(text)
  return sequenceInWindow(window, wanted)
}

const patchSurvived = (patch: LinePatch, original: string, final: string, mapping: readonly (number | undefined)[]): boolean => {
  const totalLines = textLines(final).length
  if (patch.kind === "replace_text") {
    if (patch.line === undefined) return false
    const line = mappedLine(mapping, patch.line)
    const range = boundedRange(line, 2, totalLines)
    const window = windowLines(final, range)
    if (patch.newText === patch.oldText) return true
    if (patch.newText === "") {
      return !window.some((entry) => entry.includes(patch.oldText ?? ""))
    }
    const target = normalizedLine(patch.newText ?? "")
    const absent = normalizedLine(patch.oldText ?? "")
    return target.length > 0 && window.some((entry) => normalizedLine(entry).includes(target))
      && (!absent.length || patch.newText?.includes(patch.oldText ?? "") === true || !window.some((entry) => normalizedLine(entry).includes(absent)))
  }
  if (patch.kind === "replace") {
    if (patch.startLine === undefined) return false
    const wanted = textLines(patch.intendedText ?? patch.text)
    if (!wanted.length) return false
    const originalTotal = textLines(original).length
    if (patch.startLine === 1 && patch.endLine === originalTotal) {
      return sequenceInText(final, wanted)
    }
    const start = mappedLine(mapping, patch.startLine)
    const end = patch.endLine === undefined ? start : mappedLine(mapping, patch.endLine)
    const originalSize = textLines(patch.originalText ?? "").length
    const finalSize = Math.max(originalSize, wanted.length)
    const range = {
      startLine: Math.max(1, Math.min(start, end) - 3),
      endLine: Math.min(Math.max(1, totalLines), Math.max(start, end) + finalSize + 3)
    }
    return sequenceInWindow(windowLines(final, range), wanted)
  }
  if (patch.kind === "insert") {
    if (patch.line === undefined) return false
    const line = mappedLine(mapping, patch.line)
    const range = boundedRange(line, 3, totalLines)
    return sequenceInWindow(windowLines(final, range), textLines(patch.intendedText ?? patch.text))
  }
  if (patch.kind === "delete") {
    if (patch.startLine === undefined) return false
    const line = mappedLine(mapping, patch.startLine)
    const end = patch.endLine === undefined ? line : mappedLine(mapping, patch.endLine)
    const originalTotal = textLines(original).length
    if (patch.startLine === 1 && patch.endLine === originalTotal) {
      return textLines(final).every((entry) => normalizedLine(entry).length === 0)
    }
    const range = boundedRange(line, Math.max(3, Math.abs(end - line) + 3), totalLines)
    const removed = textLines(patch.originalText ?? "")
      .map(normalizedLine)
      .filter((entry) => entry.length)
    if (!removed.length) return true
    const window = windowLines(final, range).map(normalizedLine).filter((entry) => entry.length)
    return !sequenceInWindow(window, removed)
  }
  return false
}

/** Conservative operation-associated reconciliation. Save-time formatting is allowed; removed or contradicted mutations are conflicts. */
export const reconcileLineEdits = (
  original: string,
  intended: string,
  final: string,
  patches: readonly LinePatch[]
): { reconciliation: EditReconciliation, requestedEdits: RequestedEditVerification } => {
  if (original === final) return { reconciliation: "conflicted", requestedEdits: "conflicted" }
  if (intended === final) return { reconciliation: "applied_exactly", requestedEdits: "verified" }
  if (!patches.length) return { reconciliation: "unresolved", requestedEdits: "unresolved" }
  const mapping = mappingFromLineDiff(original, final)
  const verified = patches.every((patch) => patchSurvived(patch, original, final, mapping))
  if (verified) return { reconciliation: "applied_and_transformed", requestedEdits: "verified" }
  return { reconciliation: "conflicted", requestedEdits: "conflicted" }
}

/** The text `patches` leave when applied to `original`; offsets address `original`, end exclusive. Applying them bottom-to-top is what keeps every offset valid. */
export const patchedText = (original: string, patches: LinePatch[]): string =>
  [...patches].sort((a, b) => b.start - a.start || b.end - a.end).reduce((text, patch) => text.slice(0, patch.start) + patch.text + text.slice(patch.end), original)

/** The span `patches` cover in `original` and the lines they add, which is the same whatever order the ranges were supplied in. */
export const changedSpan = (patches: LinePatch[]): { start: number; end: number; added: number } => ({
  start: Math.min(...patches.map((patch) => patch.start)),
  end: Math.max(...patches.map((patch) => patch.end)),
  added: patches.reduce((added, patch) => added + patch.text.split("\n").length - 1, 0)
})

export const lineEditFailure = (
  code: LineEditFailureCode,
  message: string,
  current_hash?: string,
  extra: {
    required_argument?: string
    candidates?: string[]
    recovery?: string
    current_text?: string
    total_lines?: number
    refreshed_ranges?: RefreshedRange[]
    source_version?: "changed" | "unchanged"
    mutation_occurred?: boolean
  } = {}
): LineEditFailure =>
  ({ code, message, ...(current_hash ? { current_hash } : {}), ...extra })

function invalid(message: string): never { throw new LineEditError(lineEditFailure("invalid_range", message)) }

/** The operations `edit_lines` accepts. Each names its own fields; nothing else is read as one, and no operation falls back to another. */
export const LINE_EDIT_OPERATIONS = ["replace", "delete", "insert_before", "insert_after", "replace_text"]

/** How many times `needle` appears in `haystack`, counted left to right without overlap. */
const occurrencesOf = (haystack: string, needle: string): number => haystack.split(needle).length - 1

/** All offsets address the original text. A terminal newline is not an extra source line. */
export const planLineEdits = async (text: string, request: LineEditRequest, eol = text.includes("\r\n") ? "\r\n" : "\n"): Promise<LinePatch[]> => {
  const matches = await verifyContentFingerprint(text, request.expected_hash)
  if (!matches) {
    const hash = await contentHash(text)
    throw new LineEditError(lineEditFailure("hash_mismatch", "The document changed. Reread it before editing; no changes were applied.", hash))
  }
  if (!Array.isArray(request.edits) || !request.edits.length) {
    throw new LineEditError(lineEditFailure(
      "invalid_argument_type",
      "edits must be a nonempty JSON array of operation objects, not a string or another value.",
      undefined,
      { required_argument: "edits", recovery: "Send edits as an array; for example [{\"operation\":\"replace\",\"start_line\":1,\"end_line\":1,\"content\":[\"new\"]}]." }
    ))
  }
  const lines = linesOf(text)
  const starts = [0]
  for (const match of text.matchAll(/\r?\n/g)) starts.push(match.index! + match[0].length)
  const terminated = text.endsWith("\n")
  const integer = (value: unknown, min: number, max: number): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max
  const planned = request.edits.map((raw: unknown, index: number): LinePatch => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid("Each edit must be an operation object.")
    const edit = raw as Record<string, unknown>
    const operation = edit.operation
    if (typeof operation !== "string" || !LINE_EDIT_OPERATIONS.includes(operation)) {
      const received = operation === undefined ? "no \"operation\" field" : `"operation": ${JSON.stringify(operation)}`
      invalid(`Unknown line operation (${received}). Set "operation" to one of ${LINE_EDIT_OPERATIONS.join(", ")}. Received fields: ${Object.keys(edit).join(", ") || "none"}.`)
    }
    const insertion = operation === "insert_before" || operation === "insert_after"
    const substring = operation === "replace_text"
    const fields = substring
      ? ["line", "old_text", "new_text"]
      : insertion
        ? ["line"]
        : ["line", "start_line", "end_line"]
    const allowed = new Set(["operation", ...fields, ...(operation === "delete" || substring ? [] : ["content"])])
    const unexpected = Object.keys(edit).filter((key) => !allowed.has(key))
    if (unexpected.length) invalid(`Unexpected field${unexpected.length > 1 ? "s" : ""} for ${operation} operation: ${unexpected.join(", ")}. Allowed fields: ${[...allowed].join(", ")}.`)
    if (substring) {
      // The target is found in the snapshot expected_hash names, so a missing or ambiguous
      // match is refused here, before any patch exists to be applied.
      const name = `Edit ${index + 1}`
      if (!integer(edit.line, 1, lines.length)) invalid(`${name}: replace_text needs a line from 1 through ${lines.length} in the snapshot expected_hash names.`)
      const line = edit.line
      const oldText = edit.old_text
      const new_text = edit.new_text
      if (typeof oldText !== "string" || !oldText.length) invalid(`${name}: replace_text needs a nonempty old_text, copied exactly from line ${line}.`)
      if (typeof new_text !== "string") invalid(`${name}: replace_text needs new_text as a string; an empty string removes old_text.`)
      for (const [field, value] of [["old_text", oldText], ["new_text", new_text]] as Array<[string, string]>) {
        if (/[\r\n]/.test(value)) invalid(`${name}: replace_text ${field} cannot hold a carriage return or a newline; the match must stay inside line ${line}.`)
      }
      // linesOf only ever removes a line separator, so an index inside a line's content addresses
      // the same offset in text; a substring patch can never reach across a line boundary.
      const content = lines[line - 1]
      const hits = occurrencesOf(content, oldText)
      if (!hits) {
        const elsewhere = lines.flatMap((entry, i) => i + 1 === line || !occurrencesOf(entry, oldText) ? [] : [String(i + 1)])
        invalid(`${name}: old_text is not on line ${line}${elsewhere.length ? ` (it is on line${elsewhere.length > 1 ? "s" : ""} ${elsewhere.join(", ")})` : ""}. Matching is literal and case-sensitive, and no other line is searched. Nothing was changed.`)
      }
      if (hits > 1) invalid(`${name}: old_text occurs ${hits} times on line ${line}, so it names no single target. Use a substring that matches once; nothing was changed.`)
      const start = starts[line - 1] + content.indexOf(oldText)
      return {
        start,
        end: start + oldText.length,
        text: new_text,
        kind: "replace_text",
        line,
        oldText,
        newText: new_text,
        originalText: oldText,
        intendedText: new_text
      }
    }
    let content = ""
    if (operation !== "delete") {
      if (!Array.isArray(edit.content) || !edit.content.length || edit.content.some((line: unknown) => typeof line !== "string" || /[\r\n]/.test(line))) {
        invalid("content must be a nonempty array of complete lines without newline characters; use delete to remove lines.")
      }
      content = edit.content.join(eol)
    }
    if (insertion) {
      const before = operation === "insert_before"
      const min = before ? 1 : lines.length ? 1 : 0
      const max = before ? lines.length + 1 : lines.length
      if (!integer(edit.line, min, max)) invalid(`Invalid insertion line; expected ${min} through ${max}.`)
      const boundary = before ? edit.line - 1 : edit.line
      const offset = starts[boundary] ?? text.length
      if (!text.length) return { start: 0, end: 0, text: content, kind: "insert", line: edit.line, intendedText: content }
      return {
        start: offset,
        end: offset,
        text: boundary < lines.length || terminated ? content + eol : eol + content,
        kind: "insert",
        line: edit.line,
        intendedText: content
      }
    }
    const hasLine = Object.prototype.hasOwnProperty.call(edit, "line")
    const hasStart = Object.prototype.hasOwnProperty.call(edit, "start_line")
    const hasEnd = Object.prototype.hasOwnProperty.call(edit, "end_line")
    if (hasLine && (hasStart || hasEnd)) {
      invalid("Ambiguous inclusive range: use line as shorthand for start_line=end_line, or use start_line and end_line, never combine line with either range field.")
    }
    let startLine: number
    let endLine: number
    if (hasLine) {
      if (!integer(edit.line, 1, lines.length)) invalid(`Invalid line shorthand; expected 1 through ${lines.length}.`)
      startLine = edit.line
      endLine = edit.line
    } else {
      if (!hasStart || !hasEnd) {
        invalid("Invalid inclusive range: replace and delete require start_line and end_line, or line as shorthand for both.")
      }
      if (!integer(edit.start_line, 1, lines.length) || !integer(edit.end_line, edit.start_line, lines.length)) {
        invalid(`Invalid inclusive range; expected lines 1 through ${lines.length}.`)
      }
      startLine = edit.start_line
      endLine = edit.end_line
    }
    let start = starts[startLine - 1]
    const end = starts[endLine] ?? text.length
    if (operation === "delete") {
      // Removing an unterminated last line also removes its preceding separator.
      if (endLine === lines.length && !terminated && start > 0) start -= text.slice(0, start).endsWith("\r\n") ? 2 : 1
      const originalText = text.slice(start, end)
      return {
        start,
        end,
        text: "",
        kind: "delete",
        startLine,
        endLine,
        originalText
      }
    }
    const intendedText = content
    return {
      start,
      end,
      text: intendedText + (endLine < lines.length || terminated ? eol : ""),
      kind: "replace",
      startLine,
      endLine,
      originalText: text.slice(start, end),
      intendedText
    }
  })
  const ordered = [...planned].sort((a: LinePatch, b: LinePatch) => a.start - b.start || a.end - b.end)
  for (let i = 1; i < ordered.length; i++) {
    const a = ordered[i - 1]
    const b = ordered[i]
    if (b.start < a.end || (b.start === a.end && (a.start === a.end || b.start === b.end))) {
      throw new LineEditError(lineEditFailure("overlapping_edits", "Edits overlap or insert at the same/touched boundary. Combine them into one operation; nothing was changed."))
    }
  }
  // Every range addresses the snapshot expected_hash names, so the order applied is
  // normalised to bottom-to-top: a range that changes the line count cannot move a
  // range above it, and no caller is required to supply ranges in any order.
  return [...ordered].reverse()
}
