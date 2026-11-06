import { TodoRepository } from "../todos/repository"
import { TodoActor,TodoListRequest, TodoPriority, TodoStatus } from "../todos/types"

import { Tool, ToolResult } from "./workspace"

const result = (value: unknown, summary: string): ToolResult => ({
  output: JSON.stringify(value),
  summary
})

const errorResult = (error: unknown): ToolResult => ({
  output: `Native TODO tool error: ${error instanceof Error ? error.message : String(error)}`,
  summary: "native TODO tool failed",
  failed: true
})

const priorities = new Set<TodoPriority>(["low", "normal", "high", "urgent"])
const statuses = new Set<TodoStatus>(["pending", "in_progress", "in_review", "blocked", "completed", "cancelled"])

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
  scope: TodoListRequest,
  onChanged: () => void
): Tool[] => [
  {
    name: "twinny_todo_list",
    description: "Read the canonical native TODO list for the current Twinny conversation.",
    parameters: [{ name: "include_completed", description: "Include completed and cancelled tasks (true or false).", optional: true }],
    guidance: "Use this before creating or changing tasks. The conversation and project scope are supplied by Twinny and cannot be changed by the model. For every mutation, generate a non-empty unique request_id and reuse it only for an exact retry.",
    readOnly: true,
    async run(args) {
      try {
        return result(await repository.getList({ ...scope, includeCompleted: args.include_completed === "true" }), "read the native TODO list")
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
    name: "twinny_todo_create",
    description: "Create a task in Twinny's canonical native TODO list for this conversation.",
    parameters: [
      { name: "title", description: "Short task title." },
      { name: "request_id", description: "Generate a non-empty unique ID; reuse it only when retrying the exact same mutation." },
      { name: "details", description: "Task details and acceptance notes.", optional: true },
      { name: "parent_id", description: "Parent TODO ID for a nested task.", optional: true },
      { name: "priority", description: "low, normal, high, or urgent.", optional: true }
    ],
    schema: {
      type: "object",
      properties: {
        title: { type: "string", maxLength: 500 },
        request_id: { type: "string", maxLength: 200, description: "Generate a non-empty unique ID; reuse only for an exact retry." },
        details: { type: "string", maxLength: 8000 },
        parent_id: { type: "string" },
        priority: { type: "string", enum: ["low", "normal", "high", "urgent"] }
      },
      required: ["title", "request_id"],
      additionalProperties: false
    },
    async run(args) {
      try {
        const priority = args.priority as TodoPriority | undefined
        if (priority && !priorities.has(priority)) throw new Error("Invalid priority")
        const item = await repository.createItem(scope, {
          title: args.title,
          details: args.details,
          parentId: args.parent_id,
          priority
        }, requestId(args))
        onChanged()
        return result(item, "created a native TODO")
      } catch (error) {
        return errorResult(error)
      }
    }
  },
  {
    name: "twinny_todo_update",
    description: "Update a native TODO with optimistic concurrency. Setting status to completed is treated as a model completion claim and moves it to in_review. Only the user can approve completion, in the TODO panel; the model cannot complete or waive verification.",
    parameters: [
      { name: "item_id", description: "ID of the TODO item." },
      { name: "expected_version", description: "Current item version from twinny_todo_list or twinny_todo_get.", type: "integer" },
      { name: "request_id", description: "Generate a non-empty unique ID; reuse it only when retrying the exact same mutation." },
      { name: "title", description: "Replacement title.", optional: true },
      { name: "details", description: "Replacement details (empty clears details).", optional: true },
      { name: "status", description: "pending, in_progress, in_review, blocked, completed, or cancelled.", optional: true },
      { name: "priority", description: "low, normal, high, or urgent.", optional: true },
      { name: "blocked_reason", description: "Required when setting status to blocked.", optional: true }
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
        const item = await repository.updateItem(scope, {
          itemId: args.item_id,
          expectedVersion,
          patch,
          actor: "model" as TodoActor,
          requestId: requestId(args)
        })
        onChanged()
        const summary = patch.status === "completed" && item.status === "in_review"
          ? "completion claim moved to in_review; it awaits evidence or the user's approval in the TODO panel"
          : "updated a native TODO"
        return result(item, summary)
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
      { name: "request_id", description: "Generate a non-empty unique ID; reuse it only when retrying the exact same mutation." }
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
        request_id: { type: "string", maxLength: 200, description: "Generate a non-empty unique ID; reuse only for an exact retry." }
      },
      required: ["item_id", "kind", "summary", "result", "request_id"],
      additionalProperties: false
    },
    async run(args) {
      try {
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

export const todoWorkspaceTools = (
  repository: TodoRepository,
  scope: TodoListRequest,
  onChanged: () => void
): import("./workspace").WorkspaceTools => {
  const tools = todoTools(repository, scope, onChanged)
  return {
    tools,
    orientation: "Twinny's canonical TODO list for the current conversation is available through the native TODO tools, including in ordinary chats with Agent mode off. These tools cannot access another conversation's list. Optional parent_id values must be omitted when creating a top-level TODO. Model completion claims through twinny_todo_update remain in_review until evidence supports them or the user approves them in the TODO panel. Report every native TODO tool error; a later successful retry does not erase an earlier failure.",
    instructionFiles: () => [],
    async run(call, context) {
      const tool = tools.find((candidate) => candidate.name === call.name)
      if (!tool) return { output: `Unknown native TODO tool: ${call.name}`, summary: "rejected an unknown TODO tool", failed: true }
      return tool.run(call.args, context)
    }
  }
}
