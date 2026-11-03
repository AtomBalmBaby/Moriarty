import type { IntentTaskPlan } from "./types"

export type IntentPlanValidation = { plan?: IntentTaskPlan; diagnostic?: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const stringList = (value: unknown, minimum: number): string[] | undefined => {
  if (!Array.isArray(value) || value.length < minimum || value.some((entry) => typeof entry !== "string" || !entry.trim())) return undefined
  const normalized = value.map((entry) => (entry as string).trim())
  if (normalized.some((entry) => entry.length > 2000)) return undefined
  return normalized
}

export const validateIntentTaskPlan = (value: unknown): IntentPlanValidation => {
  if (!isRecord(value)) return { diagnostic: "Plan must be an object." }
  const { planId, version, revision, goal, constraints, tasks } = value
  if (typeof planId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(planId)) {
    return { diagnostic: "plan.planId must be a stable identifier (1-128 letters, digits, dot, underscore, colon, or dash)." }
  }
  if (version !== 1) return { diagnostic: "plan.version must be 1." }
  if (!Number.isSafeInteger(revision) || (revision as number) < 1) return { diagnostic: "plan.revision must be a positive integer and increase when the plan changes." }
  if (typeof goal !== "string" || !goal.trim() || goal.length > 4000) return { diagnostic: "plan.goal must contain 1-4,000 characters." }
  const normalizedConstraints = stringList(constraints, 0)
  if (!normalizedConstraints) return { diagnostic: "plan.constraints must be an array of non-empty strings." }
  if (!Array.isArray(tasks) || tasks.length < 1 || tasks.length > 100) return { diagnostic: "plan.tasks must contain 1-100 tasks." }

  const ids = new Set<string>()
  const normalizedTasks: IntentTaskPlan["tasks"] = []
  for (const [index, raw] of tasks.entries()) {
    const path = "plan.tasks[" + index + "]"
    if (!isRecord(raw)) return { diagnostic: path + " must be an object." }
    const { id, title, description, acceptanceCriteria, dependencies } = raw
    if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) return { diagnostic: path + ".id must be a stable identifier (1-128 letters, digits, dot, underscore, colon, or dash)." }
    if (ids.has(id)) return { diagnostic: "Duplicate task identifier: " + id + "." }
    ids.add(id)
    if (typeof title !== "string" || !title.trim() || title.length > 500) return { diagnostic: path + ".title must contain 1-500 characters." }
    if (typeof description !== "string" || !description.trim() || description.length > 8000) return { diagnostic: path + ".description must contain 1-8,000 characters." }
    const criteria = stringList(acceptanceCriteria, 1)
    if (!criteria || criteria.length > 20) return { diagnostic: path + ".acceptanceCriteria must contain 1-20 non-empty strings." }
    const taskDependencies = dependencies === undefined ? [] : stringList(dependencies, 0)
    if (!taskDependencies || taskDependencies.some((dependency) => dependency === id) || new Set(taskDependencies).size !== taskDependencies.length) return { diagnostic: path + ".dependencies must contain unique task identifiers other than itself." }
    normalizedTasks.push({ id, title: title.trim(), description: description.trim(), acceptanceCriteria: criteria, dependencies: taskDependencies })
  }

  for (const task of normalizedTasks) {
    for (const dependency of task.dependencies) {
      if (!ids.has(dependency)) return { diagnostic: "Task " + task.id + " depends on unknown task " + dependency + "." }
    }
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const byId = new Map(normalizedTasks.map((task) => [task.id, task]))
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return false
    if (visited.has(id)) return true
    visiting.add(id)
    for (const dependency of byId.get(id)?.dependencies ?? []) if (!visit(dependency)) return false
    visiting.delete(id)
    visited.add(id)
    return true
  }
  if (normalizedTasks.some((task) => !visit(task.id))) return { diagnostic: "Task dependencies must not contain cycles." }

  return { plan: { planId, version: 1, revision: revision as number, goal: goal.trim(), constraints: normalizedConstraints, tasks: normalizedTasks } }
}
