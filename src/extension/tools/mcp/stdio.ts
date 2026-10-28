import { ChildProcess, spawn } from "child_process"

export interface StdioMcpServerConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
}

export interface StdioMcpClientOptions {
  cwd: string
  startTimeoutMs?: number
  callTimeoutMs?: number
  onStderr?(text: string): void
}

interface Pending {
  resolve(result: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

const START_TIMEOUT_MS = 10_000
const CALL_TIMEOUT_MS = 30_000
const MAX_STDERR_CHARS = 4000

export class StdioMcpClient {
  private _child?: ChildProcess
  private _nextId = 1
  private readonly _pending = new Map<number, Pending>()
  private _buffer = ""
  private _ended?: string
  private _started?: Promise<void>

  constructor(
    readonly name: string,
    private readonly _config: StdioMcpServerConfig,
    private readonly _options: StdioMcpClientOptions
  ) {}

  start(): Promise<void> {
    this._started ??= this.begin().catch((error) => {
      this.close()
      throw error
    })
    return this._started
  }

  private async begin() {
    const child = spawn(this._config.command, this._config.args ?? [], {
      cwd: this._config.cwd ?? this._options.cwd,
      env: { ...process.env, ...this._config.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    })
    this._child = child
    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stdout?.on("data", (chunk: string) => this.receive(chunk))
    child.stderr?.on("data", (chunk: string) => this._options.onStderr?.(chunk.slice(-MAX_STDERR_CHARS)))
    child.on("error", (error) => this.end(`it could not start: ${error.message}`))
    child.on("exit", (code, signal) => this.end(`it exited${signal ? ` on ${signal}` : ` with code ${code}`}`))
    child.stdin?.on("error", () => undefined)
    await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "twinny", version: "1" }
    }, this._options.startTimeoutMs ?? START_TIMEOUT_MS)
    this.notify("notifications/initialized")
  }

  async listTools(): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>> {
    await this.start()
    const tools: Array<{ name: string; description?: string; inputSchema?: unknown }> = []
    let cursor: string | undefined
    for (let page = 0; page < 20; page++) {
      const result = (await this.request("tools/list", cursor ? { cursor } : {})) as {
        tools?: Array<{ name: string; description?: string; inputSchema?: unknown }>
        nextCursor?: string
      }
      for (const tool of result?.tools ?? []) if (tool && typeof tool.name === "string") tools.push(tool)
      cursor = typeof result?.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined
      if (!cursor) break
    }
    return tools
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ text: string; isError: boolean }> {
    await this.start()
    const result = (await this.request("tools/call", { name, arguments: args }, undefined, signal)) as {
      content?: unknown[]
      isError?: boolean
      structuredContent?: unknown
    }
    return { text: contentText(result), isError: result?.isError === true }
  }

  close() {
    this.end("it was closed")
    const child = this._child
    if (child && child.exitCode === null && !child.killed) {
      child.stdin?.end()
      child.kill()
    }
  }

  private request(method: string, params: unknown, timeoutMs?: number, signal?: AbortSignal): Promise<unknown> {
    if (this._ended) return Promise.reject(new Error(`The MCP server ${this.name} is not running: ${this._ended}.`))
    const id = this._nextId++
    return new Promise((resolve, reject) => {
      const limit = timeoutMs ?? this._options.callTimeoutMs ?? CALL_TIMEOUT_MS
      const settle = () => {
        this._pending.delete(id)
        clearTimeout(timer)
        signal?.removeEventListener("abort", onAbort)
      }
      const onAbort = () => {
        settle()
        this.notify("notifications/cancelled", { requestId: id, reason: "The user stopped the reply." })
        reject(new Error("Stopped by the user."))
      }
      const timer = setTimeout(() => {
        settle()
        this.notify("notifications/cancelled", { requestId: id, reason: "Timed out." })
        reject(new Error(`The MCP server ${this.name} did not answer ${method} within ${Math.round(limit / 1000)} s.`))
      }, limit)
      this._pending.set(id, {
        resolve: (result) => {
          settle()
          resolve(result)
        },
        reject: (error) => {
          settle()
          reject(error)
        },
        timer
      })
      if (signal?.aborted) return onAbort()
      signal?.addEventListener("abort", onAbort, { once: true })
      this.send({ jsonrpc: "2.0", id, method, params })
    })
  }

  private notify(method: string, params?: unknown) {
    this.send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) })
  }

  private send(message: unknown) {
    const stdin = this._child?.stdin
    if (!stdin || stdin.destroyed || this._ended) return
    stdin.write(`${JSON.stringify(message)}\n`)
  }

  private receive(chunk: string) {
    this._buffer += chunk
    let newline = this._buffer.indexOf("\n")
    while (newline !== -1) {
      const line = this._buffer.slice(0, newline).trim()
      this._buffer = this._buffer.slice(newline + 1)
      if (line) this.handle(line)
      newline = this._buffer.indexOf("\n")
    }
  }

  private handle(line: string) {
    let message: { id?: number | string; method?: string; result?: unknown; error?: { message?: string } }
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (message.method !== undefined) {
      if (message.id !== undefined) {
        this.send(
          message.method === "ping"
            ? { jsonrpc: "2.0", id: message.id, result: {} }
            : { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `twinny does not offer ${message.method}.` } }
        )
      }
      return
    }
    const pending = typeof message.id === "number" ? this._pending.get(message.id) : undefined
    if (!pending) return
    if (message.error) pending.reject(new Error(message.error.message || "The MCP server reported an error."))
    else pending.resolve(message.result)
  }

  private end(reason: string) {
    if (this._ended) return
    this._ended = reason
    for (const pending of this._pending.values()) pending.reject(new Error(`The MCP server ${this.name} stopped: ${reason}.`))
    this._pending.clear()
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
