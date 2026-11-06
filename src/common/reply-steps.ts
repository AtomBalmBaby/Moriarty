import { getThinkingMessage, messageText } from "./text"
import type { ChatCompletionMessage, ToolStepView } from "./types"

/**
 * Steps that arrive after their reply was saved (a feedback review, which
 * runs once the reply is in) join that reply's own steps, placed at the end
 * of its text. A step already there with the same id is replaced.
 */
export const attachLateSteps = (
  message: ChatCompletionMessage,
  late: ToolStepView[]
): ChatCompletionMessage => {
  if (!late.length) return message
  const end = getThinkingMessage(messageText(message)).message.length
  const ids = new Set(late.map((step) => step.id))
  const kept = (message.toolSteps ?? []).filter((step) => !ids.has(step.id))
  return {
    ...message,
    toolSteps: [
      ...kept,
      ...late.map((step) => ({ ...step, at: step.at ?? end }))
    ]
  }
}
