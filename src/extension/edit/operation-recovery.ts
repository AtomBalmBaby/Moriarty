import { TextDecoder } from "node:util"
import * as vscode from "vscode"

import { editDigest, TodoRepository } from "../todos/repository"
import type { TodoListRequest, UnresolvedEditOperation } from "../todos/types"

export type EditOperationRecoveryInspection = {
  operation: UnresolvedEditOperation
  diskHash?: string
  editorHash?: string
  state: "pre" | "post" | "diverged" | "missing" | "inconsistent"
}

export class EditOperationRecoveryHost {
  constructor(
    private readonly repository: TodoRepository,
    private readonly root: string
  ) {}

  async list(scope: TodoListRequest): Promise<UnresolvedEditOperation[]> {
    return this.repository.listUnresolvedEditOperations(scope)
  }

  async inspect(operation: UnresolvedEditOperation): Promise<EditOperationRecoveryInspection> {
    const absolute = vscode.Uri.joinPath(vscode.Uri.file(this.root), operation.target)
    let diskText: string | undefined
    let editorText: string | undefined
    try {
      diskText = new TextDecoder("utf-8", { fatal: true }).decode(await vscode.workspace.fs.readFile(absolute))
    } catch {
      diskText = undefined
    }
    try {
      editorText = (await vscode.workspace.openTextDocument(absolute)).getText()
    } catch {
      editorText = undefined
    }
    const diskHash = diskText === undefined ? undefined : editDigest(diskText)
    const editorHash = editorText === undefined ? undefined : editDigest(editorText)
    if (diskText === undefined) {
      return { operation, diskHash, editorHash, state: editorText === undefined ? "missing" : "inconsistent" }
    }
    if (editorText !== undefined && editorText.replace(/\r\n/g, "\n") !== diskText.replace(/\r\n/g, "\n")) {
      return { operation, diskHash, editorHash, state: "inconsistent" }
    }
    if (diskHash === operation.postDigest) return { operation, diskHash, editorHash, state: "post" }
    if (diskHash === operation.preDigest) return { operation, diskHash, editorHash, state: "pre" }
    return { operation, diskHash, editorHash, state: "diverged" }
  }

  async reconcile(scope: TodoListRequest, operation: UnresolvedEditOperation): Promise<{ ok: boolean; message: string }> {
    if (operation.ownerLiveness === "live") {
      return { ok: false, message: `Operation ${operation.id} is owned by a live heartbeat; it was not taken over.` }
    }
    const inspected = await this.inspect(operation)
    if (inspected.state === "post") {
      const settled = await this.repository.settleProjectEditOperation(
        scope,
        operation.id,
        operation.status,
        "reconciled_applied",
        "Verified reconciliation: the authoritative disk and editor state match the operation's intended digest."
      )
      return { ok: settled, message: settled ? `Operation ${operation.id} finalized as reconciled_applied.` : `Operation ${operation.id} was changed concurrently and was not reconciled twice.` }
    }
    if (inspected.state === "pre" && operation.ownerLiveness === "abandoned") {
      const settled = await this.repository.settleProjectEditOperation(
        scope,
        operation.id,
        operation.status,
        "reconciled_absent",
        "Verified reconciliation: a definitively terminated owner left the authoritative state at the pre-edit digest."
      )
      return { ok: settled, message: settled ? `Operation ${operation.id} finalized as reconciled_absent.` : `Operation ${operation.id} was changed concurrently and was not reconciled twice.` }
    }
    const detail = inspected.state === "inconsistent"
      ? "Verified recovery found different editor and disk states; the operation remains unresolved."
      : inspected.state === "missing"
        ? "Verified recovery found the target missing; the operation remains unresolved."
        : "Verified recovery found neither the pre-edit nor intended digest; the operation remains unresolved."
    const settled = await this.repository.settleProjectEditOperation(scope, operation.id, operation.status, "diverged", detail)
    return { ok: settled, message: settled ? detail : `Operation ${operation.id} was changed concurrently; reread the recovery list.` }
  }

  async supersede(scope: TodoListRequest, operation: UnresolvedEditOperation, reason: string): Promise<{ ok: boolean; message: string }> {
    if (operation.ownerLiveness === "live") {
      return { ok: false, message: `Operation ${operation.id} has a live owner and cannot be superseded.` }
    }
    const inspected = await this.inspect(operation)
    const applied = inspected.state === "post"
    const decision = applied ? "reconciled_applied" : "reconciled_absent"
    const decisionReason = applied
      ? `${reason.trim()} Verified digest matches the intended state; this supersession records final reconciliation, not replay.`
      : `${reason.trim()} Historical operation superseded; the original mutation is not inferred from the current file.`
    const settled = await this.repository.supersedeProjectEditOperation(
      scope,
      operation.id,
      operation.status,
      decision,
      decisionReason,
      "Explicit VS Code recovery command; user-confirmed supersession"
    )
    return { ok: settled, message: settled
      ? `Operation ${operation.id} superseded as ${decision}. Historical detail and recovery provenance were retained.`
      : `Operation ${operation.id} could not be superseded because it changed or is now live.` }
  }

  async show(scope: TodoListRequest): Promise<void> {
    const operations = await this.list(scope)
    if (!operations.length) {
      await vscode.window.showInformationMessage("Twinny: no unresolved edit operations block this project.")
      return
    }
    const picked = await vscode.window.showQuickPick(operations.map((operation) => {
      const liveness = operation.ownerLiveness === "live"
        ? "live"
        : operation.ownerLiveness === "abandoned"
          ? "abandoned"
          : "uncertain"
      return {
        label: `${operation.target} — ${operation.status}`,
        description: `${operation.id} · owner ${liveness}`,
        detail: `${operation.detail || "No reconciliation detail."}\nPre ${operation.preDigest}\nPost ${operation.postDigest}`,
        operation
      }
    }), { title: "Twinny unresolved edit operations", placeHolder: "Select an operation to inspect" })
    if (!picked) return
    const action = await vscode.window.showQuickPick([
      { label: "$(refresh) Attempt verified reconciliation", detail: "Only settle from actual pre/post evidence or preserve divergence.", action: "reconcile" },
      { label: "$(close) Explicitly supersede/abandon", detail: "Requires user confirmation and a reason; never claims an unproved mutation.", action: "supersede" }
    ], { title: `Recover ${picked.operation.id}`, placeHolder: "Choose a recovery action" })
    if (!action) return
    if (action.action === "reconcile") {
      const result = await this.reconcile(scope, picked.operation)
      await vscode.window.showInformationMessage(result.message)
      return
    }
    if (picked.operation.ownerLiveness === "live") {
      await vscode.window.showWarningMessage(`Operation ${picked.operation.id} has a live owner and was not superseded.`)
      return
    }
    const confirmed = await vscode.window.showQuickPick([
      { label: "Yes, supersede this inactive/uncertain operation", detail: "Do not infer success. Keep the historical record and recovery event.", confirmed: true },
      { label: "Cancel", confirmed: false }
    ], { title: "Confirm edit-operation supersession", placeHolder: "This removes the operation's authority to block future edits" })
    if (!confirmed?.confirmed) return
    const reason = await vscode.window.showInputBox({
      title: "Recovery reason",
      prompt: "Record why this operation is safe to supersede",
      placeHolder: "Example: the original host terminated and the current file has been committed",
      ignoreFocusOut: true,
      validateInput: (value) => value.trim().length ? undefined : "A recovery reason is required."
    })
    if (!reason?.trim()) return
    const result = await this.supersede(scope, picked.operation, reason)
    await vscode.window.showInformationMessage(result.message)
  }
}
