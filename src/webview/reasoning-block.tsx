import React, { useState } from "react"
import { useTranslation } from "react-i18next"

import { formatDuration } from "../common/time"
import type { ReasoningRoundView } from "../common/types"

import type { ReasoningView } from "./reasoning-rounds"

import styles from "./styles/message.module.css"

/**
 * The reader's open or closed choice for each round, kept for the life of the
 * page. The live block and the saved reply are different components, so this
 * is what keeps a choice made while thinking through the hand-over.
 */
const choices = new Map<string, boolean>()
const CHOICE_LIMIT = 500

const rememberChoice = (id: string, open: boolean) => {
  if (choices.size >= CHOICE_LIMIT) choices.clear()
  choices.set(id, open)
}

interface ReasoningRoundProps {
  round: ReasoningRoundView
  active: boolean
  interrupted?: "paused" | "stopped"
}

export const ReasoningRound = ({ round, active, interrupted }: ReasoningRoundProps) => {
  const { t } = useTranslation()
  const [choice, setChoice] = useState<boolean | undefined>(() => choices.get(round.id))
  // Streaming opens the round; finishing collapses it unless the reader chose otherwise.
  const open = choice ?? active

  const toggle = () => {
    rememberChoice(round.id, !open)
    setChoice(!open)
  }

  const label = active
    ? t("reasoning-thinking")
    : round.complete
      ? round.durationMs !== undefined
        ? t("reasoning-thought-for", { duration: formatDuration(round.durationMs) })
        : t("reasoning-thought")
      : interrupted === "paused"
        ? t("reasoning-paused")
        : t("reasoning-stopped")

  return (
    <div className={styles.thinkingSection} data-reasoning-state={active ? "active" : round.complete ? "complete" : interrupted ?? "stopped"}>
      <div
        className={styles.thinkingHeader}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault()
            toggle()
          }
        }}
      >
        <span>{label}</span>
        <span className={`codicon ${open ? "codicon-chevron-down" : "codicon-chevron-right"}`} aria-hidden="true" />
      </div>
      {open && <div className={`${styles.thinkingContent} ${styles.reasoningText}`}>{round.text}</div>}
    </div>
  )
}

interface ReasoningBlockProps {
  reasoning: ReasoningView
  /** How the reply was interrupted: an unfinished round reads paused or stopped. */
  interrupted?: "paused" | "stopped"
}

/** The provider's reasoning for a reply, one collapsible block per round. Nothing renders without rounds. */
const ReasoningBlock = ({ reasoning, interrupted }: ReasoningBlockProps) => {
  if (!reasoning.rounds.length) return null
  return (
    <>
      {reasoning.rounds.map((round) => (
        <ReasoningRound
          key={round.id}
          round={round}
          active={round.id === reasoning.activeId}
          interrupted={interrupted}
        />
      ))}
    </>
  )
}

export default ReasoningBlock
