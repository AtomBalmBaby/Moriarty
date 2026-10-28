import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

export interface HttpMcpServerConfig {
  type: "http"
  url: string
  headers?: Record<string, string>
  timeoutMs?: number
}

export interface HttpMcpClientOptions {
  cwd: string
  startTimeoutMs?: number
  callTimeoutMs?: number
  onStderr?(text: string): void
}

const DEFAULT_START_TIMEOUT_MS = 15_000
const DEFAULT_CALL_TIMEOUT_MS = 30_000

export class HttpMcpClient {
  private _client?: Client
  private _transport?: StreamableHTTPClientTransport
  private _started?: Promise<void>

  constructor(
    readonly name: string,
    private readonly _config: HttpMcpServerConfig,
    private readonly _options: HttpMcpClientOptions
  ) {}

  async start(): Promise<void> {
    if (this._started) return this._started
    this._started = this.begin().catch((error) => {
      this.close().catch(() => undefined)
      throw error
    })
    return this._started
  }

  private async begin() {
    const url = new URL(this._config.url)
    if (!/[hH][tT][tT][pP][sS]?:/.test(url.protocol)) {
      throw new Error(`The MCP server ${this.name} URL must use http or https.`)
    }
    this._transport = new StreamableHTTPClientTransport(url, {
      requestInit: this._config.headers ? { headers: this._config.headers } : undefined
    })
    this._client = new Client({ name: "twinny", version: "1" }, { capabilities: {} })
    const controller = new AbortController()
    const timeoutMs = this._config.timeoutMs ?? this._options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      await this._client.connect(this._transport, { signal: controller.signal } as never)
    } finally {
      clearTimeout(timer)
    }
  }

  async listTools(): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>> {
    await this.start()
    const result = await this._client!.listTools()
    return (result.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
    }))
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ text: string; isError: boolean }> {
    await this.start()
    const controller = new AbortController()
    const timeoutMs = this._config.timeoutMs ?? this._options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const combined = new AbortController()
      const onAbort = () => combined.abort()
      if (signal) signal.addEventListener("abort", onAbort, { once: true })
      controller.signal.addEventListener("abort", onAbort, { once: true })
      const result = (await this._client!.callTool({ name, arguments: args }, undefined, {
        signal: combined.signal
      } as never)) as { content?: unknown[]; structuredContent?: unknown; isError?: boolean }
      return { text: contentText(result), isError: result.isError === true }
    } finally {
      clearTimeout(timer)
    }
  }

  async close(): Promise<void> {
    if (this._transport) {
      await this._transport.close()
      this._transport = undefined
    }
    this._client = undefined
    this._started = undefined
  }
}

export const contentText = (result: { content?: unknown[]; structuredContent?: unknown; isError?: boolean } | undefined): string => {
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
