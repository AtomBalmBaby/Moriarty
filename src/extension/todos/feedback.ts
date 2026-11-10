import { createHash, randomUUID } from "node:crypto"

import { logger, redact } from "../../common/logger"
import type { ReplyChangesView, SourceIdentity, TodoCriterionReconciliation, TodoEvaluation, TodoEvaluationCriterion, TypedCriterion, WorkspaceMutationOperation } from "../../common/types"
import { verifyContentFingerprint } from "../tools/fingerprint"

import { codeIdentifiers, commandDigest, samePath } from "./evidence"
import { type AcceptedFact, type CriterionVerification, type IntentPlanContext, type RequirementActivation, type RetainedObservationEvidence, type TodoReviewPackage } from "./types"

/** A task needs a successful workspace change only when its typed contract says so. Wording is never read. */
export const taskRequiresWorkspaceChanges = (criteria: readonly TypedCriterion[]): boolean =>
  criteria.some((criterion) => criterion.verification.kind === "workspace_mutation")

const decisions = new Set(["accept", "revise", "needs_evidence", "blocked"])
const criterionStatuses = new Set(["passed", "failed", "unverified"])
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
export type EvaluationValidationCode = "empty_response" | "malformed_json" | "missing_field" | "schema_version" | "task_id" | "decision" | "invalid_shape"

export class TodoEvaluationProviderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TodoEvaluationProviderError"
  }
}

export class TodoEvaluationValidationError extends Error {
  constructor(
    readonly code: EvaluationValidationCode,
    message: string,
    readonly expected?: unknown,
    readonly received?: unknown,
    readonly field?: string
  ) {
    super(message)
    this.name = "TodoEvaluationValidationError"
  }
}

const invalid = (code: EvaluationValidationCode, message: string, expected?: unknown, received?: unknown, field?: string): never => {
  throw new TodoEvaluationValidationError(code, message, expected, received, field)
}

const extractJsonObject = (raw: string): string => {
  const fenced = raw.match(/\x60{3}(?:json)?\s*([\s\S]*?)\x60{3}/i)
  if (fenced) return fenced[1].trim()
  const start = raw.indexOf("{")
  if (start < 0) return raw.trim()
  let depth = 0
  let quoted = false
  let escaped = false
  for (let index = start; index < raw.length; index++) {
    const character = raw[index]
    if (quoted) {
      if (escaped) escaped = false
      else if (character === "\\") escaped = true
      else if (character === "\"") quoted = false
      continue
    }
    if (character === "\"") quoted = true
    else if (character === "{") depth++
    else if (character === "}" && --depth === 0) return raw.slice(start, index + 1)
  }
  return raw.slice(start).trim()
}
const boundedStrings = (value: unknown, limit: number, entryLimit: number, field: string): string[] => {
  if (!Array.isArray(value)) throw new TodoEvaluationValidationError("invalid_shape", `${field} must be an array of strings`, "string[]", typeof value, field)
  if (value.length > entryLimit) invalid("invalid_shape", `${field} exceeds the ${entryLimit}-entry limit`, entryLimit, value.length, field)
  const entries: unknown[] = value
  return entries.map((entry, index) => {
    const entryField = `${field}[${index}]`
    if (typeof entry !== "string") throw new TodoEvaluationValidationError("invalid_shape", `${entryField} must be a string`, "string", typeof entry, entryField)
    if (!entry.trim()) throw new TodoEvaluationValidationError("invalid_shape", `${entryField} must not be empty`, "non-empty string", entry, entryField)
    if (entry.length > limit) throw new TodoEvaluationValidationError("invalid_shape", `${entryField} exceeds the ${limit}-character limit`, limit, entry.length, entryField)
    return entry.trim()
  })
}

const exactKeys = (value: Record<string, unknown>, expected: string[], field: string) => {
  const unexpected = Object.keys(value).find((key) => !expected.includes(key))
  if (unexpected) invalid("invalid_shape", `${field}.${unexpected} is not part of the evaluation schema`, expected, unexpected, `${field}.${unexpected}`)
}

const preserveObservationSet = (review: TodoReviewPackage) => {
  const seen = new Set<string>()
  const unique = review.observations.filter((observation) => {
    if (seen.has(observation.id)) return false
    seen.add(observation.id)
    return true
  })
  const score = (observation: TodoReviewPackage["observations"][number]) => {
    const tool = observation.toolName.toLowerCase()
    const category = /rollback|recovery/.test(tool) ? 500
      : /diagnostic|problem/.test(tool) ? 400
      : tool === "run_command" ? 300
      : /edit|write|create|delete|move|rename/.test(tool) ? 200
      : /read|search|find|grep|symbol|definition|reference/.test(tool) ? 100
      : 0
    return category
  }
  return unique
    .map((observation, index) => ({ observation, index, score: score(observation) }))
    .sort((left, right) => right.score - left.score
      || left.observation.createdAt.localeCompare(right.observation.createdAt)
      || right.index - left.index)
    .slice(0, 80)
    .map(({ observation }) => observation)
}

const MAX_SHARED_OBSERVATIONS = 40

/**
 * Observations from other tasks on the active plan that this review may cite. The payload and the
 * citation check both use this set, so a reference is valid only when the evaluator was shown that record.
 */
const sharedObservationRecords = (review: TodoReviewPackage, visible: TodoReviewPackage["observations"]) =>
  review.retainedEvidence
    .filter((record) => record.itemId !== review.task.id && !visible.some((observation) => observation.id === record.observationId))
    .slice(0, MAX_SHARED_OBSERVATIONS)
    .map((record) => ({ id: record.observationId, taskId: record.itemId, toolName: record.toolName, arguments: record.arguments, failed: record.failed, exitCode: record.exitCode }))

const FILE_CREATE_TOOLS = ["create_file"]
const FILE_EDIT_TOOLS = ["edit_lines", "edit_file"]
const FILE_DELETE_TOOLS = ["delete_file"]
const MUTATING_TOOLS = [...FILE_CREATE_TOOLS, ...FILE_EDIT_TOOLS, ...FILE_DELETE_TOOLS]
const OPERATION_TOOLS: Record<WorkspaceMutationOperation, readonly string[]> = { create: FILE_CREATE_TOOLS, edit: FILE_EDIT_TOOLS, delete: FILE_DELETE_TOOLS }

/** Host-recorded tool facts usable as evidence, whether captured for this task or a sibling. */
export interface TrustedObservationRef {
  id: string
  toolName: string
  arguments: Record<string, string>
  failed: boolean
  exitCode?: number
}

/**
 * Whether the host proved a criterion from trusted observations it cites. Keyed by the reconciliation's
 * criterion outcome and cited observation IDs, never by the criterion's wording.
 */
export const criterionProvenBy = (
  reconciliation: TodoCriterionReconciliation | undefined,
  observations: TrustedObservationRef[]
): boolean => reconciliation?.outcome === "proven"
  && reconciliation.supportingObservationIds.length > 0
  && reconciliation.supportingObservationIds.every((id) => observations.some((observation) => observation.id === id && !observation.failed))

/** Returns the current text of a workspace file, or undefined when it cannot be read. */
export type CurrentSourceReader = (path: string) => Promise<string | undefined>

/** Bumped when the deterministic rules change, so stored outcomes can be told apart. */
export const RECONCILIATION_VERSION = 1

/** Evaluator identity recorded when the host decides a review without Feedback. */
export const DETERMINISTIC_EVALUATOR = "host:deterministic"

/** A criterion's outcome before the host attaches the criterion ID it answers. */
type CriterionOutcome = Omit<TodoCriterionReconciliation, "criterionId">

const reconciled = (
  outcome: TodoCriterionReconciliation["outcome"],
  supportingObservationIds: string[],
  missing: string[]
): CriterionOutcome => ({
  outcome,
  supportingObservationIds: [...new Set(supportingObservationIds)],
  missing,
  version: RECONCILIATION_VERSION
})

const NUMBERED_SOURCE_LINE = /^(\d+): (.*)$/


const indentOf = (text: string): number => text.length - text.trimStart().length

const NAME_PROPERTY_LINE = /\bname\s*:\s*["'`]([A-Za-z_$][\w$-]*)["'`]/
const DECLARATION_LINE = /^\s*(?:export\s+)?(?:async\s+)?(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)\b/
const DECLARATION_SEARCH_LINES = 40

/**
 * Tool registrations (`name: "read_file"`) paired with the declaration that encloses them.
 * Walking upward, each step must reach a strictly shallower line, so the first declaration
 * reached is the enclosing one, not a sibling above it. Both lines must be inside the read's
 * captured range. The pairing is a source-shape heuristic, so it is only stored with the
 * fingerprint of the file it was read from.
 */
const implementationAliases = (record: RetainedObservationEvidence): Array<{ tool: string; implementation: string; startLine: number; registrationLine: number }> => {
  if (!record.content) return []
  const ranges = record.sources
    .filter((source) => source.startLine !== undefined && source.endLine !== undefined)
    .map((source) => [source.startLine as number, source.endLine as number])
  const inRange = (line: number): boolean => ranges.some(([start, end]) => line >= start && line <= end)
  const lines = record.content.split("\n").flatMap((line) => {
    const match = NUMBERED_SOURCE_LINE.exec(line)
    return match ? [{ line: Number(match[1]), text: match[2] }] : []
  })
  const aliases: Array<{ tool: string; implementation: string; startLine: number; registrationLine: number }> = []
  lines.forEach((registration, index) => {
    const name = NAME_PROPERTY_LINE.exec(registration.text)
    if (!name || !inRange(registration.line)) return
    let depth = indentOf(registration.text)
    for (let above = index - 1; above >= Math.max(0, index - DECLARATION_SEARCH_LINES); above--) {
      const candidate = lines[above]
      if (!candidate.text.trim() || indentOf(candidate.text) >= depth) continue
      depth = indentOf(candidate.text)
      const declaration = DECLARATION_LINE.exec(candidate.text)
      if (declaration) {
        if (inRange(candidate.line) && declaration[1] !== name[1]) aliases.push({ tool: name[1], implementation: declaration[1], startLine: candidate.line, registrationLine: registration.line })
        return
      }
    }
  })
  return aliases
}

/**
 * Whether an accepted fact is about a name a request mentions: its implementation symbol or its registered tool name.
 * This is retrieval only. Proof is decided by the criterion's declared identity in `acceptedFactOutcome` and
 * `sourceContractOutcome`, never by this helper.
 */
export const factMatchesSymbol = (candidate: AcceptedFact, symbol: string): boolean =>
  candidate.symbol === symbol || candidate.registeredTool === symbol

const cachedCurrentReader = (readCurrent?: CurrentSourceReader): ((path: string) => Promise<string | undefined>) => {
  const cache = new Map<string, Promise<string | undefined>>()
  return (path: string) => {
    if (!readCurrent) return Promise.resolve(undefined)
    let text = cache.get(path)
    if (!text) {
      text = readCurrent(path).catch(() => undefined)
      cache.set(path, text)
    }
    return text
  }
}

export interface AcceptedFactStatus {
  fact: AcceptedFact
  freshness: "current" | "historical" | "unverifiable"
  /** Why the fact no longer proves the current source; absent when current. */
  reason?: string
}

/**
 * Whether a set of matching facts names one current location. Several distinct locations are
 * ambiguous and never resolved by picking one. A single location that is historical is reported
 * as historical so the caller re-reads it rather than citing it as proof.
 */
export type AcceptedResolution = "unique" | "ambiguous" | "historical" | "none"

export const resolveAcceptedFacts = (statuses: AcceptedFactStatus[]): AcceptedResolution => {
  const live = statuses.filter((status) => !status.fact.supersededBy)
  const locations = new Set(live.map(({ fact }) => `${fact.path}:${fact.startLine}-${fact.endLine}`))
  if (locations.size === 0) return "none"
  if (locations.size > 1) return "ambiguous"
  return live.some((status) => status.freshness === "current") ? "unique" : "historical"
}

/**
 * Classifies accepted facts without changing them. Superseded and source-changed facts
 * stay in the repository as historical evidence with an explanation.
 */
export const assessAcceptedFacts = async (facts: AcceptedFact[], readCurrent?: CurrentSourceReader): Promise<AcceptedFactStatus[]> => {
  const current = cachedCurrentReader(readCurrent)
  return Promise.all(facts.map(async (fact): Promise<AcceptedFactStatus> => {
    if (fact.supersededBy) return { fact, freshness: "historical", reason: `superseded by accepted fact ${fact.supersededBy}` }
    const text = await current(fact.path)
    if (text === undefined) return { fact, freshness: "unverifiable", reason: `${fact.path} could not be read to confirm its fingerprint` }
    if (!(await verifyContentFingerprint(text, fact.sourceHash).catch(() => false))) {
      return { fact, freshness: "historical", reason: `${fact.path} changed after this fact was accepted` }
    }
    return { fact, freshness: "current" }
  }))
}

const RELEVANCE_SYMBOL = 4
const RELEVANCE_PATH = 3
const RELEVANCE_PLAN = 2
const FRESHNESS_ORDER: Record<AcceptedFactStatus["freshness"], number> = { current: 0, historical: 1, unverifiable: 2 }

/**
 * Chooses the accepted facts shown for this request, within a fixed budget. Relevance decides what is kept: an exact
 * symbol or alias named by the request, then a source path it names, then a task of the active plan. Freshness and
 * recency only order facts with equal relevance, so a stale exact match is kept over an unrelated current fact.
 */
export const selectAcceptedFacts = async (
  request: { text: string; planItemIds: string[] },
  facts: AcceptedFact[],
  readCurrent: CurrentSourceReader | undefined,
  budget: number
): Promise<{ selected: AcceptedFactStatus[]; omitted: number }> => {
  const live = facts.filter((fact) => !fact.supersededBy)
  const subjects = [...new Set(codeIdentifiers(request.text))]
  const planItems = new Set(request.planItemIds)
  const relevance = (fact: AcceptedFact): number =>
    (subjects.some((subject) => factMatchesSymbol(fact, subject)) ? RELEVANCE_SYMBOL : 0)
    + (request.text.includes(fact.path) ? RELEVANCE_PATH : 0)
    + (planItems.has(fact.itemId) ? RELEVANCE_PLAN : 0)
  const ranked = (await assessAcceptedFacts(live, readCurrent))
    .map((status) => ({ status, score: relevance(status.fact) }))
    .sort((left, right) => right.score - left.score
      || FRESHNESS_ORDER[left.status.freshness] - FRESHNESS_ORDER[right.status.freshness]
      || right.status.fact.acceptedAt.localeCompare(left.status.fact.acceptedAt)
      || left.status.fact.id.localeCompare(right.status.fact.id))
  const selected = ranked.slice(0, budget).map(({ status }) => status)
  return { selected, omitted: ranked.length - selected.length }
}

/** An explicit request to reuse existing accepted evidence before searching or reading. Other messages never trigger the preflight. */
const EVIDENCE_FIRST_REQUEST = /\b(accepted|existing|prior|previous|persisted|recorded|project[- ]wide)\s+(source\s+)?(evidence|facts?)\b|\bevidence[- ]first\b|\b(check|reuse|consult|look\s+up)\b[^.\n]{0,60}\b(evidence|accepted facts?)\b/i

export const isEvidenceFirstRequest = (text: string): boolean => EVIDENCE_FIRST_REQUEST.test(text)

export type EvidencePreflightStatus = "fresh" | "stale" | "ambiguous" | "missing" | "unverifiable"

export interface EvidencePreflightFact {
  symbol: string
  registeredTool?: string
  toolName: string
  path: string
  startLine: number
  endLine: number
  sourceHash: string
  observationId: string
  itemId: string
  conversationId: string
  planRevision: number
  verification: "verified" | "changed" | "unreadable"
}

export interface EvidencePreflight {
  status: EvidencePreflightStatus
  reason: string
  subjects: string[]
  facts: EvidencePreflightFact[]
}

/**
 * Host-side evidence preflight for an explicit evidence-first request. It resolves the request's symbols and paths
 * against live project facts, then verifies each source fingerprint. A record alone never establishes freshness.
 */
export const evidencePreflight = async (
  text: string,
  facts: AcceptedFact[],
  readCurrent?: CurrentSourceReader
): Promise<EvidencePreflight> => {
  const subjects = [...new Set(codeIdentifiers(text))].slice(0, 12)
  const matched = facts.filter((fact) => !fact.supersededBy && (subjects.some((subject) => factMatchesSymbol(fact, subject)) || text.includes(fact.path)))
  if (!matched.length) return { status: "missing", reason: "no live accepted fact names this request's symbols or paths", subjects, facts: [] }
  const statuses = await assessAcceptedFacts(matched, readCurrent)
  const projected = statuses.map(({ fact, freshness }): EvidencePreflightFact => ({
    symbol: fact.symbol,
    ...(fact.registeredTool ? { registeredTool: fact.registeredTool } : {}),
    toolName: fact.toolName,
    path: fact.path,
    startLine: fact.startLine,
    endLine: fact.endLine,
    sourceHash: fact.sourceHash,
    observationId: fact.observationId,
    itemId: fact.itemId,
    conversationId: fact.conversationId,
    planRevision: fact.planRevision,
    verification: freshness === "current" ? "verified" : freshness === "unverifiable" ? "unreadable" : "changed"
  }))
  const resolution = resolveAcceptedFacts(statuses)
  if (resolution === "ambiguous") {
    const locations = new Set(matched.map((fact) => `${fact.path}:${fact.startLine}-${fact.endLine}`)).size
    return { status: "ambiguous", reason: `${locations} accepted source locations match; the request does not select one`, subjects, facts: projected }
  }
  if (resolution === "unique" && statuses.some((status) => status.freshness === "current")) {
    return { status: "fresh", reason: "the accepted source fingerprint matches the current source", subjects, facts: projected }
  }
  const unreadable = statuses.find((status) => status.freshness === "unverifiable")
  if (unreadable) return { status: "unverifiable", reason: unreadable.reason ?? "source could not be read", subjects, facts: projected }
  return { status: "stale", reason: statuses.find((status) => status.reason)?.reason ?? "accepted source changed", subjects, facts: projected }
}

const PREFLIGHT_GUIDANCE: Record<EvidencePreflightStatus, string> = {
  fresh: "Answer from these verified facts and cite their observation_id. Do not search or read this source again.",
  stale: "The accepted source changed. Read only the listed lines again before claiming them.",
  ambiguous: "Several accepted locations match. Do not choose one silently; state the ambiguity or resolve it from the request.",
  missing: "No accepted fact exists yet. Search and read as needed, then complete the task with observation IDs.",
  unverifiable: "The source could not be read, so freshness is unknown. Do not describe these facts as current."
}

/** The preflight as compact structured context for the implementer. */
export const renderEvidencePreflight = (preflight: EvidencePreflight): string => [
  "Host evidence preflight (deterministic, from persisted accepted facts; the host ran it before your first request):",
  JSON.stringify({ status: preflight.status, reason: preflight.reason, subjects: preflight.subjects, facts: preflight.facts }),
  PREFLIGHT_GUIDANCE[preflight.status]
].join("\n")

/**
 * Host record of a project-wide accepted-evidence lookup. It is a record the host wrote, not a tool the model can call,
 * so its name carries no tool prefix.
 */
export const EVIDENCE_CHECK_TOOL = "host_evidence_check"

/** The arguments and output of the host's project-wide accepted-evidence lookup, built from the live facts it found. */
export const evidenceCheckRecord = (live: AcceptedFact[]): { arguments: Record<string, string>; output: string } => {
  const resolution = live.length ? "found" : "none"
  return {
    arguments: {
      scope: "project",
      query: "all live accepted facts of this project",
      resolution,
      factCount: String(live.length),
      factIds: live.slice(0, 20).map((fact) => fact.id).join(",")
    },
    output: `Accepted-evidence lookup (project-wide, unfiltered): resolution=${resolution}, ${live.length} live accepted fact(s).`
  }
}

/** Scope of the prohibition outcome. The host records only operations Twinny itself executes, so the claim stops there. */
const PROHIBITION_SCOPE = "Covers file operations Twinny controls (create_file, edit_lines, edit_file, delete_file). Writes made by other mechanisms, including shell commands, are not audited."

/**
 * Proves a required workspace change from the host's record of this task. Failed mutations changed nothing,
 * so only a successful one counts.
 */
const mutationOutcome = (verification: Extract<CriterionVerification, { kind: "workspace_mutation" }>, records: RetainedObservationEvidence[]): CriterionOutcome => {
  const allowed = verification.operation ? OPERATION_TOOLS[verification.operation] : MUTATING_TOOLS
  const mutations = records.filter((record) => allowed.includes(record.toolName))
  const succeeded = mutations.filter((record) => !record.failed)
  if (succeeded.length) return reconciled("proven", succeeded.map((record) => record.observationId), [])
  return reconciled("unknown", [], [mutations.length ? "every file-mutation observation recorded for this task failed" : `no successful file-mutation observation (${allowed.join(", ")}) is recorded for this task`])
}

/**
 * Decides a command result from the latest host-recorded run of the exact command in this task. A run only proves the
 * current workspace if no successful Twinny-recorded mutation followed it in the plan. A `historical` result is diagnostic:
 * it proves the recorded run, labelled as not validated against the current workspace. An `after_activation` result
 * also needs the run to be recorded after the task's requirement activation, by causal list revision.
 */
const commandOutcome = (
  verification: Extract<CriterionVerification, { kind: "command_exit_status" }>,
  taskRecords: RetainedObservationEvidence[],
  planRecords: RetainedObservationEvidence[],
  activation: RequirementActivation | undefined
): CriterionOutcome => {
  const digest = commandDigest(verification.command)
  const latest = taskRecords.filter((record) => record.toolName === "run_command" && record.arguments.command_sha256 === digest).at(-1)
  if (verification.execution === "after_activation") {
    if (!activation) return reconciled("unknown", [], [`the requirement to run ${verification.command} is not activated for this task yet; it is activated when a reply starts`])
    const eligible = latest !== undefined && latest.listRevision !== undefined && latest.listRevision > activation.listRevision
    if (!eligible) {
      const predates = latest ? `the latest run of ${verification.command} (observation ${latest.observationId}) predates` : `no run of ${verification.command} has been recorded since`
      return reconciled("unknown", [], [`${predates} the requirement activation at ${new Date(activation.activatedAt).toISOString()}; run it again to satisfy the requirement`])
    }
  }
  if (!latest) return reconciled("unknown", [], ["no recorded run of " + verification.command])
  if (latest.failed || latest.exitCode === undefined) return reconciled("unknown", [], ["the latest run of " + verification.command + " did not complete"])
  const historical = verification.scope === "historical"
  if (!historical) {
    const position = planRecords.findIndex((record) => record.observationId === latest.observationId)
    const later = planRecords.slice(position + 1).filter((record) => !record.failed && MUTATING_TOOLS.includes(record.toolName))
    if (later.length) {
      return reconciled("unknown", [], [`the workspace changed after the latest run of ${verification.command} (observation ${later[0].observationId}); run it again to test the current revision`])
    }
  }
  const outcome = latest.exitCode === verification.exitCode
    ? reconciled("proven", [latest.observationId], [])
    : reconciled("disproven", [latest.observationId], [verification.command + " exited with " + latest.exitCode + " in observation " + latest.observationId + ", not " + verification.exitCode])
  return historical ? { ...outcome, scope: `a historical run of ${verification.command}, not validated against the current workspace` } : outcome
}

/**
 * Decides a prohibition from the host's operation record for the plan. A prohibition describes the whole
 * process, so the record is the list-shared set of retained observations, which dependent TODOs reuse. A
 * successful mutation Twinny executed violates it. Failed mutations did not change anything, and a plan with
 * no recorded operations gives the host nothing to test against.
 */
const prohibitionOutcome = (records: RetainedObservationEvidence[]): CriterionOutcome => {
  if (!records.length) return reconciled("unknown", [], ["no trusted operation record in this plan to test the prohibition against"])
  const violations = records.filter((record) => !record.failed && MUTATING_TOOLS.includes(record.toolName))
  if (violations.length) {
    return {
      ...reconciled("disproven", violations.map((record) => record.observationId), violations.map((record) => `${record.toolName} succeeded in observation ${record.observationId}, which the criterion prohibits`)),
      scope: PROHIBITION_SCOPE
    }
  }
  return { ...reconciled("proven", records.map((record) => record.observationId), []), scope: PROHIBITION_SCOPE }
}

/** A registration (name: "read_file") paired with the declaration that implements it, and the fingerprinted read that shows it. */
interface RegistrationRead {
  record: RetainedObservationEvidence
  alias: { tool: string; implementation: string; startLine: number; registrationLine: number }
  path: string
  sourceHash: string
}

/**
 * Registration lines that name a tool, whether or not their enclosing declaration was read. Proves the
 * registered tool name only; it never proves the implementation symbol.
 */
const registeredNameReads = (records: RetainedObservationEvidence[]): Array<{ record: RetainedObservationEvidence; tool: string; line: number; path: string; sourceHash: string }> =>
  records.filter((record) => !record.failed && record.retained && record.content !== undefined).flatMap((record) =>
    (record.content ?? "").split("\n").flatMap((text) => {
      const numbered = NUMBERED_SOURCE_LINE.exec(text)
      const name = numbered && NAME_PROPERTY_LINE.exec(numbered[2])
      if (!numbered || !name) return []
      const line = Number(numbered[1])
      const source = record.sources.find((candidate) =>
        candidate.startLine !== undefined && candidate.endLine !== undefined
        && candidate.startLine <= line && line <= candidate.endLine && candidate.contentHash)
      return source?.contentHash ? [{ record, tool: name[1], line, path: source.path, sourceHash: source.contentHash }] : []
    }))

const registrationReads = (records: RetainedObservationEvidence[]): RegistrationRead[] =>

  records.filter((record) => !record.failed && record.retained && record.content !== undefined).flatMap((record) =>
    implementationAliases(record).flatMap((alias) => {
      const source = record.sources.find((candidate) =>
        candidate.startLine !== undefined && candidate.endLine !== undefined
        && candidate.startLine <= alias.startLine && alias.registrationLine <= candidate.endLine && candidate.contentHash)
      return source?.contentHash ? [{ record, alias, path: source.path, sourceHash: source.contentHash }] : []
    }))

/**
 * The line that closes a declaration: the first later line at the declaration's indentation that starts with a closing brace.
 * Measured on the current source, so the range is independent of how much a read happened to capture.
 */
const declarationEnd = (text: string, startLine: number): number | undefined => {
  const lines = text.split("\n")
  const opening = lines[startLine - 1]
  if (opening === undefined) return undefined
  const indent = indentOf(opening)
  for (let index = startLine; index < lines.length; index++) {
    const line = lines[index]
    if (line.trim() && indentOf(line) === indent && line.trimStart().startsWith("}")) return index + 1
  }
  return undefined
}

/** Whether a retained read captured the given line of the path, so its content is actually shown and not merely in an unread range. */
const showsLine = (record: RetainedObservationEvidence, path: string, line: number): boolean =>
  record.sources.some((source) => samePath(source.path, path) && source.startLine !== undefined && source.endLine !== undefined
    && source.startLine <= line && line <= source.endLine)
  && !!record.content?.split("\n").some((text) => NUMBERED_SOURCE_LINE.exec(text)?.[1] === String(line))

/**
 * Fresh retained reads, from any observation, that show a line of the path. Each must match the current
 * source, so a boundary read taken before an edit cannot close a range at the current revision.
 */
const boundaryObservations = async (records: RetainedObservationEvidence[], path: string, line: number, text: string): Promise<string[]> => {
  const ids: string[] = []
  for (const record of records) {
    if (record.failed || !record.retained || record.content === undefined || !showsLine(record, path, line)) continue
    const hash = record.sources.find((source) => samePath(source.path, path))?.contentHash
    if (hash && await verifyContentFingerprint(text, hash).catch(() => false)) ids.push(record.observationId)
  }
  return ids
}

/** The latest successful project-wide lookup whose recorded resolution and count agree. Failed, partial, and subject-scoped lookups prove nothing. */
const latestProjectLookup = (records: RetainedObservationEvidence[]): RetainedObservationEvidence | undefined => {
  const valid = records.filter((record) => {
    if (record.toolName !== EVIDENCE_CHECK_TOOL || record.failed || record.arguments.scope !== "project") return false
    const count = Number(record.arguments.factCount)
    return Number.isInteger(count) && count >= 0 && record.arguments.resolution === (count > 0 ? "found" : "none")
  })
  return valid[valid.length - 1]
}

/** Whether an accepted fact still matches the current source: same fingerprint, and the recorded range when one is required. */
const liveFactMatches = async (fact: AcceptedFact, current: (path: string) => Promise<string | undefined>, needsRange: boolean): Promise<boolean> => {
  const text = await current(fact.path)
  if (text === undefined || !(await verifyContentFingerprint(text, fact.sourceHash).catch(() => false))) return false
  return !needsRange || declarationEnd(text, fact.startLine) === fact.endLine
}

/**
 * Whether a criterion's name denotes an accepted fact under the criterion's identity. A registered-tool name matches only the
 * fact's registered tool; an implementation name matches only the fact's own symbol. Neither is inferred from spelling.
 */
export const factNamedBy = (identity: SourceIdentity, name: string, fact: AcceptedFact): boolean =>
  identity === "registered_tool" ? fact.registeredTool === name : fact.symbol === name

/**
 * `accepted_fact_exists` is proven by a current accepted fact. A completed project-wide lookup that found no facts, with no
 * fact accepted since, is an authoritative counterexample. A subject-scoped or failed lookup decides nothing.
 */
const acceptedFactOutcome = async (
  subject: { identity: SourceIdentity; symbol: string; path?: string },
  records: RetainedObservationEvidence[],
  accepted: AcceptedFact[],
  current: (path: string) => Promise<string | undefined>
): Promise<CriterionOutcome> => {
  const matching = accepted.filter((fact) => !fact.supersededBy && factNamedBy(subject.identity, subject.symbol, fact) && (subject.path === undefined || samePath(fact.path, subject.path)))
  const live: AcceptedFact[] = []
  for (const fact of matching) {
    if (await liveFactMatches(fact, current, false)) live.push(fact)
  }
  const livePaths = new Set(live.map((fact) => fact.path))
  if (livePaths.size > 1) return reconciled("unknown", [], [`${subject.symbol} is recorded at ${livePaths.size} locations; the criterion must name the file`])
  if (live.length) return { ...reconciled("proven", [live[0].observationId], []), reuse: "accepted" }
  if (subject.path === undefined) {
    const declaredPaths = [...new Set([...registrationReads(records).map((read) => read.path), ...registeredNameReads(records).map((read) => read.path)])]
    const located: CriterionOutcome[] = []
    for (const path of declaredPaths) {
      const outcome = await sourceContractOutcome({ kind: "source_location", identity: subject.identity, symbol: subject.symbol, path }, records, accepted, current)
      if (outcome.outcome === "proven") located.push(outcome)
    }
    if (located.length === 1) return located[0]
    if (located.length > 1) return reconciled("unknown", located.flatMap((outcome) => outcome.supportingObservationIds), [`${subject.symbol} is declared in ${located.length} files; the criterion must name the file`])
  }
  const check = latestProjectLookup(records)
  if (check?.arguments.resolution === "none" && !accepted.some((fact) => fact.acceptedAt > check.observedAt)) {
    return reconciled("disproven", [check.observationId], [`no accepted fact for ${subject.symbol} existed at the project-wide check`])
  }
  return reconciled("unknown", [], [matching.length
    ? `the accepted fact for ${subject.symbol} no longer matches the current source`
    : `no current accepted fact for ${subject.symbol} is recorded`])
}

/**
 * Source predicates for one declaration. Location and fingerprint are proven by a fingerprint-verified read that shows the
 * declaration. A range also needs a fresh retained read that shows the declaration's actual closing line, so a short read
 * cannot prove an unseen boundary.
 */
const sourceContractOutcome = async (
  subject: { kind: "source_location" | "source_range" | "source_fingerprint"; identity: SourceIdentity; symbol: string; path: string },
  records: RetainedObservationEvidence[],
  accepted: AcceptedFact[],
  current: (path: string) => Promise<string | undefined>
): Promise<CriterionOutcome> => {
  const needsRange = subject.kind === "source_range"
  for (const fact of accepted.filter((candidate) => !candidate.supersededBy && factNamedBy(subject.identity, subject.symbol, candidate) && samePath(candidate.path, subject.path))) {
    if (await liveFactMatches(fact, current, needsRange)) return { ...reconciled("proven", [fact.observationId], []), reuse: "accepted" }
  }
  const missing: string[] = []
  const named = (alias: RegistrationRead["alias"]) => subject.identity === "registered_tool" ? alias.tool === subject.symbol : alias.implementation === subject.symbol
  for (const { record, alias, path, sourceHash } of registrationReads(records).filter((read) => named(read.alias) && samePath(read.path, subject.path))) {
    const text = await current(path)
    if (text === undefined) {
      missing.push(`cannot read the current ${path} to confirm observation ${record.observationId}`)
      continue
    }
    if (!(await verifyContentFingerprint(text, sourceHash).catch(() => false))) {
      missing.push(`${path} changed after observation ${record.observationId} was read; read it again`)
      continue
    }
    if (!needsRange) {
      // The closing line is measured, and a fact is stored only when a fresh read shows it. Otherwise the location is
      // proven for this decision without persisting a boundary the host has not observed.
      const end = declarationEnd(text, alias.startLine)
      const boundary = end === undefined ? [] : await boundaryObservations(records, path, end, text)
      return {
        ...reconciled("proven", [...new Set([record.observationId, ...boundary])], []),
        facts: end !== undefined && boundary.length > 0
          ? [{ symbol: alias.implementation, registeredTool: alias.tool, path, startLine: alias.startLine, endLine: end, observationId: record.observationId, sourceHash }]
          : []
      }
    }
    const end = declarationEnd(text, alias.startLine)
    if (end === undefined) {
      missing.push(`the closing line of ${alias.implementation} in ${path} cannot be found`)
      continue
    }
    const boundary = await boundaryObservations(records, path, end, text)
    if (!boundary.length) {
      missing.push(`${alias.implementation} in ${path} closes at line ${end}, which no fresh retained read shows; read through line ${end}`)
      continue
    }
    return {
      ...reconciled("proven", [...new Set([record.observationId, ...boundary])], []),
      facts: [{ symbol: alias.implementation, registeredTool: alias.tool, path, startLine: alias.startLine, endLine: end, observationId: record.observationId, sourceHash }]
    }
  }
  if (subject.identity === "registered_tool" && !needsRange) {
    for (const { record, tool, line, path, sourceHash } of registeredNameReads(records).filter((read) => read.tool === subject.symbol && samePath(read.path, subject.path))) {
      const text = await current(path)
      if (text === undefined) {
        missing.push(`cannot read the current ${path} to confirm observation ${record.observationId}`)
        continue
      }
      if (!(await verifyContentFingerprint(text, sourceHash).catch(() => false))) {
        missing.push(`${path} changed after observation ${record.observationId} was read; read it again`)
        continue
      }
      return {
        ...reconciled("proven", [record.observationId], []),
        facts: [{ symbol: tool, path, startLine: line, endLine: line, observationId: record.observationId, sourceHash }]
      }
    }
  }
  if (subject.path !== undefined) {
    const path = subject.path
    for (const record of records) {
      if (!record.failed && !record.retained && record.toolName === "read_file" && samePath(record.arguments.path ?? "", path)) {
        missing.push(`the read of ${path} in observation ${record.observationId} was evicted from retained storage; read it again`)
      }
    }
  }
  return reconciled("unknown", [], missing.length ? missing : [`no retained successful read shows ${subject.symbol} in ${subject.path}`])
}

/** Decides one typed criterion. The descriptor's kind selects the rule; the criterion's wording is never read. */
/**
 * A source predicate without a path is decided by the single file the host observed declaring the symbol, found in retained
 * registration reads and accepted facts. Several proven files, or none, leave the criterion unknown and say what is missing.
 */
const sourceOutcome = async (
  subject: { kind: "source_location" | "source_range" | "source_fingerprint"; identity: SourceIdentity; symbol: string; path?: string },
  records: RetainedObservationEvidence[],
  accepted: AcceptedFact[],
  current: (path: string) => Promise<string | undefined>
): Promise<CriterionOutcome> => {
  if (subject.path !== undefined) return sourceContractOutcome({ ...subject, path: subject.path }, records, accepted, current)
  const named = (alias: RegistrationRead["alias"]) => subject.identity === "registered_tool" ? alias.tool === subject.symbol : alias.implementation === subject.symbol
  const candidates = new Set([
    ...registrationReads(records).filter((read) => named(read.alias)).map((read) => read.path),
    ...(subject.identity === "registered_tool" ? registeredNameReads(records).filter((read) => read.tool === subject.symbol).map((read) => read.path) : []),
    ...accepted.filter((fact) => !fact.supersededBy && factNamedBy(subject.identity, subject.symbol, fact)).map((fact) => fact.path)
  ])
  const proven: CriterionOutcome[] = []
  const missing: string[] = []
  for (const path of candidates) {
    const outcome = await sourceContractOutcome({ ...subject, path }, records, accepted, current)
    if (outcome.outcome === "proven") proven.push(outcome)
    else missing.push(...outcome.missing)
  }
  if (proven.length === 1) return proven[0]
  if (proven.length > 1) return reconciled("unknown", proven.flatMap((outcome) => outcome.supportingObservationIds), [`${subject.symbol} is declared in ${proven.length} files; the criterion must name the file`])
  return reconciled("unknown", [], missing.length ? missing : [`no retained read shows the declaration of ${subject.symbol}; read the file that declares it`])
}

const typedOutcome = async (
  verification: CriterionVerification,
  taskId: string,
  records: RetainedObservationEvidence[],
  accepted: AcceptedFact[],
  current: (path: string) => Promise<string | undefined>,
  activation: RequirementActivation | undefined
): Promise<CriterionOutcome> => {
  switch (verification.kind) {
    case "semantic_review":
      return reconciled("semantic", [], [])
    case "execution_invariant":
      return prohibitionOutcome(records)
    case "workspace_mutation":
      return mutationOutcome(verification, records.filter((record) => record.itemId === taskId))
    case "command_exit_status":
      return commandOutcome(verification, records.filter((record) => record.itemId === taskId), records, activation)
    case "evidence_lookup_completed": {
      const check = latestProjectLookup(records)
      return check
        ? { ...reconciled("proven", [check.observationId], []), scope: `the completed project-wide lookup of accepted facts (resolution: ${check.arguments.resolution})` }
        : reconciled("unknown", [], ["no completed project-wide lookup of accepted facts is recorded in this plan"])
    }
    case "accepted_fact_exists":
      return acceptedFactOutcome(verification, records, accepted, current)
    case "source_location":
    case "source_range":
    case "source_fingerprint":
      return sourceOutcome(verification, records, accepted, current)
  }
}

/** The single source of criterion outcomes for a review, decided by each criterion's typed descriptor. */
export const reviewReconciliations = async (
  review: Pick<TodoReviewPackage, "criteria" | "retainedEvidence" | "acceptedEvidence" | "symbolAliases" | "requirementActivation"> & { task: Pick<TodoReviewPackage["task"], "id"> },
  readCurrentSource?: CurrentSourceReader
): Promise<TodoCriterionReconciliation[]> => {
  const current = cachedCurrentReader(readCurrentSource)
  const outcomes: TodoCriterionReconciliation[] = []
  for (const criterion of review.criteria) {
    outcomes.push({ ...await typedOutcome(criterion.verification, review.task.id, review.retainedEvidence, review.acceptedEvidence, current, review.requirementActivation), criterionId: criterion.id })
  }
  return carryWidestFacts(outcomes)
}

/**
 * One read can prove a symbol at several ranges, and several criteria can share that proof. Each symbol, path, and
 * observation keeps only its widest fact, and that fact is carried by the outcome that proved it.
 */
const carryWidestFacts = (outcomes: TodoCriterionReconciliation[]): TodoCriterionReconciliation[] => {
  const keyOf = (fact: { symbol: string; path: string; observationId: string }) => [fact.symbol, fact.path, fact.observationId].join("\u0000")
  const widest = new Map<string, NonNullable<TodoCriterionReconciliation["facts"]>[number]>()
  for (const fact of outcomes.flatMap((outcome) => outcome.facts ?? [])) {
    const current = widest.get(keyOf(fact))
    if (!current || fact.endLine - fact.startLine > current.endLine - current.startLine) widest.set(keyOf(fact), fact)
  }
  return outcomes.map((outcome) => {
    if (!outcome.facts) return outcome
    const facts = outcome.facts.filter((fact) => widest.get(keyOf(fact)) === fact)
    return facts.length ? { ...outcome, facts } : { ...outcome, facts: undefined }
  })
}

const reconciliationFor = (reconciliations: TodoCriterionReconciliation[], criterionId: string) =>  reconciliations.find((entry) => entry.criterionId === criterionId)

/** A criterion as the host decided it. Only proven and disproven outcomes are final; anything else stays unverified. */
const hostCriterion = (criterion: TypedCriterion, reconciliation: TodoCriterionReconciliation | undefined): TodoEvaluationCriterion => {
  const outcome = reconciliation?.outcome ?? "unknown"
  const status: TodoEvaluationCriterion["status"] = outcome === "proven" ? "passed" : outcome === "disproven" ? "failed" : "unverified"
  return {
    criterionId: criterion.id,
    criterion: criterion.description,
    status,
    evidenceRefs: [...(reconciliation?.supportingObservationIds ?? [])],
    ...(reconciliation ? { reconciliation } : {})
  }
}

/**
 * Decides a review from host-verified reconciliations alone. Returns undefined
 * when any criterion is semantic, so only genuinely interpretive questions
 * reach Feedback. Ordinary workspace-change and approval gates still apply
 * to the result the caller receives.
 */
export const deterministicTodoEvaluation = (
  review: TodoReviewPackage,
  reconciliations: TodoCriterionReconciliation[],
  evaluatedAt = new Date().toISOString()
): TodoEvaluation | undefined => {
  if (review.criteria.some((criterion) => !reconciliationFor(reconciliations, criterion.id))) return undefined
  if (reconciliations.some((reconciliation) => reconciliation.outcome === "semantic")) return undefined
  const criteria: TodoEvaluationCriterion[] = review.criteria.map((criterion) => hostCriterion(criterion, reconciliationFor(reconciliations, criterion.id)))
  const failed = criteria.filter((criterion) => criterion.status === "failed")
  const unverified = criteria.filter((criterion) => criterion.status === "unverified")
  const problems = criteria.flatMap((criterion) =>
    (criterion.status === "passed" ? [] : criterion.reconciliation?.missing ?? []).map((gap) => `${criterion.criterion} — ${gap}`.slice(0, 500))
  ).slice(0, 20)
  const decision: TodoEvaluation["decision"] = failed.length ? "revise" : unverified.length ? "needs_evidence" : "accept"
  return {
    schemaVersion: 1,
    taskId: review.planTaskId,
    decision,
    criteria,
    problems: decision === "accept" ? [] : problems,
    correctiveInstructions: failed.map((criterion) => ("Correct the work so trusted observations support: " + criterion.criterion).slice(0, 500)),
    explanation: decision === "accept"
      ? ["Every criterion was verified deterministically from trusted observations of the current source.", ...new Set(reconciliations.map((reconciliation) => reconciliation.scope).filter((scope): scope is string => !!scope))].join(" ")
      : "Deterministic verification found the missing or contradicted facts listed in problems.",
    scores: { completion: 0, correctness: 0, alignment: 0 },
    metadata: { evaluator: DETERMINISTIC_EVALUATOR, evaluatedAt, taskVersion: review.task.version, planRevision: review.planRevision }
  }
}

export const parseTodoEvaluation = (
  raw: string,
  review: TodoReviewPackage,
  evaluator: string,
  evaluatedAt = new Date().toISOString(),
  reconciliations: TodoCriterionReconciliation[] = []
): TodoEvaluation => {
  if (!raw.trim()) invalid("empty_response", "Evaluator returned an empty response")
  let value: unknown
  try {
    value = JSON.parse(extractJsonObject(raw))
  } catch (error) {
    throw new TodoEvaluationValidationError("malformed_json", "Evaluator response is not valid JSON: " + (error instanceof Error ? error.message : String(error)))
  }
  if (!isRecord(value)) throw new TodoEvaluationValidationError("invalid_shape", "Evaluator response must be a JSON object", "object", typeof value)
  if (!("schemaVersion" in value)) invalid("missing_field", "Evaluator response is missing schemaVersion", 1, undefined, "schemaVersion")
  if (value.schemaVersion !== 1) invalid("schema_version", "Evaluator response has an unsupported schema version", 1, value.schemaVersion, "schemaVersion")
  if (!("taskId" in value)) invalid("missing_field", "Evaluator response is missing taskId", review.planTaskId, undefined, "taskId")
  if (value.taskId !== review.planTaskId) invalid("task_id", "Evaluator response taskId does not match the canonical plan task ID", review.planTaskId, value.taskId, "taskId")
  if (!("decision" in value)) invalid("missing_field", "Evaluator response is missing decision", [...decisions], undefined, "decision")
  if (!decisions.has(String(value.decision))) invalid("decision", "Evaluator response contains an unknown decision", [...decisions], value.decision, "decision")
  for (const field of ["criteria", "problems", "correctiveInstructions", "explanation", "scores"]) {
    if (!(field in value)) invalid("missing_field", "Evaluator response is missing " + field, field, undefined, field)
  }
  const criteriaValue = value.criteria
  const semanticIds = new Set(review.criteria.filter((criterion) => reconciliationFor(reconciliations, criterion.id)?.outcome === "semantic").map((criterion) => criterion.id))
  if (!Array.isArray(criteriaValue) || criteriaValue.length !== semanticIds.size) {
    throw new TodoEvaluationValidationError("invalid_shape", "Evaluator must return exactly one result for each semantic criterion, identified by criterionId", [...semanticIds], Array.isArray(criteriaValue) ? criteriaValue.length : typeof criteriaValue, "criteria")
  }
  exactKeys(value, ["schemaVersion", "taskId", "decision", "criteria", "problems", "correctiveInstructions", "explanation", "scores"], "response")
  const visibleObservations = preserveObservationSet(review)
  const visibleEvidence = review.evidence.slice(0, 8)
  const trustedRecords = [...visibleObservations, ...sharedObservationRecords(review, visibleObservations)]
  const knownRefs = new Set([...trustedRecords.map((observation) => observation.id), ...visibleEvidence.map((evidence) => evidence.id)])
  const judged = new Map<string, TodoEvaluationCriterion>()
  criteriaValue.forEach((entry, index) => {
    const field = `criteria[${index}]`
    if (!isRecord(entry)) invalid("invalid_shape", `Evaluator criterion at index ${index} must be an object`, "object", entry, field)
    if (!("criterionId" in entry)) invalid("missing_field", `Evaluator criterion at index ${index} is missing the required 'criterionId' field`, [...semanticIds], undefined, `${field}.criterionId`)
    if (!("status" in entry)) invalid("missing_field", `Evaluator criterion at index ${index} is missing the required 'status' field`, [...criterionStatuses], undefined, `${field}.status`)
    if (!("evidenceRefs" in entry)) invalid("missing_field", `Evaluator criterion at index ${index} is missing the required 'evidenceRefs' field`, [], undefined, `${field}.evidenceRefs`)
    exactKeys(entry, ["criterionId", "status", "evidenceRefs"], field)
    if (typeof entry.criterionId !== "string" || !semanticIds.has(entry.criterionId)) {
      invalid("invalid_shape", `Evaluator criterion at index ${index} is not a semantic criterion of this task`, [...semanticIds], entry.criterionId, `${field}.criterionId`)
    }
    const criterionId = entry.criterionId as string
    if (judged.has(criterionId)) invalid("invalid_shape", `Evaluator returned criterionId ${criterionId} more than once`, [...semanticIds], criterionId, `${field}.criterionId`)
    if (!criterionStatuses.has(String(entry.status))) invalid("invalid_shape", `Evaluator criterion at index ${index} has an invalid status; expected passed, failed, or unverified`, [...criterionStatuses], entry.status, `${field}.status`)
    const evidenceRefs = boundedStrings(entry.evidenceRefs, 100, 20, `${field}.evidenceRefs`)
    if (evidenceRefs.some((reference) => !knownRefs.has(reference))) invalid("invalid_shape", "Evaluator cited evidence outside this task review package", [...knownRefs], evidenceRefs, `${field}.evidenceRefs`)
    const criterion = review.criteria.find((candidate) => candidate.id === criterionId)
    judged.set(criterionId, {
      ...hostCriterion(criterion!, reconciliationFor(reconciliations, criterionId)),
      status: entry.status as TodoEvaluationCriterion["status"],
      evidenceRefs
    })
  })
  const criteria: TodoEvaluationCriterion[] = review.criteria.map((criterion) =>
    judged.get(criterion.id) ?? hostCriterion(criterion, reconciliationFor(reconciliations, criterion.id)))
  const problems = boundedStrings(value.problems, 500, 20, "problems")
  const correctiveInstructions = boundedStrings(value.correctiveInstructions, 500, 20, "correctiveInstructions")
  const explanation = value.explanation
  if (typeof explanation !== "string" || !explanation.trim() || explanation.length > 1000) {
    throw new TodoEvaluationValidationError("invalid_shape", "Evaluator response explanation must be a non-empty string of at most 1000 characters", "non-empty string, max 1000 characters", explanation, "explanation")
  }
  if (!isRecord(value.scores)) throw new TodoEvaluationValidationError("invalid_shape", "Evaluator response scores must be an object", "object", typeof value.scores, "scores")
  const scores = value.scores
  exactKeys(scores, ["completion", "correctness", "alignment"], "scores")
  const score = (name: "completion" | "correctness" | "alignment") => {
    const number = scores[name]
    if (typeof number !== "number" || !Number.isInteger(number) || number < -7 || number > 8) {
      throw new TodoEvaluationValidationError("invalid_shape", "scores." + name + " must be an integer from -7 to +8", "integer in [-7, 8]", number, "scores." + name)
    }
    return number
  }
  let decision = value.decision as TodoEvaluation["decision"]
  let disproven = false
  for (const criterion of criteria) {
    const outcome = criterion.reconciliation?.outcome
    if (outcome === "disproven") {
      disproven = true
      criterion.status = "failed"
      const contradiction = (criterion.reconciliation?.missing ?? []).join("; ") || "trusted observations contradict this criterion"
      if (problems.length < 20) problems.push((criterion.criterion + " — " + contradiction).slice(0, 500))
      if (correctiveInstructions.length < 20) correctiveInstructions.push(("Correct the work so trusted observations support: " + criterion.criterion).slice(0, 500))
    } else if (outcome === "proven") {
      if (criterion.status !== "passed") logger.warn("[Feedback] reviewer.criterion_overridden task=" + value.taskId + " reviewer_status=" + criterion.status + " host_outcome=proven")
      criterion.status = "passed"
    } else if (outcome === "unknown" && criterion.reconciliation?.criterionId) {
      // A typed criterion the host could not prove cannot be passed on the reviewer's word.
      if (criterion.status === "passed") logger.warn("[Feedback] reviewer.criterion_overridden task=" + value.taskId + " reviewer_status=passed host_outcome=unknown")
      criterion.status = criterion.status === "failed" ? "failed" : "unverified"
    }
  }
  const reviewerDecision = decision
  if (disproven) decision = "revise"
  else if (decision === "revise" && !criteria.some((criterion) => criterion.status === "failed")) {
    decision = criteria.every((criterion) => criterion.status === "passed") ? "accept" : "needs_evidence"
  } else if (decision === "needs_evidence" && criteria.every((criterion) => criterion.status === "passed") && criteria.some((criterion) => criterion.reconciliation?.outcome === "proven")) decision = "accept"
  if (decision === "accept" && criteria.some((criterion) => criterion.reconciliation?.criterionId && criterion.reconciliation.outcome === "unknown")) decision = "needs_evidence"
  if (decision !== reviewerDecision) logger.warn("[Feedback] reviewer.decision_reconciled task=" + value.taskId + " reviewer=" + reviewerDecision + " host=" + decision)
  if (decision !== "accept" && /\b(all|every)\b[^.]{0,80}\b(satisf\w*|met|verified|passed)\b/i.test(explanation)) {
    logger.warn("[Feedback] reviewer.explanation_contradicts_decision task=" + value.taskId + " decision=" + decision)
  }
  if (decision !== "accept") addUnresolvedReasons(problems, review, reconciliations)
  if (decision === "accept") {
    for (const criterion of criteria) {
      if (criterion.status !== "passed" || criterionProvenBy(criterion.reconciliation, trustedRecords)) continue
      if (criterion.evidenceRefs.some((reference) => trustedRecords.some((observation) => observation.id === reference && !observation.failed))) continue
      criterion.status = "unverified"
      problems.push("Missing a trusted Twinny tool observation for: " + criterion.criterion)
      logger.warn("[Feedback] todo.evidence.missing task=" + value.taskId + " criterion_refs=" + criterion.evidenceRefs.length)
    }
    if (criteria.some((criterion) => criterion.status === "failed")) decision = "revise"
    else if (criteria.some((criterion) => criterion.status !== "passed")) decision = "needs_evidence"
  }
  if (decision === "needs_evidence" && !problems.length && !criteria.some((criterion) => criterion.status === "unverified")) {
    invalid("invalid_shape", "Insufficient-evidence decisions must identify missing evidence")
  }
  if (decision === "revise" && !correctiveInstructions.length) invalid("invalid_shape", "Revision decisions must include corrective instructions")
  return {
    schemaVersion: 1,
    taskId: review.planTaskId,
    decision,
    criteria,
    problems,
    correctiveInstructions,
    explanation: explanation.trim(),
    scores: { completion: score("completion"), correctness: score("correctness"), alignment: score("alignment") },
    metadata: { evaluator, evaluatedAt, taskVersion: review.task.version, planRevision: review.planRevision }
  }
}

export const evaluationRequestId = (review: TodoReviewPackage): string => {
  const material = [
    review.task.id,
    review.task.version,
    ...review.criteria.map((criterion) => `${criterion.id}\n${criterion.description}`),
    ...review.observations.map((entry) => entry.id)
  ].join("\n")
  const hash = createHash("sha256").update(material).digest("hex").slice(0, 32)
  return `review:${review.task.id}:${review.task.version}:${hash}`
}

const describeEvidenceStatus = (status: TodoReviewPackage["observations"][number]["evidence"]) => status
  ? { retained: status.retained, complete: status.complete, originalChars: status.originalChars, preservedChars: status.preservedChars }
  : { retained: false }

const retainedContentFor = (review: TodoReviewPackage, observationId: string) => {
  const content = review.retainedEvidence.find((entry) => entry.observationId === observationId)?.content
  return content === undefined ? undefined : clip(content, 4000)
}

export const feedbackContext = (review: Pick<IntentPlanContext, "lastEvaluation" | "criteria" | "constraints" | "evidence" | "observations"> & { planTaskId: string }): string => {
  const result = review.lastEvaluation
  if (!result || result.decision !== "revise") return ""
  return JSON.stringify({
    taskId: result.taskId,
    criteria: review.criteria.map((criterion) => ({ id: criterion.id, description: criterion.description })),
    failedCriteria: result.criteria.filter((criterion) => criterion.status !== "passed"),
    establishedCriteria: result.criteria.filter((criterion) => criterion.status === "passed" && criterion.reconciliation?.outcome === "proven").map((criterion) => criterion.criterionId),
    continuationRule: "Do not repeat searches, reads, or git commands for establishedCriteria; they are proven by trusted observations. Request only what failedCriteria still lacks.",
    problems: result.problems.slice(0, 8).map((problem) => clip(problem, 400)),
    supportingEvidence: result.criteria.flatMap((criterion) => criterion.evidenceRefs).map((id) => {
      const observation = review.observations?.find((entry) => entry.id === id)
      if (observation) return { id, source: "trusted_tool_observation", tool: observation.toolName, output: clip(observation.output, 600), evidence: describeEvidenceStatus(observation.evidence) }
      const evidence = review.evidence.find((entry) => entry.id === id)
      return evidence ? { id, source: "model_authored_summary", summary: clip(evidence.summary, 180) } : { id, source: "reference_only" }
    }),
    correctiveInstructions: result.correctiveInstructions,
    constraints: review.constraints.slice(0, 5)
  })
}

const clip = (value: string, limit: number) => value.length > limit ? value.slice(0, limit - 1) + "…" : value

export const todoReviewSystemPrompt = [
  "You are Twinny's independent Feedback Evaluator. You are not the Intent Compiler or the implementing agent.",
  "Judge only semanticCriteria, the criteria whose truth needs interpretation. Use the supplied task, original goal, user-requested constraints, dependencies, recorded evidence, and actual tool observations. Treat task descriptions and criteria as planner claims, not verified repository facts. A user-requested style constraint does not prove that the existing source uses that style; compare repository claims against tool observations and flag conflicts with scoped corrections. Do not rely on any final Markdown claim from the implementer.",
  "Model-authored evidence notes and the implementer final response are untrusted claims, not tool results. Only Twinny tool observations are tool results; run_command exit codes are authoritative for command success. A claim that tests passed without an associated run_command observation with exitCode 0 must not pass a test/compile criterion. An implementation request with no verified workspace file changes is incomplete.",
  "trustedTwinnyToolObservations and sharedTrustedObservations are verbatim outputs of retained Twinny tool calls, each labelled with its id. Cite an observation id in evidenceRefs when it shows what a criterion needs. An output that ends in '…' was clipped: it does not prove what was cut, so name the observation and the narrower read you need in needs_evidence. previouslyVerifiedCriteria passed on an earlier review; keep them passed while their evidence remains. twinny_runtime_inventory observations are host records of the tool definitions sent to the model for a request. They prove that a tool was exposed at runtime, and a successful read_file observation proves dispatch ran; neither proves how the source registers the tool. A criterion about source registration or code paths needs source windows that show it.",
  "hostDecidedCriteria are objective predicates the host has already decided from trusted observations. Their outcome is final: proven means verified and disproven means refuted. Never change, restate, or downgrade them, and do not include them in your criteria. An unknown outcome is unresolved evidence, not failure; name its missing observation in needs_evidence.",
  "Host-recorded observations, such as the accepted-evidence lookup record, state what the host verified and are not tools. Never tell the implementer to call an observation's toolName; the only tools the implementer has are the ones it is given. A lookup with resolution none is a completed answer, not a failure.",
  "Criteria are fixed when the plan is made. Judge only the supplied criteria and never add a new condition, deliverable, or requirement to record, document, or report on the TODO list. Accepted host evidence is authoritative for narrow deterministic facts, so do not ask for a fresh observation of a fact the host has already verified unless its freshness check failed.",
  "Never request or execute a command. Do not widen project scope or override user permissions. If evidence is insufficient, choose needs_evidence and name the missing observation. If a criterion failed, choose revise and provide concrete corrective instructions. Use blocked only for an actual blocker.",
  "Return exactly one JSON object and no other keys, following this structure: {\"schemaVersion\":1,\"taskId\":\"<copy task.taskId exactly>\",\"decision\":\"accept\",\"criteria\":[{\"criterionId\":\"<copy one semanticCriteria criterionId exactly>\",\"status\":\"passed\",\"evidenceRefs\":[\"<supplied observation ID>\"]}],\"problems\":[],\"correctiveInstructions\":[],\"explanation\":\"<non-empty string>\",\"scores\":{\"completion\":0,\"correctness\":0,\"alignment\":0}}. Every listed key is required. decision must be exactly one of accept, revise, needs_evidence, blocked. Each criteria entry has exactly criterionId (string), status (passed, failed, or unverified), and evidenceRefs (array of supplied IDs). criteria must contain exactly one entry per semanticCriteria item, identified by criterionId; never include hostDecidedCriteria. Each evidenceRefs entry must be an ID explicitly supplied in the input; never invent or infer IDs. problems and correctiveInstructions are arrays of strings and may be empty; explanation is a non-empty string; scores has exactly completion, correctness, and alignment, each an integer from -7 to +8. Do not use 'criterion' instead of 'criterionId', do not return correctiveInstructions as a string, and do not add fields."
].join("\n")

const isSemanticCriterion = (criterion: TypedCriterion) => criterion.verification.kind === "semantic_review"

export const todoReviewInput = (review: TodoReviewPackage, changes?: ReplyChangesView, finalResponse?: string, reconciliations?: TodoCriterionReconciliation[]): string => JSON.stringify({
  originalGoal: clip(review.goal, 800),
  userRequestedConstraints: review.constraints.slice(0, 8).map((value) => clip(value, 300)),
  plan: { id: review.planId, revision: review.planRevision },
  task: {
    taskId: review.planTaskId,
    stableId: review.planTaskId,
    todoId: review.task.id,
    title: clip(review.task.title, 300),
    description: clip(review.task.details ?? "", 1200),
    status: review.task.status,
    version: review.task.version
  },
  dependencies: review.dependencies.slice(0, 8),
  semanticCriteria: review.criteria.filter(isSemanticCriterion).map((criterion) => ({ criterionId: criterion.id, description: clip(criterion.description, 400) })),
  hostDecidedCriteria: review.criteria.filter((criterion) => !isSemanticCriterion(criterion)).map((criterion) => {
    const entry = reconciliationFor(reconciliations ?? [], criterion.id)
    return {
      criterionId: criterion.id,
      description: clip(criterion.description, 400),
      outcome: entry?.outcome ?? "unknown",
      supportingObservationIds: entry?.supportingObservationIds.slice(0, 8) ?? [],
      missing: entry?.missing.slice(0, 4).map((value) => clip(value, 300)) ?? []
    }
  }),
  modelAuthoredEvidenceNotes: review.evidence.slice(0, 8).map((entry) => ({ id: entry.id, kind: entry.kind, result: entry.result, summary: clip(entry.summary, 500) })),
  relevantFileChanges: changes?.files.slice(0, 20).map((file) => ({ path: clip(file.path, 240), status: file.status, added: file.added, removed: file.removed })),
  previousEvaluation: review.lastEvaluation ? {
    decision: review.lastEvaluation.decision,
    problems: review.lastEvaluation.problems.slice(0, 5),
    correctiveInstructions: review.lastEvaluation.correctiveInstructions.slice(0, 5)
  } : undefined,
  previouslyVerifiedCriteria: review.lastEvaluation?.criteria
    .filter((criterion) => criterion.status === "passed")
    .map((criterion) => ({ criterionId: criterion.criterionId, evidenceRefs: criterion.evidenceRefs.slice(0, 8) })),
  trustedTwinnyToolObservations: preserveObservationSet(review).map((entry) => ({
    id: entry.id,
    toolName: entry.toolName,
    arguments: Object.fromEntries(Object.entries(entry.arguments).slice(0, 8).map(([key, value]) => [clip(key, 100), clip(value, 500)])),
    output: clip(entry.output, 4000),
    retainedContent: retainedContentFor(review, entry.id),
    evidence: describeEvidenceStatus(entry.evidence),
    failed: entry.failed,
    ...(entry.exitCode !== undefined ? { exitCode: entry.exitCode } : {})
  })),
  sharedTrustedObservations: sharedObservationRecords(review, preserveObservationSet(review)).map((entry) => ({
    id: entry.id,
    taskId: entry.taskId,
    toolName: entry.toolName,
    arguments: Object.fromEntries(Object.entries(entry.arguments).slice(0, 8).map(([key, value]) => [clip(key, 100), clip(value, 500)])),
    failed: entry.failed,
    ...(entry.exitCode !== undefined ? { exitCode: entry.exitCode } : {})
  })),
  implementerFinalResponseUntrusted: finalResponse ? clip(finalResponse, 1200) : undefined
})

const reviewsInFlight = new Map<string, Promise<TodoEvaluation>>()

/**
 * Plan tasks awaiting Feedback: a task with no evaluation, or one whose last
 * evaluation predates its current version (a claim or new evidence arrived).
 */
/** A task is reviewable only once every prerequisite is verified; otherwise its claim waits without a Feedback call. */
export const dependenciesComplete = (review: TodoReviewPackage): boolean =>
  review.dependencies.every((dependency) => dependency.status === "completed")

export const reviewCandidates = (reviews: TodoReviewPackage[], itemId?: string): TodoReviewPackage[] =>
  (itemId
    ? reviews.filter((review) => review.task.id === itemId)
    : reviews.filter((review) => !review.lastEvaluation || review.lastEvaluation.metadata.taskVersion !== review.task.version - 1)
  ).filter(dependenciesComplete)

/** Completes pending reviews whose every objective criterion is proven by trusted, current facts. Feedback is never consulted. */
export const completeProvenReviews = async (
  repository: import("./repository").TodoRepository,
  scope: import("./types").TodoWriteRequest,
  readCurrentSource?: CurrentSourceReader,
  options: { isCancelled?: () => boolean } = {}
): Promise<string[]> => {
  const completed: string[] = []
  for (const review of await repository.getReviewPackages(scope, { includeOpen: true })) {
    if (options.isCancelled?.()) break
    if (review.task.status !== "pending" && review.task.status !== "in_progress") continue
    if (!dependenciesComplete(review) || taskRequiresWorkspaceChanges(review.criteria)) continue
    if (!(await provenTodoEvaluation(review, readCurrentSource))) continue
    if (options.isCancelled?.()) break
    const claimed = await repository.updateItem(scope, {
      itemId: review.task.id,
      expectedVersion: review.task.version,
      patch: { status: "in_review" },
      actor: "model",
      requestId: randomUUID()
    })
    const fresh = (await repository.getReviewPackages(scope)).find((candidate) => candidate.task.id === review.task.id)

    const verdict = fresh ? await provenTodoEvaluation(fresh, readCurrentSource) : undefined
    if (!fresh || !verdict) {
      logger.warn(`[Evidence] lazy completion of ${review.planTaskId} was not reproduced on re-check; the turn-end review will decide`)
      continue
    }
    if (options.isCancelled?.()) {
      // A claim made before cancellation is released so the task is not left in review without a verdict.
      await repository.updateItem(scope, {
        itemId: claimed.id,
        expectedVersion: claimed.version,
        patch: { status: "in_progress" },
        actor: "model",
        requestId: randomUUID()
      })
      break
    }
    await repository.applyEvaluation(scope, fresh.task.id, fresh.task.version, verdict, evaluationRequestId(fresh))
    logger.info(`[Evidence] completed ${review.planTaskId} from trusted facts without Feedback or implementer investigation (criteria=${review.criteria.length}, claimedVersion=${claimed.version})`)
    completed.push(review.planTaskId)
  }
  return completed
}

/**
 * Host-only proof: a verdict exists only when every criterion is proven by trusted, current facts. Never consults Feedback.
 * Partial or unproven work returns undefined, so the normal review path investigates only what is still missing.
 */
export const provenTodoEvaluation = async (
  review: TodoReviewPackage,
  readCurrentSource?: CurrentSourceReader
): Promise<TodoEvaluation | undefined> => {
  const reconciliations = await reviewReconciliations(review, readCurrentSource)
  const evaluation = deterministicTodoEvaluation(review, reconciliations)
  return evaluation?.decision === "accept" ? evaluation : undefined
}

/**
 * Whether the host can decide a review from its own trusted observations alone, so no Feedback model is needed.
 * True when no criterion is semantic, even when some remain unproven and the decision is needs_evidence.
 */
export const hostDecidesReview = async (review: TodoReviewPackage, readCurrentSource?: CurrentSourceReader): Promise<boolean> => {
  const reconciliations = await reviewReconciliations(review, readCurrentSource)
  return deterministicTodoEvaluation(review, reconciliations) !== undefined
}

/**
 * The host's unresolved reasons for objective criteria. A non-accepting decision must name the missing predicate, so these
 * fill any problems the evaluator left empty. Semantic criteria are judged by the evaluator and are never described here.
 */
const unresolvedProblems = (review: TodoReviewPackage, reconciliations: TodoCriterionReconciliation[]): string[] =>
  review.criteria.flatMap((criterion) => {
    const reconciliation = reconciliationFor(reconciliations, criterion.id)
    if (!reconciliation || reconciliation.outcome === "proven" || reconciliation.outcome === "semantic") return []
    const reasons = reconciliation.missing.length ? reconciliation.missing : ["no trusted observation proves this criterion"]
    return reasons.map((reason) => `${criterion.description} — ${reason}`.slice(0, 500))
  }).slice(0, 20)

const addUnresolvedReasons = (problems: string[], review: TodoReviewPackage, reconciliations: TodoCriterionReconciliation[]): string[] => {
  for (const reason of unresolvedProblems(review, reconciliations)) {
    if (problems.length >= 20) break
    if (!problems.includes(reason)) problems.push(reason)
  }
  return problems
}

export const evaluateTodoReview = (
  repository: import("./repository").TodoRepository,
  scope: import("./types").TodoWriteRequest,
  review: TodoReviewPackage,
  evaluator: (correction?: string, reconciliations?: TodoCriterionReconciliation[]) => Promise<string>,
  evaluatorName: string,
  requirements: { hasVerifiedFileChanges?: boolean; readCurrentSource?: CurrentSourceReader } = {}
): Promise<TodoEvaluation> => {
  const key = `${scope.projectFingerprint}\n${scope.conversationId}\n${review.task.id}\n${review.task.version}`
  const inFlight = reviewsInFlight.get(key)
  if (inFlight) return inFlight
  const operation = (async () => {
  const reconciliations = await reviewReconciliations(review, requirements.readCurrentSource)
    const deterministic = deterministicTodoEvaluation(review, reconciliations)
    logger.debug("[Feedback] criteria task=" + review.task.id + " " + reconciliations.map((item, i) => `${i}=${item.outcome}${item.facts?.length ? `(facts=${item.facts.length})` : ""}${item.reuse ? "(reuse)" : ""}`).join(" ") + " path=" + (deterministic ? "deterministic" : "feedback"))
    reconciliations.forEach((item, i) => {
      if (item.missing.length) logger.trace("[Feedback] criterion " + i + " " + item.outcome + " missing: " + item.missing.join("; ").slice(0, 400))
    })
    let result: TodoEvaluation
    if (deterministic) {
      result = deterministic
    } else {
      let raw = await evaluator(undefined, reconciliations)
      try {
        result = parseTodoEvaluation(raw, review, evaluatorName, new Date().toISOString(), reconciliations)
      } catch (error) {
        if (!(error instanceof TodoEvaluationValidationError)) throw error
        logger.warn("[FeedbackEvaluator] Invalid response (code=" + error.code + ", field=" + (error.field ?? "root") + "): " + error.message + "; expected=" + JSON.stringify(error.expected) + "; received=" + JSON.stringify(error.received) + "; raw=" + redact(raw).slice(0, 4000))
        raw = await evaluator("Your prior response failed validation (" + error.code + ": " + error.message + "). Return a corrected JSON object only. The canonical taskId must be exactly " + JSON.stringify(review.planTaskId) + ". Do not change the supplied task criteria or invent evidence.", reconciliations)
        try {
          result = parseTodoEvaluation(raw, review, evaluatorName, new Date().toISOString(), reconciliations)
        } catch (retryError) {
          if (retryError instanceof TodoEvaluationValidationError) {
            logger.warn("[FeedbackEvaluator] Correction response still invalid (code=" + retryError.code + ", field=" + (retryError.field ?? "root") + "): " + retryError.message + "; expected=" + JSON.stringify(retryError.expected) + "; received=" + JSON.stringify(retryError.received) + "; raw=" + redact(raw).slice(0, 4000))
          }
          throw retryError
        }
      }
    }
    const workspaceChangesMissing = taskRequiresWorkspaceChanges(review.criteria) && !requirements.hasVerifiedFileChanges
    const workspaceProblem = "No verified workspace file changes were recorded for this implementation request."
    if (result.decision === "accept" && workspaceChangesMissing) {
      result.decision = "needs_evidence"
      result.criteria = result.criteria.map((criterion) => ({ ...criterion, status: "unverified", evidenceRefs: [] }))
      result.correctiveInstructions.push("Implement the requested source changes and provide trusted verification evidence.")
    }
    if (workspaceChangesMissing && result.decision !== "accept" && !result.problems.includes(workspaceProblem) && result.problems.length < 20) result.problems.push(workspaceProblem)
    if (result.decision !== "accept") addUnresolvedReasons(result.problems, review, reconciliations)
    const verdictSource = deterministic ? "deterministic" : "feedback evaluator=" + evaluatorName
    if (!deterministic) {
      const proven = reconciliations.filter((item) => item.outcome === "proven").length
      const disproven = reconciliations.some((item) => item.outcome === "disproven")
      if (result.decision !== "accept" && reconciliations.length && proven === reconciliations.length) {
        logger.debug("[Feedback] conflict task=" + review.task.id + " decision=" + result.decision + " but every criterion is proven by trusted observations")
      } else if (result.decision === "accept" && disproven) {
        logger.debug("[Feedback] conflict task=" + review.task.id + " decision=accept but a criterion is disproven by trusted observations")
      }
    }
    logger.info("[Feedback] todo.verdict source=" + verdictSource + " decision=" + result.decision + " task=" + review.task.id)
    return repository.applyEvaluation(scope, review.task.id, review.task.version, result, evaluationRequestId(review))
  })().finally(() => reviewsInFlight.delete(key))
  reviewsInFlight.set(key, operation)
  return operation
}
