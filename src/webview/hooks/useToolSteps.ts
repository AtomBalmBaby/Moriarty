import { useCallback, useRef, useState } from "react"

import { EVENT_NAME } from "../../common/constants"
import { ToolStepView } from "../../common/types"
import { useServerEvent } from "../messaging"
import { nextActivityOrder } from "../reasoning-rounds"

/**
 * The tool steps of the reply being written. The extension sends the whole
 * list whenever a step starts, finishes or waits for the user; the chat
 * shows it over the pending reply, then takes it with the reply itself and
 * clears here for the next turn. The ref lets an event handler read the
 * latest list without a stale closure.
 *
 * Each step is marked, when first seen, with how much of the reply
 * `replyText` says is written, and its arrival order, so it shows at that
 * point in the reply among the reasoning rounds.
 */
export const useToolSteps = (replyText: () => string = () => "") => {
  const [steps, setSteps] = useState<ToolStepView[]>([])
  const stepsRef = useRef<ToolStepView[]>([])
  const placeRef = useRef(new Map<string, Pick<ToolStepView, "at" | "order">>())

  useServerEvent(EVENT_NAME.twinnyToolSteps, (incoming) => {
    const places = placeRef.current
    stepsRef.current = (incoming ?? []).map((step) => {
      if (!places.has(step.id)) places.set(step.id, { at: replyText().length, order: nextActivityOrder() })
      return { ...step, ...places.get(step.id) }
    })
    setSteps(stepsRef.current)
  })

  const clear = useCallback(() => {
    stepsRef.current = []
    placeRef.current = new Map()
    setSteps([])
  }, [])

  /** The steps so far, if any, and forgets them. */
  const take = useCallback(() => {
    const current = stepsRef.current
    clear()
    return current.length ? current : undefined
  }, [clear])

  return { steps, clear, take }
}
