import type { EntireChatExportRequest } from "../../common/messaging/protocol"

/** The outside world the export reaches: injected so the failures can be tested. */
export interface EntireChatExportDeps {
  redact: (text: string) => string
  writeClipboard: (text: string) => Promise<void>
  /** Resolves to where the file was written, or undefined when the user cancelled. */
  saveMarkdown: (text: string) => Promise<string | undefined>
  notify: (level: "info" | "error", message: string) => void
}

export const EMPTY_CHAT_MESSAGE = "There is no conversation to export yet."

const describe = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

/**
 * Delivers a whole-chat export: secrets are redacted first, then the text
 * goes to the clipboard or a file the user picks. Every outcome is reported.
 */
export const deliverEntireChat = async (
  { action, markdown }: EntireChatExportRequest,
  deps: EntireChatExportDeps
): Promise<void> => {
  if (!markdown.trim()) {
    deps.notify("error", EMPTY_CHAT_MESSAGE)
    return
  }
  const text = deps.redact(markdown)
  if (action === "copy") {
    try {
      await deps.writeClipboard(text)
      deps.notify("info", "Entire chat copied to the clipboard.")
    } catch (error) {
      deps.notify(
        "error",
        `Could not copy the chat to the clipboard: ${describe(error)}`
      )
    }
    return
  }
  try {
    const location = await deps.saveMarkdown(text)
    if (location) deps.notify("info", `Entire chat saved to ${location}.`)
  } catch (error) {
    deps.notify("error", `Could not save the chat: ${describe(error)}`)
  }
}
