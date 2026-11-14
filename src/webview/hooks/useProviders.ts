import { useCallback, useEffect, useState } from "react"

import { EVENT_NAME, PROVIDER_EVENT_NAME } from "../../common/constants"
import { messageOf } from "../../common/errors"
import {
  ChatGPTPlanStatus,
  ContextUsageStatus,
  ContextWindowStatus,
  ProviderModelList,
  ProviderSaveResult,
  ProviderTestResult
} from "../../common/messaging/protocol"
import { DiscoveredServer } from "../../common/provider-discovery"
import { ProviderType } from "../../common/provider-validation"
import { TwinnyProvider } from "../../common/types"
import { bridge, emit, useServerEvent } from "../messaging"

const failed = (error: unknown): ProviderTestResult => ({
  success: false,
  error: messageOf(error)
})

/**
 * The size the active chat provider's server says its model holds. Asked again
 * when the provider or `refreshKey` changes; `null` until the answer arrives.
 */
export const useContextWindow = (
  provider: TwinnyProvider | null,
  refreshKey: number
): ContextWindowStatus | null => {
  const [status, setStatus] = useState<ContextWindowStatus | null>(null)
  const key = provider
    ? [provider.id, provider.provider, provider.modelName, provider.apiProtocol, provider.apiHostname, provider.apiPort, provider.apiPath, provider.deviceId].join("|")
    : ""

  useEffect(() => {
    if (!provider) {
      setStatus(null)
      return
    }
    let cancelled = false
    bridge
      .request(EVENT_NAME.twinnyGetContextWindow, provider)
      .then((answer) => {
        if (!cancelled) setStatus(answer ?? null)
      })
      .catch(() => {
        if (!cancelled) setStatus(null)
      })
    return () => {
      cancelled = true
    }
  }, [key, refreshKey])

  return status
}

/** How often the composer reads the running conversation's live usage. */
export const CONTEXT_USAGE_POLL_MS = 1000

/**
 * The running conversation's live prompt usage, read on a timer. `null` until a
 * model request for this conversation has been made.
 */
export const useContextUsage = (conversationId: string | undefined): ContextUsageStatus | null => {
  const [usage, setUsage] = useState<ContextUsageStatus | null>(null)

  useEffect(() => {
    let cancelled = false
    const read = () => {
      bridge
        .request(EVENT_NAME.twinnyGetContextUsage, { conversationId })
        .then((answer) => {
          if (cancelled) return
          setUsage((previous) =>
            previous?.tokens === answer?.tokens && previous?.counted === answer?.counted ? previous : answer ?? null
          )
        })
        .catch(() => {
          if (!cancelled) setUsage(null)
        })
    }
    read()
    const timer = setInterval(read, CONTEXT_USAGE_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [conversationId])

  return usage
}

export const useProviders = () => {
  const [providers, setProviders] = useState<Record<string, TwinnyProvider>>({})
  const [chatProvider, setChatProvider] = useState<TwinnyProvider | null>(null)
  const [intentProvider, setIntentProvider] = useState<TwinnyProvider | null>(null)
  const [fimProvider, setFimProvider] = useState<TwinnyProvider | null>(null)
  const [embeddingProvider, setEmbeddingProvider] =
    useState<TwinnyProvider | null>(null)
  /** False until the extension has answered once; the list is unknown before. */
  const [ready, setReady] = useState(false)

  useServerEvent(PROVIDER_EVENT_NAME.getAllProviders, (all) => {
    setProviders(all || {})
    setReady(true)
  })
  useServerEvent(PROVIDER_EVENT_NAME.getActiveChatProvider, (provider) =>
    setChatProvider(provider || null)
  )
  useServerEvent(PROVIDER_EVENT_NAME.getActiveIntentProvider, (provider) =>
    setIntentProvider(provider || null)
  )
  useServerEvent(PROVIDER_EVENT_NAME.getActiveFimProvider, (provider) =>
    setFimProvider(provider || null)
  )
  useServerEvent(PROVIDER_EVENT_NAME.getActiveEmbeddingsProvider, (provider) =>
    setEmbeddingProvider(provider || null)
  )

  useEffect(() => {
    emit(PROVIDER_EVENT_NAME.getAllProviders)
    emit(PROVIDER_EVENT_NAME.getActiveChatProvider)
    emit(PROVIDER_EVENT_NAME.getActiveIntentProvider)
    emit(PROVIDER_EVENT_NAME.getActiveFimProvider)
    emit(PROVIDER_EVENT_NAME.getActiveEmbeddingsProvider)
  }, [])

  const getProvidersByType = useCallback(
    (type: string) =>
      Object.values(providers).filter((provider) => provider.type === type),
    [providers]
  )

  const activeProviders: Record<ProviderType, TwinnyProvider | null> = {
    chat: chatProvider,
    intent: intentProvider,
    fim: fimProvider,
    embedding: embeddingProvider
  }

  const setActiveProvider = useCallback(
    (type: ProviderType, provider: TwinnyProvider) => {
      const channel = {
        chat: PROVIDER_EVENT_NAME.setActiveChatProvider,
        intent: PROVIDER_EVENT_NAME.setActiveIntentProvider,
        fim: PROVIDER_EVENT_NAME.setActiveFimProvider,
        embedding: PROVIDER_EVENT_NAME.setActiveEmbeddingsProvider
      }[type]
      emit(channel, provider)
    },
    []
  )

  return {
    activeProviders,
    chatProvider,
    intentProvider,
    ready,
    embeddingProvider,
    fimProvider,
    getProvidersByType,
    providers,
    setActiveProvider,
    copyProvider: (p: TwinnyProvider) =>
      emit(PROVIDER_EVENT_NAME.copyProvider, p),
    removeProvider: (p: TwinnyProvider) =>
      emit(PROVIDER_EVENT_NAME.removeProvider, p),
    resetProviders: () => emit(PROVIDER_EVENT_NAME.resetProvidersToDefaults),
    /** Adds a provider; the reply says whether it was accepted. */
    saveProvider: (p: TwinnyProvider): Promise<ProviderSaveResult> =>
      bridge.request(PROVIDER_EVENT_NAME.addProvider, p),
    updateProvider: (p: TwinnyProvider): Promise<ProviderSaveResult> =>
      bridge.request(PROVIDER_EVENT_NAME.updateProvider, p),
    getChatGPTPlanStatus: (): Promise<ChatGPTPlanStatus> =>
      bridge.request(PROVIDER_EVENT_NAME.getChatGPTPlanStatus),
    signInChatGPTPlan: (): Promise<ChatGPTPlanStatus> =>
      bridge.request(PROVIDER_EVENT_NAME.signInChatGPTPlan),
    signOutChatGPTPlan: (): Promise<ChatGPTPlanStatus> =>
      bridge.request(PROVIDER_EVENT_NAME.signOutChatGPTPlan),
    /** Sends one real request to the provider and reports what happened. */
    testProvider: (p: TwinnyProvider): Promise<ProviderTestResult> =>
      bridge.request(PROVIDER_EVENT_NAME.testProvider, p).catch(failed),
    /** Asks the provider's own endpoint which models it serves. */
    listModels: (p: TwinnyProvider): Promise<ProviderModelList> =>
      bridge
        .request(PROVIDER_EVENT_NAME.listProviderModels, p)
        .catch((error) => ({ models: [], error: failed(error).error })),
    /** Asks the usual local ports which model servers are running. */
    discoverServers: (): Promise<DiscoveredServer[]> =>
      bridge.request(PROVIDER_EVENT_NAME.discoverProviders).catch(() => []),
    /** Creates providers for a found server and makes them active. */
    useDiscoveredServer: (server: DiscoveredServer): Promise<TwinnyProvider[]> =>
      bridge
        .request(PROVIDER_EVENT_NAME.useDiscoveredServer, server)
        .catch(() => []),
    setActiveChatProvider: (p: TwinnyProvider) =>
      emit(PROVIDER_EVENT_NAME.setActiveChatProvider, p),
    setActiveIntentProvider: (p: TwinnyProvider) =>
      emit(PROVIDER_EVENT_NAME.setActiveIntentProvider, p),
    setActiveEmbeddingsProvider: (p: TwinnyProvider) =>
      emit(PROVIDER_EVENT_NAME.setActiveEmbeddingsProvider, p),
    setActiveFimProvider: (p: TwinnyProvider) =>
      emit(PROVIDER_EVENT_NAME.setActiveFimProvider, p),
    triggerExportProviders: () => emit(PROVIDER_EVENT_NAME.exportProviders),
    triggerImportProviders: () => emit(PROVIDER_EVENT_NAME.importProviders)
  }
}
