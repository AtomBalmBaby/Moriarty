/**
 * How many tokens the model behind a provider can hold, as far as its
 * server will say.
 *
 * A local server decides this when it loads the model, and it is often far
 * less than the model was trained for (Ollama loads 4k to 32k unless told
 * otherwise), so the only honest source is the server itself. A size is
 * confirmed when the server reports the context it runs with; a model's own
 * maximum is advertised only. A hosted API is not asked. When nothing is
 * confirmed, the fallback applies and the result is marked unconfirmed.
 *
 * Asking is cheap but not free, so an answer is kept for a short while. An
 * answer that confirmed nothing (Ollama before the model's first request) is
 * asked again sooner.
 */
import { API_PROVIDERS } from "../../common/constants"
import { deadline } from "../../common/deadline"
import { getProviderOrigin } from "../../common/provider-validation"
import { TwinnyProvider } from "../../common/types"
import { ConfirmedCapacity, ContextCapacity, FALLBACK_CONTEXT_TOKENS, SUPPORTED_CONTEXT_TOKENS } from "../tools/budget"

import { providerRegistry } from "./registry"

const KEEP_CONFIRMED_MS = 30_000
const KEEP_UNCONFIRMED_MS = 3000
const ASK_TIMEOUT_MS = 1500
/** Far above any window in use; a larger number is taken as malformed. */
const MAX_PLAUSIBLE_TOKENS = 10_000_000

/** What one server said about a model's context. */
export interface ServerProbe {
  confirmed: ConfirmedCapacity[]
  advertised?: number
  slots?: number
}

export type ContextSetting =
  | { mode: "auto" }
  | { mode: "override"; tokens: number }
  | { mode: "invalid"; value: string }

export interface ContextOptions {
  setting: unknown
  fallback: unknown
}

interface Known {
  probe: ServerProbe
  at: number
}

let clock = () => Date.now()

const known = new Map<string, Known>()

const keyOf = (provider: TwinnyProvider) =>
  [
    provider.provider,
    provider.apiProtocol ?? "",
    provider.apiHostname ?? "",
    provider.apiPort ?? "",
    provider.modelName
  ].join("|")

const originOf = (provider: TwinnyProvider) =>
  getProviderOrigin({ ...provider, apiHostname: provider.apiHostname || "localhost" })

const ask = async (provider: TwinnyProvider, url: string, body?: unknown): Promise<unknown> => {
  const { signal, done } = deadline(ASK_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {})
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal
    })
    return response.ok ? await response.json() : undefined
  } catch {
    return undefined
  } finally {
    done()
  }
}

const positive = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value > 0 && value <= MAX_PLAUSIBLE_TOKENS
    ? value
    : undefined

const sized = (source: ConfirmedCapacity["source"], tokens: number | undefined): ConfirmedCapacity[] =>
  tokens === undefined ? [] : [{ source, tokens }]

/** `llama3` and `llama3:latest` are one model to Ollama. */
const sameOllamaModel = (a: string, b: string) => {
  const tagged = (name: string) => (name.includes(":") ? name : `${name}:latest`)
  return tagged(a) === tagged(b)
}

/**
 * Ollama: a loaded model reports the context it runs with. An unloaded one
 * is confirmed only by the `num_ctx` its Modelfile sets, which Ollama loads
 * it with unless a request says otherwise. The model's own maximum is
 * advertised only, since Ollama may load it with less.
 */
const fromOllama = async (provider: TwinnyProvider): Promise<ServerProbe> => {
  const origin = originOf(provider)
  const loaded = (await ask(provider, `${origin}/api/ps`)) as
    | { models?: { name?: string; model?: string; context_length?: unknown }[] }
    | undefined
  const running = loaded?.models?.find(
    (model) =>
      sameOllamaModel(model.name ?? "", provider.modelName) || sameOllamaModel(model.model ?? "", provider.modelName)
  )
  const shown = (await ask(provider, `${origin}/api/show`, { model: provider.modelName })) as
    | { parameters?: unknown; model_info?: Record<string, unknown> }
    | undefined
  const runtime = positive(running?.context_length)
  const set = typeof shown?.parameters === "string" ? /^\s*num_ctx\s+(\d+)/m.exec(shown.parameters) : null
  const modelfile = set ? positive(Number(set[1])) : undefined
  const maximum = Object.entries(shown?.model_info ?? {}).find(([key]) => key.endsWith(".context_length"))?.[1]
  return {
    confirmed: runtime ? sized("runtime", runtime) : sized("configured", modelfile),
    advertised: positive(maximum)
  }
}

/**
 * llama.cpp: `n_ctx` is the context one slot holds, and a request uses one
 * slot; `total_slots` is how many run at once, so the server's total is that
 * times the slots. A router-mode server needs the model named and would load
 * it to answer; asking must not load anything.
 */
const fromLlamaCpp = async (provider: TwinnyProvider): Promise<ServerProbe> => {
  const query = provider.modelName
    ? `?model=${encodeURIComponent(provider.modelName)}&autoload=false`
    : ""
  const props = (await ask(provider, `${originOf(provider)}/props${query}`)) as
    | { default_generation_settings?: { n_ctx?: unknown }; total_slots?: unknown }
    | undefined
  return {
    confirmed: sized("runtime", positive(props?.default_generation_settings?.n_ctx)),
    slots: positive(props?.total_slots)
  }
}

/** LM Studio: the loaded context is confirmed; the model's own maximum is advertised only. */
const fromLmStudio = async (provider: TwinnyProvider): Promise<ServerProbe> => {
  const listing = (await ask(provider, `${originOf(provider)}/api/v0/models`)) as
    | { data?: { id?: string; loaded_context_length?: unknown; max_context_length?: unknown }[] }
    | undefined
  const model = listing?.data?.find((entry) => entry.id === provider.modelName)
  return {
    confirmed: sized("runtime", positive(model?.loaded_context_length)),
    advertised: positive(model?.max_context_length)
  }
}

/** A gateway lists each model's context when its admin set one. */
const fromListing = async (provider: TwinnyProvider): Promise<ServerProbe> => {
  try {
    const models = await providerRegistry.resolve(provider).models()
    const model = models.find((entry) => entry.id === provider.modelName)
    return { confirmed: sized("listing", positive(model?.contextWindow)) }
  } catch {
    return { confirmed: [] }
  }
}

/**
 * An OpenAI-compatible server's model list. Fields that state the context a
 * server loaded or serves are confirmed; fields that state a model's maximum
 * are advertised only. The standard list carries neither, and that is fine.
 */
const fromModelList = async (provider: TwinnyProvider): Promise<ServerProbe> => {
  const listing = (await ask(provider, `${originOf(provider)}/v1/models`)) as
    | { data?: Record<string, unknown>[] }
    | undefined
  const model = listing?.data?.find((entry) => entry.id === provider.modelName)
  return {
    confirmed: [
      ...sized("runtime", positive(model?.loaded_context_length)),
      ...sized("configured", positive(model?.max_model_len))
    ],
    advertised:
      positive(model?.context_length) ?? positive(model?.context_window) ?? positive(model?.max_context_length)
  }
}

const probeOf = (provider: TwinnyProvider): Promise<ServerProbe> => {
  switch (provider.provider) {
    case API_PROVIDERS.Ollama:
      return fromOllama(provider)
    case API_PROVIDERS.LlamaCpp:
      return fromLlamaCpp(provider)
    case API_PROVIDERS.LMStudio:
      return fromLmStudio(provider)
    case API_PROVIDERS.TwinnyRemote:
      return fromListing(provider)
    case API_PROVIDERS.OpenAICompatible:
    case API_PROVIDERS.LiteLLM:
    case API_PROVIDERS.OpenWebUI:
    case API_PROVIDERS.Oobabooga:
    case API_PROVIDERS.Qvac:
      return fromModelList(provider)
    default:
      // Hosted APIs and anything unlisted are not asked; they resolve as unconfirmed.
      return Promise.resolve({ confirmed: [] })
  }
}

/** What the server says, asked again only once the cached answer is stale. */
export const serverProbeOf = async (provider: TwinnyProvider): Promise<ServerProbe> => {
  const key = keyOf(provider)
  const cached = known.get(key)
  const age = cached ? clock() - cached.at : Infinity
  const keep = cached?.probe.confirmed.length ? KEEP_CONFIRMED_MS : KEEP_UNCONFIRMED_MS
  if (cached && age < keep) return cached.probe
  const probe = await probeOf(provider)
  known.set(key, { probe, at: clock() })
  return probe
}

/**
 * The `twinny.chatContextWindow` setting: "Auto" (or unset) asks the server;
 * a positive whole number is the user's own figure. Anything else is invalid
 * and is treated as Auto by the caller, which reports it.
 */
export const parseContextSetting = (value: unknown): ContextSetting => {
  if (value === undefined || value === null) return { mode: "auto" }
  if (typeof value === "string" && (value.trim() === "" || value.trim().toLowerCase() === "auto")) {
    return { mode: "auto" }
  }
  const tokens =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\s*\d+\s*$/.test(value)
        ? Number(value)
        : Number.NaN
  if (positive(tokens)) return { mode: "override", tokens }
  return { mode: "invalid", value: String(value) }
}

/** The `twinny.chatContextFallback` setting, or the default when it is not a positive whole number. */
export const resolveFallback = (value: unknown): number => positive(value) ?? FALLBACK_CONTEXT_TOKENS

/**
 * The capacity a request is planned for. A user's figure wins. Otherwise the
 * smallest confirmed size, so the server's own limit is never exceeded. With
 * nothing confirmed, the fallback applies and says so.
 */
export const resolveCapacity = (
  probe: ServerProbe,
  setting: ContextSetting,
  fallback: number
): ContextCapacity => {
  const considered = [...probe.confirmed].sort((a, b) => a.tokens - b.tokens)
  const smallest = considered[0]
  const detail = {
    considered,
    ...(probe.advertised === undefined ? {} : { advertised: probe.advertised }),
    ...(probe.slots === undefined ? {} : { slots: probe.slots })
  }
  if (setting.mode === "override") {
    const above = smallest && setting.tokens > smallest.tokens
      ? `twinny.chatContextWindow is ${setting.tokens}, but the server confirmed ${smallest.tokens}; the server may cut requests above that.`
      : undefined
    const below = setting.tokens < SUPPORTED_CONTEXT_TOKENS
      ? `${setting.tokens} tokens is below the ${SUPPORTED_CONTEXT_TOKENS}-token minimum for agent work; results will be trimmed to fit.`
      : undefined
    return {
      ...detail,
      tokens: setting.tokens,
      source: "override",
      confirmed: true,
      warning: above ?? below
    }
  }
  if (smallest) {
    return {
      ...detail,
      tokens: smallest.tokens,
      source: smallest.source,
      confirmed: true,
      warning:
        smallest.tokens < SUPPORTED_CONTEXT_TOKENS
          ? `The server confirmed ${smallest.tokens} tokens, below the ${SUPPORTED_CONTEXT_TOKENS}-token minimum for agent work; results will be trimmed to fit.`
          : undefined
    }
  }
  const invalid = setting.mode === "invalid" ? ` twinny.chatContextWindow "${setting.value}" is not a token count.` : ""
  return {
    ...detail,
    tokens: fallback,
    source: "fallback",
    confirmed: false,
    warning: `No server confirmed this model's context; planning for ${fallback} tokens.${invalid} Set twinny.chatContextWindow to the model's context to be exact.`
  }
}

/** The capacity for `provider`, asking its server if the answer is not cached. */
export const contextCapacityOf = async (provider: TwinnyProvider, options: ContextOptions): Promise<ContextCapacity> =>
  resolveCapacity(await serverProbeOf(provider), parseContextSetting(options.setting), resolveFallback(options.fallback))

/** The capacity from the last answer for `provider`, without asking: for showing next to a reply. */
export const knownContextCapacity = (provider: TwinnyProvider, options: ContextOptions): ContextCapacity | undefined => {
  const cached = known.get(keyOf(provider))
  return cached
    ? resolveCapacity(cached.probe, parseContextSetting(options.setting), resolveFallback(options.fallback))
    : undefined
}

/** For configuration changes and tests: forget every answer. */
export const forgetContextWindows = () => known.clear()

/** For tests: read time from `now` instead of the system clock. */
export const setContextClock = (now: () => number) => {
  clock = now
}
