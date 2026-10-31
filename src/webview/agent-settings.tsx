/* eslint-disable simple-import-sort/imports */
import React, { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import cx from "classnames"

import type { AgentProfileSummary, AgentSelection } from "../common/agents"
import { AGENT_STEP_PRESETS, DEFAULT_AGENT_STEPS, EVENT_NAME, GLOBAL_STORAGE_KEY } from "../common/constants"
import type { AgentRegistryRequest, PromptInstructionSnapshot, PromptInstructionsResponse } from "../common/messaging/protocol"
import type { TeamAgentPolicy } from "../common/team"

import { StorageType, useStorageContext } from "./hooks/useStorageContext"
import { bridge, emit, useServerEvent } from "./messaging"

import styles from "./styles/agent-settings.module.css"
import { ToolPicker } from "./tool-picker";

/** Steps a reply may take, offered as presets; `DEFAULT_AGENT_STEPS` is the default. */
export const STEP_PRESETS = AGENT_STEP_PRESETS

/** The presets, with the user's own number among them when they set another in their settings. */
const stepChoices = (current: number) =>
  Number.isFinite(current) && !STEP_PRESETS.includes(current)
    ? [...STEP_PRESETS, current].sort((a, b) => a - b)
    : STEP_PRESETS

/**
 * A `twinny.*` setting, read once and written back to the user's
 * settings; the panel shows a change at once rather than waiting for the
 * round trip.
 */
const useSetting = <T,>(key: string, fallback: T): [T, (value: T) => void] => {
  const [value, setValue] = useState<T>(fallback)
  useEffect(() => {
    bridge
      .request(EVENT_NAME.twinnyGetConfigValue, { key })
      .then((answer) => answer?.value !== undefined && setValue(answer.value as T))
      .catch(() => undefined)
  }, [key])
  const write = useCallback(
    (next: T) => {
      setValue(next)
      emit(EVENT_NAME.twinnySetConfigValue, { key, value: next })
    },
    [key]
  )
  return [value, write]
}

interface Choice<T> {
  value: T
  label: string
  title?: string
  /** Why it cannot be chosen, when it cannot. */
  locked?: string
}

const clampNumber = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(value)))

const NumberSetting = ({
  label,
  value,
  min,
  max,
  step,
  unit,
  title,
  onChange
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  unit: string
  title: string
  onChange: (value: number) => void
}) => (
  <label className={styles.row} aria-label={label}>
    <span className={styles.label} title={title}>{label}</span>
    <span className={styles.numberWrap}>
      <input
        type="number"
        min={min}
        max={max}
        step={step ?? 1}
        value={value}
        aria-label={label}
        title={title}
        className={styles.numberInput}
        onChange={(event) => onChange(clampNumber(Number(event.target.value || 0), min, max))}
      />
      <span className={styles.unit}>{unit}</span>
    </span>
  </label>
)

const Choices = <T extends string | number>({
  label,
  value,
  choices,
  onChange
}: {
  label: string
  value: T
  choices: Choice<T>[]
  onChange: (value: T) => void
}) => (
  <div className={styles.row} role="radiogroup" aria-label={label}>
    <span className={styles.label}>{label}</span>
    <span className={styles.choices}>
      {choices.map((choice) => (
        <button
          key={String(choice.value)}
          type="button"
          role="radio"
          aria-checked={choice.value === value}
          disabled={!!choice.locked}
          className={cx(styles.choice, { [styles.chosen]: choice.value === value })}
          title={choice.locked ?? choice.title}
          onClick={() => choice.value !== value && onChange(choice.value)}
        >
          {choice.label}
        </button>
      ))}
    </span>
  </div>
)

interface AgentSettingsConfig extends Record<string, unknown> {
  defaultSelection: "off" | "default"
  autoDiscover: boolean
  searchPaths: string[]
  excludedPaths: string[]
}

const isSettingsRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const AgentRegistryPanel = () => {
  const [options, setOptions] = useState<AgentSettingsConfig>({ defaultSelection: "off", autoDiscover: true, searchPaths: [], excludedPaths: [] })
  const [searchPathsDraft, setSearchPathsDraft] = useState("")
  const [excludedPathsDraft, setExcludedPathsDraft] = useState("")
  const [settingsBusy, setSettingsBusy] = useState(false)
  const [agents, setAgents] = useState<AgentProfileSummary[]>([])
  const [path, setPath] = useState("")
  const [name, setName] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const configUpdateObserved = useRef(false)

  const applyConfig = useCallback((value: unknown) => {
    const settings = isSettingsRecord(value) ? value : {}
    const searchPaths = Array.isArray(settings.searchPaths)
      ? settings.searchPaths.filter((entry): entry is string => typeof entry === "string")
      : []
    const excludedPaths = Array.isArray(settings.excludedPaths)
      ? settings.excludedPaths.filter((entry): entry is string => typeof entry === "string")
      : []
    setOptions({
      defaultSelection: settings.defaultSelection === "default" ? "default" : "off",
      autoDiscover: settings.autoDiscover !== false,
      searchPaths,
      excludedPaths
    })
    setSearchPathsDraft(searchPaths.join("\n"))
    setExcludedPathsDraft(excludedPaths.join("\n"))
  }, [])

  useServerEvent(EVENT_NAME.twinnyConfigValueChanged, ({ key, value }) => {
    if (key !== "agents") return
    configUpdateObserved.current = true
    applyConfig(value)
  })

  const perform = useCallback(async (request: AgentRegistryRequest) => {
    setBusy(true)
    setError("")
    try {
      setAgents(await bridge.request(EVENT_NAME.twinnyAgentRegistry, request))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => { void perform({ action: "list" }) }, [perform])

  useEffect(() => {
    let cancelled = false
    bridge.request(EVENT_NAME.twinnyGetConfigValue, { key: "agents" })
      .then(({ value }) => {
        if (cancelled || configUpdateObserved.current) return
        applyConfig(value)
      })
      .catch((reason) => {
        if (!cancelled) setError(`Could not load agent settings: ${reason instanceof Error ? reason.message : String(reason)}`)
      })
    return () => { cancelled = true }
  }, [applyConfig])

  const updateOptions = useCallback(async (patch: Partial<AgentSettingsConfig>) => {
    setSettingsBusy(true)
    setError("")
    try {
      const { value } = await bridge.request(EVENT_NAME.twinnyGetConfigValue, { key: "agents" })
      const settings = isSettingsRecord(value) ? value : {}
      const next = { ...settings, ...patch }
      await bridge.request(EVENT_NAME.twinnySetConfigValue, { key: "agents", value: next })
      setOptions((current) => ({ ...current, ...patch }))
      try {
        setAgents(await bridge.request(EVENT_NAME.twinnyAgentRegistry, { action: "refresh" }))
      } catch (reason) {
        setError(`Settings saved, but profiles could not be refreshed: ${reason instanceof Error ? reason.message : String(reason)}`)
      }
    } catch (reason) {
      setError(`Could not save agent settings: ${reason instanceof Error ? reason.message : String(reason)}`)
    } finally {
      setSettingsBusy(false)
    }
  }, [])

  return (
    <section className={styles.agentsSection} aria-label="Selectable agents">
      <ToolPicker />
      <div className={styles.agentsHeading}>
        <strong>Agents</strong>
        <button type="button" className={styles.choice} disabled={busy} onClick={() => void perform({ action: "refresh" })}>Refresh</button>
      </div>
      <label className={styles.agentSettingRow}>
        <span>New chat default</span>
        <select
          value={options.defaultSelection}
          disabled={settingsBusy}
          onChange={(event) => void updateOptions({ defaultSelection: event.target.value === "default" ? "default" : "off" })}
        >
          <option value="off">Agent off</option>
          <option value="default">Default Agent</option>
        </select>
      </label>
      <label className={styles.agentSettingRow}>
        <span>Discover profiles automatically</span>
        <input
          type="checkbox"
          checked={options.autoDiscover}
          disabled={settingsBusy}
          onChange={(event) => void updateOptions({ autoDiscover: event.target.checked })}
        />
      </label>
      <div className={styles.agentSettingColumn}>
        <span>Additional discovery directories (one path per line)</span>
        <textarea
          className={styles.agentInput}
          aria-label="Additional agent discovery directories"
          placeholder="${workspaceFolder}/.agents\n${extensionGlobalStorage}/agents"
          value={searchPathsDraft}
          disabled={settingsBusy}
          onChange={(event) => setSearchPathsDraft(event.target.value)}
        />
        <button
          type="button"
          className={styles.choice}
          disabled={settingsBusy}
          onClick={() => void updateOptions({ searchPaths: [...new Set(searchPathsDraft.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean))] })}
        >Save discovery paths</button>
      </div>
      <div className={styles.agentSettingColumn}>
        <span>Excluded profile files (one path per line)</span>
        <textarea
          className={styles.agentInput}
          aria-label="Excluded agent profile files"
          value={excludedPathsDraft}
          disabled={settingsBusy}
          onChange={(event) => setExcludedPathsDraft(event.target.value)}
        />
        <button
          type="button"
          className={styles.choice}
          disabled={settingsBusy}
          onClick={() => void updateOptions({ excludedPaths: [...new Set(excludedPathsDraft.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean))] })}
        >Save exclusions</button>
      </div>
      <div className={styles.agentAddForm}>
        <input className={styles.agentInput} aria-label="Agent file path" placeholder="path/to/profile.agent.md" value={path} onChange={(event) => setPath(event.target.value)} />
        <button type="button" className={styles.choice} disabled={busy || !path.trim()} onClick={() => { void perform({ action: "add", path: path.trim(), ...(name.trim() ? { name: name.trim() } : {}) }); setPath("") }}>Register path</button>
        <button type="button" className={styles.choice} disabled={busy} onClick={() => void perform({ action: "pick" })}>Choose file…</button>
        <input className={styles.agentInput} aria-label="Agent display name" placeholder="Agent name" value={name} onChange={(event) => setName(event.target.value)} />
        <button type="button" className={styles.choice} disabled={busy || !name.trim()} onClick={() => { void perform({ action: "create", name: name.trim() }); setName("") }}>Create new</button>
      </div>
      {error && <div className={styles.agentError} role="alert">{error}</div>}
      {!agents.length && !busy && <div className={styles.agentStatus}>No registered or discovered agent profiles.</div>}
      {agents.map((agent) => (
        <div key={agent.id} className={styles.agentEntry}>
          <div className={styles.agentEntryMain}>
            <label className={styles.agentEnabled}>
              <input type="checkbox" checked={agent.enabled} disabled={busy || !agent.valid} onChange={(event) => void perform({ action: "enable", id: agent.id, enabled: event.target.checked })} />
              <span>{agent.name}</span>
            </label>
            <span className={styles.agentStatus}>{agent.valid ? agent.userInvocable ? "Valid" : "Not user-invocable" : "Invalid: " + (agent.validation ?? "unknown error")}</span>
          </div>
          <code className={styles.agentPath} title={agent.path}>{agent.path}</code>
          <div className={styles.agentStatus}>Source: {agent.source}{agent.mcpServers.length ? " · MCP: " + agent.mcpServers.join(", ") : " · MCP: none"}</div>
          {agent.warnings.map((warning) => <div key={warning} className={styles.agentWarning}>{warning}</div>)}
          <div className={styles.agentActions}>
            <button type="button" className={styles.choice} disabled={busy} onClick={() => void perform({ action: "open", id: agent.id })}>Open</button>
            <button type="button" className={styles.choice} disabled={busy} onClick={() => void perform({ action: "remove", id: agent.id })}>Remove registration</button>
          </div>
        </div>
      ))}
    </section>
  )
}

type PromptRoute = "chat" | "intent"

const promptConfigKeys = {
  chat: { mode: "chatBaseInstructionsMode", file: "chatBaseInstructionsFile" },
  intent: { mode: "intentBaseInstructionsMode", file: "intentBaseInstructionsFile" }
} as const

const PromptInstructionsPanel = ({ agentSelection }: { agentSelection: AgentSelection }) => {
  const [inspection, setInspection] = useState<PromptInstructionsResponse>()
  const [previewRoute, setPreviewRoute] = useState<PromptRoute>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const reloadSequence = useRef(0)

  const reload = useCallback(async () => {
    const sequence = ++reloadSequence.current
    setBusy(true)
    setError("")
    try {
      const result = await bridge.request(EVENT_NAME.twinnyPromptInstructions, { action: "inspect", agentSelection })
      if (sequence === reloadSequence.current) setInspection(result)
    } catch (reason) {
      if (sequence === reloadSequence.current) setError("Could not load prompt instructions: " + (reason instanceof Error ? reason.message : String(reason)))
    } finally {
      if (sequence === reloadSequence.current) setBusy(false)
    }
  }, [agentSelection])

  useEffect(() => { void reload() }, [reload])
  useServerEvent(EVENT_NAME.twinnyConfigValueChanged, ({ key }) => {
    if (Object.values(promptConfigKeys).some((route) => key === route.mode || key === route.file)) void reload()
  })

  const save = useCallback(async (key: string, value: unknown) => {
    setBusy(true)
    setError("")
    try {
      await bridge.request(EVENT_NAME.twinnySetConfigValue, { key, value })
      await reload()
    } catch (reason) {
      setError("Could not save prompt settings: " + (reason instanceof Error ? reason.message : String(reason)))
      setBusy(false)
    }
  }, [reload])

  const pick = useCallback(async (route: PromptRoute) => {
    setBusy(true)
    setError("")
    try {
      const result = await bridge.request(EVENT_NAME.twinnyPromptInstructions, { action: "pick", route })
      if (result.selectedFile) {
        await bridge.request(EVENT_NAME.twinnySetConfigValue, { key: promptConfigKeys[route].file, value: result.selectedFile })
        await bridge.request(EVENT_NAME.twinnySetConfigValue, { key: promptConfigKeys[route].mode, value: "custom" })
      }
      await reload()
    } catch (reason) {
      setError("Could not select the Markdown file: " + (reason instanceof Error ? reason.message : String(reason)))
      setBusy(false)
    }
  }, [reload])

  const open = useCallback(async (route: PromptRoute) => {
    setBusy(true)
    setError("")
    try {
      await bridge.request(EVENT_NAME.twinnyPromptInstructions, { action: "open", route })
    } catch (reason) {
      setError("Could not open the Markdown file: " + (reason instanceof Error ? reason.message : String(reason)))
    } finally {
      setBusy(false)
    }
  }, [])

  const routePanel = (route: PromptRoute, title: string, snapshot: PromptInstructionSnapshot | undefined) => (
    <section className={styles.promptRoute} aria-label={title}>
      <strong>{title}</strong>
      <label className={styles.promptSettingRow}>
        <span>Mode</span>
        <select
          className={styles.agentInput}
          aria-label={title + " mode"}
          value={snapshot?.mode ?? "default"}
          disabled={busy}
          onChange={(event) => void save(promptConfigKeys[route].mode, event.currentTarget.value)}
        >
          <option value="default">Built-in Default</option>
          <option value="custom">Custom Markdown File</option>
          <option value="none">None</option>
        </select>
      </label>
      {snapshot?.mode === "custom" && (
        <>
          <div className={styles.promptPath} title={snapshot.file}>{snapshot.file || "No Markdown file selected"}</div>
          <div className={styles.promptActions}>
            <button type="button" className={styles.choice} disabled={busy} onClick={() => void pick(route)}>Choose Markdown File…</button>
            <button type="button" className={styles.choice} disabled={busy || !snapshot.file} onClick={() => void open(route)}>Open for Editing</button>
          </div>
        </>
      )}
      {snapshot?.warning && <div className={styles.promptWarning} role="status">{snapshot.warning}</div>}
      {snapshot?.mode === "custom" && !snapshot.warning && !snapshot.content.trim() && <div className={styles.promptSource}>The selected Markdown file is empty; no optional base instructions are added.</div>}
      {snapshot?.mode === "none" && <div className={styles.promptSource}>No optional base instructions are added in None mode.</div>}
      {snapshot && <div className={styles.promptSource}>Resolved from: {snapshot.source ?? "None"} · SHA-256 {snapshot.hash.slice(0, 12)}</div>}
      <label className={styles.promptPreview}>
        <span>Selected preamble (read-only)</span>
        <textarea readOnly rows={4} value={snapshot?.content ?? ""} aria-label={title + " selected preamble preview"} />
      </label>
      <div className={styles.promptActions}>
        <button type="button" className={styles.choice} disabled={busy} onClick={() => void reload()}>Refresh Preview</button>
        <button type="button" className={styles.choice} disabled={busy} onClick={() => { setPreviewRoute(route); void reload() }}>Preview Effective Prompt</button>
        <button type="button" className={styles.choice} disabled={busy || snapshot?.mode === "default"} onClick={() => void save(promptConfigKeys[route].mode, "default")}>Restore Default</button>
      </div>
      {previewRoute === route && inspection && (
        <div className={styles.promptEffective}>
          <strong>{title} effective prompt</strong>
          {route === "chat" && inspection.agentWarning && <div className={styles.promptWarning}>{inspection.agentWarning}</div>}
          {route === "chat" && inspection.agentId && <div className={styles.promptSource}>Selected agent profile: {inspection.agentId}</div>}
          <textarea readOnly rows={8} value={route === "chat" ? inspection.chatEffective ?? "" : inspection.intentEffective ?? ""} aria-label={title + " effective prompt preview"} />
          <strong>Dynamically generated runtime content (not editable Markdown)</strong>
          <pre>{route === "chat" ? [inspection.chatRuntimeContext, inspection.toolGuidance].filter(Boolean).join("\n\n") : "Compiler input contains the current user request and bounded conversation history. The required JSON protocol is enforced by Twinny."}</pre>
          <button type="button" className={styles.choice} onClick={() => setPreviewRoute(undefined)}>Close Preview</button>
        </div>
      )}
    </section>
  )

  return (
    <section className={styles.promptInstructions} aria-label="Base instructions">
      <div className={styles.agentsHeading}><strong>Base Instructions</strong></div>
      {routePanel("chat", "Chat Base Instructions", inspection?.chat)}
      {routePanel("intent", "Intent Compiler Base Instructions", inspection?.intent)}
      {error && <div className={styles.agentError} role="alert">{error}</div>}
    </section>
  )
}

interface AgentSettingsProps {
  /** What the connected team's policy allows, if it sets agent rules. */
  team?: TeamAgentPolicy
  autoRun: boolean
  setAutoRun: (on: boolean) => void
  onClose: () => void
  agentSelection: AgentSelection
}

/**
 * What agent mode may do, from the composer: how changes land, whether
 * commands ask, run or are off, where they run, and how many steps a reply
 * may take. Each is a setting the user has (`twinny.chatTools…`), written
 * back to their settings; a rule the team sets shows, and cannot be
 * loosened here.
 */
export const AgentSettings = ({ team, autoRun, setAutoRun, onClose, agentSelection }: AgentSettingsProps) => {
  const { t } = useTranslation()
  const panel = useRef<HTMLDivElement>(null)
  const [edits, setEdits] = useSetting<string>("chatToolsEdits", "apply")
  const [commands, setCommands] = useSetting<string>("chatToolsCommands", "ask")
  const [runIn, setRunIn] = useSetting<string>("chatToolsCommandsRunIn", "background")
  const [maxSteps, setMaxSteps] = useSetting<number>("chatToolsMaxSteps", DEFAULT_AGENT_STEPS)
  const [maxReadLines, setMaxReadLines] = useSetting<number>("chatToolsMaxReadLines", 1000)
  const [maxResultChars, setMaxResultChars] = useSetting<number>("chatToolsMaxResultChars", 100000)
  const [intentCompilerEnabled, setIntentCompilerEnabled] = useSetting<boolean>("chatToolsIntentCompilerEnabled", false)
  const [intentCompilerMode, setIntentCompilerMode] = useSetting<string>("chatToolsIntentCompilerMode", "ask")
  const [intentCompilerMaxTurns, setIntentCompilerMaxTurns] = useSetting<number>("chatToolsIntentCompilerMaxTurns", 3)
  const [intentCompilerTrace, setIntentCompilerTrace] = useSetting<boolean>("chatToolsIntentCompilerTrace", false)
  const [mcpNeverAskAgain, setMcpNeverAskAgain] = useSetting<boolean>("mcpNeverAskAgain", false)
  const { context: always, setContext: setAlways } = useStorageContext<string[]>(
    StorageType.Global,
    GLOBAL_STORAGE_KEY.alwaysRunCommands
  )
  const { context: alwaysMcp, setContext: setAlwaysMcp } = useStorageContext<string[]>(
    StorageType.Global,
    GLOBAL_STORAGE_KEY.alwaysRunMcpTools
  )
  const [mcpServers] = useSetting<Record<string, unknown>>("chatToolsMcpServers", {})
  const servers = Object.keys(mcpServers ?? {}).length

  // Escape or a click elsewhere puts it away.
  useServerEvent(EVENT_NAME.twinnyConfigValueChanged, ({ key, value }) => {
    if (key === "chatToolsIntentCompilerEnabled" && typeof value === "boolean") {
      setIntentCompilerEnabled(value)
    }
    if (key === "chatToolsIntentCompilerMode" && typeof value === "string") {
      setIntentCompilerMode(value)
    }
    if (key === "chatToolsIntentCompilerTrace" && typeof value === "boolean") {
      setIntentCompilerTrace(value)
    }
    if (key === "mcpNeverAskAgain" && typeof value === "boolean") {
      setMcpNeverAskAgain(value)
    }
  })

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.stopPropagation()
      onClose()
    }
    const onPointer = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      if (!panel.current?.contains(target) && !target?.closest("[data-agent-picker]")) onClose()
    }
    window.addEventListener("keydown", onKey, true)
    window.addEventListener("mousedown", onPointer)
    return () => {
      window.removeEventListener("keydown", onKey, true)
      window.removeEventListener("mousedown", onPointer)
    }
  }, [onClose])

  const teamSays = t("agent-settings-team")
  const commandsOff = team?.commands === "off" || commands === "off"
  const commandMode = commandsOff ? "off" : autoRun && !team?.commands ? "run" : "ask"
  const kept = always?.length ?? 0
  const keptMcp = alwaysMcp?.length ?? 0

  const chooseCommands = (mode: string) => {
    if (mode === "off") {
      setCommands("off")
      return
    }
    // The composer's auto-run switch and the setting say the same thing.
    setCommands(mode === "run" ? "allow" : "ask")
    setAutoRun(mode === "run")
  }

  return (
    <div ref={panel} className={styles.panel} role="dialog" aria-label={t("agent-settings-title")}>
      <div className={styles.head}>
        <span>{t("agent-settings-title")}</span>
        <button type="button" className={styles.close} onClick={onClose} aria-label={t("agent-settings-close")}>
          <span className="codicon codicon-close" aria-hidden="true" />
        </button>
      </div>
      <PromptInstructionsPanel agentSelection={agentSelection} />
      <details>
        <summary>Agents</summary>
        <AgentRegistryPanel />
      </details>
      <Choices
        label="Intent compiler"
        value={intentCompilerEnabled ? intentCompilerMode : "always-original"}
        onChange={(value) => {
          if (value === "always-original") {
            setIntentCompilerEnabled(false)
            setIntentCompilerMode("always-original")
            return
          }
          setIntentCompilerEnabled(true)
          setIntentCompilerMode(value)
        }}
        choices={[
          { value: "always-original", label: "Always original", title: "Run the original request and skip the compiler." },
          { value: "ask", label: "Ask each time", title: "Refine, then review and choose before execution." },
          { value: "always-refined", label: "Always use refined", title: "Automatically execute the refined prompt when the proposal stays in scope." }
        ]}
      />
      <NumberSetting
        label="Max intent turns"
        value={intentCompilerMaxTurns}
        min={0}
        max={10}
        step={1}
        unit="turns"
        title="How many previous prompt/response turns to include as context when refining a new request."
        onChange={setIntentCompilerMaxTurns}
        />
      <label className={styles.row} aria-label="Trace intent compiler requests">
      <ToolPicker />
        
        <span className={styles.label}>Trace intent compiler requests</span>
        <input
          type="checkbox"
          checked={intentCompilerTrace}
          title="Write a local raw request/response trace for the Intent Compiler. Disabled by default and may include private conversation content."
          onChange={(event) => setIntentCompilerTrace(event.target.checked)}
        />
      </label>
      <Choices
        label={t("agent-settings-edits")}
        value={team?.edits === "review" ? "review" : edits}
        onChange={setEdits}
        choices={[
          {
            value: "apply",
            label: t("agent-settings-edits-apply"),
            title: t("agent-settings-edits-apply-title"),
            ...(team?.edits === "review" ? { locked: teamSays } : {})
          },
          { value: "review", label: t("agent-settings-edits-review"), title: t("agent-settings-edits-review-title") }
        ]}
      />
      <Choices
        label={t("agent-settings-commands")}
        value={commandMode}
        onChange={chooseCommands}
        choices={[
          {
            value: "ask",
            label: t("agent-settings-commands-ask"),
            title: t("agent-settings-commands-ask-title"),
            ...(team?.commands === "off" ? { locked: teamSays } : {})
          },
          {
            value: "run",
            label: t("agent-settings-commands-run"),
            title: t("agent-settings-commands-run-title"),
            ...(team?.commands ? { locked: teamSays } : {})
          },
          { value: "off", label: t("agent-settings-commands-off"), title: t("agent-settings-commands-off-title") }
        ]}
      />
      {!commandsOff && (
        <Choices
          label={t("agent-settings-run-in")}
          value={runIn}
          onChange={setRunIn}
          choices={[
            { value: "background", label: t("agent-settings-run-in-background"), title: t("agent-settings-run-in-background-title") },
            { value: "terminal", label: t("agent-settings-run-in-terminal"), title: t("agent-settings-run-in-terminal-title") }
          ]}
        />
      )}
      <Choices
        label={t("agent-settings-steps")}
        value={maxSteps}
        onChange={setMaxSteps}
        choices={stepChoices(maxSteps).map((steps) => ({
          value: steps,
          label: String(steps),
          title: t("agent-settings-steps-title", { count: steps })
        }))}
      />
      <NumberSetting
        label={t("agent-settings-read-lines")}
        value={maxReadLines}
        min={100}
        max={5000}
        step={50}
        unit={t("agent-settings-lines-unit")}
        title={t("agent-settings-read-lines-title")}
        onChange={setMaxReadLines}
      />
      <NumberSetting
        label={t("agent-settings-result-chars")}
        value={maxResultChars}
        min={10000}
        max={200000}
        step={1000}
        unit={t("agent-settings-characters-unit")}
        title={t("agent-settings-result-chars-title")}
        onChange={setMaxResultChars}
      />
      <label className={styles.row} aria-label="MCP: Never ask me. EVER.">
        <span
          className={styles.label}
          title="Automatically approve every tool call from enabled MCP servers. Applies across conversations and restarts. Does not enable disabled servers or override external system permissions. This includes destructive actions offered by enabled servers."
        >
          MCP: Never ask me. EVER.
        </span>
        <input
          type="checkbox"
          checked={mcpNeverAskAgain}
          title="Automatically approve every tool call from enabled MCP servers. Applies across conversations and restarts. Does not enable disabled servers or override external system permissions. This includes destructive actions offered by enabled servers."
          onChange={(event) => setMcpNeverAskAgain(event.target.checked)}
        />
      </label>
      {team?.commands !== "off" && team?.mcp !== "off" && (
        <div className={styles.row}>
          <span className={styles.label} title={t("agent-settings-mcp-title")}>
            {t("agent-settings-mcp", { count: servers })}
          </span>
          <button type="button" className={styles.link} onClick={() => emit(EVENT_NAME.twinnyOpenAgentSettings)}>
            {t(servers ? "agent-settings-mcp-configure" : "agent-settings-mcp-add")}
          </button>
        </div>
      )}
      {kept + keptMcp > 0 && !team?.commands && (
        <div className={styles.row}>
          <span className={styles.label}>
            {[
              ...(kept ? [t("agent-settings-always", { count: kept })] : []),
              ...(keptMcp ? [t("agent-settings-always-mcp", { count: keptMcp })] : [])
            ].join(" · ")}
          </span>
          <button
            type="button"
            className={styles.link}
            onClick={() => {
              if (kept) setAlways([])
              if (keptMcp) setAlwaysMcp([])
            }}
            title={t("agent-settings-forget-title")}
          >
            {t("agent-settings-forget")}
          </button>
        </div>
      )}
      <button type="button" className={styles.more} onClick={() => emit(EVENT_NAME.twinnyOpenAgentSettings)}>
        {t("agent-settings-more")}
      </button>
    </div>
  )
}


export default AgentSettings;
