/**
 * A whole conversation as one Markdown document, built from the chat's
 * messages (never the rendered DOM): every message, tool call, feedback
 * review and automatic continuation, in the order they happened. Pure, so
 * the webview builds it and the tests run it without VS Code.
 */
import * as cheerio from "cheerio"

import { ASSISTANT, CONTINUATION_PREFIX, TWINNY, USER, YOU } from "./constants"
import { replyParts } from "./reply-parts"
import { getThinkingMessage, messageText } from "./text"
import type {
  ChatCompletionMessage,
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

const replyStatus = (
  message: ChatCompletionMessage,
  inProgress: boolean
): string => {
  if (inProgress)
    return "**Status:** in progress when exported; this is what had been written so far."
  const meta = message.meta
  const steps = message.toolSteps ?? []
  const parts: string[] = []
  if (meta?.stopped) parts.push("Stopped by you before it finished.")
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

const textOf = (message: ChatCompletionMessage) => messageText(message)

const renderUser = (message: ChatCompletionMessage, number: number): string => {
  const body = htmlToMarkdown(textOf(message)) || note("empty message")
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
    const body = piece.replace(/^\n+/, "").replace(/\s+$/, "")
    if (body) out.push(body, "")
  })
  return out
}

const renderAssistant = (
  message: ChatCompletionMessage,
  number: number,
  counter: Counter,
  inProgress = false
): string => {
  const { thinking, message: text } = getThinkingMessage(textOf(message))
  const model = message.meta?.model ? ` · \`${message.meta.model}\`` : ""
  const lines = [`## ${number}. ${TWINNY}${model}`, ""]
  if (thinking) lines.push(quoted("Reasoning", thinking), "")
  const steps = message.toolSteps ?? []
  let wrote = false
  for (const part of replyParts(text, steps)) {
    if ("text" in part) {
      const rendered = renderText(part.text, counter)
      wrote ||= rendered.some(Boolean)
      lines.push(...rendered)
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
  lines.push(replyStatus(message, inProgress))
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
        : renderAssistant(message, number, counter)
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
