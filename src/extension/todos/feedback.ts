import { createHash } from "node:crypto"

import type { ReplyChangesView, TodoEvaluation, TodoEvaluationCriterion } from "../../common/types"

import type { IntentPlanContext, TodoReviewPackage } from "./types"

const decisions = new Set(["accept", "revise", "needs_evidence", "blocked"])
const criterionStatuses = new Set(["passed", "failed", "unverified"])
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
const boundedStrings = (value: unknown, limit: number, entryLimit: number): string[] => {
  if (!Array.isArray(value) || value.length > entryLimit || value.some((entry) => typeof entry !== "string" || !entry.trim() || entry.length > limit)) {
    throw new Error("Evaluation contains an invalid string list")
  }
  return value.map((entry) => (entry as string).trim())
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
  evaluatedAt = new Date().toISOString()
): TodoEvaluation => {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const value: unknown = JSON.parse((fenced?.[1] ?? raw).trim())
  if (!isRecord(value) || value.schemaVersion !== 1 || value.taskId !== review.planTaskId || !decisions.has(String(value.decision))) {
    throw new Error("Evaluator response has an invalid schema version, task ID, or decision")
  }
  if (!Array.isArray(value.criteria) || value.criteria.length !== review.acceptanceCriteria.length) {
    throw new Error("Evaluator must return one result for every acceptance criterion")
  }
  const knownRefs = new Set([...review.observations.map((observation) => observation.id), ...review.evidence.map((evidence) => evidence.id)])
  const criteria: TodoEvaluationCriterion[] = value.criteria.map((entry, index) => {
    if (!isRecord(entry) || entry.criterion !== review.acceptanceCriteria[index] || !criterionStatuses.has(String(entry.status))) {
      throw new Error("Evaluator returned malformed or reordered acceptance criteria")
    }
    const evidenceRefs = boundedStrings(entry.evidenceRefs, 100, 20)
    if (evidenceRefs.some((reference) => !knownRefs.has(reference))) throw new Error("Evaluator cited evidence outside this task review package")
    return { criterion: entry.criterion, status: entry.status as TodoEvaluationCriterion["status"], evidenceRefs }
  })
  const problems = boundedStrings(value.problems, 500, 20)
  const correctiveInstructions = boundedStrings(value.correctiveInstructions, 500, 20)
  if (typeof value.explanation !== "string" || !value.explanation.trim() || value.explanation.length > 1000) {
    throw new Error("Evaluator response is missing its explanation")
  }
  if (!isRecord(value.scores)) throw new Error("Evaluator response is missing scores")
  const scores = value.scores
  const score = (name: "completion" | "correctness" | "alignment") => {
    const number = scores[name]
    if (typeof number !== "number" || !Number.isInteger(number) || number < -7 || number > 8) throw new Error(`Evaluator score ${name} must be an integer from -7 to +8`)
    return number
  }
  let decision = value.decision as TodoEvaluation["decision"]
  if (decision === "accept") {
    for (const criterion of criteria) {
      if (criterion.status === "passed" && !hasTrustedEvidenceForCriterion(criterion.criterion, criterion.evidenceRefs, review.observations)) {
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
    throw new Error("Insufficient-evidence decisions must identify missing evidence")
  }
  if (decision === "revise" && !correctiveInstructions.length) throw new Error("Revision decisions must include corrective instructions")
  return {
    schemaVersion: 1,
    taskId: review.planTaskId,
    decision,
    criteria,
    problems,
    correctiveInstructions,
    explanation: value.explanation.trim(),
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
  "Assess only the supplied task, original goal and constraints, acceptance criteria, dependencies, recorded evidence, and actual tool observations. Do not rely on any final Markdown claim from the implementer.",
  "Model-authored evidence notes are untrusted summaries. Only Twinny tool observations are tool results; run_command exit codes are authoritative for command success. A claim that tests passed without an associated run_command observation with exitCode 0 must not pass a test/compile criterion.",
  "Never request or execute a command. Do not widen project scope or override user permissions. If evidence is insufficient, choose needs_evidence and name the missing observation. If a criterion failed, choose revise and provide concrete corrective instructions. Use blocked only for an actual blocker.",
  "Return one JSON object only with schemaVersion=1, taskId, decision, criteria (same order/text as supplied, each status passed/failed/unverified and evidenceRefs of supplied IDs), problems, correctiveInstructions, explanation, scores (completion/correctness/alignment integers from -7 to +8). Scores support but never override evidence or criteria."
].join("\n")

export const todoReviewInput = (review: TodoReviewPackage, changes?: ReplyChangesView): string => JSON.stringify({
  originalGoal: clip(review.goal, 800),
  constraints: review.constraints.slice(0, 8).map((value) => clip(value, 300)),
  plan: { id: review.planId, revision: review.planRevision },
  task: {
    stableId: review.planTaskId,
    id: review.task.id,
    title: clip(review.task.title, 300),
    description: clip(review.task.details ?? "", 1200),
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
  trustedTwinnyToolObservations: review.observations.slice(0, 12).map((entry) => ({
    id: entry.id,
    toolName: entry.toolName,
    arguments: entry.arguments,
    output: clip(entry.output, 1800),
    failed: entry.failed,
    ...(entry.exitCode !== undefined ? { exitCode: entry.exitCode } : {})
  }))
})

const reviewsInFlight = new Map<string, Promise<TodoEvaluation>>()

export const evaluateTodoReview = (
  repository: import("./repository").TodoRepository,
  scope: import("./types").TodoListRequest,
  review: TodoReviewPackage,
  evaluator: () => Promise<string>,
  evaluatorName: string
): Promise<TodoEvaluation> => {
  const key = `${scope.projectFingerprint}\n${scope.conversationId}\n${review.task.id}\n${review.task.version}`
  const inFlight = reviewsInFlight.get(key)
  if (inFlight) return inFlight
  const operation = (async () => {
    const result = parseTodoEvaluation(await evaluator(), review, evaluatorName)
    return repository.applyEvaluation(scope, review.task.id, review.task.version, result, evaluationRequestId(review))
  })().finally(() => reviewsInFlight.delete(key))
  reviewsInFlight.set(key, operation)
  return operation
}
