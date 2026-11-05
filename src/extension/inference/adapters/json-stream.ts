/**
 * A POST whose reply arrives as JSON lines or server-sent events, read as
 * an async iterable of parsed objects. Every local server (Ollama,
 * llama.cpp, LM Studio, vLLM) and the OpenAI completions API stream this way.
 */
import { logger } from "../../../common/logger"
import {
  createInferenceAttemptId,
  createInferenceTrace,
  inferenceEvent,
  InferenceTraceContext
} from "../trace"

import { StreamResponse } from "./fim-dialects"

/** Waiting on the first byte for longer than this is a failure. */
const CONNECT_TIMEOUT_MS = 60000
/** How much of an error body is worth reading in the log. */
const MAX_ERROR_BODY = 400

export function isStreamWithDataPrefix(stringBuffer: string) {
  return stringBuffer.startsWith("data:")
}

export function safeParseJsonResponse(
  stringBuffer: string
): StreamResponse | undefined {
  try {
    const line = stringBuffer.trim()
    if (!line) return undefined
    const payload = isStreamWithDataPrefix(line)
      ? line.slice("data:".length).trim()
      : line
    if (!payload || payload === "[DONE]") return undefined
    return JSON.parse(payload)
  } catch {
    return undefined
  }
}

/**
 * The server usually says what went wrong in the body ("model not found",
 * "context length exceeded"); keep that on the error so the log shows it.
 */
export const responseError = async (response: Response) => {
  let detail = ""
  try {
    detail = (await response.text()).trim().slice(0, MAX_ERROR_BODY)
  } catch {
    // The status alone will have to do.
  }
  const error = new Error(
    `Server responded with status code: ${response.status}${detail ? ` ${detail}` : ""}`
  ) as Error & { status?: number }
  error.status = response.status
  return error
}

/**
 * The request as a person would read it: the prompt (or messages) as
 * text, and the rest of the body as one JSON line. Debug level only.
 */
export const logRequest = (url: string, body: unknown) => {
  const payload = body && typeof body === "object" ? (body as Record<string, unknown>) : {}
  logger.debug(
    `[Inference] request.metadata ${JSON.stringify({
      endpoint: endpointOf(url),
      model: payload.model,
      fields: Object.keys(payload).filter((key) => key !== "prompt" && key !== "messages")
    })}`
  )
}

export interface JsonStreamRequest {
  url: string
  headers: Record<string, string>
  body: unknown
  signal?: AbortSignal
  logBody?: boolean
  trace?: InferenceTraceContext
  provider?: string
  model?: string
}

let activeHttpAttempts = 0

const endpointOf = (url: string) => {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return url.split("?")[0]
  }
}

const responseMetadata = (headers: Headers) => {
  const safeHeaders: Record<string, string> = {}
  for (const name of ["content-type", "x-request-id", "request-id", "x-task-id", "x-llama-task-id", "task-id"]) {
    const value = headers.get(name)
    if (value) safeHeaders[name] = value.slice(0, 200)
  }
  const serverTaskId = safeHeaders["x-llama-task-id"]
  const taskIdCandidates = Object.fromEntries(
    ["x-task-id", "task-id"].flatMap((name) =>
      safeHeaders[name] ? [[name, safeHeaders[name]]] : []
    )
  )
  return {
    response_headers: safeHeaders,
    server_task_id: serverTaskId,
    server_task_id_source: serverTaskId ? "explicit-llama-task-response-header" : "not-exposed-in-response-headers",
    server_task_id_candidates: taskIdCandidates,
    server_request_id: safeHeaders["x-request-id"] ?? safeHeaders["request-id"]
  }
}

const recordStreamTaskId = (
  item: StreamResponse,
  trace: InferenceTraceContext,
  attemptId: string
): boolean => {
  const metadata = item as StreamResponse & {
    server_task_id?: unknown
    llama_task_id?: unknown
    task_id?: unknown
  }
  const taskId = metadata.server_task_id ?? metadata.llama_task_id
  if (typeof taskId === "string" && taskId) {
    inferenceEvent("http_attempt.server_task_id", {
      operation_id: trace.operationId,
      request_id: trace.requestId,
      attempt_id: attemptId,
      server_task_id: taskId,
      source: "explicit-response-stream-metadata",
      confidence: "confirmed"
    })
    return true
  } else if (typeof metadata.task_id === "string" && metadata.task_id) {
    inferenceEvent("http_attempt.server_task_id_candidate", {
      operation_id: trace.operationId,
      request_id: trace.requestId,
      attempt_id: attemptId,
      candidate: metadata.task_id,
      source: "ambiguous-task_id-response-field",
      confidence: "unconfirmed"
    })
  }
  return false
}

/**
 * Yields each parsed line as it arrives. Stopping early (a `break`, or the
 * signal firing) cancels the response so the server stops generating.
 */
export async function* streamJsonLines(
  request: JsonStreamRequest
): AsyncGenerator<StreamResponse> {
  const { url, headers, body, signal, logBody = true } = request
  if (logBody) logRequest(url, body)

  const trace = createInferenceTrace(request.trace)
  const attemptId = trace.attemptId ?? createInferenceAttemptId()
  const endpoint = endpointOf(url)
  const startedClock = performance.now()
  let terminalState = "consumer-closed"
  let responseStatus: number | undefined
  let serverTaskIdState = "not-exposed-in-response"
  let errorType: string | undefined
  let cleanupState = "not-started"
  let firstByteMs: number | undefined
  let firstEventMs: number | undefined
  let lateResponseLogged = false
  activeHttpAttempts += 1
  inferenceEvent("http_attempt.dispatched", {
    operation_id: trace.operationId,
    request_id: trace.requestId,
    attempt_id: attemptId,
    parent_request_id: trace.parentRequestId,
    tool_loop_step: trace.toolLoopStep,
    max_tool_loop_steps: trace.maxToolLoopSteps,
    provider: request.provider,
    endpoint,
    transport: "http",
    model: request.model ?? (body as { model?: string } | undefined)?.model,
    dispatched_at: new Date().toISOString(),
    active_requests: activeHttpAttempts,
    queued_requests: 0
  })

  const controller = new AbortController()
  const forward = () => controller.abort(signal?.reason)
  if (signal?.aborted) forward()
  else signal?.addEventListener("abort", forward, { once: true })
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort(new DOMException("Request timed out", "TimeoutError"))
  }, CONNECT_TIMEOUT_MS)
  const throwIfAborted = () => {
    if (controller.signal.aborted) {
      if (responseStatus !== undefined && !lateResponseLogged) {
        lateResponseLogged = true
        inferenceEvent("http_attempt.late_response", {
          operation_id: trace.operationId,
          request_id: trace.requestId,
          attempt_id: attemptId,
          response_status: responseStatus,
          reason: timedOut ? "timeout" : "cancelled"
        }, "warn")
      }
      throw controller.signal.reason ?? new DOMException("The request was cancelled.", "AbortError")
    }
  }
  const onAbort = () => inferenceEvent("http_attempt.abort_propagated", {
    operation_id: trace.operationId,
    request_id: trace.requestId,
    attempt_id: attemptId,
    reason: timedOut
      ? "timeout"
      : signal?.reason instanceof Error && signal.reason.message === "Twinny tool call detected"
        ? "tool-call-detected"
        : "cancelled",
    initiator: trace.cancellationInitiator ?? "unspecified",
    active_requests: activeHttpAttempts
  }, "warn")
  controller.signal.addEventListener("abort", onAbort, { once: true })

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    })
    responseStatus = response.status
    const metadata = responseMetadata(response.headers)
    if (metadata.server_task_id) serverTaskIdState = "confirmed-response-header"
    inferenceEvent("http_attempt.response_headers", {
      operation_id: trace.operationId,
      request_id: trace.requestId,
      attempt_id: attemptId,
      endpoint,
      response_status: response.status,
      ...metadata,
      time_to_headers_ms: Math.round(performance.now() - startedClock)
    })
    throwIfAborted()
    clearTimeout(timeout)

    if (!response.ok) {
      terminalState = "http-error"
      throw await responseError(response)
    }
    if (!response.body) {
      terminalState = "failed"
      throw new Error("Failed to get a ReadableStream from the response")
    }

    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
    let buffer = ""
    cleanupState = "pending"
    try {
      for (;;) {
        throwIfAborted()
        const { value, done } = await reader.read()
        throwIfAborted()
        if (done) break
        if (value && firstByteMs === undefined) {
          firstByteMs = Math.round(performance.now() - startedClock)
          inferenceEvent("http_attempt.first_byte", {
            operation_id: trace.operationId,
            request_id: trace.requestId,
            attempt_id: attemptId,
            time_to_first_byte_ms: firstByteMs
          })
        }
        buffer += value
        let newline: number
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          const json = safeParseJsonResponse(line)
          if (json) {
            if (recordStreamTaskId(json, trace, attemptId)) {
              serverTaskIdState = "confirmed-response-stream-metadata"
            }
            if (firstEventMs === undefined) {
              firstEventMs = Math.round(performance.now() - startedClock)
              inferenceEvent("http_attempt.first_stream_event", {
                operation_id: trace.operationId,
                request_id: trace.requestId,
                attempt_id: attemptId,
                time_to_first_event_ms: firstEventMs
              })
            }
            yield json
          }
        }
      }
      const rest = safeParseJsonResponse(buffer)
      if (rest) {
        if (recordStreamTaskId(rest, trace, attemptId)) {
          serverTaskIdState = "confirmed-response-stream-metadata"
        }
        if (firstEventMs === undefined) {
          firstEventMs = Math.round(performance.now() - startedClock)
          inferenceEvent("http_attempt.first_stream_event", {
            operation_id: trace.operationId,
            request_id: trace.requestId,
            attempt_id: attemptId,
            time_to_first_event_ms: firstEventMs
          })
        }
        yield rest
      }
      terminalState = "completed"
    } finally {
      await reader.cancel().catch(() => undefined)
      cleanupState = "completed"
      inferenceEvent("http_attempt.stream_cleanup", {
        operation_id: trace.operationId,
        request_id: trace.requestId,
        attempt_id: attemptId,
        state: cleanupState,
        cancelled: controller.signal.aborted
      })
    }
  } catch (error) {
    errorType = error instanceof Error ? error.name : typeof error
    if (timedOut || (error instanceof Error && error.name === "TimeoutError")) {
      terminalState = "timeout"
      logger.warn(
        `No response from ${endpoint} after ${CONNECT_TIMEOUT_MS / 1000}s. ` +
          "The model may still be loading."
      )
    } else if (signal?.aborted || controller.signal.aborted) {
      terminalState = "cancelled"
    } else if (error instanceof Error) {
      if (terminalState === "consumer-closed") terminalState = "failed"
      // The caller reports this with the provider named; here only the
      // raw detail, for when that summary is not enough.
      logger.debug(`Request to ${endpoint} failed: ${error.name}`)
    }
    throw error
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener("abort", forward)
    controller.signal.removeEventListener("abort", onAbort)
    controller.abort()
    activeHttpAttempts -= 1
    inferenceEvent("http_attempt.terminal", {
      operation_id: trace.operationId,
      request_id: trace.requestId,
      attempt_id: attemptId,
      endpoint,
      state: terminalState,
      response_status: responseStatus,
      error_type: errorType,
      server_task_id_state: serverTaskIdState,
      stream_cleanup: cleanupState,
      time_to_first_byte_ms: firstByteMs,
      time_to_first_stream_event_ms: firstEventMs,
      duration_ms: Math.round(performance.now() - startedClock),
      active_requests: activeHttpAttempts,
      queued_requests: 0
    }, terminalState === "failed" || terminalState === "timeout" ? "warn" : "info")
  }
}
