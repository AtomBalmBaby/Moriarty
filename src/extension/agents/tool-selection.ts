export interface NamedAgentTool {
  name: string
}

export interface McpAgentTool {
  server: string
  tool: string
}

export interface AgentToolSelection<TNative extends NamedAgentTool, TMcp extends McpAgentTool> {
  explicit: boolean
  native: TNative[]
  mcp: TMcp[]
  unmatched: string[]
}

const NATIVE_GROUPS: Record<string, string[]> = {
  read: ["list_dir", "find_files", "read_file", "grep", "find_symbol", "editor_context", "find_references", "go_to_definition", "diagnostics"],
  search: ["search_code", "grep", "find_files", "find_symbol", "find_references"],
  edit: ["edit_file", "create_file", "rename_symbol", "move_file", "delete_file"],
  execute: ["run_command"],
  run: ["run_command"],
  terminal: ["run_command"]
}

const normalize = (name: string) => name.trim().replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().replace(/^tool:/, "").replace(/[_-]/g, "")
const builtinName = (name: string) => {
  const [namespace, local] = name.split("/", 2)
  return local && ["twinny", "vscode", "workspace", "builtin"].includes(namespace) ? local : name
}

export const resolveAgentToolSelection = <TNative extends NamedAgentTool, TMcp extends McpAgentTool>(
  requestedTools: (string | string[]) | undefined,
  nativeTools: TNative[],
  mcpTools: TMcp[]
): AgentToolSelection<TNative, TMcp> => {
  const requested: string[] = !requestedTools ? [] : Array.isArray(requestedTools) ? requestedTools : [requestedTools]
  if (requested.length === 0) {
    return { explicit: false, native: nativeTools, mcp: mcpTools, unmatched: [] }
  }
  const nativeByName = new Map<string, TNative>()
  nativeTools.forEach(tool => nativeByName.set(normalize(tool.name), tool))
  const selectedNative = new Set<TNative>()
  const selectedMcp = new Set<TMcp>()
  const unmatched: string[] = []
  for (const rawName of requested) {
    const name = normalize(rawName)
    if (name === "*") {
      nativeTools.forEach(t => selectedNative.add(t))
      mcpTools.forEach(t => selectedMcp.add(t))
      continue
    }
    const builtin = builtinName(name)
    const nativeMatch = nativeByName.get(normalize(builtin))
    let matched = false
    if (nativeMatch) {
      selectedNative.add(nativeMatch)
      matched = true
    } else {
      const group = NATIVE_GROUPS[name] ?? NATIVE_GROUPS[normalize(builtin)] ?? []
      for (const alias of group) {
        const tool = nativeByName.get(normalize(alias))
        if (tool) {
          selectedNative.add(tool)
          matched = true
        }
      }
    }
    const parts = name.split("/", 2)
    let mcpMatchFound = false
    if (parts.length === 2) {
      for (const tool of mcpTools) {
        if (normalize(tool.server) === normalize(parts[0]) && (parts[1] === "*" || normalize(tool.tool) === normalize(parts[1]))) {
          selectedMcp.add(tool)
          mcpMatchFound = true
        }
      }
    } else {
      for (const tool of mcpTools) {
        if (normalize(tool.tool) === name) {
          selectedMcp.add(tool)
          mcpMatchFound = true
        }
      }
    }
    if (matched || mcpMatchFound) {
      continue
    }
    unmatched.push(rawName)
  }
  const resolvedNative = nativeTools.filter(t => selectedNative.has(t))
  const resolvedMcp = mcpTools.filter(t => selectedMcp.has(t))
  return { explicit: true, native: resolvedNative, mcp: resolvedMcp, unmatched }
}

export const agentToolSelectionDiagnostic = (
  requested: string[] | undefined,
  unmatched: string[],
  available: string[],
  resolvedCount: number
): string => {
  const selected = requested ?? []
  const selection = selected.length
    ? `The profile explicitly restricts tools to: ${selected.join(", ")}.`
    : "The profile explicitly declares an empty tools list."
  const unresolved = unmatched.length ? ` Unmatched names: ${unmatched.join(", ")}.` : ""
  const alternatives = available.length ? ` Available alternatives: ${available.join(", ")}.` : " No tools are currently eligible under Twinny's settings and security policy."
  const outcome = resolvedCount === 0 ? "Agent tool selection resolved to no tools." : "Agent tool selection is partially unresolved."
  return `${outcome} ${selection}${unresolved}${alternatives}`
}
