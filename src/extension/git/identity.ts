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
 * Stage 4 turns those identities into one commit's attribution (§9 of the design): who is named as author,
 * who as committer, and which human appears once as a co-author. What decides it is the ownership the host
 * proved for the paths in the commit scope, plus the tagging policy - never a model name, and never the fact
 * that Moriarty ran the command.
 */
import { ConfigValue, resolveConfigValue } from "../todos/project-config"

import { GitConfigLayer, GitHumanConfig, GitProjectConfig } from "./config"
import type { OwnershipClass, OwnershipConfidence } from "./ownership"

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

/** One commit's attribution, as the matrix §9 decides it. `null` means git's own configured identity is used. */
export interface CommitAttribution {
  tagging: boolean
  author: GitIdentity | null
  committer: GitIdentity | null
  coAuthors: GitIdentity[]
  /** Which layer decided each one, said so a reading can show where it came from. */
  basis: string
}

/** What the commit scope holds, as the ownership index can say about it. Host facts only, never a claim. */
export interface CommitScopeReading { path: string; ownership: OwnershipClass; confidence: OwnershipConfidence }

export interface CommitAttributionInput {
  config: GitProjectConfig
  /** Which layer decided `identity.email`, so the answer can name it. */
  origin?: GitConfigLayer
  gitConfig?: Record<string, string>
  /** An explicit trusted host instruction: the only thing that can name an author for this commit. */
  hostInstruction?: { name?: string; email?: string }
  environment?: Record<string, string | undefined>
  /** Whether the host proved this session made a change inside this scope. */
  agentWork: boolean
  scope: readonly CommitScopeReading[]
}

export type GitAttributionRefusalCode =
  "git_identity_missing_email" | "git_identity_not_configured" | "git_authorship_not_proven" | "git_mixed_ownership" | "git_hunk_selection_required"

export interface GitAttributionRefusal { code: GitAttributionRefusalCode; executed: false; summary: string; output: string }

export type GitAttributionAnswer =
  | { state: "resolved"; attribution: CommitAttribution }
  | { state: "refused"; refusal: GitAttributionRefusal }

/** The normal configured identity, as git itself would use it. Not a Moriarty name, and not a model name. */
const configuredIdentity = (gitConfig?: Record<string, string>): GitIdentity | undefined => {
  if (gitConfig === undefined) return undefined
  const name = trimName(gitConfig["user.name"])
  const email = trimAddress(gitConfig["user.email"])
  return name === undefined || email === undefined ? undefined : { name, email }
}

/**
 * Resolves the attribution one commit would carry, row by row through the matrix §9. A model name, a provider
 * or the fact that this stage executed the commit never decides an author: what can is a host-proved owner of
 * the change, the project's own human config, `git config user.name`/`user.email`, or an explicit host
 * instruction. A mixed scope is not guessed around - it needs a split or an explicit authorship.
 */
export const resolveCommitAttribution = (input: CommitAttributionInput): GitAttributionAnswer => {
  const answer = resolveGitIdentity({
    config: input.config,
    ...(input.origin === undefined ? {} : { origin: input.origin }),
    ...(input.gitConfig === undefined ? {} : { gitConfig: input.gitConfig }),
    ...(input.hostInstruction === undefined ? {} : { hostInstruction: input.hostInstruction }),
    ...(input.environment === undefined ? {} : { environment: input.environment })
  })
  if (answer.state === "refused") return { state: "refused", refusal: answer.refusal }
  const resolution = answer.resolution
  const normal = configuredIdentity(input.gitConfig)

  // §9.5: the opt-out names Moriarty nowhere and adds no trailer, so the commit is signed with the normal identity.
  if (!resolution.tagging) {
    if (normal === undefined)
      return { state: "refused", refusal: { code: "git_identity_not_configured", executed: false, summary: "Commit refused: no normal Git identity is configured", output: "With git.identity.tagging off the commit uses `git config user.name` and `user.email`; neither is set here. Nothing was committed." } }
    return {
      state: "resolved",
      attribution: { tagging: false, author: normal, committer: normal, coAuthors: [], basis: `tagging off: author and committer from git config (${normal.name})` }
    }
  }

  const moriarty = resolution.moriarty
  if (moriarty === undefined)
    return { state: "refused", refusal: { code: "git_identity_missing_email", executed: false, summary: "Commit refused: Moriarty Git email is missing", output: `Set git.identity.email in .twinny/config.json or configure ${MORIARTY_EMAIL_ENVIRONMENT_VARIABLE}.` } }

  const mixed = input.scope.filter((entry) => entry.ownership === "mixed" || entry.confidence === "uncertain")
  const explicit = input.hostInstruction !== undefined && resolution.human !== undefined
  if (mixed.length > 0 && !explicit)
    return {
      state: "refused",
      refusal: {
        code: "git_mixed_ownership",
        executed: false,
        summary: "Commit refused: ownership is mixed",
        output: `${mixed.map((entry) => entry.path).join(", ")} holds more than one owner's work (${mixed.map((entry) => `${entry.ownership}/${entry.confidence}`).join(", ")}). Select hunks or state an explicit authorship; nothing here guesses one.`
      }
    }

  // A split of verified agent hunks is still this session's own work, so Moriarty authors it.
  if (input.agentWork) {
    const human = resolution.human
    return {
      state: "resolved",
      attribution: {
        tagging: true,
        author: moriarty,
        committer: moriarty,
        coAuthors: human === undefined ? [] : [human],
        basis: `tagging on, agent work the host proved (${input.scope.map((entry) => `${entry.path}=${entry.ownership}/${entry.confidence}`).join(", ") || "nothing named"}); author and committer Moriarty from ${resolution.sources.moriartyEmail}; co-author ${human === undefined ? "none" : `${human.name} from ${resolution.sources.human}`}`
      }
    }
  }

  // §9.3: committing work this session did not make preserves the person the host can name, and never labels
  // Moriarty as author merely because it executed the commit.
  const author = explicit ? resolution.human : (resolution.human ?? normal)
  if (author === undefined)
    return {
      state: "refused",
      refusal: {
        code: "git_authorship_not_proven",
        executed: false,
        summary: "Commit refused: the author of the existing work cannot be proven",
        output: "The scope holds no change the host proved as this session's, and no human identity is named by the project config, git config or a host instruction. State an explicit authorship; nothing here invents one."
      }
    }
  return {
    state: "resolved",
    attribution: {
      tagging: true,
      author,
      committer: moriarty,
      // No co-author is added just because Moriarty executed the commit.
      coAuthors: explicit ? [author] : [],
      basis: `tagging on, existing work not this session's: author ${author.name} from ${explicit ? "host instruction" : resolution.sources.human}, committer Moriarty from ${resolution.sources.moriartyEmail}`
    }
  }
}

/** The line a diagnostic may print for one commit's attribution. */
export const describeCommitAttribution = (attribution: CommitAttribution): string =>
  `author=${attribution.author === null ? "git config" : `${attribution.author.name} <${attribution.author.email}>`}, committer=${attribution.committer === null ? "git config" : `${attribution.committer.name} <${attribution.committer.email}>`}, co-authors=${attribution.coAuthors.length === 0 ? "none" : attribution.coAuthors.map((identity) => identity.name).join(", ")}; ${attribution.basis}`
