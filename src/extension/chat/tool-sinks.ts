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
import type { ChatEditMode, ChatEditOutcome } from "../edit/service"
import { WorkspaceSearch } from "../embeddings/search"
import { stripAnsi, tailOutput } from "../terminal/output"
import type { Replacement } from "../tools/edit"
import { isProtectedPath } from "../tools/helpers"
import { contentHash, LineEditError, lineEditFailure, planLineEdits } from "../tools/line-edit"
import { EditorDiagnostic, EditorLocation, EditorSink, FileOpsSink } from "../tools/more"
import { WorkspaceView } from "../tools/view"
import { CodeSearch, CommandOutcome, CommandSink, EditOutcome, EditSink } from "../tools/workspace"

import { changesBetween, MAX_COMMAND_CHANGES, snapshotTree, TreeSnapshot } from "./command-snapshot"
import { forbiddenDeleteReason } from "./execution-reconciliation"
import { ReplyChanges } from "./reply-changes"
import {
  CheckpointFile,
  createDiagnosticObserver,
  DiagnosticObservation,
  DiagnosticRegressionMonitor,
  DiagnosticVerificationStatus,
  recoverSignificantEdit,
  SafeEditCheckpoints,
  verifyDiagnosticBaseline
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

export interface EditSafetyOptions {
  goal?: string
  checkpoints?: SafeEditCheckpoints
  errorSpikeThreshold?: number
  cumulativeErrorThreshold?: number
  diagnosticMonitor?: DiagnosticRegressionMonitor
  onCatastrophic?(notice: EditRecoveryNotice): Promise<void> | void
  canMutate?(): boolean
  blockMutations?(): void
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
export type ApproveChange = (detail: string, approval: "command" | "change") => Promise<boolean>

/** A file as the editor has it when it is open there, unsaved changes included. */
export const openDocumentText = async (file: string): Promise<string | undefined> =>
  // Only the file itself: a diff view holds another version of it under
  // the same path with a different scheme.
  workspace.textDocuments.find((document) => document.uri.scheme === "file" && document.uri.fsPath === file)?.getText()

/** Apply a workspace edit and save what it touched, so later reads and searches of the disk agree. */
const applyAndSave = async (edit: WorkspaceEdit): Promise<boolean> => {
  if (!(await workspace.applyEdit(edit))) return false
  for (const [uri] of edit.entries()) {
    const document = workspace.textDocuments.find((d) => d.uri.toString() === uri.toString())
    if (document?.isDirty) await document.save()
  }
  return true
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
    if (outcome.ok && !outcome.pending) await onApplied?.()
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
  if (!outcome.ok || outcome.pending) {
    watcher.dispose()
    return outcome
  }
  await onApplied?.()
  const document = workspace.textDocuments.find((entry) => entry.uri.toString() === uri.toString())
  const after = document
    ? await watcher.wait(document.version, true)
    : { status: "unavailable" as const, errors: [], reason: "The edited document is no longer open in the editor." }
  watcher.dispose()
  if ("status" in after) {
    return {
      ...outcome,
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
 * Edits and new files applied and saved, or shown for review, as
 * `twinny.chatToolsEdits` says; deletes and moves likewise, asked in the
 * chat when reviewing since they have no diff.
 */
export const editorEdits = (
  view: WorkspaceView,
  mode: ChatEditMode,
  approve: ApproveChange,
  changes?: Pick<ReplyChanges, "touch" | "hold">,
  safety: EditSafetyOptions = {}
): EditSink & FileOpsSink => {
  const isProtected = (file: string) => isProtectedPath(view.relative(file)) || isProtectedPath(view.realRelative(file))
  const modeFor = (file: string): ChatEditMode => (isProtected(file) ? "review" : mode)
  const held = <T>(work: () => Promise<T>): Promise<T> => changes?.hold(work()) ?? work()
  let mutationsBlocked = false
  const blocked = (): EditOutcome | undefined => mutationsBlocked || safety.canMutate?.() === false
    ? { ok: false, message: "Mutation blocked after a catastrophic edit regression." }
    : undefined
  const checkedOutcome = async (file: string, outcome: EditOutcome & { recoveryBaseline?: string[]; diagnosticCheckAvailable?: boolean; diagnosticsObserved?: boolean; diagnosticFailure?: DiagnosticObservation }): Promise<EditOutcome> => {
    if (!outcome.ok || outcome.pending) return outcome
    const introduced = outcome.newErrors ?? 0
    const observer = outcome.recoveryBaseline && outcome.diagnosticCheckAvailable ? diagnosticObserver(Uri.file(file)) : undefined
    let recovery: Awaited<ReturnType<typeof recoverSignificantEdit>>
    try {
      recovery = await recoverSignificantEdit({
        file: view.relative(file),
        introducedErrors: introduced,
        diagnosticsObserved: outcome.diagnosticsObserved ?? false,
        diagnosticCheckAvailable: outcome.diagnosticCheckAvailable ?? false,
        baseline: outcome.recoveryBaseline,
        diagnosticFailure: outcome.diagnosticFailure,
        checkpoints: safety.checkpoints,
        monitor: safety.diagnosticMonitor,
        errorSpikeThreshold: safety.errorSpikeThreshold,
        blockMutations: () => {
          mutationsBlocked = true
          safety.blockMutations?.()
        },
        observeRestoredDiagnostics: async () => {
          const uri = Uri.file(file)
          const document = workspace.textDocuments.find((entry) => entry.uri.toString() === uri.toString())
          return observer && document
            ? observer.wait(document.version, true)
            : { status: "unavailable" as const, errors: [], reason: "The restored document is no longer open in the editor." }
        }
      })
    } finally {
      observer?.dispose()
    }
    if (!recovery) {
      if ((outcome.diagnosticsObserved && introduced === 0) || (outcome.diagnosticsObserved === undefined && outcome.newErrors === undefined)) {
        await safety.checkpoints?.commit([file])
      }
      return outcome
    }
    const reason = recovery.reason.includes("Could not safely restore")
      ? "Could not safely restore after " + introduced + " new diagnostics in " + view.relative(file) + ": " + recovery.reason.replace("Could not safely restore file contents: ", "")
      : recovery.reason.replace("the safe file checkpoint", "the last safe checkpoint in " + view.relative(file))
    const diagnostics = [outcome.message, recovery.diagnosticEvidence].filter(Boolean).join("\n").slice(0, 4000)
    await safety.onCatastrophic?.({
      file: view.relative(file),
      introducedErrors: introduced,
      diagnostics,
      restored: recovery.restored,
      fileVerified: recovery.fileVerified,
      diagnosticsVerified: recovery.diagnosticsVerified,
      diagnosticsStatus: recovery.diagnosticsStatus,
      reason
    })
    return { ...outcome, ok: false, message: reason + " Further file mutations are blocked for this execution." }
  }
  return {
    mode,
    async read(file) {
      return (await workspace.openTextDocument(Uri.file(file))).getText()
    },
    async editLines(file, request) {
      const denied = blocked()
      if (denied) return { ...denied, error: lineEditFailure("permission_denied", denied.message) }
      let document
      try {
        document = await workspace.openTextDocument(Uri.file(file))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { ok: false, message, error: lineEditFailure("document_unavailable", message) }
      }
      let patches
      try {
        patches = planLineEdits(document.getText(), request)
      } catch (error) {
        if (error instanceof LineEditError) return { ok: false, message: error.message, error: error.detail }
        throw error
      }
      if (modeFor(file) === "review" && !(await approve(
        "edit lines in " + view.relative(file) + " (SHA-256 " + request.expected_hash + ")\n" + JSON.stringify(request.edits, null, 2), "change"
      ))) {
        const error = lineEditFailure("permission_denied", "The user declined the line edits; nothing was changed.")
        return { ok: false, message: error.message, error }
      }
      const deniedAfterApproval = blocked()
      if (deniedAfterApproval) return { ...deniedAfterApproval, error: lineEditFailure("permission_denied", deniedAfterApproval.message) }
      await safety.checkpoints?.capture([file])
      const changed = {
        start: document.positionAt(patches[0].start).line,
        end: document.positionAt(patches[patches.length - 1].end).line + patches.reduce((added, patch) => added + patch.text.split("\n").length - 1, 0)
      }
      const outcome = await withNewErrors(view, file, "apply", changed, () => held(async () => {
        await changes?.touch(file)
        return (await commands.executeCommand<ChatEditOutcome>(
          TWINNY_COMMAND_NAME.chatFileEdit, { file, lineEdits: request }, "apply"
        )) ?? { ok: false, message: "Not changed: the editor did not answer.", error: lineEditFailure("application_failed", "The editor did not answer.") }
      }), async () => { await safety.checkpoints?.markChanged([file]) })
      const checked = await checkedOutcome(file, outcome)
      if (!checked.ok) return checked
      const hash = contentHash(document.getText())
      if (hash !== checked.contentHash) {
        const error = lineEditFailure("application_failed", "The document changed while diagnostics were checked. Reread it before another edit.", hash)
        return { ok: false, message: error.message, error }
      }
      return { ...checked, contentHash: hash }
    },
    async edit(file, replacement) {
      const denied = blocked()
      if (denied) return denied
      if (modeFor(file) === "apply") await safety.checkpoints?.capture([file])
      const outcome = await withNewErrors(view, file, modeFor(file), changedLines(replacement), () =>
        held(async () => {
          if (modeFor(file) === "apply") await changes?.touch(file)
          return (await commands.executeCommand<ChatEditOutcome>(
            TWINNY_COMMAND_NAME.chatFileEdit,
            { file, ...replacement },
            modeFor(file)
          )) ?? { ok: false, message: "Not changed: the editor did not answer." }
        }),
        async () => { if (modeFor(file) === "apply") await safety.checkpoints?.markChanged([file]) }
      )
      return checkedOutcome(file, outcome)
    },
    async create(file, content) {
      const denied = blocked()
      if (denied) return denied
      if (modeFor(file) === "apply") await safety.checkpoints?.capture([file])
      const outcome = await withNewErrors(view, file, modeFor(file), undefined, () =>
        held(async () => {
          if (modeFor(file) === "apply") await changes?.touch(file)
          return (await commands.executeCommand<ChatEditOutcome>(
            TWINNY_COMMAND_NAME.chatFileCreate,
            file,
            content,
            modeFor(file)
          )) ?? { ok: false, message: "Not created: the editor did not answer." }
        }),
        async () => { if (modeFor(file) === "apply") await safety.checkpoints?.markChanged([file]) }
      )
      return checkedOutcome(file, outcome)
    },
    async remove(file) {
      const relative = view.relative(file)
      const denied = blocked()
      if (denied) return denied
      const conflict = safety.goal ? forbiddenDeleteReason(safety.goal, relative) : undefined
      if (conflict) return { ok: false, message: `Not deleted: ${conflict}` }
      const lost = mode === "apply" && !isProtected(file) && !(await recoverableFromGit(file))
      if ((mode === "review" || isProtected(file) || lost) && !(await approve(`delete ${relative}${lost ? "\n(git has no copy of it as it is now)" : ""}`, "change"))) {
        return { ok: false, message: "The user chose not to delete it." }
      }
      return held(async () => {
        await safety.checkpoints?.capture([file])
        await changes?.touch(file)
        const edit = new WorkspaceEdit()
        edit.deleteFile(Uri.file(file), { ignoreIfNotExists: false })
        const applied = await workspace.applyEdit(edit)
        if (applied) await safety.checkpoints?.markChanged([file])
        return applied
          ? { ok: true, message: `Deleted ${relative}.` }
          : { ok: false, message: `The editor refused to delete ${relative}.` }
      })
    },
    async move(from, to) {
      const denied = blocked()
      if (denied) return denied
      const [source, target] = [view.relative(from), view.relative(to)]
      if ((mode === "review" || isProtected(from) || isProtected(to)) && !(await approve(`move ${source} → ${target}`, "change"))) {
        return { ok: false, message: "The user chose not to move it." }
      }
      return held(async () => {
        await safety.checkpoints?.capture([from, to])
        await changes?.touch(from)
        await changes?.touch(to)
        const edit = new WorkspaceEdit()
        edit.renameFile(Uri.file(from), Uri.file(to), { overwrite: false })
        const applied = await applyAndSave(edit)
        if (applied) await safety.checkpoints?.markChanged([from, to])
        return applied
          ? { ok: true, message: `Moved ${source} to ${target}.` }
          : { ok: false, message: `The editor refused to move ${source}.` }
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
  async rename(file, line, character, newName) {
    if (safety.canMutate?.() === false) return { ok: false, message: "Mutation blocked after a catastrophic edit regression." }
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
        message: "The language server has no rename here; edit the uses with edit_file instead."
      }
    }
    // A rename reaches wherever the language server follows the symbol.
    // It is held to the files the other tools may touch.
    const beyond = edit.entries().find(([uri]) => uri.scheme !== "file" || !view.visible(uri.fsPath))
    if (beyond) {
      return {
        ok: false,
        message: `Not renamed: it would change ${beyond[0].fsPath}, which is outside the workspace or ignored.`
      }
    }
    const files = edit.entries().map(([uri]) => view.relative(uri.fsPath))
    const changes = edit.entries().reduce((n, [, edits]) => n + edits.length, 0)
    if (
      (mode === "review" || files.some(isProtectedPath)) &&
      !(await approve(`rename to ${newName}: ${changes} changes in ${files.join(", ")}`, "change"))
    ) {
      return { ok: false, message: "The user chose not to rename it." }
    }
    const absoluteFiles = edit.entries().map(([uri]) => uri.fsPath)
    let renameFailure: string | undefined
    const rename = async () => {
      await safety.checkpoints?.capture(absoluteFiles)
      const baseline = new Map<string, { errors: string[]; version: number }>()
      for (const absolute of absoluteFiles) {
        const uri = Uri.file(absolute)
        const document = await workspace.openTextDocument(uri)
        const observer = diagnosticObserver(uri)
        const observed = await observer.wait(document.version, false)
        observer.dispose()
        if (!("status" in observed)) baseline.set(absolute, observed)
      }
      const editObservers = new Map(absoluteFiles.map((absolute) => [absolute, diagnosticObserver(Uri.file(absolute))]))
      for (const [uri] of edit!.entries()) await replyChanges?.touch(uri.fsPath)
      const applied = await applyAndSave(edit!)
      if (!applied) {
        editObservers.forEach((observer) => observer.dispose())
        return false
      }
      await safety.checkpoints?.markChanged(absoluteFiles)
      let catastrophic: { absolute: string; messages: string[] } | undefined
      for (const absolute of absoluteFiles) {
        const previous = baseline.get(absolute)
        if (!previous) continue
        const uri = Uri.file(absolute)
        const document = workspace.textDocuments.find((entry) => entry.uri.toString() === uri.toString())
        const observed = document ? await editObservers.get(absolute)!.wait(document.version, true) : undefined
        if (!observed || "status" in observed) continue
        const before = [...previous.errors]
        const fresh = errorsIn(uri).filter((diagnostic) => {
          const found = before.indexOf(diagnostic.message)
          if (found < 0) return true
          before.splice(found, 1)
          return false
        })
        if (fresh.length && safety.diagnosticMonitor?.record(absolute, fresh.length)) {
          catastrophic = { absolute, messages: fresh.slice(0, 20).map((diagnostic) => `${diagnostic.range.start.line + 1}: ${diagnostic.message.split("\n")[0]}`) }
          break
        }
      }
      editObservers.forEach((observer) => observer.dispose())
      if (!catastrophic) return true
      safety.blockMutations?.()
      const rollbackObservers = new Map(absoluteFiles.map((absolute) => [absolute, diagnosticObserver(Uri.file(absolute))]))
      const rollback = safety.checkpoints
        ? await safety.checkpoints.rollback()
        : { restored: false, contentVerified: false, reason: "No safe checkpoint service is available." }
      let diagnosticsVerified = rollback.restored && baseline.size === absoluteFiles.length
      let diagnosticsStatus: DiagnosticVerificationStatus = rollback.restored ? "verified" : "unavailable"
      let diagnosticReason = "Restored diagnostics match the pre-rename baseline."
      const evidence: string[] = []
      if (rollback.restored) {
        for (const absolute of absoluteFiles) {
          const before = baseline.get(absolute)
          const observer = rollbackObservers.get(absolute)
          const uri = Uri.file(absolute)
          const document = workspace.textDocuments.find((entry) => entry.uri.toString() === uri.toString())
          if (!before || !observer || !document) {
            diagnosticsVerified = false
            diagnosticsStatus = "unavailable"
            diagnosticReason = "A stable pre-rename baseline or restored document version was unavailable for " + view.relative(absolute) + "."
            continue
          }
          const observed = await observer.wait(document.version, true)
          const verification = verifyDiagnosticBaseline(before.errors, observed)
          evidence.push(verification.evidence)
          if (!verification.verified) {
            diagnosticsVerified = false
            diagnosticsStatus = verification.status
            diagnosticReason = verification.reason
          }
        }
      }
      rollbackObservers.forEach((observer) => observer.dispose())
      renameFailure = !rollback.restored
        ? "Could not safely restore after rename introduced diagnostics: " + rollback.reason
        : !diagnosticsVerified
          ? "Restored and verified file contents after rename, but diagnostic verification " + diagnosticsStatus + ": " + diagnosticReason
          : "Restored and verified the last safe checkpoint after rename introduced diagnostics: " + catastrophic.messages.join("; ")
      await safety.onCatastrophic?.({
        file: view.relative(catastrophic.absolute),
        introducedErrors: catastrophic.messages.length,
        diagnostics: [...catastrophic.messages, ...evidence].join("\n").slice(0, 4000),
        restored: rollback.restored,
        fileVerified: rollback.contentVerified,
        diagnosticsVerified,
        diagnosticsStatus,
        reason: renameFailure
      })
      return false
    }
    return (await (replyChanges?.hold(rename()) ?? rename()))
      ? {
          ok: true,
          files,
          message: `Renamed to ${newName}: ${changes} changes in ${files.join(", ")}, saved.`
        }
      : { ok: false, message: renameFailure ?? "The editor refused the rename." }
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
