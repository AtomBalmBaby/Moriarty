import { useCallback, useEffect, useRef, useState } from "react"

import { EVENT_NAME } from "../../common/constants"
import type { ReasoningRoundView } from "../../common/types"
import { useServerEvent } from "../messaging"
import { appendReasoning, closeReasoning, LiveReasoningRound, nextActivityOrder, toReasoningViews } from "../reasoning-rounds"

/** Reasoning streams token by token; the view is updated at most every REASONING_FLUSH_MS. */
const REASONING_FLUSH_MS = 200

/**
 * The reasoning rounds of the reply being written. Deltas are batched into
 * the view; closing a round publishes at once, so a finished round never
 * shows as still streaming. A round is marked, when it opens, with how much
 * of the reply `replyText` says is written and its arrival order, so it sits
 * among the reply's tool steps as it happened. `take` hands the rounds to the
 * reply that keeps them and clears here for the next turn.
 */
export const useReasoningRounds = (replyText: () => string = () => "") => {
  const [rounds, setRounds] = useState<LiveReasoningRound[]>([])
  const roundsRef = useRef<LiveReasoningRound[]>([])
  const timerRef = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => () => clearTimeout(timerRef.current), [])

  const commit = useCallback((next: LiveReasoningRound[]) => {
    clearTimeout(timerRef.current)
    timerRef.current = undefined
    roundsRef.current = next
    setRounds(next)
  }, [])

  useServerEvent(EVENT_NAME.twinnyOnReasoning, ({ round, text }) => {
    const next = appendReasoning(roundsRef.current, round, text, Date.now(), () => ({
      at: replyText().length,
      order: nextActivityOrder()
    }))
    if (next === roundsRef.current) return
    roundsRef.current = next
    if (timerRef.current !== undefined) return
    timerRef.current = setTimeout(() => {
      timerRef.current = undefined
      setRounds(roundsRef.current)
    }, REASONING_FLUSH_MS)
  })

  /** Closes the round still streaming, if any: its answer or tool calls began, or the reply was interrupted. */
  const close = useCallback((complete: boolean) => {
    const next = closeReasoning(roundsRef.current, complete, Date.now())
    if (next !== roundsRef.current) commit(next)
  }, [commit])

  const clear = useCallback(() => commit([]), [commit])

  /** The rounds as they stand now, including deltas not yet published. */
  const snapshot = useCallback((): ReasoningRoundView[] => toReasoningViews(roundsRef.current), [])

  /** Closes what is still streaming and returns the rounds for the reply that keeps them. */
  const take = useCallback((complete: boolean): ReasoningRoundView[] | undefined => {
    const views = toReasoningViews(closeReasoning(roundsRef.current, complete, Date.now()))
    commit([])
    return views.length ? views : undefined
  }, [commit])

  return { rounds, close, clear, take, snapshot }
}
