export const AGENT_SELECTION_STORAGE_KEY = "agentSelection"
export const LAST_AGENT_SELECTION_STORAGE_KEY = "lastAgentSelection"

export type AgentSelection = "off" | "default" | (string & {})

export const normalizeAgentSelection = (value: unknown): AgentSelection | undefined =>
  typeof value === "string" && value.trim() && value !== "off" ? value as AgentSelection : value === "off" ? "off" : undefined

export const selectionFromLegacyAgentMode = (value: unknown): AgentSelection | undefined =>
  typeof value === "boolean" ? (value ? "default" : "off") : undefined

export const resolveAgentSelection = (
  requested: unknown,
  stored: unknown,
  legacy: AgentSelection | undefined,
  chatToolsEnabled: boolean,
  defaultSelection: "off" | "default" | undefined
): AgentSelection => {
  const explicit = normalizeAgentSelection(requested)
  const canonical = normalizeAgentSelection(stored)
  if (explicit) {
    if (explicit !== "off" || canonical !== undefined) return explicit
    const migrated = legacy ?? (chatToolsEnabled ? "default" : defaultSelection ?? "off")
    return migrated === "off" ? explicit : migrated
  }
  return canonical ?? legacy ?? (chatToolsEnabled ? "default" : defaultSelection ?? "off")
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
