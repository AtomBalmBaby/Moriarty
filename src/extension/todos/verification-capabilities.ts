import type { CriterionVerificationKind, SourceIdentity, TypedCriterion } from "../../common/types"

/**
 * What the deterministic verifier can decide for one criterion kind. Plan validation and host verification both read this
 * table, so a plan is accepted only for kind, identity, and field combinations the verifier implements.
 */
export interface VerificationCapability {
  /** Fields a descriptor of this kind may carry besides `kind`. */
  fields: readonly string[]
  /** Source identities the verifier can prove for this kind. Empty when the kind names no source identity. */
  identities: readonly SourceIdentity[]
}

const SOURCE_IDENTITIES: readonly SourceIdentity[] = ["registered_tool", "implementation_symbol"]
const SOURCE_FIELDS = ["kind", "identity", "symbol", "path"] as const

export const VERIFICATION_CAPABILITIES: Record<CriterionVerificationKind, VerificationCapability> = {
  evidence_lookup_completed: { fields: ["kind"], identities: [] },
  accepted_fact_exists: { fields: SOURCE_FIELDS, identities: SOURCE_IDENTITIES },
  source_location: { fields: SOURCE_FIELDS, identities: SOURCE_IDENTITIES },
  source_range: { fields: SOURCE_FIELDS, identities: SOURCE_IDENTITIES },
  source_fingerprint: { fields: SOURCE_FIELDS, identities: SOURCE_IDENTITIES },
  execution_invariant: { fields: ["kind", "invariant"], identities: [] },
  workspace_mutation: { fields: ["kind", "operation"], identities: [] },
  command_exit_status: { fields: ["kind", "command", "exitCode", "scope", "execution"], identities: [] },
  semantic_review: { fields: ["kind"], identities: [] }
}

/** The capability for a stored or submitted kind, or undefined when the verifier does not implement it. */
export const capabilityOf = (kind: string): VerificationCapability | undefined =>
  Object.prototype.hasOwnProperty.call(VERIFICATION_CAPABILITIES, kind) ? VERIFICATION_CAPABILITIES[kind as CriterionVerificationKind] : undefined

/**
 * A task-level contradiction the verifier can decide from the descriptors alone: `no_mutating_tool_calls` prohibits every
 * mutating tool call in the plan, so a `workspace_mutation` requirement can never be satisfied beside it.
 */
export const contradictoryCriteria = (criteria: readonly TypedCriterion[]): { prohibition: TypedCriterion; requirement: TypedCriterion } | undefined => {
  const prohibition = criteria.find((criterion) => criterion.verification.kind === "execution_invariant" && criterion.verification.invariant === "no_mutating_tool_calls")
  const requirement = criteria.find((criterion) => criterion.verification.kind === "workspace_mutation")
  return prohibition && requirement ? { prohibition, requirement } : undefined
}
