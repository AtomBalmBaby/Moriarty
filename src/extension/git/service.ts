/**
 * Stage 3's one Git execution service (§7.1 of the design): repository resolution, read-only argument
 * execution, status and change inspection, all behind the existing `git(view)` tool. `more.ts` stays the
 * tool registrar and the compatibility adapter for legacy `args`; this module is where a typed operation
 * runs, so one place decides what a Git call may reach.
 *
 * What runs here reads only: `status --porcelain=v1 -z`, `rev-parse`, `symbolic-ref` and bounded `diff`
 * with `--numstat`. Every word goes to git as an argument, never as a shell line, nothing is typed at it,
 * and the presentation stays pinned so the same repository answers the same way on every machine. Nothing
 * stages, commits or pushes — those are Stage 4's and Stage 5's — and a call naming one is refused before
 * anything runs. The read-only safeguards are the ones the tool already had (`readOnlyGitArgs`,
 * `gitNamedPaths`, `tidyGitPath`, the hidden-file filters), gathered here so there is one copy of them, so
 * legacy reads answer exactly as they did.
 *
 * Paths keep the workspace's rules: what `.gitignore` hides, what the team's rules block, and what lies
 * outside the open folder is not shown; a path the call names outright is refused rather than quietly
 * dropped. A repository the workspace folder does not belong to is reached only through the existing access
 * preflight, and without a grant the call is refused. Credentials stay as references: a reading names the
 * mode and the variable names, never what they hold, and a read needs no credential at all — no value
 * enters an argument, an output or a recorded result.
 */
import { execFile } from "child_process"
import fs from "fs"
import path from "path"

import { GitAnswer, MAX_COMMAND_CHANGES, RepositoryLocation, repositoryOf } from "../chat/command-snapshot"
import { readState } from "../chat/reply-changes"
import { isWithin } from "../tools/access-grants"
import type { AccessPreflight } from "../tools/access-preflight"
import type { ToolArguments, ToolErrorCode } from "../tools/arguments"
import { tidyGitPath, withoutHiddenDiffs } from "../tools/helpers"
import type { WorkspaceView } from "../tools/view"

import { contentDigest, GitBaselineStore, GitChangeStatus, GitRefusal, parsePorcelain, refuse, STATUS_OF_CODE } from "./baseline"
import type { GitConfigSource, GitPlainCommitMode, GitWorkflowMode } from "./config"
import type { GitOwnershipStore, OwnershipClass, OwnershipConfidence } from "./ownership"

/** A read stays capped the way the read-only tool always capped it. */
export const MAX_GIT_OUTPUT = 10_000
/** How much of an inspected diff the model-visible result shows; the whole bounded text stays as raw output for the observation. */
const MAX_INSPECT_DIFF_CHARS = 2_000
const GIT_TIMEOUT_MS = 20_000

/** Settings a user's git configuration could turn another way, pinned so the output is the same on every machine. */
const GIT_PINNED = [
  "--no-pager",
  "-c", "color.ui=false",
  "-c", "diff.noprefix=false",
  "-c", "diff.mnemonicPrefix=false",
  "-c", "core.quotepath=false"
]

/** One git process, answered with the bytes, the text as the tool shows it, and what it exited with. */
export interface GitRunAnswer extends GitAnswer {
  output: string
  exitCode: number
}

/** The conditions this stage names. Every one is a refusal that ran nothing. */
export type GitRefusalCode =
  | "git_not_a_repository"
  | "git_path_not_visible"
  | "git_access_denied"
  | "git_argument_conflict"
  | "git_operation_not_supported"
  | "git_read_failed"
  | "git_too_many_changes"

/** Which shared tool code a Git condition reports under, so existing consumers read the same class; undefined when only the Git condition can be named. */
export const toolCodeOfGitRefusal = (code: string): ToolErrorCode | undefined => {
  if (code === "git_not_a_repository") return "missing_target"
  if (code === "git_path_not_visible" || code === "git_access_denied") return "permission_denied"
  if (code === "git_argument_conflict" || code === "git_operation_not_supported") return "invalid_argument_type"
  return undefined
}

/** The typed operations the same `git` tool answers for. Stage 3 runs the ones that read. */
export type GitOperation = "status" | "inspect" | "prepare_commit" | "commit" | "push" | "recover"

export const GIT_OPERATIONS: readonly GitOperation[] = ["status", "inspect", "prepare_commit", "commit", "push", "recover"]
/** The ones this stage runs; the rest are named and refused before anything runs. */
export const RUN_GIT_OPERATIONS: readonly GitOperation[] = ["status", "inspect"]

export const READ_ONLY_GIT_OPERATIONS: readonly GitOperation[] = ["status", "inspect", "recover"]

/** The typed fields Stage 3 adds. `args` and `operation` are mutually exclusive, so a call is one or the other. */
export interface GitToolArguments {
  args?: string
  operation?: GitOperation
  repository?: string
  paths?: string[]
}

/**
 * Whether this call only reads. Legacy `args` always does; a typed operation depends on which one it is,
 * so the dispatcher can tell a read from a mutation without changing every tool definition.
 */
export const gitCallIsReadOnly = (args: ToolArguments): boolean => {
  const operation = args.operation
  if (typeof operation !== "string" || operation.trim() === "") return true
  return READ_ONLY_GIT_OPERATIONS.includes(operation.trim() as GitOperation)
}

/** Where the call ran, and what git says about it. */
export interface GitRepositoryRef {
  top: string
  /** `null` for a repository with nothing committed yet. */
  head: string | null
  /** `null` when HEAD is detached, or when the branch has no name to give. */
  branch: string | null
}

/** What the workflow preset permits. A permission is not a reason to do anything, and it never authorises itself. */
export type GitCapability = "allowed" | "denied" | "approval-required"

export interface GitCapabilities {
  commit: GitCapability
  push: GitCapability
  /** Where the answer came from, said so a later stage's restrictions read as separate. */
  basis: string
}

/** What each preset permits (§5), read as the effective config gave it. */
export const GIT_CAPABILITIES_OF_MODE: Record<GitWorkflowMode, { commit: GitCapability; push: GitCapability }> = {
  "manual-approval": { commit: "approval-required", push: "approval-required" },
  "local-commits": { commit: "allowed", push: "denied" },
  "commit-and-push": { commit: "allowed", push: "approval-required" },
  autonomous: { commit: "allowed", push: "allowed" }
}

/** A status reading, as §7.2 shapes it. */
export interface GitStatusReading {
  kind: "git_status"
  succeeded: true
  repository: GitRepositoryRef
  /** Only when the host captured a baseline for this conversation at chat start; nothing here invents one. */
  baselineId?: string
  staged: string[]
  unstaged: string[]
  untracked: string[]
  capabilities?: GitCapabilities
  /** What the effective config says, names only. An invalid file reports itself instead of falling back. */
  config?: { mode: GitWorkflowMode; plainCommit: GitPlainCommitMode }
  auth?: { mode: string; references: string[] }
  configProblem?: string
  /** Paths the workspace's rules keep from the agent, counted so a reading says what it did not show. */
  leftOut?: number
}

/** One path as inspection answered for it. */
export interface GitInspectedChange {
  path: string
  side: "staged" | "unstaged" | "untracked" | "clean"
  status: GitChangeStatus
  ownership: OwnershipClass
  confidence: OwnershipConfidence
  added?: number
  removed?: number
  digest?: string
}

/** An inspection reading: the paths the call selected, with what the host can say about each. */
export interface GitInspectReading {
  kind: "git_inspect"
  succeeded: true
  repository: GitRepositoryRef
  baselineId?: string
  paths: string[]
  changes: GitInspectedChange[]
  stat: { files: number; additions: number; deletions: number }
  /** The part the model sees; the whole bounded text stays in the raw output recorded for the call. */
  diff?: string
  /** The whole bounded patch, kept for the observation raw output rather than shown to the model. */
  retained?: string
  clipped?: number
  /** Why an ownership class is what it is, when the index had nothing to prove. */
  ownershipNote?: string
  leftOut?: number
}

/** The observation the host has already recorded for this call, when it has one. The tool never invents an id. */
export type GitObservationLookup = (call: { name: string; args: ToolArguments }) => string | undefined

/** What the service needs from the host: the workspace it belongs to, and the stores the earlier stages built. */
export interface GitServiceOptions {
  view: WorkspaceView
  /** The existing access preflight. Without it a repository outside the workspace is refused, as it always was. */
  access?: AccessPreflight
  /** Stage 1's shared reader, so a reading reports the config it actually has. */
  configSource?: GitConfigSource
  /** Stage 2's stores, when the host has them for this project. */
  baselines?: GitBaselineStore
  ownership?: GitOwnershipStore
  /** The conversation the call belongs to, as the host knows it. Never read from a prompt or from a model argument. */
  conversationId?: string
  observations?: GitObservationLookup
}

/** The one place a Git call runs. */
export interface GitExecutionService {
  /** The repository one call may read: the workspace's own, or a named one the host granted. */
  resolveRepository(named: string | undefined, signal?: AbortSignal): Promise<RepositoryLocation | GitRefusal>
  /** Where the open folder sits inside the repository, as git names it; empty at the top. */
  prefix(top: string): Promise<string>
  hiddenHere(relative: string): boolean
  hiddenIn(relative: string, at: string): boolean
  /** Why a word before `--` that is not an option may not go to git, if it may not. */
  refuseBareArguments(args: string[], signal?: AbortSignal): Promise<string | undefined>
  /** One read-only git process: argument arrays, no shell, nothing typed at it. */
  runGit(top: string, args: string[], signal?: AbortSignal): Promise<GitRunAnswer>
  status(named: string | undefined, signal?: AbortSignal): Promise<GitStatusReading | GitRefusal>
  inspect(paths: string[], named: string | undefined, signal?: AbortSignal): Promise<GitInspectReading | GitRefusal>
}

/** `text` up to `max` characters, ending on a whole line where one is near. */
export const cutToLine = (text: string, max: number): string => {
  if (text.length <= max) return text
  const newline = text.lastIndexOf("\n", max)
  return text.slice(0, newline > max / 2 ? newline : max)
}

/** A record from `git diff --numstat -z`: `added\tremoved\tpath`, with `-` where the content is not text. */
interface NumstatEntry { path: string; added?: number; removed?: number }

const parseNumstat = (stdout: Buffer): NumstatEntry[] => {
  const entries: NumstatEntry[] = []
  for (const field of stdout.toString("utf8").split("\0")) {
    if (!field) continue
    const parts = field.split("\t")
    const named = parts.pop()
    if (!named) continue
    const entry: NumstatEntry = { path: tidyGitPath(named) }
    const added = Number(parts[0])
    const removed = Number(parts[1])
    if (Number.isFinite(added)) entry.added = added
    if (Number.isFinite(removed)) entry.removed = removed
    entries.push(entry)
  }
  return entries
}

export const createGitExecutionService = (options: GitServiceOptions): GitExecutionService => {
  const view = options.view
  const prefixes = new Map<string, Promise<string>>()

  const runGit = async (top: string, args: string[], signal?: AbortSignal): Promise<GitRunAnswer> =>
    new Promise<GitRunAnswer>((resolveAnswer) => {
      const child = execFile(
        "git",
        [...GIT_PINNED, ...args],
        {
          cwd: top,
          timeout: GIT_TIMEOUT_MS,
          maxBuffer: 20 * 1024 * 1024,
          encoding: "buffer",
          // A read needs no credential; the environment is what the tool always had, with prompts off.
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
          signal
        },
        (error, stdout, stderr) => {
          const out = String(stdout ?? "")
          const err = String(stderr ?? "")
          const code = error ? (typeof error.code === "number" ? error.code : 1) : 0
          resolveAnswer({ stdout: Buffer.from(out, "utf8"), ok: !error, exitCode: code, output: `${out}${err ? `${out ? "\n" : ""}${err}` : ""}` })
        }
      )
      child.stdin?.end()
    })

  /** Whether a path from the workspace root is ignored, as the folder it is when it is one; a path that is not there is taken either way. */
  const ignoredHere = (relative: string): boolean => {
    if (!relative) return false
    let isDirectory: boolean | undefined
    try {
      isDirectory = fs.statSync(path.join(view.root, relative)).isDirectory()
    } catch {
      isDirectory = undefined
    }
    return isDirectory === undefined
      ? view.ignored(relative) || view.ignored(relative, true)
      : view.ignored(relative, isDirectory)
  }

  /** Whether a path as the repository names it is one the tools may not show: ignored, or in a part of the repository outside the open folder. */
  const hiddenIn = (inRepo: string, at: string): boolean =>
    inRepo.startsWith(at) ? ignoredHere(inRepo.slice(at.length)) : at !== ""

  /** The same for a path given from the workspace root, where git runs. Pathspec magic is refused with the rest. */
  const hiddenHere = (relative: string): boolean =>
    relative.startsWith(":") || /^\.\.(\/|$)/.test(path.posix.normalize(relative.replace(/\\/g, "/"))) || path.isAbsolute(relative) || ignoredHere(relative)

  /** Why a path the call named outright cannot be shown, said so the call can act on it. */
  const whyHidden = (relative: string): string => {
    const cleaned = path.posix.normalize(relative.replace(/\\/g, "/"))
    if (path.isAbsolute(cleaned) || /^\.\.(\/|$)/.test(cleaned)) return `${cleaned} is outside the workspace`
    if (view.blocked(cleaned)) return `${cleaned} is kept from the agent by the team's rules`
    if (ignoredHere(cleaned)) return `${cleaned} is ignored by .gitignore`
    return `${cleaned} is not a path this workspace may show`
  }

  const prefixOf = (top: string): Promise<string> => {
    const known = prefixes.get(top)
    if (known) return known
    // Where the open folder sits inside the repository, as git answers for the folder it was started in.
    const asked = runGit(view.root, ["rev-parse", "--show-prefix"]).then(({ output, exitCode }) => (exitCode === 0 ? output.trim() : ""))
    prefixes.set(top, asked)
    return asked
  }

  /** HEAD and the branch, as git names them, without asking it to write anything. */
  const refOf = async (top: string, signal?: AbortSignal): Promise<GitRepositoryRef> => {
    const head = await runGit(top, ["rev-parse", "--verify", "--quiet", "HEAD"], signal)
    const branch = await runGit(top, ["symbolic-ref", "--quiet", "--short", "HEAD"], signal)
    return { top, head: head.ok ? head.stdout.toString("utf8").trim() : null, branch: branch.ok ? branch.stdout.toString("utf8").trim() : null }
  }

  const resolveRepository = async (named: string | undefined, signal?: AbortSignal): Promise<RepositoryLocation | GitRefusal> => {
    const wanted = named?.trim()
    if (!wanted) {
      const own = await repositoryOf(view.root)
      return own ?? refuse("git_not_a_repository", `Status refused: ${view.root} is not inside a git repository`, "Nothing was read. Outside a repository there is no status to report.")
    }
    const outside = view.outsideLexical(wanted)
    if (outside) {
      // A repository the tools were not allowed in is asked for first, exactly as an outside file is.
      if (!options.access) return refuse("git_access_denied", `Status refused: ${outside} is outside the workspace`, "The tools are allowed in the workspace folder and in folders the user granted. Nothing was read there.")
      const outcome = await options.access.authorize([{ path: outside, access: "read" }], "git", signal)
      if (!outcome.ok) return refuse("git_access_denied", `Status refused: ${outside} is outside the workspace`, outcome.message)
    }
    let target: string
    try {
      target = view.resolve(wanted, "dir")
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return refuse("git_access_denied", `Status refused: ${wanted} cannot be read`, message)
    }
    const repository = await repositoryOf(target)
    if (!repository) return refuse("git_not_a_repository", `${target} is not inside a git repository`, "Nothing was read.")
    // A repository whose top lies above a granted folder reaches further than the folder that was allowed.
    if (!isWithin(view.root, repository.top) && !view.visible(repository.top))
      return refuse("git_access_denied", `Status refused: ${repository.top} is outside what this workspace may read`, `${target} belongs to a repository whose top was not granted. Name the folder that was, or grant ${repository.top}.`)
    return repository
  }

  const refuseBareArguments = async (args: string[], signal?: AbortSignal): Promise<string | undefined> => {
    const [subcommand, ...rest] = args
    const split = rest.indexOf("--")
    for (const arg of split === -1 ? rest : rest.slice(0, split)) {
      if (arg.startsWith("-") || /^[^:]*:/.test(arg)) continue
      const tidied = tidyGitPath(arg)
      if (path.isAbsolute(arg) || /^\.\.(\/|$)/.test(tidied)) return `${arg} is outside the workspace and cannot be read.`
      if (tidied && fs.existsSync(path.join(view.root, tidied)) && ignoredHere(tidied)) {
        return `${arg} is outside the workspace or ignored by .gitignore and cannot be read.`
      }
      if (subcommand === "show" || subcommand === "diff") {
        const answer = await runGit(view.root, ["cat-file", "-t", arg], signal)
        if (answer.exitCode === 0 && answer.output.trim() === "blob") {
          return `${arg} is a file's contents by id, which git here does not show; name the file instead, e.g. show HEAD:path/to/file.`
        }
      }
    }
    return undefined
  }

  /** What the effective config says, with names only. An invalid file is reported as it stands, never fallen back on. */
  const configReading = async (): Promise<Partial<GitStatusReading>> => {
    if (!options.configSource) return { configProblem: "no effective Git configuration was read for this project" }
    const reading = await options.configSource.effective()
    if (reading.state === "invalid") return { configProblem: `${reading.path}: ${reading.reason}` }
    const config = reading.reading.config
    const mode = config.workflow.mode
    const permissions = GIT_CAPABILITIES_OF_MODE[mode]
    return {
      config: { mode, plainCommit: config.workflow.plainCommit },
      auth: { mode: config.auth.mode, references: Object.keys(config.auth.env).map((name) => name) },
      capabilities: { ...permissions, basis: `git.workflow.mode=${mode}; the preset's permission only, and this stage runs neither commit nor push` }
    }
  }

  /** The content as the host measures it, for a path this workspace may show. */
  const digestOf = async (top: string, relative: string): Promise<string | undefined> => {
    const absolute = path.join(top, ...relative.split("/"))
    if (!view.visible(absolute)) return undefined
    const state = await readState(absolute, (file) => view.text(file))
    return state === undefined || state === null ? undefined : contentDigest(state)
  }

  const status = async (named: string | undefined, signal?: AbortSignal): Promise<GitStatusReading | GitRefusal> => {
    const repository = await resolveRepository(named, signal)
    if ("code" in repository) return repository
    const at = await prefixOf(repository.top)
    const read = await runGit(repository.top, ["status", "--porcelain=v1", "-z"], signal)
    if (!read.ok) return refuse("git_read_failed", "Status refused: git could not read the repository", `git status --porcelain=v1 -z failed in ${repository.top}. Nothing was changed.`)
    const entries = parsePorcelain(read.stdout)
    if (entries.length > MAX_COMMAND_CHANGES) return refuse("git_too_many_changes", `Status refused: ${entries.length} paths changed, more than ${MAX_COMMAND_CHANGES}`, "A repository this wide is not reported here. Name the paths to look at instead.")

    const staged: string[] = []
    const unstaged: string[] = []
    const untracked: string[] = []
    let leftOut = 0
    for (const entry of entries) {
      if (hiddenIn(entry.path, at)) { leftOut++; continue }
      if (entry.code === "??") { untracked.push(entry.path); continue }
      if (entry.code.charAt(0) !== " ") staged.push(entry.path)
      if (entry.code.charAt(1) !== " ") unstaged.push(entry.path)
    }

    const reading: GitStatusReading = {
      kind: "git_status",
      succeeded: true,
      repository: await refOf(repository.top, signal),
      staged: staged.sort((a, b) => a.localeCompare(b)),
      unstaged: unstaged.sort((a, b) => a.localeCompare(b)),
      untracked: untracked.sort((a, b) => a.localeCompare(b))
    }
    const captured = options.conversationId ? options.baselines?.capturedFor(options.conversationId) : undefined
    if (captured) reading.baselineId = captured.baseline.id
    Object.assign(reading, await configReading())
    if (leftOut) reading.leftOut = leftOut
    return reading
  }

  /** One side's counts and patch for the paths named, through git's own read-only diff. */
  const sideOf = async (top: string, cached: boolean, paths: string[], signal?: AbortSignal): Promise<{ entries: NumstatEntry[]; patch: string }> => {
    if (!paths.length) return { entries: [], patch: "" }
    const guard = ["--no-ext-diff", "--no-textconv"]
    const base = ["diff", ...guard, ...(cached ? ["--cached"] : [])]
    const counts = await runGit(top, [...base, "--numstat", "-z", "--", ...paths], signal)
    if (!counts.ok) return { entries: [], patch: "" }
    const shown = await runGit(top, [...base, "--", ...paths], signal)
    if (!shown.ok) return { entries: parseNumstat(counts.stdout), patch: "" }
    return { entries: parseNumstat(counts.stdout), patch: withoutHiddenDiffs(shown.output, (file) => hiddenHere(file)).text }
  }

  const inspect = async (paths: string[], named: string | undefined, signal?: AbortSignal): Promise<GitInspectReading | GitRefusal> => {
    const repository = await resolveRepository(named, signal)
    if ("code" in repository) return repository
    const at = await prefixOf(repository.top)
    const selected: string[] = []
    for (const given of paths) {
      const relative = tidyGitPath(given)
      if (!relative) continue
      // A path the call named is refused when it may not be shown, not quietly left out of the answer.
      if (hiddenHere(relative) || hiddenIn(relative, at))
        return refuse("git_path_not_visible", `Inspection refused: ${relative} cannot be shown`, `${whyHidden(relative)} and cannot be read. Name a path this workspace may show.`)
      selected.push(relative)
    }
    const read = await runGit(repository.top, ["status", "--porcelain=v1", "-z"], signal)
    if (!read.ok) return refuse("git_read_failed", "Inspection refused: git could not read the repository", `git status --porcelain=v1 -z failed in ${repository.top}. Nothing was changed.`)
    const entries = parsePorcelain(read.stdout)
    if (entries.length > MAX_COMMAND_CHANGES) return refuse("git_too_many_changes", `Inspection refused: ${entries.length} paths changed, more than ${MAX_COMMAND_CHANGES}`, "A repository this wide is not reported here. Name the paths to look at instead.")

    const index = options.conversationId ? options.ownership?.for(options.conversationId) : undefined
    const known = index && !("code" in index) ? index : undefined
    const note = known === undefined
      ? options.conversationId === undefined
        ? "no conversation was named by the host, so no path can be owned here"
        : "no baseline was captured for this conversation, so nothing here can say who changed a path"
      : undefined

    const seen = new Map<string, string>()
    let leftOut = 0
    for (const entry of entries) {
      if (hiddenIn(entry.path, at)) { leftOut++; continue }
      if (selected.length && !selected.includes(entry.path)) continue
      seen.set(entry.path, entry.code)
    }
    for (const relative of selected) if (!seen.has(relative)) seen.set(relative, "  ")

    const pathsOf = (side: (code: string) => boolean): string[] => [...seen.keys()].filter((relative) => side(seen.get(relative)!))
    const stagedPaths = pathsOf((code) => code !== "??" && code.charAt(0) !== " ")
    const unstagedPaths = pathsOf((code) => code === "??" || code.charAt(1) !== " ")
    const staged = await sideOf(repository.top, true, stagedPaths, signal)
    const unstaged = await sideOf(repository.top, false, unstagedPaths, signal)
    const counts = new Map<string, NumstatEntry>([...staged.entries, ...unstaged.entries].map((entry) => [entry.path, entry]))

    const changes: GitInspectedChange[] = await Promise.all([...seen.keys()].sort((a, b) => a.localeCompare(b)).map(async (relative) => {
      const code = seen.get(relative)!
      const entry = counts.get(relative)
      const owned = known?.change(relative)
      const side: "staged" | "unstaged" | "untracked" | "clean" = code === "??" ? "untracked" : code.charAt(0) !== " " ? "staged" : code.charAt(1) !== " " ? "unstaged" : "clean"
      // The status is the character for the side the path is reported on, as git gave it.
      const mark = side === "untracked" ? "?" : side === "clean" ? " " : side === "staged" ? code.charAt(0) : code.charAt(1)
      const answer: GitInspectedChange = {
        path: relative,
        side,
        status: STATUS_OF_CODE[mark] ?? "unknown",
        ownership: owned?.ownership ?? "unknown",
        confidence: owned?.confidence ?? "uncertain"
      }
      if (entry?.added !== undefined) answer.added = entry.added
      if (entry?.removed !== undefined) answer.removed = entry.removed
      const digest = await digestOf(repository.top, relative)
      if (digest !== undefined) answer.digest = digest
      return answer
    }))

    const reading: GitInspectReading = {
      kind: "git_inspect",
      succeeded: true,
      repository: await refOf(repository.top, signal),
      paths: selected.sort((a, b) => a.localeCompare(b)),
      changes,
      stat: { files: changes.length, additions: changes.reduce((sum, change) => sum + (change.added ?? 0), 0), deletions: changes.reduce((sum, change) => sum + (change.removed ?? 0), 0) }
    }
    if (known !== undefined) reading.baselineId = known.sessionId
    if (note) reading.ownershipNote = note
    const patch = [staged.patch, unstaged.patch].filter(Boolean).join("")
    if (patch) {
      const shown = cutToLine(patch, MAX_INSPECT_DIFF_CHARS)
      reading.diff = shown
      if (shown.length < patch.length) {
        reading.clipped = patch.length - shown.length
        reading.retained = patch.slice(0, MAX_GIT_OUTPUT)
      }
    }
    if (leftOut) reading.leftOut = leftOut
    return reading
  }

  return { resolveRepository, prefix: prefixOf, hiddenHere, hiddenIn, refuseBareArguments, runGit, status, inspect }
}