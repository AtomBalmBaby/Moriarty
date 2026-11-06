import { createHash, randomUUID } from "node:crypto"
import { Database, SqlValue } from "sql.js"

import { logger } from "../../common/logger"

import { hasTrustedEvidenceForCriterion, isAnalysisOnlyIntent } from "./feedback"
import { validateIntentTaskPlan } from "./intent-plan"
import { SqliteFile } from "./sqlite"
import {
  type AddTodoEvidenceInput,
  type CreateTodoInput,
  type IntentPlanContext,
  type IntentPlanOutline,
  type IntentTaskPlan,
  TodoConflictError,
  type TodoEvaluation,
  type TodoEvidence,
  type TodoItem,
  type TodoListRequest,
  type TodoListSnapshot,
  type TodoPriority,
  type TodoReviewPackage,
  type TodoSource,
  type TodoStatus,
  type TodoToolObservation,
  type TodoToolObservationInput,
  type TodoVerification,
  type UpdateTodoInput} from "./types"

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
  source: TodoSource
  acceptance_criteria?: string | null
  sort_order: number
  blocked_reason: string | null
  version: number
  created_at: string
  updated_at: string
}

const now = () => new Date().toISOString()
type TodoLogField = string | number | boolean | null
const logTodoEvent = (event: string, fields: Record<string, TodoLogField>) => logger.info("[Todo] " + event + " " + JSON.stringify(fields))
const validStatuses = new Set<TodoStatus>(["pending", "in_progress", "in_review", "blocked", "completed", "cancelled"])
const validPriorities = new Set<TodoPriority>(["low", "normal", "high", "urgent"])
const statusTransitions: Record<TodoStatus, Set<TodoStatus>> = {
  pending: new Set(["in_progress", "in_review", "blocked", "cancelled"]),
  in_progress: new Set(["pending", "in_review", "blocked", "cancelled"]),
  in_review: new Set(["in_progress", "blocked", "cancelled"]),
  blocked: new Set(["pending", "in_progress", "in_review", "cancelled"]),
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
  source: row.source,
  acceptanceCriteria: row.acceptance_criteria ? JSON.parse(row.acceptance_criteria) as string[] : undefined,
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
    `SELECT items.id, items.list_id, items.parent_id, items.title, items.details, items.status, items.verification, items.priority,
            items.created_by, items.source, tasks.acceptance_json AS acceptance_criteria, items.sort_order, items.blocked_reason,
            items.version, items.created_at, items.updated_at
     FROM todo_items AS items LEFT JOIN todo_intent_tasks AS tasks ON tasks.item_id = items.id
     WHERE items.list_id = ? ${includeCompleted ? "" : "AND items.status NOT IN ('completed','cancelled')"}
     ORDER BY items.sort_order, items.created_at`,
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

/**
 * Proof that a completion came from an explicit user action in the TODO panel.
 * Only the webview bridge may create one; model tools never receive it, so a
 * model-supplied `actor` or `verification` argument cannot grant approval.
 */
export interface TrustedUserApproval {
  readonly source: "todo-panel"
}

export const trustedTodoPanelApproval: TrustedUserApproval = Object.freeze({ source: "todo-panel" })

const normalizeTodoTitle = (title: string) => title.toLowerCase().replace(/\s+/g, " ").replace(/[\s.!:;]+$/, "").trim()
const normalizeTodoIdentity = (title: string) => normalizeTodoTitle(title)
  .split(" ")
  .filter((word) => word && word !== "the" && word !== "a" && word !== "an")
  .join(" ")
const PLACEHOLDER_BLOCK_REASONS = new Set(["no reason", "none", "n/a", "na", "tbd", "todo", "unknown", "blocked", "-"])
const isPlaceholderBlockReason = (reason: string) => {
  const normalized = normalizeTodoTitle(reason).replace(/[.!?]+$/, "")
  return normalized.length < 8 || PLACEHOLDER_BLOCK_REASONS.has(normalized)
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

  getIntentTaskPlan(request: TodoListRequest): Promise<IntentTaskPlan | undefined> {
    return this.sqlite.read((database) => {
      const project = rows<ProjectRow>(database, "SELECT id, fingerprint FROM todo_projects WHERE fingerprint = ?", [request.projectFingerprint.trim()])[0]
      if (!project) return undefined
      const list = rows<ListRow>(database, "SELECT id, project_id, conversation_id, revision FROM todo_lists WHERE project_id = ? AND conversation_id = ?", [project.id, request.conversationId.trim()])[0]
      if (!list) return undefined
      const stored = rows<{ plan_id: string; revision: number; goal: string; constraints_json: string }>(
        database, "SELECT plan_id, revision, goal, constraints_json FROM todo_intent_plans WHERE list_id = ?", [list.id]
      )[0]
      if (!stored) return undefined
      const tasks = rows<{ task_id: string; title: string; details: string; acceptance_json: string; dependencies_json: string }>(
        database,
        `SELECT tasks.task_id, items.title, items.details, tasks.acceptance_json, tasks.dependencies_json
         FROM todo_intent_tasks AS tasks JOIN todo_items AS items ON items.id = tasks.item_id
         WHERE tasks.list_id = ? AND tasks.active = 1 ORDER BY items.sort_order, items.created_at`, [list.id]
      )
      return {
        planId: stored.plan_id,
        version: 1,
        revision: stored.revision,
        goal: stored.goal,
        constraints: JSON.parse(stored.constraints_json) as string[],
        tasks: tasks.map((task) => ({
          id: task.task_id,
          title: task.title,
          description: task.details,
          acceptanceCriteria: JSON.parse(task.acceptance_json) as string[],
          dependencies: JSON.parse(task.dependencies_json) as string[]
        }))
      }
    })
  }

  getIntentResult(request: TodoListRequest): Promise<unknown | undefined> {
    return this.sqlite.read((database) => {
      const project = rows<ProjectRow>(database, "SELECT id, fingerprint FROM todo_projects WHERE fingerprint = ?", [request.projectFingerprint.trim()])[0]
      if (!project) return undefined
      const list = rows<ListRow>(database, "SELECT id, project_id, conversation_id, revision FROM todo_lists WHERE project_id = ? AND conversation_id = ?", [project.id, request.conversationId.trim()])[0]
      if (!list) return undefined
      const stored = rows<{ intent_result_json: string }>(database, "SELECT intent_result_json FROM todo_intent_plans WHERE list_id = ?", [list.id])[0]
      return stored ? JSON.parse(stored.intent_result_json) as unknown : undefined
    })
  }

  synchronizeIntentPlan(request: TodoListRequest, candidate: unknown, intentResult: unknown): Promise<TodoListSnapshot> {
    const validation = validateIntentTaskPlan(candidate)
    if (!validation.plan) throw new Error("Invalid intent plan: " + validation.diagnostic)
    const plan = validation.plan
    const resultJson = JSON.stringify(intentResult)
    if (!resultJson || resultJson.length > 100_000) throw new Error("Intent result must be serializable and no larger than 100,000 characters")

    return this.sqlite.write((database) => {
      const list = ensureList(database, request)
      const existing = rows<{
        plan_id: string; revision: number; goal: string; constraints_json: string; intent_result_json: string
      }>(database, "SELECT plan_id, revision, goal, constraints_json, intent_result_json FROM todo_intent_plans WHERE list_id = ?", [list.id])[0]
      if (existing) {
        if (existing.plan_id !== plan.planId) throw new TodoConflictError("Intent plan ID changed for this conversation; preserve the existing planId when revising it")
        if (plan.revision < existing.revision) throw new TodoConflictError("Intent plan revision is older than the stored revision")
      }

      const priorTasks = rows<{
        task_id: string; item_id: string; acceptance_json: string; dependencies_json: string; active: number
        title: string; details: string | null; sort_order: number
      }>(database,
        `SELECT tasks.task_id, tasks.item_id, tasks.acceptance_json, tasks.dependencies_json, tasks.active,
                items.title, items.details, items.sort_order
         FROM todo_intent_tasks AS tasks JOIN todo_items AS items ON items.id = tasks.item_id
         WHERE tasks.list_id = ?`, [list.id])
      const priorById = new Map(priorTasks.map((task) => [task.task_id, task]))
      const unchanged = !!existing && plan.revision === existing.revision
      if (unchanged) {
        if (existing.goal !== plan.goal || existing.constraints_json !== JSON.stringify(plan.constraints)) {
          throw new TodoConflictError("Intent plan definitions changed without increasing plan.revision")
        }
        if (priorTasks.filter((task) => task.active).length !== plan.tasks.length || plan.tasks.some((task) => {
          const prior = priorById.get(task.id)
          return !prior || !prior.active || prior.title !== task.title || prior.details !== task.description ||
            prior.acceptance_json !== JSON.stringify(task.acceptanceCriteria) || prior.dependencies_json !== JSON.stringify(task.dependencies)
        })) throw new TodoConflictError("Intent tasks changed without increasing plan.revision")
        database.run("UPDATE todo_intent_plans SET intent_result_json = ?, updated_at = ? WHERE list_id = ?", [resultJson, now(), list.id])
        return snapshotFor(database, list, request.includeCompleted)
      }

      const createdAt = now()
      const itemIds = new Map<string, string>()
      for (const [index, task] of plan.tasks.entries()) {
        const prior = priorById.get(task.id)
        if (prior) {
          itemIds.set(task.id, prior.item_id)
        } else {
          const itemId = randomUUID()
          const order = rows<{ next_order: number }>(database, "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM todo_items WHERE list_id = ?", [list.id])[0].next_order
          database.run(
            `INSERT INTO todo_items(id, list_id, title, details, status, verification, priority, created_by, source, sort_order, version, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'pending', 'not_checked', 'normal', 'model', 'intent_compiler', ?, 1, ?, ?)`,
            [itemId, list.id, task.title, task.description, order + index, createdAt, createdAt]
          )
          itemIds.set(task.id, itemId)
        }
      }

      database.run("UPDATE todo_intent_tasks SET active = 0 WHERE list_id = ?", [list.id])
      const userOrder = rows<{ max_order: number | null }>(database, "SELECT MAX(sort_order) AS max_order FROM todo_items WHERE list_id = ? AND source != 'intent_compiler'", [list.id])[0].max_order
      const firstPlanOrder = (userOrder ?? -1) + 1
      for (const [index, task] of plan.tasks.entries()) {
        const itemId = itemIds.get(task.id)!
        const prior = priorById.get(task.id)
        const desiredOrder = firstPlanOrder + index
        if (prior) {
          const changedDefinition = prior.title !== task.title || prior.details !== task.description || prior.sort_order !== desiredOrder
          if (changedDefinition) {
            database.run("UPDATE todo_items SET title = ?, details = ?, sort_order = ?, version = version + 1, updated_at = ? WHERE id = ?", [task.title, task.description, desiredOrder, createdAt, itemId])
          }
        }
        database.run(
          `INSERT INTO todo_intent_tasks(list_id, task_id, item_id, acceptance_json, dependencies_json, active)
           VALUES (?, ?, ?, ?, ?, 1)
           ON CONFLICT(list_id, task_id) DO UPDATE SET acceptance_json = excluded.acceptance_json,
             dependencies_json = excluded.dependencies_json, active = 1`,
          [list.id, task.id, itemId, JSON.stringify(task.acceptanceCriteria), JSON.stringify(task.dependencies)]
        )
        database.run("DELETE FROM todo_dependencies WHERE item_id = ?", [itemId])
      }
      for (const task of plan.tasks) {
        const itemId = itemIds.get(task.id)!
        for (const dependency of task.dependencies) {
          database.run("INSERT INTO todo_dependencies(item_id, depends_on_item_id) VALUES (?, ?)", [itemId, itemIds.get(dependency)!])
        }
      }
      if (existing) {
        database.run(
          "UPDATE todo_intent_plans SET revision = ?, goal = ?, constraints_json = ?, intent_result_json = ?, updated_at = ? WHERE list_id = ?",
          [plan.revision, plan.goal, JSON.stringify(plan.constraints), resultJson, createdAt, list.id]
        )
      } else {
        database.run(
          "INSERT INTO todo_intent_plans(list_id, plan_id, revision, goal, constraints_json, intent_result_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [list.id, plan.planId, plan.revision, plan.goal, JSON.stringify(plan.constraints), resultJson, createdAt]
        )
      }
      bumpList(database, list.id, undefined, "intent_plan_synchronized", "model", "intent-plan:" + plan.planId + ":" + plan.revision, {
        planId: plan.planId, revision: plan.revision, taskIds: plan.tasks.map((task) => task.id)
      })
      return snapshotFor(database, list, request.includeCompleted)
    })
  }

  getActiveIntentContext(request: TodoListRequest): Promise<IntentPlanContext | undefined> {
    return this.sqlite.read((database) => {
      const project = rows<ProjectRow>(database, "SELECT id, fingerprint FROM todo_projects WHERE fingerprint = ?", [request.projectFingerprint.trim()])[0]
      if (!project) return undefined
      const list = rows<ListRow>(database, "SELECT id, project_id, conversation_id, revision FROM todo_lists WHERE project_id = ? AND conversation_id = ?", [project.id, request.conversationId.trim()])[0]
      if (!list) return undefined
      const plan = rows<{ plan_id: string; revision: number; goal: string; constraints_json: string }>(
        database, "SELECT plan_id, revision, goal, constraints_json FROM todo_intent_plans WHERE list_id = ?", [list.id]
      )[0]
      if (!plan) return undefined
      const tasks = rows<ItemRow & { task_id: string; acceptance_json: string; dependencies_json: string }>(
        database,
        `SELECT items.id, items.list_id, items.parent_id, items.title, items.details, items.status, items.verification,
                items.priority, items.created_by, items.source, items.sort_order, items.blocked_reason, items.version,
                items.created_at, items.updated_at, tasks.task_id, tasks.acceptance_json, tasks.acceptance_json AS acceptance_criteria, tasks.dependencies_json
         FROM todo_intent_tasks AS tasks JOIN todo_items AS items ON items.id = tasks.item_id
         WHERE tasks.list_id = ? AND tasks.active = 1 ORDER BY items.sort_order, items.created_at`, [list.id]
      )
      const byId = new Map(tasks.map((task) => [task.task_id, task]))
      const current = tasks.find((task) => task.status === "in_progress") ?? tasks.find((task) =>
        task.status === "pending" && JSON.parse(task.dependencies_json as string).every((id: string) => byId.get(id)?.status === "completed")
      )
      if (!current) return undefined
      const dependencyIds = JSON.parse(current.dependencies_json as string) as string[]
      const evidence = rows<TodoEvidence>(database,
        "SELECT id, item_id AS itemId, kind, summary, result, created_at AS createdAt FROM todo_evidence WHERE item_id = ? ORDER BY created_at DESC LIMIT 3",
        [current.id]
      )
      const observations = rows<{ id: string; itemId: string; toolName: string; arguments_json: string; output: string; failed: number; exitCode: number | null; createdAt: string }>(database,
        "SELECT id, item_id AS itemId, tool_name AS toolName, arguments_json, output, failed, exit_code AS exitCode, created_at AS createdAt FROM todo_tool_observations WHERE item_id = ? ORDER BY created_at DESC LIMIT 10", [current.id]
      ).map((observation) => ({
        id: observation.id, itemId: observation.itemId, toolName: observation.toolName,
        arguments: JSON.parse(observation.arguments_json) as Record<string, string>, output: observation.output,
        failed: observation.failed !== 0, exitCode: observation.exitCode ?? undefined, createdAt: observation.createdAt
      }))
      const lastEvaluation = rows<{ evaluation_json: string }>(database,
        "SELECT evaluation_json FROM todo_evaluations WHERE item_id = ? ORDER BY created_at DESC LIMIT 1", [current.id])[0]
      return {
        planId: plan.plan_id,
        revision: plan.revision,
        goal: plan.goal,
        constraints: JSON.parse(plan.constraints_json) as string[],
        task: itemOf(current),
        planTaskId: current.task_id,
        acceptanceCriteria: JSON.parse(current.acceptance_json as string) as string[],
        dependencies: dependencyIds.flatMap((id) => {
          const dependency = byId.get(id)
          return dependency ? [{ id, title: dependency.title, status: dependency.status }] : []
        }),
        evidence,
        observations,
        lastEvaluation: lastEvaluation ? JSON.parse(lastEvaluation.evaluation_json) as TodoEvaluation : undefined
      }
    })
  }

  getPlanOutline(request: TodoListRequest): Promise<IntentPlanOutline | undefined> {
    return this.sqlite.read((database) => {
      const project = rows<ProjectRow>(database, "SELECT id, fingerprint FROM todo_projects WHERE fingerprint = ?", [request.projectFingerprint.trim()])[0]
      if (!project) return undefined
      const list = rows<ListRow>(database, "SELECT id, project_id, conversation_id, revision FROM todo_lists WHERE project_id = ? AND conversation_id = ?", [project.id, request.conversationId.trim()])[0]
      if (!list) return undefined
      const plan = rows<{ plan_id: string; revision: number; goal: string }>(
        database, "SELECT plan_id, revision, goal FROM todo_intent_plans WHERE list_id = ?", [list.id]
      )[0]
      if (!plan) return undefined
      const tasks = rows<{ task_id: string; id: string; title: string; status: TodoStatus; verification: TodoVerification; version: number; blocked_reason: string | null }>(
        database,
        `SELECT tasks.task_id, items.id, items.title, items.status, items.verification, items.version, items.blocked_reason
         FROM todo_intent_tasks AS tasks JOIN todo_items AS items ON items.id = tasks.item_id
         WHERE tasks.list_id = ? AND tasks.active = 1 ORDER BY items.sort_order, items.created_at`, [list.id]
      )
      return {
        planId: plan.plan_id,
        revision: plan.revision,
        goal: plan.goal,
        tasks: tasks.map((task) => {
          const latest = rows<{ evaluation_json: string }>(database,
            "SELECT evaluation_json FROM todo_evaluations WHERE item_id = ? ORDER BY created_at DESC LIMIT 1", [task.id])[0]
          const evaluation = latest ? JSON.parse(latest.evaluation_json) as TodoEvaluation : undefined
          return {
            taskId: task.task_id,
            itemId: task.id,
            title: task.title,
            status: task.status,
            verification: task.verification,
            version: task.version,
            blockedReason: task.blocked_reason ?? undefined,
            unmetCriteria: evaluation?.criteria.filter((criterion) => criterion.status !== "passed").map((criterion) => criterion.criterion) ?? [],
            problems: evaluation?.problems ?? []
          }
        })
      }
    })
  }

  getReviewPackages(request: TodoListRequest): Promise<TodoReviewPackage[]> {
    return this.sqlite.read((database) => {
      const project = rows<ProjectRow>(database, "SELECT id, fingerprint FROM todo_projects WHERE fingerprint = ?", [request.projectFingerprint.trim()])[0]
      if (!project) return []
      const list = rows<ListRow>(database, "SELECT id, project_id, conversation_id, revision FROM todo_lists WHERE project_id = ? AND conversation_id = ?", [project.id, request.conversationId.trim()])[0]
      if (!list) return []
      const plan = rows<{ plan_id: string; revision: number; goal: string; constraints_json: string }>(database, "SELECT plan_id, revision, goal, constraints_json FROM todo_intent_plans WHERE list_id = ?", [list.id])[0]
      if (!plan) return []
      const tasks = rows<ItemRow & { task_id: string; acceptance_json: string; dependencies_json: string }>(
        database,
        "SELECT items.id, items.list_id, items.parent_id, items.title, items.details, items.status, items.verification, items.priority, items.created_by, items.source, items.sort_order, items.blocked_reason, items.version, items.created_at, items.updated_at, tasks.task_id, tasks.acceptance_json, tasks.dependencies_json " +
          "FROM todo_intent_tasks AS tasks JOIN todo_items AS items ON items.id = tasks.item_id " +
          "WHERE tasks.list_id = ? AND tasks.active = 1 ORDER BY items.sort_order, items.created_at",
        [list.id]
      )
      const taskMap = new Map(tasks.map((task) => [task.task_id, task]))
      return tasks.filter((task) => task.status === "in_review").map((row) => {
        const evidence = rows<TodoEvidence>(database,
          "SELECT id, item_id AS itemId, kind, summary, result, created_at AS createdAt FROM todo_evidence WHERE item_id = ? ORDER BY created_at DESC LIMIT 10", [row.id])
        const observations = rows<{ id: string; itemId: string; toolName: string; arguments_json: string; output: string; failed_number: number; exitCode: number | null; createdAt: string }>(database,
          "SELECT id, item_id AS itemId, tool_name AS toolName, arguments_json, output, failed AS failed_number, exit_code AS exitCode, created_at AS createdAt FROM todo_tool_observations WHERE item_id = ? ORDER BY created_at DESC", [row.id]
        ).map((observation) => ({
          id: observation.id,
          itemId: observation.itemId,
          toolName: observation.toolName,
          arguments: JSON.parse(observation.arguments_json) as Record<string, string>,
          output: observation.output,
          failed: observation.failed_number !== 0,
          exitCode: observation.exitCode ?? undefined,
          createdAt: observation.createdAt
        }))
        const dependencyIds = JSON.parse(row.dependencies_json) as string[]
        const lastEvaluation = rows<{ evaluation_json: string }>(database,
          "SELECT evaluation_json FROM todo_evaluations WHERE item_id = ? ORDER BY created_at DESC LIMIT 1", [row.id])[0]
        return {
          projectFingerprint: request.projectFingerprint,
          conversationId: request.conversationId,
          planId: plan.plan_id,
          planRevision: plan.revision,
          goal: plan.goal,
          constraints: JSON.parse(plan.constraints_json) as string[],
          planTaskId: row.task_id,
          task: itemOf(row),
          acceptanceCriteria: JSON.parse(row.acceptance_json) as string[],
          dependencies: dependencyIds.flatMap((id) => {
            const dependency = taskMap.get(id)
            return dependency ? [{ id, title: dependency.title, status: dependency.status }] : []
          }),
          evidence,
          observations,
          lastEvaluation: lastEvaluation ? JSON.parse(lastEvaluation.evaluation_json) as TodoEvaluation : undefined
        }
      })
    })
  }

  recordToolObservation(request: TodoListRequest, input: TodoToolObservationInput): Promise<TodoToolObservation> {
    validateRequestId(input.requestId)
    const toolName = input.toolName.trim()
    const redact = (value: string) => value
      .replace(/(authorization\s*:\s*bearer\s+)[^\s]+/gi, "$1[REDACTED]")
      .replace(/\b(api[_-]?key|token|secret|password)\b(\s*[:=]\s*["']?)[^\s"',;]+/gi, "$1$2[REDACTED]")
      .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]")
    const output = redact(input.output)
    const arguments_ = Object.fromEntries(Object.entries(input.arguments).map(([key, value]) => [key, redact(value)]))
    if (!toolName || toolName.length > 120 || output.length > 12000) throw new Error("Tool observation exceeds its storage limits")
    return this.sqlite.write((database) => {
      const list = ensureList(database, request)
      const prior = rows<{ id: string; itemId: string; toolName: string; arguments_json: string; output: string; failed: number; exitCode: number | null; createdAt: string }>(database,
        "SELECT id, item_id AS itemId, tool_name AS toolName, arguments_json, output, failed, exit_code AS exitCode, created_at AS createdAt FROM todo_tool_observations WHERE list_id = ? AND request_id = ?", [list.id, input.requestId])[0]
      if (prior) return { ...prior, arguments: JSON.parse(prior.arguments_json) as Record<string, string>, failed: prior.failed !== 0, exitCode: prior.exitCode ?? undefined }
      const row = rows<ItemRow>(database, "SELECT * FROM todo_items WHERE id = ? AND list_id = ?", [input.itemId, list.id])[0]
      if (!row || row.status === "completed" || row.status === "cancelled") throw new Error("Tool observation task is no longer actionable")
      const intentTask = rows<{ task_id: string }>(database, "SELECT task_id FROM todo_intent_tasks WHERE item_id = ? AND list_id = ? AND active = 1", [input.itemId, list.id])[0]
      if (!intentTask) throw new Error("Tool observations are limited to active Intent tasks")
      const observation: TodoToolObservation = { id: randomUUID(), itemId: input.itemId, toolName, arguments: arguments_, output, failed: input.failed, exitCode: input.exitCode, createdAt: now() }
      database.run("INSERT INTO todo_tool_observations(id, list_id, item_id, request_id, tool_name, arguments_json, output, failed, exit_code, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [observation.id, list.id, input.itemId, input.requestId, toolName, JSON.stringify(arguments_), output, input.failed ? 1 : 0, input.exitCode ?? null, observation.createdAt])
      if (row.status === "in_review") database.run("UPDATE todo_items SET version = version + 1, updated_at = ? WHERE id = ?", [observation.createdAt, row.id])
      bumpList(database, list.id, input.itemId, "tool_observed", "system", input.requestId, { toolName, failed: input.failed, exitCode: input.exitCode })
      logTodoEvent("todo.evidence.recorded", { operation_id: list.id, item_id: input.itemId, tool_name: toolName, failed: input.failed, exit_code: input.exitCode ?? null, request_id: input.requestId })
      return observation
    })
  }

  applyEvaluation(request: TodoListRequest, itemId: string, expectedVersion: number, evaluation: TodoEvaluation, requestId: string): Promise<TodoEvaluation> {
    validateRequestId(requestId)
    return this.sqlite.write((database) => {
      const list = ensureList(database, request)
      const prior = rows<{ evaluation_json: string }>(database, "SELECT evaluation_json FROM todo_evaluations WHERE list_id = ? AND request_id = ?", [list.id, requestId])[0]
      if (prior) return JSON.parse(prior.evaluation_json) as TodoEvaluation
      const row = rows<ItemRow & { task_id: string }>(database,
        "SELECT items.*, tasks.task_id FROM todo_items AS items JOIN todo_intent_tasks AS tasks ON tasks.item_id = items.id WHERE items.id = ? AND items.list_id = ? AND tasks.active = 1", [itemId, list.id])[0]
      if (!row) throw new Error("Review task was not found in the active conversation")
      if (row.status !== "in_review") throw new TodoConflictError("Cannot review a TODO in " + row.status + " status")
      if (row.version !== expectedVersion) throw new TodoConflictError("TODO changed since review version " + expectedVersion + "; current version is " + row.version)
      const currentPlan = rows<{ revision: number; goal: string }>(database, "SELECT revision, goal FROM todo_intent_plans WHERE list_id = ?", [list.id])[0]
      if (!currentPlan || currentPlan.revision !== evaluation.metadata.planRevision) throw new TodoConflictError("Intent plan changed while its TODO was being evaluated")
      if (evaluation.schemaVersion !== 1) throw new Error("Evaluation schemaVersion must be 1")
      if (evaluation.taskId !== row.task_id) throw new Error("Evaluation task ID does not match the reviewed task")
      if (!["accept", "revise", "needs_evidence", "blocked"].includes(evaluation.decision)) throw new Error("Evaluation decision is not supported")
      const taskDefinition = rows<{ acceptance_json: string }>(database, "SELECT acceptance_json FROM todo_intent_tasks WHERE item_id = ? AND list_id = ? AND active = 1", [itemId, list.id])[0]
      const acceptanceCriteria = JSON.parse(taskDefinition.acceptance_json) as string[]
      if (evaluation.criteria.length !== acceptanceCriteria.length || evaluation.criteria.some((criterion, index) => criterion.criterion !== acceptanceCriteria[index])) {
        throw new Error("Evaluation criteria do not match the stored task acceptance criteria")
      }
      const observations = rows<{ id: string; tool_name: string; arguments_json: string; failed: number; exit_code: number | null }>(database,
        "SELECT id, tool_name, arguments_json, failed, exit_code FROM todo_tool_observations WHERE item_id = ?", [itemId])
      const evidenceIds = new Set(rows<{ id: string }>(database, "SELECT id FROM todo_evidence WHERE item_id = ?", [itemId]).map((entry) => entry.id))
      const observationIds = new Set(observations.map((observation) => observation.id))
      for (const [index, criterion] of evaluation.criteria.entries()) {
        if (!["passed", "failed", "unverified"].includes(criterion.status)) throw new Error(`Evaluation criteria[${index}].status is not supported`)
        for (const reference of criterion.evidenceRefs) {
          if (!observationIds.has(reference) && !evidenceIds.has(reference)) {
            throw new Error(`Evaluation criteria[${index}].evidenceRefs references unknown evidence ID ${reference}`)
          }
        }
      }
      if (evaluation.decision === "accept") {
        const byId = new Map(observations.map((observation) => [observation.id, observation]))
        const unsupported = evaluation.criteria.some((criterion) => {
          if (criterion.status !== "passed") return true
          const refs = criterion.evidenceRefs.filter((id) => byId.has(id))
          const trusted = observations.filter((observation) => byId.has(observation.id)).map((observation) => ({
            id: observation.id, itemId, toolName: observation.tool_name, arguments: JSON.parse(observation.arguments_json) as Record<string, string>, output: "",
            failed: observation.failed !== 0, exitCode: observation.exit_code ?? undefined, createdAt: ""
          }))
          const needsCommandEvidence = /\b(test|tests|assertions?|compile|compilation|build|type.?check|command|execute|run)\b/i.test(criterion.criterion)
          const evidenceFreeAnalysis = isAnalysisOnlyIntent(currentPlan.goal) && !needsCommandEvidence
          return criterion.status !== "passed" || (!hasTrustedEvidenceForCriterion(criterion.criterion, refs, trusted) && !evidenceFreeAnalysis)
        })
        if (unsupported) throw new Error("Evaluation cannot accept criteria without adequate trusted tool observations")
        const unfinishedDependency = rows<{ id: string }>(database,
          "SELECT prerequisite.id FROM todo_dependencies dependency JOIN todo_items prerequisite ON prerequisite.id = dependency.depends_on_item_id WHERE dependency.item_id = ? AND prerequisite.status != 'completed' LIMIT 1", [itemId])[0]
        if (unfinishedDependency) throw new Error("Cannot verify a task while its dependencies are incomplete")
      }
      const updatedAt = now()
      const status = evaluation.decision === "accept" ? "completed" : evaluation.decision === "revise" ? "in_progress" : evaluation.decision === "blocked" ? "blocked" : "in_review"
      const verification = evaluation.decision === "accept" ? "passed" : evaluation.decision === "revise" ? "failed" : "not_checked"
      const blockedReason = evaluation.decision === "blocked" ? evaluation.explanation : null
      database.run("INSERT INTO todo_evaluations(id, list_id, item_id, request_id, task_version, decision, evaluation_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [randomUUID(), list.id, itemId, requestId, expectedVersion, evaluation.decision, JSON.stringify(evaluation), updatedAt])
      database.run("UPDATE todo_items SET status = ?, verification = ?, blocked_reason = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?",
        [status, verification, blockedReason, updatedAt, itemId, expectedVersion])
      if (database.getRowsModified() !== 1) throw new TodoConflictError("TODO changed while applying its evaluation")
      bumpList(database, list.id, itemId, "evaluation_recorded", "system", requestId, { decision: evaluation.decision, evaluation })
      logTodoEvent("feedback.reconciled", { operation_id: list.id, item_id: itemId, decision: evaluation.decision, status, verification, request_id: requestId })
      if (status === "completed") logTodoEvent("todo.completed", { operation_id: list.id, item_id: itemId, verification, request_id: requestId })
      return evaluation
    })
  }

  getEvaluationHistory(request: TodoListRequest, itemId: string): Promise<TodoEvaluation[]> {
    return this.sqlite.read((database) => {
      const project = rows<ProjectRow>(database, "SELECT id, fingerprint FROM todo_projects WHERE fingerprint = ?", [request.projectFingerprint.trim()])[0]
      if (!project) return []
      const list = rows<ListRow>(database, "SELECT id, project_id, conversation_id, revision FROM todo_lists WHERE project_id = ? AND conversation_id = ?", [project.id, request.conversationId.trim()])[0]
      if (!list) return []
      const item = rows<{ id: string }>(database, "SELECT id FROM todo_items WHERE id = ? AND list_id = ?", [itemId, list.id])[0]
      if (!item) return []
      return rows<{ evaluation_json: string }>(database, "SELECT evaluation_json FROM todo_evaluations WHERE item_id = ? ORDER BY created_at", [itemId])
        .map((entry) => JSON.parse(entry.evaluation_json) as TodoEvaluation)
    })
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
        `SELECT items.id, items.list_id, items.parent_id, items.title, items.details, items.status, items.verification, items.priority,
                items.created_by, items.source, tasks.acceptance_json AS acceptance_criteria, items.sort_order, items.blocked_reason, items.version, items.created_at, items.updated_at
         FROM todo_items AS items LEFT JOIN todo_intent_tasks AS tasks ON tasks.item_id = items.id
         WHERE items.id = ? AND items.list_id = ?`,
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
      if (actor === "model") {
        const wanted = normalizeTodoIdentity(title)
        const existing = rows<ItemRow>(
          database,
          "SELECT * FROM todo_items WHERE list_id = ? AND status != 'cancelled' AND COALESCE(parent_id, '') = ? ORDER BY sort_order, created_at",
          [list.id, parentId ?? ""]
        ).find((row) => normalizeTodoIdentity(row.title) === wanted)
        if (existing) {
          const item = itemOf(existing)
          recordRequest(database, list.id, requestId, "create", item)
          logTodoEvent("todo.duplicate.reconciled", { operation_id: list.id, item_id: item.id, status: item.status, actor, request_id: requestId })
          return item
        }
      }
      const createdAt = now()
      const id = randomUUID()
      database.run(
        `INSERT INTO todo_items(id, list_id, parent_id, title, details, status, verification, priority, created_by, source, sort_order, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', 'not_checked', ?, ?, ?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM todo_items WHERE list_id = ?), 1, ?, ?)`,
        [id, list.id, parentId ?? null, title, input.details ?? null, priority, actor, actor, list.id, createdAt, createdAt]
      )
      bumpList(database, list.id, id, "item_created", actor, requestId, { title, parentId, priority })
      const item = itemOf(rows<ItemRow>(database, "SELECT * FROM todo_items WHERE id = ?", [id])[0])
      recordRequest(database, list.id, requestId, "create", item)
      logTodoEvent("todo.created", { operation_id: list.id, item_id: id, status: item.status, actor, request_id: requestId })
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
        if (input.actor !== "user") {
          status = "in_review"
        }
        else if (row.status === "completed") throw new Error("Reopen a completed TODO before updating it")
        else throw new Error("Use explicit user completion to approve a TODO")
      }
      if (status === "blocked" && (!blockedReason?.trim() || isPlaceholderBlockReason(blockedReason))) {
        throw new Error("A blocked TODO requires a specific reason describing the external condition that prevents progress")
      }
      if (status !== "blocked") blockedReason = null
      const verification = row.status === "completed" ? "not_checked" : row.verification
      const allowed = statusTransitions[row.status]
      if (status !== row.status && !allowed.has(status)) throw new Error(`Invalid TODO transition: ${row.status} -> ${status}`)

      const updatedAt = now()
      const unchangedState = title === row.title
        && (details ?? null) === (row.details ?? null)
        && status === row.status
        && priority === row.priority
        && sortOrder === row.sort_order
        && (blockedReason ?? null) === (row.blocked_reason ?? null)
        && verification === row.verification
      if (unchangedState) {
        const unchanged = itemOf(row)
        recordRequest(database, list.id, input.requestId, "update", unchanged)
        logTodoEvent("todo.update.noop", { operation_id: list.id, item_id: row.id, status: row.status, version: row.version, actor: input.actor, request_id: input.requestId })
        return unchanged
      }
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
      logTodoEvent("todo.updated", { operation_id: list.id, item_id: row.id, status: item.status, version: item.version, actor: input.actor, request_id: input.requestId })
      return item
    })
  }

  async completeByUser(request: TodoListRequest, itemId: string, expectedVersion: number, reason: string, requestId: string, approval: TrustedUserApproval): Promise<TodoItem> {
    validateRequestId(requestId)
    if (approval?.source !== "todo-panel") throw new Error("Only an explicit user action in the TODO panel can complete a TODO")
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
      logTodoEvent("todo.completed", { operation_id: list.id, item_id: itemId, verification: item.verification, actor: "user", request_id: requestId })
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
      database.run("UPDATE todo_items SET version = version + 1, updated_at = ? WHERE id = ? AND status = 'in_review'", [evidence.createdAt, input.itemId])
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
