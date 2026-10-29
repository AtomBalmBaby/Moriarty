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
  requested: string[] | undefined,
  nativeTools: TNative[],
  mcpTools: TMcp[]
): AgentToolSelection<TNative, TMcp> => {
  if (requested === undefined) {
    return { explicit: false, native: nativeTools, mcp: mcpTools, unmatched: [] }
  }

  const nativeByName = new Map(nativeTools.map((tool) => [normalize(tool.name), tool]))
  const selectedNative = new Set<TNative>()
  const selectedMcp = new Set<TMcp>()
  const unmatched: string[] = []

  for (const rawName of requested) {
    const name = normalize(rawName)
    if (name === "*") {
      nativeTools.forEach((tool) => selectedNative.add(tool))
      mcpTools.forEach((tool) => selectedMcp.add(tool))
      continue
    }

    const nativeName = normalize(builtinName(name))
    const nativeMatch = nativeByName.get(nativeName)
    let matched = false
    if (nativeMatch) {
      selectedNative.add(nativeMatch)
      matched = true
    }
    for (const alias of NATIVE_GROUPS[name] ?? NATIVE_GROUPS[nativeName] ?? []) {
      const tool = nativeByName.get(normalize(alias))
      if (tool) {
        selectedNative.add(tool)
        matched = true
      }
    }

    const qualified = name.split("/", 2)
    const isBuiltinNamespace = qualified.length === 2 && ["twinny", "vscode", "workspace", "builtin"].includes(qualified[0])
    const isNativeAlias = !!(NATIVE_GROUPS[name] ?? NATIVE_GROUPS[nativeName])
    const mcpMatches = qualified.length === 2 && !isBuiltinNamespace
      ? mcpTools.filter((tool) => normalize(tool.server) === qualified[0] && (qualified[1] === "*" || normalize(tool.tool) === qualified[1]))
      : nativeMatch || isNativeAlias
        ? []
        : mcpTools.filter((tool) => normalize(tool.tool) === name)
    mcpMatches.forEach((tool) => selectedMcp.add(tool))
    if (mcpMatches.length) matched = true
    if (!matched) unmatched.push(rawName)
  }

  return {
    explicit: true,
    native: nativeTools.filter((tool) => selectedNative.has(tool)),
    mcp: mcpTools.filter((tool) => selectedMcp.has(tool)),
    unmatched
  }
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
