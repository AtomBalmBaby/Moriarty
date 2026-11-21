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
}

/** The checked references of one result and the aggregate for them. */
export interface SourceValidityAssessment {
  /** invalid beats stale beats valid. Undefined when the result recorded no file reference. */
  validity?: SourceValidity
  references: CheckedSourceReference[]
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

