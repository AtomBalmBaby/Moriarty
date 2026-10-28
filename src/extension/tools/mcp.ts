/**
 * Model Context Protocol servers as agent tools. The active transport is
 * selected from the server configuration: legacy stdio when no type is set,
 * or the HTTP adapter when type:"http" is configured.
 */
import { HttpMcpClient } from "./mcp/http"
import { StdioMcpClient } from "./mcp/stdio"
import type { ToolParameter, ToolSpec } from "./protocol"

export const MCP_PROTOCOL_VERSION = "2025-06-18"
export const MANY_MCP_TOOLS = 20
const MAX_DESCRIPTION_CHARS = 200

export type McpTransportType = "stdio" | "http"

export interface McpServerConfigBase {
  type?: McpTransportType
  headers?: Record<string, string>
  timeoutMs?: number
}

export interface McpServerConfigStdio extends McpServerConfigBase {
  type?: "stdio"
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
}

export interface McpServerConfigHttp extends McpServerConfigBase {
  type: "http"
  url: string
  headers?: Record<string, string>
  timeoutMs?: number
}

export type McpServerConfig = McpServerConfigStdio | McpServerConfigHttp

export interface JsonSchema {
  type?: string | string[]
  description?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  [key: string]: unknown
}

export interface McpTool {
  name: string
  description?: string
  inputSchema?: JsonSchema
}

export interface McpCallResult {
  text: string
  isError: boolean
}

export interface McpClientOptions {
  cwd: string
  startTimeoutMs?: number
  callTimeoutMs?: number
  onStderr?(text: string): void
}

export const resolveMcpTransportType = (config: Partial<McpServerConfig> | undefined): McpTransportType => {
  if (config?.type === "http") return "http"
  if (typeof (config as { url?: string } | undefined)?.url === "string" && (config as { url?: string }).url?.trim()) return "http"
  return "stdio"
}

export class McpClient {
  private readonly _client: StdioMcpClient | HttpMcpClient

  constructor(readonly name: string, config: McpServerConfig, options: McpClientOptions) {
    if (resolveMcpTransportType(config) === "http") {
      this._client = new HttpMcpClient(name, config as McpServerConfigHttp, options)
    } else {
      this._client = new StdioMcpClient(name, config as McpServerConfigStdio, options)
    }
  }

  start(): Promise<void> {
    return this._client.start()
  }

  listTools(): Promise<McpTool[]> {
    return this._client.listTools() as Promise<McpTool[]>
  }

  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> {
    return this._client.callTool(name, args, signal) as Promise<McpCallResult>
  }

  close() {
    return this._client.close()
  }
}

export const contentText = (result: { content?: unknown[]; structuredContent?: unknown } | undefined): string => {
  const parts = (result?.content ?? []).map((item) => {
    const part = item as { type?: string; text?: string; name?: string; uri?: string; resource?: { uri?: string; text?: string } }
    if (part.type === "text" && typeof part.text === "string") return part.text
    if (part.type === "image") return "[image]"
    if (part.type === "audio") return "[audio]"
    if (part.type === "resource") return part.resource?.text ?? `[resource ${part.resource?.uri ?? ""}]`.trim()
    if (part.type === "resource_link") return `[resource ${part.name ?? part.uri ?? ""}]`.trim()
    return ""
  })
  const text = parts.filter(Boolean).join("\n")
  if (text) return text
  return result?.structuredContent === undefined ? "" : JSON.stringify(result.structuredContent)
}

export const qualifiedToolName = (server: string, tool: string) =>
  `${server}__${tool}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64)

const clipDescription = (text: string | undefined) => {
  const flat = (text ?? "").replace(/\s+/g, " ").trim()
  return flat.length > MAX_DESCRIPTION_CHARS ? `${flat.slice(0, MAX_DESCRIPTION_CHARS - 1)}…` : flat
}

const typeOf = (schema: JsonSchema | undefined) => (Array.isArray(schema?.type) ? schema?.type[0] : schema?.type)

export const coerceArguments = (schema: JsonSchema | undefined, args: Record<string, string>): Record<string, unknown> => {
  const properties = schema?.properties ?? {}
  return Object.fromEntries(
    Object.entries(args).map(([name, value]) => {
      const type = typeOf(properties[name])
      if (type === "number" || type === "integer") {
        const number = Number(value)
        return [name, Number.isFinite(number) && value.trim() !== "" ? number : value]
      }
      if (type === "boolean") return [name, value === "true" ? true : value === "false" ? false : value]
      if (type === "object" || type === "array" || type === "null") {
        try {
          return [name, JSON.parse(value)]
        } catch {
          return [name, value]
        }
      }
      return [name, value]
    })
  )
}

export interface McpToolSpec extends ToolSpec {
  server: string
  tool: string
}

export const mcpToolSpecs = (server: string, tools: McpTool[], taken: Set<string>): McpToolSpec[] =>
  tools.flatMap((tool) => {
    let name = qualifiedToolName(server, tool.name)
    for (let n = 2; taken.has(name); n++) name = `${qualifiedToolName(server, tool.name).slice(0, 60)}_${n}`
    taken.add(name)
    const schema: JsonSchema = tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : { type: "object" }
    const required = new Set(Array.isArray(schema.required) ? schema.required : [])
    const parameters: ToolParameter[] = Object.entries(schema.properties ?? {}).map(([parameter, property]) => ({
      name: parameter,
      description: clipDescription(property?.description) || parameter,
      ...(required.has(parameter) ? {} : { optional: true })
    }))
    return [
      {
        name,
        server,
        tool: tool.name,
        description: `${clipDescription(tool.description) || tool.name} (from the MCP server ${server})`,
        parameters,
        schema: { type: "object", ...schema }
      }
    ]
  })
