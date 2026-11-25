/**
 * Stage 2's chat-start baseline (§8.1 of the design): what git already had when a conversation began —
 * HEAD, branch, the real index, and every staged, unstaged and untracked path — read once per
 * conversation and kept as it was for the life of that conversation. Context pruning, a model change or
 * another call for the same conversation answers with the same baseline, because ownership is measured
 * against it: a later claim can only be judged against what the session started with.
 *
 * Everything here reads. Git is asked for `status`, `rev-parse` and `symbolic-ref`, and the working tree
 * is snapshotted the way `chat/command-snapshot.ts` already does for command changes — through a copy of
 * the index, so `.gitignore` is honoured and the user's own staging stays as it is. No staging, commit,
 * branch change or reset happens here, and the real index file is hashed as it sits on disk, never
 * rewritten. The snapshot writes objects to git's own store, as `git stash create` does; that is the one
 * thing this stage touches, and it is the behaviour command changes already rely on.
 *
 * The effective Git config is read through Stage 1's shared reader (`createGitConfigSource`), never by
 * re-reading `config.json`. A credential value never enters a capture: the reading holds env references,
 * and `describe` prints names only. A file the shared reader finds invalid is reported as it is, not
 * quietly replaced by defaults, so an invalid config still reports itself in a session reading.
 */
import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

import { MAX_COMMAND_CHANGES, repositoryOf, runGitInRepository, snapshotTree } from "../chat/command-snapshot"
import { readState } from "../chat/reply-changes"

import { describeGitConfig, GitConfigReading, GitConfigSource } from "./config"

/** What git's own porcelain code says about one side of a path, as a plain word. */
export type GitChangeStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "type_change" | "unreadable" | "untracked" | "clean" | "unknown"

const STATUS_OF_CODE: Record<string, GitChangeStatus> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "type_change",
  U: "unreadable",
  "?": "untracked",
  " ": "clean"
}

/** A capture changes nothing, so a refusal always says that it executed nothing. */
export interface GitRefusal {
  code: string
  executed: false
  summary: string
  output: string
}

export const refuse = (code: string, summary: string, output: string): GitRefusal => ({ code, executed: false, summary, output })

/** One path as git classified it at the moment the session started. */
export interface GitChange {
  /** Repository-relative, forward slashes, exactly as git named it. */
  path: string
  /** Which side this entry belongs to: what the index had, or what the working tree had. */
  side: "staged" | "unstaged"
  /** The two characters git printed for this path, so both sides can still be seen. */
  code: string
  status: GitChangeStatus
  /** Where git says the content came from, for a rename or a copy. */
  from?: string
  /** What the host read the file to hold at capture time; `undefined` when it could not be read or kept. */
  digest?: string
}

/** The session baseline, as §4 of the plan defines it. */
export interface GitSessionBaseline {
  id: string
  conversationId: string
  repositoryTop: string
  /** `null` for a repository with nothing committed yet. */
  headBefore: string | null
  /** `null` when HEAD is detached, or when the branch has no name to give. */
  branchBefore: string | null
  /** sha256 over the bytes of git's own index file, so a later stage can prove it was preserved. */
  realIndexDigest: string
  staged: GitChange[]
  unstaged: GitChange[]
  untracked: string[]
  /** The working tree as git would commit it, taken the way command changes take it. */
  workingTreeSnapshot: string
}

/** Which model the host was talking to at capture time. Provenance only: never an owner, and never model-supplied. */
export interface GitSessionModel { provider?: string; name?: string }

/** The provenance the host knows and hands in. Nothing here takes it from a prompt. */
export interface GitSessionHost { hostKey?: string; model?: GitSessionModel }

/** One captured session: the baseline plus what the host knew when it took it. */
export interface GitSessionCapture {
  conversationId: string
  hostKey?: string
  model?: GitSessionModel
  /** Where git keeps its own files for this repository, as `rev-parse` answered. */
  gitDir: string
  /** A detached HEAD has no branch to name; recorded so nothing guesses one. */
  detached: boolean
  /** What Stage 1's shared reader answered at capture time, in the state it gave it. */
  config: GitConfigReading
  capturedAt: number
  baseline: GitSessionBaseline
}

/** The digest of a repository with no index file yet, told apart from an index that holds nothing. */
export const ABSENT_INDEX_DIGEST = createHash("sha256").update("twinny:git-index-absent").digest("hex")

/**
 * Content as the host measures it: sha256 over the text with line endings normalised. It is the same
 * shape `editDigest` produces in `todos/repository.ts`, so a baseline reading and an edit operation's
 * pre/post digests compare with each other.
 */
export const contentDigest = (text: string): string => createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex")

const entryOf = async (top: string, code: string, relative: string, side: "staged" | "unstaged", from?: string): Promise<GitChange> => {
  const change: GitChange = { path: relative, side, code, status: STATUS_OF_CODE[code] ?? "unknown" }
  if (from !== undefined) change.from = from
  const state = await readState(path.join(top, ...relative.split("/")))
  if (state !== undefined && state !== null) change.digest = contentDigest(state)
  return change
}

/** One porcelain v1 record: `XY path`, with the source path following for a rename or a copy. */
const parsePorcelain = (stdout: Buffer): { code: string; path: string; from?: string }[] => {
  const fields = stdout.toString("utf8").split("\0").filter(Boolean)
  const entries: { code: string; path: string; from?: string }[] = []
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]
    const code = field.slice(0, 2)
    const named = field.slice(2).replace(/^ +/, "")
    if (!code || !named) continue
    const detected = code.charAt(0) === "R" || code.charAt(1) === "R" || code.charAt(0) === "C" || code.charAt(1) === "C"
    const entry: { code: string; path: string; from?: string } = { code, path: named }
    if (detected && i + 1 < fields.length) entry.from = fields[++i]
    entries.push(entry)
  }
  return entries
}

const sorted = <T extends { path: string }>(changes: T[]): T[] => [...changes].sort((a, b) => a.path.localeCompare(b.path))

/** Reads one session baseline as it stands now. Called once per conversation by the store. */
export const captureGitSessionBaseline = async (
  conversationId: string,
  workspaceRoot: string,
  configSource: GitConfigSource,
  host: GitSessionHost = {}
): Promise<GitSessionCapture | GitRefusal> => {
  if (!conversationId) return refuse("git_baseline_no_conversation", "Baseline refused: no conversation to tie it to", "A baseline belongs to one conversation; without one its changes could be mixed with another session's.")
  const repository = await repositoryOf(workspaceRoot)
  if (!repository) return refuse("git_baseline_no_repository", `Baseline refused: ${workspaceRoot} is not inside a git repository`, "Nothing was read. A session that is not in a repository has no git baseline to keep.")

  // The index as it stands when the session starts, taken before git is asked anything: a status run can
  // refresh its own stat cache and rewrite the file, so the baseline records what git had, not what a read
  // left there.
  const indexFile = path.join(repository.gitDir, "index")
  let realIndexDigest = ABSENT_INDEX_DIGEST
  try {
    realIndexDigest = createHash("sha256").update(await fs.readFile(indexFile)).digest("hex")
  } catch {
    // A repository with nothing staged yet has no index file; that is a state, not a failure.
  }
  const status = await runGitInRepository(repository.top, ["status", "--porcelain=v1", "-z"])
  if (!status.ok) return refuse("git_baseline_status_failed", "Baseline refused: git could not read the working tree", `git status --porcelain=v1 -z failed in ${repository.top}. Nothing was changed.`)
  const entries = parsePorcelain(status.stdout)
  if (entries.length > MAX_COMMAND_CHANGES) return refuse("git_baseline_too_many_changes", `Baseline refused: ${entries.length} paths changed, more than ${MAX_COMMAND_CHANGES}`, "A baseline this wide would be a guess. Narrow the session to one repository or fewer paths.")

  const head = await runGitInRepository(repository.top, ["rev-parse", "--verify", "--quiet", "HEAD"])
  const branch = await runGitInRepository(repository.top, ["symbolic-ref", "--quiet", "--short", "HEAD"])
  const snapshot = await snapshotTree(repository.top)
  if (!snapshot) return refuse("git_baseline_snapshot_failed", "Baseline refused: the working tree could not be snapshotted", `The temporary index copy failed in ${repository.top}. Nothing was changed; the session runs without a baseline.`)

  const staged: GitChange[] = []
  const unstaged: GitChange[] = []
  const untracked: string[] = []
  for (const entry of entries) {
    if (entry.code === "??") { untracked.push(entry.path); continue }
    if (entry.code.charAt(0) !== " ") staged.push(await entryOf(repository.top, entry.code.charAt(0), entry.path, "staged", entry.from))
    if (entry.code.charAt(1) !== " ") unstaged.push(await entryOf(repository.top, entry.code.charAt(1), entry.path, "unstaged", entry.from))
  }

  return {
    conversationId,
    ...(host.hostKey !== undefined ? { hostKey: host.hostKey } : {}),
    ...(host.model !== undefined ? { model: host.model } : {}),
    gitDir: repository.gitDir,
    detached: !branch.ok,
    config: await configSource.effective(),
    capturedAt: Date.now(),
    baseline: {
      id: randomUUID(),
      conversationId,
      repositoryTop: repository.top,
      headBefore: head.ok ? head.stdout.toString("utf8").trim() : null,
      branchBefore: branch.ok ? branch.stdout.toString("utf8").trim() : null,
      realIndexDigest,
      staged: sorted(staged),
      unstaged: sorted(unstaged),
      untracked: untracked.sort((a, b) => a.localeCompare(b)),
      workingTreeSnapshot: snapshot.tree
    }
  }
}

/**
 * One store per project: it captures once per conversation and keeps what it captured. A second call for
 * the same conversation answers with the baseline as it was, so pruning context or changing model cannot
 * move it; a call that names another repository is refused instead of merging two sessions.
 */
export interface GitBaselineStore {
  capture(conversationId: string, workspaceRoot: string, host?: GitSessionHost): Promise<GitSessionCapture | GitRefusal>
  capturedFor(conversationId: string): GitSessionCapture | undefined
  bySessionId(id: string): GitSessionCapture | undefined
  conversations(): string[]
  /** The line a diagnostic may print: names, digests and counts, never a credential value. */
  describe(conversationId: string): string
}

export const createGitBaselineStore = (configSource: GitConfigSource, defaultHost: GitSessionHost = {}): GitBaselineStore => {
  const captured = new Map<string, GitSessionCapture>()
  return {
    capture: async (conversationId, workspaceRoot, host) => {
      const known = captured.get(conversationId)
      if (known) {
        const repository = await repositoryOf(workspaceRoot)
        if (repository && repository.top !== known.baseline.repositoryTop)
          return refuse("git_baseline_other_repository", `Baseline kept: ${conversationId} belongs to ${known.baseline.repositoryTop}`, `${workspaceRoot} is in another repository (${repository.top}). Two conversations do not share one baseline.`)
        return known
      }
      const capture = await captureGitSessionBaseline(conversationId, workspaceRoot, configSource, { ...defaultHost, ...host })
      if ("code" in capture) return capture
      captured.set(conversationId, capture)
      return capture
    },
    capturedFor: (conversationId) => captured.get(conversationId),
    bySessionId: (id) => [...captured.values()].find((capture) => capture.baseline.id === id),
    conversations: () => [...captured.keys()],
    describe: (conversationId) => {
      const capture = captured.get(conversationId)
      if (!capture) return `${conversationId}: no baseline was captured`
      const baseline = capture.baseline
      const counts = `staged=${baseline.staged.length}, unstaged=${baseline.unstaged.length}, untracked=${baseline.untracked.length}`
      const who = [`${capture.conversationId} session ${baseline.id}`, `${baseline.repositoryTop}`, `head=${baseline.headBefore ?? "unborn"}`, `branch=${baseline.branchBefore ?? (capture.detached ? "detached" : "none")}`, counts, `snapshot=${baseline.workingTreeSnapshot}`, `index=${baseline.realIndexDigest}`].join(" ")
      return `${who}; ${describeGitConfig(capture.config)}`
    }
  }
}
