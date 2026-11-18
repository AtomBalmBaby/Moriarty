import { ASSISTANT } from "../constants"
import type { ChatCompletionMessage } from "../types"

/** Sent by the webview when the user presses Continue on a stopped reply. */
export const CONTINUE_PROMPT = "Continue exactly where your last reply stopped. Do not repeat anything you already wrote."

/** Sent by the webview when the user presses Continue on a reply that ran out of tool steps. */
export const CARRY_ON_PROMPT = "Carry on with the task from where your last reply got to, using the tools again as you need them. Do not redo steps that already worked."

const TYPED_CONTINUE = /^(continue|resume|keep going|carry on)[.!]?$/i

/**
 * Whether a reply can be resumed: its task is paused, or, with no task, it was stopped as the last message or ran out
 * of tool steps. A closed task is not resumable. Mirrors the webview's rule for offering Continue.
 */
export const isResumableReply = (message: ChatCompletionMessage | undefined): boolean => {
  const meta = message?.meta
  if (message?.role !== ASSISTANT || !meta) return false
  if (meta.task) return meta.task.state === "paused"
  return !!meta.stopped || !!meta.outOfSteps
}

/** Whether a user message only asks to carry on, whether it came from the Continue button or was typed. */
export const isContinuationText = (text: string): boolean => {
  const trimmed = text.trim()
  return trimmed === CONTINUE_PROMPT || trimmed === CARRY_ON_PROMPT || TYPED_CONTINUE.test(trimmed)
}

/**
 * The request the latest user message carries on from: the latest earlier
 * text that is not itself a continuation. `userTexts` holds each user
 * message's text, oldest first. A continuation with no earlier request is
 * returned as it is.
 */
export const requestBehindContinuation = (userTexts: string[]): string | undefined => {
  const latest = userTexts.at(-1)
  if (latest === undefined || !isContinuationText(latest)) return latest
  for (let index = userTexts.length - 2; index >= 0; index -= 1) {
    if (!isContinuationText(userTexts[index])) return userTexts[index]
  }
  return latest
}
