import type { TodoEvidence, TodoItem, TodoPriority } from "../../common/types"

export type { TodoEvidence, TodoItem, TodoListSnapshot, TodoPriority, TodoSource, TodoStatus, TodoVerification } from "../../common/types"
export type TodoActor = "user" | "model"

export type { IntentTaskDefinition, IntentTaskPlan } from "../../common/types"

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

export class TodoConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TodoConflictError"
  }
}
