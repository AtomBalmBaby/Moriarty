/**
 * A chat client whose `chat()` lets the model use tools before it answers.
 * Everything above it (the streaming reply, the stop button, error
 * reporting) sees one ordinary stream: the model's prose, a line per tool
 * it used when the host wants those, then the answer.
 *
 * Two ways of calling: `native` sends the tools through the server's own
 * tool-calling, and falls back to `text` when the server or model refuses
 * them; `text` asks for calls written in the reply (see `protocol.ts`) and
 * works through anything that carries chat.
 *
 * The loop also keeps the conversation inside the model's context (see
 * `budget.ts`): each result is held to a share of it, and when a request
 * would not fit, the oldest results are trimmed first.
 *
 * Wrap the client `resolveInferenceProvider` returns, so tool results go
 * through the secret shield like the rest of the conversation.
 */
import { API_PROVIDERS, ASSISTANT, DEFAULT_AGENT_STEPS, OPEN_AI_COMPATIBLE_PROVIDERS, SYSTEM, USER } from "../../common/constants"
import { logger } from "../../common/logger"
import { HOSTED_PROVIDERS } from "../../common/provider-validation"
import {
  ChatChunk,
  ChatFinishReason,
  ChatMessage,
  ChatRequest,
  ChatToolCall,
  InferenceClient,
  InferenceError,
  InferenceOptions,
  isCancelled
} from "../inference"
import { hostedTakesTools } from "../inference/adapters/fluency"
import { isRetryableProviderFailure } from "../inference/errors"
import { createInferenceTrace, inferenceEvent } from "../inference/trace"

import { ContextCapacity, ContextDiagnostics, ContextPlan, fitResult, planContext, TokenEstimator, trimmedResult } from "./budget"
import { buildBreakdown, RequestBreakdown, RowChars } from "./context-breakdown"
import { instructionsSection } from "./instructions"
import {
  displayableLength,
  FINAL_ANSWER_PROMPT,
  findToolCall,
  FoundCall,
  nameArguments,
  parseLenientJson,
  ToolCall,
  toolDefinition,
  toolInstructions,
  toolResultEnd,
  toolResultMessage
} from "./protocol"
import { ToolResult, WorkspaceTools } from "./workspace"

export const DEFAULT_MAX_STEPS = DEFAULT_AGENT_STEPS
/** Calls run from one native reply; a model that fans out wider is told which were left. */
const MAX_CALLS_PER_REPLY = 8
/** A result keeps at least this much of its output, whatever comes ahead of it. */
const MIN_RESULT_CHARS = 1000
/** The least of a fresh result kept when the context is tight; less is left out, with a notice saying so. */
const MIN_FRESH_CHARS = 400
/** Calls repeated in one reply, or requests in a row of calls that cannot be read, before the model is asked to answer. */
const MAX_REPEATED_CALLS = 3
const MAX_UNREADABLE_IN_A_ROW = 3
const MAX_NO_PROGRESS_STEPS = 3
/** Provider requests re-sent after a failure that showed the user nothing. */
const MAX_PROVIDER_RETRIES = 2
const PROVIDER_RETRY_DELAY_MS = 750

/** Why the host stopped one request, rather than the model finishing it. */
export type GenerationStopReason = "duration_limit" | "no_progress" | "output_limit"

/** Ends a request's stream. It carries the reason, so the stop is never read as a finished reply. */
export class GenerationStopped extends Error {
  constructor(readonly reason: GenerationStopReason, readonly limit: number) {
    super(`generation stopped: ${reason}`)
    this.name = "GenerationStopped"
  }
}

export interface GenerationLimits {
  /** Longest one request may run, in milliseconds; 0 turns the limit off. */
  maxDurationMs: number
  /** Longest silence between chunks of one request, in milliseconds; 0 turns the limit off. */
  noProgressMs: number
  /** Output tokens asked of the server for one request; 0 keeps the server's own limit. */
  maxOutputTokens: number
}

export const NO_GENERATION_LIMITS: GenerationLimits = { maxDurationMs: 0, noProgressMs: 0, maxOutputTokens: 0 }

/** Defaults for the `twinny.chatInference*` settings, in whole seconds and tokens. */
export const GENERATION_LIMIT_DEFAULTS = { durationSeconds: 900, noProgressSeconds: 300, outputTokens: 6144 }
const MAX_GENERATION_SECONDS = 7200
const MAX_GENERATION_TOKENS = 1_000_000
/** How often a running request is compared with its limits. */
const GENERATION_CHECK_MS = 1000

const wholeSetting = (value: number, fallback: number, max: number) =>
  Number.isFinite(value) ? Math.min(max, Math.max(0, Math.floor(value))) : fallback

export const generationLimitsFrom = (settings: { durationSeconds: number; noProgressSeconds: number; outputTokens: number }): GenerationLimits => ({
  maxDurationMs: wholeSetting(settings.durationSeconds, GENERATION_LIMIT_DEFAULTS.durationSeconds, MAX_GENERATION_SECONDS) * 1000,
  noProgressMs: wholeSetting(settings.noProgressSeconds, GENERATION_LIMIT_DEFAULTS.noProgressSeconds, MAX_GENERATION_SECONDS) * 1000,
  maxOutputTokens: wholeSetting(settings.outputTokens, GENERATION_LIMIT_DEFAULTS.outputTokens, MAX_GENERATION_TOKENS)
})

/** Tracks one request against its limits. The clock is injected, so the limits test without waiting. */
export class GenerationMonitor {
  private readonly started: number
  private lastOutput: number

  constructor(private readonly limits: GenerationLimits, private readonly clock: () => number = Date.now) {
    this.started = clock()
    this.lastOutput = this.started
  }

  /** Whether any time limit applies, so a checking timer is needed. */
  get timed(): boolean {
    return this.limits.maxDurationMs > 0 || this.limits.noProgressMs > 0
  }

  /** Called for every chunk the server sends. */
  output(): void {
    this.lastOutput = this.clock()
  }

  /** The limit this request has run past, if any. */
  exceeded(): GenerationStopped | undefined {
    const now = this.clock()
    if (this.limits.maxDurationMs > 0 && now - this.started >= this.limits.maxDurationMs) {
      return new GenerationStopped("duration_limit", this.limits.maxDurationMs)
    }
    if (this.limits.noProgressMs > 0 && now - this.lastOutput >= this.limits.noProgressMs) {
      return new GenerationStopped("no_progress", this.limits.noProgressMs)
    }
    return undefined
  }
}

/** What the user is told when the host stopped a request. */
export const generationStopNotice = (stop: GenerationStopped): string => {
  switch (stop.reason) {
    case "duration_limit":
      return `Stopped: this request ran past its ${stop.limit / 1000} second limit before the model finished. Completed tool results are kept; continue to resume.`
    case "no_progress":
      return `Stopped: the model sent no output for ${stop.limit / 1000} seconds. Completed tool results are kept; continue to resume.`
    case "output_limit":
      return "Stopped: the model reached its output limit before finishing this reply. A tool call it was still writing was not run; continue to resume."
  }
}

export type ToolMode = "native" | "text"

/**
 * Servers reached through the OpenAI-compatible route, where `tools` goes
 * to the server as sent (a paired device's Ollama included: the request is
 * relayed to it untouched), OpenAI itself, and a team gateway. QVAC's
 * server has no tool-calling, and text-generation-webui's is patchy.
 */
const NATIVE_TOOL_KINDS = new Set<string>([
  ...Object.values(OPEN_AI_COMPATIBLE_PROVIDERS).filter(
    (kind) =>
      kind !== OPEN_AI_COMPATIBLE_PROVIDERS.Qvac &&
      kind !== OPEN_AI_COMPATIBLE_PROVIDERS.Oobabooga
  ),
  API_PROVIDERS.OpenAI,
  // A gateway passes tools on to its backend; one from before it could
  // refuses the field by name, and the loop carries on in text.
  API_PROVIDERS.TwinnyRemote
])

/**
 * How to offer tools to a provider of this kind; `native` falls back to
 * text when refused. Hosted APIs go native when fluency.js can pass tools
 * to them (Anthropic, Gemini, Mistral, Groq, OpenRouter…).
 */
export const toolModeFor = (providerKind: string): ToolMode =>
  NATIVE_TOOL_KINDS.has(providerKind) ||
  (HOSTED_PROVIDERS.includes(providerKind) && hostedTakesTools(providerKind))
    ? "native"
    : "text"

/** One tool the model used, for the chat's steps, logs and the eval. */
export interface ToolStep {
  /** Unique within the reply; the same in `onToolStart` and `onStep`. */
  id: string
  index: number
  mode: ToolMode
  name?: string
  args?: Record<string, string>
  /** Set when the call could not be read. */
  parseError?: string
  summary: string
  /** What the model was given back. */
  output: string
  /** The tool refused or the call went wrong (a bad path, a failing command). */
  failed?: boolean
  /** Characters of conversation sent for the request that asked for this call. */
  promptChars: number
}

/** A call about to run, for hosts that show it while it does. */
export interface ToolStart {
  id: string
  name: string
  args: Record<string, string>
}

/** What a reply's requests cost, as far as the server counted. */
export interface ToolLoopUsage {
  /** The largest prompt of the reply: how much of the context it came to use. */
  promptTokens?: number
  /** Every request's output together. */
  completionTokens?: number
}

export interface ToolLoopOptions {
  mode?: ToolMode
  maxSteps?: number
  /** Upper ceiling for one tool result kept in the model's context, after scaling by the context window. */
  maxResultChars?: number
  /**
   * The capacity the model's requests may use, asked before each request: a
   * local server knows only once the model is loaded. A bare number is taken
   * as given. Unknown leaves the conversation untrimmed.
   */
  contextWindow?(): Promise<number | ContextCapacity | undefined> | number | ContextCapacity | undefined
  /**
   * Whether the reply text carries a `> summary` line per call. On by
   * default; a host that shows the steps itself turns it off.
   */
  stepLines?: boolean
  /**
   * Asked of every request; dropped for the rest of the reply if the model
   * refuses it (models that do not reason).
   */
  reasoningEffort?: ChatRequest["reasoningEffort"]
  /**
   * Current host state added to the system prompt of every request, not
   * kept in the conversation, so it stays fresh and never grows the history.
   */
  requestContext?(): Promise<string | undefined> | string | undefined
  /** Called before each call runs. */
  onToolStart?(start: ToolStart): void
  onStep?(step: ToolStep): void
  /** Called after a tool has really run, before its result is sent back to the model. */
  onToolResult?(call: ToolCall, result: ToolResult): void | Promise<void>
  /** Stop dispatching tools and inference after a controller has blocked mutations. */
  shouldStop?(): boolean
  /**
   * Called once per request with the characters it sends and what they are estimated to be in tokens,
   * and what each part of it is made of.
   */
  onRequest?(promptChars: number, step: number, mode: ToolMode, estimatedTokens: number, breakdown: RequestBreakdown): void
  /** Called after each request the server counted, with the breakdown it was sent with. */
  onRequestCounted?(step: number, breakdown: RequestBreakdown, promptTokens: number): void
  /** Called after each request the server counted. */
  onUsage?(usage: ToolLoopUsage): void
  /** Called when native tool-calling, or the reasoning effort, was refused and the loop carried on without it. */
  onFallback?(reason: string, what: "tools" | "reasoning-effort"): void
  /** Called when old results were trimmed so the next request fits. */
  onTrim?(results: number, estimatedTokens: number): void
  /** What became of a tool result's text on its way into the conversation, and into the next request. */
  onBudget?(entry: ResultBudget): void
  /** What one inference request was budgeted with, as counts and tokens; no content. */
  onContext?(entry: ContextDiagnostics): void
  /** Wait before re-sending a provider request that failed; tests shorten it. */
  providerRetryDelayMs?: number
  /**
   * Asked before each request after the first: messages the user sent
   * while the reply was working, handed over (and so taken) for the
   * model to read before its next step. A message never asked for, because
   * the model answered first, stays the host's to send as a turn of its own.
   */
  steering?(): string[]
  /** Called when the reply ended because it used every tool step it had, with the work maybe unfinished. */
  onOutOfSteps?(): void
  /** Limits on one request's duration, silence, and output, read before each request. */
  generationLimits?(): GenerationLimits
  /** Called when the host stopped a request; the reason is shown to the user in place of a finished reply. */
  onGenerationStop?(stop: GenerationStopped): void
  /**
   * Called when the reply ends, however it ends, with the calls made and
   * what they returned, cut to size: kept with the reply so the next turn
   * still has them. Undefined when no tool ran.
   */
  onNotes?(notes: string | undefined): void
  /** Called last, when the reply is over or was stopped. */
  onEnd?(): void
}

const clipTo = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit)}… (cut)` : text

const textOf = (content: ChatMessage["content"]): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part) => (part.type === "text" ? part.text : "")).join("\n")
      : ""

type NativeCall = { id: string; type: "function"; function: { name: string; arguments: string } }

const callsOf = (message: ChatMessage): NativeCall[] =>
  (message as { tool_calls?: NativeCall[] }).tool_calls ?? []

const charsOf = (messages: ChatMessage[]) =>
  messages.reduce(
    (sum, m) =>
      sum +
      textOf(m.content).length +
      callsOf(m).reduce((n, c) => n + c.function.name.length + c.function.arguments.length, 0),
    0
  )

/** The conversation with the tool section added to its system prompt. */
const withToolPrompt = (messages: ChatMessage[], section: string): ChatMessage[] => {
  const [first, ...rest] = messages
  if (first?.role === SYSTEM) {
    return [{ role: SYSTEM, content: `${textOf(first.content).trim()}\n\n${section}` }, ...rest]
  }
  return [{ role: SYSTEM, content: section }, ...messages]
}

/**
 * The conversation with the last request's instruction at its end: in the
 * user's turn when that is where it stops (a text-mode result), since
 * some servers refuse two user turns in a row; as a turn of its own after
 * a native tool result.
 */
const withClosingPrompt = (messages: ChatMessage[]): ChatMessage[] => {
  const final = messages[messages.length - 1]
  return final?.role === USER && typeof final.content === "string"
    ? [...messages.slice(0, -1), { ...final, content: `${final.content}\n\n${FINAL_ANSWER_PROMPT}` }]
    : [...messages, { role: USER, content: FINAL_ANSWER_PROMPT }]
}

/** The conversation with host state added to its system prompt for one request only. */
const withRequestContext = (messages: ChatMessage[], context: string | undefined): ChatMessage[] => {
  if (!context?.trim()) return messages
  return withToolPrompt(messages, context)
}

const stepLine = (summary: string) => `> ${summary}\n\n`

/** How messages the user sent mid-reply reach the model, in its next request. */
export const steeringMessage = (said: string[]) =>
  [
    `While you were working, the user wrote${said.length > 1 ? " these messages" : ""}:`,
    ...said.map((text) => `\n${text}`),
    "\nTake that into account and carry on."
  ].join("\n")

/**
 * A reply with its tool calls taken out, for the last request, whose
 * calls are never run: the text before the first call, and each piece
 * of prose after one.
 */
const withoutCalls = (text: string): { lead: string; after: string[] } => {
  const pieces: string[] = []
  let rest = text
  for (let found = findToolCall(rest, true); found; found = findToolCall(rest, true)) {
    pieces.push(rest.slice(0, found.start))
    rest = rest.slice(found.end)
  }
  const [lead, ...after] = [...pieces, rest]
  return { lead: lead.trimEnd(), after: after.map((piece) => piece.trim()).filter(Boolean) }
}

/** What goes between text already shown and a step line, so each line is its own paragraph. */
const gapAfter = (shown: string) =>
  !shown.trim() || shown.endsWith("\n\n") ? "" : shown.endsWith("\n") ? "\n" : "\n\n"

/** A refusal that names tools or function calling, as opposed to any other failure. */
const refusesNativeTools = (error: unknown) =>
  !isCancelled(error) &&
  error instanceof Error &&
  (/\btools?\b|function.?call/i.test(error.message) || /failed to parse grammar/i.test(error.message))

/** A model that does not take a reasoning effort, as opposed to one that will not mix it with tools. */
const refusesReasoningEffort = (error: unknown) =>
  !isCancelled(error) &&
  error instanceof Error &&
  /reasoning[._ ]?effort/i.test(error.message) &&
  !/function tools|\btools\b/i.test(error.message)

const cancelled = (reason?: unknown) =>
  new InferenceError("cancelled", "The request was cancelled.", { cause: reason })

/** Resolves after `ms`, or rejects as cancelled as soon as `signal` aborts. */
export const pause = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) return reject(cancelled(signal.reason))
  const onAbort = () => {
    clearTimeout(timer)
    reject(cancelled(signal?.reason))
  }
  const timer = setTimeout(() => {
    signal?.removeEventListener("abort", onAbort)
    resolve()
  }, ms)
  signal?.addEventListener("abort", onAbort, { once: true })
})

/**
 * Native arguments as the tools take them, or why they could not be read.
 * A server that passes the model's JSON on as it was written (llama.cpp,
 * vLLM) passes on its slips too, and they are mended the same way as in
 * a text call.
 */
const parseArguments = (call: ChatToolCall): ToolCall | { error: string; detail?: string } => {
  if (!call.arguments.trim()) return { name: call.name, args: {} }
  const parsed = parseLenientJson(call.arguments)
  if ("error" in parsed) return { error: "the arguments were not valid JSON", detail: parsed.error }
  const { value } = parsed
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "the arguments were not an object" }
  return {
    name: call.name,
    args: Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])
    )
  }
}

/** Characters of an unreadable call quoted back to the model, so it can see what went wrong. */
const MAX_QUOTED_CALL = 600

/**
 * What the model is told about a call it wrote that could not be read:
 * why, in the parser's words when it had some, what it wrote, and the
 * form that works.
 */
export const unreadableCallMessage = (pending: { error?: string; detail?: string; written?: string }, native: boolean) => {
  const why = `Your tool call could not be read: ${pending.error}${pending.detail ? ` (${pending.detail})` : ""}.`
  const written = pending.written?.trim()
  const quoted = written
    ? `\nYou wrote:\n~~~\n${written.length > MAX_QUOTED_CALL ? `${written.slice(0, MAX_QUOTED_CALL)}… (${written.length - MAX_QUOTED_CALL} more characters)` : written}\n~~~`
    : ""
  const form = native
    ? ""
    : "\nWrite it exactly like this, as JSON, with line breaks inside strings written as \\n:\n```tool\n{\"name\": \"read_file\", \"arguments\": {\"path\": \"src/index.ts\"}}\n```"
  return `${why}${quoted}${form}`
}

/** Whether `text` is JSON as written, or empty (no arguments). */
const strictJson = (text: string) => {
  if (!text.trim()) return true
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

const parsedOr = (json: string): unknown => {
  try {
    return JSON.parse(json)
  } catch {
    return {}
  }
}

/**
 * A native tool conversation said in plain messages: each call as the
 * text protocol writes it, each result as a user turn. For the one server
 * that will not take tool history without the tools declared beside it.
 */
export const flattenToolHistory = (messages: ChatMessage[]): ChatMessage[] => {
  const names = new Map<string, string>()
  const flat: { role: string; content: ChatMessage["content"]; own: boolean }[] = []
  const add = (role: string, content: string) => {
    const previous = flat[flat.length - 1]
    if (previous?.own && previous.role === role) previous.content = `${previous.content}\n\n${content}`
    else flat.push({ role, content, own: true })
  }
  for (const message of messages) {
    const calls = callsOf(message)
    if (message.role === ASSISTANT && calls.length) {
      for (const call of calls) names.set(call.id, call.function.name)
      add(
        ASSISTANT,
        [
          textOf(message.content).trim(),
          ...calls.map(
            (call) =>
              "```tool\n" +
              JSON.stringify({ name: call.function.name, arguments: parsedOr(call.function.arguments) }) +
              "\n```"
          )
        ]
          .filter(Boolean)
          .join("\n")
      )
    } else if (message.role === "tool") {
      const id = (message as { tool_call_id?: string }).tool_call_id ?? ""
      add(USER, toolResultMessage(names.get(id) ?? "tool", textOf(message.content)))
    } else {
      flat.push({ role: message.role, content: message.content, own: false })
    }
  }
  return flat.map(({ role, content }) => ({ role, content }) as ChatMessage)
}

/** A call the model made, in either mode, with what the conversation records of it. */
interface PendingCall {
  /** The native call as it goes back to the server; absent in text mode. */
  raw?: ChatToolCall
  call?: ToolCall
  error?: string
  /** What the parser said, and what the model wrote, when the call could not be read. */
  detail?: string
  written?: string
}

/** One tool result's sizes and fate, in characters; no content. */
export interface ResultBudget {
  /** The call's invocation ID, as in the step stream: `${step}.${index}`. */
  id: string
  name: string
  /** What the tool returned. */
  original?: number
  /** What was sent into the conversation after the per-result cap. */
  serialized?: number
  /** What the conversation holds for it once the context was budgeted. */
  budgeted: number
  reason: "kept whole" | "per-result cap" | "older result trimmed" | "cut to remaining room" | "omitted: no room"
  /** Tokens left under the window's limit when the request was budgeted; negative when over. */
  remainingTokens?: number
  /** Whether the result's text is in the next request, rather than a notice in its place. */
  retained?: boolean
}

export const describeResultBudget = (entry: ResultBudget) =>
  [
    `Tool result ${entry.id} ${entry.name} · ${entry.reason}`,
    entry.original === undefined ? undefined : `original ${entry.original} chars`,
    entry.serialized === undefined ? undefined : `serialized ${entry.serialized}`,
    `budgeted ${entry.budgeted}`,
    entry.remainingTokens === undefined ? undefined : `remaining ${entry.remainingTokens} tokens`,
    entry.retained === undefined ? undefined : entry.retained ? "retained in next request" : "not retained"
  ]
    .filter(Boolean)
    .join(" · ")

/** A result in the conversation, so it can be trimmed later. */
interface ResultSlot {
  id: string
  message: number
  step: number
  name: string
  trimmed: boolean
  /** Left out of the conversation for lack of room, with a notice in its place. */
  omitted?: boolean
  /** A folder's instructions ahead of the output: kept when the output is trimmed. */
  preface?: string
  /** What follows the result in its message (the user's words mid-reply, in text mode): kept when it is trimmed. */
  after?: string
}

const toCapacity = (raw: number | ContextCapacity | undefined): ContextCapacity | undefined => {
  if (typeof raw === "number") {
    return raw > 0 ? { tokens: raw, source: "unspecified", confirmed: false, considered: [] } : undefined
  }
  return raw && raw.tokens > 0 ? raw : undefined
}

class ToolLoop {
  private readonly _logicalRequestId = createInferenceTrace().operationId
  private _mode: ToolMode
  private _effort: ChatRequest["reasoningEffort"]
  private _messages: ChatMessage[] = []
  /** The tool and project sections of the system prompt, as `prompt` added them. */
  private _sections: string[] = []
  private _results: ResultSlot[] = []
  /** Everything yielded so far, for spacing the step lines. */
  private _shown = ""
  /** Each call and what it returned, and what the user said along the way, for the next turn's notes. */
  private _record: ({ name: string; args: Record<string, string>; output: string } | { said: string })[] = []
  private _plan?: ContextPlan
  private readonly _estimator = new TokenEstimator()
  private readonly _usage: ToolLoopUsage = {}
  private _flattened = false
  /**
   * Read-only calls answered so far, by name and arguments, since the
   * workspace last changed: one asked again gets a pointer to its result
   * rather than the same output twice.
   */
  private readonly _answered = new Map<string, { summary: string; slot?: ResultSlot }>()
  /** Calls not run because they repeated one already answered. */
  private _repeats = 0
  /** Requests in a row whose every call could not be read. */
  private _unreadable = 0
  /** Tool turns in a row that all fail or return no search results. */
  private _noProgressSteps = 0
  /** Set when the model goes round in circles: the next request asks for its answer. */
  private _stuck = false

  constructor(
    private readonly _client: InferenceClient,
    private readonly _workspace: WorkspaceTools,
    private readonly _options: ToolLoopOptions
  ) {
    this._mode = _options.mode ?? "text"
    this._effort = _options.reasoningEffort
  }

  async *run(request: ChatRequest, options?: InferenceOptions): AsyncGenerator<ChatChunk> {
    try {
      yield* this.steps(request, options)
    } finally {
      // However the reply ends (answered, stopped, failed), what the tools
      // did is kept for the next turn and the host is told it is over.
      this._options.onNotes?.(this.notes())
      this._options.onEnd?.()
    }
  }

  private prompt(request: ChatRequest) {
    const { tools, orientation, instructions } = this._workspace
    this._sections = [toolInstructions(tools, orientation, this._mode === "native"), ...(instructions ? [instructionsSection(instructions)] : [])]
    return withToolPrompt(request.messages, this._sections.join("\n\n"))
  }

  /**
   * What the request is made of, in characters, from what is sent. The rows
   * add up to the characters `charsOf` counts for `sent`, plus the schemas.
   */
  private measure(sent: ChatMessage[], context: string | undefined, closing: boolean, schemas: number) {
    const contextApplied = !!context?.trim()
    // The system prompt is trimmed at its end when context follows it.
    const section = this._sections.join("\n\n")
    const sectionChars = contextApplied ? section.trimEnd().length : section.length
    const toolChars = Math.min(this._sections[0]?.length ?? 0, sectionChars)
    const contextChars = contextApplied ? context!.length + 2 : 0
    const systemChars = sent[0]?.role === SYSTEM ? textOf(sent[0].content).length : 0

    const base = this._messages[0]?.role === SYSTEM ? this._messages.slice(1) : this._messages
    let history = 0
    let calls = 0
    let results = 0
    for (const message of base) {
      const text = textOf(message.content)
      calls += callsOf(message).reduce((n, c) => n + c.function.name.length + c.function.arguments.length, 0)
      if (message.role === "tool") results += text.length
      else if (message.role === USER) {
        const end = toolResultEnd(text)
        results += end
        history += text.length - end
      } else history += text.length
    }
    const final = this._messages[this._messages.length - 1]
    const closingChars = !closing
      ? 0
      : FINAL_ANSWER_PROMPT.length + (final?.role === USER && typeof final.content === "string" ? 2 : 0)

    const chars: RowChars = {
      system: systemChars - sectionChars - contextChars,
      toolInstructions: toolChars,
      projectInstructions: sectionChars - toolChars,
      schemas,
      context: contextChars,
      history,
      calls,
      results,
      closing: closingChars
    }
    return buildBreakdown(chars, this._estimator.charsPerToken)
  }

  private async *steps(request: ChatRequest, options?: InferenceOptions): AsyncGenerator<ChatChunk> {
    const maxSteps = this._options.maxSteps ?? DEFAULT_MAX_STEPS
    const outer = options?.signal
    const definitions = this._workspace.tools.map(toolDefinition)
    const definitionChars = JSON.stringify(definitions).length
    this._messages = this.prompt(request)

    // Set once a tool's result says to answer now (an edit waits for review).
    let settled = false
    let requestSequence = 0
    let providerRetries = 0
    const operationId = options?.trace?.operationId ?? this._logicalRequestId
    for (let step = 0; ; step++) {
      if (outer?.aborted) {
        inferenceEvent("request.cancelled_before_dispatch", {
          operation_id: operationId,
          tool_loop_step: step + 1,
          max_tool_loop_steps: maxSteps,
          queued_requests: 0,
          reason: "operation-aborted-before-next-tool-loop-step"
        }, "warn")
        throw cancelled(outer.reason)
      }
      if (step > 0) this.steer()
      const last = settled || this._stuck || step >= maxSteps
      const native = this._mode === "native"
      // The last request offers nothing to call, so the model answers.
      const tools = native && !last ? definitions : undefined
      const closing = last && !settled

      const context = await this._options.requestContext?.()
      await this.fit((tools ? definitionChars : 0) + (closing ? FINAL_ANSWER_PROMPT.length : 0) + (context?.length ?? 0), step)
      if (outer?.aborted) {
        inferenceEvent("request.cancelled_before_dispatch", {
          operation_id: operationId,
          tool_loop_step: step + 1,
          max_tool_loop_steps: maxSteps,
          queued_requests: 0,
          reason: "operation-aborted-during-context-preparation"
        }, "warn")
        throw cancelled(outer.reason)
      }
      const sent = withRequestContext(closing ? withClosingPrompt(this._messages) : this._messages, context)
      const promptChars = charsOf(sent) + (tools ? definitionChars : 0)
      const breakdown = this.measure(sent, context, closing, tools ? definitionChars : 0)
      this._options.onRequest?.(promptChars, step, this._mode, this._estimator.tokens(promptChars), breakdown)

      // A step of our own to cut short when a text call closes, without it
      // looking like the user pressed stop.
      const stepAbort = new AbortController()
      const forward = () => stepAbort.abort(outer?.reason)
      if (outer?.aborted) forward()
      else outer?.addEventListener("abort", forward, { once: true })
      const requestId = `${operationId}-request-${++requestSequence}`

      const limits = this._options.generationLimits?.() ?? NO_GENERATION_LIMITS
      const monitor = new GenerationMonitor(limits)
      const configuredOutput = limits.maxOutputTokens > 0 ? limits.maxOutputTokens : undefined
      // The reply may not take more than the plan kept room for; the window cannot hold more.
      const maxOutputTokens = configuredOutput && this._plan
        ? Math.min(configuredOutput, Math.max(1, this._plan.reserved))
        : configuredOutput
      const reply = { text: "", shown: 0, toolCalls: undefined as ChatToolCall[] | undefined, reasoning: "" }
      let found: FoundCall | undefined
      let finishReason: ChatFinishReason | undefined
      let promptTokens: number | undefined
      let completionTokens: number | undefined
      const watch = monitor.timed
        ? setInterval(() => {
          const stop = monitor.exceeded()
          if (stop && !stepAbort.signal.aborted) stepAbort.abort(stop)
        }, GENERATION_CHECK_MS)
        : undefined
      try {
        const chunks = this._client.chat(
          {
            ...request,
            messages: sent,
            ...(this._effort ? { reasoningEffort: this._effort } : {}),
            ...(maxOutputTokens ? { maxTokens: maxOutputTokens } : {}),
            ...(tools ? { tools } : {})
          },
          {
            ...options,
            signal: stepAbort.signal,
            trace: {
              operationId,
              operationKind: "tool_loop",
              requestId,
              parentRequestId: options?.trace?.requestId,
              toolLoopStep: step + 1,
              maxToolLoopSteps: maxSteps,
              cancellationInitiator: options?.trace?.cancellationInitiator
            }
          }
        )
        for await (const chunk of chunks) {
          monitor.output()
          reply.text += chunk.content
          if (typeof chunk.reasoning === "string" && chunk.reasoning) {
            reply.reasoning += chunk.reasoning
            // Passed on as it arrives, so the chat can show the thinking while it happens.
            yield { content: "", reasoning: chunk.reasoning }
          }
          if (chunk.toolCalls) reply.toolCalls = [...(reply.toolCalls ?? []), ...chunk.toolCalls]
          if (chunk.usage?.promptTokens) promptTokens = chunk.usage.promptTokens
          if (chunk.usage?.completionTokens) completionTokens = chunk.usage.completionTokens
          if (chunk.finishReason) finishReason = chunk.finishReason
          // Native mode reads text calls too: qwen3-coder sometimes writes its
          // own call syntax as prose, and Ollama passes it through untouched.
          if (!last) {
            found = findToolCall(reply.text)
            if (found) break
          }
          // A call's opening is held back in every case; on the last request
          // one may still come, and it is never shown.
          const safe = displayableLength(reply.text)
          if (safe > reply.shown) {
            yield this.show(reply.text.slice(reply.shown, safe))
            reply.shown = safe
          }
        }
        providerRetries = 0
      } catch (error) {
        if (outer?.aborted) {
          throw error
        }
        if (stepAbort.signal.reason instanceof GenerationStopped) {
          // The host stopped this request. It is not retried, and what it was
          // writing is neither run nor read as a finished reply.
          yield* this.stopped(stepAbort.signal.reason)
          return
        }
        if (this._effort && !reply.text && refusesReasoningEffort(error)) {
          inferenceEvent("tool_loop.retry_decision", {
            operation_id: operationId,
            request_id: requestId,
            tool_loop_step: step + 1,
            reason: "reasoning-effort-unsupported",
            next_action: "new-request-without-reasoning-effort"
          })
          this._options.onFallback?.((error as Error).message, "reasoning-effort")
          this._effort = undefined
          step--
          continue
        }
        if (native && !reply.text && refusesNativeTools(error)) {
          // A server can reject native calls outright or fail to build its
          // tool-schema grammar; either way, no tool ran and text mode is safe.
          if (!this._results.length) {
            inferenceEvent("tool_loop.retry_decision", {
              operation_id: operationId,
              request_id: requestId,
              tool_loop_step: step + 1,
              reason: "native-tools-unsupported",
              next_action: "new-request-in-text-tool-mode"
            })
            this._options.onFallback?.((error as Error).message, "tools")
            this._mode = "text"
            this._messages = this.prompt(request)
            step--
            continue
          }
          // Refused on the last request, which carries tool history but no
          // tools: say the history in plain messages instead, once.
          if (last && !this._flattened) {
            inferenceEvent("tool_loop.retry_decision", {
              operation_id: operationId,
              request_id: requestId,
              tool_loop_step: step + 1,
              reason: "native-tool-history-unsupported",
              next_action: "new-request-with-flattened-history"
            })
            this._flattened = true
            this._messages = flattenToolHistory(this._messages)
            this._results = []
            this._answered.clear()
            this._mode = "text"
            step--
            continue
          }
        }
        // Nothing was shown, reasoned, or called, so the same request is safe to send again.
        if (
          isRetryableProviderFailure(error) &&
          !reply.shown &&
          !reply.reasoning &&
          !reply.toolCalls &&
          providerRetries < MAX_PROVIDER_RETRIES &&
          !outer?.aborted
        ) {
          providerRetries++
          const delay = (this._options.providerRetryDelayMs ?? PROVIDER_RETRY_DELAY_MS) * providerRetries
          inferenceEvent("tool_loop.retry_decision", {
            operation_id: operationId,
            request_id: requestId,
            tool_loop_step: step + 1,
            reason: "provider-failure-before-output",
            failure_reason: (error as InferenceError).reason ?? (error as InferenceError).kind,
            attempt: providerRetries,
            max_attempts: MAX_PROVIDER_RETRIES,
            delay_ms: delay,
            next_action: "re-send-same-request"
          }, "warn")
          await pause(delay, outer)
          step--
          continue
        }
        if (!isCancelled(error)) throw error
      } finally {
        if (watch) clearInterval(watch)
        outer?.removeEventListener("abort", forward)
        if (found) stepAbort.abort(new Error("Twinny tool call detected"))
        else stepAbort.abort()
      }

      this.count(promptChars, promptTokens, completionTokens)
      if (promptTokens) this._options.onRequestCounted?.(step, breakdown, promptTokens)
      // A reply the output cap cut short may hold half a call: nothing it
      // says is run, and it is not presented as finished.
      if (finishReason === "length") {
        yield* this.stopped(new GenerationStopped("output_limit", maxOutputTokens ?? 0))
        return
      }

      const nativeCalls = native && !last ? this.nativeCalls(reply.toolCalls) : []
      if (!nativeCalls.length) found ??= findToolCall(reply.text, true)
      // What the model wrote, before a text call is cut out of it for the
      // conversation: the prose ahead of the call is shown from this.
      const written = reply.text
      const calls = nativeCalls.length ? nativeCalls : last ? [] : this.textCall(found, reply, step)

      if (!calls.length) {
        // The answer. A call written on the last request is never run and
        // never shown, but what the model wrote after it is; anything else
        // held back was prose after all.
        if (last && found) {
          const { lead, after } = withoutCalls(written.slice(reply.shown))
          if (lead) yield this.show(lead)
          for (const piece of after) yield this.show(`${gapAfter(this._shown)}${piece}`)
        } else if (written.length > reply.shown) {
          yield this.show(written.slice(reply.shown))
        }
        if (!this._shown.trim() && this._record.length) {
          yield this.show(
            settled
              ? "The change is waiting in the editor for you to accept or reject."
              : this._stuck
                ? "I was going round in circles with the same tool calls, so I stopped there; the steps above show what I tried."
                : last
                  ? "I ran out of tool steps for this reply before I could finish. Continue, and I will carry on from here."
                  : "The model finished without writing a reply; the steps above show what it did."
          )
        }
        if (last && !settled && !this._stuck && step >= maxSteps) this._options.onOutOfSteps?.()
        const usage = this._usage.promptTokens || this._usage.completionTokens ? { ...this._usage } : undefined
        if (usage || finishReason) {
          yield { content: "", ...(usage ? { usage } : {}), ...(finishReason ? { finishReason } : {}) }
        }
        return
      }

      // Whatever was held back in case it began a call is prose when the
      // calls came another way (natively), and so is all before a text call.
      // Call markup a server left in the text beside its native calls is not prose.
      const markup = found ?? (nativeCalls.length ? findToolCall(written, true) : undefined)
      const proseEnd = markup ? markup.start : written.length
      if (proseEnd > reply.shown) yield this.show(written.slice(reply.shown, proseEnd))
      const results: ToolResult[] = []
      /** Each call's key among the answered ones, when it is a read worth keeping. */
      const keys: (string | undefined)[] = []
      for (const [i, pending] of calls.entries()) {
        const id = `${step}.${i}`
        const name = pending.call?.name ?? pending.raw?.name ?? "unknown"
        this._options.onToolStart?.({ id, name, args: pending.call?.args ?? {} })
        const key = pending.call ? this.answerKey(pending.call) : undefined
        // Anything that may change the workspace makes every earlier read stale.
        if (pending.call && !key) this._answered.clear()
        const earlier = key ? this._answered.get(key) : undefined
        // A result trimmed out of the context is gone from the model's view, and is run again;
        // one left out for lack of room is refused, since running it again would give the same answer.
        const repeated = earlier && (!earlier.slot?.trimmed || earlier.slot.omitted) ? earlier : undefined
        if (repeated) this._repeats++
        const stopped = this._options.shouldStop?.() === true
        const ran: ToolResult = stopped
          ? { output: "This call was not run because execution stopped after a catastrophic edit regression.", summary: name + " not run after catastrophic regression", failed: true }
          : !pending.call
          ? {
              output: unreadableCallMessage(pending, native),
              summary: `tool call not understood · ${pending.error}`,
              failed: true
            }
          : repeated?.slot?.omitted
          ? {
              output: `${name} was not run again: its result for these same arguments did not fit in the model's context, so it was left out. Ask for a smaller part, such as a narrower line range, or try something different.`,
              summary: `${repeated.summary} · repeated, left out for lack of room`,
              failed: true
            }
          : repeated

            ? {
                output:
                  `You already called ${name} with these same arguments in this reply, and nothing in the workspace has changed since, ` +
                  "so it was not run again: its result is above. Use that, or try something different.",
                summary: `${repeated.summary} · repeated, not run again`
              }
            : await this.runCall(pending.call, outer)
        if (pending.call && !repeated) await this._options.onToolResult?.(pending.call, ran)
        // A read that failed (a search that ran out of time, a language
        // server still starting) is worth trying again, so it is not kept.
        keys.push(repeated || ran.failed ? undefined : key)
        const left = (reply.toolCalls?.length ?? 0) - calls.length
        const note =
          left > 0 && i === calls.length - 1
            ? `\n(${left} more ${left === 1 ? "call" : "calls"} in the same reply ${left === 1 ? "was" : "were"} not run; make ${left === 1 ? "it" : "them"} again if still needed.)`
            : ""
        const { preface } = ran
        // Calls made together share a result's room, so the next request
        // has all of them rather than trimming the ones just asked for.
        const room = this._plan
          ? Math.max(MIN_RESULT_CHARS, Math.floor(this._plan.resultChars / calls.length) - (preface?.length ?? 0))
          : undefined
        const fitted = room ? fitResult(ran.output, room) : ran.output
        const result: ToolResult = {
          ...ran,
          output: fitted + note || "(no output)"
        }
        this._options.onBudget?.({
          id,
          name,
          original: ran.output.length,
          serialized: result.output.length,
          budgeted: result.output.length,
          reason: fitted.length < ran.output.length ? "per-result cap" : "kept whole"
        })

        // A folder's instructions go ahead of the output, where a cut to
        // fit the context does not reach them; the step shows the output.
        const sent = preface ? { ...result, output: `${preface}\n\n${result.output}` } : result
        results.push(sent)
        // The next turn's notes keep what the tool returned; the folder's
        // instructions come again when that turn's tools reach the folder.
        this._record.push({ name, args: pending.call?.args ?? {}, output: result.output })
        this._options.onStep?.({
          id,
          index: step,
          mode: this._mode,
          name: pending.call?.name ?? pending.raw?.name,
          args: pending.call?.args,
          parseError: pending.error,
          summary: result.summary,
          output: result.output,
          failed: result.failed,
          promptChars
        })
        if (this._options.stepLines !== false) {
          yield this.show(`${gapAfter(this._shown)}${stepLine(result.summary)}`)
        }
      }
      const slots = this.remember(calls, results, reply.text, found, step, reply.reasoning || undefined)
      keys.forEach((key, i) => {
        if (key) this._answered.set(key, { summary: results[i].summary, slot: slots[i] })
      })
      this._unreadable = calls.every((pending) => !pending.call) ? this._unreadable + 1 : 0
      const noProgress = results.length > 0 && results.every((result, index) => {
        if (result.failed) return true
        const name = calls[index]?.call?.name
        if (name === "find_files") return result.summary.endsWith(" · none")
        if (name === "search_workspace") {
          try {
            return JSON.parse(result.output).total === 0
          } catch {
            return false
          }
        }
        return false
      })
      this._noProgressSteps = noProgress ? this._noProgressSteps + 1 : 0
      // A small model that keeps asking for what it has, or keeps writing
      // calls that cannot be read, is not getting anywhere with more steps.
      if (this._repeats >= MAX_REPEATED_CALLS || this._unreadable >= MAX_UNREADABLE_IN_A_ROW || this._noProgressSteps >= MAX_NO_PROGRESS_STEPS) {
        this._stuck = true
        if (this._noProgressSteps >= MAX_NO_PROGRESS_STEPS) {
          logger.warn("Agent tool loop stopped after " + this._noProgressSteps + " consecutive tool steps without progress; asking the model to answer with the information it has.")
        }
      }
      settled = results.some((result) => result.final)
      if (this._options.shouldStop?.()) return
    }
  }

  /** A read-only call by its name and arguments, so the same one asked twice is known; undefined for any other call. */
  private answerKey(call: ToolCall): string | undefined {
    if (!this._workspace.tools.find((tool) => tool.name === call.name)?.readOnly) return undefined
    const args = Object.entries(call.args)
      .map(([name, value]) => [name, value.trim()])
      .filter(([, value]) => value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return JSON.stringify([call.name, args])
  }

  /**
   * What the user sent while the reply worked, put where the model reads
   * it next: a turn of its own after native results, the end of the user
   * turn that carries a text-mode result. It goes in the notes too, so the
   * next turn knows what was asked along the way.
   */
  private steer() {
    const said = (this._options.steering?.() ?? []).map((text) => text.trim()).filter(Boolean)
    if (!said.length) return
    const message = steeringMessage(said)
    const at = this._messages.length - 1
    const final = this._messages[at]
    if (this._mode === "text" && final?.role === USER && typeof final.content === "string") {
      this._messages[at] = { ...final, content: `${final.content}\n\n${message}` }
      // The result it follows may be trimmed later; what the user said is not.
      const slot = this._results.find((result) => result.message === at)
      if (slot) slot.after = `${slot.after ?? ""}\n\n${message}`
    } else {
      this._messages.push({ role: USER, content: message })
    }
    for (const text of said) this._record.push({ said: text })
  }

  /** A tool's result, or a cancellation the moment the user stops the reply: no tool is waited on past that. */
  private async runCall(call: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
    // Checked before dispatch: a stop during an earlier call must not start a later one.
    if (signal?.aborted) throw cancelled(signal.reason)
    const work = this._workspace.run(call, { signal })
    if (!signal) return work
    work.catch(() => undefined)
    let onAbort = () => undefined as void
    const stopped = new Promise<never>((_, reject) => {
      onAbort = () => reject(cancelled(signal.reason))
      signal.addEventListener("abort", onAbort, { once: true })
    })
    stopped.catch(() => undefined)
    try {
      return await Promise.race([work, stopped])
    } finally {
      signal.removeEventListener("abort", onAbort)
    }
  }

  /** What the server counted for a request: corrects the estimates and adds to the reply's totals. */
  private count(promptChars: number, promptTokens?: number, completionTokens?: number) {
    this._estimator.observe(promptChars, promptTokens)
    if (!promptTokens && !completionTokens) return
    if (promptTokens) this._usage.promptTokens = Math.max(this._usage.promptTokens ?? 0, promptTokens)
    if (completionTokens) this._usage.completionTokens = (this._usage.completionTokens ?? 0) + completionTokens
    this._options.onUsage?.({ ...this._usage })
  }

  /**
   * Before a request: if it would not fit the model's context, trim the older
   * tool results out of the conversation, oldest first, until it is comfortably
   * inside. The newest step's results are the evidence for the next turn, so
   * they are cut to the room left, never to a preview; a result with too little
   * room left is replaced by a notice saying it was left out.
   */
  private async fit(extraChars: number, step: number) {
    let raw: number | ContextCapacity | undefined
    try {
      raw = await this._options.contextWindow?.()
    } catch {
      raw = undefined
    }
    const capacity = toCapacity(raw)
    const limits = this._options.generationLimits?.() ?? NO_GENERATION_LIMITS
    this._plan = capacity ? planContext(capacity.tokens, this._options.maxResultChars, limits.maxOutputTokens) : undefined
    const plan = this._plan
    if (!capacity || !plan) return
    const estimate = () => this._estimator.tokens(charsOf(this._messages) + extraChars)
    const sizeOf = (slot: ResultSlot) => textOf(this._messages[slot.message]?.content).length
    const newest = this._results.length ? this._results[this._results.length - 1].step : 0
    const before = new Map<ResultSlot, number>(this._results.map((slot) => [slot, sizeOf(slot)]))
    const changed = new Map<ResultSlot, ResultBudget["reason"]>()
    if (estimate() > plan.limit) {
      const passes: Array<(slot: ResultSlot) => boolean> = [(slot) => slot.step < newest - 1, (slot) => slot.step < newest]
      let trimmed = 0
      for (const eligible of passes) {
        for (const slot of this._results) {
          if (slot.trimmed || !eligible(slot)) continue
          if (estimate() <= plan.target) break
          this.trim(slot)
          changed.set(slot, "older result trimmed")
          trimmed++
        }
        if (estimate() <= plan.limit) break
      }
      if (trimmed) this._options.onTrim?.(trimmed, estimate())
      for (const slot of this._results) {
        if (slot.trimmed || slot.step !== newest) continue
        const over = estimate() - plan.limit
        if (over <= 0) break
        changed.set(slot, this.cut(slot, over * this._estimator.charsPerToken))
      }
    }
    for (const slot of this._results) {
      if (slot.step !== newest && !changed.has(slot)) continue
      const message = this._messages[slot.message]
      this._options.onBudget?.({
        id: slot.id,
        name: slot.name,
        budgeted: textOf(message?.content).length,
        reason: changed.get(slot) ?? (slot.omitted ? "omitted: no room" : "kept whole"),
        remainingTokens: plan.limit - estimate(),
        retained: !slot.omitted
      })
    }
    const used = estimate()
    const freshSlots = this._results.filter((slot) => slot.step === newest)
    const removedFrom = (reasons: ResultBudget["reason"][]) => {
      const slots = [...changed].filter(([, reason]) => reasons.includes(reason)).map(([slot]) => slot)
      const chars = slots.reduce((sum, slot) => sum + (before.get(slot) ?? 0) - sizeOf(slot), 0)
      return { results: slots.length, chars, tokens: this._estimator.tokens(chars) }
    }
    const olderResults = removedFrom(["older result trimmed"])
    const freshResults = removedFrom(["cut to remaining room", "omitted: no room"])
    const cut = freshSlots.filter((slot) => changed.get(slot) === "cut to remaining room").length
    const omitted = freshSlots.length - freshSlots.filter((slot) => !slot.omitted).length
    const exhausted = used > plan.limit
    const reasons = [
      olderResults.results ? `${olderResults.results} older result(s) trimmed` : undefined,
      cut ? `${cut} fresh result(s) cut` : undefined,
      omitted ? `${omitted} fresh result(s) omitted` : undefined,
      exhausted ? "still over budget after trimming" : undefined
    ].filter((reason): reason is string => reason !== undefined)
    this._options.onContext?.({
      request: step + 1,
      capacity: {
        tokens: capacity.tokens,
        source: capacity.source,
        confirmed: capacity.confirmed,
        advertised: capacity.advertised,
        slots: capacity.slots
      },
      reserved: plan.reserved,
      margin: plan.margin,
      promptBudget: plan.limit,
      estimatedPromptTokens: used,
      remainingTokens: plan.limit - used,
      utilizationPercent: Math.round((used / capacity.tokens) * 1000) / 10,
      fresh: { total: freshSlots.length, retained: freshSlots.length - omitted, cut, omitted },
      removed: { olderResults, freshResults },
      reason: reasons.length ? reasons.join("; ") : "none",
      exhausted
    })
  }

  /** A result's output as the conversation holds it, apart from the folder's instructions and any text after it. */
  private split(slot: ResultSlot) {
    const message = this._messages[slot.message]
    if (!message) return undefined
    const whole = textOf(message.content)
    const after = slot.after && whole.endsWith(slot.after) ? slot.after : ""
    const text = whole.slice(0, whole.length - after.length)
    const body = message.role === "tool" ? text : text.replace(/^<tool_result[^>]*>\n/, "").replace(/\n<\/tool_result>$/, "")
    // Instructions hold for the whole reply, so they outlast the output they came with.
    const preface = slot.preface && body.startsWith(slot.preface) ? slot.preface : ""
    return { message, after, preface, output: preface ? body.slice(preface.length).trimStart() : body }
  }

  private rewrite(slot: ResultSlot, output: string) {
    const parts = this.split(slot)
    if (!parts) return
    const kept = parts.preface ? `${parts.preface}\n\n${output}` : output
    const { message, after } = parts
    this._messages[slot.message] = (
      message.role === "tool" ? { ...message, content: kept } : { ...message, content: toolResultMessage(slot.name, kept) + after }
    ) as ChatMessage
    slot.trimmed = true
  }

  private trim(slot: ResultSlot) {
    const parts = this.split(slot)
    if (parts) this.rewrite(slot, trimmedResult(parts.output))
  }

  /**
   * Cuts a fresh result by `excess` characters, or leaves it out with a notice
   * when too little of it would remain to be worth the model's attention.
   */
  private cut(slot: ResultSlot, excess: number): ResultBudget["reason"] {
    const parts = this.split(slot)
    if (!parts) return "kept whole"
    // A short result costs little, and is often a notice the model needs, such as a refused repeat.
    if (parts.output.length <= MIN_FRESH_CHARS) return "kept whole"
    const room = parts.output.length - Math.ceil(excess)
    if (room >= MIN_FRESH_CHARS) {
      this.rewrite(slot, fitResult(parts.output, room))
      return "cut to remaining room"
    }
    this.rewrite(
      slot,
      `[Not included: this result (${parts.output.length} characters) did not fit in the model's context. Ask for a smaller part, such as a narrower line range.]`
    )
    slot.omitted = true
    return "omitted: no room"
  }

  /** The calls made and what they returned, cut to a size worth carrying into the next turn. */
  private notes(): string | undefined {
    if (!this._record.length) return undefined
    const budget = this._plan?.notesChars ?? 6000
    const each = Math.max(200, Math.min(1200, Math.floor(budget / this._record.length) - 100))
    const blocks = this._record.map((entry) =>
      "said" in entry
        ? `The user, while you worked: ${clipTo(entry.said, each)}`
        : `${entry.name} ${clipTo(JSON.stringify(entry.args), 240)}\n${clipTo(entry.output, each)}`
    )
    // The latest calls say where the work stands; when not all fit, they stay.
    while (blocks.length > 1 && blocks.join("\n\n").length > budget) blocks.shift()
    return clipTo(blocks.join("\n\n"), budget)
  }

  private show(content: string): ChatChunk {
    this._shown += content
    return { content }
  }

  /** Tells the user the host stopped the request; no finished reply is written after it. */
  private *stopped(stop: GenerationStopped): Generator<ChatChunk> {
    this._options.onGenerationStop?.(stop)
    yield this.show(`${this._shown.trim() ? "\n\n" : ""}${generationStopNotice(stop)}`)
  }

  private nativeCalls(toolCalls: ChatToolCall[] | undefined): PendingCall[] {
    return (toolCalls ?? []).slice(0, MAX_CALLS_PER_REPLY).map((raw) => {
      const call = parseArguments(raw)
      // What goes back to the server must parse there too: fluency.js and
      // Ollama both read the arguments as JSON, so mended ones go back mended.
      if ("error" in call) {
        return { raw: { ...raw, arguments: "{}" }, error: call.error, detail: call.detail, written: raw.arguments }
      }
      return { raw: strictJson(raw.arguments) ? raw : { ...raw, arguments: JSON.stringify(call.args) }, call }
    })
  }

  private textCall(found: FoundCall | undefined, reply: { text: string }, step: number): PendingCall[] {
    if (!found) return []
    if (found.call) found.call = nameArguments(found.call, this._workspace.tools)
    const unread = found.call ? {} : { detail: found.detail, written: reply.text.slice(found.start, found.end) }
    if (this._mode === "native") {
      // Carried on as a native call, so the conversation stays in one form.
      reply.text = reply.text.slice(0, found.start).trimEnd()
      const raw = {
        id: `call_text_${step}`,
        name: found.call?.name ?? "unknown",
        arguments: JSON.stringify(found.call?.args ?? {})
      }
      return [{ raw, call: found.call, error: found.error, ...unread }]
    }
    // Only what the model wrote up to the end of its call goes back to it.
    reply.text = reply.text.slice(0, found.end)
    return [{ call: found.call, error: found.error, ...unread }]
  }

  /** The reply that made the calls, and their results, join the conversation. */
  private remember(
    calls: PendingCall[],
    results: ToolResult[],
    text: string,
    found: FoundCall | undefined,
    step: number,
    reasoning?: string
  ): ResultSlot[] {
    const slot = (name: string, preface: string | undefined, id: string): ResultSlot => ({
      id,
      message: this._messages.length,
      step,
      name,
      trimmed: false,
      ...(preface ? { preface } : {})
    })
    const slots: ResultSlot[] = []
    if (this._mode === "native") {
      const assistant: ChatMessage = {
        role: ASSISTANT,
        // Some OpenAI-compatible servers reject `null` for assistant content
        // when tool calls are present; use an empty string instead.
        content: text.trim() ? text : "",
        tool_calls: calls.map(({ raw }) => ({
          id: raw!.id,
          type: "function" as const,
          function: { name: raw!.name, arguments: raw!.arguments }
        }))
      }
      if (reasoning) assistant.reasoning = reasoning
      this._messages.push(assistant)
      calls.forEach(({ raw }, i) => {
        slots.push(slot(raw!.name, results[i].preface, `${step}.${i}`))
        this._messages.push({ role: "tool", tool_call_id: raw!.id, content: results[i].output } as ChatMessage)
      })
      this._results.push(...slots)
      return slots
    }
    const name = calls[0].call?.name ?? "error"
    // A call read before its closing marker arrived is recorded closed.
    this._messages.push({ role: ASSISTANT, content: found?.unclosed ? `${text.trimEnd()}\n${found.unclosed}` : text })
    slots.push(slot(name, results[0].preface, `${step}.0`))
    this._results.push(...slots)
    this._messages.push({ role: USER, content: toolResultMessage(name, results[0].output) })
    return slots
  }
}

/** `client`, with the workspace's tools available to `chat()`. */
export const withTools = (
  client: InferenceClient,
  workspace: WorkspaceTools,
  options: ToolLoopOptions = {}
): InferenceClient => ({
  id: client.id,
  capabilities: () => client.capabilities(),
  models: (o) => client.models(o),
  fim: (request, o) => client.fim(request, o),
  embeddings: (request, o) => client.embeddings(request, o),
  chat: (request, o) => new ToolLoop(client, workspace, options).run(request, o)
})
