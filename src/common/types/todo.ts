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

export interface TodoListSnapshot {
  id: string
  projectId: string
  conversationId: string
  revision: number
  items: TodoItem[]
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
