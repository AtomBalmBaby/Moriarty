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
  criteria?: TypedCriterion[]
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
/**
 * A checked source location. `symbol` is always the authoritative implementation symbol (for example readFile).
 * `registeredTool` is set only when a trusted registration read proves that this symbol is registered under that
 * tool name (for example read_file). Tool names and implementation symbols are different identities.
 */
export interface TodoSourceFact {
  symbol: string
  registeredTool?: string
  path: string
  startLine: number
  endLine: number
  observationId: string
  sourceHash: string
}

/**
 * Which identity a source criterion names. `registered_tool` matches the name a tool is registered under.
 * `implementation_symbol` matches the declaring function, class, or variable. The two are never inferred from each other.
 */
export type SourceIdentity = "registered_tool" | "implementation_symbol"

export interface TodoCriterionReconciliation {
  outcome: "proven" | "disproven" | "unknown" | "semantic"
  /** Stable identity of the typed criterion this outcome decides. */
  criterionId: string
  supportingObservationIds: string[]
  missing: string[]
  version: number
  /** Source locations this outcome proves; recorded as accepted evidence when the task is accepted. */
  facts?: TodoSourceFact[]
  /** `accepted` when previously accepted, still-fresh facts satisfied the criterion without this task's reads. */
  reuse?: "accepted"
  /** What a proven outcome does not cover, when the host's record of operations is not a complete audit. */
  scope?: string
}

export interface TodoEvaluationCriterion {
  /** Display text, derived from the typed criterion's description. */
  criterion: string
  criterionId: string
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

/**
 * Machine-checkable verification for one acceptance criterion. The host decides each kind from its own records;
 * the criterion's description is display text only.
 */
export type WorkspaceMutationOperation = "create" | "edit" | "delete"

export type CriterionVerification =
  /** Proven by a successful project-scoped accepted-evidence lookup, whether it found facts or none. */
  | { kind: "evidence_lookup_completed" }
  /** Proven by a live accepted fact that matches the symbol under `identity` and the path, or disproven only by a complete project-wide lookup that found none. */
  | { kind: "accepted_fact_exists"; identity: SourceIdentity; symbol: string; path?: string }
  /** Proven by an authoritative read or accepted fact that locates the symbol's declaration in the path. */
  | { kind: "source_location"; identity: SourceIdentity; symbol: string; path: string }
  /** Proven by an authoritative read that shows the declaration through its closing boundary at the current source. */
  | { kind: "source_range"; identity: SourceIdentity; symbol: string; path: string }
  /** Proven when the declaration's fingerprint at the authoritative read matches the current source. */
  | { kind: "source_fingerprint"; identity: SourceIdentity; symbol: string; path: string }
  /** Proven by the host's record of tool operations. Covers only tool calls the host recorded, not shell writes. */
  | { kind: "execution_invariant"; invariant: "no_mutating_tool_calls" }
  /** Proven when a successful host-recorded file create, edit, or delete ran during this task. A required change, not a prohibition. `operation` narrows it to one kind of mutation. */
  | { kind: "workspace_mutation"; operation?: WorkspaceMutationOperation }
  /**
   * Proven when the latest host-recorded run of this exact command exited with the given code and no successful
   * workspace mutation Twinny recorded in the task came after that run. `scope: "historical"` states a diagnostic
   * about an earlier revision: it ignores later mutations and proves nothing about the current workspace.
   * `execution: "after_activation"` requires that run to come after the task's requirement activation, so a run that
   * completed earlier cannot satisfy it. Omitted means `"recorded"`: any recorded run may satisfy the criterion.
   */
  | { kind: "command_exit_status"; command: string; exitCode: number; scope?: "current" | "historical"; execution?: "recorded" | "after_activation" }
  /** Genuinely interpretive; delegated to the configured Feedback evaluator. */
  | { kind: "semantic_review" }

export type CriterionVerificationKind = CriterionVerification["kind"]

export interface TypedCriterion {
  id: string
  description: string
  verification: CriterionVerification
}

export interface IntentTaskDefinition {
  id: string
  title: string
  description: string
  /** Typed verification contracts; the only acceptance representation. */
  criteria: TypedCriterion[]
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
