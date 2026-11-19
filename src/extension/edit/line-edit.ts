import { EndOfLine, Range, TextDocument, TextEditor, Uri, window, workspace } from "vscode"

import { contentHash, ContentSource, LineEditError, lineEditFailure, LineEditFailureCode, LineEditRequest, LinePatch, patchedText, planLineEdits } from "../tools/line-edit"

import type { ChatEditOutcome } from "./service"

/**
 * `visible`: the document is shown in a persistent tab and takes focus. `background`: it is shown without taking focus,
 * or an editor already showing it is used as it is.
 */
export type EditorVisibility = "visible" | "background"

export const UNSAVED_REQUIRES_VISIBLE = "save false is only allowed when twinny.chatToolsEditorVisibility is visible; the edit was not applied. Retry with save true, or ask the user to change the setting."

export interface DocumentEditOptions {
  /** Saves the complete resulting document. `false` leaves the edit unsaved for review, and is only allowed when `visibility` is `visible`. */
  save: boolean
  visibility: EditorVisibility
}


/** The text a file holds on disk, or undefined when its bytes cannot be read as UTF-8 or UTF-16 with a byte-order mark. */
const decodePersisted = (bytes: Uint8Array): string | undefined => {
  try {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le", { fatal: true }).decode(bytes.subarray(2))
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be", { fatal: true }).decode(bytes.subarray(2))
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
}

const failed = (code: LineEditFailureCode, message: string, current_hash?: string): ChatEditOutcome =>
  ({ ok: false, message, error: lineEditFailure(code, message, current_hash) })

/**
 * Applies the line edits to the document's current buffer, which may hold the user's unsaved changes, as one undoable
 * transaction. The document is shown first because diagnostics are only reported for documents in an editor. With
 * `save`, the complete document is then saved and read back; a save failure is reported as `save_failed`, separately
 * from an edit failure. An unsaved edit is only applied in Visible mode, so it is never left unsaved in the background.
 */
export const applyDocumentLineEdits = async (file: string, request: LineEditRequest, options: DocumentEditOptions = { save: true, visibility: "background" }): Promise<ChatEditOutcome> => {
  if (!options.save && options.visibility !== "visible") {
    return failed("permission_denied", UNSAVED_REQUIRES_VISIBLE)
  }
  let document: TextDocument
  try {
    document = await workspace.openTextDocument(Uri.file(file))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, message, error: lineEditFailure("document_unavailable", message) }
  }
  try {
    const editor = await revealEditor(document, options.visibility)
    const version = document.version
    const original = document.getText()
    const patches = await planLineEdits(original, request, document.eol === EndOfLine.CRLF ? "\r\n" : "\n")
    const expected = patchedText(original, patches)
    const notApplied = await applyTransaction(editor, document, version, original, patches)
    if (notApplied) return notApplied
    if (document.getText() !== expected) {
      return failed("application_failed", "The document changed immediately after the transaction; nothing was saved. Reread it; do not retry automatically.", await contentHash(document.getText()))
    }
    if (!options.save) {
      const message = "Applied as one undoable editor transaction and left unsaved for review. The file on disk is unchanged, so a build from disk does not include this edit."
      return { ok: true, contentHash: await contentHash(expected), contentSource: "buffer", persisted: false, message }
    }
    return await saveAndVerify(document, expected)
  } catch (error) {
    if (error instanceof LineEditError) return { ok: false, message: error.message, error: error.detail }
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, message, error: lineEditFailure("application_failed", message) }
  }
}

/**
 * The editor that shows the document, so its diagnostics are reported. Visible: a persistent tab that takes focus, in the
 * column of an editor already showing it. Background: an existing editor is used as it is; otherwise the document opens
 * as a preview tab without taking focus.
 */
export const revealEditor = async (document: TextDocument, visibility: EditorVisibility): Promise<TextEditor> => {
  const shown = window.visibleTextEditors.find((editor) => editor.document.uri.toString() === document.uri.toString())
  if (visibility === "visible") return window.showTextDocument(document, { preview: false, viewColumn: shown?.viewColumn })
  if (shown) return shown
  return window.showTextDocument(document, { preview: true, preserveFocus: true })
}

/**
 * Applies the patches in one undo transaction and returns undefined, or returns why it was not applied. The version
 * is compared synchronously just before the edit is issued, so a change made since the edit was prepared is never
 * overwritten; the caller must issue the edit without awaiting in between.
 * Patches reach this point planned bottom-to-top, so a range that changes the line count cannot move a range above it.
 */
const applyTransaction = async (editor: TextEditor, document: TextDocument, version: number, original: string, patches: LinePatch[]): Promise<ChatEditOutcome | undefined> => {
  if (document.isClosed || document.version !== version) {
    return failed("hash_mismatch", "The document changed after the edit was prepared; no line edits were applied. Reread it.", await contentHash(document.getText()))
  }
  const applied = await editor.edit((builder) => {
    for (const patch of patches) builder.replace(new Range(document.positionAt(patch.start), document.positionAt(patch.end)), patch.text)
  }, { undoStopBefore: true, undoStopAfter: true })
  if (applied) return undefined
  if (document.getText() !== original) {
    return failed("hash_mismatch", "The document changed during the transaction; no line edits were applied. Reread it.", await contentHash(document.getText()))
  }
  return failed("application_failed", "VS Code refused the line-edit transaction; no line edits were applied.")
}

/** Saves only this document, then reads the file back and checks it against the intended text. */
const saveAndVerify = async (document: TextDocument, expected: string): Promise<ChatEditOutcome> => {
  const saveProblem = async (reason: string): Promise<ChatEditOutcome> => {
    const hash = await contentHash(document.getText())
    const message = `The line edits are applied in the editor buffer but are not confirmed on disk: ${reason} Reread the file before editing again.`
    return { ok: false, message, error: lineEditFailure("save_failed", message, hash) }
  }
  try {
    const saved = await document.save()
    if (!saved || document.isDirty) return await saveProblem("VS Code did not save the document.")
  } catch (error) {
    return await saveProblem(error instanceof Error ? error.message : String(error))
  }
  let bytes: Uint8Array
  try {
    bytes = await workspace.fs.readFile(document.uri)
  } catch (error) {
    return await saveProblem(`the saved file could not be read back (${error instanceof Error ? error.message : String(error)}).`)
  }
  const persisted = decodePersisted(bytes)
  const contentSource: ContentSource = persisted === undefined ? "buffer" : "disk"
  const text = persisted ?? document.getText()
  if (persisted !== undefined && persisted !== document.getText()) {
    return await saveProblem("the file on disk differs from the saved editor buffer.")
  }
  if (text !== expected) {
    const message = "The saved file differs from the intended edit (for example, format-on-save changed it). Reread it; do not retry automatically."
    return { ok: false, message, error: lineEditFailure("application_failed", message, await contentHash(text)) }
  }
  const message = contentSource === "disk"
    ? "Applied as one undoable editor transaction and saved; the saved file was read back and matches."
    : "Applied as one undoable editor transaction and saved. The file's encoding could not be read back, so the save was checked by the editor only."
  return { ok: true, contentHash: await contentHash(text), contentSource, persisted: true, message }
}
