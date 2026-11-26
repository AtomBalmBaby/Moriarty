/**
 * What the chat's tools reach in the editor: edits go through the inline
 * edit service, commands run in the background (or a terminal of their
 * own, as the user set), `search_code`
 * asks the embeddings index, and the language servers answer for errors,
 * references and renames. The tools themselves (`tools/workspace.ts`)
 * know none of this, so they run headless in tests and the eval.
 *
 * Edits apply straight away or wait for review, as the user set. A few
 * things wait for the user whatever the setting, because undo would not
 * bring them back or because they widen what the model may do: deleting a
 * file git has no copy of, and changing `.vscode/` or a `.gitignore`.
 */
import { ChildProcess, execFile, spawn } from "child_process"
import { randomUUID } from "crypto"
import { existsSync, readFileSync } from "fs"
import path from "path"
import {
  commands,
  Diagnostic,
  DiagnosticSeverity,
  languages,
  Location,
  LocationLink,
  Position,
  Range,
  Terminal,
  TerminalShellIntegration,
  Uri,
  window,
  workspace,
  WorkspaceEdit
} from "vscode"

import {
  DEFAULT_RERANK_THRESHOLD,
  DEFAULT_WORKSPACE_HIT_CHARS,
  TWINNY,
  TWINNY_COMMAND_NAME
} from "../../common/constants"
import { logger } from "../../common/logger"
import { EditorVisibility, revealEditor, UNSAVED_REQUIRES_VISIBLE } from "../edit/line-edit"
import { type ChatEditMode, type ChatEditOutcome, preauthorizedNow } from "../edit/service"
import { WorkspaceSearch } from "../embeddings/search"
import { stripAnsi, tailOutput } from "../terminal/output"
import { editDigest } from "../todos/repository"
import type { EditOperationInput } from "../todos/types"
import { currentAccessHostKey } from "../tools/access-host"
import type { Replacement } from "../tools/edit"
import { isProtectedPath } from "../tools/helpers"
import { changedSpan, contentHash, LineEditError, lineEditFailure, patchedText, planLineEdits } from "../tools/line-edit"
import { EditorDiagnostic, EditorLocation, EditorSink, FileOpsSink } from "../tools/more"
import { claimWrites, coversWrites, type OperationAuthorization, type WriteOperation, type WriteRequest } from "../tools/operation-authorization"
import { linesOf, WorkspaceView } from "../tools/view"
import { CodeSearch, CommandOutcome, CommandSink, EditOutcome, EditSink, IndexChange, IndexRefreshOutcome } from "../tools/workspace"

import { changesBetween, MAX_COMMAND_CHANGES, snapshotTree, TreeSnapshot } from "./command-snapshot"
import { forbiddenDeleteReason } from "./execution-reconciliation"
import { ReplyChanges } from "./reply-changes"
import {
  CheckpointFile,
  createDiagnosticObserver,
  DiagnosticObservation,
  DiagnosticRegressionMonitor,
  DiagnosticVerificationStatus,
  SafeEditCheckpoints
} from "./safe-edit-recovery"

export interface EditRecoveryNotice {
  file: string
  introducedErrors: number
  diagnostics: string
  restored: boolean
  fileVerified: boolean
  diagnosticsVerified: boolean
  diagnosticsStatus: DiagnosticVerificationStatus
  reason: string
}

/** Runs an editor command. The default is VS Code's own command boundary. */
export type EditCommandRunner = <T>(command: string, ...args: unknown[]) => PromiseLike<T | undefined>

/** Settles one recorded edit operation; a settlement that loses to reconciliation is a no-op. */
export interface EditOperationTicket {
  settle(status: "succeeded" | "failed" | "reconciled_applied" | "reconciled_absent" | "diverged", detail: string): Promise<void>
}

/** Records a consequential edit before it is dispatched, and throws when the record cannot be written. */
export type EditOperationLedger = (operation: Omit<EditOperationInput, "itemId" | "ownerId">) => Promise<EditOperationTicket | undefined>

const editOperationsInFlight = new Set<string>()

/** Whether this host still has the edit's command running, so its outcome cannot yet be read from the buffer. */
export const isEditOperationInFlight = (id: string) => editOperationsInFlight.has(id)

/** The document text an applied replacement leaves, with the editor's inclusive line range. */
const replacedText = ({ startLine, endLine, text }: Replacement, before: string) => {
  const lines = before.replace(/\r\n/g, "\n").split("\n")
  return [...lines.slice(0, startLine), ...(text ? text.split("\n") : []), ...lines.slice(endLine + 1)].join("\n")
}

/** The precondition digest of a create: the file does not exist yet. It is not hex, so no content digest can equal it. */
export const ABSENT_DIGEST = "absent"

/** Whether the target still holds the state the operation was recorded against; an unreadable target does not. */
const holdsPrecondition = async (target: { file: string; preDigest: string }): Promise<boolean> => {
  if (target.preDigest === ABSENT_DIGEST) return !existsSync(target.file)
  try {
    return editDigest((await workspace.openTextDocument(Uri.file(target.file))).getText()) === target.preDigest
  } catch {
    return false
  }
}

export interface EditSafetyOptions {
  goal?: string
  runEditCommand?: EditCommandRunner
  recordEditOperation?: EditOperationLedger
  checkpoints?: SafeEditCheckpoints
  errorSpikeThreshold?: number
  cumulativeErrorThreshold?: number
  diagnosticMonitor?: DiagnosticRegressionMonitor
  onCatastrophic?(notice: EditRecoveryNotice): Promise<void> | void
  /** Tells the workspace index about the files this call just saved, before the change is reported. */
  refreshIndex?: (changes: readonly IndexChange[]) => Promise<IndexRefreshOutcome>
  mutations?: Map<string, boolean>
  canMutate?(file?: string): boolean
  blockMutations?(files: string[], reconcileOnFreshBaseline: boolean): void
  clearMutations?(files: string[]): void
  reconcileMutations?(files: string[]): void
}

export const createSafeEditCheckpoints = (storageUri: Uri): SafeEditCheckpoints => {
  const metadataUri = Uri.joinPath(storageUri, "active-execution-edit-checkpoint.json")
  const readSnapshot = async (file: string): Promise<string | null | undefined> => {
    const document = workspace.textDocuments.find((entry) => entry.uri.scheme === "file" && entry.uri.fsPath === file)
    let disk: string | null = null
    let diskBase64: string | undefined
    if (existsSync(file)) {
      const contents = readFileSync(file)
      if (contents.length > 1024 * 1024 || (contents.includes(0) && (!document || document.getText().includes("\0")))) return undefined
      disk = contents.toString("utf8")
      // Keep non-UTF-8 bytes intact when restoring the disk beneath a dirty buffer.
      if (!Buffer.from(disk, "utf8").equals(contents)) diskBase64 = contents.toString("base64")
    }
    const buffer = document?.getText() ?? disk
    if (buffer === null && disk === null && !document) return null
    if (buffer !== null && buffer !== undefined && Buffer.byteLength(buffer, "utf8") > 1024 * 1024) return undefined
    return JSON.stringify({ version: 1, buffer, disk, diskBase64, dirty: !!document?.isDirty })
  }

  return new SafeEditCheckpoints({
    read: readSnapshot,
    restore: async (files: CheckpointFile[]) => {
      const edit = new WorkspaceEdit()
      const restoreAfter: Array<{ uri: Uri; path: string; snapshot: { buffer: string | null; disk: string | null; diskBase64?: string; dirty: boolean } }> = []
      for (const checkpoint of files) {
        const uri = Uri.file(checkpoint.path)
        const current = await readSnapshot(checkpoint.path)
        if (current === undefined) return false
        if (checkpoint.before === null) {
          if (current !== null) edit.deleteFile(uri, { ignoreIfNotExists: true })
          continue
        }
        let snapshot: { version: number; buffer: string | null; disk: string | null; diskBase64?: string; dirty: boolean }
        try {
          snapshot = JSON.parse(checkpoint.before)
        } catch {
          return false
        }
        if ((snapshot.diskBase64 !== undefined && typeof snapshot.diskBase64 !== "string") || snapshot.version !== 1 || (snapshot.buffer !== null && typeof snapshot.buffer !== "string") || (snapshot.disk !== null && typeof snapshot.disk !== "string") || typeof snapshot.dirty !== "boolean") return false
        const text = snapshot.buffer ?? snapshot.disk
        if (text === null) {
          if (current !== null) edit.deleteFile(uri, { ignoreIfNotExists: true })
          restoreAfter.push({ uri, path: checkpoint.path, snapshot })
          continue
        }
        if (current === null) {
          edit.createFile(uri, { contents: Buffer.from(text, "utf8"), ignoreIfExists: false })
        } else {
          const document = await workspace.openTextDocument(uri)
          edit.replace(uri, new Range(document.positionAt(0), document.positionAt(document.getText().length)), text)
        }
        restoreAfter.push({ uri, path: checkpoint.path, snapshot })
      }
      if (!(await workspace.applyEdit(edit))) return false
      for (const { uri, path, snapshot } of restoreAfter) {
        if (snapshot.disk === null) {
          if (existsSync(path)) await workspace.fs.delete(uri, { useTrash: false })
          continue
        }
        if (snapshot.dirty) {
          await workspace.fs.writeFile(uri, snapshot.diskBase64 ? Buffer.from(snapshot.diskBase64, "base64") : Buffer.from(snapshot.disk, "utf8"))
          continue
        }
        const document = workspace.textDocuments.find((entry) => entry.uri.toString() === uri.toString())
        if (document?.isDirty && !(await document.save())) return false
      }
      return true
    },
    persist: async (files) => {
      const data = Buffer.from(JSON.stringify({ version: 1, files }), "utf8")
      if (data.length > 5 * 1024 * 1024) throw new Error("Safe edit recovery metadata exceeded its storage limit.")
      await workspace.fs.createDirectory(storageUri)
      await workspace.fs.writeFile(metadataUri, data)
    },
    clear: async () => {
      await workspace.fs.createDirectory(storageUri)
      await workspace.fs.writeFile(metadataUri, Buffer.from(JSON.stringify({ version: 1, files: [] }), "utf8"))
    }
  })
}

export type ChatCommandMode = "ask" | "allow" | "off"
/** Where the model's commands run: a process of their own, or the twinny tools terminal. */
export type ChatCommandPlace = "background" | "terminal"

/** How long a command may run before the model is given what it has so far. */
const COMMAND_TIMEOUT_MS = 120_000
/** How long a new terminal gets to report shell integration. */
const INTEGRATION_WAIT_MS = 4000
const OUTPUT_TAIL = { maxChars: 4000, maxLines: 80 }
const MAX_CAPTURE_CHARS = 200_000
const SEARCH_HITS = 6
const SEARCH_CHARS = 8000

/** Asks the user to approve something in the chat's tool steps; true to go ahead. */
export type ApproveChange = (
  detail: string,
  approval: "command" | "change",
  options?: { operation?: "remove" | "move" | "rename" | "delete-recreate"; resource?: string }
) => Promise<boolean>

/** A file as the editor has it when it is open there, unsaved changes included. */
export const openDocumentText = async (file: string): Promise<string | undefined> =>
  // Only the file itself: a diff view holds another version of it under
  // the same path with a different scheme.
  workspace.textDocuments.find((document) => document.uri.scheme === "file" && document.uri.fsPath === file)?.getText()

/** The editor document's version when the file is open there, undefined otherwise. A recorded read
 * uses it to say whether its text came from the buffer or from the saved file.
 */
export const openDocumentVersion = (file: string): number | undefined =>
  workspace.textDocuments.find((document) => document.uri.scheme === "file" && document.uri.fsPath === file)?.version

/** The saved file as the index sees it: read back from disk, decoded as UTF-8 with the byte-order mark stripped. Undefined when it cannot be read. */
const savedFileText = (file: string): string | undefined => {
  try {
    const text = readFileSync(file).toString("utf8")
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  } catch {
    return undefined
  }
}

/** Apply a workspace edit and save what it touched, so later reads and searches of the disk agree. */
const applyAndSave = async (edit: WorkspaceEdit): Promise<boolean> => {
  if (!(await workspace.applyEdit(edit))) return false
  for (const [uri] of edit.entries()) {
    const document = workspace.textDocuments.find((d) => d.uri.toString() === uri.toString())
    if (document?.isDirty) await document.save()
  }
  return true
}

/**
 * The index is caught up with what a call changed, each path with what happened to it.
 * A refresh that throws is a failed refresh, not a failed change, and is reported as the model's to read.
 */
const refreshed = async (
  view: WorkspaceView,
  safety: EditSafetyOptions,
  changes: readonly IndexChange[],
  outcome: EditOutcome
): Promise<EditOutcome> => {
  if (!safety.refreshIndex) return outcome
  let indexRefresh: IndexRefreshOutcome
  try {
    indexRefresh = await safety.refreshIndex(changes)
  } catch (error) {
    indexRefresh = { status: "failed", reason: error instanceof Error ? error.message : String(error) }
  }
  if (indexRefresh.status === "failed")
    logger.warn(`Index refresh failed for ${changes.map((change) => view.relative(change.path)).join(", ")}: ${indexRefresh.reason}`)
  return outcome.ok ? { ...outcome, indexRefresh } : outcome
}

const gitSays = (cwd: string, args: string[]) =>
  new Promise<boolean>((resolve) => {
    execFile("git", args, { cwd, timeout: 5000 }, (error) => resolve(!error))
  })

/**
 * How git lists a tracked file: `H` as usual; lowercase when marked
 * assume-unchanged and `S` for skip-worktree, where git no longer looks
 * at the file and so cannot say whether it changed.
 */
const gitTag = (cwd: string, file: string) =>
  new Promise<string>((resolve) => {
    execFile("git", ["ls-files", "-v", "--", file], { cwd, timeout: 5000 }, (error, stdout) =>
      resolve(error ? "" : stdout.charAt(0))
    )
  })

/** Whether git could give the file back exactly as it is: tracked, unchanged since the last commit, nothing unsaved. */
const recoverableFromGit = async (file: string): Promise<boolean> => {
  if (workspace.textDocuments.some((d) => d.uri.scheme === "file" && d.uri.fsPath === file && d.isDirty)) return false
  const cwd = path.dirname(file)
  return (
    (await gitSays(cwd, ["ls-files", "--error-unmatch", "--", file])) &&
    (await gitTag(cwd, file)) === "H" &&
    (await gitSays(cwd, ["diff", "--quiet", "HEAD", "--", file]))
  )
}

/** Errors named after an edit; any more are counted. */
const MAX_NEW_ERRORS = 5
/** Languages with no checker to wait for, and the file names that are one before the file exists. */
const UNCHECKED_LANGUAGES = new Set(["plaintext", "markdown", "log", "ignore"])
const UNCHECKED_FILES = /\.(md|markdown|txt|log|csv)$|(^|[\\/])\.\w*ignore$/i

const errorsIn = (uri: Uri) =>
  languages.getDiagnostics(uri).filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.Error)

const diagnosticObserver = (uri: Uri) =>
  createDiagnosticObserver(
    {
      currentVersion: () => workspace.textDocuments.find((document) => document.uri.toString() === uri.toString())?.version,
      errors: () => errorsIn(uri).map((diagnostic) => diagnostic.message),
      onChange: (listener) =>
        languages.onDidChangeDiagnostics((event) => {
          if (event.uris.some((changed) => changed.toString() === uri.toString())) listener()
        })
    },
    DIAGNOSTICS_QUIET_MS,
    DIAGNOSTICS_MAX_MS
  )
/** The lines a replacement leaves in their place, 0-based in the new text; none for a deletion. */
const changedLines = ({ startLine, text }: Replacement) =>
  text ? { start: startLine, end: startLine + text.split("\n").length - 1 } : { start: startLine, end: startLine - 1 }

/**
 * Captures a stable diagnostic baseline before an edit, watches for an
 * update after it, and only counts errors tied to the resulting document
 * version. When there is no comparable baseline, errors are limited to
 * the changed lines and are not treated as a confirmed regression.
 */
const withNewErrors = async (
  view: WorkspaceView,
  file: string,
  mode: ChatEditMode,
  changed: { start: number; end: number } | undefined,
  change: () => Promise<ChatEditOutcome>,
  onApplied?: () => Promise<void>
): Promise<EditOutcome & { recoveryBaseline?: string[]; diagnosticCheckAvailable?: boolean; diagnosticsObserved?: boolean; diagnosticFailure?: DiagnosticObservation }> => {
  const applyChange = async () => {
    const outcome = await change()
    if (editedBuffer(outcome)) await onApplied?.()
    return outcome
  }
  if (mode !== "apply" || UNCHECKED_FILES.test(file)) return applyChange()
  const uri = Uri.file(file)
  const open = workspace.textDocuments.find((document) => document.uri.toString() === uri.toString())
  if (open && UNCHECKED_LANGUAGES.has(open.languageId)) return applyChange()
  const known = !!open && !!changed
  let baseline: string[] | undefined
  let baselineVersion: number | undefined
  let baselineFailure: DiagnosticObservation | undefined
  if (known && open) {
    const baselineObserver = diagnosticObserver(uri)
    const observed = await baselineObserver.wait(open.version, false)
    baselineObserver.dispose()
    if ("status" in observed) baselineFailure = observed
    else { baseline = observed.errors; baselineVersion = observed.version }
  }
  const watcher = diagnosticObserver(uri)
  const outcome = await change()
  if (!editedBuffer(outcome)) {
    watcher.dispose()
    return outcome
  }
  await onApplied?.()
  if (!outcome.ok) {
    watcher.dispose()
    return outcome
  }
  const document = workspace.textDocuments.find((entry) => entry.uri.toString() === uri.toString())
  const after = document
    ? await watcher.wait(document.version, true)
    : { status: "unavailable" as const, errors: [], reason: "The edited document is no longer open in the editor." }
  watcher.dispose()
  if ("status" in after) {
    return {
      ...outcome,
      message: `${outcome.message}\nThe editor reported no diagnostics for ${view.relative(file)} after the edit, so its errors were not checked: ${after.reason}`,
      recoveryBaseline: baseline,
      diagnosticCheckAvailable: baseline !== undefined,
      diagnosticsObserved: false,
      diagnosticFailure: after
    }
  }
  if (known && baselineVersion !== undefined && after.version <= baselineVersion) {
    return {
      ...outcome,
      recoveryBaseline: baseline,
      diagnosticCheckAvailable: baseline !== undefined,
      diagnosticsObserved: false,
      diagnosticFailure: {
        status: "stale",
        version: after.version,
        errors: after.errors,
        reason: "The diagnostic snapshot did not advance beyond pre-edit document version " + baselineVersion + "."
      }
    }
  }
  const before = [...(baseline ?? [])]
  const fresh = errorsIn(uri).filter((diagnostic) => {
    if (!known || !baseline) {
      const line = diagnostic.range.start.line
      return !changed || (line >= changed.start && line <= changed.end)
    }
    const seen = before.indexOf(diagnostic.message)
    if (seen === -1) return true
    before.splice(seen, 1)
    return false
  })
  if (!fresh.length) {
    return {
      ...outcome,
      recoveryBaseline: baseline,
      diagnosticCheckAvailable: baseline !== undefined,
      diagnosticsObserved: !known || baseline !== undefined,
      diagnosticFailure: baselineFailure
    }
  }
  const one = fresh.length === 1
  const named = fresh
    .slice(0, MAX_NEW_ERRORS)
    .map(
      (diagnostic) =>
        `${diagnostic.range.start.line + 1}: ${diagnostic.message.split("\n")[0]}${diagnostic.source ? ` (${diagnostic.source})` : ""}`
    )
  const more = fresh.length > named.length ? `\n… and ${fresh.length - named.length} more` : ""
  const where = known && baseline
    ? `that ${one ? "was" : "were"} not there before`
    : changed
      ? "on the lines you changed"
      : "in the new file"
  return {
    ...outcome,
    newErrors: fresh.length,
    recoveryBaseline: baseline,
    diagnosticCheckAvailable: baseline !== undefined,
    diagnosticsObserved: !known || baseline !== undefined,
    diagnosticFailure: baselineFailure,
    message:
      `${outcome.message}\nThe editor now reports ${one ? "an error" : `${fresh.length} errors`} in ${view.relative(file)} ${where}:\n` +
      `${named.join("\n")}${more}\nFix ${one ? "it" : "them"} if your change caused ${one ? "it" : "them"}.`
  }
}

/**
 * Whether the change left the editor buffer different: applied, or applied but not saved (the buffer keeps the edit).
 */
const editedBuffer = (outcome: ChatEditOutcome) => !outcome.pending && (outcome.ok || outcome.error?.code === "save_failed")

/**
 * Edits and new files applied and saved, or shown for review, as
 * `twinny.chatToolsEdits` says; deletes and moves likewise, asked in the
 * chat when reviewing since they have no diff.
 */
export const editorEdits = (
  view: WorkspaceView,
  mode: ChatEditMode,
  approve: ApproveChange,
  changes?: Pick<ReplyChanges, "touch" | "hold">,
  safety: EditSafetyOptions = {},
  visibility: EditorVisibility = "background"
): EditSink & FileOpsSink => {
  const isProtected = (file: string) => isProtectedPath(view.relative(file)) || isProtectedPath(view.realRelative(file))
  const modeFor = (file: string): ChatEditMode => (isProtected(file) ? "review" : mode)
  const held = <T>(work: () => Promise<T>): Promise<T> => changes?.hold(work()) ?? work()
  const mutationsBlocked = safety.mutations ?? new Map<string, boolean>()
  safety.mutations = mutationsBlocked
  const resourceKey = (file: string) => path.resolve(file)
  const blocked = (file?: string): EditOutcome | undefined => {
    if (!file) return safety.canMutate?.() === false
      ? { ok: false, message: "Mutation blocked after an unsafe recovery state." }
      : undefined
    const key = resourceKey(file)
    if (mutationsBlocked.has(key) || safety.canMutate?.(key) === false) {
      return {
        ok: false,
        message: mutationsBlocked.get(key)
          ? "Mutation blocked for " + view.relative(file) + " until a fresh diagnostic baseline is reconciled."
          : "Mutation blocked for " + view.relative(file) + " until the recovery problem is reconciled."
      }
    }
    return undefined
  }
  /** The paths outside the workspace that a call of `operation` changes, unless a preauthorization already covers them. */
  const outsideWrites = (operation: WriteOperation, paths: string[]): WriteRequest[] =>
    paths
      .filter((absolute) => view.outsideLexical(absolute, true) !== undefined && !preauthorizedNow(absolute))
      .map((absolute) => ({ operation, absolute }))
  /**
   * The reason outside changes are refused, unless this call approved them; undefined when all may change.
   * Checked before any file is read or copied. With `spend`, the approval is claimed right before the change.
   */
  const outsideRefusal = (requests: WriteRequest[], write?: OperationAuthorization, spend = false): string | undefined => {
    if (requests.length === 0) return undefined
    const approved = spend
      ? claimWrites(write, requests, currentAccessHostKey())
      : coversWrites(write, requests, currentAccessHostKey())
    if (mode === "apply" && approved) return undefined
    return `${requests.map((request) => view.relative(request.absolute)).join(", ")} is outside the workspace and the change was not approved.`
  }
  const checkedOutcome = async (file: string, outcome: EditOutcome & { recoveryBaseline?: string[]; diagnosticCheckAvailable?: boolean; diagnosticsObserved?: boolean; diagnosticFailure?: DiagnosticObservation }): Promise<EditOutcome> => {
    if (!outcome.ok || outcome.pending) return outcome
    // Diagnostics are actionable observations, not evidence that a file write
    // was incorrect or that it should be rolled back. Commit the successful
    // authorized transaction so later checkpoints reflect valid intermediate edits.
    await safety.checkpoints?.commit([file])
    return outcome
  }
  const runCommand: EditCommandRunner = safety.runEditCommand ?? ((command, ...args) => commands.executeCommand(command, ...args))
  type PendingEdit = { id: string; ticket?: EditOperationTicket; file: string; preDigest: string }
  /** Records an apply before the editor is asked for it; the edit is refused if the record cannot be written. */
  const beginEdit = async (file: string, before: string | undefined, after: string): Promise<PendingEdit | { refused: string }> => {
    const id = randomUUID()
    const preDigest = before === undefined ? ABSENT_DIGEST : editDigest(before)
    editOperationsInFlight.add(id)
    try {
      const ticket = await safety.recordEditOperation?.({
        id, target: view.relative(file), mode: "apply", preDigest, postDigest: editDigest(after)
      })
      return { id, ticket, file, preDigest }
    } catch (error) {
      editOperationsInFlight.delete(id)
      return { refused: "Not changed: " + (error instanceof Error ? error.message : String(error)) }
    }
  }
  /**
   * Settles only what the editor's answer proves: a clean success, or a refusal while the target still holds its
   * original state. A missing answer, a rejected command, or a rollback that did not restore the original stays
   * dispatched for reconciliation.
   */
  const settleEdit = async (pending: PendingEdit | undefined, command: EditOutcome | undefined, checked: EditOutcome) => {
    if (!pending?.ticket) return
    if (checked.postSave === "conflicted" || checked.postSave === "unresolved" || checked.requestedEdits === "conflicted" || checked.requestedEdits === "unresolved") {
      await pending.ticket.settle("diverged", checked.message)
    } else if (checked.ok && !checked.pending) await pending.ticket.settle("succeeded", checked.message)
    else if (command?.ok && (await holdsPrecondition(pending))) await pending.ticket.settle("reconciled_absent", checked.message)
    else if (command && !command.ok && (await holdsPrecondition(pending))) await pending.ticket.settle("failed", command.message)
  }
  return {
    mode,
    async read(file) {
      return (await workspace.openTextDocument(Uri.file(file))).getText()
    },
    async editLines(file, request, save, write) {
      const denied = blocked(file)
      if (denied) return { ...denied, error: lineEditFailure("permission_denied", denied.message) }
      const refused = outsideRefusal(outsideWrites("edit", [file]), write)
      if (refused) return { ok: false, message: `Not changed: ${refused}`, error: lineEditFailure("permission_denied", "The document is outside the workspace.") }
      if (!save && visibility !== "visible") {
        const error = lineEditFailure("permission_denied", UNSAVED_REQUIRES_VISIBLE)
        return { ok: false, message: error.message, error }
      }
      let document
      try {
        document = await workspace.openTextDocument(Uri.file(file))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { ok: false, message, error: lineEditFailure("document_unavailable", message) }
      }
      let patches
      try {
        patches = await planLineEdits(document.getText(), request)
      } catch (error) {
        if (error instanceof LineEditError) {
          if (error.detail.code === "stale_hash" || error.detail.code === "hash_mismatch") {
            const text = document.getText()
            const totalLines = text.length ? text.split(/\r\n|\r|\n/).length : 0
            const lines = request.edits
              ? (Array.isArray(request.edits) ? request.edits : []) as Array<Record<string, unknown>>
              : []
            const named = lines.flatMap((edit) => {
              const line = typeof edit.line === "number" ? edit.line : typeof edit.start_line === "number" ? edit.start_line : undefined
              return line === undefined ? [] : [{ startLine: Math.max(1, line - 3), endLine: Math.min(Math.max(1, totalLines), line + 3) }]
            })
            const refreshedRanges = named.length
              ? named.sort((a, b) => a.startLine - b.startLine).reduce<typeof named>((merged, range) => {
                  const last = merged[merged.length - 1]
                  if (last && range.startLine <= last.endLine + 1) last.endLine = Math.max(last.endLine, range.endLine)
                  else merged.push({ ...range })
                  return merged
                }, [])
              : totalLines ? [{ startLine: 1, endLine: Math.min(totalLines, 7) }] : []
            return {
              ok: false,
              message: error.message,
              error: lineEditFailure(error.detail.code, error.detail.message, error.detail.current_hash, {
                current_text: text,
                total_lines: totalLines,
                refreshed_ranges: refreshedRanges,
                source_version: "unchanged",
                mutation_occurred: false
              })
            }
          }
          return {
            ok: false,
            message: error.message,
            error: lineEditFailure(error.detail.code, error.detail.message, error.detail.current_hash, {
              total_lines: document.lineCount,
              mutation_occurred: false
            })
          }
        }
        throw error
      }
      if (modeFor(file) === "review" && !(await approve(
        "edit lines in " + view.relative(file) + " (SHA-256 " + request.expected_hash + ")\n" + JSON.stringify(request.edits, null, 2), "change"
      ))) {
        const error = lineEditFailure("permission_denied", "The user declined the line edits; nothing was changed.")
        return { ok: false, message: error.message, error }
      }
      const deniedAfterApproval = blocked(file)
      if (deniedAfterApproval) return { ...deniedAfterApproval, error: lineEditFailure("permission_denied", deniedAfterApproval.message) }
      try {
        await revealEditor(document, visibility)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const failure = lineEditFailure("document_unavailable", message)
        return { ok: false, message: failure.message, error: failure }
      }
      await safety.checkpoints?.capture([file])
      const span = changedSpan(patches)
      const changed = { start: document.positionAt(span.start).line, end: document.positionAt(span.end).line + span.added }
      const before = document.getText()
      const pending = await beginEdit(file, before, patchedText(before, patches))
      if ("refused" in pending) {
        const error = lineEditFailure("application_failed", pending.refused)
        return { ok: false, message: error.message, error }
      }
      let command: EditOutcome | undefined
      let checked: EditOutcome
      try {
        const outcome = await withNewErrors(view, file, "apply", changed, () => held(async () => {
          await changes?.touch(file)
          return (await runCommand<ChatEditOutcome>(
            TWINNY_COMMAND_NAME.chatFileEdit, { file, lineEdits: request, save, visibility }, "apply", write
          )) ?? { ok: false, message: "Not changed: the editor did not answer.", error: lineEditFailure("application_failed", "The editor did not answer.") }
        }), async () => { await safety.checkpoints?.markChanged([file]) })
        command = outcome
        checked = await checkedOutcome(file, outcome)
        // The saved file is what the index sees, including a checkpoint that restored it.
        if (command.ok && !command.pending && command.persisted !== false) checked = await refreshed(view, safety, [{ path: file, kind: "write" }], checked)
        await settleEdit(pending, command, checked)
      } finally {
        editOperationsInFlight.delete(pending.id)
      }
      if (!checked.ok) return checked
      const hash = await contentHash(document.getText())
      if (hash !== checked.contentHash) {
        const error = lineEditFailure("application_failed", "The document changed while diagnostics were checked. Reread it before another edit.", hash)
        return { ok: false, message: error.message, error }
      }
      return { ...checked, contentHash: hash }
    },
    async edit(file, replacement, write) {
      const denied = blocked(file)
      if (denied) return denied
      const refused = outsideRefusal(outsideWrites("edit", [file]), write)
      if (refused) return { ok: false, message: `Not changed: ${refused}` }
      if (modeFor(file) === "apply") await safety.checkpoints?.capture([file])
      let pending: PendingEdit | undefined
      let command: EditOutcome | undefined
      let checked: EditOutcome
      try {
        if (modeFor(file) === "apply") {
          const before = (await workspace.openTextDocument(Uri.file(file))).getText()
          const begun = await beginEdit(file, before, replacedText(replacement, before))
          if ("refused" in begun) return { ok: false, message: begun.refused }
          pending = begun
        }
        const outcome = await withNewErrors(view, file, modeFor(file), changedLines(replacement), () =>
          held(async () => {
            if (modeFor(file) === "apply") await changes?.touch(file)
            return (await runCommand<ChatEditOutcome>(
              TWINNY_COMMAND_NAME.chatFileEdit,
              { file, ...replacement },
              modeFor(file),
              write
            )) ?? { ok: false, message: "Not changed: the editor did not answer." }
          }),
          async () => { if (modeFor(file) === "apply") await safety.checkpoints?.markChanged([file]) }
        )
        command = outcome
        checked = await checkedOutcome(file, outcome)
        if (modeFor(file) === "apply" && command.ok && !command.pending) checked = await refreshed(view, safety, [{ path: file, kind: "write" }], checked)
        await settleEdit(pending, command, checked)
      } finally {
        if (pending) editOperationsInFlight.delete(pending.id)
      }
      return checked
    },
    async create(file, content, write, invocationId) {
      const denied = blocked(file)
      if (denied) return denied
      const refused = outsideRefusal(outsideWrites("create", [file]), write)
      if (refused) return { ok: false, message: `Not created: ${refused}` }
      if (modeFor(file) === "apply" && existsSync(file)) {
        const saved = savedFileText(file)
        return {
          ok: false,
          message: "Not created: " + view.relative(file) + " already exists.",
          createStatus: "already_exists",
          ...(saved !== undefined ? { contentHash: await contentHash(saved), contentSource: "disk" as const, persisted: true, finalText: saved, totalLines: linesOf(saved).length } : {})
        }
      }
      if (modeFor(file) === "apply") await safety.checkpoints?.capture([file])
      let pending: PendingEdit | undefined
      try {
        if (modeFor(file) === "apply") {
          const begun = await beginEdit(file, undefined, content)
          if ("refused" in begun) return { ok: false, message: begun.refused }
          pending = begun
        }
        const outcome = await withNewErrors(view, file, modeFor(file), undefined, () =>
          held(async () => {
            if (modeFor(file) === "apply") await changes?.touch(file)
            return (await runCommand<ChatEditOutcome>(
              TWINNY_COMMAND_NAME.chatFileCreate,
              file,
              content,
              modeFor(file),
              write,
              invocationId
            )) ?? { ok: false, message: "Not created: the editor did not answer." }
          }),
          async () => { if (modeFor(file) === "apply") await safety.checkpoints?.markChanged([file]) }
        )
        let checked = await checkedOutcome(file, outcome)
        if (modeFor(file) === "apply" && outcome.ok && !outcome.pending) {
          // The saved file is what the index sees, and the hash the model is given is read back from it.
          checked = await refreshed(view, safety, [{ path: file, kind: "write" }], checked)
          const saved = savedFileText(file)
          if (saved !== undefined) {
            const finalHash = await contentHash(saved)
            const intendedHash = await contentHash(content)
            const transformed = saved !== content
            checked = {
              ...checked,
              contentHash: finalHash,
              contentSource: "disk",
              persisted: true,
              postSave: transformed ? "applied_and_transformed" : "applied_exactly",
              requestedEdits: "verified",
              intendedHash,
              sourceVersion: "changed",
              previousSourceVersion: "superseded",
              transformationNotice: transformed ? "Save-time formatting or code actions transformed the created file." : undefined,
              finalText: saved,
              totalLines: linesOf(saved).length,
              createStatus: transformed ? "created_and_transformed" : "created",
              operationId: invocationId
            }
          } else {
            checked = {
              ...checked,
              contentHash: undefined,
              contentSource: undefined,
              persisted: undefined,
              postSave: "unresolved",
              requestedEdits: "unresolved",
              intendedHash: await contentHash(content),
              sourceVersion: "changed",
              previousSourceVersion: "superseded",
              finalText: undefined,
              createStatus: "unresolved",
              operationId: invocationId
            }
          }
        }
        if (pending?.ticket && checked.createStatus === "unresolved" && checked.ok) {
          await pending.ticket.settle("succeeded", checked.message)
        } else {
          await settleEdit(pending, outcome, checked)
        }
        return checked
      } finally {
        if (pending) editOperationsInFlight.delete(pending.id)
      }
    },
    async remove(file, write) {
      const relative = view.relative(file)
      const denied = blocked(file)
      if (denied) return denied
      const removal = outsideWrites("remove", [file])
      const refused = outsideRefusal(removal, write)
      if (refused) return { ok: false, message: `Not deleted: ${refused}` }
      const conflict = safety.goal ? forbiddenDeleteReason(safety.goal, relative) : undefined
      if (conflict) return { ok: false, message: `Not deleted: ${conflict}` }
      const lost = mode === "apply" && !isProtected(file) && !(await recoverableFromGit(file))
      if ((mode === "review" || isProtected(file) || lost) && !(await approve(`delete ${relative}${lost ? "\n(git has no copy of it as it is now)" : ""}`, "change", { operation: "remove", resource: file }))) {
        return { ok: false, message: "The user chose not to delete it." }
      }
      return held(async () => {
        const claimed = outsideRefusal(removal, write, true)
        if (claimed) return { ok: false, message: `Not deleted: ${claimed}` }
        await safety.checkpoints?.capture([file])
        await changes?.touch(file)
        const edit = new WorkspaceEdit()
        edit.deleteFile(Uri.file(file), { ignoreIfNotExists: false })
        const applied = await workspace.applyEdit(edit)
        if (applied) await safety.checkpoints?.markChanged([file])
        if (!applied) return { ok: false, message: `The editor refused to delete ${relative}.` }
        return await refreshed(view, safety, [{ path: file, kind: "delete" }], { ok: true, message: `Deleted ${relative}.` })
      })
    },
    async move(from, to, write) {
      const denied = blocked(from)
      if (denied) return denied
      const relocation = outsideWrites("move", [from, to])
      const refused = outsideRefusal(relocation, write)
      if (refused) return { ok: false, message: `Not moved: ${refused}` }
      const [source, target] = [view.relative(from), view.relative(to)]
      if ((mode === "review" || isProtected(from) || isProtected(to)) && !(await approve(`move ${source} → ${target}`, "change", { operation: "move", resource: `${from}→${to}` }))) {
        return { ok: false, message: "The user chose not to move it." }
      }
      return held(async () => {
        const claimed = outsideRefusal(relocation, write, true)
        if (claimed) return { ok: false, message: `Not moved: ${claimed}` }
        await safety.checkpoints?.capture([from, to])
        await changes?.touch(from)
        await changes?.touch(to)
        const edit = new WorkspaceEdit()
        edit.renameFile(Uri.file(from), Uri.file(to), { overwrite: false })
        const applied = await applyAndSave(edit)
        if (applied) await safety.checkpoints?.markChanged([from, to])
        if (!applied) return { ok: false, message: `The editor refused to move ${source}.` }
        const success = await refreshed(view, safety, [{ path: from, kind: "delete" }, { path: to, kind: "write" }], { ok: true, message: `Moved ${source} to ${target}.` })
        const saved = savedFileText(to)
        return saved === undefined ? success : { ...success, contentHash: await contentHash(saved) }
      })
    }
  }
}

/** How long to wait for a first word on a file from its language server. */
const DIAGNOSTICS_WAIT_MS = 1500
/** Once it has spoken: how long it must stay quiet to count as finished (syntax errors come first, type errors after). */
const DIAGNOSTICS_QUIET_MS = 400
const DIAGNOSTICS_MAX_MS = 4000
const MAX_SELECTION_CHARS = 4000
const MAX_PLACES = 200

const SEVERITY: Record<DiagnosticSeverity, EditorDiagnostic["severity"]> = {
  [DiagnosticSeverity.Error]: "error",
  [DiagnosticSeverity.Warning]: "warning",
  [DiagnosticSeverity.Information]: "info",
  [DiagnosticSeverity.Hint]: "info"
}

/**
 * Resolves once the language server has had its say on `uri`: a moment of
 * quiet after it reports, or a short wait when it has nothing new.
 */
const settledDiagnostics = (uri: Uri, quietMs = DIAGNOSTICS_QUIET_MS) =>
  new Promise<void>((resolve) => {
    let quiet: NodeJS.Timeout | undefined
    const finish = () => {
      clearTimeout(first)
      clearTimeout(quiet)
      clearTimeout(longest)
      listener.dispose()
      resolve()
    }
    const first = setTimeout(finish, DIAGNOSTICS_WAIT_MS)
    const longest = setTimeout(finish, DIAGNOSTICS_MAX_MS)
    const listener = languages.onDidChangeDiagnostics((event) => {
      if (!event.uris.some((changed) => changed.toString() === uri.toString())) return
      clearTimeout(first)
      clearTimeout(quiet)
      quiet = setTimeout(finish, quietMs)
    })
  })

const toLocations = (found: Array<Location | LocationLink> | undefined): EditorLocation[] =>
  (found ?? []).slice(0, MAX_PLACES).map((item) => {
    const [uri, range] =
      "targetUri" in item ? [item.targetUri, item.targetSelectionRange ?? item.targetRange] : [item.uri, item.range]
    return { file: uri.fsPath, line: range.start.line + 1 }
  })

const toDiagnostic = (uri: Uri, diagnostic: Diagnostic): EditorDiagnostic => ({
  file: uri.fsPath,
  line: diagnostic.range.start.line + 1,
  severity: SEVERITY[diagnostic.severity],
  message: diagnostic.message.split("\n")[0],
  source: diagnostic.source
})

/** What VS Code and its language servers know, for the chat's tools. */
export const editorKnowledge = (
  view: WorkspaceView,
  mode: ChatEditMode,
  approve: ApproveChange,
  /** Keeps each file a rename reaches as it was, for undo. */
  replyChanges?: Pick<ReplyChanges, "touch" | "hold">,
  safety: EditSafetyOptions = {}
): EditorSink => ({
  async diagnostics(file) {
    if (file) {
      const uri = Uri.file(file)
      const settled = settledDiagnostics(uri)
      await workspace.openTextDocument(uri)
      await settled
      safety.reconcileMutations?.([uri.fsPath])
      return languages.getDiagnostics(uri).map((d) => toDiagnostic(uri, d))
    }
    return languages
      .getDiagnostics()
      .filter(([uri]) => uri.scheme === "file" && view.visible(uri.fsPath))
      .flatMap(([uri, found]) => found.map((d) => toDiagnostic(uri, d)))
      .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1))
  },
  async references(file, line, character) {
    return toLocations(
      await commands.executeCommand<Location[]>(
        "vscode.executeReferenceProvider",
        Uri.file(file),
        new Position(line, character)
      )
    )
  },
  async definition(file, line, character) {
    return toLocations(
      await commands.executeCommand<Array<Location | LocationLink>>(
        "vscode.executeDefinitionProvider",
        Uri.file(file),
        new Position(line, character)
      )
    )
  },
  async rename(file, line, character, newName, authorizeOutside) {
    if (safety.canMutate?.(file) === false) return { ok: false, message: "Mutation blocked for " + view.relative(file) + " until the recovery problem is reconciled." }
    let edit: WorkspaceEdit | undefined
    try {
      edit = await commands.executeCommand<WorkspaceEdit>(
        "vscode.executeDocumentRenameProvider",
        Uri.file(file),
        new Position(line, character),
        newName
      )
    } catch (error) {
      return {
        ok: false,
        message: `The language server could not rename it: ${error instanceof Error ? error.message : error}`
      }
    }
    if (!edit || !edit.size) {
      return {
        ok: false,
        message: "The language server has no rename here; read the uses and edit them with edit_lines instead."
      }
    }
    // A rename reaches wherever the language server follows the symbol.
    // Files in the workspace must be ones the other tools may touch; files
    // outside it must each be authorized for writing before any changes.
    const beyond = edit
      .entries()
      .find(([uri]) => uri.scheme !== "file" || (view.inWorkspace(uri.fsPath) && !view.visible(uri.fsPath)))
    if (beyond) {
      return {
        ok: false,
        message: `Not renamed: it would change ${beyond[0].fsPath}, which is ignored or not a file on disk.`
      }
    }
    const outside = edit
      .entries()
      .map(([uri]) => uri.fsPath)
      .filter((target) => !view.inWorkspace(target))
    if (outside.length) {
      const refusal = authorizeOutside
        ? await authorizeOutside(outside)
        : `Not renamed: it would change ${outside[0]}, which is outside the workspace.`
      if (refusal) return { ok: false, message: refusal }
    }
    const files = edit.entries().map(([uri]) => view.relative(uri.fsPath))
    const changes = edit.entries().reduce((n, [, edits]) => n + edits.length, 0)
    if (
      (mode === "review" || files.some(isProtectedPath)) &&
      !(await approve(`rename to ${newName}: ${changes} changes in ${files.join(", ")}`, "change", { operation: "rename", resource: files.join(",") }))
    ) {
      return { ok: false, message: "The user chose not to rename it." }
    }
    const absoluteFiles = edit.entries().map(([uri]) => uri.fsPath)
    let renameFailure: string | undefined
    let attempted = false
    const rename = async () => {
      await safety.checkpoints?.capture(absoluteFiles)
      for (const [uri] of edit!.entries()) await replyChanges?.touch(uri.fsPath)
      // From here the files may hold whatever the rename did to them, so the index is told about all of them.
      attempted = true
      const applied = await applyAndSave(edit!)
      if (!applied) {
        return false
      }
      await safety.checkpoints?.commit(absoluteFiles)
      return true
    }
    const done = await (replyChanges?.hold(rename()) ?? rename())
    const outcome = done
      ? {
          ok: true,
          files,
          message: `Renamed to ${newName}: ${changes} changes in ${files.join(", ")}, saved.`
        }
      : { ok: false, message: renameFailure ?? "The editor refused the rename." }
    if (!attempted) return outcome
    // Every file the rename reached, whether it changed or was put back as it was.
    const caught = await refreshed(view, safety, absoluteFiles.map((absolute): IndexChange => ({ path: absolute, kind: "write" })), outcome)
    if (!done) return caught
    const fileHashes: Record<string, string> = {}
    for (const absolute of absoluteFiles) {
      const saved = savedFileText(absolute)
      if (saved === undefined) continue
      fileHashes[view.relative(absolute)] = await contentHash(saved)
    }
    return { ...caught, fileHashes }
  },
  async context() {
    const editor = window.activeTextEditor
    const selection = editor && !editor.selection.isEmpty ? editor.selection : undefined
    const text = selection ? editor!.document.getText(new Range(selection.start, selection.end)) : ""
    return {
      activeFile: editor?.document.uri.scheme === "file" ? editor.document.uri.fsPath : undefined,
      cursorLine: editor ? editor.selection.active.line + 1 : undefined,
      selection: selection
        ? {
            startLine: selection.start.line + 1,
            endLine: selection.end.line + 1,
            text: text.length > MAX_SELECTION_CHARS ? `${text.slice(0, MAX_SELECTION_CHARS)}\n… (cut)` : text
          }
        : undefined,
      openFiles: window.tabGroups.all
        .flatMap((group) => group.tabs)
        .map((tab) => (tab.input as { uri?: Uri } | undefined)?.uri)
        .filter((uri): uri is Uri => uri?.scheme === "file")
        .map((uri) => uri.fsPath)
    }
  }
})

/**
 * One line on where the user is in the editor, sent with their message so
 * "this function" and "here" need no tool call to resolve. Nothing when
 * the file is one the tools may not read.
 */
export const editorHint = (view: WorkspaceView): string => {
  const editor = window.activeTextEditor
  if (!editor || editor.document.uri.scheme !== "file" || !view.visible(editor.document.uri.fsPath)) return ""
  const file = view.relative(editor.document.uri.fsPath)
  const { selection } = editor
  return selection.isEmpty
    ? `The user's active editor is ${file}, cursor on line ${selection.active.line + 1}.`
    : `The user's active editor is ${file}, with lines ${selection.start.line + 1}-${selection.end.line + 1} selected.`
}

/** The terminal the chat's commands run in, apart from the one other features type into. */
export const TOOLS_TERMINAL = `${TWINNY} tools`

/** Terminals with a command of ours still running in them: one that outlived its wait. */
const busy = new WeakSet<Terminal>()
/** Terminals whose shell never reported integration; no need to wait to find that out again. */
const withoutIntegration = new WeakSet<Terminal>()

/** When a command of ours last ended in a terminal. */
const lastEnded = new WeakMap<Terminal, number>()
/**
 * A shell reports where it is with its next prompt, a moment after a
 * command ends. Sooner than this after one, what it last reported is not
 * taken as where it is now.
 */
const CWD_SETTLE_MS = 2000


/** A terminal to run in: ours, alive, and not in the middle of something; `fresh` when it was just opened at `cwd`. */
const toolsTerminal = (cwd: string): { terminal: Terminal; fresh: boolean } => {
  const existing = window.terminals.find(
    (terminal) => terminal.name === TOOLS_TERMINAL && terminal.exitStatus === undefined && !busy.has(terminal)
  )
  return existing
    ? { terminal: existing, fresh: false }
    : {
        terminal: window.createTerminal({ name: TOOLS_TERMINAL, cwd }),
        fresh: true
      }
}

/** The terminal's shell integration, waiting briefly for a new terminal's shell to report it. */
const integrationOf = (terminal: Terminal): Promise<TerminalShellIntegration | undefined> => {
  if (withoutIntegration.has(terminal)) return Promise.resolve(undefined)
  if (terminal.shellIntegration) return Promise.resolve(terminal.shellIntegration)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      listener.dispose()
      withoutIntegration.add(terminal)
      resolve(undefined)
    }, INTEGRATION_WAIT_MS)
    const listener = window.onDidChangeTerminalShellIntegration((event) => {
      if (event.terminal !== terminal) return
      clearTimeout(timer)
      listener.dispose()
      resolve(event.shellIntegration)
    })
  })
}

type Ended = { exitCode?: number } | "timeout" | "stopped"

/** Runs to its end in the terminal, or until the wait or the user's patience runs out. */
const execute = (
  terminal: Terminal,
  run: () => ReturnType<TerminalShellIntegration["executeCommand"]>,
  timeoutMs: number,
  signal?: AbortSignal,
  onOutput?: (output: string) => void
) => {
  const execution = run()
  busy.add(terminal)
  let output = ""
  const reading = (async () => {
    for await (const chunk of execution.read()) {
      output = (output + chunk).slice(-MAX_CAPTURE_CHARS)
      onOutput?.(output)
    }
  })().catch((error) => logger.warn(`Chat command output: ${error}`))

  let settle: (ended: Ended) => void = () => undefined
  const ended = new Promise<Ended>((resolve) => {
    settle = resolve
  })
  // These two listeners outlive the wait: a command left running frees
  // its terminal only when it really ends.
  const release = () => {
    finished.dispose()
    closed.dispose()
    busy.delete(terminal)
    lastEnded.set(terminal, Date.now())
  }
  const finished = window.onDidEndTerminalShellExecution((event) => {
    if (event.execution !== execution) return
    release()
    settle({ exitCode: event.exitCode })
  })
  // `exit` and friends end the shell itself, and with it any end event.
  const closed = window.onDidCloseTerminal((gone) => {
    if (gone !== terminal) return
    release()
    settle({ exitCode: gone.exitStatus?.code })
  })
  const timer = setTimeout(() => settle("timeout"), timeoutMs)
  const stop = () => {
    // The user stopped the reply: the command is interrupted as Ctrl+C would.
    terminal.sendText("\x03", false)
    settle("stopped")
  }
  if (signal?.aborted) stop()
  else signal?.addEventListener("abort", stop, { once: true })
  void ended.then(() => {
    clearTimeout(timer)
    signal?.removeEventListener("abort", stop)
  })
  return { ended, output: () => output, reading }
}

/** Presence of the API is not proof that the shell emits usable execution events. */
const verifiedIntegration = new WeakSet<Terminal>()
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const verifyIntegration = async (terminal: Terminal, integration: TerminalShellIntegration, signal?: AbortSignal) => {
  if (verifiedIntegration.has(terminal)) return true
  if (signal?.aborted) return false
  // This has no user side effects. Never retry a user's command after an
  // ambiguous timeout: it may already have executed successfully.
  const marker = "TWINNY_SHELL_INTEGRATION_OK"
  const probe = execute(terminal, () => integration.executeCommand(`echo ${marker}`), INTEGRATION_WAIT_MS, signal)
  const ended = await probe.ended
  await Promise.race([probe.reading, new Promise((resolve) => setTimeout(resolve, 300))])
  if (typeof ended === "object" && ended.exitCode === 0 && probe.output().includes(marker)) {
    verifiedIntegration.add(terminal)
    return true
  }
  withoutIntegration.add(terminal)
  logger.warn(`Chat command: shell integration probe failed (${JSON.stringify(ended)}, captured=${probe.output().length}); using background execution`)
  return false
}

/** In the tools terminal, so the user sees it and `@terminal` has it afterwards. */
const runInTerminal = async (
  terminal: Terminal,
  integration: TerminalShellIntegration,
  command: string,
  cwd: string,
  fresh: boolean,
  signal?: AbortSignal,
  onOutput?: (output: string) => void
): Promise<CommandOutcome> => {
  // Commands are promised the workspace root, and an earlier one may have
  // left the shell elsewhere. Unless the shell is new, or has sat idle
  // and says it is at the root, it is sent there first.
  const idle = Date.now() - (lastEnded.get(terminal) ?? 0) > CWD_SETTLE_MS
  if (!fresh && !(idle && integration.cwd?.fsPath === cwd)) {
    await execute(terminal, () => integration.executeCommand("cd", [cwd]), 5000, signal).ended
  }
  const run = execute(terminal, () => integration.executeCommand(command), COMMAND_TIMEOUT_MS, signal, onOutput)
  const ended = await run.ended
  // The last chunk can land just after the end event.
  await Promise.race([run.reading, new Promise((resolve) => setTimeout(resolve, 300))])
  const tail = tailOutput(stripAnsi(run.output()), OUTPUT_TAIL)
  if (ended === "timeout") return { ran: true, output: tail, timedOut: "running" }
  if (ended === "stopped") return { ran: true, output: tail, timedOut: "stopped" }
  return { ran: true, output: tail, exitCode: ended.exitCode }
}

/**
 * bash where there is one: the lines models write assume a POSIX shell,
 * which fish, say, is not. PATH comes from the extension host either way.
 */
const BACKGROUND_SHELL: string | boolean = process.platform !== "win32" && existsSync("/bin/bash") ? "/bin/bash" : true

/** After the shell exits, how long its output may take to finish arriving. */
const EXIT_GRACE_MS = 500
/** How long a stopped command gets to end on SIGTERM before it is killed outright. */
const KILL_AFTER_MS = 2000

/**
 * Ends a background command and whatever it started: its process group
 * on POSIX (even once the shell itself has exited, since what it left
 * running is still in the group); on Windows, where killing the shell
 * leaves its children running, `taskkill /T` down the tree.
 */
const killTree = (child: ChildProcess, group: boolean, signal: NodeJS.Signals = "SIGTERM") => {
  try {
    if (process.platform === "win32" && child.pid) {
      execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, (error) => {
        if (error) child.kill()
      })
    } else if (group && child.pid) {
      process.kill(-child.pid, signal)
    } else {
      child.kill(signal)
    }
  } catch {
    // Nothing left in the group, or it is not ours to signal.
    if (child.exitCode === null) child.kill(signal)
  }
}

/**
 * In a process of its own, through a shell, from the workspace
 * root. Nothing can type into it, so a command that waits for input gets
 * end-of-file instead of hanging. Ending it (the wait ran out, or the
 * user stopped the reply) ends whatever it started too, and so does the
 * command finishing: a server it put in the background (`npm start &`)
 * has nobody to read it once the step is over, and would hold its port.
 */
const runInBackground = (
  command: string,
  cwd: string,
  signal?: AbortSignal,
  onOutput?: (output: string) => void,
  timeoutMs = COMMAND_TIMEOUT_MS
): Promise<CommandOutcome> =>
  new Promise((resolve) => {
    const group = process.platform !== "win32"
    const child = spawn(command, {
      cwd,
      shell: BACKGROUND_SHELL,
      detached: group,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PAGER: "cat", GIT_PAGER: "cat", NO_COLOR: "1" }
    })
    let output = ""
    let ended: "stopped" | undefined
    let settled = false
    let leftovers = false
    let exitCode: number | undefined
    const timers: ReturnType<typeof setTimeout>[] = []
    const take = (chunk: string) => {
      output = (output + chunk).slice(-MAX_CAPTURE_CHARS)
      onOutput?.(output)
    }
    // Whole characters, however the bytes fall across chunks.
    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stdout?.on("data", take)
    child.stderr?.on("data", take)
    const finish = () => {
      if (settled) return
      settled = true
      timers.forEach(clearTimeout)
      signal?.removeEventListener("abort", stop)
      // Whatever the command left behind ends with it.
      if (leftovers || ended) killTree(child, group, "SIGKILL")
      const note = leftovers && !ended ? "\n(it left processes running in the background; they were ended with it)" : ""
      const tail = tailOutput(stripAnsi(output), OUTPUT_TAIL) + note
      resolve(ended ? { ran: true, output: tail, timedOut: ended } : { ran: true, output: tail, exitCode })
    }
    function stop() {
      if (ended || settled) return
      ended = "stopped"
      killTree(child, group)
      // A command that ignores SIGTERM is killed; one whose pipes stay
      // open after that is not waited on.
      timers.push(setTimeout(() => killTree(child, group, "SIGKILL"), KILL_AFTER_MS))
      timers.push(setTimeout(finish, KILL_AFTER_MS + EXIT_GRACE_MS))
    }
    timers.push(setTimeout(stop, timeoutMs))
    if (signal?.aborted) stop()
    else signal?.addEventListener("abort", stop, { once: true })
    child.on("error", (error) => {
      output += `\n${error.message}`
      exitCode = 127
      finish()
    })
    child.on("exit", (code) => {
      exitCode = code ?? undefined
      // The shell is done; its output follows within a moment unless
      // something it started still holds the pipes.
      timers.push(
        setTimeout(() => {
          leftovers = true
          finish()
        }, EXIT_GRACE_MS)
      )
    })
    child.on("close", () => finish())
  })

/** Asks in a notification, for hosts without a chat to ask in. */
const askInNotification = async (command: string) =>
  (await window.showInformationMessage(`Twinny wants to run: ${command}`, "Run", "Skip")) === "Run"

/**
 * Commands the model asks for: put to the user first while `mode` says
 * `ask` (in the chat's tool steps when `approve` is given), then run in
 * the background or in the tools terminal. `mode` is asked for each
 * command, so switching auto-run on mid-reply holds for the rest of it.
 * `onOutput` hears what the command prints as it prints it.
 */
export const terminalCommands = (
  mode: (command: string) => "ask" | "allow",
  cwd: string,
  approve: (command: string) => Promise<boolean> = askInNotification,
  options: {
    place?: ChatCommandPlace
    onOutput?: (output: string) => void
    /** Hears, as a command starts, how to stop just that command. */
    onStart?: (stop: () => void) => void
    /** How long a background command may run; two minutes unless a test says less. */
    timeoutMs?: number
    /** Ends when the chat does (a closed panel, a reload): its commands end with it. */
    lifetime?: AbortSignal
    /**
     * Files a command changes are kept for undo with the edits' (inside a
     * git repository); `visible` says which the agent may show.
     */
    changes?: Pick<ReplyChanges, "touchWith" | "hold">
    visible?: (file: string) => boolean
  } = {}
): CommandSink => ({
  get mode() {
    return mode("")
  },
  async run(command, signal) {
    if (mode(command) === "ask") {
      if (!(await approve(command))) {
        logger.info(`Chat command skipped: ${command}`)
        return { ran: false, output: "" }
      }
    }
    if (signal?.aborted) return { ran: false, output: "" }
    logger.info(`Chat command: ${command}`)
    // Output is passed on while this step lasts: a command left running in
    // the terminal after the wait keeps printing, and that is not the next
    // step's output.
    let current = true
    const onOutput = options.onOutput && ((output: string) => current && options.onOutput!(stripAnsi(output)))
    // Its own stop, which the reply's stop also pulls.
    const own = new AbortController()
    const follow = () => own.abort()
    signal?.addEventListener("abort", follow, { once: true })
    options.lifetime?.addEventListener("abort", follow, { once: true })
    if (options.lifetime?.aborted) follow()
    let stoppedByUser = false
    options.onStart?.(() => {
      stoppedByUser = true
      own.abort()
    })
    // The tree before it runs, so what it changed can be undone with the reply.
    const before = options.changes ? await snapshotTree(cwd) : undefined
    try {
      const outcome = await (async () => {
        if (options.place !== "terminal") return runInBackground(command, cwd, own.signal, onOutput, options.timeoutMs)
        const { terminal, fresh } = toolsTerminal(cwd)
        terminal.show(true)
        const integration = await integrationOf(terminal)
        // Experiment D negative control: trust API presence without the readiness probe.
        if (integration) {
          return runInTerminal(terminal, integration, command, cwd, fresh, own.signal, onOutput)
        }
        if (own.signal.aborted) return { ran: false, output: "" }
        logger.info("Chat command: no verified shell integration in the tools terminal, running in the background")
        return runInBackground(command, cwd, own.signal, onOutput, options.timeoutMs)
      })()
      return stoppedByUser && outcome.timedOut === "stopped" ? { ...outcome, stoppedByUser: true } : outcome
    } finally {
      current = false
      signal?.removeEventListener("abort", follow)
      options.lifetime?.removeEventListener("abort", follow)
      if (before && options.changes) {
        await options.changes.hold(keepCommandChanges(before, cwd, command, options.changes, options.visible))
      }
    }
  }
})

/** What a command changed, kept with the reply's other changes; files the agent may not show are left out. */
const keepCommandChanges = async (
  before: TreeSnapshot,
  cwd: string,
  command: string,
  changes: Pick<ReplyChanges, "touchWith">,
  visible: (file: string) => boolean = () => true
) => {
  const started = Date.now()
  const after = await snapshotTree(cwd)
  if (!after) return
  const changed = await changesBetween(before, after)
  const took = Date.now() - started
  if (!changed) {
    logger.warn(`Chat command changed more than ${MAX_COMMAND_CHANGES} files; they are not listed for undo: ${command}`)
    return
  }
  const shown = changed.filter((change) => visible(change.file))
  for (const change of shown) changes.touchWith(change.file, change.before)
  logger.info(
    `Chat command changed ${shown.length} file${shown.length === 1 ? "" : "s"} (read from git in ${took} ms): ${command}`
  )
}

/** A command as Always run keeps it: trimmed, its spaces collapsed. */
export const normalCommand = (command: string) => command.trim().replace(/\s+/g, " ")

/** `search_code` over the embeddings index, with the chat's own threshold. */
export const indexSearch = (search: WorkspaceSearch, threshold: () => number | undefined): CodeSearch => ({
  async search(query) {
    const result = await search.searchDetailed(query, {
      limit: SEARCH_HITS,
      threshold: threshold() || DEFAULT_RERANK_THRESHOLD,
      maxChars: SEARCH_CHARS,
      expandChars: DEFAULT_WORKSPACE_HIT_CHARS
    })
    return result.hits.filter((hit) => hit.kind !== "imports")
  }
})
