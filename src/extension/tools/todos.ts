import { logger } from "../../common/logger"
import { assessAcceptedFacts, type CurrentSourceReader, factNamedBy, resolveAcceptedFacts } from "../todos/feedback"
import { TodoRepository } from "../todos/repository"
import { ChildTodoOutcome, ChildTodoProposal, ChildTodoReview, TodoActor, TodoItem, TodoPriority, TodoStatus, TodoWriteRequest } from "../todos/types"

import { Tool, ToolContext, ToolResult } from "./workspace"

export interface TodoToolOptions {
  /** Feedback review of agent-proposed children under an authoritative plan. Absent when Feedback is disabled. */
  review?: ChildTodoReview
  /** Whether the user's own message directly asked for TODO creation. Read from trusted conversation state. */
  isUserAuthorized?: () => boolean
  /** Reads the authoritative workspace source, so accepted facts can be judged current or historical. */
  readCurrentSource?: CurrentSourceReader
  /** Host-generated execution that performs these calls. Absent outside an execution, so no use is counted. */
  executionId?: string
}

/**
 * Counts a successful, current use of accepted facts for the project ranking. Usage is best-effort: a failed write is logged
 * and never fails the tool call that used the evidence.
 */
const recordEvidenceUse = (
  repository: TodoRepository,
  scope: TodoWriteRequest,
  options: TodoToolOptions,
  kind: "lookup" | "reuse",
  factIds: string[]
): Promise<void> => {
  if (!options.executionId || !factIds.length) return Promise.resolve()
  return repository.recordEvidenceUse(scope, { kind, executionId: options.executionId, factIds })
    .then(() => undefined, (error: unknown) => {
      logger.warn(`[Evidence] could not record ${kind} use: ${error instanceof Error ? error.message : String(error)}`)
    })
}

const result = (value: unknown, summary: string): ToolResult => ({
  output: JSON.stringify(value),
  summary
})

const errorResult = (error: unknown): ToolResult => ({
  output: `Native TODO tool error: ${error instanceof Error ? error.message : String(error)}`,
  summary: "native TODO tool failed",
  failed: true
})

const NEXT_ACTION: Record<ChildTodoOutcome["decision"], string> = {
  accepted: "continue",
  revised: "continue",
  existing_task: "use_existing_task",
  rejected: "do_not_create_task",
  needs_clarification: "propose_narrower_task"
}

const childResult = (outcome: ChildTodoOutcome): ToolResult => result({
  ok: true,
  result: outcome.decision,
  ...(outcome.itemId ? { item_id: outcome.itemId } : {}),
  parent_id: outcome.parentId,
  plan_revision: outcome.planRevision,
  next_action: NEXT_ACTION[outcome.decision],
  instruction: outcome.instruction
}, `Feedback decided: ${outcome.decision}`)

const existingTaskResult = (match: { item: TodoItem; matchedBy: string; planRevision: number }): ToolResult => result({
  ok: true,
  result: "existing_task",
  item_id: match.item.id,
  title: match.item.title,
  plan_revision: match.planRevision,
  matched_by: match.matchedBy,
  next_action: "use_existing_task",
  instruction: "An equivalent TODO already exists in the plan; use it instead of creating another."
}, "matched an existing plan TODO")

const feedbackUnavailable = (parentId: string, reason: string): ToolResult => ({
  output: JSON.stringify({
    ok: false,
    result: "feedback_unavailable",
    parent_id: parentId,
    next_action: "do_not_assume_created",
    instruction: `Feedback could not review this proposal (${reason}), so no TODO was created. Do not assume the task exists. Continue with the current plan, or retry this exact request later with the same request_id.`
  }),
  summary: "Feedback could not review a proposed TODO; nothing was created",
  failed: true
})

const priorities = new Set<TodoPriority>(["low", "normal", "high", "urgent"])
const statuses = new Set<TodoStatus>(["pending", "in_progress", "in_review", "blocked", "completed", "cancelled"])
const EVIDENCE_LOOKUP_LIMIT = 20

const requestId = (args: Record<string, string>) => {
  const value = args.request_id?.trim()
  if (!value) throw new Error("request_id is required; generate a non-empty unique ID and reuse it only when retrying this exact mutation")
  return value
}

const evidenceResult = (value: string): "observed" | "passed" | "failed" => {
  switch (value.trim().toLowerCase()) {
    case "observed":
      return "observed"
    case "passed":
    case "success":
    case "successful":
    case "pass":
    case "ok":
      return "passed"
    case "failed":
    case "failure":
    case "failing":
    case "fail":
      return "failed"
    default:
      throw new Error("Evidence result must be observed, passed, or failed (success/successful/pass and failure/failing/fail are also accepted)")
  }
}

export const todoTools = (
  repository: TodoRepository,
  scope: TodoWriteRequest,
  onChanged: () => void,
  options: TodoToolOptions = {}
): Tool[] => [
  {
    name: "twinny_todo_list",
    description: "Read the canonical native TODO list for the current Twinny conversation, or read-only another conversation's list in this project.",
    parameters: [
      { name: "include_completed", description: "Include completed and cancelled tasks (true or false).", optional: true },
      { name: "conversation_id", description: "Another conversation in this project whose list to read. Read-only; omit for the current conversation.", optional: true }
    ],
    guidance: "Use this before creating or changing tasks. The conversation and project scope are supplied by Twinny and cannot be changed by the model. For every mutation, generate a non-empty unique request_id and reuse it only for an exact retry.",
    readOnly: true,
    async run(args) {
      try {
        const includeCompleted = args.include_completed === "true"
        const other = args.conversation_id?.trim()
        if (other && other !== scope.conversationId) {
          const snapshot = await repository.readList({ ...scope, conversationId: other, includeCompleted })
          if (!snapshot) throw new Error("No TODO list exists for that conversation in this project")
          return result({ ...snapshot, read_only: true }, "read another conversation's TODO list read-only")
        }
        return result(await repository.getList({ ...scope, includeCompleted }), "read the native TODO list")
      } catch (error) {
        return errorResult(error)
      }
    }
  },
  {
    name: "twinny_todo_get",
    description: "Read one TODO and its evidence from the current Twinny conversation.",
    parameters: [{ name: "item_id", description: "ID of the TODO item." }],
    readOnly: true,
    async run(args) {
      try {
        if (!args.item_id) throw new Error("item_id is required")
        return result(await repository.getItem(scope, args.item_id), "read a native TODO")
      } catch (error) {
        return errorResult(error)
      }
    }
  },
  {
    name: "twinny_evidence_lookup",
    description: "Look up source facts the host already accepted from trusted observations in any conversation of this project, with their freshness and originating conversation. Facts are read-only project knowledge; a fact from another conversation can be cited but never changed from here.",
    parameters: [
      { name: "symbol", description: "Exact symbol name, such as readFile.", optional: true },
      { name: "path", description: "Workspace-relative source path, such as src/extension/tools/workspace.ts.", optional: true }
    ],
    guidance: "Call this before searching or reading source for a fact that a previous task may already have established. A current fact is proven: cite its observation_id in your completion claim instead of searching again, or attach it to the TODO with twinny_todo_evidence using accepted_fact_id set to its evidence_id. A historical fact no longer matches the source; read only the listed lines again. Provide at least one of symbol or path.",
    readOnly: true,
    async run(args) {
      try {
        const symbol = args.symbol?.trim() || undefined
        const path = args.path?.trim() || undefined
        if (!symbol && !path) throw new Error("symbol or path is required")
        const facts = (await repository.listAcceptedEvidence(scope, { symbol, path })).slice(0, EVIDENCE_LOOKUP_LIMIT)
        const statuses = await assessAcceptedFacts(facts, options.readCurrentSource)
        const resolution = resolveAcceptedFacts(statuses)
        logger.debug(`[Evidence] lookup project=${scope.projectFingerprint.slice(0, 12)} symbol=${symbol ?? "-"} path=${path ?? "-"} matches=${statuses.length} resolution=${resolution}`)
        if (!statuses.length) logger.trace("[Evidence] lookup found no accepted fact for this project; facts are recorded only after a deterministic proof, so a missing fact means none was proven yet")
        await recordEvidenceUse(repository, scope, options, "lookup", statuses.filter((status) => status.freshness === "current").map((status) => status.fact.id))
        const found = statuses.map(({ fact, freshness, reason }) => ({
          evidence_id: fact.id,
          symbol: fact.symbol,
          tool_name: fact.toolName,
          ...(fact.registeredTool ? { registered_tool: fact.registeredTool } : {}),
          path: fact.path,
          start_line: fact.startLine,
          end_line: fact.endLine,
          source_hash: fact.sourceHash,
          observation_id: fact.observationId,
          conversation_id: fact.conversationId,
          item_id: fact.itemId,
          plan_revision: fact.planRevision,
          accepted_at: fact.acceptedAt,
          freshness,
          ...(reason ? { reason } : {}),
          ...(freshness !== "current" && !fact.supersededBy ? { refresh: `read ${fact.path} lines ${fact.startLine}-${fact.endLine} again` } : {})
        }))
        return result({ ok: true, resolution, facts: found, total: found.length, limit: EVIDENCE_LOOKUP_LIMIT }, `found ${found.length} accepted evidence fact(s), resolution ${resolution}`)
      } catch (error) {
        return errorResult(error)
      }
    }
  },
  {
    name: "twinny_todo_create",
    description: "Create a task in Twinny's canonical native TODO list for this conversation. When an authoritative plan exists, this proposes a child task: give todo_parent_id (an existing plan TODO), details, and reason, and Feedback decides whether it is created. The result is one of created, existing_task, revised, rejected, needs_clarification, or feedback_unavailable, with next_action. An existing_task or rejected result is a normal outcome, not a failure. Create only genuinely new work.",
    parameters: [
      { name: "title", description: "Short task title." },
      { name: "request_id", description: "Generate a non-empty unique ID; reuse it only when retrying the exact same mutation." },
      { name: "todo_parent_id", description: "Existing plan TODO this task belongs under. Required when an authoritative plan exists.", optional: true },
      { name: "details", description: "Task details and acceptance notes. Required when an authoritative plan exists.", optional: true },
      { name: "reason", description: "Why this child task is needed for the parent. Required when an authoritative plan exists.", optional: true },
      { name: "priority", description: "low, normal, high, or urgent.", optional: true }
    ],
    schema: {
      type: "object",
      properties: {
        title: { type: "string", maxLength: 500 },
        request_id: { type: "string", maxLength: 200, description: "Generate a non-empty unique ID; reuse only for an exact retry." },
        todo_parent_id: { type: "string", description: "Existing plan TODO ID. Required when an authoritative plan exists." },
        details: { type: "string", maxLength: 8000, description: "Required when an authoritative plan exists." },
        reason: { type: "string", maxLength: 2000, description: "Required when an authoritative plan exists." },
        priority: { type: "string", enum: ["low", "normal", "high", "urgent"] }
      },
      required: ["title", "request_id"],
      additionalProperties: false
    },
    async run(args, context?: ToolContext) {
      try {
        const priority = args.priority as TodoPriority | undefined
        if (priority && !priorities.has(priority)) throw new Error("Invalid priority")
        const key = requestId(args)
        const parentId = args.todo_parent_id?.trim() || undefined
        if (!(await repository.hasAuthoritativePlan(scope)) || options.isUserAuthorized?.()) {
          const outcome = await repository.createItemOutcome(scope, {
            title: args.title,
            details: args.details,
            parentId,
            priority
          }, key)
          onChanged()
          const { item } = outcome
          return result({
            ok: true,
            result: outcome.reused ? "existing_task" : "created",
            item_id: item.id,
            task_status: item.status,
            version: item.version,
            title: item.title,
            ...(outcome.reused ? { matched_by: outcome.matchedBy } : {}),
            next_action: outcome.reused ? "use_existing_task" : "continue",
            item
          }, outcome.reused ? "matched an existing native TODO" : "created a native TODO")
        }
        if (parentId) await repository.childTodoContext(scope, parentId)
        const existing = await repository.existingTaskFor(scope, args.title, parentId)
        if (existing) return existingTaskResult(existing)
        if (!parentId) throw new Error("todo_parent_id is required: under the authoritative plan, add work only beneath an existing plan TODO")
        if (!args.details?.trim()) throw new Error("details is required when an authoritative plan exists")
        if (!args.reason?.trim()) throw new Error("reason is required when an authoritative plan exists")
        const proposal: ChildTodoProposal = {
          parentId,
          title: args.title.trim(),
          details: args.details.trim(),
          reason: args.reason.trim(),
          priority: priority ?? "normal",
          requestId: key
        }
        const known = await repository.childTodoReplay(scope, proposal)
        if (known) return childResult(known)
        const parentContext = await repository.childTodoContext(scope, parentId)
        if (!options.review) return feedbackUnavailable(parentId, "Feedback is disabled")
        const reviewed = await options.review(proposal, parentContext, context?.signal)
        if (context?.signal?.aborted) return { output: "Native TODO tool error: the operation was stopped before Feedback decided; nothing was created", summary: "stopped before a TODO decision", failed: true }
        if (!reviewed.ok) return feedbackUnavailable(parentId, reviewed.error)
        const outcome = await repository.applyChildTodo(scope, proposal, reviewed.decision)
        onChanged()
        return childResult(outcome)
      } catch (error) {
        return errorResult(error)
      }
    }
  },
  {
    name: "twinny_todo_update",
    description: "Update a native TODO with optimistic concurrency. Setting status to completed submits a completion claim, not a final state: the first valid claim moves the TODO to in_review and queues Feedback review; an identical repeat is acknowledged without changes. Submit a claim once. in_review means the claim was received, so do not retry it. Continue other actionable work or finish the turn so Feedback can review. If Feedback rejects a claim, follow its corrective instructions instead of resubmitting an unchanged claim. Only trusted Feedback verification or the user, in the TODO panel, can approve completion. A blocked TODO can be claimed again when its blocker is resolved, or moved back to pending or in_progress.",
    parameters: [
      { name: "item_id", description: "ID of the TODO item." },
      { name: "expected_version", description: "Current item version from twinny_todo_list or twinny_todo_get.", type: "integer" },
      { name: "request_id", description: "Generate a non-empty unique ID; reuse it only when retrying the exact same mutation." },
      { name: "title", description: "Replacement title.", optional: true },
      { name: "details", description: "Replacement details (empty clears details).", optional: true },
      { name: "status", description: "pending, in_progress, in_review, blocked, completed, or cancelled.", optional: true },
      { name: "priority", description: "low, normal, high, or urgent.", optional: true },
      { name: "blocked_reason", description: "Required when setting status to blocked. Must name the specific external condition preventing progress (for example, 'the file is locked by another process'); placeholders such as 'No reason' are rejected.", optional: true }
    ],
    schema: {
      type: "object",
      properties: {
        item_id: { type: "string" },
        expected_version: { type: "integer", minimum: 1 },
        request_id: { type: "string", maxLength: 200, description: "Generate a non-empty unique ID; reuse only for an exact retry." },
        title: { type: "string", maxLength: 500 },
        details: { type: "string", maxLength: 8000 },
        status: { type: "string", enum: [...statuses] },
        priority: { type: "string", enum: [...priorities] },
        blocked_reason: { type: "string", maxLength: 1000 }
      },
      required: ["item_id", "expected_version", "request_id"],
      additionalProperties: false
    },
    async run(args) {
      try {
        const expectedVersion = Number(args.expected_version)
        if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new Error("expected_version must be a positive integer")
        const status = args.status as TodoStatus | undefined
        const priority = args.priority as TodoPriority | undefined
        if (status && !statuses.has(status)) throw new Error("Invalid status")
        if (priority && !priorities.has(priority)) throw new Error("Invalid priority")
        const patch: Record<string, string> = {}
        for (const [source, target] of [["title", "title"], ["details", "details"], ["status", "status"], ["priority", "priority"], ["blocked_reason", "blockedReason"]]) {
          if (args[source] !== undefined) patch[target] = args[source]
        }
        if (status === "completed") {
          const others = Object.keys(patch).filter((key) => key !== "status")
          if (others.length) throw new Error(`A completion claim must not change other fields (${others.join(", ")}); update those in a separate call first`)
          const claim = await repository.claimCompletion(scope, {
            itemId: args.item_id,
            expectedVersion,
            requestId: requestId(args)
          })
          onChanged()
          return result({
            ok: true,
            claim: claim.disposition,
            item_id: claim.item.id,
            task_status: claim.item.status,
            verification: "pending",
            review: claim.review,
            version: claim.item.version,
            retry_required: false,
            next_action: "continue_other_work_or_finish_turn",
            ...(claim.review === "user_approval" ? { note: "This task is not in a Feedback plan; it awaits the user's approval in the TODO panel." } : {})
          }, claim.disposition === "accepted" ? "completion claim accepted; Feedback review is pending" : "completion claim already submitted; no change")
        }
        const item = await repository.updateItem(scope, {
          itemId: args.item_id,
          expectedVersion,
          patch,
          actor: "model" as TodoActor,
          requestId: requestId(args)
        })
        onChanged()
        return result(item, "updated a native TODO")
      } catch (error) {
        return errorResult(error)
      }
    }
  },
  {
    name: "twinny_todo_evidence",
    description: "Attach a bounded evidence note to a native TODO. Model-reported evidence does not itself accept completion.",
    parameters: [
      { name: "item_id", description: "ID of the TODO item." },
      { name: "kind", description: "Evidence kind, such as test, build, observation, or failure." },
      { name: "summary", description: "Short, bounded evidence summary." },
      { name: "result", description: "Use observed when unverified, passed for success, or failed for failure. success/successful/pass and failure/failing/fail are accepted aliases." },
      { name: "request_id", description: "Generate a non-empty unique ID; reuse it only when retrying the exact same mutation." },
      { name: "accepted_fact_id", description: "Optional evidence_id from twinny_evidence_lookup. The host validates the fact and records it as this TODO's evidence, setting kind, summary, and result itself.", optional: true }
    ],
    schema: {
      type: "object",
      properties: {
        item_id: { type: "string" },
        kind: { type: "string", maxLength: 100 },
        summary: { type: "string", maxLength: 2000 },
        result: {
          type: "string",
          enum: ["observed", "passed", "failed"],
          description: "Use observed when unverified, passed for success, or failed for failure. success/successful/pass and failure/failing/fail are accepted aliases."
        },
        request_id: { type: "string", maxLength: 200, description: "Generate a non-empty unique ID; reuse only for an exact retry." },
        accepted_fact_id: { type: "string", maxLength: 200, description: "Optional evidence_id of an accepted fact; the host validates it." }
      },
      required: ["item_id", "kind", "summary", "result", "request_id"],
      additionalProperties: false
    },
    async run(args) {
      try {
        if (args.accepted_fact_id?.trim()) {
          const reference = await acceptedFactReference(repository, scope, options, args.item_id, args.accepted_fact_id.trim(), requestId(args))
          onChanged()
          return result(reference, "recorded a host-verified accepted fact as native TODO evidence")
        }
        const evidence = await repository.addEvidence(scope, {
          itemId: args.item_id,
          kind: args.kind,
          summary: args.summary,
          result: evidenceResult(args.result),
          requestId: requestId(args)
        })
        onChanged()
        return result(evidence, "recorded native TODO evidence")
      } catch (error) {
        return errorResult(error)
      }
    }
  }
]

/**
 * Validates a model's reference to an accepted fact on the host, then records it as this TODO's evidence. The fact must
 * belong to this project, not be superseded, be current in the workspace, and be named by one of the TODO's criteria.
 * It attaches provenance only: the TODO's status and criterion outcomes are decided by the reviewer, not here.
 */
const acceptedFactReference = async (
  repository: TodoRepository,
  scope: TodoWriteRequest,
  options: TodoToolOptions,
  itemId: string,
  factId: string,
  requestId: string
) => {
  const fact = (await repository.listAcceptedEvidence(scope)).find((candidate) => candidate.id === factId)
  if (!fact) throw new Error("accepted fact was not found in this project")
  if (fact.supersededBy) throw new Error(`accepted fact ${factId} was superseded by ${fact.supersededBy}; cite the replacement instead`)
  const [status] = await assessAcceptedFacts([fact], options.readCurrentSource)
  if (status.freshness !== "current") {
    throw new Error(`accepted fact ${factId} is ${status.freshness}${status.reason ? `: ${status.reason}` : ""}; read ${fact.path} lines ${fact.startLine}-${fact.endLine} again`)
  }
  const { item } = await repository.getItem(scope, itemId)
  const named = (item.criteria ?? []).some(({ verification }) => {
    if (verification.kind === "accepted_fact_exists") return factNamedBy(verification.identity, verification.symbol, fact) && (verification.path === undefined || verification.path === fact.path)
    if (verification.kind === "source_location" || verification.kind === "source_range" || verification.kind === "source_fingerprint") {
      return factNamedBy(verification.identity, verification.symbol, fact) && (verification.path === undefined || verification.path === fact.path)
    }
    return false
  })
  if (!named) {
    throw new Error(`accepted fact ${factId} is not the subject of a typed criterion of this TODO`)
  }
  const evidence = await repository.addEvidence(scope, {
    itemId,
    kind: "accepted_fact",
    summary: `Host-verified accepted fact ${fact.id}: ${fact.symbol} in ${fact.path} lines ${fact.startLine}-${fact.endLine}, fingerprint ${fact.sourceHash}, observation ${fact.observationId}, from conversation ${fact.conversationId}, accepted ${fact.acceptedAt}.`,
    result: "observed",
    requestId
  })
  await recordEvidenceUse(repository, scope, options, "reuse", [fact.id])
  return evidence
}

export const todoWorkspaceTools = (
  repository: TodoRepository,
  scope: TodoWriteRequest,
  onChanged: () => void,
  options: TodoToolOptions = {}
): import("./workspace").WorkspaceTools => {
  const tools = todoTools(repository, scope, onChanged, options)
  return {
    tools,
    orientation: "Twinny's canonical TODO list for the current conversation is available through the native TODO tools, including in ordinary chats with Agent mode off. These tools write only to the current conversation's list. Another conversation's list in this project is readable, read-only, through twinny_todo_list with conversation_id; no tool changes it. When an authoritative plan exists, twinny_todo_create proposes a child task under todo_parent_id and Feedback decides whether it is created; a rejected or existing_task result is a decision to follow, not an error. Omit todo_parent_id only when no plan exists and you are creating a top-level TODO. Model completion claims through twinny_todo_update remain in_review until evidence supports them or the user approves them in the TODO panel. Report every native TODO tool error; a later successful retry does not erase an earlier failure.",
    instructionFiles: () => [],
    async run(call, context) {
      const tool = tools.find((candidate) => candidate.name === call.name)
      if (!tool) return { output: `Unknown native TODO tool: ${call.name}`, summary: "rejected an unknown TODO tool", failed: true }
      return tool.run(call.args, context)
    }
  }
}
