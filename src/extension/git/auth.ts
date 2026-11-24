/**
 * Stage 1's credential mode resolution and the child-process environment assembly (§6 of the design).
 *
 * The project file stores variable *names*, never values: `git.auth.env` maps a documented Git name to an
 * env reference, and only the names Moriarty owns are read. A value is read from the process environment at
 * the moment a Git process is about to be created, and it goes to that process alone. Nothing here puts a
 * resolved value into a parsed config, a diagnostic, an evidence row, a log line or a tool result; `report`
 * says which names were referenced.
 *
 * Every mode keeps terminal prompts off with `GIT_TERMINAL_PROMPT=0`: nothing is ever typed at a Git
 * process, and an interactive credential prompt stays inside Git's own safe askpass facility, where the
 * model cannot see it. Credential configuration selects which credential is used; it never decides who is
 * named in a commit, because attribution comes from `identity.ts`.
 */
import { ConfigValue, resolveConfigValue } from "../todos/project-config"

export type GitAuthMode = "inherit" | "dedicated" | "environment" | "managed"

/** The documented names a credential reference may sit under. A value for one is never stored in the file. */
export const GIT_CREDENTIAL_ENV_NAMES = ["GIT_ASKPASS", "GIT_SSH_COMMAND", "GIT_HTTP_EXTRA_HEADER"] as const

/** What the project may name for credentials: names and paths, never key content or a secret value. */
export interface GitAuthConfig {
  mode: GitAuthMode
  /** An absolute or `~`-expanded key path. A path is a credential selection, not the key itself. */
  sshIdentityFile?: string
  credentialHelper?: string
  /** An authentication login name. Never a password or a token. */
  username?: string
  env: Record<string, ConfigValue>
}

/** The future managed seam (§6). It is a provider contract, not an authentication database. */
export interface GitCredentialRequest {
  repository: string
  remote: string
  operation: "fetch" | "push"
  signal?: AbortSignal
}

export interface GitCredentialContext {
  environment?: ReadonlyMap<string, string>
  gitConfig?: ReadonlyMap<string, string>
  sshIdentityFile?: string
}

export interface GitCredentialProvider {
  resolve(request: GitCredentialRequest): Promise<GitCredentialContext>
}

/** V1 resolves `managed` against a provider that no stage has installed yet; the error is its own words. */
export const MANAGED_CREDENTIAL_PROVIDER_ERROR = "managed credential provider not installed"

export type GitCredentialProblemCode = "git_auth_provider_not_installed" | "git_auth_environment_missing" | "git_auth_invalid_reference"

/** An actionable credential error. It names references, never what they hold. */
export interface GitCredentialProblem {
  code: GitCredentialProblemCode
  summary: string
  output: string
}

/** What a diagnostic may show: the mode and the names it referenced. Values are not part of this shape. */
export interface GitCredentialReport {
  mode: GitAuthMode
  terminalPrompt: "0"
  /** The variable names the project referenced, in the order the file named them. */
  references: string[]
  sshIdentityFile?: string
  credentialHelper?: string
  username?: string
}

export interface GitAuthInput {
  auth: GitAuthConfig
  /** The environment to read references from; the process environment is used when nothing is given. */
  environment?: Record<string, string | undefined>
  home?: string
  /** Only used for `managed`, and only by a stage that installs one. */
  provider?: GitCredentialProvider
  request?: GitCredentialRequest
}

/** The environment and config the Git child process is created with. Values live in this call only. */
export interface GitProcessCredentials {
  mode: GitAuthMode
  environment: Record<string, string>
  gitConfig: Record<string, string>
  sshIdentityFile: string | undefined
  /** What may be reported afterwards, with names instead of values. */
  report: GitCredentialReport
}

const recordOf = (values: ReadonlyMap<string, string> | undefined): Record<string, string> => {
  const copy: Record<string, string> = {}
  if (values) for (const [key, value] of values) copy[key] = value
  return copy
}

/** `~` is read as the user's home, like the project home setting does. A path is never created here. */
export const expandHomePath = (value: string, home = process.env.HOME ?? ""): string => {
  if (value === "~") return home
  if (!/^[~][\\/]/.test(value)) return value
  return value.replace(/^~/, home)
}

/** A name that would hold a secret is not an auth setting: the key itself is reported instead of read. */
export const looksLikeSecretName = (name: string): boolean => /(password|token|secret|passphrase|apikey|privatekey)$/i.test(name)

/**
 * Resolves one mode into the environment a Git process would be created with. A missing reference is a clear
 * configuration error naming only the variable; nothing is silently fallen back on, and no value enters the
 * report.
 */
export const resolveGitCredentials = async (input: GitAuthInput): Promise<GitProcessCredentials | GitCredentialProblem> => {
  const auth = input.auth
  const base = input.environment ?? process.env
  const report: GitCredentialReport = { mode: auth.mode, terminalPrompt: "0", references: [...GIT_CREDENTIAL_ENV_NAMES].filter((name) => auth.env[name] !== undefined) }
  if (auth.sshIdentityFile !== undefined) report.sshIdentityFile = expandHomePath(auth.sshIdentityFile, input.home ?? process.env.HOME ?? "")
  if (auth.credentialHelper !== undefined) report.credentialHelper = auth.credentialHelper
  if (auth.username !== undefined) report.username = auth.username

  const environment: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) if (typeof value === "string") environment[key] = value
  const gitConfig: Record<string, string> = {}
  // Nothing is ever typed at a Git process, whatever mode was chosen.
  environment.GIT_TERMINAL_PROMPT = "0"

  for (const name of report.references) {
    const reference = auth.env[name]
    if (reference === undefined) continue
    if (!("env" in reference)) return { code: "git_auth_invalid_reference", summary: `Credential configuration error: git.auth.env.${name} must name an environment variable`, output: `Store { "env": "NAME" } for git.auth.env.${name}; the project file holds names, not values.` }
    const value = resolveConfigValue(reference, base)
    if (value === undefined) return { code: "git_auth_environment_missing", summary: `Credential configuration error: ${reference.env} is not set`, output: `Set ${reference.env} in the environment, or change git.auth.mode. The project file names it and never stores what it holds.` }
    environment[name] = value
  }

  if (auth.mode === "dedicated") {
    // A helper name and a key path select a credential; they do not say who authored a commit.
    if (auth.credentialHelper !== undefined) gitConfig["credential.helper"] = auth.credentialHelper
    if (auth.sshIdentityFile !== undefined) environment.GIT_SSH_COMMAND = `ssh -i ${expandHomePath(auth.sshIdentityFile, input.home ?? process.env.HOME ?? "")}`
  }

  if (auth.mode === "managed") {
    // The seam is a later stage's; without an installed provider the resolver says so plainly.
    let context: GitCredentialContext
    try {
      context = await resolveManagedCredentials(input.provider, input.request)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { code: "git_auth_provider_not_installed", summary: message, output: "Change git.auth.mode to inherit, dedicated or environment until a credential provider is installed." }
    }
    for (const [key, value] of Object.entries(recordOf(context.environment))) environment[key] = value
    for (const [key, value] of Object.entries(recordOf(context.gitConfig))) gitConfig[key] = value
    if (context.sshIdentityFile !== undefined) report.sshIdentityFile = context.sshIdentityFile
    environment.GIT_TERMINAL_PROMPT = "0"
  }

  return { mode: auth.mode, environment, gitConfig, sshIdentityFile: report.sshIdentityFile, report }
}

/** The managed provider is a later stage's. Without one installed this is the clear error it names. */
export const resolveManagedCredentials = async (provider: GitCredentialProvider | undefined, request: GitCredentialRequest | undefined): Promise<GitCredentialContext> => {
  if (!provider) throw new Error(MANAGED_CREDENTIAL_PROVIDER_ERROR)
  if (!request) throw new Error("managed credential resolution needs a request naming the repository, the remote and the operation")
  return provider.resolve(request)
}

/** The line a diagnostic or a test reads: what mode is in force and which names it referenced. */
export const describeGitCredentials = (report: GitCredentialReport): string => {
  const parts = [`mode=${report.mode}`, `GIT_TERMINAL_PROMPT=${report.terminalPrompt}`]
  if (report.sshIdentityFile !== undefined) parts.push(`sshIdentityFile=${report.sshIdentityFile}`)
  if (report.credentialHelper !== undefined) parts.push(`credentialHelper=${report.credentialHelper}`)
  if (report.username !== undefined) parts.push(`username=${report.username}`)
  parts.push(report.references.length > 0 ? `references=${report.references.join(", ")}` : "references=none")
  return parts.join(", ")
}
