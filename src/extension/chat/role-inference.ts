import type { InferenceTraceContext } from "../inference/trace"
import type { ChatFinishReason } from "../inference/types"

/** One system+user exchange sent to a role's own provider. */
export interface RoleInferenceRequest {
  system: string
  user: string
  /** Asks for a JSON object where the provider supports structured output. */
  json?: boolean
}

/** A reply with what its reply channels reported, for diagnostics and the output-limit check. */
export interface RoleReply {
  text: string
  reasoningChars?: number
  finishReason?: ChatFinishReason
}

/** The visible text of a reply, whether or not it carries channel details. */
export const replyText = (reply: string | RoleReply | undefined): string =>
  typeof reply === "string" ? reply : reply?.text ?? ""

export type RoleInference = (
  request: RoleInferenceRequest,
  options: { signal: AbortSignal; trace: InferenceTraceContext }
) => Promise<string | RoleReply | undefined>

/** The provider a role (Feedback, Prompt Compiler) resolved to. */
export interface RoleEndpoint {
  infer: RoleInference
  provider: string
  model: string
  label?: string
}

export type RoleResolution =
  | { ok: true; endpoint: RoleEndpoint }
  | { ok: false; error: string }

export type RoleResolver = () => RoleResolution | Promise<RoleResolution>

/** Rejects once `ms` elapse, aborting `controller` with the same error. */
export const abortAfter = (controller: AbortController, ms: number, message: string) => {
  const timeout = setTimeout(() => controller.abort(new RoleTimeoutError(message)), ms)
  return () => clearTimeout(timeout)
}

export class RoleTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RoleTimeoutError"
  }
}

export type JsonFailure =
  | "empty"
  | "reasoning-only"
  | "no-json"
  | "truncated"
  | "syntax"
  | "not-object"

export interface JsonExtraction {
  value?: Record<string, unknown>
  error?: string
  failure?: JsonFailure
  /** Where a syntax error sits, counted from the start of the JSON object. */
  offset?: number
}

const CONTROL_TOKEN = /<\|[a-z_]+\|>/gi

/**
 * The text a user would read. Harmony-format replies (GPT-OSS) keep their
 * answer after `<|channel|>final<|message|>`; an analysis channel with no
 * final answer is reasoning only, and yields nothing. Reasoning blocks are
 * removed, and control tokens with them.
 */
export const visibleModelText = (output: string): string => {
  const final = output.match(/<\|channel\|>final<\|message\|>([\s\S]*)$/i)
  if (!final && /<\|channel\|>/i.test(output)) return ""
  const answer = final ? final[1] : output
  return answer
    .replace(/<(think|thinking)>[\s\S]*?<\/\1>/gi, "")
    .replace(/^<(think|thinking)>[\s\S]*$/i, "")
    .replace(CONTROL_TOKEN, "")
    .trim()
}

/** The index of the brace closing the one at `start`, string-aware; -1 when the object never closes. */
const closingBrace = (text: string, start: number): number => {
  let depth = 0
  let inString = false
  for (let index = start; index < text.length; index++) {
    const char = text[index]
    if (inString) {
      if (char === "\\") index++
      else if (char === "\"") inString = false
    } else if (char === "\"") {
      inString = true
    } else if (char === "{") {
      depth++
    } else if (char === "}" && --depth === 0) {
      return index
    }
  }
  return -1
}

const syntaxOffset = (error: unknown) => {
  const match = /position (\d+)/.exec(error instanceof Error ? error.message : String(error))
  return match ? Number(match[1]) : undefined
}

/**
 * Extracts one JSON object from a model reply: fenced, bare, or surrounded
 * by prose. Each failure is named, so a caller can tell an empty reply from
 * a cut-off one, and a syntax error from a valid object of the wrong shape.
 * Nothing is repaired: a truncated object is reported, never completed.
 */
export const extractJsonObject = (output: string | undefined): JsonExtraction => {
  if (!output?.trim()) return { failure: "empty", error: "The provider returned an empty response." }
  const text = visibleModelText(output)
  if (!text) return { failure: "reasoning-only", error: "The provider returned reasoning but no answer." }
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1] : text
  const start = candidate.indexOf("{")
  if (start === -1) return { failure: "no-json", error: "The provider response was not valid JSON." }
  const end = closingBrace(candidate, start)
  if (end === -1) return { failure: "truncated", error: "The provider response ended before its JSON object was complete." }
  const slice = candidate.slice(start, end + 1)
  try {
    const parsed: unknown = JSON.parse(slice)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { value: parsed as Record<string, unknown> }
    return { failure: "not-object", error: "The provider response must be a JSON object." }
  } catch (error) {
    const offset = syntaxOffset(error)
    return {
      failure: "syntax",
      offset,
      error: "The provider response was not valid JSON" + (offset === undefined ? "." : ` (syntax error at character ${offset} of the object).`)
    }
  }
}

const refusedJsonMode = new Set<string>()
const JSON_MODE_REFUSAL = /response_format|json[ _-]?(?:mode|object)|structured[ _-]?output/i

/**
 * Asks for structured JSON output, and asks again without it once a server
 * names the parameter as unsupported. The refusal is remembered per server,
 * so later calls go straight to the plain request. Any other failure, and
 * a cancelled call, is thrown unchanged.
 */
export const structuredReply = async (
  key: string,
  call: (json: boolean) => Promise<RoleReply>,
  signal: AbortSignal
): Promise<RoleReply> => {
  if (refusedJsonMode.has(key)) return call(false)
  try {
    return await call(true)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (signal.aborted || !JSON_MODE_REFUSAL.test(message)) throw error
    refusedJsonMode.add(key)
    return call(false)
  }
}
