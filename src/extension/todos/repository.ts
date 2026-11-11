import { createHash, randomUUID } from "node:crypto"
import { Database, SqlValue } from "sql.js"

import { logger } from "../../common/logger"

import {
  displayArguments,
  type EvidenceHit,
  type EvidenceSource,
  MAX_EVIDENCE_TEXT,
  preserveEvidence,
  redactEvidence
} from "./evidence"
import { validateIntentTaskPlan } from "./intent-plan"
import { SqliteFile, type SqliteLocation } from "./sqlite"
import {
  type AcceptedFact,
  type AcceptedFactUsage,
  type AddTodoEvidenceInput,
  type AnswerRequirement,
  type ChildTodoContext,
  type ChildTodoDecision,
  type ChildTodoDecisionKind,
  type ChildTodoOutcome,
  type ChildTodoProposal,
  type CreateTodoInput,
  type EditOperationInput,
  type EditOperationRecord,
  type EditOperationStatus,
  type EvidenceUseKind,
  type IntentPlanContext,
  type IntentPlanOutline,
  type IntentPlanOutlineChild,
  type IntentTaskPlan,
  type RequirementActivation,
  type RetainedObservationEvidence,
  type SymbolAlias,
  type TodoCompletionClaim,
  TodoConflictError,
  type TodoCreateOutcome,
  type TodoEvaluation,
  type TodoEvaluationDecision,
  type TodoEvidence,
  type TodoItem,
  type TodoListRequest,
  type TodoListSnapshot,
  type TodoPriority,
  type TodoReviewPackage,
  type TodoSource,
  type TodoStatus,
  type TodoToolEvidenceStatus,
  type TodoToolObservation,
  type TodoToolObservationInput,
  type TodoVerification,
  type TodoWriteRequest,
  type TypedCriterion,
  type UnresolvedEditOperation,
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
  criteria_json?: string | null
  sort_order: number
  blocked_reason: string | null
  version: number
  created_at: string
  updated_at: string
}

const now = () => new Date().toISOString()

/** Content digest for an edit's precondition or postcondition. Only digests are persisted, never file text. */
export const editDigest = (text: string): string => createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex")
/** Canonical JSON of a task's typed criteria, the only stored acceptance representation. */
const criteriaJson = (criteria: TypedCriterion[]): string => JSON.stringify(criteria)
const storedCriteria = (json: string | null | undefined): TypedCriterion[] | undefined => json ? JSON.parse(json) as TypedCriterion[] : undefined
/** Typed criteria of an active plan task. Active tasks always carry them, so a missing value is corrupt storage. */
const requiredCriteria = (json: string | null | undefined): TypedCriterion[] => {
  const criteria = storedCriteria(json)
  if (!criteria) throw new Error("Active TODO plan task has no typed criteria")
  return criteria
}
/** Display text of typed criteria, derived for projections that need strings. */
const displayOf = (criteria: TypedCriterion[]): string[] => criteria.map((criterion) => criterion.description)
type TodoLogField = string | number | boolean | null
const logTodoEvent = (event: string, fields: Record<string, TodoLogField>, level: "info" | "debug" = "info") => {
  const line = "[Todo] " + event + " " + JSON.stringify(fields)
  if (level === "debug") logger.debug(line)
  else logger.info(line)
}
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
  criteria: storedCriteria(row.criteria_json),
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

/** Raised when a conversation other than the list's own tries to change that list. Reads are never restricted. */
export class TodoWriteDeniedError extends Error {
  constructor(conversationId: string) {
    super(`Conversation ${conversationId.trim()} cannot change another conversation's TODO list`)
    this.name = "TodoWriteDeniedError"
  }
}

const assertWriter = (request: TodoWriteRequest): void => {
  if (request.writer.trim() !== request.conversationId.trim()) throw new TodoWriteDeniedError(request.conversationId)
}

const findList = (database: Database, request: TodoListRequest): ListRow | undefined => {
  const project = rows<ProjectRow>(database, "SELECT id, fingerprint FROM todo_projects WHERE fingerprint = ?", [request.projectFingerprint.trim()])[0]
  if (!project) return undefined
  return rows<ListRow>(database, "SELECT id, project_id, conversation_id, revision FROM todo_lists WHERE project_id = ? AND conversation_id = ?", [project.id, request.conversationId.trim()])[0]
}

interface PlanTaskLink {
  taskId: string
  criteria: TypedCriterion[]
  dependencies: string[]
}

interface PlanMembership {
  /** Active, non-cancelled TODO items in the list. */
  items: Map<string, ItemRow>
  /** Each plan member mapped to the plan task at or above it. Walks are cycle-guarded. */
  planTaskOf: Map<string, string>
  /** Plan task links keyed by TODO item ID. */
  tasks: Map<string, PlanTaskLink>
}

/**
 * Names an item that this list's plan superseded, for a lookup that only accepts active tasks. Returns undefined for
 * any other item, so other conversations' items and unknown IDs keep the caller's generic message.
 */
const supersededItemMessage = (database: Database, listId: string, itemId: string): string | undefined =>
  rows<{ item_id: string }>(database, "SELECT item_id FROM todo_intent_tasks WHERE list_id = ? AND item_id = ? AND active = 0", [listId, itemId])[0]
    ? "TODO item belongs to a superseded plan revision and is no longer part of the active plan"
    : undefined

const planMembership = (database: Database, listId: string): PlanMembership => {
  const items = new Map<string, ItemRow>(
    rows<ItemRow>(database, "SELECT * FROM todo_items WHERE list_id = ? AND status != 'cancelled' ORDER BY sort_order, created_at", [listId])
      .map((row): [string, ItemRow] => [row.id, row])
  )
  const tasks = new Map<string, PlanTaskLink>(
    rows<{ item_id: string; task_id: string; criteria_json: string | null; dependencies_json: string }>(
      database,
      "SELECT item_id, task_id, criteria_json, dependencies_json FROM todo_intent_tasks WHERE list_id = ? AND active = 1",
      [listId]
    )
      .filter((task) => items.has(task.item_id))
      .map((task): [string, PlanTaskLink] => [task.item_id, {
        taskId: task.task_id,
        criteria: requiredCriteria(task.criteria_json),
        dependencies: JSON.parse(task.dependencies_json) as string[]
      }])
  )
  const planTaskOf = new Map<string, string>()
  for (const id of items.keys()) {
    const seen = new Set<string>()
    let current: string | null = id
    while (current && items.has(current) && !seen.has(current)) {
      if (tasks.has(current)) {
        planTaskOf.set(id, current)
        break
      }
      seen.add(current)
      current = items.get(current)!.parent_id
    }
  }
  return { items, planTaskOf, tasks }
}

/** Returns the plan task that anchors the parent, or throws when the parent cannot take a child. */
const anchorForParent = (membership: PlanMembership, parentId: string): string => {
  if (!membership.items.has(parentId)) throw new Error("todo_parent_id must name an active TODO in this conversation's plan")
  const anchor = membership.planTaskOf.get(parentId)
  if (!anchor) throw new Error("The parent TODO is not part of the authoritative plan")
  return anchor
}

const childFingerprint = (proposal: Pick<ChildTodoProposal, "parentId" | "title" | "details">): string =>
  createHash("sha256")
    .update(JSON.stringify([proposal.parentId, normalizeTodoTitle(proposal.title), (proposal.details ?? "").replace(/\s+/g, " ").trim().toLowerCase()]))
    .digest("hex")

const insertItem = (
  database: Database,
  listId: string,
  input: { parentId?: string; title: string; details?: string; priority: TodoPriority; actor: "user" | "model"; requestId: string }
): string => {
  const createdAt = now()
  const id = randomUUID()
  database.run(
    `INSERT INTO todo_items(id, list_id, parent_id, title, details, status, verification, priority, created_by, source, sort_order, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'pending', 'not_checked', ?, ?, ?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM todo_items WHERE list_id = ?), 1, ?, ?)`,
    [id, listId, input.parentId ?? null, input.title, input.details ?? null, input.priority, input.actor, input.actor, listId, createdAt, createdAt]
  )
  bumpList(database, listId, id, "item_created", input.actor, input.requestId, { title: input.title, parentId: input.parentId, priority: input.priority })
  return id
}

const liveChildOutcome = (database: Database, listId: string, outcome: ChildTodoOutcome): ChildTodoOutcome | undefined => {
  if (!outcome.itemId) return outcome
  const [item] = rows<{ status: TodoStatus }>(database, "SELECT status FROM todo_items WHERE id = ? AND list_id = ?", [outcome.itemId, listId])
  return item && item.status !== "cancelled" ? outcome : undefined
}

const recordedChildOutcome = (database: Database, listId: string, proposal: ChildTodoProposal): ChildTodoOutcome | undefined => {
  const [prior] = rows<{ fingerprint: string; result_json: string }>(
    database,
    "SELECT fingerprint, result_json FROM todo_child_proposals WHERE list_id = ? AND request_id = ?",
    [listId, proposal.requestId]
  )
  if (!prior) return undefined
  if (prior.fingerprint !== childFingerprint(proposal)) throw new TodoConflictError("This request ID was already used for a different child TODO proposal")
  return JSON.parse(prior.result_json) as ChildTodoOutcome
}

const childContext = (membership: PlanMembership, plan: { plan_id: string; revision: number; goal: string }, parentId: string): ChildTodoContext => {
  const parent = membership.items.get(parentId)!
  const ownLink = membership.tasks.get(parentId)
  const titleByTaskId = new Map([...membership.tasks].map(([itemId, link]) => [link.taskId, membership.items.get(itemId)!.title]))
  return {
    planId: plan.plan_id,
    revision: plan.revision,
    goal: plan.goal,
    parent: {
      id: parent.id,
      title: parent.title,
      details: parent.details ?? undefined,
      status: parent.status,
      acceptance: displayOf(ownLink?.criteria ?? []),
      dependsOn: (ownLink?.dependencies ?? []).flatMap((taskId) => titleByTaskId.get(taskId) ?? [])
    },
    children: [...membership.items.values()]
      .filter((item) => item.parent_id === parentId && membership.planTaskOf.has(item.id))
      .map((item) => ({ itemId: item.id, parentItemId: parentId, title: item.title, status: item.status })),
    planItems: [...membership.tasks.keys()].map((itemId) => {
      const item = membership.items.get(itemId)!
      return { id: item.id, title: item.title, status: item.status }
    })
  }
}

const unresolvedEditTarget = (database: Database, projectId: string, target: string): { id: string; conversationId: string | null } | undefined =>
  rows<{ id: string; conversationId: string | null }>(database,
    "SELECT e.id AS id, l.conversation_id AS conversationId FROM todo_edit_operations e JOIN todo_lists l ON l.id = e.list_id WHERE l.project_id = ? AND e.target = ? AND e.status IN ('dispatched','diverged') LIMIT 1", [projectId, target])[0]

type EditOperationRow = { id: string; itemId: string | null; ownerId: string | null; target: string; mode: "apply" | "review"; preDigest: string; postDigest: string; status: EditOperationStatus; detail: string; createdAt: number; updatedAt: number }

const toEditOperationRecord = (row: EditOperationRow): EditOperationRecord => ({
  id: row.id,
  itemId: row.itemId ?? undefined,
  ownerId: row.ownerId ?? undefined,
  target: row.target,
  mode: row.mode,
  preDigest: row.preDigest,
  postDigest: row.postDigest,
  status: row.status,
  detail: row.detail,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt
})

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
            items.created_by, items.source, tasks.criteria_json, items.sort_order, items.blocked_reason,
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

const OVERLAP_STOP_WORDS = new Set(["a", "an", "and", "for", "from", "in", "of", "on", "the", "to", "with"])
const titleTokens = (title: string) => new Set(normalizeTodoTitle(title).split(/[^a-z0-9]+/).filter((token) => token && !OVERLAP_STOP_WORDS.has(token)))

/**
 * Matches a model-proposed title to a single authoritative plan task when at
 * least three meaningful words are shared and cover most of the smaller title.
 * Ties and weak overlaps return undefined so distinct work is never merged.
 */
const planOverlapMatch = (candidates: ItemRow[], title: string): ItemRow | undefined => {
  const wanted = titleTokens(title)
  if (wanted.size < 3) return undefined
  const scored = candidates.map((row) => {
    const tokens = titleTokens(row.title)
    const shared = [...wanted].filter((token) => tokens.has(token)).length
    return { row, shared, ratio: shared / Math.min(wanted.size, tokens.size) }
  }).filter((entry) => entry.shared >= 3 && entry.ratio >= 0.75)
    .sort((left, right) => right.shared - left.shared || right.ratio - left.ratio)
  if (!scored.length) return undefined
  const [best, next] = scored
  if (next && next.shared === best.shared && next.ratio === best.ratio) return undefined
  return best.row
}

/**
 * Matches a broad umbrella title that restates several plan tasks at once:
 * most of its meaningful words must appear across at least two distinct plan
 * tasks. The best-matching plan task is returned as the existing record.
 */
const planUmbrellaMatch = (candidates: ItemRow[], title: string): ItemRow | undefined => {
  const wanted = titleTokens(title)
  if (wanted.size < 3) return undefined
  const scored = candidates.map((row) => {
    const tokens = titleTokens(row.title)
    const shared = [...wanted].filter((token) => tokens.has(token)).length
    return { row, shared }
  }).filter((entry) => entry.shared >= 1)
  if (scored.length < 2) return undefined
  const covered = new Set<string>()
  for (const { row } of scored) for (const token of titleTokens(row.title)) if (wanted.has(token)) covered.add(token)
  if (covered.size / wanted.size < 0.75) return undefined
  return scored.sort((left, right) => right.shared - left.shared)[0].row
}

const latestItemEvent = (database: Database, listId: string, itemId: string, eventType: string) =>
  rows<{ list_revision: number; payload_json: string }>(database,
    "SELECT list_revision, payload_json FROM todo_events WHERE list_id = ? AND item_id = ? AND event_type = ? ORDER BY list_revision DESC LIMIT 1",
    [listId, itemId, eventType])[0]

const reviewPathFor = (database: Database, listId: string, itemId: string): TodoCompletionClaim["review"] =>
  rows<{ task_id: string }>(database, "SELECT task_id FROM todo_intent_tasks WHERE item_id = ? AND list_id = ? AND active = 1", [itemId, listId])[0]
    ? "feedback_turn_end"
    : "user_approval"

const PLACEHOLDER_BLOCK_REASONS = new Set(["no reason", "none", "n/a", "na", "tbd", "todo", "unknown", "blocked", "-"])
const isPlaceholderBlockReason = (reason: string) => {
  const normalized = normalizeTodoTitle(reason).replace(/[.!?]+$/, "")
  return normalized.length < 8 || PLACEHOLDER_BLOCK_REASONS.has(normalized)
}

const validateRequestId = (requestId: string) => {
  if (!requestId.trim() || requestId.length > 200) throw new Error("A request ID between 1 and 200 characters is required")
}

/** Per-list storage for retained tool output; beyond the limit the oldest retained output is evicted. */
export interface EvidenceStorageLimits {
  listChars: number
}

export const DEFAULT_EVIDENCE_STORAGE_LIMITS: EvidenceStorageLimits = { listChars: 2_000_000 }

/**
 * Retained observations for a review. With `sharedListId`, observations from
 * every active plan task in that list are included, so one retained read can
 * support several related criteria. Each keeps its own item provenance.
 */
interface AcceptedFactRow {
  id: string
  conversation_id: string
  item_id: string
  criterion_index: number
  criterion: string
  observation_id: string
  tool_name: string
  symbol: string
  path: string
  start_line: number
  end_line: number
  source_hash: string
  superseded_by: string | null
  plan_id: string
  plan_revision: number
  registered_tool: string | null
  created_at: string
}

const ACCEPTED_FACT_COLUMNS = "evidence.id, lists.conversation_id, evidence.item_id, evidence.criterion_index, evidence.criterion, evidence.observation_id, evidence.tool_name, evidence.symbol, evidence.path, evidence.start_line, evidence.end_line, evidence.source_hash, evidence.superseded_by, evidence.plan_id, evidence.plan_revision, evidence.registered_tool, evidence.created_at"

/**
 * Accepted facts for a project, across all its conversations. "Current" is decided per
 * symbol and path on read: the newest current fact wins, and older ones report it as
 * `supersededBy`. Rows are never rewritten here, so another conversation's record stays intact.
 */
/**
 * Project facts, newest first. Supersession is decided over the whole project before any
 * symbol or path filter, so a filtered query never revives a fact that a newer one replaced.
 * A symbol matches the fact's own symbol or its verified implementation name.
 */
const acceptedFactsFor = (database: Database, projectId: string, options: { symbol?: string; path?: string; includeSuperseded?: boolean } = {}): AcceptedFact[] => {
  const facts = rows<AcceptedFactRow>(database,
    `SELECT ${ACCEPTED_FACT_COLUMNS} FROM todo_accepted_evidence AS evidence JOIN todo_lists AS lists ON lists.id = evidence.list_id ` +
    "WHERE lists.project_id = ? ORDER BY evidence.created_at DESC, evidence.id",
    [projectId]
  ).map((row) => ({
    id: row.id,
    conversationId: row.conversation_id,
    itemId: row.item_id,
    criterionIndex: row.criterion_index,
    criterion: row.criterion,
    toolName: row.tool_name,
    planId: row.plan_id,
    planRevision: row.plan_revision,
    symbol: row.symbol,
    registeredTool: row.registered_tool ?? undefined,
    path: row.path,
    startLine: row.start_line,
    endLine: row.end_line,
    observationId: row.observation_id,
    sourceHash: row.source_hash,
    supersededBy: row.superseded_by ?? undefined,
    acceptedAt: row.created_at
  }))
  const newest = new Map<string, string>()
  for (const fact of facts) {
    const key = JSON.stringify([fact.symbol, fact.path])
    if (fact.supersededBy) continue
    const current = newest.get(key)
    if (current) fact.supersededBy = current
    else newest.set(key, fact.id)
  }
  const matches = facts.filter((fact) =>
    (options.symbol === undefined || fact.symbol === options.symbol || fact.registeredTool === options.symbol)
    && (options.path === undefined || fact.path === options.path))
  return options.includeSuperseded ? matches : matches.filter((fact) => !fact.supersededBy)
}

/**
 * Tool-name to implementation links verified from source, across all conversations of a project.
 * Each link is an accepted evidence row that names a registered tool, so it shares that row's provenance and fingerprint.
 */
const symbolAliasesFor = (database: Database, projectId: string): SymbolAlias[] =>
  rows<{ id: string; conversation_id: string; tool_name: string; implementation: string; path: string; start_line: number; end_line: number; observation_id: string; source_hash: string; created_at: string }>(database,
    "SELECT evidence.id, lists.conversation_id, evidence.registered_tool AS tool_name, evidence.symbol AS implementation, evidence.path, evidence.start_line, evidence.end_line, evidence.observation_id, evidence.source_hash, evidence.created_at " +
    "FROM todo_accepted_evidence AS evidence JOIN todo_lists AS lists ON lists.id = evidence.list_id " +
    "WHERE lists.project_id = ? AND evidence.registered_tool IS NOT NULL ORDER BY evidence.created_at DESC, evidence.id",
    [projectId]
  ).map((row) => ({
    id: row.id,
    conversationId: row.conversation_id,
    toolName: row.tool_name,
    implementation: row.implementation,
    path: row.path,
    startLine: row.start_line,
    endLine: row.end_line,
    observationId: row.observation_id,
    sourceHash: row.source_hash,
    createdAt: row.created_at
  }))

/**
 * Stores host-verified source facts from an accepted evaluation, in the reviewed conversation's list only.
 * A new fact supersedes earlier facts for the same symbol and path in that list. Project-wide currency is resolved on read.
 */
const recordAcceptedFacts = (
    database: Database,
    listId: string,
    plan: { plan_id: string; revision: number },
    itemId: string,
    evaluation: TodoEvaluation,
    observations: Map<string, { tool_name: string; failed: number }>,
    acceptedAt: string
): void => {
    function refuse(index: number, reason: string): never {
      logger.debug(`[Evidence] fact not promoted task=${itemId} criterion=${index} reason=${reason}`)
      throw new Error(`criteria[${index}] ${reason}`)
    }
    const candidates = evaluation.criteria.flatMap((criterion, index) =>
      criterion.status === "passed" ? (criterion.reconciliation?.facts ?? []).map((fact) => ({ index, criterion, fact })) : [])
    for (const { index, criterion, fact } of candidates) {
    const observation = observations.get(fact.observationId)
    if (!observation || observation.failed !== 0) refuse(index, "fact references an unusable observation")
    if (!fact.symbol.trim() || !fact.path.trim() || !fact.sourceHash.trim()) refuse(index, "fact is missing its symbol, path, or fingerprint")
    if (!Number.isInteger(fact.startLine) || !Number.isInteger(fact.endLine) || fact.startLine < 1 || fact.endLine < fact.startLine) {
      refuse(index, "fact has an invalid line range")
    }
    if (fact.registeredTool !== undefined && !fact.registeredTool.trim()) refuse(index, "registered tool name is empty")
    const id = randomUUID()
    database.run(
      "INSERT INTO todo_accepted_evidence(id, list_id, plan_id, plan_revision, item_id, criterion_index, criterion, observation_id, tool_name, symbol, path, start_line, end_line, source_hash, superseded_by, registered_tool, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)",
      [id, listId, plan.plan_id, plan.revision, itemId, index, criterion.criterion, fact.observationId, observation.tool_name, fact.symbol, fact.path, fact.startLine, fact.endLine, fact.sourceHash, fact.registeredTool ?? null, acceptedAt]
    )
    database.run(
      "UPDATE todo_accepted_evidence SET superseded_by = ? WHERE list_id = ? AND symbol = ? AND path = ? AND superseded_by IS NULL AND id <> ?",
      [id, listId, fact.symbol, fact.path, id]
    )
    logger.debug(`[Evidence] promoted task=${itemId} criterion=${index} symbol=${fact.symbol} path=${fact.path} lines=${fact.startLine}-${fact.endLine} observation=${fact.observationId}`)
  }

}

/** A stored plan is closed when every task it still has is finished; its history stays, and new work may replace it. */
const intentPlanClosed = (database: Database, listId: string): boolean =>
  rows<{ open_tasks: number }>(database,
    `SELECT COUNT(*) AS open_tasks FROM todo_intent_tasks AS tasks JOIN todo_items AS items ON items.id = tasks.item_id
     WHERE tasks.list_id = ? AND tasks.active = 1 AND items.status NOT IN ('completed', 'cancelled')`, [listId])[0].open_tasks === 0

const latestActivation = (database: Database, listId: string, itemId: string): RequirementActivation | undefined => {
  const row = rows<{ id: string; item_id: string; kind: RequirementActivation["kind"]; list_revision: number; activated_at: number }>(database,
    "SELECT id, item_id, kind, list_revision, activated_at FROM todo_requirement_activations WHERE list_id = ? AND item_id = ? ORDER BY list_revision DESC LIMIT 1", [listId, itemId])[0]
  return row ? { id: row.id, itemId: row.item_id, kind: row.kind, listRevision: row.list_revision, activatedAt: row.activated_at } : undefined
}

const retainedEvidenceFor = (database: Database, itemId: string, withContent: boolean, sharedListId?: string): RetainedObservationEvidence[] =>
  rows<{ observation_id: string; observed_item_id: string; tool_name: string; arguments_json: string; failed: number; exit_code: number | null; observed_at: string; list_revision: number | null; retained: number | null; content: string | null; complete: number | null; original_chars: number | null; preserved_chars: number | null; metadata_json: string | null }>(database,
    "SELECT observations.id AS observation_id, observations.item_id AS observed_item_id, observations.tool_name, observations.arguments_json, observations.failed, observations.exit_code, observations.created_at AS observed_at, observations.list_revision, evidence.retained, " +
    (withContent ? "evidence.content" : "NULL AS content") +
    ", evidence.complete, evidence.original_chars, evidence.preserved_chars, evidence.metadata_json " +
    "FROM todo_tool_observations AS observations LEFT JOIN todo_tool_evidence AS evidence ON evidence.observation_id = observations.id " +
    (sharedListId
      ? "WHERE observations.list_id = ? AND observations.item_id IN (SELECT item_id FROM todo_intent_tasks WHERE list_id = ? AND active = 1) "
      : "WHERE observations.item_id = ? ") +
    "ORDER BY observations.list_revision, observations.created_at, observations.rowid", sharedListId ? [sharedListId, sharedListId] : [itemId]).map((row) => {
      const metadata = row.metadata_json
        ? JSON.parse(row.metadata_json) as { sources: EvidenceSource[]; hits: EvidenceHit[] }
        : { sources: [], hits: [] }
      return {
        observationId: row.observation_id,
        itemId: row.observed_item_id,
        toolName: row.tool_name,
        arguments: JSON.parse(row.arguments_json) as Record<string, string>,
        failed: row.failed !== 0,
        ...(row.exit_code === null || row.exit_code === undefined ? {} : { exitCode: row.exit_code }),
        observedAt: row.observed_at,
        retained: row.retained === 1,
        complete: row.complete === 1,
        originalChars: row.original_chars ?? 0,
        preservedChars: row.preserved_chars ?? 0,
        ...(row.list_revision === null ? {} : { listRevision: row.list_revision }),
        content: withContent && row.retained === 1 ? row.content ?? undefined : undefined,
        sources: metadata.sources,
        hits: metadata.hits
      }
    })

const evidenceStatus = (entry: RetainedObservationEvidence | undefined): TodoToolEvidenceStatus => ({
  retained: entry?.retained ?? false,
  complete: entry?.complete ?? false,
  originalChars: entry?.originalChars ?? 0,
  preservedChars: entry?.preservedChars ?? 0
})

const enforceEvidenceBudget = (database: Database, listId: string, keepId: string, limitChars: number) => {
  let excess = (rows<{ total: number }>(database,
    "SELECT COALESCE(SUM(preserved_chars), 0) AS total FROM todo_tool_evidence WHERE list_id = ? AND retained = 1", [listId])[0]?.total ?? 0) - limitChars
  if (excess <= 0) return
  const candidates = rows<{ observation_id: string; preserved_chars: number }>(database,
    "SELECT observation_id, preserved_chars FROM todo_tool_evidence WHERE list_id = ? AND retained = 1 AND observation_id != ? ORDER BY created_at, observation_id", [listId, keepId])
  for (const candidate of candidates) {
    if (excess <= 0) break
    database.run("UPDATE todo_tool_evidence SET retained = 0, content = NULL WHERE observation_id = ?", [candidate.observation_id])
    excess -= candidate.preserved_chars
  }
}

export class TodoRepository {
  private readonly sqlite: SqliteFile
  private readonly evidenceLimits: EvidenceStorageLimits

  constructor(databasePath: SqliteLocation, wasmPath: string, evidenceLimits: EvidenceStorageLimits = DEFAULT_EVIDENCE_STORAGE_LIMITS) {
    this.sqlite = new SqliteFile(databasePath, wasmPath)
    this.evidenceLimits = evidenceLimits
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
      const tasks = rows<{ task_id: string; title: string; details: string; dependencies_json: string; criteria_json: string }>(
        database,
        `SELECT tasks.task_id, items.title, items.details, tasks.dependencies_json, tasks.criteria_json
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
          criteria: requiredCriteria(task.criteria_json),
          dependencies: JSON.parse(task.dependencies_json) as string[]
        }))
      }
    })
  }

  intentPlanClosed(request: TodoListRequest): Promise<boolean> {
    return this.sqlite.read((database) => {
      const list = findList(database, request)
      return list ? intentPlanClosed(database, list.id) : false
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

  synchronizeIntentPlan(request: TodoWriteRequest, candidate: unknown, intentResult: unknown): Promise<TodoListSnapshot> {
    assertWriter(request)
    const validation = validateIntentTaskPlan(candidate)
    if (!validation.plan) throw new Error("Invalid intent plan: " + validation.diagnostic)
    const plan = validation.plan
    const resultJson = JSON.stringify(intentResult)
    if (!resultJson || resultJson.length > 100_000) throw new Error("Intent result must be serializable and no larger than 100,000 characters")
    const answerJson = JSON.stringify(plan.answer ?? [])

    return this.sqlite.write((database) => {
      const list = ensureList(database, request)
      const existing = rows<{
        plan_id: string; revision: number; goal: string; constraints_json: string; intent_result_json: string; answer_json: string
      }>(database, "SELECT plan_id, revision, goal, constraints_json, intent_result_json, answer_json FROM todo_intent_plans WHERE list_id = ?", [list.id])[0]
      // A closed plan is finished work: new work replaces it under a new planId, and its items and history stay.
      const replacing = !!existing && intentPlanClosed(database, list.id)
      if (existing && !replacing) {
        if (existing.plan_id !== plan.planId) throw new TodoConflictError("Intent plan ID changed for this conversation; preserve the existing planId when revising it")
        if (plan.revision < existing.revision) throw new TodoConflictError("Intent plan revision is older than the stored revision")
      }
      if (replacing && plan.revision <= existing.revision) {
        throw new TodoConflictError(`A plan replacing a completed plan needs a revision above ${existing.revision}`)
      }

      const priorTasks = rows<{
        task_id: string; item_id: string; dependencies_json: string; criteria_json: string | null; active: number
        title: string; details: string | null; sort_order: number
      }>(database,
        `SELECT tasks.task_id, tasks.item_id, tasks.dependencies_json, tasks.criteria_json, tasks.active,
                items.title, items.details, items.sort_order
         FROM todo_intent_tasks AS tasks JOIN todo_items AS items ON items.id = tasks.item_id
         WHERE tasks.list_id = ?`, [list.id])
      // Task identities of a replaced plan belong to finished items, so the new plan's tasks start new items.
      const priorById = new Map(priorTasks.filter(() => !replacing).map((task) => [task.task_id, task]))
      const unchanged = !!existing && !replacing && plan.revision === existing.revision
      if (unchanged) {
        if (existing.goal !== plan.goal || existing.constraints_json !== JSON.stringify(plan.constraints) || existing.answer_json !== answerJson) {
          throw new TodoConflictError("Intent plan definitions changed without increasing plan.revision")
        }
        if (priorTasks.filter((task) => task.active).length !== plan.tasks.length || plan.tasks.some((task) => {
          const prior = priorById.get(task.id)
          return !prior || !prior.active || prior.title !== task.title || prior.details !== task.description ||
            prior.dependencies_json !== JSON.stringify(task.dependencies) || prior.criteria_json !== criteriaJson(task.criteria)
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
          `INSERT INTO todo_intent_tasks(list_id, task_id, item_id, dependencies_json, criteria_json, active)
           VALUES (?, ?, ?, ?, ?, 1)
           ON CONFLICT(list_id, task_id) DO UPDATE SET item_id = excluded.item_id,
             dependencies_json = excluded.dependencies_json, criteria_json = excluded.criteria_json, active = 1`,
          [list.id, task.id, itemId, JSON.stringify(task.dependencies), criteriaJson(task.criteria)]
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
          "UPDATE todo_intent_plans SET plan_id = ?, revision = ?, goal = ?, constraints_json = ?, intent_result_json = ?, answer_json = ?, updated_at = ? WHERE list_id = ?",
          [plan.planId, plan.revision, plan.goal, JSON.stringify(plan.constraints), resultJson, answerJson, createdAt, list.id]
        )
      } else {
        database.run(
          "INSERT INTO todo_intent_plans(list_id, plan_id, revision, goal, constraints_json, intent_result_json, answer_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [list.id, plan.planId, plan.revision, plan.goal, JSON.stringify(plan.constraints), resultJson, answerJson, createdAt]
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
      const plan = rows<{ plan_id: string; revision: number; goal: string; constraints_json: string; answer_json: string }>(
        database, "SELECT plan_id, revision, goal, constraints_json, answer_json FROM todo_intent_plans WHERE list_id = ?", [list.id]
      )[0]
      if (!plan) return undefined
      const tasks = rows<ItemRow & { task_id: string; dependencies_json: string; criteria_json: string | null }>(
        database,
        `SELECT items.id, items.list_id, items.parent_id, items.title, items.details, items.status, items.verification,
                items.priority, items.created_by, items.source, items.sort_order, items.blocked_reason, items.version,
                items.created_at, items.updated_at, tasks.task_id, tasks.dependencies_json, tasks.criteria_json
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
      const retainedEvidence = retainedEvidenceFor(database, current.id, false, list.id)
      const observations = rows<{ id: string; itemId: string; toolName: string; arguments_json: string; output: string; failed: number; exitCode: number | null; createdAt: string; executionId: string | null }>(database,
        "SELECT id, item_id AS itemId, tool_name AS toolName, arguments_json, output, failed, exit_code AS exitCode, created_at AS createdAt, execution_id AS executionId FROM todo_tool_observations WHERE item_id = ? ORDER BY created_at DESC, rowid DESC", [current.id]
      ).map((observation) => ({
        id: observation.id, itemId: observation.itemId, toolName: observation.toolName,
        arguments: JSON.parse(observation.arguments_json) as Record<string, string>, output: observation.output,
        failed: observation.failed !== 0, exitCode: observation.exitCode ?? undefined, createdAt: observation.createdAt,
        executionId: observation.executionId ?? undefined,
        evidence: evidenceStatus(retainedEvidence.find((entry) => entry.observationId === observation.id))
      }))
      const lastEvaluation = rows<{ evaluation_json: string }>(database,
        "SELECT evaluation_json FROM todo_evaluations WHERE item_id = ? ORDER BY created_at DESC LIMIT 1", [current.id])[0]
      return {
        planId: plan.plan_id,
        revision: plan.revision,
        goal: plan.goal,
        constraints: JSON.parse(plan.constraints_json) as string[],
        answer: JSON.parse(plan.answer_json) as AnswerRequirement[],
        task: itemOf(current),
        planTaskId: current.task_id,
        criteria: requiredCriteria(current.criteria_json),
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
      const tasks = rows<{ task_id: string; id: string; title: string; status: TodoStatus; verification: TodoVerification; version: number; blocked_reason: string | null; dependencies_json: string }>(
        database,
        `SELECT tasks.task_id, items.id, items.title, items.status, items.verification, items.version, items.blocked_reason, tasks.dependencies_json
         FROM todo_intent_tasks AS tasks JOIN todo_items AS items ON items.id = tasks.item_id
         WHERE tasks.list_id = ? AND tasks.active = 1 ORDER BY items.sort_order, items.created_at`, [list.id]
      )
      const byTaskId = new Map(tasks.map((task) => [task.task_id, task]))
      const membership = planMembership(database, list.id)
      return {
        planId: plan.plan_id,
        revision: plan.revision,
        goal: plan.goal,
        tasks: tasks.map((task) => {
          const latest = rows<{ evaluation_json: string }>(database,
            "SELECT evaluation_json FROM todo_evaluations WHERE item_id = ? ORDER BY created_at DESC LIMIT 1", [task.id])[0]
          const evaluation = latest ? JSON.parse(latest.evaluation_json) as TodoEvaluation : undefined
          const dependencies = JSON.parse(task.dependencies_json) as string[]
          return {
            taskId: task.task_id,
            itemId: task.id,
            title: task.title,
            status: task.status,
            verification: task.verification,
            version: task.version,
            blockedReason: task.blocked_reason ?? undefined,
            unmetCriteria: evaluation?.criteria.filter((criterion) => criterion.status !== "passed").map((criterion) => criterion.criterion) ?? [],
            problems: evaluation?.problems ?? [],
            awaitingDependencies: dependencies
              .map((id) => byTaskId.get(id))
              .filter((dependency) => dependency !== undefined && dependency.status !== "completed")
              .map((dependency) => dependency!.title)
          }
        }),
        children: [...membership.items.values()]
          .filter((item) => item.parent_id && !membership.tasks.has(item.id) && membership.planTaskOf.has(item.id))
          .map((item): IntentPlanOutlineChild => ({ itemId: item.id, parentItemId: item.parent_id!, title: item.title, status: item.status }))
      }
    })
  }

  /**
   * Failed tool operations recorded against the active plan's tasks in this conversation, oldest first. Observations of
   * tasks a later plan revision or replacement dropped stay in storage but are not part of the current plan's report.
   */
  /** Failed operations of one execution only. Failures recorded by other executions remain stored but are not reported here. */
  failedToolOperations(request: TodoListRequest, executionId: string): Promise<string[]> {
    return this.sqlite.read((database) => {
      const project = rows<ProjectRow>(database, "SELECT id, fingerprint FROM todo_projects WHERE fingerprint = ?", [request.projectFingerprint.trim()])[0]
      if (!project) return []
      const list = rows<ListRow>(database, "SELECT id, project_id, conversation_id, revision FROM todo_lists WHERE project_id = ? AND conversation_id = ?", [project.id, request.conversationId.trim()])[0]
      if (!list) return []
      return rows<{ tool_name: string; arguments_json: string; exit_code: number | null; output: string }>(database,
        `SELECT tool_name, arguments_json, exit_code, output FROM todo_tool_observations
         WHERE list_id = ? AND failed = 1 AND execution_id = ? AND item_id IN (SELECT item_id FROM todo_intent_tasks WHERE list_id = ? AND active = 1)
         ORDER BY created_at ASC`, [list.id, executionId, list.id]
      ).map((row) => {
        const args = displayArguments(JSON.parse(row.arguments_json) as Record<string, unknown>)
        const target = typeof args.path === "string" ? args.path : JSON.stringify(args).slice(0, 160)
        const exit = row.exit_code === null ? "" : ` (exit ${row.exit_code})`
        return `${row.tool_name} ${target}${exit}: ${row.output.replace(/\s+/g, " ").slice(0, 160)}`
      })
    })
  }

  getReviewPackages(request: TodoListRequest, options: { includeOpen?: boolean } = {}): Promise<TodoReviewPackage[]> {
    return this.sqlite.read((database) => {
      const project = rows<ProjectRow>(database, "SELECT id, fingerprint FROM todo_projects WHERE fingerprint = ?", [request.projectFingerprint.trim()])[0]
      if (!project) return []
      const list = rows<ListRow>(database, "SELECT id, project_id, conversation_id, revision FROM todo_lists WHERE project_id = ? AND conversation_id = ?", [project.id, request.conversationId.trim()])[0]
      if (!list) return []
      const plan = rows<{ plan_id: string; revision: number; goal: string; constraints_json: string }>(database, "SELECT plan_id, revision, goal, constraints_json FROM todo_intent_plans WHERE list_id = ?", [list.id])[0]
      if (!plan) return []
      const tasks = rows<ItemRow & { task_id: string; dependencies_json: string; criteria_json: string | null }>(
        database,
        "SELECT items.id, items.list_id, items.parent_id, items.title, items.details, items.status, items.verification, items.priority, items.created_by, items.source, items.sort_order, items.blocked_reason, items.version, items.created_at, items.updated_at, tasks.task_id, tasks.dependencies_json, tasks.criteria_json " +
          "FROM todo_intent_tasks AS tasks JOIN todo_items AS items ON items.id = tasks.item_id " +
          "WHERE tasks.list_id = ? AND tasks.active = 1 ORDER BY items.sort_order, items.created_at",
        [list.id]
      )
      const taskMap = new Map(tasks.map((task) => [task.task_id, task]))
      const acceptedEvidence = acceptedFactsFor(database, list.project_id)
      const symbolAliases = symbolAliasesFor(database, list.project_id)
      const reviewable = (status: string) => status === "in_review" || (options.includeOpen === true && (status === "pending" || status === "in_progress"))
      return tasks.filter((task) => reviewable(task.status)).map((row) => {
        const evidence = rows<TodoEvidence>(database,
          "SELECT id, item_id AS itemId, kind, summary, result, created_at AS createdAt FROM todo_evidence WHERE item_id = ? ORDER BY created_at DESC LIMIT 10", [row.id])
        const retainedEvidence = retainedEvidenceFor(database, row.id, true, list.id)
        const observations = rows<{ id: string; itemId: string; toolName: string; arguments_json: string; output: string; failed_number: number; exitCode: number | null; createdAt: string }>(database,
          "SELECT observations.id, observations.item_id AS itemId, observations.tool_name AS toolName, observations.arguments_json, observations.output, observations.failed AS failed_number, observations.exit_code AS exitCode, observations.created_at AS createdAt FROM todo_tool_observations AS observations WHERE observations.list_id = ? AND observations.item_id IN (SELECT item_id FROM todo_intent_tasks WHERE list_id = ? AND active = 1) ORDER BY observations.created_at DESC, observations.rowid DESC", [list.id, list.id]
        ).map((observation) => ({
          id: observation.id,
          itemId: observation.itemId,
          toolName: observation.toolName,
          arguments: JSON.parse(observation.arguments_json) as Record<string, string>,
          output: observation.output,
          failed: observation.failed_number !== 0,
          exitCode: observation.exitCode ?? undefined,
          createdAt: observation.createdAt,
          evidence: evidenceStatus(retainedEvidence.find((entry) => entry.observationId === observation.id))
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
          criteria: requiredCriteria(row.criteria_json),
          dependencies: dependencyIds.flatMap((id) => {
            const dependency = taskMap.get(id)
            return dependency ? [{ id, title: dependency.title, status: dependency.status }] : []
          }),
          evidence,
          observations,
          retainedEvidence,
          acceptedEvidence,
          symbolAliases,
          requirementActivation: latestActivation(database, list.id, row.id),
          lastEvaluation: lastEvaluation ? JSON.parse(lastEvaluation.evaluation_json) as TodoEvaluation : undefined
        }
      })
    })
  }

  /** Retained output of every observation for this conversation's active plan, completed tasks included. */
  listIntentEvidence(request: TodoListRequest): Promise<RetainedObservationEvidence[]> {
    return this.sqlite.read((database) => {
      const project = rows<ProjectRow>(database, "SELECT id, fingerprint FROM todo_projects WHERE fingerprint = ?", [request.projectFingerprint.trim()])[0]
      if (!project) return []
      const list = rows<ListRow>(database, "SELECT id, project_id, conversation_id, revision FROM todo_lists WHERE project_id = ? AND conversation_id = ?", [project.id, request.conversationId.trim()])[0]
      if (!list) return []
      return retainedEvidenceFor(database, "", true, list.id)
    })
  }

  recordToolObservation(request: TodoWriteRequest, input: TodoToolObservationInput): Promise<TodoToolObservation> {
    assertWriter(request)
    validateRequestId(input.requestId)
    const toolName = input.toolName.trim()
    if (!toolName || toolName.length > 120) throw new Error("Tool observation has an invalid tool name")
    const output = redactEvidence(input.output).slice(0, MAX_EVIDENCE_TEXT)
    const arguments_ = Object.fromEntries(Object.entries(input.arguments).map(([key, value]) => [key, redactEvidence(value)]))
    const preserved = input.evidenceOutput === undefined ? undefined : preserveEvidence(input.evidenceOutput)
    return this.sqlite.write((database) => {
      const list = ensureList(database, request)
      const prior = rows<{ id: string; itemId: string; toolName: string; arguments_json: string; output: string; failed: number; exitCode: number | null; createdAt: string }>(database,
        "SELECT id, item_id AS itemId, tool_name AS toolName, arguments_json, output, failed, exit_code AS exitCode, created_at AS createdAt FROM todo_tool_observations WHERE list_id = ? AND request_id = ?", [list.id, input.requestId])[0]
      if (prior) {
        const priorEvidence = rows<{ retained: number; complete: number; original_chars: number; preserved_chars: number }>(database,
          "SELECT retained, complete, original_chars, preserved_chars FROM todo_tool_evidence WHERE observation_id = ?", [prior.id])[0]
        return {
          ...prior,
          arguments: JSON.parse(prior.arguments_json) as Record<string, string>,
          failed: prior.failed !== 0,
          exitCode: prior.exitCode ?? undefined,
          evidence: priorEvidence && {
            retained: priorEvidence.retained === 1,
            complete: priorEvidence.complete === 1,
            originalChars: priorEvidence.original_chars,
            preservedChars: priorEvidence.preserved_chars
          }
        }
      }
      const row = rows<ItemRow>(database, "SELECT * FROM todo_items WHERE id = ? AND list_id = ?", [input.itemId, list.id])[0]
      if (!row || row.status === "completed" || row.status === "cancelled") throw new Error("Tool observation task is no longer actionable")
      const intentTask = rows<{ task_id: string }>(database, "SELECT task_id FROM todo_intent_tasks WHERE item_id = ? AND list_id = ? AND active = 1", [input.itemId, list.id])[0]
      if (!intentTask) throw new Error("Tool observations are limited to active Intent tasks")
      const retain = preserved !== undefined && preserved.preservedChars <= this.evidenceLimits.listChars
      const evidence: TodoToolEvidenceStatus | undefined = preserved && {
        retained: retain,
        complete: preserved.complete,
        originalChars: preserved.originalChars,
        preservedChars: preserved.preservedChars
      }
      const observation: TodoToolObservation = { id: randomUUID(), itemId: input.itemId, toolName, arguments: arguments_, output, failed: input.failed, exitCode: input.exitCode, createdAt: now(), evidence, executionId: input.executionId }
      const listRevision = bumpList(database, list.id, input.itemId, "tool_observed", "system", input.requestId, { toolName, failed: input.failed, exitCode: input.exitCode })
      database.run("INSERT INTO todo_tool_observations(id, list_id, item_id, request_id, tool_name, arguments_json, output, failed, exit_code, created_at, list_revision, execution_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [observation.id, list.id, input.itemId, input.requestId, toolName, JSON.stringify(arguments_), output, input.failed ? 1 : 0, input.exitCode ?? null, observation.createdAt, listRevision, input.executionId ?? null])
      if (preserved) {
        database.run("INSERT INTO todo_tool_evidence(observation_id, list_id, content, retained, complete, original_chars, preserved_chars, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [observation.id, list.id, retain ? preserved.content : null, retain ? 1 : 0, preserved.complete ? 1 : 0, preserved.originalChars, preserved.preservedChars, JSON.stringify({ sources: preserved.sources, hits: preserved.hits }), observation.createdAt])
        enforceEvidenceBudget(database, list.id, observation.id, this.evidenceLimits.listChars)
      }
      // Evidence does not change the task's content or status, so it does not bump its version: an unrelated observation
      // made during review must not invalidate that review. The list revision above records it for review packages.
      logTodoEvent("todo.evidence.recorded", { operation_id: list.id, item_id: input.itemId, tool_name: toolName, failed: input.failed, exit_code: input.exitCode ?? null, request_id: input.requestId }, input.failed ? "info" : "debug")
      return observation
    })
  }

  /**
   * Records an editor mutation before it is dispatched. The unresolved-target check and the insert run in one write
   * transaction, so two dispatches cannot both claim the same target.
   */
  beginEditOperation(request: TodoWriteRequest, input: EditOperationInput): Promise<EditOperationRecord> {
    assertWriter(request)
    return this.sqlite.write((database) => {
      const list = ensureList(database, request)
      if (input.itemId !== undefined) {
        const intentTask = rows<{ task_id: string }>(database, "SELECT task_id FROM todo_intent_tasks WHERE item_id = ? AND list_id = ? AND active = 1", [input.itemId, list.id])[0]
        if (!intentTask) throw new Error("Edit operations are limited to active Intent tasks")
      }
      const unresolved = unresolvedEditTarget(database, list.project_id, input.target)
      if (unresolved) throw new TodoConflictError(`Edit target ${input.target} has an unresolved operation ${unresolved.id}`)
      const timestamp = Date.now()
      const record: EditOperationRecord = { ...input, status: "dispatched", detail: "", createdAt: timestamp, updatedAt: timestamp }
      database.run("INSERT INTO todo_edit_operations(id, list_id, item_id, owner_id, target, mode, pre_digest, post_digest, status, detail, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [record.id, list.id, record.itemId ?? null, record.ownerId ?? null, record.target, record.mode, record.preDigest, record.postDigest, record.status, record.detail, record.createdAt, record.updatedAt])
      return record
    })
  }

  /**
   * Moves a dispatched operation to a terminal status. The update applies only while the operation is still dispatched,
   * so a late settlement cannot overwrite a reconciliation that already decided the outcome.
   */
  settleEditOperation(request: TodoWriteRequest, operationId: string, status: Exclude<EditOperationStatus, "dispatched">, detail: string): Promise<boolean> {
    assertWriter(request)
    return this.sqlite.write((database) => {
      const list = findList(database, request)
      if (!list) return false
      database.run("UPDATE todo_edit_operations SET status = ?, detail = ?, updated_at = ? WHERE id = ? AND list_id = ? AND status = 'dispatched'",
        [status, detail.slice(0, 500), Date.now(), operationId, list.id])
      return database.getRowsModified() === 1
    })
  }

  /**
   * Reports a dispatched edit on the target in any conversation of this project. Edits without an active Intent task
   * cannot be recorded, so the controller uses this to refuse them while an earlier dispatch is still unsettled.
   */
  findUnresolvedEditTarget(request: TodoListRequest, target: string): Promise<{ operationId: string; conversationId: string | null } | undefined> {
    return this.sqlite.read((database) => {
      const project = rows<ProjectRow>(database, "SELECT id, fingerprint FROM todo_projects WHERE fingerprint = ?", [request.projectFingerprint.trim()])[0]
      if (!project) return undefined
      const unresolved = unresolvedEditTarget(database, project.id, target)
      return unresolved ? { operationId: unresolved.id, conversationId: unresolved.conversationId } : undefined
    })
  }

  listDispatchedEditOperations(request: TodoListRequest): Promise<EditOperationRecord[]> {
    return this.sqlite.read((database) => {
      const list = findList(database, request)
      if (!list) return []
      return rows<EditOperationRow>(database,
        "SELECT id, item_id AS itemId, owner_id AS ownerId, target, mode, pre_digest AS preDigest, post_digest AS postDigest, status, detail, created_at AS createdAt, updated_at AS updatedAt FROM todo_edit_operations WHERE list_id = ? AND status = 'dispatched' ORDER BY created_at, id", [list.id])
        .map(toEditOperationRecord)
    })
  }

  /**
   * Lists unresolved operations across every conversation of the project. Operations are host-owned, so another
   * conversation's record is visible for reconciliation and blocking, but is never replayed or re-owned here.
   */
  listUnresolvedEditOperations(request: TodoListRequest): Promise<UnresolvedEditOperation[]> {
    return this.sqlite.read((database) => {
      const project = rows<ProjectRow>(database, "SELECT id, fingerprint FROM todo_projects WHERE fingerprint = ?", [request.projectFingerprint.trim()])[0]
      if (!project) return []
      return rows<EditOperationRow & { conversationId: string | null }>(database,
        "SELECT e.id AS id, e.item_id AS itemId, e.owner_id AS ownerId, e.target AS target, e.mode AS mode, e.pre_digest AS preDigest, e.post_digest AS postDigest, e.status AS status, e.detail AS detail, e.created_at AS createdAt, e.updated_at AS updatedAt, l.conversation_id AS conversationId FROM todo_edit_operations e JOIN todo_lists l ON l.id = e.list_id WHERE l.project_id = ? AND e.status IN ('dispatched','diverged') ORDER BY e.created_at, e.id", [project.id])
        .map((row) => ({ ...toEditOperationRecord(row), status: row.status as "dispatched" | "diverged", conversationId: row.conversationId }))
    })
  }

  /**
   * Moves an unresolved operation to its reconciled outcome only if it still has the status the caller decided from.
   * Two reconcilers that observed the same status race on this compare-and-set, and exactly one of them wins.
   */
  settleProjectEditOperation(request: TodoListRequest, operationId: string, expected: "dispatched" | "diverged", status: Exclude<EditOperationStatus, "dispatched" | "succeeded" | "failed">, detail: string): Promise<boolean> {
    return this.sqlite.write((database) => {
      const project = rows<ProjectRow>(database, "SELECT id, fingerprint FROM todo_projects WHERE fingerprint = ?", [request.projectFingerprint.trim()])[0]
      if (!project) return false
      database.run("UPDATE todo_edit_operations SET status = ?, detail = ?, updated_at = ? WHERE id = ? AND status = ? AND list_id IN (SELECT id FROM todo_lists WHERE project_id = ?)",
        [status, detail.slice(0, 500), Date.now(), operationId, expected, project.id])
      return database.getRowsModified() === 1
    })
  }

  /**
   * Starts a task's execution requirements at the current causal revision. The first activation is idempotent, so a
   * task keeps its activation across replies. Only an explicit renewal records a new one, which makes earlier runs ineligible.
   */
  activateRequirement(request: TodoWriteRequest, itemId: string, requestId: string): Promise<RequirementActivation> {
    return this.recordActivation(request, itemId, requestId, "activation")
  }

  renewRequirement(request: TodoWriteRequest, itemId: string, requestId: string): Promise<RequirementActivation> {
    return this.recordActivation(request, itemId, requestId, "renewal")
  }

  private recordActivation(request: TodoWriteRequest, itemId: string, requestId: string, kind: RequirementActivation["kind"]): Promise<RequirementActivation> {
    assertWriter(request)
    validateRequestId(requestId)
    return this.sqlite.write((database) => {
      const list = ensureList(database, request)
      const prior = latestActivation(database, list.id, itemId)
      const replay = rows<{ id: string; item_id: string; kind: RequirementActivation["kind"]; list_revision: number; activated_at: number }>(database,
        "SELECT id, item_id, kind, list_revision, activated_at FROM todo_requirement_activations WHERE list_id = ? AND request_id = ?", [list.id, requestId])[0]
      if (replay) return { id: replay.id, itemId: replay.item_id, kind: replay.kind, listRevision: replay.list_revision, activatedAt: replay.activated_at }
      if (kind === "activation" && prior) return prior
      const item = rows<{ status: TodoStatus }>(database, "SELECT status FROM todo_items WHERE id = ? AND list_id = ?", [itemId, list.id])[0]
      if (!item) throw new Error("Requirement activation task was not found")
      if (item.status === "completed" || item.status === "cancelled") throw new Error("Requirement activation task is no longer actionable")
      const intentTask = rows<{ task_id: string }>(database, "SELECT task_id FROM todo_intent_tasks WHERE item_id = ? AND list_id = ? AND active = 1", [itemId, list.id])[0]
      if (!intentTask) throw new Error("Requirement activations are limited to active Intent tasks")
      const listRevision = bumpList(database, list.id, itemId, kind === "activation" ? "requirement_activated" : "requirement_renewed", "system", requestId, { kind })
      const activation: RequirementActivation = { id: randomUUID(), itemId, kind, listRevision, activatedAt: Date.now() }
      database.run("INSERT INTO todo_requirement_activations(id, list_id, item_id, request_id, kind, list_revision, activated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [activation.id, list.id, itemId, requestId, kind, listRevision, activation.activatedAt])
      return activation
    })
  }

  applyEvaluation(request: TodoWriteRequest, itemId: string, expectedVersion: number, evaluation: TodoEvaluation, requestId: string): Promise<TodoEvaluation> {
    assertWriter(request)
    validateRequestId(requestId)
    return this.sqlite.write((database) => {
      const list = ensureList(database, request)
      const prior = rows<{ evaluation_json: string }>(database, "SELECT evaluation_json FROM todo_evaluations WHERE list_id = ? AND request_id = ?", [list.id, requestId])[0]
      if (prior) return JSON.parse(prior.evaluation_json) as TodoEvaluation
      const row = rows<ItemRow & { task_id: string }>(database,
        "SELECT items.*, tasks.task_id FROM todo_items AS items JOIN todo_intent_tasks AS tasks ON tasks.item_id = items.id WHERE items.id = ? AND items.list_id = ? AND tasks.active = 1", [itemId, list.id])[0]
      if (!row) throw new Error(supersededItemMessage(database, list.id, itemId) ?? "Review task was not found in the active conversation")
      if (row.status !== "in_review") throw new TodoConflictError("Cannot review a TODO in " + row.status + " status")
      if (row.version !== expectedVersion) throw new TodoConflictError("TODO changed since review version " + expectedVersion + "; current version is " + row.version)
      const currentPlan = rows<{ plan_id: string; revision: number; goal: string }>(database, "SELECT plan_id, revision, goal FROM todo_intent_plans WHERE list_id = ?", [list.id])[0]
      if (!currentPlan || currentPlan.revision !== evaluation.metadata.planRevision) throw new TodoConflictError("Intent plan changed while its TODO was being evaluated")
      if (evaluation.schemaVersion !== 1) throw new Error("Evaluation schemaVersion must be 1")
      if (evaluation.taskId !== row.task_id) throw new Error("Evaluation task ID does not match the reviewed task")
      if (!["accept", "revise", "needs_evidence", "blocked"].includes(evaluation.decision)) throw new Error("Evaluation decision is not supported")
      const taskDefinition = rows<{ criteria_json: string | null }>(database, "SELECT criteria_json FROM todo_intent_tasks WHERE item_id = ? AND list_id = ? AND active = 1", [itemId, list.id])[0]
      const stored = requiredCriteria(taskDefinition.criteria_json)
      if (evaluation.criteria.length !== stored.length || evaluation.criteria.some((criterion, index) => criterion.criterionId !== stored[index].id)) {
        throw new Error("Evaluation criteria do not match the stored task criteria")
      }
      const observations = rows<{ id: string; item_id: string; tool_name: string; arguments_json: string; failed: number; exit_code: number | null }>(database,
        "SELECT observations.id, observations.item_id, observations.tool_name, observations.arguments_json, observations.failed, observations.exit_code FROM todo_tool_observations AS observations WHERE observations.list_id = ? AND observations.item_id IN (SELECT item_id FROM todo_intent_tasks WHERE list_id = ? AND active = 1)", [list.id, list.id])
      const evidenceIds = new Set(rows<{ id: string }>(database, "SELECT id FROM todo_evidence WHERE item_id = ?", [itemId]).map((entry) => entry.id))
      const observationIds = new Set(observations.map((observation) => observation.id))
      const acceptedObservationIds = new Set(acceptedFactsFor(database, list.project_id).map((fact) => fact.observationId))
      for (const [index, criterion] of evaluation.criteria.entries()) {
        if (!["passed", "failed", "unverified"].includes(criterion.status)) throw new Error(`Evaluation criteria[${index}].status is not supported`)
        for (const reference of criterion.evidenceRefs) {
          if (!observationIds.has(reference) && !evidenceIds.has(reference) && !acceptedObservationIds.has(reference)) {
            throw new Error(`Evaluation criteria[${index}].evidenceRefs references unknown evidence ID ${reference}`)
          }
        }
      }
      if (evaluation.decision === "accept") {
        const byId = new Map(observations.map((observation) => [observation.id, observation]))
        const unresolved = evaluation.criteria.flatMap((criterion) => {
          const reconciliation = criterion.reconciliation
          if (reconciliation?.reuse === "accepted") {
            // Reused criteria rest on current accepted facts in this project, not on this task's reads.
            return criterion.status === "passed" && criterion.evidenceRefs.length > 0 && criterion.evidenceRefs.every((id) => acceptedObservationIds.has(id))
              ? [] : [`${criterion.criterionId}: reused accepted fact is not cited`]
          }
          if (criterion.status !== "passed") return [`${criterion.criterionId}: not passed`]
          if (reconciliation?.outcome === "proven") return []
          // Semantic judgments stand only when they cite a trusted observation of this task or a shared one.
          if (reconciliation?.outcome === "semantic" && criterion.evidenceRefs.some((id) => byId.has(id))) return []
          return [`${criterion.criterionId}: ${reconciliation?.missing[0] ?? "no trusted observation establishes it"}`]
        })
        if (unresolved.length > 0) throw new Error(["Evaluation cannot accept unresolved criteria", ...unresolved].join("; "))
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
      if (evaluation.decision === "accept") recordAcceptedFacts(database, list.id, currentPlan, itemId, evaluation, new Map(observations.map((observation) => [observation.id, observation])), updatedAt)
      bumpList(database, list.id, itemId, "evaluation_recorded", "system", requestId, { decision: evaluation.decision, evaluation })
      logTodoEvent("feedback.reconciled", { operation_id: list.id, item_id: itemId, decision: evaluation.decision, status, verification, request_id: requestId })
      if (status === "completed") logTodoEvent("todo.completed", { operation_id: list.id, item_id: itemId, verification, request_id: requestId })
      return evaluation
    })
  }

  listAcceptedEvidence(request: TodoListRequest, options: { symbol?: string; path?: string } = {}): Promise<AcceptedFact[]> {
    return this.sqlite.read((database) => {
      const project = rows<ProjectRow>(database, "SELECT id, fingerprint FROM todo_projects WHERE fingerprint = ?", [request.projectFingerprint.trim()])[0]
      if (!project) return []
      return acceptedFactsFor(database, project.id, { ...options, includeSuperseded: true })
    })
  }

  /**
   * Records successful, distinct uses of current accepted facts by one execution. A row is keyed by fact, kind and
   * execution, so repeating the same use inside an execution is ignored. Facts that are superseded or outside the
   * project are skipped. Freshness is checked by the caller, which reads source; this write only checks structure.
   */
  recordEvidenceUse(request: TodoListRequest, input: { kind: EvidenceUseKind; executionId: string; factIds: string[] }): Promise<number> {
    return this.sqlite.write((database) => {
      const project = rows<ProjectRow>(database, "SELECT id, fingerprint FROM todo_projects WHERE fingerprint = ?", [request.projectFingerprint.trim()])[0]
      if (!project) return 0
      const current = new Set(acceptedFactsFor(database, project.id).map((fact) => fact.id))
      let recorded = 0
      for (const factId of new Set(input.factIds)) {
        if (!current.has(factId)) continue
        database.run(
          "INSERT OR IGNORE INTO todo_evidence_usage (id, fact_id, project_id, conversation_id, execution_id, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [randomUUID(), factId, project.id, request.conversationId.trim(), input.executionId, input.kind, now()]
        )
        recorded += database.getRowsModified()
      }
      return recorded
    })
  }

  /**
   * Every current accepted fact in the project with its lifetime lookup and reuse counts. Counts are per distinct
   * execution and kind, so the ranking is decided by independent use. Superseded facts are excluded from the candidates.
   */
  promotionCandidates(request: TodoListRequest): Promise<AcceptedFactUsage[]> {
    return this.sqlite.read((database) => {
      const project = rows<ProjectRow>(database, "SELECT id, fingerprint FROM todo_projects WHERE fingerprint = ?", [request.projectFingerprint.trim()])[0]
      if (!project) return []
      const counts = new Map<string, { lookups: number; reuses: number }>()
      for (const row of rows<{ fact_id: string; kind: EvidenceUseKind; uses: number }>(database,
        "SELECT fact_id, kind, COUNT(*) AS uses FROM todo_evidence_usage WHERE project_id = ? GROUP BY fact_id, kind", [project.id])) {
        const entry = counts.get(row.fact_id) ?? { lookups: 0, reuses: 0 }
        if (row.kind === "lookup") entry.lookups = row.uses
        else entry.reuses = row.uses
        counts.set(row.fact_id, entry)
      }
      return acceptedFactsFor(database, project.id).map((fact) => ({ fact, lookups: 0, reuses: 0, ...counts.get(fact.id) }))
    })
  }

  listSymbolAliases(request: TodoListRequest): Promise<SymbolAlias[]> {
    return this.sqlite.read((database) => {
      const project = rows<ProjectRow>(database, "SELECT id, fingerprint FROM todo_projects WHERE fingerprint = ?", [request.projectFingerprint.trim()])[0]
      if (!project) return []
      return symbolAliasesFor(database, project.id)
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

  /**
   * Read-only view of a conversation's TODO list in the same project. It never creates a list
   * or writes a row, and the snapshot is a fresh copy. Undefined means no list exists yet.
   */
  readList(request: TodoListRequest): Promise<TodoListSnapshot | undefined> {
    return this.sqlite.read((database) => {
      const list = findList(database, request)
      return list ? snapshotFor(database, list, request.includeCompleted) : undefined
    })
  }

  getItem(request: TodoListRequest, itemId: string): Promise<{ item: TodoItem; evidence: TodoEvidence[] }> {
    return this.sqlite.write((database) => {
      const list = ensureList(database, request)
      const row = rows<ItemRow>(
        database,
        `SELECT items.id, items.list_id, items.parent_id, items.title, items.details, items.status, items.verification, items.priority,
                items.created_by, items.source, tasks.criteria_json, items.sort_order, items.blocked_reason, items.version, items.created_at, items.updated_at
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

  createItem(request: TodoWriteRequest, input: CreateTodoInput, requestId: string, actor: "user" | "model" = "model"): Promise<TodoItem> {
    return this.createItemOutcome(request, input, requestId, actor).then((outcome) => outcome.item)
  }

  /**
   * Creates a TODO, or reuses the existing one when a model create matches a
   * task that is already present. Exact titles match first; within an
   * authoritative intent plan, a clear word overlap also matches. Ambiguous or
   * weak overlaps create a new item rather than merging distinct work.
   */
  createItemOutcome(request: TodoWriteRequest, input: CreateTodoInput, requestId: string, actor: "user" | "model" = "model"): Promise<TodoCreateOutcome> {
    assertWriter(request)
    validateRequestId(requestId)
    const title = input.title.trim()
    const parentId = input.parentId?.trim() || undefined
    if (!title || title.length > 500) throw new Error("TODO title must contain 1 to 500 characters")
    if (input.details && input.details.length > 8000) throw new Error("TODO details cannot exceed 8,000 characters")
    const priority = input.priority ?? "normal"
    if (!validPriorities.has(priority)) throw new Error("Invalid TODO priority")

    return this.sqlite.write((database) => {
      const list = ensureList(database, request)
      const prior = parseRequest<TodoCreateOutcome | TodoItem>(database, list.id, requestId, "create")
      if (prior) return "item" in prior ? prior : { item: prior, reused: false }
      if (parentId) {
        const parent = rows<{ id: string }>(database, "SELECT id FROM todo_items WHERE id = ? AND list_id = ?", [parentId, list.id])[0]
        if (!parent) throw new Error("Parent TODO item must be in the active conversation")
      }
      if (actor === "model") {
        const wanted = normalizeTodoIdentity(title)
        const siblings = rows<ItemRow>(
          database,
          "SELECT * FROM todo_items WHERE list_id = ? AND status != 'cancelled' AND COALESCE(parent_id, '') = ? ORDER BY sort_order, created_at",
          [list.id, parentId ?? ""]
        )
        const exact = siblings.find((row) => normalizeTodoIdentity(row.title) === wanted)
        const planRows = exact ? [] : rows<ItemRow>(
          database,
          `SELECT items.* FROM todo_items AS items JOIN todo_intent_tasks AS tasks ON tasks.item_id = items.id
           WHERE items.list_id = ? AND tasks.list_id = ? AND tasks.active = 1 AND items.status != 'cancelled'`,
          [list.id, list.id]
        )
        const overlap = exact ? undefined : planOverlapMatch(planRows, title)
        const umbrella = exact || overlap ? undefined : planUmbrellaMatch(planRows, title)
        const reusedRow = exact ?? overlap ?? umbrella
        if (reusedRow) {
          const matchedBy = exact ? "title" : overlap ? "plan_overlap" : "plan_umbrella"
          const outcome: TodoCreateOutcome = { item: itemOf(reusedRow), reused: true, matchedBy }
          recordRequest(database, list.id, requestId, "create", outcome)
          logTodoEvent("todo.duplicate.reconciled", { operation_id: list.id, item_id: outcome.item.id, status: outcome.item.status, actor, matched_by: outcome.matchedBy ?? null, request_id: requestId })
          return outcome
        }
      }
      const id = insertItem(database, list.id, { parentId, title, details: input.details, priority, actor, requestId })
      const outcome: TodoCreateOutcome = { item: itemOf(rows<ItemRow>(database, "SELECT * FROM todo_items WHERE id = ?", [id])[0]), reused: false }
      recordRequest(database, list.id, requestId, "create", outcome)
      logTodoEvent("todo.created", { operation_id: list.id, item_id: id, status: outcome.item.status, actor, request_id: requestId })
      return outcome
    })
  }

  hasAuthoritativePlan(request: TodoListRequest): Promise<boolean> {
    return this.sqlite.read((database) => {
      const list = findList(database, request)
      if (!list) return false
      return rows<{ plan_id: string }>(database, "SELECT plan_id FROM todo_intent_plans WHERE list_id = ?", [list.id]).length > 0
    })
  }

  /** Everything Feedback reviews a child proposal against. Throws when the parent cannot take a child. */
  childTodoContext(request: TodoListRequest, parentId: string): Promise<ChildTodoContext> {
    return this.sqlite.read((database) => {
      const list = findList(database, request)
      const plan = list ? rows<{ plan_id: string; revision: number; goal: string }>(database, "SELECT plan_id, revision, goal FROM todo_intent_plans WHERE list_id = ?", [list.id])[0] : undefined
      if (!list || !plan) throw new Error("No authoritative plan exists for this conversation")
      const membership = planMembership(database, list.id)
      anchorForParent(membership, parentId)
      return childContext(membership, plan, parentId)
    })
  }

  /**
   * A result that needs no Feedback review: the recorded decision for this request or an identical
   * proposal. Undefined when Feedback must review.
   */
  childTodoReplay(request: TodoListRequest, proposal: ChildTodoProposal): Promise<ChildTodoOutcome | undefined> {
    validateRequestId(proposal.requestId)
    return this.sqlite.read((database) => {
      const list = findList(database, request)
      if (!list) return undefined
      const byRequest = recordedChildOutcome(database, list.id, proposal)
      if (byRequest) return byRequest
      const fingerprint = childFingerprint(proposal)
      const decided = rows<{ result_json: string }>(
        database,
        "SELECT result_json FROM todo_child_proposals WHERE list_id = ? AND fingerprint = ? ORDER BY created_at DESC",
        [list.id, fingerprint]
      )
      for (const row of decided) {
        const outcome = liveChildOutcome(database, list.id, JSON.parse(row.result_json) as ChildTodoOutcome)
        if (outcome) return outcome
      }
      return undefined
    })
  }

  /**
   * A live TODO that already covers this title: an exact sibling under the parent, or an overlapping or
   * umbrella plan task. Read-only, so it decides without any model call or mutation.
   */
  existingTaskFor(request: TodoListRequest, title: string, parentId?: string): Promise<{ item: TodoItem; matchedBy: "title" | "plan_overlap" | "plan_umbrella"; planRevision: number } | undefined> {
    return this.sqlite.read((database) => {
      const list = findList(database, request)
      if (!list) return undefined
      const wanted = normalizeTodoIdentity(title)
      const siblings = rows<ItemRow>(
        database,
        "SELECT * FROM todo_items WHERE list_id = ? AND status != 'cancelled' AND COALESCE(parent_id, '') = ? ORDER BY sort_order, created_at",
        [list.id, parentId ?? ""]
      )
      const exact = siblings.find((row) => normalizeTodoIdentity(row.title) === wanted)
      const planRows = exact ? [] : rows<ItemRow>(
        database,
        `SELECT items.* FROM todo_items AS items JOIN todo_intent_tasks AS tasks ON tasks.item_id = items.id
         WHERE items.list_id = ? AND tasks.list_id = ? AND tasks.active = 1 AND items.status != 'cancelled'`,
        [list.id, list.id]
      )
      const overlap = exact ? undefined : planOverlapMatch(planRows, title)
      const umbrella = exact || overlap ? undefined : planUmbrellaMatch(planRows, title)
      const match = exact ? { row: exact, matchedBy: "title" as const } : overlap ? { row: overlap, matchedBy: "plan_overlap" as const } : umbrella ? { row: umbrella, matchedBy: "plan_umbrella" as const } : undefined
      if (!match) return undefined
      const [plan] = rows<{ revision: number }>(database, "SELECT revision FROM todo_intent_plans WHERE list_id = ?", [list.id])
      return { item: itemOf(match.row), matchedBy: match.matchedBy, planRevision: plan?.revision ?? 0 }
    })
  }


  /**
   * Applies a host-validated Feedback decision in one transaction. Accepted and
   * revised proposals insert exactly one child and advance the plan revision;
   * other decisions leave the TODO list untouched.
   */
  applyChildTodo(request: TodoWriteRequest, proposal: ChildTodoProposal, decision: ChildTodoDecision): Promise<ChildTodoOutcome> {
    assertWriter(request)
    validateRequestId(proposal.requestId)
    return this.sqlite.write((database) => {
      const list = findList(database, request)
      const plan = list ? rows<{ revision: number }>(database, "SELECT revision FROM todo_intent_plans WHERE list_id = ?", [list.id])[0] : undefined
      if (!list || !plan) throw new Error("No authoritative plan exists for this conversation")
      const recorded = recordedChildOutcome(database, list.id, proposal)
      if (recorded) return recorded
      const fingerprint = childFingerprint(proposal)
      const sameProposal = rows<{ result_json: string }>(
        database,
        "SELECT result_json FROM todo_child_proposals WHERE list_id = ? AND fingerprint = ? ORDER BY created_at DESC",
        [list.id, fingerprint]
      ).map((row) => liveChildOutcome(database, list.id, JSON.parse(row.result_json) as ChildTodoOutcome)).find((outcome) => outcome)
      if (sameProposal) return sameProposal

      const membership = planMembership(database, list.id)
      const parentId = decision.parentId ?? proposal.parentId
      anchorForParent(membership, proposal.parentId)
      if (parentId !== proposal.parentId) anchorForParent(membership, parentId)

      let kind: ChildTodoDecisionKind = decision.decision
      let itemId = decision.itemId
      let instruction = decision.instruction
      let planRevision = plan.revision

      if (kind === "accepted" || kind === "revised") {
        const title = (decision.title ?? proposal.title).trim()
        const details = (decision.details ?? proposal.details)?.trim() || undefined
        if (!title || title.length > 500) throw new Error("TODO title must contain 1 to 500 characters")
        if (details && details.length > 8000) throw new Error("TODO details cannot exceed 8,000 characters")
        const wanted = normalizeTodoIdentity(title)
        const sibling = rows<ItemRow>(
          database,
          "SELECT * FROM todo_items WHERE list_id = ? AND status != 'cancelled' AND COALESCE(parent_id, '') = ? ORDER BY sort_order, created_at",
          [list.id, parentId]
        ).find((row) => normalizeTodoIdentity(row.title) === wanted)
        if (sibling) {
          kind = "existing_task"
          itemId = sibling.id
          instruction = "An equivalent TODO already exists under this parent; use it instead of creating another."
        } else {
          itemId = insertItem(database, list.id, { parentId, title, details, priority: proposal.priority, actor: "model", requestId: proposal.requestId })
          planRevision = plan.revision + 1
          database.run("UPDATE todo_intent_plans SET revision = revision + 1, updated_at = ? WHERE list_id = ?", [now(), list.id])
        }
      } else if (kind === "existing_task") {
        if (!itemId || !membership.planTaskOf.has(itemId)) throw new Error("An existing-task decision must name an active item in the authoritative plan")
      } else {
        itemId = undefined
      }

      const outcome: ChildTodoOutcome = { decision: kind, parentId, itemId, planRevision, instruction }
      database.run(
        "INSERT INTO todo_child_proposals(list_id, request_id, fingerprint, parent_id, decision, item_id, plan_revision, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [list.id, proposal.requestId, fingerprint, proposal.parentId, kind, itemId ?? null, planRevision, JSON.stringify(outcome), now()]
      )
      bumpList(database, list.id, itemId, "child_todo_decided", "model", proposal.requestId, { decision: kind, parentId, planRevision })
      logTodoEvent("todo.child.decided", { operation_id: list.id, item_id: itemId ?? null, decision: kind, plan_revision: planRevision, request_id: proposal.requestId })
      return outcome
    })
  }

  updateItem(request: TodoWriteRequest, input: UpdateTodoInput): Promise<TodoItem> {
    assertWriter(request)
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
        logTodoEvent("todo.update.noop", { operation_id: list.id, item_id: row.id, status: row.status, version: row.version, actor: input.actor, request_id: input.requestId }, "debug")
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

  /**
   * Records a model completion claim exactly once. The first valid claim moves
   * the TODO to in_review and queues its Feedback review. Repeats while that
   * review is pending are acknowledged without changing the version. Only
   * Feedback or a trusted user action can complete the TODO.
   */
  claimCompletion(request: TodoWriteRequest, input: { itemId: string; expectedVersion: number; requestId: string }): Promise<TodoCompletionClaim> {
    assertWriter(request)
    validateRequestId(input.requestId)
    return this.sqlite.write((database) => {
      const list = ensureList(database, request)
      const prior = parseRequest<TodoCompletionClaim>(database, list.id, input.requestId, "claim")
      if (prior) return prior
      const row = rows<ItemRow>(database, "SELECT * FROM todo_items WHERE id = ? AND list_id = ?", [input.itemId, list.id])[0]
      if (!row) throw new Error("TODO item was not found in the active conversation")
      if (row.status === "completed" || row.status === "cancelled") throw new Error(`Cannot claim completion for a ${row.status} TODO`)

      const review = reviewPathFor(database, list.id, row.id)
      const lastClaim = latestItemEvent(database, list.id, row.id, "completion_claimed")
      const lastEvaluation = latestItemEvent(database, list.id, row.id, "evaluation_recorded")
      const reviewPending = row.status === "in_review" && lastClaim !== undefined
        && (lastEvaluation === undefined || lastEvaluation.list_revision < lastClaim.list_revision)

      if (reviewPending) {
        const claimed = JSON.parse(lastClaim.payload_json) as { expectedVersion: number }
        if (input.expectedVersion < claimed.expectedVersion || input.expectedVersion > row.version) {
          throw new TodoConflictError(`Completion claim is already pending review at version ${row.version}; resubmitting from version ${input.expectedVersion} is not a valid retry`)
        }
        const claim: TodoCompletionClaim = { disposition: "already_submitted", item: itemOf(row), review }
        recordRequest(database, list.id, input.requestId, "claim", claim)
        logTodoEvent("todo.claim.already_submitted", { operation_id: list.id, item_id: row.id, version: row.version, request_id: input.requestId }, "debug")
        return claim
      }

      if (lastEvaluation) {
        const evaluated = JSON.parse(lastEvaluation.payload_json) as { decision: TodoEvaluationDecision; evaluation: TodoEvaluation }
        const newEvidence = rows<{ found: number }>(database,
          "SELECT 1 AS found FROM todo_events WHERE list_id = ? AND item_id = ? AND event_type IN ('tool_observed','evidence_added') AND list_revision > ? LIMIT 1",
          [list.id, row.id, lastEvaluation.list_revision]).length > 0
        if (evaluated.decision !== "accept" && !newEvidence) {
          const corrections = evaluated.evaluation.correctiveInstructions.length ? evaluated.evaluation.correctiveInstructions : [evaluated.evaluation.explanation]
          throw new TodoConflictError(`Feedback ${evaluated.decision === "needs_evidence" ? "needs more evidence" : "rejected the previous completion claim"} and no new observation was recorded. Do not resubmit the same claim; ${corrections.join("; ")}`)
        }
      }

      if (row.version !== input.expectedVersion) throw new TodoConflictError(`TODO changed since version ${input.expectedVersion}; current version is ${row.version}`)
      const alreadyInReview = row.status === "in_review"
      if (!alreadyInReview && !statusTransitions[row.status].has("in_review")) throw new Error(`Invalid TODO transition: ${row.status} -> in_review`)

      if (!alreadyInReview) {
        database.run(
          "UPDATE todo_items SET status = 'in_review', verification = 'not_checked', blocked_reason = NULL, version = version + 1, updated_at = ? WHERE id = ? AND version = ?",
          [now(), row.id, row.version]
        )
        if (database.getRowsModified() !== 1) throw new TodoConflictError("TODO changed while recording its completion claim")
      }
      const resultVersion = alreadyInReview ? row.version : row.version + 1
      bumpList(database, list.id, row.id, "completion_claimed", "model", input.requestId, { expectedVersion: input.expectedVersion, resultVersion, previousStatus: row.status, review })
      const claim: TodoCompletionClaim = { disposition: "accepted", item: itemOf(rows<ItemRow>(database, "SELECT * FROM todo_items WHERE id = ?", [row.id])[0]), review }
      recordRequest(database, list.id, input.requestId, "claim", claim)
      logTodoEvent("todo.claim.accepted", { operation_id: list.id, item_id: row.id, previous_status: row.status, version: claim.item.version, review, request_id: input.requestId })
      return claim
    })
  }

  async completeByUser(request: TodoWriteRequest, itemId: string, expectedVersion: number, reason: string, requestId: string, approval: TrustedUserApproval): Promise<TodoItem> {
    assertWriter(request)
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

  addEvidence(request: TodoWriteRequest, input: AddTodoEvidenceInput): Promise<TodoEvidence> {
    assertWriter(request)
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
      database.run("INSERT INTO todo_evidence(id, item_id, kind, summary, result, created_at) VALUES (?, ?, ?, ?, ?, ?)",
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
