/**
 * Stage 4's commit transaction (§10.2 and §11.3 of the design): one record per prepared operation, the states
 * it may move through, and recovery that reads repository state instead of trusting an exit code or a timeout.
 * A successful commit is never repeated because a tool response was lost; a retry by operation ID is an
 * idempotent status check, and no empty commit is manufactured.
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

/** The operations the transaction table names. Push is recorded by Stage 5; this stage creates no push record. */
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
  kind: GitTransactionKind
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
  state: GitTransactionState
  outcome?: string
  createdAt: number
  updatedAt: number
}

/** What a call names when it prepares an operation. `id` and `fingerprint` are the store's own. */
export type NewCommitRecord = Omit<GitCommitRecord, "fingerprint" | "state" | "createdAt" | "updatedAt">

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

/** One record per prepared operation, keyed by id and by invocation as the schema's UNIQUE does. */
export interface GitTransactionStore {
  projectKey(): string
  /** Records a prepared operation before commit dispatch. A second call for the same invocation answers with the record it already has. */
  prepare(input: NewCommitRecord): GitCommitRecord
  get(id: string): GitCommitRecord | undefined
  byInvocation(invocationId: string): GitCommitRecord | undefined
  /** Another record with the same commit intent, so a second operation cannot claim it. */
  byFingerprint(fingerprint: string, exceptId?: string): GitCommitRecord | undefined
  /** Compare-and-set on the state alone, as §11.1 requires. */
  transition(id: string, to: GitTransactionState, byInvocationId: string, outcome?: string): GitCommitRecord | GitRefusal
  records(): GitCommitRecord[]
  /** The line a diagnostic may print: names, digests and states, never a credential value. */
  describe(id: string): string
}

export const createGitTransactionStore = (projectKey = ""): GitTransactionStore => {
  const operations = new Map<string, GitCommitRecord>()

  return {
    projectKey: () => projectKey,
    prepare: (input) => {
      const existing = operations.get(input.id)
      if (existing) return existing
      const now = Date.now()
      const record: GitCommitRecord = { ...input, fingerprint: commitFingerprint(input), state: "prepared", createdAt: now, updatedAt: now }
      operations.set(record.id, record)
      return record
    },
    get: (id) => operations.get(id),
    byInvocation: (invocationId) => [...operations.values()].find((record) => record.invocationId === invocationId),
    byFingerprint: (fingerprint, exceptId) => [...operations.values()].find((record) => record.fingerprint === fingerprint && record.id !== exceptId),
    transition: (id, to, byInvocationId, outcome) => {
      const record = operations.get(id)
      if (!record) return refuse("git_transaction_unknown", `Commit refused: operation ${id} is not one this stage prepared`, "Nothing ran. Prepare the operation before a commit, and recover it by its own id.")
      // One invocation owns one operation and its terminal state: another conversation may read a project
      // operation, but it cannot replay or re-own a record this invocation prepared.
      if (record.invocationId !== byInvocationId)
        return refuse("git_transaction_other_conversation", `Commit refused: operation ${id} belongs to ${record.invocationId}`, "A conversation may inspect a project operation; it may not replay or re-own another conversation's prepared operation.")
      if (!COMMIT_TRANSITIONS[record.state].includes(to))
        return refuse("git_transaction_bad_transition", `Commit refused: ${record.state} cannot move to ${to}`, `A commit record moves through ${COMMIT_TRANSITIONS[record.state].join(", ")}. Nothing ran.`)
      const now = Date.now()
      const moved: GitCommitRecord = { ...record, state: to, ...(outcome === undefined ? {} : { outcome }), updatedAt: now }
      operations.set(id, moved)
      return moved
    },
    records: () => [...operations.values()],
    describe: (id) => {
      const record = operations.get(id)
      if (!record) return `${id}: no prepared operation was recorded`
      const scope = `${record.entries.length} ${record.entries.length === 1 ? "file" : "files"}`
      return [
        `operation ${record.id}`, `invocation ${record.invocationId}`, `kind=${record.kind}`, `state=${record.state}`,
        `project=${record.projectKey || "unkeyed"}`, record.repositoryTop, `conversation=${record.conversationId ?? "none"}`,
        `task=${record.taskId ?? "none"}`, `execution=${record.executionId ?? "none"}`, `host=${record.hostKey ?? "none"}`,
        `model=${record.model ? `${record.model.provider ?? "?"}/${record.model.name ?? "?"}` : "not named by the host"}`,
        `head=${record.headBefore ?? "unborn"}`, `branch=${record.branchBefore ?? "detached"}`,
        `scope=${scope}`, `diff=${record.selectedDiffSha256}`, `tree=${record.alternateTree}`, `index=${record.realIndexDigest}`,
        `${record.attribution.basis}`
      ].join(" ")
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

export interface GitRecoveredReading {
  kind: "git_recovered"
  succeeded: true
  operationId: string
  state: GitTransactionState
  /** What was read, in the order recovery reads it: nothing is decided from an exit code alone. */
  inspected: string
  commit?: { sha: string; parents: string[]; tree: string }
  reason?: string
}

/** The id a call did not name is the store's own, so a later reading can tie a record to it. */
export const operationIdOf = (named?: string): string => (typeof named === "string" && named.trim() ? named.trim() : randomUUID())