import type { ToolResultIntegrity } from "../../common/types"

/**
 * Keeping a tool conversation inside the model's context. Pure sums: the
 * loop asks how much a request may hold, how large one result may be, and
 * how many tokens a stretch of text is likely to be.
 *
 * Every request of a reply carries the whole conversation so far, tool
 * results included, so a few file reads fill a small local model's
 * context. A server asked for more than it holds cuts the conversation
 * from the front, which is where the tool instructions are, and the model
 * forgets how to call a tool. So the loop trims its own oldest results
 * first, and says so in their place.
 */

/** Code and paths run to fewer characters per token than prose; this errs towards counting too many. */
export const DEFAULT_CHARS_PER_TOKEN = 3.3

/** Under this, tool use is cramped whatever is trimmed: the tools' own description takes a quarter of it. */
export const SMALL_CONTEXT_TOKENS = 8192

export const SUPPORTED_CONTEXT_TOKENS = 65_536

/** Planned for when no server confirms a model's context and the user has not set one. */
export const FALLBACK_CONTEXT_TOKENS = SUPPORTED_CONTEXT_TOKENS

export type CapacitySource = "override" | "runtime" | "configured" | "listing" | "fallback" | "unspecified"

export interface ConfirmedCapacity {
  source: "runtime" | "configured" | "listing"
  tokens: number
}

export interface ContextCapacity {
  tokens: number
  source: CapacitySource
  confirmed: boolean
  advertised?: number
  slots?: number
  considered: ConfirmedCapacity[]
  warning?: string
}

export interface ContextDiagnostics {
  request: number
  capacity: { tokens: number; source: CapacitySource; confirmed: boolean; advertised?: number; slots?: number }
  reserved: number
  margin: number
  promptBudget: number
  estimatedPromptTokens: number
  remainingTokens: number
  utilizationPercent: number
  fresh: { total: number; retained: number; cut: number; omitted: number }
  removed: {
    olderResults: { results: number; chars: number; tokens: number }
    freshResults: { results: number; chars: number; tokens: number }
  }
  reason: string
  exhausted: boolean
  configuredOutputTokens: number
  effectiveOutputTokens: number
  outputCapped: boolean
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))

export interface ContextPlan {
  /** Tokens the model's context holds. */
  window: number
  /** Tokens kept for the reply, at least the output cap; capped so `limit` keeps 512 tokens when the window allows. */
  reserved: number
  /** Tokens held back from the window against estimate error. */
  margin: number
  /** Tokens an estimated prompt may take before old results are trimmed. */
  limit: number
  /** Where trimming stops, well under the limit, so it is not needed again a step later. */
  target: number
  /** Characters one tool result may run to. */
  resultChars: number
  /** Characters of tool notes kept for the next turn. */
  notesChars: number
  /** The output maximum requested by configuration. */
  configuredOutputTokens: number
  /** The output allocation actually used after the context safety cap. */
  effectiveOutputTokens: number
  /** Whether the configured output maximum was capped. */
  outputCapped: boolean
}

/** How a context of `window` tokens is shared out, given the output cap each request sends. */
export const planContext = (window: number, maxResultChars = 100_000, outputTokens = 0): ContextPlan => {
  const margin = Math.floor(window * 0.1)
  const configured = Number.isFinite(outputTokens) && outputTokens > 0 ? Math.floor(outputTokens) : 0
  const desired = configured > 0 ? configured : 2048
  const reserveCap = Math.floor(window * 0.25)
  const effective = Math.max(0, Math.min(desired, reserveCap, window - margin - 512))
  const reply = effective
  const reserved = Math.max(0, Math.min(reply, window - margin - 512))
  const limit = window - reserved - margin
  const ceiling = Number.isFinite(maxResultChars) ? Math.max(2000, Math.min(200_000, Math.round(maxResultChars))) : 100_000
  return {
    window,
    reserved,
    margin,
    limit,
    target: Math.floor(limit * 0.65),
    resultChars: clamp(Math.floor(window * DEFAULT_CHARS_PER_TOKEN * 0.2), 2000, ceiling),
    notesChars: clamp(Math.floor(window * DEFAULT_CHARS_PER_TOKEN * 0.08), 1200, 6000),
    configuredOutputTokens: configured,
    effectiveOutputTokens: reserved,
    outputCapped: configured > 0 && reserved < configured
  }
}

/**
 * Characters to tokens, learning the ratio from what the server counts:
 * each request that reports its prompt tokens corrects the next estimate.
 */
export class TokenEstimator {
  private _charsPerToken = DEFAULT_CHARS_PER_TOKEN

  public tokens(chars: number): number {
    return Math.ceil(chars / this._charsPerToken)
  }

  /** A request of `chars` characters was counted as `promptTokens` by the server. */
  public observe(chars: number, promptTokens: number | undefined) {
    if (!promptTokens || chars < 200) return
    this._charsPerToken = clamp(chars / promptTokens, 2, 6)
  }

  public get charsPerToken() {
    return this._charsPerToken
  }
}

/** `text` up to `max` characters, ending on a whole line where one is near. */
export const cutToLine = (text: string, max: number): string => {
  if (text.length <= max) return text
  const newline = text.lastIndexOf("\n", max)
  return text.slice(0, newline > max / 2 ? newline : max)
}

/** One result held to its share of the context, saying what was left out. */
export const fitResult = (output: string, maxChars: number): string =>
  output.length <= maxChars
    ? output
    : `${cutToLine(output, maxChars)}\n… cut to fit the model's context (${output.length - maxChars} more characters); ask for less at a time`

const RESULT_INTEGRITY_PREFIX = "[result_integrity]"
const RESULT_INTEGRITY_LINE = /^\\[result_integrity\\].*$/

/** A model-readable copy of structured delivery metadata, kept as a single stable line. */
export const formatResultIntegrity = (integrity: ToolResultIntegrity): string =>
  `${RESULT_INTEGRITY_PREFIX}${JSON.stringify(integrity)}`

export const stripResultIntegrity = (output: string): string =>
  output.split("\n").filter((line) => !RESULT_INTEGRITY_LINE.test(line)).join("\n")

export const withResultIntegrity = (output: string, integrity: ToolResultIntegrity): string =>
  `${stripResultIntegrity(output).replace(/\n$/, "")}\n${formatResultIntegrity(integrity)}`

/** Fit a file read without cutting inside a source line and update the same integrity object passed to the model. */
export const fitFileResult = (
  output: string,
  maxChars: number,
  integrity: ToolResultIntegrity
): { output: string; integrity: ToolResultIntegrity } => {
  const clean = stripResultIntegrity(output)
  if (clean.length <= maxChars) {
    const next = {
      ...integrity,
      status: integrity.status === "partial" ? "partial" as const : integrity.status === "omitted" ? "omitted" as const : "complete" as const,
      rawChars: output.length,
      deliveredChars: clean.length
    }
    return {
      output: next.status === "complete" ? clean : withResultIntegrity(clean, next),
      integrity: next
    }
  }
  if (integrity.source?.kind !== "file" || !integrity.selected) {
    const omitted = clean.length - maxChars
    const kept = fitResult(clean, maxChars)
    const next = {
      ...integrity,
      status: "partial" as const,
      truncation: {
        stage: "per_result_cap" as const,
        reason: "per-result character budget",
        omittedChars: omitted
      },
      rawChars: clean.length,
      deliveredChars: kept.length
    }
    return { output: withResultIntegrity(kept, next), integrity: next }
  }

  const lines = clean.split("\n")
  const bodyStart = lines.findIndex((line) => /^\d+: /.test(line))
  if (bodyStart === -1) {
    const kept = cutToLine(clean, maxChars)
    const next = {
      ...integrity,
      status: "partial" as const,
      truncation: {
        stage: "per_result_cap" as const,
        reason: "per-result character budget",
        omittedChars: clean.length - kept.length
      },
      rawChars: clean.length,
      deliveredChars: kept.length
    }
    return { output: withResultIntegrity(kept, next), integrity: next }
  }

  const prefix = lines.slice(0, bodyStart).join("\n")
  const body = lines.slice(bodyStart)
  const selected = integrity.selected
  const keptBody: string[] = []
  let current = selected.startLine
  let length = prefix.length
  const bodyBudget = Math.max(1, maxChars - 800)
  let oversizedLine: number | undefined

  for (let i = 0; i < body.length; i++) {
    const line = body[i]
    const match = /^(\d+): /.exec(line)
    if (!match) break
    const candidate = keptBody.length ? 2 : 1
    if (length + candidate + line.length > bodyBudget) {
      if (line.length > 10_000) oversizedLine = Number(match[1])
      break
    }
    keptBody.push(line)
    length += candidate + line.length
    current = Number(match[1])
  }

  const deliveredEnd = keptBody.length ? current : undefined
  const omittedLines = deliveredEnd === undefined
    ? selected.endLine - selected.startLine + 1
    : selected.endLine - deliveredEnd
  const nextStartLine = deliveredEnd === undefined ? selected.startLine : deliveredEnd + 1
  const omittedChars = clean.length - (prefix.length + (keptBody.length ? 1 : 0) + keptBody.join("\n").length)
  const next: ToolResultIntegrity = {
    ...integrity,
    status: "partial",
    ...(deliveredEnd === undefined ? {} : {
      delivered: {
        startLine: selected.startLine,
        endLine: deliveredEnd,
        totalLines: selected.totalLines
      }
    }),
    truncation: {
      stage: "per_result_cap",
      reason: "per-result character budget",
      omittedChars,
      omittedLines,
      nextStartLine: nextStartLine <= selected.endLine ? nextStartLine : undefined,
      ...(oversizedLine !== undefined ? { nextCharStart: 1 } : {})
    },
    rawChars: clean.length,
    deliveredChars: prefix.length + (keptBody.length ? 1 : 0) + keptBody.join("\n").length
  }

  const qualifiedHeader = lines[0]
  const header = qualifiedHeader.includes("; partial delivery")
    ? qualifiedHeader
    : qualifiedHeader.replace(/\)$/, "") + (qualifiedHeader.includes(")") ? "; partial delivery)" : "")
  const keptPrefix = [header, ...lines.slice(1, bodyStart)]
  const bodyText = keptBody.join("\n")
  const continuation = deliveredEnd === undefined
    ? `delivery: partial\nselected_lines: ${selected.startLine}–${selected.endLine} of ${selected.totalLines}\ndelivered_lines: none\nnext_start_line: ${nextStartLine}${oversizedLine !== undefined ? "\nnext_char_start: 1" : ""}\nomitted_chars: ${omittedChars}`
    : `delivery: partial\nselected_lines: ${selected.startLine}–${selected.endLine} of ${selected.totalLines}\ndelivered_lines: ${selected.startLine}–${deliveredEnd} of ${selected.totalLines}\nnext_start_line: ${nextStartLine}${oversizedLine !== undefined ? "\nnext_char_start: 1" : ""}\nomitted_chars: ${omittedChars}`
  const kept = [keptPrefix.join("\n"), continuation, bodyText].filter((part) => part.length > 0).join("\n")
  return { output: withResultIntegrity(kept, next), integrity: next }
}

/** What stands in for a result trimmed out of the conversation: its first line, so the model knows what it was. */
export const trimmedResult = (output: string): string => {
  const first = output.split("\n", 1)[0].slice(0, 160)
  return `${first}\n[The rest was trimmed to save context. Run the tool again if you need it.]`
}

/** The prompt size of a conversation's latest model request: the server's count once it reports one, otherwise Twinny's estimate. */
export interface ContextUsage {
  tokens: number
  counted: boolean
}

/** Holds live usage for the conversation that is running. Another conversation reads as no usage. */
export class ContextUsageStore {
  private conversationId = ""
  private usage: ContextUsage | undefined

  public record(conversationId: string | undefined, usage: ContextUsage): void {
    const key = conversationId ?? ""
    if (key !== this.conversationId) this.conversationId = key
    this.usage = usage
  }

  public read(conversationId: string | undefined): ContextUsage | undefined {
    return (conversationId ?? "") === this.conversationId ? this.usage : undefined
  }
}
