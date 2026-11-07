export interface ToolEvidenceInput {
  name: string
  args: Record<string, unknown>
  output: string
  failed: boolean
  exitCode?: number
  invocationId: string
}

export interface CompactToolEvidence {
  toolName: string
  invocationId: string
  targetPath?: string
  failed: boolean
  exitCode?: number
  lineRange?: { start: number; end: number }
  fingerprints: string[]
  resultIds: string[]
  summary: string
}

export const MAX_EVIDENCE_TEXT = 1000
const MAX_FAILURE_SUMMARY = 240
const MAX_RESULT_IDS = 8
const PATH_KEYS = ["path", "file_path", "filePath", "file", "target"]
const START_KEYS = ["start_line", "startLine"]
const END_KEYS = ["end_line", "endLine"]
const FINGERPRINT = /\b(?:xxh64:[0-9a-f]{16}|xxh3_128:[0-9a-f]{32}|sha256:[0-9a-f]{64})\b/g
const RESULT_ID = /\b(?:observation_id|item_id|itemId|id)"?\s*[:=]\s*"?([A-Za-z0-9._:-]{4,80})/g

const firstString = (args: Record<string, unknown>, keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = args[key]
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 500)
  }
  return undefined
}

const positiveInteger = (args: Record<string, unknown>, keys: string[]): number | undefined => {
  for (const key of keys) {
    const value = Number(args[key])
    if (Number.isSafeInteger(value) && value > 0) return value
  }
  return undefined
}

/**
 * Removes credentials from text that is kept as evidence. A quoted secret
 * is replaced inside its quotes; a bare `token` is only treated as a secret
 * when it looks like one, so ordinary source such as `const token = getToken()`
 * or `tokenCount` is left as the file has it.
 */
export const redactEvidence = (text: string): string => text
  .replace(/(authorization\s*:\s*bearer\s+)[^\s]+/gi, "$1[REDACTED]")
  .replace(/\b(api[_-]?key|token|secret|password)\b(["']?\s*[:=]\s*)(["'])([^"'\n]{8,})\3/gi, "$1$2$3[REDACTED]$3")
  .replace(/\b(api[_-]?key|secret|password|token)\b(["']?\s*[:=]\s*)([^\s"',;()]+)/gi, (match, key: string, separator: string, value: string) => {
    if (value === "[REDACTED]") return match
    const looksSecret = key.toLowerCase() !== "token" || (value.length >= 20 && /\d/.test(value))
    return looksSecret ? `${key}${separator}[REDACTED]` : match
  })
  .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]")

const unique = (values: string[], limit: number) => [...new Set(values)].slice(0, limit)

/**
 * Compact, structured evidence for a tool result. File contents and other
 * successful output are reduced to counts; only failures keep a short,
 * redacted excerpt, so the record stays bounded whatever the tool returned.
 */
export const compactToolEvidence = (input: ToolEvidenceInput): CompactToolEvidence => {
  const start = positiveInteger(input.args, START_KEYS)
  const end = positiveInteger(input.args, END_KEYS)
  const text = input.output ?? ""
  const lines = text ? text.split("\n").length : 0
  const firstLine = redactEvidence(text.trim().split("\n")[0] ?? "").slice(0, MAX_FAILURE_SUMMARY)
  const summary = input.failed
    ? `failed: ${firstLine || "no output"}`
    : `${lines} line${lines === 1 ? "" : "s"} of output`
  const resultIds = [...text.matchAll(RESULT_ID)].map((match) => match[1])
  return {
    toolName: input.name.slice(0, 120),
    invocationId: input.invocationId,
    targetPath: firstString(input.args, PATH_KEYS),
    failed: input.failed,
    exitCode: input.exitCode,
    lineRange: start && end && end >= start ? { start, end } : start ? { start, end: start } : undefined,
    fingerprints: unique([...text.matchAll(FINGERPRINT)].map((match) => match[0]), 8),
    resultIds: unique(resultIds, MAX_RESULT_IDS),
    summary
  }
}

export const compactArguments = (evidence: CompactToolEvidence): Record<string, string> => {
  const pairs: [string, string | number | undefined][] = [
    ["path", evidence.targetPath],
    ["start_line", evidence.lineRange?.start],
    ["end_line", evidence.lineRange?.end]
  ]
  return Object.fromEntries(pairs.filter((pair): pair is [string, string | number] => pair[1] !== undefined).map(([key, value]) => [key, String(value)]))
}

/** The stored form of the evidence: JSON that never exceeds the evidence bound. */
export const compactEvidenceText = (evidence: CompactToolEvidence): string => {
  const text = JSON.stringify(evidence)
  if (text.length <= MAX_EVIDENCE_TEXT) return text
  return JSON.stringify({
    toolName: evidence.toolName.slice(0, 120),
    invocationId: evidence.invocationId,
    targetPath: evidence.targetPath?.slice(0, 200),
    failed: evidence.failed,
    exitCode: evidence.exitCode,
    lineRange: evidence.lineRange,
    fingerprints: evidence.fingerprints.slice(0, 2),
    resultIds: evidence.resultIds.slice(0, 2),
    summary: evidence.summary.slice(0, 80),
    truncated: true
  })
}

/** Longest tool output kept verbatim for Feedback; anything longer is recorded as incomplete. */
export const MAX_RETAINED_EVIDENCE_CHARS = 200_000
/** Longest excerpt of one observation placed in a Feedback prompt. */
export const MAX_EXCERPT_CHARS = 2_400
const EXCERPT_CONTEXT_LINES = 3
const MAX_HITS = 50
const MAX_HIT_PREVIEW = 200
const READ_HEADER = /^(.+?) \((?:lines (\d+)–(\d+) of (\d+)|full line (\d+))\)$/
const TOTAL_LINES = /total_lines: (\d+)/
const CONTENT_HASH = /content_hash: ([a-z0-9_]+:[a-f0-9]+)/i
const CODE_PATH = /(?:[\w.-]+\/)*[\w.-]+\.(?:tsx?|jsx?|mjs|cjs|json|md|py|go|rs|java|cs|css|html|ya?ml)\b/g
const BACKTICKED = /`([^`\n]{2,120})`/g

export interface EvidenceSource {
  path: string
  startLine?: number
  endLine?: number
  totalLines?: number
  /** Fingerprint of the whole document as it was read; absent for outputs that carry none. */
  contentHash?: string
}

export interface EvidenceHit {
  path: string
  line?: number
  preview: string
}

export interface PreservedEvidence {
  content: string
  originalChars: number
  preservedChars: number
  complete: boolean
  sources: EvidenceSource[]
  hits: EvidenceHit[]
}

const parseSources = (text: string): EvidenceSource[] => {
  const header = READ_HEADER.exec(text.split("\n", 1)[0] ?? "")
  if (!header) return []
  const head = text.slice(0, 400)
  const total = TOTAL_LINES.exec(head)
  const hash = CONTENT_HASH.exec(head)
  const start = Number(header[2] ?? header[5])
  const end = Number(header[3] ?? header[5])
  const totalLines = Number(header[4] ?? total?.[1])
  return [{
    path: header[1].slice(0, 500),
    startLine: Number.isSafeInteger(start) ? start : undefined,
    endLine: Number.isSafeInteger(end) ? end : undefined,
    totalLines: Number.isSafeInteger(totalLines) ? totalLines : undefined,
    contentHash: hash?.[1]
  }]
}

const parseHits = (text: string): EvidenceHit[] => {
  const trimmed = text.trimStart()
  if (!trimmed.startsWith("{")) return []
  let parsed: { results?: unknown }
  try {
    parsed = JSON.parse(trimmed) as { results?: unknown }
  } catch {
    return []
  }
  if (!Array.isArray(parsed.results)) return []
  return parsed.results.slice(0, MAX_HITS).flatMap((hit): EvidenceHit[] => {
    if (!hit || typeof hit !== "object") return []
    const { path, line, preview } = hit as Record<string, unknown>
    if (typeof path !== "string") return []
    return [{
      path: path.slice(0, 500),
      line: Number.isSafeInteger(line) ? line as number : undefined,
      preview: redactEvidence(typeof preview === "string" ? preview : "").slice(0, MAX_HIT_PREVIEW)
    }]
  })
}

/**
 * Keeps a tool output for later retrieval. The stored content is redacted,
 * cut at a line boundary, and flagged incomplete when the cap applied, so
 * no shortened copy is mistaken for the whole output.
 */
export const preserveEvidence = (output: string): PreservedEvidence => {
  const text = output ?? ""
  const complete = text.length <= MAX_RETAINED_EVIDENCE_CHARS
  const kept = complete ? text : text.slice(0, MAX_RETAINED_EVIDENCE_CHARS).replace(/\n[^\n]*$/, "")
  const content = redactEvidence(kept)
  return {
    content,
    originalChars: text.length,
    preservedChars: content.length,
    complete,
    sources: parseSources(text),
    hits: parseHits(text)
  }
}

export interface EvidenceAnchors {
  paths: string[]
  symbols: string[]
}

/**
 * Paths and identifiers a criterion names; these decide what evidence must exist.
 * Backticked identifiers always count. A criterion that names a file also anchors
 * its code-like prose identifiers (see codeIdentifiers), so "Locate the read_file
 * tool definition in <path>" is checked against that file the same as "`read_file`".
 */
export const evidenceAnchors = (criterion: string): EvidenceAnchors => {
  const paths = unique([...criterion.matchAll(CODE_PATH)].map((match) => match[0]), 12)
  const pathSet = new Set(paths.map((path) => path.toLowerCase()))
  const backticked = [...criterion.matchAll(BACKTICKED)].map((match) => match[1].trim())
  const prose = paths.length > 0 ? codeIdentifiers(criterion) : []
  const seen = new Set<string>()
  const symbols = [...backticked, ...prose].filter((symbol) => {
    const key = symbol.toLowerCase()
    if (!symbol || pathSet.has(key) || seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, 12)
  return { paths, symbols }
}

export interface EvidenceExcerpt {
  text: string
  matched: boolean
  truncated: boolean
}

/**
 * Bounded, deterministic excerpt of retained content: lines that mention an
 * anchor, with a few lines of context, in source order. With no anchors the
 * head of the content is used. Gaps between kept ranges are marked with "…".
 */
export const excerptEvidence = (content: string, anchors: string[], maxChars = MAX_EXCERPT_CHARS): EvidenceExcerpt => {
  const lines = content.split("\n")
  const lowered = lines.map((line) => line.toLowerCase())
  const needles = anchors.map((anchor) => anchor.toLowerCase()).filter(Boolean)
  const hits = lines.flatMap((_, index) => needles.length === 0 || needles.some((needle) => lowered[index].includes(needle)) ? [index] : [])
  if (needles.length > 0 && hits.length === 0) return { text: "", matched: false, truncated: false }
  const ranges: [number, number][] = []
  for (const index of hits) {
    const from = Math.max(0, index - EXCERPT_CONTEXT_LINES)
    const to = Math.min(lines.length - 1, index + EXCERPT_CONTEXT_LINES)
    const last = ranges[ranges.length - 1]
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to)
    else ranges.push([from, to])
  }
  const pieces: string[] = []
  let used = 0
  let previous = -1
  let truncated = false
  outer: for (const [from, to] of ranges) {
    if (previous >= 0 && from > previous + 1) pieces.push("…")
    for (let index = from; index <= to; index++) {
      const line = lines[index]
      const room = maxChars - used
      if (line.length + 1 > room) {
        if (room > 3) pieces.push(line.slice(0, room - 2) + "…")
        truncated = true
        break outer
      }
      pieces.push(line)
      used += line.length + 1
      previous = index
    }
  }
  return { text: pieces.join("\n"), matched: true, truncated }
}

/** Longest text kept for one window; a longer window is cut at a line boundary and says so. */
export const MAX_WINDOW_CHARS = 1_200
const HEAD_LINES = 40
const MAX_WINDOWS = 200
const IDENTIFIER = /\b[A-Za-z_][A-Za-z0-9_]{2,80}\b/g

export interface EvidenceWindow {
  /** Index of the first and last line of the window in the lines it was taken from. */
  from: number
  to: number
  /** File line numbers, when the lines carry them. */
  lines?: { start: number; end: number }
  /** Needles the window mentions; empty for the head window used when a criterion names no symbol. */
  needles: string[]
  text: string
  truncated: boolean
}

/**
 * Names a criterion's proposition turns on: backticked symbols and code-like
 * identifiers (with an underscore, a capital, or a digit), outside file paths.
 */
export const propositionNeedles = (criterion: string): string[] => {
  const withoutPaths = criterion.replace(CODE_PATH, " ")
  const backticked = [...withoutPaths.matchAll(BACKTICKED)].map((match) => match[1].trim())
  const identifiers = [...withoutPaths.matchAll(IDENTIFIER)].map((match) => match[0]).filter((word) => /[_A-Z0-9]/.test(word))
  return unique([...backticked, ...identifiers].map((word) => word.toLowerCase()).filter(Boolean), 12)
}

/** Identifiers that read as code: snake_case, camelCase, or containing a digit. Sentence capitals do not count. */
const codeIdentifiers = (criterion: string): string[] =>
  [...criterion.replace(CODE_PATH, " ").matchAll(IDENTIFIER)]
    .map((match) => match[0])
    .filter((word) => /_|[a-z][A-Z]|\d/.test(word))

const numberedLine = (line: string): number | undefined => {
  const match = /^(\d+): /.exec(line)
  return match ? Number(match[1]) : undefined
}

const numberedRange = (lines: string[]): { start: number; end: number } | undefined => {
  const numbers = lines.map(numberedLine).filter((value): value is number => value !== undefined)
  return numbers.length ? { start: numbers[0], end: numbers[numbers.length - 1] } : undefined
}

const boundedText = (lines: string[]): { text: string; truncated: boolean } => {
  const kept: string[] = []
  let used = 0
  for (const line of lines) {
    if (used + line.length + 1 > MAX_WINDOW_CHARS) {
      const room = MAX_WINDOW_CHARS - used
      if (room > 4) kept.push(line.slice(0, room - 2) + "…")
      return { text: kept.join("\n"), truncated: true }
    }
    kept.push(line)
    used += line.length + 1
  }
  return { text: kept.join("\n"), truncated: false }
}

/**
 * Every window of lines that mentions a needle, with the lines it covers and
 * the needles it holds. Without needles, the head of the lines is one window.
 * Nothing is dropped here: budgeting is the caller's decision.
 */
export const evidenceWindows = (lines: string[], needles: string[], context: number): EvidenceWindow[] => {
  const lowered = lines.map((line) => line.toLowerCase())
  const terms = needles.map((needle) => needle.toLowerCase()).filter(Boolean)
  const spans: { from: number; to: number; needles: Set<string> }[] = []
  if (terms.length === 0) {
    if (lines.length) spans.push({ from: 0, to: Math.min(lines.length, HEAD_LINES) - 1, needles: new Set() })
  } else {
    for (let index = 0; index < lines.length && spans.length < MAX_WINDOWS; index++) {
      const matched = terms.filter((term) => lowered[index].includes(term))
      if (!matched.length) continue
      const from = Math.max(0, index - context)
      const to = Math.min(lines.length - 1, index + context)
      const last = spans[spans.length - 1]
      if (last && from <= last.to + 1) {
        last.to = Math.max(last.to, to)
        matched.forEach((term) => last.needles.add(term))
      } else spans.push({ from, to, needles: new Set(matched) })
    }
  }
  return spans.map((span) => {
    const bounded = boundedText(lines.slice(span.from, span.to + 1))
    const range = numberedRange(lines.slice(span.from, span.to + 1))
    return {
      from: span.from,
      to: span.to,
      ...(range ? { lines: range } : {}),
      needles: [...span.needles],
      text: redactEvidence(bounded.text),
      truncated: bounded.truncated
    }
  })
}

/** What the store kept for one observation, as needed to judge coverage. */
export interface EvidenceRecord {
  observationId: string
  toolName: string
  failed: boolean
  arguments: Record<string, string>
  retained: boolean
  complete?: boolean
  content?: string
  sources: EvidenceSource[]
}

export interface CoverageGap {
  anchor: string
  reason: "missing_source" | "absent_symbol" | "evicted" | "inaccessible" | "incomplete"
}

export const samePath = (recorded: string, anchor: string) => {
  const left = recorded.toLowerCase()
  const right = anchor.toLowerCase()
  return left === right || left.endsWith("/" + right)
}

const argumentPaths = (record: EvidenceRecord): string[] =>
  PATH_KEYS.flatMap((key) => typeof record.arguments[key] === "string" ? [record.arguments[key]] : [])

/**
 * Anchors a criterion names that no successful, retained observation covers.
 * A path needs a read of that file, or a successful change to it; a symbol
 * needs retained output or a command argument that contains it.
 */
export const evidenceGaps = (anchors: EvidenceAnchors, records: EvidenceRecord[]): CoverageGap[] => {
  const usable = records.filter((record) => !record.failed)
  const gaps: CoverageGap[] = []
  for (const path of anchors.paths) {
    const readRecords = usable.filter((record) => record.sources.some((source) => samePath(source.path, path)))
    const readCovered = readRecords.some((record) => record.retained && record.content !== undefined)
    // Reads carry sources; only records without them count as changes, so an unreadable read stays a gap.
    const changed = usable.some((record) =>
      record.sources.length === 0 && argumentPaths(record).some((value) => samePath(value, path)))
    if (readCovered || changed) continue
    if (readRecords.some((record) => record.retained)) gaps.push({ anchor: path, reason: "inaccessible" })
    else if (readRecords.length > 0) gaps.push({ anchor: path, reason: "evicted" })
    else gaps.push({ anchor: path, reason: "missing_source" })
  }
  for (const symbol of anchors.symbols) {
    const needle = symbol.toLowerCase()
    const covered = usable.some((record) =>
      (record.content?.toLowerCase().includes(needle) ?? false) || JSON.stringify(record.arguments).toLowerCase().includes(needle))
    if (covered) continue
    if (usable.some((record) => record.retained && record.content === undefined)) gaps.push({ anchor: symbol, reason: "inaccessible" })
    else if (usable.some((record) => record.retained && record.complete === false)) gaps.push({ anchor: symbol, reason: "incomplete" })
    else if (usable.some((record) => !record.retained)) gaps.push({ anchor: symbol, reason: "evicted" })
    else gaps.push({ anchor: symbol, reason: "absent_symbol" })
  }
  return gaps
}

export const describeGap = (gap: CoverageGap): string => {
  switch (gap.reason) {
    case "missing_source":
      return `no successful observation covers ${gap.anchor}; read it with read_file, or change it with an edit tool`
    case "absent_symbol":
      return `\`${gap.anchor}\` does not appear in any retained observation; find it with search_workspace or read_file`
    case "evicted":
      return `retained evidence that may contain ${gap.anchor} was evicted from storage; read the relevant lines again`
    case "inaccessible":
      return `retained evidence for ${gap.anchor} could not be loaded; read the relevant lines again`
    case "incomplete":
      return `retained output was cut at the storage limit, so ${gap.anchor} may lie in the omitted part; read the relevant lines again`
  }
}
