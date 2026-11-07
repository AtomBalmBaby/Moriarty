import { useCallback, useEffect, useRef, useState } from "react"

import type { AgentSelection, AgentStartupSelection } from "../../common/agents"
import {
  AGENT_SELECTION_STORAGE_KEY,
  AGENT_STARTUP_SELECTION_SETTING,
  isRememberedAgentSource,
  LAST_AGENT_SELECTION_STORAGE_KEY,
  normalizeAgentSelection,
  normalizeAgentStartupSelection,
  resolveStartupAgentSelection
} from "../../common/agents"
import { EVENT_NAME } from "../../common/constants"
import { bridge, useServerEvent } from "../messaging"

import { StorageType, useStorageContext } from "./useStorageContext"
import { useTeamAgentPolicy } from "./useTeamAgentPolicy"

export interface AgentStartupInputs {
  /** Profiles were listed, or listing failed; until then a custom "last used" profile cannot be checked. */
  profilesSettled: boolean
  /** The conversation active at mount has been read, whether or not one exists. */
  conversationLoaded: boolean
  /** The selection stored on the active conversation, if it has one. A chat that already has one keeps it. */
  restoredSelection: AgentSelection | undefined
}

/** The single selected agent profile, and the agent a new session starts with. */
export const useAgentMode = (availableAgentIds: string[], startupInputs: AgentStartupInputs) => {
  const { context: storedSelection, setContext, loaded: storedLoaded } = useStorageContext<AgentSelection>(
    StorageType.Global,
    AGENT_SELECTION_STORAGE_KEY
  )
  const { context: lastSelection, setContext: setLastSelection, loaded: lastLoaded } = useStorageContext<AgentSelection>(
    StorageType.Global,
    LAST_AGENT_SELECTION_STORAGE_KEY
  )
  const [startupLoaded, setStartupLoaded] = useState(false)
  const [sessionReady, setSessionReady] = useState(false)
  const [preferenceError, setPreferenceError] = useState("")
  const team = useTeamAgentPolicy()
  const teamOff = !!team?.off
  const selectionRef = useRef<AgentSelection>("off")
  const lastSelectionRef = useRef<AgentSelection | undefined>(undefined)
  lastSelectionRef.current = normalizeAgentSelection(lastSelection) ?? lastSelectionRef.current
  const startupPreferenceRef = useRef<AgentStartupSelection>("default")
  const userChoseRef = useRef(false)
  const availableRef = useRef(new Set(availableAgentIds))
  availableRef.current = new Set(availableAgentIds)

  const setSelection = useCallback((next: AgentSelection, source = "selector", persistSame = false) => {
    if (isRememberedAgentSource(source)) userChoseRef.current = true
    const previous = selectionRef.current
    if (previous === next) {
      if (persistSame) setContext(next)
      return false
    }
    selectionRef.current = next
    console.info(`[Twinny Agent] selection source=${source} from=${previous} to=${next}`)
    if (isRememberedAgentSource(source) && next !== "off") {
      lastSelectionRef.current = next
      setLastSelection(next)
    }
    setContext(next)
    return true
  }, [setContext, setLastSelection])

  const startupSelection = useCallback(
    () => resolveStartupAgentSelection(startupPreferenceRef.current, lastSelectionRef.current, availableRef.current),
    []
  )

  const startupReady = storedLoaded && lastLoaded && startupLoaded && startupInputs.profilesSettled && startupInputs.conversationLoaded
  useEffect(() => {
    if (sessionReady || !startupReady) return
    // A restored chat keeps the selection it was saved with, and a choice made before startup finished is kept too.
    if (startupInputs.restoredSelection === undefined && !userChoseRef.current) {
      setSelection(startupSelection(), "startup", true)
    }
    setSessionReady(true)
  }, [sessionReady, startupReady, startupInputs.restoredSelection, setSelection, startupSelection])

  useEffect(() => {
    let cancelled = false
    bridge.request(EVENT_NAME.twinnyGetConfigValue, { key: AGENT_STARTUP_SELECTION_SETTING })
      .then(({ value }) => {
        if (cancelled) return
        startupPreferenceRef.current = normalizeAgentStartupSelection(value)
        setStartupLoaded(true)
        setPreferenceError("")
      })
      .catch((reason) => {
        if (cancelled) return
        startupPreferenceRef.current = "default"
        setStartupLoaded(true)
        setPreferenceError(`Could not load agent settings: ${reason instanceof Error ? reason.message : String(reason)}`)
      })
    return () => { cancelled = true }
  }, [])

  // Takes effect for the next new chat; the open chat keeps its selection.
  useServerEvent(EVENT_NAME.twinnyConfigValueChanged, ({ key, value }) => {
    if (key !== AGENT_STARTUP_SELECTION_SETTING) return
    startupPreferenceRef.current = normalizeAgentStartupSelection(value)
    setPreferenceError("")
  })

  const selection = normalizeAgentSelection(storedSelection) ?? "off"
  const effectiveSelection: AgentSelection = teamOff ? "off" : selection

  useEffect(() => {
    const previous = selectionRef.current
    if (previous === selection) return
    selectionRef.current = selection
    console.info(`[Twinny Agent] selection source=storage-sync from=${previous} to=${selection}`)
  }, [selection])

  const resetForNewChat = useCallback(() => {
    setSelection(startupSelection(), "new-conversation", true)
  }, [setSelection, startupSelection])

  return {
    agentSelection: selection,
    lastAgentSelection: normalizeAgentSelection(lastSelection) ?? "default",
    storedAgentSelection: selection,
    setAgentSelection: setSelection,
    resetAgentSelectionForNewChat: resetForNewChat,
    agentSessionReady: sessionReady,
    agentMode: effectiveSelection !== "off",
    teamAgentRules: team,
    agentPreferenceError: preferenceError
  }
}
