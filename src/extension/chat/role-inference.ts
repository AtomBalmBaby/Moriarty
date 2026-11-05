import type { InferenceTraceContext } from "../inference/trace"

/** One system+user exchange sent to a role's own provider. */
export interface RoleInferenceRequest {
  system: string
  user: string
}

export type RoleInference = (
  request: RoleInferenceRequest,
  options: { signal: AbortSignal; trace: InferenceTraceContext }
) => Promise<string | undefined>

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

/**
 * Extracts one JSON object from a model reply: fenced, bare, or surrounded
 * by prose. Reasoning blocks are removed first.
 */
export const extractJsonObject = (output: string | undefined): { value?: Record<string, unknown>; error?: string } => {
  if (!output?.trim()) return { error: "The provider returned an empty response." }
  const text = output
    .replace(/<(think|thinking)>[\s\S]*?<\/\1>/gi, "")
    .replace(/^<(think|thinking)>[\s\S]*$/i, "")
    .trim()
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1] : text
  const attempts = [candidate]
  const start = candidate.indexOf("{")
  const end = candidate.lastIndexOf("}")
  if (start !== -1 && end > start) attempts.push(candidate.slice(start, end + 1))
  for (const attempt of attempts) {
    try {
      const parsed: unknown = JSON.parse(attempt)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { value: parsed as Record<string, unknown> }
      return { error: "The provider response must be a JSON object." }
    } catch {
      // Try the next candidate.
    }
  }
  return { error: "The provider response was not valid JSON." }
}
