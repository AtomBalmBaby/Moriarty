/**
 * The host records what a tool actually did as a project observation. This is the production
 * recording path the chat's tool-result hook uses, and the hook only adds what it knows itself:
 * which task was active, when there was one. A result is stored for the project with its
 * provenance, so a chat with no TODO plan still keeps what its tools saw, and a declined command
 * or a TODO tool that records its own result is not an observation at all.
 */
import { logger } from "../../common/logger"
import {
  compactEvidenceText,
  compactToolEvidence,
  observationArguments,
  observedSourceReferences,
  type ObservedVersion
} from "../todos/evidence"
import type { TodoRepository } from "../todos/repository"
import type { TodoToolObservation, TodoToolObservationInput, TodoWriteRequest } from "../todos/types"
import type { ToolCall } from "../tools/protocol"
import type { ToolResult } from "../tools/workspace"

/** What the recorder needs: the project, the conversation writing, and where a read's text came from. */
export interface ToolResultRecorder {
  repository: TodoRepository
  scope: TodoWriteRequest
  /** From the workspace view: the open editor buffer, or the saved file. Never from the model. */
  sourceOrigin?: (path: string) => { origin: ObservedVersion; editorVersion?: number }
}

export interface ToolResultRecord {
  /** The host's own invocation identity, kept as `request_id` for replay deduplication. */
  invocationId: string
  executionId?: string
  /** Provenance only: the task that was active when the result came in. Nothing is invented for it. */
  itemId?: string
}

/** A declined command ran nothing, and the TODO tools record their own results: neither is a tool observation. */
export const isRecordableToolResult = (call: ToolCall, result: ToolResult): boolean =>
  !call.name.startsWith("twinny_todo_") && !(call.name === "run_command" && !result.execution)

/**
 * The observation one result becomes: bounded display text, the stored output, and the file
 * references the tool's own result proves. A failed call proves no file reference.
 */
export const toolObservationInput = (
  recorder: ToolResultRecorder,
  call: ToolCall,
  result: ToolResult,
  invocationId: string,
  executionId?: string
): TodoToolObservationInput => {
  const rawOutput = result.execution?.output ?? result.output
  const evidence = compactToolEvidence({
    name: call.name,
    args: call.args,
    output: rawOutput,
    failed: result.failed ?? false,
    exitCode: result.execution?.exitCode,
    invocationId
  })
  const sources = observedSourceReferences({
    name: call.name,
    args: call.args,
    output: rawOutput,
    failed: evidence.failed,
    origin: recorder.sourceOrigin?.(call.args.path ?? "")
  })
  return {
    toolName: call.name,
    arguments: observationArguments(evidence, result.observation?.arguments),
    output: compactEvidenceText(evidence),
    evidenceOutput: evidence.failed ? undefined : rawOutput,
    failed: evidence.failed,
    exitCode: evidence.exitCode,
    executionId,
    requestId: invocationId,
    sources
  }
}

/** Records one tool result for the project, with the task that was active when it came in. */
export const recordToolResult = async (
  recorder: ToolResultRecorder,
  call: ToolCall,
  result: ToolResult,
  record: ToolResultRecord
): Promise<TodoToolObservation> => {
  const input = toolObservationInput(recorder, call, result, record.invocationId, record.executionId)
  const first = input.sources?.[0]
  const observation = await recorder.repository.recordToolObservation(recorder.scope, { ...input, itemId: record.itemId })
  logger.debug(
    `[Evidence] observation tool=${call.name} ${record.itemId ? `task=${record.itemId}` : "task=none (project observation)"} ` +
    `path=${first?.path ?? "-"} role=${first?.role ?? "-"} origin=${first?.observedVersion ?? "-"} ` +
    `failed=${observation.failed} invocation=${record.invocationId}`
  )
  return observation
}

/** A result whose storage failed is reported as what the host saw, not as model evidence. */
export const reportRecordFailure = async (recorder: ToolResultRecorder, call: ToolCall, invocationId: string, reason: string, itemId?: string): Promise<void> => {
  logger.error(`[Todo] todo.evidence.missing ${JSON.stringify({ tool_name: call.name, invocation_id: invocationId, reason })}`)
  if (!itemId) return
  await recorder.repository.addEvidence(recorder.scope, {
    itemId,
    kind: "evidence_storage_failed",
    summary: `Result of ${call.name} (${invocationId}) was not recorded as evidence: ${reason}`.slice(0, 400),
    result: "failed",
    requestId: invocationId
  }).catch((error: unknown) => logger.error("[Todo] could not record the evidence storage failure: " + String(error)))
}

