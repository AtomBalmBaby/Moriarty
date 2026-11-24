/**
 * Stage 4's recorded dependency index (§6). It keeps what an actual operation established - a claim reconciled
 * from a read, a fact accepted from an observation, a supersession - in the `evidence_dependencies` table Stage 1
 * froze, and it holds the source-change events the host reports to it.
 *
 * It records and reports; it decides nothing. Validity stays with `SourceValidityBoundary`, which reads through
 * this index for context only. So:
 * - an edge is written only when both sides name a record this project already has, from an operation that ran;
 *   no dependency is read out of command text, and no claim gets an edge because a file name looks related;
 * - a path is matched by the recorded identity (root plus root-relative path), never by a matching fingerprint,
 *   so two files with identical content stay two sources;
 * - an event for a file this project never recorded as a source, or for a file outside an authorized root, is
 *   refused and names nothing (Rule 7);
 * - a change detected with latency is not a state. It answers `unknown` until the boundary's own verified read
 *   reconciles it, and then reports the state that read showed.
 *
 * Stage 4 adds no schema. The edges live in Stage 1's v21 table; the events are this session's recorded context,
 * held for the boundary and bounded, because no v21 object stores validity events.
 */
import { type SourceLocation, type SourceRootRecord, type SourceRoots,toPosixPath } from "./source-roots"
import type { ClassificationContext, DependencyEdge, DependencyKind, RecordedSourceReference, ValidityEvent } from "./source-validity"
import type { Database } from "./sqlite"

type SqlValue = string | number | bigint | Buffer | null

const rows = <T>(database: Database, sql: string, values: SqlValue[] = []): T[] => database.prepare(sql).all(...values) as T[]
const row = <T>(database: Database, sql: string, values: SqlValue[] = []): T | undefined => database.prepare(sql).get(...values) as T | undefined
const execute = (database: Database, sql: string, values: SqlValue[] = []) => database.prepare(sql).run(...values)

/** The kinds Stage 1 froze in the table's CHECK. Nothing outside this list can be recorded. */
const KINDS: readonly DependencyKind[] = ["source_read", "derived_claim", "accepted_fact", "supersedes"]

/** Events are context for one session, not an audit store: bounded so a long run cannot grow without limit. */
export const MAX_RECORDED_EVENTS = 200

/**
 * What an operation reported about a path. The caller names what happened; nothing here guesses it, and no field
 * of this event claims a state or a dependency. A rename also keeps the link the operation recorded.
 */
export interface SourceEvent {
  path: string
  reason: ValidityEvent["reason"]
  origin: ValidityEvent["origin"]
  /** The path a rename moved from, when the event is one. */
  from?: string
}

/** A rename the repository recorded as an operation: the pair it named, not a file chosen by matching content. */
export interface RecordedRenameLink {
  from: string
  to: string
}

export interface DependencyIndexOptions {
  /** Whether a path's root may be named at all. A denied event records nothing and names no candidate. */
  authorized?: (root: SourceRootRecord) => boolean
  /** The bound on recorded events for this session. */
  limit?: number
}

export interface RecordedEventOutcome {
  event?: ValidityEvent
  /** Why nothing was recorded: the path is not a source this project has a record for, or it is outside scope. */
  reason?: string
}

/**
 * The recorded dependency and event context for one project. Every method here answers from what was stored or
 * reported; none of them decides validity.
 */
export class DependencyIndex {
  private readonly events = new Map<string, ValidityEvent>()

  constructor(
    private readonly database: Database,
    private readonly roots: SourceRoots,
    private readonly options: DependencyIndexOptions = {}
  ) {}

  /**
   * Records one established relationship. The pair is refused when it names nothing this project recorded, names
   * the same record twice, or uses a kind the frozen schema does not allow - a dependency is never invented to
   * fill a gap, so a command run whose side effects are unknown leaves this table empty.
   */
  recordEdge(edge: { derivedObservationId: string; sourceObservationId: string; kind: DependencyKind }, establishedAt: string): DependencyEdge | undefined {
    const derived = edge.derivedObservationId.trim()
    const source = edge.sourceObservationId.trim()
    if (!derived || !source || derived === source) return undefined
    if (!KINDS.includes(edge.kind)) return undefined
    if (!this.observationExists(derived) || !this.observationExists(source)) return undefined
    execute(this.database, "INSERT OR IGNORE INTO evidence_dependencies(derived_observation_id, source_observation_id, kind, established_at) VALUES (?, ?, ?, ?)", [derived, source, edge.kind, establishedAt])
    return { derivedObservationId: derived, sourceObservationId: source, kind: edge.kind, establishedAt }
  }

  /** The edges that establish one record, in the order they were recorded. */
  edgesFor(derivedObservationId: string): DependencyEdge[] {
    return rows<{ derived_observation_id: string; source_observation_id: string; kind: string; established_at: string }>(this.database,
      "SELECT derived_observation_id, source_observation_id, kind, established_at FROM evidence_dependencies WHERE derived_observation_id = ? ORDER BY established_at, source_observation_id",
      [derivedObservationId.trim()])
      .map((edge) => ({ derivedObservationId: edge.derived_observation_id, sourceObservationId: edge.source_observation_id, kind: edge.kind as DependencyKind, establishedAt: edge.established_at }))
  }

  /** The claims a change to one record touches: only the ones an operation recorded as depending on it. */
  claimsDependingOn(sourceObservationId: string): DependencyEdge[] {
    return rows<{ derived_observation_id: string; source_observation_id: string; kind: string; established_at: string }>(this.database,
      "SELECT derived_observation_id, source_observation_id, kind, established_at FROM evidence_dependencies WHERE source_observation_id = ? ORDER BY established_at, derived_observation_id",
      [sourceObservationId.trim()])
      .map((edge) => ({ derivedObservationId: edge.derived_observation_id, sourceObservationId: edge.source_observation_id, kind: edge.kind as DependencyKind, establishedAt: edge.established_at }))
  }

  /** The references this project recorded for one record, resolved the way the writer stored them. */
  referencesFor(observationId: string): RecordedSourceReference[] {
    return rows<{ root_id: string; path: string; role: string; content_hash: string | null; observed_version: string; editor_version: number | null }>(this.database,
      "SELECT root_id, path, role, content_hash, observed_version, editor_version FROM observation_source WHERE observation_id = ? ORDER BY ordinal",
      [observationId.trim()])
      .map((referenceRow) => ({
        path: this.roots.canonicalPath({ rootId: referenceRow.root_id, path: referenceRow.path }),
        role: referenceRow.role as RecordedSourceReference["role"],
        ...(referenceRow.content_hash === null ? {} : { contentHash: referenceRow.content_hash }),
        observedVersion: referenceRow.observed_version as RecordedSourceReference["observedVersion"],
        ...(referenceRow.editor_version === null ? {} : { editorVersion: referenceRow.editor_version })
      }))
  }

  /** Whether this project has a record that names this path as a source. Identity, not content. */
  recordsSource(path: string): boolean {
    const location = this.locationOf(path)
    if (location === undefined) return false
    return (row<{ n: number }>(this.database, "SELECT COUNT(*) AS n FROM observation_source WHERE root_id = ? AND path = ?", [location.rootId, location.path])?.n ?? 0) >= 1
  }

  /**
   * Records an event for a path. A path this project never recorded as a source, or one outside an authorized
   * root, is refused: the event names nothing it cannot name, and no claim is invalidated by a change it does
   * not depend on.
   */
  noteEvent(input: SourceEvent): RecordedEventOutcome {
    const canonical = toPosixPath(input.path.trim())
    if (!canonical) return { reason: "the event names no path" }
    const location = this.roots.fromCanonical(canonical)
    const root = this.roots.byId(location.rootId)
    if (root === undefined) return { reason: `the path ${canonical} cannot be resolved to a resource root` }
    if (this.options.authorized !== undefined && !this.options.authorized(root)) return { reason: `the path ${canonical} is outside the roots this project was given` }
    // A rename names the path it moved from: that is the identity this project recorded, and the new path is
    // reported with it. Nothing is resolved from matching content.
    const named = input.from === undefined ? canonical : toPosixPath(input.from)
    if (!this.recordsSource(named)) return { reason: `${named} is not a source this project recorded, so no record depends on it` }
    const event = { path: canonical, reason: input.reason, origin: input.origin, observedAt: new Date().toISOString(), reconciled: false }
    const limit = this.options.limit ?? MAX_RECORDED_EVENTS
    if (!this.events.has(canonical) && this.events.size >= limit) return { reason: `the event index is full at ${limit} paths, so this change was not recorded` }
    this.events.set(canonical, event)
    return { event }
  }

  /** The last event recorded for a path, or nothing. */
  eventFor(path: string): ValidityEvent | undefined {
    const canonical = toPosixPath(path.trim())
    return canonical ? this.events.get(canonical) : undefined
  }

  /** A read through the boundary settled this path: what it showed is now the recorded state for it. */
  reconcile(reference: RecordedSourceReference): void {
    const event = this.eventFor(reference.path)
    if (event) event.reconciled = true
  }

  /** What was recorded about one reference: an edge, an event, a supersession. Nothing is inferred here. */
  context(reference: RecordedSourceReference, observationId?: string): ClassificationContext {
    const derived = observationId === undefined ? undefined : observationId.trim()
    const edge = derived ? this.edgesFor(derived)[0] : undefined
    const event = this.eventFor(reference.path)
    return {
      ...(derived === undefined || derived === "" ? {} : { observationId: derived }),
      ...(edge === undefined ? {} : { dependency: edge }),
      ...(event === undefined ? {} : { event })
    }
  }

  /** The claims a change to this path touches, from recorded edges only. */
  affectedClaims(path: string): DependencyEdge[] {
    const location = this.locationOf(path)
    if (location === undefined) return []
    const found = rows<{ observation_id: string }>(this.database, "SELECT DISTINCT observation_id FROM observation_source WHERE root_id = ? AND path = ?", [location.rootId, location.path])
    return found.flatMap((record) => this.claimsDependingOn(record.observation_id))
  }

  /**
   * The rename link this project recorded for a path. An index row with the same content is a candidate hint, not
   * proof, so identical content at two paths stays two sources and nothing is chosen between them.
   */
  recordedLinks(path: string): RecordedRenameLink[] {
    const location = this.locationOf(path)
    if (location === undefined) return []
    const found = rows<{ from_root: string; from_path: string; to_root: string; to_path: string }>(this.database,
      "SELECT moved_from.root_id AS from_root, moved_from.path AS from_path, moved_to.root_id AS to_root, moved_to.path AS to_path FROM observation_source AS moved_from JOIN observation_source AS moved_to ON moved_to.observation_id = moved_from.observation_id WHERE moved_from.role = 'moved_from' AND moved_from.root_id = ? AND moved_from.path = ? AND moved_to.role = 'moved_to' ORDER BY moved_from.observation_id, moved_to.ordinal",
      [location.rootId, location.path])
    return found.map((record) => ({ from: this.roots.canonicalPath({ rootId: record.from_root, path: record.from_path }), to: this.roots.canonicalPath({ rootId: record.to_root, path: record.to_path }) }))
  }

  private locationOf(path: string): SourceLocation | undefined {
    const canonical = toPosixPath(path.trim())
    if (!canonical) return undefined
    try {
      return this.roots.fromCanonical(canonical)
    } catch {
      return undefined
    }
  }

  private observationExists(observationId: string): boolean {
    return row<{ id: string }>(this.database, "SELECT id FROM todo_tool_observations WHERE id = ?", [observationId]) !== undefined
  }
}
