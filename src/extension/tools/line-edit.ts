import { fingerprintContent, verifyContentFingerprint } from "./fingerprint"
import { linesOf } from "./view"

export const contentHash = fingerprintContent

export type LineEditFailureCode = "hash_mismatch" | "invalid_range" | "overlapping_edits" | "document_unavailable" | "permission_denied" | "application_failed"

export interface LineEditFailure {
  code: LineEditFailureCode
  message: string
  current_hash?: string
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
}

export const lineEditFailure = (code: LineEditFailureCode, message: string, current_hash?: string): LineEditFailure =>
  ({ code, message, ...(current_hash ? { current_hash } : {}) })

function invalid(message: string): never { throw new LineEditError(lineEditFailure("invalid_range", message)) }

/** All offsets address the original text. A terminal newline is not an extra source line. */
export const planLineEdits = async (text: string, request: LineEditRequest, eol = text.includes("\r\n") ? "\r\n" : "\n"): Promise<LinePatch[]> => {
  const matches = await verifyContentFingerprint(text, request.expected_hash)
  if (!matches) {
    const hash = await contentHash(text)
    throw new LineEditError(lineEditFailure("hash_mismatch", "The document changed. Reread it before editing; no changes were applied.", hash))
  }
  if (!Array.isArray(request.edits) || !request.edits.length) invalid("edits must be a nonempty array.")
  const lines = linesOf(text)
  const starts = [0]
  for (const match of text.matchAll(/\r?\n/g)) starts.push(match.index! + match[0].length)
  const terminated = text.endsWith("\n")
  const integer = (value: unknown, min: number, max: number): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max
  const patches = request.edits.map((raw: unknown): LinePatch => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid("Each edit must be an operation object.")
    const edit = raw as Record<string, unknown>
    const operation = edit.operation
    if (typeof operation !== "string" || !["replace", "delete", "insert_before", "insert_after"].includes(operation)) invalid("Unknown line operation.")
    const insertion = operation === "insert_before" || operation === "insert_after"
    const allowed = new Set(["operation", ...(insertion ? ["line"] : ["start_line", "end_line"]), ...(operation === "delete" ? [] : ["content"])])
    if (Object.keys(edit).some((key) => !allowed.has(key))) invalid("Unexpected fields in line operation.")
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
      if (!text.length) return { start: 0, end: 0, text: content }
      return { start: offset, end: offset, text: boundary < lines.length || terminated ? content + eol : eol + content }
    }
    if (!integer(edit.start_line, 1, lines.length) || !integer(edit.end_line, edit.start_line, lines.length)) {
      invalid(`Invalid inclusive range; expected lines 1 through ${lines.length}.`)
    }
    let start = starts[edit.start_line - 1]
    const end = starts[edit.end_line] ?? text.length
    if (operation === "delete") {
      // Removing an unterminated last line also removes its preceding separator.
      if (edit.end_line === lines.length && !terminated && start > 0) start -= text.slice(0, start).endsWith("\r\n") ? 2 : 1
      return { start, end, text: "" }
    }
    return { start, end, text: content + (edit.end_line < lines.length || terminated ? eol : "") }
  }).sort((a: LinePatch, b: LinePatch) => a.start - b.start || a.end - b.end)
  for (let i = 1; i < patches.length; i++) {
    const a = patches[i - 1]
    const b = patches[i]
    if (b.start < a.end || (b.start === a.end && (a.start === a.end || b.start === b.end))) {
      throw new LineEditError(lineEditFailure("overlapping_edits", "Edits overlap or insert at the same/touched boundary. Combine them into one operation; nothing was changed."))
    }
  }
  return patches
}
