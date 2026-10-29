import { JSON_SCHEMA, load } from "js-yaml"
import * as path from "path"

export interface ParsedAgentProfile {
  name: string
  description?: string
  tools?: string[]
  model?: string
  userInvocable: boolean
  disableModelInvocation: boolean
  mcpServers: string[]
  instructions: string
  frontmatter: Record<string, unknown>
  unsupportedFields: string[]
}

const SUPPORTED_FIELDS = new Set([
  "name",
  "description",
  "tools",
  "model",
  "user-invocable",
  "disable-model-invocation",
  "mcp-servers"
])

const stringList = (value: unknown, key: string): string[] | undefined => {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim())) {
    throw new Error(`The '${key}' field must be a list of non-empty strings.`)
  }
  return value.map((item) => item.trim())
}

const booleanField = (value: unknown, key: string, fallback: boolean): boolean => {
  if (value === undefined) return fallback
  if (typeof value !== "boolean") throw new Error(`The '${key}' field must be true or false.`)
  return value
}

export const parseAgentProfile = (content: string, filePath: string): ParsedAgentProfile => {
  if (!filePath.endsWith(".agent.md")) throw new Error("Selectable agent files must end in '.agent.md'.")
  if (content.length > 1_000_000) throw new Error("Agent profile files must be smaller than 1 MB.")
  const source = content.replace(/^\uFEFF/, "")
  const match = source.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)([\s\S]*)$/)
  if (!match) throw new Error("The file must start with YAML frontmatter between '---' lines.")
  let parsed: unknown
  try {
    parsed = load(match[1], { schema: JSON_SCHEMA })
  } catch (error) {
    throw new Error(`Invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("YAML frontmatter must be a mapping of metadata fields.")
  }
  const frontmatter = parsed as Record<string, unknown>
  const name = typeof frontmatter.name === "string" && frontmatter.name.trim()
    ? frontmatter.name.trim()
    : path.basename(filePath).replace(/\.agent\.md$/i, "")
  if (frontmatter.description !== undefined && typeof frontmatter.description !== "string") {
    throw new Error("The 'description' field must be a string.")
  }
  if (frontmatter.model !== undefined && typeof frontmatter.model !== "string") {
    throw new Error("The 'model' field must be a string.")
  }
  const tools = stringList(frontmatter.tools, "tools")
  const mcpValue = frontmatter["mcp-servers"]
  const mcpServers = typeof mcpValue === "string"
    ? [mcpValue]
    : Array.isArray(mcpValue)
      ? stringList(mcpValue, "mcp-servers") ?? []
      : mcpValue && typeof mcpValue === "object"
        ? Object.keys(mcpValue)
        : []
  return {
    name,
    ...(typeof frontmatter.description === "string" ? { description: frontmatter.description } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(typeof frontmatter.model === "string" ? { model: frontmatter.model } : {}),
    userInvocable: booleanField(frontmatter["user-invocable"], "user-invocable", true),
    disableModelInvocation: booleanField(frontmatter["disable-model-invocation"], "disable-model-invocation", false),
    mcpServers,
    instructions: match[2].trim(),
    frontmatter,
    unsupportedFields: Object.keys(frontmatter).filter((key) => !SUPPORTED_FIELDS.has(key))
  }
}
