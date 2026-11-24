/**
 * The project's own config file, `<projectHome>/.twinny/config.json`, read once and shared by every
 * section that owns keys in it: `evidence` for the byte store, `git` for Moriarty's Git integration.
 *
 * Nothing here writes or resets a user's configuration. A missing file means the caller's documented
 * defaults; an unreadable, corrupt or invalid file is reported as an actionable error and never
 * silently fallen back on. A key outside the section a caller reads stays in the file untouched and is
 * reported by that caller, never dropped here: sharing the parser changes no section's report of what
 * it does not read.
 *
 * A value can be given directly or as a reference to the name of an environment variable. Only names
 * are stored in the project file; a reference is resolved at execution time, and a resolved secret value
 * goes only to the process that needs it, never into a reading, an evidence row, a log or a tool result.
 */
import fs from "node:fs/promises"
import path from "node:path"

import { isRecord } from "../../common/guards"

import { PROJECT_TODO_DIRECTORY } from "./project-home"

export const PROJECT_CONFIG_NAME = "config.json"

/** A value given directly, or as the name of an environment variable. The file holds names, never values. */
export type ConfigValue = { value: string } | { env: string }

/** What one section found wrong with the file: the file it read and the line a user can act on. */
export interface ConfigProblem { path: string; reason: string }

export interface ConfigDocument {
  path: string
  source: "defaults" | "config.json"
  document: Record<string, unknown>
}

export type DocumentReading =
  | { state: "effective"; reading: ConfigDocument }
  | { state: "invalid"; path: string; reason: string }

export const projectConfigPath = (projectHome: string): string =>
  path.join(projectHome, PROJECT_TODO_DIRECTORY, PROJECT_CONFIG_NAME)

/** The keys the file names besides the one this section reads, reported so nothing is silently dropped. */
export const otherKeysOf = (document: Record<string, unknown>, ownKey: string): string[] =>
  Object.keys(document).filter((key) => key !== ownKey)

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Reads the file as it stands. A corrupt file is reported, not worked around. */
export const readProjectConfigDocument = async (projectHome: string): Promise<DocumentReading> => {
  const file = projectConfigPath(projectHome)
  let text: string
  try {
    text = await fs.readFile(file, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { state: "effective", reading: { path: file, source: "defaults", document: {} } }
    return { state: "invalid", path: file, reason: `could not be read: ${messageOf(error)}` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch (error) {
    return { state: "invalid", path: file, reason: `is not JSON (${messageOf(error)}); correct it or remove it` }
  }
  if (!isRecord(parsed))
    return { state: "invalid", path: file, reason: `must hold a JSON object, not ${Array.isArray(parsed) ? "an array" : String(parsed)}` }
  return { state: "effective", reading: { path: file, source: "config.json", document: parsed } }
}

/**
 * Safe reload: the file is read again only when it has changed on disk, so a new setting takes effect at
 * the next operation without a restart and without re-reading a file that did not change. Every section
 * shares one stamp cache, so two readers of the same project file do not parse it twice.
 */
export interface DocumentSource {
  effective(): Promise<DocumentReading>
  /** What this source last answered with, for diagnostics. */
  last(): DocumentReading | undefined
}

export const createDocumentSource = (projectHome: string): DocumentSource => {
  let last: DocumentReading | undefined
  let stamp = ""
  return {
    effective: async () => {
      const file = projectConfigPath(projectHome)
      let stampNow = "absent"
      try {
        const stat = await fs.stat(file)
        if (stat.isDirectory()) return { state: "invalid", path: file, reason: "is a folder, not a config file; nothing was changed" }
        stampNow = `${stat.size}:${stat.mtimeMs}`
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          return { state: "invalid", path: file, reason: `could not be checked: ${messageOf(error)}` }
      }
      if (last && stamp === stampNow) return last
      const reading = await readProjectConfigDocument(projectHome)
      last = reading
      stamp = stampNow
      return reading
    },
    last: () => last
  }
}

/** The shape an environment variable name has. A reference is stored as a name, never as its value. */
export const ENV_REFERENCE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** A direct value or an env reference; anything else is reported by the caller that owns the key. */
export const parseConfigValue = (given: unknown): ConfigValue | undefined => {
  if (typeof given === "string") return given.trim().length > 0 ? { value: given.trim() } : undefined
  if (!isRecord(given)) return undefined
  const keys = Object.keys(given)
  if (keys.length !== 1) return undefined
  const key = keys[0]
  const value = given[key]
  if (typeof value !== "string" || value.trim().length === 0) return undefined
  if (key === "value") return { value: value.trim() }
  if (key === "env" && ENV_REFERENCE_NAME.test(value.trim())) return { env: value.trim() }
  return undefined
}

/**
 * Resolves one reference at execution time. The value is returned only to the caller that is about to act
 * on it; a reading, diagnostic or evidence row names the reference instead of the value.
 */
export const resolveConfigValue = (reference: ConfigValue, environment: Record<string, string | undefined>): string | undefined => {
  if ("value" in reference) return reference.value
  const value = environment[reference.env]
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

/** What a reference is, in the words a diagnostic may print: a name, never a resolved secret. */
export const describeConfigReference = (reference: ConfigValue): string =>
  "env" in reference ? `env ${reference.env}` : "a direct value, not shown here"
