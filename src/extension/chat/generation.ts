import { ASSISTANT, EVENT_NAME } from "../../common/constants"
import { formatCount, logger } from "../../common/logger"
import { ChatCompletionMessage, ReplyChangesView, ReplyMeta, TwinnyProvider } from "../../common/types"
import { GenerationRun, GenerationTracker, StopInitiator } from "../generations"
import { ChatRequest, InferenceClient, isCancelled } from "../inference"
import {
  cancelInferenceOperation,
  createInferenceTrace,
  finishInferenceOperation,
  inferenceEvent,
  InferenceTraceContext
} from "../inference/trace"
import { ExtensionBridge } from "../messaging/bridge"
import { describeProviderError, describeProviderErrorPlain, isAbortError } from "../providers/errors"
import { redactEvidence } from "../todos/evidence"

/** Message content is a string, or text parts alongside images. */
const contentText = (content: ChatCompletionMessage["content"]): string => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) =>
      part.type === "text" ? part.text : `[${part.type}]`
    )
    .join("\n")
}

const contentLength = (content: ChatCompletionMessage["content"]) =>
  contentText(content).length

/** What a feature adds to a reply as it ends. */
export interface ReplyExtras {
  /** What the reply's tools were asked and returned, kept with it for the next turn; never shown. */
  toolNotes?(): string | undefined
  /** More about how the reply came about, read once it has ended. */
  meta?(): Partial<ReplyMeta>
  /** True when the reply is worth keeping with no text: its tools ran, and their steps are its record. */
  keepEmpty?(): boolean
  /** Waited for once the reply has ended, before it is kept: work that reads the workspace as the reply left it. */
  settle?(): Promise<void>
  /** The files the reply changed, kept with it (read after `settle`). */
  changes?(): ReplyChangesView | undefined
}

/**
 * One chat request from start to finish: a run on the generation tracker
 * (which owns the spinner and the stop keybinding), streaming partial text to
 * the webview, and turning a failure into a message the user can act on.
 *
 * `prefix` is text shown (and saved) ahead of the model's reply, e.g. a part
 * heading in a multi-part review.
 */
export class ChatGeneration {
  private _run?: GenerationRun
  private _cancelled = false
  private _cancellationReason?: StopInitiator
  private _trace?: InferenceTraceContext
  /** Runs stopped because the user left their conversation: what they wrote is not kept. */
  private readonly _discarded = new WeakSet<GenerationRun>()
  private readonly _stopSubscription: { dispose(): void }

  constructor(
    private readonly _bridge: ExtensionBridge,
    private readonly _generations: GenerationTracker
  ) {
    // The stop command reaches every chat, the panel's as well as the
    // sidebar's, and between the parts of a review as well as during one.
    this._stopSubscription = _generations.onDidStop((initiator) => this.abort(initiator))
  }

  public dispose() {
    this._stopSubscription.dispose()
  }

  /** True once the user has stopped generation, until the next operation starts. */
  public get cancelled() {
    return this._cancelled
  }

  /** Who stopped the operation, if anyone did. */
  public get cancellationReason(): StopInitiator | undefined {
    return this._cancellationReason
  }

  public reset() {
    this._cancelled = false
    this._cancellationReason = undefined
  }

  /**
   * Stop the request in flight. The operation that owns the requests reports
   * its own terminal state to the webview, so this does not end it.
   */
  public abort(initiator: StopInitiator = "user") {
    this._cancelled = true
    this._cancellationReason ??= initiator
    if (this._trace) {
      cancelInferenceOperation(this._trace, initiator, "generation-stopped")
    }
    this._run?.abort(new DOMException(
      `Twinny ${initiator === "user" ? "user stop" : "host cancellation"}`,
      "AbortError"
    ))
  }

  /** Whether a reply is being written now. */
  public get running(): boolean {
    return !!this._run
  }

  /**
   * Stop the reply being written and keep none of it: the user started
   * another conversation or opened an old one, and the reply belongs to
   * neither.
   */
  public discard() {
    if (this._run) this._discarded.add(this._run)
    this.abort()
  }

  /**
   * Run one request against a resolved provider and show the reply as it
   * streams. Whether the provider streams or answers whole is its business.
   */
  public async generate(
    inference: InferenceClient,
    request: ChatRequest,
    provider: TwinnyProvider,
    prefix = "",
    extras: ReplyExtras = {}
  ): Promise<string> {
    if (this._cancelled) return ""
    const run = this._generations.start("chat")
    this._run = run
    const endpoint = provider.apiHostname
      ? `${provider.apiProtocol ?? "http"}://${provider.apiHostname}${provider.apiPort ? `:${provider.apiPort}` : ""}${provider.apiPath ?? ""}`
      : "sdk-managed"
    const trace = createInferenceTrace({ operationKind: "chat", provider: provider.provider, endpoint })
    this._trace = trace
    let operationState = "completed"
    inferenceEvent("operation.started", {
      operation_id: trace.operationId,
      provider: provider.provider,
      endpoint,
      model: provider.modelName,
      kind: "chat"
    })
    let text = prefix
    let streamChunks = 0
    let streamedContentChars = 0
    let reasoningChars = 0
    let finishReason: string | undefined
    const elapsed = this.logRequest(request.messages, provider)
    const started = Date.now()
    const meta: ReplyMeta = { model: provider.modelName, provider: provider.label }
    const finish = (): ReplyMeta => ({
      ...meta,
      ...extras.meta?.(),
      durationMs: Date.now() - started,
      // Stopped by the user; a failure ends the run too, but is not a stop.
      ...(this._cancelled ? { stopped: true } : {})
    })

    try {
      const chunks = inference.chat(request, {
        signal: run.signal,
        trace,
        onBackend: (name) => {
          meta.provider = name
        },
        onShield: (report) => {
          meta.withheld = report
        }
      })
      try {
        for await (const chunk of chunks) {
          streamChunks++
          streamedContentChars += chunk.content.length
          reasoningChars += chunk.reasoning?.length ?? 0
          if (chunk.reasoning) this._bridge.emit(EVENT_NAME.twinnyOnReasoning, redactEvidence(chunk.reasoning))
          if (chunk.finishReason) finishReason = chunk.finishReason
          if (chunk.usage?.completionTokens) {
            meta.completionTokens = chunk.usage.completionTokens
          }
          if (chunk.usage?.promptTokens) {
            meta.promptTokens = chunk.usage.promptTokens
          }
          text += chunk.content
          this._bridge.emit(EVENT_NAME.twinnyOnCompletion, {
            content: text.trimStart() || " ",
            role: ASSISTANT
          })
        }
      } catch (error) {
        // Stopping is not a failure: what arrived is the reply.
        if (!isCancelled(error)) throw error
      }

      const reply = text.trim()
      logger.debug(
        `Chat ← ${elapsed()} · ${formatCount(reply.length)} chars` +
          (run.signal.aborted ? " · stopped by the user" : "")
      )
      logger.block("Chat reply", reply)
      if (!run.signal.aborted && !text.slice(prefix.length).trim() && !extras.keepEmpty?.()) {
        const streamState = streamChunks === 0
          ? "the provider emitted no response chunks"
          : streamedContentChars === 0
            ? "the stream contained no visible text"
            : "Twinny received content but no usable text or completed tool call remained after response parsing"
        const reasoning = reasoningChars ? `; ${reasoningChars} reasoning characters were received without visible content` : ""
        throw new Error(`The provider completed without usable chat content or a completed tool call (${streamState}; finish reason: ${finishReason ?? "not provided"}${reasoning}). Check the model/server response and tool-call support, then retry.`)
      }
      await extras.settle?.()
      // A discarded reply is nobody's: not shown, and not part of the conversation.
      if (this._discarded.has(run)) return ""
      if (reply || extras.keepEmpty?.()) this.addMessage(reply, finish(), extras.toolNotes?.(), extras.changes?.())
      return reply
    } catch (error) {
      operationState = run.signal.aborted ? "cancelled" : "failed"
      run.finish()
      // Keep whatever streamed before the failure; it is still useful.
      // A bare heading is not.
      const partial = text.trim() === prefix.trim() ? "" : text.trim()
      if (this._discarded.has(run)) return ""
      await extras.settle?.().catch(() => undefined)
      if (partial || extras.keepEmpty?.()) this.addMessage(partial, finish(), extras.toolNotes?.(), extras.changes?.())
      this.report(error, provider)
      return partial
    } finally {
      run.finish()
      finishInferenceOperation(trace, operationState, {
        duration_ms: Date.now() - started,
        provider: provider.provider,
        model: provider.modelName
      })
      if (this._trace === trace) this._trace = undefined
      if (this._run === run) this._run = undefined
    }
  }

  private addMessage(content: string, meta?: ReplyMeta, toolNotes?: string, changes?: ReplyChangesView) {
    this._bridge.emit(EVENT_NAME.twinnyAddMessage, {
      content,
      role: ASSISTANT,
      ...(meta ? { meta } : {}),
      ...(toolNotes ? { toolNotes } : {}),
      ...(changes ? { changes } : {})
    })
  }

  /**
   * One line saying what is being sent and to whom; the messages
   * themselves at debug level. Returns the stopwatch for the reply line.
   */
  private logRequest(
    messages: ChatCompletionMessage[],
    provider: TwinnyProvider
  ) {
    const chars = messages.reduce((sum, m) => sum + contentLength(m.content), 0)
    logger.debug(
      `Chat → ${provider.modelName} (${provider.label}) · ` +
        `${messages.length} message${messages.length === 1 ? "" : "s"}, ` +
        `${formatCount(chars)} chars`
    )
    logger.block(
      "Chat messages",
      messages
        .map((m) => `[${m.role}]\n${contentText(m.content)}`)
        .join("\n\n")
    )
    return logger.timer()
  }

  /** A stopped request is not an error; anything else gets explained. */
  private report(error: unknown, provider: TwinnyProvider) {
    if (isAbortError(error) || this._cancelled) return
    logger.error(`Chat failed: ${describeProviderErrorPlain(error, provider)}`)
    this.addMessage(describeProviderError(error, provider))
  }
}
