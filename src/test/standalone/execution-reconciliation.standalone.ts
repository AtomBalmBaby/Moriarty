import assert from "assert"
import test from "node:test"

import {
  allIntentTasksComplete,
  continuationContext,
  ExecutionReconciliationController,
  forbiddenDeleteReason,
  requiresWorkspaceChanges
} from "../../extension/chat/execution-reconciliation"

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
  assert.equal(requiresWorkspaceChanges("Explain how the todo panel works"), false)
  assert.equal(requiresWorkspaceChanges("Modify the todo panel to be compact"), true)
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

test("cancellation prevents dispatching a continuation", () => {
  const controller = new ExecutionReconciliationController()
  controller.cancel()
  assert.equal(controller.reconcile("revise", "no-progress").state, "cancelled")
  assert.equal(controller.claimContinuation(), false)
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
