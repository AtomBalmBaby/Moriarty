import type { TodoEvaluation, TodoEvidence, TodoItem, TodoPriority, TodoSourceFact, TodoStatus, TodoToolObservation, TodoVerification } from "../../common/types"

import type { EvidenceHit, EvidenceSource } from "./evidence"

export type { TodoEvaluation, TodoEvaluationCriterion, TodoEvaluationDecision, TodoEvidence, TodoItem, TodoListSnapshot, TodoPriority, TodoSource, TodoStatus, TodoToolEvidenceStatus, TodoToolObservation, TodoVerification } from "../../common/types"
export type TodoActor = "user" | "model"

export type { IntentTaskDefinition, IntentTaskPlan } from "../../common/types"

/** Every active plan task with its TODO item, for the executor to update instead of recreating. */
export interface IntentPlanOutline {
  planId: string
  revision: number
  goal: string
  tasks: IntentPlanOutlineTask[]
  /** Child TODOs Feedback accepted under plan tasks. They are not plan tasks and add no dependencies. */
  children: IntentPlanOutlineChild[]
}

export interface IntentPlanOutlineChild {
  itemId: string
  parentItemId: string
  title: string
  status: TodoStatus
}

/** An agent's request to add a child under a plan TODO, before Feedback reviews it. */
export interface ChildTodoProposal {
  parentId: string
  title: string
  details?: string
  reason: string
  priority: TodoPriority
  requestId: string
}

export type ChildTodoDecisionKind = "accepted" | "existing_task" | "revised" | "rejected" | "needs_clarification"

/** A Feedback decision after the host has validated it. `revised` may change the title, details, or parent. */
export interface ChildTodoDecision {
  decision: ChildTodoDecisionKind
  itemId?: string
  title?: string
  details?: string
  parentId?: string
  instruction: string
}

/** The authoritative result of a child TODO proposal, as stored and returned to the agent. */
export interface ChildTodoOutcome {
  decision: ChildTodoDecisionKind
  parentId: string
  itemId?: string
  planRevision: number
  instruction: string
}

/** The plan state Feedback reviews a child proposal against. */
export interface ChildTodoContext {
  planId: string
  revision: number
  goal: string
  parent: { id: string; title: string; details?: string; status: TodoStatus; acceptance: string[]; dependsOn: string[] }
  children: IntentPlanOutlineChild[]
  planItems: { id: string; title: string; status: TodoStatus }[]
}

export type ChildTodoReviewOutcome =
  | { ok: true; decision: ChildTodoDecision }
  | { ok: false; error: string }

/** Reviews an agent's child proposal on the Feedback provider. A failure never authorizes a mutation. */
export type ChildTodoReview = (proposal: ChildTodoProposal, context: ChildTodoContext, signal?: AbortSignal) => Promise<ChildTodoReviewOutcome>

export interface IntentPlanOutlineTask {
  taskId: string
  itemId: string
  title: string
  status: TodoStatus
  verification: TodoVerification
  version: number
  blockedReason?: string
  /** Criteria the latest Feedback evaluation did not pass, with the reason it gave. */
  unmetCriteria: string[]
  problems: string[]
  /** Titles of prerequisite tasks that are not yet completed; a claim waits on these rather than failing review. */
  awaitingDependencies: string[]
}

export interface IntentPlanContext {
  planId: string
  revision: number
  goal: string
  constraints: string[]
  task: TodoItem
  planTaskId: string
  acceptanceCriteria: string[]
  dependencies: { id: string; title: string; status: TodoItem["status"] }[]
  evidence: TodoEvidence[]
  observations?: TodoToolObservation[]
  lastEvaluation?: TodoEvaluation
}

export interface TodoListRequest {
  projectFingerprint: string
  conversationId: string
  includeCompleted?: boolean
}

/**
 * A mutation of one conversation's list. `writer` is the conversation acting, supplied by host context
 * (the active chat or the session that invoked the tool), never by model output. The repository rejects
 * any write whose writer is not the list's own conversation.
 */
export interface TodoWriteRequest extends TodoListRequest {
  writer: string
}

export interface CreateTodoInput {
  title: string
  details?: string
  parentId?: string
  priority?: TodoPriority
}

export interface UpdateTodoInput {
  itemId: string
  expectedVersion: number
  patch: Partial<Pick<TodoItem, "title" | "details" | "status" | "priority" | "blockedReason" | "sortOrder">>
  actor: TodoActor
  requestId: string
}

export interface AddTodoEvidenceInput {
  itemId: string
  kind: string
  summary: string
  result: TodoEvidence["result"]
  requestId: string
}

/** Host record of the effective tool definitions sent to the model; proves exposure, not source registration. */
export const RUNTIME_INVENTORY_TOOL = "twinny_runtime_inventory"

export interface TodoToolObservationInput {
  itemId: string
  toolName: string
  arguments: Record<string, string>
  output: string
  /** Full tool output, kept for Feedback retrieval; `output` remains the bounded summary. */
  evidenceOutput?: string
  failed: boolean
  exitCode?: number
  requestId: string
}

/** Stored tool output for one observation, with whatever the store still holds. */
export interface RetainedObservationEvidence {
  observationId: string
  itemId: string
  toolName: string
  arguments: Record<string, string>
  failed: boolean
  exitCode?: number
  retained: boolean
  complete: boolean
  originalChars: number
  preservedChars: number
  content?: string
  sources: EvidenceSource[]
  hits: EvidenceHit[]
}

/**
 * A source location previously verified and accepted for a completed task; durable across turns and reopen.
 * Facts are project knowledge. `conversationId` records the originating chat as provenance, and only that chat may write its own facts.
 */
export interface AcceptedFact extends TodoSourceFact {
  id: string
  conversationId: string
  itemId: string
  criterionIndex: number
  criterion: string
  toolName: string
  planId: string
  planRevision: number
  /** Set when a later accepted fact for the same path and symbol replaced this one. The row is kept for audit. */
  supersededBy?: string
  acceptedAt: string
}

/**
 * A proven relationship between a registered tool name (read_file) and the symbol that implements it (readFile),
 * with the observation and fingerprint that proved it. Project knowledge, like accepted facts.
 */
export interface SymbolAlias {
  id: string
  conversationId: string
  toolName: string
  implementation: string
  path: string
  startLine: number
  endLine: number
  observationId: string
  sourceHash: string
  createdAt: string
}

export interface TodoReviewPackage {
  projectFingerprint: string
  conversationId: string
  planId: string
  planRevision: number
  goal: string
  constraints: string[]
  planTaskId: string
  task: TodoItem
  acceptanceCriteria: string[]
  dependencies: { id: string; title: string; status: TodoItem["status"] }[]
  evidence: TodoEvidence[]
  observations: TodoToolObservation[]
  retainedEvidence: RetainedObservationEvidence[]
  /** Current accepted source facts for this conversation, so verification can reuse them across TODOs. */
  acceptedEvidence: AcceptedFact[]
  /** Proven tool-name to implementation relationships in this project. */
  symbolAliases: SymbolAlias[]
  lastEvaluation?: TodoEvaluation
}

/** Outcome of a completion claim: recorded once, then acknowledged idempotently. */
export interface TodoCompletionClaim {
  disposition: "accepted" | "already_submitted"
  item: TodoItem
  review: "feedback_turn_end" | "user_approval"
}

/** Outcome of a create: a model create that matches an existing task reuses it. */
export interface TodoCreateOutcome {
  item: TodoItem
  reused: boolean
  matchedBy?: "title" | "plan_overlap" | "plan_umbrella"
}

export class TodoConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TodoConflictError"
  }
}
