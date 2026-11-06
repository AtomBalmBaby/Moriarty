import type { IntentPlanOutline } from "./types"

const MAX_TASKS = 24
const clip = (value: string, limit: number) => (value.length > limit ? value.slice(0, limit - 1) + "…" : value)

/**
 * The plan Feedback synchronized, as the executor must see it on every
 * request: stable item IDs, current versions and outstanding evidence.
 */
export const renderPlanContext = (outline: IntentPlanOutline): string => {
  const lines = outline.tasks.slice(0, MAX_TASKS).map((task) => {
    const state = [task.status, `verification ${task.verification}`, `version ${task.version}`].join(", ")
    const detail = [
      ...(task.blockedReason ? [`  blocked: ${clip(task.blockedReason, 160)}`] : []),
      ...task.unmetCriteria.slice(0, 4).map((criterion) => `  needs evidence: ${clip(criterion, 180)}`),
      ...task.problems.slice(0, 2).map((problem) => `  problem: ${clip(problem, 180)}`)
    ]
    return [`- ${task.itemId} (${state}) ${clip(task.title, 180)}`, ...detail].join("\n")
  })
  const omitted = outline.tasks.length - MAX_TASKS
  return [
    `Twinny's native TODO plan for this conversation (plan ${outline.planId}, revision ${outline.revision}). These TODO items already exist.`,
    "Use twinny_todo_list and twinny_todo_get to read these items, and twinny_todo_update to change them by item_id, passing expected_version from the version above. Do not create a TODO that repeats one listed here; twinny_todo_create is only for genuinely new work, and a matching create returns the existing item (result existing_task).",
    "A task is complete only when Feedback verifies it from recorded tool results. Setting status to completed submits one completion claim that moves the task to in_review (claim accepted). Submit each claim once: in_review means it was received, so do not retry it. Continue other actionable tasks or finish this turn so Feedback can review. If Feedback rejects a claim, follow its corrective instructions instead of resubmitting an unchanged claim.",
    ...lines,
    ...(omitted > 0 ? [`… ${omitted} more task${omitted === 1 ? "" : "s"} not shown; use twinny_todo_list.`] : [])
  ].join("\n")
}
