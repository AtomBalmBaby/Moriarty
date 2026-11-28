/**
 * Stage 4's commit transaction (§10.2 and §11.3 of the design): one record per prepared operation, the states
 * it may move through, and recovery that reads repository state instead of trusting an exit code or a timeout.
 * A successful commit is never repeated because a tool response was lost; a retry by operation ID is an
 * idempotent status check, and no empty commit is manufactured.
 * Stage 5 adds the push record and its machine (§10.3 and §11.4): a push never creates a commit, an answer that was
 * lost is settled from what the remote ref actually holds, and a second call for an operation that already ended answers as a status check.
 *
 * Stage 6 makes these records durable in the project database, on the additive v22 migration the plan names.
 * Nothing here opens or changes a database: this store is the same shape the repository methods will read
 * from, and one record holds compact attribution data - names, emails, digests and SHAs - never a credential,
 * a raw patch or a secret URL (§12). One invocation owns one operation and its terminal state, a state moves
 * by compare-and-set, and another conversation cannot replay or re-own a prepared operation.
 */
import { createHash, randomUUID } from "node:crypto"

import { GitRefusal, refuse } from "./baseline"
import type { CommitAttribution } from "./identity"

/** The operations the transaction table names: the commit record Stage 4 makes and the push record Stage 5 makes. */
export type GitTransactionKind = "commit" | "push"

/** The states §10.2 names, in the shape the schema accepts. */
export type GitTransactionState =
  | "prepared" | "authorized" | "running" | "succeeded" | "failed"
  | "refused" | "rejected" | "uncertain"

export const GIT_TRANSACTION_STATES: readonly GitTransactionState[] = [
  "prepared", "authorized", "running", "succeeded", "failed", "refused", "rejected", "uncertain"
]

/** The moves a commit record may make. A move not in this table is refused, not quietly taken. */
export const COMMIT_TRANSITIONS: Record<GitTransactionState, readonly GitTransactionState[]> = {
  prepared: ["authorized", "refused", "failed"],
  authorized: ["running", "refused", "failed"],
  running: ["succeeded", "failed", "uncertain", "refused"],
  uncertain: ["succeeded", "failed", "uncertain"],
  succeeded: [],
  failed: [],
  refused: [],
  rejected: []
}

/** The moves a push record may make (§10.3). A push that never needed to be sent can still be settled from what the remote already held, because that is a reading, not an action. */
export const PUSH_TRANSITIONS: Record<GitTransactionState, readonly GitTransactionState[]> = {
  prepared: ["authorized", "refused", "failed"],
  authorized: ["running", "succeeded", "rejected", "refused", "failed", "uncertain"],
  running: ["succeeded", "rejected", "failed", "uncertain", "refused"],
  uncertain: ["succeeded", "rejected", "failed", "uncertain"],
  succeeded: [],
  failed: [],
  refused: [],
  rejected: []
}


/** A condition that ran something and still did not complete. `executed` says which, as §14 shapes it. */
export interface GitRunRefusal { code: string; executed: boolean; summary: string; output: string }

export const ranRefusal = (code: string, summary: string, output: string): GitRunRefusal => ({ code, executed: true, summary, output })

/** One path as staging recorded it in the alternate index. */
export interface StagedEntry {
  path: string
  /** Where the content came from: the working tree, an entry the real index already held, or a verified patch. */
  source: "working" | "index" | "patch"
  mode: string
  blob: string
  /** What the host read for the whole file when it could name it. */
  digest?: string
  /** Why this path was allowed into the commit, said so a later reading can check it. */
  basis: string
}

/** One prepared commit, as §10.1 records it. No credential and no raw patch is held here. */
export interface GitCommitRecord {
  id: string
  invocationId: string
  /** The schema's kind column. A commit record is only ever a commit, so no push settles one. */
  kind: "commit"
  projectKey: string
  repositoryTop: string
  conversationId?: string
  taskId?: string
  executionId?: string
  hostKey?: string
  /** Host-derived provenance only; never a co-author and never read from a prompt. */
  model?: { provider?: string; name?: string }
  headBefore: string | null
  branchBefore: string | null
  realIndexDigest: string
  entries: StagedEntry[]
  selectedDiffSha256: string
  alternateTree: string
  /** The private scratch index this operation is working in, kept until commit or cancellation. */
  scratchIndex: string
  message: string
  /** Whether this call said outright that an empty commit is allowed; nothing manufactures one without it. */
  allowEmpty?: boolean
  attribution: CommitAttribution
  /** sha256 over the fields that name this commit's intent, so recovery can match it. */
  fingerprint: string
  /** The commit this operation made, once it is known. A push publishes exactly this, never a commit it invents. */
  commitSha?: string
  state: GitTransactionState
  outcome?: string
  createdAt: number
  updatedAt: number
}

/** What a call names when it prepares an operation. `id` and `fingerprint` are the store's own. */
export type NewCommitRecord = Omit<GitCommitRecord, "fingerprint" | "state" | "createdAt" | "updatedAt">

/** One recorded push: the commit it published, the destination as the effective config named it, and what the remote ref held before and after. No credential and no URL with a credential is held here (§12). */
export interface GitPushRecord {
  id: string
  invocationId: string
  kind: "push"
  projectKey: string
  repositoryTop: string
  conversationId?: string
  taskId?: string
  executionId?: string
  hostKey?: string
  model?: { provider?: string; name?: string }
  /** The commit operation this push published, when it published one this stage made. */
  commitOperationId?: string
  commitSha: string
  headBefore: string | null
  branchBefore: string | null
  /** The remote as a name, or a URL printed without its credential. */
  remote: string
  branch: string
  setUpstream: boolean
  /** Force is never what this stage can be approved for. */
  force: false
  /** What the ref held when it was read before anything was sent. */
  expectedRemoteSha: string | null
  /** What it holds as the last reading proved it. */
  actualRemoteSha?: string | null
  /** sha256 over what this push names, so a second call for the same operation is recognised. */
  fingerprint: string
  state: GitTransactionState
  outcome?: string
  createdAt: number
  updatedAt: number
}

export type NewPushRecord = Omit<GitPushRecord, "fingerprint" | "state" | "createdAt" | "updatedAt">

export type GitOperationRecord = GitCommitRecord | GitPushRecord

/** What a push intent is hashed over: where, which destination, which commit. */
export const pushFingerprint = (record: Pick<GitPushRecord, "projectKey" | "repositoryTop" | "remote" | "branch" | "commitSha">): string =>
  createHash("sha256").update([record.projectKey, record.repositoryTop, record.remote, record.branch, record.commitSha].join("\u0001")).digest("hex")

/** The fields the intent is hashed over: where, from what, in what scope, with what message. */
export const commitFingerprint = (record: Pick<GitCommitRecord, "projectKey" | "repositoryTop" | "headBefore" | "alternateTree" | "message" | "entries">): string => {
  const scope = [...record.entries].sort((a, b) => a.path.localeCompare(b.path)).map((entry) => `${entry.path}:${entry.mode}:${entry.blob}`).join("\n")
  return createHash("sha256").update([record.projectKey, record.repositoryTop, record.headBefore ?? "unborn", record.alternateTree, record.message, scope].join("\u0001")).digest("hex")
}

/** A candidate commit read from the repository, for recovery. */
export interface GitCommitCandidate { sha: string; parents: string[]; tree: string; message: string }

/** What recovery can prove from repository state, in the order §11.3 lists it. */
export type CommitReconciliation =
  | { state: "succeeded"; commit: GitCommitCandidate; provedBy: string }
  | { state: "failed"; provedBy: string }
  | { state: "uncertain"; reason: string }

const firstLine = (text: string): string => text.split("\n")[0].trim()

/** The whole message, or its first line: recovery names which one matched. */
const messageMatches = (record: GitCommitRecord, candidate: GitCommitCandidate): boolean =>
  candidate.message.trim() === record.message.trim()

const parentMatches = (record: GitCommitRecord, candidate: GitCommitCandidate): boolean =>
  candidate.parents.length === 0 ? record.headBefore === null : candidate.parents[0] === record.headBefore

/**
 * Recovery reads the repository, never an exit code or a timeout: a matching commit is reused, a verified
 * absence is a failure, and what still cannot be proved stays uncertain. No second commit is created here.
 */
export const reconcileCommit = (record: GitCommitRecord, headNow: string | null, candidates: GitCommitCandidate[]): CommitReconciliation => {
  for (const candidate of candidates) {
    if (!parentMatches(record, candidate) || candidate.tree !== record.alternateTree) continue
    const exact = messageMatches(record, candidate)
    if (!exact && firstLine(candidate.message) !== firstLine(record.message)) continue
    return { state: "succeeded", commit: candidate, provedBy: `commit ${candidate.sha} matches the prepared parent ${record.headBefore ?? "unborn"} and tree ${record.alternateTree}${exact ? ", message whole" : ", message by its first line"}` }
  }
  if (headNow === record.headBefore) return { state: "failed", provedBy: `HEAD is still ${record.headBefore ?? "unborn"}, so no commit was created for this operation` }
  return { state: "uncertain", reason: `HEAD is ${headNow ?? "unborn"}, which is not the prepared parent and holds no commit matching tree ${record.alternateTree}` }
}

/** What recovery can prove about a push, in the order §11.4 lists it. Nothing here is decided from an exit code or a timeout. */
export type PushReconciliation =
  | { state: "succeeded"; remoteSha: string; provedBy: string }
  | { state: "rejected"; remoteSha: string | null; provedBy: string }
  | { state: "failed"; remoteSha: string | null; provedBy: string }
  | { state: "uncertain"; remoteSha: string | null; reason: string }

/**
 * The remote ref as it reads now, against what this operation expected. It equals this commit, or holds this
 * commit and has moved on; it changed away from what was expected; or it is still what it was, which proves
 * nothing landed. What cannot be proved stays uncertain, and no second send is decided from that.
 */
export const reconcilePush = (record: GitPushRecord, remoteSha: string | null, holdsCommit?: boolean): PushReconciliation => {
  if (remoteSha === null)
    return { state: "uncertain", remoteSha: null, reason: `the ref on ${record.remote} could not be read, so nothing here can say what this push did` }
  if (remoteSha === record.commitSha)
    return { state: "succeeded", remoteSha, provedBy: `the ref ${record.branch} on ${record.remote} holds ${remoteSha}, the commit this operation published` }
  if (record.expectedRemoteSha !== null && remoteSha === record.expectedRemoteSha)
    return { state: "failed", remoteSha, provedBy: `the ref still holds ${remoteSha}, exactly what it held before this operation ran, so nothing landed` }
  if (holdsCommit === true)
    return { state: "succeeded", remoteSha, provedBy: `the ref ${record.branch} holds this commit and has moved on to ${remoteSha}` }
  if (holdsCommit === undefined)
    return { state: "uncertain", remoteSha, reason: `the ref reads ${remoteSha}, which is not this commit and cannot be checked against it from here` }
  return { state: "rejected", remoteSha, provedBy: `the ref moved from ${record.expectedRemoteSha ?? "nothing"} to ${remoteSha}, which does not hold this commit; nothing was rewritten` }
}

/** One record per prepared operation, keyed by id and by invocation as the schema's UNIQUE does. */
export interface GitTransactionStore {
  projectKey(): string
  /** Records a prepared commit before dispatch. A second call for the same invocation answers with the record it already had. */
  prepare(input: NewCommitRecord): GitCommitRecord
  /** Records a push before anything is sent, with what the ref held when it was first read. A push record is never made by a commit, and no push settles one. */
  preparePush(input: NewPushRecord): GitPushRecord
  /** The record an id names, whichever kind it is. */
  get(id: string): GitOperationRecord | undefined
  commitRecord(id: string): GitCommitRecord | undefined
  pushRecord(id: string): GitPushRecord | undefined
  byInvocation(invocationId: string): GitOperationRecord | undefined
  /** Another record with the same intent, so a second operation cannot claim it. */
  byFingerprint(fingerprint: string, exceptId?: string): GitCommitRecord | undefined
  byPushFingerprint(fingerprint: string, exceptId?: string): GitPushRecord | undefined
  /** Compare-and-set on the state alone, as §11.1 requires, by the table the record's kind owns. */
  transition(id: string, to: GitTransactionState, byInvocationId: string, outcome?: string): GitOperationRecord | GitRefusal
  /** What an operation produced, recorded only by the operation that produced it. */
  setCommitSha(id: string, sha: string, byInvocationId: string): GitCommitRecord | GitRefusal
  setRemoteSha(id: string, remoteSha: string | null, byInvocationId: string): GitPushRecord | GitRefusal
  records(): GitOperationRecord[]
  /** The line a diagnostic may print: names, digests and states, never a credential value. */
  describe(id: string): string
}

export const createGitTransactionStore = (projectKey = ""): GitTransactionStore => {
  const operations = new Map<string, GitOperationRecord>()

  const kindWord = (record: GitOperationRecord): string => (record.kind === "commit" ? "Commit" : "Push")
  const tableOf = (record: GitOperationRecord): readonly GitTransactionState[] => (record.kind === "commit" ? COMMIT_TRANSITIONS[record.state] : PUSH_TRANSITIONS[record.state])

  // One invocation owns one operation and its terminal state: another conversation may read a project
  // operation, but it cannot replay or re-own a record this invocation prepared.
  const ownedBy = <T extends GitOperationRecord>(record: T, byInvocationId: string): T | GitRefusal => {
    if (record.invocationId !== byInvocationId)
      return refuse("git_transaction_other_conversation", `${kindWord(record)} refused: operation ${record.id} belongs to ${record.invocationId}`, "A conversation may inspect a project operation; it may not replay or re-own the prepared operation of another conversation.")
    return record
  }

  const put = <T extends GitOperationRecord>(record: T, patch: Partial<T>): T => {
    const moved: T = { ...record, ...patch, updatedAt: Date.now() }
    operations.set(record.id, moved)
    return moved
  }

  const commitOf = (id: string): GitCommitRecord | undefined => {
    const found = operations.get(id)
    return found && found.kind === "commit" ? found : undefined
  }

  const pushOf = (id: string): GitPushRecord | undefined => {
    const found = operations.get(id)
    return found && found.kind === "push" ? found : undefined
  }

  return {
    projectKey: () => projectKey,
    prepare: (input) => {
      const existing = commitOf(input.id)
      if (existing) return existing
      const now = Date.now()
      const record: GitCommitRecord = { ...input, fingerprint: commitFingerprint(input), state: "prepared", createdAt: now, updatedAt: now }
      operations.set(record.id, record)
      return record
    },
    preparePush: (input) => {
      const existing = pushOf(input.id)
      if (existing) return existing
      const now = Date.now()
      const record: GitPushRecord = { ...input, fingerprint: pushFingerprint(input), state: "prepared", createdAt: now, updatedAt: now }
      operations.set(record.id, record)
      return record
    },
    get: (id) => operations.get(id),
    commitRecord: commitOf,
    pushRecord: pushOf,
    byInvocation: (invocationId) => [...operations.values()].find((record) => record.invocationId === invocationId),
    byFingerprint: (fingerprint, exceptId) => [...operations.values()].filter((record): record is GitCommitRecord => record.kind === "commit" && record.fingerprint === fingerprint && record.id !== exceptId)[0],
    byPushFingerprint: (fingerprint, exceptId) => [...operations.values()].filter((record): record is GitPushRecord => record.kind === "push" && record.fingerprint === fingerprint && record.id !== exceptId)[0],
    transition: (id, to, byInvocationId, outcome) => {
      const found = operations.get(id)
      if (!found) return refuse("git_transaction_unknown", `Operation ${id} is not one this store prepared`, "Nothing ran. Prepare the operation first, then settle it by its own id.")
      const held = ownedBy(found, byInvocationId)
      if ("code" in held) return held
      if (!tableOf(held).includes(to))
        return refuse("git_transaction_bad_transition", `${kindWord(held)} refused: ${held.state} cannot move to ${to}`, `A ${held.kind} record moves through ${tableOf(held).join(", ")}. Nothing ran.`)
      return put(held, { state: to, ...(outcome === undefined ? {} : { outcome }) })
    },
    setCommitSha: (id, sha, byInvocationId) => {
      const found = commitOf(id)
      if (!found) return refuse("git_transaction_unknown", `Commit refused: ${id} is not a commit this store prepared`, "Nothing ran.")
      const held = ownedBy(found, byInvocationId)
      if ("code" in held) return held
      return put(held, { commitSha: sha })
    },
    setRemoteSha: (id, remoteSha, byInvocationId) => {
      const found = pushOf(id)
      if (!found) return refuse("git_transaction_unknown", `Push refused: ${id} is not a push this store prepared`, "Nothing ran.")
      const held = ownedBy(found, byInvocationId)
      if ("code" in held) return held
      return put(held, { actualRemoteSha: remoteSha })
    },
    records: () => [...operations.values()],
    describe: (id) => {
      const record = operations.get(id)
      if (!record) return `${id}: no prepared operation was recorded`
      const who = [
        `operation ${record.id}`, `invocation ${record.invocationId}`, `kind=${record.kind}`, `state=${record.state}`,
        `project=${record.projectKey || "unkeyed"}`, record.repositoryTop, `conversation=${record.conversationId ?? "none"}`,
        `task=${record.taskId ?? "none"}`, `execution=${record.executionId ?? "none"}`, `host=${record.hostKey ?? "none"}`,
        `model=${record.model ? `${record.model.provider ?? "?"}/${record.model.name ?? "?"}` : "not named by the host"}`,
        `head=${record.headBefore ?? "unborn"}`, `branch=${record.branchBefore ?? "detached"}`
      ]
      if (record.kind === "commit") {
        const scope = `${record.entries.length} ${record.entries.length === 1 ? "file" : "files"}`
        return [...who, `scope=${scope}`, `diff=${record.selectedDiffSha256}`, `tree=${record.alternateTree}`, `index=${record.realIndexDigest}`, record.attribution.basis].join(" ")
      }
      return [...who, `destination=${record.remote}/${record.branch}`, `upstream=${record.setUpstream}`, `force=${record.force}`, `commit=${record.commitSha}`, `ref_expected=${record.expectedRemoteSha ?? "none"}`, `ref_actual=${record.actualRemoteSha ?? "not read"}`].join(" ")
    }
  }
}

/** The compact model-visible readings Stage 4 answers with, in the shape §7.3 gives them. */
export interface GitPreparedReading {
  kind: "git_commit_prepared"
  succeeded: true
  operationId: string
  invocationId?: string
  head: string | null
  selectedFiles: string[]
  selectedDiffSha256: string
  empty: boolean
  realIndexPreserved: boolean
  requiresCommitApproval: boolean
  /** How each path was allowed into the commit; nothing here claims an owner it cannot prove. */
  entries?: { path: string; source: string; basis: string }[]
  /** Where the permission for this call came from, named so a reading says what it did not do. */
  basis?: string
}

export interface GitCommitReading {
  kind: "git_commit"
  succeeded: true
  operationId: string
  state: GitTransactionState
  commit?: {
    sha: string
    parents: string[]
    tree: string
    author: CommitAttribution["author"]
    committer: CommitAttribution["committer"]
    coAuthors: CommitAttribution["coAuthors"]
    message: string
    files: string[]
  }
  /** A duplicate call answers with the state it already had; it never creates a second commit. */
  duplicate?: boolean
  basis?: string
}

/** A push reading, in the shape §7.4 gives it: what was published, where, and what the ref held before and after. The remote is printed as it may be shown, with no credential. */
export interface GitPushReading {
  kind: "git_push"
  succeeded: true
  operationId: string
  state: GitTransactionState
  remote: string
  branch: string
  commitSha: string
  expectedRemoteSha: string | null
  actualRemoteSha: string | null
  setUpstream: boolean
  /** What was read, in the order recovery reads it; nothing here is decided from an exit code or a timeout. */
  inspected: string
  duplicate?: boolean
  basis?: string
}

export interface GitRecoveredReading {
  kind: "git_recovered"
  succeeded: true
  operationId: string
  state: GitTransactionState
  /** What was read, in the order recovery reads it: nothing is decided from an exit code alone. */
  inspected: string
  commit?: { sha: string; parents: string[]; tree: string }
  reason?: string
  /** For a push record: the destination it publishes to and what its ref holds now, as it was read. */
  destination?: { remote: string; branch: string }
  remoteSha?: string | null
}

/** The id a call did not name is the store's own, so a later reading can tie a record to it. */
export const operationIdOf = (named?: string): string => (typeof named === "string" && named.trim() ? named.trim() : randomUUID())