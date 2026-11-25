/**
 * Stage 2's session ownership index (§8.2 of the design): which change on a path came from whom, read
 * only from host facts. It is fed by what the edit tools recorded, what a command snapshot showed before
 * and after, what the source-event infrastructure reported as a save, and what a native Git operation
 * moved. It never matches text, never asks the model who wrote something, and refuses any claim that is
 * not host-derived: what it cannot prove stays `unknown`, and a file whose ownership is unknown is split
 * where a verified hunk allows it or needs an explicit authorship choice otherwise.
 *
 * Two rules hold throughout. A path that was already changed when the baseline was taken is never agent
 * owned by itself — the session did not make that change. And a fact that lands on a path the index
 * already knows, from a state the index cannot match, is recorded as an unexplained gap rather than
 * quietly attributed to whoever spoke last. Both rules are what keeps a commit from claiming work that
 * was not Moriarty's, which is what Stage 4 stages against this index. A fact that restates a change
 * the index already knew from another host source confirms what was known instead of opening a gap.
 *
 * The index is per conversation: it is built from one session baseline and never reads another
 * conversation's facts, so two conversations working in the same repository keep two separate ownership
 * readings. Digests are compared as the host measures them (`contentDigest` in `baseline.ts`, the same
 * shape `editDigest` gives), never as text.
 */
import path from "node:path"

import type { TreeChange, TreeSnapshot } from "../chat/command-snapshot"
import type { ChangeRecord } from "../chat/reply-changes"
import type { EditOperationInput } from "../todos/types"

import { contentDigest, GitBaselineStore, GitRefusal, GitSessionCapture, GitSessionHost, refuse } from "./baseline"

export type OwnershipClass = "agent" | "human" | "external" | "mixed" | "unknown"
export type OwnershipConfidence = "verified" | "known" | "uncertain"

/** The host sources that can say who changed a path. A claim from anywhere else is not taken. */
export const HOST_PROVENANCES = ["native_edit", "edit_ledger", "command_snapshot", "source_save", "git_operation"] as const
export type OwnershipProvenance = (typeof HOST_PROVENANCES)[number]

/** What each host source proves, and what it cannot. */
export const OWNERSHIP_OF_PROVENANCE: Record<OwnershipProvenance, OwnershipClass> = {
  /** The edit tools touched the file themselves and kept what it was before. */
  native_edit: "agent",
  /** The apply-mode edit ledger recorded this operation's own pre/post digests. */
  edit_ledger: "agent",
  /** A command the agent ran, read from the tree before and after it. */
  command_snapshot: "agent",
  /** A save the editor reported: the user, or something outside the session. */
  source_save: "external",
  /** A Git operation moves content that was already there; it does not make Moriarty its owner. */
  git_operation: "external"
}

/** One hunk the host can name. A hunk is only claimed when its own evidence carries it. */
export interface GitHunkOwnership {
  path: string
  startLine?: number
  endLine?: number
  ownership: OwnershipClass
  confidence: OwnershipConfidence
  digest?: string
}

/** What the index can say about one path. */
export interface GitOwnershipChange {
  path: string
  ownership: OwnershipClass
  confidence: OwnershipConfidence
  /** The state the change came from: what the baseline read, or what the first fact found. */
  preDigest?: string
  /** What the last host fact left, when it could name it. */
  postDigest?: string
  hunks?: GitHunkOwnership[]
}

/** One change the host saw. Every field is what the host recorded at the time it ran. */
export interface HostChangeFact {
  conversationId: string
  /** Repository-relative, or the absolute file the host has. One of the two must be given. */
  path?: string
  file?: string
  provenance: string
  preDigest?: string
  postDigest?: string
  executionId?: string
  sourceObservationId?: string
  /** Host-derived provenance only. A model name is never an owner. */
  model?: GitSessionHost["model"]
  hunks?: GitHunkOwnership[]
  /** The two trees a command-snapshot fact was read from, so a later stage can name them. */
  beforeSnapshot?: string
  afterSnapshot?: string
  /** When the host saw it, so order is kept without guessing from the clock alone. */
  at?: number
}

/** A fact that names a claim the host did not see is refused, and nothing is inferred from it. */
export type OwnershipRefusalCode =
  | "git_ownership_not_host_derived"
  | "git_ownership_path_outside_repository"
  | "git_ownership_other_conversation"
  | "git_baseline_missing"
  | "git_mixed_ownership"
  | "git_ownership_unknown"
  | "git_not_agent_owned"
  | "git_hunk_selection_required"

/** What the index says about one path before a whole file may be claimed. */
export type ClaimDecision = { allowed: true; change: GitOwnershipChange } | GitRefusal
export type SplitDecision = { allowed: true; hunks: GitHunkOwnership[] } | GitRefusal

/** One fact that names what was already there at capture time refines the starting change. */
interface OwnershipPart {
  origin: OwnershipProvenance | "baseline" | "unexplained"
  ownership: OwnershipClass
  confidence: OwnershipConfidence
  preDigest?: string
  postDigest?: string
  executionId?: string
  sourceObservationId?: string
  model?: GitSessionHost["model"]
  beforeSnapshot?: string
  afterSnapshot?: string
  hunks?: GitHunkOwnership[]
  at: number
}

/** A path that gained a change, and what the index knew before it. */
export interface OwnershipTransition {
  path: string
  /** `clean` when nothing was known for the path before this fact. */
  from: OwnershipClass | "clean"
  to: OwnershipClass
  kind: "clean_to_dirty" | "dirty_to_mixed" | "same_owner" | "unexplained_gap"
  origin: OwnershipProvenance | "baseline" | "unexplained"
  confidence: OwnershipConfidence
}

const RANK: Record<OwnershipConfidence, number> = { verified: 2, known: 1, uncertain: 0 }
const weakest = (parts: OwnershipPart[]): OwnershipConfidence => {
  let best: OwnershipConfidence = "verified"
  for (const part of parts) if (RANK[part.confidence] < RANK[best]) best = part.confidence
  return best
}

/**
 * How firmly one fact proves its own change: both sides it read, or the pair of trees a command
 * snapshot compared. A fact that names one side only is `known`; what no host source can name stays
 * `unknown`, and nothing here raises a fact to `verified` by guessing the other side.
 */
const confidenceOf = (fact: HostChangeFact): OwnershipConfidence => {
  if (fact.preDigest !== undefined && fact.postDigest !== undefined) return "verified"
  // The two trees are what the host read, so a snapshot that names one side still proves both.
  if (fact.beforeSnapshot !== undefined && fact.afterSnapshot !== undefined && (fact.preDigest !== undefined || fact.postDigest !== undefined)) return "verified"
  return "known"
}

/** The host fact as the index reads it. A fact is accepted only when its source is one of the host's own. */
const accept = (fact: HostChangeFact): OwnershipProvenance | GitRefusal =>
  HOST_PROVENANCES.includes(fact.provenance as OwnershipProvenance) ? (fact.provenance as OwnershipProvenance) :
    refuse("git_ownership_not_host_derived", "Ownership refused: the claim is not host-derived", `"${fact.provenance}" is not one of ${HOST_PROVENANCES.join(", ")}. The index does not infer an owner from text, from a model name or from a claim the host did not see.`)

export interface GitOwnershipIndex {
  conversationId: string
  sessionId: string
  repositoryTop: string
  /** Records one host fact. A fact that cannot be matched to what the index already knew is recorded as unknown. */
  note(fact: HostChangeFact): GitOwnershipChange | GitRefusal
  change(pathOrFile: string): GitOwnershipChange | undefined
  changes(): GitOwnershipChange[]
  /** Whether a whole file may be claimed as Moriarty's own work, as §8.3 requires. */
  claimFor(pathOrFile: string): ClaimDecision
  /** Where a mixed file can be split on verified hunks alone. */
  splitFor(pathOrFile: string): SplitDecision
  transitions(): OwnershipTransition[]
}

/** One index per conversation, seeded with that conversation's baseline. */
export const createGitOwnershipIndex = (capture: GitSessionCapture): GitOwnershipIndex => {
  const starting = new Map<string, OwnershipPart>()
  for (const entry of [...capture.baseline.staged, ...capture.baseline.unstaged]) {
    // A path the baseline found changed is not agent-owned by itself. It is named only when a host fact names it.
    starting.set(entry.path, { origin: "baseline", ownership: "unknown", confidence: "known", postDigest: entry.digest, at: capture.capturedAt })
  }
  const facts = new Map<string, OwnershipPart[]>()
  const transitions: OwnershipTransition[] = []

  /** Repository-relative, as git names the path; anything outside this session's repository is refused. */
  const resolve = (named: string): string | GitRefusal => {
    if (!named) return refuse("git_ownership_no_path", "Ownership refused: no path was named", "The index answers for one path at a time, as the repository names it.")
    const absolute = path.isAbsolute(named) ? path.normalize(named) : path.resolve(capture.baseline.repositoryTop, named)
    const relative = path.relative(capture.baseline.repositoryTop, absolute)
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
      return refuse("git_ownership_path_outside_repository", `Ownership refused: ${named} is not inside ${capture.baseline.repositoryTop}`, "The session's baseline belongs to one repository. Nothing was recorded for a path outside it.")
    return relative.split(path.sep).join("/")
  }

  const partsOf = (relative: string): OwnershipPart[] => {
    const start = starting.get(relative)
    const noted = facts.get(relative) ?? []
    return start === undefined ? [...noted] : [start, ...noted]
  }

  const answer = (relative: string): GitOwnershipChange | undefined => {
    const parts = partsOf(relative)
    if (!parts.length) return undefined
    const owners = new Set(parts.map((part) => part.ownership))
    const sortedParts = [...parts].sort((a, b) => a.at - b.at)
    const hunks = sortedParts.flatMap((part) => part.hunks ?? [])
    const change: GitOwnershipChange = {
      path: relative,
      ownership: owners.size === 1 ? [...owners][0] : "mixed",
      confidence: weakest(sortedParts),
      ...(hunks.length ? { hunks } : {})
    }
    const from = sortedParts.find((part) => part.preDigest !== undefined)?.preDigest
    if (from !== undefined) change.preDigest = from
    const to = [...sortedParts].reverse().find((part) => part.postDigest !== undefined)?.postDigest
    if (to !== undefined) change.postDigest = to
    return change
  }

  const claimRefusal = (change: GitOwnershipChange): ClaimDecision => {
    if (change.ownership === "mixed")
      return refuse("git_mixed_ownership", "Commit refused: ownership is mixed", `${change.path} holds more than one owner's work (${partsOf(change.path).map((part) => `${part.origin}:${part.ownership}`).join(", ")}). Select hunks or choose an explicit authorship policy.`)
    if (change.ownership === "unknown" || change.confidence === "uncertain")
      return refuse("git_ownership_unknown", "Commit refused: ownership is unknown", `${change.path} cannot be claimed: the index has no host fact that proves who changed it, and nothing here infers one. Select hunks or state an explicit authorship.`)
    if (change.ownership !== "agent")
      return refuse("git_not_agent_owned", "Commit refused: the file is not Moriarty's own work", `${change.path} is ${change.ownership}-owned. Only wholly agent-owned files may be staged automatically.`)
    return { allowed: true, change }
  }

  return {
    conversationId: capture.conversationId,
    sessionId: capture.baseline.id,
    repositoryTop: capture.baseline.repositoryTop,
    note: (fact) => {
      if (fact.conversationId !== capture.conversationId)
        return refuse("git_ownership_other_conversation", `Ownership refused: the fact belongs to ${fact.conversationId}`, `This index is ${capture.conversationId}'s. A conversation may not re-own another conversation's baseline.`)
      const provenance = accept(fact)
      if (typeof provenance !== "string") return provenance
      const relative = resolve(fact.path ?? fact.file ?? "")
      if (typeof relative !== "string") return relative
      const at = fact.at ?? Date.now()
      const known = partsOf(relative)
      const last = known[known.length - 1]
      const before = answer(relative)
      // A fact that starts from a state the index already knew for this path is not a gap: it restates the
      // same change read from another host source. Only a state nobody named counts as a gap.
      const knownStates = known.flatMap((part) => [part.preDigest, part.postDigest]).filter((digest) => digest !== undefined)
      const gap = fact.preDigest !== undefined && knownStates.length > 0 && !knownStates.includes(fact.preDigest)
      // A fact that names what the baseline already had says who made the starting change; it does not add one.
      if (!gap && last?.origin === "baseline" && fact.preDigest === undefined && fact.postDigest === last.postDigest) {
        last.origin = provenance
        last.ownership = provenance === "source_save" ? "human" : OWNERSHIP_OF_PROVENANCE[provenance]
        transitions.push({ path: relative, from: before?.ownership ?? "clean", to: answer(relative)!.ownership, kind: "same_owner", origin: provenance, confidence: answer(relative)!.confidence })
        return answer(relative)!
      }
      if (gap) {
        // The file held something else before this fact, and no host source says who put it there.
        facts.set(relative, [...(facts.get(relative) ?? []), { origin: "unexplained", ownership: "unknown", confidence: "uncertain", at: last!.at, ...(last.postDigest !== undefined ? { postDigest: last.postDigest } : {}) }])
      }
      const part: OwnershipPart = {
        origin: provenance,
        ownership: OWNERSHIP_OF_PROVENANCE[provenance],
        confidence: confidenceOf(fact),
        at,
        ...(fact.preDigest !== undefined ? { preDigest: fact.preDigest } : {}),
        ...(fact.postDigest !== undefined ? { postDigest: fact.postDigest } : {}),
        ...(fact.executionId !== undefined ? { executionId: fact.executionId } : {}),
        ...(fact.sourceObservationId !== undefined ? { sourceObservationId: fact.sourceObservationId } : {}),
        ...(fact.model !== undefined ? { model: fact.model } : {}),
        ...(fact.beforeSnapshot !== undefined || fact.afterSnapshot !== undefined ? { beforeSnapshot: fact.beforeSnapshot, afterSnapshot: fact.afterSnapshot } : {}),
        ...(fact.hunks?.length ? { hunks: fact.hunks.map((hunk) => ({ ...hunk, path: relative })) } : {})
      }
      facts.set(relative, [...(facts.get(relative) ?? []), part])
      const after = answer(relative)!
      const kind = before === undefined ? "clean_to_dirty" : gap ? "unexplained_gap" : before.ownership !== after.ownership ? "dirty_to_mixed" : "same_owner"
      transitions.push({ path: relative, from: before?.ownership ?? "clean", to: after.ownership, kind, origin: provenance, confidence: after.confidence })
      return after
    },
    change: (pathOrFile) => {
      const relative = resolve(pathOrFile)
      return typeof relative === "string" ? answer(relative) : undefined
    },
    changes: () => [...new Set([...starting.keys(), ...facts.keys()])].sort().map((relative) => answer(relative)!).filter(Boolean),
    claimFor: (pathOrFile) => {
      const relative = resolve(pathOrFile)
      if (typeof relative !== "string") return relative
      const change = answer(relative)
      if (!change) return refuse("git_ownership_unknown", "Commit refused: ownership is unknown", `${relative} has no host fact and was not changed when the session started, so nothing here can say who owns it.`)
      return claimRefusal(change)
    },
    splitFor: (pathOrFile) => {
      const relative = resolve(pathOrFile)
      if (typeof relative !== "string") return relative
      const change = answer(relative)
      if (!change) return refuse("git_ownership_unknown", "Commit refused: ownership is unknown", `${relative} has no host fact and was not changed when the session started, so nothing here can say who owns it.`)
      const hunks = change.hunks ?? []
      if (!hunks.length) return refuse("git_hunk_selection_required", "Commit refused: no hunk evidence for this file", `${change.path} is ${change.ownership}-owned and the edit evidence names no hunks for it, so it cannot be split. Choose an explicit authorship policy.`)
      const unverified = hunks.filter((hunk) => hunk.ownership !== "agent" || hunk.confidence === "uncertain")
      if (unverified.length) return refuse("git_hunk_selection_required", "Commit refused: not every hunk is verified agent work", `${change.path} has ${hunks.length} hunks; ${unverified.map((hunk) => `${hunk.ownership}/${hunk.confidence}`).join(", ")} cannot be claimed without an explicit authorship policy.`)
      return { allowed: true, hunks }
    },
    transitions: () => [...transitions]
  }
}

/** The indexes, one per conversation, built on the baselines the store captured. */
export interface GitOwnershipStore {
  /** The index for one conversation; a conversation with no baseline gets no ownership claims at all. */
  for(conversationId: string): GitOwnershipIndex | GitRefusal
  indexes(): GitOwnershipIndex[]
}

export const createGitOwnershipStore = (baselines: GitBaselineStore): GitOwnershipStore => {
  const indexes = new Map<string, GitOwnershipIndex>()
  return {
    for: (conversationId) => {
      const known = indexes.get(conversationId)
      if (known) return known
      const capture = baselines.capturedFor(conversationId)
      if (!capture) return refuse("git_baseline_missing", `Ownership refused: no baseline was captured for ${conversationId}`, "Nothing can be claimed without what the session started with. Capture the baseline at conversation start.")
      const index = createGitOwnershipIndex(capture)
      indexes.set(conversationId, index)
      return index
    },
    indexes: () => [...indexes.values()]
  }
}

/** The adapters that feed the index from the change evidence that already exists. Each one carries only what its source actually saw. */

/** One apply-mode edit operation, as `chat/tool-sinks.ts` records it. `file` is the absolute path the sink held. */
export const factFromEditOperation = (
  conversationId: string,
  operation: Omit<EditOperationInput, "itemId" | "ownerId">,
  file: string,
  host: GitSessionHost = {}
): HostChangeFact => ({
  conversationId,
  file,
  provenance: "edit_ledger",
  preDigest: operation.preDigest,
  postDigest: operation.postDigest,
  ...(host.model !== undefined ? { model: host.model } : {})
})

/** What one reply changed, as `chat/reply-changes.ts` keeps it: the first copy is what the reply found. */
export const factsFromReplyChangeRecord = (record: ChangeRecord, conversationId: string, host: GitSessionHost = {}): HostChangeFact[] =>
  record.files.map((file) => ({
    conversationId,
    file: path.join(record.root, ...file.path.split("/")),
    provenance: "native_edit",
    ...(file.before === null || file.before === undefined ? {} : { preDigest: contentDigest(file.before) }),
    ...(file.afterHash !== null && file.afterHash !== undefined ? { postDigest: file.afterHash } : {}),
    ...(host.model !== undefined ? { model: host.model } : {})
  }))

/** What a command the agent ran changed, read from the two snapshots of the same tree. */
export const factsFromCommandSnapshot = (
  before: TreeSnapshot,
  after: TreeSnapshot,
  changes: TreeChange[],
  conversationId: string,
  host: GitSessionHost = {}
): HostChangeFact[] =>
  changes.map((change) => ({
    conversationId,
    file: change.file,
    provenance: "command_snapshot",
    beforeSnapshot: before.tree,
    afterSnapshot: after.tree,
    ...(change.before === null || change.before === undefined ? {} : { preDigest: contentDigest(change.before) }),
    ...(host.model !== undefined ? { model: host.model } : {})
  }))

/** A save the source-event infrastructure reported, which no tool of the session made. */
export const factFromSourceSave = (file: string, conversationId: string, digestAfter: string, host: GitSessionHost = {}): HostChangeFact => ({
  conversationId,
  file,
  provenance: "source_save",
  postDigest: digestAfter,
  ...(host.model !== undefined ? { model: host.model } : {})
})
