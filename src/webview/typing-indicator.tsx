import React, { useEffect, useMemo, useState } from "react"

import { TWINNY } from "../common/constants"
import { WorkspaceSearchReport } from "../common/messaging/protocol"
import { replyParts } from "../common/reply-parts"
import { ToolStepView } from "../common/types"

import { ReasoningRound } from "./reasoning-block"
import type { ReasoningView } from "./reasoning-rounds"
import ToolSteps from "./tool-steps"
import WorkspaceContext from "./workspace-context"

import styles from "./styles/typing-indicator.module.css"

/** What the chat knows about the turn in progress; nothing here is inferred from text. */
export interface TypingActivity {
  /** Reasoning the provider streamed for this turn; no rounds when it exposes none. */
  reasoning: ReasoningView
  /** Automatic turns after the first in this request. */
  continuation: number
  /** The TODO item marked in progress, when there is one. */
  activeTask?: string
  /** Feedback is planning the TODO list. */
  feedbackPlanning: boolean
  /** The agent's state glyph and label, the same ones the agent picker shows. */
  status?: { glyph: string; label: string }
  /** TODO items verified complete, out of all items in the list. */
  verified?: { done: number; total: number }
}

interface TypingIndicatorProps {
  /** The workspace search running for the reply that is on its way. */
  context?: WorkspaceSearchReport
  /** Tools the model is using before it has written anything. */
  steps?: ToolStepView[]
  activity?: TypingActivity
}

const phaseOf = (steps: ToolStepView[] | undefined, activity: TypingActivity | undefined): string => {
  const waiting = steps?.find((step) => step.status === "waiting")
  if (waiting) return "Waiting for your approval"
  const running = steps?.find((step) => step.status === "running")
  if (running) return `Running ${running.name}`
  if (activity?.feedbackPlanning) return "Feedback is reviewing the plan"
  return activity?.reasoning.activeId ? "Thinking" : "Generating"
}

const TypingIndicator = ({ context, steps, activity }: TypingIndicatorProps) => {
  const [seconds, setSeconds] = useState(0)
  // Nothing is written yet, so every round and step sits at the start, ordered by when it arrived.
  const parts = useMemo(() => replyParts("", steps, activity?.reasoning.rounds), [steps, activity?.reasoning.rounds])

  useEffect(() => {
    const started = Date.now()
    const timer = window.setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000)
    return () => window.clearInterval(timer)
  }, [])

  return (
    <div className={styles.pending}>
      <div className={styles.label}>
        <span>{TWINNY}</span>
        <span className={styles.cursor} aria-hidden="true" />
      </div>
      <div className={styles.activity}>
        {activity?.status && <span title={activity.status.label} aria-label={activity.status.label}>{activity.status.glyph}</span>}
        <span>{phaseOf(steps, activity)}</span>
        <span>{seconds}s</span>
        {!!activity?.continuation && <span>continuation {activity.continuation}</span>}
        {activity?.activeTask && <span>task: {activity.activeTask}</span>}
        {!!activity?.verified?.total && <span>verified {activity.verified.done}/{activity.verified.total}</span>}
      </div>
      {context && (
        <div className={styles.context}>
          <WorkspaceContext report={context} />
        </div>
      )}
      {parts.map((part, i) =>
        "round" in part ? (
          <ReasoningRound
            key={`round:${part.round.id}`}
            round={part.round}
            active={part.round.id === activity?.reasoning.activeId}
          />
        ) : "steps" in part ? (
          <div key={i} className={styles.context}>
            <ToolSteps steps={part.steps} />
          </div>
        ) : null
      )}
    </div>
  )
}

export default TypingIndicator
