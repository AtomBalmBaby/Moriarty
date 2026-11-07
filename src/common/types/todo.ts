export type TodoStatus = "pending" | "in_progress" | "in_review" | "blocked" | "completed" | "cancelled"
export type TodoVerification = "not_checked" | "passed" | "failed" | "waived"
export type TodoPriority = "low" | "normal" | "high" | "urgent"
export type TodoSource = "user" | "model" | "intent_compiler"

export interface TodoItem {
  id: string
  listId: string
  parentId?: string
  title: string
  details?: string
  status: TodoStatus
  verification: TodoVerification
  priority: TodoPriority
  createdBy: "user" | "model"
  source: TodoSource
  acceptanceCriteria?: string[]
  sortOrder: number
  blockedReason?: string
  version: number
  createdAt: string
  updatedAt: string
}

export interface TodoEvidence {
  id: string
  itemId: string
  kind: string
  summary: string
  result: "observed" | "passed" | "failed"
  createdAt: string
}

export type TodoEvaluationDecision = "accept" | "revise" | "needs_evidence" | "blocked"

/**
 * Deterministic result for one criterion. `semantic` marks criteria that name
 * no checkable source path or runtime fact; those remain with the Feedback AI.
 */
/** A checked source location: where a symbol is declared, and the fingerprint it was read under. */
export interface TodoSourceFact {
  symbol: string
  path: string
  startLine: number
  endLine: number
  observationId: string
  sourceHash: string
  /** Set when the criterion names a tool (for example read_file) whose registered name is implemented by this symbol (readFile). */
  implementation?: string
}

export interface TodoCriterionReconciliation {
  outcome: "proven" | "disproven" | "unknown" | "semantic"
  supportingObservationIds: string[]
  missing: string[]
  version: number
  /** Source locations this outcome proves; recorded as accepted evidence when the task is accepted. */
  facts?: TodoSourceFact[]
  /** `accepted` when previously accepted, still-fresh facts satisfied the criterion without this task's reads. */
  reuse?: "accepted"
}

export interface TodoEvaluationCriterion {
  criterion: string
  status: "passed" | "failed" | "unverified"
  evidenceRefs: string[]
  reconciliation?: TodoCriterionReconciliation
}

export interface TodoEvaluation {
  schemaVersion: 1
  taskId: string
  decision: TodoEvaluationDecision
  criteria: TodoEvaluationCriterion[]
  problems: string[]
  correctiveInstructions: string[]
  explanation: string
  scores: { completion: number; correctness: number; alignment: number }
  metadata: { evaluator: string; evaluatedAt: string; taskVersion: number; planRevision: number }
}

export interface TodoToolEvidenceStatus {
  retained: boolean
  complete: boolean
  originalChars: number
  preservedChars: number
}

export interface TodoToolObservation {
  id: string
  itemId: string
  toolName: string
  arguments: Record<string, string>
  output: string
  failed: boolean
  exitCode?: number
  createdAt: string
  evidence?: TodoToolEvidenceStatus
}

export interface TodoListSnapshot {
  id: string
  projectId: string
  conversationId: string
  revision: number
  items: TodoItem[]
}

/** The Feedback planning state of one conversation, shown above its TODO list. */
export interface TodoFeedbackStatus {
  conversationId: string
  state: "planning" | "retrying" | "planned" | "failed" | "idle"
  error?: string
}

export interface IntentTaskDefinition {
  id: string
  title: string
  description: string
  acceptanceCriteria: string[]
  dependencies: string[]
}

export interface IntentTaskPlan {
  planId: string
  version: 1
  revision: number
  goal: string
  constraints: string[]
  tasks: IntentTaskDefinition[]
}
