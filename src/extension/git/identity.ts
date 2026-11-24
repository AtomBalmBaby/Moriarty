/**
 * Stage 1's attribution identities (§3 of the design). The logical name is always `Moriarty`: not the
 * operating-system username, not the provider, not the model, not an account login. A credential decides
 * how a push authenticates; it never changes who is named here, and a model name is never an identity.
 *
 * The Moriarty email is never hardcoded. It is resolved at execution time from the merged effective
 * config, which itself came from the project file, the user-preference layer or a normal environment
 * variable. A missing or empty email is a configuration error that refuses a commit, not a default that
 * is quietly invented. A tagging-disabled commit does not need it, because Moriarty is then neither
 * author nor committer.
 *
 * Human identity is resolved in the documented order: the explicit project human config, then
 * `git config user.name` and `user.email`, then an explicit trusted host instruction. Names are trimmed
 * and de-duplicated case-insensitively; one trailer per human identity, and Moriarty is never added as a
 * co-author of a commit it already authors.
 */
import { ConfigValue, resolveConfigValue } from "../todos/project-config"

import { GitConfigLayer, GitHumanConfig, GitProjectConfig } from "./config"

/** The permanent logical identity. Nothing here replaces it with an account or a model name. */
export const MORIARTY_IDENTITY_NAME = "Moriarty"

/** The variable a normal VS Code environment can hold when the project names no reference of its own. */
export const MORIARTY_EMAIL_ENVIRONMENT_VARIABLE = "MORIARTY_GIT_EMAIL"

/** One person as Git would name them: a trimmed name and an address. */
export interface GitIdentity { name: string; email: string }

/** Where an identity came from, so a diagnostic can say which layer decided it. */
export type IdentitySource = "project config" | "user preference" | "environment variable" | "git config" | "host instruction" | "none"

export interface GitIdentityResolution {
  tagging: boolean
  /** Moriarty as author and committer only when tagging is on; nothing is claimed when it is off. */
  moriarty: GitIdentity | undefined
  human: GitIdentity | undefined
  sources: { moriartyEmail: IdentitySource; human: IdentitySource }
  /** A configured reference that could not be resolved, stated plainly instead of guessed around. */
  problems: string[]
}

/** The refusal a commit gets when no Moriarty email can be resolved while tagging is on. */
export interface GitIdentityRefusal {
  code: "git_identity_missing_email"
  executed: false
  summary: string
  output: string
}

export type GitIdentityAnswer =
  | { state: "resolved"; resolution: GitIdentityResolution }
  | { state: "refused"; refusal: GitIdentityRefusal }

export interface GitIdentityInput {
  config: GitProjectConfig
  /** Which layer decided `identity.email`, so the answer can name it. */
  origin?: GitConfigLayer
  /** `git config user.name` and `user.email` as the host reads them, used only when the file names no human. */
  gitConfig?: Record<string, string>
  /** An explicit trusted host instruction: the last word for a human identity, never a credential. */
  hostInstruction?: { name?: string; email?: string }
  environment?: Record<string, string | undefined>
}

/** A person as a name. Spaces inside it are part of the name; angle brackets would break the trailer. */
const trimName = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0 || /[<>]/.test(trimmed)) return undefined
  if ([...trimmed].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return undefined
  return trimmed
}

/** An address as a person gave it. It is attribution data, and it is never a credential. */
const trimAddress = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0 || /\s/.test(trimmed)) return undefined
  return trimmed.includes("@") ? trimmed : undefined
}

/** The variable a reference names, or nothing when it holds the value itself. */
const envName = (reference: ConfigValue): string | undefined => ("env" in reference ? reference.env : undefined)

/** Resolves the identities a commit would use, at execution time, from the layers the design names. */
export const resolveGitIdentity = (input: GitIdentityInput): GitIdentityAnswer => {
  const config = input.config
  const environment = input.environment ?? process.env
  const problems: string[] = []
  const reference = config.identity.email
  let emailSource: IdentitySource = reference === undefined ? "none" : input.origin === "user" ? "user preference" : "project config"
  let address: string | undefined
  if (reference !== undefined) {
    const resolved = resolveConfigValue(reference, environment)
    if (resolved === undefined) problems.push(`git.identity.email references ${envName(reference)}, which is not set`)
    else address = trimAddress(resolved)
  } else {
    const fromEnvironment = trimAddress(environment[MORIARTY_EMAIL_ENVIRONMENT_VARIABLE])
    if (fromEnvironment !== undefined) {
      address = fromEnvironment
      emailSource = "environment variable"
    }
  }

  const human = humanIdentity(config.identity.human, input, environment, problems)

  if (config.identity.tagging && address === undefined) {
    const named = reference === undefined ? MORIARTY_EMAIL_ENVIRONMENT_VARIABLE : envName(reference) ?? MORIARTY_EMAIL_ENVIRONMENT_VARIABLE
    return {
      state: "refused",
      refusal: {
        code: "git_identity_missing_email",
        executed: false,
        summary: "Commit refused: Moriarty Git email is missing",
        output: `Set git.identity.email in .twinny/config.json or configure ${named}.`
      }
    }
  }

  const resolution: GitIdentityResolution = {
    tagging: config.identity.tagging,
    // Tagging off means Moriarty is named nowhere in the commit, and no email is needed.
    moriarty: config.identity.tagging && address !== undefined ? { name: MORIARTY_IDENTITY_NAME, email: address } : undefined,
    human,
    sources: { moriartyEmail: address === undefined ? "none" : emailSource, human: human === undefined ? "none" : humanSource(config.identity.human, input) },
    problems
  }
  return { state: "resolved", resolution }
}

/** The documented order: project human config, then Git config, then an explicit host instruction. */
const humanIdentity = (configured: GitHumanConfig | undefined, input: GitIdentityInput, environment: Record<string, string | undefined>, problems: string[]): GitIdentity | undefined => {
  if (configured !== undefined) {
    const name = trimName(configured.name)
    const email = trimAddress(resolveConfigValue(configured.email, environment))
    if (name === undefined || email === undefined) {
      problems.push(`git.identity.human names ${JSON.stringify(configured.name)} and ${JSON.stringify(configured.email)}, which is not a person and an address`)
      return undefined
    }
    return { name, email }
  }
  const gitConfig = input.gitConfig
  if (gitConfig !== undefined) {
    const name = trimName(gitConfig["user.name"])
    const email = trimAddress(gitConfig["user.email"])
    if (name !== undefined && email !== undefined) return { name, email }
  }
  const instruction = input.hostInstruction
  if (instruction !== undefined) {
    const name = trimName(instruction.name)
    const email = trimAddress(instruction.email)
    if (name !== undefined && email !== undefined) return { name, email }
    problems.push(`the host instruction names ${JSON.stringify(instruction.name ?? "")} and ${JSON.stringify(instruction.email ?? "")}, which is not a person and an address`)
  }
  return undefined
}

const humanSource = (configured: GitHumanConfig | undefined, input: GitIdentityInput): IdentitySource => {
  if (configured !== undefined) return "project config"
  const gitConfig = input.gitConfig
  if (gitConfig !== undefined && trimName(gitConfig["user.name"]) !== undefined && trimAddress(gitConfig["user.email"]) !== undefined) return "git config"
  return input.hostInstruction !== undefined ? "host instruction" : "none"
}

/** The standard trailer, one per human identity. */
export const formatCoAuthorTrailer = (identity: GitIdentity): string => `Co-authored-by: ${identity.name} <${identity.email}>`

/**
 * One trailer per human identity, de-duplicated case-insensitively. Moriarty is never a co-author of a
 * commit it already authors, and a tagging-disabled commit carries no Moriarty trailer at all.
 */
export const coAuthorTrailers = (identities: GitIdentity[], moriartyAuthors: boolean, tagging: boolean): string[] => {
  if (!tagging) return []
  const seen = new Set<string>()
  const trailers: string[] = []
  for (const identity of identities) {
    const key = `${identity.name.toLowerCase()}|${identity.email.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    if (moriartyAuthors && identity.name.toLowerCase() === MORIARTY_IDENTITY_NAME.toLowerCase()) continue
    trailers.push(formatCoAuthorTrailer(identity))
  }
  return trailers
}

/** What a diagnostic may print: who is named and which layer said so, never a resolved credential. */
export const describeGitIdentity = (answer: GitIdentityAnswer): string => {
  if (answer.state === "refused") return `${answer.refusal.summary}: ${answer.refusal.output}`
  const resolution = answer.resolution
  const parts = [`tagging=${resolution.tagging}`, `moriarty=${resolution.moriarty === undefined ? "not used" : `${MORIARTY_IDENTITY_NAME} (email from ${resolution.sources.moriartyEmail})`}`, `human=${resolution.human === undefined ? "none" : `${resolution.human.name} (email from ${resolution.sources.human})`}`]
  if (resolution.problems.length > 0) parts.push(`reported: ${resolution.problems.join("; ")}`)
  return parts.join(", ")
}
