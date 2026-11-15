import { logger } from "../../common/logger"

/** Keys whose values name what a call does; shown in full, since they are not source text. */
const CONTROL_KEYS = new Set(["operation", "type", "op", "action", "mode"])
const MAX_SHOWN_ITEMS = 10
const MAX_DEPTH = 8
const MAX_OUTPUT_CHARS = 300

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const parseJson = (text: string): { value: unknown } | undefined => {
  try {
    return { value: JSON.parse(text) }
  } catch {
    return undefined
  }
}

/**
 * The shape of a value: its keys, control values, numbers and booleans, with
 * text replaced by its length. JSON held in a string is shaped as well, since
 * a tool's `edits` argument arrives that way. Source text never appears.
 */
export const shapeOf = (key: string, value: unknown, depth = 0): unknown => {
  if (value === undefined) return "undefined"
  if (value === null || typeof value === "number" || typeof value === "boolean") return value
  if (typeof value === "string") {
    if (CONTROL_KEYS.has(key)) return value.slice(0, 24)
    const trimmed = value.trim()
    const container = /^[[{]/.test(trimmed) && depth < MAX_DEPTH ? parseJson(trimmed) : undefined
    if (container) return shapeOf(key, container.value, depth + 1)
    return `<${value.length} chars>`
  }
  if (depth >= MAX_DEPTH) return `<${Array.isArray(value) ? "array" : typeof value}>`
  if (Array.isArray(value)) {
    const shown = value.slice(0, MAX_SHOWN_ITEMS).map((item) => shapeOf("", item, depth + 1))
    return value.length > MAX_SHOWN_ITEMS ? [...shown, `<${value.length - MAX_SHOWN_ITEMS} more items>`] : shown
  }
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, shapeOf(name, item, depth + 1)]))
  }
  return `<${typeof value}>`
}

/**
 * Where the arguments the model sent differ from the ones the tool received,
 * key by key. Dropped nulls, values changed in type, and keys lost either way
 * are what a model that "sent" a call can still be wrong about.
 */
export const describeMismatch = (sent: Record<string, unknown>, received: Record<string, string>): string[] => {
  const notes: string[] = []
  for (const [key, value] of Object.entries(sent)) {
    if (value === null || value === undefined) notes.push(`${key}: sent as ${value}, not received`)
    else if (!(key in received)) notes.push(`${key}: sent, not received`)
    else if (typeof value === "string" ? received[key] !== value : received[key] !== JSON.stringify(value)) notes.push(`${key}: changed between sent and received`)
  }
  for (const key of Object.keys(received)) {
    if (!(key in sent)) notes.push(`${key}: received, not sent`)
  }
  return notes
}

/** What a failed call was: the model's text, as written, and what the tool received of it. */
export interface ToolFailure {
  /** The tool's name, as the model called it. */
  name: string
  /** The call's ID as the model's server gave it, to match against the server's own logs. */
  callId?: string
  /** The call's invocation ID, as in the step stream. */
  id: string
  mode: string
  provider?: string
  /** The one-line summary the step shows. */
  summary: string
  /** The full output the model was given. */
  output: string
  /** The call's arguments exactly as the model wrote them, before anything mended them. */
  sent?: string
  /** Why the sent text is not JSON, when the parser said. */
  detail?: string
  /** The arguments the tool received; absent when the call was never read. */
  received?: Record<string, string>
}

/** The sent arguments as an object, or why they are not one. A text call written whole carries its arguments inside it. */
const parseSent = (text: string, detail?: string): { value: Record<string, unknown> } | { problem: string } => {
  const body = text.trim().replace(/^```[\w-]*\s*/, "").replace(/\s*```$/, "")
  const parsed = parseJson(body)
  if (!parsed) return { problem: `not JSON (${text.length} chars${detail ? `; ${detail}` : ""})` }
  let value = parsed.value
  if (isObject(value) && "name" in value && "arguments" in value) value = value.arguments
  if (typeof value === "string") {
    const inner = parseJson(value)
    value = inner ? inner.value : value
  }
  if (!isObject(value)) return { problem: `not an object (${Array.isArray(value) ? "array" : typeof value})` }
  return { value }
}

const oneLine = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > MAX_OUTPUT_CHARS ? `${flat.slice(0, MAX_OUTPUT_CHARS)}… (${flat.length - MAX_OUTPUT_CHARS} more characters)` : flat
}

/**
 * Logs a failed tool call. The warning is always written, whatever the debug
 * setting: the argument shapes, the sent-versus-received differences, and the
 * output. Source text stays out of it. The full request and output follow at
 * debug level, when logging is on.
 */
export const logToolFailure = (failure: ToolFailure): void => {
  const origin = [failure.mode, failure.provider].filter(Boolean).join(", ")
  const lines = [`tool failed · ${failure.name} (${origin}) · call ${failure.callId ?? "none"}, step ${failure.id} · ${failure.summary}`]

  let sent: Record<string, unknown> | undefined
  if (failure.sent === undefined) {
    lines.push("    sent: nothing recorded")
  } else {
    const read = parseSent(failure.sent, failure.detail)
    if ("value" in read) {
      sent = read.value
      lines.push(`    sent: ${JSON.stringify(shapeOf("", sent))}`)
    } else {
      lines.push(`    sent: ${read.problem}`)
    }
  }

  lines.push(`    received: ${failure.received ? JSON.stringify(shapeOf("", failure.received)) : "not read as a call"}`)
  if (sent && failure.received) {
    for (const note of describeMismatch(sent, failure.received)) lines.push(`    mismatch: ${note}`)
  }
  lines.push(`    output: ${oneLine(failure.output)}`)

  logger.warn(lines.join("\n"))
  logger.block(
    `tool failed · ${failure.name} ${failure.id}, as sent, received and returned`,
    JSON.stringify({ sent: failure.sent, received: failure.received, output: failure.output }, null, 2)
  )
}
