/**
 * Source-reference validity, decided in one place (Stage 12).
 *
 * The project evidence repository owns this boundary. A file reference is checked when it
 * is stored and again when it is read back, so storage, project lookup, preflight, Feedback
 * packages, retained evidence and accepted facts all report the same states from the same
 * rules. A consumer never opts in to correctness by passing a reader: the boundary reads the
 * authoritative source itself, and the only thing the host hands it is what the editor has open,
 * which a Node process cannot know.
 *
 * States for one reference (§2.6): the recorded fingerprint matches the current source →
 * `valid`; the file exists with different content → `stale`; the file is gone → `invalid`;
 * matching content restored → `valid` again. Aggregate over a result: `invalid` beats `stale`
 * beats `valid`. An ordinary I/O error — permission, a file too large to read, binary content —
 * is not one of those states; it stays on the existing error path and is reported as
 * `unverifiable`. A result that recorded no fingerprint gets no invented one and no file
 * validity, so a model-asserted hash in tool output is not compared here: it is content, not a
 * reference.
 *
 * A `read_file` hit is one line, so it cannot carry its own hash; only the whole-file identity
 * is stored for it, and a hit is judged against the current whole file.
 *
 * The five classes of §6 are additive to those states. A class is what the boundary reports for a record once
 * recorded dependency and event context is taken into account; it never replaces a state, and a consumer never
 * decides one by itself. Only a relationship an actual operation established counts: no file is resolved from a
 * matching fingerprint, no dependency is read out of command text, and a change detected with latency proves no
 * state before a verified read reconciles it.
 */
import { promises as fs } from "node:fs"

import { looksBinary } from "../embeddings/indexable"
import { verifyContentFingerprint } from "../tools/fingerprint"

import type { ObservedSourceReference, ObservedVersion } from "./evidence"
import type { SourceRoots } from "./source-roots"

/** `valid`, `stale` and `invalid` are §2.6. `unverifiable` is not a state: it is the existing error path. */
export type SourceValidity = "valid" | "stale" | "invalid" | "unverifiable"

/** A file reference as the repository recorded it. */
export type RecordedSourceReference = ObservedSourceReference

/** The same reference after the boundary checked it. */
export interface CheckedSourceReference extends ObservedSourceReference {
  /** The version the boundary read: the open buffer for a buffer reference, otherwise the saved file. */
  checkedAgainst: ObservedVersion
  /** False when the check read an unsaved buffer: a buffer check says nothing about the saved file. */
  persistedSource: boolean
  validity: SourceValidity
  /** Names this boundary as the decider, so a consumer can tell a decided state from a claimed one. */
  decidedBy: SourceValidityDecider
  reason: string
  /** The observation this reference belongs to, when the caller names it. A notice needs it to name the record. */
  observationId?: string
}

/** The checked references of one result and the aggregate for them. */
export interface SourceValidityAssessment {
  /** invalid beats stale beats valid. Undefined when the result recorded no file reference. */
  validity?: SourceValidity
  references: CheckedSourceReference[]
}

/** §6's full classification, additive to the states above. */
export type ValidityClass = "current" | "stale" | "unknown" | "historical" | "superseded"

/** Why a record is not current, in the words a notice may carry. */
export type StaleReason = "source_modified" | "source_deleted" | "dependency_invalidated" | "rename" | "git_operation"

/** How a dependency was established: the same enumeration Stage 1 froze in `evidence_dependencies.kind`. */
export type DependencyKind = "source_read" | "derived_claim" | "accepted_fact" | "supersedes"

/** One recorded dependency: the relationship an actual operation established, never a guess. */
export interface DependencyEdge {
  derivedObservationId: string
  sourceObservationId: string
  kind: DependencyKind
  establishedAt: string
}

/** A source change reported to the index. An unverified one answers `unknown`; it is not a state by itself. */
export interface ValidityEvent {
  /** The canonical path the event names, recorded the way the repository records its sources. */
  path: string
  reason: StaleReason
  /** Where the report came from. A watcher change stays unverified until a read through this boundary settles it. */
  origin: "native_edit" | "editor_save" | "file_watcher" | "git_operation" | "recorded_operation"
  observedAt: string
  reconciled: boolean
}

/** What the dependency index knows about one reference. It reports relationships and events; it decides nothing. */
export interface RecordedContextSource {
  context(reference: RecordedSourceReference, observationId?: string): ClassificationContext
  /** Called when a read through this boundary settles the event recorded for that path. */
  reconcile?(reference: RecordedSourceReference): void
  /** The references the repository recorded for one record, so a dependency's own class can be decided here. */
  referencesFor?(observationId: string): RecordedSourceReference[]
}

/** Recorded context for one reference. Every entry is what an operation established, not what was inferred. */
export interface ClassificationContext {
  /** The record this reference belongs to, when the caller names it. */
  observationId?: string
  /** The edge that established this record, when one was recorded. */
  dependency?: DependencyEdge
  /** The class the boundary decided for that edge's source, from its own recorded reference. */
  dependencyClass?: ValidityClass
  /** An event for this path that no verified read has reconciled yet. */
  event?: ValidityEvent
  /** A user or task decision that replaced this record for future action. The original stays history. */
  supersededBy?: string
  /** A record that names no content: an event or a run, kept as history. */
  eventOnly?: boolean
}

/** A stale notice as the projector and tools may render it: the UUID, the original obsolete hash and the reason. Never a new hash (Rule 3). */
export interface StaleNotice {
  observationId: string
  originalHash: string
  reason: StaleReason
}

/** A checked reference with the class the boundary gave it. Additive: every existing field keeps its meaning. */
export interface ClassifiedSourceReference extends CheckedSourceReference {
  class: ValidityClass
  /** The notice this reference can be rendered as, or nothing when the record is current. */
  notice?: StaleNotice
}

/** What a state reports as a class, with recorded context only. `unverifiable` has no class of its own: it is `unknown`. */
export const validityClassOf = (state: SourceValidity | undefined, context: ClassificationContext = {}): ValidityClass => {
  if (context.supersededBy) return "superseded"
  if (context.eventOnly) return "historical"
  // A change the host performed or saved is verified, so it invalidates at once. A change only detected by a
  // watcher arrived with latency and proves nothing until a verified read through this boundary settles it.
  if (context.event && !context.event.reconciled && context.event.origin === "file_watcher") return "unknown"
  if (state === undefined || state === "unverifiable") return "unknown"
  // A claim whose recorded dependency is no longer current is stale for the current state; a historical record stays history.
  if (state === "valid" && context.dependencyClass !== undefined && context.dependencyClass !== "current") return "stale"
  return state === "valid" ? "current" : "stale"
}

const REASON_OF_STATE: Partial<Record<SourceValidity, StaleReason>> = { stale: "source_modified", invalid: "source_deleted" }

/** The class's reason. A superseded record and an unknown one are not stale, so they carry no notice reason. */
export const staleReasonOf = (state: SourceValidity, context: ClassificationContext = {}): StaleReason | undefined => {
  if (context.event?.reason) return context.event.reason
  if (context.dependency && context.dependencyClass !== undefined && context.dependencyClass !== "current") return "dependency_invalidated"
  return REASON_OF_STATE[state]
}

/** The notice for one classified reference. Only a stale record gets one, and only when both the record and its original hash are named. */
export const staleNoticeOf = (reference: CheckedSourceReference, context: ClassificationContext = {}): StaleNotice | undefined => {
  if (validityClassOf(reference.validity, context) !== "stale" || reference.contentHash === undefined) return undefined
  const observationId = reference.observationId ?? context.observationId
  if (observationId === undefined) return undefined
  return { observationId, originalHash: reference.contentHash, reason: staleReasonOf(reference.validity, context) ?? "source_modified" }
}

/** The aggregate order stays invalid > stale > valid. `unknown` is counted on its own and never folded into a stronger state. */
export interface ClassAggregate {
  class?: ValidityClass
  unknown?: number
}

export const aggregateClass = (references: readonly ClassifiedSourceReference[]): ClassAggregate => {
  const unknown = references.filter((reference) => reference.class === "unknown").length
  if (!references.length) return { ...(unknown ? { unknown } : {}) }
  // The order stays invalid over stale over valid, reported through the classes those states map to. `unknown`
  // is counted beside it and folded in only when nothing stronger was decided.
  for (const entry of ["stale", "superseded", "historical", "current"] as ValidityClass[]) {
    if (references.some((reference) => reference.class === entry)) return { class: entry, ...(unknown ? { unknown } : {}) }
  }
  return { class: "unknown", ...(unknown ? { unknown } : {}) }
}

/** The class the boundary gave one record, with the aggregate it decided for its references. */
export interface ClassifiedAssessment extends SourceValidityAssessment {
  references: ClassifiedSourceReference[]
  class?: ValidityClass
  unknown?: number
}

/** The editor document open at an absolute path, when one is open. Editor state, not a validator. */
export type OpenDocumentLookup = (absolutePath: string) => { text: string; version?: number } | undefined

/** The host's authoritative source for a canonical path. Its undefined answer means "could not be read", never "the file is gone". */
export type SourceTextReader = (canonicalPath: string) => Promise<string | undefined>

export interface SourceBoundaryOptions {
  /** Resolves a canonical path to the resource root the writer recorded it under. */
  roots?: SourceRoots
  openDocument?: OpenDocumentLookup
  readText?: SourceTextReader
  /** The recorded dependency and event context, supplied by the repository's index. It reports; this boundary decides. */
  recorded?: RecordedContextSource
}

/** The same read cap the source tools use, so a file the tools cannot read is not called invalid. */
const MAX_SOURCE_BYTES = 512 * 1024

export type SourceRead =
  | { text: string; from: ObservedVersion; editorVersion?: number }
  | { missing: true }
  | { error: string }

const isMissing = (error: unknown): boolean => (error as { code?: string })?.code === "ENOENT"

export type SourceValidityDecider = "source-boundary"
const DECIDED_BY: SourceValidityDecider = "source-boundary"

/** invalid beats stale beats valid; nothing invalid or stale can be reported for unreadable references. */
export const aggregateValidity = (references: readonly CheckedSourceReference[]): SourceValidity | undefined => {
  if (!references.length) return undefined
  for (const state of ["invalid", "stale", "valid", "unverifiable"] as SourceValidity[]) {
    const found = references.find((reference) => reference.validity === state)
    if (found) return found.validity
  }
  return undefined
}

/**
 * The boundary. It is stateless apart from the roots and the host's source, and it caches nothing
 * across calls: each call reads the authoritative source, which is what §2.6 requires.
 */
export class SourceValidityBoundary {
  constructor(private readonly options: SourceBoundaryOptions = {}) {}

  /** The recorded context this boundary reads through, when the repository gave it one. It is a report, not a decider. */
  recorded(): RecordedContextSource | undefined {
    return this.options.recorded
  }

  /** The class for a state this boundary already decided, from recorded context only. */
  classOf(state: SourceValidity, context: ClassificationContext = {}): ValidityClass {
    return validityClassOf(state, context)
  }

  /** One reference, checked against the source its role and version name. */
  async check(reference: RecordedSourceReference, cache?: Map<string, SourceRead>): Promise<CheckedSourceReference> {
    const canonical = reference.path.trim()
    const checked = { ...reference, path: canonical }
    if (!canonical) return { ...checked, checkedAgainst: reference.observedVersion, persistedSource: true, validity: "unverifiable", decidedBy: DECIDED_BY, reason: "the reference names no path" }
    if (!reference.contentHash) return { ...checked, checkedAgainst: reference.observedVersion, persistedSource: true, validity: "unverifiable", decidedBy: DECIDED_BY, reason: "no fingerprint was recorded for this reference" }
    const read = await this.read(canonical, reference.observedVersion, cache)
    const from = "from" in read ? read.from : reference.observedVersion
    const result = { ...checked, checkedAgainst: from, persistedSource: from === "disk", decidedBy: DECIDED_BY }
    if ("missing" in read) return { ...result, validity: "invalid", reason: "the file the reference names no longer exists" }
    if ("error" in read) return { ...result, validity: "unverifiable", reason: `the current source could not be read: ${read.error}` }
    let matches = false
    try {
      matches = await verifyContentFingerprint(read.text, reference.contentHash)
    } catch (error) {
      return { ...result, validity: "unverifiable", reason: `the recorded fingerprint is not a valid fingerprint: ${error instanceof Error ? error.message : String(error)}` }
    }
    if (matches) {
      return { ...result, validity: "valid", reason: from === "buffer" ? "the recorded fingerprint matches the text the editor has open" : "the recorded fingerprint matches the current source" }
    }
    return { ...result, validity: "stale", reason: "the file exists with content that no longer matches the recorded fingerprint" }
  }

  /**
   * The boundary as a reader for the paths that need the text itself, such as the criterion reconciler:
   * the same authoritative source validity is decided against, so no path reads a file a second way.
   */
  reader(): SourceTextReader {
    return async (canonical: string) => {
      const text = await this.read(canonical, "disk")
      return "text" in text ? text.text : undefined
    }
  }

  /** Every reference of one result, with the aggregate the plan defines for it. */
  async assess(references: readonly RecordedSourceReference[]): Promise<SourceValidityAssessment> {
    const cache = new Map<string, SourceRead>()
    const checked: CheckedSourceReference[] = []
    for (const reference of references) checked.push(await this.check(reference, cache))
    return { validity: aggregateValidity(checked), references: checked }
  }

  /**
   * The class for one reference: the state this boundary decides, plus recorded context only. A change that
   * arrived with latency is reported as `unknown` here, and this read is what reconciles it, so the answer after
   * it reports the state the source actually shows.
   */
  async classify(reference: RecordedSourceReference, context: ClassificationContext = {}, cache?: Map<string, SourceRead>): Promise<ClassifiedSourceReference> {
    const checked = await this.check(reference, cache)
    const classified: ClassifiedSourceReference = { ...checked, ...(context.observationId === undefined ? {} : { observationId: context.observationId }), class: validityClassOf(checked.validity, context) }
    if (context.event && !context.event.reconciled && checked.validity !== "unverifiable") this.options.recorded?.reconcile?.(reference)
    const notice = staleNoticeOf(classified, context)
    return notice === undefined ? classified : { ...classified, notice }
  }

  /** Every reference of one record, classified through the context this repository's index recorded for it. */
  async classifyRecord(references: readonly RecordedSourceReference[], observationId?: string, visited = new Set<string>()): Promise<ClassifiedAssessment> {
    if (references.length === 0) {
      // A record that names no file reference is an event or a run: it stays history. Its currency is unknown
      // unless an operation established it, so nothing here makes it current.
      return { references: [], class: validityClassOf(undefined, { eventOnly: true }) }
    }
    const cache = new Map<string, SourceRead>()
    const checked: ClassifiedSourceReference[] = []
    for (const reference of references) {
      const context = this.options.recorded?.context(reference, observationId) ?? {}
      const source = context.dependency?.sourceObservationId
      if (source !== undefined && observationId !== undefined && !visited.has(source)) {
        visited.add(source)
        const decided = await this.classifyRecord(this.options.recorded?.referencesFor?.(source) ?? [], source, visited)
        context.dependencyClass = decided.class ?? "unknown"
      }
      checked.push(await this.classify(reference, context, cache))
    }
    const aggregate = aggregateClass(checked)
    return { ...aggregate, validity: aggregateValidity(checked), references: checked }
  }

  /**
   * The authoritative text for one canonical path: the open editor document for a buffer reference,
   * otherwise the saved file. The same read is shared by every reference of one call, so a consumer
   * that needs both the text and the state reads a file once.
   */
  async read(canonical: string, observedVersion: ObservedVersion = "disk", cache?: Map<string, SourceRead>): Promise<SourceRead> {
    // A host reader is asked once per path, so the text and the state of one path come from one read.
    const key = this.options.readText ? canonical : `${canonical}:${observedVersion}`
    if (cache?.has(key)) return cache.get(key)!
    let read: SourceRead
    if (this.options.readText) {
      try {
        const text = await this.options.readText(canonical)
        // A host reader answers undefined for an absent file and for an unreadable one alike, so it cannot
        // name the missing case; that stays on the existing error path.
        read = text === undefined ? { error: "the host source could not be read" } : { text, from: observedVersion }
      } catch (error) {
        read = { error: `the host source could not be read: ${error instanceof Error ? error.message : String(error)}` }
      }
    } else {
      const absolute = this.resolve(canonical)
      if (absolute === undefined) read = { error: "the reference cannot be resolved to a resource root" }
      else if (observedVersion === "buffer") {
        const open = this.options.openDocument?.(absolute)
        // The buffer has closed, so the saved file decides this reference.
        read = open ? { text: open.text, from: "buffer", editorVersion: open.version } : await this.readFromDisk(absolute)
      } else {
        read = await this.readFromDisk(absolute)
      }
    }
    cache?.set(key, read)
    return read
  }

  /** Reads the saved file at the absolute path the reference resolves to. */
  private async readFromDisk(absolute: string): Promise<SourceRead> {
    try {
      const stat = await fs.stat(absolute)
      if (!stat.isFile()) return { error: `${absolute} is not a file` }
      if (stat.size > MAX_SOURCE_BYTES) return { error: `${absolute} is larger than ${MAX_SOURCE_BYTES} bytes` }
      const buffer = await fs.readFile(absolute)
      if (looksBinary(buffer)) return { error: `${absolute} holds binary content` }
      // The tools hash decoded text with the byte-order mark stripped, so the same read decides validity.
      const text = buffer.toString("utf8")
      return { text: text.charCodeAt(0) === 0xfeff ? text.slice(1) : text, from: "disk" }
    } catch (error) {
      return isMissing(error) ? { missing: true } : { error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** A reference is identified by its root and root-relative path (§2.2), so the boundary resolves it the same way the writer did. */
  private resolve(canonical: string): string | undefined {
    const roots = this.options.roots
    if (!roots) return undefined
    try {
      return roots.absolutePath(roots.fromCanonical(canonical))
    } catch {
      return undefined
    }
  }
}

