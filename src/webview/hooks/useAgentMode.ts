import { useCallback, useEffect, useRef, useState } from "react"

import type { AgentSelection } from "../../common/agents"
import { AGENT_SELECTION_STORAGE_KEY, LAST_AGENT_SELECTION_STORAGE_KEY, normalizeAgentSelection, selectionFromLegacyAgentMode } from "../../common/agents"
import { EVENT_NAME, GLOBAL_STORAGE_KEY } from "../../common/constants"
import { bridge, useServerEvent } from "../messaging"

import { StorageType, useStorageContext } from "./useStorageContext"
import { useTeamAgentPolicy } from "./useTeamAgentPolicy"

/** The single selected agent profile; the previous boolean is read only during migration. */
export const useAgentMode = (availableAgentIds: string[] = []) => {
  const { context: storedSelection, setContext, loaded } = useStorageContext<AgentSelection>(
    StorageType.Global,
    AGENT_SELECTION_STORAGE_KEY
  )
  const { context: lastSelection, setContext: setLastSelection } = useStorageContext<AgentSelection>(
    StorageType.Global,
    LAST_AGENT_SELECTION_STORAGE_KEY
  )
  const [newChatDefault, setNewChatDefault] = useState<"off" | "default">("off")
  const [preferenceError, setPreferenceError] = useState("")
  const team = useTeamAgentPolicy()
  const teamOff = !!team?.off
  const selectionRef = useRef<AgentSelection>("off")
  const selectionChangedDuringMigration = useRef(false)
  const availableRef = useRef(new Set(availableAgentIds))
  availableRef.current = new Set(availableAgentIds)

  const setSelection = useCallback((next: AgentSelection, source = "selector", persistSame = false) => {
    if (source !== "legacy-migration") selectionChangedDuringMigration.current = true
    const previous = selectionRef.current
    if (previous === next) {
      if (persistSame) setContext(next)
      return false
    }
    selectionRef.current = next
    console.info(`[Twinny Agent] selection source=${source} from=${previous} to=${next}`)
    if (next !== "off") setLastSelection(next)
    setContext(next)
    return true
  }, [setContext, setLastSelection])

  useEffect(() => {
    if (!loaded || storedSelection !== undefined) return
    let cancelled = false
    const migrate = async () => {
      let migrated: AgentSelection | undefined
      try {
        const legacy = await bridge.request(EVENT_NAME.twinnyGlobalContext, { key: GLOBAL_STORAGE_KEY.agentMode })
        migrated = selectionFromLegacyAgentMode(legacy.value)
      } catch {
        migrated = undefined
      }
      if (migrated === undefined) {
        try {
          const { value } = await bridge.request(EVENT_NAME.twinnyGetConfigValue, { key: "chatTools" })
          const { value: agentSettings } = await bridge.request(EVENT_NAME.twinnyGetConfigValue, { key: "agents" })
          const defaultSelection = agentSettings && typeof agentSettings === "object"
            ? Reflect.get(agentSettings, "defaultSelection")
            : undefined
          migrated = value === true ? "default" : defaultSelection === "default" ? "default" : "off"
        } catch (reason) {
          if (!cancelled) setPreferenceError(`Could not load agent defaults: ${reason instanceof Error ? reason.message : String(reason)}`)
          migrated = "off"
        }
      }
      if (!cancelled && !selectionChangedDuringMigration.current) {
        setSelection(migrated, "legacy-migration", true)
      }
    }
    void migrate()
    return () => { cancelled = true }
  }, [loaded, storedSelection, setSelection])

  useEffect(() => {
    let cancelled = false
    bridge.request(EVENT_NAME.twinnyGetConfigValue, { key: "agents" })
      .then(({ value }) => {
        if (cancelled || value === null || typeof value !== "object") return
        setNewChatDefault(Reflect.get(value, "defaultSelection") === "default" ? "default" : "off")
        setPreferenceError("")
      })
      .catch((reason) => {
        if (!cancelled) setPreferenceError(`Could not load agent settings: ${reason instanceof Error ? reason.message : String(reason)}`)
      })
    return () => { cancelled = true }
  }, [])

  useServerEvent(EVENT_NAME.twinnyConfigValueChanged, ({ key, value }) => {
    if (key === "agents" && value !== null && typeof value === "object") {
      setNewChatDefault(Reflect.get(value, "defaultSelection") === "default" ? "default" : "off")
      setPreferenceError("")
    }
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
    setSelection(newChatDefault, "new-conversation")
  }, [newChatDefault, setSelection])

  return {
    agentSelection: selection,
    lastAgentSelection: normalizeAgentSelection(lastSelection) ?? "default",
    storedAgentSelection: selection,
    setAgentSelection: setSelection,
    resetAgentSelectionForNewChat: resetForNewChat,
    agentMode: effectiveSelection !== "off",
    teamAgentRules: team,
    agentPreferenceError: preferenceError
  }
}
