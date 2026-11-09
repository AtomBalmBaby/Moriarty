import type { CriterionVerification, CriterionVerificationKind, SourceIdentity, TypedCriterion } from "../../common/types"

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

const CRITERION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
const SYMBOL = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

const hasOnlyKeys = (record: Record<string, unknown>, allowed: readonly string[]): string | undefined =>
  Object.keys(record).find((key) => !allowed.includes(key))

/** A repository-relative path: no absolute roots, no parent traversal, no empty segments. */
const repositoryPath = (value: unknown): string | undefined => {
  if (typeof value !== "string" || value.length < 1 || value.length > 500) return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.startsWith("/") || trimmed.includes("\\") || /^[A-Za-z]:/.test(trimmed)) return undefined
  const segments = trimmed.split("/")
  return segments.some((segment) => !segment || segment === "." || segment === "..") ? undefined : trimmed
}

const CRITERION_FIELDS: Record<TypedCriterion["verification"]["kind"], readonly string[]> = {
  evidence_lookup_completed: ["kind"],
  accepted_fact_exists: ["kind", "identity", "symbol", "path"],
  source_location: ["kind", "identity", "symbol", "path"],
  source_range: ["kind", "identity", "symbol", "path"],
  source_fingerprint: ["kind", "identity", "symbol", "path"],
  execution_invariant: ["kind", "invariant"],
  workspace_mutation: ["kind", "operation"],
  command_exit_status: ["kind", "command", "exitCode", "scope", "execution"],
  semantic_review: ["kind"]
}

/** Validates one typed verification descriptor. Required fields and allowed values are checked; wording is never interpreted. */
const verificationOf = (value: unknown, path: string): { verification?: CriterionVerification; diagnostic?: string } => {
  if (!isRecord(value)) return { diagnostic: path + " must be an object." }
  const declared = value.kind
  const kind = typeof declared === "string" && Object.prototype.hasOwnProperty.call(CRITERION_FIELDS, declared) ? declared as CriterionVerificationKind : undefined
  if (!kind) {
    return { diagnostic: path + ".kind must be one of " + Object.keys(CRITERION_FIELDS).join(", ") + "." }
  }
  const unknownField = hasOnlyKeys(value, CRITERION_FIELDS[kind])
  if (unknownField) return { diagnostic: path + " has unsupported field " + unknownField + " for kind " + kind + "." }
  const symbolOf = (): string | undefined => typeof value.symbol === "string" && SYMBOL.test(value.symbol) ? value.symbol : undefined
  const identityOf = (): SourceIdentity | undefined => value.identity === "registered_tool" || value.identity === "implementation_symbol" ? value.identity : undefined
  switch (kind) {
    case "evidence_lookup_completed":
    case "semantic_review":
      return { verification: { kind } as CriterionVerification }
    case "accepted_fact_exists": {
      const identity = identityOf()
      if (!identity) return { diagnostic: path + ".identity must be registered_tool or implementation_symbol." }
      const symbol = symbolOf()
      if (!symbol) return { diagnostic: path + ".symbol must be a source identifier." }
      if (value.path === undefined) return { verification: { kind, identity, symbol } }
      const filePath = repositoryPath(value.path)
      return filePath ? { verification: { kind, identity, symbol, path: filePath } } : { diagnostic: path + ".path must be a repository-relative path." }
    }
    case "source_location":
    case "source_range":
    case "source_fingerprint": {
      const identity = identityOf()
      if (!identity) return { diagnostic: path + ".identity must be registered_tool or implementation_symbol." }
      const symbol = symbolOf()
      if (!symbol) return { diagnostic: path + ".symbol must be a source identifier." }
      const filePath = repositoryPath(value.path)
      if (!filePath) return { diagnostic: path + ".path must be a repository-relative path." }
      return { verification: { kind, identity, symbol, path: filePath } as CriterionVerification }
    }
    case "execution_invariant":
      if (value.invariant !== "no_mutating_tool_calls") return { diagnostic: path + ".invariant must be no_mutating_tool_calls." }
      return { verification: { kind, invariant: value.invariant } }
    case "workspace_mutation": {
      if (value.operation === undefined) return { verification: { kind } }
      if (value.operation !== "create" && value.operation !== "edit" && value.operation !== "delete") return { diagnostic: path + ".operation must be create, edit, or delete." }
      return { verification: { kind, operation: value.operation } }
    }
    case "command_exit_status": {
      const command = typeof value.command === "string" && value.command.trim() && value.command.length <= 500 ? value.command.trim() : undefined
      if (!command) return { diagnostic: path + ".command must be a non-empty command of at most 500 characters." }
      const exitCode = value.exitCode
      if (typeof exitCode !== "number" || !Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) return { diagnostic: path + ".exitCode must be an integer from 0 to 255." }
      if (value.scope !== undefined && value.scope !== "current" && value.scope !== "historical") return { diagnostic: path + ".scope must be current or historical when present." }
      if (value.execution !== undefined && value.execution !== "recorded" && value.execution !== "after_activation") return { diagnostic: path + ".execution must be recorded or after_activation when present." }
      if (value.scope === "historical" && value.execution === "after_activation") return { diagnostic: path + " cannot be both historical and after_activation; a historical diagnostic does not require a new run." }
      return {
        verification: {
          kind,
          command,
          exitCode,
          ...(value.scope === undefined ? {} : { scope: value.scope }),
          ...(value.execution === undefined ? {} : { execution: value.execution })
        }
      }
    }
  }
  return { diagnostic: path + ".kind is not supported." }
}

/** Validates the typed criteria of one task. Identifiers must be unique and every descriptor must be well-formed. */
const typedCriteriaOf = (value: unknown, path: string): { criteria?: TypedCriterion[]; diagnostic?: string } => {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) return { diagnostic: path + ".criteria must contain 1-20 typed criteria." }
  const ids = new Set<string>()
  const criteria: TypedCriterion[] = []
  for (const [index, raw] of value.entries()) {
    const at = path + ".criteria[" + index + "]"
    if (!isRecord(raw)) return { diagnostic: at + " must be an object." }
    const unknownField = hasOnlyKeys(raw, ["id", "description", "verification"])
    if (unknownField) return { diagnostic: at + " has unsupported field " + unknownField + "." }
    const { id, description, verification } = raw
    if (typeof id !== "string" || !CRITERION_ID.test(id)) return { diagnostic: at + ".id must be a stable identifier (1-64 letters, digits, dot, underscore, colon, or dash)." }
    if (ids.has(id)) return { diagnostic: "Duplicate criterion identifier " + id + " in " + path + "." }
    ids.add(id)
    if (typeof description !== "string" || !description.trim() || description.length > 2000) return { diagnostic: at + ".description must contain 1-2,000 characters." }
    const result = verificationOf(verification, at + ".verification")
    if (!result.verification) return { diagnostic: result.diagnostic }
    criteria.push({ id, description: description.trim(), verification: result.verification })
  }
  return { criteria }
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
    const { id, title, description, acceptanceCriteria, criteria: typedCriteria, dependencies } = raw
    if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) return { diagnostic: path + ".id must be a stable identifier (1-128 letters, digits, dot, underscore, colon, or dash)." }
    if (ids.has(id)) return { diagnostic: "Duplicate task identifier: " + id + "." }
    ids.add(id)
    if (typeof title !== "string" || !title.trim() || title.length > 500) return { diagnostic: path + ".title must contain 1-500 characters." }
    if (typeof description !== "string" || !description.trim() || description.length > 8000) return { diagnostic: path + ".description must contain 1-8,000 characters." }
    if (acceptanceCriteria !== undefined) {
      return { diagnostic: path + ".acceptanceCriteria is no longer accepted; give typed criteria as criteria[] with a stable id, a description, and a verification descriptor." }
    }
    const result = typedCriteriaOf(typedCriteria, path)
    if (!result.criteria) return { diagnostic: result.diagnostic }
    const taskDependencies = dependencies === undefined ? [] : stringList(dependencies, 0)
    if (!taskDependencies || taskDependencies.some((dependency) => dependency === id) || new Set(taskDependencies).size !== taskDependencies.length) return { diagnostic: path + ".dependencies must contain unique task identifiers other than itself." }
    normalizedTasks.push({ id, title: title.trim(), description: description.trim(), criteria: result.criteria, dependencies: taskDependencies })
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
