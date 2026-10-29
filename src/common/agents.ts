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
