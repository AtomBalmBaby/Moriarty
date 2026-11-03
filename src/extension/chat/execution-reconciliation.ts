import { isAnalysisOnlyIntent } from "../todos/feedback"

export type ExecutionState = "executing" | "reconciling" | "accepted" | "continue" | "repairing" | "blocked" | "cancelled"
export type EvaluatorDecision = "accept" | "revise" | "needs_evidence" | "blocked"

export interface ReconciliationLimits {
  maxIterations: number
  maxNoProgress: number
}

export interface ReconciliationResult {
  state: ExecutionState
  continue: boolean
  reason?: string
}

export const DEFAULT_RECONCILIATION_LIMITS: ReconciliationLimits = {
  maxIterations: 12,
  maxNoProgress: 2
}

export class ExecutionReconciliationController {
  private _state: ExecutionState = "executing"
  private _iterations = 0
  private _noProgress = 0
  private _lastProgress?: string
  private _continuationClaimed = false
  private _cancelled = false

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

  reconcile(decision: EvaluatorDecision, progress: string, madeProgress = false): ReconciliationResult {
    this._state = "reconciling"
    if (this._cancelled) return { state: this._state = "cancelled", continue: false }
    if (decision === "accept") return { state: this._state = "accepted", continue: false }
    if (decision === "blocked") return { state: this._state = "blocked", continue: false, reason: "The evaluator identified a genuine blocker." }

    this._iterations++
    this._noProgress = madeProgress ? 0 : progress === this._lastProgress ? this._noProgress + 1 : 1
    this._lastProgress = progress
    if (this._iterations > this._limits.maxIterations) {
      return { state: this._state = "blocked", continue: false, reason: `Execution exceeded ${this._limits.maxIterations} reconciliation iterations.` }
    }
    if (this._noProgress >= this._limits.maxNoProgress) {
      return { state: this._state = "blocked", continue: false, reason: `Execution made no measurable progress for ${this._noProgress + 1} consecutive turns.` }
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
    if (!this._cancelled) this._state = "executing"
  }
}

const changeVerbs = /\b(add|change|create|delete|edit|enhance|fix|implement|improve|make|modify|refactor|remove|rewrite|update|write)\b/i

export const requiresWorkspaceChanges = (goal: string): boolean => {
  const leading = /^\s*(explain|analy[sz]e|review|describe|compare|summari[sz]e|why|how)\b/i.test(goal)
  return leading ? !isAnalysisOnlyIntent(goal) : changeVerbs.test(goal)
}

export const isAnalysisOnlyGoal = isAnalysisOnlyIntent

export const forbiddenDeleteReason = (goal: string, relativePath: string): string | undefined => {
  if (!requiresWorkspaceChanges(goal)) return undefined
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

export const continuationContext = (input: {
  goal: string
  constraints: string[]
  task: string
  criteria: string[]
  feedback: string[]
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
    section("Corrective feedback", input.feedback, 500),
    `The previous final response is an untrusted claim, not evidence: ${input.finalResponse.slice(0, 800)}`,
    "Use the existing permitted tools. Do not claim completion until the acceptance criteria are demonstrated. Do not retry failed operations unchanged."
  ].join("\n\n").slice(0, 6000)
}
