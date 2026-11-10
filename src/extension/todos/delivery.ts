import { samePath } from "./evidence"
import { assessAcceptedFacts, type CurrentSourceReader, factNamedBy } from "./feedback"
import { type AcceptedFact, type AnswerField, type AnswerRequirement } from "./types"

/** An objective value the answer must state, taken from a current accepted fact. */
export interface RequiredValue {
  field: AnswerField
  label: string
  value: string
  pattern: RegExp
}

export type DeliveryVerdict =
  | { outcome: "delivered" }
  | { outcome: "rejected"; detail: string; correction: string }
  | { outcome: "unresolved"; detail: string; correction: string }

/** Template text the model left behind instead of a value, such as `xxh64:<hash_value>` or `<fingerprint>`. */
const PLACEHOLDER = /[a-z][a-z0-9_]*:<[^<>\s]*>|<[a-z_]*(?:hash|fingerprint)[a-z_]*>/i
const FINGERPRINT = /\b[a-z][a-z0-9_]*:[0-9a-f]{16,}\b/g

const escapePattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** The value as a whole token, so a longer path or fingerprint that merely contains it does not count. */
const tokenPattern = (value: string) => new RegExp(`(?<![\\w.-])${escapePattern(value)}(?![\\w/-]|\\.\\w)`)

/** The line range `start-end`, with a dash, "to", or "through", and no digit touching either bound. */
const rangePattern = (start: number, end: number) => new RegExp(`(?<!\\d)L?${start}\\s*(?:-|–|—|to|through|\\.\\.)\\s*L?${end}(?!\\d)`)

const valueFor = (field: AnswerField, fact: AcceptedFact): RequiredValue => {
  if (field === "path") return { field, label: "implementation file", value: fact.path, pattern: tokenPattern(fact.path) }
  if (field === "range") {
    return {
      field,
      label: "implementation line range",
      value: `${fact.startLine}-${fact.endLine}`,
      pattern: rangePattern(fact.startLine, fact.endLine)
    }
  }
  return {
    field,
    label: "authoritative whole-file source fingerprint",
    value: fact.sourceHash,
    pattern: tokenPattern(fact.sourceHash)
  }
}

type Resolution = { values: RequiredValue[]; trusted: string[] } | { unresolved: string }

/**
 * Resolves one requirement from the project's current accepted facts. A stale, unverifiable, missing, or conflicting
 * fact resolves to nothing: no value is inferred from a model claim, from a tool registration line, or from a fact
 * whose boundary was never measured.
 */
const resolveRequirement = async (
  requirement: AnswerRequirement,
  facts: AcceptedFact[],
  readCurrent: CurrentSourceReader | undefined
): Promise<Resolution> => {
  const { identity, symbol, path } = requirement.source
  const subject = `${identity} ${symbol} in ${path ?? "any file"}`
  const matching = facts.filter((fact) =>
    !fact.supersededBy && factNamedBy(identity, symbol, fact) && (path === undefined || samePath(fact.path, path)))
  if (matching.length === 0) return { unresolved: `no accepted fact records ${subject}` }
  const statuses = await assessAcceptedFacts(matching, readCurrent)
  const current = statuses.filter((status) => status.freshness === "current").map((status) => status.fact)
  if (current.length === 0) {
    return { unresolved: `no current accepted fact for ${subject}: ${statuses.map((status) => status.reason ?? status.freshness).join("; ")}` }
  }
  const fact = current.reduce((latest, next) => (next.acceptedAt > latest.acceptedAt ? next : latest))
  if (!Number.isInteger(fact.startLine) || !Number.isInteger(fact.endLine) || !fact.sourceHash) {
    return { unresolved: `the accepted fact for ${subject} has no measured boundary or fingerprint` }
  }
  const disagrees = current.some((other) =>
    other.path !== fact.path || other.startLine !== fact.startLine || other.endLine !== fact.endLine || other.sourceHash !== fact.sourceHash)
  if (disagrees) return { unresolved: `the current accepted facts for ${subject} disagree` }
  return { values: requirement.fields.map((field) => valueFor(field, fact)), trusted: [fact.sourceHash] }
}

/** The first missing or contradicting part of a reply, or undefined when every required value is stated and nothing invented. */
const replyFault = (reply: string, values: RequiredValue[], trusted: Set<string>): string | undefined => {
  const placeholder = PLACEHOLDER.exec(reply)
  if (placeholder) return `the answer contains the placeholder "${placeholder[0]}"`
  for (const value of values) {
    if (!value.pattern.test(reply)) return `the answer does not state the ${value.label}`
  }
  for (const match of reply.matchAll(FINGERPRINT)) {
    if (!trusted.has(match[0])) return `the answer states the fingerprint "${match[0]}", which no current accepted fact supports`
  }
  return undefined
}

const rejectedCorrection = (detail: string, values: RequiredValue[]) => [
  `The answer was not delivered: ${detail}.`,
  "The task is complete, but the answer must state these host-verified values:",
  ...values.map((value) => `- ${value.label}: ${value.value}`),
  "Reply with the complete answer using only these values. Do not run commands or recalculate any hash."
].join("\n")

const unresolvedCorrection = (detail: string) => [
  `The answer cannot be delivered yet: ${detail}.`,
  "Do not state values that the host has not verified. Re-establish the current source facts with the native lookup and read tools, then answer."
].join("\n")

/**
 * Checks a reply against the plan's typed answer requirements. Only the objective values are checked; the wording of the
 * reply is not. A reply that meets no requirement is never delivered, and missing evidence is reported as unresolved.
 */
export const checkDelivery = async (
  reply: string,
  requirements: AnswerRequirement[],
  facts: AcceptedFact[],
  readCurrent: CurrentSourceReader | undefined
): Promise<DeliveryVerdict> => {
  if (requirements.length === 0) return { outcome: "delivered" }
  const values: RequiredValue[] = []
  const trusted = new Set<string>()
  for (const requirement of requirements) {
    const resolution = await resolveRequirement(requirement, facts, readCurrent)
    if ("unresolved" in resolution) {
      return { outcome: "unresolved", detail: resolution.unresolved, correction: unresolvedCorrection(resolution.unresolved) }
    }
    values.push(...resolution.values)
    resolution.trusted.forEach((value) => trusted.add(value))
  }
  const fault = replyFault(reply, values, trusted)
  if (fault) return { outcome: "rejected", detail: fault, correction: rejectedCorrection(fault, values) }
  return { outcome: "delivered" }
}
