/**
 * Where a configured provider becomes something a feature can call.
 *
 * Adapters register for the provider kinds they serve. `resolve()` picks
 * the adapter for a configuration, builds its provider, and wraps it so
 * that every capability is callable, unsupported ones fail before any
 * request is made, cancellation ends a read at once, and whatever a client
 * throws comes out as an `InferenceError`.
 */
import { API_PROVIDERS, OPEN_AI_COMPATIBLE_PROVIDERS } from "../../common/constants"
import { HOSTED_PROVIDERS } from "../../common/provider-validation"
import { TwinnyProvider } from "../../common/types"
import { RemoteInferenceProvider } from "../../protocol/client"

import { ChatGPTPlanInferenceProvider } from "./adapters/chatgpt-plan"
import { HostedInferenceProvider } from "./adapters/hosted"
import { HttpInferenceProvider } from "./adapters/http"
import { InferenceError, toInferenceError, unsupportedCapability } from "./errors"
import { SecretShieldMode, shieldClient, shouldShield } from "./shield"
import { abortable } from "./stream"
import { createInferenceTrace, inferenceEvent, startInferenceRequest } from "./trace"
import {
  InferenceCapability,
  InferenceClient,
  InferenceOptions,
  InferenceProvider
} from "./types"

/** One way of serving a family of provider kinds. */
export interface InferenceAdapter {
  readonly id: string
  create(config: TwinnyProvider): InferenceProvider
}

const guardedStream = <T>(
  provider: InferenceProvider,
  run: ((options: InferenceOptions) => AsyncIterable<T>) | undefined,
  capability: InferenceCapability,
  options?: InferenceOptions,
  model?: string
): AsyncIterable<T> => {
  if (!run || !provider.capabilities().includes(capability)) {
    throw unsupportedCapability(provider.id, capability)
  }
  const trace = createInferenceTrace(options?.trace)
  const tracedOptions = { ...options, trace }
  return (async function* () {
    const finish = startInferenceRequest(trace, {
      provider: trace.provider ?? provider.id,
      endpoint: trace.endpoint ?? "sdk-managed",
      model,
      capability
    }, options?.signal)
    let state = "completed"
    try {
      if (options?.signal?.aborted) {
        inferenceEvent("request.cancelled_before_dispatch", {
          operation_id: trace.operationId,
          request_id: trace.requestId,
          provider: trace.provider ?? provider.id,
          tool_loop_step: trace.toolLoopStep,
          queued_requests: 0
        }, "warn")
        state = "cancelled"
        throw options.signal.reason ?? new DOMException("The request was cancelled.", "AbortError")
      }
      yield* abortable(run(tracedOptions), options?.signal)
    } catch (error) {
      state = options?.signal?.aborted ? "cancelled" : "failed"
      finish(state, error)
      throw toInferenceError(error)
    } finally {
      finish(state)
    }
  })()
}

const guardedPromise = async <T>(
  provider: InferenceProvider,
  what: InferenceCapability | "models",
  run: ((options: InferenceOptions) => Promise<T>) | undefined,
  options?: InferenceOptions,
  model?: string
): Promise<T> => {
  if (!run || (what !== "models" && !provider.capabilities().includes(what))) {
    throw unsupportedCapability(provider.id, what)
  }
  const trace = createInferenceTrace(options?.trace)
  const finish = startInferenceRequest(trace, {
    provider: trace.provider ?? provider.id,
    endpoint: trace.endpoint ?? "sdk-managed",
    model,
    capability: what
  }, options?.signal)
  let state = "completed"
  try {
    if (options?.signal?.aborted) {
      inferenceEvent("request.cancelled_before_dispatch", {
        operation_id: trace.operationId,
        request_id: trace.requestId,
        provider: trace.provider ?? provider.id,
        queued_requests: 0
      }, "warn")
      state = "cancelled"
      throw options.signal.reason ?? new DOMException("The request was cancelled.", "AbortError")
    }
    return await run({ ...options, trace })
  } catch (error) {
    state = options?.signal?.aborted ? "cancelled" : "failed"
    finish(state, error)
    throw toInferenceError(error)
  } finally {
    finish(state)
  }
}

/** The provider boundary, applied to whatever an adapter built. */
export const guard = (provider: InferenceProvider): InferenceClient => ({
  id: provider.id,
  capabilities: () => provider.capabilities(),
  models: (options) =>
    guardedPromise(provider, "models", provider.models && ((o) => provider.models!(o)), options),
  fim: (request, options) =>
    guardedStream(
      provider,
      provider.fim && ((o) => provider.fim!(request, o)),
      "fim",
      options,
      request.model
    ),
  chat: (request, options) =>
    guardedStream(
      provider,
      provider.chat && ((o) => provider.chat!(request, o)),
      "chat",
      options,
      request.model
    ),
  embeddings: (request, options) =>
    guardedPromise(
      provider,
      "embeddings",
      provider.embeddings && ((o) => provider.embeddings!(request, o)),
      options,
      request.model
    )
})

export class ProviderRegistry {
  private readonly _adapters = new Map<string, InferenceAdapter>()

  /** Serve these provider kinds with this adapter; a later call replaces. */
  public register(providerIds: string | string[], adapter: InferenceAdapter): this {
    for (const id of Array.isArray(providerIds) ? providerIds : [providerIds]) {
      this._adapters.set(id, adapter)
    }
    return this
  }

  public unregister(providerId: string): this {
    this._adapters.delete(providerId)
    return this
  }

  public get(providerId: string): InferenceAdapter | undefined {
    return this._adapters.get(providerId)
  }

  public has(providerId: string): boolean {
    return this._adapters.has(providerId)
  }

  public providerIds(): string[] {
    return [...this._adapters.keys()]
  }

  /** The client for a configured provider. Throws when nothing serves its kind. */
  public resolve(config: TwinnyProvider): InferenceClient {
    const adapter = this._adapters.get(config.provider)
    if (!adapter) {
      throw new InferenceError(
        "provider-unavailable",
        `No inference adapter is registered for provider "${config.provider}".`
      )
    }
    const endpoint = config.apiHostname
      ? `${config.apiProtocol ?? "http"}://${config.apiHostname}${config.apiPort ? `:${config.apiPort}` : ""}${config.apiPath ?? ""}`
      : "sdk-managed"
    const provider = guard(adapter.create(config))
    return {
      ...provider,
      chat: (request, options) => provider.chat(request, {
        ...options,
        trace: createInferenceTrace({
          ...options?.trace,
          endpoint,
          provider: config.provider
        })
      }),
      fim: (request, options) => provider.fim(request, {
        ...options,
        trace: createInferenceTrace({
          ...options?.trace,
          endpoint,
          provider: config.provider
        })
      }),
      embeddings: (request, options) => provider.embeddings(request, {
        ...options,
        trace: createInferenceTrace({
          ...options?.trace,
          endpoint,
          provider: config.provider
        })
      }),
      models: (options) => provider.models({
        ...options,
        trace: createInferenceTrace({
          ...options?.trace,
          endpoint,
          provider: config.provider
        })
      })
    }
  }
}

export const httpAdapter: InferenceAdapter = {
  id: "http",
  create: (config) => new HttpInferenceProvider(config)
}

export const hostedAdapter: InferenceAdapter = {
  id: "hosted",
  create: (config) => new HostedInferenceProvider(config)
}

/** A Twinny gateway: the same jobs, carried over the remote protocol. */
/** The open workspace's name, when VS Code is around; the gateway's routing rules match on it. */
const workspaceName = (): string | undefined => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const vscode = require("vscode") as typeof import("vscode")
    return vscode.workspace.workspaceFolders?.[0]?.name
  } catch {
    return undefined
  }
}

export const remoteAdapter: InferenceAdapter = {
  id: "remote",
  create: (config) => RemoteInferenceProvider.fromProvider(config, undefined, workspaceName)
}

export const chatGPTPlanAdapter: InferenceAdapter = {
  id: "chatgpt-plan",
  create: (config) => new ChatGPTPlanInferenceProvider(config)
}

/** The registry the extension uses, with every built-in kind served. */
export const providerRegistry = new ProviderRegistry()
  .register(Object.values(OPEN_AI_COMPATIBLE_PROVIDERS), httpAdapter)
  .register(HOSTED_PROVIDERS, hostedAdapter)
  .register(API_PROVIDERS.TwinnyRemote, remoteAdapter)
  .register(API_PROVIDERS.ChatGPTPlan, chatGPTPlanAdapter)

/** The `twinny.secretShield` setting, when VS Code is around. */
const secretShieldMode = (): SecretShieldMode => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const vscode = require("vscode") as typeof import("vscode")
    return vscode.workspace
      .getConfiguration("twinny")
      .get<SecretShieldMode>("secretShield", "offMachine")
  } catch {
    return "offMachine"
  }
}

/**
 * The client a feature calls. Requests that would leave the machine go
 * through the secret shield; the gateway resolves through the registry
 * directly and is not affected.
 */
export const resolveInferenceProvider = (config: TwinnyProvider): InferenceClient => {
  const client = providerRegistry.resolve(config)
  return shouldShield(config, secretShieldMode()) ? shieldClient(client, config) : client
}
