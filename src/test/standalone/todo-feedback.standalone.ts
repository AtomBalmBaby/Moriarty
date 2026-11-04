import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import initSqlJs from "sql.js"

import { continuationContext,ExecutionReconciliationController } from "../../extension/chat/execution-reconciliation"
import { evaluateTodoReview, feedbackContext, parseTodoEvaluation, taskRequiresWorkspaceChanges, TodoEvaluationValidationError, todoReviewInput } from "../../extension/todos/feedback"
import { TodoRepository, workspaceProjectFingerprint } from "../../extension/todos/repository"
import type { TodoEvaluation, TodoReviewPackage } from "../../extension/todos/types"

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
    await state.repository.completeByUser(state.scope, item.id, item.version, "Explicitly approved by user", "user-complete")
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
      const observation = await addObservation(state.repository, state.scope, item.id, task === "test" ? "run_command" : task, task === "test" ? 0 : undefined)
      expected.set(item.id, observation.id)
    }
    const reviews = await state.repository.getReviewPackages(state.scope)
    assert.equal(reviews.length, 3)
    for (const review of reviews) {
      const own = review.observations[0]
      assert.equal(own.itemId, review.task.id)
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
    assert.match(evaluation.problems.join(" "), /No verified workspace file changes/)
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
