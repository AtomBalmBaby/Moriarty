import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import initSqlJs from "sql.js"

import { logger } from "../../common/logger"
import type { SourceIdentity, TodoCriterionReconciliation, TypedCriterion, WorkspaceMutationOperation } from "../../common/types/todo"
import { resolveAgentToolSelection } from "../../extension/agents/tool-selection"
import { continuationContext,ExecutionReconciliationController } from "../../extension/chat/execution-reconciliation"
import { CHILD_TODO_PROTOCOL, ChildTodoReviewer, FEEDBACK_PLAN_PROTOCOL, FeedbackPlanner, parseFeedbackPlanResponse, userRequestsTodoCreation } from "../../extension/chat/feedback-planner"
import { checkDelivery, type DeliveryVerdict } from "../../extension/todos/delivery"
import { EVIDENCE_BUDGET, type EvidenceBudget, projectEvidence, rankPromotionCandidates, renderRecentObservations, renderRequiredEvidence } from "../../extension/todos/evidence-context"
import { commandDigest, compactArguments, compactEvidenceText, compactToolEvidence, describeGap, evidenceAnchors, evidenceGaps, type EvidenceRecord, excerptEvidence, MAX_EVIDENCE_TEXT, MAX_EXCERPT_CHARS, MAX_RETAINED_EVIDENCE_CHARS, preserveEvidence } from "../../extension/todos/evidence"
import { assessAcceptedFacts, completeProvenReviews, type CurrentSourceReader, dependenciesComplete, DETERMINISTIC_EVALUATOR, evaluateTodoReview, EVIDENCE_CHECK_TOOL, evidenceCheckRecord, evidencePreflight, factNamedBy, feedbackContext, hostDecidesReview, parseTodoEvaluation, provenTodoEvaluation, renderEvidencePreflight, reviewCandidates, reviewReconciliations, selectAcceptedFacts, taskHasVerifiedMutation, taskRequiresWorkspaceChanges, TodoEvaluationValidationError, todoReviewInput,todoReviewSystemPrompt } from "../../extension/todos/feedback"
import { validateIntentTaskPlan } from "../../extension/todos/intent-plan"
import { capabilityOf } from "../../extension/todos/verification-capabilities"
import { authoritativeExecutionReport, renderPlanContext } from "../../extension/todos/plan-context"
import { editDigest, TodoRepository, trustedTodoPanelApproval, workspaceProjectFingerprint } from "../../extension/todos/repository"
import type { AcceptedFact, AnswerRequirement, ChildTodoDecision, ChildTodoReview, IntentPlanOutline, RetainedObservationEvidence, SymbolAlias, TodoEvaluation, TodoReviewPackage, TodoWriteRequest } from "../../extension/todos/types"
import { RUNTIME_INVENTORY_TOOL, TodoConflictError } from "../../extension/todos/types"
import { fingerprintContent } from "../../extension/tools/fingerprint"
import { contentHash, planLineEdits } from "../../extension/tools/line-edit"
import { todoWorkspaceTools } from "../../extension/tools/todos"
import { type EditSink, type ToolResult,workspaceTools } from "../../extension/tools/workspace"

const wasmPath = path.join(process.cwd(), "out", "sql-wasm.wasm")
const plan = (tasks: { id: string; title?: string; criteria: TypedCriterion[]; dependencies?: string[] }[], goal = "Verify the requested work") => ({
  planId: "feedback-plan",
  version: 1 as const,
  revision: 1,
  goal,
  constraints: ["Preserve existing behavior"],
  tasks: tasks.map((task) => ({
    id: task.id,
    title: task.title ?? task.id,
    description: `Work for ${task.id}`,
    criteria: task.criteria,
    dependencies: task.dependencies ?? []
  }))
})

/** A criterion Feedback judges because no objective descriptor applies to it. */
const semantic = (id: string, description = id): TypedCriterion => ({ id, description, verification: { kind: "semantic_review" } })
const exitZero = (command: string): TypedCriterion => ({ id: "exit", description: `\`${command}\` exits with status 0`, verification: { kind: "command_exit_status", command, exitCode: 0 } })
const locate = (symbol: string, path: string, identity: SourceIdentity): TypedCriterion => ({ id: "locate", description: `Locate ${symbol} in ${path}`, verification: { kind: "source_location", symbol, path, identity } })
const sourceLocation = (id: string, description: string, symbol: string, identity: SourceIdentity, path = WORKSPACE_FILE): TypedCriterion => ({ id, description, verification: { kind: "source_location", symbol, path, identity } })
/** Runs the production typed reconciler on a review shaped from the given evidence. */
const reviewCriteria = (criteria: TypedCriterion[], retainedEvidence: RetainedObservationEvidence[], readCurrent?: CurrentSourceReader, acceptedEvidence: AcceptedFact[] = [], symbolAliases: SymbolAlias[] = []) =>
  reviewReconciliations({ task: { id: "task" }, criteria, retainedEvidence, acceptedEvidence, symbolAliases }, readCurrent)

/** Reviewer entries for semantic criteria only: objective criteria are host-judged and a reviewer payload cannot name them. */
const semanticEntries = (review: TodoReviewPackage, status: "passed" | "failed", evidenceRefs: string[]) =>
  review.criteria.filter((criterion) => criterion.verification.kind === "semantic_review").map((criterion) => ({ criterionId: criterion.id, status, evidenceRefs }))

/** Parses a reviewer response as evaluateTodoReview does: the host's criterion reconciliations are computed first and passed in. */
const parseEvaluation = async (raw: string, review: TodoReviewPackage, evaluatedAt?: string) =>
  parseTodoEvaluation(raw, review, "mock-reviewer", evaluatedAt ?? new Date().toISOString(), await reviewReconciliations(review))

const fixture = async (tasks: Parameters<typeof plan>[0], complete = true, goal = "Verify the requested work") => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-feedback-"))
  const databasePath = path.join(directory, "twinny-state.sqlite")
  const scope = { projectFingerprint: workspaceProjectFingerprint(["file:///feedback-project"]), conversationId: "feedback-chat", writer: "feedback-chat" }
  const repository = new TodoRepository(databasePath, wasmPath)
  const initial = await repository.synchronizeIntentPlan(scope, plan(tasks, goal), { prompt: goal })
  const items = complete ? [] : initial.items
  if (complete) {
    for (const item of initial.items) {
      items.push(await repository.updateItem(scope, {
        itemId: item.id,
        expectedVersion: item.version,
        patch: { status: "completed" },
        actor: "model",
        requestId: `claim-${item.id}`
      }))
    }
  }
  return { directory, databasePath, scope, repository, items }
}

const acceptingReview: ChildTodoReview = async () => ({ ok: true, decision: { decision: "accepted", instruction: "Accepted under the parent." } })

const responseFor = (review: TodoReviewPackage, options: {
  decision?: TodoEvaluation["decision"]
  status?: "passed" | "failed" | "unverified"
  refs?: string[]
  correctiveInstructions?: string[]
  problems?: string[]
} = {}) => JSON.stringify({
  schemaVersion: 1,
  taskId: review.planTaskId,
  decision: options.decision ?? "accept",
  criteria: review.criteria.filter((criterion) => criterion.verification.kind === "semantic_review").map((criterion) => ({
    criterionId: criterion.id,
    status: options.status ?? "passed",
    evidenceRefs: options.refs ?? []
  })),
  problems: options.problems ?? [],
  correctiveInstructions: options.correctiveInstructions ?? [],
  explanation: "Reviewed the task against the supplied observations.",
  scores: { completion: 7, correctness: 7, alignment: 8 }
})

const runCommandArguments = (command: string) => compactArguments(compactToolEvidence({ name: "run_command", args: { command }, output: "", failed: false, exitCode: 0, invocationId: "fixture" }))

const addObservation = (repository: TodoRepository, scope: TodoWriteRequest, itemId: string, toolName = "read_file", exitCode?: number) =>
  repository.recordToolObservation(scope, {
    itemId,
    toolName,
    arguments: toolName === "run_command" ? runCommandArguments("npx tsc --strict && node example/intent-smoke/check.cjs") : { path: "src/fixture.ts" },
    output: exitCode === undefined ? "Twinny tool returned the inspected content." : "3 assertions passed.",
    failed: false,
    exitCode,
    requestId: `observation-${itemId}-${toolName}`
  })

test("the executor receives the synchronized plan with stable IDs, versions, and bounded detail", () => {
  const tasks: IntentPlanOutline["tasks"] = Array.from({ length: 26 }, (_, index) => ({
    taskId: `task-${index}`,
    itemId: `item-${index}`,
    title: `Task ${index}`,
    status: index === 0 ? "in_review" : "pending",
    verification: "not_checked",
    version: index + 3,
    unmetCriteria: index === 0 ? ["edited file shows the new identifier"] : [],
    problems: [],
    awaitingDependencies: []
  }))
  const rendered = renderPlanContext({ planId: "plan-1", revision: 4, goal: "Verify the requested work", tasks, children: [] })
  assert.match(rendered, /plan plan-1, revision 4/)
  assert.match(rendered, /- item-0 \(in_review, verification not_checked, version 3\) Task 0/)
  assert.match(rendered, /needs evidence: edited file shows the new identifier/)
  assert.match(rendered, /item-23 \(/)
  assert.doesNotMatch(rendered, /item-24 \(/)
  assert.match(rendered, /2 more tasks not shown/)
  assert.match(rendered, /expected_version/)
})

test("oversized tool output becomes bounded valid evidence with its fingerprint extracted, not recomputed", () => {
  const fingerprint = "sha256:" + "a".repeat(64)
  const output = [`${fingerprint}`, "x".repeat(200_000), "{\"observation_id\":\"obs-12345\"}"].join("\n")
  const evidence = compactToolEvidence({
    name: "read_file", args: { path: "src/a.ts", start_line: 1, end_line: 20 }, output, failed: false, invocationId: "inv-1"
  })
  assert.deepEqual(evidence.fingerprints, [fingerprint])
  assert.deepEqual(evidence.resultIds, ["obs-12345"])
  assert.deepEqual(evidence.lineRange, { start: 1, end: 20 })
  const stored = compactEvidenceText(evidence)
  assert.ok(stored.length <= MAX_EVIDENCE_TEXT)
  assert.equal(JSON.parse(stored).invocationId, "inv-1")
  const failed = compactToolEvidence({ name: "edit_lines", args: { path: "b.ts" }, output: "token=sk-abcdefghijklmnopqrstuvwx boom", failed: true, invocationId: "inv-2" })
  assert.match(failed.summary, /^failed: /)
  assert.doesNotMatch(failed.summary, /sk-abcdefghij/)
})

test("a run_command observation keeps its command text, and other tools keep only their target arguments", () => {
  const run = compactArguments(compactToolEvidence({ name: "run_command", args: { command: "test -f made.txt" }, output: "", failed: false, exitCode: 0, invocationId: "inv-3" }))
  assert.deepEqual(run, { command: "test -f made.txt", command_sha256: commandDigest("test -f made.txt") })
  const read = compactArguments(compactToolEvidence({ name: "read_file", args: { path: "src/a.ts", command: "not-a-command" }, output: "", failed: false, invocationId: "inv-4" }))
  assert.deepEqual(read, { path: "src/a.ts" })
})

test("command identity covers the whole trimmed command, while the stored display stays bounded", () => {
  const header = "test -f made.txt #"
  const prefix = header + "p".repeat(500 - header.length)
  const extended = prefix + "x".repeat(100)
  const identify = (command: string) => compactArguments(compactToolEvidence({
    name: "run_command", args: { command }, output: "", failed: false, exitCode: 0, invocationId: "inv-5"
  }))
  const longRun = identify(extended)
  assert.equal(longRun.command, prefix, "the display is bounded to 500 characters")
  assert.equal(longRun.command_sha256, commandDigest(extended))
  assert.match(longRun.command_sha256, /^sha256:[0-9a-f]{64}$/)
  assert.notEqual(longRun.command_sha256, identify(prefix).command_sha256, "a command is not identified by its display prefix")
  assert.equal(identify(`  ${prefix}\n`).command_sha256, identify(prefix).command_sha256, "surrounding whitespace is not part of the identity")
  assert.notEqual(identify("test -f made.txt").command_sha256, identify("test -f ready.txt").command_sha256)
})

test("no-progress detection stops repeated identical work and unchanged rejections, while a changed unsatisfied set is progress", () => {
  const stalled = new ExecutionReconciliationController()
  const repeat = { observations: [{ toolName: "search_workspace", arguments: { query: "x" }, failed: false }], passedCriteria: [] }
  const looped: boolean[] = []
  for (let turn = 0; turn < 3; turn++) {
    const progressed = stalled.recordEvidence(repeat)
    looped.push(stalled.reconcile("revise", "task-1|in_progress", progressed).continue)
  }
  assert.deepEqual(looped, [true, true, false])
  assert.equal(stalled.state, "blocked")

  const changing = new ExecutionReconciliationController()
  for (let turn = 0; turn < 3; turn++) {
    const progressed = changing.recordEvidence({
      observations: [{ toolName: "read_file", arguments: { path: `file-${turn}.ts` }, failed: false }], passedCriteria: []
    })
    assert.equal(changing.reconcile("revise", `task-1|criterion-${turn}:failed`, progressed).continue, true, `turn ${turn} changed the unsatisfied set`)
  }

  const unchanged = new ExecutionReconciliationController()
  const reads = [0, 1, 2].map((turn) => unchanged.recordEvidence({
    observations: [{ toolName: "read_file", arguments: { path: `file-${turn}.ts` }, failed: false }], passedCriteria: []
  }))
  assert.equal(unchanged.reconcile("revise", "task-1|criterion:failed", reads[0]).continue, true)
  assert.equal(unchanged.reconcile("revise", "task-1|criterion:failed", reads[1]).continue, true)
  const stopped = unchanged.reconcile("revise", "task-1|criterion:failed", reads[2])
  assert.equal(stopped.continue, false, "new reads that leave the same criterion unsatisfied are not endless progress")
  assert.match(stopped.reason ?? "", /no measurable progress/)
})

test("a passed criterion restarts the no-progress count, and a repeated rejection stops with the open criterion", () => {
  const controller = new ExecutionReconciliationController()
  assert.equal(controller.reconcile("needs_evidence", "task-1|criterion:failed", "observations").continue, true)
  const passed = controller.recordEvidence({ observations: [], passedCriteria: ["read_file is defined"] })
  assert.equal(passed, "criteria")
  assert.equal(controller.reconcile("needs_evidence", "task-1|criterion:passed", passed).continue, true)
  assert.equal(controller.reconcile("needs_evidence", "task-1|criterion:passed", "none").continue, true, "the count starts again after progress")

  const rejected = new ExecutionReconciliationController()
  const first = rejected.reconcile("needs_evidence", "task-1|in_progress", "none")
  const second = rejected.reconcile("needs_evidence", "task-1|in_progress", "none")
  assert.equal(first.continue, true)
  assert.equal(second.continue, false)
  assert.match(second.reason ?? "", /no measurable progress/)
})

test("evidence gates progress: repeated identical calls and re-passed criteria do not count", () => {
  const controller = new ExecutionReconciliationController()
  const search = { toolName: "search_workspace", arguments: { query: "ALPHA" }, failed: false }
  assert.equal(controller.recordEvidence({ observations: [search], passedCriteria: [] }), "observations")
  assert.equal(controller.recordEvidence({ observations: [search], passedCriteria: [] }), "none")
  assert.equal(controller.recordEvidence({ observations: [], passedCriteria: ["file edited"] }), "criteria")
  assert.equal(controller.recordEvidence({ observations: [], passedCriteria: ["file edited"] }), "none")
  const edit = { toolName: "edit_lines", arguments: { path: "a.ts" } }
  assert.equal(controller.recordEvidence({ observations: [{ ...edit, failed: true }], passedCriteria: [] }), "none")
  assert.equal(controller.recordEvidence({ observations: [{ ...edit, failed: false }], passedCriteria: [] }), "observations", "a failed call that now succeeds is progress")
})

test("continuation names the outstanding TODO items and forbids replacements", () => {
  const text = continuationContext({
    goal: "Verify index", constraints: [], task: "Edit smoke file", criteria: ["BETA is present"], feedback: ["needs_evidence"],
    todoTargets: ["item-7 (version 4, in_progress) Edit smoke file: needs evidence: BETA is present"],
    finalResponse: "done"
  })
  assert.match(text, /Outstanding TODO items:\n- item-7 \(version 4/)
  assert.match(text, /Do not create replacements/)
})

test("a model create that repeats an existing title in the same list reconciles to that item", async () => {
  const state = await fixture([{ id: "seed", criteria: [semantic("seed", "Seed criterion")] }])
  try {
    const existing = await state.repository.createItem(state.scope, { title: "Map the parser" }, "seed-create")
    const duplicate = await state.repository.createItem(state.scope, { title: "  map   the PARSER. " }, "model-dup", "model")
    assert.equal(duplicate.id, existing.id)
    const userCreate = await state.repository.createItem(state.scope, { title: "Map the parser" }, "user-create", "user")
    assert.notEqual(userCreate.id, existing.id, "explicit user creation is never silently merged")
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("trusted passing observations accept a task and persist verification", async () => {
  const state = await fixture([{ id: "verify", criteria: [semantic("verify", "Focused tests pass")] }])
  try {
    const item = state.items[0]
    const observation = await addObservation(state.repository, state.scope, item.id, "run_command", 0)
    const review = (await state.repository.getReviewPackages(state.scope))[0]
    const evaluation = await evaluateTodoReview(state.repository, state.scope, review,
      async () => responseFor(review, { refs: [observation.id] }), "mock-reviewer")
    assert.equal(evaluation.decision, "accept")
    const completed = (await state.repository.getList(state.scope)).items[0]
    assert.equal(completed.status, "completed")
    assert.equal(completed.verification, "passed")
    assert.equal((await state.repository.getEvaluationHistory(state.scope, item.id)).length, 1)
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

const commandObservation = (repository: TodoRepository, scope: TodoWriteRequest, itemId: string, command: string, exitCode: number) =>
  repository.recordToolObservation(scope, {
    itemId,
    toolName: "run_command",
    arguments: runCommandArguments(command),
    output: exitCode === 0 ? "Command completed." : "Command reported an error.",
    failed: false,
    exitCode,
    requestId: `command-${itemId}-${exitCode}`
  })

test("a backticked exit-status criterion is decided deterministically, without any evaluator call, from the recorded exit status", async () => {
  const command = "npx tsc --noEmit"
  const state = await fixture([{ id: "verify", criteria: [exitZero(command)] }])
  try {
    const item = state.items[0]
    const observation = await commandObservation(state.repository, state.scope, item.id, command, 0)
    const review = (await state.repository.getReviewPackages(state.scope))[0]
    let evaluatorCalls = 0
    const evaluation = await evaluateTodoReview(state.repository, state.scope, review, async () => { evaluatorCalls++; return "{}" }, "mock-reviewer")
    assert.equal(evaluatorCalls, 0)
    assert.equal(evaluation.decision, "accept")
    assert.equal(evaluation.metadata?.evaluator, DETERMINISTIC_EVALUATOR)
    assert.deepEqual(evaluation.criteria[0].evidenceRefs, [observation.id])
    assert.equal((await state.repository.getList(state.scope)).items[0].status, "completed")
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("a recorded nonzero exit fails a backticked exit-status criterion deterministically and returns to work", async () => {
  const command = "npx tsc --noEmit"
  const state = await fixture([{ id: "verify", criteria: [exitZero(command)] }])
  try {
    const item = state.items[0]
    await commandObservation(state.repository, state.scope, item.id, command, 1)
    const review = (await state.repository.getReviewPackages(state.scope))[0]
    let evaluatorCalls = 0
    const evaluation = await evaluateTodoReview(state.repository, state.scope, review, async () => { evaluatorCalls++; return "{}" }, "mock-reviewer")
    assert.equal(evaluatorCalls, 0)
    assert.equal(evaluation.decision, "revise")
    assert.equal(evaluation.criteria[0].status, "failed")
    assert.equal((await state.repository.getList(state.scope)).items[0].status, "in_progress")
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("an exit-status criterion without a recorded run is never passed, and no evaluator is asked to supply the missing fact", async () => {
  const command = "npx tsc --noEmit"
  const state = await fixture([{ id: "verify", criteria: [exitZero(command)] }])
  try {
    const review = (await state.repository.getReviewPackages(state.scope))[0]
    let evaluatorCalls = 0
    const evaluation = await evaluateTodoReview(state.repository, state.scope, review, async () => { evaluatorCalls++; return "{}" }, "mock-reviewer")
    assert.equal(evaluatorCalls, 0)
    assert.equal(evaluation.decision, "needs_evidence")
    assert.notEqual((await state.repository.getList(state.scope)).items[0].status, "completed")
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("every verdict logs whether the host decided it deterministically or Feedback reviewed it", async () => {
  const lines: string[] = []
  const originalInfo = logger.info
  logger.info = (message: string) => { lines.push(message) }
  const command = "npx tsc --noEmit"
  const deterministic = await fixture([{ id: "exact", criteria: [exitZero(command)] }])
  const reviewed = await fixture([{ id: "semantic", criteria: [semantic("semantic", "Focused tests pass")] }])
  try {
    await commandObservation(deterministic.repository, deterministic.scope, deterministic.items[0].id, command, 0)
    const exactReview = (await deterministic.repository.getReviewPackages(deterministic.scope))[0]
    await evaluateTodoReview(deterministic.repository, deterministic.scope, exactReview, async () => "{}", "mock-reviewer")
    const observation = await addObservation(reviewed.repository, reviewed.scope, reviewed.items[0].id, "run_command", 0)
    const semanticReview = (await reviewed.repository.getReviewPackages(reviewed.scope))[0]
    await evaluateTodoReview(reviewed.repository, reviewed.scope, semanticReview,
      async () => responseFor(semanticReview, { refs: [observation.id] }), "mock-reviewer")
    const verdicts = lines.filter((line) => line.includes("todo.verdict"))
    assert.equal(verdicts.length, 2, lines.join("\n"))
    assert.match(verdicts[0], /source=deterministic decision=accept/)
    assert.match(verdicts[1], /source=feedback evaluator=mock-reviewer decision=accept/)
  } finally {
    logger.info = originalInfo
    fs.rmSync(deterministic.directory, { recursive: true, force: true })
    fs.rmSync(reviewed.directory, { recursive: true, force: true })
  }
})

test("failed criteria return actionable revision feedback for the next task context", async () => {
  const state = await fixture([{ id: "fix", criteria: [semantic("fix", "Regression test passes")] }])
  try {
    const item = state.items[0]
    const observation = await addObservation(state.repository, state.scope, item.id, "run_command", 1)
    await state.repository.addEvidence(state.scope, { itemId: item.id, kind: "review", summary: "The test fails on the boundary case.", result: "failed", requestId: "failed-note" })
    const review = (await state.repository.getReviewPackages(state.scope))[0]
    const evaluation = await evaluateTodoReview(state.repository, state.scope, review,
      async () => responseFor(review, { decision: "revise", status: "failed", refs: [observation.id], correctiveInstructions: ["Fix the boundary case and rerun the focused test."] }), "mock-reviewer")
    assert.equal(evaluation.decision, "revise")
    assert.equal((await state.repository.getList(state.scope)).items[0].status, "in_progress")
    const context = await state.repository.getActiveIntentContext(state.scope)
    assert.ok(context?.lastEvaluation)
    const feedback = feedbackContext(context!)
    assert.match(feedback, /Fix the boundary case/)
    assert.match(feedback, /Regression test passes/)
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("model-authored passing notes cannot verify unsupported success", async () => {
  const state = await fixture([{ id: "compile", criteria: [exitZero("npm test")] }])
  try {
    const item = state.items[0]
    const note = await state.repository.addEvidence(state.scope, { itemId: item.id, kind: "claim", summary: "The tests passed.", result: "passed", requestId: "model-claim" })
    const fakeCommand = await state.repository.recordToolObservation(state.scope, {
      itemId: item.id, toolName: "run_command", arguments: runCommandArguments("echo tests passed"), output: "tests passed", failed: false, exitCode: 0, requestId: "fake-test-command"
    })
    const review = (await state.repository.getReviewPackages(state.scope))[0]
    const evaluation = await parseEvaluation(responseFor(review, { refs: [note.id, fakeCommand.id] }), review)
    assert.equal(evaluation.decision, "needs_evidence")
    assert.match(evaluation.problems[0], /no recorded run of npm test/)
    await state.repository.applyEvaluation(state.scope, item.id, review.task.version, evaluation, "unsupported-claim")
    const after = (await state.repository.getList(state.scope)).items[0]
    assert.equal(after.status, "in_review")
    assert.equal(after.verification, "not_checked")
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("evaluation history survives reopening and duplicate requests do not transition twice", async () => {
  const state = await fixture([{ id: "persist", criteria: [semantic("persist", "Source inspection is complete")] }])
  try {
    const item = state.items[0]
    const observation = await addObservation(state.repository, state.scope, item.id)
    const review = (await state.repository.getReviewPackages(state.scope))[0]
    let evaluatorCalls = 0
    const mock = async () => {
      evaluatorCalls += 1
      await new Promise((resolve) => setTimeout(resolve, 10))
      return responseFor(review, { refs: [observation.id] })
    }
    await Promise.all([
      evaluateTodoReview(state.repository, state.scope, review, mock, "mock-reviewer"),
      evaluateTodoReview(state.repository, state.scope, review, mock, "mock-reviewer")
    ])
    assert.equal(evaluatorCalls, 1)
    const afterFirst = (await state.repository.getList(state.scope)).items[0]
    await evaluateTodoReview(state.repository, state.scope, review, mock, "mock-reviewer")
    const afterDuplicate = (await state.repository.getList(state.scope)).items[0]
    assert.equal(afterDuplicate.version, afterFirst.version)
    const reopened = new TodoRepository(state.databasePath, wasmPath)
    assert.equal((await reopened.getEvaluationHistory(state.scope, item.id)).length, 1)
    assert.equal((await reopened.getList(state.scope)).items[0].status, "completed")
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("stale evaluations cannot overwrite newer review versions", async () => {
  const state = await fixture([{ id: "stale", criteria: [semantic("stale", "The source was inspected")] }])
  try {
    const item = state.items[0]
    const observation = await addObservation(state.repository, state.scope, item.id)
    const review = (await state.repository.getReviewPackages(state.scope))[0]
    const result = await parseEvaluation(responseFor(review, { refs: [observation.id] }), review)
    await state.repository.updateItem(state.scope, {
      itemId: item.id, expectedVersion: review.task.version, patch: { title: "Changed while reviewing" }, actor: "user", requestId: "user-edited-during-review"
    })
    await assert.rejects(state.repository.applyEvaluation(state.scope, item.id, review.task.version, result, "stale-result"), /changed since review version/)
    assert.equal((await state.repository.getList(state.scope)).items[0].status, "in_review")
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("review provider failures and malformed responses preserve task state", async () => {
  const state = await fixture([{ id: "failure", criteria: [semantic("failure", "Compile succeeds")] }])
  try {
    const item = state.items[0]
    const review = (await state.repository.getReviewPackages(state.scope))[0]
    await assert.rejects(evaluateTodoReview(state.repository, state.scope, review, async () => { throw new Error("provider timeout") }, "mock-reviewer"), /provider timeout/)
    await assert.rejects(evaluateTodoReview(state.repository, state.scope, review, async () => "{ truncated", "mock-reviewer"))
    assert.equal((await state.repository.getList(state.scope)).items[0].status, "in_review")
    assert.deepEqual(await state.repository.getEvaluationHistory(state.scope, item.id), [])
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("manual completion and independent project/chat scopes remain isolated", async () => {
  const state = await fixture([{ id: "user-completed", criteria: [semantic("user-completed", "Review by user")] }])
  try {
    const item = state.items[0]
    await state.repository.completeByUser(state.scope, item.id, item.version, "Explicitly approved by user", "user-complete", trustedTodoPanelApproval)
    assert.deepEqual(await state.repository.getReviewPackages(state.scope), [])
    const otherScope = { projectFingerprint: workspaceProjectFingerprint(["file:///another-project"]), conversationId: "feedback-chat", writer: "feedback-chat" }
    const otherPlan = { ...plan([{ id: "other", criteria: [semantic("other", "Other task is inspected")] }]), planId: "other-plan" }
    await state.repository.synchronizeIntentPlan(otherScope, otherPlan, { prompt: "Other project" })
    const other = (await state.repository.getList(otherScope)).items[0]
    await state.repository.updateItem(otherScope, { itemId: other.id, expectedVersion: other.version, patch: { status: "completed" }, actor: "model", requestId: "other-claim" })
    assert.equal((await state.repository.getReviewPackages(otherScope)).length, 1)
    assert.deepEqual(await state.repository.getReviewPackages(state.scope), [])
    const otherChat = { ...otherScope, conversationId: "other-chat", writer: "other-chat" }
    assert.deepEqual(await state.repository.getReviewPackages(otherChat), [])
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("every eligible task is evaluated with its own IDs and observations", async () => {
  const state = await fixture([
    { id: "inspect", criteria: [semantic("inspect", "The source was inspected")] },
    { id: "change", criteria: [semantic("change", "The implementation was edited")] },
    { id: "test", criteria: [semantic("test", "Tests pass")] }
  ])
  try {
    const expected = new Map<string, string>()
    for (const item of state.items) {
      const task = item.title
      const observation = await addObservation(state.repository, state.scope, item.id, task === "test" ? "run_command" : task === "change" ? "edit_lines" : task, task === "test" ? 0 : undefined)
      expected.set(item.id, observation.id)
    }
    const reviews = await state.repository.getReviewPackages(state.scope)
    assert.equal(reviews.length, 3)
    for (const review of reviews) {
      const own = review.observations.find((entry) => entry.itemId === review.task.id)!
      assert.ok(own, "each review includes its own observation")
      const evaluation = await evaluateTodoReview(state.repository, state.scope, review,
        async () => responseFor(review, { refs: [expected.get(review.task.id)!] }), "mock-reviewer")
      assert.equal(evaluation.taskId, review.planTaskId)
    }
    assert.deepEqual((await state.repository.getList(state.scope)).items.map((item) => item.status), ["completed", "completed", "completed"])
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("existing version-2 TODO databases migrate review tables without losing tasks", async () => {
  const state = await fixture([{ id: "legacy", criteria: [semantic("legacy", "Legacy task is inspected")] }])
  try {
    const sql = await initSqlJs({ locateFile: () => wasmPath })
    const database = new sql.Database(fs.readFileSync(state.databasePath))
    database.run("DROP TABLE todo_evaluations; DROP TABLE todo_tool_observations; PRAGMA user_version = 2")
    fs.writeFileSync(state.databasePath, Buffer.from(database.export()))
    database.close()
    const reopened = new TodoRepository(state.databasePath, wasmPath)
    assert.equal((await reopened.getList(state.scope)).items[0].status, "in_review")
    assert.deepEqual(await reopened.getEvaluationHistory(state.scope, state.items[0].id), [])
    assert.equal((await reopened.getReviewPackages(state.scope)).length, 1)
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("a version-15 database keeps its alias rows as history, gains a nullable registered_tool, and does not promote them into authoritative links", async () => {
  const state = await evidenceFixtureFor([{ id: "registration", criteria: [sourceLocation("defined", "`read_file` is defined in src/extension/tools/workspace.ts", "read_file", "registered_tool", EVIDENCE_FILE)] }])
  try {
    const [registration] = state.itemIds
    await startItemInReview(state.repository, state.scope, registration)
    await observeRead(state, registration, "read-registration", EVIDENCE_FILE, 160, sourceLines.slice(159, 220))
    const calls = { count: 0 }
    const accepted = await evaluateTodoReview(state.repository, state.scope, await reviewFor(state, registration), countingEvaluator(calls), "mock-reviewer", { readCurrentSource: currentWorkspace, hasVerifiedFileChanges: false })
    assert.equal(accepted.decision, "accept", JSON.stringify(accepted.problems))

    const sql = await initSqlJs({ locateFile: () => wasmPath })
    const database = new sql.Database(fs.readFileSync(state.databasePath))
    const [listId, observationId, sourceHash] = database.exec("SELECT list_id, observation_id, source_hash FROM todo_accepted_evidence WHERE registered_tool = 'read_file'")[0].values[0]
    database.run("ALTER TABLE todo_accepted_evidence DROP COLUMN registered_tool; PRAGMA user_version = 15")
    database.run(
      "INSERT INTO todo_symbol_aliases(id, list_id, tool_name, implementation, path, start_line, end_line, observation_id, source_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["legacy-alias", listId, "read_file", "readFile", EVIDENCE_FILE, 169, 220, observationId, sourceHash, "2024-01-01T00:00:00.000Z"]
    )
    fs.writeFileSync(state.databasePath, Buffer.from(database.export()))
    database.close()

    const reopened = new TodoRepository(state.databasePath, wasmPath)
    await reopened.initialize()
    const check = new sql.Database(fs.readFileSync(state.databasePath))
    try {
      assert.equal(check.exec("PRAGMA user_version")[0].values[0][0], 18)
      assert.equal(check.exec("PRAGMA table_info(todo_accepted_evidence)")[0].values.some((row) => row[1] === "registered_tool"), true, "the migration adds registered_tool")
      assert.equal(check.exec("SELECT COUNT(*) FROM todo_symbol_aliases")[0].values[0][0], 1, "the legacy alias row is kept as history")
    } finally {
      check.close()
    }

    const facts = await reopened.listAcceptedEvidence(state.scope, { symbol: "readFile", path: EVIDENCE_FILE })
    assert.equal(facts.length, 1, "the accepted fact and its provenance survive the upgrade")
    assert.equal(facts[0].registeredTool, undefined, "a legacy row is not backfilled from the heuristic alias table")
    assert.deepEqual(await reopened.listSymbolAliases(state.scope), [], "a legacy alias is not an authoritative link")

    const [legacy] = await reviewCriteria([sourceLocation("exact", "`read_file` is defined in src/extension/tools/workspace.ts", "read_file", "registered_tool", EVIDENCE_FILE)], [], currentWorkspace, facts)
    assert.equal(legacy.outcome, "unknown", JSON.stringify(legacy))
    assert.equal(legacy.failureReason, "missing_evidence", "the legacy fact cannot prove the registration, so a fresh read is required")
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("a version-16 database keeps its tool observations as history with no execution owner, and gains the execution index", async () => {
  const state = await fixture([{
    id: "historical-observation",
    criteria: [semantic("historical-observation", "Read the workspace file")]
  }], false)
  try {
    const item = state.items[0]
    const historical = await state.repository.recordToolObservation(state.scope, {
      itemId: item.id,
      toolName: "read_file",
      arguments: { path: "src/history.ts" },
      output: "export const history = true",
      failed: true,
      requestId: "historical-read"
    })

    const sql = await initSqlJs({ locateFile: () => wasmPath })
    const database = new sql.Database(fs.readFileSync(state.databasePath))
    database.run("DROP INDEX IF EXISTS todo_tool_observations_execution; ALTER TABLE todo_tool_observations DROP COLUMN execution_id; PRAGMA user_version = 16")
    fs.writeFileSync(state.databasePath, Buffer.from(database.export()))
    database.close()

    const reopened = new TodoRepository(state.databasePath, wasmPath)
    await reopened.initialize()
    const check = new sql.Database(fs.readFileSync(state.databasePath))
    try {
      assert.equal(check.exec("PRAGMA user_version")[0].values[0][0], 18)
      assert.equal(check.exec("PRAGMA table_info(todo_tool_observations)")[0].values.some((row) => row[1] === "execution_id"), true, "the migration adds execution_id")
      assert.equal(check.exec("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'todo_tool_observations_execution'")[0]?.values.length, 1)
      const [row] = check.exec(`SELECT output, failed, execution_id FROM todo_tool_observations WHERE id = '${historical.id}'`)[0].values
      assert.deepEqual(row, ["export const history = true", 1, null], "the historical row keeps its output and failure, with no execution owner")
    } finally {
      check.close()
    }

    const [kept] = (await reopened.getReviewPackages(state.scope, { includeOpen: true })).flatMap((review) => review.observations).filter((observation) => observation.id === historical.id)
    assert.equal(kept?.failed, true, "the historical failure is still readable through the repository")
    assert.equal(kept?.executionId, undefined)
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("existing version-4 TODO databases gain child proposals and accepted evidence without losing tasks", async () => {
  const state = await fixture([{ id: "kept", criteria: [semantic("kept", "Kept task is inspected")] }])
  try {
    const sql = await initSqlJs({ locateFile: () => wasmPath })
    const database = new sql.Database(fs.readFileSync(state.databasePath))
    database.run("DROP TABLE todo_child_proposals; DROP TABLE todo_accepted_evidence; PRAGMA user_version = 4")
    fs.writeFileSync(state.databasePath, Buffer.from(database.export()))
    database.close()
    const reopened = new TodoRepository(state.databasePath, wasmPath)
    assert.equal((await reopened.getList(state.scope)).items[0].title, state.items[0].title)
    const check = new sql.Database(fs.readFileSync(state.databasePath))
    assert.equal(check.exec("PRAGMA user_version")[0].values[0][0], 18)
    assert.equal(check.exec("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'todo_accepted_evidence'")[0].values[0][0], 1)
    assert.equal(check.exec("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'todo_symbol_aliases'")[0].values[0][0], 1)
    check.close()
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

const WORKSPACE_FILE = "src/extension/tools/workspace.ts"
const workspaceText = Array.from({ length: 850 }, (_, index) => {
  if (index === 168) return "const readFile = (view: WorkspaceView, maxLines = DEFAULT_READ_LINES, sink?: EditSink): Tool => {"
  if (index === 169) return "  const limit = clampReadLines(maxLines)"
  if (index === 170) return "  return {"
  if (index === 171) return "    name: \"read_file\","
  if (index === 172) return "    async run(args: unknown) {"
  if (index === 216) return "      return args"
  if (index === 217) return "    }"
  if (index === 218) return "  }"
  if (index === 219) return "}"
  if (index > 172 && index < 216) return `      const filler${index + 1} = ${index + 1}`
  if (index === 779) return "    const tool = tools.find((candidate) => candidate.name === name)"
  if (index === 799) return "    void tool.run(args)"
  return `const filler${index + 1} = ${index + 1}`
}).join("\n")
const currentWorkspace: CurrentSourceReader = async (file) => (file === WORKSPACE_FILE ? workspaceText : undefined)
type Harness = { repository: TodoRepository; scope: TodoWriteRequest }

/** A read_file observation whose fingerprint covers the whole document it read, as the host records it. */
const observeWorkspaceWindow = async (state: Harness, itemId: string, requestId: string, start: number, end: number, text = workspaceText) => {
  const lines = text.split("\n")
  const hash = await fingerprintContent(text)
  return state.repository.recordToolObservation(state.scope, {
    itemId,
    toolName: "read_file",
    arguments: { path: WORKSPACE_FILE, start_line: String(start), end_line: String(end) },
    output: `read \`${WORKSPACE_FILE}:${start}\` · ${end - start + 1} lines`,
    failed: false,
    requestId,
    evidenceOutput: `${WORKSPACE_FILE} (lines ${start}–${end} of ${lines.length})\ncontent_hash: ${hash}; total_lines: ${lines.length}\n${numbered(start, lines.slice(start - 1, end))}`
  })
}

test("the live read_file sequence reuses one set of observations across tasks without re-reading", async () => {
  const state = await fixture([
    { id: "registration", criteria: [sourceLocation("registration", "`read_file` is registered in `src/extension/tools/workspace.ts`", "read_file", "registered_tool")] },
    { id: "dispatch", criteria: [semantic("dispatch", "`tools.find` dispatches in `src/extension/tools/workspace.ts`")] },
    { id: "validation", criteria: [sourceLocation("validation", "`read_file` argument validation is in `src/extension/tools/workspace.ts`", "read_file", "registered_tool")] }
  ], false)
  try {
    const [registration, dispatch, validation] = state.items
    const registrationRead = await observeWorkspaceWindow(state, registration.id, "read-registration", 160, 181)
    const dispatchRead = await observeWorkspaceWindow(state, registration.id, "read-dispatch", 780, 840)

    await state.repository.claimCompletion(state.scope, { itemId: registration.id, expectedVersion: registration.version, requestId: "claim-registration" })
    const first = reviewCandidates(await state.repository.getReviewPackages(state.scope), registration.id)[0]
    const firstEvaluation = await evaluateTodoReview(state.repository, state.scope, first, async () => responseFor(first, { refs: [registrationRead.id] }), "mock-reviewer", { readCurrentSource: currentWorkspace })
    assert.equal(firstEvaluation.decision, "accept")

    await state.repository.claimCompletion(state.scope, { itemId: dispatch.id, expectedVersion: dispatch.version, requestId: "claim-dispatch" })
    const second = reviewCandidates(await state.repository.getReviewPackages(state.scope), dispatch.id)[0]
    assert.ok(second.retainedEvidence.some((record) => record.observationId === registrationRead.id), "the registration read is retained for the dispatch task")
    const dispatchOutcome = (await reviewReconciliations(second, currentWorkspace))[0]
    assert.equal(dispatchOutcome.outcome, "semantic", JSON.stringify(dispatchOutcome))
    const secondEvaluation = await evaluateTodoReview(state.repository, state.scope, second, async () => responseFor(second, { refs: [dispatchRead.id] }), "mock-reviewer", { readCurrentSource: currentWorkspace })
    assert.equal(secondEvaluation.decision, "accept")

    await state.repository.claimCompletion(state.scope, { itemId: validation.id, expectedVersion: validation.version, requestId: "claim-validation" })
    const third = reviewCandidates(await state.repository.getReviewPackages(state.scope), validation.id)[0]
    const validationOutcome = (await reviewReconciliations(third, currentWorkspace))[0]
    assert.equal(validationOutcome.outcome, "proven", JSON.stringify(validationOutcome))
    assert.ok(validationOutcome.supportingObservationIds.includes(registrationRead.id), "validation reuses the registration read without a new read")
    const thirdEvaluation = await evaluateTodoReview(state.repository, state.scope, third, async () => responseFor(third, { refs: [registrationRead.id] }), "mock-reviewer", { readCurrentSource: currentWorkspace })
    assert.equal(thirdEvaluation.decision, "accept")

    for (const item of [registration, dispatch, validation]) {
      assert.equal((await state.repository.getItem(state.scope, item.id)).item.status, "completed", item.id)
    }
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("a dependency-blocked claim keeps its evidence, skips Feedback, and is reviewed once its dependency verifies", async () => {
  const state = await fixture([
    { id: "registration", criteria: [sourceLocation("registration", "`read_file` is registered in `src/extension/tools/workspace.ts`", "read_file", "registered_tool")] },
    { id: "validation", criteria: [sourceLocation("validation", "`read_file` argument validation is in `src/extension/tools/workspace.ts`", "read_file", "registered_tool")], dependencies: ["registration"] }
  ], false)
  try {
    const [registration, validation] = state.items
    const registrationRead = await observeWorkspaceWindow(state, registration.id, "read-registration", 160, 220)
    const validationRead = await observeWorkspaceWindow(state, validation.id, "read-validation", 160, 220)
    await state.repository.claimCompletion(state.scope, { itemId: validation.id, expectedVersion: validation.version, requestId: "claim-validation-early" })
    assert.equal(reviewCandidates(await state.repository.getReviewPackages(state.scope)).length, 0, "a claim waiting on its prerequisite is not sent to Feedback")
    assert.equal((await state.repository.getItem(state.scope, validation.id)).item.status, "in_review", "the claim is preserved")

    await state.repository.claimCompletion(state.scope, { itemId: registration.id, expectedVersion: registration.version, requestId: "claim-registration" })
    const ready = reviewCandidates(await state.repository.getReviewPackages(state.scope))
    assert.deepEqual(ready.map((review) => review.task.id), [registration.id], "only the independent prerequisite is eligible")
    const registrationReview = ready[0]
    const registrationEvaluation = await evaluateTodoReview(state.repository, state.scope, registrationReview, async () => responseFor(registrationReview, { refs: [registrationRead.id] }), "mock-reviewer", { readCurrentSource: currentWorkspace })
    assert.equal(registrationEvaluation.decision, "accept")

    const waiting = reviewCandidates(await state.repository.getReviewPackages(state.scope))
    assert.deepEqual(waiting.map((review) => review.task.id), [validation.id], "the dependent claim becomes eligible once its prerequisite verifies")
    const validationReview = waiting[0]
    let calls = 0
    const validationEvaluation = await evaluateTodoReview(state.repository, state.scope, validationReview, async () => {
      calls++
      return responseFor(validationReview, { refs: [validationRead.id] })
    }, "mock-reviewer", { readCurrentSource: currentWorkspace })
    assert.equal(validationEvaluation.decision, "accept")
    assert.equal(calls, 0, "a dependent task proven deterministically makes no Feedback call")
    assert.equal((await state.repository.getItem(state.scope, validation.id)).item.status, "completed")
    assert.equal(reviewCandidates(await state.repository.getReviewPackages(state.scope)).length, 0, "a verified task is not reviewed again")
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("a stale source observation is unknown and a failed read proves nothing", async () => {
  const stale = await fixture([{ id: "registration", criteria: [sourceLocation("registration", "`read_file` is registered in `src/extension/tools/workspace.ts`", "read_file", "registered_tool")] }], false)
  const failed = await fixture([{ id: "registration", criteria: [sourceLocation("registration", "`read_file` is registered in `src/extension/tools/workspace.ts`", "read_file", "registered_tool")] }], false)
  try {
    await observeWorkspaceWindow(stale, stale.items[0].id, "stale-read", 160, 181, `${workspaceText}\n// edited after the read`)
    await stale.repository.claimCompletion(stale.scope, { itemId: stale.items[0].id, expectedVersion: stale.items[0].version, requestId: "claim-stale" })
    const staleReview = reviewCandidates(await stale.repository.getReviewPackages(stale.scope))[0]
    const staleOutcome = (await reviewReconciliations(staleReview, currentWorkspace))[0]
    assert.equal(staleOutcome.outcome, "unknown", JSON.stringify(staleOutcome))
    assert.deepEqual(staleOutcome.supportingObservationIds, [])
    assert.match(staleOutcome.missing.join("\n"), /changed after/)

    await failed.repository.recordToolObservation(failed.scope, {
      itemId: failed.items[0].id, toolName: "read_file", arguments: { path: WORKSPACE_FILE }, output: "read failed: file is locked", failed: true, requestId: "failed-read"
    })
    await failed.repository.claimCompletion(failed.scope, { itemId: failed.items[0].id, expectedVersion: failed.items[0].version, requestId: "claim-failed" })
    const failedReview = reviewCandidates(await failed.repository.getReviewPackages(failed.scope))[0]
    const failedOutcome = (await reviewReconciliations(failedReview, currentWorkspace))[0]
    assert.equal(failedOutcome.outcome, "unknown", JSON.stringify(failedOutcome))
    assert.deepEqual(failedOutcome.supportingObservationIds, [])
  } finally {
    fs.rmSync(stale.directory, { recursive: true, force: true })
    fs.rmSync(failed.directory, { recursive: true, force: true })
  }
})

test("the final report separates awaiting, review, and failed states from verified work", async () => {
  const state = await fixture([
    { id: "registration", criteria: [sourceLocation("registration", "`read_file` is registered in `src/extension/tools/workspace.ts`", "read_file", "registered_tool")] },
    { id: "validation", criteria: [sourceLocation("validation", "`read_file` argument validation is in `src/extension/tools/workspace.ts`", "read_file", "registered_tool")], dependencies: ["registration"] }
  ], false)
  try {
    const [registration, validation] = state.items
    await observeWorkspaceWindow(state, registration.id, "read-registration", 160, 181)
    await state.repository.recordToolObservation(state.scope, {
      itemId: validation.id, toolName: "run_command", arguments: runCommandArguments("npx tsc --noEmit"), output: "tsc: 2 errors", failed: true, exitCode: 2, requestId: "failed-compile", executionId: "exec-report"
    })
    await state.repository.claimCompletion(state.scope, { itemId: registration.id, expectedVersion: registration.version, requestId: "claim-registration" })
    await state.repository.claimCompletion(state.scope, { itemId: validation.id, expectedVersion: validation.version, requestId: "claim-validation" })

    const outline = await state.repository.getPlanOutline(state.scope)
    const report = authoritativeExecutionReport(outline!, await state.repository.failedToolOperations(state.scope, "exec-report"))
    assert.match(report, /Verified complete \(0\)/)
    assert.match(report, /Awaiting Feedback review \(1\):\n- \S+ registration/)
    assert.match(report, /Awaiting dependencies \(1\):\n- \S+ validation \(waiting on registration\)/)
    assert.match(report, /Failed tool operations \(1\):\n- run_command \{"command":"npx tsc --noEmit"\} \(exit 2\)/)
    assert.doesNotMatch(report, /No failed tool operations/)
    assert.match(report, /overrides any progress claimed/)
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("host runtime inventory proves tool exposure but never source registration", async () => {
  const exposed = await fixture([{ id: "read_file_exposed", criteria: [semantic("read_file_exposed", "`read_file` is exposed to the model in the outgoing tool inventory")] }])
  const registered = await fixture([{ id: "read_file_registered", criteria: [sourceLocation("read_file_registered", "`read_file` is registered in src/extension/tools/workspace.ts", "read_file", "registered_tool")] }])
  try {
    const inventory = { outgoingToolCount: 1, outgoingTools: ["read_file"] }
    const exposure = await exposed.repository.recordToolObservation(exposed.scope, {
      itemId: exposed.items[0].id, toolName: RUNTIME_INVENTORY_TOOL, arguments: {}, output: JSON.stringify(inventory), evidenceOutput: JSON.stringify(inventory), failed: false, requestId: "inventory-exposed"
    })
    const exposureReview = (await exposed.repository.getReviewPackages(exposed.scope))[0]
    const accepted = await parseEvaluation(responseFor(exposureReview, { refs: [exposure.id] }), exposureReview)
    assert.equal(accepted.criteria[0].status, "passed", `the host inventory establishes exposure: ${JSON.stringify(accepted.problems)}`)

    await registered.repository.recordToolObservation(registered.scope, {
      itemId: registered.items[0].id, toolName: RUNTIME_INVENTORY_TOOL, arguments: {}, output: JSON.stringify(inventory), evidenceOutput: JSON.stringify(inventory), failed: false, requestId: "inventory-registered"
    })
    const registrationReview = (await registered.repository.getReviewPackages(registered.scope))[0]
    const rejected = (await reviewReconciliations(registrationReview, currentWorkspace))[0]
    assert.notEqual(rejected.outcome, "proven", JSON.stringify(rejected))
    assert.deepEqual(rejected.supportingObservationIds, [])
    assert.ok(rejected.missing.length > 0, "the missing source read is named")
  } finally {
    fs.rmSync(exposed.directory, { recursive: true, force: true })
    fs.rmSync(registered.directory, { recursive: true, force: true })
  }
})

test("a successful but unrelated shell command cannot prove tests passed", async () => {
  const state = await fixture([{ id: "fake-test", criteria: [exitZero("npm test")] }])
  try {
    const item = state.items[0]
    const observation = await state.repository.recordToolObservation(state.scope, {
      itemId: item.id, toolName: "run_command", arguments: runCommandArguments("echo done"), output: "done", failed: false, exitCode: 0, requestId: "echo-is-not-test"
    })
    const review = (await state.repository.getReviewPackages(state.scope))[0]
    const result = await parseEvaluation(responseFor(review, { refs: [observation.id] }), review)
    assert.equal(result.decision, "needs_evidence")
    assert.equal((await state.repository.applyEvaluation(state.scope, item.id, review.task.version, result, "echo-unverified")).decision, "needs_evidence")
    assert.equal((await state.repository.getList(state.scope)).items[0].status, "in_review")
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("a plan revision invalidates an evaluation package even when the item version did not change", async () => {
  const state = await fixture([{ id: "revision", criteria: [semantic("revision", "Source inspection is complete")] }])
  try {
    const item = state.items[0]
    const observation = await addObservation(state.repository, state.scope, item.id)
    const review = (await state.repository.getReviewPackages(state.scope))[0]
    const result = await parseEvaluation(responseFor(review, { refs: [observation.id] }), review)
    await state.repository.synchronizeIntentPlan(state.scope, { ...plan([{ id: "revision", criteria: [semantic("revision", "Source inspection is complete")] }]), revision: 2, goal: "Changed goal" }, { prompt: "Changed goal" })
    await assert.rejects(state.repository.applyEvaluation(state.scope, item.id, review.task.version, result, "old-plan-review"), /Intent plan changed/)
    assert.equal((await state.repository.getList(state.scope)).items[0].status, "in_review")
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("analysis-only evaluation may accept a complete answer without file edits", async () => {
  const state = await fixture([{ id: "explain", criteria: [semantic("explain", "The design tradeoffs are explained")] }])
  try {
    const item = state.items[0]
    const observation = await addObservation(state.repository, state.scope, item.id)
    const review = (await state.repository.getReviewPackages(state.scope))[0]
    const evaluation = await parseEvaluation(responseFor(review, { refs: [observation.id] }), review, new Date().toISOString())
    assert.equal(evaluation.decision, "accept")
    const input = todoReviewInput(review, undefined, "Here is the analysis")
    assert.match(input, /implementerFinalResponseUntrusted/)
    assert.match(input, /Here is the analysis/)
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("Cerebras-shaped malformed criteria are rejected with exact field diagnostics", async () => {
  const state = await fixture([
    { id: "field-check", criteria: [semantic("field-check", "The validation rule is documented")] },
    { id: "field-order", criteria: [semantic("field-order", "The schema version is documented")], dependencies: ["field-check"] }
  ], false)
  try {
    const item = state.items[0]
    await state.repository.updateItem(state.scope, {
      itemId: item.id,
      expectedVersion: item.version,
      patch: { status: "in_review" },
      actor: "model",
      requestId: "criteria-review"
    })
    const review = (await state.repository.getReviewPackages(state.scope))[0]
    const semanticIds = review.criteria.map((criterion) => criterion.id)
    assert.deepEqual(semanticIds, ["field-check"])
    assert.deepEqual(JSON.parse(todoReviewInput(review)).semanticCriteria.map((criterion: { criterionId: string }) => criterion.criterionId), semanticIds)
    const textInsteadOfCriterion = JSON.parse(responseFor(review))
    textInsteadOfCriterion.criteria = [{
      text: "The validation rule is documented",
      status: "passed",
      evidenceRefs: []
    }]
    await assert.rejects(parseEvaluation(JSON.stringify(textInsteadOfCriterion), review), (error: unknown) => {
      return error instanceof TodoEvaluationValidationError && error.code === "missing_field" && error.field === "criteria[0].criterionId"
    })

    const droppedCriterionAndStringInstructions = JSON.parse(responseFor(review))
    droppedCriterionAndStringInstructions.criteria = [{
      status: "passed",
      evidenceRefs: []
    }]
    droppedCriterionAndStringInstructions.correctiveInstructions = "Fix the schema"
    await assert.rejects(parseEvaluation(JSON.stringify(droppedCriterionAndStringInstructions), review), (error: unknown) => {
      return error instanceof TodoEvaluationValidationError && error.field === "criteria[0].criterionId"
    })

    const unknownCriterion = JSON.parse(responseFor(review))
    unknownCriterion.criteria[0].criterionId = "not-a-semantic-criterion"
    await assert.rejects(parseEvaluation(JSON.stringify(unknownCriterion), review), (error: unknown) => {
      return error instanceof TodoEvaluationValidationError && error.field === "criteria[0].criterionId"
    })

    const stringInstructions = JSON.parse(responseFor(review))
    stringInstructions.correctiveInstructions = "Fix the schema"
    await assert.rejects(parseEvaluation(JSON.stringify(stringInstructions), review), (error: unknown) => {
      return error instanceof TodoEvaluationValidationError && error.field === "correctiveInstructions"
    })

    const valid = await parseEvaluation(responseFor(review), review)
    assert.deepEqual(valid.criteria.map((criterion) => criterion.criterionId), semanticIds)
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("an early file read remains evaluator-visible across later tool calls and automatic continuation", async () => {
  const state = await fixture([{
    id: "retain-evidence",
    criteria: [semantic("retain-evidence", "Inspect src/webview/styles/todo-panel.module.css and confirm its styling")]
  }], false)
  try {
    const item = state.items[0]
    const initial = await state.repository.recordToolObservation(state.scope, {
      itemId: item.id,
      toolName: "read_file",
      arguments: { path: "src/webview/styles/todo-panel.module.css" },
      output: ".todoPanel { display: grid; }",
      failed: false,
      requestId: "early-css-read"
    })

    const firstReviewItem = await state.repository.updateItem(state.scope, {
      itemId: item.id,
      expectedVersion: item.version,
      patch: { status: "in_review" },
      actor: "model",
      requestId: "first-turn-review"
    })
    const firstReview = (await state.repository.getReviewPackages(state.scope))[0]
    const firstDecision = await parseEvaluation(responseFor(firstReview, {
      decision: "needs_evidence",
      status: "unverified",
      problems: ["Continue with the remaining evidence."]
    }), firstReview)
    await state.repository.applyEvaluation(state.scope, item.id, firstReviewItem.version, firstDecision, "first-turn-decision")

    const inProgress = await state.repository.updateItem(state.scope, {
      itemId: item.id,
      expectedVersion: (await state.repository.getList(state.scope)).items[0].version,
      patch: { status: "in_progress" },
      actor: "model",
      requestId: "automatic-continuation"
    })
    const active = await state.repository.getActiveIntentContext(state.scope)
    assert.equal(active?.task.id, item.id)
    const continuation = continuationContext({
      goal: active!.goal,
      constraints: active!.constraints,
      task: active!.task.title,
      criteria: active!.criteria.map((criterion) => criterion.description),
      feedback: ["Continue after independent evaluation."],
      verifiedObservations: (active!.observations ?? []).map((observation) =>
        `${observation.toolName} ${observation.arguments.path ?? ""}: ${observation.output}`
      ),
      finalResponse: "The first turn is complete."
    })
    assert.match(continuation, /todo-panel\.module\.css/)

    for (let index = 0; index < 105; index++) {
      await state.repository.recordToolObservation(state.scope, {
        itemId: item.id,
        toolName: "read_file",
        arguments: { path: `src/late-${index}.ts` },
        output: `Late observation ${index}`,
        failed: false,
        requestId: `late-read-${index}`
      })
    }
    for (const [toolName, args, output] of [
      ["edit_file", { path: "src/changed.ts" }, "Applied a targeted edit."],
      ["diagnostics", { file: "src/changed.ts" }, "No new diagnostics."],
      ["run_command", runCommandArguments("npm test"), "Tests passed."],
      ["automatic_edit_recovery", { fileVerified: "true" }, "Rollback restored the file."]
    ] as const) {
      await state.repository.recordToolObservation(state.scope, {
        itemId: item.id,
        toolName,
        arguments: args,
        output,
        failed: false,
        exitCode: toolName === "run_command" ? 0 : undefined,
        requestId: `later-${toolName}`
      })
    }
    await state.repository.updateItem(state.scope, {
      itemId: item.id,
      expectedVersion: inProgress.version,
      patch: { status: "in_review" },
      actor: "model",
      requestId: "second-turn-review"
    })
    const review = (await state.repository.getReviewPackages(state.scope))[0]
    assert.ok(review.observations.some((observation) => observation.id === initial.id))
    const evaluatorInput = JSON.parse(todoReviewInput(review))
    assert.ok(evaluatorInput.trustedTwinnyToolObservations.some((observation: { id: string }) => observation.id === initial.id))
    assert.ok(evaluatorInput.trustedTwinnyToolObservations.some((observation: { output: string }) => observation.output.includes(".todoPanel")))
    for (const toolName of ["edit_file", "diagnostics", "run_command", "automatic_edit_recovery"]) {
      assert.ok(evaluatorInput.trustedTwinnyToolObservations.some((observation: { toolName: string }) => observation.toolName === toolName), `${toolName} evidence should be retained`)
    }
    const suppliedIds = new Set(evaluatorInput.trustedTwinnyToolObservations.map((observation: { id: string }) => observation.id))
    const omittedObservation = review.observations.find((observation) => !suppliedIds.has(observation.id))
    assert.ok(omittedObservation, "the evaluator payload remains bounded")
    await assert.rejects(parseEvaluation(responseFor(review, { refs: [omittedObservation!.id] }), review), (error: unknown) =>
      error instanceof TodoEvaluationValidationError && error.field === "criteria[0].evidenceRefs")
    const evaluation = await parseEvaluation(responseFor(review, { refs: [initial.id] }), review)
    assert.equal(evaluation.criteria[0].evidenceRefs[0], initial.id)
    const fabricated = { ...evaluation, criteria: evaluation.criteria.map((criterion) => ({ ...criterion, evidenceRefs: ["fabricated-observation-id"] })) }
    await assert.rejects(
      state.repository.applyEvaluation(state.scope, item.id, review.task.version, fabricated, "fabricated-reference"),
      /criteria\[0\]\.evidenceRefs references unknown evidence ID/
    )
    assert.equal((await state.repository.getEvaluationHistory(state.scope, item.id)).length, 1)
    const persisted = await evaluateTodoReview(state.repository, state.scope, review,
      async () => responseFor(review, { refs: [initial.id] }), "mock-reviewer")
    assert.equal(persisted.decision, "accept")
    assert.equal((await state.repository.getList(state.scope)).items[0].status, "completed")
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("the evaluator payload states what it omitted and keeps the newest and verifier-cited records", async () => {
  const state = await fixture([{
    id: "bounded-evidence",
    criteria: [semantic("bounded-evidence", "Read the workspace files and summarize them")]
  }], false)
  try {
    const item = state.items[0]
    await state.repository.updateItem(state.scope, {
      itemId: item.id,
      expectedVersion: item.version,
      patch: { status: "in_progress" },
      actor: "model",
      requestId: "bounded-start"
    })
    const records: string[] = []
    for (let index = 0; index < 85; index += 1) {
      const observation = await state.repository.recordToolObservation(state.scope, {
        itemId: item.id,
        toolName: "read_file",
        arguments: { path: `src/file-${index}.ts` },
        output: `contents ${index}`,
        failed: false,
        requestId: `bounded-read-${index}`
      })
      records.push(observation.id)
    }
    const version = (await state.repository.getList(state.scope)).items[0].version
    await state.repository.updateItem(state.scope, {
      itemId: item.id,
      expectedVersion: version,
      patch: { status: "in_review" },
      actor: "model",
      requestId: "bounded-review"
    })
    const review = (await state.repository.getReviewPackages(state.scope))[0]
    assert.equal(review.observations.length, 85)

    const input = JSON.parse(todoReviewInput(review))
    const shown = new Set(input.trustedTwinnyToolObservations.map((entry: { id: string }) => entry.id))
    assert.equal(input.trustedTwinnyToolObservations.length, 80)
    assert.equal(input.projectionOmissions.trustedTwinnyToolObservations, 5, "the payload states how many records it left out")
    assert.equal(input.projectionOmissions.modelAuthoredEvidenceNotes, 0)
    assert.equal(shown.has(records[84]), true, "the newest read in the category is kept")
    assert.equal(shown.has(records[0]), false, "the oldest read in the category is the one left out")

    // A record the verifier cites is shown even when it would otherwise be omitted, so the verdict can be checked against it.
    const cited: TodoCriterionReconciliation = {
      outcome: "semantic",
      criterionId: review.criteria[0].id,
      supportingObservationIds: [records[0]],
      missing: [],
      version: 1
    }
    const pinned = JSON.parse(todoReviewInput(review, undefined, undefined, [cited]))
    assert.equal(pinned.trustedTwinnyToolObservations.some((entry: { id: string }) => entry.id === records[0]), true)
    assert.equal(pinned.projectionOmissions.trustedTwinnyToolObservations, 5)

    const accepted = parseTodoEvaluation(responseFor(review, { refs: [records[0]] }), review, "mock-reviewer", new Date().toISOString(), [cited])
    assert.equal(accepted.criteria[0].evidenceRefs[0], records[0], "a shown, cited record is a valid citation")
    assert.throws(
      () => parseTodoEvaluation(responseFor(review, { refs: [records[1]] }), review, "mock-reviewer", new Date().toISOString(), [cited]),
      (error: unknown) => error instanceof TodoEvaluationValidationError && error.field === "criteria[0].evidenceRefs",
      "an omitted record cannot be cited"
    )
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("a continuation names the next task and carries each unresolved criterion's established and missing facts", () => {
  const text = continuationContext({
    goal: "Investigate read_file",
    constraints: [],
    task: "item-2: Trace dispatch",
    criteria: ["`tool.run(` is called from the dispatch path"],
    unresolvedEvidence: ["`tool.run(` is called from the dispatch path — partial; established by [obs-dispatch]; missing: a successful invocation of read_file"],
    feedback: [],
    finalResponse: "Done."
  })
  assert.match(text, /Current unresolved task: item-2: Trace dispatch/)
  assert.match(text, /Evidence for unresolved criteria:\n- `tool\.run\(` is called from the dispatch path — partial; established by \[obs-dispatch\]; missing: a successful invocation of read_file/)
  const withoutEvidence = continuationContext({ goal: "g", constraints: [], task: "t", criteria: [], feedback: [], finalResponse: "" })
  assert.doesNotMatch(withoutEvidence, /Evidence for unresolved criteria/)
})

test("an implementation cannot be accepted from prose without verified workspace changes", async () => {
  const state = await fixture([{ id: "implement", criteria: [semantic("implement", "The requested component is updated"), { id: "implement-mutation", description: "The requested component is updated in the workspace", verification: { kind: "workspace_mutation" } }] }])
  try {
    const item = state.items[0]
    const observation = await addObservation(state.repository, state.scope, item.id)
    const review = (await state.repository.getReviewPackages(state.scope))[0]
    const evaluation = await evaluateTodoReview(state.repository, state.scope, review,
      async () => responseFor(review, { refs: [observation.id] }), "mock-reviewer",
      { hasVerifiedFileChanges: false })
    assert.equal(evaluation.decision, "needs_evidence")
    assert.match(evaluation.problems.join(" "), /No verified workspace file changes|file-mutation observation/)
    assert.equal((await state.repository.getList(state.scope)).items[0].status, "in_review")
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})


test("evidence recorded while a claim is in review keeps the claim's version and stays reviewable", async () => {
  const state = await fixture([{ id: "docs", criteria: [semantic("docs", "The docs describe the feature")] }], false)
  try {
    const item = state.items[0]
    await state.repository.claimCompletion(state.scope, { itemId: item.id, expectedVersion: item.version, requestId: "claim-docs" })
    const claimed = (await state.repository.getItem(state.scope, item.id)).item
    assert.equal(claimed.status, "in_review")
    await addObservation(state.repository, state.scope, item.id)
    const after = (await state.repository.getItem(state.scope, item.id)).item
    assert.equal(after.version, claimed.version, "unrelated evidence does not make an in-flight review stale")
    assert.deepEqual(reviewCandidates(await state.repository.getReviewPackages(state.scope)).map((review) => review.task.id), [item.id])
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("a task that needs evidence is reopened only by evidence recorded after its evaluation", async () => {
  const state = await fixture([{ id: "edit", criteria: [{ id: "edit", description: "The component is updated in the workspace", verification: { kind: "workspace_mutation" } }] }], false)
  try {
    const item = state.items[0]
    await state.repository.claimCompletion(state.scope, { itemId: item.id, expectedVersion: item.version, requestId: "claim-edit" })
    const readOnly = await addObservation(state.repository, state.scope, item.id)
    const review = (await state.repository.getReviewPackages(state.scope))[0]
    const first = await evaluateTodoReview(state.repository, state.scope, review,
      async () => responseFor(review, { refs: [readOnly.id] }), "mock-reviewer",
      { hasVerifiedFileChanges: taskHasVerifiedMutation(review) })
    assert.equal(first.decision, "needs_evidence")
    assert.deepEqual(reviewCandidates(await state.repository.getReviewPackages(state.scope)), [], "an unanswered wait is not re-sent to Feedback")

    await addObservation(state.repository, state.scope, item.id, "edit_file")
    const reopened = reviewCandidates(await state.repository.getReviewPackages(state.scope))
    assert.deepEqual(reopened.map((candidate) => candidate.task.id), [item.id], "evidence after the evaluation reopens the review")
    assert.equal(taskHasVerifiedMutation(reopened[0]), true)
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("a file change recorded for a sibling task, or a failed edit, cannot satisfy another task's workspace mutation", async () => {
  const mutation = (id: string) => ({ id, criteria: [{ id, description: `${id} is updated in the workspace`, verification: { kind: "workspace_mutation" as const } }] })
  const state = await fixture([mutation("writer"), mutation("other")], false)
  try {
    const [writer, other] = state.items
    await addObservation(state.repository, state.scope, writer.id, "edit_file")
    await state.repository.recordToolObservation(state.scope, {
      itemId: other.id,
      toolName: "edit_file",
      arguments: { path: "src/fixture.ts" },
      output: "No match found for the requested text.",
      failed: true,
      requestId: "failed-edit-other"
    })
    await state.repository.claimCompletion(state.scope, { itemId: writer.id, expectedVersion: writer.version, requestId: "claim-writer" })
    await state.repository.claimCompletion(state.scope, { itemId: other.id, expectedVersion: other.version, requestId: "claim-other" })
    const reviews = await state.repository.getReviewPackages(state.scope)
    const writerReview = reviews.find((review) => review.task.id === writer.id)
    const otherReview = reviews.find((review) => review.task.id === other.id)
    assert.ok(writerReview && otherReview)
    assert.equal(taskHasVerifiedMutation(writerReview), true, "the task's own successful edit counts")
    assert.equal(taskHasVerifiedMutation(otherReview), false, "a sibling's edit and a failed edit do not count")
    const evaluation = await evaluateTodoReview(state.repository, state.scope, otherReview,
      async () => responseFor(otherReview, { refs: [] }), "mock-reviewer",
      { hasVerifiedFileChanges: taskHasVerifiedMutation(otherReview) })
    assert.equal(evaluation.decision, "needs_evidence")
    assert.equal((await state.repository.getItem(state.scope, other.id)).item.status, "in_review")
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("a pending review and its claim survive reopening the repository", async () => {
  const state = await fixture([{ id: "docs", criteria: [semantic("docs", "The docs describe the feature")] }], false)
  try {
    const item = state.items[0]
    await state.repository.claimCompletion(state.scope, { itemId: item.id, expectedVersion: item.version, requestId: "claim-docs" })
    const reopened = new TodoRepository(state.databasePath, wasmPath)
    assert.equal((await reopened.getItem(state.scope, item.id)).item.status, "in_review")
    assert.deepEqual(reviewCandidates(await reopened.getReviewPackages(state.scope)).map((review) => review.task.id), [item.id])
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("a repeated completion claim is idempotent and leaves one reviewable claim", async () => {
  const state = await fixture([{ id: "docs", criteria: [semantic("docs", "The docs describe the feature")] }], false)
  try {
    const item = state.items[0]
    const first = await state.repository.claimCompletion(state.scope, { itemId: item.id, expectedVersion: item.version, requestId: "claim-docs" })
    assert.equal(first.disposition, "accepted")
    const afterFirst = (await state.repository.getItem(state.scope, item.id)).item

    const replay = await state.repository.claimCompletion(state.scope, { itemId: item.id, expectedVersion: item.version, requestId: "claim-docs" })
    assert.equal(replay.disposition, "accepted", "the same request replays its stored result")
    assert.equal((await state.repository.getItem(state.scope, item.id)).item.version, afterFirst.version, "a replay does not advance the version")

    const duplicate = await state.repository.claimCompletion(state.scope, { itemId: item.id, expectedVersion: item.version, requestId: "claim-docs-again" })
    assert.equal(duplicate.disposition, "already_submitted", "a new claim while review is pending does not create a second review")
    assert.equal((await state.repository.getItem(state.scope, item.id)).item.version, afterFirst.version)
    assert.equal(reviewCandidates(await state.repository.getReviewPackages(state.scope)).length, 1)
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("a prerequisite's verification releases every branching dependent, and neither dependent is reviewed early", async () => {
  const state = await fixture([
    { id: "registration", criteria: [sourceLocation("registration", "`read_file` is registered in `src/extension/tools/workspace.ts`", "read_file", "registered_tool")] },
    { id: "validation", criteria: [semantic("validation", "Validation rejects an empty path")], dependencies: ["registration"] },
    { id: "docs", criteria: [semantic("docs", "The read_file tool is documented")], dependencies: ["registration"] }
  ], false)
  try {
    const [registration, validation, docs] = state.items
    const registrationRead = await observeWorkspaceWindow(state, registration.id, "read-registration", 160, 220)
    await state.repository.claimCompletion(state.scope, { itemId: validation.id, expectedVersion: validation.version, requestId: "claim-validation" })
    await state.repository.claimCompletion(state.scope, { itemId: docs.id, expectedVersion: docs.version, requestId: "claim-docs" })
    await state.repository.claimCompletion(state.scope, { itemId: registration.id, expectedVersion: registration.version, requestId: "claim-registration" })
    assert.deepEqual(reviewCandidates(await state.repository.getReviewPackages(state.scope)).map((review) => review.task.id), [registration.id], "dependents wait on the prerequisite")

    const review = reviewCandidates(await state.repository.getReviewPackages(state.scope))[0]
    const evaluation = await evaluateTodoReview(state.repository, state.scope, review, async () => responseFor(review, { refs: [registrationRead.id] }), "mock-reviewer", { readCurrentSource: currentWorkspace })
    assert.equal(evaluation.decision, "accept")

    const released = reviewCandidates(await state.repository.getReviewPackages(state.scope)).map((candidate) => candidate.task.id).sort()
    assert.deepEqual(released, [validation.id, docs.id].sort(), "both dependents become eligible exactly once")
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("evaluator fixtures validate schema, canonical plan IDs, and wrapped JSON independently", async () => {
  const state = await fixture([{ id: "task-1", criteria: [semantic("task-1", "Source paths are documented")] }])
  try {
    const review = (await state.repository.getReviewPackages(state.scope))[0]
    const valid = responseFor(review)
    assert.equal((await parseEvaluation(valid, review)).taskId, review.planTaskId)
    assert.equal(todoReviewInput(review).includes("\"taskId\":\"task-1\""), true)
    assert.equal(todoReviewInput(review).includes("\"todoId\":\"" + review.task.id + "\""), true)
    assert.equal((await parseEvaluation("Assessment follows.\n\x60\x60\x60json\n" + valid + "\n\x60\x60\x60\nEnd.", review)).taskId, review.planTaskId)

    const wrongId = JSON.parse(valid)
    wrongId.taskId = review.task.id
    await assert.rejects(parseEvaluation(JSON.stringify(wrongId), review), (error: unknown) => error instanceof TodoEvaluationValidationError && error.code === "task_id" && error.expected === review.planTaskId && error.received === review.task.id)

    const missingVersion = JSON.parse(valid)
    delete missingVersion.schemaVersion
    await assert.rejects(parseEvaluation(JSON.stringify(missingVersion), review), (error: unknown) => error instanceof TodoEvaluationValidationError && error.code === "missing_field")
    const wrongVersion = JSON.parse(valid)
    wrongVersion.schemaVersion = 2
    await assert.rejects(parseEvaluation(JSON.stringify(wrongVersion), review), (error: unknown) => error instanceof TodoEvaluationValidationError && error.code === "schema_version")
    const unknownDecision = JSON.parse(valid)
    unknownDecision.decision = "approve"
    await assert.rejects(parseEvaluation(JSON.stringify(unknownDecision), review), (error: unknown) => error instanceof TodoEvaluationValidationError && error.code === "decision")
    await assert.rejects(parseEvaluation("{broken", review), (error: unknown) => error instanceof TodoEvaluationValidationError && error.code === "malformed_json")
    await assert.rejects(parseEvaluation("", review), (error: unknown) => error instanceof TodoEvaluationValidationError && error.code === "empty_response")
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("one malformed evaluator response can be corrected once and only the validated result persists", async () => {
  const state = await fixture([{ id: "task-retry", criteria: [semantic("task-retry", "Source paths are documented")] }])
  try {
    const item = state.items[0]
    const observation = await addObservation(state.repository, state.scope, item.id)
    const review = (await state.repository.getReviewPackages(state.scope))[0]
    const wrong = JSON.parse(responseFor(review, { refs: [observation.id] }))
    wrong.taskId = review.task.id
    let calls = 0
    const evaluation = await evaluateTodoReview(state.repository, state.scope, review, async (correction) => {
      calls++
      if (calls === 1) {
        assert.equal(correction, undefined)
        return JSON.stringify(wrong)
      }
      assert.match(correction ?? "", /canonical taskId/)
      return responseFor(review, { refs: [observation.id] })
    }, "mock-reviewer")
    assert.equal(calls, 2)
    assert.equal(evaluation.decision, "accept")
    assert.equal((await state.repository.getEvaluationHistory(state.scope, item.id)).length, 1)
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("failed correction and provider failures are never persisted or accepted", async () => {
  const malformedState = await fixture([{ id: "task-bad-retry", criteria: [semantic("task-bad-retry", "Source paths are documented")] }])
  try {
    const review = (await malformedState.repository.getReviewPackages(malformedState.scope))[0]
    let calls = 0
    await assert.rejects(evaluateTodoReview(malformedState.repository, malformedState.scope, review, async () => {
      calls++
      return "not JSON"
    }, "mock-reviewer"), (error: unknown) => error instanceof TodoEvaluationValidationError && error.code === "malformed_json")
    assert.equal(calls, 2)
    assert.equal((await malformedState.repository.getEvaluationHistory(malformedState.scope, review.task.id)).length, 0)
  } finally {
    fs.rmSync(malformedState.directory, { recursive: true, force: true })
  }

  const providerState = await fixture([{ id: "task-provider-error", criteria: [semantic("task-provider-error", "Source paths are documented")] }])
  try {
    const review = (await providerState.repository.getReviewPackages(providerState.scope))[0]
    let calls = 0
    await assert.rejects(evaluateTodoReview(providerState.repository, providerState.scope, review, async () => {
      calls++
      throw new Error("provider unavailable")
    }, "mock-reviewer"), /provider unavailable/)
    assert.equal(calls, 1, "provider errors are not malformed-output retries")
    assert.equal((await providerState.repository.getEvaluationHistory(providerState.scope, review.task.id)).length, 0)
  } finally {
    fs.rmSync(providerState.directory, { recursive: true, force: true })
  }
})


test("accepted source inspection persists and unlocks implementation without accepting the goal", async () => {
  const state = await fixture([
    { id: "task-1", criteria: [semantic("task-1", "TODO panel file paths are documented")] },
    { id: "task-2", criteria: [{ id: "task-2", description: "Compact collapsible cards are implemented", verification: { kind: "workspace_mutation" } }], dependencies: ["task-1"] }
  ], false)
  try {
    const controller = new ExecutionReconciliationController()
    const inspection = await state.repository.getActiveIntentContext(state.scope)
    assert.equal(inspection?.planTaskId, "task-1")
    assert.equal(inspection?.task.status, "pending")
    const inReview = await state.repository.updateItem(state.scope, {
      itemId: inspection!.task.id,
      expectedVersion: inspection!.task.version,
      patch: { status: "in_review" },
      actor: "model",
      requestId: "inspection-in-review"
    })
    const observation = await addObservation(state.repository, state.scope, inReview.id)
    const review = (await state.repository.getReviewPackages(state.scope)).find((candidate) => candidate.task.id === inReview.id)!
    const evaluation = await evaluateTodoReview(state.repository, state.scope, review,
      async () => responseFor(review, { refs: [observation.id] }), "mock-reviewer", { hasVerifiedFileChanges: false })
    assert.equal(evaluation.decision, "accept", "an inspection task can complete without editing source files")
    assert.equal(taskRequiresWorkspaceChanges(review.criteria), false)
    assert.equal((await state.repository.getList({ ...state.scope, includeCompleted: true })).items.find((item) => item.id === inReview.id)?.status, "completed")

    const implementation = await state.repository.getActiveIntentContext(state.scope)
    assert.equal(implementation?.planTaskId, "task-2", "the completed inspection dependency unlocks implementation")
    assert.equal(taskRequiresWorkspaceChanges(implementation!.criteria), true)
    assert.equal(controller.advanceAcceptedTask("task-1:accepted").state, "continue")
    const continuation = continuationContext({
      goal: inspection!.goal,
      constraints: inspection!.constraints,
      task: implementation!.task.title,
      criteria: implementation!.criteria.map((criterion) => criterion.description),
      feedback: ["The inspection task was accepted. Implement the outstanding feature."],
      verifiedObservations: ["read_file src/webview/todo-panel.tsx: identified the existing task card handler"],
      finalResponse: "The files are inspected."
    })
    assert.match(continuation, /Current unresolved task: task-2/)
    assert.match(continuation, /identified the existing task card handler/)
    assert.equal(controller.state, "continue", "task acceptance does not declare goal-level completion")
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

const recordTool = (repository: TodoRepository, scope: TodoWriteRequest, itemId: string, toolName: string, failed = false) =>
  repository.recordToolObservation(scope, {
    itemId,
    toolName,
    arguments: { path: "twinny_index_smoke_test.ts" },
    output: failed ? "Tool failed." : "Tool returned the expected result.",
    failed,
    requestId: `mutation-${itemId}-${toolName}-${failed}`
  })

test("file-mutation criteria require a successful matching mutation tool, not any read", async () => {
  const cases: { description: string; operation: WorkspaceMutationOperation; tool: string; expectAccept: boolean }[] = [
    { description: "Create twinny_index_smoke_test.ts with the ALPHA identifier", operation: "create", tool: "read_file", expectAccept: false },
    { description: "Create twinny_index_smoke_test.ts with the ALPHA identifier", operation: "create", tool: "create_file", expectAccept: true },
    { description: "Replace ALPHA with BETA in twinny_index_smoke_test.ts", operation: "edit", tool: "search_workspace", expectAccept: false },
    { description: "Replace ALPHA with BETA in twinny_index_smoke_test.ts", operation: "edit", tool: "edit_lines", expectAccept: true },
    { description: "Delete twinny_index_smoke_test.ts from the workspace", operation: "delete", tool: "edit_lines", expectAccept: false },
    { description: "Delete twinny_index_smoke_test.ts from the workspace", operation: "delete", tool: "delete_file", expectAccept: true }
  ]
  for (const example of cases) {
    const state = await fixture([{ id: "mutation", criteria: [{ id: "mutation", description: example.description, verification: { kind: "workspace_mutation", operation: example.operation } }] }])
    try {
      const observation = await recordTool(state.repository, state.scope, state.items[0].id, example.tool)
      const review = (await state.repository.getReviewPackages(state.scope))[0]
      const evaluation = await evaluateTodoReview(state.repository, state.scope, review,
        async () => responseFor(review, { refs: [observation.id] }), "mock-reviewer", { hasVerifiedFileChanges: example.expectAccept })
      assert.equal(evaluation.decision === "accept", example.expectAccept, `${example.tool} for "${example.description}"`)
      if (!example.expectAccept) {
        assert.ok(evaluation.problems.some((problem) => problem.includes("file-mutation observation")), "missing mutation problem is explained")
        assert.equal((await state.repository.getList(state.scope)).items[0].status !== "completed", true)
      }
    } finally {
      fs.rmSync(state.directory, { recursive: true, force: true })
    }
  }
})

test("move and rename tools count as file mutations, and read-only navigation never does", async () => {
  const cases: { description: string; operation?: WorkspaceMutationOperation; tool: string; expectAccept: boolean }[] = [
    { description: "Move twinny_index_smoke_test.ts into the tests folder", tool: "move_file", expectAccept: true },
    { description: "Rename the ALPHA symbol to BETA across the workspace", tool: "rename_symbol", expectAccept: true },
    { description: "Rename the ALPHA symbol to BETA across the workspace", operation: "edit", tool: "rename_symbol", expectAccept: true },
    { description: "Rename the ALPHA symbol to BETA across the workspace", operation: "edit", tool: "find_references", expectAccept: false },
    { description: "Move twinny_index_smoke_test.ts into the tests folder", tool: "find_files", expectAccept: false }
  ]
  for (const example of cases) {
    const verification: { kind: "workspace_mutation"; operation?: WorkspaceMutationOperation } = example.operation
      ? { kind: "workspace_mutation", operation: example.operation }
      : { kind: "workspace_mutation" }
    const state = await fixture([{ id: "mutation", criteria: [{ id: "mutation", description: example.description, verification }] }])
    try {
      const observation = await recordTool(state.repository, state.scope, state.items[0].id, example.tool)
      const review = (await state.repository.getReviewPackages(state.scope))[0]
      const evaluation = await evaluateTodoReview(state.repository, state.scope, review,
        async () => responseFor(review, { refs: [observation.id] }), "mock-reviewer", { hasVerifiedFileChanges: example.expectAccept })
      assert.equal(evaluation.decision === "accept", example.expectAccept, `${example.tool} for "${example.description}"`)
    } finally {
      fs.rmSync(state.directory, { recursive: true, force: true })
    }
  }
})


test("a failed mutation observation never supports a file-change claim", async () => {
  const state = await fixture([{ id: "create", criteria: [{ id: "create", description: "Create twinny_index_smoke_test.ts", verification: { kind: "workspace_mutation" } }] }])
  try {
    const failed = await recordTool(state.repository, state.scope, state.items[0].id, "create_file", true)
    const review = (await state.repository.getReviewPackages(state.scope))[0]
    const result = await parseEvaluation(responseFor(review, { refs: [failed.id] }), review)
    assert.notEqual(result.decision, "accept")
    assert.equal(result.criteria[0].status, "unverified")
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("workspace-index regression: claimed create, edit, and delete without tool execution stays unverified", async () => {
  const state = await fixture([{ id: "index-smoke", criteria: [{ id: "index-smoke", description: "Create twinny_index_smoke_test.ts, replace ALPHA with BETA, then delete it", verification: { kind: "workspace_mutation" } }] }])
  try {
    const reads = await Promise.all([
      recordTool(state.repository, state.scope, state.items[0].id, "read_file"),
      recordTool(state.repository, state.scope, state.items[0].id, "search_workspace"),
      recordTool(state.repository, state.scope, state.items[0].id, "find_files")
    ])
    const review = (await state.repository.getReviewPackages(state.scope))[0]
    const evaluation = await evaluateTodoReview(state.repository, state.scope, review,
      async () => responseFor(review, { refs: reads.map((observation) => observation.id) }), "mock-reviewer")
    assert.notEqual(evaluation.decision, "accept")
    const persisted = (await state.repository.getList(state.scope)).items[0]
    assert.notEqual(persisted.verification, "passed")
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("the native TODO tools are offered to the agent by default and dispatch to the repository", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-todo-tools-"))
  try {
    const scope = { projectFingerprint: workspaceProjectFingerprint(["file:///todo-tools"]), conversationId: "todo-tools-chat", writer: "todo-tools-chat" }
    const repository = new TodoRepository(path.join(directory, "twinny-state.sqlite"), wasmPath)
    const workspace = todoWorkspaceTools(repository, scope, () => undefined)
    const names = workspace.tools.map((tool) => tool.name)
    for (const name of ["twinny_todo_list", "twinny_todo_get", "twinny_todo_create", "twinny_todo_update", "twinny_todo_evidence"]) {
      assert.ok(names.includes(name), `${name} is missing from the offered tools`)
    }
    assert.ok(!names.includes("twinny_todo_complete"), "the model must not be offered a tool that completes TODOs")
    for (const tool of workspace.tools) {
      assert.ok(tool.description.length > 0, `${tool.name} needs a description for its schema`)
    }
    assert.equal(resolveAgentToolSelection(undefined, workspace.tools, []).native.length, workspace.tools.length)

    const created = await workspace.run({ name: "twinny_todo_list", args: {} } as never, undefined)
    assert.equal(created.failed, undefined)
    assert.match(created.output, /"items":\[\]/)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("feedback plans with TODO bookkeeping tasks are rejected, while distinct user work is accepted", () => {
  const plan = {
    planId: "plan-bookkeeping",
    version: 1,
    revision: 1,
    goal: "Index the workspace search",
    constraints: [],
    tasks: [
      { id: "init", title: "Initialize investigation TODOs", description: "Create the TODO entries for this plan", criteria: [{ id: "todos", description: "TODOs exist", verification: { kind: "semantic_review" } }], dependencies: [] },
      { id: "locate", title: "Locate read_file definition", description: "Find the native tool", criteria: [{ id: "path", description: "Path identified", verification: { kind: "semantic_review" } }], dependencies: ["init"] },
      { id: "task-list-ui", title: "Add task list component", description: "Render the task list panel", criteria: [{ id: "panel", description: "Panel renders", verification: { kind: "semantic_review" } }], dependencies: ["locate"] }
    ]
  }
  const rejected = parseFeedbackPlanResponse(JSON.stringify({ track: true, plan }))
  assert.ok("error" in rejected, "a plan that creates TODO bookkeeping tasks is rejected")
  assert.equal(rejected.failure, "administrative")
  assert.match(rejected.error, /tasks\[0\]/)

  const kept = {
    ...plan,
    tasks: [
      { id: "locate", title: "Locate read_file definition", description: "Find the native tool", criteria: [{ id: "path", description: "Path identified", verification: { kind: "semantic_review" } }], dependencies: [] },
      { id: "task-list-ui", title: "Add task list component", description: "Render the task list panel", criteria: [{ id: "panel", description: "Panel renders", verification: { kind: "semantic_review" } }], dependencies: ["locate"] }
    ]
  }
  const parsed = parseFeedbackPlanResponse(JSON.stringify({ track: true, plan: kept }))
  assert.ok("plan" in parsed, "distinct user work remains a valid plan")
  assert.deepEqual(parsed.plan.tasks.map((task) => task.id), ["locate", "task-list-ui"])
  assert.deepEqual(parsed.plan.tasks[0].dependencies, [])
})

const EVIDENCE_FILE = "src/extension/tools/workspace.ts"
const sourceLines = workspaceText.split("\n")
const numbered = (start: number, lines: string[]) => lines.map((text, index) => `${start + index}: ${text}`).join("\n")
const readOutput = async (file: string, start: number, lines: string[]) =>
  `${file} (lines ${start}–${start + lines.length - 1} of 850)\ncontent_hash: ${await fingerprintContent(workspaceText)}; total_lines: 850\n${numbered(start, lines)}`

const evidenceFixtureFor = async (tasks: Parameters<typeof plan>[0], listChars?: number) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-evidence-"))
  const databasePath = path.join(directory, "twinny-state.sqlite")
  const scope = { projectFingerprint: workspaceProjectFingerprint(["file:///evidence-project"]), conversationId: "evidence-chat", writer: "evidence-chat" }
  const repository = new TodoRepository(databasePath, wasmPath, { listChars: listChars ?? 2_000_000 })
  const synchronized = await repository.synchronizeIntentPlan(scope, plan(tasks), { prompt: "Explain how read_file is registered" })
  return { directory, databasePath, scope, repository, itemIds: synchronized.items.map((item) => item.id) }
}
const evidenceFixture = async (criterion: TypedCriterion, listChars?: number) => evidenceFixtureFor([{ id: "investigate", criteria: [criterion] }], listChars)
type EvidenceFixture = Awaited<ReturnType<typeof evidenceFixture>>

const startInvestigation = async (state: EvidenceFixture) => {
  const context = await state.repository.getActiveIntentContext(state.scope)
  return state.repository.updateItem(state.scope, {
    itemId: context!.task.id,
    expectedVersion: context!.task.version,
    patch: { status: "in_review" },
    actor: "model",
    requestId: "investigate-in-review"
  })
}

const observeRead = async (state: EvidenceFixture, itemId: string, requestId: string, file: string, start: number, lines: string[]) =>
  state.repository.recordToolObservation(state.scope, {
    itemId,
    toolName: "read_file",
    arguments: { path: file, start_line: String(start), end_line: String(start + lines.length - 1) },
    output: `read \`${file}:${start}\` · ${lines.length} lines`,
    failed: false,
    requestId,
    evidenceOutput: await readOutput(file, start, lines)
  })

const reviewFor = async (state: EvidenceFixture, itemId: string) =>
  (await state.repository.getReviewPackages(state.scope)).find((candidate) => candidate.task.id === itemId)!

test("a numbered read keeps its path, line range, total, and every source line", async () => {
  const output = await readOutput(EVIDENCE_FILE, 150, sourceLines.slice(149, 200))
  const preserved = preserveEvidence(output)
  assert.equal(preserved.complete, true)
  assert.equal(preserved.content, output)
  assert.deepEqual(preserved.sources, [{ path: EVIDENCE_FILE, startLine: 150, endLine: 200, totalLines: 850, contentHash: await fingerprintContent(workspaceText) }])
  assert.ok(preserved.content.split("\n").includes("172:     name: \"read_file\","))
})

test("search output keeps each hit's path, line, and preview", () => {
  const output = JSON.stringify({
    query: "read_file", mode: "text", total: 1, offset: 0, limit: 20,
    results: [{ path: EVIDENCE_FILE, line: 172, column: 5, category: "symbol", symbol: "read_file", kind: "property", preview: "name: \"read_file\",", source: "ts" }]
  })
  const hits = preserveEvidence(output).hits
  assert.equal(hits.length, 1)
  assert.equal(hits[0].path, EVIDENCE_FILE)
  assert.equal(hits[0].line, 172)
  assert.match(hits[0].preview, /read_file/)
})

test("oversized source is cut at a whole line and reports that it is incomplete", async () => {
  const output = await readOutput(EVIDENCE_FILE, 1, sourceLines.map((line) => line + " ".repeat(400)))
  const preserved = preserveEvidence(output)
  assert.equal(preserved.complete, false)
  assert.equal(preserved.originalChars, output.length)
  assert.ok(preserved.preservedChars <= MAX_RETAINED_EVIDENCE_CHARS)
  const originalLines = new Set(output.split("\n"))
  assert.ok(preserved.content.split("\n").every((line) => originalLines.has(line)), "every preserved line is an intact source line")
})

test("excerpts of a long source stay within budget, keep matching lines, and do not dump the file", () => {
  const content = numbered(1, sourceLines)
  assert.ok(content.length > MAX_EXCERPT_CHARS, "the fixture must be larger than one excerpt")
  const excerpt = excerptEvidence(content, ["read_file"])
  assert.equal(excerpt.matched, true)
  assert.ok(excerpt.text.length <= MAX_EXCERPT_CHARS)
  assert.ok(excerpt.text.split("\n").includes("172:     name: \"read_file\","))
  assert.ok(!excerpt.text.includes("500: const filler500"))
  assert.equal(excerptEvidence(content, ["registerNativeTool"]).matched, false)
})

test("credential redaction removes the secret without altering unrelated source lines", () => {
  const output = `src/config.ts (lines 2–3 of 3)\ncontent_hash: sha256:${"b".repeat(64)}; total_lines: 3\n2: const readFileName = "read_file"\n3: const token=sk-abcdefghijklmnopqrstuvwx1234`
  const preserved = preserveEvidence(output)
  assert.ok(preserved.content.includes("2: const readFileName = \"read_file\""))
  assert.doesNotMatch(preserved.content, /sk-abcdefghij/)
})

test("coverage separates covered, absent, missing, failed, incomplete, and inaccessible evidence", () => {
  const read: EvidenceRecord = {
    observationId: "obs-read",
    toolName: "read_file",
    failed: false,
    arguments: { path: EVIDENCE_FILE, start_line: "150", end_line: "200" },
    retained: true,
    complete: true,
    content: "172:     name: \"read_file\",",
    sources: [{ path: EVIDENCE_FILE, startLine: 150, endLine: 200, totalLines: 850 }]
  }
  assert.deepEqual(evidenceGaps(evidenceAnchors("`read_file` is defined in src/extension/tools/workspace.ts"), [read]), [])
  assert.deepEqual(
    evidenceGaps(evidenceAnchors("`registerNativeTool` wires `read_file` in src/extension/tools/workspace.ts"), [read]),
    [{ anchor: "registerNativeTool", reason: "absent_symbol" }]
  )
  assert.deepEqual(
    evidenceGaps(evidenceAnchors("`read_file` is in src/extension/tools/view.ts"), [read]),
    [{ anchor: "src/extension/tools/view.ts", reason: "missing_source" }]
  )
  assert.deepEqual(
    evidenceGaps(evidenceAnchors("`read_file` is in src/extension/tools/workspace.ts"), [{ ...read, failed: true }]),
    [
      { anchor: EVIDENCE_FILE, reason: "missing_source" },
      { anchor: "read_file", reason: "absent_symbol" }
    ],
    "a failed read never supports a criterion"
  )
  assert.deepEqual(
    evidenceGaps(evidenceAnchors("`registerNativeTool` is in the read range"), [{ ...read, complete: false, content: "150: const x = 1" }]),
    [{ anchor: "registerNativeTool", reason: "incomplete" }]
  )
  assert.deepEqual(
    evidenceGaps(evidenceAnchors("`read_file` is in src/extension/tools/workspace.ts"), [{ ...read, content: undefined }]),
    [
      { anchor: EVIDENCE_FILE, reason: "inaccessible" },
      { anchor: "read_file", reason: "inaccessible" }
    ]
  )
  assert.match(describeGap({ anchor: "x", reason: "incomplete" }), /cut at the storage limit/)
})

test("retained read evidence lets Feedback approve an investigation whose final prose is incomplete", async () => {
  const state = await evidenceFixture(sourceLocation("defined", "`read_file` is defined and registered in src/extension/tools/workspace.ts", "read_file", "registered_tool"))
  try {
    const item = await startInvestigation(state)
    const observation = await observeRead(state, item.id, "read-workspace", EVIDENCE_FILE, 150, sourceLines.slice(149, 200))
    await state.repository.recordToolObservation(state.scope, {
      itemId: item.id,
      toolName: "search_workspace",
      arguments: { query: "read_file", path: "src" },
      output: "search_workspace read_file: 1 hit",
      failed: false,
      requestId: "search-read-file",
      evidenceOutput: JSON.stringify({ query: "read_file", mode: "text", total: 1, offset: 0, limit: 20, results: [{ path: EVIDENCE_FILE, line: 172, column: 5, category: "symbol", symbol: "read_file", kind: "property", preview: "name: \"read_file\",", source: "ts" }] })
    })
    const review = await reviewFor(state, item.id)
    const input = JSON.parse(todoReviewInput(review, undefined, "Found it."))
    const offered = input.trustedTwinnyToolObservations.find((entry: { id: string }) => entry.id === observation.id)
    assert.ok(offered, "the source read is offered to Feedback as a trusted observation")
    assert.ok(offered.retainedContent?.includes("name: \"read_file\","), "the offered observation carries the retained registration line")
    const evaluation = await evaluateTodoReview(state.repository, state.scope, review, async () => responseFor(review, { refs: [observation.id] }), "mock-reviewer", { readCurrentSource: currentWorkspace, hasVerifiedFileChanges: false })
    assert.ok(evaluation.criteria.length > 0 && evaluation.criteria.every((criterion) => criterion.reconciliation?.outcome === "proven"), "the retained evidence establishes every host-decided criterion")
    assert.equal(evaluation.decision, "accept", JSON.stringify(evaluation.problems))
    assert.equal((await state.repository.getList({ ...state.scope, includeCompleted: true })).items.find((candidate) => candidate.id === item.id)?.status, "completed")
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("a prose criterion that names a code identifier still promotes its verified definition fact", async () => {
  const state = await evidenceFixture(sourceLocation("defined", "Locate the read_file tool definition in src/extension/tools/workspace.ts", "read_file", "registered_tool"))
  try {
    const item = await startInvestigation(state)
    const observation = await observeRead(state, item.id, "read-prose", EVIDENCE_FILE, 150, sourceLines.slice(149, 220))
    const calls = { count: 0 }
    const evaluation = await evaluateTodoReview(state.repository, state.scope, await reviewFor(state, item.id), countingEvaluator(calls), "mock-reviewer", { readCurrentSource: currentWorkspace, hasVerifiedFileChanges: false })
    assert.equal(evaluation.decision, "accept", JSON.stringify(evaluation.problems))
    assert.equal(calls.count, 0)
    const facts = await state.repository.listAcceptedEvidence(state.scope, { symbol: "read_file", path: EVIDENCE_FILE })
    assert.equal(facts.length, 1, "the verified declaration is promoted even though the criterion has no backticks")
    assert.equal(facts[0].observationId, observation.id)
    assert.equal(facts[0].startLine, 169)
    assert.equal(facts[0].endLine, 220, "the promoted range ends at the closing brace, not at the registration line")
    assert.equal(facts[0].symbol, "readFile")
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("accepted source facts are project knowledge: a second chat reads them after reopen and completes without new reads", async () => {
  const acceptance = sourceLocation("defined", "`read_file` is defined in src/extension/tools/workspace.ts", "read_file", "registered_tool")
  const state = await evidenceFixture(acceptance)
  try {
    const item = await startInvestigation(state)
    const observation = await observeRead(state, item.id, "read-origin", EVIDENCE_FILE, 150, sourceLines.slice(149, 220))
    const originCalls = { count: 0 }
    const origin = await evaluateTodoReview(state.repository, state.scope, await reviewFor(state, item.id), countingEvaluator(originCalls), "mock-reviewer", { readCurrentSource: currentWorkspace, hasVerifiedFileChanges: false })
    assert.equal(origin.decision, "accept", JSON.stringify(origin.problems))

    const secondScope = { ...state.scope, conversationId: "second-chat", writer: "second-chat" }
    const secondPlan = await state.repository.synchronizeIntentPlan(secondScope, plan([{ id: "lookup", criteria: [acceptance] }]), { prompt: "Where is read_file defined?" })
    const reopened = new TodoRepository(state.databasePath, wasmPath)
    const facts = await reopened.listAcceptedEvidence(secondScope, { symbol: "read_file", path: EVIDENCE_FILE })
    assert.equal(facts.length, 1, "a fact accepted in another chat of the same project is visible after reopen")
    assert.equal(facts[0].conversationId, state.scope.conversationId, "the fact keeps its originating conversation")
    assert.equal(facts[0].observationId, observation.id)

    const lookupItem = secondPlan.items[0]
    await startItemInReview(reopened, secondScope, lookupItem.id)
    const secondCalls = { count: 0 }
    const second = await evaluateTodoReview(reopened, secondScope, await reviewFor({ ...state, repository: reopened, scope: secondScope }, lookupItem.id), countingEvaluator(secondCalls), "mock-reviewer", { readCurrentSource: currentWorkspace, hasVerifiedFileChanges: false })
    assert.equal(second.decision, "accept", JSON.stringify(second.problems))
    assert.equal(secondCalls.count, 0)
    assert.deepEqual(second.criteria[0].evidenceRefs, [observation.id], "the second chat cites the origin observation without reading the file itself")
    assert.equal((await reopened.getList({ ...secondScope, includeCompleted: true })).items.find((candidate) => candidate.id === lookupItem.id)?.status, "completed")
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("a fact accepted in another chat of the project supersedes this chat's fact for the same symbol and path, with provenance kept", async () => {
  const acceptance = sourceLocation("defined", "`read_file` is defined in src/extension/tools/workspace.ts", "read_file", "registered_tool")
  const state = await evidenceFixture(acceptance)
  try {
    const startItem = await startInvestigation(state)
    const original = await observeRead(state, startItem.id, "read-original", EVIDENCE_FILE, 150, sourceLines.slice(149, 220))
    const calls = { count: 0 }
    const first = await evaluateTodoReview(state.repository, state.scope, await reviewFor(state, startItem.id), countingEvaluator(calls), "mock-reviewer", { readCurrentSource: currentWorkspace, hasVerifiedFileChanges: false })
    assert.equal(first.decision, "accept", JSON.stringify(first.problems))

    const secondScope = { ...state.scope, conversationId: "second-chat", writer: "second-chat" }
    const secondPlan = await state.repository.synchronizeIntentPlan(secondScope, plan([{ id: "lookup", criteria: [acceptance] }]), { prompt: "Where is read_file defined?" })
    const secondItem = secondPlan.items[0]
    await startItemInReview(state.repository, secondScope, secondItem.id)
    const fresh = await state.repository.recordToolObservation(secondScope, {
      itemId: secondItem.id,
      toolName: "read_file",
      arguments: { path: EVIDENCE_FILE, start_line: "150", end_line: "200" },
      output: `read \`${EVIDENCE_FILE}:150\` · 51 lines`,
      failed: false,
      requestId: "read-second",
      evidenceOutput: await readCurrentOutput(CHANGED_TEXT, EVIDENCE_FILE, 150, sourceLines.slice(149, 220))
    })
    const second = await evaluateTodoReview(state.repository, secondScope, await reviewFor({ ...state, scope: secondScope }, secondItem.id), countingEvaluator(calls), "mock-reviewer", { readCurrentSource: changedWorkspace, hasVerifiedFileChanges: false })
    assert.equal(second.decision, "accept", JSON.stringify(second.problems))
    assert.equal(calls.count, 0)

    const history = await state.repository.listAcceptedEvidence(secondScope, { symbol: "read_file", path: EVIDENCE_FILE })
    assert.equal(history.length, 2, "both chats' facts are kept")
    const current = history.filter((fact) => !fact.supersededBy)
    assert.equal(current.length, 1)
    assert.equal(current[0].observationId, fresh.id)
    assert.equal(current[0].conversationId, "second-chat")
    const previous = history.find((fact) => fact.observationId === original.id)!
    assert.equal(previous.supersededBy, current[0].id, "the earlier chat's fact is superseded in the project view")
    assert.equal(previous.conversationId, state.scope.conversationId, "the earlier fact keeps its originating chat")
    assert.equal((await state.repository.listAcceptedEvidence(state.scope, { symbol: "read_file", path: EVIDENCE_FILE })).filter((fact) => !fact.supersededBy)[0].observationId, fresh.id, "every chat sees the same current fact")
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("another conversation's TODO list in the project is readable read-only, and reads never create or change it", async () => {
  const state = await evidenceFixture(sourceLocation("defined", "`read_file` is defined in src/extension/tools/workspace.ts", "read_file", "registered_tool"))
  try {
    const other = { projectFingerprint: state.scope.projectFingerprint, conversationId: "other-chat", writer: "other-chat" }
    assert.equal(await state.repository.readList(other), undefined, "a conversation with no list reads as absent")
    assert.equal(await state.repository.readList(other), undefined, "reading an absent list does not create it")
    await state.repository.createItem(other, { title: "Survey the parser" }, "other-create", "user")
    const snapshot = await state.repository.readList(other)
    assert.equal(snapshot?.conversationId, "other-chat")
    assert.equal(snapshot?.items.length, 1)
    snapshot?.items.splice(0)
    assert.equal((await state.repository.readList(other))?.items.length, 1, "a returned snapshot is a copy, not the stored list")
    const foreignProject = { projectFingerprint: workspaceProjectFingerprint(["file:///another-project"]), conversationId: "other-chat", writer: "other-chat" }
    assert.equal(await state.repository.readList(foreignProject), undefined, "a conversation in another project is not readable")

    const tools = todoWorkspaceTools(state.repository, state.scope, () => undefined)
    const read = await tools.run({ name: "twinny_todo_list", args: { conversation_id: "other-chat" } })
    assert.ok(!read.failed, read.output)
    const body = JSON.parse(read.output) as { conversationId: string; items: { title: string }[]; read_only: boolean }
    assert.equal(body.read_only, true)
    assert.equal(body.conversationId, "other-chat")
    assert.deepEqual(body.items.map((item) => item.title), ["Survey the parser"])
    const missing = await tools.run({ name: "twinny_todo_list", args: { conversation_id: "never-seen" } })
    assert.equal(missing.failed, true, "a missing conversation list is reported, not created")
    assert.equal(await state.repository.readList({ ...state.scope, conversationId: "never-seen" }), undefined)
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

const CHANGED_TEXT = `${workspaceText}\nconst changedFixture = true`
const changedWorkspace: CurrentSourceReader = async (file) => (file === WORKSPACE_FILE ? CHANGED_TEXT : undefined)
const startItemInReview = async (repository: TodoRepository, scope: EvidenceFixture["scope"], itemId: string) => {
  const item = (await repository.getList({ ...scope, includeCompleted: true })).items.find((candidate) => candidate.id === itemId)!
  return repository.updateItem(scope, { itemId, expectedVersion: item.version, patch: { status: "in_review" }, actor: "model", requestId: `${itemId}-in-review` })
}
const countingEvaluator = (calls: { count: number }) => async (): Promise<string> => {
  calls.count += 1
  throw new Error("Feedback must not be consulted for a deterministic decision")
}
const readCurrentOutput = async (text: string, file: string, start: number, lines: string[]) =>
  `${file} (lines ${start}–${start + lines.length - 1} of ${text.split("\n").length})\ncontent_hash: ${await fingerprintContent(text)}; total_lines: ${text.split("\n").length}\n${numbered(start, lines)}`
const TWO_TASKS = [
  { id: "investigate", criteria: [sourceLocation("defined", "`read_file` is defined in src/extension/tools/workspace.ts", "read_file", "registered_tool")] },
  { id: "locate-again", criteria: [sourceLocation("defined", "`read_file` is defined in src/extension/tools/workspace.ts", "read_file", "registered_tool")] }
]

test("a deterministically accepted source fact is persisted and reused by a later TODO without Feedback or new reads", async () => {
  const state = await evidenceFixtureFor(TWO_TASKS)
  try {
    const [first, second] = state.itemIds
    await startItemInReview(state.repository, state.scope, first)
    const observation = await observeRead(state, first, "read-first", EVIDENCE_FILE, 150, sourceLines.slice(149, 220))
    const calls = { count: 0 }
    const firstEvaluation = await evaluateTodoReview(state.repository, state.scope, await reviewFor(state, first), countingEvaluator(calls), "mock-reviewer", { readCurrentSource: currentWorkspace, hasVerifiedFileChanges: false })
    assert.equal(firstEvaluation.decision, "accept", JSON.stringify(firstEvaluation.problems))
    assert.equal(calls.count, 0)

    const facts = await state.repository.listAcceptedEvidence(state.scope, { symbol: "read_file", path: EVIDENCE_FILE })
    assert.equal(facts.length, 1)
    assert.equal(facts[0].observationId, observation.id)
    assert.equal(facts[0].startLine, 169)
    assert.equal(facts[0].endLine, 220)
    assert.equal(facts[0].symbol, "readFile", "the registered name is stored with the function that implements it")
    assert.equal(facts[0].sourceHash, await fingerprintContent(workspaceText))
    assert.equal(facts[0].supersededBy, undefined)

    await startItemInReview(state.repository, state.scope, second)
    const secondReview = await reviewFor(state, second)
    assert.equal(secondReview.acceptedEvidence.length, 1, "the accepted fact is offered to the later TODO")
    assert.deepEqual(secondReview.retainedEvidence.map((entry) => entry.observationId), [observation.id], "the later TODO adds no read of its own; it sees only the shared observation")
    const secondEvaluation = await evaluateTodoReview(state.repository, state.scope, secondReview, countingEvaluator(calls), "mock-reviewer", { readCurrentSource: currentWorkspace, hasVerifiedFileChanges: false })
    assert.equal(secondEvaluation.decision, "accept", JSON.stringify(secondEvaluation.problems))
    assert.deepEqual(secondEvaluation.criteria[0].evidenceRefs, [observation.id])
    assert.equal(calls.count, 0)
    assert.equal((await state.repository.getList({ ...state.scope, includeCompleted: true })).items.find((candidate) => candidate.id === second)?.status, "completed")
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("repeating an accepted review adds no duplicate fact, and another project reads none", async () => {
  const state = await evidenceFixtureFor(TWO_TASKS)
  try {
    const [first] = state.itemIds
    await startItemInReview(state.repository, state.scope, first)
    await observeRead(state, first, "read-first", EVIDENCE_FILE, 150, sourceLines.slice(149, 220))
    const calls = { count: 0 }
    const review = await reviewFor(state, first)
    const evaluation = await evaluateTodoReview(state.repository, state.scope, review, countingEvaluator(calls), "mock-reviewer", { readCurrentSource: currentWorkspace, hasVerifiedFileChanges: false })
    assert.equal(evaluation.decision, "accept", JSON.stringify(evaluation.problems))
    assert.equal((await state.repository.listAcceptedEvidence(state.scope, { symbol: "read_file", path: EVIDENCE_FILE })).length, 1)

    await evaluateTodoReview(state.repository, state.scope, review, countingEvaluator(calls), "mock-reviewer", { readCurrentSource: currentWorkspace, hasVerifiedFileChanges: false }).catch(() => undefined)
    assert.equal((await state.repository.listAcceptedEvidence(state.scope, { symbol: "read_file", path: EVIDENCE_FILE })).length, 1, "a repeated acceptance must not duplicate the fact")

    const otherProject = { projectFingerprint: workspaceProjectFingerprint(["file:///another-project"]), conversationId: "other-chat", writer: "other-chat" }
    assert.deepEqual(await state.repository.listAcceptedEvidence(otherProject, { symbol: "read_file", path: EVIDENCE_FILE }), [], "a fact is never visible to another project")
    assert.equal(calls.count, 0)
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("a changed source makes the accepted fact historical, and only fresh trusted evidence re-accepts it", async () => {
  const state = await evidenceFixtureFor(TWO_TASKS)
  try {
    const [first, second] = state.itemIds
    await startItemInReview(state.repository, state.scope, first)
    const observation = await observeRead(state, first, "read-first", EVIDENCE_FILE, 150, sourceLines.slice(149, 220))
    const calls = { count: 0 }
    await evaluateTodoReview(state.repository, state.scope, await reviewFor(state, first), countingEvaluator(calls), "mock-reviewer", { readCurrentSource: currentWorkspace, hasVerifiedFileChanges: false })
    const original = await state.repository.listAcceptedEvidence(state.scope, { symbol: "read_file", path: EVIDENCE_FILE })
    assert.equal(original.length, 1)
    assert.equal((await assessAcceptedFacts(original, currentWorkspace))[0].freshness, "current")
    const [stale] = await assessAcceptedFacts(original, changedWorkspace)
    assert.equal(stale.freshness, "historical")
    assert.ok(stale.reason, "staleness is explained")

    await startItemInReview(state.repository, state.scope, second)
    const blocked = await evaluateTodoReview(state.repository, state.scope, await reviewFor(state, second), countingEvaluator(calls), "mock-reviewer", { readCurrentSource: changedWorkspace, hasVerifiedFileChanges: false })
    assert.notEqual(blocked.decision, "accept", "the stale fact does not prove the changed source")
    assert.equal(blocked.criteria[0].reconciliation?.reuse, undefined)
    assert.equal(calls.count, 0)

    const fresh = await state.repository.recordToolObservation(state.scope, {
      itemId: second,
      toolName: "read_file",
      arguments: { path: EVIDENCE_FILE, start_line: "150", end_line: "200" },
      output: `read \`${EVIDENCE_FILE}:150\` · 51 lines`,
      failed: false,
      requestId: "read-changed",
      evidenceOutput: await readCurrentOutput(CHANGED_TEXT, EVIDENCE_FILE, 150, sourceLines.slice(149, 220))
    })
    const accepted = await evaluateTodoReview(state.repository, state.scope, await reviewFor(state, second), countingEvaluator(calls), "mock-reviewer", { readCurrentSource: changedWorkspace, hasVerifiedFileChanges: false })
    assert.equal(accepted.decision, "accept", JSON.stringify(accepted.problems))
    assert.equal(calls.count, 0)

    const history = await state.repository.listAcceptedEvidence(state.scope, { symbol: "read_file", path: EVIDENCE_FILE })
    assert.equal(history.length, 2, "the superseded fact is kept for audit")
    const current = history.filter((fact) => !fact.supersededBy)
    assert.equal(current.length, 1)
    assert.equal(current[0].observationId, fresh.id)
    const previous = history.find((fact) => fact.observationId === observation.id)!
    assert.equal(previous.supersededBy, current[0].id)
    assert.equal((await assessAcceptedFacts([previous], changedWorkspace))[0].freshness, "historical")
    assert.equal((await assessAcceptedFacts(current, changedWorkspace))[0].freshness, "current")
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("accepted facts survive repository reopen and are reused without the original conversation or evaluator", async () => {
  const state = await evidenceFixtureFor(TWO_TASKS)
  try {
    const [first, second] = state.itemIds
    await startItemInReview(state.repository, state.scope, first)
    const observation = await observeRead(state, first, "read-first", EVIDENCE_FILE, 150, sourceLines.slice(149, 220))
    const calls = { count: 0 }
    await evaluateTodoReview(state.repository, state.scope, await reviewFor(state, first), countingEvaluator(calls), "mock-reviewer", { readCurrentSource: currentWorkspace, hasVerifiedFileChanges: false })

    const reopened = new TodoRepository(state.databasePath, wasmPath)
    const facts = await reopened.listAcceptedEvidence(state.scope, { symbol: "read_file", path: EVIDENCE_FILE })
    assert.equal(facts.length, 1)
    assert.equal(facts[0].observationId, observation.id)
    assert.equal((await assessAcceptedFacts(facts, currentWorkspace))[0].freshness, "current")

    await startItemInReview(reopened, state.scope, second)
    const review = (await reopened.getReviewPackages(state.scope)).find((candidate) => candidate.task.id === second)!
    assert.equal(review.acceptedEvidence.length, 1)
    const evaluation = await evaluateTodoReview(reopened, state.scope, review, countingEvaluator(calls), "different-provider-model", { readCurrentSource: currentWorkspace, hasVerifiedFileChanges: false })
    assert.equal(evaluation.decision, "accept", JSON.stringify(evaluation.problems))
    assert.equal(calls.count, 0)
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})


const workspaceRecord = async (start: number, end: number) => ({
  observedAt: "2026-01-01T00:00:00.000Z",
  observationId: "obs-window",
  itemId: "registration",
  toolName: "read_file",
  arguments: { path: EVIDENCE_FILE, start_line: String(start), end_line: String(end) },
  failed: false,
  retained: true,
  complete: true,
  originalChars: 0,
  preservedChars: 0,
  content: numbered(start, sourceLines.slice(start - 1, end)),
  sources: [{ path: EVIDENCE_FILE, startLine: start, endLine: end, totalLines: 850, contentHash: await fingerprintContent(workspaceText) }],
  hits: []
})

const commandRecord = (command: string, exitCode: number | undefined, observationId = "obs-command", failed = false): RetainedObservationEvidence => ({
  observedAt: "2026-01-01T00:00:00.000Z",
  observationId,
  itemId: "task",
  toolName: "run_command",
  arguments: runCommandArguments(command),
  failed,
  exitCode,
  retained: true,
  complete: true,
  originalChars: 0,
  preservedChars: 0,
  sources: [],
  hits: []
})


test("a command_exit_status criterion is proven only by a non-failed zero-exit run of that exact command", async () => {
  const [outcome] = await reviewCriteria([exitZero("npm run build-tests")], [commandRecord("npm run build-tests", 0)], currentWorkspace)
  assert.equal(outcome.outcome, "proven", JSON.stringify(outcome))
  assert.deepEqual(outcome.supportingObservationIds, ["obs-command"])
  const [failedRun] = await reviewCriteria([exitZero("npm run build-tests")], [commandRecord("npm run build-tests", 0, "obs-command", true)], currentWorkspace)
  assert.equal(failedRun.outcome, "unknown", JSON.stringify(failedRun))
  const [otherCommand] = await reviewCriteria([exitZero("npm run build-tests")], [commandRecord("npm test", 0)], currentWorkspace)
  assert.equal(otherCommand.outcome, "unknown", JSON.stringify(otherCommand))
})

test("a nonzero exit of the cited command disproves the criterion and is recorded as the supporting observation", async () => {
  const [outcome] = await reviewCriteria([exitZero("npm run build-tests")], [commandRecord("npm run build-tests", 1)], currentWorkspace)
  assert.equal(outcome.outcome, "disproven", JSON.stringify(outcome))
  assert.deepEqual(outcome.supportingObservationIds, ["obs-command"])
})

test("a command_exit_status criterion without any matching run is unknown, so the task cannot pass on it", async () => {
  const [outcome] = await reviewCriteria([exitZero("npm run build-tests")], [], currentWorkspace)
  assert.equal(outcome.outcome, "unknown", JSON.stringify(outcome))
  assert.deepEqual(outcome.supportingObservationIds, [])
})

test("a semantic_review criterion is never decided by a command record", async () => {
  const [outcome] = await reviewCriteria([semantic("compile", "Compile succeeds")], [commandRecord("npm run build-tests", 0)], currentWorkspace)
  assert.equal(outcome.outcome, "semantic", JSON.stringify(outcome))
})

test("a tool name and the function that encloses its registration are stored as one alias with both line ranges", async () => {
  const [outcome] = await reviewCriteria([locate("read_file", EVIDENCE_FILE, "registered_tool")], [await workspaceRecord(160, 220)], currentWorkspace)
  assert.equal(outcome.outcome, "proven", JSON.stringify(outcome))
  assert.deepEqual(outcome.facts, [{
    symbol: "readFile",
    registeredTool: "read_file",
    path: EVIDENCE_FILE,
    startLine: 169,
    endLine: 220,
    observationId: "obs-window",
    sourceHash: await fingerprintContent(workspaceText)
  }])
})

test("a registration read that stops before the closing line proves the location and records only the observed name line", async () => {
  const [outcome] = await reviewCriteria([locate("read_file", EVIDENCE_FILE, "registered_tool")], [await workspaceRecord(160, 181)], currentWorkspace)
  assert.equal(outcome.outcome, "proven", JSON.stringify(outcome))
  assert.ok(outcome.facts?.every((fact) => fact.startLine === 172 && fact.endLine === 172), "the closing line 220 is unseen, so no implementation range is recorded")
})

test("a registration whose enclosing declaration is outside the read stores no alias", async () => {
  const [outcome] = await reviewCriteria([locate("read_file", EVIDENCE_FILE, "registered_tool")], [await workspaceRecord(171, 181)], currentWorkspace)
  assert.equal(outcome.outcome, "proven", JSON.stringify(outcome))
  assert.deepEqual(outcome.facts, [{
    symbol: "read_file",
    path: EVIDENCE_FILE,
    startLine: 172,
    endLine: 172,
    observationId: "obs-window",
    sourceHash: await fingerprintContent(workspaceText)
  }])
})

test("a stored alias lets a criterion naming the implementation reuse the fact without reading, and only with the alias", async () => {
  const sourceHash = await fingerprintContent(workspaceText)
  const fact = {
    id: "fact-registration",
    conversationId: "chat-a",
    itemId: "item-a",
    criterionIndex: 0,
    criterion: "Locate the `read_file` tool definition in src/extension/tools/workspace.ts",
    toolName: "read_file",
    planId: "plan-a",
    planRevision: 1,
    acceptedAt: "2024-01-01T00:00:00.000Z",
    symbol: "readFile",
    registeredTool: "read_file",
    path: EVIDENCE_FILE,
    startLine: 169,
    endLine: 220,
    observationId: "obs-window",
    sourceHash
  }
  const alias = {
    id: "alias-registration",
    conversationId: "chat-a",
    toolName: "read_file",
    implementation: "readFile",
    path: EVIDENCE_FILE,
    startLine: 169,
    endLine: 220,
    observationId: "obs-window",
    sourceHash,
    createdAt: "2024-01-01T00:00:00.000Z"
  }
  const criteria = [locate("readFile", EVIDENCE_FILE, "implementation_symbol")]
  const [reused] = await reviewCriteria(criteria, [], currentWorkspace, [fact], [alias])
  assert.equal(reused.outcome, "proven", JSON.stringify(reused))
  assert.equal(reused.reuse, "accepted")
  assert.deepEqual(reused.supportingObservationIds, ["obs-window"])
  const [withoutAlias] = await reviewCriteria(criteria, [], currentWorkspace, [fact], [])
  assert.equal(withoutAlias.outcome, "proven", "the fact carries its implementation symbol and registered tool, so the alias row is not needed to prove it")
})

test("a registration alias proven in one chat is stored, survives reopen, and proves the implementation name in a later chat", async () => {
  const state = await evidenceFixtureFor([
    { id: "registration", criteria: [{ id: "defined", description: "`read_file` is defined in src/extension/tools/workspace.ts", verification: { kind: "source_location", identity: "registered_tool", symbol: "read_file", path: "src/extension/tools/workspace.ts" } }] },
    { id: "implementation", criteria: [{ id: "location", description: "`readFile` is defined in src/extension/tools/workspace.ts", verification: { kind: "source_location", identity: "implementation_symbol", symbol: "readFile", path: "src/extension/tools/workspace.ts" } }] }
  ])
  try {
    const [registration, implementation] = state.itemIds
    await startItemInReview(state.repository, state.scope, registration)
    await observeRead(state, registration, "read-registration", EVIDENCE_FILE, 160, sourceLines.slice(159, 220))
    const calls = { count: 0 }
    const first = await evaluateTodoReview(state.repository, state.scope, await reviewFor(state, registration), countingEvaluator(calls), "mock-reviewer", { readCurrentSource: currentWorkspace, hasVerifiedFileChanges: false })
    assert.equal(first.decision, "accept", JSON.stringify(first.problems))

    const reopened = new TodoRepository(state.databasePath, wasmPath)
    const aliases = await reopened.listSymbolAliases(state.scope)
    assert.deepEqual(aliases.map((alias) => [alias.toolName, alias.implementation, alias.startLine, alias.endLine]), [["read_file", "readFile", 169, 220]])

    await startItemInReview(reopened, state.scope, implementation)
    const review = (await reopened.getReviewPackages(state.scope)).find((candidate) => candidate.task.id === implementation)!
    assert.equal(review.symbolAliases.length, 1, "the later chat sees the stored alias")
    const second = await evaluateTodoReview(reopened, state.scope, review, countingEvaluator(calls), "different-provider-model", { readCurrentSource: currentWorkspace, hasVerifiedFileChanges: false })
    assert.equal(second.decision, "accept", JSON.stringify(second.problems))
    assert.equal(second.criteria[0].reconciliation?.reuse, "accepted")
    assert.equal(calls.count, 0)
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

const COPY_FILE = "src/extension/tools/workspace-copy.ts"
const twoCopiesWorkspace: CurrentSourceReader = async (file) => (file === EVIDENCE_FILE || file === COPY_FILE ? workspaceText : undefined)

const deliveryRequirement: AnswerRequirement = {
  id: "read-file",
  source: { identity: "implementation_symbol", symbol: "readFile", path: EVIDENCE_FILE },
  fields: ["path", "range", "fingerprint"]
}

const deliveryFact = (sourceHash: string, overrides: Partial<AcceptedFact> = {}): AcceptedFact => ({
  id: "fact-readfile", conversationId: "conversation", itemId: "item", criterionIndex: 0, criterion: "source fingerprint",
  toolName: "read_file", planId: "plan", planRevision: 1, symbol: "readFile", registeredTool: "read_file", path: EVIDENCE_FILE,
  startLine: 169, endLine: 219, observationId: "observation", sourceHash, acceptedAt: "2026-01-01T00:00:00.000Z", ...overrides
})

type BlockedVerdict = Extract<DeliveryVerdict, { detail: string }>
const blocked = (verdict: DeliveryVerdict, outcome: BlockedVerdict["outcome"]): BlockedVerdict => {
  assert.equal(verdict.outcome, outcome)
  return verdict as BlockedVerdict
}

test("a delivery check verifies every required objective value against current accepted facts", async () => {
  const hash = await fingerprintContent(workspaceText)
  const check = (reply: string, readCurrent: CurrentSourceReader | undefined = twoCopiesWorkspace, facts: AcceptedFact[] = [deliveryFact(hash)]) =>
    checkDelivery(reply, [deliveryRequirement], facts, readCurrent)
  const expectRejected = async (reply: string, pattern: RegExp) => {
    const verdict = blocked(await check(reply), "rejected")
    assert.match(verdict.detail, pattern)
    assert.ok(verdict.correction.includes(hash), "the correction restates the host-verified fingerprint")
    assert.match(verdict.correction, /Do not run commands or recalculate any hash/)
    return verdict
  }
  const complete = `${EVIDENCE_FILE} lines 169-219, authoritative fingerprint ${hash}`

  assert.deepEqual(await check(complete), { outcome: "delivered" })
  assert.deepEqual(await check(`${complete}. The file has TODO comments that are not placeholder answers.`), { outcome: "delivered" })
  assert.deepEqual(await checkDelivery("anything", [], [], undefined), { outcome: "delivered" }, "a plan without answer requirements is never gated")

  await expectRejected(`${EVIDENCE_FILE} authoritative fingerprint ${hash}`, /implementation line range/)
  await expectRejected(`${EVIDENCE_FILE} lines 1-400 of 868, fingerprint ${hash}`, /implementation line range/)
  await expectRejected(`${EVIDENCE_FILE} lines 169-219`, /authoritative whole-file source fingerprint/)
  await expectRejected(`src/extension/tools/other.ts lines 169-219, fingerprint ${hash}`, /implementation file/)
  await expectRejected(`${complete}; also xxh64:bbbbbbbbbbbbbbbb`, /xxh64:bbbbbbbbbbbbbbbb/)
  await expectRejected(`${EVIDENCE_FILE} lines 169-219, fingerprint xxh64:<hash_value>`, /placeholder/)
  await expectRejected(`${EVIDENCE_FILE} lines 169-219, fingerprint <fingerprint>`, /placeholder/)

  const stale = blocked(await check(complete, async (file) => (file === EVIDENCE_FILE ? `${workspaceText}\n// edited` : undefined)), "unresolved")
  assert.match(stale.detail, /changed after this fact was accepted/)
  const unverifiable = blocked(await check(complete, async () => undefined), "unresolved")
  assert.match(unverifiable.detail, /could not be read/)
  const unmeasured = blocked(await check(complete, twoCopiesWorkspace, [deliveryFact(hash, { startLine: Number.NaN })]), "unresolved")
  assert.match(unmeasured.detail, /no measured boundary or fingerprint/)
  const irrelevant = blocked(await check(complete, twoCopiesWorkspace, [deliveryFact(hash, { symbol: "otherFunction" })]), "unresolved")
  assert.match(irrelevant.detail, /no accepted fact records/)
  blocked(await check(complete, twoCopiesWorkspace, [deliveryFact(hash, { supersededBy: "newer-fact" })]), "unresolved")
})

test("the answer contract is validated against same-plan source criteria, and each field needs its matching criterion", () => {
  const criterion = (kind: string) => ({ id: kind, description: `${kind} of readFile`, verification: { kind, identity: "implementation_symbol", symbol: "readFile", path: EVIDENCE_FILE } })
  const plan = (answer: unknown, kinds = ["source_location", "source_range", "source_fingerprint"]) => ({
    planId: "read-file-plan", version: 1, revision: 1, goal: "Report read_file", constraints: [],
    tasks: [{ id: "locate", title: "Locate readFile", description: "Locate readFile", dependencies: [], criteria: kinds.map(criterion) }],
    answer
  })
  const answer = [{ id: "read-file", source: { identity: "implementation_symbol", symbol: "readFile", path: EVIDENCE_FILE }, fields: ["path", "range", "fingerprint"] }]
  assert.deepEqual(validateIntentTaskPlan(plan(answer)).plan?.answer, [deliveryRequirement])
  assert.match(validateIntentTaskPlan(plan(answer, ["source_location"])).diagnostic ?? "", /no source_range criterion/)
  assert.match(validateIntentTaskPlan(plan([{ ...answer[0], fields: ["hash"] }])).diagnostic ?? "", /fields must be a non-empty list/)
})

test("a definition criterion that names no path is located by the one fresh read that declares it", async () => {
  const state = await evidenceFixture({ id: "defined", description: "Locate the read_file tool definition", verification: { kind: "accepted_fact_exists", identity: "registered_tool", symbol: "read_file" } })
  try {
    const item = await startInvestigation(state)
    const observation = await observeRead(state, item.id, "read-discover", EVIDENCE_FILE, 150, sourceLines.slice(149, 220))
    const calls = { count: 0 }
    const evaluation = await evaluateTodoReview(state.repository, state.scope, await reviewFor(state, item.id), countingEvaluator(calls), "mock-reviewer", { readCurrentSource: currentWorkspace, hasVerifiedFileChanges: false })
    assert.equal(evaluation.decision, "accept", JSON.stringify(evaluation.problems))
    assert.equal(calls.count, 0)
    const facts = await state.repository.listAcceptedEvidence(state.scope, { symbol: "read_file", path: EVIDENCE_FILE })
    assert.equal(facts.length, 1)
    assert.equal(facts[0].observationId, observation.id)
    assert.equal(facts[0].symbol, "readFile")
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("a live request that asks to return the recorded fingerprint is decided from one fresh read, with no Feedback call", async () => {
  const state = await evidenceFixture({ id: "defined", description: "Locate the native read_file definition using previously accepted TODO evidence if available", verification: { kind: "accepted_fact_exists", identity: "registered_tool", symbol: "read_file" } })
  try {
    const item = await startInvestigation(state)
    const observation = await observeRead(state, item.id, "read-live-return", EVIDENCE_FILE, 150, sourceLines.slice(149, 220))
    const calls = { count: 0 }
    const evaluation = await evaluateTodoReview(state.repository, state.scope, await reviewFor(state, item.id), countingEvaluator(calls), "mock-reviewer", { readCurrentSource: currentWorkspace, hasVerifiedFileChanges: false })
    assert.equal(evaluation.decision, "accept", JSON.stringify(evaluation.problems))
    assert.equal(calls.count, 0)
    const facts = await state.repository.listAcceptedEvidence(state.scope, { symbol: "read_file", path: EVIDENCE_FILE })
    assert.equal(facts.length, 1)
    assert.equal(facts[0].observationId, observation.id)
    assert.equal(facts[0].symbol, "readFile")
    assert.equal(facts[0].startLine, 169)
    assert.equal(facts[0].endLine, 220)
    assert.equal(facts[0].sourceHash, await fingerprintContent(workspaceText), "the read_file fingerprint is the source fingerprint")
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("a path-free definition criterion declared in two files stays unresolved and names the file, with no Feedback call", async () => {
  const state = await evidenceFixture({ id: "defined", description: "Locate the read_file tool definition", verification: { kind: "accepted_fact_exists", identity: "registered_tool", symbol: "read_file" } })
  try {
    const item = await startInvestigation(state)
    const observation = await observeRead(state, item.id, "read-one", EVIDENCE_FILE, 150, sourceLines.slice(149, 200))
    await observeRead(state, item.id, "read-two", COPY_FILE, 150, sourceLines.slice(149, 200))
    const calls = { count: 0 }
    const review = await reviewFor(state, item.id)
    const evaluation = await evaluateTodoReview(state.repository, state.scope, review, async () => {
      calls.count += 1
      return responseFor(review, { refs: [observation.id] })
    }, "mock-reviewer", { readCurrentSource: twoCopiesWorkspace, hasVerifiedFileChanges: false })
    assert.equal(evaluation.decision, "needs_evidence", JSON.stringify(evaluation.problems))
    assert.equal(calls.count, 0, "an objective ambiguity is not a semantic judgment, so Feedback is not asked")
    assert.ok(evaluation.problems.some((problem) => problem.includes("declared in 2 files")), JSON.stringify(evaluation.problems))
    assert.equal((await state.repository.listAcceptedEvidence(state.scope, { symbol: "read_file" })).length, 0)
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("a path-free definition criterion is neither proven nor disproven by a fresh read that does not declare the symbol", async () => {
  const state = await evidenceFixture({ id: "defined", description: "Locate the read_file tool definition", verification: { kind: "accepted_fact_exists", identity: "registered_tool", symbol: "read_file" } })
  try {
    const item = await startInvestigation(state)
    const observation = await observeRead(state, item.id, "read-filler", EVIDENCE_FILE, 1, sourceLines.slice(0, 50))
    const calls = { count: 0 }
    const review = await reviewFor(state, item.id)
    const evaluation = await evaluateTodoReview(state.repository, state.scope, review, async () => {
      calls.count += 1
      return responseFor(review, { refs: [observation.id] })
    }, "mock-reviewer", { readCurrentSource: currentWorkspace, hasVerifiedFileChanges: false })
    assert.notEqual(evaluation.decision, "revise", JSON.stringify(evaluation.problems))
    assert.equal(calls.count, 0, "absence from a fresh read is neither a proof nor a semantic judgment")
    assert.ok(evaluation.problems.some((problem) => problem.includes("no current accepted fact for read_file is recorded")), JSON.stringify(evaluation.problems))
    assert.equal((await state.repository.listAcceptedEvidence(state.scope, { symbol: "read_file" })).length, 0)
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("a failed read or a read without its content fingerprint proves nothing and stores no accepted fact", async () => {
  const state = await evidenceFixture(sourceLocation("defined", "Locate the read_file tool definition in src/extension/tools/workspace.ts", "read_file", "registered_tool"))
  try {
    const item = await startInvestigation(state)
    await state.repository.recordToolObservation(state.scope, {
      itemId: item.id,
      toolName: "read_file",
      arguments: { path: EVIDENCE_FILE, start_line: "150", end_line: "200" },
      output: "read failed: file is locked",
      failed: true,
      requestId: "read-failed"
    })
    await state.repository.recordToolObservation(state.scope, {
      itemId: item.id,
      toolName: "read_file",
      arguments: { path: EVIDENCE_FILE, start_line: "150", end_line: "200" },
      output: `read \`${EVIDENCE_FILE}:150\` · 51 lines`,
      failed: false,
      requestId: "read-without-fingerprint",
      evidenceOutput: `${EVIDENCE_FILE} (lines 150–200 of 850)\n${numbered(150, sourceLines.slice(149, 200))}`
    })
    const review = await reviewFor(state, item.id)
    const outcomes = await reviewCriteria(review.criteria, review.retainedEvidence, currentWorkspace)
    assert.notEqual(outcomes[0].outcome, "proven", JSON.stringify(outcomes[0]))
    assert.deepEqual(outcomes[0].supportingObservationIds, [])

    const calls = { count: 0 }
    await evaluateTodoReview(state.repository, state.scope, review, async () => {
      calls.count += 1
      return responseFor(review, { decision: "revise", status: "failed", correctiveInstructions: ["Read the source again with its fingerprint."] })
    }, "mock-reviewer", { readCurrentSource: currentWorkspace, hasVerifiedFileChanges: false }).catch(() => undefined)
    assert.equal((await state.repository.listAcceptedEvidence(state.scope, { symbol: "read_file" })).length, 0, "unprovable evidence must not be accepted")
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("conversation B resolves a path-free tool name from accepted project facts with zero model reads and the origin's provenance", async () => {
  const state = await evidenceFixture(sourceLocation("defined", "`read_file` is defined in src/extension/tools/workspace.ts", "read_file", "registered_tool"))
  try {
    const item = await startInvestigation(state)
    const observation = await observeRead(state, item.id, "read-origin", EVIDENCE_FILE, 150, sourceLines.slice(149, 220))
    const originCalls = { count: 0 }
    const origin = await evaluateTodoReview(state.repository, state.scope, await reviewFor(state, item.id), countingEvaluator(originCalls), "mock-reviewer", { readCurrentSource: currentWorkspace, hasVerifiedFileChanges: false })
    assert.equal(origin.decision, "accept", JSON.stringify(origin.problems))
    const originItems = JSON.stringify((await state.repository.getList({ ...state.scope, includeCompleted: true })).items)

    const secondScope = { ...state.scope, conversationId: "second-chat", writer: "second-chat" }
    const secondPlan = await state.repository.synchronizeIntentPlan(secondScope, plan([{ id: "lookup", criteria: [{ id: "locate-tool", description: "Locate the `read_file` tool definition", verification: { kind: "accepted_fact_exists", identity: "registered_tool", symbol: "read_file" } }] }]), { prompt: "Where is the read_file tool implemented?" })
    const reopened = new TodoRepository(state.databasePath, wasmPath)
    const lookupId = secondPlan.items[0].id
    await startItemInReview(reopened, secondScope, lookupId)
    const hostReads: string[] = []
    const countedReader: CurrentSourceReader = async (file) => {
      hostReads.push(file)
      return currentWorkspace(file)
    }
    const secondCalls = { count: 0 }
    const review = (await reopened.getReviewPackages(secondScope)).find((candidate) => candidate.task.id === lookupId)!
    const second = await evaluateTodoReview(reopened, secondScope, review, countingEvaluator(secondCalls), "mock-reviewer", { readCurrentSource: countedReader, hasVerifiedFileChanges: false })
    assert.equal(second.decision, "accept", JSON.stringify(second.problems))
    assert.equal(secondCalls.count, 0, "no model evaluation")
    assert.equal(second.criteria[0].reconciliation?.reuse, "accepted")
    assert.deepEqual(second.criteria[0].evidenceRefs, [observation.id], "the origin observation is cited")
    assert.deepEqual(hostReads, [EVIDENCE_FILE], "the host fingerprint check is the only read, and it is not a model tool call")
    assert.equal(review.observations.length, 0, "conversation B made no source observations of its own")
    assert.equal(JSON.stringify((await state.repository.getList({ ...state.scope, includeCompleted: true })).items), originItems, "conversation A's TODOs are unchanged")
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("twinny_evidence_lookup resolves a tool name or its implementation without a path, reports unique resolution, and mutates nothing", async () => {
  const state = await evidenceFixture(sourceLocation("defined", "`read_file` is defined in src/extension/tools/workspace.ts", "read_file", "registered_tool"))
  try {
    const item = await startInvestigation(state)
    const observation = await observeRead(state, item.id, "read-origin", EVIDENCE_FILE, 150, sourceLines.slice(149, 220))
    await evaluateTodoReview(state.repository, state.scope, await reviewFor(state, item.id), countingEvaluator({ count: 0 }), "mock-reviewer", { readCurrentSource: currentWorkspace, hasVerifiedFileChanges: false })
    const originItems = JSON.stringify((await state.repository.getList({ ...state.scope, includeCompleted: true })).items)

    const secondScope = { ...state.scope, conversationId: "second-chat", writer: "second-chat" }
    await state.repository.synchronizeIntentPlan(secondScope, plan([{ id: "lookup", criteria: [{ id: "locate-tool", description: "Locate the `read_file` tool definition", verification: { kind: "accepted_fact_exists", identity: "registered_tool", symbol: "read_file" } }] }]), { prompt: "Where is read_file implemented?" })
    const reopened = new TodoRepository(state.databasePath, wasmPath)
    const second = { ...state, repository: reopened, scope: secondScope }

    for (const symbol of ["read_file", "readFile"]) {
      const lookup = await lookupEvidence(second, { symbol }, currentWorkspace)
      assert.equal(lookup.failed, false)
      assert.equal(lookup.body!.resolution, "unique", symbol)
      assert.equal(lookup.body!.facts.length, 1, symbol)
      const [fact] = lookup.body!.facts
      assert.equal(fact.tool_name, "read_file")
      assert.equal(fact.symbol, "readFile")
      assert.equal(fact.registered_tool, "read_file")
      assert.equal(fact.path, EVIDENCE_FILE)
      assert.equal(fact.observation_id, observation.id)
      assert.equal(fact.conversation_id, state.scope.conversationId, "provenance keeps the origin conversation")
      assert.equal(fact.freshness, "current")
    }

    const forged = await lookupEvidence({ ...second, scope: { ...secondScope, projectFingerprint: workspaceProjectFingerprint(["file:///evidence-project-forged"]) } }, { symbol: "read_file" }, currentWorkspace)
    assert.equal(forged.body!.facts.length, 0, "a different project resolves nothing")
    assert.equal(forged.body!.resolution, "none")

    assert.equal(JSON.stringify((await state.repository.getList({ ...state.scope, includeCompleted: true })).items), originItems, "lookups change no TODO")
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("a changed source makes the project fact historical, so a path-free criterion is not proven from it", async () => {
  const state = await evidenceFixture(sourceLocation("defined", "`read_file` is defined in src/extension/tools/workspace.ts", "read_file", "registered_tool"))
  try {
    const item = await startInvestigation(state)
    await observeRead(state, item.id, "read-origin", EVIDENCE_FILE, 150, sourceLines.slice(149, 220))
    await evaluateTodoReview(state.repository, state.scope, await reviewFor(state, item.id), countingEvaluator({ count: 0 }), "mock-reviewer", { readCurrentSource: currentWorkspace, hasVerifiedFileChanges: false })

    const changedWorkspace: CurrentSourceReader = async (file) => (file === EVIDENCE_FILE ? workspaceText.replace("name: \"read_file\"", "name: \"read_files\"") : undefined)
    const secondScope = { ...state.scope, conversationId: "second-chat", writer: "second-chat" }
    const secondPlan = await state.repository.synchronizeIntentPlan(secondScope, plan([{ id: "lookup", criteria: [{ id: "locate-tool", description: "Locate the `read_file` tool definition", verification: { kind: "accepted_fact_exists", identity: "registered_tool", symbol: "read_file" } }] }]), { prompt: "Where is read_file implemented?" })
    const reopened = new TodoRepository(state.databasePath, wasmPath)
    const second = { ...state, repository: reopened, scope: secondScope }

    const lookup = await lookupEvidence(second, { symbol: "read_file" }, changedWorkspace)
    assert.equal(lookup.body!.resolution, "historical")
    assert.equal(lookup.body!.facts[0].freshness, "historical")
    assert.match(String(lookup.body!.facts[0].refresh), /read src\/extension\/tools\/workspace\.ts lines 169-220 again/)

    const lookupId = secondPlan.items[0].id
    await startItemInReview(reopened, secondScope, lookupId)
    const calls = { count: 0 }
    const review = (await reopened.getReviewPackages(secondScope)).find((candidate) => candidate.task.id === lookupId)!
    await evaluateTodoReview(reopened, secondScope, review, async () => {
      calls.count += 1
      return responseFor(review, { refs: [] })
    }, "mock-reviewer", { readCurrentSource: changedWorkspace, hasVerifiedFileChanges: false })
    assert.equal(calls.count, 0, "a historical fact is not evidence of the current source, and an objective predicate is not sent to Feedback")
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("two project facts that name different locations for one tool are ambiguous, and no path-free criterion picks one", async () => {
  const state = await evidenceFixtureFor([
    { id: "origin", criteria: [{ id: "defined", description: "`read_file` is defined in src/extension/tools/workspace.ts", verification: { kind: "source_location", identity: "registered_tool", symbol: "read_file", path: "src/extension/tools/workspace.ts" } }] },
    { id: "copy", criteria: [{ id: "location", description: "`read_file` is defined in src/extension/tools/workspace-copy.ts", verification: { kind: "source_location", identity: "registered_tool", symbol: "read_file", path: "src/extension/tools/workspace-copy.ts" } }] }
  ])
  try {
    for (const itemId of state.itemIds) {
      await startItemInReview(state.repository, state.scope, itemId)
      await observeRead(state, itemId, `read-${itemId}`, itemId === state.itemIds[0] ? EVIDENCE_FILE : COPY_FILE, 150, sourceLines.slice(149, 220))
      const review = await reviewFor(state, itemId)
      const evaluation = await evaluateTodoReview(state.repository, state.scope, review, countingEvaluator({ count: 0 }), "mock-reviewer", { readCurrentSource: twoCopiesWorkspace, hasVerifiedFileChanges: false })
      assert.equal(evaluation.decision, "accept", JSON.stringify(evaluation.problems))
    }
    const lookup = await lookupEvidence(state, { symbol: "read_file" }, twoCopiesWorkspace)
    assert.equal(lookup.body!.resolution, "ambiguous")
    assert.equal(lookup.body!.facts.length, 2)
    assert.equal((await lookupEvidence(state, { symbol: "readFile" }, twoCopiesWorkspace)).body!.resolution, "ambiguous")

    const secondScope = { ...state.scope, conversationId: "second-chat", writer: "second-chat" }
    const secondPlan = await state.repository.synchronizeIntentPlan(secondScope, plan([{ id: "lookup", criteria: [{ id: "locate-tool", description: "Locate the `read_file` tool definition", verification: { kind: "accepted_fact_exists", identity: "registered_tool", symbol: "read_file" } }] }]), { prompt: "Where is read_file implemented?" })
    const reopened = new TodoRepository(state.databasePath, wasmPath)
    const lookupId = secondPlan.items[0].id
    await startItemInReview(reopened, secondScope, lookupId)
    const calls = { count: 0 }
    const review = (await reopened.getReviewPackages(secondScope)).find((candidate) => candidate.task.id === lookupId)!
    const second = await evaluateTodoReview(reopened, secondScope, review, async () => {
      calls.count += 1
      return responseFor(review, { refs: [] })
    }, "mock-reviewer", { readCurrentSource: twoCopiesWorkspace, hasVerifiedFileChanges: false })
    assert.equal(calls.count, 0, "ambiguous project knowledge is not a semantic judgment, so Feedback is not asked to choose a file")
    assert.equal(second.decision, "needs_evidence", JSON.stringify(second.problems))
    assert.notEqual(second.criteria[0].reconciliation?.reuse, "accepted")
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("accepted facts and TODO writes stay inside the project that recorded them, even under a forged project fingerprint", async () => {
  const state = await evidenceFixture(sourceLocation("defined", "Locate the read_file tool definition in src/extension/tools/workspace.ts", "read_file", "registered_tool"))
  try {
    const item = await startInvestigation(state)
    await observeRead(state, item.id, "read-own", EVIDENCE_FILE, 150, sourceLines.slice(149, 220))
    const calls = { count: 0 }
    const evaluation = await evaluateTodoReview(state.repository, state.scope, await reviewFor(state, item.id), countingEvaluator(calls), "mock-reviewer", { readCurrentSource: currentWorkspace, hasVerifiedFileChanges: false })
    assert.equal(evaluation.decision, "accept", JSON.stringify(evaluation.problems))
    assert.equal((await state.repository.listAcceptedEvidence(state.scope, { symbol: "read_file", path: EVIDENCE_FILE })).length, 1)

    const forged = { ...state.scope, projectFingerprint: workspaceProjectFingerprint(["file:///evidence-project-forged"]) }
    assert.deepEqual(await state.repository.listAcceptedEvidence(forged, { symbol: "read_file" }), [], "a forged project reads no accepted fact")
    await assert.rejects(async () => state.repository.updateItem(forged, {
      itemId: item.id, expectedVersion: item.version, patch: { title: "Rewritten from another project" }, actor: "model", requestId: "forged-update"
    }))
    assert.equal((await state.repository.getList(state.scope)).items.find((candidate) => candidate.id === item.id)?.title, item.title, "another project cannot rewrite this item")

    const created = await state.repository.createItem(forged, { title: "Task in a forged project" }, "forged-create")
    assert.equal(created.title, "Task in a forged project")
    assert.equal((await state.repository.getList(state.scope)).items.some((candidate) => candidate.title === "Task in a forged project"), false, "a write under a forged project stays in its own project")
    assert.deepEqual(await state.repository.listAcceptedEvidence(forged, { symbol: "read_file" }), [])
    assert.equal((await state.repository.listAcceptedEvidence(state.scope, { symbol: "read_file", path: EVIDENCE_FILE })).length, 1, "the recorded fact is unchanged")
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

const lookupEvidence = async (state: EvidenceFixture, args: Record<string, string>, readCurrent?: CurrentSourceReader) => {
  const tools = todoWorkspaceTools(state.repository, state.scope, () => undefined, { readCurrentSource: readCurrent })
  const response = await tools.run({ name: "twinny_evidence_lookup", args })
  return { failed: response.failed === true, body: response.failed ? undefined : JSON.parse(response.output) as { facts: Record<string, unknown>[]; resolution?: string } }
}

test("twinny_evidence_lookup returns a current accepted fact with its observation and freshness, and is read-only", async () => {
  const state = await evidenceFixtureFor(TWO_TASKS)
  try {
    const [first] = state.itemIds
    await startItemInReview(state.repository, state.scope, first)
    const observation = await observeRead(state, first, "read-first", EVIDENCE_FILE, 150, sourceLines.slice(149, 220))
    const calls = { count: 0 }
    await evaluateTodoReview(state.repository, state.scope, await reviewFor(state, first), countingEvaluator(calls), "mock-reviewer", { readCurrentSource: currentWorkspace, hasVerifiedFileChanges: false })

    const tools = todoWorkspaceTools(state.repository, state.scope, () => undefined, { readCurrentSource: currentWorkspace })
    assert.equal(tools.tools.find((tool) => tool.name === "twinny_evidence_lookup")?.readOnly, true)

    const lookup = await lookupEvidence(state, { symbol: "read_file", path: EVIDENCE_FILE }, currentWorkspace)
    assert.equal(lookup.failed, false)
    assert.equal(lookup.body!.facts.length, 1)
    const [fact] = lookup.body!.facts
    assert.equal(fact.observation_id, observation.id)
    assert.equal(fact.symbol, "readFile")
    assert.equal(fact.registered_tool, "read_file")
    assert.equal(fact.path, EVIDENCE_FILE)
    assert.equal(fact.start_line, 169)
    assert.equal(fact.end_line, 220)
    assert.equal(fact.source_hash, await fingerprintContent(workspaceText))
    assert.equal(fact.freshness, "current")
    assert.equal(fact.refresh, undefined, "a current fact needs no refresh")
    assert.equal(calls.count, 0)
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("a conversation with no TODO plan still reads the project's accepted evidence, so an untracked turn loses no lookup", async () => {
  const state = await evidenceFixture(sourceLocation("defined", "`read_file` is defined in src/extension/tools/workspace.ts", "read_file", "registered_tool"))
  try {
    const item = await startInvestigation(state)
    const observation = await observeRead(state, item.id, "read-origin", EVIDENCE_FILE, 150, sourceLines.slice(149, 220))
    await evaluateTodoReview(state.repository, state.scope, await reviewFor(state, item.id), countingEvaluator({ count: 0 }), "mock-reviewer", { readCurrentSource: currentWorkspace, hasVerifiedFileChanges: false })

    const untrackedScope = { ...state.scope, conversationId: "untracked-chat", writer: "untracked-chat" }
    const reopened = new TodoRepository(state.databasePath, wasmPath)
    assert.equal(await reopened.getIntentTaskPlan(untrackedScope), undefined, "this conversation has no plan")
    const untracked = { ...state, repository: reopened, scope: untrackedScope }

    const lookup = await lookupEvidence(untracked, { symbol: "read_file" }, currentWorkspace)
    assert.equal(lookup.failed, false)
    assert.equal(lookup.body!.resolution, "unique")
    assert.equal(lookup.body!.facts.length, 1)
    assert.equal(lookup.body!.facts[0].observation_id, observation.id, "the origin conversation's fact is reused")
    assert.equal(lookup.body!.facts[0].freshness, "current")
    assert.equal((await reopened.getList({ ...untrackedScope, includeCompleted: true })).items.length, 0, "the lookup creates no TODO in the untracked conversation")
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("twinny_evidence_lookup reports a changed source as historical with a refresh hint, and a superseded fact without one", async () => {
  const state = await evidenceFixtureFor(TWO_TASKS)
  try {
    const [first, second] = state.itemIds
    await startItemInReview(state.repository, state.scope, first)
    const observation = await observeRead(state, first, "read-first", EVIDENCE_FILE, 150, sourceLines.slice(149, 220))
    const calls = { count: 0 }
    await evaluateTodoReview(state.repository, state.scope, await reviewFor(state, first), countingEvaluator(calls), "mock-reviewer", { readCurrentSource: currentWorkspace, hasVerifiedFileChanges: false })

    const stale = await lookupEvidence(state, { path: EVIDENCE_FILE }, changedWorkspace)
    assert.equal(stale.body!.facts.length, 1)
    assert.equal(stale.body!.facts[0].freshness, "historical")
    assert.ok(typeof stale.body!.facts[0].reason === "string", "staleness is explained")
    assert.equal(stale.body!.facts[0].refresh, `read ${EVIDENCE_FILE} lines 169-220 again`)

    await startItemInReview(state.repository, state.scope, second)
    const fresh = await state.repository.recordToolObservation(state.scope, {
      itemId: second,
      toolName: "read_file",
      arguments: { path: EVIDENCE_FILE, start_line: "150", end_line: "200" },
      output: `read \`${EVIDENCE_FILE}:150\` · 51 lines`,
      failed: false,
      requestId: "read-changed",
      evidenceOutput: await readCurrentOutput(CHANGED_TEXT, EVIDENCE_FILE, 150, sourceLines.slice(149, 220))
    })
    const accepted = await evaluateTodoReview(state.repository, state.scope, await reviewFor(state, second), countingEvaluator(calls), "mock-reviewer", { readCurrentSource: changedWorkspace, hasVerifiedFileChanges: false })
    assert.equal(accepted.decision, "accept", JSON.stringify(accepted.problems))

    const history = await lookupEvidence(state, { symbol: "read_file" }, changedWorkspace)
    assert.equal(history.body!.facts.length, 2)
    const superseded = history.body!.facts.find((fact) => fact.observation_id === observation.id)!
    const current = history.body!.facts.find((fact) => fact.observation_id === fresh.id)!
    assert.equal(superseded.freshness, "historical")
    assert.equal(superseded.refresh, undefined, "a superseded fact points to its replacement, not a re-read")
    assert.equal(current.freshness, "current")
    assert.equal(current.refresh, undefined)
    assert.equal(calls.count, 0)
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("planning, observation, deterministic verification, persistence, context reset, and a different model's lookup run as one sequence", async () => {
  const OBJECTIVE = "Locate the native read_file tool definition."
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-integration-"))
  const databasePath = path.join(directory, "twinny-state.sqlite")
  const scope = { projectFingerprint: workspaceProjectFingerprint(["file:///integration-project"]), conversationId: "integration-chat", writer: "integration-chat" }
  try {
    const task = (id: string, title: string, dependencies: string[]) => ({ id, title, description: `Work for ${id}.`, criteria: [{ id: "location", description: "`read_file` is defined in src/extension/tools/workspace.ts", verification: { kind: "source_location", identity: "registered_tool", symbol: "read_file", path: "src/extension/tools/workspace.ts" } }], dependencies })
    const reply = JSON.stringify({ track: true, plan: { planId: "feedback-plan", version: 1, revision: 1, goal: OBJECTIVE, constraints: [], tasks: [
      task("locate", "Locate native read_file definition", []),
      task("follow-up", "Answer the read_file location follow-up", ["locate"]),
      task("recheck", "Recheck the read_file location", ["locate"])
    ] } })
    const parsed = parseFeedbackPlanResponse(reply, OBJECTIVE)
    if (!("plan" in parsed)) assert.fail(JSON.stringify(parsed))

    const repository = new TodoRepository(databasePath, wasmPath, { listChars: 2_000_000 })
    const synchronized = await repository.synchronizeIntentPlan(scope, parsed.plan, { source: "feedback", goal: OBJECTIVE })
    const [locate, followUp, recheck] = synchronized.items.map((item) => item.id)
    const state = { directory, databasePath, scope, repository, itemIds: [locate, followUp, recheck] }

    await startItemInReview(repository, scope, locate)
    const observation = await observeRead(state, locate, "integration-read", EVIDENCE_FILE, 150, sourceLines.slice(149, 220))
    const calls = { count: 0 }
    const first = await evaluateTodoReview(repository, scope, await reviewFor(state, locate), countingEvaluator(calls), "mock-reviewer", { readCurrentSource: currentWorkspace, hasVerifiedFileChanges: false })
    assert.equal(first.decision, "accept", JSON.stringify(first.problems))
    assert.equal(calls.count, 0, "a deterministic fact never reaches Feedback")

    const reopened = new TodoRepository(databasePath, wasmPath)
    const reopenedState = { ...state, repository: reopened }
    const retained = await reopened.listAcceptedEvidence(scope, { symbol: "read_file", path: EVIDENCE_FILE })
    assert.equal(retained.length, 1)
    assert.equal(retained[0].observationId, observation.id)
    const lookup = await lookupEvidence(reopenedState, { symbol: "read_file", path: EVIDENCE_FILE }, currentWorkspace)
    assert.equal(lookup.failed, false)
    assert.equal(lookup.body!.facts.length, 1)
    assert.equal(lookup.body!.facts[0].freshness, "current")
    assert.equal(lookup.body!.facts[0].observation_id, observation.id)

    await startItemInReview(reopened, scope, followUp)
    const second = await evaluateTodoReview(reopened, scope, await reviewFor(reopenedState, followUp), countingEvaluator(calls), "different-provider-model", { readCurrentSource: currentWorkspace, hasVerifiedFileChanges: false })
    assert.equal(second.decision, "accept", JSON.stringify(second.problems))
    assert.equal(calls.count, 0, "the second task reuses the accepted fact without a search or read")

    const stale = await lookupEvidence(reopenedState, { symbol: "read_file", path: EVIDENCE_FILE }, changedWorkspace)
    assert.equal(stale.body!.facts[0].freshness, "historical")
    assert.ok(stale.body!.facts[0].refresh, "the lookup names the fresh read that would re-establish the fact")

    await startItemInReview(reopened, scope, recheck)
    const blocked = await evaluateTodoReview(reopened, scope, await reviewFor(reopenedState, recheck), countingEvaluator(calls), "different-provider-model", { readCurrentSource: changedWorkspace, hasVerifiedFileChanges: false })
    assert.notEqual(blocked.decision, "accept", "the historical fact does not prove the changed source")
    assert.equal(calls.count, 0)

    const fresh = await reopened.recordToolObservation(scope, {
      itemId: recheck,
      toolName: "read_file",
      arguments: { path: EVIDENCE_FILE, start_line: "150", end_line: "200" },
      output: `read \`${EVIDENCE_FILE}:150\` · 51 lines`,
      failed: false,
      requestId: "integration-read-changed",
      evidenceOutput: await readCurrentOutput(CHANGED_TEXT, EVIDENCE_FILE, 150, sourceLines.slice(149, 220))
    })
    const accepted = await evaluateTodoReview(reopened, scope, await reviewFor(reopenedState, recheck), countingEvaluator(calls), "different-provider-model", { readCurrentSource: changedWorkspace, hasVerifiedFileChanges: false })
    assert.equal(accepted.decision, "accept", JSON.stringify(accepted.problems))
    assert.equal(calls.count, 0)

    const history = await reopened.listAcceptedEvidence(scope, { symbol: "read_file", path: EVIDENCE_FILE })
    assert.equal(history.length, 2, "the superseded fact is kept for audit")
    const current = history.filter((fact) => !fact.supersededBy)
    assert.equal(current.length, 1)
    assert.equal(current[0].observationId, fresh.id)
    const previous = history.find((fact) => fact.observationId === observation.id)!
    assert.equal((await assessAcceptedFacts([previous], changedWorkspace))[0].freshness, "historical")
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("twinny_evidence_lookup requires a symbol or a path and fails without one", async () => {
  const state = await evidenceFixtureFor(TWO_TASKS)
  try {
    const lookup = await lookupEvidence(state, {}, currentWorkspace)
    assert.equal(lookup.failed, true)
    assert.equal(lookup.body, undefined)
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("a read that misses the definition's line range or names a different symbol never proves it, and needs no Feedback call", async () => {
  const criterion = sourceLocation("defined", "`read_file` is defined in src/extension/tools/workspace.ts", "read_file", "registered_tool")
  const cases = [
    { label: "lines 1-50 hold no definition", start: 1, lines: sourceLines.slice(0, 50) },
    { label: "the definition line names write_file", start: 150, lines: sourceLines.slice(149, 200).map((line) => line.replace("\"read_file\"", "\"write_file\"")) }
  ]
  for (const { label, start, lines } of cases) {
    const state = await evidenceFixture(criterion)
    try {
      const [item] = state.itemIds
      await startItemInReview(state.repository, state.scope, item)
      await observeRead(state, item, `read-${start}`, EVIDENCE_FILE, start, lines)
      const calls = { count: 0 }
      const evaluation = await evaluateTodoReview(state.repository, state.scope, await reviewFor(state, item), countingEvaluator(calls), "mock-reviewer", { readCurrentSource: currentWorkspace, hasVerifiedFileChanges: false })
      assert.notEqual(evaluation.decision, "accept", label)
      assert.equal(calls.count, 0, label)
    } finally {
      fs.rmSync(state.directory, { recursive: true, force: true })
    }
  }
})

test("a semantic relationship that no fact can settle still reaches Feedback", async () => {
  const state = await evidenceFixture({ id: "handles-outside", description: "`read_file` returns an error when its path is outside the workspace", verification: { kind: "semantic_review" } })
  try {
    const [item] = state.itemIds
    await startItemInReview(state.repository, state.scope, item)
    await observeRead(state, item, "read-semantic", EVIDENCE_FILE, 150, sourceLines.slice(149, 200))
    const calls = { count: 0 }
    const evaluator = async () => {
      calls.count += 1
      throw new Error("semantic review requested")
    }
    await assert.rejects(evaluateTodoReview(state.repository, state.scope, await reviewFor(state, item), evaluator, "mock-reviewer", { readCurrentSource: currentWorkspace, hasVerifiedFileChanges: false }), /semantic review requested/)
    assert.equal(calls.count, 1, "the behavioral claim is decided by Feedback, not by the host")
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("Feedback, verifier, child-review, and Mycroft prompts agree on the TODO and evidence rules", () => {
  assert.match(FEEDBACK_PLAN_PROTOCOL, /Planning workflow is not a user deliverable/)
  assert.match(FEEDBACK_PLAN_PROTOCOL, /Criteria are fixed when the plan is made/)
  assert.match(FEEDBACK_PLAN_PROTOCOL, /locate or lookup task needs only the facts/)
  assert.match(CHILD_TODO_PROTOCOL, /justified by genuinely new work rather than by an administrative step/)
  assert.match(todoReviewSystemPrompt, /never add a new condition, deliverable, or requirement to record, document, or report on the TODO list/)
  const mycroft = renderPlanContext({ planId: "feedback-plan", revision: 1, tasks: [], children: [] } as unknown as IntentPlanOutline)
  assert.match(mycroft, /search for the exact symbol or registration signature first/)
  assert.match(mycroft, /about 150-250 lines/)
  assert.match(mycroft, /submit one completion claim that cites the observation IDs/)
  assert.match(mycroft, /do not create TODO entries to document or report this work/)
  assert.doesNotMatch(mycroft, /create a TODO that documents|record this location in a TODO/i)
})

test("the plan context Mycroft receives lists current accepted facts before the tasks and omits stale ones", async () => {
  const state = await evidenceFixtureFor(TWO_TASKS)
  try {
    const [first] = state.itemIds
    await startItemInReview(state.repository, state.scope, first)
    const observation = await observeRead(state, first, "read-first", EVIDENCE_FILE, 150, sourceLines.slice(149, 220))
    await evaluateTodoReview(state.repository, state.scope, await reviewFor(state, first), countingEvaluator({ count: 0 }), "mock-reviewer", { readCurrentSource: currentWorkspace, hasVerifiedFileChanges: false })

    const outline = (await state.repository.getPlanOutline(state.scope))!
    const facts = await state.repository.listAcceptedEvidence(state.scope)
    const current = renderPlanContext(outline, await assessAcceptedFacts(facts, currentWorkspace))
    assert.ok(current.includes(`observation ${observation.id}`), "the current fact is offered to the next request")
    assert.ok(current.indexOf("Accepted host evidence") < current.indexOf(`- ${first}`), "accepted evidence precedes the task list")
    assert.ok(current.includes("Before editing a file, read its current content"))

    const stale = renderPlanContext(outline, await assessAcceptedFacts(facts, changedWorkspace))
    assert.equal(stale.includes("[current]"), false, "a changed source is never offered as current")
    assert.ok(stale.includes("[historical]"), "the stale fact stays visible as labelled historical context")
    assert.ok(stale.includes(observation.id), "its provenance is preserved")
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("a passed criterion whose named symbol appears in no retained evidence is rejected with that symbol", async () => {
  const state = await evidenceFixture(sourceLocation("wired", "`registerNativeTool` wires `read_file` in src/extension/tools/workspace.ts", "registerNativeTool", "implementation_symbol"))
  try {
    const item = await startInvestigation(state)
    const observation = await observeRead(state, item.id, "read-workspace-partial", EVIDENCE_FILE, 150, sourceLines.slice(149, 200))
    const review = await reviewFor(state, item.id)
    const evaluation = await evaluateTodoReview(state.repository, state.scope, review, async () => responseFor(review, { refs: [observation.id] }), "mock-reviewer", { readCurrentSource: currentWorkspace, hasVerifiedFileChanges: false })
    assert.notEqual((await state.repository.getList({ ...state.scope, includeCompleted: true })).items.find((candidate) => candidate.id === item.id)?.status, "completed")
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("a criterion whose source was never read is rejected as missing, not inferred from search output", async () => {
  const state = await evidenceFixture(sourceLocation("verified", "`read_file` is verified in src/extension/tools/view.ts", "read_file", "registered_tool", "src/extension/tools/view.ts"))
  try {
    const item = await startInvestigation(state)
    const observation = await state.repository.recordToolObservation(state.scope, {
      itemId: item.id,
      toolName: "search_workspace",
      arguments: { query: "read_file", path: "src" },
      output: "search_workspace read_file: 0 hits",
      failed: false,
      requestId: "search-only",
      evidenceOutput: JSON.stringify({ query: "read_file", mode: "text", total: 0, offset: 0, limit: 20, results: [] })
    })
    const review = await reviewFor(state, item.id)
    const evaluation = await evaluateTodoReview(state.repository, state.scope, review, async () => responseFor(review, { refs: [observation.id] }), "mock-reviewer", { hasVerifiedFileChanges: false })
    assert.equal(evaluation.decision, "needs_evidence")
    const [reconciliation] = evaluation.criteria.map((criterion) => criterion.reconciliation)
    assert.equal(reconciliation?.outcome, "unknown", "search output does not prove the source")
    assert.deepEqual(reconciliation?.supportingObservationIds, [], "the search observation supports nothing")
    assert.ok(reconciliation?.missing.some((reason) => reason.includes("src/extension/tools/view.ts")), "the unresolved reason names the missing source")
    assert.ok(evaluation.problems.some((problem) => problem.includes("src/extension/tools/view.ts")))
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("a duplicate tool delivery stores one observation and one evidence record", async () => {
  const state = await evidenceFixture(sourceLocation("defined", "`read_file` is defined in src/extension/tools/workspace.ts", "read_file", "registered_tool"))
  try {
    const item = await startInvestigation(state)
    const first = await observeRead(state, item.id, "same-delivery", EVIDENCE_FILE, 150, sourceLines.slice(149, 200))
    const second = await observeRead(state, item.id, "same-delivery", EVIDENCE_FILE, 150, sourceLines.slice(149, 200))
    assert.equal(second.id, first.id)
    const review = await reviewFor(state, item.id)
    assert.equal(review.observations.length, 1)
    assert.equal(review.retainedEvidence.length, 1)
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("retained evidence survives reopening the store, as it does across an automatic continuation", async () => {
  const state = await evidenceFixture(sourceLocation("defined", "`read_file` is defined in src/extension/tools/workspace.ts", "read_file", "registered_tool"))
  try {
    const item = await startInvestigation(state)
    const observation = await observeRead(state, item.id, "persisted-read", EVIDENCE_FILE, 150, sourceLines.slice(149, 200))
    const reopened = new TodoRepository(state.databasePath, wasmPath)
    const review = await reviewFor({ ...state, repository: reopened }, item.id)
    const retained = review.retainedEvidence.find((entry) => entry.observationId === observation.id)
    assert.ok(retained?.content?.includes("172:     name: \"read_file\","))
    assert.deepEqual(retained?.sources, [{ path: EVIDENCE_FILE, startLine: 150, endLine: 200, totalLines: 850, contentHash: await fingerprintContent(workspaceText) }])
    assert.equal(review.observations.find((entry) => entry.id === observation.id)?.evidence?.retained, true)
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("evidence evicted by the storage budget is reported as evicted, never as covered", async () => {
  const size = preserveEvidence(await readOutput(EVIDENCE_FILE, 150, sourceLines.slice(149, 200))).preservedChars
  const state = await evidenceFixture(sourceLocation("defined", "`read_file` is defined in src/extension/tools/workspace.ts", "read_file", "registered_tool"), Math.ceil(size * 1.5))
  try {
    const item = await startInvestigation(state)
    const evicted = await observeRead(state, item.id, "first-read", EVIDENCE_FILE, 150, sourceLines.slice(149, 200))
    await observeRead(state, item.id, "second-read", "src/extension/tools/other.ts", 1, sourceLines.slice(0, 51))
    const review = await reviewFor(state, item.id)
    assert.equal(review.observations.find((entry) => entry.id === evicted.id)?.evidence?.retained, false)
    assert.equal(review.retainedEvidence.find((entry) => entry.observationId === evicted.id)?.content, undefined)
    const evaluation = await evaluateTodoReview(state.repository, state.scope, review, async () => responseFor(review, { refs: [evicted.id] }), "mock-reviewer", { hasVerifiedFileChanges: false })
    assert.equal(evaluation.decision, "needs_evidence")
    assert.ok(evaluation.problems.some((problem) => problem.includes("evicted")))
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("an in-review claim is queued for Feedback and approval completes it with verified evidence", async () => {
  const state = await fixture([{ id: "locate_native_read_file_tool_definition", criteria: [{ id: "located", description: "The read_file definition is located", verification: { kind: "semantic_review" } }] }], false)
  try {
    const item = state.items[0]
    const observation = await addObservation(state.repository, state.scope, item.id)
    const claim = await state.repository.claimCompletion(state.scope, { itemId: item.id, expectedVersion: item.version, requestId: "claim-approve" })
    assert.equal(claim.disposition, "accepted")
    assert.equal(claim.review, "feedback_turn_end")

    const candidates = reviewCandidates(await state.repository.getReviewPackages(state.scope))
    assert.equal(candidates.length, 1)
    assert.equal(candidates[0].task.id, item.id)

    const evaluation = await evaluateTodoReview(state.repository, state.scope, candidates[0], async () => responseFor(candidates[0], { refs: [observation.id] }), "mock-reviewer")
    assert.equal(evaluation.decision, "accept")
    const approved = (await state.repository.getItem(state.scope, item.id)).item
    assert.equal(approved.status, "completed")
    assert.equal(approved.verification, "passed")
    assert.equal(reviewCandidates(await state.repository.getReviewPackages(state.scope)).length, 0)
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("a rejected claim returns corrective instructions and is not re-claimed without new evidence", async () => {
  const state = await fixture([{ id: "trace_read_file_dispatch", criteria: [{ id: "dispatch", description: "The dispatch path is traced", verification: { kind: "semantic_review" } }] }], false)
  try {
    const item = state.items[0]
    const observation = await addObservation(state.repository, state.scope, item.id)
    await state.repository.claimCompletion(state.scope, { itemId: item.id, expectedVersion: item.version, requestId: "claim-reject" })
    const review = reviewCandidates(await state.repository.getReviewPackages(state.scope))[0]
    const evaluation = await evaluateTodoReview(state.repository, state.scope, review,
      async () => responseFor(review, { decision: "revise", status: "failed", refs: [observation.id], correctiveInstructions: ["Cite the dispatch lines for the read_file case."] }), "mock-reviewer")
    assert.equal(evaluation.decision, "revise")
    const revised = (await state.repository.getItem(state.scope, item.id)).item
    assert.equal(revised.status, "in_progress")

    await assert.rejects(
      state.repository.claimCompletion(state.scope, { itemId: item.id, expectedVersion: revised.version, requestId: "claim-unchanged" }),
      /Cite the dispatch lines for the read_file case/
    )

    const fresh = await addObservation(state.repository, state.scope, item.id, "search_workspace")
    const current = (await state.repository.getItem(state.scope, item.id)).item
    const reclaimed = await state.repository.claimCompletion(state.scope, { itemId: item.id, expectedVersion: current.version, requestId: "claim-with-evidence" })
    assert.equal(reclaimed.disposition, "accepted")
    assert.ok(fresh.id)
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("a claimed plan task is reviewed through the candidate rule and sibling observations stay visible to it", async () => {
  const state = await fixture([
    { id: "locate_native_read_file_tool_definition", criteria: [{ id: "located", description: "The read_file definition is located", verification: { kind: "semantic_review" } }] },
    { id: "trace_read_file_dispatch", criteria: [{ id: "dispatch", description: "The dispatch path is traced", verification: { kind: "semantic_review" } }] }
  ], false)
  try {
    const [first, second] = state.items
    const observation = await addObservation(state.repository, state.scope, first.id)
    await state.repository.claimCompletion(state.scope, { itemId: second.id, expectedVersion: second.version, requestId: "claim-sibling" })
    const reviews = await state.repository.getReviewPackages(state.scope)
    const review = reviewCandidates(reviews, second.id)[0]
    assert.ok(review, "the claimed sibling is a review candidate")
    assert.ok(review.observations.some((entry) => entry.id === observation.id && entry.itemId === first.id), "sibling observation remains available for reuse")
    assert.equal(reviewCandidates(reviews, first.id).length, 0, "an unclaimed task is not sent to Feedback")
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

const childProposalFixture = () => fixture([
  { id: "locate_source_definition", criteria: [{ id: "definition", description: "The definition is located", verification: { kind: "semantic_review" } }] },
  { id: "trace_source_dispatch", criteria: [{ id: "dispatch", description: "The dispatch path is traced", verification: { kind: "semantic_review" } }] }
], false)

const countingReview = (decision: ChildTodoDecision): { review: ChildTodoReview; calls: () => number } => {
  let calls = 0
  return {
    review: async () => {
      calls += 1
      return { ok: true, decision }
    },
    calls: () => calls
  }
}

const childArgs = (parentId: string, title: string, requestId: string) => ({
  title,
  request_id: requestId,
  todo_parent_id: parentId,
  details: `Complete ${title.toLowerCase()} for the parent task.`,
  reason: "The parent cannot finish without this step."
})

const createTool = (state: Awaited<ReturnType<typeof fixture>>, options: { review?: ChildTodoReview; isUserAuthorized?: () => boolean } = {}) =>
  todoWorkspaceTools(state.repository, state.scope, () => undefined, options).tools.find((candidate) => candidate.name === "twinny_todo_create")!

test("agent-created TODOs under a plan need a valid parent and never become root tasks", async () => {
  const state = await childProposalFixture()
  try {
    const { review, calls } = countingReview({ decision: "accepted", instruction: "Create it." })
    const tool = createTool(state, { review })
    const before = await state.repository.getPlanOutline(state.scope)

    const missing = await tool.run({ title: "Inspect the validation helper", request_id: "no-parent" })
    assert.equal(missing.failed, true)
    assert.match(missing.output, /todo_parent_id is required/)

    const invalid = await tool.run(childArgs("not-a-plan-item", "Inspect the validation helper", "bad-parent"))
    assert.equal(invalid.failed, true)
    assert.match(invalid.output, /todo_parent_id must name an active TODO/)

    assert.equal(calls(), 0, "Feedback is not consulted for an invalid proposal")
    const after = await state.repository.getPlanOutline(state.scope)
    assert.equal(after?.revision, before?.revision)
    assert.equal(after?.children.length, 0)
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("an accepted proposal creates exactly one child, bumps the plan revision, and adds no dependency", async () => {
  const state = await childProposalFixture()
  try {
    const { review, calls } = countingReview({ decision: "accepted", instruction: "Create it under the parent." })
    const tool = createTool(state, { review })
    const before = await state.repository.getPlanOutline(state.scope)

    const output = JSON.parse((await tool.run(childArgs(state.items[0].id, "Inspect the validation helper", "accept-1"))).output)
    assert.equal(output.ok, true)
    assert.equal(output.result, "accepted")
    assert.equal(output.next_action, "continue")
    assert.equal(output.plan_revision, (before?.revision ?? 0) + 1)

    const after = await state.repository.getPlanOutline(state.scope)
    assert.equal(after?.children.length, 1)
    assert.equal(after?.children[0].itemId, output.item_id)
    assert.equal(after?.children[0].parentItemId, state.items[0].id)
    assert.equal(after?.tasks.length, before?.tasks.length, "the child is not a plan task")
    assert.equal(after?.tasks.every((task) => task.awaitingDependencies.length === 0), true, "parent/child adds no dependencies")
    const nextRequestContext = renderPlanContext(after!)
    assert.match(nextRequestContext, new RegExp(`revision ${output.plan_revision}\\b`))
    assert.match(nextRequestContext, /Inspect the validation helper/)
    assert.equal(calls(), 1)
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("an existing-task decision returns the matching plan task and creates nothing", async () => {
  const state = await childProposalFixture()
  try {
    const tool = createTool(state, { review: countingReview({ decision: "existing_task", itemId: state.items[1].id, instruction: "Covered by the dispatch task." }).review })
    const before = await state.repository.getPlanOutline(state.scope)
    const output = JSON.parse((await tool.run(childArgs(state.items[0].id, "Inspect the validation helper", "existing-1"))).output)
    assert.equal(output.result, "existing_task")
    assert.equal(output.item_id, state.items[1].id)
    assert.equal(output.next_action, "use_existing_task")
    const after = await state.repository.getPlanOutline(state.scope)
    assert.equal(after?.children.length, 0)
    assert.equal(after?.revision, before?.revision)
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("a rejected proposal creates no TODO and is a normal decision, not a tool failure", async () => {
  const state = await childProposalFixture()
  try {
    const tool = createTool(state, { review: countingReview({ decision: "rejected", instruction: "Outside the investigation." }).review })
    const run = await tool.run(childArgs(state.items[0].id, "Inspect the validation helper", "reject-1"))
    assert.equal(run.failed, undefined)
    const output = JSON.parse(run.output)
    assert.equal(output.result, "rejected")
    assert.equal(output.next_action, "do_not_create_task")
    assert.equal((await state.repository.getPlanOutline(state.scope))?.children.length, 0)
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("unavailable Feedback never authorizes a mutation", async () => {
  const state = await childProposalFixture()
  try {
    const failing = createTool(state, { review: async () => ({ ok: false, error: "the provider timed out" }) })
    const unavailable = await failing.run(childArgs(state.items[0].id, "Inspect the validation helper", "unavailable-1"))
    assert.equal(unavailable.failed, true)
    assert.equal(JSON.parse(unavailable.output).result, "feedback_unavailable")

    const unconfigured = await createTool(state).run(childArgs(state.items[0].id, "Inspect the validation helper", "unavailable-2"))
    assert.equal(unconfigured.failed, true)

    assert.equal((await state.repository.getPlanOutline(state.scope))?.children.length, 0)
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("duplicate proposals are idempotent and never reach Feedback twice", async () => {
  const state = await childProposalFixture()
  try {
    const { review, calls } = countingReview({ decision: "accepted", instruction: "Create it." })
    const tool = createTool(state, { review })
    const first = JSON.parse((await tool.run(childArgs(state.items[0].id, "Inspect the validation helper", "dup-1"))).output)
    const retry = JSON.parse((await tool.run(childArgs(state.items[0].id, "Inspect the validation helper", "dup-1"))).output)
    const repeat = JSON.parse((await tool.run(childArgs(state.items[0].id, "Inspect the validation helper", "dup-2"))).output)
    assert.equal(retry.item_id, first.item_id)
    assert.equal(repeat.item_id, first.item_id)
    assert.equal(calls(), 1)
    assert.equal((await state.repository.getPlanOutline(state.scope))?.children.length, 1)
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("stopping during Feedback review applies nothing even when Feedback accepts", async () => {
  const state = await childProposalFixture()
  try {
    const controller = new AbortController()
    const tool = createTool(state, {
      review: async () => {
        controller.abort()
        return { ok: true, decision: { decision: "accepted", instruction: "Create it." } }
      }
    })
    const run = await tool.run(childArgs(state.items[0].id, "Inspect the validation helper", "stop-1"), { signal: controller.signal })
    assert.equal(run.failed, true)
    assert.match(run.output, /nothing was created/)
    assert.equal((await state.repository.getPlanOutline(state.scope))?.children.length, 0)
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("a parent is not verified because its accepted child completed", async () => {
  const state = await childProposalFixture()
  try {
    const tool = createTool(state, { review: countingReview({ decision: "accepted", instruction: "Create it." }).review })
    const created = JSON.parse((await tool.run(childArgs(state.items[0].id, "Inspect the validation helper", "parent-1"))).output)
    const child = (await state.repository.getItem(state.scope, created.item_id)).item
    await state.repository.updateItem(state.scope, {
      itemId: child.id,
      expectedVersion: child.version,
      patch: { status: "completed" },
      actor: "model",
      requestId: "child-claim"
    })
    const outline = await state.repository.getPlanOutline(state.scope)
    const parent = outline?.tasks.find((task) => task.itemId === state.items[0].id)
    assert.equal(parent?.verification, "not_checked")
    assert.notEqual(parent?.status, "completed")
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("explicit user-directed TODO creation under a plan remains supported", async () => {
  const state = await childProposalFixture()
  try {
    const { review, calls } = countingReview({ decision: "rejected", instruction: "Not used." })
    const tool = createTool(state, { review, isUserAuthorized: () => true })
    const output = JSON.parse((await tool.run({ title: "Add a TODO for the release notes", request_id: "user-todo" })).output)
    assert.equal(output.result, "created")
    assert.equal(calls(), 0, "a user-directed request bypasses the autonomous proposal review")
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("a plan revision made while a child proposal is under review is applied at the tool boundary, and a removed parent creates no child", async () => {
  const state = await childProposalFixture()
  try {
    const parent = (await state.repository.getList(state.scope)).items.find((item) => item.title === "locate_source_definition")!
    const tasks = (criterion: string): Parameters<typeof plan>[0] => [
      { id: "locate_source_definition", criteria: [semantic("locate", criterion)] },
      { id: "trace_source_dispatch", criteria: [{ id: "dispatch", description: "The dispatch path is traced", verification: { kind: "semantic_review" } }] }
    ]
    const gated = () => {
      let release!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      let markStarted!: () => void
      const started = new Promise<void>((resolve) => { markStarted = resolve })
      const review: ChildTodoReview = async () => {
        markStarted()
        await gate
        return { ok: true, decision: { decision: "accepted", instruction: "Accepted under the parent." } }
      }
      return { review, started, release }
    }

    const revisedGate = gated()
    const revisedTool = createTool(state, { review: revisedGate.review })
    const revisedRun = revisedTool.run(childArgs(parent.id, "Trace the definition caller", "race-revise"))
    await revisedGate.started
    const revisedPlan = { ...plan(tasks("The definition is located and its callers are listed")), revision: 2 }
    await state.repository.synchronizeIntentPlan(state.scope, revisedPlan, { prompt: "Verify the requested work" })
    revisedGate.release()
    const accepted = JSON.parse((await revisedRun).output)
    assert.equal(accepted.result, "accepted")
    assert.equal(accepted.plan_revision, 3, "the child is applied against the revision current at the tool boundary")
    const afterAccept = await state.repository.getList(state.scope)
    assert.equal(afterAccept.items.filter((item) => item.title === "Trace the definition caller").length, 1)
    assert.equal(afterAccept.items.find((item) => item.id === parent.id)?.title, "locate_source_definition")

    const removedGate = gated()
    const removedTool = createTool(state, { review: removedGate.review })
    const removedRun = removedTool.run(childArgs(parent.id, "Trace the removed branch", "race-removed"))
    await removedGate.started
    const removedPlan = { ...plan([{ id: "trace_source_dispatch", criteria: [{ id: "dispatch", description: "The dispatch path is traced", verification: { kind: "semantic_review" } }] }]), revision: 4 }
    await state.repository.synchronizeIntentPlan(state.scope, removedPlan, { prompt: "Verify the requested work" })
    removedGate.release()
    const rejected = await removedRun
    assert.equal(rejected.failed, true, "a parent removed from the plan during review cannot receive a child")
    assert.equal((await state.repository.getList(state.scope)).items.some((item) => item.title === "Trace the removed branch"), false)
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("workflow text about TODO tracking never authorizes a root-level task under a plan; the user's own request does", async () => {
  const state = await childProposalFixture()
  try {
    const { review, calls } = countingReview({ decision: "accepted", instruction: "Create it." })
    const workflowMessage = "Feedback and TODO requirements\nUse the available native TODO system to track this investigation.\nCreate actionable TODOs before beginning the investigation."
    const workflowTool = createTool(state, { review, isUserAuthorized: () => userRequestsTodoCreation(workflowMessage) })
    const rootAttempt = await workflowTool.run({ title: "Create actionable TODOs for the investigation", request_id: "workflow-root" })
    assert.equal(rootAttempt.failed, true)
    assert.match(rootAttempt.output, /todo_parent_id is required/)
    assert.equal((await state.repository.getPlanOutline(state.scope))?.children.length, 0, "no root task was created")
    assert.equal(calls(), 0)

    const requestTool = createTool(state, { review, isUserAuthorized: () => userRequestsTodoCreation("Please create a TODO to track the release notes.") })
    const created = JSON.parse((await requestTool.run({ title: "Track the release notes", request_id: "user-root" })).output)
    assert.equal(created.result, "created")
    assert.equal(calls(), 0, "the explicit user request is not a Feedback proposal")
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("an administrative child proposal is refused before any model review and creates nothing", async () => {
  const state = await childProposalFixture()
  try {
    let modelCalls = 0
    const reviewer = new ChildTodoReviewer({
      resolve: () => ({
        ok: true,
        endpoint: {
          infer: async () => {
            modelCalls += 1
            return JSON.stringify({ decision: "accepted", instruction: "Create it." })
          },
          provider: "scripted",
          model: "feedback-model",
          label: "Scripted"
        }
      })
    })
    const tool = createTool(state, { review: (proposal, context, signal) => reviewer.review(proposal, context, signal) })
    const before = (await state.repository.getPlanOutline(state.scope))?.children.length
    const refused = await tool.run(childArgs(state.items[0].id, "Log the definition location as a TODO entry", "admin-child"))
    assert.equal(refused.failed, true)
    assert.match(refused.output, /TODO administration/)
    assert.equal(modelCalls, 0, "the administrative proposal never reaches the model")
    assert.equal((await state.repository.getPlanOutline(state.scope))?.children.length, before, "no child was created")

    const concrete = await tool.run(childArgs(state.items[0].id, "Inspect the validation helper", "concrete-child"))
    assert.equal(concrete.failed, undefined)
    assert.equal(modelCalls, 1, "a concrete proposal is reviewed by Feedback")
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("umbrella creates restating several plan tasks reuse the plan while distinct subtasks are created", async () => {
  const state = await fixture([
    { id: "locate_read_file_definition", criteria: [{ id: "located", description: "The read_file definition is located", verification: { kind: "semantic_review" } }] },
    { id: "identify_tool_registration", criteria: [{ id: "registration", description: "The registration array includes readFile", verification: { kind: "semantic_review" } }] },
    { id: "trace_dispatch_implementation", criteria: [{ id: "reaches", description: "Dispatch reaches the implementation", verification: { kind: "semantic_review" } }] }
  ], false)
  try {
    const tools = todoWorkspaceTools(state.repository, state.scope, () => undefined, { review: acceptingReview }).tools
    const create = (title: string, requestId: string, parentId?: string) => tools.find((candidate) => candidate.name === "twinny_todo_create")!.run({
      title,
      request_id: requestId,
      ...(parentId ? { todo_parent_id: parentId, details: "Validate the argument types before the read.", reason: "The read path needs this check." } : {})
    }).then((output) => JSON.parse(output.output))

    const umbrella = await create("Investigate read_file registration and dispatch", "umbrella-create")
    assert.equal(umbrella.result, "existing_task")
    assert.equal(umbrella.matched_by, "plan_umbrella")
    assert.equal(state.items.some((item) => item.id === umbrella.item_id), true)

    const distinct = await create("Validate argument types before reading", "distinct-create", state.items[0].id)
    assert.equal(distinct.result, "accepted")
    assert.equal(state.items.some((item) => item.id === distinct.item_id), false)
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("native TODO tools acknowledge claims once, reuse plan tasks, and never let the model approve its own work", async () => {
  const state = await fixture([{ id: "locate_native_read_file_tool_definition", criteria: [{ id: "located", description: "The read_file definition is located", verification: { kind: "semantic_review" } }] }], false)
  try {
    const item = state.items[0]
    const tools = todoWorkspaceTools(state.repository, state.scope, () => undefined, { review: acceptingReview }).tools
    const tool = (name: string) => tools.find((candidate) => candidate.name === name)!
    const update = (args: Record<string, string>) => tool("twinny_todo_update").run(args).then((output) => JSON.parse(output.output))

    const claim = await update({ item_id: item.id, expected_version: String(item.version), request_id: "todo1-update", status: "completed" })
    assert.equal(claim.ok, true)
    assert.equal(claim.claim, "accepted")
    assert.equal(claim.task_status, "in_review")
    assert.equal(claim.verification, "pending")
    assert.equal(claim.retry_required, false)
    assert.equal(claim.review, "feedback_turn_end")

    const replay = await update({ item_id: item.id, expected_version: String(item.version), request_id: "todo1-update", status: "completed" })
    assert.deepEqual(replay, claim)

    const repeated = await update({ item_id: item.id, expected_version: String(item.version), request_id: "todo1-update-2", status: "completed" })
    assert.equal(repeated.claim, "already_submitted")
    assert.equal(repeated.version, claim.version)
    assert.equal(repeated.retry_required, false)

    const mixed = await tool("twinny_todo_update").run({ item_id: item.id, expected_version: String(claim.version), request_id: "mixed", status: "completed", title: "Renamed" })
    assert.equal(mixed.failed, true)
    assert.match(mixed.output, /must not change other fields/)

    const duplicate = JSON.parse((await tool("twinny_todo_create").run({ title: "Locate the native read_file definition in workspace", request_id: "dup-create" })).output)
    assert.equal(duplicate.result, "existing_task")
    assert.equal(duplicate.item_id, item.id)
    assert.equal(duplicate.next_action, "use_existing_task")
    assert.equal(duplicate.matched_by, "plan_overlap")

    const created = JSON.parse((await tool("twinny_todo_create").run({ title: "Trace dispatch to implementation", request_id: "new-subtask", todo_parent_id: item.id, details: "Follow dispatch to the read_file implementation.", reason: "The read path needs this step." })).output)
    assert.equal(created.result, "accepted")
    assert.notEqual(created.item_id, item.id)

    const stored = (await state.repository.getItem(state.scope, item.id)).item
    assert.equal(stored.status, "in_review", "a model claim never reaches completed")
    assert.equal(stored.version, claim.version)
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

const EVIDENCE_REQUEST = "Check the project's accepted evidence first, then locate the native read_file implementation and report its path, line range, and fingerprint."
const READ_FILE_SOURCE = "src/extension/tools/workspace.ts"
const LOCATE_CRITERION = "The native `read_file` tool is declared and registered in src/extension/tools/workspace.ts"
const READ_CRITERION = "Read the implementation and obtain its fingerprint"
const realWorkspaceSource = fs.readFileSync(path.join(process.cwd(), READ_FILE_SOURCE), "utf8")
const overlappingPlan: Parameters<typeof plan>[0] = [{ id: "locate", criteria: [{ id: "locate", description: LOCATE_CRITERION, verification: { kind: "source_location", identity: "registered_tool", symbol: "read_file", path: "src/extension/tools/workspace.ts" } }] }, { id: "read", criteria: [{ id: "read", description: READ_CRITERION, verification: { kind: "source_fingerprint", identity: "implementation_symbol", symbol: "readFile", path: "src/extension/tools/workspace.ts" } }] }]
type FeedbackFixture = Awaited<ReturnType<typeof fixture>>

const sourceWorkspace = (text = realWorkspaceSource) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-read-file-"))
  fs.mkdirSync(path.join(root, path.dirname(READ_FILE_SOURCE)), { recursive: true })
  fs.writeFileSync(path.join(root, READ_FILE_SOURCE), text)
  return root
}
const sourceReader = (root: string): CurrentSourceReader => async (file) => {
  const absolute = path.join(root, file)
  return fs.existsSync(absolute) ? fs.readFileSync(absolute, "utf8") : undefined
}
/** Runs the production native read_file tool, the only source of trusted read output. */
const runReadFile = async (root: string, reads: { count: number }, start = "169", end = "220") => {
  reads.count += 1
  const tool = workspaceTools(root).tools.find((candidate) => candidate.name === "read_file")!
  const args = { path: READ_FILE_SOURCE, start_line: start, end_line: end }
  return { args, result: await tool.run(args) }
}
/** Records the observation the way the chat loop does: the raw tool output is kept as evidenceOutput. */
const recordRead = (state: FeedbackFixture, itemId: string, requestId: string, read: Awaited<ReturnType<typeof runReadFile>>) =>
  state.repository.recordToolObservation(state.scope, {
    itemId,
    toolName: "read_file",
    arguments: read.args,
    output: read.result.summary ?? "read",
    failed: false,
    requestId,
    evidenceOutput: read.result.output
  })
const itemTitled = (state: FeedbackFixture, title: string) => state.items.find((item) => item.title === title)!
const claimTask = (state: FeedbackFixture, title: string, requestId: string) => {
  const item = itemTitled(state, title)
  return state.repository.updateItem(state.scope, { itemId: item.id, expectedVersion: item.version, patch: { status: "in_review" }, actor: "model", requestId })
}
const reviewOf = async (state: FeedbackFixture, itemId: string) =>
  (await state.repository.getReviewPackages(state.scope)).find((candidate) => candidate.task.id === itemId)!
const statusOf = async (state: FeedbackFixture, title: string) => (await state.repository.getItem(state.scope, itemTitled(state, title).id)).item.status
/** One real read of the registration, then the host's deterministic verdict on the locate TODO. Feedback must never be asked. */
const establishFact = async (state: FeedbackFixture, workspace: string, reads: { count: number }) => {
  await claimTask(state, "locate", "locate-claim")
  const read = await runReadFile(workspace, reads)
  const observation = await recordRead(state, itemTitled(state, "locate").id, "locate-read", read)
  const verdict = await evaluateTodoReview(state.repository, state.scope, await reviewOf(state, itemTitled(state, "locate").id), async () => {
    throw new Error("Feedback must not judge objective source criteria")
  }, "mock-reviewer", { readCurrentSource: sourceReader(workspace) })
  return { observation, verdict }
}
const removeAll = (...paths: string[]) => paths.forEach((target) => fs.rmSync(target, { recursive: true, force: true }))

test("Scenario A: one trusted read_file observation establishes the locate fact and completes the overlapping read TODO without another read", async () => {
  const workspace = sourceWorkspace()
  const reads = { count: 0 }
  const state = await fixture(overlappingPlan, false, EVIDENCE_REQUEST)
  const logs: string[] = []
  const originalInfo = logger.info
  logger.info = (message: string) => { logs.push(message) }
  try {
    const preflight = await evidencePreflight(EVIDENCE_REQUEST, await state.repository.listAcceptedEvidence(state.scope), sourceReader(workspace))
    assert.equal(preflight.status, "missing")

    const { observation, verdict } = await establishFact(state, workspace, reads)
    assert.equal(verdict.decision, "accept")
    assert.ok(logs.some((line) => line.includes("source=deterministic")), "the locate TODO is judged by the host")
    assert.equal(await statusOf(state, "locate"), "completed")

    const fact = (await state.repository.listAcceptedEvidence(state.scope)).find((candidate) => candidate.path === READ_FILE_SOURCE)
    assert.ok(fact, "the trusted observation is promoted to a persisted accepted fact")
    assert.equal(fact.observationId, observation.id)
    assert.equal(fact.sourceHash, await fingerprintContent(realWorkspaceSource), "the fingerprint is the one read_file reported")
    assert.ok(fact.startLine >= 169 && fact.endLine <= 220, `fact lies within the requested read: ${fact.startLine}-${fact.endLine}`)

    const completed = await completeProvenReviews(state.repository, state.scope, sourceReader(workspace))
    assert.deepEqual(completed, ["read"])
    assert.equal(await statusOf(state, "read"), "completed")
    assert.equal(reads.count, 1, "the overlapping TODO needs no second read")
    assert.ok(logs.some((line) => line.includes("[Evidence] completed read")), "completion is attributed to trusted facts")
  } finally {
    logger.info = originalInfo
    removeAll(state.directory, workspace)
  }
})

test("Scenario B: a reopened repository in a new conversation resolves the persisted fact before any search", async () => {
  const workspace = sourceWorkspace()
  const reads = { count: 0 }
  const first = await fixture(overlappingPlan, false, EVIDENCE_REQUEST)
  try {
    const { observation } = await establishFact(first, workspace, reads)

    const reopened = new TodoRepository(first.databasePath, wasmPath)
    const scope = { projectFingerprint: first.scope.projectFingerprint, conversationId: "second-chat", writer: "second-chat" }
    await reopened.synchronizeIntentPlan(scope, plan(overlappingPlan, EVIDENCE_REQUEST), { prompt: EVIDENCE_REQUEST })
    const facts = await reopened.listAcceptedEvidence(scope)
    const preflight = await evidencePreflight(EVIDENCE_REQUEST, facts, sourceReader(workspace))
    assert.equal(preflight.status, "fresh")
    const fact = facts.find((candidate) => candidate.path === READ_FILE_SOURCE)!
    assert.equal(fact.observationId, observation.id, "original provenance is preserved")
    assert.equal(fact.conversationId, first.scope.conversationId)
    assert.ok(renderEvidencePreflight(preflight).includes(fact.sourceHash), "the injected preflight carries the fingerprint")

    const completed = await completeProvenReviews(reopened, scope, sourceReader(workspace))
    assert.deepEqual(completed.sort(), ["locate", "read"])
    assert.equal(reads.count, 1, "the new conversation issues no read")
  } finally {
    removeAll(first.directory, workspace)
  }
})

const FILENAME_CRITERION = "The filename of the implementation is identified"
const RANGE_CRITERION = "The implementation line range (start and end line numbers) is specified"
const FINGERPRINT_CRITERION = "The authoritative source fingerprint is obtained via read_file"
const NO_MODIFICATION_CRITERION = "No files are modified during the process"
const SEMANTIC_CRITERION = "The implementation handles malformed input gracefully"
const LIVE_TASK = "Locate the native read_file implementation"
const LIVE_CRITERIA: TypedCriterion[] = [
  { id: "filename", description: FILENAME_CRITERION, verification: { kind: "source_location", identity: "implementation_symbol", symbol: "readFile", path: READ_FILE_SOURCE } },
  { id: "range", description: RANGE_CRITERION, verification: { kind: "source_range", identity: "implementation_symbol", symbol: "readFile", path: READ_FILE_SOURCE } },
  { id: "fingerprint", description: FINGERPRINT_CRITERION, verification: { kind: "source_fingerprint", identity: "implementation_symbol", symbol: "readFile", path: READ_FILE_SOURCE } },
  { id: "no-modification", description: NO_MODIFICATION_CRITERION, verification: { kind: "execution_invariant", invariant: "no_mutating_tool_calls" } }
]
const livePlan = [{ id: "locate-native-read-file", title: LIVE_TASK, criteria: LIVE_CRITERIA }]

test("live regression: planner criteria are resolved by the host from one authoritative read, and the TODO completes without Feedback or continuation", async () => {
  const workspace = sourceWorkspace()
  const reads = { count: 0 }
  const state = await fixture(livePlan, false, EVIDENCE_REQUEST)
  try {
    const preflight = await evidencePreflight(EVIDENCE_REQUEST, await state.repository.listAcceptedEvidence(state.scope), sourceReader(workspace))
    assert.equal(preflight.status, "missing")

    await claimTask(state, LIVE_TASK, "live-claim")
    const read = await runReadFile(workspace, reads, "169", "220")
    const observation = await recordRead(state, itemTitled(state, LIVE_TASK).id, "live-read", read)
    let evaluatorCalls = 0
    const verdict = await evaluateTodoReview(state.repository, state.scope, await reviewOf(state, itemTitled(state, LIVE_TASK).id), async () => {
      evaluatorCalls += 1
      throw new Error("Feedback must not judge criteria the host has proven")
    }, "mock-reviewer", { readCurrentSource: sourceReader(workspace) })
    assert.equal(evaluatorCalls, 0)
    assert.equal(verdict.decision, "accept")
    assert.deepEqual(verdict.criteria.map((criterion) => criterion.status), ["passed", "passed", "passed", "passed"])

    const [filename, range, fingerprint, prohibition] = verdict.criteria.map((criterion) => criterion.reconciliation!)
    assert.equal(filename.outcome, "proven")
    assert.deepEqual(filename.supportingObservationIds, [observation.id])
    assert.equal(range.outcome, "proven")
    assert.equal(fingerprint.outcome, "proven")
    assert.equal(prohibition.outcome, "proven", "a read modifies nothing, so the prohibition holds")
    assert.match(prohibition.scope ?? "", /shell/, "the claim is bounded to operations Twinny controls")

    const fact = (await state.repository.listAcceptedEvidence(state.scope)).find((candidate) => candidate.path === READ_FILE_SOURCE)!
    assert.equal(fact.startLine, 169)
    assert.equal(fact.endLine, 220)
    assert.equal(fact.sourceHash, await fingerprintContent(realWorkspaceSource))
    assert.equal(await statusOf(state, LIVE_TASK), "completed")

    assert.deepEqual(await completeProvenReviews(state.repository, state.scope, sourceReader(workspace)), [], "nothing remains to complete, so no continuation is needed")
    assert.equal(evaluatorCalls, 0)
    assert.equal(reads.count, 1, "one authoritative read establishes every source fact")

    const reopened = new TodoRepository(state.databasePath, wasmPath)
    const later = { projectFingerprint: state.scope.projectFingerprint, conversationId: "later-chat", writer: "later-chat" }
    await reopened.synchronizeIntentPlan(later, plan(livePlan, EVIDENCE_REQUEST), { prompt: EVIDENCE_REQUEST })
    const laterPreflight = await evidencePreflight(EVIDENCE_REQUEST, await reopened.listAcceptedEvidence(later), sourceReader(workspace))
    assert.equal(laterPreflight.status, "fresh")
    assert.ok(renderEvidencePreflight(laterPreflight).includes(fact.sourceHash), "the next conversation receives the fingerprint")
  } finally {
    removeAll(state.directory, workspace)
  }
})

test("live regression: a reviewer rejection that claims every criterion is satisfied cannot overturn host-proven facts, and its explanation stays distinct from its decision", async () => {
  const workspace = sourceWorkspace()
  const reads = { count: 0 }
  const state = await fixture([{ id: "locate-native-read-file", title: LIVE_TASK, criteria: [...LIVE_CRITERIA, { id: "semantic", description: SEMANTIC_CRITERION, verification: { kind: "semantic_review" } }] }], false, EVIDENCE_REQUEST)
  try {
    await claimTask(state, LIVE_TASK, "contradiction-claim")
    const read = await runReadFile(workspace, reads, "169", "220")
    const observation = await recordRead(state, itemTitled(state, LIVE_TASK).id, "contradiction-read", read)
    const review = await reviewOf(state, itemTitled(state, LIVE_TASK).id)
    const explanation = "Rejected, although every mandatory criterion is satisfied by the observations."
    const contradictory = JSON.stringify({
      schemaVersion: 1,
      taskId: review.planTaskId,
      decision: "revise",
      criteria: semanticEntries(review, "failed", [observation.id]),
      problems: [],
      correctiveInstructions: ["Explain how the semantic criterion is satisfied by the read."],
      explanation,
      scores: { completion: 6, correctness: 6, alignment: 6 }
    })
    let evaluatorCalls = 0
    const verdict = await evaluateTodoReview(state.repository, state.scope, review, async () => {
      evaluatorCalls += 1
      return contradictory
    }, "mock-reviewer", { readCurrentSource: sourceReader(workspace) })

    assert.equal(evaluatorCalls, 1, "only the semantic criterion is left for Feedback")
    const liveIds = LIVE_CRITERIA.map((criterion) => criterion.id)
    const objective = verdict.criteria.filter((criterion) => liveIds.includes(criterion.criterionId))
    assert.deepEqual(objective.map((criterion) => criterion.status), ["passed", "passed", "passed", "passed"], "host-proven criteria are not demoted by the reviewer")
    assert.equal(verdict.criteria.find((criterion) => criterion.criterionId === "semantic")!.status, "failed")
    assert.equal(verdict.decision, "revise", "a genuinely failed semantic criterion keeps the decision open")
    assert.equal(verdict.explanation, explanation, "the reviewer's explanation is preserved as prose, not as proof")
    assert.equal(await statusOf(state, LIVE_TASK), "in_progress", "the TODO is sent back for work, not completed, from the contradictory verdict")
  } finally {
    removeAll(state.directory, workspace)
  }
})

test("a provenance criterion about a subject the task never names is not resolved by the host and goes to Feedback", async () => {
  const workspace = sourceWorkspace()
  const reads = { count: 0 }
  const state = await fixture([{ id: "locate-native-read-file", title: LIVE_TASK, criteria: [{ id: "cache-filename", description: "The filename of the cache is identified", verification: { kind: "semantic_review" } }] }], false, EVIDENCE_REQUEST)
  try {
    await claimTask(state, LIVE_TASK, "cache-claim")
    const read = await runReadFile(workspace, reads, "169", "220")
    await recordRead(state, itemTitled(state, LIVE_TASK).id, "cache-read", read)
    let evaluatorCalls = 0
    await evaluateTodoReview(state.repository, state.scope, await reviewOf(state, itemTitled(state, LIVE_TASK).id), async () => {
      evaluatorCalls += 1
      throw new Error("Feedback review requested")
    }, "mock-reviewer", { readCurrentSource: sourceReader(workspace) }).catch(() => undefined)
    assert.equal(evaluatorCalls, 1, "an unanchored subject is a judgment, not a host fact")
    assert.notEqual(await statusOf(state, LIVE_TASK), "completed")
  } finally {
    removeAll(state.directory, workspace)
  }
})

const LOOKUP_DONE: TypedCriterion = { id: "lookup", description: "The project-wide accepted-evidence lookup is completed", verification: { kind: "evidence_lookup_completed" } }
const FACT_EXISTS: TypedCriterion = { id: "fact", description: "An accepted fact for readFile exists", verification: { kind: "accepted_fact_exists", identity: "implementation_symbol", symbol: "readFile" } }
const evidenceCheck = (args: Record<string, string>, failed = false): RetainedObservationEvidence => ({
  ...commandRecord("", 0, "obs-evidence-check", failed),
  toolName: EVIDENCE_CHECK_TOOL,
  itemId: "locate",
  arguments: args
})
const acceptedFact = (id: string, overrides: Partial<AcceptedFact> = {}): AcceptedFact => ({
  id,
  symbol: "readFile",
  registeredTool: "read_file",
  path: READ_FILE_SOURCE,
  startLine: 169,
  endLine: 220,
  observationId: `obs-${id}`,
  sourceHash: "hash",
  conversationId: "chat",
  itemId: "locate",
  criterionIndex: 0,
  criterion: "criterion",
  toolName: "read_file",
  planId: "plan",
  planRevision: 1,
  acceptedAt: "2024-01-01T00:00:00.000Z",
  ...overrides
})

test("accepted-evidence check: a completed project-wide none lookup proves lookup completion and never proves fact existence", async () => {
  const none = await reviewCriteria([LOOKUP_DONE, FACT_EXISTS], [evidenceCheck({ scope: "project", factCount: "0", factIds: "", resolution: "none" })])
  assert.equal(none[0].outcome, "proven")
  assert.deepEqual(none[0].supportingObservationIds, ["obs-evidence-check"])
  assert.equal(none[1].outcome, "disproven", "a none lookup is a counterexample to existence, not proof of it")
  const stale = await reviewCriteria([FACT_EXISTS], [evidenceCheck({ scope: "project", factCount: "0", factIds: "", resolution: "none" })], undefined, [acceptedFact("late", { acceptedAt: "2026-06-01T00:00:00.000Z" })])
  assert.equal(stale[0].outcome, "unknown", "a fact accepted after the check invalidates the none it recorded")
})

test("accepted-evidence check: presence is proven only by a fact the check found that is still live", async () => {
  const liveHash = await fingerprintContent(workspaceText)
  const check = evidenceCheck({ scope: "project", factCount: "1", factIds: "fact-live", resolution: "found" })
  const [live] = await reviewCriteria([FACT_EXISTS], [check], currentWorkspace, [acceptedFact("fact-live", { sourceHash: liveHash })])
  assert.equal(live.outcome, "proven")
  const [superseded] = await reviewCriteria([FACT_EXISTS], [check], currentWorkspace, [acceptedFact("fact-live", { sourceHash: liveHash, supersededBy: "fact-new" })])
  assert.equal(superseded.outcome, "unknown", "a found fact that has since been superseded no longer proves presence")
  const [absent] = await reviewCriteria([FACT_EXISTS], [evidenceCheck({ scope: "project", factCount: "0", factIds: "", resolution: "none" })])
  assert.equal(absent.outcome, "disproven")
})

test("accepted-evidence check: a subject-scoped, failed, or non-lookup criterion is not decided by the check", async () => {
  const subset = await reviewCriteria([LOOKUP_DONE], [evidenceCheck({ scope: "subject", factCount: "0", factIds: "", resolution: "none" })])
  assert.equal(subset[0].outcome, "unknown", "a subject-scoped lookup is not a project-wide lookup")
  const failed = await reviewCriteria([LOOKUP_DONE, FACT_EXISTS], [evidenceCheck({ scope: "project", factCount: "0", factIds: "", resolution: "none" }, true)])
  assert.equal(failed[0].outcome, "unknown", "a failed lookup did not complete")
  assert.equal(failed[1].outcome, "unknown", "a failed lookup decides no existence claim")
  const behavior = await reviewCriteria([semantic("behavior", "The accepted evidence handles missing files correctly")], [evidenceCheck({ scope: "project", factCount: "0", factIds: "", resolution: "none" })])
  assert.equal(behavior[0].outcome, "semantic", "a behavioral criterion about accepted evidence is still judged, not decided by a count")
})

const CHECK_TASK = "Check for existing accepted evidence of native read_file implementation"
const dependentLivePlan = [
  { id: "check", title: CHECK_TASK, criteria: [LOOKUP_DONE] },
  { id: "locate-native-read-file", title: LIVE_TASK, criteria: LIVE_CRITERIA, dependencies: ["check"] }
]
/** Records the host's lookup through the production record builder; overrides model a failed, filtered, or mis-scoped lookup. */
const recordLookup = (state: FeedbackFixture, title: string, live: AcceptedFact[], requestId: string, overrides: { failed?: boolean; toolName?: string; arguments?: Record<string, string> } = {}) => {
  const lookup = evidenceCheckRecord(live)
  return state.repository.recordToolObservation(state.scope, {
    itemId: itemTitled(state, title).id,
    toolName: overrides.toolName ?? EVIDENCE_CHECK_TOOL,
    arguments: overrides.arguments ?? lookup.arguments,
    output: lookup.output,
    failed: overrides.failed ?? false,
    requestId
  })
}

test("inquiry: a completed project-wide lookup proves lookup completion whether it found facts or none", async () => {
  const found = await reviewCriteria([LOOKUP_DONE], [evidenceCheck({ scope: "project", factCount: "1", factIds: "fact-live", resolution: "found" })], undefined, [acceptedFact("fact-live")])
  assert.equal(found[0].outcome, "proven")
  const none = await reviewCriteria([LOOKUP_DONE], [evidenceCheck({ scope: "project", factCount: "0", factIds: "", resolution: "none" })])
  assert.equal(none[0].outcome, "proven", "a successful none satisfies a lookup-completion criterion")
  const laterFact = await reviewCriteria([LOOKUP_DONE], [evidenceCheck({ scope: "project", factCount: "0", factIds: "", resolution: "none" })], undefined, [acceptedFact("later", { acceptedAt: "2026-06-01T00:00:00.000Z" })])
  assert.equal(laterFact[0].outcome, "proven", "a lookup that was performed stays proof that it occurred")
})

const lookupOutcomes: [string, AcceptedFact[]][] = [["found", [acceptedFact("fact-live")]], ["none", []]]
for (const [label, live] of lookupOutcomes) {
  test(`live regression (${label}): the two-TODO dependent plan proves the lookup, releases the dependent TODO, and reuses the existing read`, async () => {
    const workspace = sourceWorkspace()
    const reads = { count: 0 }
    const state = await fixture(dependentLivePlan, false, EVIDENCE_REQUEST)
    try {
      let feedbackCalls = 0
      const feedback = async (): Promise<string> => {
        feedbackCalls += 1
        throw new Error("Feedback must not judge a host-proven lookup or a criterion the host decided")
      }
      await claimTask(state, CHECK_TASK, "check-claim")
      const read = await runReadFile(workspace, reads, "169", "220")
      await recordRead(state, itemTitled(state, CHECK_TASK).id, "existing-read", read)
      await recordLookup(state, CHECK_TASK, live, "check-observation")
      const first = await evaluateTodoReview(state.repository, state.scope, await reviewOf(state, itemTitled(state, CHECK_TASK).id), feedback, "mock-reviewer", { readCurrentSource: sourceReader(workspace) })
      assert.equal(first.criteria[0].reconciliation!.outcome, "proven")
      assert.equal(first.decision, "accept")
      assert.equal(await statusOf(state, CHECK_TASK), "completed")
      const dependent = (await state.repository.getReviewPackages(state.scope, { includeOpen: true })).find((candidate) => candidate.task.id === itemTitled(state, LIVE_TASK).id)!
      assert.equal(dependent.dependencies[0]?.status, "completed")
      assert.ok(dependenciesComplete(dependent), "a completed negative prerequisite does not block its dependent TODO")
      await claimTask(state, LIVE_TASK, "locate-claim")
      const verdict = await evaluateTodoReview(state.repository, state.scope, await reviewOf(state, itemTitled(state, LIVE_TASK).id), feedback, "mock-reviewer", { readCurrentSource: sourceReader(workspace) })
      assert.equal(verdict.decision, "accept")
      assert.equal(await statusOf(state, LIVE_TASK), "completed")
      assert.equal(reads.count, 1, "the dependent TODO reuses the existing read instead of repeating it")
      assert.equal(feedbackCalls, 0, "no contradictory rejection and no continuation occurs")
    } finally {
      removeAll(state.directory, workspace)
    }
  })
}

test("live regression: a failed lookup, a filtered or subject-scoped lookup, an absent record, or another project's lookup does not prove the inquiry", async () => {
  const cases: { name: string; record?: (state: FeedbackFixture) => Promise<unknown> }[] = [
    { name: "failed lookup", record: (state) => recordLookup(state, CHECK_TASK, [], "check-failed", { failed: true }) },
    { name: "filtered native lookup", record: (state) => recordLookup(state, CHECK_TASK, [], "check-filtered", { toolName: "twinny_evidence_lookup", arguments: { symbol: "read_file", path: READ_FILE_SOURCE } }) },
    { name: "subject-scoped check", record: (state) => recordLookup(state, CHECK_TASK, [], "check-subject", { arguments: { scope: "subject", factCount: "0", factIds: "" } }) },
    { name: "absent lookup record" },
    { name: "another project's lookup", record: async () => undefined }
  ]
  for (const testCase of cases) {
    const state = await fixture([dependentLivePlan[0]], false, EVIDENCE_REQUEST)
    const other = await fixture([dependentLivePlan[0]], false, EVIDENCE_REQUEST)
    try {
      await claimTask(state, CHECK_TASK, "check-claim")
      if (testCase.name === "another project's lookup") {
        await claimTask(other, CHECK_TASK, "other-claim")
        await recordLookup(other, CHECK_TASK, [], "other-check")
      } else {
        await testCase.record?.(state)
      }
      let feedbackCalls = 0
      const verdict = await evaluateTodoReview(state.repository, state.scope, await reviewOf(state, itemTitled(state, CHECK_TASK).id), async () => {
        feedbackCalls += 1
        throw new Error("Feedback must not decide an objective lookup the host cannot prove")
      }, "mock-reviewer")
      assert.equal(feedbackCalls, 0, `${testCase.name}: an objective lookup is decided by the host, not by Feedback`)
      assert.equal(verdict.criteria[0].reconciliation!.outcome, "unknown", `${testCase.name}: the lookup is not proven`)
      assert.ok(verdict.criteria[0].reconciliation!.missing.length > 0, `${testCase.name}: the unresolved reason is named`)
      assert.notEqual(verdict.decision, "accept", `${testCase.name}: the TODO is not accepted`)
      assert.notEqual(await statusOf(state, CHECK_TASK), "completed", `${testCase.name}: the TODO does not complete`)
    } finally {
      removeAll(state.directory, other.directory)
    }
  }
})


const EVIDENCE_CHECK_CRITERION = "Verified that no existing accepted evidence is present project-wide"

test("live regression: the host's accepted-evidence check proves absence for the TODO with no Feedback call and completes it", async () => {
  const state = await fixture([{ id: "locate-native-read-file", title: LIVE_TASK, criteria: [{ id: "lookup-completed", description: EVIDENCE_CHECK_CRITERION, verification: { kind: "evidence_lookup_completed" } }] }], false, EVIDENCE_REQUEST)
  try {
    await claimTask(state, LIVE_TASK, "check-claim")
    const check = evidenceCheckRecord([])
    await state.repository.recordToolObservation(state.scope, {
      itemId: itemTitled(state, LIVE_TASK).id,
      toolName: EVIDENCE_CHECK_TOOL,
      arguments: check.arguments,
      output: check.output,
      failed: false,
      requestId: "check-observation"
    })
    let evaluatorCalls = 0
    const verdict = await evaluateTodoReview(state.repository, state.scope, await reviewOf(state, itemTitled(state, LIVE_TASK).id), async () => {
      evaluatorCalls += 1
      throw new Error("Feedback must not judge a check the host has recorded")
    }, "mock-reviewer")
    assert.equal(evaluatorCalls, 0)
    assert.equal(verdict.criteria[0].reconciliation!.outcome, "proven")
    assert.equal(verdict.decision, "accept")
    assert.equal(await statusOf(state, LIVE_TASK), "completed")
  } finally {
    removeAll(state.directory)
  }
})

test("live regression: a reviewer decision that rejects with no failed criterion is reconciled to its criteria, not its prose", async () => {
  const workspace = sourceWorkspace()
  const reads = { count: 0 }
  const state = await fixture([{ id: "locate-native-read-file", title: LIVE_TASK, criteria: [...LIVE_CRITERIA, { id: "semantic", description: SEMANTIC_CRITERION, verification: { kind: "semantic_review" } }] }], false, EVIDENCE_REQUEST)
  try {
    await claimTask(state, LIVE_TASK, "reconcile-claim")
    const read = await runReadFile(workspace, reads, "169", "220")
    const observation = await recordRead(state, itemTitled(state, LIVE_TASK).id, "reconcile-read", read)
    const review = await reviewOf(state, itemTitled(state, LIVE_TASK).id)
    let reconciliations: TodoCriterionReconciliation[] = []
    await evaluateTodoReview(state.repository, state.scope, review, async (_correction, seen) => {
      reconciliations = seen ?? []
      return JSON.stringify({
        schemaVersion: 1,
        taskId: review.planTaskId,
        decision: "revise",
        criteria: semanticEntries(review, "failed", [observation.id]),
        problems: [],
        correctiveInstructions: ["Explain how the semantic criterion is satisfied by the read."],
        explanation: "Every criterion is satisfied.",
        scores: { completion: 6, correctness: 6, alignment: 6 }
      })
    }, "mock-reviewer", { readCurrentSource: sourceReader(workspace) })
    assert.equal(reconciliations.length, review.criteria.length)

    const decided = parseTodoEvaluation(JSON.stringify({
      schemaVersion: 1,
      taskId: review.planTaskId,
      decision: "revise",
      criteria: semanticEntries(review, "passed", [observation.id]),
      problems: [],
      correctiveInstructions: ["Explain how the semantic criterion is satisfied by the read."],
      explanation: "Every criterion is satisfied.",
      scores: { completion: 8, correctness: 8, alignment: 8 }
    }), review, "mock-reviewer", new Date().toISOString(), reconciliations)
    assert.equal(decided.decision, "accept", "no criterion remains failed once the host's proven outcomes are applied")
    assert.ok(decided.criteria.slice(0, 4).every((criterion) => criterion.status === "passed"))
  } finally {
    removeAll(state.directory, workspace)
  }
})

test("negative: a read that stops before the closing line leaves the range criterion unproven, with no reviewer claim able to prove it", async () => {
  const workspace = sourceWorkspace()
  const reads = { count: 0 }
  const state = await fixture(livePlan, false, EVIDENCE_REQUEST)
  try {
    await claimTask(state, LIVE_TASK, "short-claim")
    const read = await runReadFile(workspace, reads, "169", "219")
    await recordRead(state, itemTitled(state, LIVE_TASK).id, "short-read", read)
    const review = await reviewOf(state, itemTitled(state, LIVE_TASK).id)
    const verdict = await evaluateTodoReview(state.repository, state.scope, review, async () => JSON.stringify({
      schemaVersion: 1,
      taskId: review.planTaskId,
      decision: "accept",
      criteria: [],
      problems: [],
      correctiveInstructions: [],
      explanation: "All criteria are satisfied.",
      scores: { completion: 8, correctness: 8, alignment: 8 }
    }), "mock-reviewer", { readCurrentSource: sourceReader(workspace) })

    const range = verdict.criteria.find((criterion) => criterion.criterionId === "range")!
    assert.notEqual(range.status, "passed", "a positive reviewer claim without trusted evidence does not prove the range")
    assert.notEqual(range.reconciliation?.outcome, "proven")
    assert.ok(range.reconciliation?.missing.some((gap) => gap.includes("220")), "the unresolved gap names the closing line")
    assert.notEqual(verdict.decision, "accept")
    assert.notEqual(await statusOf(state, LIVE_TASK), "completed")
  } finally {
    removeAll(state.directory, workspace)
  }
})

test("negative: a reviewer payload that names an objective criterion is rejected as invalid_shape, and cannot demote host facts", async () => {
  const workspace = sourceWorkspace()
  const reads = { count: 0 }
  const state = await fixture(livePlan, false, EVIDENCE_REQUEST)
  try {
    await claimTask(state, LIVE_TASK, "named-claim")
    const read = await runReadFile(workspace, reads, "169", "220")
    const observation = await recordRead(state, itemTitled(state, LIVE_TASK).id, "named-read", read)
    const review = await reviewOf(state, itemTitled(state, LIVE_TASK).id)
    const raw = JSON.stringify({
      schemaVersion: 1,
      taskId: review.planTaskId,
      decision: "revise",
      criteria: [{ criterionId: "range", status: "failed", evidenceRefs: [observation.id] }],
      problems: [],
      correctiveInstructions: [],
      explanation: "The range is not satisfied.",
      scores: { completion: 6, correctness: 6, alignment: 6 }
    })
    await assert.rejects(parseEvaluation(raw, review), (error: unknown) => error instanceof TodoEvaluationValidationError && error.code === "invalid_shape")
  } finally {
    removeAll(state.directory, workspace)
  }
})

/** A later model claim: re-reads the item's current version, so it works after an earlier evaluation changed the version. */
const reclaim = async (state: FeedbackFixture, title: string, requestId: string) => {
  const id = itemTitled(state, title).id
  const current = (await state.repository.getItem(state.scope, id)).item
  return state.repository.updateItem(state.scope, { itemId: id, expectedVersion: current.version, patch: { status: "in_review" }, actor: "model", requestId })
}

test("separate evidence: a read stopping at 219 proves the other criteria and leaves only the range open; a later read closes it without Feedback", async () => {
  const workspace = sourceWorkspace()
  const reads = { count: 0 }
  const state = await fixture(livePlan, false, EVIDENCE_REQUEST)
  const noFeedback = async () => {
    throw new Error("Feedback must not judge objective source criteria")
  }
  try {
    await claimTask(state, LIVE_TASK, "split-claim")
    const first = await runReadFile(workspace, reads, "169", "219")
    await recordRead(state, itemTitled(state, LIVE_TASK).id, "split-first", first)
    const partial = await evaluateTodoReview(state.repository, state.scope, await reviewOf(state, itemTitled(state, LIVE_TASK).id), noFeedback, "mock-reviewer", { readCurrentSource: sourceReader(workspace) })
    assert.equal(partial.decision, "needs_evidence")
    const [filename, range, fingerprint, prohibition] = partial.criteria.map((criterion) => criterion.reconciliation!)
    assert.equal(filename.outcome, "proven")
    assert.equal(fingerprint.outcome, "proven")
    assert.equal(prohibition.outcome, "proven")
    assert.notEqual(range.outcome, "proven")
    assert.ok(range.missing.some((gap) => gap.includes("220")), "the outstanding gap names the closing line")
    const reopened = new TodoRepository(state.databasePath, wasmPath)
    const persisted = (await reopened.getReviewPackages(state.scope)).find((candidate) => candidate.task.id === itemTitled(state, LIVE_TASK).id)!.lastEvaluation
    assert.deepEqual(persisted?.criteria.map((criterion) => criterion.status), ["passed", "unverified", "passed", "passed"], "each criterion's outcome survives a restart")
    assert.notEqual(await statusOf(state, LIVE_TASK), "completed")

    await reclaim(state, LIVE_TASK, "split-reclaim")
    const second = await runReadFile(workspace, reads, "200", "230")
    await recordRead(state, itemTitled(state, LIVE_TASK).id, "split-second", second)
    const verdict = await evaluateTodoReview(state.repository, state.scope, await reviewOf(state, itemTitled(state, LIVE_TASK).id), noFeedback, "mock-reviewer", { readCurrentSource: sourceReader(workspace) })
    assert.equal(verdict.decision, "accept")
    assert.deepEqual(verdict.criteria.map((criterion) => criterion.status), ["passed", "passed", "passed", "passed"])
    assert.equal(await statusOf(state, LIVE_TASK), "completed")
    assert.equal(reads.count, 2, "each criterion needed only the read that carried its missing fact")
  } finally {
    removeAll(state.directory, workspace)
  }
})

test("negative: a boundary read taken after the source changed does not close a range whose registration read is stale", async () => {
  const workspace = sourceWorkspace()
  const reads = { count: 0 }
  const state = await fixture(livePlan, false, EVIDENCE_REQUEST)
  const noFeedback = async () => {
    throw new Error("Feedback must not judge objective source criteria")
  }
  try {
    await claimTask(state, LIVE_TASK, "stale-claim")
    const first = await runReadFile(workspace, reads, "169", "219")
    await recordRead(state, itemTitled(state, LIVE_TASK).id, "stale-first", first)
    fs.writeFileSync(path.join(workspace, READ_FILE_SOURCE), realWorkspaceSource + "\n")
    const boundary = await runReadFile(workspace, reads, "200", "230")
    await recordRead(state, itemTitled(state, LIVE_TASK).id, "stale-boundary", boundary)
    const verdict = await evaluateTodoReview(state.repository, state.scope, await reviewOf(state, itemTitled(state, LIVE_TASK).id), noFeedback, "mock-reviewer", { readCurrentSource: sourceReader(workspace) })
    const range = verdict.criteria.find((criterion) => criterion.criterionId === "range")!
    assert.notEqual(range.reconciliation?.outcome, "proven")
    assert.ok(range.reconciliation?.missing.some((gap) => gap.includes("changed after observation")), "the stale registration read is named")
    assert.notEqual(verdict.decision, "accept")
    assert.notEqual(await statusOf(state, LIVE_TASK), "completed")

    await reclaim(state, LIVE_TASK, "stale-reclaim")
    const fresh = await runReadFile(workspace, reads, "169", "230")
    await recordRead(state, itemTitled(state, LIVE_TASK).id, "stale-fresh", fresh)
    const accepted = await evaluateTodoReview(state.repository, state.scope, await reviewOf(state, itemTitled(state, LIVE_TASK).id), noFeedback, "mock-reviewer", { readCurrentSource: sourceReader(workspace) })
    assert.equal(accepted.decision, "accept")
    assert.equal(await statusOf(state, LIVE_TASK), "completed")
  } finally {
    removeAll(state.directory, workspace)
  }
})

test("host decision: a review whose criteria are all objective needs no Feedback, even while its range is open; a semantic criterion still does", async () => {
  const workspace = sourceWorkspace()
  const reads = { count: 0 }
  const state = await fixture(livePlan, false, EVIDENCE_REQUEST)
  const semantic = await fixture([{ id: "semantic-task", title: "Semantic task", criteria: [{ id: "semantic", description: SEMANTIC_CRITERION, verification: { kind: "semantic_review" } }] }], false, EVIDENCE_REQUEST)
  try {
    await claimTask(state, LIVE_TASK, "decide-claim")
    const partial = await runReadFile(workspace, reads, "169", "219")
    await recordRead(state, itemTitled(state, LIVE_TASK).id, "decide-read", partial)
    assert.equal(await hostDecidesReview(await reviewOf(state, itemTitled(state, LIVE_TASK).id), sourceReader(workspace)), true)

    const claim = await claimTask(semantic, "Semantic task", "semantic-claim")
    assert.equal(claim.status, "in_review")
    assert.equal(await hostDecidesReview(await reviewOf(semantic, itemTitled(semantic, "Semantic task").id), sourceReader(workspace)), false)
  } finally {
    removeAll(state.directory, semantic.directory, workspace)
  }
})

test("negative: a failed write never violates the no-modification criterion, while a successful write disproves it", async () => {
  const workspace = sourceWorkspace()
  const reads = { count: 0 }
  const failedState = await fixture(livePlan, false, EVIDENCE_REQUEST)
  const successState = await fixture(livePlan, false, EVIDENCE_REQUEST)
  try {
    for (const [state, failed] of [[failedState, true], [successState, false]] as const) {
      await claimTask(state, LIVE_TASK, `write-claim-${failed}`)
      const read = await runReadFile(workspace, reads, "169", "220")
      await recordRead(state, itemTitled(state, LIVE_TASK).id, `write-read-${failed}`, read)
      await state.repository.recordToolObservation(state.scope, {
        itemId: itemTitled(state, LIVE_TASK).id,
        toolName: "edit_lines",
        arguments: { path: READ_FILE_SOURCE },
        output: failed ? "edit failed" : "edited",
        failed,
        requestId: `write-${failed}`
      })
    }

    let evaluatorCalls = 0
    const failedVerdict = await evaluateTodoReview(failedState.repository, failedState.scope, await reviewOf(failedState, itemTitled(failedState, LIVE_TASK).id), async () => {
      evaluatorCalls += 1
      throw new Error("Feedback must not judge criteria the host has proven")
    }, "mock-reviewer", { readCurrentSource: sourceReader(workspace) })
    assert.equal(failedVerdict.decision, "accept")
    assert.equal(failedVerdict.criteria.find((criterion) => criterion.criterionId === "no-modification")!.reconciliation?.outcome, "proven")
    assert.equal(evaluatorCalls, 0)

    const successReview = await reviewOf(successState, itemTitled(successState, LIVE_TASK).id)
    const successVerdict = await evaluateTodoReview(successState.repository, successState.scope, successReview, async () =>
      responseFor(successReview, { decision: "revise", status: "failed" }), "mock-reviewer", { readCurrentSource: sourceReader(workspace) })
    const prohibition = successVerdict.criteria.find((criterion) => criterion.criterionId === "no-modification")!
    assert.equal(prohibition.reconciliation?.outcome, "disproven")
    assert.equal(prohibition.status, "failed")
    assert.notEqual(successVerdict.decision, "accept")
  } finally {
    removeAll(failedState.directory, successState.directory, workspace)
  }
})

test("negative: a changed source makes the fact stale and leaves the overlapping TODO open", async () => {
  const workspace = sourceWorkspace()
  const reads = { count: 0 }
  const state = await fixture(overlappingPlan, false, EVIDENCE_REQUEST)
  try {
    await establishFact(state, workspace, reads)
    fs.writeFileSync(path.join(workspace, READ_FILE_SOURCE), realWorkspaceSource.replace("name: \"read_file\",", "name: \"read_file_renamed\","))
    const preflight = await evidencePreflight(EVIDENCE_REQUEST, await state.repository.listAcceptedEvidence(state.scope), sourceReader(workspace))
    assert.equal(preflight.status, "stale")
    assert.deepEqual(await completeProvenReviews(state.repository, state.scope, sourceReader(workspace)), [])
    assert.equal(await statusOf(state, "read"), "pending")
  } finally {
    removeAll(state.directory, workspace)
  }
})

test("negative: an unavailable source is unverifiable, never fresh", async () => {
  const workspace = sourceWorkspace()
  const reads = { count: 0 }
  const state = await fixture(overlappingPlan, false, EVIDENCE_REQUEST)
  try {
    await establishFact(state, workspace, reads)
    fs.rmSync(path.join(workspace, READ_FILE_SOURCE))
    const preflight = await evidencePreflight(EVIDENCE_REQUEST, await state.repository.listAcceptedEvidence(state.scope), sourceReader(workspace))
    assert.equal(preflight.status, "unverifiable")
    assert.deepEqual(await completeProvenReviews(state.repository, state.scope, sourceReader(workspace)), [])
    assert.equal(await statusOf(state, "read"), "pending")
  } finally {
    removeAll(state.directory, workspace)
  }
})

test("negative: a failed or out-of-range read never becomes accepted evidence", async () => {
  const workspace = sourceWorkspace()
  const reads = { count: 0 }
  const state = await fixture(overlappingPlan, false, EVIDENCE_REQUEST)
  try {
    await claimTask(state, "locate", "locate-claim")
    await assert.rejects(runReadFile(workspace, reads, "9999", "9999"))
    await state.repository.recordToolObservation(state.scope, {
      itemId: itemTitled(state, "locate").id,
      toolName: "read_file",
      arguments: { path: READ_FILE_SOURCE, start_line: "9999", end_line: "9999" },
      output: "read_file failed",
      failed: true,
      requestId: "locate-read-failed"
    })
    const review = await reviewOf(state, itemTitled(state, "locate").id)
    assert.equal(await provenTodoEvaluation(review, sourceReader(workspace)), undefined)
    assert.deepEqual(await state.repository.listAcceptedEvidence(state.scope), [])
    assert.deepEqual(await completeProvenReviews(state.repository, state.scope, sourceReader(workspace)), [])
  } finally {
    removeAll(state.directory, workspace)
  }
})

test("negative: a valid fact never certifies a criterion it does not prove, nor a semantic criterion", async () => {
  const workspace = sourceWorkspace()
  const reads = { count: 0 }
  const state = await fixture([
    ...overlappingPlan,
    { id: "other", criteria: [{ id: "runcommand", description: "`runCommand` is declared in src/extension/tools/workspace.ts", verification: { kind: "source_location", identity: "implementation_symbol", symbol: "runCommand", path: "src/extension/tools/workspace.ts" } }] },
    { id: "semantic", criteria: [{ id: "reads", description: "The change reads well to a reviewer", verification: { kind: "semantic_review" } }] }
  ], false, EVIDENCE_REQUEST)
  try {
    await establishFact(state, workspace, reads)
    assert.deepEqual(await completeProvenReviews(state.repository, state.scope, sourceReader(workspace)), ["read"])
    assert.equal(await statusOf(state, "other"), "pending")
    assert.equal(await statusOf(state, "semantic"), "pending")
    assert.equal(reads.count, 1)
  } finally {
    removeAll(state.directory, workspace)
  }
})

test("negative: ambiguous symbol resolution is reported and another project's facts are never reused", async () => {
  const workspace = sourceWorkspace()
  const reads = { count: 0 }
  const state = await fixture(overlappingPlan, false, EVIDENCE_REQUEST)
  try {
    await establishFact(state, workspace, reads)
    const [fact] = await state.repository.listAcceptedEvidence(state.scope)
    const twin = { ...fact, id: "twin-fact", path: "src/extension/tools/other-workspace.ts" }
    const ambiguous = await evidencePreflight(EVIDENCE_REQUEST, [fact, twin], sourceReader(workspace))
    assert.equal(ambiguous.status, "ambiguous")

    const foreign = new TodoRepository(state.databasePath, wasmPath)
    const foreignScope = { projectFingerprint: workspaceProjectFingerprint(["file:///other-project"]), conversationId: "foreign-chat", writer: "foreign-chat" }
    await foreign.synchronizeIntentPlan(foreignScope, plan(overlappingPlan, EVIDENCE_REQUEST), { prompt: EVIDENCE_REQUEST })
    const foreignFacts = await foreign.listAcceptedEvidence(foreignScope)
    assert.deepEqual(foreignFacts, [])
    assert.equal((await evidencePreflight(EVIDENCE_REQUEST, foreignFacts, sourceReader(workspace))).status, "missing")
    assert.deepEqual(await completeProvenReviews(foreign, foreignScope, sourceReader(workspace)), [])
  } finally {
    removeAll(state.directory, workspace)
  }
})

test("information reuse: a modification TODO receives the established fact with its ID and fingerprint, and is not completed from it", async () => {
  const workspace = sourceWorkspace()
  const reads = { count: 0 }
  const state = await fixture([
    { id: "locate", criteria: [{ id: "locate", description: LOCATE_CRITERION, verification: { kind: "source_location", identity: "registered_tool", symbol: "read_file", path: "src/extension/tools/workspace.ts" } }] },
    { id: "modify", criteria: [sourceLocation("locate", LOCATE_CRITERION, "read_file", "registered_tool"), { id: "modify", description: "Its read_file implementation is updated to report the line count", verification: { kind: "workspace_mutation" } }] }
  ], false, EVIDENCE_REQUEST)
  try {
    await establishFact(state, workspace, reads)
    const facts = await assessAcceptedFacts(await state.repository.listAcceptedEvidence(state.scope), sourceReader(workspace))
    const [status] = facts
    const context = renderPlanContext((await state.repository.getPlanOutline(state.scope))!, facts)
    assert.ok(context.includes(`${status.fact.id} [current]`), "the established fact is offered by its stable ID")
    assert.ok(context.includes(status.fact.sourceHash), "the fingerprint travels with the fact")
    assert.ok(context.includes(`observation ${status.fact.observationId}`), "original provenance is preserved")

    await completeProvenReviews(state.repository, state.scope, sourceReader(workspace))
    assert.equal(await statusOf(state, "modify"), "pending", "a change task is never completed from read-only facts")
    assert.equal(await statusOf(state, "locate"), "completed")
    assert.equal(reads.count, 1, "reuse issues no further read")
  } finally {
    removeAll(state.directory, workspace)
  }
})

test("partial reuse: a TODO with one proven and one unproven criterion keeps the proven fact and is not completed", async () => {
  const workspace = sourceWorkspace()
  const reads = { count: 0 }
  const UNRELATED_CRITERION = "`runCommand` is declared in src/extension/tools/workspace.ts"
  const state = await fixture([
    { id: "locate", criteria: [{ id: "locate", description: LOCATE_CRITERION, verification: { kind: "source_location", identity: "registered_tool", symbol: "read_file", path: "src/extension/tools/workspace.ts" } }] },
    { id: "read", criteria: [{ id: "locate", description: LOCATE_CRITERION, verification: { kind: "source_location", identity: "registered_tool", symbol: "read_file", path: "src/extension/tools/workspace.ts" } }, { id: "unrelated", description: UNRELATED_CRITERION, verification: { kind: "source_location", identity: "implementation_symbol", symbol: "runCommand", path: "src/extension/tools/workspace.ts" } }] }
  ], false, EVIDENCE_REQUEST)
  try {
    await establishFact(state, workspace, reads)
    const readId = itemTitled(state, "read").id
    const review = (await state.repository.getReviewPackages(state.scope, { includeOpen: true })).find((candidate) => candidate.task.id === readId)!
    const [proven, unproven] = await reviewCriteria(review.criteria, review.retainedEvidence, sourceReader(workspace), review.acceptedEvidence, review.symbolAliases)
    assert.equal(proven.outcome, "proven", "the established fact covers the criterion it proves")
    assert.notEqual(unproven.outcome, "proven", "the unrelated criterion is not carried by the fact")
    assert.equal(await provenTodoEvaluation(review, sourceReader(workspace)), undefined, "a partly proven TODO is not completed")

    await completeProvenReviews(state.repository, state.scope, sourceReader(workspace))
    assert.equal(await statusOf(state, "read"), "pending")
    assert.equal(reads.count, 1)
  } finally {
    removeAll(state.directory, workspace)
  }
})

test("stale evidence stays visible as historical context with its status, never as current proof", async () => {
  const workspace = sourceWorkspace()
  const reads = { count: 0 }
  const state = await fixture(overlappingPlan, false, EVIDENCE_REQUEST)
  try {
    await establishFact(state, workspace, reads)
    fs.writeFileSync(path.join(workspace, READ_FILE_SOURCE), realWorkspaceSource.replace("name: \"read_file\",", "name: \"read_file_renamed\","))
    const facts = await assessAcceptedFacts(await state.repository.listAcceptedEvidence(state.scope), sourceReader(workspace))
    const [status] = facts
    assert.equal(status.freshness, "historical")
    const context = renderPlanContext((await state.repository.getPlanOutline(state.scope))!, facts)
    assert.ok(context.includes(`${status.fact.id} [historical]`), "the historical fact keeps its ID and status")
    assert.ok(context.includes("re-read them before relying on them"))
    assert.deepEqual(await completeProvenReviews(state.repository, state.scope, sourceReader(workspace)), [])
    assert.equal(await statusOf(state, "read"), "pending")
  } finally {
    removeAll(state.directory, workspace)
  }
})

test("negative: a historical read never proves a criterion that adds, changes, or implements source", async () => {
  const workspace = sourceWorkspace()
  const criteria = [
    "`read_file` is added to src/extension/tools/workspace.ts",
    "`read_file` is changed in src/extension/tools/workspace.ts",
    "`read_file` is implemented in src/extension/tools/workspace.ts"
  ]
  for (const acceptance of criteria) {
    const reads = { count: 0 }
    const state = await fixture([{ id: "mutate", criteria: [{ id: "mutate", description: acceptance, verification: { kind: "workspace_mutation" } }] }], false, EVIDENCE_REQUEST)
    try {
      await recordRead(state, itemTitled(state, "mutate").id, "mutate-read", await runReadFile(workspace, reads))
      assert.deepEqual(await completeProvenReviews(state.repository, state.scope, sourceReader(workspace)), [], acceptance)
      assert.equal(await statusOf(state, "mutate"), "pending", acceptance)
    } finally {
      removeAll(state.directory)
    }
  }
  removeAll(workspace)
})

test("negative: a passing run that predates a later successful edit does not prove the run criterion", async () => {
  const state = await fixture([{ id: "verify", criteria: [{ id: "tests-pass", description: "`npm test` exits 0", verification: { kind: "command_exit_status", command: "npm test", exitCode: 0 } }] }], false, EVIDENCE_REQUEST)
  try {
    await state.repository.recordToolObservation(state.scope, {
      itemId: itemTitled(state, "verify").id,
      toolName: "run_command",
      arguments: runCommandArguments("npm test"),
      output: "pass",
      failed: false,
      exitCode: 0,
      requestId: "verify-run"
    })
    await state.repository.recordToolObservation(state.scope, {
      itemId: itemTitled(state, "verify").id,
      toolName: "edit_lines",
      arguments: { path: "src/extension/tools/workspace.ts" },
      output: "edited",
      failed: false,
      requestId: "verify-edit"
    })
    assert.deepEqual(await completeProvenReviews(state.repository, state.scope), [])
    assert.equal(await statusOf(state, "verify"), "pending")
  } finally {
    removeAll(state.directory)
  }
})

test("negative: a criterion that asks for a new run is never proven by an earlier passing run", async () => {
  const state = await fixture([{ id: "again", criteria: [{ id: "tests-pass-again", description: "`npm test` is run again and exits 0", verification: { kind: "command_exit_status", command: "npm test", exitCode: 0, execution: "after_activation" } }] }], false, EVIDENCE_REQUEST)
  try {
    await state.repository.recordToolObservation(state.scope, {
      itemId: itemTitled(state, "again").id,
      toolName: "run_command",
      arguments: runCommandArguments("npm test"),
      output: "pass",
      failed: false,
      exitCode: 0,
      requestId: "again-run"
    })
    assert.deepEqual(await completeProvenReviews(state.repository, state.scope), [])
    assert.equal(await statusOf(state, "again"), "pending")
  } finally {
    removeAll(state.directory)
  }
})

test("negative: a run stays unproven when the clock stored a later edit earlier than the run", async () => {
  const state = await fixture([{ id: "skewed", criteria: [{ id: "tests-pass-skewed", description: "`npm test` exits 0", verification: { kind: "command_exit_status", command: "npm test", exitCode: 0 } }] }], false, EVIDENCE_REQUEST)
  try {
    const itemId = itemTitled(state, "skewed").id
    await state.repository.recordToolObservation(state.scope, {
      itemId,
      toolName: "run_command",
      arguments: runCommandArguments("npm test"),
      output: "pass",
      failed: false,
      exitCode: 0,
      requestId: "skewed-run"
    })
    await state.repository.recordToolObservation(state.scope, {
      itemId,
      toolName: "edit_lines",
      arguments: { path: "src/extension/tools/workspace.ts" },
      output: "edited",
      failed: false,
      requestId: "skewed-edit"
    })
    const sql = await initSqlJs({ locateFile: () => wasmPath })
    const database = new sql.Database(fs.readFileSync(state.databasePath))
    database.run("UPDATE todo_tool_observations SET created_at = ? WHERE request_id = ?", ["2000-01-01T00:00:00.000Z", "skewed-edit"])
    fs.writeFileSync(state.databasePath, Buffer.from(database.export()))
    database.close()
    const reopened = new TodoRepository(state.databasePath, wasmPath)
    assert.deepEqual(await completeProvenReviews(reopened, state.scope), [])
    assert.equal((await reopened.getList({ ...state.scope, includeCompleted: true })).items.find((item) => item.id === itemId)?.status, "pending")
  } finally {
    removeAll(state.directory)
  }
})

test("cancellation: a stopped reply completes no TODO even when its evidence proves the criterion", async () => {
  const state = await fixture([{ id: "verify", criteria: [{ id: "tests-pass", description: "`npm test` exits 0", verification: { kind: "command_exit_status", command: "npm test", exitCode: 0 } }] }], false, EVIDENCE_REQUEST)
  try {
    await state.repository.recordToolObservation(state.scope, {
      itemId: itemTitled(state, "verify").id,
      toolName: "run_command",
      arguments: runCommandArguments("npm test"),
      output: "pass",
      failed: false,
      exitCode: 0,
      requestId: "verify-run"
    })
    assert.deepEqual(await completeProvenReviews(state.repository, state.scope, undefined, { isCancelled: () => true }), [])
    assert.equal(await statusOf(state, "verify"), "pending")
  } finally {
    removeAll(state.directory)
  }
})

test("cancellation: a stop after the claim releases it to in_progress and completes nothing", async () => {
  const state = await fixture([{ id: "verify", criteria: [{ id: "tests-pass", description: "`npm test` exits 0", verification: { kind: "command_exit_status", command: "npm test", exitCode: 0 } }] }], false, EVIDENCE_REQUEST)
  try {
    await state.repository.recordToolObservation(state.scope, {
      itemId: itemTitled(state, "verify").id,
      toolName: "run_command",
      arguments: runCommandArguments("npm test"),
      output: "pass",
      failed: false,
      exitCode: 0,
      requestId: "verify-run"
    })
    // Checks run before the scan, before the claim, and before the apply: the third check stops after the claim.
    let checks = 0
    assert.deepEqual(await completeProvenReviews(state.repository, state.scope, undefined, { isCancelled: () => ++checks >= 3 }), [])
    assert.equal(checks, 3)
    assert.equal(await statusOf(state, "verify"), "in_progress")
  } finally {
    removeAll(state.directory)
  }
})

test("approval: a failed or declined edit never satisfies a criterion that requires a change", async () => {
  const state = await fixture([{ id: "modify", criteria: [{ id: "diagnostics", description: "Add a `diagnosticsField` to the native read_file implementation in src/extension/tools/workspace.ts", verification: { kind: "workspace_mutation" } }] }], false, EVIDENCE_REQUEST)
  try {
    await state.repository.recordToolObservation(state.scope, {
      itemId: itemTitled(state, "modify").id,
      toolName: "edit_lines",
      arguments: { path: "src/extension/tools/workspace.ts" },
      output: "The user chose not to apply this edit",
      failed: true,
      requestId: "declined-edit"
    })
    assert.deepEqual(await completeProvenReviews(state.repository, state.scope), [])
    assert.equal(await statusOf(state, "modify"), "pending")
  } finally {
    removeAll(state.directory)
  }
})

test("approval: a run recorded as failed never proves a passing run criterion", async () => {
  const state = await fixture([{ id: "verify", criteria: [{ id: "tests-pass", description: "`npm test` exits 0", verification: { kind: "command_exit_status", command: "npm test", exitCode: 0 } }] }], false, EVIDENCE_REQUEST)
  try {
    await state.repository.recordToolObservation(state.scope, {
      itemId: itemTitled(state, "verify").id,
      toolName: "run_command",
      arguments: runCommandArguments("npm test"),
      output: "The user chose not to run this command",
      failed: true,
      exitCode: 0,
      requestId: "declined-run"
    })
    assert.deepEqual(await completeProvenReviews(state.repository, state.scope), [])
    assert.equal(await statusOf(state, "verify"), "pending")
  } finally {
    removeAll(state.directory)
  }
})

test("prerequisite only: a proven location leaves the broader modification task pending", async () => {
  const state = await fixture([{ id: "locate", criteria: [{ id: "locate", description: LOCATE_CRITERION, verification: { kind: "source_location", identity: "registered_tool", symbol: "read_file", path: "src/extension/tools/workspace.ts" } }, { id: "add-diagnostics", description: "Add a `diagnosticsField` to the native read_file implementation in src/extension/tools/workspace.ts", verification: { kind: "workspace_mutation" } }] }], false, EVIDENCE_REQUEST)
  const workspace = sourceWorkspace()
  try {
    const read = await runReadFile(workspace, { count: 0 })
    await recordRead(state, itemTitled(state, "locate").id, "locate-read", read)
    const review = (await state.repository.getReviewPackages(state.scope, { includeOpen: true })).find((candidate) => candidate.task.id === itemTitled(state, "locate").id)!
    const [location, modification] = await reviewCriteria(review.criteria, review.retainedEvidence, sourceReader(workspace), review.acceptedEvidence, review.symbolAliases)
    assert.equal(location.outcome, "proven", "the trusted read proves the location prerequisite")
    assert.notEqual(modification.outcome, "proven", "the location never proves the change")
    assert.deepEqual(await completeProvenReviews(state.repository, state.scope, sourceReader(workspace)), [])
    assert.equal(await statusOf(state, "locate"), "pending")
  } finally {
    removeAll(workspace, state.directory)
  }
})

test("fresh demand: a re-run after the reply started proves a re-run criterion, and an earlier run does not", async () => {
  const state = await fixture([{ id: "again", criteria: [{ id: "tests-pass-again", description: "`npm test` is run again and exits 0", verification: { kind: "command_exit_status", command: "npm test", exitCode: 0, execution: "after_activation" } }] }], false, EVIDENCE_REQUEST)
  try {
    const runNpmTest = (requestId: string) => state.repository.recordToolObservation(state.scope, {
      itemId: itemTitled(state, "again").id,
      toolName: "run_command",
      arguments: runCommandArguments("npm test"),
      output: "pass",
      failed: false,
      exitCode: 0,
      requestId
    })
    await runNpmTest("again-earlier")
    assert.deepEqual(await completeProvenReviews(state.repository, state.scope, undefined), [])
    // The reply start activates the requirement; this test performs that host step explicitly.
    await state.repository.activateRequirement(state.scope, itemTitled(state, "again").id, "again-reply-start")
    assert.deepEqual(await completeProvenReviews(state.repository, state.scope, undefined), [])
    await runNpmTest("again-fresh")
    assert.deepEqual(await completeProvenReviews(state.repository, state.scope, undefined), ["again"])
    assert.equal(await statusOf(state, "again"), "completed")
  } finally {
    removeAll(state.directory)
  }
})

test("identity: a registered tool name never names a fact registered under another tool, and a registered name never names an implementation", async () => {
  const writeFact = await relevanceFact("fact-write", "readFile", WORKSPACE_FILE, "", { registeredTool: "write_file" })
  const readFact = await relevanceFact("fact-read", "readFile", WORKSPACE_FILE, "", { registeredTool: "read_file" })
  assert.equal(factNamedBy("registered_tool", "read_file", writeFact), false, "a write_file registration never proves read_file")
  assert.equal(factNamedBy("registered_tool", "write_file", writeFact), true)
  assert.equal(factNamedBy("implementation_symbol", "readFile", writeFact), true, "the implementation symbol still names its own fact")
  assert.equal(factNamedBy("implementation_symbol", "write_file", writeFact), false, "a registered name never names an implementation symbol")
  assert.equal(factNamedBy("registered_tool", "read_file", readFact), true)
  assert.equal(factNamedBy("implementation_symbol", "read_file", readFact), false)
})

test("historical scope: a run that predates a later edit still proves a criterion explicitly scoped as historical", async () => {
  const state = await fixture([{ id: "diagnose", criteria: [{ id: "tests-passed-then", description: "`npm test` passed at the time of the run", verification: { kind: "command_exit_status", command: "npm test", exitCode: 0, scope: "historical" } }] }], false, EVIDENCE_REQUEST)
  try {
    await state.repository.recordToolObservation(state.scope, {
      itemId: itemTitled(state, "diagnose").id,
      toolName: "run_command",
      arguments: runCommandArguments("npm test"),
      output: "pass",
      failed: false,
      exitCode: 0,
      requestId: "diagnose-run"
    })
    await state.repository.recordToolObservation(state.scope, {
      itemId: itemTitled(state, "diagnose").id,
      toolName: "edit_lines",
      arguments: { path: "src/extension/tools/workspace.ts" },
      output: "edited",
      failed: false,
      requestId: "diagnose-edit"
    })
    assert.deepEqual(await completeProvenReviews(state.repository, state.scope), ["diagnose"])
    assert.equal(await statusOf(state, "diagnose"), "completed")
  } finally {
    removeAll(state.directory)
  }
})

const relevanceFact = async (id: string, symbol: string, file: string, text: string, overrides: Partial<AcceptedFact> = {}): Promise<AcceptedFact> => ({
  id,
  symbol,
  path: file,
  startLine: 1,
  endLine: 10,
  observationId: `obs-${id}`,
  sourceHash: await fingerprintContent(text),
  conversationId: "relevance-chat",
  itemId: `item-${id}`,
  criterionIndex: 0,
  criterion: `criterion for ${id}`,
  toolName: "read_file",
  planId: "relevance-plan",
  planRevision: 1,
  acceptedAt: "2024-01-01T00:00:00.000Z",
  ...overrides
})

test("relevance: an exact symbol match is kept, and ranks first, when unrelated current facts fill the budget", async () => {
  const files: Record<string, string> = { "src/exact.ts": "changed after acceptance" }
  const exact = await relevanceFact("exact", "readFile", "src/exact.ts", "original text")
  const unrelated: AcceptedFact[] = []
  for (let index = 0; index < 20; index += 1) {
    const file = `src/unrelated-${index}.ts`
    files[file] = `unrelated body ${index}`
    unrelated.push(await relevanceFact(`unrelated-${index}`, `helper${index}`, file, files[file], {
      acceptedAt: `2024-02-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`
    }))
  }
  const { selected, omitted } = await selectAcceptedFacts(
    { text: "Fix readFile so it reports its fingerprint", planItemIds: [] },
    [...unrelated, exact],
    async (file) => files[file],
    12
  )
  assert.equal(selected.length, 12)
  assert.equal(omitted, 9, "the budget omits the unrelated remainder, not the exact match")
  assert.equal(selected[0].fact.id, "exact")
  assert.equal(selected[0].freshness, "historical", "a stale exact match is still reported as stale")
})

test("relevance: an alias of the requested tool name ranks the aliased implementation's fact", async () => {
  const files: Record<string, string> = { "src/impl.ts": "impl body", "src/other.ts": "other body" }
  const aliased = await relevanceFact("aliased", "readFileImpl", "src/impl.ts", "impl body", { registeredTool: "read_file" })
  const unrelated = await relevanceFact("unrelated", "writeThing", "src/other.ts", "other body", {
    acceptedAt: "2024-06-01T00:00:00.000Z"
  })
  const { selected } = await selectAcceptedFacts(
    { text: "Check the read_file tool", planItemIds: [] },
    [unrelated, aliased],
    async (file) => files[file],
    1
  )
  assert.equal(selected[0].fact.id, "aliased", "the alias relationship outranks a newer unrelated fact")
})

test("relevance: with equal relevance, a current fact ranks before a newer historical one", async () => {
  const files: Record<string, string> = { "src/a.ts": "current a", "src/b.ts": "changed b" }
  const current = await relevanceFact("current", "alpha", "src/a.ts", "current a", { acceptedAt: "2024-01-01T00:00:00.000Z" })
  const historical = await relevanceFact("historical", "beta", "src/b.ts", "original b", { acceptedAt: "2024-03-01T00:00:00.000Z" })
  const { selected, omitted } = await selectAcceptedFacts(
    { text: "Summarize the module", planItemIds: [] },
    [historical, current],
    async (file) => files[file],
    1
  )
  assert.equal(selected[0].fact.id, "current")
  assert.equal(selected[0].freshness, "current")
  assert.equal(omitted, 1)
})

test("relevance: an unverifiable fact ranks after a current one and is never excluded for being unverifiable", async () => {
  const files: Record<string, string> = { "src/a.ts": "current a" }
  const current = await relevanceFact("current", "alpha", "src/a.ts", "current a", { acceptedAt: "2024-01-01T00:00:00.000Z" })
  const unverifiable = await relevanceFact("unverifiable", "beta", "src/gone.ts", "gone", { acceptedAt: "2024-05-01T00:00:00.000Z" })
  const both = await selectAcceptedFacts({ text: "Summarize", planItemIds: [] }, [unverifiable, current], async (file) => files[file], 2)
  assert.deepEqual(both.selected.map(({ fact }) => fact.id), ["current", "unverifiable"])
  assert.equal(both.selected[1].freshness, "unverifiable")
  assert.equal(both.omitted, 0)
})

test("relevance: a fact from the active plan ranks first without excluding other facts", async () => {
  const files: Record<string, string> = { "src/planned.ts": "changed planned", "src/other.ts": "other body" }
  const planned = await relevanceFact("planned", "gamma", "src/planned.ts", "original planned", { itemId: "planned-task" })
  const other = await relevanceFact("other", "delta", "src/other.ts", "other body", { acceptedAt: "2024-06-01T00:00:00.000Z" })
  const reader: CurrentSourceReader = async (file) => files[file]
  const one = await selectAcceptedFacts({ text: "Continue the work", planItemIds: ["planned-task"] }, [other, planned], reader, 1)
  assert.equal(one.selected[0].fact.id, "planned")
  const two = await selectAcceptedFacts({ text: "Continue the work", planItemIds: ["planned-task"] }, [other, planned], reader, 2)
  assert.deepEqual(two.selected.map(({ fact }) => fact.id).sort(), ["other", "planned"])
})

test("relevance: a superseded fact is never selected, even when it is an exact match", async () => {
  const files: Record<string, string> = { "src/exact.ts": "current body" }
  const superseded = await relevanceFact("superseded", "readFile", "src/exact.ts", "current body", { supersededBy: "replacement" })
  const replacement = await relevanceFact("replacement", "readFileAgain", "src/exact.ts", "current body", { acceptedAt: "2024-02-01T00:00:00.000Z" })
  const { selected, omitted } = await selectAcceptedFacts(
    { text: "Fix readFile", planItemIds: [] },
    [superseded, replacement],
    async (file) => files[file],
    12
  )
  assert.deepEqual(selected.map(({ fact }) => fact.id), ["replacement"])
  assert.equal(omitted, 0)
})

test("relevance: rendered context keeps the ranked order and reports how many facts were omitted", async () => {
  const files: Record<string, string> = { "src/a.ts": "current a", "src/b.ts": "changed b" }
  const current = await relevanceFact("current", "alpha", "src/a.ts", "current a")
  const historical = await relevanceFact("historical", "readFile", "src/b.ts", "original b")
  const outline = { planId: "relevance-plan", revision: 1, goal: "Continue", tasks: [], children: [] } as unknown as IntentPlanOutline
  const selection = await selectAcceptedFacts({ text: "Fix readFile", planItemIds: [] }, [current, historical], async (file) => files[file], 1)
  const rendered = renderPlanContext(outline, selection.selected, selection.omitted)
  assert.match(rendered, /historical \[historical\] readFile \(read_file\)/, "the exact match is the one rendered")
  assert.doesNotMatch(rendered, /alpha/, "the unrelated fact is omitted by the budget")
  assert.match(rendered, /… 1 more accepted fact\(s\)/, "the omitted count is reported")
})

const REFERENCE_TASKS: Parameters<typeof plan>[0] = [
  { id: "investigate", criteria: [{ id: "defined", description: "`read_file` is defined in src/extension/tools/workspace.ts", verification: { kind: "source_location", identity: "registered_tool", symbol: "read_file", path: "src/extension/tools/workspace.ts" } }] },
  { id: "modify", criteria: [{ id: "modify", description: "Change the `read_file` tool in src/extension/tools/workspace.ts to report its line count", verification: { kind: "workspace_mutation" } }, { id: "modify-subject", description: "`read_file` is defined in src/extension/tools/workspace.ts", verification: { kind: "source_location", identity: "registered_tool", symbol: "read_file", path: "src/extension/tools/workspace.ts" } }] },
  { id: "unrelated", criteria: [{ id: "changelog", description: "Document the changelog entry for the release", verification: { kind: "workspace_mutation" } }] }
]

/** Conversation A: the investigation accepts the read_file location fact through the deterministic review. */
const acceptLocationFact = async () => {
  const state = await evidenceFixtureFor(REFERENCE_TASKS)
  const [investigate] = state.itemIds
  await startItemInReview(state.repository, state.scope, investigate)
  await observeRead(state, investigate, "reference-read", EVIDENCE_FILE, 150, sourceLines.slice(149, 220))
  await evaluateTodoReview(state.repository, state.scope, await reviewFor(state, investigate), countingEvaluator({ count: 0 }), "mock-reviewer", { readCurrentSource: currentWorkspace, hasVerifiedFileChanges: false })
  const lookup = await lookupEvidence(state, { symbol: "read_file", path: EVIDENCE_FILE }, currentWorkspace)
  assert.equal(lookup.body!.facts.length, 1, "the investigation accepted exactly one location fact")
  return { state, factId: String(lookup.body!.facts[0].evidence_id) }
}
const referenceEvidence = (tools: ReturnType<typeof todoWorkspaceTools>, itemId: string, factId: string, requestId: string) =>
  tools.run({
    name: "twinny_todo_evidence",
    args: { item_id: itemId, kind: "observation", summary: "cites the accepted location", result: "observed", request_id: requestId, accepted_fact_id: factId }
  })

test("a host-verified accepted fact referenced by a TODO that names it is recorded with its provenance, and the TODO is not completed", async () => {
  const { state, factId } = await acceptLocationFact()
  try {
    const [, modify] = state.itemIds
    await startItemInReview(state.repository, state.scope, modify)
    const before = (await state.repository.listAcceptedEvidence(state.scope, { symbol: "read_file", path: EVIDENCE_FILE }))[0]
    const tools = todoWorkspaceTools(state.repository, state.scope, () => undefined, { readCurrentSource: currentWorkspace })

    const response = await referenceEvidence(tools, modify, factId, "reference-modify")
    assert.equal(response.failed, undefined, response.output)
    const evidence = JSON.parse(response.output) as { kind: string; result: string; summary: string }
    assert.equal(evidence.kind, "accepted_fact")
    assert.equal(evidence.result, "observed", "a reference is never recorded as a pass")
    assert.match(evidence.summary, new RegExp(`accepted fact ${factId}`))
    assert.match(evidence.summary, new RegExp(before.observationId))
    assert.match(evidence.summary, new RegExp(before.conversationId))
    assert.match(evidence.summary, new RegExp(before.sourceHash.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))

    assert.equal((await state.repository.getItem(state.scope, modify)).item.status, "in_review", "supporting evidence does not complete the modification TODO")
    const review = await reviewFor(state, modify)
    assert.ok(review.evidence.some((row) => row.kind === "accepted_fact"), "the reviewer sees the host-recorded reference")

    const after = await state.repository.listAcceptedEvidence(state.scope, { symbol: "read_file", path: EVIDENCE_FILE })
    assert.deepEqual(after, [before], "the original accepted fact is neither changed nor superseded by the reference")
  } finally {
    removeAll(state.directory)
  }
})

test("an accepted fact reference is rejected when it is unknown, foreign, stale, unverifiable, or unrelated to the TODO's criteria", async () => {
  const { state, factId } = await acceptLocationFact()
  try {
    const [, modify, unrelated] = state.itemIds
    await startItemInReview(state.repository, state.scope, modify)
    const tools = todoWorkspaceTools(state.repository, state.scope, () => undefined, { readCurrentSource: currentWorkspace })
    const expectRejected = async (run: Promise<ToolResult>, reason: RegExp, label: string) => {
      const response = await run
      assert.equal(response.failed, true, `${label} is rejected`)
      assert.match(response.output, reason, label)
    }

    await expectRejected(referenceEvidence(tools, modify, "no-such-fact", "reject-unknown"), /not found in this project/, "an unknown id")
    await expectRejected(
      referenceEvidence(tools, unrelated, factId, "reject-unrelated"),
      /is not the subject of a typed criterion of this TODO/,
      "a fact no criterion names"
    )
    await expectRejected(
      referenceEvidence(todoWorkspaceTools(state.repository, state.scope, () => undefined, { readCurrentSource: changedWorkspace }), modify, factId, "reject-stale"),
      /is historical/,
      "a stale fact"
    )
    await expectRejected(
      referenceEvidence(todoWorkspaceTools(state.repository, state.scope, () => undefined), modify, factId, "reject-unverifiable"),
      /is unverifiable/,
      "a fact the host cannot re-read"
    )
    const foreignScope = { projectFingerprint: workspaceProjectFingerprint(["file:///other-project"]), conversationId: "foreign-chat", writer: "foreign-chat" }
    const foreign = new TodoRepository(state.databasePath, wasmPath)
    await expectRejected(
      referenceEvidence(todoWorkspaceTools(foreign, foreignScope, () => undefined, { readCurrentSource: currentWorkspace }), modify, factId, "reject-foreign"),
      /not found in this project/,
      "a fact from another project"
    )

    assert.equal((await reviewFor(state, modify)).evidence.length, 0, "no rejected reference is recorded")
    assert.equal((await state.repository.getItem(state.scope, modify)).item.status, "in_review")
  } finally {
    removeAll(state.directory)
  }
})

const MODIFY_REQUEST = "Change read_file so it reports its line count, then verify the change."
const MODIFY_CRITERION = "Change the `read_file` tool in src/extension/tools/workspace.ts to report its line count"
const contentHashOf = (output: string) => /content_hash: (\S+?);/.exec(output)![1]
const setStatus = async (repository: TodoRepository, scope: EvidenceFixture["scope"], itemId: string, status: "in_progress" | "in_review", requestId: string) => {
  const item = (await repository.getItem(scope, itemId)).item
  return repository.updateItem(scope, { itemId, expectedVersion: item.version, patch: { status }, actor: "model", requestId })
}
/** The production line editor applied to the real workspace file, so later reads see the change. */
const diskEditSink = (): EditSink => ({
  mode: "apply",
  read: async (file) => fs.readFileSync(file, "utf8"),
  edit: async () => ({ ok: true, message: "unused" }),
  create: async () => ({ ok: true, message: "unused" }),
  async editLines(file, request) {
    const text = fs.readFileSync(file, "utf8")
    const patches = await planLineEdits(text, request)
    let next = text
    for (const patch of [...patches].reverse()) next = next.slice(0, patch.start) + patch.text + next.slice(patch.end)
    fs.writeFileSync(file, next)
    return { ok: true, message: "applied", contentHash: await contentHash(next) }
  }
})

test("Scenario C: a location fact accepted in one conversation guides a modification in another without completing it", async () => {
  const workspace = sourceWorkspace()
  const reads = { count: 0 }
  const conversationA = await fixture(overlappingPlan, false, EVIDENCE_REQUEST)
  try {
    const { observation: locateObservation, verdict } = await establishFact(conversationA, workspace, reads)
    assert.equal(verdict.decision, "accept")
    const acceptedInA = (await conversationA.repository.listAcceptedEvidence(conversationA.scope)).find((candidate) => candidate.path === READ_FILE_SOURCE)!
    const originalFact = { ...acceptedInA }

    const scopeB = { projectFingerprint: conversationA.scope.projectFingerprint, conversationId: "chat-b", writer: "chat-b" }
    const repositoryB = new TodoRepository(conversationA.databasePath, wasmPath)
    await repositoryB.synchronizeIntentPlan(scopeB, plan([{ id: "modify", criteria: [{ id: "modify", description: MODIFY_CRITERION, verification: { kind: "workspace_mutation" } }, { id: "modify-subject", description: LOCATE_CRITERION, verification: { kind: "source_location", identity: "registered_tool", symbol: "read_file", path: READ_FILE_SOURCE } }] }], MODIFY_REQUEST), { prompt: MODIFY_REQUEST })
    const modify = (await repositoryB.getList(scopeB)).items.find((item) => item.title === "modify")!

    const facts = await repositoryB.listAcceptedEvidence(scopeB)
    assert.deepEqual(facts.map((fact) => fact.id), [acceptedInA.id], "conversation B sees the project's accepted fact")
    const selection = await selectAcceptedFacts({ text: MODIFY_REQUEST, planItemIds: [modify.id] }, facts, sourceReader(workspace), 12)
    assert.equal(selection.selected.length, 1)
    assert.equal(selection.selected[0].freshness, "current")
    assert.equal(selection.selected[0].fact.observationId, locateObservation.id, "provenance points to conversation A's observation")
    assert.equal(selection.selected[0].fact.conversationId, conversationA.scope.conversationId)
    const context = renderPlanContext((await repositoryB.getPlanOutline(scopeB))!, selection.selected, selection.omitted)
    assert.ok(context.includes(`observation ${locateObservation.id}`), "the implementer receives the accepted location as compact context")

    assert.deepEqual(await completeProvenReviews(repositoryB, scopeB, sourceReader(workspace)), [], "knowing the location does not complete the modification")
    assert.equal((await repositoryB.getItem(scopeB, modify.id)).item.status, "pending")

    await setStatus(repositoryB, scopeB, modify.id, "in_progress", "modify-claim")
    const implementer = workspaceTools(workspace, [], { edits: diskEditSink(), git: false, instructions: false })
    const toolCalls: string[] = []
    const run = (name: string, args: Record<string, string>) => {
      toolCalls.push(name)
      return implementer.run({ name, args })
    }

    const window = { path: READ_FILE_SOURCE, start_line: String(acceptedInA.startLine), end_line: String(acceptedInA.endLine) }
    const readBefore = await run("read_file", window)
    assert.notEqual(readBefore.failed, true, readBefore.output)
    assert.ok(readBefore.output.includes("const readFile = (view"), "the current source is read from the accepted range")
    const beforeHash = contentHashOf(readBefore.output)
    await repositoryB.recordToolObservation(scopeB, { itemId: modify.id, toolName: "read_file", arguments: window, output: "read", failed: false, requestId: "modify-read-before", evidenceOutput: readBefore.output })

    const reference = await todoWorkspaceTools(repositoryB, scopeB, () => undefined, { readCurrentSource: sourceReader(workspace) }).run({
      name: "twinny_todo_evidence",
      args: { item_id: modify.id, kind: "observation", summary: "cites the accepted location", result: "observed", request_id: "modify-reference", accepted_fact_id: acceptedInA.id }
    })
    assert.equal(reference.failed, undefined, reference.output)
    assert.equal((await repositoryB.getItem(scopeB, modify.id)).item.status, "in_progress", "the reference supports the TODO without completing it")

    const edit = await run("edit_lines", { path: READ_FILE_SOURCE, expected_hash: beforeHash, edits: JSON.stringify([{ operation: "insert_after", line: 169, content: ["  const reportedLineCount = 0"] }]) })
    assert.notEqual(edit.failed, true, edit.output)
    const editObservation = await repositoryB.recordToolObservation(scopeB, { itemId: modify.id, toolName: "edit_lines", arguments: { path: READ_FILE_SOURCE }, output: edit.output, failed: false, requestId: "modify-edit" })

    const verifyWindow = { path: READ_FILE_SOURCE, start_line: String(acceptedInA.startLine), end_line: String(acceptedInA.endLine + 1) }
    const verify = await run("read_file", verifyWindow)
    assert.ok(verify.output.includes("const reportedLineCount = 0"), "the change is present in the current source")
    assert.notEqual(contentHashOf(verify.output), beforeHash)
    const verifyObservation = await repositoryB.recordToolObservation(scopeB, { itemId: modify.id, toolName: "read_file", arguments: verifyWindow, output: "read", failed: false, requestId: "modify-verify", evidenceOutput: verify.output })
    assert.deepEqual(toolCalls, ["read_file", "edit_lines", "read_file"], "no workspace-wide discovery was needed")

    await setStatus(repositoryB, scopeB, modify.id, "in_review", "modify-in-review")
    const review = (await repositoryB.getReviewPackages(scopeB)).find((candidate) => candidate.task.id === modify.id)!
    assert.ok(review.evidence.some((row) => row.kind === "accepted_fact"), "the reviewer sees the host-recorded reference")
    const evaluation = await evaluateTodoReview(repositoryB, scopeB, review,
      async () => responseFor(review, { refs: [editObservation.id, verifyObservation.id] }), "mock-reviewer",
      { readCurrentSource: sourceReader(workspace), hasVerifiedFileChanges: true })
    assert.equal(evaluation.decision, "accept", JSON.stringify(evaluation.problems))
    assert.equal((await repositoryB.getItem(scopeB, modify.id)).item.status, "completed", "completion follows the verified edit, not the known location")

    const preserved = (await repositoryB.listAcceptedEvidence(scopeB)).find((candidate) => candidate.id === originalFact.id)
    assert.ok(preserved?.supersededBy, "the revision accepted in conversation B supersedes conversation A's fact")
    assert.deepEqual({ ...preserved!, supersededBy: undefined }, originalFact, "conversation A's accepted provenance is unchanged")
    const assessed = await assessAcceptedFacts(await repositoryB.listAcceptedEvidence(scopeB), sourceReader(workspace))
    assert.equal(assessed.find((candidate) => candidate.fact.id === originalFact.id)!.freshness, "historical", "the old location is not presented as current")
  } finally {
    removeAll(conversationA.directory, workspace)
  }
})

// Gate 1: typed verification contracts, exercised through the repository, observations, and the production reconciler.
const typedCriterion = (id: string, description: string, verification: TypedCriterion["verification"]): TypedCriterion => ({ id, description, verification })
const CHECK_TITLE = "Check accepted evidence"
const SOURCE_CRITERIA = [
  typedCriterion("location", "readFile is declared in workspace.ts", { kind: "source_location", identity: "implementation_symbol", symbol: "readFile", path: READ_FILE_SOURCE }),
  typedCriterion("fingerprint", "readFile's authoritative fingerprint is reported by read_file", { kind: "source_fingerprint", identity: "implementation_symbol", symbol: "readFile", path: READ_FILE_SOURCE }),
  typedCriterion("range", "readFile spans its declaration through the closing brace", { kind: "source_range", identity: "implementation_symbol", symbol: "readFile", path: READ_FILE_SOURCE })
]

test("Gate 1: a successful lookup proves completion whether or not facts were found; failed, subject-scoped, and inconsistent lookups prove neither", async () => {
  const cases = [
    { name: "none", arguments: evidenceCheckRecord([]).arguments, failed: false, lookup: "proven", existence: "disproven" },
    { name: "found", arguments: evidenceCheckRecord([acceptedFact("fact-live")]).arguments, failed: false, lookup: "proven", existence: "unknown" },
    { name: "failed", arguments: evidenceCheckRecord([]).arguments, failed: true, lookup: "unknown", existence: "unknown" },
    { name: "subject-scoped", arguments: { ...evidenceCheckRecord([]).arguments, scope: "subject" }, failed: false, lookup: "unknown", existence: "unknown" },
    { name: "inconsistent", arguments: { ...evidenceCheckRecord([]).arguments, factCount: "2" }, failed: false, lookup: "unknown", existence: "unknown" }
  ]
  for (const example of cases) {
    const state = await fixture([{ id: "check", title: CHECK_TITLE, criteria: [LOOKUP_DONE, FACT_EXISTS] }], false, EVIDENCE_REQUEST)
    try {
      const id = itemTitled(state, CHECK_TITLE).id
      await claimTask(state, CHECK_TITLE, `lookup-${example.name}-claim`)
      await state.repository.recordToolObservation(state.scope, {
        itemId: id,
        toolName: EVIDENCE_CHECK_TOOL,
        arguments: example.arguments,
        output: `lookup ${example.name}`,
        failed: example.failed,
        requestId: `lookup-${example.name}-observation`
      })
      const [lookup, fact] = await reviewReconciliations(await reviewOf(state, id))
      assert.equal(lookup.outcome, example.lookup, `${example.name}: evidence_lookup_completed`)
      assert.equal(fact.outcome, example.existence, `${example.name}: accepted_fact_exists`)
    } finally {
      removeAll(state.directory)
    }
  }
})

test("Gate 1: only a semantic_review criterion asks the evaluator; host-decided criteria complete without Feedback", async () => {
  const hostOnly = await fixture([{ id: "check", title: CHECK_TITLE, criteria: [LOOKUP_DONE] }], false, EVIDENCE_REQUEST)
  try {
    await claimTask(hostOnly, CHECK_TITLE, "host-only-claim")
    await hostOnly.repository.recordToolObservation(hostOnly.scope, { itemId: itemTitled(hostOnly, CHECK_TITLE).id, toolName: EVIDENCE_CHECK_TOOL, ...evidenceCheckRecord([]), failed: false, requestId: "host-only-lookup" })
    let calls = 0
    await evaluateTodoReview(hostOnly.repository, hostOnly.scope, await reviewOf(hostOnly, itemTitled(hostOnly, CHECK_TITLE).id), async () => {
      calls += 1
      throw new Error("Feedback was asked about a host-decided criterion")
    }, "mock-reviewer").catch(() => undefined)
    assert.equal(calls, 0)
    assert.equal(await statusOf(hostOnly, CHECK_TITLE), "completed")
  } finally {
    removeAll(hostOnly.directory)
  }

  const mixed = await fixture([{ id: "check", title: CHECK_TITLE, criteria: [LOOKUP_DONE, typedCriterion("judgment", "The summary is accurate", { kind: "semantic_review" })] }], false, EVIDENCE_REQUEST)
  try {
    await claimTask(mixed, CHECK_TITLE, "mixed-claim")
    await mixed.repository.recordToolObservation(mixed.scope, { itemId: itemTitled(mixed, CHECK_TITLE).id, toolName: EVIDENCE_CHECK_TOOL, ...evidenceCheckRecord([]), failed: false, requestId: "mixed-lookup" })
    const outcomes = await reviewReconciliations(await reviewOf(mixed, itemTitled(mixed, CHECK_TITLE).id))
    assert.deepEqual(outcomes.map((outcome) => outcome.outcome), ["proven", "semantic"])
    let calls = 0
    await evaluateTodoReview(mixed.repository, mixed.scope, await reviewOf(mixed, itemTitled(mixed, CHECK_TITLE).id), async () => {
      calls += 1
      throw new Error("Feedback review requested")
    }, "mock-reviewer").catch(() => undefined)
    assert.equal(calls, 1, "the semantic criterion is the only reason to ask Feedback")
  } finally {
    removeAll(mixed.directory)
  }
})

test("Gate 1: a read ending at line 219 cannot prove the closing brace at 220; a later boundary read completes the range from both observations", async () => {
  const workspace = sourceWorkspace()
  const reads = { count: 0 }
  const state = await fixture([{ id: "locate", title: LIVE_TASK, criteria: SOURCE_CRITERIA }], false, EVIDENCE_REQUEST)
  try {
    const id = itemTitled(state, LIVE_TASK).id
    await claimTask(state, LIVE_TASK, "source-claim")
    const short = await recordRead(state, id, "source-short", await runReadFile(workspace, reads, "169", "219"))
    const afterShort = await reviewReconciliations(await reviewOf(state, id), sourceReader(workspace))
    assert.deepEqual(afterShort.map((outcome) => outcome.outcome), ["proven", "proven", "unknown"])
    const tail = await recordRead(state, id, "source-tail", await runReadFile(workspace, reads, "220", "220"))
    const afterTail = await reviewReconciliations(await reviewOf(state, id), sourceReader(workspace))
    assert.equal(afterTail[2].outcome, "proven")
    assert.deepEqual([...afterTail[2].supportingObservationIds].sort(), [short.id, tail.id].sort(), "the range rests on both reads together")
    assert.equal(reads.count, 2)
  } finally {
    removeAll(state.directory, workspace)
  }
})

const NEGATIVE_FILE = "src/fixtures/negative.ts"
const negativeText = [
  "import { ghost } from \"./elsewhere\"",
  "// function ghost() {}",
  "const label = \"class ghost\"",
  "const unrelated = { ghost: 1 }",
  "export const real = 1"
].join("\n")
const negativeReader: CurrentSourceReader = async (file) => (file === NEGATIVE_FILE ? negativeText : undefined)

test("a name present only in an import, comment, string, or unrelated key never satisfies an implementation symbol, and a complete read disproves it", async () => {
  const state = await evidenceFixture(sourceLocation("ghost", "`ghost` is established in the negative fixture", "ghost", "implementation_symbol", NEGATIVE_FILE))
  try {
    const item = await startInvestigation(state)
    await observeSourceWindow(state, item.id, "read-negative", NEGATIVE_FILE, negativeText, 1, 5)
    const review = await reviewFor(state, item.id)
    const [reconciliation] = await reviewReconciliations(review, negativeReader)
    assert.equal(reconciliation.outcome, "disproven", JSON.stringify(reconciliation))
    assert.equal(reconciliation.failureReason, "contradicted_evidence")
    assert.deepEqual(reconciliation.supportingObservationIds.length > 0, true)
  } finally {
    removeAll(state.directory)
  }
})

const DYNAMIC_FILE = "src/fixtures/dynamic.ts"
const dynamicText = [
  "const makeName = () => \"dynamic_tool\"",
  "export const tools = () => [",
  "  { name: makeName(), run() { return 1 } }",
  "]"
].join("\n")
const dynamicReader: CurrentSourceReader = async (file) => (file === DYNAMIC_FILE ? dynamicText : undefined)

test("a tool registered under a computed name blocks disproof of an absent registered name, and the outcome says why", async () => {
  const state = await evidenceFixture(sourceLocation("dynamic", "`dynamic_tool` is registered in the dynamic fixture", "dynamic_tool", "registered_tool", DYNAMIC_FILE))
  try {
    const item = await startInvestigation(state)
    await observeSourceWindow(state, item.id, "read-dynamic", DYNAMIC_FILE, dynamicText, 1, 4)
    const review = await reviewFor(state, item.id)
    const [reconciliation] = await reviewReconciliations(review, dynamicReader)
    assert.notEqual(reconciliation.outcome, "disproven", JSON.stringify(reconciliation))
    assert.equal(reconciliation.outcome, "unknown")
    assert.equal(reconciliation.failureReason, "unsupported_operation")
    assert.match(reconciliation.missing.join("\n"), /computed name/)
  } finally {
    removeAll(state.directory)
  }
})

test("a partial read establishes neither presence nor absence of a declaration, and a complete read decides both", async () => {
  const present = sourceLocation("present", "`readFile` is established in the workspace", "readFile", "implementation_symbol", EVIDENCE_FILE)
  const absent = sourceLocation("absent", "`nowhereFunction` is established in the workspace", "nowhereFunction", "implementation_symbol", EVIDENCE_FILE)
  const partial = await reviewCriteria([present, absent], [await workspaceRecord(1, 100)], currentWorkspace)
  assert.deepEqual(partial.map((outcome) => outcome.outcome), ["unknown", "unknown"], JSON.stringify(partial))
  assert.deepEqual(partial.map((outcome) => outcome.failureReason), ["missing_evidence", "missing_evidence"])
  const complete = await reviewCriteria([present, absent], [await workspaceRecord(1, sourceLines.length)], currentWorkspace)
  assert.deepEqual(complete.map((outcome) => outcome.outcome), ["proven", "disproven"], JSON.stringify(complete))
})

test("Gate 1: one complete read_file observation proves location, fingerprint, and range, emits one fact, and is not reused after the file or symbol changes", async () => {
  const workspace = sourceWorkspace()
  const reads = { count: 0 }
  const wrongSymbol = typedCriterion("wrong", "writeFile spans its declaration", { kind: "source_range", identity: "implementation_symbol", symbol: "writeFile", path: READ_FILE_SOURCE })
  const state = await fixture([{ id: "locate", title: LIVE_TASK, criteria: [...SOURCE_CRITERIA, wrongSymbol] }], false, EVIDENCE_REQUEST)
  try {
    const id = itemTitled(state, LIVE_TASK).id
    await claimTask(state, LIVE_TASK, "full-claim")
    const observation = await recordRead(state, id, "full-read", await runReadFile(workspace, reads, "169", "220"))
    const outcomes = await reviewReconciliations(await reviewOf(state, id), sourceReader(workspace))
    assert.deepEqual(outcomes.slice(0, 3).map((outcome) => outcome.outcome), ["proven", "proven", "proven"])
    assert.ok(outcomes.slice(0, 3).every((outcome) => outcome.supportingObservationIds.includes(observation.id)))
    assert.equal(outcomes.filter((outcome) => outcome.facts?.length).length, 1, "the range fact is emitted once")
    assert.equal(outcomes[3].outcome, "unknown", "the read covers lines 169–220 only, so a declaration with another name elsewhere in the file is not established absent")
    assert.equal(outcomes[3].failureReason, "missing_evidence")
    assert.match(outcomes[3].missing.join("\n"), /absence is not established/)
    fs.writeFileSync(path.join(workspace, READ_FILE_SOURCE), `${realWorkspaceSource}\n// edited after the read\n`)
    const stale = await reviewReconciliations(await reviewOf(state, id), sourceReader(workspace))
    assert.ok(stale.slice(0, 3).every((outcome) => outcome.outcome !== "proven"), "a changed file does not keep its proof")
  } finally {
    removeAll(state.directory, workspace)
  }
})

test("Gate 1: typed criteria, outcomes, and observation links survive reopen", async () => {
  const workspace = sourceWorkspace()
  const reads = { count: 0 }
  const state = await fixture([{ id: "locate", title: LIVE_TASK, criteria: SOURCE_CRITERIA }], false, EVIDENCE_REQUEST)
  try {
    const id = itemTitled(state, LIVE_TASK).id
    await claimTask(state, LIVE_TASK, "reopen-claim")
    const observation = await recordRead(state, id, "reopen-read", await runReadFile(workspace, reads, "169", "220"))
    const verdict = await evaluateTodoReview(state.repository, state.scope, await reviewOf(state, id), async () => {
      throw new Error("Feedback must not judge objective source criteria")
    }, "mock-reviewer", { readCurrentSource: sourceReader(workspace) })
    assert.equal(verdict.decision, "accept")
    const reopened = new TodoRepository(state.databasePath, wasmPath)
    const history = await reopened.getEvaluationHistory(state.scope, id)
    assert.deepEqual(history.at(-1)!.criteria.map((criterion) => criterion.criterionId), ["location", "fingerprint", "range"])
    assert.ok(history.at(-1)!.criteria.every((criterion) => criterion.reconciliation?.supportingObservationIds.includes(observation.id)))
    assert.equal((await reopened.getItem(state.scope, id)).item.status, "completed")
  } finally {
    removeAll(state.directory, workspace)
  }
})

// Gate 0 reproducer: the planner creates the dependent TODOs from a scripted model reply, and the host records the
// lookup with the production record builder. The assertions describe the intended contract, not the current output.
const GATE0_CHECK_TASK = "Check for existing accepted evidence of native read_file implementation"
const GATE0_CHECK_CRITERION = "Check for existing accepted evidence of read_file project-wide"
const GATE0_PLAN = plan([
  { id: "check", title: GATE0_CHECK_TASK, criteria: [{ id: "lookup-completed", description: GATE0_CHECK_CRITERION, verification: { kind: "evidence_lookup_completed" } }] },
  { id: "locate-native-read-file", title: LIVE_TASK, criteria: LIVE_CRITERIA, dependencies: ["check"] }
], EVIDENCE_REQUEST)

/** A repository whose TODOs were written by the production FeedbackPlanner from a scripted model reply. */
const plannedBy = async (planned: ReturnType<typeof plan>) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-gate0-"))
  const databasePath = path.join(directory, "twinny-state.sqlite")
  const scope: TodoWriteRequest = { projectFingerprint: workspaceProjectFingerprint(["file:///feedback-project"]), conversationId: "feedback-chat", writer: "feedback-chat" }
  const repository = new TodoRepository(databasePath, wasmPath)
  const planner = new FeedbackPlanner({
    enabled: () => true,
    repository: () => repository,
    resolve: () => ({
      ok: true,
      endpoint: { infer: async () => JSON.stringify({ track: true, plan: planned }), provider: "scripted", model: "feedback-model", label: "Scripted" }
    })
  })
  const outcome = await planner.start(scope, EVIDENCE_REQUEST)
  return { directory, databasePath, scope, repository, status: outcome.status }
}
const titled = async (state: { repository: TodoRepository; scope: TodoWriteRequest }, title: string) =>
  (await state.repository.getList({ ...state.scope, includeCompleted: true })).items.find((item) => item.title === title)!

test("Gate 0 reproducer: a planner-created lookup TODO is proven by the host's completed none lookup, with no Feedback judgment", async () => {
  const state = await plannedBy(GATE0_PLAN)
  try {
    assert.equal(state.status, "planned", "the scripted two-task plan is accepted by the planner")
    const check = await titled(state, GATE0_CHECK_TASK)
    await state.repository.updateItem(state.scope, { itemId: check.id, expectedVersion: check.version, patch: { status: "in_review" }, actor: "model", requestId: "gate0-claim" })
    await state.repository.recordToolObservation(state.scope, {
      itemId: check.id,
      toolName: EVIDENCE_CHECK_TOOL,
      ...evidenceCheckRecord([]),
      failed: false,
      requestId: "gate0-lookup"
    })
    let evaluatorCalls = 0
    const review = (await state.repository.getReviewPackages(state.scope)).find((candidate) => candidate.task.id === check.id)!
    await evaluateTodoReview(state.repository, state.scope, review, async () => {
      evaluatorCalls += 1
      throw new Error("Feedback judged a criterion the host had already proven")
    }, "mock-reviewer").catch(() => undefined)
    assert.equal(evaluatorCalls, 0, "a completed lookup proves its inquiry without Feedback")
    assert.equal((await state.repository.getItem(state.scope, check.id)).item.status, "completed")
  } finally {
    removeAll(state.directory)
  }
})

test("Gate 0 reproducer: the dependent TODO is released by the completed lookup, and one read_file observation proves its criteria with no second read or Feedback call", async () => {
  const workspace = sourceWorkspace()
  const reads = { count: 0 }
  const state = await plannedBy(GATE0_PLAN)
  try {
    assert.equal(state.status, "planned")
    const check = await titled(state, GATE0_CHECK_TASK)
    await state.repository.completeByUser(state.scope, check.id, check.version, "Lookup completed", "gate0-check-complete", trustedTodoPanelApproval)
    const locate = await titled(state, LIVE_TASK)
    const claimed = await state.repository.updateItem(state.scope, { itemId: locate.id, expectedVersion: locate.version, patch: { status: "in_review" }, actor: "model", requestId: "gate0-locate-claim" })
    assert.equal(claimed.status, "in_review", "the dependent TODO is released once its prerequisite completes")
    const read = await runReadFile(workspace, reads, "169", "220")
    await state.repository.recordToolObservation(state.scope, {
      itemId: locate.id,
      toolName: "read_file",
      arguments: read.args,
      output: read.result.summary ?? "read",
      failed: false,
      requestId: "gate0-read",
      evidenceOutput: read.result.output
    })
    let evaluatorCalls = 0
    const review = (await state.repository.getReviewPackages(state.scope)).find((candidate) => candidate.task.id === locate.id)!
    const verdict = await evaluateTodoReview(state.repository, state.scope, review, async () => {
      evaluatorCalls += 1
      throw new Error("Feedback judged criteria the host had already proven")
    }, "mock-reviewer", { readCurrentSource: sourceReader(workspace) })
    assert.equal(evaluatorCalls, 0)
    assert.equal(verdict.decision, "accept")
    assert.equal((await state.repository.getItem(state.scope, locate.id)).item.status, "completed")
    assert.equal(reads.count, 1, "the trusted observation from one read establishes the locate facts")
  } finally {
    removeAll(state.directory, workspace)
  }
})

test("Gate 0 reproducer: a read that stops at line 219 does not prove a range whose closing brace is line 220", async () => {
  const workspace = sourceWorkspace()
  const reads = { count: 0 }
  const state = await fixture(livePlan, false, EVIDENCE_REQUEST)
  try {
    await claimTask(state, LIVE_TASK, "range-claim")
    const read = await runReadFile(workspace, reads, "169", "219")
    await recordRead(state, itemTitled(state, LIVE_TASK).id, "range-read-219", read)
    const review = await reviewOf(state, itemTitled(state, LIVE_TASK).id)
    const range = review.criteria.findIndex((criterion) => criterion.id === "range")
    const verdict = await evaluateTodoReview(state.repository, state.scope, review, async () => {
      throw new Error("Feedback is asked only about criteria the host cannot decide")
    }, "mock-reviewer", { readCurrentSource: sourceReader(workspace) }).catch(() => undefined)
    const outcome = verdict?.criteria[range]?.reconciliation?.outcome
    assert.notEqual(outcome, "proven", `the range 169-219 is not the declaration 169-220 (observed outcome: ${outcome ?? "no verdict"})`)
    assert.notEqual(await statusOf(state, LIVE_TASK), "completed")
  } finally {
    removeAll(state.directory, workspace)
  }
})

test("Gate 0 negative control: a criterion that requires accepted evidence to exist is not satisfied by a none lookup", async () => {
  const requirement = "Accepted evidence of read_file exists before the implementation is reported."
  const state = await fixture([{ id: "locate-native-read-file", title: LIVE_TASK, criteria: [{ id: "exists", description: requirement, verification: { kind: "accepted_fact_exists", identity: "registered_tool", symbol: "read_file" } }] }], false, EVIDENCE_REQUEST)
  try {
    await claimTask(state, LIVE_TASK, "control-claim")
    await state.repository.recordToolObservation(state.scope, {
      itemId: itemTitled(state, LIVE_TASK).id,
      toolName: EVIDENCE_CHECK_TOOL,
      ...evidenceCheckRecord([]),
      failed: false,
      requestId: "control-lookup"
    })
    let seen: TodoCriterionReconciliation[] | undefined
    const verdict = await evaluateTodoReview(state.repository, state.scope, await reviewOf(state, itemTitled(state, LIVE_TASK).id), async (_correction, reconciliations) => {
      seen = reconciliations
      throw new Error("Feedback is asked only about criteria the host cannot decide")
    }, "mock-reviewer").catch(() => undefined)
    const outcome = verdict?.criteria[0]?.reconciliation?.outcome ?? seen?.[0]?.outcome
    assert.equal(outcome, "disproven", "a none result is absence, which contradicts an existence requirement")
    assert.notEqual(await statusOf(state, LIVE_TASK), "completed")
  } finally {
    removeAll(state.directory)
  }
})

const RERUN_CRITERION: TypedCriterion = { id: "tests-pass-again", description: "`npm test` is run again and exits 0", verification: { kind: "command_exit_status", command: "npm test", exitCode: 0, execution: "after_activation" } }
const recordRerun = (state: FeedbackFixture, requestId: string) => state.repository.recordToolObservation(state.scope, {
  itemId: itemTitled(state, "again").id,
  toolName: "run_command",
  arguments: runCommandArguments("npm test"),
  output: "pass",
  failed: false,
  exitCode: 0,
  requestId
})
const openReviewOf = async (state: FeedbackFixture, itemId: string) =>
  (await state.repository.getReviewPackages(state.scope, { includeOpen: true })).find((candidate) => candidate.task.id === itemId)!
const rerunOutcome = async (state: FeedbackFixture) => (await reviewReconciliations(await openReviewOf(state, itemTitled(state, "again").id)))[0]

test("requirement renewal invalidates earlier runs, and only a run after the renewal proves the renewed requirement", async () => {
  const state = await fixture([{ id: "again", criteria: [RERUN_CRITERION] }], false, EVIDENCE_REQUEST)
  try {
    const activation = await state.repository.activateRequirement(state.scope, itemTitled(state, "again").id, "activate-1")
    await recordRerun(state, "run-1")
    assert.equal((await rerunOutcome(state)).outcome, "proven")
    const renewal = await state.repository.renewRequirement(state.scope, itemTitled(state, "again").id, "renew-1")
    assert.equal(renewal.kind, "renewal")
    assert.ok(renewal.listRevision > activation.listRevision, "a renewal is causally after the activation it supersedes")
    const afterRenewal = await rerunOutcome(state)
    assert.equal(afterRenewal.outcome, "unknown")
    assert.match(afterRenewal.missing[0], /predates the requirement activation/)
    await recordRerun(state, "run-2")
    assert.equal((await rerunOutcome(state)).outcome, "proven")
  } finally {
    removeAll(state.directory)
  }
})

test("a run recorded before activation cannot satisfy an execution requirement, and the reason names the missing activation", async () => {
  const state = await fixture([{ id: "again", criteria: [RERUN_CRITERION] }], false, EVIDENCE_REQUEST)
  try {
    assert.equal((await rerunOutcome(state)).outcome, "unknown")
    assert.match((await rerunOutcome(state)).missing[0], /not activated for this task yet/)
    await recordRerun(state, "run-before")
    assert.equal((await rerunOutcome(state)).outcome, "unknown")
    assert.match((await rerunOutcome(state)).missing[0], /not activated for this task yet/)
    await state.repository.activateRequirement(state.scope, itemTitled(state, "again").id, "activate-late")
    const outcome = await rerunOutcome(state)
    assert.equal(outcome.outcome, "unknown")
    assert.match(outcome.missing[0], /predates the requirement activation/)
  } finally {
    removeAll(state.directory)
  }
})

test("repeated reviews without renewal keep the same activation and the same proven outcome", async () => {
  const state = await fixture([{ id: "again", criteria: [RERUN_CRITERION] }], false, EVIDENCE_REQUEST)
  try {
    const activation = await state.repository.activateRequirement(state.scope, itemTitled(state, "again").id, "activate-once")
    await recordRerun(state, "run-once")
    const first = await openReviewOf(state, itemTitled(state, "again").id)
    const second = await openReviewOf(state, itemTitled(state, "again").id)
    assert.deepEqual(first.requirementActivation, activation)
    assert.deepEqual(second.requirementActivation, activation)
    assert.equal((await reviewReconciliations(first))[0].outcome, "proven")
    assert.equal((await reviewReconciliations(second))[0].outcome, "proven")
  } finally {
    removeAll(state.directory)
  }
})

test("activation is idempotent per item, and an activation and its renewal persist across repository reopen", async () => {
  const state = await fixture([{ id: "again", criteria: [RERUN_CRITERION] }], false, EVIDENCE_REQUEST)
  try {
    const first = await state.repository.activateRequirement(state.scope, itemTitled(state, "again").id, "activate-a")
    const again = await state.repository.activateRequirement(state.scope, itemTitled(state, "again").id, "activate-b")
    assert.equal(again.id, first.id, "a second first-activation returns the existing activation")
    const renewal = await state.repository.renewRequirement(state.scope, itemTitled(state, "again").id, "renew-persist")
    const reopened = new TodoRepository(state.databasePath, wasmPath)
    const review = (await reopened.getReviewPackages(state.scope, { includeOpen: true })).find((candidate) => candidate.task.id === itemTitled(state, "again").id)!
    assert.deepEqual(review.requirementActivation, renewal)
    assert.equal(review.requirementActivation!.kind, "renewal")
  } finally {
    removeAll(state.directory)
  }
})

test("the command_exit_status execution field accepts the two typed values and rejects others and historical after_activation", () => {
  const withExecution = (execution: unknown, scope?: unknown) => ({
    planId: "feedback-plan",
    version: 1,
    revision: 1,
    goal: "Verify",
    constraints: [],
    tasks: [{ id: "again", title: "again", description: "Re-run the tests after activation", dependencies: [], criteria: [{ id: "c", description: "`npm test` exits 0", verification: { kind: "command_exit_status", command: "npm test", exitCode: 0, ...(execution === undefined ? {} : { execution }), ...(scope === undefined ? {} : { scope }) } }] }]
  })
  assert.ok(validateIntentTaskPlan(withExecution("recorded")).plan)
  assert.ok(validateIntentTaskPlan(withExecution("after_activation")).plan)
  assert.match(validateIntentTaskPlan(withExecution("sometimes")).diagnostic ?? "", /execution must be recorded or after_activation/)
  assert.match(validateIntentTaskPlan(withExecution("after_activation", "historical")).diagnostic ?? "", /cannot be both historical and after_activation/)
})

test("a version-10 database with accepted evidence upgrades to version 11 with every evidence row and relationship intact", async () => {
  const state = await evidenceFixtureFor(TWO_TASKS)
  try {
    const [first] = state.itemIds
    await startItemInReview(state.repository, state.scope, first)
    const observation = await observeRead(state, first, "read-first", EVIDENCE_FILE, 150, sourceLines.slice(149, 220))
    const calls = { count: 0 }
    const evaluation = await evaluateTodoReview(state.repository, state.scope, await reviewFor(state, first), countingEvaluator(calls), "mock-reviewer", { readCurrentSource: currentWorkspace, hasVerifiedFileChanges: false })
    assert.equal(evaluation.decision, "accept", JSON.stringify(evaluation.problems))
    const facts = await state.repository.listAcceptedEvidence(state.scope, { symbol: "read_file", path: EVIDENCE_FILE })
    assert.equal(facts.length, 1)
    assert.equal(facts[0].observationId, observation.id)

    const sql = await initSqlJs({ locateFile: () => wasmPath })
    const inspect = () => {
      const database = new sql.Database(fs.readFileSync(state.databasePath))
      try {
        return {
          version: database.exec("PRAGMA user_version")[0].values[0][0],
          activationTable: database.exec("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'todo_requirement_activations'")[0].values[0][0],
          observations: database.exec("SELECT id, item_id, tool_name, list_revision FROM todo_tool_observations ORDER BY id")[0]?.values ?? []
        }
      } finally {
        database.close()
      }
    }
    const before = inspect()
    assert.ok(before.observations.some((row) => row[0] === observation.id && row[3] !== null), "the observation is ordered by its list revision before the upgrade")

    const downgrade = new sql.Database(fs.readFileSync(state.databasePath))
    downgrade.run("DROP TABLE todo_requirement_activations; PRAGMA user_version = 10")
    fs.writeFileSync(state.databasePath, Buffer.from(downgrade.export()))
    downgrade.close()

    const reopened = new TodoRepository(state.databasePath, wasmPath)
    await reopened.initialize()
    assert.deepEqual(await reopened.listAcceptedEvidence(state.scope, { symbol: "read_file", path: EVIDENCE_FILE }), facts, "the accepted fact and its provenance survive the upgrade unchanged")
    const upgraded = inspect()
    assert.equal(upgraded.version, 18)
    assert.equal(upgraded.activationTable, 1, "the requirement activation table is added")
    assert.deepEqual(upgraded.observations, before.observations, "no observation row or list revision changes during the upgrade")

    const again = new TodoRepository(state.databasePath, wasmPath)
    await again.initialize()
    assert.deepEqual(await again.listAcceptedEvidence(state.scope, { symbol: "read_file", path: EVIDENCE_FILE }), facts, "a second reopen is stable")
    assert.equal(inspect().version, 18)
    assert.equal(calls.count, 0)
  } finally {
    removeAll(state.directory)
  }
})

test("an unresolved edit target blocks other conversations in the same project, but not other projects", async () => {
  const state = await fixture([{ id: "edit-task", criteria: [semantic("edit-task", "The edit is applied")] }], false)
  try {
    const itemId = (await state.repository.getActiveIntentContext(state.scope))!.task.id
    const pre = editDigest("original\n")
    const post = editDigest("changed\n")
    await state.repository.beginEditOperation(state.scope, { id: "edit-owner", itemId, target: "src/shared.ts", mode: "apply", preDigest: pre, postDigest: post })

    const otherConversation = { projectFingerprint: state.scope.projectFingerprint, conversationId: "other-chat", writer: "other-chat" }
    await state.repository.synchronizeIntentPlan(otherConversation, plan([{ id: "other-task", criteria: [semantic("other-task", "The other edit is applied")] }], "Other goal"), { prompt: "Other goal" })
    const otherItemId = (await state.repository.getActiveIntentContext(otherConversation))!.task.id
    const blocked = { id: "edit-other", itemId: otherItemId, target: "src/shared.ts", mode: "apply" as const, preDigest: pre, postDigest: post }
    assert.deepEqual(await state.repository.findUnresolvedEditTarget(otherConversation, "src/shared.ts"), { operationId: "edit-owner", conversationId: "feedback-chat" })
    await assert.rejects(state.repository.beginEditOperation(otherConversation, blocked), TodoConflictError, "another conversation cannot duplicate an unresolved edit in the same project")
    assert.deepEqual((await state.repository.listDispatchedEditOperations(otherConversation)), [], "a refused edit is never recorded")

    const foreignProject = { projectFingerprint: workspaceProjectFingerprint(["file:///another-project"]), conversationId: "foreign-chat", writer: "foreign-chat" }
    await state.repository.synchronizeIntentPlan(foreignProject, plan([{ id: "foreign-task", criteria: [semantic("foreign-task", "The foreign edit is applied")] }], "Foreign goal"), { prompt: "Foreign goal" })
    const foreignItemId = (await state.repository.getActiveIntentContext(foreignProject))!.task.id
    assert.equal(await state.repository.findUnresolvedEditTarget(foreignProject, "src/shared.ts"), undefined, "an unresolved edit does not block another project")
    assert.equal((await state.repository.beginEditOperation(foreignProject, { id: "edit-foreign", itemId: foreignItemId, target: "src/shared.ts", mode: "apply", preDigest: pre, postDigest: post })).status, "dispatched")
  } finally {
    removeAll(state.directory)
  }
})

test("edit operations are recorded before dispatch, settle once, and block only unresolved targets", async () => {
  const state = await fixture([{ id: "edit-task", criteria: [semantic("edit-task", "The edit is applied")] }], false)
  try {
    const itemId = (await state.repository.getActiveIntentContext(state.scope))!.task.id
    const pre = editDigest("original\n")
    const post = editDigest("changed\n")
    const operation = (id: string, target: string) => ({ id, itemId, target, mode: "apply" as const, preDigest: pre, postDigest: post })

    assert.equal((await state.repository.beginEditOperation(state.scope, operation("edit-1", "src/a.ts"))).status, "dispatched")
    await assert.rejects(state.repository.beginEditOperation(state.scope, operation("edit-2", "src/a.ts")), TodoConflictError, "a second edit to an unresolved target is refused")
    await state.repository.beginEditOperation(state.scope, operation("edit-3", "src/b.ts"))
    await assert.rejects(state.repository.beginEditOperation(state.scope, { ...operation("edit-5", "src/c.ts"), itemId: "not-active" }), /limited to active Intent tasks/)

    assert.equal(await state.repository.settleEditOperation(state.scope, "edit-1", "succeeded", "applied"), true)
    assert.equal(await state.repository.settleEditOperation(state.scope, "edit-1", "failed", "late"), false, "a late settlement cannot overwrite a decided outcome")
    assert.equal(await state.repository.settleEditOperation(state.scope, "missing", "failed", ""), false)
    assert.deepEqual((await state.repository.listDispatchedEditOperations(state.scope)).map((record) => record.id), ["edit-3"])
    await state.repository.beginEditOperation(state.scope, operation("edit-4", "src/a.ts"))

    const reopened = new TodoRepository(state.databasePath, wasmPath)
    await reopened.initialize()
    assert.deepEqual((await reopened.listDispatchedEditOperations(state.scope)).map((record) => record.id), ["edit-3", "edit-4"], "unsettled operations survive reopen")
    assert.equal(await reopened.settleEditOperation(state.scope, "edit-3", "reconciled_absent", "The editor buffer holds the original text."), true)
    assert.equal(await reopened.settleEditOperation(state.scope, "edit-3", "succeeded", "late"), false, "reconciliation decides the outcome once")

    const sql = await initSqlJs({ locateFile: () => wasmPath })
    const database = new sql.Database(fs.readFileSync(state.databasePath))
    try {
      const statuses = database.exec("SELECT id, status FROM todo_edit_operations ORDER BY id")[0].values
      assert.deepEqual(statuses, [["edit-1", "succeeded"], ["edit-3", "reconciled_absent"], ["edit-4", "dispatched"]])
    } finally {
      database.close()
    }
  } finally {
    removeAll(state.directory)
  }
})

test("the v12 edit ledger rebuilds for optional task association, keeps its rows, and keeps a v12 backup", async () => {
  const state = await fixture([{ id: "migrated-edit", criteria: [semantic("migrated-edit", "Migrated edit task is pending")] }], false)
  const sql = await initSqlJs({ locateFile: () => wasmPath })
  const backupPath = `${state.databasePath}.v12.bak`
  const inspect = (file: string) => {
    const database = new sql.Database(fs.readFileSync(file))
    try {
      const itemColumn = database.exec("PRAGMA table_info(todo_edit_operations)")[0].values.find((row) => row[1] === "item_id")
      return {
        version: database.exec("PRAGMA user_version")[0].values[0][0],
        itemNullable: itemColumn?.[3] === 0,
        ids: (database.exec("SELECT id FROM todo_edit_operations ORDER BY id")[0]?.values ?? []).map((row) => row[0]),
        statuses: database.exec("SELECT id, status FROM todo_edit_operations ORDER BY id")[0]?.values ?? [],
        index: database.exec("SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'todo_edit_operations_target'")[0].values[0][0],
        cascadesFromItems: database.exec("PRAGMA foreign_key_list(todo_edit_operations)")[0].values.some((row) => row[2] === "todo_items" && row[6] === "CASCADE")
      }
    } finally {
      database.close()
    }
  }
  try {
    const itemId = (await state.repository.getActiveIntentContext(state.scope))!.task.id
    assert.deepEqual(inspect(state.databasePath), { version: 18, itemNullable: true, ids: [], statuses: [], index: 1, cascadesFromItems: true }, "a new database is created at the current version with an optional task")
    assert.equal(fs.existsSync(backupPath), false, "a new database has no earlier version to back up")

    await state.repository.beginEditOperation(state.scope, { id: "v12-edit", itemId, target: "src/old.ts", mode: "apply", preDigest: editDigest("a\n"), postDigest: editDigest("b\n") })
    await state.repository.settleEditOperation(state.scope, "v12-edit", "succeeded", "The edit was applied.")

    const downgrade = new sql.Database(fs.readFileSync(state.databasePath))
    downgrade.run(`
DROP INDEX todo_edit_operations_target;
ALTER TABLE todo_edit_operations RENAME TO todo_edit_operations_old;
CREATE TABLE todo_edit_operations (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL REFERENCES todo_lists(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES todo_items(id) ON DELETE CASCADE,
  target TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('apply','review')),
  pre_digest TEXT NOT NULL,
  post_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('dispatched','succeeded','failed','reconciled_applied','reconciled_absent','diverged')),
  detail TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX todo_edit_operations_target ON todo_edit_operations(list_id, target, status);
INSERT INTO todo_edit_operations (id, list_id, item_id, target, mode, pre_digest, post_digest, status, detail, created_at, updated_at)
  SELECT id, list_id, item_id, target, mode, pre_digest, post_digest, status, detail, created_at, updated_at FROM todo_edit_operations_old;
DROP TABLE todo_edit_operations_old;
PRAGMA user_version = 12;`)
    fs.writeFileSync(state.databasePath, Buffer.from(downgrade.export()))
    downgrade.close()
    assert.equal(inspect(state.databasePath).itemNullable, false, "the simulated v12 ledger requires a task")

    const reopened = new TodoRepository(state.databasePath, wasmPath)
    await reopened.initialize()
    const upgraded = inspect(state.databasePath)
    assert.equal(upgraded.version, 18)
    assert.equal(upgraded.itemNullable, true, "the task column becomes optional")
    assert.deepEqual(upgraded.statuses, [["v12-edit", "succeeded"]], "existing ledger rows keep their identity and settlement")
    assert.equal(upgraded.index, 1, "the target index is recreated")
    assert.equal(upgraded.cascadesFromItems, true, "a task deletion still removes its operations")
    assert.equal(inspect(backupPath).version, 12, "the v12 file is kept as a backup")
    assert.equal(inspect(backupPath).itemNullable, false)

    const free = await reopened.beginEditOperation(state.scope, { id: "v13-free", target: "src/free.ts", mode: "apply", preDigest: editDigest("a\n"), postDigest: editDigest("b\n") })
    assert.equal(free.itemId, undefined, "a project-scoped edit is recorded without a task")
    assert.deepEqual((await reopened.listUnresolvedEditOperations(state.scope)).map((op) => [op.id, op.itemId, op.conversationId]), [["v13-free", undefined, state.scope.conversationId]])
    await assert.rejects(reopened.beginEditOperation(state.scope, { id: "v13-unknown", itemId: "missing-task", target: "src/free.ts", mode: "apply", preDigest: editDigest("a\n"), postDigest: editDigest("b\n") }), /limited to active Intent tasks/, "a named task must still be active")

    const again = new TodoRepository(state.databasePath, wasmPath)
    await again.initialize()
    assert.deepEqual(inspect(state.databasePath).ids, ["v12-edit", "v13-free"], "a second reopen is stable")
    assert.equal(inspect(state.databasePath).version, 18)
  } finally {
    removeAll(state.directory)
  }
})

test("the owner column is additive: legacy edit rows stay unowned and each reopened row keeps its owner", async () => {
  const state = await fixture([{ id: "owned-edit", criteria: [semantic("owned-edit", "Owned edit task is pending")] }], false)
  const sql = await initSqlJs({ locateFile: () => wasmPath })
  const versionAndOwnerColumn = () => {
    const check = new sql.Database(fs.readFileSync(state.databasePath))
    try {
      return {
        version: check.exec("PRAGMA user_version")[0].values[0][0],
        ownerColumn: check.exec("PRAGMA table_info(todo_edit_operations)")[0].values.some((row) => row[1] === "owner_id")
      }
    } finally {
      check.close()
    }
  }
  try {
    await state.repository.beginEditOperation(state.scope, { id: "1-unowned-edit", target: "src/unowned.ts", mode: "apply", preDigest: editDigest("a\n"), postDigest: editDigest("b\n") })
    const downgrade = new sql.Database(fs.readFileSync(state.databasePath))
    downgrade.run("ALTER TABLE todo_edit_operations DROP COLUMN owner_id; PRAGMA user_version = 13")
    fs.writeFileSync(state.databasePath, Buffer.from(downgrade.export()))
    downgrade.close()
    assert.deepEqual(versionAndOwnerColumn(), { version: 13, ownerColumn: false })

    const reopened = new TodoRepository(state.databasePath, wasmPath)
    await reopened.initialize()
    assert.deepEqual(versionAndOwnerColumn(), { version: 18, ownerColumn: true }, "the upgrade adds the owner column")
    assert.deepEqual((await reopened.listUnresolvedEditOperations(state.scope)).map((op) => [op.id, op.ownerId]), [["1-unowned-edit", undefined]], "a legacy row has no owner")

    await reopened.beginEditOperation(state.scope, { id: "2-owned-edit", ownerId: "host-b", target: "src/owned.ts", mode: "apply", preDigest: editDigest("a\n"), postDigest: editDigest("b\n") })
    const again = new TodoRepository(state.databasePath, wasmPath)
    await again.initialize()
    assert.deepEqual((await again.listUnresolvedEditOperations(state.scope)).map((op) => [op.id, op.ownerId]), [["1-unowned-edit", undefined], ["2-owned-edit", "host-b"]], "owners survive a reopen")
    assert.deepEqual(versionAndOwnerColumn(), { version: 18, ownerColumn: true }, "a second reopen is stable")
  } finally {
    removeAll(state.directory)
  }
})


test("project edit reconciliation settles an operation once and stays inside its project", async () => {
  const state = await fixture([{ id: "reconcile-edit", criteria: [semantic("reconcile-edit", "The reconciled edit is applied")] }], false)
  try {
    const itemId = (await state.repository.getActiveIntentContext(state.scope))!.task.id
    const pre = editDigest("original\n")
    const post = editDigest("changed\n")
    await state.repository.beginEditOperation(state.scope, { id: "reconcile-op", itemId, target: "src/race.ts", mode: "apply", preDigest: pre, postDigest: post })
    const other = { projectFingerprint: state.scope.projectFingerprint, conversationId: "reconcile-other", writer: "reconcile-other" }
    const foreign = { projectFingerprint: workspaceProjectFingerprint(["file:///another-project"]), conversationId: "foreign-reconcile", writer: "foreign-reconcile" }

    assert.deepEqual((await state.repository.listUnresolvedEditOperations(other)).map((op) => [op.id, op.conversationId]), [["reconcile-op", state.scope.conversationId]], "another conversation of the project sees the unresolved operation")
    assert.deepEqual(await state.repository.listUnresolvedEditOperations(foreign), [], "another project sees none of it")
    assert.equal(await state.repository.settleProjectEditOperation(foreign, "reconcile-op", "dispatched", "reconciled_applied", "foreign"), false, "another project cannot settle it")

    const raced = await Promise.all([
      state.repository.settleProjectEditOperation(other, "reconcile-op", "dispatched", "reconciled_applied", "first reconciler"),
      state.repository.settleProjectEditOperation(state.scope, "reconcile-op", "dispatched", "reconciled_absent", "second reconciler")
    ])
    assert.equal(raced.filter(Boolean).length, 1, "exactly one reconciler wins the compare-and-set")
    assert.deepEqual(await state.repository.listUnresolvedEditOperations(other), [], "a settled operation no longer blocks the project")
    assert.equal(await state.repository.findUnresolvedEditTarget(other, "src/race.ts"), undefined)

    await state.repository.beginEditOperation(state.scope, { id: "reconcile-divergent", itemId, target: "src/race.ts", mode: "apply", preDigest: pre, postDigest: post })
    assert.equal(await state.repository.settleProjectEditOperation(other, "reconcile-divergent", "dispatched", "diverged", "matches neither text"), true)
    assert.deepEqual(await state.repository.findUnresolvedEditTarget(other, "src/race.ts"), { operationId: "reconcile-divergent", conversationId: state.scope.conversationId }, "a diverged operation keeps its target blocked")
    assert.equal(await state.repository.settleProjectEditOperation(other, "reconcile-divergent", "dispatched", "reconciled_applied", "stale decision"), false, "a stale decision cannot release a diverged operation")
    assert.equal(await state.repository.settleProjectEditOperation(other, "reconcile-divergent", "diverged", "reconciled_applied", "The editor now holds the intended text."), true)
    assert.equal(await state.repository.findUnresolvedEditTarget(other, "src/race.ts"), undefined, "the editor matching the intended text releases the target")
  } finally {
    removeAll(state.directory)
  }
})

test("edit digests normalize line endings and distinguish content", () => {
  assert.equal(editDigest("a\r\nb\r\n"), editDigest("a\nb\n"))
  assert.notEqual(editDigest("a\nb\n"), editDigest("a\nc\n"))
})

test("the v11 TODO database gains the edit operation ledger while keeping the active intent task", async () => {
  const state = await fixture([{ id: "kept-edit", criteria: [semantic("kept-edit", "Kept edit task is pending")] }], false)
  try {
    const before = await state.repository.getActiveIntentContext(state.scope)
    const sql = await initSqlJs({ locateFile: () => wasmPath })
    const downgrade = new sql.Database(fs.readFileSync(state.databasePath))
    downgrade.run("DROP TABLE todo_edit_operations; PRAGMA user_version = 11")
    fs.writeFileSync(state.databasePath, Buffer.from(downgrade.export()))
    downgrade.close()

    const reopened = new TodoRepository(state.databasePath, wasmPath)
    await reopened.initialize()
    const after = await reopened.getActiveIntentContext(state.scope)
    assert.equal(after?.task.id, before?.task.id, "the active intent task survives the upgrade")
    assert.equal(after?.planTaskId, before?.planTaskId)
    await reopened.beginEditOperation(state.scope, { id: "edit-after-upgrade", itemId: after!.task.id, target: "src/a.ts", mode: "apply", preDigest: editDigest("a"), postDigest: editDigest("b") })

    const check = new sql.Database(fs.readFileSync(state.databasePath))
    try {
      assert.equal(check.exec("PRAGMA user_version")[0].values[0][0], 18)
      assert.equal(check.exec("SELECT COUNT(*) FROM todo_edit_operations WHERE item_id = ?", [after!.task.id])[0].values[0][0], 1)
    } finally {
      check.close()
    }
  } finally {
    removeAll(state.directory)
  }
})

const TODOS_FILE = "src/extension/tools/todos.ts"
const todosText = fs.readFileSync(path.join(process.cwd(), TODOS_FILE), "utf8")
const todosReader: CurrentSourceReader = async (file) => (file === TODOS_FILE ? todosText : undefined)
const REGISTRATION_LINES = [262, 272] as const
const WHOLE_TODOS_LINES = [1, todosText.split("\n").length - 1] as const

/** Records a read_file observation of a repository file, fingerprinting the whole text it read as the host does. */
const observeSourceWindow = async (state: EvidenceFixture, itemId: string, requestId: string, file: string, text: string, start: number, end: number) => {
  const lines = text.split("\n")
  return state.repository.recordToolObservation(state.scope, {
    itemId,
    toolName: "read_file",
    arguments: { path: file, start_line: String(start), end_line: String(end) },
    output: `read \`${file}:${start}\` · ${end - start + 1} lines`,
    failed: false,
    requestId,
    evidenceOutput: `${file} (lines ${start}–${end} of ${lines.length})\ncontent_hash: ${await fingerprintContent(text)}; total_lines: ${lines.length}\n${numbered(start, lines.slice(start - 1, end))}`
  })
}

const todoIdentity = (id: string, symbol: string, identity: SourceIdentity): TypedCriterion =>
  sourceLocation(id, `\`${symbol}\` is established in ${TODOS_FILE}`, symbol, identity, TODOS_FILE)

test("a registered tool identifier keeps its exact name, underscores included, and an unregistered camelCase spelling is disproven", async () => {
  const state = await evidenceFixtureFor([{ id: "investigate", criteria: [todoIdentity("exact", "twinny_todo_update", "registered_tool"), todoIdentity("camel", "twinnyTodoUpdate", "registered_tool")] }])
  try {
    const item = await startInvestigation(state)
    const read = await observeSourceWindow(state, item.id, "read-registration", TODOS_FILE, todosText, ...WHOLE_TODOS_LINES)
    const review = await reviewFor(state, item.id)
    const reconciliations = await reviewReconciliations(review, todosReader)
    const exact = reconciliations.find((entry) => entry.criterionId === "exact")
    const camel = reconciliations.find((entry) => entry.criterionId === "camel")
    assert.equal(exact?.outcome, "proven", JSON.stringify(exact))
    assert.deepEqual(exact?.supportingObservationIds, [read.id])
    assert.equal(camel?.outcome, "disproven", JSON.stringify(camel))
    assert.equal(camel?.failureReason, "contradicted_evidence")
  } finally {
    removeAll(state.directory)
  }
})

test("an implementation symbol is not satisfied by the registration line that names the tool", async () => {
  const state = await evidenceFixture(todoIdentity("declaration", "twinny_todo_update", "implementation_symbol"))
  try {
    const item = await startInvestigation(state)
    const read = await observeSourceWindow(state, item.id, "read-registration", TODOS_FILE, todosText, ...REGISTRATION_LINES)
    const review = await reviewFor(state, item.id)
    const [reconciliation] = await reviewReconciliations(review, todosReader)
    assert.equal(reconciliation.outcome, "unknown", JSON.stringify(reconciliation))
    assert.equal(reconciliation.failureReason, "invalid_identity", "the name is a registered tool, not a declaration, so the identity is wrong rather than missing")
    assert.match(reconciliation.missing.join("\n"), /not a declaration/)
    const evaluation = await evaluateTodoReview(state.repository, state.scope, review, async () => responseFor(review, { refs: [read.id] }), "mock-reviewer", { readCurrentSource: todosReader, hasVerifiedFileChanges: false })
    assert.notEqual(evaluation.decision, "accept")
  } finally {
    removeAll(state.directory)
  }
})

test("a demonstrably wrong implementation symbol is contradicted through deterministic review, and an AI reply cannot accept it", async () => {
  const state = await evidenceFixtureFor([{ id: "investigate", criteria: [todoIdentity("camel", "twinnyTodoUpdate", "implementation_symbol"), semantic("explain", "Explain how the TODO update tool is registered")] }])
  try {
    const item = await startInvestigation(state)
    const read = await observeSourceWindow(state, item.id, "read-registration", TODOS_FILE, todosText, ...WHOLE_TODOS_LINES)
    const review = await reviewFor(state, item.id)
    const evaluation = await evaluateTodoReview(state.repository, state.scope, review, async () => responseFor(review, { decision: "accept", refs: [read.id] }), "mock-reviewer", { readCurrentSource: todosReader, hasVerifiedFileChanges: false })
    const camel = evaluation.criteria.find((criterion) => criterion.criterionId === "camel")
    assert.equal(camel?.reconciliation?.outcome, "disproven", JSON.stringify(camel))
    assert.equal(camel?.reconciliation?.failureReason, "contradicted_evidence")
    assert.notEqual(evaluation.decision, "accept", "a deterministic disproof is not overridden by the evaluator's accept")
    assert.equal(evaluation.decision, "revise", JSON.stringify(evaluation.problems))
  } finally {
    removeAll(state.directory)
  }
})

test("repeating an identical read of a contradicted identity does not change the outcome, and the corrective instruction says so", async () => {
  const state = await evidenceFixture(todoIdentity("camel", "twinnyTodoUpdate", "implementation_symbol"))
  try {
    const item = await startInvestigation(state)
    await observeSourceWindow(state, item.id, "read-registration", TODOS_FILE, todosText, ...WHOLE_TODOS_LINES)
    await observeSourceWindow(state, item.id, "read-registration-again", TODOS_FILE, todosText, ...WHOLE_TODOS_LINES)
    const review = await reviewFor(state, item.id)
    const [reconciliation] = await reviewReconciliations(review, todosReader)
    assert.equal(reconciliation.outcome, "disproven", JSON.stringify(reconciliation))
    assert.equal(reconciliation.failureReason, "contradicted_evidence")

    const evaluation = await evaluateTodoReview(state.repository, state.scope, review, async () => responseFor(review, { decision: "revise", status: "failed" }), "mock-reviewer", { readCurrentSource: todosReader, hasVerifiedFileChanges: false })
    assert.equal(evaluation.decision, "revise")
    assert.ok(evaluation.correctiveInstructions.some((text) => text.includes("repeating the same read cannot change this")), JSON.stringify(evaluation.correctiveInstructions))
    assert.ok(!evaluation.correctiveInstructions.some((text) => /read the file that declares/.test(text)), JSON.stringify(evaluation.correctiveInstructions))
  } finally {
    removeAll(state.directory)
  }
})

test("a read of an implementation symbol whose text changed after observation is stale evidence, distinct from missing evidence", async () => {
  const state = await evidenceFixture(todoIdentity("registration", "twinny_todo_update", "registered_tool"))
  try {
    const item = await startInvestigation(state)
    await observeSourceWindow(state, item.id, "read-registration", TODOS_FILE, todosText, ...REGISTRATION_LINES)
    const edited = `${todosText}\n// edited after observation\n`
    const [stale] = await reviewReconciliations(await reviewFor(state, item.id), async (file) => (file === TODOS_FILE ? edited : undefined))
    assert.equal(stale.outcome, "unknown", JSON.stringify(stale))
    assert.equal(stale.failureReason, "stale_evidence")
    assert.match(stale.missing.join("\n"), /changed after observation/)

    const absent = await evidenceFixture(todoIdentity("registration", "twinny_todo_update", "registered_tool"))
    try {
      const absentItem = await startInvestigation(absent)
      const [missing] = await reviewReconciliations(await reviewFor(absent, absentItem.id), todosReader)
      assert.equal(missing.failureReason, "missing_evidence")
    } finally {
      removeAll(absent.directory)
    }
  } finally {
    removeAll(state.directory)
  }
})

test("a path-less implementation criterion is a valid discovery task, and without evidence it is missing evidence rather than invalid", async () => {
  const discovery: TypedCriterion = { id: "discover", description: "Locate the declaration that registers the TODO update tool", verification: { kind: "source_location", identity: "implementation_symbol", symbol: "registerNativeTool" } }
  const validation = validateIntentTaskPlan({
    planId: "discovery-plan", version: 1, revision: 1, goal: "Locate the TODO update declaration", constraints: [],
    tasks: [{ id: "discover", title: "Locate", description: "Locate the declaration", dependencies: [], criteria: [discovery] }]
  })
  assert.ok(validation.plan, validation.diagnostic)

  const state = await evidenceFixture(discovery)
  try {
    const item = await startInvestigation(state)
    const [reconciliation] = await reviewReconciliations(await reviewFor(state, item.id), todosReader)
    assert.equal(reconciliation.outcome, "unknown", JSON.stringify(reconciliation))
    assert.equal(reconciliation.failureReason, "missing_evidence")
  } finally {
    removeAll(state.directory)
  }
})

test("a registered tool criterion with no retained read is missing evidence, not contradicted", async () => {
  const state = await evidenceFixture(todoIdentity("registration", "twinny_todo_update", "registered_tool"))
  try {
    const item = await startInvestigation(state)
    const review = await reviewFor(state, item.id)
    const [reconciliation] = await reviewReconciliations(review, todosReader)
    assert.equal(reconciliation.outcome, "unknown")
    assert.equal(reconciliation.failureReason, "missing_evidence")
    const evaluation = await evaluateTodoReview(state.repository, state.scope, review, async () => responseFor(review), "mock-reviewer", { readCurrentSource: todosReader, hasVerifiedFileChanges: false })
    assert.notEqual(evaluation.decision, "accept")
  } finally {
    removeAll(state.directory)
  }
})

test("persisted facts keep their meaning: an alias fact proves both identities, and a legacy registration-only fact proves only the tool", () => {
  const alias = acceptedFact("alias", { symbol: "readFile", registeredTool: "read_file" })
  assert.equal(factNamedBy("implementation_symbol", "readFile", alias), true)
  assert.equal(factNamedBy("registered_tool", "read_file", alias), true)
  assert.equal(factNamedBy("registered_tool", "readFile", alias), false)
  assert.equal(factNamedBy("implementation_symbol", "read_file", alias), false)

  const legacy = acceptedFact("legacy", { symbol: "read_file", registeredTool: undefined })
  assert.equal(factNamedBy("registered_tool", "read_file", legacy), true)
  assert.equal(factNamedBy("implementation_symbol", "read_file", legacy), false)

  const registration = acceptedFact("registration", { symbol: "twinny_todo_update", registeredTool: undefined, path: TODOS_FILE })
  assert.equal(factNamedBy("registered_tool", "twinny_todo_update", registration), true)
  assert.equal(factNamedBy("registered_tool", "twinnyTodoUpdate", registration), false)
  assert.equal(factNamedBy("implementation_symbol", "twinny_todo_update", registration), false, "a registration-only fact is never a declaration")
})

test("plan validation rejects a same-task contradiction and an identity the verifier cannot prove, with actionable diagnostics", () => {
  const withTask = (criteria: unknown[]) => ({
    planId: "contract-plan", version: 1, revision: 1, goal: "Verify the contract", constraints: [],
    tasks: [{ id: "task", title: "Task", description: "Task", dependencies: [], criteria }]
  })
  const prohibition = { id: "no-mutation", description: "No edits", verification: { kind: "execution_invariant", invariant: "no_mutating_tool_calls" } }
  const edit = { id: "edit-file", description: "Edit the file", verification: { kind: "workspace_mutation", operation: "edit" } }
  const contradiction = validateIntentTaskPlan(withTask([prohibition, edit]))
  assert.match(contradiction.diagnostic ?? "", /unsatisfiable/)
  assert.match(contradiction.diagnostic ?? "", /criterion edit-file requires a workspace_mutation, but criterion no-mutation prohibits/)

  assert.ok(validateIntentTaskPlan(withTask([{ ...prohibition, id: "other-task-only" }])).plan, "a prohibition alone is valid")

  const invalidIdentity = validateIntentTaskPlan(withTask([{ id: "bad", description: "Locate", verification: { kind: "source_location", identity: "tool", symbol: "twinny_todo_update" } }]))
  assert.match(invalidIdentity.diagnostic ?? "", /identity must be registered_tool or implementation_symbol; received/)

  const invariantWithIdentity = validateIntentTaskPlan(withTask([{ id: "bad", description: "No edits", verification: { kind: "execution_invariant", invariant: "no_mutating_tool_calls", identity: "registered_tool" } }]))
  assert.match(invariantWithIdentity.diagnostic ?? "", /has unsupported field identity for kind execution_invariant/)
})

test("the verifier capability table is authoritative: only implemented kinds and identities are capable, and an unknown kind is reported as unsupported", async () => {
  assert.equal(capabilityOf("made_up_kind"), undefined)
  assert.equal(capabilityOf("toString"), undefined, "inherited object properties are not capabilities")
  assert.deepEqual(capabilityOf("source_location")?.identities, ["registered_tool", "implementation_symbol"])
  assert.deepEqual(capabilityOf("workspace_mutation")?.identities, [])

  const [outcome] = await reviewCriteria([typedCriterion("unsupported", "A criterion the verifier does not implement", { kind: "made_up_kind" } as unknown as TypedCriterion["verification"])], [], currentWorkspace)
  assert.notEqual(outcome.outcome, "proven")
  assert.equal(outcome.failureReason, "unsupported_operation", JSON.stringify(outcome))
})

// Stage H: the promoted and recent windows over real repository, lookup, reuse, and review paths. Each test owns its database.
const PROMOTION_PROJECT = workspaceProjectFingerprint(["file:///evidence-project"])
const PROJECT_COPY = workspaceProjectFingerprint(["file:///evidence-project-copy"])
const SEARCH_FILE = "src/extension/tools/search.ts"
const LIST_FILE = "src/extension/tools/list.ts"
/** Same registration layout as workspaceText, so the structural analyzer finds `name` as a registered tool. */
const toolSource = (name: string, fn: string): string => Array.from({ length: 850 }, (_, index) => {
  if (index === 168) return `const ${fn} = (view: WorkspaceView, maxLines = DEFAULT_READ_LINES, sink?: EditSink): Tool => {`
  if (index === 169) return "  const limit = clampReadLines(maxLines)"
  if (index === 170) return "  return {"
  if (index === 171) return `    name: "${name}",`
  if (index === 172) return "    async run(args: unknown) {"
  if (index === 216) return "      return args"
  if (index === 217) return "    }"
  if (index === 218) return "  }"
  if (index === 219) return "}"
  if (index > 172 && index < 216) return `      const filler${index + 1} = ${index + 1}`
  return `const filler${index + 1} = ${index + 1}`
}).join("\n")
const PROMOTION_SOURCES: Record<string, string> = {
  [WORKSPACE_FILE]: workspaceText,
  [SEARCH_FILE]: toolSource("search_files", "searchFiles"),
  [LIST_FILE]: toolSource("list_files", "listFiles")
}
const sourcesNow: CurrentSourceReader = async (file) => PROMOTION_SOURCES[file]
const sourcesWithChangedRead: CurrentSourceReader = async (file) => (file === WORKSPACE_FILE ? CHANGED_TEXT : PROMOTION_SOURCES[file])
const sourcesUnreadable: CurrentSourceReader = async () => undefined
const waitMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const readCriterion = () => sourceLocation("defined", "`read_file` is defined in src/extension/tools/workspace.ts", "read_file", "registered_tool")
const searchCriterion = () => sourceLocation("defined", "`search_files` is defined in src/extension/tools/search.ts", "search_files", "registered_tool", SEARCH_FILE)
const listCriterion = () => sourceLocation("defined", "`list_files` is defined in src/extension/tools/list.ts", "list_files", "registered_tool", LIST_FILE)
const READ_ARGS = { symbol: "read_file", path: WORKSPACE_FILE }

type PromotionStore = { directory: string; databasePath: string; repository: TodoRepository }
const openPromotionStore = (): PromotionStore => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-promotion-"))
  const databasePath = path.join(directory, "twinny-state.sqlite")
  return { directory, databasePath, repository: new TodoRepository(databasePath, wasmPath) }
}
const scopeOf = (conversationId: string, projectFingerprint = PROMOTION_PROJECT): TodoWriteRequest => ({ projectFingerprint, conversationId, writer: conversationId })
const planTasks = async (repository: TodoRepository, scope: TodoWriteRequest, tasks: Parameters<typeof plan>[0]): Promise<string[]> =>
  (await repository.synchronizeIntentPlan(scope, plan(tasks), { prompt: "Work through the evidence tasks" })).items.map((item) => item.id)

/** Accepts a source fact through the real path: a read in this execution, then the deterministic review. */
const acceptSource = async (repository: TodoRepository, scope: TodoWriteRequest, itemId: string, file: string, executionId: string, tag: string, text = PROMOTION_SOURCES[file]) => {
  await startItemInReview(repository, scope, itemId)
  await repository.recordToolObservation(scope, {
    itemId,
    toolName: "read_file",
    arguments: { path: file, start_line: "150", end_line: "220" },
    output: `read \`${file}:150\` · 71 lines`,
    failed: false,
    requestId: `${tag}-read`,
    evidenceOutput: await readCurrentOutput(text, file, 150, text.split("\n").slice(149, 220)),
    executionId
  })
  const review = (await repository.getReviewPackages(scope)).find((candidate) => candidate.task.id === itemId)!
  const calls = { count: 0 }
  const readCurrentSource: CurrentSourceReader = async (candidate) => (candidate === file ? text : PROMOTION_SOURCES[candidate])
  const evaluation = await evaluateTodoReview(repository, scope, review, countingEvaluator(calls), "mock-reviewer", { readCurrentSource, hasVerifiedFileChanges: false })
  assert.equal(evaluation.decision, "accept", JSON.stringify(evaluation.problems))
  assert.equal(calls.count, 0)
}
const factFor = async (repository: TodoRepository, scope: TodoWriteRequest, symbol: string, file: string) =>
  (await repository.listAcceptedEvidence(scope, { symbol, path: file })).find((fact) => !fact.supersededBy)!

/** Conversation A accepts read, search, and list facts in that order, 5 ms apart, and holds one pending task for later use. */
const seedProject = async (repository: TodoRepository, projectFingerprint = PROMOTION_PROJECT) => {
  const scope = scopeOf("chat-a", projectFingerprint)
  const [read, search, list, again] = await planTasks(repository, scope, [
    { id: "read", criteria: [readCriterion()] },
    { id: "search", criteria: [searchCriterion()] },
    { id: "list", criteria: [listCriterion()] },
    { id: "again", criteria: [readCriterion()] }
  ])
  await acceptSource(repository, scope, read, WORKSPACE_FILE, "exec-accept-read", "read")
  await waitMs(5)
  await acceptSource(repository, scope, search, SEARCH_FILE, "exec-accept-search", "search")
  await waitMs(5)
  await acceptSource(repository, scope, list, LIST_FILE, "exec-accept-list", "list")
  return {
    scope,
    again,
    facts: {
      read: await factFor(repository, scope, "read_file", WORKSPACE_FILE),
      search: await factFor(repository, scope, "search_files", SEARCH_FILE),
      list: await factFor(repository, scope, "list_files", LIST_FILE)
    }
  }
}

const lookupAs = async (repository: TodoRepository, scope: TodoWriteRequest, executionId: string, args: Record<string, string>, sources: CurrentSourceReader = sourcesNow) => {
  const tools = todoWorkspaceTools(repository, scope, () => undefined, { readCurrentSource: sources, executionId })
  return tools.run({ name: "twinny_evidence_lookup", args })
}
const countsOf = async (repository: TodoRepository, scope: TodoWriteRequest, factId: string) => {
  const entry = (await repository.promotionCandidates(scope)).find((candidate) => candidate.fact.id === factId)
  return { lookups: entry?.lookups ?? 0, reuses: entry?.reuses ?? 0 }
}
/** The projection as the controller builds it: repository reads, then the shared service, with no rendering side effects. */
const projectFor = async (repository: TodoRepository, scope: TodoWriteRequest, executionId: string | undefined, requestText: string, sources: CurrentSourceReader, budget?: EvidenceBudget) => {
  const [facts, usage, active] = await Promise.all([repository.listAcceptedEvidence(scope), repository.promotionCandidates(scope), repository.getActiveIntentContext(scope)])
  return projectEvidence({
    requestText,
    planItemIds: [],
    criteria: active?.criteria ?? [],
    executionId,
    facts,
    usage,
    observations: active?.observations ?? [],
    observationText: (observation) => `${observation.toolName} ${observation.output}`,
    readCurrent: sources,
    budget
  })
}

test("accepted evidence from one conversation is promoted into another conversation of the same project without knowing its ID", async () => {
  const store = openPromotionStore()
  try {
    const { facts } = await seedProject(store.repository)
    const other = scopeOf("chat-b")
    await planTasks(store.repository, other, [{ id: "summary", criteria: [semantic("summary")] }])
    const projection = await projectFor(store.repository, other, "exec-b", "Summarize the project", sourcesNow)
    const promoted = projection.promoted.map((status) => status.fact.id)
    assert.deepEqual([...promoted].sort(), [facts.read.id, facts.search.id, facts.list.id].sort(), JSON.stringify(projection.omitted))
    assert.deepEqual(projection.requiredFacts, [])
  } finally {
    fs.rmSync(store.directory, { recursive: true, force: true })
  }
})

test("repeated meaningful use moves a fact to the top of the promoted ranking", async () => {
  const store = openPromotionStore()
  try {
    const { scope, facts } = await seedProject(store.repository)
    assert.equal(rankPromotionCandidates(await store.repository.promotionCandidates(scope), "", [])[0].fact.id, facts.list.id, "with no use, the newest acceptance leads")
    for (const executionId of ["exec-1", "exec-2"]) {
      const lookup = await lookupAs(store.repository, scope, executionId, READ_ARGS)
      assert.notEqual(lookup.failed, true, lookup.output)
    }
    assert.deepEqual(await countsOf(store.repository, scope, facts.read.id), { lookups: 2, reuses: 0 })
    assert.equal(rankPromotionCandidates(await store.repository.promotionCandidates(scope), "", [])[0].fact.id, facts.read.id)

    const other = scopeOf("chat-b")
    await planTasks(store.repository, other, [{ id: "summary", criteria: [semantic("summary")] }])
    assert.equal((await projectFor(store.repository, other, "exec-b", "Summarize the project", sourcesNow)).promoted[0].fact.id, facts.read.id)
  } finally {
    fs.rmSync(store.directory, { recursive: true, force: true })
  }
})

test("duplicate lookups inside one execution count once, and failed or empty lookups count nothing", async () => {
  const store = openPromotionStore()
  try {
    const { scope, facts } = await seedProject(store.repository)
    await lookupAs(store.repository, scope, "exec-1", READ_ARGS)
    await lookupAs(store.repository, scope, "exec-2", READ_ARGS)
    for (let attempt = 0; attempt < 3; attempt++) await lookupAs(store.repository, scope, "exec-3", READ_ARGS)
    assert.deepEqual(await countsOf(store.repository, scope, facts.read.id), { lookups: 3, reuses: 0 }, "one use per execution, not per call")

    const factsBefore = JSON.stringify(await store.repository.listAcceptedEvidence(scope))
    const failed = await lookupAs(store.repository, scope, "exec-4", {})
    assert.equal(failed.failed, true, "a lookup naming neither symbol nor path is a failed call")
    await lookupAs(store.repository, scope, "exec-4", { symbol: "no_such_tool" })
    assert.deepEqual(await countsOf(store.repository, scope, facts.read.id), { lookups: 3, reuses: 0 })
    assert.equal(JSON.stringify(await store.repository.listAcceptedEvidence(scope)), factsBefore, "usage never rewrites accepted facts")
  } finally {
    fs.rmSync(store.directory, { recursive: true, force: true })
  }
})

test("usage from separate conversations adds up, and reuse is counted apart from lookups", async () => {
  const store = openPromotionStore()
  try {
    const { scope, facts } = await seedProject(store.repository)
    await lookupAs(store.repository, scope, "exec-1", READ_ARGS)
    const chatC = scopeOf("chat-c")
    const [use] = await planTasks(store.repository, chatC, [{ id: "use", criteria: [readCriterion()] }])
    await lookupAs(store.repository, chatC, "exec-c", READ_ARGS)
    assert.deepEqual(await countsOf(store.repository, chatC, facts.read.id), { lookups: 2, reuses: 0 })

    const tools = todoWorkspaceTools(store.repository, chatC, () => undefined, { readCurrentSource: sourcesNow, executionId: "exec-c" })
    const claim = await tools.run({ name: "twinny_todo_evidence", args: { item_id: use, kind: "observation", summary: "read_file is defined in workspace.ts", result: "passed", request_id: "claim-1" } })
    assert.notEqual(claim.failed, true, claim.output)
    assert.deepEqual(await countsOf(store.repository, chatC, facts.read.id), { lookups: 2, reuses: 0 }, "a model-authored claim adds no authority or reuse")

    const attach = await tools.run({ name: "twinny_todo_evidence", args: { item_id: use, kind: "observation", summary: "accepted fact", result: "observed", request_id: "attach-1", accepted_fact_id: facts.read.id } })
    assert.notEqual(attach.failed, true, attach.output)
    assert.deepEqual(await countsOf(store.repository, chatC, facts.read.id), { lookups: 2, reuses: 1 })
  } finally {
    fs.rmSync(store.directory, { recursive: true, force: true })
  }
})

test("building and rendering the evidence windows never counts as reuse", async () => {
  const store = openPromotionStore()
  try {
    const { scope, facts } = await seedProject(store.repository)
    const chatC = scopeOf("chat-c")
    await planTasks(store.repository, chatC, [{ id: "use", criteria: [readCriterion()] }])
    const before = JSON.stringify(await store.repository.promotionCandidates(scope))
    for (let pass = 0; pass < 3; pass++) {
      const projection = await projectFor(store.repository, chatC, "exec-c", "Explain read_file", sourcesNow)
      assert.ok(projection.requiredFacts.some((status) => status.fact.id === facts.read.id), "the fact is shown to the implementer")
      renderRequiredEvidence(projection)
      renderRecentObservations(projection)
    }
    assert.equal(JSON.stringify(await store.repository.promotionCandidates(scope)), before)
  } finally {
    fs.rmSync(store.directory, { recursive: true, force: true })
  }
})

test("stale and unverifiable facts leave the promoted window and never count as use, while their records remain", async () => {
  const store = openPromotionStore()
  try {
    const { scope, facts } = await seedProject(store.repository)
    await lookupAs(store.repository, scope, "exec-1", READ_ARGS)
    await lookupAs(store.repository, scope, "exec-2", READ_ARGS)
    const other = scopeOf("chat-b")
    await planTasks(store.repository, other, [{ id: "summary", criteria: [semantic("summary")] }])

    assert.equal((await projectFor(store.repository, other, "exec-b", "Summarize", sourcesNow)).promoted[0].fact.id, facts.read.id, "the most used fact leads while it is current")
    const stale = await projectFor(store.repository, other, "exec-b", "Summarize", sourcesWithChangedRead)
    assert.equal(stale.promoted.some((status) => status.fact.id === facts.read.id), false, "a stale fingerprint is never promoted")
    assert.deepEqual(stale.promoted.map((status) => status.fact.id).sort(), [facts.search.id, facts.list.id].sort())

    const staleLookup = await lookupAs(store.repository, scope, "exec-stale", READ_ARGS, sourcesWithChangedRead)
    assert.notEqual(staleLookup.failed, true, staleLookup.output)
    assert.deepEqual(await countsOf(store.repository, scope, facts.read.id), { lookups: 2, reuses: 0 }, "a historical lookup is not a successful use")

    const unverifiable = await projectFor(store.repository, other, "exec-b", "Summarize", sourcesUnreadable)
    assert.equal(unverifiable.promoted.length, 0)
    assert.equal(unverifiable.omitted.promoted, 3)

    const history = await store.repository.listAcceptedEvidence(scope, { symbol: "read_file", path: WORKSPACE_FILE })
    assert.equal(history.length, 1)
    assert.equal(history[0].supersededBy, undefined, "the fact is kept with its provenance")
    assert.equal((await projectFor(store.repository, other, "exec-b", "Summarize", sourcesNow)).promoted[0].fact.id, facts.read.id, "it returns once the source matches again")
  } finally {
    fs.rmSync(store.directory, { recursive: true, force: true })
  }
})

test("a newer acceptance supersedes an older fact, which leaves promotion but stays stored", async () => {
  const store = openPromotionStore()
  try {
    const { scope, again, facts } = await seedProject(store.repository)
    await acceptSource(store.repository, scope, again, WORKSPACE_FILE, "exec-accept-again", "again", CHANGED_TEXT)
    const current = await factFor(store.repository, scope, "read_file", WORKSPACE_FILE)
    assert.notEqual(current.id, facts.read.id, "changed content is a new fact, not a repeat of the old one")

    const history = await store.repository.listAcceptedEvidence(scope, { symbol: "read_file", path: WORKSPACE_FILE })
    assert.equal(history.length, 2, "both facts remain stored")
    assert.equal(history.find((fact) => fact.id === facts.read.id)?.supersededBy, current.id)

    const candidates = (await store.repository.promotionCandidates(scope)).map((entry) => entry.fact.id)
    assert.equal(candidates.includes(facts.read.id), false, "a superseded fact is not a candidate")
    assert.equal(candidates.includes(current.id), true)
  } finally {
    fs.rmSync(store.directory, { recursive: true, force: true })
  }
})

test("required evidence outranks promoted evidence, and a fact appears in one window only", async () => {
  const store = openPromotionStore()
  try {
    const { facts } = await seedProject(store.repository)
    const chatC = scopeOf("chat-c")
    await planTasks(store.repository, chatC, [{ id: "use", criteria: [readCriterion()] }])
    const projection = await projectFor(store.repository, chatC, "exec-c", "Explain read_file", sourcesNow)
    assert.deepEqual(projection.requiredFacts.map((status) => status.fact.id), [facts.read.id])
    assert.equal(projection.promoted.some((status) => status.fact.id === facts.read.id), false)
    assert.deepEqual(projection.promoted.map((status) => status.fact.id).sort(), [facts.search.id, facts.list.id].sort())
    assert.equal(renderRequiredEvidence(projection)!.split(facts.read.id).length - 1, 1)
  } finally {
    fs.rmSync(store.directory, { recursive: true, force: true })
  }
})

test("a required fact that does not fit its budget is reported as incomplete rather than presented as the whole", async () => {
  const store = openPromotionStore()
  try {
    await seedProject(store.repository)
    const chatC = scopeOf("chat-c")
    await planTasks(store.repository, chatC, [{ id: "use", criteria: [readCriterion()] }])
    const tight = await projectFor(store.repository, chatC, "exec-c", "Explain read_file", sourcesNow, { required: 10, promoted: 2400, recent: 2400 })
    assert.equal(tight.requiredFacts.length, 0)
    assert.equal(tight.omitted.required, 1)
    assert.match(renderRequiredEvidence(tight) ?? "", /1 required item\(s\) not shown\. This excerpt is incomplete/)
  } finally {
    fs.rmSync(store.directory, { recursive: true, force: true })
  }
})

test("an early unresolved failure stays available after more than ten later observations, until a later success of the same operation resolves it", async () => {
  const store = openPromotionStore()
  try {
    const scope = scopeOf("chat-d")
    const [work] = await planTasks(store.repository, scope, [{ id: "work", criteria: [semantic("work")] }])
    await store.repository.recordToolObservation(scope, { itemId: work, toolName: "read_file", arguments: { path: WORKSPACE_FILE, start_line: "1", end_line: "40" }, output: "read failed: EARLY-FAILURE", failed: true, requestId: "early-failure", executionId: "exec-long" })
    for (let index = 0; index < 12; index++) {
      await store.repository.recordToolObservation(scope, { itemId: work, toolName: "list_files", arguments: { path: `src/dir${index}` }, output: `listed dir${index}`, failed: false, requestId: `list-${index}`, executionId: "exec-long" })
    }
    const before = await projectFor(store.repository, scope, "exec-long", "Continue the investigation", sourcesNow)
    assert.equal(before.requiredFailures.length, 1)
    assert.match(before.requiredFailures[0], /EARLY-FAILURE/)
    assert.match(renderRequiredEvidence(before) ?? "", /unresolved failure/)

    await store.repository.recordToolObservation(scope, { itemId: work, toolName: "read_file", arguments: { path: WORKSPACE_FILE, start_line: "1", end_line: "40" }, output: "read ok", failed: false, requestId: "resolving-read", executionId: "exec-long" })
    const after = await projectFor(store.repository, scope, "exec-long", "Continue the investigation", sourcesNow)
    assert.deepEqual(after.requiredFailures, [], "a later success of the same operation resolves the failure")
  } finally {
    fs.rmSync(store.directory, { recursive: true, force: true })
  }
})

test("failures from another execution never reach the current execution's windows, and stay in the stored history", async () => {
  const store = openPromotionStore()
  try {
    const scope = scopeOf("chat-d")
    const [work] = await planTasks(store.repository, scope, [{ id: "work", criteria: [semantic("work")] }])
    await store.repository.recordToolObservation(scope, { itemId: work, toolName: "read_file", arguments: { path: WORKSPACE_FILE, start_line: "1", end_line: "40" }, output: "OLD-FAILURE-MARKER", failed: true, requestId: "old-failure", executionId: "exec-old" })
    await store.repository.recordToolObservation(scope, { itemId: work, toolName: "list_files", arguments: { path: "src/new.ts" }, output: "NEW-OBSERVATION-MARKER", failed: false, requestId: "new-observation", executionId: "exec-new" })

    const projection = await projectFor(store.repository, scope, "exec-new", "Continue", sourcesNow)
    assert.deepEqual(projection.requiredFailures, [])
    assert.equal(projection.recent.length, 1)
    assert.match(projection.recent[0], /NEW-OBSERVATION-MARKER/)
    assert.equal(projection.recent.some((line) => line.includes("OLD-FAILURE-MARKER")), false)
    assert.equal((((await store.repository.getActiveIntentContext(scope))!.observations) ?? []).some((observation) => observation.output === "OLD-FAILURE-MARKER"), true, "the earlier failure is kept")
  } finally {
    fs.rmSync(store.directory, { recursive: true, force: true })
  }
})

test("large tool outputs cannot exceed the configured projection budget, and omissions are named", async () => {
  const store = openPromotionStore()
  try {
    const scope = scopeOf("chat-d")
    const [work] = await planTasks(store.repository, scope, [{ id: "work", criteria: [semantic("work")] }])
    await store.repository.recordToolObservation(scope, { itemId: work, toolName: "read_file", arguments: { path: WORKSPACE_FILE, start_line: "1", end_line: "40" }, output: "F".repeat(5000), failed: true, requestId: "big-failure", executionId: "exec-big" })
    for (let index = 0; index < 40; index++) {
      await store.repository.recordToolObservation(scope, { itemId: work, toolName: "list_files", arguments: { path: `src/big${index}.ts` }, output: `${index}:` + "x".repeat(5000), failed: false, requestId: `big-${index}`, executionId: "exec-big" })
    }
    const projection = await projectFor(store.repository, scope, "exec-big", "Inspect", sourcesNow)
    const size = (lines: string[]) => lines.reduce((total, line) => total + line.length + 1, 0)
    assert.ok(size(projection.recent) <= EVIDENCE_BUDGET.recent, `recent ${size(projection.recent)}`)
    assert.ok(size(projection.requiredFailures) <= EVIDENCE_BUDGET.required, `required ${size(projection.requiredFailures)}`)
    assert.ok(projection.recent.every((line) => line.length <= 602), "each recent line is bounded to its entry limit and prefix")
    assert.ok(projection.requiredFailures.every((line) => line.length <= 640), "a failure line is bounded to its entry limit and prefix")
    assert.ok(projection.omitted.recent > 0)
    assert.match(renderRecentObservations(projection) ?? "", /older observation\(s\) from this execution not shown/)
    assert.equal((((await store.repository.getActiveIntentContext(scope))!.observations) ?? []).length, 41, "the stored observations are complete")
  } finally {
    fs.rmSync(store.directory, { recursive: true, force: true })
  }
})

test("promoted and recent windows each get their own space, so neither starves the other", async () => {
  const store = openPromotionStore()
  try {
    await seedProject(store.repository)
    const scope = scopeOf("chat-b")
    await planTasks(store.repository, scope, [{ id: "summary", criteria: [semantic("summary")] }])
    for (let index = 0; index < 3; index++) {
      await store.repository.recordToolObservation(scope, { itemId: (await store.repository.getActiveIntentContext(scope))!.task.id, toolName: "list_files", arguments: { path: `src/b${index}.ts` }, output: `observation ${index}`, failed: false, requestId: `b-${index}`, executionId: "exec-b" })
    }
    const projection = await projectFor(store.repository, scope, "exec-b", "Summarize", sourcesNow, { required: 3000, promoted: 600, recent: 600 })
    assert.ok(projection.promoted.length >= 1, "promoted evidence keeps part of its space")
    assert.equal(projection.promoted.length + projection.omitted.promoted, 3, "omitted promoted facts are counted")
    assert.equal(projection.recent.length, 3, "recent observations keep their space")
    assert.equal(projection.omitted.recent, 0)
  } finally {
    fs.rmSync(store.directory, { recursive: true, force: true })
  }
})

test("two projects with the same file and symbol stay isolated in counts and promotion", async () => {
  const store = openPromotionStore()
  try {
    const first = await seedProject(store.repository, PROMOTION_PROJECT)
    const second = await seedProject(store.repository, PROJECT_COPY)
    assert.notEqual(second.facts.read.id, first.facts.read.id)

    await lookupAs(store.repository, first.scope, "exec-p1", READ_ARGS)
    assert.deepEqual(await countsOf(store.repository, first.scope, first.facts.read.id), { lookups: 1, reuses: 0 })
    assert.deepEqual(await countsOf(store.repository, second.scope, second.facts.read.id), { lookups: 0, reuses: 0 })

    const firstIds = (await store.repository.promotionCandidates(first.scope)).map((entry) => entry.fact.id)
    const secondIds = (await store.repository.promotionCandidates(second.scope)).map((entry) => entry.fact.id)
    assert.equal(firstIds.some((id) => secondIds.includes(id)), false, "no candidate crosses projects")
    const secondProjection = await projectFor(store.repository, second.scope, "exec-p2", "Summarize", sourcesNow)
    const shown = [...secondProjection.requiredFacts, ...secondProjection.promoted].map((status) => status.fact.id)
    assert.deepEqual([...shown].sort(), [second.facts.read.id, second.facts.search.id, second.facts.list.id].sort(), "each project fact is shown once, across both windows")
    assert.deepEqual(secondProjection.requiredFacts.map((status) => status.fact.id), [second.facts.read.id], "the open task's criterion names read_file, so it is required")
  } finally {
    fs.rmSync(store.directory, { recursive: true, force: true })
  }
})

test("promotion usage and facts survive closing the database and reopening it", async () => {
  const store = openPromotionStore()
  try {
    const { scope, facts } = await seedProject(store.repository)
    await lookupAs(store.repository, scope, "exec-1", READ_ARGS)
    const factsBefore = JSON.stringify(await store.repository.listAcceptedEvidence(scope))

    const reopened = new TodoRepository(store.databasePath, wasmPath)
    assert.deepEqual(await countsOf(reopened, scope, facts.read.id), { lookups: 1, reuses: 0 })
    assert.equal(JSON.stringify(await reopened.listAcceptedEvidence(scope)), factsBefore)
    await lookupAs(reopened, scope, "exec-2", READ_ARGS)
    assert.deepEqual(await countsOf(reopened, scope, facts.read.id), { lookups: 2, reuses: 0 })

    const other = scopeOf("chat-b")
    await planTasks(reopened, other, [{ id: "summary", criteria: [semantic("summary")] }])
    assert.equal((await projectFor(reopened, other, "exec-b", "Summarize", sourcesNow)).promoted[0].fact.id, facts.read.id, "the reopened store ranks the same fact first")
  } finally {
    fs.rmSync(store.directory, { recursive: true, force: true })
  }
})

test("promotion ranking orders by lifetime use, then reuse, then relevance, then acceptance time, then ID", () => {
  const entry = (id: string, acceptedAt: string, lookups: number, reuses: number, overrides: Partial<AcceptedFact> = {}) => ({
    fact: acceptedFact(id, { acceptedAt, ...overrides }),
    lookups,
    reuses
  })
  const ranked = rankPromotionCandidates([
    entry("c", "2024-01-03T00:00:00.000Z", 0, 0),
    entry("a", "2024-01-01T00:00:00.000Z", 2, 0),
    entry("b", "2024-01-02T00:00:00.000Z", 1, 1),
    entry("d", "2024-01-04T00:00:00.000Z", 1, 1),
    entry("e", "2024-01-04T00:00:00.000Z", 0, 0),
    entry("g", "2024-01-05T00:00:00.000Z", 0, 0),
    entry("f", "2024-01-05T00:00:00.000Z", 0, 0)
  ], "", [])
  assert.deepEqual(ranked.map((candidate) => candidate.fact.id), ["d", "b", "a", "f", "g", "e", "c"])

  const relevant = rankPromotionCandidates([
    entry("x", "2024-01-01T00:00:00.000Z", 0, 0, { symbol: "other", registeredTool: "other_tool" }),
    entry("y", "2024-01-01T00:00:00.000Z", 0, 0, { symbol: "readFile", registeredTool: "read_file" })
  ], "How does readFile choose a path?", [])
  assert.deepEqual(relevant.map((candidate) => candidate.fact.id), ["y", "x"], "a fact the request names leads when use is equal")
})
