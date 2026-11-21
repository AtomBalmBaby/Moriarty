import { randomUUID } from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import type * as VsCode from "vscode"

import { redact } from "../common/logger"

export type DiagnosticCategory = "agent" | "prompts" | "thinking" | "toolcalls" | "transport"

export interface DiagnosticContext {
  conversationId?: string
  operationId?: string
  requestId?: string
  executionId?: string
  step?: number
  agentId?: string
  provider?: string
  model?: string
}

export interface DiagnosticRecord {
  timestamp: string
  sequence: number
  category: DiagnosticCategory
  event: string
  conversationId?: string
  operationId?: string
  requestId?: string
  executionId?: string
  step?: number
  agentId?: string
  provider?: string
  model?: string
  data?: unknown
}

const loadVsCode = (): typeof VsCode | undefined => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("vscode") as typeof VsCode
  } catch {
    return undefined
  }
}

const vscode = loadVsCode()

const categorySetting: Record<DiagnosticCategory, string> = {
  agent: "debug.agent",
  prompts: "debug.prompts",
  thinking: "debug.thinking",
  toolcalls: "debug.toolcalls",
  transport: "debug.transport"
}

let sequence = 0
let writeQueue: Promise<void> = Promise.resolve()
let traceDirectory: string | undefined
let tracePrefix = ""
let storageDirectory: string | undefined

export const setDiagnosticStorageDirectory = (directory: string | undefined): void => {
  if (!directory) return
  storageDirectory = path.join(directory, "diagnostics")
  traceDirectory = undefined
}

export const resetDiagnosticTraceDirectory = (): void => {
  traceDirectory = undefined
  tracePrefix = new Date().toISOString().replace(/[:.]/g, "-")
}

export const flushDiagnosticTrace = async (): Promise<void> => {
  await writeQueue.catch(() => undefined)
}

export const diagnosticCategoriesEnabled = (): Set<DiagnosticCategory> => {
  if (!vscode) return new Set()
  const config = vscode.workspace.getConfiguration("twinny")
  const enabled = new Set<DiagnosticCategory>()
  for (const category of Object.keys(categorySetting) as DiagnosticCategory[]) {
    if (config.get<boolean>(categorySetting[category], false)) enabled.add(category)
  }
  return enabled
}

export const diagnosticCategoryEnabled = (category: DiagnosticCategory): boolean =>
  diagnosticCategoriesEnabled().has(category)

const configuredTraceDirectory = (): string => {
  if (!vscode) return path.join(os.tmpdir(), "twinny-diagnostics")
  const configured = vscode.workspace.getConfiguration("twinny").get<string>("debug.traceDirectory", "").trim()
  if (configured) return path.resolve(configured)
  return path.join(storageDirectory ?? os.homedir(), "twinny-diagnostics")
}

const redactPayload = (value: unknown, unredacted: boolean): unknown => {
  if (typeof value === "string") return redact(value)
  if (Array.isArray(value)) return value.map((entry) => redactPayload(entry, unredacted))
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (/^(authorization|proxy-authorization|cookie|set-cookie|api[-_]?key|token|secret|password)$/i.test(key)) {
        out[key] = "[REDACTED]"
      } else {
        out[key] = redactPayload(entry, unredacted)
      }
    }
    return out
  }
  return value
}

const rotateAndPrune = async (directory: string): Promise<void> => {
  if (!vscode) return
  const config = vscode.workspace.getConfiguration("twinny")
  const retentionDays = config.get<number>("debug.traceRetentionDays", 7)
  const maxBytes = config.get<number>("debug.traceMaxBytes", 104857600)
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
  const entries = await fs.readdir(directory, { withFileTypes: true })
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => path.join(directory, entry.name))
  const stats = await Promise.all(files.map(async (file) => ({ file, stat: await fs.stat(file) })))
  let total = stats.reduce((sum, entry) => sum + entry.stat.size, 0)
  for (const entry of stats.sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs)) {
    if (entry.stat.mtimeMs < cutoff || total > maxBytes) {
      await fs.rm(entry.file, { force: true }).catch(() => undefined)
      total -= entry.stat.size
    }
  }
}

export const diagnosticTracePath = async (): Promise<string | undefined> => {
  if (!diagnosticCategoriesEnabled().size) return undefined
  if (!traceDirectory) {
    traceDirectory = configuredTraceDirectory()
    tracePrefix = new Date().toISOString().replace(/[:.]/g, "-")
  }
  await fs.mkdir(traceDirectory, { recursive: true, mode: 0o700 }).catch(() => undefined)
  await fs.chmod(traceDirectory, 0o700).catch(() => undefined)
  const tracePath = path.join(traceDirectory, `moriarty-${tracePrefix}-${process.pid}.jsonl`)
  await rotateAndPrune(traceDirectory)
  return tracePath
}

export const diagnosticEvent = (
  category: DiagnosticCategory,
  event: string,
  context: DiagnosticContext = {},
  data: unknown = undefined
): void => {
  if (!diagnosticCategoryEnabled(category)) return
  const timestamp = new Date().toISOString()
  const record: DiagnosticRecord = {
    timestamp,
    sequence: ++sequence,
    category,
    event,
    ...context,
    ...(data === undefined ? {} : {
      data: redactionForCategory(category, data)
    })
  }
  const next = writeQueue.catch(() => undefined).then(async () => {
    const tracePath = await diagnosticTracePath()
    if (!tracePath) return
    const line = `${JSON.stringify(record)}\n`
    await fs.appendFile(tracePath, line, { encoding: "utf8", mode: 0o600 })
    await fs.chmod(tracePath, 0o600).catch(() => undefined)
  })
  writeQueue = next.catch(() => undefined)
}

const redactionForCategory = (_category: DiagnosticCategory, data: unknown): unknown => {
  if (!vscode) return redactPayload(data, false)
  const unredacted = vscode.workspace.getConfiguration("twinny").get<boolean>("debug.unredacted", false)
  return unredacted
    ? redactPayload(data, true)
    : redactPayload(data, false)
}

export const createDiagnosticIds = (context: DiagnosticContext = {}): Required<Pick<DiagnosticContext, "operationId" | "requestId">> & DiagnosticContext => ({
  operationId: context.operationId ?? `op-${randomUUID()}`,
  requestId: context.requestId ?? `request-${randomUUID()}`,
  ...context
})
