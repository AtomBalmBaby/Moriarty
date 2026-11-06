import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import initSqlJs from "sql.js"

import { resolveAgentToolSelection } from "../../extension/agents/tool-selection"
import { continuationContext,ExecutionReconciliationController } from "../../extension/chat/execution-reconciliation"
import { parseFeedbackPlanResponse, userRequestsTodoCreation } from "../../extension/chat/feedback-planner"
import { compactEvidenceText, compactToolEvidence, describeGap, evidenceAnchors, evidenceGaps, type EvidenceRecord, excerptEvidence, MAX_EVIDENCE_TEXT, MAX_EXCERPT_CHARS, MAX_RETAINED_EVIDENCE_CHARS, preserveEvidence } from "../../extension/todos/evidence"
import { type CurrentSourceReader, evaluateTodoReview, feedbackContext, parseTodoEvaluation, reconcileCriteria, reviewCandidates, taskRequiresWorkspaceChanges, TodoEvaluationValidationError, todoReviewInput } from "../../extension/todos/feedback"
import { authoritativeExecutionReport, renderPlanContext } from "../../extension/todos/plan-context"
import { TodoRepository, trustedTodoPanelApproval, workspaceProjectFingerprint } from "../../extension/todos/repository"
import type { ChildTodoDecision, ChildTodoReview, IntentPlanOutline, TodoEvaluation, TodoReviewPackage } from "../../extension/todos/types"
import { RUNTIME_INVENTORY_TOOL } from "../../extension/todos/types"
import { fingerprintContent } from "../../extension/tools/fingerprint"
import { todoWorkspaceTools } from "../../extension/tools/todos"

const wasmPath = path.join(process.cwd(), "out", "sql-wasm.wasm")
const plan = (tasks: { id: string; acceptance: string; dependencies?: string[] }[]) => ({
  planId: "feedback-plan",
  version: 1 as const,
  revision: 1,
  goal: "Verify the requested work",
  constraints: ["Preserve existing behavior"],
  tasks: tasks.map((task) => ({
    id: task.id,
    title: task.id,
    description: `Work for ${task.id}`,
    acceptanceCriteria: [task.acceptance],
    dependencies: task.dependencies ?? []
  }))
})

const fixture = async (tasks: { id: string; acceptance: string; dependencies?: string[] }[], complete = true) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-feedback-"))
  const databasePath = path.join(directory, "twinny-state.sqlite")
  const scope = { projectFingerprint: workspaceProjectFingerprint(["file:///feedback-project"]), conversationId: "feedback-chat" }
  const repository = new TodoRepository(databasePath, wasmPath)
  const initial = await repository.synchronizeIntentPlan(scope, plan(tasks), { prompt: "Verify the requested work" })
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
  criteria: review.acceptanceCriteria.map((criterion) => ({
    criterion,
    status: options.status ?? "passed",
    evidenceRefs: options.refs ?? []
  })),
  problems: options.problems ?? [],
  correctiveInstructions: options.correctiveInstructions ?? [],
  explanation: "Reviewed the task against the supplied observations.",
  scores: { completion: 7, correctness: 7, alignment: 8 }
})

const addObservation = (repository: TodoRepository, scope: { projectFingerprint: string; conversationId: string }, itemId: string, toolName = "read_file", exitCode?: number) =>
  repository.recordToolObservation(scope, {
    itemId,
    toolName,
    arguments: toolName === "run_command" ? { command: "npx tsc --strict && node example/intent-smoke/check.cjs" } : { path: "src/fixture.ts" },
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

test("no-progress detection stops repeated identical work but not turns that add new evidence", () => {
  const stalled = new ExecutionReconciliationController()
  const repeat = { observations: [{ toolName: "search_workspace", arguments: { query: "x" }, failed: false }], passedCriteria: [] }
  const looped: boolean[] = []
  for (let turn = 0; turn < 3; turn++) {
    const progressed = stalled.recordEvidence(repeat)
    looped.push(stalled.reconcile("revise", "task-1|in_progress", progressed).continue)
  }
  assert.deepEqual(looped, [true, true, false])
  assert.equal(stalled.state, "blocked")

  const working = new ExecutionReconciliationController()
  for (let turn = 0; turn < 3; turn++) {
    const progressed = working.recordEvidence({
      observations: [{ toolName: "read_file", arguments: { path: `file-${turn}.ts` }, failed: false }], passedCriteria: []
    })
    assert.equal(working.reconcile("revise", "task-1|in_progress", progressed).continue, true, `turn ${turn} added evidence`)
  }
  const fourth = working.recordEvidence({
    observations: [{ toolName: "read_file", arguments: { path: "file-3.ts" }, failed: false }], passedCriteria: []
  })
  const outcome = working.reconcile("revise", "task-1|in_progress", fourth)
  assert.equal(outcome.continue, false, "new reads that never satisfy a criterion are not endless progress")
  assert.match(outcome.reason ?? "", /did not satisfy any open criterion/)
})

test("a passed criterion resets the evidence budget, and a repeated rejection stops with the open criterion", () => {
  const controller = new ExecutionReconciliationController()
  for (let turn = 0; turn < 3; turn++) {
    const kind = controller.recordEvidence({
      observations: [{ toolName: "read_file", arguments: { path: `file-${turn}.ts` }, failed: false }], passedCriteria: []
    })
    assert.equal(controller.reconcile("needs_evidence", "task-1|in_progress", kind).continue, true)
  }
  const passed = controller.recordEvidence({ observations: [], passedCriteria: ["read_file is defined"] })
  assert.equal(passed, "criteria")
  assert.equal(controller.reconcile("needs_evidence", "task-1|in_progress", passed).continue, true)
  for (let turn = 0; turn < 3; turn++) {
    const kind = controller.recordEvidence({
      observations: [{ toolName: "read_file", arguments: { path: `more-${turn}.ts` }, failed: false }], passedCriteria: []
    })
    assert.equal(controller.reconcile("needs_evidence", "task-1|in_progress", kind).continue, true, "the budget starts again")
  }

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
  const state = await fixture([{ id: "seed", acceptance: "Seed criterion" }])
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
  const state = await fixture([{ id: "verify", acceptance: "Focused tests pass" }])
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

test("failed criteria return actionable revision feedback for the next task context", async () => {
  const state = await fixture([{ id: "fix", acceptance: "Regression test passes" }])
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
  const state = await fixture([{ id: "compile", acceptance: "Tests compile and pass" }])
  try {
    const item = state.items[0]
    const note = await state.repository.addEvidence(state.scope, { itemId: item.id, kind: "claim", summary: "The tests passed.", result: "passed", requestId: "model-claim" })
    const fakeCommand = await state.repository.recordToolObservation(state.scope, {
      itemId: item.id, toolName: "run_command", arguments: { command: "echo tests passed" }, output: "tests passed", failed: false, exitCode: 0, requestId: "fake-test-command"
    })
    const review = (await state.repository.getReviewPackages(state.scope))[0]
    const evaluation = parseTodoEvaluation(responseFor(review, { refs: [note.id, fakeCommand.id] }), review, "mock-reviewer")
    assert.equal(evaluation.decision, "needs_evidence")
    assert.match(evaluation.problems[0], /relevant successful run_command observation/)
    await state.repository.applyEvaluation(state.scope, item.id, review.task.version, evaluation, "unsupported-claim")
    const after = (await state.repository.getList(state.scope)).items[0]
    assert.equal(after.status, "in_review")
    assert.equal(after.verification, "not_checked")
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("evaluation history survives reopening and duplicate requests do not transition twice", async () => {
  const state = await fixture([{ id: "persist", acceptance: "Source inspection is complete" }])
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
  const state = await fixture([{ id: "stale", acceptance: "The source was inspected" }])
  try {
    const item = state.items[0]
    const observation = await addObservation(state.repository, state.scope, item.id)
    const review = (await state.repository.getReviewPackages(state.scope))[0]
    const result = parseTodoEvaluation(responseFor(review, { refs: [observation.id] }), review, "mock-reviewer")
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
  const state = await fixture([{ id: "failure", acceptance: "Compile succeeds" }])
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
  const state = await fixture([{ id: "user-completed", acceptance: "Review by user" }])
  try {
    const item = state.items[0]
    await state.repository.completeByUser(state.scope, item.id, item.version, "Explicitly approved by user", "user-complete", trustedTodoPanelApproval)
    assert.deepEqual(await state.repository.getReviewPackages(state.scope), [])
    const otherScope = { projectFingerprint: workspaceProjectFingerprint(["file:///another-project"]), conversationId: "feedback-chat" }
    const otherPlan = { ...plan([{ id: "other", acceptance: "Other task is inspected" }]), planId: "other-plan" }
    await state.repository.synchronizeIntentPlan(otherScope, otherPlan, { prompt: "Other project" })
    const other = (await state.repository.getList(otherScope)).items[0]
    await state.repository.updateItem(otherScope, { itemId: other.id, expectedVersion: other.version, patch: { status: "completed" }, actor: "model", requestId: "other-claim" })
    assert.equal((await state.repository.getReviewPackages(otherScope)).length, 1)
    assert.deepEqual(await state.repository.getReviewPackages(state.scope), [])
    const otherChat = { ...otherScope, conversationId: "other-chat" }
    assert.deepEqual(await state.repository.getReviewPackages(otherChat), [])
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("every eligible task is evaluated with its own IDs and observations", async () => {
  const state = await fixture([
    { id: "inspect", acceptance: "The source was inspected" },
    { id: "change", acceptance: "The implementation was edited" },
    { id: "test", acceptance: "Tests pass" }
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
  const state = await fixture([{ id: "legacy", acceptance: "Legacy task is inspected" }])
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

test("existing version-4 TODO databases gain child proposals without losing tasks", async () => {
  const state = await fixture([{ id: "kept", acceptance: "Kept task is inspected" }])
  try {
    const sql = await initSqlJs({ locateFile: () => wasmPath })
    const database = new sql.Database(fs.readFileSync(state.databasePath))
    database.run("DROP TABLE todo_child_proposals; PRAGMA user_version = 4")
    fs.writeFileSync(state.databasePath, Buffer.from(database.export()))
    database.close()
    const reopened = new TodoRepository(state.databasePath, wasmPath)
    assert.equal((await reopened.getList(state.scope)).items[0].title, state.items[0].title)
    const check = new sql.Database(fs.readFileSync(state.databasePath))
    assert.equal(check.exec("PRAGMA user_version")[0].values[0][0], 5)
    assert.equal(check.exec("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'todo_child_proposals'")[0].values[0][0], 1)
    check.close()
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

const WORKSPACE_FILE = "src/extension/tools/workspace.ts"
const workspaceText = Array.from({ length: 850 }, (_, index) => {
  if (index === 168) return "  name: \"read_file\","
  if (index === 779) return "    const tool = tools.find((candidate) => candidate.name === name)"
  if (index === 799) return "    return tool.run(args)"
  return `const filler${index + 1} = ${index + 1}`
}).join("\n")
const currentWorkspace: CurrentSourceReader = async (file) => (file === WORKSPACE_FILE ? workspaceText : undefined)
type Harness = { repository: TodoRepository; scope: { projectFingerprint: string; conversationId: string } }

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
    { id: "registration", acceptance: "`read_file` is registered in `src/extension/tools/workspace.ts`" },
    { id: "dispatch", acceptance: "`tools.find` dispatches in `src/extension/tools/workspace.ts`" },
    { id: "validation", acceptance: "`read_file` argument validation is in `src/extension/tools/workspace.ts`" }
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
    const dispatchOutcome = (await reconcileCriteria(second.acceptanceCriteria, second.retainedEvidence, currentWorkspace))[0]
    assert.equal(dispatchOutcome.outcome, "proven", JSON.stringify(dispatchOutcome))
    assert.ok(dispatchOutcome.supportingObservationIds.includes(dispatchRead.id), "the dispatch proof cites the earlier window")
    const secondEvaluation = await evaluateTodoReview(state.repository, state.scope, second, async () => responseFor(second, { refs: [dispatchRead.id] }), "mock-reviewer", { readCurrentSource: currentWorkspace })
    assert.equal(secondEvaluation.decision, "accept")

    await state.repository.claimCompletion(state.scope, { itemId: validation.id, expectedVersion: validation.version, requestId: "claim-validation" })
    const third = reviewCandidates(await state.repository.getReviewPackages(state.scope), validation.id)[0]
    const validationOutcome = (await reconcileCriteria(third.acceptanceCriteria, third.retainedEvidence, currentWorkspace))[0]
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
    { id: "registration", acceptance: "`read_file` is registered in `src/extension/tools/workspace.ts`" },
    { id: "validation", acceptance: "`read_file` argument validation is in `src/extension/tools/workspace.ts`", dependencies: ["registration"] }
  ], false)
  try {
    const [registration, validation] = state.items
    const registrationRead = await observeWorkspaceWindow(state, registration.id, "read-registration", 160, 181)
    const validationRead = await observeWorkspaceWindow(state, validation.id, "read-validation", 160, 181)
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
    assert.equal(calls, 1, "exactly one Feedback call reviews the dependent task")
    assert.equal((await state.repository.getItem(state.scope, validation.id)).item.status, "completed")
    assert.equal(reviewCandidates(await state.repository.getReviewPackages(state.scope)).length, 0, "a verified task is not reviewed again")
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("a stale source observation is unknown and a failed read proves nothing", async () => {
  const stale = await fixture([{ id: "registration", acceptance: "`read_file` is registered in `src/extension/tools/workspace.ts`" }], false)
  const failed = await fixture([{ id: "registration", acceptance: "`read_file` is registered in `src/extension/tools/workspace.ts`" }], false)
  try {
    await observeWorkspaceWindow(stale, stale.items[0].id, "stale-read", 160, 181, `${workspaceText}\n// edited after the read`)
    await stale.repository.claimCompletion(stale.scope, { itemId: stale.items[0].id, expectedVersion: stale.items[0].version, requestId: "claim-stale" })
    const staleReview = reviewCandidates(await stale.repository.getReviewPackages(stale.scope))[0]
    const staleOutcome = (await reconcileCriteria(staleReview.acceptanceCriteria, staleReview.retainedEvidence, currentWorkspace))[0]
    assert.equal(staleOutcome.outcome, "unknown", JSON.stringify(staleOutcome))
    assert.deepEqual(staleOutcome.supportingObservationIds, [])
    assert.match(staleOutcome.missing.join("\n"), /changed after/)

    await failed.repository.recordToolObservation(failed.scope, {
      itemId: failed.items[0].id, toolName: "read_file", arguments: { path: WORKSPACE_FILE }, output: "read failed: file is locked", failed: true, requestId: "failed-read"
    })
    await failed.repository.claimCompletion(failed.scope, { itemId: failed.items[0].id, expectedVersion: failed.items[0].version, requestId: "claim-failed" })
    const failedReview = reviewCandidates(await failed.repository.getReviewPackages(failed.scope))[0]
    const failedOutcome = (await reconcileCriteria(failedReview.acceptanceCriteria, failedReview.retainedEvidence, currentWorkspace))[0]
    assert.equal(failedOutcome.outcome, "unknown", JSON.stringify(failedOutcome))
    assert.deepEqual(failedOutcome.supportingObservationIds, [])
  } finally {
    fs.rmSync(stale.directory, { recursive: true, force: true })
    fs.rmSync(failed.directory, { recursive: true, force: true })
  }
})

test("the final report separates awaiting, review, and failed states from verified work", async () => {
  const state = await fixture([
    { id: "registration", acceptance: "`read_file` is registered in `src/extension/tools/workspace.ts`" },
    { id: "validation", acceptance: "`read_file` argument validation is in `src/extension/tools/workspace.ts`", dependencies: ["registration"] }
  ], false)
  try {
    const [registration, validation] = state.items
    await observeWorkspaceWindow(state, registration.id, "read-registration", 160, 181)
    await state.repository.recordToolObservation(state.scope, {
      itemId: validation.id, toolName: "run_command", arguments: { command: "npx tsc --noEmit" }, output: "tsc: 2 errors", failed: true, exitCode: 2, requestId: "failed-compile"
    })
    await state.repository.claimCompletion(state.scope, { itemId: registration.id, expectedVersion: registration.version, requestId: "claim-registration" })
    await state.repository.claimCompletion(state.scope, { itemId: validation.id, expectedVersion: validation.version, requestId: "claim-validation" })

    const outline = await state.repository.getPlanOutline(state.scope)
    const report = authoritativeExecutionReport(outline!, await state.repository.failedToolOperations(state.scope))
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
  const exposed = await fixture([{ id: "read_file_exposed", acceptance: "`read_file` is exposed to the model in the outgoing tool inventory" }])
  const registered = await fixture([{ id: "read_file_registered", acceptance: "`read_file` is registered in src/extension/tools/workspace.ts" }])
  try {
    const inventory = { outgoingToolCount: 1, outgoingTools: ["read_file"] }
    const exposure = await exposed.repository.recordToolObservation(exposed.scope, {
      itemId: exposed.items[0].id, toolName: RUNTIME_INVENTORY_TOOL, arguments: {}, output: JSON.stringify(inventory), evidenceOutput: JSON.stringify(inventory), failed: false, requestId: "inventory-exposed"
    })
    const exposureReview = (await exposed.repository.getReviewPackages(exposed.scope))[0]
    const accepted = parseTodoEvaluation(responseFor(exposureReview, { refs: [exposure.id] }), exposureReview, "mock-reviewer")
    assert.equal(accepted.criteria[0].status, "passed", `the host inventory establishes exposure: ${JSON.stringify(accepted.problems)}`)

    const registration = await registered.repository.recordToolObservation(registered.scope, {
      itemId: registered.items[0].id, toolName: RUNTIME_INVENTORY_TOOL, arguments: {}, output: JSON.stringify(inventory), evidenceOutput: JSON.stringify(inventory), failed: false, requestId: "inventory-registered"
    })
    const registrationReview = (await registered.repository.getReviewPackages(registered.scope))[0]
    const rejected = parseTodoEvaluation(responseFor(registrationReview, { refs: [registration.id] }), registrationReview, "mock-reviewer")
    assert.equal(rejected.criteria[0].status, "unverified")
    assert.ok(rejected.problems.some((problem) => problem.includes("does not establish source registration")))
  } finally {
    fs.rmSync(exposed.directory, { recursive: true, force: true })
    fs.rmSync(registered.directory, { recursive: true, force: true })
  }
})

test("a successful but unrelated shell command cannot prove tests passed", async () => {
  const state = await fixture([{ id: "fake-test", acceptance: "Tests pass" }])
  try {
    const item = state.items[0]
    const observation = await state.repository.recordToolObservation(state.scope, {
      itemId: item.id, toolName: "run_command", arguments: { command: "echo done" }, output: "done", failed: false, exitCode: 0, requestId: "echo-is-not-test"
    })
    const review = (await state.repository.getReviewPackages(state.scope))[0]
    const result = parseTodoEvaluation(responseFor(review, { refs: [observation.id] }), review, "mock-reviewer")
    assert.equal(result.decision, "needs_evidence")
    assert.equal((await state.repository.applyEvaluation(state.scope, item.id, review.task.version, result, "echo-unverified")).decision, "needs_evidence")
    assert.equal((await state.repository.getList(state.scope)).items[0].status, "in_review")
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("a plan revision invalidates an evaluation package even when the item version did not change", async () => {
  const state = await fixture([{ id: "revision", acceptance: "Source inspection is complete" }])
  try {
    const item = state.items[0]
    const observation = await addObservation(state.repository, state.scope, item.id)
    const review = (await state.repository.getReviewPackages(state.scope))[0]
    const result = parseTodoEvaluation(responseFor(review, { refs: [observation.id] }), review, "mock-reviewer")
    await state.repository.synchronizeIntentPlan(state.scope, { ...plan([{ id: "revision", acceptance: "Source inspection is complete" }]), revision: 2, goal: "Changed goal" }, { prompt: "Changed goal" })
    await assert.rejects(state.repository.applyEvaluation(state.scope, item.id, review.task.version, result, "old-plan-review"), /Intent plan changed/)
    assert.equal((await state.repository.getList(state.scope)).items[0].status, "in_review")
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("analysis-only evaluation may accept a complete answer without file edits", async () => {
  const state = await fixture([{ id: "explain", acceptance: "The design tradeoffs are explained" }])
  try {
    const review = (await state.repository.getReviewPackages(state.scope))[0]
    const evaluation = parseTodoEvaluation(responseFor(review), review, "mock-reviewer", new Date().toISOString(), true)
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
    { id: "field-check", acceptance: "The validation rule is documented" },
    { id: "field-order", acceptance: "The schema version is documented", dependencies: ["field-check"] }
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
    review.acceptanceCriteria = ["The validation rule is documented", "The schema version " + "is checked ".repeat(50)]
    assert.deepEqual(JSON.parse(todoReviewInput(review)).task.acceptanceCriteria, review.acceptanceCriteria)
    const textInsteadOfCriterion = JSON.parse(responseFor(review))
    textInsteadOfCriterion.criteria = review.acceptanceCriteria.map((criterion: string) => ({
      text: criterion,
      status: "passed",
      evidenceRefs: []
    }))
    assert.throws(() => parseTodoEvaluation(JSON.stringify(textInsteadOfCriterion), review, "mock-reviewer"), (error: unknown) => {
      return error instanceof TodoEvaluationValidationError && error.code === "missing_field" && error.field === "criteria[0].criterion"
    })

    const droppedCriterionAndStringInstructions = JSON.parse(responseFor(review))
    droppedCriterionAndStringInstructions.criteria = review.acceptanceCriteria.map(() => ({
      status: "passed",
      evidenceRefs: []
    }))
    droppedCriterionAndStringInstructions.correctiveInstructions = "Fix the schema"
    assert.throws(() => parseTodoEvaluation(JSON.stringify(droppedCriterionAndStringInstructions), review, "mock-reviewer"), (error: unknown) => {
      return error instanceof TodoEvaluationValidationError && error.field === "criteria[0].criterion"
    })

    const reordered = JSON.parse(responseFor(review))
    reordered.criteria.reverse()
    assert.throws(() => parseTodoEvaluation(JSON.stringify(reordered), review, "mock-reviewer"), (error: unknown) => {
      return error instanceof TodoEvaluationValidationError && error.field === "criteria[0].criterion"
    })

    const stringInstructions = JSON.parse(responseFor(review))
    stringInstructions.correctiveInstructions = "Fix the schema"
    assert.throws(() => parseTodoEvaluation(JSON.stringify(stringInstructions), review, "mock-reviewer"), (error: unknown) => {
      return error instanceof TodoEvaluationValidationError && error.field === "correctiveInstructions"
    })

    const valid = parseTodoEvaluation(responseFor(review), review, "mock-reviewer")
    assert.deepEqual(valid.criteria.map((criterion) => criterion.criterion), review.acceptanceCriteria)
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("an early file read remains evaluator-visible across later tool calls and automatic continuation", async () => {
  const state = await fixture([{
    id: "retain-evidence",
    acceptance: "Inspect src/webview/styles/todo-panel.module.css and confirm its styling"
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
    const firstDecision = parseTodoEvaluation(responseFor(firstReview, {
      decision: "needs_evidence",
      status: "unverified",
      problems: ["Continue with the remaining evidence."]
    }), firstReview, "mock-reviewer")
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
      criteria: active!.acceptanceCriteria,
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
      ["run_command", { command: "npm test" }, "Tests passed."],
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
    assert.throws(() => parseTodoEvaluation(responseFor(review, { refs: [omittedObservation!.id] }), review, "mock-reviewer"), (error: unknown) =>
      error instanceof TodoEvaluationValidationError && error.field === "criteria[0].evidenceRefs")
    const evaluation = parseTodoEvaluation(responseFor(review, { refs: [initial.id] }), review, "mock-reviewer")
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
  const state = await fixture([{ id: "implement", acceptance: "The requested component is updated" }])
  try {
    const item = state.items[0]
    const observation = await addObservation(state.repository, state.scope, item.id)
    const review = (await state.repository.getReviewPackages(state.scope))[0]
    const evaluation = await evaluateTodoReview(state.repository, state.scope, review,
      async () => responseFor(review, { refs: [observation.id] }), "mock-reviewer",
      { requireWorkspaceChanges: true, hasVerifiedFileChanges: false })
    assert.equal(evaluation.decision, "needs_evidence")
    assert.match(evaluation.problems.join(" "), /No verified workspace file changes|file-mutation observation/)
    assert.equal((await state.repository.getList(state.scope)).items[0].status, "in_review")
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})


test("evaluator fixtures validate schema, canonical plan IDs, and wrapped JSON independently", async () => {
  const state = await fixture([{ id: "task-1", acceptance: "Source paths are documented" }])
  try {
    const review = (await state.repository.getReviewPackages(state.scope))[0]
    const valid = responseFor(review)
    assert.equal(parseTodoEvaluation(valid, review, "mock-reviewer").taskId, review.planTaskId)
    assert.equal(todoReviewInput(review).includes("\"taskId\":\"task-1\""), true)
    assert.equal(todoReviewInput(review).includes("\"todoId\":\"" + review.task.id + "\""), true)
    assert.equal(parseTodoEvaluation("Assessment follows.\n\x60\x60\x60json\n" + valid + "\n\x60\x60\x60\nEnd.", review, "mock-reviewer").taskId, review.planTaskId)

    const wrongId = JSON.parse(valid)
    wrongId.taskId = review.task.id
    assert.throws(() => parseTodoEvaluation(JSON.stringify(wrongId), review, "mock-reviewer"), (error: unknown) => error instanceof TodoEvaluationValidationError && error.code === "task_id" && error.expected === review.planTaskId && error.received === review.task.id)

    const missingVersion = JSON.parse(valid)
    delete missingVersion.schemaVersion
    assert.throws(() => parseTodoEvaluation(JSON.stringify(missingVersion), review, "mock-reviewer"), (error: unknown) => error instanceof TodoEvaluationValidationError && error.code === "missing_field")
    const wrongVersion = JSON.parse(valid)
    wrongVersion.schemaVersion = 2
    assert.throws(() => parseTodoEvaluation(JSON.stringify(wrongVersion), review, "mock-reviewer"), (error: unknown) => error instanceof TodoEvaluationValidationError && error.code === "schema_version")
    const unknownDecision = JSON.parse(valid)
    unknownDecision.decision = "approve"
    assert.throws(() => parseTodoEvaluation(JSON.stringify(unknownDecision), review, "mock-reviewer"), (error: unknown) => error instanceof TodoEvaluationValidationError && error.code === "decision")
    assert.throws(() => parseTodoEvaluation("{broken", review, "mock-reviewer"), (error: unknown) => error instanceof TodoEvaluationValidationError && error.code === "malformed_json")
    assert.throws(() => parseTodoEvaluation("", review, "mock-reviewer"), (error: unknown) => error instanceof TodoEvaluationValidationError && error.code === "empty_response")
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("one malformed evaluator response can be corrected once and only the validated result persists", async () => {
  const state = await fixture([{ id: "task-retry", acceptance: "Source paths are documented" }])
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
  const malformedState = await fixture([{ id: "task-bad-retry", acceptance: "Source paths are documented" }])
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

  const providerState = await fixture([{ id: "task-provider-error", acceptance: "Source paths are documented" }])
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
    { id: "task-1", acceptance: "TODO panel file paths are documented" },
    { id: "task-2", acceptance: "Compact collapsible cards are implemented", dependencies: ["task-1"] }
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
      async () => responseFor(review, { refs: [observation.id] }), "mock-reviewer", { requireWorkspaceChanges: taskRequiresWorkspaceChanges(review.task, review.acceptanceCriteria), hasVerifiedFileChanges: false })
    assert.equal(evaluation.decision, "accept", "an inspection task can complete without editing source files")
    assert.equal(taskRequiresWorkspaceChanges(review.task, review.acceptanceCriteria), false)
    assert.equal((await state.repository.getList({ ...state.scope, includeCompleted: true })).items.find((item) => item.id === inReview.id)?.status, "completed")

    const implementation = await state.repository.getActiveIntentContext(state.scope)
    assert.equal(implementation?.planTaskId, "task-2", "the completed inspection dependency unlocks implementation")
    assert.equal(taskRequiresWorkspaceChanges(implementation!.task, implementation!.acceptanceCriteria), true)
    assert.equal(controller.advanceAcceptedTask("task-1:accepted").state, "continue")
    const continuation = continuationContext({
      goal: inspection!.goal,
      constraints: inspection!.constraints,
      task: implementation!.task.title,
      criteria: implementation!.acceptanceCriteria,
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

const recordTool = (repository: TodoRepository, scope: { projectFingerprint: string; conversationId: string }, itemId: string, toolName: string, failed = false) =>
  repository.recordToolObservation(scope, {
    itemId,
    toolName,
    arguments: { path: "twinny_index_smoke_test.ts" },
    output: failed ? "Tool failed." : "Tool returned the expected result.",
    failed,
    requestId: `mutation-${itemId}-${toolName}-${failed}`
  })

test("file-mutation criteria require a successful matching mutation tool, not any read", async () => {
  const cases: { acceptance: string; tool: string; expectAccept: boolean }[] = [
    { acceptance: "Create twinny_index_smoke_test.ts with the ALPHA identifier", tool: "read_file", expectAccept: false },
    { acceptance: "Create twinny_index_smoke_test.ts with the ALPHA identifier", tool: "create_file", expectAccept: true },
    { acceptance: "Replace ALPHA with BETA in twinny_index_smoke_test.ts", tool: "search_workspace", expectAccept: false },
    { acceptance: "Replace ALPHA with BETA in twinny_index_smoke_test.ts", tool: "edit_lines", expectAccept: true },
    { acceptance: "Delete twinny_index_smoke_test.ts from the workspace", tool: "edit_lines", expectAccept: false },
    { acceptance: "Delete twinny_index_smoke_test.ts from the workspace", tool: "delete_file", expectAccept: true }
  ]
  for (const example of cases) {
    const state = await fixture([{ id: "mutation", acceptance: example.acceptance }])
    try {
      const observation = await recordTool(state.repository, state.scope, state.items[0].id, example.tool)
      const review = (await state.repository.getReviewPackages(state.scope))[0]
      const evaluation = await evaluateTodoReview(state.repository, state.scope, review,
        async () => responseFor(review, { refs: [observation.id] }), "mock-reviewer")
      assert.equal(evaluation.decision === "accept", example.expectAccept, `${example.tool} for "${example.acceptance}"`)
      if (!example.expectAccept) {
        assert.ok(evaluation.problems.some((problem) => problem.includes("file-mutation observation")), "missing mutation problem is explained")
        assert.equal((await state.repository.getList(state.scope)).items[0].status !== "completed", true)
      }
    } finally {
      fs.rmSync(state.directory, { recursive: true, force: true })
    }
  }
})

test("a failed mutation observation never supports a file-change claim", async () => {
  const state = await fixture([{ id: "create", acceptance: "Create twinny_index_smoke_test.ts" }])
  try {
    const failed = await recordTool(state.repository, state.scope, state.items[0].id, "create_file", true)
    const review = (await state.repository.getReviewPackages(state.scope))[0]
    const result = parseTodoEvaluation(responseFor(review, { refs: [failed.id] }), review, "mock-reviewer")
    assert.notEqual(result.decision, "accept")
    assert.equal(result.criteria[0].status, "unverified")
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("analysis-only evidence exemption does not cover file-mutation claims", async () => {
  const state = await fixture([{ id: "claim", acceptance: "Create, edit, and delete twinny_index_smoke_test.ts" }])
  try {
    const search = await recordTool(state.repository, state.scope, state.items[0].id, "search_workspace")
    const review = (await state.repository.getReviewPackages(state.scope))[0]
    const result = parseTodoEvaluation(responseFor(review, { refs: [search.id] }), review, "mock-reviewer", new Date().toISOString(), true)
    assert.notEqual(result.decision, "accept")
    assert.equal(result.criteria[0].status, "unverified")
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("workspace-index regression: claimed create, edit, and delete without tool execution stays unverified", async () => {
  const state = await fixture([{ id: "index-smoke", acceptance: "Create twinny_index_smoke_test.ts, replace ALPHA with BETA, then delete it" }])
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
    const scope = { projectFingerprint: workspaceProjectFingerprint(["file:///todo-tools"]), conversationId: "todo-tools-chat" }
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

test("feedback plans omit TODO bookkeeping tasks but keep distinct user work", () => {
  const plan = {
    planId: "plan-bookkeeping",
    version: 1,
    revision: 1,
    goal: "Index the workspace search",
    constraints: [],
    tasks: [
      { id: "init", title: "Initialize investigation TODOs", description: "Create the TODO entries for this plan", acceptanceCriteria: ["TODOs exist"], dependencies: [] },
      { id: "locate", title: "Locate read_file definition", description: "Find the native tool", acceptanceCriteria: ["Path identified"], dependencies: ["init"] },
      { id: "task-list-ui", title: "Add task list component", description: "Render the task list panel", acceptanceCriteria: ["Panel renders"], dependencies: ["locate"] }
    ]
  }
  const parsed = parseFeedbackPlanResponse(JSON.stringify({ track: true, plan }))
  assert.ok("plan" in parsed, "the plan must remain valid after removing bookkeeping")
  assert.deepEqual(parsed.plan.tasks.map((task) => task.id), ["locate", "task-list-ui"])
  assert.deepEqual(parsed.plan.tasks[0].dependencies, [])
})

const EVIDENCE_FILE = "src/extension/tools/workspace.ts"
const sourceLines = Array.from({ length: 850 }, (_, index) => index === 168 ? "  name: \"read_file\"," : `const filler${index + 1} = ${index + 1}`)
const numbered = (start: number, lines: string[]) => lines.map((text, index) => `${start + index}: ${text}`).join("\n")
const readOutput = (file: string, start: number, lines: string[]) =>
  `${file} (lines ${start}–${start + lines.length - 1} of 850)\ncontent_hash: sha256:${"a".repeat(64)}; total_lines: 850\n${numbered(start, lines)}`

const evidenceFixture = async (acceptance: string, listChars?: number) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-evidence-"))
  const databasePath = path.join(directory, "twinny-state.sqlite")
  const scope = { projectFingerprint: workspaceProjectFingerprint(["file:///evidence-project"]), conversationId: "evidence-chat" }
  const repository = new TodoRepository(databasePath, wasmPath, { listChars: listChars ?? 2_000_000 })
  await repository.synchronizeIntentPlan(scope, plan([{ id: "investigate", acceptance }]), { prompt: "Explain how read_file is registered" })
  return { directory, databasePath, scope, repository }
}
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

const observeRead = (state: EvidenceFixture, itemId: string, requestId: string, file: string, start: number, lines: string[]) =>
  state.repository.recordToolObservation(state.scope, {
    itemId,
    toolName: "read_file",
    arguments: { path: file, start_line: String(start), end_line: String(start + lines.length - 1) },
    output: `read \`${file}:${start}\` · ${lines.length} lines`,
    failed: false,
    requestId,
    evidenceOutput: readOutput(file, start, lines)
  })

const reviewFor = async (state: EvidenceFixture, itemId: string) =>
  (await state.repository.getReviewPackages(state.scope)).find((candidate) => candidate.task.id === itemId)!

test("a numbered read keeps its path, line range, total, and every source line", () => {
  const output = readOutput(EVIDENCE_FILE, 150, sourceLines.slice(149, 200))
  const preserved = preserveEvidence(output)
  assert.equal(preserved.complete, true)
  assert.equal(preserved.content, output)
  assert.deepEqual(preserved.sources, [{ path: EVIDENCE_FILE, startLine: 150, endLine: 200, totalLines: 850, contentHash: `sha256:${"a".repeat(64)}` }])
  assert.ok(preserved.content.split("\n").includes("169:   name: \"read_file\","))
})

test("search output keeps each hit's path, line, and preview", () => {
  const output = JSON.stringify({
    query: "read_file", mode: "text", total: 1, offset: 0, limit: 20,
    results: [{ path: EVIDENCE_FILE, line: 169, column: 3, category: "symbol", symbol: "read_file", kind: "property", preview: "name: \"read_file\",", source: "ts" }]
  })
  const hits = preserveEvidence(output).hits
  assert.equal(hits.length, 1)
  assert.equal(hits[0].path, EVIDENCE_FILE)
  assert.equal(hits[0].line, 169)
  assert.match(hits[0].preview, /read_file/)
})

test("oversized source is cut at a whole line and reports that it is incomplete", () => {
  const output = readOutput(EVIDENCE_FILE, 1, sourceLines.map((line) => line + " ".repeat(400)))
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
  assert.ok(excerpt.text.split("\n").includes("169:   name: \"read_file\","))
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
    content: "169:   name: \"read_file\",",
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
  const state = await evidenceFixture("`read_file` is defined and registered in src/extension/tools/workspace.ts")
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
      evidenceOutput: JSON.stringify({ query: "read_file", mode: "text", total: 1, offset: 0, limit: 20, results: [{ path: EVIDENCE_FILE, line: 169, column: 3, category: "symbol", symbol: "read_file", kind: "property", preview: "name: \"read_file\",", source: "ts" }] })
    })
    const review = await reviewFor(state, item.id)
    const input = JSON.parse(todoReviewInput(review, undefined, "Found it."))
    const excerpt = input.trustedEvidenceExcerpts.find((entry: { observationId: string }) => entry.observationId === observation.id)
    assert.ok(excerpt, "the source read is offered to Feedback as an excerpt")
    assert.ok(excerpt.text.includes("169:   name: \"read_file\","))
    assert.deepEqual(input.deterministicCoverage, [], "the stored evidence covers every anchor")

    const evaluation = await evaluateTodoReview(state.repository, state.scope, review, async () => responseFor(review, { refs: [observation.id] }), "mock-reviewer", { requireWorkspaceChanges: taskRequiresWorkspaceChanges(review.task, review.acceptanceCriteria), hasVerifiedFileChanges: false })
    assert.equal(evaluation.decision, "accept")
    assert.equal((await state.repository.getList({ ...state.scope, includeCompleted: true })).items.find((candidate) => candidate.id === item.id)?.status, "completed")
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("a passed criterion whose named symbol appears in no retained evidence is rejected with that symbol", async () => {
  const state = await evidenceFixture("`registerNativeTool` wires `read_file` in src/extension/tools/workspace.ts")
  try {
    const item = await startInvestigation(state)
    const observation = await observeRead(state, item.id, "read-workspace-partial", EVIDENCE_FILE, 150, sourceLines.slice(149, 200))
    const review = await reviewFor(state, item.id)
    const evaluation = await evaluateTodoReview(state.repository, state.scope, review, async () => responseFor(review, { refs: [observation.id] }), "mock-reviewer", { requireWorkspaceChanges: false, hasVerifiedFileChanges: false })
    assert.equal(evaluation.decision, "needs_evidence")
    assert.equal(evaluation.criteria[0].status, "unverified")
    assert.ok(evaluation.problems.some((problem) => problem.includes("`registerNativeTool` does not appear in any retained observation")))
    assert.notEqual((await state.repository.getList({ ...state.scope, includeCompleted: true })).items.find((candidate) => candidate.id === item.id)?.status, "completed")
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("a criterion whose source was never read is rejected as missing, not inferred from search output", async () => {
  const state = await evidenceFixture("`read_file` is verified in src/extension/tools/view.ts")
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
    const evaluation = await evaluateTodoReview(state.repository, state.scope, review, async () => responseFor(review, { refs: [observation.id] }), "mock-reviewer", { requireWorkspaceChanges: false, hasVerifiedFileChanges: false })
    assert.equal(evaluation.decision, "needs_evidence")
    assert.ok(evaluation.problems.some((problem) => problem.includes("no successful observation covers src/extension/tools/view.ts")))
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

const searchHits = (hits: { path: string; line: number; preview: string }[]) => JSON.stringify({
  query: "read_file", mode: "text", total: hits.length, offset: 0, limit: 20,
  results: hits.map((hit) => ({ ...hit, column: 1, category: "symbol", kind: "property", source: "ts" }))
})

test("a registration window far past the head of a long read is offered with its file line range", async () => {
  const state = await evidenceFixture("`workspaceTools` registers `readFile` in src/extension/tools/workspace.ts")
  try {
    const item = await startInvestigation(state)
    const registration = sourceLines.map((line, index) => index === 778 ? "export const workspaceTools = [readFile]," : line)
    await observeRead(state, item.id, "read-registration", EVIDENCE_FILE, 1, registration)
    const input = JSON.parse(todoReviewInput(await reviewFor(state, item.id)))
    const excerpt = input.trustedEvidenceExcerpts.find((entry: { text: string }) => entry.text.includes("779: export const workspaceTools"))
    assert.ok(excerpt, "the registration line is offered although it lies beyond line 40")
    assert.deepEqual(excerpt.lines, { start: 776, end: 782 })
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("a criterion with many matches shows its first window, budgets the rest, and indexes every omitted window", async () => {
  const state = await evidenceFixture("`readFile` dispatch in src/extension/tools/workspace.ts")
  try {
    const item = await startInvestigation(state)
    const dense = sourceLines.map((line, index) => index % 10 === 0 ? `  const value${index} = readFile(${index})` : line)
    await observeRead(state, item.id, "read-dense", EVIDENCE_FILE, 1, dense)
    const input = JSON.parse(todoReviewInput(await reviewFor(state, item.id)))
    const included = input.trustedEvidenceExcerpts as { text: string; lines?: { start: number } }[]
    const includedChars = included.reduce((sum, entry) => sum + entry.text.length, 0)
    assert.equal(included[0].lines?.start, 1, "the first window is always visible")
    assert.ok(includedChars <= 4_000 + 1_200, "later windows stay within the criterion budget")
    const omitted = (input.evidenceIndex as { included: boolean; observationId: string; lines?: unknown }[]).filter((entry) => !entry.included)
    assert.ok(omitted.length > 0, "windows beyond the budget are listed, not silently dropped")
    assert.ok(omitted.every((entry) => entry.observationId.length > 0 && entry.lines), "each omitted window names its observation and lines")
    assert.deepEqual(input.deterministicCoverage, [], "retained content still establishes the anchors")
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("one window that supports two criteria is shown once and attributed to both", async () => {
  const state = await evidenceFixture("`readFile` dispatch in src/extension/tools/workspace.ts")
  try {
    const item = await startInvestigation(state)
    await observeRead(state, item.id, "read-shared", EVIDENCE_FILE, 1, sourceLines.map((line, index) => index === 168 ? "  name: \"readFile\"," : line))
    const review = await reviewFor(state, item.id)
    const input = JSON.parse(todoReviewInput({ ...review, acceptanceCriteria: ["`readFile` dispatch in src/extension/tools/workspace.ts", "`readFile` is named in src/extension/tools/workspace.ts"] }))
    const shared = input.trustedEvidenceExcerpts.filter((entry: { text: string }) => entry.text.includes("169:   name: \"readFile\","))
    assert.equal(shared.length, 1, "the window is not duplicated")
    assert.equal(shared[0].criteria.length, 2, "the window supports both criteria")
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("search hits become windows of their own with path and line, and unrelated hits stay out", async () => {
  const state = await evidenceFixture("`read_file` is exposed as `readFile` in src/extension/tools/workspace.ts")
  try {
    const item = await startInvestigation(state)
    await state.repository.recordToolObservation(state.scope, {
      itemId: item.id,
      toolName: "search_workspace",
      arguments: { query: "read_file", path: "src" },
      output: "search_workspace read_file: 2 hits",
      failed: false,
      requestId: "search-hits",
      evidenceOutput: searchHits([
        { path: EVIDENCE_FILE, line: 169, preview: "name: \"read_file\"," },
        { path: "src/other/unrelated.ts", line: 12, preview: "const unrelated = 1" }
      ])
    })
    const input = JSON.parse(todoReviewInput(await reviewFor(state, item.id)))
    assert.equal(input.trustedEvidenceExcerpts.length, 1, "only the matching hit is offered")
    const [excerpt] = input.trustedEvidenceExcerpts
    assert.equal(excerpt.text, `${EVIDENCE_FILE}:169 name: "read_file",`)
    assert.deepEqual(excerpt.lines, { start: 169, end: 169 })
    assert.deepEqual(excerpt.sources, [{ path: EVIDENCE_FILE, startLine: 169, endLine: 169 }])
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("a duplicate tool delivery stores one observation and one evidence record", async () => {
  const state = await evidenceFixture("`read_file` is defined in src/extension/tools/workspace.ts")
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
  const state = await evidenceFixture("`read_file` is defined in src/extension/tools/workspace.ts")
  try {
    const item = await startInvestigation(state)
    const observation = await observeRead(state, item.id, "persisted-read", EVIDENCE_FILE, 150, sourceLines.slice(149, 200))
    const reopened = new TodoRepository(state.databasePath, wasmPath)
    const review = await reviewFor({ ...state, repository: reopened }, item.id)
    const retained = review.retainedEvidence.find((entry) => entry.observationId === observation.id)
    assert.ok(retained?.content?.includes("169:   name: \"read_file\","))
    assert.deepEqual(retained?.sources, [{ path: EVIDENCE_FILE, startLine: 150, endLine: 200, totalLines: 850, contentHash: `sha256:${"a".repeat(64)}` }])
    assert.equal(review.observations.find((entry) => entry.id === observation.id)?.evidence?.retained, true)
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("evidence evicted by the storage budget is reported as evicted, never as covered", async () => {
  const size = preserveEvidence(readOutput(EVIDENCE_FILE, 150, sourceLines.slice(149, 200))).preservedChars
  const state = await evidenceFixture("`read_file` is defined in src/extension/tools/workspace.ts", Math.ceil(size * 1.5))
  try {
    const item = await startInvestigation(state)
    const evicted = await observeRead(state, item.id, "first-read", EVIDENCE_FILE, 150, sourceLines.slice(149, 200))
    await observeRead(state, item.id, "second-read", "src/extension/tools/other.ts", 1, sourceLines.slice(0, 51))
    const review = await reviewFor(state, item.id)
    assert.equal(review.observations.find((entry) => entry.id === evicted.id)?.evidence?.retained, false)
    assert.equal(review.retainedEvidence.find((entry) => entry.observationId === evicted.id)?.content, undefined)
    const evaluation = await evaluateTodoReview(state.repository, state.scope, review, async () => responseFor(review, { refs: [evicted.id] }), "mock-reviewer", { requireWorkspaceChanges: false, hasVerifiedFileChanges: false })
    assert.equal(evaluation.decision, "needs_evidence")
    assert.ok(evaluation.problems.some((problem) => problem.includes("evicted")))
  } finally {
    fs.rmSync(state.directory, { recursive: true, force: true })
  }
})

test("an in-review claim is queued for Feedback and approval completes it with verified evidence", async () => {
  const state = await fixture([{ id: "locate_native_read_file_tool_definition", acceptance: "The read_file definition is located" }], false)
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
  const state = await fixture([{ id: "trace_read_file_dispatch", acceptance: "The dispatch path is traced" }], false)
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
    { id: "locate_native_read_file_tool_definition", acceptance: "The read_file definition is located" },
    { id: "trace_read_file_dispatch", acceptance: "The dispatch path is traced" }
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
  { id: "locate_source_definition", acceptance: "The definition is located" },
  { id: "trace_source_dispatch", acceptance: "The dispatch path is traced" }
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
    const tasks = (acceptance: string) => [
      { id: "locate_source_definition", acceptance },
      { id: "trace_source_dispatch", acceptance: "The dispatch path is traced" }
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
    const removedPlan = { ...plan([{ id: "trace_source_dispatch", acceptance: "The dispatch path is traced" }]), revision: 4 }
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

test("umbrella creates restating several plan tasks reuse the plan while distinct subtasks are created", async () => {
  const state = await fixture([
    { id: "locate_read_file_definition", acceptance: "The read_file definition is located" },
    { id: "identify_tool_registration", acceptance: "The registration array includes readFile" },
    { id: "trace_dispatch_implementation", acceptance: "Dispatch reaches the implementation" }
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
  const state = await fixture([{ id: "locate_native_read_file_tool_definition", acceptance: "The read_file definition is located" }], false)
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
