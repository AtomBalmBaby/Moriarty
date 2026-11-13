/**
 * The composer's Pause/Send state. It follows the host's operation lifecycle:
 * an operation opens when the host starts working on a message and closes at
 * its terminal event. A paused operation is not busy: the composer accepts
 * new messages, and only an explicit Continue resumes the paused reply.
 */

import type { ReplyMeta } from "../common/types"

export type ComposerOperationPhase = "idle" | "running" | "paused"

export type ComposerOperationEvent =
  | { type: "started" }
  | { type: "submitted" }
  | { type: "pause-requested" }
  | { type: "continue-requested" }
  | { type: "stop-requested" }
  | { type: "terminal"; paused?: boolean }

export const reduceComposerOperation = (
  phase: ComposerOperationPhase,
  event: ComposerOperationEvent
): ComposerOperationPhase => {
  switch (event.type) {
    case "started":
      // Only idle begins work: a late start cannot undo a pause.
      return phase === "idle" ? "running" : phase
    case "submitted":
      // A new message is independent work, so it starts whatever phase the composer is in.
      return "running"
    case "pause-requested":
      return phase === "running" ? "paused" : phase
    case "continue-requested":
      // Only an explicit Continue resumes a paused operation.
      return phase === "paused" ? "running" : phase
    case "stop-requested":
      // Stop ends the paused reply's task; a running operation keeps going until its terminal.
      return phase === "paused" ? "idle" : phase
    case "terminal":
      // The host's terminal ends the operation, or leaves it paused for a Continue.
      return event.paused ? "paused" : "idle"
  }
}

/** Only running work is busy: a paused task leaves the composer usable and the chevron still. */
export const composerIsBusy = (phase: ComposerOperationPhase): boolean => phase === "running"

type ReplyMessage = { role?: string; meta?: ReplyMeta }

/**
 * Whether the reply at `index` is a paused task that Continue or Stop can act on.
 * Replies saved before tasks existed are paused when they were stopped and are
 * still the last message, which is when the old UI offered Continue.
 */
export const isPausedReply = <M extends ReplyMessage>(messages: M[], index: number): boolean => {
  const meta = messages[index]?.meta
  if (!meta) return false
  if (meta.task) return meta.task.state === "paused"
  return !!meta.stopped && index === messages.length - 1
}

/**
 * The paused reply that Continue acts on: the newest paused reply with no user
 * turn after it. Host notices, such as a plan status or a pause reason, may
 * follow the reply without ending it. -1 when none is continuable.
 */
export const continuablePausedIndex = <M extends ReplyMessage>(messages: M[]): number => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return -1
    if (isPausedReply(messages, index)) return index
  }
  return -1
}

/**
 * Ends the paused reply's task for good. It reads stopped, keeps its content,
 * and loses the paused state, so Continue is no longer offered. Anything that
 * is not a paused reply is returned unchanged, so repeats are no-ops.
 */
export const stopPausedReply = <M extends ReplyMessage>(messages: M[], index: number): M[] => {
  const message = messages[index]
  if (!message?.meta || !isPausedReply(messages, index)) return messages
  const meta: ReplyMeta = {
    ...message.meta,
    stopped: true,
    task: { ...message.meta.task, state: "stopped" }
  }
  return messages.map((item, position) => (position === index ? { ...item, meta } : item))
}

/**
 * Hands the continuable paused task to a new continuation: it stops reading
 * paused or stopped and no longer offers Continue. Only the reply Continue is
 * offered on can resume, so a user turn after a paused reply leaves it alone.
 */
export const resumePausedReply = <M extends ReplyMessage>(messages: M[]): M[] => {
  const index = continuablePausedIndex(messages)
  if (index === -1) return messages
  const paused = messages[index]
  const meta: ReplyMeta = { ...paused.meta }
  delete meta.stopped
  delete meta.task
  return messages.map((message, position) => (position === index ? { ...message, meta } : message))
}
