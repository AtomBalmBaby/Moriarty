/**
 * Provider reasoning, grouped into rounds. A round is one request's thinking:
 * it opens with its first streamed text and closes when its answer or tool
 * calls begin (complete), or when the reply is paused or stopped (interrupted).
 * Only a complete round has a duration, since only then are both ends seen.
 */

import type { ReasoningRoundView } from "../common/types"

export interface LiveReasoningRound extends ReasoningRoundView {
  startedAt: number
  /** Unset while the round is still streaming. */
  endedAt?: number
}

export interface ReasoningView {
  rounds: ReasoningRoundView[]
  /** The round still streaming, if any. */
  activeId?: string
}

/** Adds streamed text to its round, opening a new round when the id is new. */
export const appendReasoning = (rounds: LiveReasoningRound[], round: string, text: string, now: number): LiveReasoningRound[] => {
  const index = rounds.findIndex((item) => item.id === round)
  if (index !== -1) {
    // Text for a round that already closed arrived late, and does not reopen it.
    if (rounds[index].endedAt !== undefined) return rounds
    return rounds.map((item, position) => (position === index ? { ...item, text: item.text + text } : item))
  }
  return [...closeReasoning(rounds, true, now), { id: round, text, complete: false, startedAt: now }]
}

/** Closes every round still streaming; a round that is not complete was interrupted. */
export const closeReasoning = (rounds: LiveReasoningRound[], complete: boolean, now: number): LiveReasoningRound[] =>
  rounds.some((item) => item.endedAt === undefined)
    ? rounds.map((item) => (item.endedAt === undefined ? { ...item, complete, endedAt: now } : item))
    : rounds

/** The rounds a reply keeps, without the ones that never got text. */
export const toReasoningViews = (rounds: LiveReasoningRound[]): ReasoningRoundView[] =>
  rounds
    .filter((item) => item.text.trim())
    .map(({ id, text, complete, startedAt, endedAt }) => ({
      id,
      text,
      complete,
      ...(complete && endedAt !== undefined ? { durationMs: Math.max(0, endedAt - startedAt) } : {})
    }))

/** Earlier rounds of a reply, then the later ones; a round kept twice counts once. */
export const mergeReasoningRounds = (
  earlier: ReasoningRoundView[] | undefined,
  later: ReasoningRoundView[] | undefined
): ReasoningRoundView[] | undefined => {
  if (!earlier?.length) return later?.length ? later : undefined
  if (!later?.length) return earlier
  const kept = new Set(later.map((item) => item.id))
  return [...earlier.filter((item) => !kept.has(item.id)), ...later]
}

export const activeReasoningId = (rounds: LiveReasoningRound[]): string | undefined =>
  rounds.find((item) => item.endedAt === undefined)?.id
