import type { TodoEvaluation,TodoEvidence, TodoItem, TodoPriority, TodoStatus, TodoToolObservation, TodoVerification } from "../../common/types"

export type { TodoEvaluation, TodoEvaluationCriterion, TodoEvaluationDecision, TodoEvidence, TodoItem, TodoListSnapshot, TodoPriority, TodoSource, TodoStatus, TodoToolObservation, TodoVerification } from "../../common/types"
export type TodoActor = "user" | "model"

export type { IntentTaskDefinition, IntentTaskPlan } from "../../common/types"

/** Every active plan task with its TODO item, for the executor to update instead of recreating. */
export interface IntentPlanOutline {
  planId: string
  revision: number
  goal: string
  tasks: IntentPlanOutlineTask[]
}

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

export interface TodoToolObservationInput {
  itemId: string
  toolName: string
  arguments: Record<string, string>
  output: string
  failed: boolean
  exitCode?: number
  requestId: string
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
  lastEvaluation?: TodoEvaluation
}

export class TodoConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TodoConflictError"
  }
}
