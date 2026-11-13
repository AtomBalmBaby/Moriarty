import React, { memo } from "react"

import { WorkspaceSearchReport } from "../common/messaging/protocol"
import { ChatCompletionMessage, MentionType, ReplyChangesView, ToolStepView } from "../common/types"

import { isPausedReply } from "./composer-operation"
import Message from "./message"
import TypingIndicator, { TypingActivity } from "./typing-indicator"

interface MessageListProps {
  message: ChatCompletionMessage
  messages: ChatCompletionMessage[]
  completion?: ChatCompletionMessage | null
  /** The workspace search for the reply in progress, shown under it. */
  context?: WorkspaceSearchReport
  /** The tool steps of the reply in progress, shown above it. */
  steps?: ToolStepView[]
  /** Inference, continuation and TODO state of the reply in progress. */
  activity?: TypingActivity
  isLoading: boolean
  index: number
  generatingRef: React.RefObject<boolean>
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
    message,
    messages,
    completion,
    context,
    steps,
    activity,
    isLoading,
    index,
    handleDeleteMessage,
    handleEditMessage,
    handleRegenerateMessage,
    handleDeleteImage,
    handleContinue,
    handleStopPausedTask,
    handleChangesUpdate
  }: MessageListProps) => {
    const isUserMessage = message?.role === "user"
    const isAgentMessage = message?.role === "assistant"
    const isLastMessage = index === messages?.length - 1
    const messageKey = `${message?.role}-0`
    const task = message?.meta?.task
    const paused = isAgentMessage && isPausedReply(messages, index)
    // The last reply that is not still running. Continue picks up a paused reply, or an out-of-steps one.
    const isLastReply = isAgentMessage && isLastMessage && !isLoading
    const canContinue = isLastReply && (paused || (!task && !!message.meta?.outOfSteps))
    // A paused task stays stoppable wherever its reply sits, even when a later message follows it.
    const canStopTask = paused
    // Shown while a step runs even between turns, such as during a Feedback review.
    const stepActive = !!steps?.some((step) => step.status === "running" || step.status === "waiting")

    return (
      <>
        {isUserMessage && (
          <Message
            key={messageKey}
            message={message}
            index={index}
            isLoading={isLoading}
            messages={messages}
            onDelete={handleDeleteMessage}
            onEdit={handleEditMessage}
            onRegenerate={handleRegenerateMessage}
            onDeleteImage={handleDeleteImage}
          />
        )}
        {isAgentMessage && (
          <Message
            key={messageKey}
            message={message}
            index={index}
            isLoading={isLoading}
            messages={messages}
            onDelete={handleDeleteMessage}
            onEdit={handleEditMessage}
            onRegenerate={handleRegenerateMessage}
            isAssistant
            paused={paused}
            onDeleteImage={handleDeleteImage}
            onContinue={canContinue ? handleContinue : undefined}
            onStopTask={canStopTask ? () => handleStopPausedTask?.(index) : undefined}
            onChangesUpdate={handleChangesUpdate}
          />
        )}
        {completion && isLastMessage && (
          <Message
            key={`completion-${messageKey}`}
            isAssistant={true}
            message={completion}
            context={context}
            steps={steps}
            index={index}
            isLoading={isLoading}
            messages={messages}
            onDelete={handleDeleteMessage}
            onEdit={handleEditMessage}
            onRegenerate={handleRegenerateMessage}
            onDeleteImage={handleDeleteImage}
          />
        )}
        {(isLoading || stepActive) && !completion && isLastMessage && (
          <TypingIndicator context={context} steps={steps} activity={activity} />
        )}
      </>
    )
  }
)

export default MessageItem
