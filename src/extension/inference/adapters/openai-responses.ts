/**
 * Chat through OpenAI's Responses API, for conversations that use tools.
 *
 * OpenAI's reasoning models (gpt-6-astra and its kind) refuse function
 * tools on `/v1/chat/completions` unless reasoning is off, which they do
 * not allow, and asked to write tool calls as text instead they tend to
 * stall there before sending a byte. `/v1/responses` takes tools and
 * reasoning together and answers in seconds, so a request with tools, or
 * a conversation that already holds tool calls, comes here.
 */
import {
  getProviderOrigin,
  normalizeReasoningEffort
} from "../../../common/provider-validation"
import { TwinnyProvider } from "../../../common/types"
import { diagnosticEvent } from "../../diagnostics"
import { createInferenceTrace, startInferenceAttempt } from "../trace"
import {
  ChatChunk,
  ChatFinishReason,
  ChatRequest,
  ChatToolCall,
  InferenceOptions,
  InferenceUsage
} from "../types"

import { logRequest, responseError } from "./json-stream"
import { toResponsesInput } from "./responses-input"
import { responseEvents } from "./responses-stream"

const DEFAULT_BASE = "https://api.openai.com/v1"

/** Whether a conversation needs the Responses API: it offers tools or already holds tool calls. */
export const needsResponsesApi = (request: ChatRequest) =>
  !!request.tools?.length ||
  request.messages.some(
    (message) =>
      message.role === "tool" ||
      !!(message as { tool_calls?: unknown[] }).tool_calls?.length
  )

const baseUrl = (config: TwinnyProvider) =>
  config.apiHostname
    ? `${getProviderOrigin(config)}${config.apiPath || "/v1"}`.replace(
        /\/$/,
        ""
      )
    : DEFAULT_BASE

/** One request to `/v1/responses`, streamed as twinny chat chunks. */
export async function* responsesChat(
  config: TwinnyProvider,
  request: ChatRequest,
  options?: InferenceOptions
): AsyncGenerator<ChatChunk> {
  const { instructions, input } = toResponsesInput(request.messages)
  const reasoningEffort = normalizeReasoningEffort(
    config.provider,
    request.reasoningEffort ?? config.reasoningEffort
  )
  const body = {
    model: request.model || config.modelName,
    input,
    ...(instructions ? { instructions } : {}),
    stream: true,
    store: false,
    ...(request.tools?.length
      ? {
          tools: request.tools.map((tool) => ({
            type: "function",
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters
          }))
        }
      : {}),
    ...(reasoningEffort
      ? { reasoning: { effort: reasoningEffort } }
      : {}),
    ...(request.maxTokens !== undefined && request.maxTokens > 0
      ? { max_output_tokens: request.maxTokens }
      : {}),
    ...(request.temperature !== undefined
      ? { temperature: request.temperature }
      : {})
  }
  const url = `${baseUrl(config)}/responses`
  logRequest(url, body)
  const trace = createInferenceTrace(options?.trace)
  diagnosticEvent("prompts", "provider.boundary.request", {
    operationId: trace.operationId,
    requestId: trace.requestId,
    step: trace.toolLoopStep
  }, { provider: config.provider, model: body.model, url, payload: body })
  diagnosticEvent("transport", "provider.boundary.raw_request", {
    operationId: trace.operationId,
    requestId: trace.requestId,
    step: trace.toolLoopStep
  }, { provider: config.provider, model: body.model, url, payload: body })
  const attempt = startInferenceAttempt(trace, {
    provider: config.provider,
    endpoint: url,
    model: body.model
  })
  let state = "consumer-stopped"
  let failure: unknown
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {})
      },
      body: JSON.stringify(body),
      signal: options?.signal
    })
    attempt.response(response)
    if (!response.ok) throw await responseError(response)
    if (!response.body) throw new Error("The server answered without a body.")

    const calls: ChatToolCall[] = []
    const text: string[] = []
    const reasoning: string[] = []
    for await (const event of responseEvents(response.body)) {
      attempt.firstResponse(event.type)
      diagnosticEvent("transport", "provider.raw_event", {
        operationId: trace.operationId,
        requestId: trace.requestId,
        step: trace.toolLoopStep
      }, { event })
      if (options?.signal?.aborted) {
        state = "cancelled"
        return
      }
      switch (event.type) {
        // A refusal is the model's answer too; left out, the reply would be blank.
        case "response.output_text.delta":
        case "response.refusal.delta":
          if (event.delta) diagnosticEvent("transport", "provider.assistant.delta", {
            operationId: trace.operationId,
            requestId: trace.requestId,
            step: trace.toolLoopStep
          }, { delta: event.delta })
          if (event.delta) text.push(event.delta)
          break
        case "response.reasoning_summary_text.delta":
          if (event.delta) diagnosticEvent("thinking", "provider.reasoning.delta", {
            operationId: trace.operationId,
            requestId: trace.requestId,
            step: trace.toolLoopStep
          }, { delta: event.delta })
          if (event.delta) reasoning.push(event.delta)
          break
        case "response.output_item.done":
          if (event.item?.type === "function_call" && event.item.name) {
            diagnosticEvent("transport", "provider.tool_call.delta", {
              operationId: trace.operationId,
              requestId: trace.requestId,
              step: trace.toolLoopStep
            }, {
              callId: event.item.call_id,
              name: event.item.name,
              rawArguments: event.item.arguments ?? ""
            })
            calls.push({
              id: event.item.call_id || `call_${calls.length}`,
              name: event.item.name,
              arguments: event.item.arguments ?? ""
            })
          }
          break
        case "response.completed": {
          state = "completed"
          const usage: InferenceUsage | undefined = event.response?.usage
            ? {
                promptTokens: event.response.usage.input_tokens,
                completionTokens: event.response.usage.output_tokens
              }
            : undefined
          if (text.length) yield { content: text.join("") }
          if (reasoning.length) {
            yield { content: "", reasoning: reasoning.join("") }
          }
          const finishReason: ChatFinishReason = "stop"
          diagnosticEvent("transport", "provider.response.completed", {
            operationId: trace.operationId,
            requestId: trace.requestId,
            step: trace.toolLoopStep
          }, {
            finishReason,
            usage,
            assistantTextLength: text.join("").length,
            reasoningLength: reasoning.join("").length,
            toolCallCount: calls.length
          })
          yield {
            content: "",
            finishReason,
            ...(usage ? { usage } : {}),
            ...(calls.length ? { toolCalls: [...calls] } : {})
          }
          return
        }
        case "response.incomplete":
          throw new Error(
            `The response was incomplete${event.response?.incomplete_details?.reason ? `: ${event.response.incomplete_details.reason}` : ""}.`
          )
        case "response.failed":
          throw new Error(
            event.response?.error?.message || "The response failed."
          )
        case "error":
          throw new Error(
            event.message ||
              event.error?.message ||
              "The server reported an error."
          )
      }
    }
    throw new Error("The response ended without response.completed.")
  } catch (error) {
    state = options?.signal?.aborted ? "cancelled" : "failed"
    failure = error
    throw error
  } finally {
    if (options?.signal?.aborted && state === "consumer-stopped")
      state = "cancelled"
    attempt.finish(state, failure)
  }
}
