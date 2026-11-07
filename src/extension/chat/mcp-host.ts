/**
 * The MCP servers the user set up in `twinny.chatToolsMcpServers`, kept
 * running for the chat: started on the first agent reply that wants them,
 * restarted when their configuration changes, closed with the chat. Disabled
 * entries never start or expose tools. Each call is put to the user first
 * unless global approval or Always run permits it, since nothing undoes what a
 * server did.
 */
import { logger } from "../../common/logger"
import { MANY_MCP_TOOLS, McpClient, McpServerConfig, McpToolSpec, mcpToolSpecs } from "../tools/mcp"
import type { McpSink, ToolResult } from "../tools/workspace"

/** How long a reply waits for its servers to start and list their tools. */
const READY_WAIT_MS = 15_000

const isServerEnabled = (value: unknown): boolean =>
  value !== null && typeof value === "object" && !Array.isArray(value) && Reflect.get(value, "enabled") !== false

interface Running {
  client: McpClient
  /** The configuration it was started with, to tell when it changed. */
  key: string
  tools: McpToolSpec[]
}

/** A server's entry in the setting, or why it is not one. */
const serverConfig = (value: unknown): McpServerConfig | string => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "it is not an object"
  const entry = value as Record<string, unknown>
  const type = entry.type === undefined ? "stdio" : entry.type
  if (type !== "stdio" && type !== "http") return "type is not stdio or http"

  if (type === "http") {
    const url = typeof entry.url === "string" ? entry.url.trim() : ""
    if (!url) return "it has no url"
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "url is not an http or https URL"
    } catch {
      return "url is not a valid URL"
    }
    if (entry.command !== undefined) return "http servers do not use command"
    if (entry.args !== undefined && (!Array.isArray(entry.args) || !entry.args.every((a) => typeof a === "string"))) {
      return "args is not a list of strings"
    }
    if (
      entry.env !== undefined &&
      (!entry.env || typeof entry.env !== "object" || !Object.values(entry.env).every((v) => typeof v === "string"))
    ) {
      return "env is not an object of strings"
    }
    if (entry.cwd !== undefined && typeof entry.cwd !== "string") return "cwd is not a string"
    if (
      entry.headers !== undefined &&
      (!entry.headers || typeof entry.headers !== "object" || !Object.values(entry.headers).every((v) => typeof v === "string"))
    ) {
      return "headers is not an object of strings"
    }
    if (entry.timeoutMs !== undefined && (typeof entry.timeoutMs !== "number" || !Number.isFinite(entry.timeoutMs))) {
      return "timeoutMs is not a number"
    }
    return {
      type: "http",
      url,
      ...(entry.headers ? { headers: entry.headers as Record<string, string> } : {}),
      ...(entry.timeoutMs !== undefined ? { timeoutMs: entry.timeoutMs as number } : {})
    }
  }

  if (typeof entry.command !== "string" || !entry.command.trim()) return "it has no command"
  if (entry.args !== undefined && (!Array.isArray(entry.args) || !entry.args.every((a) => typeof a === "string"))) {
    return "args is not a list of strings"
  }
  if (
    entry.env !== undefined &&
    (!entry.env || typeof entry.env !== "object" || !Object.values(entry.env).every((v) => typeof v === "string"))
  ) {
    return "env is not an object of strings"
  }
  if (entry.cwd !== undefined && typeof entry.cwd !== "string") return "cwd is not a string"
  return {
    type: "stdio",
    command: entry.command,
    ...(entry.args ? { args: entry.args as string[] } : {}),
    ...(entry.env ? { env: entry.env as Record<string, string> } : {}),
    ...(entry.cwd ? { cwd: entry.cwd as string } : {})
  }
}

const firstLine = (text: string) => {
  const line = text.trim().split("\n")[0] ?? ""
  return line.length > 80 ? `${line.slice(0, 80)}…` : line
}

export class McpHost {
  private readonly _running = new Map<string, Running>()

  constructor(
    private readonly _servers: () => Record<string, unknown> | undefined,
    private readonly _cwd: () => string | undefined,
    private readonly _timeouts: { startMs?: number; callMs?: number } = {}
  ) {}

  /** Whether the user set up any server. */
  get configured(): boolean {
    return Object.values(this._servers() ?? {}).some(isServerEnabled)
  }

  /** The tools of every server that is up, in the settings' order, so the prompt reads the same each reply. */
  get tools(): McpToolSpec[] {
    const servers = this._servers() ?? {}
    return Object.keys(servers).flatMap((name) => (isServerEnabled(servers[name]) ? this._running.get(name)?.tools ?? [] : []))
  }

  /**
   * Start what the settings name and is not running (or changed), close
   * what they no longer name, and read the new servers' tools. A server
   * that fails is logged and left out; the reply goes on without it.
   */
  async ready(names?: string[]): Promise<McpToolSpec[]> {
    const configured = this._servers() ?? {}
    for (const [name, running] of this._running) {
      if (!isServerEnabled(configured[name]) || running.key !== JSON.stringify(configured[name])) {
        running.client.close()
        this._running.delete(name)
      }
    }
    const wanted = Object.fromEntries(Object.entries(configured).filter(([name, value]) =>
      isServerEnabled(value) && (names === undefined || names.includes(name))
    ))
    const taken = new Set(this.tools.map((tool) => tool.name))
    const starting = Object.entries(wanted)
      .filter(([name]) => !this._running.has(name))
      .map(async ([name, value]) => {
        const config = serverConfig(value)
        if (typeof config === "string") {
          logger.warn(`MCP server ${name} is not started: ${config}.`)
          return
        }
        const client = new McpClient(name, config, {
          cwd: this._cwd() ?? process.cwd(),
          startTimeoutMs: this._timeouts.startMs,
          callTimeoutMs: this._timeouts.callMs,
          onStderr: (text) => logger.debug(`MCP ${name}: ${text.trim()}`)
        })
        try {
          const tools = await client.listTools()
          if (!isServerEnabled(this._servers()?.[name])) {
            client.close()
            return
          }
          if (tools.length > MANY_MCP_TOOLS) {
            logger.warn(
              `MCP server ${name} offers ${tools.length} tools; small models pick worse from long lists. Fewer servers, or a server set to fewer tools, helps.`
            )
          }
          const specs = mcpToolSpecs(name, tools, taken)
          this._running.set(name, { client, key: JSON.stringify(value), tools: specs })
          logger.info(`MCP server ${name} is up with ${specs.length} tool${specs.length === 1 ? "" : "s"}.`)
        } catch (error) {
          client.close()
          logger.warn(`MCP server ${name} could not start: ${error instanceof Error ? error.message : error}`)
        }
      })
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      Promise.allSettled(starting),
      new Promise((resolve) => (timer = setTimeout(resolve, READY_WAIT_MS)))
    ])
    clearTimeout(timer)
    return this.toolsFor(names)
  }

  toolsFor(names?: string[]): McpToolSpec[] {
    return names === undefined ? this.tools : this.tools.filter((tool) => names.includes(tool.server))
  }

  /** The tools for one reply; `approve` says whether a call may run. */
  sink(
    approve: (detail: string, tool: McpToolSpec) => Promise<boolean>,
    autoApprove: () => boolean = () => false,
    permitted: McpToolSpec[] = this.tools
  ): McpSink {
    const allowed = new Set(permitted.map((tool) => `${tool.server}/${tool.tool}`))
    return {
      tools: permitted,
      call: async (tool, args, context): Promise<ToolResult> => {
        const label = `${tool.server}/${tool.tool}`
        if (!allowed.has(label)) {
          return { output: `The MCP capability ${label} is not permitted for this agent.`, summary: `\`${label}\` failed · not permitted`, failed: true }
        }
        if (!isServerEnabled(this._servers()?.[tool.server])) {
          return {
            output: `The MCP server ${tool.server} is disabled or not configured.`,
            summary: `\`${label}\` failed · server disabled`,
            failed: true
          }
        }
        if (!autoApprove() && !(await approve(`${label} ${JSON.stringify(args)}`, tool))) {
          return {
            output: "The user chose not to run this tool. Carry on without it, or ask the user.",
            summary: `\`${label}\` skipped`,
            failed: true
          }
        }
        const running = this._running.get(tool.server)
        if (!running) {
          return { output: `The MCP server ${tool.server} is not running.`, summary: `\`${label}\` failed · not running`, failed: true }
        }
        try {
          const result = await running.client.callTool(tool.tool, args, context?.signal)
          const output = result.text.trim() || "(no output)"
          return {
            output: result.isError ? `The tool reported an error:\n${output}` : output,
            summary: `\`${label}\` · ${result.isError ? `error · ${firstLine(output)}` : firstLine(output) || "done"}`,
            ...(result.isError ? { failed: true } : {})
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return { output: message, summary: `\`${label}\` failed · ${firstLine(message)}`, failed: true }
        }
      }
    }
  }

  dispose() {
    for (const running of this._running.values()) running.client.close()
    this._running.clear()
  }
}
