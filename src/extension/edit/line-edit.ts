import { EndOfLine, Range, TextDocument, Uri, window, workspace } from "vscode"

import { verifyContentFingerprint } from "../tools/fingerprint"
import { contentHash, LineEditError, lineEditFailure, LineEditRequest, planLineEdits } from "../tools/line-edit"

import type { ChatEditOutcome } from "./service"

/** TextEditor.edit carries the captured document version to VS Code's main thread. */
export const applyDocumentLineEdits = async (file: string, request: LineEditRequest): Promise<ChatEditOutcome> => {
  let document: TextDocument
  try {
    document = await workspace.openTextDocument(Uri.file(file))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, message, error: lineEditFailure("document_unavailable", message) }
  }
  try {
    const original = document.getText()
    const version = document.version
    const patches = await planLineEdits(original, request, document.eol === EndOfLine.CRLF ? "\r\n" : "\n")
    const editor = await window.showTextDocument(document, { preview: true, preserveFocus: true })
    const currentHash = await contentHash(document.getText())
    const hashMatches = await verifyContentFingerprint(document.getText(), request.expected_hash)
    if (document.isClosed || document.version !== version || !hashMatches) {
      return { ok: false, message: "The document changed before the transaction.", error: lineEditFailure("hash_mismatch", "The document changed before the transaction; reread it.", currentHash) }
    }
    // No await between revalidation and the version-guarded editor transaction.
    const applied = await editor.edit((builder) => {
      for (const patch of patches) builder.replace(new Range(document.positionAt(patch.start), document.positionAt(patch.end)), patch.text)
    }, { undoStopBefore: true, undoStopAfter: true })
    if (!applied) {
      const hash = await contentHash(document.getText())
      const hashMatches = await verifyContentFingerprint(document.getText(), request.expected_hash)
      const error = !hashMatches
        ? lineEditFailure("hash_mismatch", "The document changed during the transaction; no line edits were applied. Reread it.", hash)
        : lineEditFailure("application_failed", "VS Code refused the line-edit transaction; no line edits were applied.")
      return { ok: false, message: error.message, error }
    }
    let expected = original
    for (const patch of [...patches].reverse()) expected = expected.slice(0, patch.start) + patch.text + expected.slice(patch.end)
    if (document.getText() !== expected) {
      const error = lineEditFailure("application_failed", "The document changed immediately after the transaction. Reread it; do not retry automatically.", await contentHash(document.getText()))
      return { ok: false, message: error.message, error }
    }
    return { ok: true, contentHash: await contentHash(document.getText()), message: "Applied as one undoable editor transaction. Changes remain unsaved in the editor buffer." }
  } catch (error) {
    if (error instanceof LineEditError) return { ok: false, message: error.message, error: error.detail }
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, message, error: lineEditFailure("application_failed", message) }
  }
}
