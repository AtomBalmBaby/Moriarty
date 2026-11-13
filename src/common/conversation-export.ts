/**
 * A whole conversation as one Markdown document, built from the chat's
 * messages (never the rendered DOM): every message, tool call, feedback
 * review and automatic continuation, in the order they happened. Pure, so
 * the webview builds it and the tests run it without VS Code.
 */
import * as cheerio from "cheerio"

import { ASSISTANT, CONTINUATION_PREFIX, TWINNY, USER, YOU } from "./constants"
import { closes, Fence, opens, replyParts } from "./reply-parts"
import { getThinkingMessage, messageText } from "./text"
import type {
  ChatCompletionMessage,
  ExecutionDiagnostic,
  ReasoningRoundView,
  ReplyChangesView,
  ToolStepView
} from "./types"

export interface ConversationExportOptions {
  title?: string
  /** The reply still streaming when the chat was exported: what had been written so far. */
  inProgress?: ChatCompletionMessage | null
  exportedAt?: Date
}

/** The parts of a parsed HTML node this exporter reads. */
interface HtmlNode {
  type: string
  name?: string
  data?: string
  attribs?: Record<string, string>
  children?: HtmlNode[]
}

const tagName = (node: HtmlNode): string | undefined =>
  node.type === "tag" || node.type === "script" || node.type === "style"
    ? node.name?.toLowerCase()
    : undefined

/** The text inside a node, with line breaks kept and images named. */
const plainText = (node: HtmlNode): string => {
  if (node.type === "text") return node.data ?? ""
  const tag = tagName(node)
  if (tag === "br") return "\n"
  if (tag === "img") return "[image]"
  if (tag === "script" || tag === "style") return ""
  return (node.children ?? []).map(plainText).join("")
}

/** A code block, fenced with more backticks than any run inside it. */
const fenced = (text: string) => {
  const longest = Math.max(
    0,
    ...(text.match(/`+/g) ?? []).map((run) => run.length)
  )
  const fence = "`".repeat(Math.max(3, longest + 1))
  return `${fence}\n${text.replace(/\n$/, "")}\n${fence}`
}

const inlineCode = (text: string) => {
  const longest = Math.max(
    0,
    ...(text.match(/`+/g) ?? []).map((run) => run.length)
  )
  const ticks = "`".repeat(longest + 1)
  return `${ticks}${text}${ticks}`
}

/**
 * A composer's HTML as the Markdown it was typed as: line breaks kept,
 * paragraphs and lists kept, code blocks fenced, no tags left behind.
 */
export const htmlToMarkdown = (html: string): string => {
  const render = (node: HtmlNode): string => {
    if (node.type === "text") return node.data ?? ""
    const tag = tagName(node)
    const inner = () => (node.children ?? []).map(render).join("")
    switch (tag) {
      case "br":
        return "\n"
      case "img":
        return "[image]"
      case "pre":
        return `\n${fenced(plainText(node).replace(/\n$/, ""))}\n`
      case "code": {
        const code = plainText(node)
        return code.includes("\n") ? `\n${fenced(code)}\n` : inlineCode(code)
      }
      case "p":
      case "div":
        return `\n${inner()}\n`
      case "blockquote":
        return `\n${inner()
          .trim()
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n")}\n`
      case "li":
        return `\n- ${inner().trim()}`
      case "ul":
      case "ol":
        return `${inner()}\n`
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6":
        return `\n${"#".repeat(Number(tag?.slice(1)))} ${inner().trim()}\n`
      case "strong":
      case "b":
        return inner().trim() ? `**${inner()}**` : ""
      case "em":
      case "i":
        return inner().trim() ? `*${inner()}*` : ""
      case "a": {
        const href = node.attribs?.href
        return href ? `[${inner()}](${href})` : inner()
      }
      default:
        return inner()
    }
  }
  const body = cheerio.load(html)("body").get(0) as unknown as
    HtmlNode | undefined
  return render({ type: "root", children: body?.children })
    .replace(/\r\n?/g, "\n")
    .replace(/^\n+/, "")
    .replace(/\s+$/, "")
}

const STATUS_LABEL: Record<ToolStepView["status"], string> = {
  running: "still running when exported",
  waiting: "waiting for approval when exported, not run",
  done: "succeeded",
  failed: "failed",
  skipped: "skipped, not run",
  stopped: "stopped before it finished"
}

const note = (text: string) => `_${text}_`

const quoted = (label: string, text: string) =>
  `> **${label}:**\n${text
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n")}`

const isSpace = (ch: string | undefined) => ch === undefined || /\s/.test(ch)
const isPunct = (ch: string | undefined) =>
  ch !== undefined && /[\p{P}\p{S}]/u.test(ch)

interface Delimiter {
  char: string
  start: number
  end: number
  size: number
  /** Characters closed at the front of the run, and opened at its back. */
  front: number
  back: number
  canOpen: boolean
  canClose: boolean
}

const remaining = (run: Delimiter) => run.size - run.front - run.back

const backtickRun = (text: string, from: number) => {
  let end = from
  while (text[end] === "`") end++
  return end - from
}

/** Where the next backtick run of exactly `size` starts at or after `from`, or -1. */
const closingBacktickRun = (text: string, from: number, size: number) => {
  let at = from
  while (at < text.length) {
    if (text[at] !== "`") {
      at++
      continue
    }
    const run = backtickRun(text, at)
    if (run === size) return at
    at += run
  }
  return -1
}

/**
 * Escapes the inline delimiters of one paragraph that have no partner in it,
 * so each reads as the character it was. Matched pairs, code spans and
 * existing escapes stay as written. Emphasis is matched the way CommonMark
 * matches it, minus the rule of three.
 */
const escapeUnpairedDelimiters = (text: string): string => {
  const literal = new Array<boolean>(text.length).fill(false)
  // Link targets and bare URLs are not prose: their underscores and asterisks are part of the address.
  for (const match of text.matchAll(/\]\([^)\s]*\)|<[^>\s]+>|https?:\/\/\S+/g)) {
    literal.fill(true, match.index ?? 0, (match.index ?? 0) + match[0].length)
  }
  for (let at = 0; at < text.length; ) {
    if (text[at] === "\\") {
      literal[at] = true
      if (at + 1 < text.length) literal[at + 1] = true
      at += 2
    } else if (text[at] === "`") {
      const size = backtickRun(text, at)
      const close = closingBacktickRun(text, at + size, size)
      if (close === -1) {
        at += size
      } else {
        literal.fill(true, at, close + size)
        at = close + size
      }
    } else {
      at++
    }
  }

  const runs: Delimiter[] = []
  const stray: Array<[number, number]> = []
  for (let at = 0; at < text.length; ) {
    const char = text[at]
    if (literal[at] || !"*_~`".includes(char)) {
      at++
      continue
    }
    let end = at
    while (end < text.length && text[end] === char && !literal[end]) end++
    if (char === "`") {
      stray.push([at, end])
    } else {
      const before = text[at - 1]
      const after = text[end]
      const leftFlanking =
        !isSpace(after) && (!isPunct(after) || isSpace(before) || isPunct(before))
      const rightFlanking =
        !isSpace(before) && (!isPunct(before) || isSpace(after) || isPunct(after))
      runs.push({
        char,
        start: at,
        end,
        size: end - at,
        front: 0,
        back: 0,
        canOpen: char === "_" ? leftFlanking && (!rightFlanking || isPunct(before)) : leftFlanking,
        canClose: char === "_" ? rightFlanking && (!leftFlanking || isPunct(after)) : rightFlanking
      })
    }
    at = end
  }

  const openers: Delimiter[] = []
  for (const run of runs) {
    if (run.canClose) {
      while (remaining(run) > 0) {
        let k = openers.length - 1
        while (
          k >= 0 &&
          !(
            openers[k].char === run.char &&
            remaining(openers[k]) > 0 &&
            (run.char !== "~" || openers[k].size === run.size)
          )
        )
          k--
        if (k < 0) break
        const opener = openers[k]
        const used = Math.min(2, remaining(opener), remaining(run))
        opener.back += used
        run.front += used
        openers.length = k + 1
        if (remaining(opener) === 0) openers.pop()
      }
    }
    if (run.canOpen && remaining(run) > 0) openers.push(run)
  }

  const escape = new Array<boolean>(text.length).fill(false)
  for (const run of runs) {
    if (!run.canOpen && !run.canClose) continue
    for (let at = run.start + run.front; at < run.end - run.back; at++) escape[at] = true
  }
  for (const [start, end] of stray) {
    for (let at = start; at < end; at++) escape[at] = true
  }
  return Array.from(text, (char, at) => (escape[at] ? `\\${char}` : char)).join("")
}

/**
 * Model text is cut at tool calls and reasoning rounds, so emphasis, code
 * spans and fences opened before a cut may have no close in their own piece,
 * and would run into what follows. Each piece is balanced on its own: unpaired
 * delimiters are escaped and a fence still open at the end is closed. Nothing
 * else is changed.
 */
const balanceMarkup = (text: string): string => {
  const out: string[] = []
  let paragraph: string[] = []
  let fence: Fence | undefined
  const endParagraph = () => {
    if (!paragraph.length) return
    out.push(escapeUnpairedDelimiters(paragraph.join("\n")))
    paragraph = []
  }
  for (const line of text.split("\n")) {
    if (fence) {
      out.push(line)
      if (closes(line, fence)) fence = undefined
      continue
    }
    const opening = opens(line)
    if (opening) {
      endParagraph()
      fence = opening
      out.push(line)
    } else if (line.trim()) {
      paragraph.push(line)
    } else {
      endParagraph()
      out.push(line)
    }
  }
  endParagraph()
  if (fence) out.push(fence.char.repeat(fence.size))
  return out.join("\n")
}

const formatSeconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`

const renderRound = (round: ReasoningRoundView, inProgress: boolean): string => {
  const timing = round.durationMs !== undefined ? `, ${formatSeconds(round.durationMs)}` : ""
  const state = round.complete
    ? ""
    : inProgress
      ? ", in progress when exported"
      : ", interrupted"
  return quoted(`Reasoning${timing}${state}`, balanceMarkup(round.text.trim()))
}

const renderFeedback = (step: ToolStepView): string => {
  const verdict =
    step.status === "running"
      ? "in progress when exported"
      : step.status === "done"
        ? "accepted"
        : step.status === "failed"
          ? "rejected"
          : STATUS_LABEL[step.status]
  return [
    `#### Feedback review: ${verdict}`,
    "",
    "Verdict:",
    "",
    fenced(step.output ?? step.summary)
  ].join("\n")
}

const renderTool = (step: ToolStepView): string => {
  const kind = step.name.startsWith("twinny_todo") ? "TODO tool" : "Tool"
  const lines = [
    `#### ${kind}: \`${step.name}\` (${STATUS_LABEL[step.status]})`,
    "",
    `Summary: ${step.summary}`,
    ""
  ]
  const args = Object.entries(step.args ?? {})
  if (args.length) {
    lines.push(
      "Arguments:",
      "",
      fenced(args.map(([name, value]) => `${name}: ${value}`).join("\n"))
    )
  } else {
    lines.push("Arguments: none")
  }
  if (step.argsOmitted) {
    lines.push(
      "",
      note(
        `${step.argsOmitted} characters of arguments were cut before they were saved; the rest is unavailable.`
      )
    )
  }
  lines.push("")
  if (step.output !== undefined) {
    lines.push("Output:", "", fenced(step.output))
    if (step.outputOmitted) {
      lines.push(
        "",
        note(
          `Output truncated: ${step.outputOmitted} characters were not kept, so the full output is unavailable.`
        )
      )
    }
  } else if (step.status === "skipped") {
    lines.push("Output: none, the step was not run.")
  } else if (step.status === "running" || step.status === "waiting") {
    lines.push(
      "Output: not available, the step had not finished when exported."
    )
  } else {
    lines.push("Output unavailable: it was not saved with this chat.")
  }
  return lines.join("\n")
}

const renderStep = (step: ToolStepView): string => {
  if (step.said) return quoted(`${YOU} (during this reply)`, step.summary)
  if (step.name === "feedback") return renderFeedback(step)
  return renderTool(step)
}

const renderChanges = (changes: ReplyChangesView | undefined): string => {
  if (!changes?.files.length) return ""
  const files = changes.files.map((file) => {
    const notes = [
      file.undone ? "put back" : "",
      file.noUndo ? "no copy kept, cannot be undone" : ""
    ].filter(Boolean)
    return `- \`${file.path}\`: ${file.status}, +${file.added} −${file.removed}${notes.length ? ` (${notes.join("; ")})` : ""}`
  })
  return ["Files changed by this reply:", "", ...files].join("\n")
}

const EXECUTION_OUTCOME: Record<ExecutionDiagnostic["outcome"], string> = {
  stalled: "Execution stalled before its task was verified complete.",
  delivery_rejected: "Delivery rejected; the answer was withheld and not delivered.",
  failed: "Execution failed; the answer was not delivered.",
  cancelled: "Execution cancelled; the answer was not delivered."
}

const renderExecution = (execution: ExecutionDiagnostic): string => {
  const rows = [
    `- Conversation: \`${execution.conversationId}\``,
    execution.planId ? `- Plan: \`${execution.planId}\`` : "",
    execution.reconciliation ? `- Reconciliation: ${execution.reconciliation}` : "",
    execution.verdict ? `- Delivery verdict: ${execution.verdict}${execution.verdictDetail ? `: ${execution.verdictDetail}` : ""}` : "",
    execution.correction ? `- Corrective instruction: ${execution.correction}` : "",
    `- Answer withheld: ${execution.answerWithheld ? "yes" : "no"}`,
    `- Reason: ${execution.reason}`
  ]
  return ["Execution diagnostic:", "", ...rows.filter(Boolean)].join("\n")
}

const replyStatus = (
  message: ChatCompletionMessage,
  inProgress: boolean,
  stalledAfter: boolean
): string => {
  if (inProgress)
    return "**Status:** in progress when exported; this is what had been written so far."
  const meta = message.meta
  if (meta?.execution) return `**Status:** ${EXECUTION_OUTCOME[meta.execution.outcome]}`
  if (stalledAfter)
    return `**Status:** ${EXECUTION_OUTCOME.stalled} The task stayed unresolved after this reply; see the stop message that follows.`
  const steps = message.toolSteps ?? []
  const parts: string[] = []
  if (meta?.task?.state === "paused")
    parts.push("Paused by you before it finished; it has not been continued.")
  else if (meta?.stopped) parts.push("Stopped by you before it finished.")
  if (meta?.outOfSteps)
    parts.push("Stopped at the tool-step limit; the work may be unfinished.")
  if (
    steps.some((step) => step.status === "running" || step.status === "waiting")
  ) {
    parts.push(
      "Some tool steps were still running or waiting when the chat was exported."
    )
  }
  const failed = steps.filter((step) => step.status === "failed").length
  if (failed)
    parts.push(`${failed} tool step${failed === 1 ? "" : "s"} failed.`)
  if (!parts.length) parts.push("Completed.")
  return `**Status:** ${parts.join(" ")}`
}

const renderWithheld = (message: ChatCompletionMessage): string => {
  const withheld = message.meta?.withheld ?? []
  if (!withheld.length) return ""
  const kinds = withheld
    .map((item) => `${item.count} × ${item.label}`)
    .join(", ")
  return note(`Credentials withheld before sending to the model: ${kinds}.`)
}

const renderUnverified = (message: ChatCompletionMessage): string => {
  const unverified = message.meta?.unverified
  if (!unverified) return ""
  const why =
    unverified.reason === "stopped"
      ? "stopped before the check finished"
      : "the check did not accept this answer"
  return note(
    `Unverified: ${why}.${unverified.detail ? ` ${unverified.detail}` : ""}`
  )
}

const textOf = (message: ChatCompletionMessage) => messageText(message)

const renderUser = (message: ChatCompletionMessage, number: number): string => {
  const text = textOf(message)
  // Marked messages are already Markdown; older ones are HTML from the composer.
  const body =
    (message.contentFormat === "markdown" ? text : htmlToMarkdown(text)) ||
    note("empty message")
  const images = message.images?.length
    ? note(
        `${message.images.length} image${message.images.length === 1 ? "" : "s"} attached`
      )
    : ""
  return [
    `## ${number}. ${YOU}`,
    "",
    body,
    ...(images ? ["", images] : [])
  ].join("\n")
}

interface Counter {
  continuations: number
}

/** A reply's text, with each automatic continuation marked where it begins. */
const renderText = (text: string, counter: Counter): string[] => {
  const pieces = text.split(CONTINUATION_PREFIX)
  const out: string[] = []
  pieces.forEach((piece, index) => {
    if (index > 0) {
      counter.continuations += 1
      out.push(
        `### Automatic continuation ${counter.continuations}`,
        "",
        note(
          "Twinny continued this reply automatically; the work carries on below."
        ),
        ""
      )
    }
    const body = balanceMarkup(piece.replace(/^\n+/, "").replace(/\s+$/, ""))
    if (body) out.push(body, "")
  })
  return out
}

/** A stall is recorded as its own message after the reply it ended, so the reply's status must look ahead. */
const stalledBeforeNextUser = (
  messages: ChatCompletionMessage[],
  index: number
): boolean => {
  for (let next = index + 1; next < messages.length; next++) {
    const message = messages[next]
    if (message.role === USER) return false
    if (message.meta?.execution?.outcome === "stalled") return true
  }
  return false
}

const renderAssistant = (
  message: ChatCompletionMessage,
  number: number,
  counter: Counter,
  inProgress = false,
  stalledAfter = false
): string => {
  const { thinking, message: text } = getThinkingMessage(textOf(message))
  const model = message.meta?.model ? ` · \`${message.meta.model}\`` : ""
  const lines = [`## ${number}. ${TWINNY}${model}`, ""]
  // Thinking written into the text itself, from before rounds were kept, has no place among the activity: it opens the reply.
  if (thinking) lines.push(quoted("Reasoning", balanceMarkup(thinking)), "")
  const steps = message.toolSteps ?? []
  const rounds = message.reasoningRounds ?? []
  let wrote = false
  for (const part of replyParts(text, steps, rounds)) {
    if ("text" in part) {
      const rendered = renderText(part.text, counter)
      wrote ||= rendered.some(Boolean)
      lines.push(...rendered)
    } else if ("round" in part) {
      lines.push(renderRound(part.round, inProgress), "")
    } else {
      wrote = true
      for (const step of part.steps) lines.push(renderStep(step), "")
    }
  }
  if (!wrote)
    lines.push(note(inProgress ? "nothing written yet" : "no text"), "")
  const changes = renderChanges(message.changes)
  if (changes) lines.push(changes, "")
  const withheld = renderWithheld(message)
  if (withheld) lines.push(withheld, "")
  const unverified = renderUnverified(message)
  if (unverified) lines.push(unverified, "")
  if (message.meta?.execution) lines.push(renderExecution(message.meta.execution), "")
  lines.push(replyStatus(message, inProgress, stalledAfter))
  return lines.join("\n")
}

/**
 * The conversation as Markdown: the user's messages (their line breaks and
 * Markdown kept), Twinny's replies with their tool calls, outputs, feedback
 * reviews, TODO activity and continuations, in order. What the chat did not
 * keep is said so, never left out.
 */
export const exportConversation = (
  messages: ChatCompletionMessage[],
  options: ConversationExportOptions = {}
): string => {
  const counter: Counter = { continuations: 0 }
  const shown = messages.filter(
    (message) => message.role === USER || message.role === ASSISTANT
  )
  const inProgress = options.inProgress ?? undefined
  const total = shown.length + (inProgress ? 1 : 0)
  const sections: string[] = []
  shown.forEach((message, index) => {
    const number = index + 1
    sections.push(
      message.role === USER
        ? renderUser(message, number)
        : renderAssistant(
            message,
            number,
            counter,
            false,
            stalledBeforeNextUser(shown, index)
          )
    )
  })
  if (inProgress)
    sections.push(renderAssistant(inProgress, total, counter, true))
  const exported = options.exportedAt ?? new Date()
  const title = options.title?.trim() || "Twinny chat"
  const header = [
    `# ${title}`,
    "",
    note(
      `Exported from Twinny on ${exported.toISOString()}: ${total} message${total === 1 ? "" : "s"}, ${counter.continuations} automatic continuation${counter.continuations === 1 ? "" : "s"}.`
    )
  ]
  return `${header.join("\n")}\n\n${sections.join("\n\n---\n\n")}\n`
}

/** The reply still streaming when the chat is copied, as the chat holds it right now. */
export interface LiveReply {
  text: string
  toolSteps?: ToolStepView[]
  reasoningRounds?: ReasoningRoundView[]
}

/**
 * Copy All: every saved message and the reply still streaming, in the order
 * they happened. Empty when the chat has nothing to copy.
 */
export const exportEntireChat = (
  messages: ChatCompletionMessage[],
  live: LiveReply,
  options: Omit<ConversationExportOptions, "inProgress"> = {}
): string => {
  const hasLive = !!live.text || !!live.toolSteps?.length || !!live.reasoningRounds?.length
  if (!messages.length && !hasLive) return ""
  const inProgress: ChatCompletionMessage | null = hasLive
    ? {
        role: ASSISTANT,
        content: live.text,
        ...(live.toolSteps?.length ? { toolSteps: live.toolSteps } : {}),
        ...(live.reasoningRounds?.length ? { reasoningRounds: live.reasoningRounds } : {})
      }
    : null
  return exportConversation(messages, { ...options, inProgress })
}
