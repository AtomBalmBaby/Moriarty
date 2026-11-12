import assert from "assert"
import test from "node:test"

import {
  allIntentTasksComplete,
  classifyUnresolvedPlan,
  continuationContext,
  ExecutionReconciliationController,
  forbiddenDeleteReason,
  unresolvedPlanMessage
} from "../../extension/chat/execution-reconciliation"
import { ToolSteps } from "../../extension/chat/tool-steps"
import { taskRequiresWorkspaceChanges } from "../../extension/todos/feedback"

test("tool steps are emitted when each call starts, before it finishes, and a review updates in place", () => {
  const sent: string[] = []
  const steps = new ToolSteps((list) => sent.push(list.map((step) => `${step.id}:${step.status}`).join(",")))
  steps.start({ id: "t1", name: "read_file", args: { path: "a.ts" } })
  assert.equal(sent.length, 1)
  assert.equal(sent[0], "t1:running", "a running call is visible before its result exists")
  steps.finish({ id: "t1", index: 0, mode: "native", output: "ok", failed: false, summary: "1 line of output" } as never)
  assert.equal(sent[sent.length - 1], "t1:done")
  steps.review("feedback.review.p1", "Feedback reviewing `Edit`", "running")
  steps.review("feedback.review.p1", "Feedback rejected `Edit`: needs evidence", "failed")
  assert.equal(sent[sent.length - 1], "t1:done,feedback.review.p1:failed")
  assert.equal(steps.steps.length, 2, "the review entry is replaced, not duplicated")
})

test("the no-progress reason reports the number of no-progress turns actually counted", () => {
  const controller = new ExecutionReconciliationController()
  assert.equal(controller.reconcile("revise", "same-failure").continue, true)
  const blocked = controller.reconcile("revise", "same-failure")
  assert.equal(blocked.continue, false)
  assert.match(blocked.reason ?? "", /for 2 consecutive turns/)
})

test("an incomplete implementation turn is independently continued once", () => {
  const controller = new ExecutionReconciliationController()
  const decision = controller.reconcile("revise", "no-edits:no-tool-success")
  assert.equal(decision.continue, true)
  assert.equal(decision.state, "repairing")
  assert.equal(controller.claimContinuation(), true)
  assert.equal(controller.claimContinuation(), false)
  controller.continuationStarted()
  assert.equal(controller.claimContinuation(), true)
})

test("accepted and analysis-only turns do not cause unnecessary retries", () => {
  const controller = new ExecutionReconciliationController()
  assert.equal(controller.reconcile("accept", "verified").state, "accepted")
  assert.equal(controller.claimContinuation(), false)
  assert.equal(taskRequiresWorkspaceChanges([{ id: "explain", description: "Explain how the todo panel works", verification: { kind: "semantic_review" } }]), false)
  assert.equal(taskRequiresWorkspaceChanges([{ id: "modify", description: "Modify the todo panel to be compact", verification: { kind: "workspace_mutation" } }]), true)
})

test("retry and no-progress limits block repetitive execution", () => {
  const controller = new ExecutionReconciliationController({ maxIterations: 4, maxNoProgress: 2 })
  assert.equal(controller.reconcile("needs_evidence", "same-failure").continue, true)
  assert.equal(controller.reconcile("revise", "same-failure").continue, false)
  assert.equal(controller.state, "blocked")
})

test("deleting a named component as a recovery attempt is rejected but authorized deletion remains possible", () => {
  assert.match(forbiddenDeleteReason("Modify src/webview/todo-panel.tsx", "src/webview/todo-panel.tsx") ?? "", /conflicts/)
  assert.equal(forbiddenDeleteReason("Delete src/webview/todo-panel.tsx", "src/webview/todo-panel.tsx"), undefined)
  assert.match(forbiddenDeleteReason("Modify src/webview/todo-panel.tsx and remove obsolete CSS", "src/webview/todo-panel.tsx") ?? "", /conflicts/)
  assert.equal(forbiddenDeleteReason("Modify the panel", "src/webview/todo-panel.tsx"), undefined)
})

test("continuation context stays bounded and marks prior prose as untrusted", () => {
  const message = continuationContext({
    goal: "modify panel",
    constraints: ["no new dependencies"],
    task: "implement collapse",
    criteria: ["cards collapse"],
    feedback: ["No file edits were verified"],
    finalResponse: "Done"
  })
  assert.ok(message.length <= 6000)
  assert.match(message, /untrusted claim/)
  assert.match(message, /No file edits were verified/)
})

test("a tool result that could not be recorded stays blocking for the whole request, across continuations", () => {
  const execution = new ExecutionReconciliationController({ maxIterations: 8, maxNoProgress: 2 })
  assert.equal(execution.hasUnrecordedTool, false)
  execution.markUnrecordedTool()
  assert.equal(execution.hasUnrecordedTool, true)
  assert.equal(execution.advanceAcceptedTask("next-task").continue, true)
  execution.continuationStarted()
  assert.equal(execution.hasUnrecordedTool, true, "a later continuation must not forget the unrecorded effect")
  assert.equal(execution.reconcile("revise", "retry", "criteria").continue, true)
  assert.equal(execution.hasUnrecordedTool, true)
})

test("cancellation prevents dispatching a continuation", () => {

  const controller = new ExecutionReconciliationController()
  controller.cancel()
  assert.equal(controller.reconcile("revise", "no-progress").state, "cancelled")
  assert.equal(controller.claimContinuation(), false)
})


test("a repeated runtime inventory snapshot is progress once per controller and cannot reset the no-progress budget", () => {
  const inventory = { toolName: "twinny_runtime_inventory", arguments: {}, failed: false }
  const controller = new ExecutionReconciliationController({ maxIterations: 8, maxNoProgress: 2 })
  assert.equal(controller.recordEvidence({ observations: [inventory], passedCriteria: [] }), "observations", "the first snapshot is initial context")
  assert.equal(controller.recordEvidence({ observations: [inventory], passedCriteria: [] }), "none", "the same snapshot is not new evidence")
  assert.equal(controller.reconcile("revise", "task", "observations").continue, true)
  assert.equal(controller.reconcile("revise", "task", "none").continue, true)
  const stopped = controller.reconcile("revise", "task", "none")
  assert.equal(stopped.continue, false)
  assert.match(stopped.reason ?? "", /no measurable progress for 2 consecutive turns/)
})

test("a provider failure resumes only while it keeps producing evidence, and stops on repetition", () => {
  const nonRetryable = new ExecutionReconciliationController({ maxIterations: 8, maxNoProgress: 2 })
  assert.equal(nonRetryable.providerFailed(false, "observations").continue, false)
  assert.equal(nonRetryable.state, "blocked")

  const repeated = new ExecutionReconciliationController({ maxIterations: 8, maxNoProgress: 2 })
  assert.equal(repeated.providerFailed(true, "none").continue, true)
  assert.equal(repeated.providerFailed(true, "none").continue, true)
  const stopped = repeated.providerFailed(true, "none")
  assert.equal(stopped.continue, false)
  assert.equal(stopped.state, "blocked")
  assert.match(stopped.reason ?? "", /failed 3 times in a row/)

  const bounded = new ExecutionReconciliationController({ maxIterations: 2, maxNoProgress: 2 })
  assert.equal(bounded.providerFailed(true, "observations").continue, true)
  assert.equal(bounded.providerFailed(true, "observations").continue, true)
  assert.match(bounded.providerFailed(true, "observations").reason ?? "", /exceeded 2 reconciliation iterations/)

  const reset = new ExecutionReconciliationController({ maxIterations: 8, maxNoProgress: 2 })
  assert.equal(reset.providerFailed(true, "none").continue, true)
  assert.equal(reset.providerFailed(true, "none").continue, true)
  assert.equal(reset.reconcile("revise", "next-task", "criteria").continue, true)
  assert.equal(reset.providerFailed(true, "none").continue, true)
  assert.equal(reset.providerFailed(true, "none").continue, true)
  assert.equal(reset.providerFailed(true, "none").continue, false)

  const cancelled = new ExecutionReconciliationController()
  cancelled.cancel()
  assert.equal(cancelled.providerFailed(true, "none").state, "cancelled")
})

test("an accepted task advances to the next task without accepting the overall goal", () => {
  const controller = new ExecutionReconciliationController({ maxIterations: 4, maxNoProgress: 2 })
  const advanced = controller.advanceAcceptedTask("task-1:inspection-accepted")
  assert.deepEqual(advanced, { state: "continue", continue: true })
  assert.equal(controller.claimContinuation(), true)
  controller.continuationStarted()
  assert.equal(controller.state, "executing")
  assert.equal(controller.reconcile("accept", "all-plan-tasks-verified").state, "accepted")
})


test("overall goal completion requires every nonempty intent plan task to be completed", () => {
  assert.equal(allIntentTasksComplete(["completed", "pending"]), false)
  assert.equal(allIntentTasksComplete(["completed", "in_progress"]), false)
  assert.equal(allIntentTasksComplete(["completed", "cancelled"]), false)
  assert.equal(allIntentTasksComplete(["completed", "completed"]), true)
  assert.equal(allIntentTasksComplete([]), false)
})

test("automatic continuations share one host-generated execution identity, and a new request gets its own", () => {
  const controller = new ExecutionReconciliationController()
  const executionId = controller.executionId
  assert.match(executionId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  controller.reconcile("revise", "no-edits:no-tool-success")
  assert.equal(controller.claimContinuation(), true)
  controller.continuationStarted()
  controller.reconcile("revise", "no-edits:no-tool-success")
  assert.equal(controller.executionId, executionId, "a continuation is the same logical execution")
  assert.notEqual(new ExecutionReconciliationController().executionId, executionId, "a new request is a new execution")
})

test("no eligible task is classified by why the plan cannot advance", () => {
  assert.equal(classifyUnresolvedPlan([{ status: "completed" }, { status: "cancelled" }]), "plan_complete")
  assert.equal(classifyUnresolvedPlan([{ status: "completed" }, { status: "in_review" }]), "review_pending")
  assert.equal(classifyUnresolvedPlan([{ status: "in_review" }, { status: "blocked" }]), "review_pending", "pending review outranks a blocked sibling")
  assert.equal(classifyUnresolvedPlan([{ status: "blocked" }, { status: "pending", dependenciesMet: false }]), "blocked")
  assert.equal(classifyUnresolvedPlan([{ status: "completed" }, { status: "pending", dependenciesMet: false }]), "dependency_waiting")
  assert.equal(classifyUnresolvedPlan([{ status: "pending", dependenciesMet: true }]), "no_actionable_work", "a runnable task that is not selected is a scheduling inconsistency")
  assert.equal(classifyUnresolvedPlan([{ status: "pending" }]), "no_actionable_work", "unknown dependency state is never treated as a wait")
})

test("the pause message names the reason and never claims review is a block", () => {
  const review = unresolvedPlanMessage("review_pending", [{ title: "Edit panel", status: "in_review" }])
  assert.match(review, /Review is pending for Edit panel \(in_review\)/)
  assert.doesNotMatch(review, /Blocked/)
  assert.match(unresolvedPlanMessage("dependency_waiting", [{ title: "Validate", status: "pending" }]), /prerequisites/)
  assert.match(unresolvedPlanMessage("no_actionable_work", [{ title: "Validate", status: "pending" }]), /no unmet prerequisites/)
  assert.equal(unresolvedPlanMessage("plan_complete", []), "All plan tasks are complete.")
})
