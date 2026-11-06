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

const redact = (text: string) => text
  .replace(/(authorization\s*:\s*bearer\s+)[^\s]+/gi, "$1[REDACTED]")
  .replace(/\b(api[_-]?key|token|secret|password)\b(\s*[:=]\s*["']?)[^\s"',;]+/gi, "$1$2[REDACTED]")
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
  const firstLine = redact(text.trim().split("\n")[0] ?? "").slice(0, MAX_FAILURE_SUMMARY)
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
