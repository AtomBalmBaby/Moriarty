import { InputRule, markInputRule } from "@tiptap/core"
import Link, { isAllowedUri } from "@tiptap/extension-link"
import Mention from "@tiptap/extension-mention"
import Underline from "@tiptap/extension-underline"
import { PluginKey, TextSelection } from "@tiptap/pm/state" // or 'prosemirror-state'
import type { EditorView } from "@tiptap/pm/view"
import { Editor, Extension } from "@tiptap/react"
import DOMPurify from "dompurify"

import { CodeLanguage, supportedLanguages } from "../common/languages"
import { LanguageType } from "../common/types"

export { getLineBreakCount, getThinkingMessage, kebabToSentence } from "../common/text"

const MentionPluginKey = new PluginKey("mention")

export const getLanguageMatch = (
  language: LanguageType | undefined,
  className: string | undefined
) => {
  const match = /language-(\w+)/.exec(className || "")

  if (match && match.length) {
    const matchedLanguage = supportedLanguages[match[1] as CodeLanguage]

    return matchedLanguage && matchedLanguage.derivedFrom
      ? matchedLanguage.derivedFrom
      : match[1]
  }

  if (language && language.languageId) {
    const languageId = language.languageId.toString()
    const languageEntry = supportedLanguages[languageId as CodeLanguage]

    return languageEntry && languageEntry.derivedFrom
      ? languageEntry.derivedFrom
      : languageId
  }

  return "auto"
}



/** 12412 as "12.4k": enough to see how full a context is. */
export const compactCount = (count: number) =>
  count < 1000 ? String(count) : count < 10_000 ? `${(count / 1000).toFixed(1)}k` : `${Math.round(count / 1000)}k`

export const getModelShortName = (name: string) => {
  if (name.length > 40) {
    return `${name.substring(0, 35)}...`
  }
  return name
}


// Starts a new line as Markdown structure: a new list item, a new paragraph,
// or a literal newline inside a fenced code block. A hard break would put a
// `\` into the Markdown and stop block syntax from working on later lines.
// A second Shift-Enter on an empty line at the end of a code block leaves it.
export const insertLineBreak = (editor: Editor): boolean => {
  if (editor.isActive("codeBlock")) {
    const { state, dispatch } = editor.view
    const { $from, empty } = state.selection
    const block = $from.parent
    const atEnd = empty && $from.parentOffset === block.content.size
    if (atEnd && block.textContent.endsWith("\n")) {
      const tr = state.tr.delete($from.pos - 1, $from.pos)
      const after = tr.mapping.map($from.after())
      tr.insert(after, state.schema.nodes.paragraph.create())
      tr.setSelection(TextSelection.near(tr.doc.resolve(after + 1)))
      dispatch(tr.scrollIntoView())
      return true
    }
    editor.view.dispatch(state.tr.insertText("\n"))
    return true
  }
  // Separate commands, not one `first` chain: setNode's fallback to
  // clearNodes resolves positions against a stale document inside a chain.
  if (editor.commands.splitListItem("listItem")) return true
  if (editor.commands.liftEmptyBlock()) return true
  editor.commands.splitBlock()
  if (editor.isActive("heading")) editor.commands.setNode("paragraph")
  return true
}

export const CustomKeyMap = Extension.create({
  name: "chatKeyMap",
  // Ahead of StarterKit's HardBreak, which also binds Shift-Enter and Mod-Enter.
  priority: 1000,

  addKeyboardShortcuts() {
    return {
      Enter: ({ editor }) => {
        const mentionState = MentionPluginKey.getState(editor.state)
        if (mentionState && mentionState.active) {
          return false
        }
        // An empty composer answers a command waiting on the user.
        if (editor.isEmpty && this.options.approve?.("run")) return true
        this.options.handleSubmitForm()
        this.options.clearEditor()
        return true
      },
      "Mod-Enter": ({ editor }) => insertLineBreak(editor),
      "Shift-Enter": ({ editor }) => {
        if (editor.isEmpty && this.options.approve?.("always")) return true
        return insertLineBreak(editor)
      },
      // Stops a reply on its way, from where the user is already typing;
      // pressed twice with nothing running, it clears the draft.
      Escape: ({ editor }) => {
        const mentionState = MentionPluginKey.getState(editor.state)
        if (mentionState && mentionState.active) return false
        return this.options.escape?.() ?? false
      },
      // As in a terminal: stop the reply, or clear the line. With text
      // selected it stays a copy.
      "Ctrl-c": ({ editor }) => {
        if (!editor.state.selection.empty) return false
        return this.options.interrupt?.() ?? false
      },
      "Ctrl-l": () => this.options.newConversation?.() ?? false,
      // On an empty composer "?" asks for the shortcuts; anywhere else it
      // is a question mark.
      "?": ({ editor }) => {
        if (!editor.isEmpty) return false
        return this.options.toggleShortcuts?.() ?? false
      },
      // Agent mode on and off, where Claude Code switches its modes.
      "Shift-Tab": ({ editor }) => {
        const mentionState = MentionPluginKey.getState(editor.state)
        if (mentionState && mentionState.active) return false
        return this.options.toggleAgentMode?.() ?? false
      },
      PageUp: () => this.options.scrollTranscript?.(-1) ?? false,
      PageDown: () => this.options.scrollTranscript?.(1) ?? false,
      // Earlier prompts, as in a shell: from an empty composer, or while
      // already stepping through them.
      ArrowUp: ({ editor }) => {
        const mentionState = MentionPluginKey.getState(editor.state)
        if (mentionState && mentionState.active) return false
        return this.options.recallPrompt?.(-1, editor.isEmpty) ?? false
      },
      ArrowDown: ({ editor }) => {
        const mentionState = MentionPluginKey.getState(editor.state)
        if (mentionState && mentionState.active) return false
        return this.options.recallPrompt?.(1, editor.isEmpty) ?? false
      },
    }
  },
})

// Live Markdown input. A completed delimiter formats the text in place.
// Underline has no Markdown syntax, so it is typed as ++text++ and stored as <u>text</u>.
const UNDERLINE_INPUT_RULE = /(?:^|\s)(\+\+([^+\s](?:[^+]*[^+\s])?)\+\+)$/
const LINK_INPUT_RULE = /\[([^\]]+)\]\(([^)\s]+)\)$/

export const UnderlineExtension = Underline.extend({
  addInputRules() {
    return [markInputRule({ find: UNDERLINE_INPUT_RULE, type: this.type })]
  }
})

export const LinkExtension = Link.extend({
  // Text typed after a link should not join the link.
  inclusive: false,
  addInputRules() {
    return [
      new InputRule({
        find: LINK_INPUT_RULE,
        handler: ({ state, range, match }) => {
          const [, text, href] = match
          if (!isAllowedUri(href)) return
          const { tr } = state
          const mark = state.schema.marks.link.create({ href })
          tr.replaceWith(range.from, range.to, state.schema.text(text, [mark]))
        }
      })
    ]
  }
}).configure({ openOnClick: false, autolink: true })

// Pasted text with Markdown structure is parsed as Markdown; rich HTML from
// the clipboard keeps ProseMirror's own paste handling.
const MARKDOWN_PASTE_SYNTAX = /^\s{0,3}(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|`{3}|~{3})|\*\*|__|~~|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\)|\+\+[^+\n]+\+\+|<u>/m
const RICH_HTML_PASTE = /<(strong|b|em|i|s|del|u|h[1-6]|ul|ol|li|blockquote|pre|code|a|table)[\s>]/i

const PASTED_MARKDOWN_TAGS = [
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "pre", "code",
  "strong", "em", "s", "del", "u", "a", "br", "hr"
]

let pastingMarkdown = false

export const handleMarkdownPaste = (
  view: EditorView,
  event: ClipboardEvent,
  parser: { parse: (markdown: string) => string } | undefined
): boolean => {
  // pasteHTML re-enters handlePaste with the same event; the inner call lets ProseMirror insert the parsed HTML.
  if (pastingMarkdown) return false
  const html = event.clipboardData?.getData("text/html") ?? ""
  if (RICH_HTML_PASTE.test(html)) return false
  const text = event.clipboardData?.getData("text/plain") ?? ""
  if (!parser || !MARKDOWN_PASTE_SYNTAX.test(text)) return false
  pastingMarkdown = true
  try {
    // Raw HTML in pasted Markdown is kept only as structure, so images and scripts never reach the editor.
    const html = DOMPurify.sanitize(parser.parse(text), {
      ALLOWED_TAGS: PASTED_MARKDOWN_TAGS,
      ALLOWED_ATTR: ["href", "class"]
    })
    return view.pasteHTML(html, event)
  } finally {
    pastingMarkdown = false
  }
}

export const MentionWithMarkdown = Mention.extend({
  addStorage() {
    return {
      markdown: {
        serialize: (state: { write: (text: string) => void }, node: { attrs: { label?: string | null } }) => {
          state.write(`@${node.attrs.label ?? ""}`)
        },
        parse: {}
      }
    }
  }
})

type MarkdownNode = { type: string; value?: string; children?: MarkdownNode[]; data?: Record<string, unknown> }

const isUnderlineTag = (node: MarkdownNode, tag: "<u>" | "</u>") =>
  node.type === "html" && node.value?.trim().toLowerCase() === tag

// Only a matched `<u>…</u>` pair becomes an element; other raw HTML is dropped.
const withUnderlines = (nodes: MarkdownNode[]): MarkdownNode[] => {
  const out: MarkdownNode[] = []
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    if (isUnderlineTag(node, "<u>")) {
      const close = nodes.findIndex((next, j) => j > i && isUnderlineTag(next, "</u>"))
      if (close !== -1) {
        out.push({
          type: "underline",
          data: { hName: "u" },
          children: withUnderlines(nodes.slice(i + 1, close))
        })
        i = close
        continue
      }
    }
    if (node.children) node.children = withUnderlines(node.children)
    out.push(node)
  }
  return out
}

/** Renders the `<u>…</u>` underline convention of the composer's Markdown. */
export const remarkUnderline = () => (tree: MarkdownNode) => {
  tree.children = withUnderlines(tree.children ?? [])
}

