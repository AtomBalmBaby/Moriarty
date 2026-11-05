import { logger, redact } from "../../common/logger"
import type { PromptCompileResult } from "../../common/messaging/protocol"
import { isAbortError } from "../inference/errors"
import {
  cancelInferenceOperation,
  createInferenceTrace,
  finishInferenceOperation,
  inferenceEvent,
  InferenceTraceContext
} from "../inference/trace"

import { abortAfter, extractJsonObject, RoleResolver, RoleTimeoutError } from "./role-inference"

export const PROMPT_COMPILER_PROTOCOL =
  "Rewrite the user's draft into a clearer, more complete prompt for a coding assistant without changing its intent, scope, constraints or exclusions. " +
  "Return exactly one valid JSON object, with no prose or Markdown fences, of the form {\"prompt\": string}. " +
  "The prompt field holds only the rewritten prompt text the user will review and may send. Do not add other keys."

export const DEFAULT_PROMPT_COMPILER_TIMEOUT_MS = 120_000

export const parsePromptCompilerResponse = (output: string | undefined): { prompt?: string; error?: string } => {
  const { value, error } = extractJsonObject(output)
  if (!value) return { error: error ?? "The provider response was not valid JSON." }
  const unexpected = Object.keys(value).filter((key) => key !== "prompt")
  if (unexpected.length) return { error: "The provider response has unexpected keys: " + unexpected.join(", ") + "." }
  if (typeof value.prompt !== "string" || !value.prompt.trim()) return { error: "The provider response has no prompt text." }
  return { prompt: value.prompt.trim() }
}

export interface PromptCompileInput {
  requestId: string
  prompt: string
  /** Prior turns, already rendered for the compiler, or empty. */
  history?: string
}

export interface PromptCompilerTraceRecord {
  requestId: string
  operationId: string
  provider: string
  model: string
  system: string
  user: string
  response: string | undefined
}

export interface PromptCompilerDeps {
  enabled: () => boolean
  resolve: RoleResolver
  timeoutMs?: number
  describeError?: (error: unknown) => string
}

export interface PromptCompileOptions {
  systemPrompt: () => Promise<string>
  /** Explicit trace mode only: may write raw bodies to a local file. */
  trace?: (record: PromptCompilerTraceRecord) => Promise<void>
}

interface ActiveCompilation {
  controller: AbortController
  trace: InferenceTraceContext
  initiator?: "user" | "host" | "superseded"
}

/**
 * Explicit, user-requested rewriting of a composer draft. It only returns
 * text: it never sends a message, plans TODOs or touches feedback state.
 * At most one compilation runs; a newer one cancels the older.
 */
export class PromptCompiler {
  private readonly _active = new Map<string, ActiveCompilation>()

  constructor(private readonly _deps: PromptCompilerDeps) {}

  public get activeRequestIds(): string[] {
    return [...this._active.keys()]
  }

  public async compile(input: PromptCompileInput, options: PromptCompileOptions): Promise<PromptCompileResult> {
    const { requestId } = input
    if (!this._deps.enabled()) return { requestId, status: "disabled" }
    const draft = input.prompt.trim()
    if (!draft) return { requestId, status: "failed", error: "There is no draft to compile." }
    if (this._active.has(requestId)) return { requestId, status: "failed", error: "This compilation is already running." }
    for (const id of [...this._active.keys()]) this.cancel(id, "superseded")

    const controller = new AbortController()
    const trace = createInferenceTrace({ operationKind: "prompt_compiler" })
    const active: ActiveCompilation = { controller, trace }
    this._active.set(requestId, active)
    const resolution = await Promise.resolve(this._deps.resolve()).catch((error): { ok: false; error: string } => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }))
    if (controller.signal.aborted) {
      this._active.delete(requestId)
      return { requestId, status: "cancelled" }
    }
    if (!resolution.ok) {
      this._active.delete(requestId)
      logger.warn("[PromptCompiler] provider unavailable: " + resolution.error)
      return { requestId, status: "failed", error: resolution.error }
    }
    const { endpoint } = resolution
    trace.provider = endpoint.provider
    inferenceEvent("operation.started", {
      operation_id: trace.operationId,
      kind: "prompt_compiler",
      compile_request_id: requestId,
      provider: endpoint.provider,
      model: endpoint.model,
      draft_chars: draft.length
    })
    const timeoutMs = this._deps.timeoutMs ?? DEFAULT_PROMPT_COMPILER_TIMEOUT_MS
    const clear = abortAfter(controller, timeoutMs, `Prompt Compiler timed out after ${Math.round(timeoutMs / 1000)} seconds.`)
    let state = "completed"
    try {
      const system = (await options.systemPrompt()).trim()
      const user = input.history ? `${input.history}\n\nCurrent draft:\n${draft}` : draft
      const response = await endpoint.infer({ system, user }, { signal: controller.signal, trace })
      if (controller.signal.aborted) throw controller.signal.reason ?? new Error("aborted")
      if (options.trace) {
        await options.trace({ requestId, operationId: trace.operationId, provider: endpoint.provider, model: endpoint.model, system, user, response })
          .catch((error) => logger.warn("[PromptCompiler] trace could not be written: " + String(error)))
      }
      const parsed = parsePromptCompilerResponse(response)
      if (!parsed.prompt) {
        state = "invalid-response"
        logger.warn("[PromptCompiler] " + parsed.error)
        return { requestId, status: "failed", error: "Prompt Compiler returned an unusable response: " + parsed.error }
      }
      return { requestId, status: "compiled", prompt: parsed.prompt }
    } catch (error) {
      const reason = controller.signal.reason
      if (reason instanceof RoleTimeoutError) {
        state = "timeout"
        logger.warn("[PromptCompiler] " + reason.message)
        return { requestId, status: "failed", error: reason.message }
      }
      if (controller.signal.aborted || isAbortError(error)) {
        state = "cancelled"
        return { requestId, status: "cancelled" }
      }
      state = "failed"
      const message = redact(this._deps.describeError?.(error) ?? (error instanceof Error ? error.message : String(error)))
      logger.warn("[PromptCompiler] provider failure: " + message)
      return { requestId, status: "failed", error: message.startsWith("Prompt Compiler") ? message : "Prompt Compiler failed: " + message }
    } finally {
      clear()
      this._active.delete(requestId)
      finishInferenceOperation(trace, state, {
        kind: "prompt_compiler",
        compile_request_id: requestId,
        ...(active.initiator ? { cancellation_initiator: active.initiator } : {})
      })
    }
  }

  /** Cancels one compilation; `true` when it was still running. */
  public cancel(requestId: string, initiator: "user" | "host" | "superseded" = "user"): boolean {
    const active = this._active.get(requestId)
    if (!active) return false
    active.initiator = initiator
    cancelInferenceOperation(active.trace, initiator === "host" ? "host" : "user", initiator)
    active.controller.abort(new Error("Prompt compilation cancelled"))
    return true
  }

  public cancelAll(initiator: "user" | "host" = "host") {
    for (const id of [...this._active.keys()]) this.cancel(id, initiator)
  }
}
