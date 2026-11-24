/**
 * Stage 1's effective Git configuration (§4 of the design), read through the shared project config parser
 * and merged lowest to highest: built-in defaults, then the machine-scoped user preferences a caller
 * supplies, then the project's own `<projectHome>/.twinny/config.json`. Explicit task restrictions sit
 * above all three; they are host-derived policy, so nothing here reads them.
 *
 * Only the keys Moriarty owns are read: `git.workflow`, `git.destination`, `git.identity` and `git.auth`.
 * A key inside `git` that Moriarty does not own is preserved in the file and reported, never used. An
 * invalid value is reported as one actionable line saying what was read and what was expected; it never
 * silently falls back on a default, and the file is never written. The evidence section keeps its own
 * reading of the same file, so `git` still shows up there as a key that policy does not use.
 */
import { isRecord } from "../../common/guards"
import { type ConfigValue, createDocumentSource, describeConfigReference, type DocumentReading,parseConfigValue, readProjectConfigDocument } from "../todos/project-config"

import { expandHomePath, GIT_CREDENTIAL_ENV_NAMES, type GitAuthConfig, type GitAuthMode, looksLikeSecretName } from "./auth"

export type GitWorkflowMode = "manual-approval" | "local-commits" | "commit-and-push" | "autonomous"
export type GitPlainCommitMode = "commit-only" | "commit-and-push"

export const GIT_WORKFLOW_MODES: readonly string[] = ["manual-approval", "local-commits", "commit-and-push", "autonomous"]
export const GIT_PLAIN_COMMIT_MODES: readonly string[] = ["commit-only", "commit-and-push"]
export const GIT_AUTH_MODES: readonly string[] = ["inherit", "dedicated", "environment", "managed"]

/** The fields Moriarty owns inside each section; anything else in the section is reported, not read. */
export const GIT_SECTION_FIELDS: Record<string, readonly string[]> = {
  workflow: ["mode", "plainCommit"],
  destination: ["remote", "branch", "setUpstream"],
  identity: ["tagging", "email", "human"],
  auth: ["mode", "sshIdentityFile", "credentialHelper", "username", "env"]
}

/** A human identity the project names for co-authorship. An email is attribution data, not a credential. */
export interface GitHumanConfig { name: string; email: ConfigValue }

/** The keys Moriarty owns inside `git`; anything else in the section is reported as it stands. */
export const GIT_OWNED_KEYS = ["workflow", "destination", "identity", "auth"]

export interface GitProjectConfig {
  workflow: { mode: GitWorkflowMode; plainCommit: GitPlainCommitMode }
  destination: { remote: string; branch: "current" | string; setUpstream: boolean }
  identity: { tagging: boolean; email: ConfigValue | undefined; human: GitHumanConfig | undefined }
  auth: GitAuthConfig
}

/** The documented defaults, used when no layer names a key of its own. */
export const DEFAULT_GIT_PROJECT_CONFIG: GitProjectConfig = {
  workflow: { mode: "manual-approval", plainCommit: "commit-only" },
  destination: { remote: "origin", branch: "current", setUpstream: true },
  identity: { tagging: true, email: undefined, human: undefined },
  auth: { mode: "inherit", env: {} }
}

/** The machine-scoped user preferences, as the caller read them from settings. They are validated the same way. */
export interface GitUserPreferences {
  workflow?: Record<string, unknown>
  destination?: Record<string, unknown>
}

/** Which layer decided one effective key. */
export type GitConfigLayer = "default" | "user" | "project"

/** Every key the effective config answers for, in the order a diagnostic prints them. */
export const GIT_CONFIG_KEYS = ["workflow.mode", "workflow.plainCommit", "destination.remote", "destination.branch", "destination.setUpstream", "identity.tagging", "identity.email", "identity.human", "auth.mode", "auth.sshIdentityFile", "auth.credentialHelper", "auth.username", "auth.env"]

type FlatValues = Record<string, unknown>

export interface EffectiveGitConfig {
  path: string
  source: "defaults" | "config.json"
  config: GitProjectConfig
  /** Where each key came from, so a diagnostic can name the layer instead of guessing. */
  origins: Record<string, GitConfigLayer>
  /** Keys inside `git` that Moriarty does not own: preserved in the file and reported here. */
  reportedKeys: string[]
}

export type GitConfigReading =
  | { state: "effective"; reading: EffectiveGitConfig }
  | { state: "invalid"; path: string; reason: string }

const expected = (key: string, options: readonly string[], given: unknown): string =>
  `${key} must be ${options.map((option) => JSON.stringify(option)).join(" or ")}, not ${JSON.stringify(given)}`

/** A character a ref name, a remote name or a helper name cannot carry. */
const hasControlChar = (value: string): boolean => [...value].some((character) => character.charCodeAt(0) < 33 || character.charCodeAt(0) === 127)

/** A branch name Git would accept, or the documented word `current`. */
const validBranch = (value: string): boolean => {
  if (value === "current") return true
  if (value.length === 0 || hasControlChar(value)) return false
  if (/[~^:*?[]/.test(value)) return false
  if (value.includes("..") || value.includes("//")) return false
  if (value.startsWith("/") || value.endsWith("/") || value.startsWith(".") || value.endsWith(".") || value.endsWith(".lock")) return false
  return true
}

/** A remote name or URL: one word, no control characters. What it holds is never a secret here. */
const validRemote = (value: string): boolean => value.length > 0 && !hasControlChar(value)

/** An absolute path or one starting with `~`. A key path selects a credential; the key itself is never read. */
const validKeyPath = (value: string): boolean => value.length > 0 && !hasControlChar(value) && (value.startsWith("/") || value.startsWith("~"))

/** A plain name, and not something shaped like a token that someone put in the wrong field. */
const plainName = (value: string): boolean => value.length > 0 && !hasControlChar(value) && !/^[A-Za-z0-9_-]{36,}$/.test(value)

/** One field as the file gave it, or the line a user can act on. */
type FieldAnswer = { problem: string } | { value: unknown }

const readField = (key: string, given: unknown, home: string): FieldAnswer => {
  switch (key) {
    case "workflow.mode":
      return GIT_WORKFLOW_MODES.includes(given as string) ? { value: given } : { problem: expected("git.workflow.mode", GIT_WORKFLOW_MODES, given) }
    case "workflow.plainCommit":
      return GIT_PLAIN_COMMIT_MODES.includes(given as string) ? { value: given } : { problem: expected("git.workflow.plainCommit", GIT_PLAIN_COMMIT_MODES, given) }
    case "destination.remote":
      if (typeof given !== "string" || !validRemote(given.trim())) return { problem: "git.destination.remote must name a remote as a non-empty name or URL" }
      if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/@]*:[^/@]*@/.test(given.trim())) return { problem: "git.destination.remote must name a remote or a URL without credentials in it; use a credential helper or an env reference" }
      return { value: given.trim() }
    case "destination.branch":
      return typeof given === "string" && validBranch(given.trim()) ? { value: given.trim() } : { problem: `git.destination.branch must be "current" or a branch name Git would accept, not ${JSON.stringify(given)}` }
    case "destination.setUpstream":
      return typeof given === "boolean" ? { value: given } : { problem: "git.destination.setUpstream must be true or false" }
    case "identity.tagging":
      return typeof given === "boolean" ? { value: given } : { problem: "git.identity.tagging must be true or false" }
    case "identity.email": {
      const reference = parseConfigValue(given)
      return reference === undefined ? { problem: `git.identity.email must be an email or { "env": "NAME" }, not ${JSON.stringify(given)}` } : { value: reference }
    }
    case "auth.mode":
      return GIT_AUTH_MODES.includes(given as string) ? { value: given } : { problem: expected("git.auth.mode", GIT_AUTH_MODES, given) }
    case "auth.sshIdentityFile":
      return typeof given === "string" && validKeyPath(given.trim()) ? { value: expandHomePath(given.trim(), home) } : { problem: `git.auth.sshIdentityFile must be an absolute path or one starting with ~, not ${JSON.stringify(given)}` }
    case "auth.credentialHelper":
      return typeof given === "string" && plainName(given.trim()) ? { value: given.trim() } : { problem: `git.auth.credentialHelper must name a helper, not ${JSON.stringify(given)}` }
    case "auth.username":
      return typeof given === "string" && plainName(given.trim()) ? { value: given.trim() } : { problem: `git.auth.username must be a login name, never a password or token, not ${JSON.stringify(given)}` }
    case "auth.env": {
      if (!isRecord(given)) return { problem: `git.auth.env must map a documented Git name to an env reference, not ${Array.isArray(given) ? "an array" : String(given)}` }
      const references: Record<string, ConfigValue> = {}
      for (const [name, value] of Object.entries(given as Record<string, unknown>)) {
        if (!GIT_CREDENTIAL_ENV_NAMES.includes(name as typeof GIT_CREDENTIAL_ENV_NAMES[number]))
          return { problem: `git.auth.env.${name} is not a documented credential name; the file may name ${GIT_CREDENTIAL_ENV_NAMES.join(", ")}` }
        const reference = parseConfigValue(value)
        if (reference === undefined) return { problem: `git.auth.env.${name} must be { "env": "NAME" }, not ${JSON.stringify(value)}; the project file stores names, not values` }
        if (!("env" in reference)) return { problem: `git.auth.env.${name} must reference an environment variable as { "env": "NAME" }, not a value` }
        references[name] = reference
      }
      return { value: references }
    }
    default:
      return { problem: `${key} is not read by this stage` }
  }
}

/** The human block as the file gave it: a name and an email, either of which may be an env reference. */
const readHuman = (given: unknown, label: string): FieldAnswer => {
  if (!isRecord(given)) return { problem: `${label} must be an object with a name and an email, not ${Array.isArray(given) ? "an array" : String(given)}` }
  const name = given.name
  if (typeof name !== "string" || name.trim().length === 0) return { problem: `${label}.name must name the person, not ${JSON.stringify(name)}` }
  const email = parseConfigValue(given.email)
  if (email === undefined) return { problem: `${label}.email must be an email or { "env": "NAME" }, not ${JSON.stringify(given.email)}` }
  return { value: { name: name.trim(), email } }
}

/** Reads one layer into flat validated values, collecting every problem it can name in one pass. */
const collectLayer = (source: Record<string, unknown>, label: string, home: string, reported: string[]): { values: FlatValues; problems: string[] } => {
  const values: FlatValues = {}
  const problems: string[] = []
  for (const [key, section] of Object.entries(source)) {
    if (!GIT_OWNED_KEYS.includes(key)) { reported.push(`${label}.${key}`); continue }
    if (section === undefined || section === null) continue
    if (!isRecord(section)) { problems.push(`${label}.${key} must be an object, not ${Array.isArray(section) ? "an array" : String(section)}`); continue }
    for (const [field, given] of Object.entries(section as Record<string, unknown>)) {
      const keyPath = `${label}.${key}.${field}`
      if (!(GIT_SECTION_FIELDS[key] as readonly string[]).includes(field)) { reported.push(keyPath); continue }
      if (looksLikeSecretName(field)) { problems.push(`${keyPath} would name a credential value; only env variable names belong in ${label}.auth`); continue }
      const answer = key === "identity" && field === "human" ? readHuman(given, keyPath) : readField(`${key}.${field}`, given, home)
      if ("problem" in answer) problems.push(answer.problem)
      else values[`${key}.${field}`] = answer.value
    }
  }
  return { values, problems }
}

const DEFAULT_FLAT: FlatValues = {
  "workflow.mode": DEFAULT_GIT_PROJECT_CONFIG.workflow.mode,
  "workflow.plainCommit": DEFAULT_GIT_PROJECT_CONFIG.workflow.plainCommit,
  "destination.remote": DEFAULT_GIT_PROJECT_CONFIG.destination.remote,
  "destination.branch": DEFAULT_GIT_PROJECT_CONFIG.destination.branch,
  "destination.setUpstream": DEFAULT_GIT_PROJECT_CONFIG.destination.setUpstream,
  "identity.tagging": DEFAULT_GIT_PROJECT_CONFIG.identity.tagging,
  "identity.email": undefined,
  "identity.human": undefined,
  "auth.mode": DEFAULT_GIT_PROJECT_CONFIG.auth.mode,
  "auth.sshIdentityFile": undefined,
  "auth.credentialHelper": undefined,
  "auth.username": undefined,
  "auth.env": {}
}

/** Defaults, then the user layer, then the project file: the highest layer that names a key decides it. */
const mergeLayers = (project: FlatValues, user: FlatValues, reported: string[], path: string, source: "defaults" | "config.json"): EffectiveGitConfig => {
  const chosen: FlatValues = {}
  const origins: Record<string, GitConfigLayer> = {}
  for (const key of GIT_CONFIG_KEYS) {
    const origin: GitConfigLayer = project[key] !== undefined ? "project" : user[key] !== undefined ? "user" : "default"
    origins[key] = origin
    chosen[key] = project[key] ?? user[key] ?? DEFAULT_FLAT[key]
  }
  return {
    path,
    source,
    config: {
      workflow: { mode: chosen["workflow.mode"] as GitWorkflowMode, plainCommit: chosen["workflow.plainCommit"] as GitPlainCommitMode },
      destination: { remote: chosen["destination.remote"] as string, branch: chosen["destination.branch"] as string, setUpstream: chosen["destination.setUpstream"] as boolean },
      identity: { tagging: chosen["identity.tagging"] as boolean, email: chosen["identity.email"] as ConfigValue | undefined, human: chosen["identity.human"] as GitHumanConfig | undefined },
      auth: { mode: chosen["auth.mode"] as GitAuthMode, sshIdentityFile: chosen["auth.sshIdentityFile"] as string | undefined, credentialHelper: chosen["auth.credentialHelper"] as string | undefined, username: chosen["auth.username"] as string | undefined, env: chosen["auth.env"] as Record<string, ConfigValue> }
    },
    origins,
    reportedKeys: reported
  }
}

/** The reference a diagnostic may name: what it points at, never what it holds. */
const sourceOf = (reference: ConfigValue | undefined): string => (reference === undefined ? "not configured" : describeConfigReference(reference))

/** A remote as it may be shown: a URL that carries credentials is printed without them. */
export const sanitizeRemoteForDisplay = (remote: string): string => {
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(remote)) return remote
  try {
    const url = new URL(remote)
    if (!url.username && !url.password) return url.toString()
    const login = url.username ? `${url.username}${url.password ? "[credential withheld]" : ""}` : "[credential withheld]"
    return `${url.protocol}//${login}@${url.host}${url.pathname}`
  } catch {
    // A URL that will not parse is shown as the name it was given, with the credential part removed.
    return remote.replace(/\/\/[^/@]+@/, "//[credential withheld]@")
  }
}

/**
 * Reads the file and the caller's user preferences in precedence order: defaults, then the user layer,
 * then the project file. Nothing is written, and an invalid value is reported instead of being quietly
 * replaced by a default.
 */
const interpretDocument = (document: DocumentReading, userPreferences: GitUserPreferences, home: string): GitConfigReading => {
  if (document.state === "invalid") return { state: "invalid", path: document.path, reason: document.reason }
  const file = document.reading.path
  const reported: string[] = []
  const problems: string[] = []
  const projectValues: FlatValues = {}
  const section = document.reading.document.git
  if (section !== undefined && section !== null) {
    if (!isRecord(section)) return { state: "invalid", path: file, reason: `git must be an object, not ${Array.isArray(section) ? "an array" : String(section)}` }
    const read = collectLayer(section as Record<string, unknown>, "git", home, reported)
    for (const problem of read.problems) problems.push(`${problem}; the file was left as it is`)
    Object.assign(projectValues, read.values)
  }
  const userRead = collectLayer(userPreferences as Record<string, unknown>, "user preference", home, [])
  for (const problem of userRead.problems) problems.push(`${problem}; no setting was written`)
  if (problems.length > 0) return { state: "invalid", path: file, reason: problems.join("; ") }
  return { state: "effective", reading: mergeLayers(projectValues, userRead.values, reported, file, document.reading.source) }
}

/** Reads the project file as it stands. A corrupt file is reported, not worked around. */
export const readGitProjectConfig = async (projectHome: string, userPreferences: GitUserPreferences = {}, home = process.env.HOME ?? ""): Promise<GitConfigReading> =>
  interpretDocument(await readProjectConfigDocument(projectHome), userPreferences, home)

/**
 * Safe reload, on the same stamp cache as the evidence reader: the file is parsed again only when it has
 * changed on disk, so a config change takes effect at the next Git operation without a restart.
 */
export interface GitConfigSource {
  effective(): Promise<GitConfigReading>
  /** What this source last answered with, for diagnostics. */
  last(): GitConfigReading | undefined
}

export const createGitConfigSource = (projectHome: string, userPreferences: GitUserPreferences = {}, home = process.env.HOME ?? ""): GitConfigSource => {
  const documents = createDocumentSource(projectHome)
  let last: GitConfigReading | undefined
  let lastDocument: DocumentReading | undefined
  return {
    effective: async () => {
      const document = await documents.effective()
      // A file that did not change answers with the same reading, as the evidence source does.
      if (last && lastDocument === document) return last
      const reading = interpretDocument(document, userPreferences, home)
      last = reading
      lastDocument = document
      return reading
    },
    last: () => last
  }
}

/** The line a diagnostic or a test reads: what is in force, which layer decided it, and what was not read. */
export const describeGitConfig = (reading: GitConfigReading): string => {
  if (reading.state === "invalid") return `${reading.path}: ${reading.reason}`
  const effective = reading.reading
  const config = effective.config
  const references = Object.entries(config.auth.env).map(([name, reference]) => `${name}->${"env" in reference ? reference.env : "value not stored"}`).join(", ") || "none"
  const parts = [
    `${effective.path} (${effective.source})`,
    `workflow.mode=${config.workflow.mode}`,
    `workflow.plainCommit=${config.workflow.plainCommit}`,
    `destination.remote=${sanitizeRemoteForDisplay(config.destination.remote)}`,
    `destination.branch=${config.destination.branch}`,
    `destination.setUpstream=${config.destination.setUpstream}`,
    `identity.tagging=${config.identity.tagging}`,
    `identity.email=${sourceOf(config.identity.email)}`,
    `identity.human=${config.identity.human === undefined ? "not configured" : `${config.identity.human.name} (${sourceOf(config.identity.human.email)})`}`,
    `auth.mode=${config.auth.mode}`,
    `auth.env=${references}`
  ]
  const origins = GIT_CONFIG_KEYS.map((key) => `${key}=${effective.origins[key]}`).join(", ")
  return `${parts.join(", ")}; decided by: ${origins}` + (effective.reportedKeys.length > 0 ? `; keys read but not used: ${effective.reportedKeys.join(", ")}` : "")
}

