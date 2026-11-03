import { createHash, randomUUID } from "node:crypto"
import { Database, SqlValue } from "sql.js"

import { SqliteFile } from "./sqlite"
import {
  type AddTodoEvidenceInput,
  type CreateTodoInput,
  TodoConflictError,
  type TodoEvidence,
  type TodoItem,
  type TodoListRequest,
  type TodoListSnapshot,
  type TodoPriority,
  type TodoStatus,
  type TodoVerification,
  type UpdateTodoInput
} from "./types"

interface ProjectRow {
  id: string
  fingerprint: string
}

interface ListRow {
  id: string
  project_id: string
  conversation_id: string
  revision: number
}

interface ItemRow {
  id: string
  list_id: string
  parent_id: string | null
  title: string
  details: string | null
  status: TodoStatus
  verification: TodoVerification
  priority: TodoPriority
  created_by: "user" | "model"
  sort_order: number
  blocked_reason: string | null
  version: number
  created_at: string
  updated_at: string
}

const now = () => new Date().toISOString()
const validStatuses = new Set<TodoStatus>(["pending", "in_progress", "in_review", "blocked", "completed", "cancelled"])
const validPriorities = new Set<TodoPriority>(["low", "normal", "high", "urgent"])
const statusTransitions: Record<TodoStatus, Set<TodoStatus>> = {
  pending: new Set(["in_progress", "in_review", "blocked", "cancelled"]),
  in_progress: new Set(["pending", "in_review", "blocked", "cancelled"]),
  in_review: new Set(["in_progress", "blocked", "cancelled"]),
  blocked: new Set(["pending", "in_progress", "cancelled"]),
  completed: new Set(["pending", "in_progress"]),
  cancelled: new Set(["pending", "in_progress"])
}

const rows = <T>(database: Database, sql: string, values: SqlValue[] = []): T[] => {
  const statement = database.prepare(sql)
  try {
    statement.bind(values)
    const result: T[] = []
    while (statement.step()) result.push(statement.getAsObject() as T)
    return result
  } finally {
    statement.free()
  }
}

const itemOf = (row: ItemRow): TodoItem => ({
  id: row.id,
  listId: row.list_id,
  parentId: row.parent_id ?? undefined,
  title: row.title,
  details: row.details ?? undefined,
  status: row.status,
  verification: row.verification,
  priority: row.priority,
  createdBy: row.created_by,
  sortOrder: row.sort_order,
  blockedReason: row.blocked_reason ?? undefined,
  version: row.version,
  createdAt: row.created_at,
  updatedAt: row.updated_at
})

const parseRequest = <T>(database: Database, listId: string, requestId: string, operation: string): T | undefined => {
  const [stored] = rows<{ operation: string; result_json: string }>(
    database,
    "SELECT operation, result_json FROM todo_requests WHERE list_id = ? AND request_id = ?",
    [listId, requestId]
  )
  if (!stored) return undefined
  if (stored.operation !== operation) throw new TodoConflictError("This request ID was already used for a different TODO operation")
  return JSON.parse(stored.result_json) as T
}

const recordRequest = (database: Database, listId: string, requestId: string, operation: string, result: unknown) => {
  database.run(
    "INSERT INTO todo_requests(list_id, request_id, operation, result_json, created_at) VALUES (?, ?, ?, ?, ?)",
    [listId, requestId, operation, JSON.stringify(result), now()]
  )
}

const ensureList = (database: Database, request: TodoListRequest): ListRow => {
  const fingerprint = request.projectFingerprint.trim()
  const conversationId = request.conversationId.trim()
  if (!fingerprint || fingerprint.length > 256) throw new Error("Invalid project identity")
  if (!conversationId || conversationId.length > 256) throw new Error("Invalid conversation identity")

  const existingProject = rows<ProjectRow>(database, "SELECT id, fingerprint FROM todo_projects WHERE fingerprint = ?", [fingerprint])[0]
  const projectId = existingProject?.id ?? randomUUID()
  if (!existingProject) database.run("INSERT INTO todo_projects(id, fingerprint, created_at) VALUES (?, ?, ?)", [projectId, fingerprint, now()])

  let list = rows<ListRow>(
    database,
    "SELECT id, project_id, conversation_id, revision FROM todo_lists WHERE project_id = ? AND conversation_id = ?",
    [projectId, conversationId]
  )[0]
  if (!list) {
    const listId = randomUUID()
    database.run(
      "INSERT INTO todo_lists(id, project_id, conversation_id, revision, created_at) VALUES (?, ?, ?, 0, ?)",
      [listId, projectId, conversationId, now()]
    )
    list = { id: listId, project_id: projectId, conversation_id: conversationId, revision: 0 }
  }
  return list
}

const snapshotFor = (database: Database, list: ListRow, includeCompleted = true): TodoListSnapshot => {
  const itemRows = rows<ItemRow>(
    database,
    `SELECT id, list_id, parent_id, title, details, status, verification, priority, created_by, sort_order, blocked_reason, version, created_at, updated_at
     FROM todo_items WHERE list_id = ? ${includeCompleted ? "" : "AND status NOT IN ('completed','cancelled')"}
     ORDER BY sort_order, created_at`,
    [list.id]
  )
  return {
    id: list.id,
    projectId: list.project_id,
    conversationId: list.conversation_id,
    revision: list.revision,
    items: itemRows.map(itemOf)
  }
}

const bumpList = (database: Database, listId: string, itemId: string | undefined, eventType: string, actor: string, requestId: string, payload: unknown) => {
  database.run("UPDATE todo_lists SET revision = revision + 1 WHERE id = ?", [listId])
  const [revision] = rows<{ revision: number }>(database, "SELECT revision FROM todo_lists WHERE id = ?", [listId])
  database.run(
    `INSERT INTO todo_events(id, list_id, item_id, list_revision, event_type, actor, request_id, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [randomUUID(), listId, itemId ?? null, revision.revision, eventType, actor, requestId, JSON.stringify(payload), now()]
  )
  return revision.revision
}

const validateRequestId = (requestId: string) => {
  if (!requestId.trim() || requestId.length > 200) throw new Error("A request ID between 1 and 200 characters is required")
}

export class TodoRepository {
  private readonly sqlite: SqliteFile

  constructor(databasePath: string, wasmPath: string) {
    this.sqlite = new SqliteFile(databasePath, wasmPath)
  }

  initialize(): Promise<void> {
    return this.sqlite.initialize()
  }

  getList(request: TodoListRequest): Promise<TodoListSnapshot> {
    return this.sqlite.write((database) => {
      const list = ensureList(database, request)
      return snapshotFor(database, list, request.includeCompleted)
    })
  }

  getItem(request: TodoListRequest, itemId: string): Promise<{ item: TodoItem; evidence: TodoEvidence[] }> {
    return this.sqlite.write((database) => {
      const list = ensureList(database, request)
      const row = rows<ItemRow>(
        database,
        `SELECT id, list_id, parent_id, title, details, status, verification, priority, created_by, sort_order, blocked_reason, version, created_at, updated_at
         FROM todo_items WHERE id = ? AND list_id = ?`,
        [itemId, list.id]
      )[0]
      if (!row) throw new Error("TODO item was not found in the active conversation")
      const evidence = rows<TodoEvidence>(
        database,
        "SELECT id, item_id AS itemId, kind, summary, result, created_at AS createdAt FROM todo_evidence WHERE item_id = ? ORDER BY created_at",
        [itemId]
      )
      return { item: itemOf(row), evidence }
    })
  }

  createItem(request: TodoListRequest, input: CreateTodoInput, requestId: string, actor: "user" | "model" = "model"): Promise<TodoItem> {
    validateRequestId(requestId)
    const title = input.title.trim()
    const parentId = input.parentId?.trim() || undefined
    if (!title || title.length > 500) throw new Error("TODO title must contain 1 to 500 characters")
    if (input.details && input.details.length > 8000) throw new Error("TODO details cannot exceed 8,000 characters")
    const priority = input.priority ?? "normal"
    if (!validPriorities.has(priority)) throw new Error("Invalid TODO priority")

    return this.sqlite.write((database) => {
      const list = ensureList(database, request)
      const prior = parseRequest<TodoItem>(database, list.id, requestId, "create")
      if (prior) return prior
      if (parentId) {
        const parent = rows<{ id: string }>(database, "SELECT id FROM todo_items WHERE id = ? AND list_id = ?", [parentId, list.id])[0]
        if (!parent) throw new Error("Parent TODO item must be in the active conversation")
      }
      const createdAt = now()
      const id = randomUUID()
      database.run(
        `INSERT INTO todo_items(id, list_id, parent_id, title, details, status, verification, priority, created_by, sort_order, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', 'not_checked', ?, ?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM todo_items WHERE list_id = ?), 1, ?, ?)`,
        [id, list.id, parentId ?? null, title, input.details ?? null, priority, actor, list.id, createdAt, createdAt]
      )
      bumpList(database, list.id, id, "item_created", actor, requestId, { title, parentId, priority })
      const item = itemOf(rows<ItemRow>(database, "SELECT * FROM todo_items WHERE id = ?", [id])[0])
      recordRequest(database, list.id, requestId, "create", item)
      return item
    })
  }

  updateItem(request: TodoListRequest, input: UpdateTodoInput): Promise<TodoItem> {
    validateRequestId(input.requestId)
    return this.sqlite.write((database) => {
      const list = ensureList(database, request)
      const prior = parseRequest<TodoItem>(database, list.id, input.requestId, "update")
      if (prior) return prior
      const row = rows<ItemRow>(
        database,
        "SELECT * FROM todo_items WHERE id = ? AND list_id = ?",
        [input.itemId, list.id]
      )[0]
      if (!row) throw new Error("TODO item was not found in the active conversation")
      if (row.version !== input.expectedVersion) throw new TodoConflictError(`TODO changed since version ${input.expectedVersion}; current version is ${row.version}`)

      const patch = input.patch
      if (input.actor === "model" && row.created_by === "user" && (patch.title !== undefined || patch.details !== undefined || patch.priority !== undefined)) {
        throw new TodoConflictError("This TODO was authored by the user; propose edits instead of overwriting it")
      }
      if (!Object.keys(patch).length) throw new Error("TODO update must include at least one field")
      const title = patch.title === undefined ? row.title : patch.title.trim()
      if (!title || title.length > 500) throw new Error("TODO title must contain 1 to 500 characters")
      const details = patch.details === undefined ? row.details : patch.details
      if (details && details.length > 8000) throw new Error("TODO details cannot exceed 8,000 characters")
      const priority = patch.priority ?? row.priority
      const sortOrder = patch.sortOrder ?? row.sort_order
      if (!Number.isSafeInteger(sortOrder) || sortOrder < 0 || Math.abs(sortOrder - row.sort_order) > 1 || (sortOrder !== row.sort_order && input.actor !== "user")) {
        throw new Error("TODO reordering must move one position and be initiated by the user")
      }
      if (!validPriorities.has(priority)) throw new Error("Invalid TODO priority")

      let status = patch.status ?? row.status
      let blockedReason = patch.blockedReason === undefined ? row.blocked_reason : patch.blockedReason
      if (!validStatuses.has(status)) throw new Error("Invalid TODO status")
      if (status === "completed") {
        if (input.actor !== "user") status = "in_review"
        else if (row.status === "completed") throw new Error("Reopen a completed TODO before updating it")
        else throw new Error("Use explicit user completion to approve a TODO")
      }
      if (status === "blocked" && !blockedReason?.trim()) throw new Error("A blocked TODO requires a reason")
      if (status !== "blocked") blockedReason = null
      const verification = row.status === "completed" ? "not_checked" : row.verification
      const allowed = statusTransitions[row.status]
      if (status !== row.status && !allowed.has(status)) throw new Error(`Invalid TODO transition: ${row.status} -> ${status}`)

      const updatedAt = now()
      if (sortOrder !== row.sort_order) {
        const neighbor = rows<ItemRow>(database, "SELECT * FROM todo_items WHERE list_id = ? AND sort_order = ?", [list.id, sortOrder])[0]
        if (!neighbor) throw new Error("Cannot move TODO beyond the list boundary")
        database.run("UPDATE todo_items SET sort_order = ?, version = version + 1, updated_at = ? WHERE id = ?", [row.sort_order, updatedAt, neighbor.id])
      }
      database.run(
        "UPDATE todo_items SET title = ?, details = ?, status = ?, verification = ?, priority = ?, sort_order = ?, blocked_reason = ?, version = version + 1, updated_at = ? WHERE id = ?",
        [title, details ?? null, status, verification, priority, sortOrder, blockedReason ?? null, updatedAt, row.id]
      )
      bumpList(database, list.id, row.id, "item_updated", input.actor, input.requestId, { ...patch, status, blockedReason })
      const item = itemOf(rows<ItemRow>(database, "SELECT * FROM todo_items WHERE id = ?", [row.id])[0])
      recordRequest(database, list.id, input.requestId, "update", item)
      return item
    })
  }

  completeByUser(request: TodoListRequest, itemId: string, expectedVersion: number, reason: string, requestId: string): Promise<TodoItem> {
    validateRequestId(requestId)
    const completionReason = reason.trim()
    if (!completionReason || completionReason.length > 1000) throw new Error("An explicit completion reason is required")
    return this.sqlite.write((database) => {
      const list = ensureList(database, request)
      const prior = parseRequest<TodoItem>(database, list.id, requestId, "complete")
      if (prior) return prior
      const row = rows<ItemRow>(database, "SELECT * FROM todo_items WHERE id = ? AND list_id = ?", [itemId, list.id])[0]
      if (!row) throw new Error("TODO item was not found in the active conversation")
      if (row.version !== expectedVersion) throw new TodoConflictError(`TODO changed since version ${expectedVersion}; current version is ${row.version}`)
      if (row.status === "completed" || row.status === "cancelled") throw new Error(`Cannot complete a ${row.status} TODO`)
      const unfinishedChild = rows<{ id: string }>(database, "SELECT id FROM todo_items WHERE parent_id = ? AND status NOT IN ('completed', 'cancelled') LIMIT 1", [itemId])[0]
      if (unfinishedChild) throw new Error("Complete or cancel child TODOs before completing their parent")
      const unfinishedDependency = rows<{ id: string }>(
        database,
        `SELECT dependency.item_id AS id FROM todo_dependencies dependency
         JOIN todo_items prerequisite ON prerequisite.id = dependency.depends_on_item_id
         WHERE dependency.item_id = ? AND prerequisite.status != 'completed' LIMIT 1`,
        [itemId]
      )[0]
      if (unfinishedDependency) throw new Error("Complete prerequisite TODOs before completing this task")
      const updatedAt = now()
      database.run(
        "UPDATE todo_items SET status = 'completed', verification = 'waived', blocked_reason = NULL, version = version + 1, updated_at = ? WHERE id = ?",
        [updatedAt, itemId]
      )
      bumpList(database, list.id, itemId, "item_completed_by_user", "user", requestId, { reason: completionReason })
      const item = itemOf(rows<ItemRow>(database, "SELECT * FROM todo_items WHERE id = ?", [itemId])[0])
      recordRequest(database, list.id, requestId, "complete", item)
      return item
    })
  }

  addEvidence(request: TodoListRequest, input: AddTodoEvidenceInput): Promise<TodoEvidence> {
    validateRequestId(input.requestId)
    const kind = input.kind.trim()
    const summary = input.summary.trim()
    if (!kind || kind.length > 100) throw new Error("Evidence kind must contain 1 to 100 characters")
    if (!summary || summary.length > 2000) throw new Error("Evidence summary must contain 1 to 2,000 characters")
    if (!["observed", "passed", "failed"].includes(input.result)) throw new Error("Invalid evidence result")
    return this.sqlite.write((database) => {
      const list = ensureList(database, request)
      const prior = parseRequest<TodoEvidence>(database, list.id, input.requestId, "evidence")
      if (prior) return prior
      const item = rows<{ id: string }>(database, "SELECT id FROM todo_items WHERE id = ? AND list_id = ?", [input.itemId, list.id])[0]
      if (!item) throw new Error("TODO item was not found in the active conversation")
      const evidence: TodoEvidence = { id: randomUUID(), itemId: input.itemId, kind, summary, result: input.result, createdAt: now() }
      database.run(
        "INSERT INTO todo_evidence(id, item_id, kind, summary, result, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        [evidence.id, evidence.itemId, evidence.kind, evidence.summary, evidence.result, evidence.createdAt]
      )
      bumpList(database, list.id, input.itemId, "evidence_added", "model", input.requestId, { kind, result: input.result, summary })
      recordRequest(database, list.id, input.requestId, "evidence", evidence)
      return evidence
    })
  }
}

export const workspaceProjectFingerprint = (workspaceUris: string[]): string => {
  if (!workspaceUris.length) return "unscoped"
  const normalized = workspaceUris.map((uri) => uri.trim()).filter(Boolean).sort()
  if (!normalized.length) return "unscoped"
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex")
}

export { TodoConflictError } from "./types"
