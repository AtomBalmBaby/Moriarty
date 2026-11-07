import type { AcceptedFactStatus } from "./feedback"
import type { IntentPlanOutline, IntentPlanOutlineChild } from "./types"

const MAX_TASKS = 24
const MAX_REPORT_ITEMS = 12
export const MAX_ACCEPTED_CONTEXT_FACTS = 12
const clip = (value: string, limit: number) => (value.length > limit ? value.slice(0, limit - 1) + "…" : value)

/**
 * The authoritative status of the plan, built only from the TODO repository
 * and recorded tool operations. Model prose must not override it.
 */
export const authoritativeExecutionReport = (outline: IntentPlanOutline, failedOperations: string[]): string => {
  const tasks = outline.tasks.filter((task) => task.status !== "cancelled")
  const groups: Record<"verified" | "blocked" | "dependencies" | "review" | "rejected" | "pending", string[]> = {
    verified: [], blocked: [], dependencies: [], review: [], rejected: [], pending: []
  }
  for (const task of tasks) {
    const label = `${task.itemId} ${clip(task.title, 120)}`
    if (task.status === "completed") groups.verified.push(label)
    else if (task.status === "blocked") groups.blocked.push(`${label}${task.blockedReason ? `: ${clip(task.blockedReason, 160)}` : ""}`)
    else if (task.status === "in_review" && task.awaitingDependencies.length) groups.dependencies.push(`${label} (waiting on ${task.awaitingDependencies.slice(0, 3).join(", ")})`)
    else if (task.status === "in_review") groups.review.push(label)
    else if (task.problems.length || task.unmetCriteria.length) groups.rejected.push(`${label}: ${clip(task.problems[0] ?? task.unmetCriteria[0], 160)}`)
    else groups.pending.push(label)
  }
  const section = (name: string, values: string[]) => `${name} (${values.length}):${values.slice(0, MAX_REPORT_ITEMS).map((value) => `\n- ${value}`).join("") || " none"}`
  return [
    `Authoritative TODO status for plan ${outline.planId} (revision ${outline.revision}). This overrides any progress claimed in the reply above.`,
    section("Verified complete", groups.verified),
    section("Awaiting dependencies", groups.dependencies),
    section("Awaiting Feedback review", groups.review),
    section("Feedback rejected", groups.rejected),
    section("Failed or blocked", groups.blocked),
    section("Not yet verified", groups.pending),
    section("Failed tool operations", failedOperations),
    failedOperations.length ? "Failed tool operations are recorded above and were not recovered by a later successful run unless stated." : "No failed tool operations are recorded."
  ].join("\n")
}

/**
 * The plan Feedback synchronized, as the executor must see it on every
 * request: stable item IDs, current versions and outstanding evidence.
 */
/**
 * Current accepted facts the host already verified for this conversation.
 * Historical facts are left out here; twinny_evidence_lookup returns them with their reasons.
 */
const renderAcceptedEvidence = (accepted: AcceptedFactStatus[]): string[] => {
  const current = accepted.filter(({ fact, freshness }) => freshness === "current" && !fact.supersededBy)
  if (!current.length) return []
  return [
    "Accepted host evidence (the host verified these against the current source). Do not search or read for these facts again. When a task's criteria are these facts, submit its completion claim citing the observation IDs.",
    ...current.slice(0, MAX_ACCEPTED_CONTEXT_FACTS).map(({ fact }) =>
      `- ${fact.symbol} (${fact.toolName}) ${fact.path} lines ${fact.startLine}-${fact.endLine}, observation ${fact.observationId}, task ${fact.itemId}`),
    ...(current.length > MAX_ACCEPTED_CONTEXT_FACTS ? [`… ${current.length - MAX_ACCEPTED_CONTEXT_FACTS} more accepted fact(s); use twinny_evidence_lookup.`] : [])
  ]
}

export const renderPlanContext = (outline: IntentPlanOutline, accepted: AcceptedFactStatus[] = []): string => {
  const lines = outline.tasks.slice(0, MAX_TASKS).map((task) => {
    const state = [task.status, `verification ${task.verification}`, `version ${task.version}`].join(", ")
    const detail = [
      ...(task.blockedReason ? [`  blocked: ${clip(task.blockedReason, 160)}`] : []),
      ...task.unmetCriteria.slice(0, 4).map((criterion) => `  needs evidence: ${clip(criterion, 180)}`),
      ...task.problems.slice(0, 2).map((problem) => `  problem: ${clip(problem, 180)}`)
    ]
    return [`- ${task.itemId} (${state}) ${clip(task.title, 180)}`, ...detail, ...renderChildren(task.itemId, outline.children, 1, new Set([task.itemId]))].join("\n")
  })
  const omitted = outline.tasks.length - MAX_TASKS
  return [
    `Twinny's native TODO plan for this conversation (plan ${outline.planId}, revision ${outline.revision}). These TODO items already exist.`,
    "Use twinny_todo_list and twinny_todo_get to read these items, and twinny_todo_update to change them by item_id, passing expected_version from the version above. Do not create a TODO that repeats one listed here. To add genuinely new work under a listed TODO, call twinny_todo_create with todo_parent_id set to that item, plus details and reason; Feedback decides whether it is created, and a matching or rejected result is the decision to follow.",
    "A task is complete only when Feedback verifies it from recorded tool results. Setting status to completed submits one completion claim that moves the task to in_review (claim accepted). Submit each claim once: in_review means it was received, so do not retry it. Continue other actionable tasks or finish this turn so Feedback can review. If Feedback rejects a claim, follow its corrective instructions instead of resubmitting an unchanged claim.",
    "For a source-investigation task: search for the exact symbol or registration signature first, then read one substantial range around the match (about 150-250 lines, more if the definition needs it) rather than many small overlapping reads. Check the accepted host evidence above before searching. Once the facts are established, submit one completion claim that cites the observation IDs, then stop; do not write lengthy prose in place of evidence. Twinny records observations and TODO state itself, so do not create TODO entries to document or report this work.",
    ...renderAcceptedEvidence(accepted),
    ...lines,
    ...(omitted > 0 ? [`… ${omitted} more task${omitted === 1 ? "" : "s"} not shown; use twinny_todo_list.`] : [])
  ].join("\n")
}

const MAX_CHILDREN_PER_PARENT = 8

/** Child TODOs under one parent, indented by depth. `seen` stops a malformed cycle from recursing forever. */
const renderChildren = (parentItemId: string, children: IntentPlanOutlineChild[], depth: number, seen: Set<string>): string[] =>
  children
    .filter((child) => child.parentItemId === parentItemId)
    .slice(0, MAX_CHILDREN_PER_PARENT)
    .flatMap((child) => {
      if (seen.has(child.itemId)) return []
      seen.add(child.itemId)
      return [
        `${"  ".repeat(depth)}- child ${child.itemId} (${child.status}) ${clip(child.title, 180)}`,
        ...renderChildren(child.itemId, children, depth + 1, seen)
      ]
    })
