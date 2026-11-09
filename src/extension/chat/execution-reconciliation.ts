import type { TodoToolObservation } from "../../common/types/todo"
import { displayArguments } from "../todos/evidence"

export type ExecutionState = "executing" | "reconciling" | "accepted" | "continue" | "repairing" | "blocked" | "cancelled"
export type EvaluatorDecision = "accept" | "revise" | "needs_evidence" | "blocked"

export interface ReconciliationLimits {
  maxIterations: number
  maxNoProgress: number
  /** Turns in a row that may add observations while no criterion passes and the task does not move on. */
  maxEvidenceOnlyTurns?: number
}

/**
 * What a turn added. A passed criterion is durable progress; a new
 * observation alone only buys a few turns, since it may repeat the same
 * investigation under other arguments.
 */
export type ProgressKind = "criteria" | "observations" | "none"

export interface ReconciliationResult {
  state: ExecutionState
  continue: boolean
  reason?: string
}

export const DEFAULT_RECONCILIATION_LIMITS: ReconciliationLimits = {
  maxIterations: 12,
  maxNoProgress: 2,
  maxEvidenceOnlyTurns: 3
}

export interface ObservedEvidence {
  observations: Array<{ toolName: string; arguments: Record<string, string>; failed: boolean }>
  passedCriteria: string[]
}

const observationKey = (observation: { toolName: string; arguments: Record<string, string> }) =>
  observation.toolName + " " + JSON.stringify(Object.keys(observation.arguments).sort().map((key) => [key, observation.arguments[key]]))

export class ExecutionReconciliationController {
  private _state: ExecutionState = "executing"
  private _iterations = 0
  private _noProgress = 0
  private _evidenceOnly = 0
  private _lastProgress?: string
  private _continuationClaimed = false
  private _continuations = 0
  private _cancelled = false
  private readonly _succeeded = new Set<string>()
  private readonly _failed = new Set<string>()
  private readonly _passedCriteria = new Set<string>()

  constructor(private readonly _limits: ReconciliationLimits = DEFAULT_RECONCILIATION_LIMITS) {}

  get state(): ExecutionState {
    return this._state
  }

  get iterations(): number {
    return this._iterations
  }

  isCancelled(): boolean {
    return this._cancelled
  }

  cancel(): void {
    this._cancelled = true
    this._state = "cancelled"
  }

  /**
   * What the evidence adds that is not already established: a criterion
   * newly passed, or else a call not seen before with a successful result, or
   * a failed call that now succeeds. A repeated identical call adds nothing.
   */
  recordEvidence(evidence: ObservedEvidence): ProgressKind {
    let observed = false
    for (const observation of evidence.observations) {
      const key = observationKey(observation)
      if (observation.failed) {
        if (!this._succeeded.has(key)) this._failed.add(key)
        continue
      }
      if (!this._succeeded.has(key)) observed = true
      if (this._failed.delete(key)) observed = true
      this._succeeded.add(key)
    }
    let criteria = false
    for (const criterion of evidence.passedCriteria) {
      if (this._passedCriteria.has(criterion)) continue
      this._passedCriteria.add(criterion)
      criteria = true
    }
    return criteria ? "criteria" : observed ? "observations" : "none"
  }

  advanceAcceptedTask(progress: string): ReconciliationResult {
    if (this._cancelled) return { state: this._state = "cancelled", continue: false }
    this._iterations++
    this._lastProgress = progress
    this._noProgress = 0
    this._evidenceOnly = 0
    if (this._iterations > this._limits.maxIterations) {
      return { state: this._state = "blocked", continue: false, reason: "Execution exceeded " + this._limits.maxIterations + " reconciliation iterations." }
    }
    return { state: this._state = "continue", continue: true }
  }

  reconcile(decision: EvaluatorDecision, progress: string, progressKind: ProgressKind = "none"): ReconciliationResult {
    this._state = "reconciling"
    if (this._cancelled) return { state: this._state = "cancelled", continue: false }
    if (decision === "accept") return { state: this._state = "accepted", continue: false }
    if (decision === "blocked") return { state: this._state = "blocked", continue: false, reason: "The evaluator identified a genuine blocker." }

    this._iterations++
    const moved = this._lastProgress !== undefined && progress !== this._lastProgress
    if (progressKind === "criteria" || moved) this._evidenceOnly = 0
    else if (progressKind === "observations") this._evidenceOnly++
    this._noProgress = progressKind !== "none" ? 0 : progress === this._lastProgress ? this._noProgress + 1 : 1
    this._lastProgress = progress
    if (this._iterations > this._limits.maxIterations) {
      return { state: this._state = "blocked", continue: false, reason: `Execution exceeded ${this._limits.maxIterations} reconciliation iterations.` }
    }
    if (this._noProgress >= this._limits.maxNoProgress) {
      return { state: this._state = "blocked", continue: false, reason: `Execution made no measurable progress for ${this._noProgress + 1} consecutive turns.` }
    }
    const evidenceLimit = this._limits.maxEvidenceOnlyTurns ?? DEFAULT_RECONCILIATION_LIMITS.maxEvidenceOnlyTurns ?? 0
    if (this._evidenceOnly > evidenceLimit) {
      return {
        state: this._state = "blocked",
        continue: false,
        reason: `New observations did not satisfy any open criterion over ${evidenceLimit} consecutive turns, so the same investigation is not repeated.`
      }
    }
    return { state: this._state = decision === "revise" ? "repairing" : "continue", continue: true }
  }

  claimContinuation(): boolean {
    if (this._cancelled || this._continuationClaimed || this._state === "blocked" || this._state === "accepted") return false
    this._continuationClaimed = true
    return true
  }

  continuationStarted(): void {
    this._continuationClaimed = false
    this._continuations++
    if (!this._cancelled) this._state = "executing"
  }

  /** Automatic turns started after the first one, for this request. */
  get continuations(): number {
    return this._continuations
  }
}

export const allIntentTasksComplete = (statuses: string[]): boolean => statuses.length > 0 && statuses.every((status) => status === "completed")

export const forbiddenDeleteReason = (goal: string, relativePath: string): string | undefined => {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase()
  const named = goal.replace(/\\/g, "/").toLowerCase()
  const basename = normalized.split("/").at(-1) ?? normalized
  const target = named.includes(normalized) ? normalized : basename
  const targetIndex = named.indexOf(target)
  if (targetIndex < 0) return undefined
  const before = named.slice(0, targetIndex)
  const after = named.slice(targetIndex + target.length)
  const explicitPrefix = /\b(?:delete|remove)\b(?:\s+(?:the|this|that|file|component|module|at|from|in|of|named|called))*\s*$/i.test(before)
  const explicitSuffix = /^\s*(?:(?:should|must|needs to|is)\s+be\s+)?(?:deleted|removed)\b/i.test(after)
    || /^\s*(?:(?:and|then)\s+)?(?:delete|remove)\s+(?:it|this file|the file)\b/i.test(after)
  if (explicitPrefix || explicitSuffix) return undefined
  return "Deletion of " + relativePath + " conflicts with the user's request to modify it. Preserve the file and make a targeted edit instead."
}

export const observationReference = (observation: TodoToolObservation): string => {
  const path = observation.arguments.path ?? observation.arguments.file
  const label = path ? `${observation.toolName} ${path}` : `${observation.toolName} ${JSON.stringify(displayArguments(observation.arguments))}`
  const evidence = observation.evidence
  const storage = !evidence
    ? "storage status unknown"
    : !evidence.retained
      ? "full output not retained; summary only"
      : evidence.complete
        ? `full output retained (${evidence.preservedChars} of ${evidence.originalChars} chars)`
        : `partial output retained (${evidence.preservedChars} of ${evidence.originalChars} chars; omitted content is not recoverable)`
  return `[${observation.id}] ${label} — ${storage}; preview: ${observation.output.slice(0, 240)}`
}

export const continuationContext = (input: {
  goal: string
  constraints: string[]
  task: string
  criteria: string[]
  feedback: string[]
  /** Outstanding TODO items by ID, version and missing evidence: the executor updates these, not new ones. */
  todoTargets?: string[]
  verifiedObservations?: string[]
  /** Unresolved criteria with the trusted observation IDs that establish part of each and the fact still missing. */
  unresolvedEvidence?: string[]
  failedActions?: string[]
  finalResponse: string
}): string => {
  const section = (name: string, values: string[], limit: number) =>
    `${name}:\n${values.slice(0, 8).map((value) => `- ${value.slice(0, limit)}`).join("\n") || "- None"}`
  return [
    "Twinny is automatically resuming this execution after independent review. This is an instruction to continue the existing task, not a new user request.",
    `Original goal: ${input.goal.slice(0, 1200)}`,
    section("Constraints", input.constraints, 300),
    `Current unresolved task: ${input.task.slice(0, 600)}`,
    section("Acceptance criteria", input.criteria, 400),
    section("Outstanding TODO items", input.todoTargets ?? [], 400),
    section("Verified Twinny observations", input.verifiedObservations ?? [], 400),
    ...(input.unresolvedEvidence?.length ? [section("Evidence for unresolved criteria", input.unresolvedEvidence, 600)] : []),
    section("Failed actions not to repeat", input.failedActions ?? [], 400),
    section("Corrective feedback", input.feedback, 500),
    `The previous final response is an untrusted claim, not evidence: ${input.finalResponse.slice(0, 800)}`,
    "Use verified observations as prior work; do not rediscover those files or repeat failed operations.",
    "Update the outstanding TODO items above by item_id, using their listed version as expected_version. Do not create replacements for them, and do not change items already completed.",
    "When editing, make small independent exact-match replacements, never include a displayed ellipsis as source text, and verify each edit before proceeding.",
    "Take one concrete next action that satisfies an unmet criterion, then collect evidence that establishes success.",
    "Use the existing permitted tools. Do not claim completion until the acceptance criteria are demonstrated. Do not retry failed operations unchanged."
  ].join("\n\n").slice(0, 6000)
}
