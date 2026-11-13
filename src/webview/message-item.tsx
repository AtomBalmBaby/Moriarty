import React, { memo } from "react"

import { WorkspaceSearchReport } from "../common/messaging/protocol"
import type { ChatRow } from "../common/reply-parts"
import { ChatCompletionMessage, MentionType, ReplyChangesView, ToolStepView } from "../common/types"

import { continuablePausedIndex, isPausedReply } from "./composer-operation"
import Message from "./message"
import { ReasoningRound } from "./reasoning-block"
import ToolSteps from "./tool-steps"
import TypingIndicator, { TypingActivity } from "./typing-indicator"

import styles from "./styles/typing-indicator.module.css"

interface MessageListProps {
  /** The one row this renders; a reply is several rows that share its message. */
  row: ChatRow
  messages: ChatCompletionMessage[]
  completion?: ChatCompletionMessage | null
  /** The workspace search for the reply in progress, shown under it. */
  context?: WorkspaceSearchReport
  /** The tool steps of the reply in progress, shown above it. */
  steps?: ToolStepView[]
  /** Inference, continuation and TODO state of the reply in progress. */
  activity?: TypingActivity
  isLoading: boolean
  handleDeleteMessage: (index: number) => void
  handleEditMessage: (
    message: string,
    index: number,
    mentions: MentionType[] | undefined
  ) => void
  handleRegenerateMessage: (
    index: number,
    mentions: MentionType[] | undefined
  ) => void
  handleDeleteImage?: (id: string) => void
  handleContinue?: () => void
  handleStopPausedTask?: (index: number) => void
  handleChangesUpdate?: (index: number, changes: ReplyChangesView) => void
}

const MessageItem = memo(
  ({
    row,
    messages,
    completion,
    context,
    steps,
    activity,
    isLoading,
    handleDeleteMessage,
    handleEditMessage,
    handleRegenerateMessage,
    handleDeleteImage,
    handleContinue,
    handleStopPausedTask,
    handleChangesUpdate
  }: MessageListProps) => {
    const { part } = row
    if (part.kind === "activity") {
      return <TypingIndicator context={context} steps={steps} activity={activity} />
    }
    // Rounds and steps that arrive before any text is written.
    if (row.live && !completion) {
      if (part.kind === "round") {
        return (
          <div className={styles.pendingPart}>
            <ReasoningRound round={part.round} active={part.active} />
          </div>
        )
      }
      if (part.kind === "steps") {
        return (
          <div className={styles.pendingPart}>
            <div className={styles.context}>
              <ToolSteps steps={part.steps} />
            </div>
          </div>
        )
      }
      return null
    }
    const index = row.index
    const message = row.live ? completion : messages[index]
    if (!message) return null
    if (part.kind === "message") {
      return (
        <Message
          message={message}
          index={index}
          isLoading={isLoading}
          messages={messages}
          onDelete={handleDeleteMessage}
          onEdit={handleEditMessage}
          onRegenerate={handleRegenerateMessage}
          onDeleteImage={handleDeleteImage}
        />
      )
    }

    // A saved reply keeps its pause and continuation controls; the reply in progress has none.
    const isLastMessage = index === messages.length - 1
    const paused = !row.live && isPausedReply(messages, index)
    // Continue picks up the paused reply that no user turn has followed, even when host notices came after it.
    const continuable = !row.live && continuablePausedIndex(messages) === index
    // The last reply that is not still running can pick up where it ran out of steps.
    const isLastReply = !row.live && isLastMessage && !isLoading
    const canContinue = continuable || (isLastReply && !message.meta?.task && !!message.meta?.outOfSteps)
    // A paused task stays stoppable wherever its reply sits, even when a later message follows it.
    const canStopTask = paused

    return (
      <Message
        message={message}
        part={part}
        index={index}
        isAssistant
        isLoading={isLoading}
        messages={messages}
        context={row.live ? context : undefined}
        onDelete={handleDeleteMessage}
        onEdit={handleEditMessage}
        onRegenerate={handleRegenerateMessage}
        paused={paused}
        onDeleteImage={handleDeleteImage}
        onContinue={canContinue ? handleContinue : undefined}
        onStopTask={canStopTask ? () => handleStopPausedTask?.(index) : undefined}
        onChangesUpdate={row.live ? undefined : handleChangesUpdate}
      />
    )
  }
)

export default MessageItem
