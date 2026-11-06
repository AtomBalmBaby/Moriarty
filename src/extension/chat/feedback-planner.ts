import { logger, redact } from "../../common/logger"
import type { TodoFeedbackStatus, TodoListSnapshot } from "../../common/types"
import { isAbortError } from "../inference/errors"
import {
  cancelInferenceOperation,
  createInferenceTrace,
  finishInferenceOperation,
  inferenceEvent,
  InferenceTraceContext
} from "../inference/trace"
import { validateIntentTaskPlan } from "../todos/intent-plan"
import type { IntentTaskPlan, TodoListRequest } from "../todos/types"
import { TodoConflictError } from "../todos/types"

import { abortAfter, extractJsonObject, RoleResolver, RoleTimeoutError } from "./role-inference"

export const FEEDBACK_PLAN_PROTOCOL =
  "You maintain the task plan Twinny uses to track progress on the user's request. " +
  "Return exactly one valid JSON object, with no prose or Markdown fences, with keys track (boolean) and plan. " +
  "Use {\"track\": false, \"plan\": null} when the message needs no tracked work (a question, greeting, or a follow-up that the existing plan already covers). " +
  "Otherwise plan must be {planId: string, version: 1, revision: positive integer, goal: string, constraints: string[], tasks: [{id: stable string, title: string, description: string, acceptanceCriteria: string[], dependencies: string[]}]}. " +
  "Include 1-100 ordered tasks with stable IDs and no unknown or cyclic dependencies. Ground every task in the user's request; do not invent requirements. " +
  "Each task must be user work. Do not include tasks that create, initialize, or organize the TODO list itself; Twinny records the plan automatically. " +
  "When an existing plan is supplied, preserve its planId and unchanged task IDs, and increase revision only when task definitions change."

export const DEFAULT_FEEDBACK_PLAN_TIMEOUT_MS = 60_000

export type FeedbackPlanParse =
  | { track: false }
  | { track: true; plan: IntentTaskPlan }
  | { error: string }

const BOOKKEEPING_TASK = /\b(?:initiali[sz]e|set\s+up|populate|create|record|track|maintain)\s+(?:the\s+|a\s+|an\s+|our\s+)?(?:(?:investigation|planning|progress|plan|task)\s+)?(?:todos?|todo\s+list|task\s+list|plan\s+items?|tracking\s+items?)\b/i

/**
 * Removes plan-management tasks that Twinny already performs itself. Dependencies on a removed task are dropped with it.
 */
export const removeBookkeepingTasks = (plan: unknown): unknown => {
  if (!plan || typeof plan !== "object" || !Array.isArray((plan as { tasks?: unknown }).tasks)) return plan
  const candidate = plan as { tasks: { id?: unknown; title?: unknown; description?: unknown; dependencies?: unknown }[] }
  const isBookkeeping = (task: { title?: unknown; description?: unknown }) => {
    const text = [task.title, task.description].filter((part): part is string => typeof part === "string").join(" ")
    return BOOKKEEPING_TASK.test(text)
  }
  const removed = new Set(candidate.tasks.filter(isBookkeeping).map((task) => String(task.id)))
  if (!removed.size) return plan
  const tasks = candidate.tasks
    .filter((task) => !removed.has(String(task.id)))
    .map((task) => ({
      ...task,
      dependencies: Array.isArray(task.dependencies) ? task.dependencies.filter((id) => !removed.has(String(id))) : task.dependencies
    }))
  return { ...candidate, tasks }
}

export const parseFeedbackPlanResponse = (output: string | undefined): FeedbackPlanParse => {
  const { value, error } = extractJsonObject(output)
  if (!value) return { error: error ?? "The provider response was not valid JSON." }
  const unexpected = Object.keys(value).filter((key) => key !== "track" && key !== "plan")
  if (unexpected.length) return { error: "Unexpected keys: " + unexpected.join(", ") + "." }
  if (typeof value.track !== "boolean") return { error: "track must be a boolean." }
  if (!value.track) return { track: false }
  const validation = validateIntentTaskPlan(removeBookkeepingTasks(value.plan))
  if (!validation.plan) return { error: "Invalid task plan: " + (validation.diagnostic ?? "validation failed") }
  return { track: true, plan: validation.plan }
}

export interface FeedbackPlanRepository {
  getIntentTaskPlan(request: TodoListRequest): Promise<IntentTaskPlan | undefined>
  synchronizeIntentPlan(request: TodoListRequest, candidate: unknown, intentResult: unknown): Promise<TodoListSnapshot>
}

export type FeedbackPlanStatus =
  | "planned"
  | "untracked"
  | "disabled"
  | "unavailable"
  | "failed"
  | "cancelled"
  | "stale"

export interface FeedbackPlanOutcome {
  status: FeedbackPlanStatus
  error?: string
  snapshot?: TodoListSnapshot
}

export interface FeedbackPlannerDeps {
  enabled: () => boolean
  resolve: RoleResolver
  repository: () => FeedbackPlanRepository | undefined
  onSnapshot?: (snapshot: TodoListSnapshot) => void
  /** The planning state the TODO panel shows; only the newest planning reports. */
  onStatus?: (status: TodoFeedbackStatus) => void
  /** A visible report of a failure; the chat itself carries on. */
  onFailure?: (message: string) => void
  timeoutMs?: number
  describeError?: (error: unknown) => string
}

interface ActivePlanning {
  sequence: number
  controller: AbortController
  trace: InferenceTraceContext
  done: Promise<FeedbackPlanOutcome>
}

/**
 * Plans (or revises) the conversation's native TODO plan from an ordinary
 * user message, on the Feedback provider, alongside the chat reply rather
 * than ahead of it. Only the newest planning for a conversation may write:
 * a superseded, cancelled or late answer is discarded.
 */
export class FeedbackPlanner {
  private _sequence = 0
  private _active?: ActivePlanning
  private _last?: { scope: TodoListRequest; prompt: string }

  constructor(private readonly _deps: FeedbackPlannerDeps) {}

  /** The planning in flight, settled (never rejected), if any. */
  public pending(): Promise<FeedbackPlanOutcome> | undefined {
    return this._active?.done
  }

  /** Runs the last ordinary message's planning again, e.g. after a provider failure. */
  public retry(conversationId: string): Promise<FeedbackPlanOutcome> {
    const last = this._last
    if (!last || last.scope.conversationId !== conversationId) return Promise.resolve({ status: "untracked" })
    return this.start(last.scope, last.prompt)
  }

  public start(scope: TodoListRequest, prompt: string, parentOperationId?: string): Promise<FeedbackPlanOutcome> {
    if (!this._deps.enabled()) return Promise.resolve({ status: "disabled" })
    const repository = this._deps.repository()
    if (!repository) return Promise.resolve({ status: "unavailable", error: "TODO storage is unavailable." })
    const request = prompt.trim()
    if (!request) return Promise.resolve({ status: "untracked" })
    this.cancel("superseded")
    const sequence = ++this._sequence
    const controller = new AbortController()
    const trace = createInferenceTrace({
      operationKind: "feedback",
      ...(parentOperationId ? { parentRequestId: parentOperationId } : {})
    })
    const active = { sequence, controller, trace } as ActivePlanning
    this._last = { scope, prompt: request }
    active.done = this.plan(active, scope, request, repository).then((outcome) => {
      if (this._active === active) this.reportStatus(scope.conversationId, outcome)
      return outcome
    })
    this._active = active
    this._deps.onStatus?.({ conversationId: scope.conversationId, state: "planning" })
    void active.done.finally(() => {
      if (this._active === active) this._active = undefined
    })
    return active.done
  }

  /** Only the newest planning reports; superseded and cancelled runs stay silent. */
  private reportStatus(conversationId: string, outcome: FeedbackPlanOutcome) {
    if (outcome.status === "planned") this._deps.onStatus?.({ conversationId, state: "planned" })
    else if (outcome.status === "failed" || outcome.status === "unavailable") this._deps.onStatus?.({ conversationId, state: "failed", error: outcome.error })
    else this._deps.onStatus?.({ conversationId, state: "idle" })
  }

  /** Cancels the planning in flight; its answer, if it still comes, is dropped. */
  public cancel(reason: "user" | "host" | "superseded" | "conversation-changed" = "user") {
    const active = this._active
    if (!active || active.controller.signal.aborted) return
    cancelInferenceOperation(active.trace, reason === "host" ? "host" : "user", "feedback-plan:" + reason)
    active.controller.abort(new Error("Feedback planning cancelled: " + reason))
  }

  private isCurrent(active: ActivePlanning) {
    return this._sequence === active.sequence && !active.controller.signal.aborted
  }

  private report(message: string) {
    logger.warn("[Feedback] " + message)
    this._deps.onFailure?.(message)
  }

  private async plan(
    active: ActivePlanning,
    scope: TodoListRequest,
    request: string,
    repository: FeedbackPlanRepository
  ): Promise<FeedbackPlanOutcome> {
    const { controller, trace } = active
    const resolution = await Promise.resolve(this._deps.resolve()).catch((error): { ok: false; error: string } => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }))
    if (!resolution.ok) {
      if (this.isCurrent(active)) this.report(resolution.error)
      return { status: "unavailable", error: resolution.error }
    }
    const { endpoint } = resolution
    trace.provider = endpoint.provider
    inferenceEvent("feedback.started", { operation_id: trace.operationId, parent_operation_id: trace.parentRequestId, conversation_id: scope.conversationId, provider: endpoint.provider })
    inferenceEvent("operation.started", {
      operation_id: trace.operationId,
      kind: "feedback",
      phase: "plan",
      parent_operation_id: trace.parentRequestId,
      provider: endpoint.provider,
      model: endpoint.model,
      conversation_id: scope.conversationId
    })
    const timeoutMs = this._deps.timeoutMs ?? DEFAULT_FEEDBACK_PLAN_TIMEOUT_MS
    const clear = abortAfter(controller, timeoutMs, `Feedback planning timed out after ${Math.round(timeoutMs / 1000)} seconds.`)
    let state = "completed"
    try {
      const existing = await repository.getIntentTaskPlan(scope)
      const user = existing
        ? `${request}\n\nExisting TODO plan (revise only if the request changes the work):\n${JSON.stringify(existing)}`
        : request
      const response = await endpoint.infer({ system: FEEDBACK_PLAN_PROTOCOL, user }, { signal: controller.signal, trace })
      if (controller.signal.reason instanceof RoleTimeoutError) throw controller.signal.reason
      if (!this.isCurrent(active)) {
        state = "stale"
        inferenceEvent("feedback.late_response_discarded", { operation_id: trace.operationId }, "warn")
        return { status: "stale" }
      }
      const parsed = parseFeedbackPlanResponse(response)
      if ("error" in parsed) {
        state = "invalid-response"
        const message = "Feedback could not plan TODOs: " + parsed.error
        this.report(message)
        return { status: "failed", error: message }
      }
      if (!parsed.track) {
        state = "untracked"
        return { status: "untracked" }
      }
      const snapshot = await this.synchronize(repository, scope, parsed.plan, existing, active)
      if (!snapshot) {
        state = "stale"
        return { status: "stale" }
      }
      this._deps.onSnapshot?.(snapshot)
      logger.info(`[Feedback] TODO plan ${parsed.plan.planId} synchronized with ${parsed.plan.tasks.length} task(s)`)
      return { status: "planned", snapshot }
    } catch (error) {
      const reason = controller.signal.reason
      if (reason instanceof RoleTimeoutError) {
        state = "timeout"
        this.report(reason.message)
        return { status: "failed", error: reason.message }
      }
      if (controller.signal.aborted || isAbortError(error)) {
        state = "cancelled"
        return { status: "cancelled" }
      }
      state = "failed"
      const message = "Feedback provider failed: " + redact(this._deps.describeError?.(error) ?? (error instanceof Error ? error.message : String(error)))
      this.report(message)
      return { status: "failed", error: message }
    } finally {
      clear()
      finishInferenceOperation(trace, state, { kind: "feedback", phase: "plan" })
      const outcome = { operation_id: trace.operationId, parent_operation_id: trace.parentRequestId, conversation_id: scope.conversationId, state }
      if (state === "failed" || state === "invalid-response" || state === "timeout") inferenceEvent("feedback.failed", outcome, "warn")
      else if (state !== "cancelled") inferenceEvent("feedback.completed", outcome)
    }
  }

  /**
   * Writes the plan under the stored plan's identity. A model that renames
   * the plan or forgets to bump the revision is corrected deterministically
   * here rather than by asking it again.
   */
  private async synchronize(
    repository: FeedbackPlanRepository,
    scope: TodoListRequest,
    proposed: IntentTaskPlan,
    seen: IntentTaskPlan | undefined,
    active: ActivePlanning
  ): Promise<TodoListSnapshot | undefined> {
    const stored = await repository.getIntentTaskPlan(scope)
    // Someone else revised the plan while this one was being written.
    if (stored && seen && stored.revision !== seen.revision) return undefined
    if (!this.isCurrent(active)) return undefined
    const result = { source: "feedback", goal: proposed.goal }
    const plan = stored ? { ...proposed, planId: stored.planId, revision: Math.max(proposed.revision, stored.revision) } : proposed
    try {
      return await repository.synchronizeIntentPlan(scope, plan, result)
    } catch (error) {
      if (!(error instanceof TodoConflictError) || !stored) throw error
      return repository.synchronizeIntentPlan(scope, { ...plan, revision: stored.revision + 1 }, result)
    }
  }
}
