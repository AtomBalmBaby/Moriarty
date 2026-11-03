export type TodoStatus = "pending" | "in_progress" | "in_review" | "blocked" | "completed" | "cancelled"
export type TodoVerification = "not_checked" | "passed" | "failed" | "waived"
export type TodoPriority = "low" | "normal" | "high" | "urgent"

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
