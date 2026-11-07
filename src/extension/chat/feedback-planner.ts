import { logger, redact } from "../../common/logger"
import type { TodoFeedbackStatus, TodoListSnapshot } from "../../common/types"
import { isAbortError } from "../inference/errors"
import {
  cancelInferenceOperation,
  createInferenceTrace,
  finishInferenceOperation,
  inferenceEvent,
  InferenceTraceContext
} from "../inference/trace"
import { validateIntentTaskPlan } from "../todos/intent-plan"
import type {
  ChildTodoContext,
  ChildTodoDecision,
  ChildTodoDecisionKind,
  ChildTodoProposal,
  ChildTodoReviewOutcome,
  IntentTaskPlan,
  TodoListRequest,
  TodoWriteRequest
} from "../todos/types"
import { TodoConflictError } from "../todos/types"

import { abortAfter, extractJsonObject, JsonFailure, replyText, RoleEndpoint, RoleReply, RoleResolution, RoleResolver, RoleTimeoutError } from "./role-inference"

export const FEEDBACK_PLAN_PROTOCOL =
  "You maintain the task plan Twinny uses to track progress on the user's request. " +
  "Return exactly one valid JSON object, with no prose or Markdown fences, with keys track (boolean) and plan. " +
  "Use {\"track\": false, \"plan\": null} when the message needs no tracked work (a question, greeting, or a follow-up that the existing plan already covers). " +
  "Otherwise plan must be {planId: string, version: 1, revision: positive integer, goal: string, constraints: string[], tasks: [{id: stable string, title: string, description: string, acceptanceCriteria: string[], dependencies: string[]}]}. " +
  "Include 1-100 ordered tasks with stable IDs and no unknown or cyclic dependencies. Ground every task in the user's request; do not invent requirements. " +
  "Keep the plan as small as the objective allows: one task per distinct piece of user work, with factual, specific, measurable acceptance criteria proportional to that task. " +
  "Planning workflow is not a user deliverable. Twinny creates and updates the TODO list itself, so no title, description, or criterion may ask Mycroft to create, update, verify, or report on TODO entries, statuses, or the list, even when the user says to use TODOs. " +
  "Do not add reporting, documentation, or administrative deliverables that the user did not request. " +
  "A locate or lookup task needs only the facts that answer it, such as the file, symbol, and line range, not logging, documentation, or a record of the finding. " +
  "Criteria are fixed when the plan is made, so do not plan conditions that only verification would add. " +
  "Accepted host evidence and earlier verified facts are authoritative for narrow deterministic facts, so do not plan work that re-establishes them. " +
  "When an existing plan is supplied, preserve its planId and unchanged task IDs, and increase revision only when task definitions change."

export const DEFAULT_FEEDBACK_PLAN_TIMEOUT_MS = 60_000

export type FeedbackPlanFailure = JsonFailure | "output-limit" | "schema" | "administrative"

export type FeedbackPlanParse =
  | { track: false }
  | { track: true; plan: IntentTaskPlan }
  | { error: string; failure: FeedbackPlanFailure; offset?: number }

const OUTPUT_LIMIT_MESSAGE = "The provider stopped at its output limit before the plan was complete."
const EXCERPT_CHARS = 240

/** Twinny's own TODO machinery: the list, its items, and their statuses. */
const TODO_MACHINERY = /\b(?:todos?|to-dos?|task\s+list|plan\s+items?|tracking\s+items?|task\s+(?:statuses?|entries))(?![-\w])/i
/** A verb that would direct Mycroft to write, maintain, use, or report on a TODO record. */
const ADMINISTRATIVE_VERB = /\b(?:create|created|add|added|make|open|opened|initiali[sz]e|initiali[sz]ed|set\s+up|populate|populated|record|recorded|log|logged|track|tracked|maintain|maintained|update|updated|mark|marked|verify|verified|confirm|confirmed|report|reported|submit|submitted|complete|completed|close|closed|move|moved|set|keep|kept|use|used|document|documented|file|filed|write|written|entered|noted)\b/gi
/** Words right after a TODO noun that name Twinny's code rather than its records, e.g. "TODO filter" or "TODO scanner". */
const CODE_REFERENT_AFTER = /^\s*(?:[\w.'"`/-]+\s+)?(?:path|paths|code|scanner|panel|filter|view|handler|handling|function|implementation|module|source|logic|component|command|feature|webview|parser|schema|migration|tests?|files?|regex|tool)\b/i
/** A criterion that requires a TODO record to exist or to have a status. */
const RECORD_STATE_AFTER = /^\s*(?:[\w'-]+\s+){0,3}?(?:exists?|existing|present|recorded|marked|status(?:es)?|reflects?|updated|created|is\s+(?:open|done|closed|complete|completed|in\s+progress|pending|verified))\b/i
/**
 * Verbs that build, change, or debug the work itself, when they direct it: at the start of a line or sentence, or after
 * a request word such as "please" or "to". A word like "Test" inside a heading does not direct anything.
 */
const BUILD_DIRECTIVE = /(?:^|[.!?;:]\s+|\n\s*|\b(?:please|and|then|also|to|need to|want to|can you|could you)\s+)(?<verb>implement|fix|debug|test|refactor|build|design|change|improve|rename|remove|redesign)\b/gim
const NEGATED_BEFORE = /\b(?:not|never|no|don'?t|do\s+not|without|avoid)\b\s*(?:\S+\s*){0,2}$/i

/**
 * Whether the user's objective is itself about the TODO machinery, so that TODO tasks are the deliverable.
 * It needs both a TODO noun and an un-negated build verb. A read-only request that merely mentions TODOs does not qualify.
 */
export const requestsTodoMachineryWork = (objective: string): boolean => {
  if (!TODO_MACHINERY.test(objective)) return false
  for (const match of objective.matchAll(BUILD_DIRECTIVE)) {
    const verbAt = (match.index ?? 0) + match[0].length - (match.groups?.verb.length ?? 0)
    const before = objective.slice(Math.max(0, verbAt - 40), verbAt)
    if (!NEGATED_BEFORE.test(before)) return true
  }
  return false
}

// A directive for one named task, starting a line: "Please create a TODO to track the release notes." Plural
// objects, qualifiers ("create actionable TODOs before starting") and workflow mentions ("use TODOs to track
// this") do not match, so a task description cannot grant the authority.
const DIRECT_TODO_CREATE = /^[\s>*\-\d.)]*(?:please\s+|can\s+you\s+|could\s+you\s+)?(?:create|add|make|open)\s+(?:(?:a|an|one|the|this|that|new)\s+)?(?:todo|to-do|task)(?![-\w])/im

/**
 * Whether the user's own message directly asks for a single TODO to be created. Only the host reads this, from the
 * user's message, so Mycroft cannot grant itself this authority.
 */
export const userRequestsTodoCreation = (message: string): boolean => DIRECT_TODO_CREATE.test(message)

/**
 * Whether a span of plan text directs Mycroft to create, maintain, use, or report on a TODO record. A TODO noun counts only
 * when a directive verb governs it within a short clause, it is not negated, and no code referent follows it ("TODO scanner").
 * A criterion also counts when it requires that a TODO record exist or have a status.
 */
const isAdministrativeText = (text: string, criterion: boolean): boolean => {
  for (const noun of text.matchAll(new RegExp(TODO_MACHINERY.source, "gi"))) {
    const end = (noun.index ?? 0) + noun[0].length
    const after = text.slice(end, end + 60)
    if (CODE_REFERENT_AFTER.test(after)) continue
    if (criterion && RECORD_STATE_AFTER.test(after)) return true
    const before = text.slice(0, noun.index ?? 0).split(/[.!?;:\n]/).pop() ?? ""
    const verb = [...before.matchAll(ADMINISTRATIVE_VERB)].pop()
    if (!verb || verb.index === undefined) continue
    const between = before.slice(verb.index + verb[0].length).trim()
    if (between.split(/\s+/).filter(Boolean).length > 5) continue
    if (NEGATED_BEFORE.test(before.slice(0, verb.index))) continue
    return true
  }
  return false
}

export interface AdministrativeClause {
  path: string
  text: string
}

/**
 * Finds every title, description, and acceptance criterion that makes Mycroft administer the TODO list. Plans for an
 * objective about the TODO machinery itself are exempt. Nothing is removed: the plan must be corrected and resubmitted.
 */
/** Whether a child TODO's title or details would record or manage TODO entries rather than do concrete work. */
export const isAdministrativeChildText = (text: string, objective: string): boolean => !requestsTodoMachineryWork(objective) && isAdministrativeText(text, false)

export const findAdministrativeClauses = (plan: unknown, objective = ""): AdministrativeClause[] => {
  if (!plan || typeof plan !== "object" || !Array.isArray((plan as { tasks?: unknown }).tasks)) return []
  const candidate = plan as { goal?: unknown; tasks: unknown[] }
  const basis = objective || (typeof candidate.goal === "string" ? candidate.goal : "")
  if (requestsTodoMachineryWork(basis)) return []
  const found: AdministrativeClause[] = []
  candidate.tasks.forEach((task, index) => {
    if (!task || typeof task !== "object") return
    const record = task as { title?: unknown; description?: unknown; acceptanceCriteria?: unknown }
    for (const field of ["title", "description"] as const) {
      const value = record[field]
      if (typeof value === "string" && isAdministrativeText(value, false)) found.push({ path: `tasks[${index}].${field}`, text: value })
    }
    if (!Array.isArray(record.acceptanceCriteria)) return
    record.acceptanceCriteria.forEach((criterion, position) => {
      if (typeof criterion === "string" && isAdministrativeText(criterion, true)) {
        found.push({ path: `tasks[${index}].acceptanceCriteria[${position}]`, text: criterion })
      }
    })
  })
  return found
}

const administrativeMessage = (found: AdministrativeClause[]): string => {
  const quoted = found.map(({ path, text }) => `${path} "${text.length > 160 ? text.slice(0, 157) + "..." : text}"`)
  return (
    "Administrative TODO instructions are not allowed: Twinny maintains the TODO list itself, so no task may ask Mycroft to create, update, verify, or report on it. " +
    "Remove these clauses and keep only the user's work, with minimal, factual criteria: " + quoted.join("; ") + "."
  )
}

/** Reasoning arrived but no visible answer: the model spent its reply on thinking. */
const reasoningOnly = (reply: string | RoleReply | undefined) =>
  typeof reply === "object" && !replyText(reply).trim() && (reply.reasoningChars ?? 0) > 0

const parseFeedbackPlanBody = (reply: string | RoleReply | undefined, objective: string): FeedbackPlanParse => {
  if (reasoningOnly(reply)) return { error: "The provider returned reasoning but no answer.", failure: "reasoning-only" }
  const extraction = extractJsonObject(replyText(reply))
  const { value } = extraction
  if (!value) {
    return {
      error: extraction.error ?? "The provider response was not valid JSON.",
      failure: extraction.failure ?? "no-json",
      offset: extraction.offset
    }
  }
  const unexpected = Object.keys(value).filter((key) => key !== "track" && key !== "plan")
  if (unexpected.length) return { error: "Unexpected keys: " + unexpected.join(", ") + ".", failure: "schema" }
  if (typeof value.track !== "boolean") return { error: "track must be a boolean.", failure: "schema" }
  if (!value.track) return { track: false }
  const administrative = findAdministrativeClauses(value.plan, objective)
  if (administrative.length) return { error: administrativeMessage(administrative), failure: "administrative" }
  const validation = validateIntentTaskPlan(value.plan)
  if (!validation.plan) {
    return { error: "Invalid task plan: " + (validation.diagnostic ?? "validation failed"), failure: "schema" }
  }
  return { track: true, plan: validation.plan }
}

export interface AdministrativeRepair {
  revision: number
  repaired: string[]
  unrepaired: { taskId: string; reason: string }[]
}

/**
 * Repairs an active plan that already contains administrative criteria, without restarting the investigation. Only the
 * offending criteria are removed, under the same plan ID and item IDs, at the next revision. Item status, versions,
 * observations, and verification are not touched, because synchronization keeps them. A task whose title or description
 * is administrative, or that would be left with no criteria, is reported for a Feedback replan and left unchanged.
 */
export const reconcileAdministrativeCriteria = async (repository: FeedbackPlanRepository, scope: TodoWriteRequest): Promise<AdministrativeRepair | undefined> => {
  const stored = await repository.getIntentTaskPlan(scope)
  if (!stored) return undefined
  const offending = findAdministrativeClauses(stored)
  if (!offending.length) return undefined
  const paths = new Set(offending.map((clause) => clause.path))
  const unrepaired: AdministrativeRepair["unrepaired"] = []
  const repairedTasks = new Map<string, IntentTaskPlan["tasks"][number]>()
  stored.tasks.forEach((task, index) => {
    if (paths.has(`tasks[${index}].title`) || paths.has(`tasks[${index}].description`)) {
      unrepaired.push({ taskId: task.id, reason: "its title or description directs administrative TODO work, so Feedback must replan it" })
      return
    }
    const kept = task.acceptanceCriteria.filter((_, position) => !paths.has(`tasks[${index}].acceptanceCriteria[${position}]`))
    if (kept.length === task.acceptanceCriteria.length) return
    if (!kept.length) {
      unrepaired.push({ taskId: task.id, reason: "removing its administrative criteria would leave none, so Feedback must replan it" })
      return
    }
    repairedTasks.set(task.id, { ...task, acceptanceCriteria: kept })
  })
  if (!repairedTasks.size) {
    for (const item of unrepaired) logger.warn(`[Feedback] TODO ${item.taskId} still has administrative instructions: ${item.reason}.`)
    return { revision: stored.revision, repaired: [], unrepaired }
  }
  const revision = stored.revision + 1
  const next: IntentTaskPlan = { ...stored, revision, tasks: stored.tasks.map((task) => repairedTasks.get(task.id) ?? task) }
  await repository.synchronizeIntentPlan(scope, next, { source: "feedback", goal: stored.goal, repair: "administrative-criteria" })
  const repaired = [...repairedTasks.keys()]
  logger.info(`[Feedback] Repaired plan ${stored.planId} to revision ${revision}: removed administrative criteria from ${repaired.join(", ")}.`)
  for (const item of unrepaired) logger.warn(`[Feedback] TODO ${item.taskId} still has administrative instructions: ${item.reason}.`)
  return { revision, repaired, unrepaired }
}

/** Parses a planning reply. A reply that stopped at the output limit is reported as such, never repaired. */
export const parseFeedbackPlanResponse = (reply: string | RoleReply | undefined, objective = ""): FeedbackPlanParse => {
  const parsed = parseFeedbackPlanBody(reply, objective)
  if ("error" in parsed && typeof reply === "object" && reply.finishReason === "length") {
    return { error: OUTPUT_LIMIT_MESSAGE, failure: "output-limit" }
  }
  return parsed
}

export const CHILD_TODO_PROTOCOL =
  "You review one proposed child TODO for the task plan Twinny executes. The agent executing the plan wants to add the proposed child under the parent TODO shown. " +
  "Return exactly one valid JSON object, with no prose or Markdown fences, with keys decision, item_id, title, details, parent_id, and instruction. " +
  "decision is one of: accepted (add the child as proposed), existing_task (a TODO in plan_items or existing_children already covers the work; set item_id to it), " +
  "revised (add the child with a narrower or corrected title, details, or parent_id; parent_id must name a TODO in the plan), " +
  "rejected (the work is unnecessary, out of scope, or is planning-system administration), or needs_clarification (the proposal is too broad; the instruction says how to narrow it). " +
  "Child TODOs must be concrete steps that serve the goal, justified by genuinely new work rather than by an administrative step. Reject or revise any child that only manages, records, or updates TODOs. " +
  "instruction is one short sentence telling the executing agent what to do next. Use null for item_id, title, details, and parent_id when they do not apply."

export type ChildTodoParse = { ok: true; decision: ChildTodoDecision } | { ok: false; error: string }

const CHILD_DECISION_KINDS = new Set<ChildTodoDecisionKind>(["accepted", "existing_task", "revised", "rejected", "needs_clarification"])
const CHILD_RESPONSE_KEYS = new Set(["decision", "item_id", "title", "details", "parent_id", "instruction"])
const MAX_CHILD_INSTRUCTION = 500

/** Validates a child review reply against the plan the reviewer saw. Only the schema and plan membership are checked here; the repository checks authority. */
export const parseChildTodoDecision = (reply: string | RoleReply | undefined, context: ChildTodoContext): ChildTodoParse => {
  if (reasoningOnly(reply)) return { ok: false, error: "The provider returned reasoning but no answer." }
  const { value, error } = extractJsonObject(replyText(reply))
  if (!value) return { ok: false, error: error ?? "The provider response was not valid JSON." }
  const unexpected = Object.keys(value).filter((key) => !CHILD_RESPONSE_KEYS.has(key))
  if (unexpected.length) return { ok: false, error: "Unexpected keys: " + unexpected.join(", ") + "." }
  const { decision } = value
  if (typeof decision !== "string" || !CHILD_DECISION_KINDS.has(decision as ChildTodoDecisionKind)) {
    return { ok: false, error: "decision must be accepted, existing_task, revised, rejected, or needs_clarification." }
  }
  for (const key of ["item_id", "title", "details", "parent_id", "instruction"]) {
    const field = value[key]
    if (field !== undefined && field !== null && typeof field !== "string") return { ok: false, error: `${key} must be a string or null.` }
  }
  const text = (key: string) => {
    const field = value[key]
    return typeof field === "string" && field.trim() ? field.trim() : undefined
  }
  const kind = decision as ChildTodoDecisionKind
  const instruction = text("instruction")
  if (!instruction) return { ok: false, error: "instruction must be a non-empty string." }
  const itemId = text("item_id")
  const title = text("title")
  const details = text("details")
  const parentId = text("parent_id")
  const planIds = new Set([context.parent.id, ...context.planItems.map((item) => item.id), ...context.children.map((child) => child.itemId)])
  if (kind === "existing_task" && (!itemId || !planIds.has(itemId))) return { ok: false, error: "existing_task must set item_id to a TODO listed in the plan." }
  if (kind === "revised" && !title && !details && !parentId) return { ok: false, error: "revised must change title, details, or parent_id." }
  if (kind === "revised" && parentId && !planIds.has(parentId)) return { ok: false, error: "parent_id must name a TODO listed in the plan." }
  if (title && title.length > 500) return { ok: false, error: "title must be 500 characters or fewer." }
  if (kind === "accepted" || kind === "revised") {
    for (const [key, value] of [["title", title], ["details", details]] as const) {
      if (value && isAdministrativeChildText(value, context.goal)) {
        return { ok: false, error: `${key} is TODO administration, not concrete work; name the code, behavior, or fact the child delivers.` }
      }
    }
  }
  return {
    ok: true,
    decision: {
      decision: kind,
      ...(kind === "existing_task" ? { itemId } : {}),
      ...(kind === "accepted" || kind === "revised" ? { title, details, parentId } : {}),
      instruction: instruction.slice(0, MAX_CHILD_INSTRUCTION)
    }
  }
}

const childReviewPrompt = (proposal: ChildTodoProposal, context: ChildTodoContext) =>
  "Review this proposed child TODO against the plan. Reply with the JSON object only.\n" +
  JSON.stringify({
    goal: context.goal,
    plan_revision: context.revision,
    parent: {
      item_id: context.parent.id,
      title: context.parent.title,
      details: context.parent.details ?? null,
      status: context.parent.status,
      acceptance: context.parent.acceptance,
      depends_on: context.parent.dependsOn
    },
    existing_children: context.children.map((child) => ({ item_id: child.itemId, title: child.title, status: child.status })),
    plan_items: context.planItems.map((item) => ({ item_id: item.id, title: item.title, status: item.status })),
    proposed_child: { title: proposal.title, details: proposal.details ?? null, reason: proposal.reason, priority: proposal.priority }
  }, null, 2)

/**
 * Settles with the provider's answer, or rejects as soon as the signal aborts,
 * so a provider that ignores cancellation cannot hold up Stop.
 */
const untilAborted = <T>(work: PromiseLike<T>, signal: AbortSignal): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason)
    // Subscribe first, so a rejection of the work after Stop is always handled.
    Promise.resolve(work)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", stop))
    if (signal.aborted) stop()
    else signal.addEventListener("abort", stop, { once: true })
  })

export interface ChildTodoReviewerDeps {
  resolve: RoleResolver
  timeoutMs?: number
}

/**
 * Reviews an agent's child TODO proposal on the Feedback provider. It is the
 * same provider and inference path as planning, not a second planning engine.
 * Every failure returns `ok: false`, which the caller must treat as no authority to mutate.
 */
export class ChildTodoReviewer {
  constructor(private readonly deps: ChildTodoReviewerDeps) {}

  async review(proposal: ChildTodoProposal, context: ChildTodoContext, signal?: AbortSignal): Promise<ChildTodoReviewOutcome> {
    const cancelled: ChildTodoReviewOutcome = { ok: false, error: "The child TODO review was cancelled." }
    if (signal?.aborted) return cancelled
    if ([proposal.title, proposal.details].some((text) => text !== undefined && isAdministrativeChildText(text, context.goal))) {
      return { ok: false, error: "The proposed child is TODO administration, not concrete work; name the code, behavior, or fact the child delivers." }
    }
    const resolution = await Promise.resolve(this.deps.resolve()).catch((error): RoleResolution => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }))
    if (!resolution.ok) return { ok: false, error: resolution.error }
    const { endpoint } = resolution
    const trace = createInferenceTrace({ operationKind: "feedback" })
    trace.provider = endpoint.provider
    const controller = new AbortController()
    const forwardAbort = () => controller.abort(signal?.reason)
    signal?.addEventListener("abort", forwardAbort, { once: true })
    const clear = abortAfter(controller, this.deps.timeoutMs ?? DEFAULT_FEEDBACK_PLAN_TIMEOUT_MS, "The child TODO review timed out.")
    try {
      const user = childReviewPrompt(proposal, context)
      const ask = (prompt: string) =>
        untilAborted(endpoint.infer({ system: CHILD_TODO_PROTOCOL, user: prompt, json: true }, { signal: controller.signal, trace }), controller.signal)
      let reply = await ask(user)
      if (signal?.aborted) return cancelled
      let parsed = parseChildTodoDecision(reply, context)
      if (!parsed.ok) {
        reply = await ask(correctionPrompt(user, parsed.error))
        if (signal?.aborted) return cancelled
        parsed = parseChildTodoDecision(reply, context)
      }
      if (!parsed.ok) return { ok: false, error: "Feedback could not review the child TODO: " + parsed.error }
      return { ok: true, decision: parsed.decision }
    } catch (error) {
      if (signal?.aborted) return cancelled
      const message = error instanceof Error ? error.message : String(error)
      inferenceEvent("feedback.child_todo_failed", { operation_id: trace.operationId, provider: endpoint.provider, model: endpoint.model }, "warn")
      return { ok: false, error: "Feedback could not review the child TODO: " + message }
    } finally {
      clear()
      signal?.removeEventListener("abort", forwardAbort)
    }
  }
}

const correctionPrompt = (user: string, error: string) =>
  `${user}\n\nYour previous reply was rejected: ${error} Return only one corrected JSON object that matches the schema, with no other text.`

/** Logs what the provider reported, with a bounded excerpt only at debug level (which redacts). */
const diagnose = (
  trace: InferenceTraceContext,
  endpoint: RoleEndpoint,
  attempt: "initial" | "correction",
  reply: string | RoleReply | undefined,
  parsed: FeedbackPlanParse
) => {
  const object = typeof reply === "object" ? reply : undefined
  const text = replyText(reply)
  const failed = "error" in parsed
  inferenceEvent(
    failed ? "feedback.response_invalid" : "feedback.response_parsed",
    {
      operation_id: trace.operationId,
      provider: endpoint.provider,
      model: endpoint.model,
      attempt,
      stream_completed: reply !== undefined,
      finish_reason: object?.finishReason ?? "unknown",
      content_chars: text.length,
      reasoning_chars: object?.reasoningChars ?? 0,
      ...("error" in parsed ? { failure: parsed.failure, offset: parsed.offset } : {})
    },
    failed ? "warn" : "debug"
  )
  if (text) logger.debug(`[Feedback] ${attempt} response excerpt: ${JSON.stringify(text.slice(0, EXCERPT_CHARS))}`)
}

export interface FeedbackPlanRepository {
  getIntentTaskPlan(request: TodoListRequest): Promise<IntentTaskPlan | undefined>
  intentPlanClosed(request: TodoListRequest): Promise<boolean>

  synchronizeIntentPlan(request: TodoWriteRequest, candidate: unknown, intentResult: unknown): Promise<TodoListSnapshot>
}

export type FeedbackPlanStatus =
  | "planned"
  | "untracked"
  | "disabled"
  | "unavailable"
  | "failed"
  | "cancelled"
  | "stale"

export interface FeedbackPlanOutcome {
  status: FeedbackPlanStatus
  error?: string
  snapshot?: TodoListSnapshot
}

export interface FeedbackPlannerDeps {
  enabled: () => boolean
  resolve: RoleResolver
  repository: () => FeedbackPlanRepository | undefined
  onSnapshot?: (snapshot: TodoListSnapshot) => void
  /** The planning state the TODO panel shows; only the newest planning reports. */
  onStatus?: (status: TodoFeedbackStatus) => void
  /** A visible report of a failure; the chat itself carries on. */
  onFailure?: (message: string) => void
  timeoutMs?: number
  describeError?: (error: unknown) => string
}

interface ActivePlanning {
  sequence: number
  scope: TodoWriteRequest
  controller: AbortController
  trace: InferenceTraceContext
  done: Promise<FeedbackPlanOutcome>
}

/**
 * Plans (or revises) the conversation's native TODO plan from an ordinary
 * user message, on the Feedback provider, alongside the chat reply rather
 * than ahead of it. Only the newest planning for a conversation may write:
 * a superseded, cancelled or late answer is discarded.
 */
export class FeedbackPlanner {
  private _sequence = 0
  private _active?: ActivePlanning
  private _last?: { scope: TodoWriteRequest; prompt: string }

  constructor(private readonly _deps: FeedbackPlannerDeps) {}

  /** The planning in flight, settled (never rejected), if any. */
  public pending(): Promise<FeedbackPlanOutcome> | undefined {
    return this._active?.done
  }

  /** Runs the last ordinary message's planning again, e.g. after a provider failure. */
  public retry(conversationId: string): Promise<FeedbackPlanOutcome> {
    const last = this._last
    if (!last || last.scope.conversationId !== conversationId) return Promise.resolve({ status: "untracked" })
    // A retry while this conversation is already planning joins that planning rather than superseding it.
    const active = this._active
    if (active && !active.controller.signal.aborted && active.scope.conversationId === conversationId) return active.done
    return this.start(last.scope, last.prompt)
  }

  public start(scope: TodoWriteRequest, prompt: string, parentOperationId?: string): Promise<FeedbackPlanOutcome> {
    if (!this._deps.enabled()) return Promise.resolve({ status: "disabled" })
    const repository = this._deps.repository()
    if (!repository) return Promise.resolve({ status: "unavailable", error: "TODO storage is unavailable." })
    const request = prompt.trim()
    if (!request) {
      logger.debug("[Feedback] planning not started: the message is empty")
      return Promise.resolve({ status: "untracked" })
    }
    this.cancel("superseded")
    const sequence = ++this._sequence
    const controller = new AbortController()
    const trace = createInferenceTrace({
      operationKind: "feedback",
      ...(parentOperationId ? { parentRequestId: parentOperationId } : {})
    })
    const active = { sequence, scope, controller, trace } as ActivePlanning
    this._last = { scope, prompt: request }
    active.done = this.plan(active, scope, request, repository).then((outcome) => {
      if (this._active === active) this.reportStatus(scope.conversationId, outcome)
      return outcome
    })
    this._active = active
    this._deps.onStatus?.({ conversationId: scope.conversationId, state: "planning" })
    void active.done.finally(() => {
      if (this._active === active) this._active = undefined
    })
    return active.done
  }

  /** Only the newest planning reports; superseded and cancelled runs stay silent. */
  private reportStatus(conversationId: string, outcome: FeedbackPlanOutcome) {
    if (outcome.status === "planned") this._deps.onStatus?.({ conversationId, state: "planned" })
    else if (outcome.status === "failed" || outcome.status === "unavailable") this._deps.onStatus?.({ conversationId, state: "failed", error: outcome.error })
    else this._deps.onStatus?.({ conversationId, state: "idle" })
  }

  /** Cancels the planning in flight; its answer, if it still comes, is dropped. */
  public cancel(reason: "user" | "host" | "superseded" | "conversation-changed" = "user") {
    const active = this._active
    if (!active || active.controller.signal.aborted) return
    cancelInferenceOperation(active.trace, reason === "host" ? "host" : "user", "feedback-plan:" + reason)
    active.controller.abort(new Error("Feedback planning cancelled: " + reason))
  }

  private isCurrent(active: ActivePlanning) {
    return this._sequence === active.sequence && !active.controller.signal.aborted
  }

  private report(message: string) {
    logger.warn("[Feedback] " + message)
    this._deps.onFailure?.(message)
  }

  private async plan(
    active: ActivePlanning,
    scope: TodoWriteRequest,
    request: string,
    repository: FeedbackPlanRepository
  ): Promise<FeedbackPlanOutcome> {
    const { controller, trace } = active
    const resolution = await Promise.resolve(this._deps.resolve()).catch((error): { ok: false; error: string } => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }))
    if (!resolution.ok) {
      if (this.isCurrent(active)) this.report(resolution.error)
      return { status: "unavailable", error: resolution.error }
    }
    const { endpoint } = resolution
    trace.provider = endpoint.provider
    inferenceEvent("feedback.started", { operation_id: trace.operationId, parent_operation_id: trace.parentRequestId, conversation_id: scope.conversationId, provider: endpoint.provider })
    inferenceEvent("operation.started", {
      operation_id: trace.operationId,
      kind: "feedback",
      phase: "plan",
      parent_operation_id: trace.parentRequestId,
      provider: endpoint.provider,
      model: endpoint.model,
      conversation_id: scope.conversationId
    })
    const timeoutMs = this._deps.timeoutMs ?? DEFAULT_FEEDBACK_PLAN_TIMEOUT_MS
    const clear = abortAfter(controller, timeoutMs, `Feedback planning timed out after ${Math.round(timeoutMs / 1000)} seconds.`)
    let state = "completed"
    try {
      const existing = await repository.getIntentTaskPlan(scope)
      // A finished plan is not offered for revision: the request gets its own planning decision.
      const closed = !!existing && await repository.intentPlanClosed(scope)
      const user = !existing
        ? request
        : closed
          ? `${request}\n\nThe earlier TODO plan is complete: every task in it is finished. Plan this request on its own; it needs a new plan only if it asks for tracked work.`
          : `${request}\n\nExisting TODO plan (revise only if the request changes the work):\n${JSON.stringify(existing)}`
      const ask = (prompt: string) =>
        untilAborted(endpoint.infer({ system: FEEDBACK_PLAN_PROTOCOL, user: prompt, json: true }, { signal: controller.signal, trace }), controller.signal)
      let reply = await ask(user)
      if (controller.signal.reason instanceof RoleTimeoutError) throw controller.signal.reason
      if (!this.isCurrent(active)) {
        state = "stale"
        inferenceEvent("feedback.late_response_discarded", { operation_id: trace.operationId }, "warn")
        return { status: "stale" }
      }
      let parsed = parseFeedbackPlanResponse(reply, request)
      diagnose(trace, endpoint, "initial", reply, parsed)
      // Bounded recovery: one correction with the same provider and request. Output-limit stops are not retried.
      if ("error" in parsed && parsed.failure !== "output-limit") {
        this._deps.onStatus?.({ conversationId: scope.conversationId, state: "retrying" })
        reply = await ask(correctionPrompt(user, parsed.error))
        if (controller.signal.reason instanceof RoleTimeoutError) throw controller.signal.reason
        if (!this.isCurrent(active)) {
          state = "stale"
          inferenceEvent("feedback.late_response_discarded", { operation_id: trace.operationId }, "warn")
          return { status: "stale" }
        }
        parsed = parseFeedbackPlanResponse(reply, request)
        diagnose(trace, endpoint, "correction", reply, parsed)
      }
      if ("error" in parsed) {
        state = "invalid-response"
        const message = "Feedback could not plan TODOs: " + parsed.error
        this.report(message)
        return { status: "failed", error: message }
      }
      if (!parsed.track) {
        state = "untracked"
        logger.debug("[Feedback] request needs no TODO plan (track:false)")
        return { status: "untracked" }
      }
      const synced = await this.synchronize(repository, scope, parsed.plan, existing, active)
      if (!synced) {
        state = "stale"
        return { status: "stale" }
      }
      this._deps.onSnapshot?.(synced.snapshot)
      const replaced = synced.replaced ? `; replaces completed plan ${synced.replaced}` : ""
      logger.info(`[Feedback] TODO plan ${synced.planId} synchronized with ${parsed.plan.tasks.length} task(s)${replaced}`)
      return { status: "planned", snapshot: synced.snapshot }
    } catch (error) {
      const reason = controller.signal.reason
      if (reason instanceof RoleTimeoutError) {
        state = "timeout"
        this.report(reason.message)
        return { status: "failed", error: reason.message }
      }
      if (controller.signal.aborted || isAbortError(error)) {
        if (this._sequence !== active.sequence) {
          state = "stale"
          return { status: "stale" }
        }
        state = "cancelled"
        return { status: "cancelled" }
      }
      state = "failed"
      const message = "Feedback provider failed: " + redact(this._deps.describeError?.(error) ?? (error instanceof Error ? error.message : String(error)))
      this.report(message)
      return { status: "failed", error: message }
    } finally {
      clear()
      finishInferenceOperation(trace, state, { kind: "feedback", phase: "plan" })
      const outcome = { operation_id: trace.operationId, parent_operation_id: trace.parentRequestId, conversation_id: scope.conversationId, state }
      if (state === "failed" || state === "invalid-response" || state === "timeout") inferenceEvent("feedback.failed", outcome, "warn")
      else if (state !== "cancelled") inferenceEvent("feedback.completed", outcome)
    }
  }

  /**
   * Writes the plan under the stored plan's identity. A model that renames
   * the plan or forgets to bump the revision is corrected deterministically
   * here rather than by asking it again.
   */
  private async synchronize(
    repository: FeedbackPlanRepository,
    scope: TodoWriteRequest,
    proposed: IntentTaskPlan,
    seen: IntentTaskPlan | undefined,
    active: ActivePlanning
  ): Promise<{ snapshot: TodoListSnapshot; planId: string; replaced?: string } | undefined> {
    const stored = await repository.getIntentTaskPlan(scope)
    // Someone else revised the plan while this one was being written.
    if (stored && seen && stored.revision !== seen.revision) return undefined
    if (!this.isCurrent(active)) return undefined
    const result = { source: "feedback", goal: proposed.goal }
    // A completed plan is replaced by the new work under its own planId; an open plan keeps its identity.
    const replacing = !!stored && await repository.intentPlanClosed(scope)
    const plan = !stored
      ? proposed
      : replacing
        ? { ...proposed, revision: Math.max(proposed.revision, stored.revision + 1) }
        : { ...proposed, planId: stored.planId, revision: Math.max(proposed.revision, stored.revision) }
    try {
      const snapshot = await repository.synchronizeIntentPlan(scope, plan, result)
      return { snapshot, planId: plan.planId, replaced: replacing ? stored?.planId : undefined }
    } catch (error) {
      if (!(error instanceof TodoConflictError) || !stored) throw error
      const snapshot = await repository.synchronizeIntentPlan(scope, { ...plan, revision: stored.revision + 1 }, result)
      return { snapshot, planId: plan.planId, replaced: replacing ? stored.planId : undefined }
    }
  }

}

export type FeedbackRetryOutcome = FeedbackPlanOutcome | { status: "busy" }

export interface FeedbackGateDeps {
  planner: FeedbackPlanner
  /** True while a turn runs or is being prepared; a retry must not plan beside it. */
  busy: () => boolean
  /** Explains, in the main conversation, why a message did not start. */
  notify: (message: string) => void
}

interface HeldTurn {
  conversationId: string
  dispatch: () => Promise<string | undefined>
}

const PROCEED: FeedbackPlanStatus[] = ["planned", "untracked", "disabled"]

const blockedMessage = (outcome: FeedbackPlanOutcome) =>
  `The agent did not start: Feedback could not plan this request. ${outcome.error ?? "Planning did not finish."} ` +
  "Retry planning from the TODO panel, or turn Feedback off to run without it."

/**
 * Holds an agent turn behind Feedback planning. The turn starts only once its
 * message has a valid plan synchronized, or needs none. A failed or cancelled
 * plan keeps the turn held; Retry plans it again and starts it only after that
 * succeeds, and never while another turn is running.
 */
export class FeedbackGate {
  private _held?: HeldTurn
  private _retrying?: { conversationId: string; done: Promise<FeedbackRetryOutcome> }
  private _epoch = 0

  constructor(private readonly _deps: FeedbackGateDeps) {}

  public async admit(
    conversationId: string,
    planning: Promise<FeedbackPlanOutcome> | undefined,
    dispatch: () => Promise<string | undefined>
  ): Promise<string | undefined> {
    if (!planning) return dispatch()
    const epoch = this._epoch
    const outcome = await planning
    // A superseded message is owned by the newer message's own planning.
    if (outcome.status === "stale") return undefined
    if (PROCEED.includes(outcome.status)) {
      this._held = undefined
      return dispatch()
    }
    if (epoch !== this._epoch) return undefined
    this._held = { conversationId, dispatch }
    if (outcome.status !== "cancelled") this._deps.notify(blockedMessage(outcome))
    return undefined
  }

  /** Plans the held message again. Concurrent retries share one planning. */
  public retry(conversationId: string): Promise<FeedbackRetryOutcome> {
    const inFlight = this._retrying
    if (inFlight) return inFlight.conversationId === conversationId ? inFlight.done : Promise.resolve({ status: "busy" })
    const done = this.replan(conversationId).finally(() => {
      this._retrying = undefined
    })
    this._retrying = { conversationId, done }
    return done
  }

  private async replan(conversationId: string): Promise<FeedbackRetryOutcome> {
    if (this._deps.busy()) return { status: "busy" }
    const outcome = await this._deps.planner.retry(conversationId)
    const held = this._held
    if (!PROCEED.includes(outcome.status) || !held || held.conversationId !== conversationId) return outcome
    if (this._deps.busy()) return { status: "busy" }
    this._held = undefined
    void held.dispatch().catch((error: unknown) => {
      logger.error("[Feedback] held turn could not start: " + (error instanceof Error ? error.message : String(error)))
    })
    return outcome
  }

  /** Forgets the held turn, e.g. when its conversation is reset. */
  public clear() {
    this._epoch++
    this._held = undefined
  }
}
