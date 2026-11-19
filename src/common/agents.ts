export const AGENT_SELECTION_STORAGE_KEY = "agentSelection"
export const LAST_AGENT_SELECTION_STORAGE_KEY = "lastAgentSelection"
export const AGENT_STARTUP_SELECTION_SETTING = "agents.startupSelection"

export type AgentSelection = "off" | "default" | (string & {})

export const normalizeAgentSelection = (value: unknown): AgentSelection | undefined =>
  typeof value === "string" && value.trim() && value !== "off" ? value as AgentSelection : value === "off" ? "off" : undefined

export type AgentStartupSelection = "off" | "default" | "lastUsed"

export const normalizeAgentStartupSelection = (value: unknown): AgentStartupSelection =>
  value === "off" || value === "lastUsed" ? value : "default"

export const resolveAgentSelection = (requested: unknown, stored: unknown, fallback: AgentSelection): AgentSelection =>
  normalizeAgentSelection(requested) ?? normalizeAgentSelection(stored) ?? fallback

/** Only choices the user makes are remembered for "last used"; startup and history restores are not. */
export const isRememberedAgentSource = (source: string): boolean =>
  source === "dropdown" || source === "shift-tab"

/** The selection a new chat starts with. A "last used" profile that is missing or disabled falls back to Default Agent. */
export const resolveStartupAgentSelection = (
  startup: AgentStartupSelection,
  lastUsed: unknown,
  available: ReadonlySet<string>
): AgentSelection => {
  if (startup !== "lastUsed") return startup
  const previous = normalizeAgentSelection(lastUsed)
  if (previous === undefined || previous === "off") return "default"
  return previous === "default" || available.has(previous) ? previous : "default"
}

export interface AgentProfileSummary {
  id: string
  name: string
  path: string
  enabled: boolean
  userInvocable: boolean
  valid: boolean
  validation?: string
  warnings: string[]
  mcpServers: string[]
  source: "workspace" | "user" | "registered"
}

export const isAgentSelectionEnabled = (selection: AgentSelection): boolean => selection !== "off"

export const nextAgentSelection = (
  current: AgentSelection,
  last: unknown,
  available: ReadonlySet<string>
): AgentSelection => {
  if (current !== "off") return "off"
  const previous = normalizeAgentSelection(last)
  return previous === "default" || (previous !== undefined && available.has(previous)) ? previous : "default"
}

export const withAgentSelection = <T extends object>(
  payload: T,
  agentSelection: AgentSelection
): T & { agentSelection: AgentSelection } => ({ ...payload, agentSelection })

export const discoverAgentFileNames = (entries: readonly [name: string, isFile: boolean][]): string[] =>
  entries.flatMap(([name, isFile]) => isFile && name.toLowerCase().endsWith(".agent.md") ? [name] : [])

/** What the agent is doing right now, as the one glyph on the agent picker shows it. */
export type AgentGlyphState = "off" | "blocked" | "waiting" | "tools" | "verifying" | "thinking" | "milestone" | "complete" | "ready"

export interface AgentGlyphInput {
  enabled: boolean
  toolsRunning: boolean
  toolsWaiting: boolean
  /** The latest tool step failed while the reply is still in progress. */
  toolFailed: boolean
  feedbackPlanning: boolean
  feedbackFailed: boolean
  todoBlocked: boolean
  generating: boolean
  /** A verified completion that has just happened; shown briefly. */
  celebration?: "milestone" | "complete"
}

export const AGENT_GLYPHS: Record<AgentGlyphState, { glyph: string; label: string }> = {
  off: { glyph: "🔒", label: "Agent off" },
  blocked: { glyph: "🚧", label: "Blocked or failed" },
  waiting: { glyph: "💤", label: "Waiting for you" },
  tools: { glyph: "🚀", label: "Running tools" },
  verifying: { glyph: "🔍", label: "Feedback is reviewing the plan" },
  thinking: { glyph: "🧠", label: "Thinking" },
  milestone: { glyph: "🎆", label: "A task was verified" },
  complete: { glyph: "🎉", label: "The plan was verified complete" },
  ready: { glyph: "🦸", label: "Agent ready" }
}

/**
 * Blocked and failed come before any activity so they are never hidden;
 * a celebration waits until nothing else is in progress.
 */
export const agentGlyphState = (input: AgentGlyphInput): AgentGlyphState => {
  if (!input.enabled) return "off"
  if (input.feedbackFailed || input.todoBlocked || input.toolFailed) return "blocked"
  if (input.toolsWaiting) return "waiting"
  if (input.toolsRunning) return "tools"
  if (input.feedbackPlanning) return "verifying"
  if (input.generating) return "thinking"
  if (input.celebration) return input.celebration
  return "ready"
}

/**
 * The tool steps one agent reply may take. `twinny.chatToolsMaxSteps` accepts 4 to
 * 1000, so the bounds below are that setting's own range: a number the user set
 * inside it is the number the tool loop gets, and one outside it is bounded by
 * the setting's declared minimum and maximum, not by a ceiling of Twinny's own.
 */
export const MIN_STEPS_SETTING = 4
export const MAX_STEPS_SETTING = 1000

export interface AgentStepLimit {
  /** The number `twinny.chatToolsMaxSteps` holds. */
  configured: number
  /** The number the tool loop is given, which is the same one inside the range the setting declares. */
  effective: number
}

/**
 * `twinny.chatToolsMaxSteps` as the tool loop should receive it. A value that is
 * not a usable number keeps `fallback`, which is the setting's default; any number
 * is bounded by the declared range.
 */
export const agentStepLimit = (configured: number | undefined, fallback: number): AgentStepLimit => {
  const setting = typeof configured === "number" && Number.isFinite(configured) ? Math.round(configured) : Math.round(fallback)
  return { configured: setting, effective: Math.min(MAX_STEPS_SETTING, Math.max(MIN_STEPS_SETTING, setting)) }
}

/**
 * What the chat reports about the step limit when the reply cannot use the
 * number the settings hold, naming both so a reply that ran out of steps is
 * judged by the limit it actually had. Nothing when the two are the same number.
 */
export const agentStepLimitNotice = (limit: AgentStepLimit): string | undefined =>
  limit.effective === limit.configured
    ? undefined
    : `Agent step limit: you set ${limit.configured} tool steps per reply, which is outside the ${MIN_STEPS_SETTING} to ${MAX_STEPS_SETTING} the setting allows, so replies use ${limit.effective}.`
