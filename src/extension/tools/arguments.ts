/**
 * Native tool arguments as the model sent them, read at one shared boundary.
 *
 * A JSON boolean stays a boolean, a number stays a number, an array or an
 * object keeps its shape. Nothing between a provider's tool call and a handler
 * turns a value into text, drops a field or invents one: `false`, `0`, `""`,
 * an explicit `null` and "not sent at all" all stay distinguishable, and a call
 * whose arguments cannot be read is refused rather than guessed.
 *
 * The one documented legacy accommodation is the text call syntax and the
 * providers that hand arguments as a JSON string: a model writing
 * `read_file(path="a.ts", start_line=10)` sends its values as text, so a
 * handler still accepts the textual spelling of a number, a flag or an array.
 * That is explicit parsing of what was written, never `Boolean(value)`, and it
 * never changes a value that arrived with its own type.
 */

/** A call's arguments: JSON values with their JSON types. */
export type ToolArguments = Record<string, unknown>

/** Why a call was refused. `invalid_range` is kept for coordinates, because existing consumers read that code. */
export type ToolErrorCode =
  | "missing_target"
  | "invalid_hash"
  | "hash_not_found"
  | "ambiguous_hash"
  | "hash_unproven"
  | "hash_mismatch"
  | "stale_hash"
  | "permission_denied"
  | "invalid_argument_type"
  | "malformed_arguments"
  | "missing_argument"
  | "invalid_range"
  | "overlapping_edits"
  | "document_unavailable"
  | "application_failed"
  | "save_failed"

/** A refused call, said so the model can act on it: nothing ran, what was wrong, what to send. */
export interface ToolErrorDetail {
  code: ToolErrorCode
  message: string
  /** Always false here: a refused call never claims it executed. */
  executed: false
  /** The fingerprint the file has now, when a mismatch is what the model must act on. */
  current_hash?: string
  /** The argument the call was missing or sent with the wrong type. */
  required_argument?: string
  /** Paths the caller is allowed to be told about, when more than one answers. */
  candidates?: string[]
  /** The smallest step that would make the same call work. */
  recovery?: string
}

export const argumentFailure = (
  code: ToolErrorCode,
  message: string,
  extra: { required_argument?: string; candidates?: string[]; recovery?: string } = {}
): ToolErrorDetail => ({ code, message, executed: false, ...extra })

/** A tool's contract said one thing and the call brought another. */
export class ToolArgumentError extends Error {
  constructor(public readonly detail: ToolErrorDetail) {
    super(detail.message)
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** What a JSON value is, as it reads in a message. */
export const jsonType = (value: unknown): string => {
  if (value === null) return "null"
  if (Array.isArray(value)) return "an array"
  if (isPlainObject(value)) return "an object"
  return typeof value
}

/** A value as the model wrote it, for a message: text as text, anything else as its JSON. */
export const describeValue = (value: unknown): string => {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** Whether the call sent this field at all; an explicit null is not the same as an absent one. */
export const argumentWasSent = (args: ToolArguments, name: string): boolean =>
  Object.prototype.hasOwnProperty.call(args, name)

/** The arguments as one object of values, or why they are not one. */
export const argumentObject = (args: unknown, tool: string): ToolArguments => {
  if (isPlainObject(args)) return args
  if (typeof args === "string") {
    try {
      const parsed: unknown = JSON.parse(args)
      if (isPlainObject(parsed)) return parsed
    } catch {
      // A string that is not JSON is not a set of arguments.
    }
  }
  throw new ToolArgumentError(
    argumentFailure("malformed_arguments", `${tool}: arguments must be one JSON object of values; nothing was run.`, {
      recovery: "Send the arguments as a JSON object of values and call again."
    })
  )
}

/**
 * Text where the contract says text. An absent field is undefined, so the tool
 * keeps its own "needs a path" message; a value of another type is refused,
 * never stringified into something the handler might act on.
 */
export const textArgument = (subject: string, name: string, args: ToolArguments): string | undefined => {
  const value = args[name]
  if (!argumentWasSent(args, name)) return undefined
  if (value === null) {
    throw new ToolArgumentError(
      argumentFailure("invalid_argument_type", `${subject}: ${name} must be text, not null.`, {
        required_argument: name,
        recovery: `Send ${name} as a JSON string.`
      })
    )
  }
  if (typeof value !== "string") {
    throw new ToolArgumentError(
      argumentFailure("invalid_argument_type", `${subject}: ${name} must be text, not ${jsonType(value)}.`, {
        required_argument: name,
        recovery: `Send ${name} as a JSON string.`
      })
    )
  }
  return value
}

/** A true/false argument. A real boolean is used as it is; the textual spelling is read as text, not cast. */
export const flagArgument = (subject: string, name: string, args: ToolArguments): boolean => {
  const value = args[name]
  if (typeof value === "boolean") return value
  if (!argumentWasSent(args, name)) return false
  if (value === null) {
    throw new ToolArgumentError(
      argumentFailure("invalid_argument_type", `${subject}: ${name} must be true or false, got null.`, {
        required_argument: name,
        recovery: `Send ${name} as a JSON boolean.`
      })
    )
  }
  if (typeof value === "string") {
    const text = value.trim().toLowerCase()
    if (text === "") return false
    if (text === "true") return true
    if (text === "false") return false
  }
  throw new ToolArgumentError(
    argumentFailure("invalid_argument_type", `${subject}: ${name} must be true or false, got "${describeValue(value)}".`, {
      required_argument: name,
      recovery: `Send ${name} as a JSON boolean.`
    })
  )
}

/**
 * A number as the tool's contract declares it: the JSON number, or its text
 * spelling. Range stays the tool's own decision; only the type is decided here,
 * and a value that cannot be read as a number is refused rather than turned
 * into text by a blanket conversion.
 */
export const numberArgument = (subject: string, name: string, args: ToolArguments): number | undefined => {
  const value = args[name]
  if (!argumentWasSent(args, name)) return undefined
  if (value === null) {
    throw new ToolArgumentError(
      argumentFailure("invalid_argument_type", `${subject}: ${name} must be a JSON number, not null.`, {
        required_argument: name,
        recovery: `Send ${name} as a JSON number.`
      })
    )
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ToolArgumentError(argumentFailure("invalid_argument_type", `${subject}: ${name} must be a finite JSON number.`, { required_argument: name }))
    return value
  }
  if (typeof value === "string") {
    const text = value.trim()
    if (text === "") return undefined
    const number = Number(text)
    if (!Number.isFinite(number)) {
      throw new ToolArgumentError(argumentFailure("invalid_argument_type", `${subject}: ${name} must be a JSON number, got "${text}".`, { required_argument: name }))
    }
    return number
  }
  throw new ToolArgumentError(
    argumentFailure("invalid_argument_type", `${subject}: ${name} must be a JSON number, not ${jsonType(value)}.`, {
      required_argument: name,
      recovery: `Send ${name} as a JSON number.`
    })
  )
}

/**
 * A whole positive number: the JSON number as it came, or the text spelling of
 * one (the text call syntax can only write text). Blank text is absent; anything
 * that is not a whole positive number is refused rather than guessed.
 */
export const positiveNumberArgument = (
  subject: string,
  name: string,
  args: ToolArguments,
  phrasing = "a whole number from 1"
): number | undefined => {
  const value = args[name]
  if (!argumentWasSent(args, name)) return undefined
  if (value === null) {
    throw new ToolArgumentError(
      argumentFailure("invalid_argument_type", `${subject}: ${name} must be a JSON integer, not null.`, {
        required_argument: name,
        recovery: `Send ${name} as a JSON integer.`
      })
    )
  }
  let number: number
  if (typeof value === "number") number = value
  else if (typeof value === "string") {
    const text = value.trim()
    if (text === "") return undefined
    number = /^\d+(\.0+)?$/.test(text) ? Number(text) : 0
  } else {
    throw new ToolArgumentError(
      argumentFailure("invalid_argument_type", `${subject}: ${name} must be a JSON number, not ${jsonType(value)}.`, {
        required_argument: name,
        recovery: `Send ${name} as a JSON integer.`
      })
    )
  }
  if (!Number.isInteger(number) || number < 1) {
    throw new ToolArgumentError(
      argumentFailure("invalid_range", `${subject}: ${name} must be ${phrasing}, got "${describeValue(value)}".`, {
        required_argument: name,
        recovery: `Send ${name} as ${phrasing}.`
      })
    )
  }
  return number
}

/** An array or object the tool will use as a structure. A JSON string is read as JSON; nothing is flattened into text. */
export const structureArgument = (subject: string, name: string, args: ToolArguments): unknown[] | Record<string, unknown> | undefined => {
  const value = args[name]
  if (!argumentWasSent(args, name)) return undefined
  if (value === null) {
    throw new ToolArgumentError(
      argumentFailure("invalid_argument_type", `${subject}: ${name} must be a JSON array or object, not null.`, {
        required_argument: name,
        recovery: `Send ${name} as a JSON array or object.`
      })
    )
  }
  if (Array.isArray(value) || isPlainObject(value)) return value
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value)
      if (Array.isArray(parsed) || isPlainObject(parsed)) return parsed
    } catch {
      // Not JSON: falls through to the refusal below.
    }
  }
  throw new ToolArgumentError(
    argumentFailure("invalid_argument_type", `${subject}: ${name} must be a JSON array or object, not ${jsonType(value)}.`, {
      required_argument: name,
      recovery: `Send ${name} as a JSON array or object.`
    })
  )
}

/** The values of one call, read the way its contract says, with the tool's name for each message. */
export interface ArgumentReader {
  text(name: string, subject?: string): string | undefined
  flag(name: string, subject?: string): boolean
  line(name: string, subject?: string, phrasing?: string): number | undefined
  number(name: string, subject?: string): number | undefined
  structure(name: string, subject?: string): unknown[] | Record<string, unknown> | undefined
  /** The value exactly as it came, for a tool that reads it whole. */
  raw(name: string): unknown
  sent(name: string): boolean
}

export const argumentReader = (tool: string, args: ToolArguments): ArgumentReader => ({
  text: (name, subject = tool) => textArgument(subject, name, args),
  flag: (name, subject = tool) => flagArgument(subject, name, args),
  line: (name, subject = tool, phrasing) => positiveNumberArgument(subject, name, args, phrasing),
  number: (name, subject = tool) => numberArgument(subject, name, args),
  structure: (name, subject = tool) => structureArgument(subject, name, args),
  raw: (name) => args[name],
  sent: (name) => argumentWasSent(args, name)
})

/** A value that is not what the tool's own schema says it is. */
export const declaredTypeOf = (type: string | undefined): "string" | "integer" | "boolean" | "array" | "object" => {
  switch (type) {
    case "integer":
      return "integer"
    case "boolean":
      return "boolean"
    case "array":
      return "array"
    case "object":
      return "object"
    default:
      return "string"
  }
}

/**
 * Each argument the tool advertises, checked against what it advertises: a type
 * that does not match is refused before the handler runs, and nothing the call
 * sent is dropped on the way. Fields the tool does not advertise are left for
 * the handler, which has accepted them since they were added.
 */
export const checkDeclaredArguments = (tool: string, parameters: { name: string; optional?: boolean; type?: string }[], args: ToolArguments): void => {
  for (const parameter of parameters) {
    if (!argumentWasSent(args, parameter.name)) continue
    const value = args[parameter.name]
    const declared = declaredTypeOf(parameter.type)
    let reads: boolean
    if (value === null) reads = false
    else reads =
      declared === "integer"
        ? (typeof value === "number" && Number.isSafeInteger(value)) || typeof value === "string"
        : declared === "boolean"
          ? typeof value === "boolean" || typeof value === "string"
          : declared === "array"
              ? Array.isArray(value) || typeof value === "string"
            : declared === "object"
              ? isPlainObject(value) || typeof value === "string"
              : typeof value === "string"
    if (reads) continue
    throw new ToolArgumentError(
      argumentFailure("invalid_argument_type", `${tool}: ${parameter.name} must be ${declared}, not ${jsonType(value)}.`, {
        required_argument: parameter.name,
        recovery: `Send ${parameter.name} as a JSON ${declared}${parameter.optional ? ", or leave it out" : ""}.`
      })
    )
  }
}

/** A tool's error with the fields the model needs: what ran, what is needed, what to do next. */
export const structuredErrorResult = (detail: ToolErrorDetail, name: string): { output: string; summary: string; failed: true; error: ToolErrorDetail } => ({
  output: JSON.stringify({ ok: false, error: detail }),
  summary: `${name} failed · ${detail.message}`,
  failed: true,
  error: detail
})


/**
 * The arguments as text for a step, a log or an export. Text stays as the
 * model wrote it; anything else is shown as its JSON, so a boolean does not
 * become the word for it.
 */
export const displayArguments = (args: ToolArguments): Record<string, string> =>
  Object.fromEntries(Object.entries(args).map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)]))
