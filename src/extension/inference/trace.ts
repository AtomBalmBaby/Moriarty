import { randomUUID } from "crypto"

import { logger } from "../../common/logger"

export interface InferenceTraceContext {
  operationId: string
  requestId: string
  parentRequestId?: string
  toolLoopStep?: number
  maxToolLoopSteps?: number
  attemptId?: string
  cancellationInitiator?: "user" | "host"
  endpoint?: string
  provider?: string
}

interface ActiveRequest {
  operationId: string
  requestId: string
  toolLoopStep?: number
}

let activeRequestSequence = 0
const activeRequests = new Map<number, ActiveRequest>()
const cancelledOperations = new Set<string>()

export const createInferenceTrace = (
  trace?: Partial<InferenceTraceContext>
): InferenceTraceContext => ({
  operationId: trace?.operationId ?? `operation-${randomUUID()}`,
  requestId: trace?.requestId ?? `request-${randomUUID()}`,
  ...(trace?.parentRequestId ? { parentRequestId: trace.parentRequestId } : {}),
  ...(trace?.toolLoopStep === undefined
    ? {}
    : { toolLoopStep: trace.toolLoopStep }),
  ...(trace?.maxToolLoopSteps === undefined
    ? {}
    : { maxToolLoopSteps: trace.maxToolLoopSteps }),
  ...(trace?.attemptId ? { attemptId: trace.attemptId } : {}),
  ...(trace?.cancellationInitiator
    ? { cancellationInitiator: trace.cancellationInitiator }
    : {}),
  ...(trace?.endpoint ? { endpoint: trace.endpoint } : {}),
  ...(trace?.provider ? { provider: trace.provider } : {})
})

export const createInferenceAttemptId = (): string => `attempt-${randomUUID()}`

const safeEndpoint = (endpoint: string) => {
  try {
    const parsed = new URL(endpoint)
    parsed.username = ""
    parsed.password = ""
    parsed.search = ""
    parsed.hash = ""
    return parsed.toString().replace(/\/$/, "")
  } catch {
    return endpoint.split(/[?#]/, 1)[0]
  }
}

export const inferenceEvent = (
  event: string,
  fields: Record<string, unknown> = {},
  level: "info" | "warn" | "error" = "info"
): void => {
  const record = { timestamp: new Date().toISOString(), event, ...fields }
  logger[level](`[Inference] ${JSON.stringify(record)}`)
}

export const activeInferenceRequestSnapshot = (operationId?: string) =>
  [...activeRequests.values()]
    .filter((request) => !operationId || request.operationId === operationId)
    .map((request) => ({ ...request }))

export const startInferenceAttempt = (
  trace: InferenceTraceContext,
  details: {
    provider: string
    endpoint: string
    model: string
    transport?: string
  }
) => {
  const attemptId = createInferenceAttemptId()
  const started = performance.now()
  let terminal = false
  let firstResponse = false
  const context = {
    operation_id: trace.operationId,
    request_id: trace.requestId,
    attempt_id: attemptId,
    parent_request_id: trace.parentRequestId,
    tool_loop_step: trace.toolLoopStep,
    max_tool_loop_steps: trace.maxToolLoopSteps,
    provider: details.provider,
    endpoint: safeEndpoint(details.endpoint),
    model: details.model,
    transport: details.transport ?? "fetch"
  }
  inferenceEvent("http_attempt.dispatched", {
    ...context,
    dispatched_at: new Date().toISOString(),
    active_requests: activeInferenceRequestSnapshot().length,
    queued_requests: 0
  })
  return {
    attemptId,
    response: (response: Response) => {
      const headers: Record<string, string> = {}
      for (const name of [
        "content-type",
        "x-request-id",
        "request-id",
        "x-task-id",
        "x-llama-task-id",
        "task-id"
      ]) {
        const value = response.headers.get(name)
        if (value) headers[name] = value.slice(0, 200)
      }
      const serverTaskId = headers["x-llama-task-id"]
      inferenceEvent(
        "http_attempt.response_headers",
        {
          ...context,
          status: response.status,
          response_headers: headers,
          server_task_id: serverTaskId,
          server_task_id_source: serverTaskId
            ? "explicit-llama-task-response-header"
            : "not-exposed-in-response-headers",
          server_task_id_candidates: {
            ...(headers["x-task-id"]
              ? { "x-task-id": headers["x-task-id"] }
              : {}),
            ...(headers["task-id"] ? { "task-id": headers["task-id"] } : {})
          }
        },
        response.ok ? "info" : "warn"
      )
    },
    firstResponse: (eventType?: string) => {
      if (firstResponse) return
      firstResponse = true
      inferenceEvent("http_attempt.first_response", {
        ...context,
        time_to_first_response_ms: Math.round(performance.now() - started),
        event_type: eventType
      })
    },
    finish: (state: string, error?: unknown) => {
      if (terminal) return
      terminal = true
      inferenceEvent(
        "http_attempt.terminal",
        {
          ...context,
          state,
          error_type:
            error instanceof Error
              ? error.name
              : error === undefined
                ? undefined
                : typeof error,
          duration_ms: Math.round(performance.now() - started),
          active_requests: activeInferenceRequestSnapshot().length,
          queued_requests: 0
        },
        state === "failed" ? "warn" : "info"
      )
    }
  }
}

export const cancelInferenceOperation = (
  trace: InferenceTraceContext,
  initiator: "user" | "host" | "unspecified" = trace.cancellationInitiator ??
    "unspecified",
  reason = "abort-signal"
) => {
  if (cancelledOperations.has(trace.operationId)) return
  cancelledOperations.add(trace.operationId)
  inferenceEvent(
    "operation.cancelled",
    {
      operation_id: trace.operationId,
      initiator,
      reason,
      active_requests: activeInferenceRequestSnapshot(trace.operationId),
      queued_requests: 0,
      abort_signal_issued: true
    },
    "warn"
  )
}

export const finishInferenceOperation = (
  trace: InferenceTraceContext,
  state: string,
  fields: Record<string, unknown> = {}
) => {
  inferenceEvent("operation.terminal", {
    operation_id: trace.operationId,
    request_id: trace.requestId,
    state,
    active_requests: activeInferenceRequestSnapshot(trace.operationId),
    queued_requests: 0,
    ...fields
  })
  cancelledOperations.delete(trace.operationId)
}

export const startInferenceRequest = (
  trace: InferenceTraceContext,
  fields: Record<string, unknown>,
  signal?: AbortSignal
): ((terminalState: string, error?: unknown) => void) => {
  const key = ++activeRequestSequence
  const request: ActiveRequest = {
    operationId: trace.operationId,
    requestId: trace.requestId,
    ...(trace.toolLoopStep === undefined
      ? {}
      : { toolLoopStep: trace.toolLoopStep })
  }
  activeRequests.set(key, request)
  inferenceEvent("request.started", {
    operation_id: trace.operationId,
    request_id: trace.requestId,
    parent_request_id: trace.parentRequestId,
    tool_loop_step: trace.toolLoopStep,
    max_tool_loop_steps: trace.maxToolLoopSteps,
    active_requests: activeRequests.size,
    queued_requests: 0,
    ...fields
  })

  let terminal = false
  const onAbort = () => {
    const reason = signal?.reason instanceof Error ? signal.reason.message : ""
    if (reason === "Twinny tool call detected") {
      inferenceEvent("request.stream_stopped", {
        operation_id: trace.operationId,
        request_id: trace.requestId,
        reason: "tool-call-detected",
        active_requests: activeInferenceRequestSnapshot(trace.operationId)
      })
      return
    }
    cancelInferenceOperation(
      trace,
      trace.cancellationInitiator ??
        (reason.includes("Twinny host cancellation")
          ? "host"
          : reason.includes("Twinny user stop")
            ? "user"
            : "unspecified"),
      signal?.reason instanceof Error ? signal.reason.name : "abort-signal"
    )
  }
  if (signal?.aborted) onAbort()
  else signal?.addEventListener("abort", onAbort, { once: true })

  return (terminalState, error) => {
    if (terminal) return
    terminal = true
    signal?.removeEventListener("abort", onAbort)
    activeRequests.delete(key)
    if (!activeInferenceRequestSnapshot(trace.operationId).length) {
      cancelledOperations.delete(trace.operationId)
    }
    inferenceEvent(
      "request.terminal",
      {
        operation_id: trace.operationId,
        request_id: trace.requestId,
        parent_request_id: trace.parentRequestId,
        tool_loop_step: trace.toolLoopStep,
        state: terminalState,
        error_type:
          error instanceof Error
            ? error.name
            : error === undefined
              ? undefined
              : typeof error,
        active_requests: activeRequests.size,
        queued_requests: 0
      },
      terminalState === "failed" ? "error" : "info"
    )
  }
}
