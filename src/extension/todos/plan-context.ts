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
    "Update them by item_id with twinny_todo_update, passing expected_version from the version above. Do not create a TODO that repeats one listed here; twinny_todo_create is only for newly discovered work.",
    "A task is complete only when its needed evidence is recorded from real tool results. Setting status to completed moves it to in_review for Feedback to check.",
    ...lines,
    ...(omitted > 0 ? [`… ${omitted} more task${omitted === 1 ? "" : "s"} not shown; use twinny_todo_list.`] : [])
  ].join("\n")
}
