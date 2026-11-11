import type { SourceIdentity, TodoToolObservation, TypedCriterion } from "../../common/types"
import { codeIdentifiers } from "./evidence"
import { type AcceptedFactStatus, assessAcceptedFacts, type CurrentSourceReader, factMatchesSymbol, factNamedBy } from "./feedback"
import { acceptedFactEntry } from "./plan-context"
import type { AcceptedFact, AcceptedFactUsage } from "./types"

/**
 * Character budgets for the evidence the implementer sees. Each covers the entries of one window; headings sit outside it.
 * The worst case for all three windows together is their sum.
 */
export interface EvidenceBudget {
  required: number
  promoted: number
  recent: number
}

export const EVIDENCE_BUDGET: EvidenceBudget = { required: 3000, promoted: 2400, recent: 2400 }

/** Upper bound on one observation line, so a single large tool output cannot take a window. */
const ENTRY_LIMIT = 600
/** Freshness is checked in batches so a large project does not read every source file on each request. */
const PROMOTION_BATCH = 12

export interface EvidenceRequirement {
  identity: SourceIdentity
  symbol: string
  path?: string
}

/** The symbol subjects of the criteria that accepted facts can prove. Other criteria are proven by other evidence. */
export const requirementsOf = (criteria: TypedCriterion[]): EvidenceRequirement[] =>
  criteria.flatMap(({ verification }) =>
    verification.kind === "accepted_fact_exists" || verification.kind === "source_location" || verification.kind === "source_range" || verification.kind === "source_fingerprint"
      ? [{ identity: verification.identity, symbol: verification.symbol, path: verification.path }]
      : [])

/** Relevance for ordering only. A request that names a fact never makes it authoritative. */
const namedInRequest = (requestText: string, subjects: Set<string>, fact: AcceptedFact): boolean =>
  [...subjects].some((subject) => factMatchesSymbol(fact, subject)) || requestText.includes(fact.path)

/**
 * Live facts that a criterion names, or that the request names. Historical and unverifiable facts stay in the set, with their
 * status, so the implementer re-reads them rather than trusting them.
 */
export const factsNamedByRequirement = (facts: AcceptedFact[], requirements: EvidenceRequirement[], requestText: string): AcceptedFact[] => {
  const subjects = new Set(codeIdentifiers(requestText))
  return facts.filter((fact) => !fact.supersededBy && (
    requirements.some((requirement) => factNamedBy(requirement.identity, requirement.symbol, fact) && (requirement.path === undefined || requirement.path === fact.path))
    || namedInRequest(requestText, subjects, fact)
  ))
}

/** Limits one entry, so an observation's output never takes the window. Facts are not clipped; their text is what is budgeted. */
export const boundedText = (value: string): string => value.length > ENTRY_LIMIT ? value.slice(0, ENTRY_LIMIT - 1) + "…" : value

/** The operation an observation records. A later success resolves an earlier failure only for the same operation. */
const operationOf = (observation: TodoToolObservation): string =>
  [observation.toolName, observation.arguments.path ?? observation.arguments.file ?? "", observation.arguments.command ?? ""].join("\u0000")

/**
 * Failures from one execution that no later success of the same operation resolved. `observations` must be newest first.
 * Failures from other executions, and observations without an execution, never appear, so earlier executions cannot leak in.
 */
export const unresolvedFailures = (observations: TodoToolObservation[], executionId: string | undefined): TodoToolObservation[] => {
  if (!executionId) return []
  const succeeded = new Set<string>()
  const failures: TodoToolObservation[] = []
  for (const observation of observations) {
    if (observation.executionId !== executionId) continue
    const operation = operationOf(observation)
    if (!observation.failed) succeeded.add(operation)
    else if (!succeeded.has(operation)) failures.push(observation)
  }
  return failures
}

/**
 * Orders usage by meaningful independent use. Lifetime usage, then verification reuse, then relevance to this request and plan,
 * then acceptance time and ID, so the order is deterministic and explainable. This orders what is shown; it never changes verification.
 */
export const rankPromotionCandidates = (usage: AcceptedFactUsage[], requestText: string, planItemIds: string[]): AcceptedFactUsage[] => {
  const subjects = new Set(codeIdentifiers(requestText))
  const planItems = new Set(planItemIds)
  return usage
    .map((entry) => ({
      entry,
      relevance: (namedInRequest(requestText, subjects, entry.fact) ? 2 : 0) + (planItems.has(entry.fact.itemId) ? 1 : 0)
    }))
    .sort((left, right) =>
      (right.entry.lookups + right.entry.reuses) - (left.entry.lookups + left.entry.reuses)
      || right.entry.reuses - left.entry.reuses
      || right.relevance - left.relevance
      || right.entry.fact.acceptedAt.localeCompare(left.entry.fact.acceptedAt)
      || left.entry.fact.id.localeCompare(right.entry.fact.id))
    .map(({ entry }) => entry)
}

/** How many leading texts fit in `budget` characters. The first misfit stops the count, so priority order is kept. */
const countWithin = (texts: string[], budget: number): number => {
  let used = 0
  let count = 0
  for (const text of texts) {
    if (used + text.length + 1 > budget) break
    used += text.length + 1
    count++
  }
  return count
}

/** The leading texts that fit a budget, with how many were left out. Used for both windows and for continuation. */
export const fitTexts = (texts: string[], budget: number): { kept: string[]; omitted: number } => {
  const count = countWithin(texts, budget)
  return { kept: texts.slice(0, count), omitted: texts.length - count }
}

/** Entries a continuation section renders. The last slot is kept for the omission notice when entries are left out. */
const SECTION_ENTRIES = 8

/**
 * Fits continuation list entries to a budget and to the section's entry limit. Anything left out is named in the final entry,
 * so a continuation never presents a partial list as complete.
 */
export const fitForSection = (texts: string[], budget: number, noun: string): string[] => {
  const shown = fitTexts(texts, budget).kept.slice(0, SECTION_ENTRIES - 1)
  const hidden = texts.length - shown.length
  return hidden ? [...shown, `… ${hidden} more ${noun} not shown`] : shown
}

export interface EvidenceInput {
  requestText: string
  planItemIds: string[]
  criteria: TypedCriterion[]
  /** Host-generated execution that owns the recent window and the unresolved failures. Absent means neither window has an owner. */
  executionId?: string
  /** Every accepted fact in the project, live and superseded. Only the required window reads it. */
  facts: AcceptedFact[]
  /** Current facts in the project with lifetime lookup and reuse counts. This is the promoted window's candidate set. */
  usage: AcceptedFactUsage[]
  /** The active item's observations, newest first. */
  observations: TodoToolObservation[]
  observationText: (observation: TodoToolObservation) => string
  readCurrent?: CurrentSourceReader
  budget?: EvidenceBudget
}

export interface EvidenceProjection {
  /** Required facts, in priority order, with status. Historical ones are shown so they are re-read, not trusted. */
  requiredFacts: AcceptedFactStatus[]
  /** Rendered lines for unresolved failures from this execution, newest first. */
  requiredFailures: string[]
  /** Current facts from the project ranked by use. Only facts that are current under their fingerprint appear. */
  promoted: AcceptedFactStatus[]
  /** Rendered lines for this execution's recent observations, newest first. */
  recent: string[]
  omitted: { required: number; promoted: number; recent: number }
}

/**
 * Selects the evidence for one request, without rendering it or changing the repository. Required evidence is chosen first,
 * then promoted facts that are not already shown, then recent observations that are not already shown or referenced by
 * a shown fact. Each window has its own budget, so one window cannot starve another.
 */
export const projectEvidence = async (input: EvidenceInput): Promise<EvidenceProjection> => {
  const budget = input.budget ?? EVIDENCE_BUDGET
  const failures = unresolvedFailures(input.observations, input.executionId)
  const failureLines = failures.map((observation) => `- unresolved failure: ${boundedText(input.observationText(observation))}`)
  const failureCount = countWithin(failureLines, budget.required)
  const failureUsed = failureLines.slice(0, failureCount).reduce((total, line) => total + line.length + 1, 0)

  const named = (await assessAcceptedFacts(factsNamedByRequirement(input.facts, requirementsOf(input.criteria), input.requestText), input.readCurrent))
    .sort((left, right) => (left.freshness === "current" ? 0 : 1) - (right.freshness === "current" ? 0 : 1)
      || right.fact.acceptedAt.localeCompare(left.fact.acceptedAt)
      || left.fact.id.localeCompare(right.fact.id))
  const factCount = countWithin(named.map(acceptedFactEntry), budget.required - failureUsed)
  const requiredFacts = named.slice(0, factCount)
  const shownFactIds = new Set(requiredFacts.map((status) => status.fact.id))

  const ranked = rankPromotionCandidates(input.usage.filter((entry) => !shownFactIds.has(entry.fact.id)), input.requestText, input.planItemIds)
  const promoted: AcceptedFactStatus[] = []
  let promotedUsed = 0
  let full = false
  for (let start = 0; !full && start < ranked.length; start += PROMOTION_BATCH) {
    const statuses = await assessAcceptedFacts(ranked.slice(start, start + PROMOTION_BATCH).map((entry) => entry.fact), input.readCurrent)
    for (const status of statuses) {
      if (status.freshness !== "current") continue
      const size = acceptedFactEntry(status).length + 1
      if (promotedUsed + size > budget.promoted) {
        full = true
        break
      }
      promotedUsed += size
      promoted.push(status)
    }
  }

  const shownFailures = failures.slice(0, failureCount)
  const shownObservationIds = new Set([
    ...shownFailures.map((observation) => observation.id),
    ...requiredFacts.map((status) => status.fact.observationId),
    ...promoted.map((status) => status.fact.observationId)
  ])
  const recentCandidates = input.executionId
    ? input.observations.filter((observation) => observation.executionId === input.executionId && !shownObservationIds.has(observation.id))
    : []
  const recent = fitTexts(recentCandidates.map((observation) => `- ${boundedText(input.observationText(observation))}`), budget.recent)

  return {
    requiredFacts,
    requiredFailures: failureLines.slice(0, failureCount),
    promoted,
    recent: recent.kept,
    omitted: {
      required: failures.length - failureCount + named.length - factCount,
      promoted: ranked.length - promoted.length,
      recent: recent.omitted
    }
  }
}

/**
 * The required window: unresolved failures, then the facts that criteria or the request name. If any is left out, the text
 * says so, because a partial list must not read as proof that the rest does not exist.
 */
export const renderRequiredEvidence = (projection: EvidenceProjection): string | undefined => {
  const lines = [...projection.requiredFailures, ...projection.requiredFacts.map(acceptedFactEntry)]
  if (!lines.length && !projection.omitted.required) return undefined
  return [
    "Required evidence for this task: unresolved failures from this execution and accepted facts that this task's criteria or the request name. Read it before acting on the related criterion.",
    ...lines,
    ...(projection.omitted.required
      ? [`… ${projection.omitted.required} required item(s) not shown. This excerpt is incomplete and does not prove them; retrieve them with twinny_evidence_lookup or read the source again.`]
      : [])
  ].join("\n")
}

/** The execution window: this execution's recent observations for the active task, newest first, with previews bounded. */
export const renderRecentObservations = (projection: EvidenceProjection): string | undefined => {
  if (!projection.recent.length && !projection.omitted.recent) return undefined
  return [
    "Recent observations from this execution for the active task, newest first. Previews are bounded; full output is not shown here.",
    ...projection.recent,
    ...(projection.omitted.recent ? [`… ${projection.omitted.recent} older observation(s) from this execution not shown.`] : [])
  ].join("\n")
}
