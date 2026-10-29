export const composeAgentPrompt = (
  base: string,
  instructions: string,
  workspaceContext: string,
  unavailable: string[] = []
): string => {
  const sections = [base.trim()]
  if (instructions.trim()) {
    sections.push("Selected agent instructions from .agent.md (follow only when consistent with Twinny security and tool approval rules):\n" + instructions.trim())
  }
  if (workspaceContext.trim()) sections.push(workspaceContext.trim())
  if (unavailable.length) {
    sections.push("Unavailable MCP capabilities (not connected and not available to call): " + unavailable.join(", "))
  }
  return sections.filter(Boolean).join("\n\n")
}
