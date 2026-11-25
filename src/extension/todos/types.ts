import type { AnswerRequirement, CaptureCompleteness, ResultStream, StorageCompleteness, TodoEvaluation, TodoEvidence, TodoItem, TodoPriority, TodoSourceFact, TodoStatus, TodoToolObservation, TodoVerification, ToolResultIntegrity, TypedCriterion } from "../../common/types"
import type { ToolErrorDetail } from "../tools/arguments"

import type { EvidenceHit, EvidenceSource, ObservedSourceReference, ObservedVersion } from "./evidence"
import type { CapturedResult, StoredOutcome } from "./evidence-store"
import type { SourceRootRecord, SourceRoots } from "./source-roots"
import type { SourceValidity, SourceValidityAssessment, ValidityClass } from "./source-validity"
/** Stage 4's validity contract (§6): the classes, what an operation recorded as a dependency, and the notice a stale record may be rendered as. */
export type { TodoAssessmentReaction, TodoAssessmentScoreValue, TodoAssessmentView, TodoEvaluation, TodoEvaluationCriterion, TodoEvaluationDecision, TodoEvidence, TodoItem, TodoListSnapshot, TodoObservation, TodoObservationStatus, TodoPriority, TodoSource, TodoStatus, TodoToolEvidenceStatus, TodoToolObservation, TodoVerification } from "../../common/types"
export type { ClassificationContext, ClassifiedSourceReference, DependencyEdge, DependencyKind, RecordedContextSource, StaleNotice, StaleReason, ValidityClass, ValidityEvent } from "./source-validity"
export type TodoActor = "user" | "model"

export type { AnswerField, AnswerRequirement, CriterionVerification,IntentTaskDefinition, IntentTaskPlan, TypedCriterion } from "../../common/types"

/** Every active plan task with its TODO item, for the executor to update instead of recreating. */
export interface IntentPlanOutline {
  planId: string
  revision: number
  goal: string
  tasks: IntentPlanOutlineTask[]
  /** Child TODOs Feedback accepted under plan tasks. They are not plan tasks and add no dependencies. */
  children: IntentPlanOutlineChild[]
}

export interface IntentPlanOutlineChild {
  itemId: string
  parentItemId: string
  title: string
  status: TodoStatus
}

/** An agent's request to add a child under a plan TODO, before Feedback reviews it. */
export interface ChildTodoProposal {
  parentId: string
  title: string
  details?: string
  reason: string
  priority: TodoPriority
  requestId: string
}

export type ChildTodoDecisionKind = "accepted" | "existing_task" | "revised" | "rejected" | "needs_clarification"

/** A Feedback decision after the host has validated it. `revised` may change the title, details, or parent. */
export interface ChildTodoDecision {
  decision: ChildTodoDecisionKind
  itemId?: string
  title?: string
  details?: string
  parentId?: string
  instruction: string
}

/** The authoritative result of a child TODO proposal, as stored and returned to the agent. */
export interface ChildTodoOutcome {
  decision: ChildTodoDecisionKind
  parentId: string
  itemId?: string
  planRevision: number
  instruction: string
}

/** The plan state Feedback reviews a child proposal against. */
export interface ChildTodoContext {
  planId: string
  revision: number
  goal: string
  parent: { id: string; title: string; details?: string; status: TodoStatus; acceptance: string[]; dependsOn: string[] }
  children: IntentPlanOutlineChild[]
  planItems: { id: string; title: string; status: TodoStatus }[]
}

export type ChildTodoReviewOutcome =
  | { ok: true; decision: ChildTodoDecision }
  | { ok: false; error: string }

/** Reviews an agent's child proposal on the Feedback provider. A failure never authorizes a mutation. */
export type ChildTodoReview = (proposal: ChildTodoProposal, context: ChildTodoContext, signal?: AbortSignal) => Promise<ChildTodoReviewOutcome>

export interface IntentPlanOutlineTask {
  taskId: string
  itemId: string
  title: string
  status: TodoStatus
  verification: TodoVerification
  version: number
  blockedReason?: string
  /** Criteria the latest Feedback evaluation did not pass, with the reason it gave. */
  unmetCriteria: string[]
  problems: string[]
  /** Titles of prerequisite tasks that are not yet completed; a claim waits on these rather than failing review. */
  awaitingDependencies: string[]
}

export interface IntentPlanContext {
  planId: string
  revision: number
  goal: string
  constraints: string[]
  answer: AnswerRequirement[]
  task: TodoItem
  planTaskId: string
  criteria: TypedCriterion[]
  dependencies: { id: string; title: string; status: TodoItem["status"] }[]
  evidence: TodoEvidence[]
  observations?: TodoToolObservation[]
  lastEvaluation?: TodoEvaluation
}

export interface TodoListRequest {
  projectFingerprint: string
  conversationId: string
  includeCompleted?: boolean
}

/**
 * A mutation of one conversation's list. `writer` is the conversation acting, supplied by host context
 * (the active chat or the session that invoked the tool), never by model output. The repository rejects
 * any write whose writer is not the list's own conversation.
 */
export interface TodoWriteRequest extends TodoListRequest {
  writer: string
}

/**
 * A project-scoped read: it names no conversation, because project knowledge belongs to the project.
 * `writer` is the conversation making the read, so one chat cannot write another chat's facts.
 */
export interface ProjectEvidenceRequest {
  projectFingerprint: string
  writer: string
}

export interface CreateTodoInput {
  title: string
  details?: string
  parentId?: string
  priority?: TodoPriority
}

export interface UpdateTodoInput {
  itemId: string
  expectedVersion: number
  patch: Partial<Pick<TodoItem, "title" | "details" | "status" | "priority" | "blockedReason" | "sortOrder">>
  actor: TodoActor
  requestId: string
}

export interface AddTodoEvidenceInput {
  itemId: string
  kind: string
  summary: string
  result: TodoEvidence["result"]
  requestId: string
}

/** Host record of the effective tool definitions sent to the model; proves exposure, not source registration. */
export const RUNTIME_INVENTORY_TOOL = "twinny_runtime_inventory"

export interface TodoToolObservationInput {
  /** Provenance only: the task active when the result came in. An observation does not need a task or a plan. */
  itemId?: string
  toolName: string
  arguments: Record<string, string>
  output: string
  /** Full tool output, kept for Feedback retrieval; `output` remains the bounded summary. */
  evidenceOutput?: string
  /** Raw and model-observed completeness metadata for the same tool operation. */
  integrity?: ToolResultIntegrity
  /** Completeness metadata before model/context budgeting. */
  rawIntegrity?: ToolResultIntegrity
  failed: boolean
  exitCode?: number
  requestId: string
  /** Set only by the host from its own execution state; never taken from model-provided arguments. */
  executionId?: string
  /** The files the tool actually touched or read, with each one's role and where its text came from. */
  sources?: ObservedSourceReference[]
  /** Host-execution truth: a call refused before execution is recorded as an attempt, never as a run. */
  executed?: boolean
  /** The structured error that refused the call, when the tool could name it. */
  error?: ToolErrorDetail
  startedAt?: string
  finishedAt?: string
  /** The raw capture before any fitting: typed arguments, bytes per stream, timings and measured completeness. */
  capture?: CapturedResult
}

/** Stored tool output for one observation, with whatever the store still holds. */
export interface RetainedObservationEvidence {
  observationId: string
  /** Provenance only: the task active when the observation was recorded. */
  itemId?: string
  toolName: string
  arguments: Record<string, string>
  failed: boolean
  exitCode?: number
  /** When the host recorded the observation (ISO time), used to tell fresh observations from earlier ones. */
  observedAt: string
  /** The list revision that recorded the observation. Ordering proof uses this causal revision, never the clock. Legacy rows have none. */
  listRevision?: number
  retained: boolean
  complete: boolean
  originalChars: number
  preservedChars: number
  rawIntegrity?: ToolResultIntegrity
  content?: string
  integrity?: ToolResultIntegrity
  /** What the byte store holds for this observation, measured by the store itself rather than assumed. */
  outcome?: StoredOutcome
  sources: EvidenceSource[]
  hits: EvidenceHit[]
  /** Each reference this result recorded, checked by the repository's validity boundary, with the aggregate for them. */
  validity?: SourceValidityAssessment
  /** The class the boundary gave this record: the state it decided plus what an operation recorded for it. */
  class?: ValidityClass
}

/** A stored observation, with the validity the boundary decided for the references it recorded. */
export interface RecordedObservation extends TodoToolObservation {
  /** Each reference the observation recorded, checked when it was stored. */
  validity?: SourceValidityAssessment
  /** The class the boundary gave this record when it was stored. */
  class?: ValidityClass
  /** What the byte store holds for this observation, as the store measured it. */
  outcome?: StoredOutcome
}

/**
 * A host-owned point at which a task's execution requirements took effect. A command run is eligible for an
 * `after_activation` criterion only if it was recorded after this activation, by its causal list revision.
 * `activatedAt` is Unix epoch milliseconds for display and audit; it is never used to order proof.
 */
export interface RequirementActivation {
  id: string
  itemId: string
  kind: "activation" | "renewal"
  listRevision: number
  activatedAt: number
}

/**
 * A source location previously verified and accepted for a completed task; durable across turns and reopen.
 * Facts are project knowledge. `conversationId` records the originating chat as provenance, and only that chat may write its own facts.
 */
export interface AcceptedFact extends TodoSourceFact {
  id: string
  /** Provenance only: the conversation that accepted the fact. It outlives that conversation. */
  conversationId?: string
  /** Provenance only: the task the fact was accepted for, never an owner. */
  itemId?: string
  criterionIndex: number
  criterion: string
  toolName: string
  planId: string
  planRevision: number
  /** Set when a later accepted fact for the same path and symbol replaced this one. The row is kept for audit. */
  supersededBy?: string
  acceptedAt: string
  /** What the validity boundary says about the reference this fact was recorded from. */
  validity?: SourceValidity
  /** The source version this fact was proven from, as it was recorded: the saved file, or the open editor document. It is part of the reference's identity, so a buffer fact is judged against that buffer while it is open. */
  observedVersion?: ObservedVersion
  /** The editor document's version at that read, recorded only for a buffer read. */
  editorVersion?: number
}

/** Where the shared database thinks a recorded file's content may be now. A proposal only: the recorded reference is never rewritten and no candidate is chosen over another. */
export type RelocationSource = "recorded_move" | "matching_hash"

export interface RelocationCandidate {
  path: string
  source: RelocationSource
}

/**
 * How an execution used a current accepted fact. `lookup` is an explicit successful lookup that returned the fact;
 * `reuse` is an accepted attach of the fact to a criterion. Automatic context injection is never a use.
 */
export type EvidenceUseKind = "lookup" | "reuse"

/** Project-wide usage of one accepted fact, counted once per execution and kind. */
export interface AcceptedFactUsage {
  fact: AcceptedFact
  lookups: number
  reuses: number
}

/**
 * A proven relationship between a registered tool name (read_file) and the symbol that implements it (readFile),
 * with the observation and fingerprint that proved it. Project knowledge, like accepted facts.
 */
export interface SymbolAlias {
  id: string
  conversationId: string
  toolName: string
  implementation: string
  path: string
  startLine: number
  endLine: number
  observationId: string
  sourceHash: string
  createdAt: string
}

export interface TodoReviewPackage {
  projectFingerprint: string
  conversationId: string
  planId: string
  planRevision: number
  goal: string
  constraints: string[]
  planTaskId: string
  task: TodoItem
  criteria: TypedCriterion[]
  dependencies: { id: string; title: string; status: TodoItem["status"] }[]
  evidence: TodoEvidence[]
  observations: TodoToolObservation[]
  /**
   * The observations this review can use: this task's own tool records plus the retained observations of the
   * other tasks on its plan. A record keeps the item it was recorded under, and relevance to a criterion is
   * decided by what the criterion names, never by which task recorded it. Model notes are shown as context
   * but cannot satisfy a criterion on their own.
   */
  retainedEvidence: RetainedObservationEvidence[]
  /** Current accepted source facts for this conversation, so verification can reuse them across TODOs. */
  acceptedEvidence: AcceptedFact[]
  /** Proven tool-name to implementation relationships in this project. */
  symbolAliases: SymbolAlias[]
  /** The latest requirement activation or renewal for this task, if any. */
  requirementActivation?: RequirementActivation
  lastEvaluation?: TodoEvaluation
}

/** Outcome of a completion claim: recorded once, then acknowledged idempotently. */
export interface TodoCompletionClaim {
  disposition: "accepted" | "already_submitted"
  item: TodoItem
  review: "feedback_turn_end" | "user_approval"
}

/** Outcome of a create: a model create that matches an existing task reuses it. */
export interface TodoCreateOutcome {
  item: TodoItem
  reused: boolean
  matchedBy?: "title" | "plan_overlap" | "plan_umbrella"
}

export class TodoConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TodoConflictError"
  }
}

/**
 * Host-owned lifecycle of one editor mutation. `dispatched` is unknown: the host cannot yet say whether the
 * mutation happened, so it must be reconciled before the same target is edited again. Only apply-mode edits are ledgered;
 * review-mode edits apply later through the user's review and are outside this lifecycle.
 */
export type EditOperationStatus = "dispatched" | "succeeded" | "failed" | "reconciled_applied" | "reconciled_absent" | "diverged"

export interface EditOperationInput {
  id: string
  itemId?: string
  /** The extension host that dispatched the edit. Only that host may settle an unresolved edit as absent. */
  ownerId?: string
  target: string
  mode: "apply" | "review"
  preDigest: string
  postDigest: string
}

export interface EditOperationRecord extends EditOperationInput {
  id: string
  status: EditOperationStatus
  detail: string
  createdAt: number
  updatedAt: number
}

export interface UnresolvedEditOperation extends EditOperationRecord {
  status: "dispatched" | "diverged"
  conversationId: string | null
  ownerLiveness: "live" | "abandoned" | "uncertain"
  ownerHeartbeatAt?: string
  ownerSessionId?: string
}

export interface EditOperationRecoveryAudit {
  id: string
  operationId: string
  target: string
  previousStatus: "dispatched" | "diverged"
  decision: "reconciled_absent" | "reconciled_applied"
  reason: string
  provenance: string
  createdAt: string
}

/**
 * §4.3 read-only evidence access contract (Stage 2). These are new shapes, not replacements for
 * `EvidenceSource` or `EvidenceHit`: a result reports only what the store can prove about the content
 * it holds, and never claims coverage it does not have.
 */
export type RetrievalState = "retained" | "partial_prefix" | "missing_tail" | "unknown_content" | "evicted" | "not_retrievable"
export type SearchMode = "literal" | "regex"
/** Where a lookup landed. A denied one names nothing it cannot name. */
export type EvidenceAccessDecision = "found" | "missing" | "denied"
/** Stored bytes, zero-based half-open [start,end). */
export interface ByteRange {
  fromByte: number
  toByte: number
}

/** The scope a retrieval is decided in, before any content is read. Identity and permission stay separate. */
export interface EvidenceAccessScope {
  projectId: string
  /** An observation recorded on another extension host is not read here; a row that names no host makes no claim. */
  hostKey?: string
  /** The canonical path identity this project already owns. */
  roots: SourceRoots
  /** Whether one root is inside what this caller may read. Outside-workspace content needs the editor's grant. */
  authorized?: (root: SourceRootRecord) => boolean
}

export interface EvidenceAccess {
  /** Resolve one observation by UUID; optional invocation-id alias. Enforces project/host/root scope. */
  get(observationId: string, options?: { invocationId?: string }): Promise<EvidenceObservation>
  /** Bounded inclusive retrieval over retained content. Never re-runs the original tool. */
  range(observationId: string, request: RangeRequest): Promise<RetrievedSpan>
  /** Literal and optional regex search over retained output with continuation. Zero matches is success. */
  search(observationId: string, request: SearchRequest): Promise<SearchPage>
  /** Filter observations by source path, fingerprint, tool, time, status, project - bounded. */
  find(filter: EvidenceFilter): Promise<EvidenceMatch[]>
}

/** One observation as the store can prove it, with no content attached. */
export interface EvidenceObservation {
  observationId: string
  access: EvidenceAccessDecision
  invocationId?: string
  toolName?: string
  path?: string
  observedAt?: string
  executionId?: string
  executed?: boolean
  failed?: boolean
  status?: string
  exitCode?: number
  /** The fingerprint as it was observed, never a current one (Rule 3). */
  originalHash?: string
  completeness?: { captured: CaptureCompleteness; stored: StorageCompleteness }
  streams?: { stream: ResultStream; coverage: ByteRange[] }[]
  lineIndex?: { lines: number; bounded: boolean }
  /** Set when the recorded source no longer matches: historical evidence, not current source. */
  historical?: boolean
  /** Reported only when something is claimed it cannot, or a scope refused the lookup. */
  reason?: string
}

export interface RangeRequest {
  stream?: ResultStream
  startLine?: number; endLine?: number                  // 1-based, inclusive
  startChar?: number; endChar?: number                  // 1-based character offsets on one line
  startByte?: number; endByte?: number                  // zero-based, half-open [startByte,endByte) in original bytes
}

export interface SpanCoverage {
  fromLine?: number; toLine?: number
  fromByte: number; toByte: number
}

export interface RetrievedSpan {
  observationId: string
  stream: ResultStream
  requested: RangeRequest
  coverage: SpanCoverage
  /** The pieces actually served, in byte order, when the span is not one continuous piece. */
  servedRanges?: ByteRange[]
  text?: string
  state: RetrievalState
  /** Measured by the store, never inferred: absent when nothing could be measured. */
  completeness?: { captured: CaptureCompleteness; stored: StorageCompleteness }
  /** The fingerprint as it was observed, not a current one. */
  originalHash?: string
  /** What the result is an account of. Absent when nothing was resolved to report. */
  provenance?: { toolName: string; path?: string; observedAt: string; executionId?: string }
  continuation?: { nextByte?: number; cursor?: string }
  /** Set when the recorded source no longer matches: historical evidence, never presented as current source. */
  historical?: boolean
  /** Why the state is what it is, in the store's own words. */
  reason?: string
  /** What the stored bytes are: a decoded view exists only for content that is valid UTF-8. */
  encoding?: "utf8" | "bytes" | "mixed"
  bytePreservation?: "lossless" | "normalized" | "excluded"
  /** True when the returned text is the redacted presentation view, not the stored bytes. */
  redactionApplied?: boolean
  /** A merged view is named as one: which streams it came from, in the order their chunks arrived. */
  mergedFrom?: { stream: ResultStream; coverage: ByteRange[] }[]
  coordinates?: "stored_bytes" | "merged_view"
}

export interface SearchRequest {
  query: string
  mode?: SearchMode                                     // literal by default; regex when asked for
  stream?: ResultStream
  contextLines?: number
  limit?: number
  cursor?: string                                       // deterministic continuation, not a rerun
}

export interface SearchPage {
  observationId: string
  query: string
  mode: SearchMode
  stream: ResultStream
  /** Matches in the bytes actually scanned; never a total over content the scan did not reach. */
  matchCount: number
  /** Set when the recorded source no longer matches: historical evidence, never presented as current source. */
  historical?: boolean
  matches: { line?: number; byte?: number; preview: string; withheld?: boolean; context?: string[] }[]
  contextLines?: number
  cursor?: string
  state: RetrievalState
  reason?: string
  /** What the bounded scan reached, so a bound is reported as a bound and not as a total. */
  scannedBytes?: number
  matchLimit?: number
}

export interface EvidenceFilter {
  project?: string
  path?: string
  contentHash?: string
  toolName?: string
  status?: string
  failed?: boolean
  executed?: boolean
  executionId?: string
  since?: string
  until?: string
  limit?: number
  cursor?: string
}

export interface EvidenceMatch {
  observationId: string
  toolName: string
  /** A path is named only when it is inside what this caller may read. */
  path?: string
  contentHash?: string
  observedAt: string
  status: string
  failed: boolean
  executed: boolean
  exitCode?: number
  state: RetrievalState
  completeness?: { captured: CaptureCompleteness; stored: StorageCompleteness }
  streams?: { stream: ResultStream; coverage: ByteRange[] }[]
  /** Set when the recorded source no longer matches: historical evidence, never presented as current source. */
  historical?: boolean
  /** The page position, so a bounded lookup can be continued without dumping the whole list. */
  cursor?: string
}
