import { existsSync, readFileSync } from "fs"
import { resolve } from "path"

import { messageOf } from "../../common/errors"
import { logger } from "../../common/logger"
import {
  isProviderLike,
  normalizeProvider,
  validateProvider
} from "../../common/provider-validation"
import { TwinnyProvider } from "../../common/types"

import type { ProviderStore } from "./store"

export const TWINNY_DEV_PROVIDERS_FILE = "TWINNY_DEV_PROVIDERS_FILE"
export const TWINNY_DEV_PROVIDERS_OVERRIDE = "TWINNY_DEV_PROVIDERS_OVERRIDE"
export const TWINNY_LIVE = "TWINNY_LIVE"

export const isDevelopmentHost = (context?: { extensionMode?: number } | null) => {
  const mode = context?.extensionMode
  return mode === 1 || mode === 2
}

export const isDevProviderOverrideEnabled = (
  env: NodeJS.ProcessEnv = process.env
): boolean => {
  const raw = env[TWINNY_DEV_PROVIDERS_OVERRIDE]
  return raw === "1" || raw === "true" || env[TWINNY_LIVE] === "1"
}

export const shouldApplyDevelopmentProviders = (
  context?: { extensionMode?: number } | null,
  env: NodeJS.ProcessEnv = process.env
): boolean => {
  if (!isDevelopmentHost(context)) return false
  return !!(env[TWINNY_DEV_PROVIDERS_FILE] || "").trim()
}

export const parseDevelopmentProviders = (data: string): TwinnyProvider[] => {
  const parsed = JSON.parse(data)
  const entries = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object"
      ? Object.values(parsed as Record<string, unknown>)
      : []

  if (!entries.length) {
    throw new Error(
      "The development provider config is empty. Use the exported Twinny provider format (object keyed by id or an array of providers)."
    )
  }

  const providers: TwinnyProvider[] = []
  const problems: string[] = []
  for (const entry of entries) {
    if (!isProviderLike(entry)) {
      problems.push("an entry that is not a provider")
      continue
    }

    const normalized = normalizeProvider(entry as TwinnyProvider)
    const { valid, errors } = validateProvider(normalized)
    if (!valid) {
      problems.push(
        `${normalized.label || "unnamed provider"}: ${Object.values(errors).join(", ")}`
      )
      continue
    }

    providers.push(normalized)
  }

  if (!providers.length) {
    const message = problems.length
      ? problems[0]
      : "No valid providers were found in the file."
    throw new Error(`Invalid development provider config: ${message}`)
  }

  return providers
}

export const readDevelopmentProviders = (filePath: string): TwinnyProvider[] => {
  const resolved = resolve(filePath)
  if (!existsSync(resolved)) {
    throw new Error(
      `${TWINNY_DEV_PROVIDERS_FILE} points to a missing file: ${resolved}`
    )
  }

  try {
    const data = readFileSync(resolved, "utf8")
    return parseDevelopmentProviders(data)
  } catch (error) {
    throw new Error(
      `Could not read ${TWINNY_DEV_PROVIDERS_FILE} at ${resolved}: ${messageOf(error)}`
    )
  }
}

const endpointUrl = (provider: TwinnyProvider) => {
  const hostname = provider.apiHostname || "localhost"
  const port = provider.apiPort ?? 80
  const protocol = provider.apiProtocol || "http"
  const path = provider.apiPath || "/"
  const base = `${protocol}://${hostname}:${port}`
  return `${base}${path.startsWith("/") ? path : `/${path}`}`
}

export const isProviderReachable = async (
  provider: TwinnyProvider,
  timeoutMs = 5000
): Promise<void> => {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const response = await fetch(endpointUrl(provider), {
      method: "GET",
      signal: controller.signal
    })
    clearTimeout(timer)
    if (!response.ok && response.status >= 500) {
      throw new Error(`HTTP ${response.status}`)
    }
  } catch (error) {
    throw new Error(
      `The configured provider "${provider.label || provider.modelName || "unnamed"}" at ${endpointUrl(provider)} could not be reached: ${messageOf(error)}`
    )
  }
}

export const applyDevelopmentProviders = async (
  context: { extensionMode?: number } | null | undefined,
  store: ProviderStore,
  env: NodeJS.ProcessEnv = process.env
): Promise<boolean> => {
  if (!shouldApplyDevelopmentProviders(context, env)) return false

  const file = (env[TWINNY_DEV_PROVIDERS_FILE] || "").trim()
  if (!file) return false

  const providers = readDevelopmentProviders(file)
  for (const provider of providers) {
    await isProviderReachable(provider)
  }

  const all = await store.getProviders()
  for (const provider of providers) all[provider.id] = provider
  await store.saveProviders(all)

  const override = isDevProviderOverrideEnabled(env)
  for (const type of ["chat", "fim", "embedding"] as const) {
    const provider = providers.find((item) => item.type === type)
    if (!provider) continue
    const active = store.getActive(type)
    if (override || !active) {
      await store.setActive(type, provider)
    }
  }

  await store.repairActive()
  logger.info(
    `Loaded ${providers.length} development providers from ${file} (${override ? "override" : "preserve"} mode).`
  )
  return true
}
