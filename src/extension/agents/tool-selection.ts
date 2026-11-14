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
  read: ["list_dir", "find_files", "search_workspace", "read_file", "grep", "find_symbol", "editor_context", "find_references", "go_to_definition", "diagnostics"],
  search: ["search_workspace", "search_code", "grep", "find_files", "find_symbol", "find_references"],
  edit: ["edit_lines", "create_file", "rename_symbol", "move_file", "delete_file"],
  execute: ["run_command"],
  run: ["run_command"],
  terminal: ["run_command"]
}

/** Retired native tools that saved profiles may still name; they resolve to their replacement. */
const RETIRED_NATIVE_TOOLS: Record<string, string> = { editfile: "editlines" }

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
  if (requestedTools === undefined) {
    return { explicit: false, native: nativeTools, mcp: mcpTools, unmatched: [] }
  }
  const requested: string[] = Array.isArray(requestedTools) ? requestedTools : [requestedTools]
  if (requested.length === 0) return { explicit: true, native: [], mcp: [], unmatched: [] }
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
    const key = normalize(builtin)
    const nativeMatch = nativeByName.get(RETIRED_NATIVE_TOOLS[key] ?? key)
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
    } else if (!matched) {
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


export interface TaskToolProjection<TNative extends NamedAgentTool, TMcp extends McpAgentTool> {
  native: TNative[]
  mcp: TMcp[]
  excluded: Array<{ name: string; reason: string }>
}

const TASK_RELEVANT_MCP = /(?:read|file|workspace|search|grep|symbol|diagnostic|test|command|git|todo|edit|write)/i
const DOCUMENTATION_TASK = /(?:documentation|docs|library|api reference)/i

export const projectTaskRelevantTools = <TNative extends NamedAgentTool, TMcp extends McpAgentTool>(
  native: TNative[],
  mcp: TMcp[],
  taskContext: string,
  adaptiveEnabled: boolean
): TaskToolProjection<TNative, TMcp> => {
  if (!adaptiveEnabled) return { native, mcp, excluded: [] }
  const documentationTask = DOCUMENTATION_TASK.test(taskContext)
  const eligible = mcp.filter((tool) => TASK_RELEVANT_MCP.test(tool.server + " " + tool.tool) || (documentationTask && /(?:context7|deepwiki|docs?)/i.test(tool.server + " " + tool.tool)))
  if (mcp.length && !eligible.length) return { native, mcp, excluded: [] }
  const seen = new Set<string>()
  const retained: TMcp[] = []
  const duplicates = new Set<TMcp>()
  for (const tool of eligible) {
    const key = (tool.server + "/" + tool.tool).toLowerCase()
    if (seen.has(key)) duplicates.add(tool)
    else {
      seen.add(key)
      retained.push(tool)
    }
  }
  const retainedSet = new Set(retained)
  return {
    native,
    mcp: retained,
    excluded: mcp.filter((tool) => !retainedSet.has(tool)).map((tool) => ({
      name: tool.server + "/" + tool.tool,
      reason: duplicates.has(tool) ? "Duplicate MCP capability with the same server and tool" : "No matching task capability; adaptive exposure is enabled"
    }))
  }
}
