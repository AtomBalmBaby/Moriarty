/**
 * Stage 3's one Git execution service (§7.1 of the design): repository resolution, read-only argument
 * execution, status and change inspection, all behind the existing `git(view)` tool. `more.ts` stays the
 * tool registrar and the compatibility adapter for legacy `args`; this module is where a typed operation
 * runs, so one place decides what a Git call may reach.
 *
   * What runs here reads only for the operations Stage 3 owns: `status --porcelain=v1 -z`, `rev-parse`,
   * `symbolic-ref` and bounded `diff` with `--numstat`. Every word goes to git as an argument, never as a shell
   * line, nothing is typed at it, and the presentation stays pinned so the same repository answers the same
   * way on every machine. Stage 4 adds the writes: a private copy of the index, exact paths staged by name,
   * verified patches applied to that copy, an ordinary commit, and recovery that reads repository state. The
   * real index file is hashed as it sits on disk and never written by staging, `git add -A` is never run, and
   * a call naming an operation this stage does not run is refused before anything runs.
   * Stage 5 sends the commit this stage already made to the destination the effective config names, with no force option, and settles an answer that was lost by reading what the ref holds
 *
   * Paths keep the workspace's rules: what `.gitignore` hides, what the team's rules block, and what lies
   * outside the open folder is not shown; a path the call names outright is refused rather than quietly
   * dropped. A named path is read both ways - as the open folder names it and as the same path under the
   * prefix, as the repository names it - and answered for whichever reading this workspace may show, so the
   * same visible file is never refused for being named from the open folder; only what is genuinely outside,
   * ignored or kept is refused. A rename carries the pair git named it, and a `-z` numstat record counts that
   * pair for the name the path became: the name it came from is reported only when this workspace may show it.
   * preflight, and without a grant the call is refused. Credentials stay as references: a reading names the
   * mode and the variable names, never what they hold, and a read needs no credential at all - no value
   * enters an argument, an output or a recorded result.
 */
import { execFile } from "child_process"
import { createHash } from "crypto"
import fs from "fs"
import os from "os"
import path from "path"

import { SecretShield } from "../../common/secret-shield"
import { GitAnswer, MAX_COMMAND_CHANGES, RepositoryLocation, repositoryOf } from "../chat/command-snapshot"
import { readState } from "../chat/reply-changes"
import { isWithin } from "../tools/access-grants"
import type { AccessPreflight } from "../tools/access-preflight"
import type { ToolArguments, ToolErrorCode } from "../tools/arguments"
import { tidyGitPath, withoutHiddenDiffs } from "../tools/helpers"
import { AuthorizedRequest, claimGitRequests, GitCommitRequest, GitPrepareRequest, pushRequestFromCall } from "../tools/operation-authorization"
import type { WorkspaceView } from "../tools/view"

import { resolveGitCredentials } from "./auth"
import { ABSENT_INDEX_DIGEST, contentDigest, GitBaselineStore, GitChangeStatus, GitRefusal, parsePorcelain, refuse, STATUS_OF_CODE } from "./baseline"
import { DEFAULT_GIT_PROJECT_CONFIG, type EffectiveGitConfig, type GitConfigSource, type GitPlainCommitMode, type GitWorkflowMode, sanitizeRemoteForDisplay } from "./config"
import { coAuthorTrailers, CommitAttribution, CommitScopeReading, describeCommitAttribution, MORIARTY_IDENTITY_NAME, resolveCommitAttribution } from "./identity"
import type { GitOwnershipIndex, GitOwnershipStore, OwnershipClass, OwnershipConfidence } from "./ownership"
import { COMMIT_TRANSITIONS, createGitTransactionStore, GitCommitCandidate, GitCommitReading, GitOperationRecord, GitPreparedReading, GitPushReading, GitPushRecord, GitRecoveredReading, GitRunRefusal, GitTransactionState, GitTransactionStore, operationIdOf, PUSH_TRANSITIONS, pushFingerprint, PushReconciliation, ranRefusal, reconcileCommit, reconcilePush, StagedEntry } from "./transaction"


/** A read stays capped the way the read-only tool always capped it. */
export const MAX_GIT_OUTPUT = 10_000
/** How much of an inspected diff the model-visible result shows; the whole bounded text stays as raw output for the observation. */
const MAX_INSPECT_DIFF_CHARS = 2_000
const GIT_TIMEOUT_MS = 20_000
/** How long one send may run before its answer counts as lost. A lost answer is settled by reading what the ref holds, not by its exit. */
const GIT_PUSH_TIMEOUT_MS = 20_000

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
  /** Whether the process was killed before it could answer; such a call is settled from state, never from this. */
  lost?: boolean
}

/** Stage 4's conditions. Every one is a refusal that ran nothing; the ones that ran something say so with
 * `executed: true` through `GitRunRefusal`, which carries the same shape.
 */
export type GitRefusalCode =
  | "git_not_a_repository"
  | "git_path_not_visible"
  | "git_access_denied"
  | "git_argument_conflict"
  | "git_operation_not_supported"
  | "git_read_failed"
  | "git_too_many_changes"
  | "git_no_paths_selected"
  | "git_add_all_equivalent"
  | "git_commit_not_authorized"
  | "git_approval_required"
  | "git_task_restriction"
  | "git_authorship_not_proven"
  | "git_mixed_ownership"
  | "git_ownership_unknown"
  | "git_hunk_selection_required"
  | "git_hunk_patch_failed"
  | "git_hunk_patch_mismatch"
  | "git_real_index_changed"
  | "git_selected_file_changed"
  | "git_head_changed"
  | "git_branch_changed"
  | "git_alternate_tree_changed"
  | "git_commit_empty"
  | "git_commit_message_secret"
  | "git_commit_intent_claimed"
  | "git_staging_failed"
  | "git_commit_failed"
  | "git_commit_interrupted"
  | "git_commit_not_prepared"
  | "git_selected_path_clean"
  | "git_commit_no_message"
  | "git_push_not_authorized"
  | "git_force_not_allowed"
  | "git_destination_not_authorized"
  | "git_push_no_branch"
  | "git_push_no_commit"
  | "git_push_commit_changed"
  | "git_push_branch_not_on_remote"
  | "git_push_interrupted"
  | "git_auth_environment_missing"
/** Which shared tool code a Git condition reports under, so existing consumers read the same class; undefined when only the Git condition can be named.
 */
export const toolCodeOfGitRefusal = (code: string): ToolErrorCode | undefined => {
  if (code === "git_not_a_repository") return "missing_target"
  if (code === "git_path_not_visible" || code === "git_access_denied") return "permission_denied"
  if (code === "git_argument_conflict" || code === "git_operation_not_supported") return "invalid_argument_type"
  // Stage 4: an authorization the call did not carry, an approval the preset still wants, or a task
  // restriction that outranks the preset - all refusals on the permission class, and none of them runs.
  if (code === "git_commit_not_authorized" || code === "git_push_not_authorized" || code === "git_force_not_allowed" || code === "git_destination_not_authorized" || code === "git_approval_required" || code === "git_task_restriction") return "permission_denied"
  if (code === "git_no_paths_selected" || code === "git_commit_not_prepared" || code === "git_selected_path_clean" || code === "git_commit_no_message" || code === "git_push_no_branch" || code === "git_push_no_commit" || code === "git_push_commit_changed" || code === "git_auth_environment_missing") return "invalid_argument_type"
  return undefined
}

/** The typed operations the same `git` tool answers for. Stage 3 runs the ones that read; Stage 4 stages,
 * commits and recovers; Stage 5 sends to a destination and settles an answer that was lost by reading what the ref holds. */
export type GitOperation = "status" | "inspect" | "prepare_commit" | "commit" | "push" | "recover"

export const GIT_OPERATIONS: readonly GitOperation[] = ["status", "inspect", "prepare_commit", "commit", "push", "recover"]
/** The operations this stage runs; the rest are named and refused before anything runs. */
export const RUN_GIT_OPERATIONS: readonly GitOperation[] = ["status", "inspect", "prepare_commit", "commit", "push", "recover"]

export const READ_ONLY_GIT_OPERATIONS: readonly GitOperation[] = ["status", "inspect", "recover"]

/** The typed fields Stage 3 added, plus the ones Stage 4 stages and commits with. `args` and `operation` are mutually exclusive, so a call is one or the other.
 */
export interface GitToolArguments {
  args?: string
  operation?: GitOperation
  repository?: string
  paths?: string[]
  /** Exact hunks the host proved for this session. A patch is only taken for the path it was named for. */
  hunks?: { path: string; patch: string }[]
  message?: string
  operationId?: string
  /** Stage 5: the destination as the effective config names it. A call cannot choose a remote or a branch of its own. */
  remote?: string
  branch?: string
  setUpstream?: boolean
  commitSha?: string
}

/** What a Stage 4 call resolves to, with every path already named by the call itself. */
export interface GitStagingCall {
  repository?: string
  paths: readonly string[]
  hunks?: readonly { path: string; patch: string }[]
  message?: string
  operationId?: string
  /** Which way this commit names its author, as §9 reads it. A model cannot name one. */
  attributionMode?: "automatic" | "preserve-human" | "explicit"
  /** An empty commit is refused unless the call says so outright. */
  allowEmpty?: boolean
}

/** What a Stage 5 send resolves to. The destination is what the effective config named, with a host-derived restriction above it. */
export interface GitPushCall {
  repository?: string
  /** As the call named them; empty when it named none, which is what the authorization was issued for. */
  remote?: string
  branch?: string
  operationId?: string
  commitSha?: string
  setUpstream?: boolean
  /** Force is not a thing this stage can do, so a call that asks for it is refused before anything runs. */
  force?: boolean
  /** A second send only runs when the read shows nothing landed and a fast-forward is still possible. */
  retry?: boolean
}

/** What the host knows about this call: the invocation it belongs to, never what a model claimed. */
export interface GitCallInfo { invocationId?: string; executionId?: string; taskId?: string }

/** Host-derived policy for the call. A restriction is read as it was given; nothing here grants anything. */
export interface GitCallPolicy { restrictions?: { noCommit?: boolean; noPush?: boolean }; approved?: boolean; /** A whole-file choice the host stated outright for this call, not one this stage worked out. */ explicitChoice?: boolean; /** A host-derived destination, above what the project file names. */ destination?: { remote?: string; branch?: string } }

/** The authorization issued for one call's requests. Only what operation-authorization issued is accepted. */
export type GitAuthorizationSource = (requests: readonly AuthorizedRequest[]) => unknown

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
  /** For a rename, the name git says the path came from. Carried only when this workspace may show that name as well. */
  from?: string
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

/** What the service needs from the host: the workspace it belongs to, and the stores the earlier stages built.
 */
export interface GitServiceOptions {
  view: WorkspaceView
  /** The existing access preflight. Without it a repository outside the workspace is refused, as it always was. */
  access?: AccessPreflight
  /** Stage 1's shared reader, so a reading reports the config it actually has. */
  configSource?: GitConfigSource
  /** Stage 2's stores, when the host has them for this project. */
  baselines?: GitBaselineStore
  ownership?: GitOwnershipStore
  /** Stage 4's transaction store. Stage 6 makes it durable; nothing here opens a database. */
  transactions?: GitTransactionStore
  /** The conversation the call belongs to, as the host knows it. Never read from a prompt or from a model argument. */
  conversationId?: string
  observations?: GitObservationLookup
  /** The access host this call is judged on, so a claim matches the authorization that was issued for it. */
  hostKey?: string
  /** Where the private alternate index and its patch files are kept, when the host names somewhere of its own. */
  scratch?: string
  /** Host-derived policy: an explicit task restriction, and whether this call was approved. Read as given. */
  policy?: GitCallPolicy
  /** The host-issued authorization for this call's typed requests, for a call the preflight did not carry. */
  authorizations?: GitAuthorizationSource
  /** `git config user.name` and `user.email` as the host reads them, used only when the file names no human. */
  gitConfig?: Record<string, string>
  /** The project this service speaks for, so a record can name it. Nothing here opens a database. */
  projectKey?: string
  /** An explicit trusted host instruction, used only when the file names no human. Never read from a prompt. */
  hostInstruction?: { name?: string; email?: string }
  /** How long one send may run before its answer counts as lost. A lost answer is settled by reading, not by its exit. */
  pushTimeoutMs?: number
}

/** The one place a Git call runs. */
export interface GitExecutionService {
  /** The repository one call may read: the workspace's own, or a named one the host granted. */
  resolveRepository(named: string | undefined, signal?: AbortSignal): Promise<RepositoryLocation | GitRefusal>
  /** Where the open folder sits inside the repository, as git names it; empty at the top. */
  prefix(top: string): Promise<string>
  hiddenHere(relative: string): boolean
  hiddenIn(relative: string, at: string): boolean
  /** A path the call named, read both ways: as the open folder names it, and as the repository names it from its top. The reading this workspace may show is the one answered for; undefined when neither is. */
  nameOf(relative: string, at: string): string | undefined
  /** Why a word before `--` that is not an option may not go to git, if it may not. */
  refuseBareArguments(args: string[], signal?: AbortSignal): Promise<string | undefined>
  /** One git process: argument arrays, no shell, nothing typed at it. A read needs no credential and no private index; a Stage 4 run gets both as the child environment, and what a credential holds never comes back out of the process. */
  runGit(top: string, args: string[], signal?: AbortSignal, childEnv?: Record<string, string>, timeoutMs?: number): Promise<GitRunAnswer>
  status(named: string | undefined, signal?: AbortSignal): Promise<GitStatusReading | GitRefusal>
  inspect(paths: string[], named: string | undefined, signal?: AbortSignal): Promise<GitInspectReading | GitRefusal>
  /** Stages exact paths into a private copy of the index. The real index is read, never written. */
  prepareCommit(call: GitStagingCall, authorization: unknown, info?: GitCallInfo, signal?: AbortSignal): Promise<GitPreparedReading | GitRunRefusal>
  /** Runs one prepared commit, after rechecking what was prepared. */
  commit(operationId: string, authorization: unknown, info?: GitCallInfo, signal?: AbortSignal): Promise<GitCommitReading | GitRunRefusal>
  /** Stage 5: sends one commit to the destination the effective config names, with no force option, and settles a lost answer from what the ref holds. */
  push(call: GitPushCall, authorization: unknown, info?: GitCallInfo, signal?: AbortSignal): Promise<GitPushReading | GitRunRefusal>
  /** The ref a remote holds for a destination branch, as it was read. A failed read is named as a failed read. */
  remoteRef(top: string, remote: string, branch: string, signal?: AbortSignal): Promise<{ ok: boolean; sha: string | null; read: string }>
  /** Reads what an interrupted operation came to, from repository state, and never runs anything itself. */
  recover(operationId: string, info?: GitCallInfo, signal?: AbortSignal): Promise<GitRecoveredReading | GitRefusal>
  /** Ends a prepared operation without committing it, and removes its private scratch files. */
  cancelCommit(operationId: string, reason: string, info?: GitCallInfo, signal?: AbortSignal): Promise<GitRecoveredReading | GitRefusal>
}

/** `text` up to `max` characters, ending on a whole line where one is near. */
export const cutToLine = (text: string, max: number): string => {
  if (text.length <= max) return text
  const newline = text.lastIndexOf("\n", max)
  return text.slice(0, newline > max / 2 ? newline : max)
}

/** A record from `git diff --numstat -z`: `added\tremoved\tpath`, with `-` where the content is not text. For a rename or a copy git writes the counts with an empty path field and names the pair as two fields of its own - the name it came from, then the name it became - so those counts belong to the name the path became, not to an empty one. */
interface NumstatEntry { path: string; added?: number; removed?: number }

const counted = (word: string): number | undefined => {
  const number = Number(word)
  return Number.isFinite(number) ? number : undefined
}

const parseNumstat = (stdout: Buffer): NumstatEntry[] => {
  const fields = stdout.toString("utf8").split("\0")
  const entries: NumstatEntry[] = []
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]
    if (!field) continue
    const parts = field.split("\t")
    const named = parts.pop()
    if (!named) {
      // The pair follows as its own two fields, in git's order. Read them here so they are not taken as records of their own.
      const came = fields[i + 1]
      const became = fields[i + 2]
      if (!came || !became) continue
      i += 2
      const entry: NumstatEntry = { path: tidyGitPath(became) }
      const added = counted(parts[0])
      const removed = counted(parts[1])
      if (added !== undefined) entry.added = added
      if (removed !== undefined) entry.removed = removed
      entries.push(entry)
      continue
    }
    const entry: NumstatEntry = { path: tidyGitPath(named) }
    const added = counted(parts[0])
    const removed = counted(parts[1])
    if (added !== undefined) entry.added = added
    if (removed !== undefined) entry.removed = removed
    entries.push(entry)
  }
  return entries
}

/** The path a call can name that would take the whole tree at once: an `add -A` equivalent, refused before anything runs. */
const ADD_ALL_EQUIVALENTS = new Set([".", "*", "**", "./*", ""])

/** Git's own empty tree, the base an unborn repository has no commit for. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
/** The arguments one send runs with. There is no force option in this list, and upstream is only set when the project configured it. */
export const pushArgsFor = (record: GitPushRecord, gitConfig: Record<string, string> = {}, refspec?: string): string[] => {
  const configArgs = Object.entries(gitConfig).flatMap(([key, value]) => ["-c", `${key}=${value}`])
  return [...configArgs, "push", ...(record.setUpstream ? ["--set-upstream"] : []), "--", record.remote, refspec ?? `${record.commitSha}:refs/heads/${record.branch}`]
}

/** How this stage decided to take one path into the commit scope: the working copy, a verified patch, or a removal by name. */
interface StageDecision {
  path: string
  kind: "whole" | "patch" | "remove"
  source: StagedEntry["source"]
  basis: string
  /** A whole file this session cannot prove as its own work is taken only on an explicit choice the call made outright. */
  explicit?: boolean
}

/** What a commit call may be approved for, with the task restriction above the preset. A permission is not a reason to commit. */
interface CommitPermission {
  mode: GitWorkflowMode
  capability: GitCapability
  basis: string
  /** The effective config this call reads, so the layer that decided an identity can be named. */
  effective: EffectiveGitConfig
}

/** The states a record cannot move on from: a second call for one answers as a status check, never as another commit. */
export const GIT_TERMINAL_STATES: readonly GitTransactionState[] = ["succeeded", "failed", "refused", "rejected"]
export const createGitExecutionService = (options: GitServiceOptions): GitExecutionService => {
  const view = options.view
  const prefixes = new Map<string, Promise<string>>()

  const runGit = async (top: string, args: string[], signal?: AbortSignal, childEnv?: Record<string, string>, timeoutMs?: number): Promise<GitRunAnswer> =>
    new Promise<GitRunAnswer>((resolveAnswer) => {
      const child = execFile(
        "git",
        [...GIT_PINNED, ...args],
        {
          cwd: top,
          timeout: timeoutMs ?? GIT_TIMEOUT_MS,
          maxBuffer: 20 * 1024 * 1024,
          encoding: "buffer",
          // A read keeps the environment this tool always had, with prompts off. A Stage 4 run adds the private index, the identities for that one commit and the resolved credentials: a value lives in the child process only.
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...(childEnv ?? {}) },
          signal
        },
        (error, stdout, stderr) => {
          const out = String(stdout ?? "")
          const err = String(stderr ?? "")
          const code = error ? (typeof error.code === "number" ? error.code : 1) : 0
          const lost = error !== null && ((error as { killed?: boolean }).killed === true || (error as { code?: unknown }).code === "ETIMEDOUT")
          resolveAnswer({ stdout: Buffer.from(out, "utf8"), ok: !error, exitCode: code, lost, output: `${out}${err ? `${out ? "\n" : ""}${err}` : ""}` })
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

  /** A path the call named, as either reading names it. What this workspace may show is what the call can be answered for; a name that lies outside the open folder, or that the workspace's rules keep, is refused with the reason the call gave it. */
  const nameOf = (relative: string, at: string): string | undefined => {
    const given = tidyGitPath(relative)
    if (!given || given.startsWith(":") || path.isAbsolute(given) || /^\.\.(\/|$)/.test(given)) return undefined
    for (const reading of [given, at ? `${at}${given}` : given]) if (!hiddenIn(reading, at)) return reading
    return undefined
  }

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
      capabilities: { ...permissions, basis: `git.workflow.mode=${mode}; the preset's permission only, and a permission is not an approval` }
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
      // A path the call named is refused when it may not be shown, not quietly left out of the answer. It is read both ways, so the same file is answered for whether it was named from the open folder or from the repository's top.
      const inRepo = nameOf(relative, at)
      if (inRepo === undefined)
        return refuse("git_path_not_visible", `Inspection refused: ${relative} cannot be shown`, `${whyHidden(relative)} and cannot be read. Name a path this workspace may show.`)
      selected.push(inRepo)
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

    const seen = new Map<string, { code: string; from?: string }>()
    let leftOut = 0
    for (const record of entries) {
      if (hiddenIn(record.path, at)) { leftOut++; continue }
      if (selected.length && !selected.includes(record.path)) continue
      const pair = record.from === undefined ? undefined : tidyGitPath(record.from)
      const found: { code: string; from?: string } = { code: record.code, ...(pair !== undefined && pair !== record.path && !hiddenIn(pair, at) ? { from: pair } : {}) }
      seen.set(record.path, found)
      // A rename's other name is not a record of its own in porcelain: the record names the path it became. When the call named the name it came from, git's own record says what it was, so that name is answered as the pair rather than as clean.
      if (pair !== undefined && selected.includes(pair) && !hiddenIn(pair, at)) seen.set(pair, { code: record.code })
    }
    for (const relative of selected) if (!seen.has(relative)) seen.set(relative, { code: "  " })

    const pathsOf = (side: (record: { code: string; from?: string }) => boolean): string[] => [...seen.keys()].filter((relative) => side(seen.get(relative)!))
    const stagedPaths = pathsOf((record) => record.code !== "??" && record.code.charAt(0) !== " ")
    const unstagedPaths = pathsOf((record) => record.code === "??" || record.code.charAt(1) !== " ")
    const staged = await sideOf(repository.top, true, stagedPaths, signal)
    const unstaged = await sideOf(repository.top, false, unstagedPaths, signal)
    const counts = new Map<string, NumstatEntry>([...staged.entries, ...unstaged.entries].map((entry) => [entry.path, entry]))

    const changes: GitInspectedChange[] = await Promise.all([...seen.keys()].sort((a, b) => a.localeCompare(b)).map(async (relative) => {
      const record = seen.get(relative)!
      const countedFor = counts.get(relative)
      const owned = known?.change(relative)
      const side: "staged" | "unstaged" | "untracked" | "clean" = record.code === "??" ? "untracked" : record.code.charAt(0) !== " " ? "staged" : record.code.charAt(1) !== " " ? "unstaged" : "clean"
      // The status is the character for the side the path is reported on, as git gave it; for a pair, the character that detected it.
      const mark = record.code === "??" ? "?" : side === "clean" ? " " : side === "staged" ? record.code.charAt(0) : record.code.charAt(1)
      const answer: GitInspectedChange = {
        path: relative,
        side,
        status: STATUS_OF_CODE[mark] ?? "unknown",
        ownership: owned?.ownership ?? "unknown",
        confidence: owned?.confidence ?? "uncertain"
      }
      // The name the pair came from is carried only when this workspace may show it; a name the workspace's rules keep is never put into the reading.
      if (record.from !== undefined) answer.from = record.from
      if (countedFor?.added !== undefined) answer.added = countedFor.added
      if (countedFor?.removed !== undefined) answer.removed = countedFor.removed
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

  /** The store prepared operations go to. Stage 6 makes the same shape durable; nothing here opens a database. */
  const transactions = options.transactions ?? createGitTransactionStore(options.projectKey ?? "")

  /** One Git operation at a time for one repository (§11.1). Unrelated projects are not blocked by it. */
  const queues = new Map<string, Promise<unknown>>()
  const serializeGit = async <T>(top: string, work: () => Promise<T>): Promise<T> => {
    const previous = queues.get(top) ?? Promise.resolve()
    const next = previous.then(work)
    queues.set(top, next)
    try {
      return await next
    } finally {
      if (queues.get(top) === next) queues.delete(top)
    }
  }

  /** Where one operation's private index copy and its patch files live. */
  const scratchRoot = (): string => {
    const wanted = options.scratch ?? path.join(os.tmpdir(), "twinny-git-scratch")
    fs.mkdirSync(wanted, { recursive: true })
    return wanted
  }

  /** sha256 over the bytes of git's own index file as it stands on disk - the same value the baseline records. */
  const indexDigestOf = async (gitDir: string): Promise<string> => {
    try {
      return createHash("sha256").update(await fs.promises.readFile(path.join(gitDir, "index"))).digest("hex")
    } catch {
      // A repository with no index file yet is a state, not a failure.
      return ABSENT_INDEX_DIGEST
    }
  }

  /** One entry as `ls-files -s -z` names it: mode, blob, stage and path, stage 0 only. */
  interface IndexEntry { path: string; mode: string; blob: string }

  const entriesOfIndex = async (top: string, indexFile: string | undefined, signal?: AbortSignal): Promise<IndexEntry[]> => {
    const listed = await runGit(top, ["ls-files", "-s", "-z"], signal, indexFile === undefined ? undefined : { GIT_INDEX_FILE: indexFile })
    if (!listed.ok) return []
    const entries: IndexEntry[] = []
    for (const field of listed.stdout.toString("utf8").split("\0")) {
      if (!field) continue
      const head = field.split("\t")[0]
      const named = field.slice(head.length + 1)
      const parts = head.split(" ")
      if (!named || parts.length !== 3 || parts[2] !== "0") continue
      entries.push({ path: tidyGitPath(named), mode: parts[0], blob: parts[1] })
    }
    return entries
  }

  /** The scope as a digest of what each path becomes in the private index, so a later reading can compare it. */
  const digestOfScope = (entries: readonly StagedEntry[]): string =>
    createHash("sha256").update([...entries].sort((a, b) => a.path.localeCompare(b.path)).map((entry) => `${entry.path}\t${entry.mode}\t${entry.blob}`).join("\n")).digest("hex")

  /** The lines a patch adds: the only thing this stage takes from a hunk, and what the host's digest measured. */
  const addedLinesOf = (patch: string): string[] => patch.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).map((line) => line.slice(1))

  /** Every path a patch names, so a hunk is only taken for the path the call named it for. */
  const pathsInPatch = (patch: string): string[] => {
    const named = new Set<string>()
    for (const line of patch.split("\n")) {
      const match = /^(?:---|\+\+)\s+(\S+)/.exec(line)
      if (match === null) continue
      named.add(tidyGitPath(match[1].replace(/^[ab]\//, "")))
    }
    return [...named]
  }
  /** What a tree holds, path by path, so an entry that only carries what HEAD already had is not read as new work. */
  const blobsOfTree = async (top: string, tree: string, signal?: AbortSignal): Promise<Map<string, string>> => {
    const read = await runGit(top, ["ls-tree", "-r", tree], signal)
    const blobs = new Map<string, string>()
    if (!read.ok) return blobs
    for (const line of read.stdout.toString("utf8").split("\n")) {
      if (!line) continue
      const [meta, name] = line.split("\t")
      const parts = meta.split(" ")
      if (parts.length !== 3 || !name) continue
      blobs.set(tidyGitPath(name), parts[2])
    }
    return blobs
  }

  /** What a commit can be approved for: the task restriction above the preset, and a permission that is not a reason to commit. */
  const commitPermission = async (): Promise<CommitPermission | GitRefusal> => {
    if (!options.configSource) {
      const mode = DEFAULT_GIT_PROJECT_CONFIG.workflow.mode
      return { mode, capability: GIT_CAPABILITIES_OF_MODE[mode].commit, basis: "no project file was read for this project, so the documented defaults apply", effective: { path: "(defaults)", source: "defaults", config: DEFAULT_GIT_PROJECT_CONFIG, reportedKeys: [], origins: {} } }
    }
    const reading = await options.configSource.effective()
    if (reading.state === "invalid") return refuse("git_read_failed", `Commit refused: ${reading.path}: ${reading.reason}`, "An invalid file reports itself and is left as it is; nothing was staged and no commit was made.")
    const mode = reading.reading.config.workflow.mode
    const capability = GIT_CAPABILITIES_OF_MODE[mode].commit
    return { mode, capability, basis: `git.workflow.mode=${mode} permits commit as ${capability}; the preset's permission is not an authorisation`, effective: reading.reading }
  }

  /** The message a commit carries: what the call said, and one co-author trailer per person the host can name. */
  const messageWithTrailers = (message: string, trailers: string[]): string =>
    trailers.length === 0 ? message : `${message.replace(/\s+$/, "")}\n\n${trailers.join("\n")}`

  /** The environment an identity is written with; git's own config is used when nothing was decided for this commit. */
  const identityEnv = (attribution: CommitAttribution): Record<string, string> => {
    const env: Record<string, string> = {}
    if (attribution.author !== null) { env.GIT_AUTHOR_NAME = attribution.author.name; env.GIT_AUTHOR_EMAIL = attribution.author.email }
    if (attribution.committer !== null) { env.GIT_COMMITTER_NAME = attribution.committer.name; env.GIT_COMMITTER_EMAIL = attribution.committer.email }
    return env
  }
  /** The environment a Stage 4 run writes with: what this project names for credentials, plus the identities this commit decided. What a reference holds never comes back in a reading. */
  const runEnvFor = async (attribution?: CommitAttribution): Promise<Record<string, string>> => {
    let environment: Record<string, string> = {}
    if (options.configSource) {
      const reading = await options.configSource.effective()
      if (reading.state !== "invalid") {
        const credentials = await resolveGitCredentials({ auth: reading.reading.config.auth })
        if (!("code" in credentials)) environment = { ...credentials.environment }
      }
    }
    return { ...environment, ...(attribution === undefined ? {} : identityEnv(attribution)) }
  }


  /** The commits recovery reads, in git's own order. Nothing here is decided from an exit code alone. */
  const logCandidates = async (top: string, signal?: AbortSignal): Promise<GitCommitCandidate[]> => {
    const read = await runGit(top, ["log", "-n", "20", "--format=%H%x00%P%x00%T%x00%B%x01"], signal)
    if (!read.ok) return []
    return read.stdout.toString("utf8").split("\u0001").filter((record) => record !== "").map((record) => {
      const [sha, parents, tree, message] = record.split("\u0000")
      const named = (parents ?? "").trim()
      return { sha: (sha ?? "").trim(), parents: named === "" ? [] : named.split(/\s+/), tree: (tree ?? "").trim(), message: message ?? "" }
    })
  }

  /** Whether the message says something the project's rules treat as secret. What it holds is never kept. */
  const messageIsSecret = (message: string, values: string[]): boolean => {
    if (values.some((value) => value !== "" && message.includes(value))) return true
    const shield = new SecretShield()
    shield.redact(message)
    return shield.report().length > 0
  }

  /** Stage exact paths into a private copy of the real index, and record what was prepared before any commit dispatch. */
  const prepareCommit = async (call: GitStagingCall, authorization: unknown, info?: GitCallInfo, signal?: AbortSignal): Promise<GitPreparedReading | GitRunRefusal> => {
    if (call.paths.length === 0)
      return refuse("git_no_paths_selected", "Staging refused: no path was named", "Name the exact paths this commit should record. A call that names nothing stages nothing, and this stage never takes the whole tree.")

    const permission = await commitPermission()
    if ("code" in permission) return permission
    if (options.policy?.restrictions?.noCommit)
      return refuse("git_task_restriction", "Staging refused: this task does not allow a commit", "The task's restriction is above the workflow preset. Nothing was staged and no operation was recorded.")

    const repository = await resolveRepository(call.repository, signal)
    if ("code" in repository) return repository
    const at = await prefixOf(repository.top)

    const named: string[] = []
    for (const given of call.paths) {
      const relative = tidyGitPath(given)
      if (!relative || ADD_ALL_EQUIVALENTS.has(relative))
        return refuse("git_add_all_equivalent", `Staging refused: ${given} names the whole tree`, "This stage stages the paths a call names, one at a time; it never runs an add -A equivalent.")
      const shown = nameOf(relative, at)
      if (shown === undefined)
        return refuse("git_path_not_visible", `Staging refused: ${relative} cannot be shown`, `${whyHidden(relative)} and cannot be staged. Name a path this workspace may show.`)
      named.push(shown)
    }

    const patches = (call.hunks ?? []).map((hunk) => ({ path: tidyGitPath(hunk.path), patch: hunk.patch }))
    for (const hunk of patches) {
      if (!named.includes(hunk.path))
        return refuse("git_hunk_patch_mismatch", `Staging refused: a patch names ${hunk.path}`, `A hunk is only taken for a path the call named to stage (${named.join(", ")}).`)
      const inside = pathsInPatch(hunk.patch)
      if (inside.some((path) => path !== hunk.path))
        return refuse("git_hunk_patch_mismatch", `Staging refused: the patch for ${hunk.path} names ${inside.join(", ")}`, "A patch is only taken for the single path the call named it for.")
    }

    // The typed request the preflight issued for this exact call. A grant taken for a status read, or for
    // another call, does not carry staging.
    const approvedFor = path.resolve(view.root, call.repository ?? "")
    const request: GitPrepareRequest = { kind: "prepare_commit", absolute: approvedFor, paths: call.paths.map(tidyGitPath).filter((path) => path !== "") }
    if (approvedFor !== repository.top)
      return refuse("git_commit_not_authorized", `Staging refused: the approval covers ${approvedFor}, not the repository this call runs on`, `The operation reads the real index at ${repository.top}. Name that repository, or grant its top; nothing was staged.`)
    if (!claimGitRequests(authorization, [request], options.hostKey ?? ""))
      return refuse("git_commit_not_authorized", "Staging refused: no authorisation covers this call", `The approval must name ${approvedFor} with exactly the paths the call named. A grant taken for a status read, or for another call, does not carry staging. Nothing was staged.`)

    return serializeGit(repository.top, () => stageSelected(repository, named, patches, call, permission, info, signal))
  }

  /** The decisions first: a path is only taken as this session's work when the host proved it, and a mixed or unknown file needs a split or an explicit choice. */
  const stageSelected = async (repository: RepositoryLocation, named: string[], patches: { path: string; patch: string }[], call: GitStagingCall, permission: CommitPermission, info?: GitCallInfo, signal?: AbortSignal): Promise<GitPreparedReading | GitRunRefusal> => {
    const read = options.conversationId ? options.ownership?.for(options.conversationId) : undefined
    const index: GitOwnershipIndex | undefined = read === undefined || "code" in read ? undefined : read
    const status = await runGit(repository.top, ["status", "--porcelain=v1", "-z"], signal)
    if (!status.ok) return refuse("git_read_failed", "Staging refused: git could not read the repository", `git status --porcelain=v1 -z failed in ${repository.top}. Nothing was staged.`)
    const changed = new Map<string, { code: string; from?: string }>()
    for (const record of parsePorcelain(status.stdout)) changed.set(tidyGitPath(record.path), record)

    const decisions: StageDecision[] = []
    const clean: string[] = []
    for (const relative of named) {
      // A patch is taken from the evidence the call named, whether or not the working tree still shows the change.
      const patch = patches.find((hunk) => hunk.path === relative)
      if (patch !== undefined) {
        if (index === undefined) return refuse("git_ownership_unknown", `Staging refused: no host fact for ${relative}`, "A hunk is only taken where the host's own evidence proves this session made the change.")
        const split = index.splitFor(relative)
        if (!("allowed" in split)) return split
        const added = contentDigest(`${addedLinesOf(patch.patch).join("\n")}\n`)
        for (const hunk of split.hunks)
          if (hunk.digest !== undefined && hunk.digest !== added)
            return refuse("git_hunk_patch_mismatch", `Staging refused: the patch for ${relative} does not add what the host proved`, `The host measured ${hunk.digest.slice(0, 12)}… and this patch adds ${added.slice(0, 12)}…. Nothing was staged.`)
        decisions.push({ path: relative, kind: "patch", source: "patch", basis: `verified hunk patch (${split.hunks.length} hunk${split.hunks.length === 1 ? "" : "s"}); the host proved ${relative} as ${index.change(relative)?.ownership}/${index.change(relative)?.confidence}` })
        continue
      }
      const record = changed.get(relative)
      if (record === undefined) { clean.push(relative); continue }
      const claim = index === undefined ? refuse("git_ownership_unknown", `Staging refused: no host fact for ${relative}`, "Nothing here can say who owns this change; a whole file is only taken when the host proved it as this session's work.") : index.claimFor(relative)
      if (!("allowed" in claim)) {
        if (options.policy?.explicitChoice) {
          decisions.push({ path: relative, kind: "whole", source: "working", basis: `explicit whole-file choice the host stated for this call; ${relative} is ${claim.code === "git_mixed_ownership" ? "mixed" : "not proven as this session's work"}`, explicit: true })
          continue
        }
        return claim
      }
      const present = fs.existsSync(path.join(repository.top, ...relative.split("/")))
      decisions.push({ path: relative, kind: present ? "whole" : "remove", source: "working", basis: `the host proved ${relative} as ${claim.change.ownership}/${claim.change.confidence}${present ? "" : ", recorded as its removal"}` })
      // A rename is a pair: the name it became is taken, and the name it was is recorded as removed only where the host proved both sides.
      if (record.from !== undefined) {
        const source = tidyGitPath(record.from)
        const pairClaim = index === undefined ? refuse("git_ownership_unknown", `Staging refused: no host fact for ${source}`, "A rename pair is only recorded where the host proved both sides of it.") : index.claimFor(source)
        if (!("allowed" in pairClaim)) return pairClaim
        decisions.push({ path: source, kind: "remove", source: "working", basis: `the rename pair the host proved: ${source} -> ${relative}` })
      }
    }
    // A scope that prepared nothing is an empty commit: refused unless the call said so outright.
    if (decisions.length === 0 && !call.allowEmpty)
      return refuse("git_commit_empty", "Staging refused: this call prepared no scope", `${clean.join(", ")} hold nothing this session changed, so there is no commit to make. A call that says so outright may prepare an empty scope.`)
    if (clean.length > 0 && !call.allowEmpty)
      return refuse("git_selected_path_clean", `Staging refused: ${clean.join(", ")} hold no change`, "Nothing about them changed, so there is nothing to stage. Name a path that holds this session's work.")

    // The private copy. Nothing here writes the real index file.
    const operationId = operationIdOf(call.operationId)
    const root = scratchRoot()
    const indexFile = path.join(root, `index-${operationId}`)
    const preparedRealIndex = await indexDigestOf(repository.gitDir)
    try {
      fs.copyFileSync(path.join(repository.gitDir, "index"), indexFile)
    } catch {
      // A repository with no index file yet starts the copy empty; that is a state, not a failure.
    }

    const runEnv = await runEnvFor()
    for (const decision of decisions) {
      if (signal?.aborted) return ranRefusal("git_commit_interrupted", "Staging stopped: this call was interrupted", `The private copy at ${indexFile} is left as it stands and nothing was committed. Read the state before anything else is claimed.`)
      const env = { GIT_INDEX_FILE: indexFile, ...runEnv }
      if (decision.kind === "patch") {
        const patch = patches.find((hunk) => hunk.path === decision.path)!
        const patchFile = path.join(root, `patch-${operationId}-${decision.path.replace(/[^A-Za-z0-9._-]/g, "_")}`)
        fs.writeFileSync(patchFile, patch.patch)
        const checks = await runGit(repository.top, ["apply", "--cached", "--check", "--", patchFile], signal, env)
        if (!checks.ok) {
          fs.unlinkSync(patchFile)
          return ranRefusal("git_hunk_patch_failed", `Staging refused: the hunk for ${decision.path} does not apply`, `git apply --cached --check failed in ${repository.top}: the patch is not what the prepared copy holds. The real index was never touched.`)
        }
        const applied = await runGit(repository.top, ["apply", "--cached", "--", patchFile], signal, env)
        // The patch file is used once and removed (§8.3, task 14).
        fs.unlinkSync(patchFile)
        if (!applied.ok) return ranRefusal("git_hunk_patch_failed", `Staging refused: the hunk for ${decision.path} could not be recorded`, `git apply --cached failed in ${repository.top}. The real index was never touched.`)
        continue
      }
      const args = decision.kind === "remove" ? ["update-index", "--force-remove", "--", decision.path] : ["add", "--", decision.path]
      const staged = await runGit(repository.top, args, signal, env)
      if (!staged.ok) return ranRefusal("git_staging_failed", `Staging refused: ${decision.path} could not be recorded`, `git ${args[0]} failed in ${repository.top}. The real index was never touched.`)
    }

    const before = await entriesOfIndex(repository.top, undefined, signal)
    const after = await entriesOfIndex(repository.top, indexFile, signal)
    const heldByPath = new Map(before.map((entry) => [entry.path, entry]))
    const chosen = new Map(decisions.map((decision) => [decision.path, decision]))
    const entries: StagedEntry[] = []
    for (const entry of after) {
      const decision = chosen.get(entry.path)
      const held = heldByPath.get(entry.path)
      if (decision === undefined || (held !== undefined && held.blob === entry.blob)) {
        entries.push({ path: entry.path, mode: entry.mode, blob: entry.blob, source: "index", basis: "carried from the real index exactly as it stood when this call prepared" })
        continue
      }
      const digest = await digestOf(repository.top, entry.path)
      entries.push({ path: entry.path, mode: entry.mode, blob: entry.blob, source: decision.source, basis: decision.basis, ...(digest === undefined ? {} : { digest }) })
    }
    for (const decision of decisions.filter((item) => item.kind === "remove"))
      entries.push({ path: decision.path, mode: "0", blob: "", source: decision.source, basis: `${decision.basis}; the prepared copy no longer holds it` })

    const written = await runGit(repository.top, ["write-tree"], signal, { GIT_INDEX_FILE: indexFile })
    if (!written.ok) return ranRefusal("git_staging_failed", "Staging refused: the private copy could not be written", `git write-tree failed in ${repository.top}. The real index was never touched.`)
    const tree = written.stdout.toString("utf8").trim()
    const headRead = await runGit(repository.top, ["rev-parse", "--verify", "--quiet", "HEAD"], signal)
    const head = headRead.ok ? headRead.stdout.toString("utf8").trim() : null
    const parentTree = head === null ? EMPTY_TREE : (await runGit(repository.top, ["rev-parse", `${head}^{tree}`], signal)).stdout.toString("utf8").trim()
    if (tree === parentTree && !call.allowEmpty) {
      fs.unlinkSync(indexFile)
      return ranRefusal("git_commit_empty", "Staging refused: this scope would make an empty commit", `The prepared tree ${tree} is what HEAD already holds, and the call did not say outright that an empty commit is allowed. Nothing was recorded.`)
    }

    const message = (call.message ?? "").trim()
    if (message === "") {
      fs.unlinkSync(indexFile)
      return refuse("git_commit_no_message", "Staging refused: the call named no message", "A commit needs the message the call gives; nothing here invents one.")
    }
    if (messageIsSecret(message, Object.values(runEnv))) {
      fs.unlinkSync(indexFile)
      return refuse("git_commit_message_secret", "Staging refused: the message holds something secret", "What it holds is not kept here, and no commit was recorded. Say what the change does, not what it protects.")
    }

    // An entry that carries exactly what HEAD already had is not this commit's work; only what changed is read as such.
    const headBlobs = await blobsOfTree(repository.top, head ?? EMPTY_TREE, signal)
    const scope: CommitScopeReading[] = entries.filter((entry) => entry.blob !== headBlobs.get(entry.path)).map((entry) => {
      const fact = index?.change(entry.path)
      return { path: entry.path, ownership: fact?.ownership ?? "unknown", confidence: fact?.confidence ?? "uncertain" }
    })
    const agentWork = decisions.some((decision) => decision.source === "patch" || !decision.explicit)
    const answer = resolveCommitAttribution({
      config: permission.effective.config,
      origin: permission.effective.origins["identity.email"],
      ...(options.gitConfig === undefined ? {} : { gitConfig: options.gitConfig }),
      ...(options.hostInstruction === undefined ? {} : { hostInstruction: options.hostInstruction }),
      agentWork,
      scope
    })
    if (answer.state === "refused") {
      fs.unlinkSync(indexFile)
      return answer.refusal
    }

    const branchRead = await runGit(repository.top, ["symbolic-ref", "--quiet", "--short", "HEAD"], signal)
    const capture = options.conversationId === undefined ? undefined : options.baselines?.capturedFor(options.conversationId)
    const record = transactions.prepare({
      id: operationId,
      invocationId: info?.invocationId ?? "",
      kind: "commit",
      projectKey: options.projectKey ?? transactions.projectKey(),
      repositoryTop: repository.top,
      ...(options.conversationId === undefined ? {} : { conversationId: options.conversationId }),
      ...(info?.taskId === undefined ? {} : { taskId: info.taskId }),
      ...(info?.executionId === undefined ? {} : { executionId: info.executionId }),
      ...(options.hostKey === undefined ? {} : { hostKey: options.hostKey }),
      ...(capture?.model === undefined ? {} : { model: capture.model }),
      headBefore: head,
      branchBefore: branchRead.ok ? branchRead.stdout.toString("utf8").trim() : null,
      realIndexDigest: preparedRealIndex,
      entries,
      selectedDiffSha256: digestOfScope(entries.filter((entry) => entry.source !== "index")),
      alternateTree: tree,
      scratchIndex: indexFile,
      message,
      attribution: answer.attribution
    })

    const preserved = await indexDigestOf(repository.gitDir)
    return {
      kind: "git_commit_prepared",
      succeeded: true,
      operationId: record.id,
      ...(record.invocationId === "" ? {} : { invocationId: record.invocationId }),
      head,
      selectedFiles: named.sort((a, b) => a.localeCompare(b)),
      selectedDiffSha256: record.selectedDiffSha256,
      empty: tree === parentTree,
      realIndexPreserved: preserved === preparedRealIndex,
      requiresCommitApproval: permission.capability === "approval-required",
      entries: entries.map((entry) => ({ path: entry.path, source: entry.source, basis: entry.basis })),
      basis: `${permission.basis}; prepared in the private copy ${indexFile}`
    }
  }

  /** The names a commit made, as its own record gives them. */
  const namesOfCommit = async (top: string, sha: string, signal?: AbortSignal): Promise<string[]> => {
    const read = await runGit(top, ["diff-tree", "-r", "--no-commit-id", "--name-status", "-z", sha], signal)
    if (!read.ok) return []
    const fields = read.stdout.toString("utf8").split("\0").filter((field) => field !== "")
    const names: string[] = []
    for (let i = 0; i < fields.length; i++) {
      const parts = fields[i].split("\t")
      if (!/^[ACDMRTUV]/.test(parts[0])) continue
      if (/^[RC]/.test(parts[0])) { names.push(tidyGitPath(parts[2] ?? parts[1] ?? "")); i++; continue }
      names.push(tidyGitPath(parts[1] ?? ""))
    }
    return names.sort((a, b) => a.localeCompare(b))
  }

  /** What recovery proved, whichever side of the reconciliation it came from. */
  const proofOf = (outcome: { provedBy?: string; reason?: string }): string => outcome.provedBy ?? outcome.reason ?? ""
  /** The ref a remote holds for a destination branch, as it was read. A failed read is named as a failed read, never as a result. */
  const remoteRef = async (top: string, remote: string, branch: string, signal?: AbortSignal): Promise<{ ok: boolean; sha: string | null; read: string }> => {
    const read = await runGit(top, ["ls-remote", "--", remote, `refs/heads/${branch}`], signal, undefined, options.pushTimeoutMs ?? GIT_PUSH_TIMEOUT_MS)
    if (!read.ok) return { ok: false, sha: null, read: `git ls-remote ${sanitizeRemoteForDisplay(remote)} failed in ${top} (exit ${read.exitCode})` }
    const shown = redactForDisplay(read.output.split("\n").map((line) => line.trim()).filter((line) => line !== "")[0] ?? "", [])
    const sha = (shown.split(/\s+/)[0] ?? "").trim()
    return { ok: true, sha: sha === "" ? null : sha, read: `the ref ${branch} on ${sanitizeRemoteForDisplay(remote)} reads as ${sha === "" ? "nothing there" : sha}` }
  }

  /** Whether the ref a remote holds contains this commit. Only what can be read from here can be checked; anything else stays unproven. */
  const remoteHoldsCommit = async (top: string, commitSha: string, remoteSha: string | null, signal?: AbortSignal): Promise<boolean | undefined> => {
    if (remoteSha === null) return undefined
    const known = await runGit(top, ["cat-file", "-e", remoteSha], signal)
    if (!known.ok) return undefined
    return (await runGit(top, ["merge-base", "--is-ancestor", commitSha, remoteSha], signal)).ok
  }

  /** Whether this commit could still fast-forward onto what the remote holds. Nothing here rewrites history to make that true. */
  const canFastForward = async (top: string, remoteSha: string | null, commitSha: string, signal?: AbortSignal): Promise<boolean> => {
    if (remoteSha === null) return false
    const known = await runGit(top, ["cat-file", "-e", remoteSha], signal)
    if (!known.ok) return false
    return (await runGit(top, ["merge-base", "--is-ancestor", remoteSha, commitSha], signal)).ok
  }

  /** A send answer as it may be shown: no credential value, and a URL printed without one. */
  const redactForDisplay = (text: string, values: readonly string[]): string => {
    const shield = new SecretShield()
    let kept = text
    for (const value of values) if (value !== "") kept = kept.split(value).join("[credential withheld]")
    return shield.redact(kept)
  }

  /** What a send may be approved for: the same preset read for push, with the task restriction above it. */
  const pushPermission = async (): Promise<CommitPermission | GitRefusal> => {
    if (!options.configSource) {
      const mode = DEFAULT_GIT_PROJECT_CONFIG.workflow.mode
      return { mode, capability: GIT_CAPABILITIES_OF_MODE[mode].push, basis: "no project file was read for this project, so the documented defaults apply", effective: { path: "(defaults)", source: "defaults", config: DEFAULT_GIT_PROJECT_CONFIG, reportedKeys: [], origins: {} } }
    }
    const reading = await options.configSource.effective()
    if (reading.state === "invalid") return refuse("git_read_failed", `Send refused: ${reading.path}: ${reading.reason}`, "An invalid file reports itself and is left as it is; nothing was sent.")
    const mode = reading.reading.config.workflow.mode
    const capability = GIT_CAPABILITIES_OF_MODE[mode].push
    return { mode, capability, basis: `git.workflow.mode=${mode} permits push as ${capability}; the permission is not an authorisation and never permits force`, effective: reading.reading }
  }

  /** A send reading, in the shape §7.4 gives it. */
  const pushReading = (record: GitPushRecord, permission: CommitPermission, inspected: string, extra: Record<string, unknown> = {}): GitPushReading => ({
    kind: "git_push",
    succeeded: true,
    operationId: record.id,
    state: record.state,
    remote: sanitizeRemoteForDisplay(record.remote),
    branch: record.branch,
    commitSha: record.commitSha,
    expectedRemoteSha: record.expectedRemoteSha,
    actualRemoteSha: record.actualRemoteSha ?? null,
    setUpstream: record.setUpstream,
    inspected,
    basis: permission.basis,
    ...extra
  })
  /** A send reading from whatever the store gave back for this operation. */
  const pushReadingOf = (record: GitOperationRecord, permission: CommitPermission, inspected: string, extra: Record<string, unknown> = {}): GitPushReading | GitRefusal => {
    const here = transactions.pushRecord(record.id)
    if (here === undefined) return refuse("git_transaction_unknown", `Send refused: ${record.id} is not a push record here`, "Nothing was sent.")
    return pushReading(here, permission, inspected, extra)
  }

  /** One send, with no force option anywhere in it. Its answer is settled from what the ref holds, not from its exit. */
  const sendPush = async (record: GitPushRecord, permission: CommitPermission, info?: GitCallInfo, signal?: AbortSignal): Promise<GitPushReading | GitRunRefusal> => {
    const credentials = await resolveGitCredentials({ auth: permission.effective.config.auth })
    if ("code" in credentials) return refuse(credentials.code, `Send refused: ${credentials.summary}`, credentials.output)
    const secrets = Object.entries(credentials.environment).filter(([name]) => credentials.report.references.includes(name)).map(([, value]) => value)
    const moved = transactions.transition(record.id, "running", record.invocationId, `sent by call ${info?.executionId ?? "unnamed"}`)
    if ("code" in moved) return moved
    // A raw commit has no branch to track, so upstream is only added when this commit is the tip of that branch.
    const tip = await runGit(record.repositoryTop, ["rev-parse", "--verify", "--quiet", record.branch], signal)
    const tracksBranch = record.setUpstream && tip.ok && tip.output.trim() === record.commitSha
    const refspec = tracksBranch ? `${record.branch}:refs/heads/${record.branch}` : `${record.commitSha}:refs/heads/${record.branch}`
    const answer = await runGit(record.repositoryTop, pushArgsFor(record, credentials.gitConfig, refspec), signal, credentials.environment, options.pushTimeoutMs ?? GIT_PUSH_TIMEOUT_MS)
    const now = await remoteRef(record.repositoryTop, record.remote, record.branch, signal)
    const shown = redactForDisplay(answer.output, secrets)
    // A send git itself refused as non-fast-forward is reported as rejected; this stage does not rebase, reset or force around it.
    const rejectedByGit = !answer.lost && !answer.ok && /\[rejected\]|non-fast-forward/.test(shown)
    const outcome: PushReconciliation = rejectedByGit ? { state: "rejected", remoteSha: now.sha, provedBy: `the send was refused as non-fast-forward; the ref holds ${now.sha ?? "nothing there"}, which does not hold this commit` } : reconcilePush(record, now.sha, await remoteHoldsCommit(record.repositoryTop, record.commitSha, now.sha, signal))
    const said = answer.lost
      ? `the send was killed at the ${options.pushTimeoutMs ?? GIT_PUSH_TIMEOUT_MS} ms limit and no answer came back, so nothing here is read from its exit`
      : `the send answered with exit ${answer.exitCode}: ${shown.trim() === "" ? "nothing it could say" : shown.trim()}`
    const upstream = record.setUpstream ? (tracksBranch ? "upstream set as the project configured it" : "upstream not added: a raw commit has no branch to track") : "upstream left as the project configured it"
    const settled = transactions.transition(record.id, outcome.state, record.invocationId, `${proofOf(outcome)}; ${said}`)
    if ("code" in settled) return settled
    return pushReadingOf(settled, permission, `the commit sent is ${record.commitSha} (${refspec}); ${upstream}; ${now.read}; ${said}`, { sent: answer.ok && !answer.lost })
  }

  /** Stage 5's send. A second call for an operation that already ended answers as a status check, and a lost answer is settled by reading the ref before anything runs again. */
  const push = async (call: GitPushCall, authorization: unknown, info?: GitCallInfo, signal?: AbortSignal): Promise<GitPushReading | GitRunRefusal> => {
    if (call.force === true)
      return refuse("git_force_not_allowed", "Send refused: force is not something this stage can do", "Nothing was sent. A send here only fast-forwards; force, force-with-lease and rewriting history are refused.")

    const permission = await pushPermission()
    if ("code" in permission) return permission
    if (options.policy?.restrictions?.noPush)
      return refuse("git_task_restriction", "Send refused: this task does not allow a push", "The task's restriction is above the workflow preset. Nothing was sent.")
    if (permission.capability === "approval-required" && !options.policy?.approved)
      return refuse("git_approval_required", "Send refused: this workflow needs an approval for the send", `${permission.basis}. This call was not approved.`)

    const repository = await resolveRepository(call.repository, signal)
    if ("code" in repository) return repository

    // The destination is what the effective config names, with a host-derived restriction above it. A call cannot choose a remote or a branch.
    const destination = permission.effective.config.destination
    const policyDestination = options.policy?.destination
    const remote = (policyDestination?.remote ?? destination.remote ?? "").trim()
    if (remote === "") return refuse("git_destination_not_authorized", "Send refused: no destination remote is configured", "Nothing was sent. Set git.destination.remote, or name the remote the host granted.")
    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/@]*:[^/@]*@/.test(remote))
      return refuse("git_destination_not_authorized", `Send refused: ${sanitizeRemoteForDisplay(remote)} carries a login in its URL`, "Nothing was sent. A remote here names a place, not a credential; use a credential helper or an environment reference.")
    const configuredBranch = (policyDestination?.branch ?? destination.branch ?? "current").trim()
    const namedRemote = (call.remote ?? "").trim()
    if (namedRemote !== "" && namedRemote !== remote)
      return refuse("git_destination_not_authorized", `Send refused: ${sanitizeRemoteForDisplay(namedRemote)} is not the destination this project names`, `The effective destination is ${sanitizeRemoteForDisplay(remote)}. A call cannot choose a remote; only host-derived policy sits above it.`)
    const namedBranch = (call.branch ?? "").trim()
    if (namedBranch !== "" && configuredBranch !== "current" && namedBranch !== configuredBranch)
      return refuse("git_destination_not_authorized", `Send refused: ${namedBranch} is not the branch this project names`, `The effective destination is ${sanitizeRemoteForDisplay(remote)}/${configuredBranch}. A call cannot choose a branch.`)
    const here = await runGit(repository.top, ["symbolic-ref", "--quiet", "--short", "HEAD"], signal)
    const branch = configuredBranch === "current" ? (here.ok ? here.output.trim() : "") : configuredBranch
    if (branch === "") return refuse("git_push_no_branch", "Send refused: there is no branch to publish to", "A detached HEAD has no name here, and nothing was sent. Name the destination branch in the project config.")
    const setUpstream = destination.setUpstream
    if (call.setUpstream !== undefined && call.setUpstream !== setUpstream)
      return refuse("git_destination_not_authorized", "Send refused: upstream is only set as the project configured it", `The effective config says ${setUpstream}. Nothing was sent.`)

    // The commit is what this stage already made; a send never makes one. A call may name an operation recorded as a push, and that is answered for from state, not sent again.
    const preparedId = (call.operationId ?? "").trim()
    const committed = preparedId === "" ? undefined : transactions.commitRecord(preparedId)
    const recorded = preparedId === "" ? undefined : transactions.pushRecord(preparedId)
    if (preparedId !== "" && committed === undefined && recorded === undefined)
      return refuse("git_commit_not_prepared", `Send refused: ${preparedId} is not an operation this stage prepared`, "Nothing was sent. Commit first, then publish the record that commit made.")
    if (committed !== undefined && committed.repositoryTop !== repository.top)
      return refuse("git_commit_not_prepared", `Send refused: ${committed.id} belongs to another repository`, "Nothing was sent.")
    if (committed !== undefined && committed.state !== "succeeded")
      return refuse("git_commit_not_prepared", `Send refused: ${committed.id} has not committed`, `Its state is ${committed.state}. Nothing was committed, so there was nothing to send.`)
    const headRead = await runGit(repository.top, ["rev-parse", "--verify", "--quiet", "HEAD"], signal)
    const sha = committed !== undefined ? (committed.commitSha ?? "") : (recorded !== undefined ? recorded.commitSha : (headRead.ok ? headRead.output.trim() : ""))
    if (sha === "") return refuse("git_push_no_commit", "Send refused: there is nothing committed to publish", "A repository with no commit has nothing to send. Nothing was sent.")
    const namedSha = (call.commitSha ?? "").trim()
    if (namedSha !== "" && namedSha !== sha)
      return refuse("git_push_commit_changed", `Send refused: ${namedSha} is not what this operation published`, `The commit this repository holds is ${sha}. Nothing was sent; read the state before anything else is claimed.`)

    const approvedFor = path.resolve(view.root)
    const request = pushRequestFromCall({ operationId: preparedId, remote: namedRemote, branch: namedBranch }, approvedFor)
    if (approvedFor !== repository.top)
      return refuse("git_push_not_authorized", `Send refused: the approval covers ${approvedFor}, not the repository this call runs on`, `Nothing was sent. Grant ${repository.top}, or run this call in it.`)
    if (!claimGitRequests(authorization, [request], options.hostKey ?? ""))
      return refuse("git_push_not_authorized", "Send refused: no authorisation covers this call", "The approval must name the repository and the destination exactly as this call named them. A grant taken for a read, or for another call, does not carry a send. Nothing was sent.")

    const projectKey = options.projectKey ?? ""
    const invocation = info?.invocationId ?? ""
    const fingerprint = pushFingerprint({ projectKey, repositoryTop: repository.top, remote, branch, commitSha: sha })
    const byCall = invocation === "" ? undefined : transactions.byInvocation(invocation)
    const known = recorded ?? (byCall !== undefined && byCall.kind === "push" ? byCall : transactions.byPushFingerprint(fingerprint))
    if (known !== undefined) {
      const now = await remoteRef(repository.top, remote, branch, signal)
      if (GIT_TERMINAL_STATES.includes(known.state))
        return pushReadingOf(known, permission, `${now.read}; answered from the state this operation already had`, { duplicate: true })
      // Reading the ref before anything runs again settles what it proves; only an explicit authorized retry sends, and only when the read shows nothing landed and a fast-forward is still possible.
      const outcome = reconcilePush(known, now.sha, await remoteHoldsCommit(repository.top, sha, now.sha, signal))
      if (call.retry && outcome.state === "failed" && (await canFastForward(repository.top, now.sha, sha, signal))) return sendPush(known, permission, info, signal)
      const target = PUSH_TRANSITIONS[known.state].includes(outcome.state) ? outcome.state : "uncertain"
      const settled = transactions.transition(known.id, target, known.invocationId, `${proofOf(outcome)}; read before anything was sent again`)
      if ("code" in settled) return settled
      return pushReadingOf(settled, permission, `${now.read}; ${proofOf(outcome)}`, { duplicate: true, actualRemoteSha: now.sha })
    }

    const capture = options.conversationId === undefined ? undefined : options.baselines?.capturedFor(options.conversationId)
    const before = await remoteRef(repository.top, remote, branch, signal)
    const record = transactions.preparePush({
      id: operationIdOf(undefined),
      invocationId: invocation,
      kind: "push",
      projectKey,
      repositoryTop: repository.top,
      ...(options.conversationId === undefined ? {} : { conversationId: options.conversationId }),
      ...(info?.taskId === undefined ? {} : { taskId: info.taskId }),
      ...(info?.executionId === undefined ? {} : { executionId: info.executionId }),
      ...(options.hostKey === undefined ? {} : { hostKey: options.hostKey }),
      ...(capture?.model === undefined ? {} : { model: capture.model }),
      headBefore: committed !== undefined ? committed.headBefore : (headRead.ok ? headRead.output.trim() : null),
      branchBefore: branch,
      commitSha: sha,
      remote,
      branch,
      setUpstream,
      force: false,
      expectedRemoteSha: before.sha
    })
    const authorized = transactions.transition(record.id, "authorized", record.invocationId, `authorized by call ${info?.executionId ?? "unnamed"}`)
    if ("code" in authorized) return authorized

    if (before.ok && before.sha === sha)
      return pushReadingOf(authorized, permission, `${before.read}; nothing was sent because the ref already held this commit`)
    if (before.ok && before.sha === null)
      return refuse("git_push_branch_not_on_remote", `Send refused: ${sanitizeRemoteForDisplay(remote)} has no branch named ${branch}`, "Nothing was sent. This stage only sends to a branch the remote already has; creating one is a separate, explicit permission.")
    if (signal?.aborted) return ranRefusal("git_push_interrupted", "Send stopped: this call was interrupted", "Nothing was sent; read what the ref holds before anything else is claimed.")
    return sendPush(record, permission, info, signal)
 }

  /** Run one prepared commit. A second call for an operation that already settled answers as a status check. */
  const commit = async (operationId: string, authorization: unknown, info?: GitCallInfo, signal?: AbortSignal): Promise<GitCommitReading | GitRunRefusal> => {
    const permission = await commitPermission()
    if ("code" in permission) return permission
    if (options.policy?.restrictions?.noCommit)
      return refuse("git_task_restriction", "Commit refused: this task does not allow a commit", "The task's restriction is above the workflow preset. Nothing was committed.")
    // A preset that needs an approval is not satisfied by a permission alone: the call has to be approved.
    if (permission.capability === "approval-required" && !options.policy?.approved)
      return refuse("git_approval_required", "Commit refused: this workflow needs an approval for the commit", `${permission.basis} This call was not approved. The prepared operation is left as it was.`)

    const record = transactions.commitRecord(operationId)
    if (record === undefined)
      return refuse("git_commit_not_prepared", `Commit refused: ${operationId} is not an operation this stage prepared`, "Prepare a scope first, then commit by the operation id the preparation gave.")

    // A call for an operation that already ended answers with the state it had; it never makes a second commit.
    if (GIT_TERMINAL_STATES.includes(record.state)) {
      const note = record.outcome === undefined ? "" : `; ${record.outcome}`
      return { kind: "git_commit", succeeded: true, operationId: record.id, state: record.state, duplicate: true, basis: `answered from the state this operation already had${note}` }
    }

    // One conversation may read another's operation; it cannot replay or re-own it.
    if (record.conversationId !== undefined && options.conversationId !== undefined && record.conversationId !== options.conversationId)
      return refuse("git_commit_not_prepared", `Commit refused: ${record.id} belongs to another conversation`, "A conversation may inspect a project operation; it cannot replay or re-own one it did not prepare.")

    const approvedFor = path.resolve(view.root)
    const request: GitCommitRequest = { kind: "commit", absolute: approvedFor, operationId: record.id }
    if (!claimGitRequests(authorization, [request], options.hostKey ?? ""))
      return refuse("git_commit_not_authorized", "Commit refused: no authorisation covers this call", `The approval must name the repository this call runs on (${approvedFor}) and the operation id ${record.id}. A grant taken for a status read, or for another call, does not carry a commit.`)

    const claimed = transactions.byFingerprint(record.fingerprint, record.id)
    if (claimed !== undefined)
      return refuse("git_commit_intent_claimed", `Commit refused: this commit intent already belongs to ${claimed.id}`, "Read that operation instead of making another commit with the same scope and message.")

    const repository = await resolveRepository(record.repositoryTop, signal)
    if ("code" in repository) return repository

    // §8.4: what the preparation recorded, re-read before anything is written.
    const headRead = await runGit(repository.top, ["rev-parse", "--verify", "--quiet", "HEAD"], signal)
    const head = headRead.ok ? headRead.stdout.toString("utf8").trim() : null
    if (head !== record.headBefore)
      return refuse("git_head_changed", "Commit refused: HEAD is not what this operation prepared", `It was ${record.headBefore ?? "unborn"} and is now ${head ?? "unborn"}. Nothing was committed; read the state before preparing again.`)
    const branchRead = await runGit(repository.top, ["symbolic-ref", "--quiet", "--short", "HEAD"], signal)
    const branch = branchRead.ok ? branchRead.stdout.toString("utf8").trim() : null
    if (branch !== record.branchBefore)
      return refuse("git_branch_changed", "Commit refused: the branch is not what this operation prepared", `It was ${record.branchBefore ?? "detached"} and is now ${branch ?? "detached"}. Nothing was committed.`)
    const realIndex = await indexDigestOf(repository.gitDir)
    if (realIndex !== record.realIndexDigest)
      return refuse("git_real_index_changed", "Commit refused: the real index changed after this operation prepared", `The digest prepared was ${record.realIndexDigest.slice(0, 12)}… and is now ${realIndex.slice(0, 12)}…. Nothing was committed; the scope has to be prepared again.`)

    const held = await entriesOfIndex(repository.top, record.scratchIndex, signal)
    const heldByPath = new Map(held.map((entry) => [entry.path, entry]))
    for (const entry of record.entries) {
      if (entry.digest !== undefined) {
        const now = await digestOf(repository.top, entry.path)
        if (now !== entry.digest)
          return refuse("git_selected_file_changed", `Commit refused: ${entry.path} changed after this operation prepared`, `The digest prepared was ${entry.digest.slice(0, 12)}… and is now ${now === undefined ? "unreadable" : now.slice(0, 12)}…. Nothing was committed.`)
      }
      if (entry.blob !== "" && heldByPath.get(entry.path)?.blob !== entry.blob)
        return refuse("git_selected_file_changed", `Commit refused: the private copy no longer holds what this operation prepared for ${entry.path}`, "Something wrote the prepared scope after the preparation. Nothing was committed.")
    }

    // Ownership on a shared path is checked again: the same conditions as preparation, before anything is written.
    const reading = options.conversationId === undefined ? undefined : options.ownership?.for(record.conversationId ?? options.conversationId)
    if (reading !== undefined && !("code" in reading))
      for (const entry of record.entries) {
        if (entry.source === "index") continue
        const fact = reading.change(entry.path)
        if (fact === undefined) return refuse("git_authorship_not_proven", `Commit refused: nothing here proves ${entry.path} as this session's work`, "A commit that cannot say who made the change it records is not made. Nothing was committed.")
        if (fact.ownership !== "agent" && !options.policy?.explicitChoice)
          return refuse("git_mixed_ownership", `Commit refused: ${entry.path} no longer reads as this session's own work`, `The index now reports it as ${fact.ownership}/${fact.confidence}. Nothing was committed.`)
      }
    if (signal?.aborted) return ranRefusal("git_commit_interrupted", "Commit stopped: this call was interrupted", "Nothing was written. Read what the repository holds before anything else is claimed.")

    const prepared = transactions.transition(record.id, "authorized", record.invocationId, info?.executionId === undefined ? undefined : `authorized by call ${info.executionId}`)
    if ("code" in prepared) return prepared
    const moved = transactions.transition(prepared.id, "running", prepared.invocationId)
    if ("code" in moved) return moved
    const running = transactions.commitRecord(moved.id)
    if (running === undefined) return refuse("git_transaction_unknown", `Commit refused: ${prepared.id} is not a commit record here`, "Nothing was committed.")

    const message = messageWithTrailers(running.message, coAuthorTrailers(running.attribution.coAuthors, running.attribution.author?.name === MORIARTY_IDENTITY_NAME, running.attribution.tagging))
    const env = { GIT_INDEX_FILE: running.scratchIndex, ...(await runEnvFor(running.attribution)) }
    const parents = running.headBefore === null ? [] : [running.headBefore]
    const written = await runGit(repository.top, ["-c", "commit.gpgsign=false", "commit-tree", running.alternateTree, ...parents.flatMap((parent) => ["-p", parent]), "-m", message], signal, env)
    if (!written.ok) {
      fs.unlinkSync(running.scratchIndex)
      const failed = transactions.transition(running.id, "failed", running.invocationId, `git commit-tree failed in ${repository.top}`)
      if ("code" in failed) return failed
      return { kind: "git_commit", succeeded: true, operationId: failed.id, state: "failed", basis: "nothing was committed: the prepared tree could not be written as a commit" }
    }
    const sha = written.stdout.toString("utf8").trim()
    // The commit this operation made, recorded so a later send publishes exactly this one.
    transactions.setCommitSha(running.id, sha, running.invocationId)
    // The ref moves by compare-and-set, so a HEAD that changed after preparation is not overwritten.
    const updated = await runGit(repository.top, ["update-ref", branch === null ? "HEAD" : `refs/heads/${branch}`, sha, running.headBefore ?? ""], signal, env)
    fs.unlinkSync(running.scratchIndex)
    if (!updated.ok) {
      // The response is ambiguous: read what the repository actually holds before anything is claimed.
      const outcome = reconcileCommit(running, head, await logCandidates(repository.top, signal))
      const settled = transactions.transition(running.id, outcome.state, running.invocationId, `git update-ref failed in ${repository.top}; ${proofOf(outcome)}`)
      if ("code" in settled) return settled
      return { kind: "git_commit", succeeded: true, operationId: settled.id, state: settled.state, basis: `the commit was written but this call could not move the ref; ${proofOf(outcome)}` }
    }
    const files = await namesOfCommit(repository.top, sha, signal)
    const settled = transactions.transition(running.id, "succeeded", running.invocationId, `commit ${sha} on ${branch ?? "detached HEAD"}`)
    if ("code" in settled) return settled
    return {
      kind: "git_commit",
      succeeded: true,
      operationId: settled.id,
      state: "succeeded",
      commit: {
        sha,
        parents,
        tree: running.alternateTree,
        author: running.attribution.author,
        committer: running.attribution.committer,
        coAuthors: running.attribution.coAuthors,
        message,
        files
      },
      basis: `${permission.basis}; ${describeCommitAttribution(running.attribution)}`
    }
  }

  /** Read what an interrupted operation actually produced; never manufacture a commit or replay one. */
  const recover = async (operationId: string, info?: GitCallInfo, signal?: AbortSignal): Promise<GitRecoveredReading | GitRefusal> => {
    const record = transactions.get(operationId)
    if (record === undefined) return refuse("git_commit_not_prepared", `Recovery refused: ${operationId} is not an operation this stage prepared`, "Nothing was read for an operation that does not exist.")
    const repository = await resolveRepository(record.repositoryTop, signal)
    if ("code" in repository) return repository
    if (record.kind === "push") {
      // A send is settled from the ref it was sent to. The exit of a process that never answered says nothing here.
      const now = await remoteRef(repository.top, record.remote, record.branch, signal)
      const outcome = reconcilePush(record, now.sha, await remoteHoldsCommit(repository.top, record.commitSha, now.sha, signal))
      const inspected = `the commit this operation published is ${record.commitSha}; ${now.read}; read for call ${info?.executionId ?? "unnamed"}`
      const where = { remote: sanitizeRemoteForDisplay(record.remote), branch: record.branch }
      if (GIT_TERMINAL_STATES.includes(record.state))
        return { kind: "git_recovered", succeeded: true, operationId: record.id, state: record.state, inspected: `${inspected}; answered from the state it already had`, destination: where, remoteSha: now.sha, ...(record.outcome === undefined ? {} : { reason: record.outcome }) }
      if (record.state === "prepared")
        return { kind: "git_recovered", succeeded: true, operationId: record.id, state: "prepared", inspected, destination: where, remoteSha: now.sha, reason: proofOf(outcome) }
      const settled = transactions.transition(record.id, outcome.state, record.invocationId, proofOf(outcome))
      if ("code" in settled) return settled
      return { kind: "git_recovered", succeeded: true, operationId: settled.id, state: settled.state, inspected, destination: where, remoteSha: now.sha, reason: proofOf(outcome) }
    }
    const headRead = await runGit(repository.top, ["rev-parse", "--verify", "--quiet", "HEAD"], signal)
    const head = headRead.ok ? headRead.stdout.toString("utf8").trim() : null
    const candidates = await logCandidates(repository.top, signal)
    const inspected = `HEAD ${head ?? "unborn"}, ${candidates.length} commit${candidates.length === 1 ? "" : "s"} read from the log, against the prepared parent ${record.headBefore ?? "unborn"} and tree ${record.alternateTree}; read for call ${info?.executionId ?? "unnamed"}`
    if (GIT_TERMINAL_STATES.includes(record.state))
      return { kind: "git_recovered", succeeded: true, operationId: record.id, state: record.state, inspected: `${inspected}; answered from the state it already had`, ...(record.outcome === undefined ? {} : { reason: record.outcome }) }
    const outcome = reconcileCommit(record, head, candidates)
    // A prepared operation that never ran has nothing to settle; it stays as it was.
    if (record.state === "prepared")
      return { kind: "git_recovered", succeeded: true, operationId: record.id, state: "prepared", inspected, reason: proofOf(outcome) }
    const settled = transactions.transition(record.id, outcome.state, record.invocationId, proofOf(outcome))
    if ("code" in settled) return settled
    return {
      kind: "git_recovered",
      succeeded: true,
      operationId: settled.id,
      state: settled.state,
      inspected,
      ...(outcome.state === "succeeded" ? { commit: { sha: outcome.commit.sha, parents: outcome.commit.parents, tree: outcome.commit.tree } } : {}),
      reason: proofOf(outcome)
    }
  }

  /** End a prepared operation without committing it, and remove its private scratch copy. */
  const cancelCommit = async (operationId: string, reason: string, info?: GitCallInfo, signal?: AbortSignal): Promise<GitRecoveredReading | GitRefusal> => {
    const record = transactions.commitRecord(operationId)
    if (record === undefined) return refuse("git_commit_not_prepared", `Cancel refused: ${operationId} is not an operation this stage prepared`, "Nothing was removed; there is no prepared operation to cancel.")
    if (signal?.aborted) return refuse("git_commit_interrupted", "Cancel refused: this call was interrupted", "Nothing was removed; the operation is left as it stands.")
    if (!COMMIT_TRANSITIONS[record.state].includes("refused"))
      return { kind: "git_recovered", succeeded: true, operationId: record.id, state: record.state, inspected: `the operation was already ${record.state}, so nothing was cancelled`, reason: record.outcome }
    const settled = transactions.transition(record.id, "refused", record.invocationId, `cancelled: ${reason}`)
    if ("code" in settled) return settled
    try {
      fs.unlinkSync(record.scratchIndex)
    } catch {
      // The private copy is already gone.
    }
    return { kind: "git_recovered", succeeded: true, operationId: settled.id, state: settled.state, inspected: `the private index copy ${record.scratchIndex} was removed; nothing was committed; read for call ${info?.executionId ?? "unnamed"}`, reason: `cancelled: ${reason}` }
  }

  return { resolveRepository, prefix: prefixOf, hiddenHere, hiddenIn, nameOf, refuseBareArguments, runGit, status, inspect, prepareCommit, commit, push, remoteRef, recover, cancelCommit }
}