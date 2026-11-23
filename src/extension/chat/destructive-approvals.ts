import fs from "fs"
import path from "path"

export type DestructiveOperation = "remove" | "move" | "rename" | "delete-recreate"

export interface DestructiveApproval {
  operation: DestructiveOperation
  resource: string
  lifetime: "session" | "project"
  projectHome?: string
}

export interface DestructiveApprovalMemento {
  get<T>(key: string): T | undefined
  update(key: string, value: unknown): PromiseLike<void>
}

export const DESTRUCTIVE_PROJECT_APPROVALS_KEY = "twinny.destructiveProjectApprovals"

const canonical = (resource: string): string => {
  const absolute = path.resolve(resource)
  try {
    return fs.realpathSync.native(absolute)
  } catch {
    const parent = path.dirname(absolute)
    try {
      return path.join(fs.realpathSync.native(parent), path.basename(absolute))
    } catch {
      return absolute
    }
  }
}

export class DestructiveApprovalStore {
  private readonly session = new Map<string, DestructiveApproval>()
  private project: DestructiveApproval[]

  constructor(
    private readonly memento: DestructiveApprovalMemento | undefined,
    private readonly projectHome: () => string
  ) {
    const saved = memento?.get<unknown>(DESTRUCTIVE_PROJECT_APPROVALS_KEY)
    this.project = Array.isArray(saved)
      ? saved.filter((value): value is DestructiveApproval => {
          if (!value || typeof value !== "object") return false
          const item = value as Partial<DestructiveApproval>
          return (item.operation === "remove" || item.operation === "move" || item.operation === "rename" || item.operation === "delete-recreate")
            && typeof item.resource === "string"
            && typeof item.projectHome === "string"
        }).map((item) => ({ ...item, lifetime: "project" as const }))
      : []
  }

  private key(operation: DestructiveOperation, resource: string): string {
    if (operation === "move" && resource.includes("→")) {
      const [from, to] = resource.split("→", 2)
      return JSON.stringify([operation, canonical(from.trim()), canonical(to.trim())])
    }
    if (operation === "rename" && resource.includes(",")) {
      return JSON.stringify([operation, resource.split(",").map((entry) => canonical(entry.trim())).sort()])
    }
    return JSON.stringify([operation, canonical(resource)])
  }

  allows(operation: DestructiveOperation, resource: string): boolean {
    const key = this.key(operation, resource)
    if (this.session.has(key)) return true
    const home = this.projectHome()
    return this.project.some((grant) =>
      grant.projectHome === home &&
      this.key(grant.operation, grant.resource) === key
    )
  }

  async add(operation: DestructiveOperation, resource: string, lifetime: "session" | "project"): Promise<void> {
    const approval: DestructiveApproval = {
      operation,
      resource: canonical(resource),
      lifetime,
      ...(lifetime === "project" ? { projectHome: this.projectHome() } : {})
    }
    if (lifetime === "session") {
      this.session.set(this.key(operation, resource), approval)
      return
    }
    const key = this.key(operation, resource)
    if (this.project.some((grant) => grant.projectHome === approval.projectHome && this.key(grant.operation, grant.resource) === key)) return
    this.project = [...this.project, approval]
    await this.memento?.update(DESTRUCTIVE_PROJECT_APPROVALS_KEY, this.project)
  }

  async revokeProject(match: (approval: DestructiveApproval) => boolean = () => true): Promise<number> {
    const removed = this.project.filter(match)
    if (!removed.length) return 0
    this.project = this.project.filter((approval) => !removed.includes(approval))
    await this.memento?.update(DESTRUCTIVE_PROJECT_APPROVALS_KEY, this.project)
    return removed.length
  }

  projectApprovals(): DestructiveApproval[] {
    return [...this.project]
  }
}
