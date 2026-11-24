/**
 * The project's own evidence storage policy, read from `<projectHome>/.twinny/config.json` next to
 * `project.sqlite`. This file is the single source of truth for quotas and eviction: the
 * `storage_policy` table row is only an audit snapshot of what was in force for a write, never a
 * setting of its own, and nothing here writes or resets a user's configuration.
 *
 * A missing file uses the documented defaults. An unreadable, corrupt or invalid file is reported as
 * an actionable error: it is never overwritten, never silently fallen back on, and no database is
 * touched because of it. Keys outside `evidence.storage` are preserved as they are and reported,
 * including a `git` section that its own module reads; sharing the parser changes nothing here.
 *
 * File location, JSON parsing and the changed-on-disk reload cache live in `project-config.ts` and are
 * shared with the Git reader. The evidence section's defaults, validation and error wording are
 * unchanged.
 */
import { isRecord } from "../../common/guards"

import { type ConfigProblem, createDocumentSource, type DocumentReading, otherKeysOf, readProjectConfigDocument } from "./project-config"

export { PROJECT_CONFIG_NAME } from "./project-config"

/** Stage 1 keeps today's order; the favourite tier is Stage 6's, so the name says what was actually used. */
export type PolicyEvictionOrder = "oldest_unfavourited_first" | "oldest_first"
/** `presentation_only` keeps captured bytes whole; a policy that forbids raw secrets must say so. */
export type PolicyRedactionMode = "presentation_only" | "exclude_raw_secrets"

export interface EvidenceStoragePolicy {
  maxProjectBytes: number
  maxBlobBytes: number
  evictionOrder: PolicyEvictionOrder
  redactionMode: PolicyRedactionMode
  enabled: boolean
}

/** The documented defaults, used only when the project names no config file of its own. */
export const DEFAULT_EVIDENCE_STORAGE_POLICY: EvidenceStoragePolicy = {
  maxProjectBytes: 64_000_000,
  maxBlobBytes: 2_000_000,
  evictionOrder: "oldest_unfavourited_first",
  redactionMode: "presentation_only",
  enabled: true
}

export const POLICY_BOUNDS = { minProjectBytes: 1, maxProjectBytes: 1_000_000_000, minBlobBytes: 1, maxBlobBytes: 100_000_000 }

/** What the reader decided for one project, with what it was given. */
export interface EffectivePolicy {
  path: string
  source: "defaults" | "config.json"
  policy: EvidenceStoragePolicy
  /** Keys this policy does not read; reported so nothing is silently dropped. */
  otherKeys: string[]
}

/** The same problem shape every project config section reports. */
export type InvalidPolicy = ConfigProblem

export type PolicyReading =
  | { state: "effective"; reading: EffectivePolicy }
  | { state: "invalid"; path: string; reason: string }

const wholeBytes = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined

const outOfRange = (key: string, value: number, bounds: { min: number; max: number }): string =>
  `${key} ${value} is outside the documented range ${bounds.min}-${bounds.max} bytes`

/** A key the file does not name keeps its documented default; a key it does name is checked against it. */
const BYTE_BOUNDS = { maxProjectBytes: { min: POLICY_BOUNDS.minProjectBytes, max: POLICY_BOUNDS.maxProjectBytes }, maxBlobBytes: { min: POLICY_BOUNDS.minBlobBytes, max: POLICY_BOUNDS.maxBlobBytes } }

/** One actionable line per problem: what was read, what was expected, and where it has to sit. */
const validateStorage = (storage: Record<string, unknown>, file: string): InvalidPolicy | undefined => {
  const problems: string[] = []
  for (const key of ["maxProjectBytes", "maxBlobBytes"] as const) {
    if (storage[key] === undefined) continue
    const value = wholeBytes(storage[key])
    if (value === undefined) problems.push(`evidence.storage.${key} must be a whole nonnegative number of bytes`)
    else if (value < BYTE_BOUNDS[key].min || value > BYTE_BOUNDS[key].max) problems.push(outOfRange(`evidence.storage.${key}`, value, BYTE_BOUNDS[key]))
  }
  if ("evictionOrder" in storage && storage.evictionOrder !== "oldest_unfavourited_first" && storage.evictionOrder !== "oldest_first")
    problems.push(`evidence.storage.evictionOrder must be "oldest_unfavourited_first" or "oldest_first", not ${JSON.stringify(storage.evictionOrder)}`)
  if ("redactionMode" in storage && storage.redactionMode !== "presentation_only" && storage.redactionMode !== "exclude_raw_secrets")
    problems.push(`evidence.storage.redactionMode must be "presentation_only" or "exclude_raw_secrets", not ${JSON.stringify(storage.redactionMode)}`)
  if ("enabled" in storage && typeof storage.enabled !== "boolean")
    problems.push("evidence.storage.enabled must be true or false")
  if (problems.length === 0) return undefined
  return { path: file, reason: `${problems.join("; ")}; the file was left as it is` }
}

/** What the evidence section of a shared document says, or the problem it has with it. */
const evidenceReadingOf = (document: DocumentReading): PolicyReading => {
  if (document.state === "invalid") return { state: "invalid", path: document.path, reason: document.reason }
  const source = document.reading
  const file = source.path
  const otherKeys = otherKeysOf(source.document, "evidence")
  const evidence = source.document.evidence
  if (evidence === undefined || evidence === null)
    return { state: "effective", reading: { path: file, source: source.source, policy: { ...DEFAULT_EVIDENCE_STORAGE_POLICY }, otherKeys } }
  if (!isRecord(evidence))
    return { state: "invalid", path: file, reason: `evidence must be an object, not ${Array.isArray(evidence) ? "an array" : String(evidence)}` }
  const storage = (evidence as Record<string, unknown>).storage
  if (storage === undefined || storage === null)
    return { state: "effective", reading: { path: file, source: source.source, policy: { ...DEFAULT_EVIDENCE_STORAGE_POLICY }, otherKeys } }
  if (!isRecord(storage))
    return { state: "invalid", path: file, reason: `evidence.storage must be an object, not ${Array.isArray(storage) ? "an array" : String(storage)}` }
  const given = storage as Record<string, unknown>
  const invalid = validateStorage(given, file)
  if (invalid) return { state: "invalid", ...invalid }
  const defaults = DEFAULT_EVIDENCE_STORAGE_POLICY
  return {
    state: "effective",
    reading: {
      path: file,
      source: source.source,
      policy: {
        maxProjectBytes: given.maxProjectBytes === undefined ? defaults.maxProjectBytes : given.maxProjectBytes as number,
        maxBlobBytes: given.maxBlobBytes === undefined ? defaults.maxBlobBytes : given.maxBlobBytes as number,
        evictionOrder: (given.evictionOrder ?? defaults.evictionOrder) as PolicyEvictionOrder,
        redactionMode: (given.redactionMode ?? defaults.redactionMode) as PolicyRedactionMode,
        enabled: given.enabled === undefined ? defaults.enabled : given.enabled as boolean
      },
      otherKeys
    }
  }
}

/** Reads the file as it stands. A corrupt file is reported, not worked around. */
export const readEvidenceStoragePolicy = async (projectHome: string): Promise<PolicyReading> =>
  evidenceReadingOf(await readProjectConfigDocument(projectHome))

/**
 * Safe reload: the file is read again only when it has changed on disk, so a new setting takes effect
 * at the next storage operation without a restart and without re-reading a file that did not change.
 * The stamp cache is the shared one; what this source answers with is still evidence's own reading.
 */
export interface PolicySource {
  effective(): Promise<PolicyReading>
  /** What this source last answered with, for diagnostics. */
  last(): PolicyReading | undefined
}

export const createPolicySource = (projectHome: string): PolicySource => {
  const documents = createDocumentSource(projectHome)
  let last: PolicyReading | undefined
  let lastDocument: DocumentReading | undefined
  return {
    effective: async () => {
      const document = await documents.effective()
      // A file that did not change answers with the same reading, exactly as before the parser was shared.
      if (last && lastDocument === document) return last
      const reading = evidenceReadingOf(document)
      last = reading
      lastDocument = document
      return reading
    },
    last: () => last
  }
}

/** The effective-policy line a diagnostic or a test reads: what was used and where it came from. */
export const describeEffectivePolicy = (reading: PolicyReading): string => {
  if (reading.state === "invalid") return `${reading.path}: ${reading.reason}`
  const policy = reading.reading.policy
  return `${reading.reading.path} (${reading.reading.source}): maxProjectBytes=${policy.maxProjectBytes}, ` +
    `maxBlobBytes=${policy.maxBlobBytes}, evictionOrder=${policy.evictionOrder}, redactionMode=${policy.redactionMode}, ` +
    `enabled=${policy.enabled}` +
    (reading.reading.otherKeys.length > 0 ? `; keys read but not used: ${reading.reading.otherKeys.join(", ")}` : "")
}
