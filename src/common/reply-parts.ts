import { getThinkingMessage } from "./text"
import { ChatCompletionMessage, ReasoningRoundView, ToolStepView } from "./types"

export type ReplyPart = { text: string } | { steps: ToolStepView[] } | { round: ReasoningRoundView }

/** A fence's opening line: three or more backticks or tildes, and for backticks an info string without one. */
const FENCE_OPEN = /^[ \t]{0,3}(`{3,}|~{3,})([^\n]*)$/
const FENCE_CLOSE = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/

interface Fence {
  char: string
  size: number
  /** No language, or one models wrap a tool call in: the fence may be a call's, not code. */
  wrapper: boolean
}

const CALL_FENCES = new Set(["", "json", "tool", "xml"])

const opens = (line: string): Fence | undefined => {
  const match = line.match(FENCE_OPEN)
  if (!match || (match[1][0] === "`" && match[2].includes("`"))) return undefined
  return { char: match[1][0], size: match[1].length, wrapper: CALL_FENCES.has(match[2].trim().toLowerCase()) }
}

/** A closing line for `fence`: the same character, at least as many, nothing after. */
const closes = (line: string, fence: Fence) => {
  const match = line.match(FENCE_CLOSE)
  return !!match && match[1][0] === fence.char && match[1].length >= fence.size
}

/**
 * Where a split at `at` may go so it never lands inside a code block: `at`
 * itself, or the end of the line that closes the block open there. A
 * plain (or `json`) fence opened with nothing in it yet is a stray, the
 * opening of a call the model fenced, which the loop took out; so is a
 * fence that never closes. The split then stays where the step ran.
 */
const outsideFence = (text: string, at: number) => {
  let open: Fence | undefined
  /** The open block has code in it before `at`. */
  let written = false
  let offset = 0
  for (const line of text.split("\n")) {
    const end = offset + line.length
    if (offset < at) {
      if (!open) {
        open = opens(line)
        written = false
      } else if (closes(line, open)) {
        open = undefined
      } else if (line.trim()) {
        written = true
      }
    } else if (!open || (open.wrapper && !written)) {
      return at
    } else if (closes(line, open)) {
      return end
    }
    offset = end + 1
  }
  return at
}

/** Saved activity without an order goes before ordered activity at the same place, as it always did. */
const compareOrder = (a: number | undefined, b: number | undefined) =>
  a === b ? 0 : a === undefined ? -1 : b === undefined ? 1 : a - b

type Activity = { step: ToolStepView } | { round: ReasoningRoundView }

/**
 * A reply's text cut where its tools ran and its reasoning rounds opened, with
 * each piece of activity in its place, in the order it happened: what the
 * model said, the thinking before a tool, the tool, what it said next. Runs of
 * steps with nothing between them share one part. Activity saved without a
 * place goes first, as it used to.
 */
export const replyParts = (text: string, steps?: ToolStepView[], rounds?: ReasoningRoundView[]): ReplyPart[] => {
  if (!steps?.length && !rounds?.length) return [{ text }]
  const placed = [
    ...(rounds ?? []).map((round) => ({ at: round.at, order: round.order, item: { round } as Activity })),
    ...(steps ?? []).map((step) => ({ at: step.at, order: step.order, item: { step } as Activity }))
  ].map((entry, index) => ({
    ...entry,
    index,
    at: outsideFence(text, Math.min(Math.max(entry.at ?? 0, 0), text.length))
  }))
  placed.sort((a, b) => a.at - b.at || compareOrder(a.order, b.order) || a.index - b.index)

  const parts: ReplyPart[] = []
  let from = 0
  let run: ToolStepView[] | undefined
  for (const entry of placed) {
    if (entry.at > from) {
      parts.push({ text: text.slice(from, entry.at) })
      from = entry.at
      run = undefined
    }
    if ("round" in entry.item) {
      parts.push({ round: entry.item.round })
      run = undefined
    } else if (run) {
      run.push(entry.item.step)
    } else {
      run = [entry.item.step]
      parts.push({ steps: run })
    }
  }
  if (from < text.length) parts.push({ text: text.slice(from) })
  return parts
}

/** One part of a reply, rendered as its own virtualized row. */
export type ReplyRowPart =
  | { kind: "head" }
  | { kind: "round"; round: ReasoningRoundView; active: boolean }
  | { kind: "steps"; steps: ToolStepView[] }
  | { kind: "text"; text: string }
  | { kind: "tail" }

export type ChatRowPart = { kind: "message" } | { kind: "activity" } | ReplyRowPart

export interface ChatRow {
  /** Stable across streaming, collapse, reload, and continuation; never an array index. */
  key: string
  /** The message the row belongs to, shared by every row of one assistant execution. */
  index: number
  /** The reply in progress rather than a saved message. */
  live: boolean
  part: ChatRowPart
}

export interface ChatRowsInput {
  messages: ChatCompletionMessage[]
  /** The reply streaming in, shown after the saved messages. */
  completion?: ChatCompletionMessage | null
  /** Reasoning rounds of the reply in progress. */
  reasoning?: { rounds: ReasoningRoundView[]; activeId?: string }
  /** Tool steps of the reply in progress. */
  steps?: ToolStepView[]
  /** The typing indicator shows while nothing has streamed yet. */
  pending?: boolean
}

export interface ChatRows {
  rows: ChatRow[]
  /** The first row of the last message: where its response is anchored. */
  anchor: number
}

const replyKey = (message: ChatCompletionMessage, index: number) => message.id ?? `index-${index}`

const replyRows = (
  rows: ChatRow[],
  source: ChatCompletionMessage,
  index: number,
  key: string,
  live: boolean,
  rounds: ReasoningRoundView[],
  activeId: string | undefined,
  steps: ToolStepView[] | undefined
) => {
  const content = typeof source.content === "string" ? source.content : ""
  if (!content && !source.toolSteps?.length && !steps?.length && !rounds.length) return
  const { message: text } = getThinkingMessage(content)
  const push = (suffix: string, part: ChatRowPart) => rows.push({ key: `${key}:${suffix}`, index, live, part })

  push("head", { kind: "head" })
  // Offsets into the text are keyed by where each piece starts, so a text row keeps its key as the reply grows.
  let offset = 0
  for (const part of replyParts(text, source.toolSteps ?? steps, rounds)) {
    if ("round" in part) {
      push(`round:${part.round.id}`, { kind: "round", round: part.round, active: part.round.id === activeId })
    } else if ("steps" in part) {
      push(`steps:${part.steps[0].id}`, { kind: "steps", steps: part.steps })
    } else {
      if (part.text.trim()) push(`text:${offset}`, { kind: "text", text: part.text.trim() })
      offset += part.text.length
    }
  }
  push("tail", { kind: "tail" })
}

/**
 * The rows that render a chat: one per user message, and per assistant
 * reply, a head, each reasoning round, each run of tool steps, each text
 * piece, and a tail, all in the order they happened. Rows of the reply in
 * progress take the `live` key prefix, so they keep their keys when it is
 * saved.
 */
export const buildChatRows = ({ messages, completion, reasoning, steps, pending }: ChatRowsInput): ChatRows => {
  const rows: ChatRow[] = []
  const last = messages.length - 1
  let anchor = 0
  messages.forEach((message, index) => {
    if (index === last) anchor = rows.length
    if (message.role === "user") {
      rows.push({ key: `${replyKey(message, index)}:message`, index, live: false, part: { kind: "message" } })
    } else if (message.role === "assistant") {
      replyRows(
        rows,
        message,
        index,
        replyKey(message, index),
        false,
        message.reasoningRounds ?? [],
        undefined,
        undefined
      )
    }
  })
  if (last >= 0 && completion) {
    replyRows(
      rows,
      completion,
      last,
      "live",
      true,
      reasoning ? reasoning.rounds : completion.reasoningRounds ?? [],
      reasoning?.activeId,
      steps
    )
  } else if (last >= 0 && pending) {
    rows.push({ key: "live:activity", index: last, live: true, part: { kind: "activity" } })
    for (const part of replyParts("", steps, reasoning?.rounds)) {
      if ("round" in part) {
        rows.push({
          key: `live:round:${part.round.id}`,
          index: last,
          live: true,
          part: { kind: "round", round: part.round, active: part.round.id === reasoning?.activeId }
        })
      } else if ("steps" in part) {
        rows.push({ key: `live:steps:${part.steps[0].id}`, index: last, live: true, part: { kind: "steps", steps: part.steps } })
      }
    }
  }
  return { rows, anchor }
}
