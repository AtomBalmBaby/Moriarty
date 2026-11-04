import { createHash } from "node:crypto"

import { logger, redact } from "../../common/logger"
import type { ReplyChangesView, TodoEvaluation, TodoEvaluationCriterion } from "../../common/types"

import type { IntentPlanContext, TodoReviewPackage } from "./types"

export const taskRequiresWorkspaceChanges = (task: Pick<TodoReviewPackage["task"], "title" | "details">, criteria: string[]): boolean => {
  const taskText = [task.title, task.details ?? "", ...criteria].join("\n")
  if (/\b(inspect|identify|list|locate|map|note|document|report|review|summari[sz]e|understand)\b/i.test(taskText) && !/\b(add|change|create|delete|edit|fix|implement(?:ed|ing)?|improve|modify|refactor|remove|rewrite|update|write)\b/i.test(taskText)) return false
  return /\b(add|change|create|delete|edit|fix|implement(?:ed|ing)?|improve|modify|refactor|remove|rewrite|update|write)\b/i.test(taskText)
}

export const isAnalysisOnlyIntent = (goal: string): boolean => {
  const leading = goal.match(/^\s*(explain|analy[sz]e|review|describe|compare|summari[sz]e|why|how)\b/i)
  if (!leading) return false
  const rest = goal.slice(leading[0].length)
  if (/^(?:\s*how|\s*why|\s*can|\s*should|\s*would)\b/i.test(rest)) return true
  return !/\b(add|change|create|delete|edit|enhance|fix|implement(?:ed|ing)?|improve|make|modify|refactor|remove|rewrite|update|write)\b/i.test(rest)
}

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
const boundedStrings = (value: unknown, limit: number, entryLimit: number): string[] => {
  if (!Array.isArray(value) || value.length > entryLimit || value.some((entry) => typeof entry !== "string" || !entry.trim() || entry.length > limit)) {
    throw new TodoEvaluationValidationError("invalid_shape", "Evaluation contains an invalid string list")
  }
  return value.map((entry) => (entry as string).trim())
}

const preserveObservationSet = (observations: TodoReviewPackage["observations"]) => {
  const seen = new Set<string>()
  return observations.filter((observation) => {
    if (seen.has(observation.id)) return false
    seen.add(observation.id)
    return true
  }).slice(0, 80)
}

export const hasTrustedEvidenceForCriterion = (
  criterion: string,
  references: string[],
  observations: TodoReviewPackage["observations"]
): boolean => {
  const cited = observations.filter((observation) => references.includes(observation.id) && !observation.failed)
  if (!cited.length) return false
  const commands = cited.filter((observation) => observation.toolName === "run_command" && observation.exitCode === 0)
  const needsTest = /\b(test|tests|assertions?)\b/i.test(criterion)
  const needsCompile = /\b(compile|compilation|build|type.?check)\b/i.test(criterion)
  if (!needsTest && !needsCompile && !/\b(command|execute|run)\b/i.test(criterion)) return true
  const isTestCommand = (command: string) =>
    /(?:^|(?:&&|\|\||;)\s*)(?:npm\s+test\b|(?:npm|npx|yarn|pnpm|bun)\s+(?:run\s+)?[^\s]*test[^\s]*(?:\s|$)|(?:jest|vitest|pytest|mocha)\b|cargo\s+test\b|go\s+test\b|python(?:\d+)?\s+-m\s+(?:pytest|unittest)\b|node\s+(?:--test\b|[^\s]*\b(?:check|test|spec)[^/\s]*\.(?:cjs|mjs|js)\b))/i.test(command)
  const isCompileCommand = (command: string) => /\b(tsc|type.?check|build|compile|cargo\s+check)\b/i.test(command)
  return commands.some((observation) => {
    const command = observation.arguments.command ?? ""
    return (!needsTest || isTestCommand(command)) && (!needsCompile || isCompileCommand(command))
  })
}

export const parseTodoEvaluation = (
  raw: string,
  review: TodoReviewPackage,
  evaluator: string,
  evaluatedAt = new Date().toISOString(),
  allowEvidenceFreeAnalysis = false
): TodoEvaluation => {
  if (!raw.trim()) invalid("empty_response", "Evaluator returned an empty response")
  let value: unknown
  try {
    value = JSON.parse(extractJsonObject(raw))
  } catch (error) {
    throw new TodoEvaluationValidationError("malformed_json", "Evaluator response is not valid JSON: " + (error instanceof Error ? error.message : String(error)))
  }
  if (!isRecord(value)) throw new TodoEvaluationValidationError("invalid_shape", "Evaluator response must be a JSON object", "object", typeof value)
  if (!("schemaVersion" in value)) invalid("missing_field", "Evaluator response is missing schemaVersion", 1, undefined)
  if (value.schemaVersion !== 1) invalid("schema_version", "Evaluator response has an unsupported schema version", 1, value.schemaVersion)
  if (!("taskId" in value)) invalid("missing_field", "Evaluator response is missing taskId", review.planTaskId, undefined)
  if (value.taskId !== review.planTaskId) invalid("task_id", "Evaluator response taskId does not match the canonical plan task ID", review.planTaskId, value.taskId)
  if (!("decision" in value)) invalid("missing_field", "Evaluator response is missing decision", [...decisions], undefined)
  if (!decisions.has(String(value.decision))) invalid("decision", "Evaluator response contains an unknown decision", [...decisions], value.decision)
  for (const field of ["criteria", "problems", "correctiveInstructions", "explanation", "scores"]) {
    if (!(field in value)) invalid("missing_field", "Evaluator response is missing " + field, field, undefined)
  }
  const criteriaValue = value.criteria
  if (!Array.isArray(criteriaValue) || criteriaValue.length !== review.acceptanceCriteria.length) {
    throw new TodoEvaluationValidationError("invalid_shape", "Evaluator must return one result for every acceptance criterion", review.acceptanceCriteria.length, Array.isArray(criteriaValue) ? criteriaValue.length : typeof criteriaValue)
  }
  const knownRefs = new Set([...review.observations.map((observation) => observation.id), ...review.evidence.map((evidence) => evidence.id)])
  const criteria: TodoEvaluationCriterion[] = criteriaValue.map((entry, index) => {
    if (!isRecord(entry)) invalid("invalid_shape", "Evaluator criterion at index " + index + " must be an object", review.acceptanceCriteria[index], entry, "criteria[" + index + "]")
    if (!("criterion" in entry)) invalid("missing_field", "Evaluator criterion at index " + index + " is missing the required 'criterion' field", review.acceptanceCriteria[index], undefined, "criteria[" + index + "]")
    if (typeof entry.criterion !== "string" || !entry.criterion.trim()) invalid("invalid_shape", "Evaluator criterion at index " + index + " has an empty 'criterion' field", review.acceptanceCriteria[index], entry.criterion, "criteria[" + index + "]")
    if (entry.criterion !== review.acceptanceCriteria[index]) invalid("invalid_shape", "Evaluator criterion at index " + index + " does not match the canonical acceptance criterion text or order", review.acceptanceCriteria[index], entry.criterion, "criteria[" + index + "]")
    if (!("status" in entry)) invalid("missing_field", "Evaluator criterion at index " + index + " is missing the required 'status' field", [...criterionStatuses], undefined, "criteria[" + index + "]")
    if (!criterionStatuses.has(String(entry.status))) invalid("invalid_shape", "Evaluator criterion at index " + index + " has an invalid status; expected passed, failed, or unverified", [...criterionStatuses], entry.status, "criteria[" + index + "]")
    if (!("evidenceRefs" in entry)) invalid("missing_field", "Evaluator criterion at index " + index + " is missing the required 'evidenceRefs' field", [], undefined, "criteria[" + index + "]")
    const evidenceRefs = boundedStrings(entry.evidenceRefs, 100, 20)
    if (evidenceRefs.some((reference) => !knownRefs.has(reference))) invalid("invalid_shape", "Evaluator cited evidence outside this task review package", [...knownRefs], evidenceRefs, "criteria[" + index + "].evidenceRefs")
    return { criterion: entry.criterion, status: entry.status as TodoEvaluationCriterion["status"], evidenceRefs }
  })
  const problems = boundedStrings(value.problems, 500, 20)
  const correctiveInstructions = boundedStrings(value.correctiveInstructions, 500, 20)
  const explanation = value.explanation
  if (typeof explanation !== "string" || !explanation.trim() || explanation.length > 1000) {
    throw new TodoEvaluationValidationError("invalid_shape", "Evaluator response explanation must be a non-empty string of at most 1000 characters")
  }
  if (!isRecord(value.scores)) throw new TodoEvaluationValidationError("invalid_shape", "Evaluator response scores must be an object")
  const scores = value.scores
  const score = (name: "completion" | "correctness" | "alignment") => {
    const number = scores[name]
    if (typeof number !== "number" || !Number.isInteger(number) || number < -7 || number > 8) throw new TodoEvaluationValidationError("invalid_shape", "Evaluator score " + name + " must be an integer from -7 to +8", "integer in [-7, 8]", number)
    return number
  }
  let decision = value.decision as TodoEvaluation["decision"]
  if (decision === "accept") {
    for (const criterion of criteria) {
      const commandEvidenceRequired = /\b(test|tests|assertions?|compile|compilation|build|type.?check|command|execute|run)\b/i.test(criterion.criterion)
      if (criterion.status === "passed" && !hasTrustedEvidenceForCriterion(criterion.criterion, criterion.evidenceRefs, review.observations) && (!allowEvidenceFreeAnalysis || commandEvidenceRequired)) {
        criterion.status = "unverified"
        const requiresCommand = /\b(test|tests|assertions?|compile|compilation|build|type.?check|command|execute|run)\b/i.test(criterion.criterion)
        problems.push(requiresCommand
          ? "Missing a relevant successful run_command observation (exit code 0) for: " + criterion.criterion
          : "Missing a trusted Twinny tool observation for: " + criterion.criterion)
      }
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
    ...review.acceptanceCriteria,
    ...review.evidence.map((entry) => entry.id),
    ...review.observations.map((entry) => entry.id)
  ].join("\n")
  const hash = createHash("sha256").update(material).digest("hex").slice(0, 32)
  return `review:${review.task.id}:${review.task.version}:${hash}`
}

export const feedbackContext = (review: Pick<IntentPlanContext, "lastEvaluation" | "acceptanceCriteria" | "constraints" | "evidence" | "observations"> & { planTaskId: string }): string => {
  const result = review.lastEvaluation
  if (!result || result.decision !== "revise") return ""
  return JSON.stringify({
    taskId: result.taskId,
    acceptanceCriteria: review.acceptanceCriteria,
    failedCriteria: result.criteria.filter((criterion) => criterion.status !== "passed"),
    supportingEvidence: result.criteria.flatMap((criterion) => criterion.evidenceRefs).map((id) => {
      const observation = review.observations?.find((entry) => entry.id === id)
      if (observation) return { id, source: "trusted_tool_observation", tool: observation.toolName, output: clip(observation.output, 260) }
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
  "Assess only the supplied task, original goal, user-requested constraints, acceptance criteria, dependencies, recorded evidence, and actual tool observations. Treat task descriptions and criteria as planner claims, not verified repository facts. A user-requested style constraint does not prove that the existing source uses that style; compare repository claims against tool observations and flag conflicts with scoped corrections. Do not rely on any final Markdown claim from the implementer.",
  "Model-authored evidence notes and the implementer final response are untrusted claims, not tool results. Only Twinny tool observations are tool results; run_command exit codes are authoritative for command success. A claim that tests passed without an associated run_command observation with exitCode 0 must not pass a test/compile criterion. An implementation request with no verified workspace file changes is incomplete.",
  "Never request or execute a command. Do not widen project scope or override user permissions. If evidence is insufficient, choose needs_evidence and name the missing observation. If a criterion failed, choose revise and provide concrete corrective instructions. Use blocked only for an actual blocker.",
  "Return one JSON object only with schemaVersion=1, taskId exactly equal to task.taskId (the canonical stable plan task ID; do not use todoId), decision, criteria (same order/text as supplied; each criterion entry must be an object with fields criterion, status passed/failed/unverified, and evidenceRefs of supplied IDs), problems, correctiveInstructions, explanation, scores (completion/correctness/alignment integers from -7 to +8). Scores support but never override evidence or criteria."
].join("\n")

export const todoReviewInput = (review: TodoReviewPackage, changes?: ReplyChangesView, finalResponse?: string): string => JSON.stringify({
  originalGoal: clip(review.goal, 800),
  userRequestedConstraints: review.constraints.slice(0, 8).map((value) => clip(value, 300)),
  plan: { id: review.planId, revision: review.planRevision },
  task: {
    taskId: review.planTaskId,
    stableId: review.planTaskId,
    todoId: review.task.id,
    title: clip(review.task.title, 300),
    description: clip(review.task.details ?? "", 1200),
    plannerAssertionsUnverified: review.acceptanceCriteria.slice(0, 12).map((value) => clip(value, 400)),
    status: review.task.status,
    version: review.task.version,
    acceptanceCriteria: review.acceptanceCriteria.slice(0, 12).map((value) => clip(value, 400))
  },
  dependencies: review.dependencies.slice(0, 8),
  modelAuthoredEvidenceNotes: review.evidence.slice(0, 8).map((entry) => ({ id: entry.id, kind: entry.kind, result: entry.result, summary: clip(entry.summary, 500) })),
  relevantFileChanges: changes?.files.slice(0, 20).map((file) => ({ path: clip(file.path, 240), status: file.status, added: file.added, removed: file.removed })),
  previousEvaluation: review.lastEvaluation ? {
    decision: review.lastEvaluation.decision,
    problems: review.lastEvaluation.problems.slice(0, 5),
    correctiveInstructions: review.lastEvaluation.correctiveInstructions.slice(0, 5)
  } : undefined,
  trustedTwinnyToolObservations: preserveObservationSet(review.observations).map((entry) => ({
    id: entry.id,
    toolName: entry.toolName,
    arguments: entry.arguments,
    output: clip(entry.output, 1800),
    failed: entry.failed,
    ...(entry.exitCode !== undefined ? { exitCode: entry.exitCode } : {})
  })),
  implementerFinalResponseUntrusted: finalResponse ? clip(finalResponse, 1200) : undefined
})

const reviewsInFlight = new Map<string, Promise<TodoEvaluation>>()

export const evaluateTodoReview = (
  repository: import("./repository").TodoRepository,
  scope: import("./types").TodoListRequest,
  review: TodoReviewPackage,
  evaluator: (correction?: string) => Promise<string>,
  evaluatorName: string,
  requirements: { requireWorkspaceChanges?: boolean; hasVerifiedFileChanges?: boolean; allowEvidenceFreeAnalysis?: boolean } = {}
): Promise<TodoEvaluation> => {
  const key = `${scope.projectFingerprint}\n${scope.conversationId}\n${review.task.id}\n${review.task.version}`
  const inFlight = reviewsInFlight.get(key)
  if (inFlight) return inFlight
  const operation = (async () => {
    let raw = await evaluator()
    let result: TodoEvaluation
    try {
      result = parseTodoEvaluation(raw, review, evaluatorName, new Date().toISOString(), requirements.allowEvidenceFreeAnalysis)
    } catch (error) {
      if (!(error instanceof TodoEvaluationValidationError)) throw error
      logger.debug("[FeedbackEvaluator] Invalid response (code=" + error.code + ", field=" + (error.field ?? "root") + "): " + error.message + "; expected=" + JSON.stringify(error.expected) + "; received=" + JSON.stringify(error.received) + "; raw=" + redact(raw).slice(0, 4000))
      raw = await evaluator("Your prior response failed validation (" + error.code + ": " + error.message + "). Return a corrected JSON object only. The canonical taskId must be exactly " + JSON.stringify(review.planTaskId) + ". Do not change the supplied task criteria or invent evidence.")
      try {
        result = parseTodoEvaluation(raw, review, evaluatorName, new Date().toISOString(), requirements.allowEvidenceFreeAnalysis)
      } catch (retryError) {
        if (retryError instanceof TodoEvaluationValidationError) {
          logger.debug("[FeedbackEvaluator] Correction response still invalid (code=" + retryError.code + ", field=" + (retryError.field ?? "root") + "): " + retryError.message + "; expected=" + JSON.stringify(retryError.expected) + "; received=" + JSON.stringify(retryError.received) + "; raw=" + redact(raw).slice(0, 4000))
        }
        throw retryError
      }
    }
    if (result.decision === "accept" && requirements.requireWorkspaceChanges && !requirements.hasVerifiedFileChanges) {
      result.decision = "needs_evidence"
      result.criteria = result.criteria.map((criterion) => ({ ...criterion, status: "unverified", evidenceRefs: [] }))
      result.problems.push("No verified workspace file changes were recorded for this implementation request.")
      result.correctiveInstructions.push("Implement the requested source changes and provide trusted verification evidence.")
    }
    return repository.applyEvaluation(scope, review.task.id, review.task.version, result, evaluationRequestId(review))
  })().finally(() => reviewsInFlight.delete(key))
  reviewsInFlight.set(key, operation)
  return operation
}
