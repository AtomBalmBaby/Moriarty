import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react"
import { useTranslation } from "react-i18next"
import Markdown, { Components } from "react-markdown"
import { Editor, EditorContent, Extension, useEditor } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import DOMPurify from "dompurify"
import remarkGfm from "remark-gfm"
import { Markdown as TiptapMarkdown } from "tiptap-markdown"

import { ASSISTANT, EVENT_NAME, TWINNY, YOU } from "../common/constants"
import { WorkspaceSearchReport } from "../common/messaging/protocol"
import type { ReplyRowPart } from "../common/reply-parts"
import {
  ChatCompletionMessage,
  ImageAttachment,
  MentionType,
  ReplyChangesView,
  ReplyMeta
} from "../common/types"

import { useSuggestion } from "./hooks/useSuggestion"
import CodeBlock from "./code-block"
import { createCustomImageExtension } from "./image-extension"
import { MentionExtension } from "./mention-extention"
import { emit } from "./messaging"
import { ReasoningRound } from "./reasoning-block"
import { ReplyChanges } from "./reply-changes"
import { useToast } from "./toast"
import ToolSteps from "./tool-steps"
import {
  getThinkingMessage,
  handleMarkdownPaste,
  insertLineBreak,
  LinkExtension,
  MentionWithMarkdown,
  remarkUnderline,
  UnderlineExtension
} from "./utils"
import WorkspaceContext from "./workspace-context"

import styles from "./styles/message.module.css"

interface MessageProps {
  index?: number
  /**
   * The part of an assistant reply this row renders. A user message has none.
   * Each assistant part is its own row, so each can measure and collapse on its own.
   */
  part?: ReplyRowPart
  isAssistant?: boolean
  /**
   * The workspace search behind a reply still streaming. A finished reply
   * carries its own in `message.context`.
   */
  context?: WorkspaceSearchReport
  isLoading?: boolean
  message?: ChatCompletionMessage
  messages?: ChatCompletionMessage[]
  onDelete?: (index: number) => void
  onRegenerate?: (index: number, mentions: MentionType[] | undefined) => void
  onEdit?: (
    message: string,
    index: number,
    mentions: MentionType[] | undefined,
    images?: ImageAttachment[]
  ) => void
  onHeightChange?: () => void
  onDeleteImage?: (id: string) => void
  /** A reply whose task the user paused: it reads paused and offers Continue or Stop. */
  paused?: boolean
  /** Continue a paused or out-of-steps reply. Only the last reply offers it. */
  onContinue?: () => void
  /** End a paused reply's task for good. Any paused reply offers it. */
  onStopTask?: () => void
  /** Keep a reply's changed files as they stand after an undo. */
  onChangesUpdate?: (index: number, changes: ReplyChangesView) => void
  /** The conversation's title, shown as the title of the box around its opening task. */
  taskTitle?: string
  /** Identifies the conversation, so a fold made in one conversation does not carry over to another. */
  taskConversationId?: string
  /** Whether the agent has started replying to the conversation; the task box folds once it has. */
  taskReplied?: boolean
}

const CustomKeyMap = Extension.create({
  name: "messageKeyMap",
  // Ahead of StarterKit's HardBreak, which also binds Shift-Enter and Mod-Enter.
  priority: 1000,
  addKeyboardShortcuts() {
    return {
      "Mod-Enter": ({ editor }) => insertLineBreak(editor),
      "Shift-Enter": ({ editor }) => insertLineBreak(editor)
    }
  }
})

interface ThinkingSectionProps {
  thinking: string
  isCollapsed: boolean
  onToggle: () => void
  markdownComponents: Components
}

const ThinkingSection = React.memo(
  ({
    thinking,
    isCollapsed: initialCollapsed,
    onToggle,
    markdownComponents
  }: ThinkingSectionProps) => {
    const { t } = useTranslation()
    const [isCollapsed, setIsCollapsed] = React.useState(initialCollapsed)
    const prevThinkingRef = useRef(thinking)
    const isStreamingRef = useRef(false)

    useEffect(() => {
      // If thinking content changed and is longer, we're streaming
      if (thinking.length > prevThinkingRef.current.length) {
        isStreamingRef.current = true
        setIsCollapsed(false) // Auto-expand during streaming
      } else {
        isStreamingRef.current = false
      }
      prevThinkingRef.current = thinking
    }, [thinking])

    const handleToggle = useCallback(() => {
      if (!isStreamingRef.current) {
        setIsCollapsed((prev) => !prev)
        onToggle()
      }
    }, [onToggle])

    return (
      <div className={styles.thinkingSection}>
        <div className={styles.thinkingHeader} onClick={handleToggle}>
          <span>{t("thinking")}</span>
          <span
            className={`codicon ${isCollapsed ? "codicon-chevron-right" : "codicon-chevron-down"
              }`}
          />
        </div>
        <div
          className={`${styles.thinkingContent} ${isCollapsed ? styles.collapsed : ""
            }`}
        >
          <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
            {thinking}
          </Markdown>
        </div>
      </div>
    )
  }
)

const formatDuration = (ms: number) =>
  ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`

/** 12412 as "12.4k": enough to see how full a context is. */
const compactCount = (count: number) =>
  count < 1000 ? String(count) : count < 10_000 ? `${(count / 1000).toFixed(1)}k` : `${Math.round(count / 1000)}k`

/** From here a context is close enough to full to say so. */
const CONTEXT_NEARLY_FULL = 0.8

/**
 * One quiet line under a reply: which model wrote it, how long it took,
 * and, when the backend counted, how fast and how much of the model's
 * context the conversation now takes. Old conversations have no meta and
 * show nothing.
 */
const ReplyFooter = ({
  meta,
  paused,
  onContinue,
  onStopTask,
  actions
}: {
  meta: ReplyMeta
  /** The reply's task is paused: it is not stopped, and Continue or Stop can act on it. */
  paused?: boolean
  onContinue?: () => void
  /** Ends a paused task for good. */
  onStopTask?: () => void
  /** The reply's copy and regenerate, at the line's end. */
  actions?: React.ReactNode
}) => {
  const { t } = useTranslation()
  const parts: { text: string; title?: string }[] = []
  if (meta.durationMs !== undefined) parts.push({ text: formatDuration(meta.durationMs) })
  if (meta.completionTokens && meta.durationMs) {
    const perSecond = meta.completionTokens / (meta.durationMs / 1000)
    parts.push({
      text: t("reply-tokens-per-second", { count: meta.completionTokens, rate: perSecond.toFixed(1) }),
      title: t("reply-tokens-title", { count: meta.completionTokens })
    })
  }
  const title = [meta.provider, meta.model].filter(Boolean).join(" · ")
  const used = meta.promptTokens
  const holds = meta.contextWindow

  return (
    <div className={styles.replyFooter}>
      {meta.model && (
        <span className={styles.replyModel} title={title}>
          {meta.model}
        </span>
      )}
      {parts.map((part) => (
        <span key={part.text} title={part.title}>
          {part.text}
        </span>
      ))}
      {!!used && (
        <span
          className={holds && used / holds >= CONTEXT_NEARLY_FULL ? styles.replyContextFull : undefined}
          title={
            holds
              ? t("reply-context-of-title", { used: used.toLocaleString(), window: holds.toLocaleString() })
              : t("reply-context-title", { used: used.toLocaleString() })
          }
        >
          {holds
            ? t("reply-context-of", { used: compactCount(used), window: compactCount(holds) })
            : t("reply-context", { used: compactCount(used) })}
        </span>
      )}
      {paused && <span className={styles.replyStopped}>{t("reply-paused")}</span>}
      {meta.stopped && !paused && <span className={styles.replyStopped}>{t("reply-stopped")}</span>}
      {meta.outOfSteps && !meta.stopped && <span className={styles.replyStopped}>{t("reply-out-of-steps")}</span>}
      {!!meta.withheld?.length && <WithheldBadge withheld={meta.withheld} />}
      {!!meta.instructions?.length && <InstructionsBadge files={meta.instructions} />}
      {onContinue && (
        <button
          type="button"
          className={styles.replyContinue}
          onClick={onContinue}
          title={t(meta.outOfSteps && !meta.stopped ? "reply-continue-steps-title" : "reply-continue-title")}
        >
          <span className="codicon codicon-debug-continue" aria-hidden="true" />
          {t("reply-continue")}
        </button>
      )}
      {onStopTask && (
        <button type="button" className={styles.replyContinue} onClick={onStopTask} title={t("reply-stop-task-title")}>
          <span className="codicon codicon-debug-stop" aria-hidden="true" />
          {t("reply-stop-task")}
        </button>
      )}
      {actions && <span className={styles.replyActions}>{actions}</span>}
    </div>
  )
}

/** How many credentials the secret shield kept out of the request, and which kinds. */
const WithheldBadge = ({ withheld }: { withheld: NonNullable<ReplyMeta["withheld"]> }) => {
  const { t } = useTranslation()
  const count = withheld.reduce((sum, { count }) => sum + count, 0)
  const kinds = withheld.map(({ label, count }) => (count > 1 ? `${label} ×${count}` : label)).join(", ")
  return (
    <span className={styles.replyWithheld} title={t("reply-withheld-title", { kinds })}>
      <span className="codicon codicon-shield" aria-hidden="true" />
      {t("reply-withheld", { count })}
    </span>
  )
}

/** A reply shown without passing its check: the label says why, and the body is tinted to match. */
const UnverifiedBanner = ({ unverified }: { unverified: NonNullable<ReplyMeta["unverified"]> }) => {
  const { t } = useTranslation()
  return (
    <div
      className={styles.replyUnverified}
      title={unverified.detail ? t("reply-unverified-title", { detail: unverified.detail }) : undefined}
    >
      <span className="codicon codicon-warning" aria-hidden="true" />
      {t(unverified.reason === "stopped" ? "reply-unverified-stopped" : "reply-unverified-delivery")}
    </div>
  )
}

/** The project's instruction files agent mode followed; opens the first. */
const InstructionsBadge = ({ files }: { files: string[] }) => {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      className={styles.replyInstructions}
      title={t("reply-instructions-title", { files: files.join(", ") })}
      onClick={() => emit(EVENT_NAME.twinnyOpenFile, { path: files[0] })}
    >
      <span className="codicon codicon-book" aria-hidden="true" />
      {files.length > 1 ? t("reply-instructions-more", { file: files[0], count: files.length - 1 }) : files[0]}
    </button>
  )
}

/** Taller than this, a user turn (usually pasted code) folds away. */
const COLLAPSE_HEIGHT = 240

/*
 * A long question pushes its answer off screen. It shows its first lines and
 * a toggle; the whole of it is still what was sent.
 */
const Collapsible = ({ children }: { children: React.ReactNode }) => {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)
  const [tall, setTall] = React.useState(false)
  const [open, setOpen] = React.useState(false)

  useLayoutEffect(() => {
    const el = ref.current
    if (el) setTall(el.scrollHeight > COLLAPSE_HEIGHT + 60)
  }, [children])

  return (
    <>
      <div
        ref={ref}
        className={tall && !open ? styles.folded : undefined}
        style={tall && !open ? { maxHeight: COLLAPSE_HEIGHT } : undefined}
      >
        {children}
      </div>
      {tall && (
        <button
          type="button"
          className={styles.expandToggle}
          onClick={() => setOpen((prev) => !prev)}
        >
          <span
            className={`codicon codicon-chevron-${open ? "up" : "down"}`}
            aria-hidden="true"
          />
          {open ? t("show-less") : t("show-more")}
        </button>
      )}
    </>
  )
}

/**
 * The conversation's opening task, in a box titled with the conversation. It folds to its header, which keeps the
 * message actions. The body stays mounted while folded, so an edit in progress is kept.
 */
const TaskBox = ({
  title,
  open,
  onToggle,
  actions,
  children
}: {
  title: string
  open: boolean
  onToggle: () => void
  actions: React.ReactNode
  children: React.ReactNode
}) => {
  const { t } = useTranslation()
  const bodyId = React.useId()
  const sectionRef = React.useRef<HTMLElement>(null)
  // The box's height before a toggle, when the box starts above the viewport.
  const heightBeforeToggle = React.useRef<number | null>(null)

  const handleToggle = () => {
    const section = sectionRef.current
    const scroller = section?.closest<HTMLElement>("[data-testid='virtuoso-scroller']")
    heightBeforeToggle.current =
      section && scroller && section.getBoundingClientRect().top < scroller.getBoundingClientRect().top
        ? section.offsetHeight
        : null
    onToggle()
  }

  // Virtuoso measures the new height on the next frame, and a tall body clamps itself after its first effect.
  // The offset is taken once both have settled; applying it earlier scrolls Virtuoso to the wrong rows.
  React.useLayoutEffect(() => {
    const before = heightBeforeToggle.current
    heightBeforeToggle.current = null
    const section = sectionRef.current
    if (before === null || !section) return
    const scroller = section.closest<HTMLElement>("[data-testid='virtuoso-scroller']")
    if (!scroller) return
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const delta = section.offsetHeight - before
      if (delta) scroller.scrollTop += delta
    }))
  })

  return (
    <section ref={sectionRef} className={styles.taskBox}>
      <div className={styles.taskBoxHeader}>
        <button
          type="button"
          className={styles.taskBoxToggle}
          aria-expanded={open}
          aria-controls={bodyId}
          title={open ? t("task-box-collapse") : t("task-box-expand")}
          onClick={handleToggle}
        >
          <span className={`codicon codicon-chevron-${open ? "down" : "right"}`} aria-hidden="true" />
          <span className={styles.taskBoxTitle}>{title}</span>
        </button>
        <div className={styles.taskBoxActions}>{actions}</div>
      </div>
      <div id={bodyId} className={styles.taskBoxBody} hidden={!open}>
        {children}
      </div>
    </section>
  )
}

export const Message: React.FC<MessageProps> = ({
  index = 0,
  part,
  isAssistant,
  context,
  isLoading,
  message,
  onDelete,
  onRegenerate,
  onEdit,
  onHeightChange,
  messages,
  onDeleteImage,
  onContinue,
  onStopTask,
  paused,
  onChangesUpdate,
  taskTitle,
  taskReplied,
  taskConversationId
}) => {
  const { t } = useTranslation()
  const [isThinkingCollapsed, setIsThinkingCollapsed] = React.useState(false)
  const [editing, setEditing] = React.useState<boolean>(false)
  // A reader's fold or unfold applies to the conversation it was made in; the row is reused when the conversation changes.
  const [taskChoice, setTaskChoice] = React.useState<{ conversationId?: string; open: boolean } | undefined>(undefined)
  const messageRef = useRef<HTMLDivElement>(null)
  const prevHeightRef = useRef<number>(0)
  const { Toast, showToast } = useToast()
  const handleThinkingToggle = useCallback(() => {
    setIsThinkingCollapsed((prev) => !prev)
  }, [])
  useEffect(() => {
    const currentHeight = messageRef.current?.offsetHeight
    if (currentHeight && currentHeight !== prevHeightRef.current) {
      prevHeightRef.current = currentHeight
      onHeightChange?.()
    }
  }, [editing, message?.content])

  const handleToggleEditing = useCallback(() => setEditing((prev) => !prev), [])
  const handleDelete = useCallback(() => onDelete?.(index), [onDelete, index])

  const extractMentionsFromHtml = (content: string): MentionType[] => {
    const parser = new DOMParser()
    const doc = parser.parseFromString(content, "text/html")
    const mentions: MentionType[] = []

    doc.querySelectorAll(".mention").forEach((mention) => {
      const path = mention.getAttribute("data-id")
      const label = mention.getAttribute("data-label")
      if (path && label) {
        mentions.push({
          name: label,
          path: path
        })
      }
    })

    return mentions
  }

  const handleRegenerate = useCallback(() => {
    if (!messages?.length) return
    const lastMessage = messages[index - 1]
    // Markdown keeps no mention paths in its text, so they are stored on the message.
    const mentions =
      lastMessage?.contentFormat === "markdown"
        ? lastMessage.mentions
        : extractMentionsFromHtml(lastMessage?.content as string)
    onRegenerate?.(index, mentions)
  }, [onRegenerate, index])

  const handleToggleCancel = useCallback(() => {
    setEditing(false)
    editorRef.current?.commands.setContent(message?.content as string)
  }, [message?.content])

  const handleToggleSave = useCallback(() => {
    const editorContent = editorRef.current?.getHTML()
    if (!editorContent) {
      return setEditing(false)
    }
    const parser = new DOMParser()
    const doc = parser.parseFromString(editorContent, "text/html")
    const mentions = Array.from(doc.querySelectorAll(".mention")).map(
      (mention) => {
        const filePath = mention.getAttribute("data-id")
        const label = mention.getAttribute("data-label")
        if (filePath && label) {
          mention.outerHTML = `<span class="mention" data-type="mention" data-id="${filePath}" data-label="${label}">@${label}</span>`
        }
        return { name: label, path: filePath }
      }
    )

    const imageNodes = Array.from(doc.querySelectorAll("img"))
    const imageIds = imageNodes.map(img => img.getAttribute("id")).filter((id): id is string => Boolean(id))
    const allImages = (message?.images || []) as ImageAttachment[]
    const filteredImages = allImages.filter(img => img.id && imageIds.includes(img.id))

    // Markdown messages are saved as Markdown; legacy messages keep their HTML.
    const markdown = editorRef.current?.storage.markdown?.getMarkdown()
    const finalContent =
      message?.contentFormat === "markdown" && markdown !== undefined
        ? markdown
        : doc.body.innerHTML
    if (message?.content === finalContent) {
      return setEditing(false)
    }

    onEdit?.(
      finalContent,
      index,
      mentions.filter((m): m is MentionType => Boolean(m.name && m.path)),
      filteredImages
    )
    setEditing(false)
  }, [message?.content, message?.contentFormat, onEdit, index, message?.images])

  const handleOpenFile = useCallback((filePath: string) => {
    emit(EVENT_NAME.twinnyOpenFile, filePath)
  }, [])

  const { suggestion, filePaths } = useSuggestion()

  const memoizedSuggestion = useMemo(
    () => suggestion,
    [JSON.stringify(filePaths)]
  )

  const editorRef = useRef<Editor | null>(null)

  const CustomImageExtension = createCustomImageExtension(onDeleteImage)

  const editor = useEditor(
    {
      extensions: [
        StarterKit,
        TiptapMarkdown,
        UnderlineExtension,
        LinkExtension,
        MentionExtension,
        CustomImageExtension.configure({
          allowBase64: true,
        }),
        MentionWithMarkdown.configure({
          HTMLAttributes: {
            class: "mention"
          },
          suggestion: memoizedSuggestion,
          renderText({ node }) {
            return `@${node.attrs.label}`
          }
        }),
        CustomKeyMap.configure({
          handleToggleSave
        })
      ],
      content: message?.content,
      // StarterKit's mark paste rules would turn literal `*text*` in any paste into emphasis.
      enablePasteRules: ["link"],
      editorProps: {
        attributes: {
          class: styles.editor
        },
        handleDOMEvents: {
          paste: (view, event) => {
            const items = Array.from(event.clipboardData?.items || [])
            const imageItem = items.find(item => item.type.startsWith("image/"))

            if (imageItem) {
              const file = imageItem.getAsFile()
              if (file) {
                const reader = new FileReader()
                reader.onload = (e) => {
                  const base64 = e.target?.result as string
                  const imageData = base64.includes("data:") ? base64 : `data:${file.type};base64,${base64.split(",")[1]}`
                  view.dispatch(
                    view.state.tr.replaceSelectionWith(
                      view.state.schema.nodes.image.create({ src: imageData })
                    )
                  )
                }
                reader.readAsDataURL(file)
                return true
              }
            }

            // Markdown-looking text becomes formatting; anything else pastes as usual.
            return handleMarkdownPaste(view, event, editorRef.current?.storage.markdown?.parser)
          }
        }
      },
      onFocus: () => {
        if (editorRef.current) {
          editorRef.current.commands.focus("end")
        }
      }
    },
    [memoizedSuggestion]
  )

  useEffect(() => {
    if (editorRef.current) {
      const mentionExtension =
        editorRef.current.extensionManager.extensions.find(
          (extension) => extension.name === "mention"
        )
      if (mentionExtension) {
        mentionExtension.options.suggestion = memoizedSuggestion
        editorRef.current.commands.focus()
      }
    }
  }, [memoizedSuggestion])

  const renderContent = useCallback(
    (htmlContent: string) => {
      const sanitizedHtml = DOMPurify.sanitize(htmlContent, {
        ALLOWED_TAGS: ["span", "p", "br", "code", "pre", "blockquote"],
        ALLOWED_ATTR: ["class", "data-id", "data-label", "data-type"],
        ALLOW_DATA_ATTR: true,
        ALLOW_UNKNOWN_PROTOCOLS: true
      });

      return (
        <div
          className={styles.messageContent}
          dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
          onClick={(e) => {
            const target = e.target as HTMLElement
            const mention = target.closest(".mention")
            if (mention) {
              const filePath = mention.getAttribute("data-id")
              if (filePath) {
                handleOpenFile(filePath)
              }
            }
          }}
        />
      )
    },
    [handleOpenFile]
  )

  const renderImageGallery = useCallback(() => {
    const images = message?.images || [] as ImageAttachment[]
    if (!images.length) return null;

    const maxImages = 10
    const limitedImages = images.slice(0, maxImages)

    return (
      <div className={styles.imageGallery}>
        {limitedImages.map((img, index) => (
          <div key={index} className={styles.imageContainer}>
            <img
              src={(img as ImageAttachment).data}
              className={styles.chatImageSquare}
              alt=""
              loading="lazy"
              style={{ maxWidth: "200px", maxHeight: "200px" }}
            />
          </div>
        ))}
        {images.length > maxImages && (
          <div style={{ color: "#888", marginTop: 8 }}>
            {`+${images.length - maxImages} more image(s) not shown for performance`}
          </div>
        )}
      </div>
    )
  }, [message?.images])

  const renderCodeBlock = useCallback(
    ({
      children,
      ...props
    }: { children: React.ReactNode } & React.HTMLProps<HTMLPreElement>) => {
      if (React.isValidElement(children)) {
        return (
          <CodeBlock role={message?.role} {...children.props} />
        )
      }
      return <pre {...props}>{children}</pre>
    },
    [message?.role]
  )

  const markdownComponents = useMemo(
    () =>
    ({
      pre: renderCodeBlock,
      p: ({
        children,
        ...props
      }: React.HTMLAttributes<HTMLParagraphElement>) => {
        if (
          typeof children === "string" &&
          (children.includes("class=\"mention\"") || children.includes("<img"))
        ) {
          return renderContent(children)
        }
        return <p {...props}>{children}</p>
      },
    } as Components),
    [renderCodeBlock, renderContent, message?.images]
  )

  // Markdown from the user is not HTML: no `p` override, so its text never reaches renderContent.
  const userMarkdownComponents = useMemo(
    () => ({ pre: renderCodeBlock }) as Components,
    [renderCodeBlock]
  )

  if (!message) return null
  // Assistant rows are only built for replies with something to show, so only a user message can be empty here.
  if (!part && !message.content) return null

  const { thinking, message: messageContent } = getThinkingMessage(
    message.content as string
  )

  const conversationLength = messages?.length || 0
  // A reply with a footer keeps its actions at the end of it; anything else floats them over its corner.
  const footerActions = message.role === ASSISTANT && !!message.meta && !editing

  const options = (
    <div className={styles.messageOptions}>
      <VSCodeButton
        title={t("copy-code")}
        onClick={() => {
          navigator.clipboard.writeText(messageContent)
          showToast(t("copied-to-clipboard"))
        }}
        appearance="icon"
      >
        <span className="codicon codicon-copy"></span>
      </VSCodeButton>
      {editing && !isAssistant && (
        <>
          <VSCodeButton
            title={t("cancel-edit")}
            appearance="icon"
            onClick={handleToggleCancel}
          >
            <span className="codicon codicon-close" />
          </VSCodeButton>
          <VSCodeButton
            title={t("save-edit")}
            appearance="icon"
            onClick={handleToggleSave}
          >
            <span className="codicon codicon-check" />
          </VSCodeButton>
        </>
      )}
      {!editing && !isAssistant && (
        <>
          <VSCodeButton
            disabled={isLoading}
            title={t("edit-message")}
            appearance="icon"
            onClick={handleToggleEditing}
          >
            <span className="codicon codicon-edit" />
          </VSCodeButton>
          <VSCodeButton
            disabled={isLoading || conversationLength <= 2}
            title={t("delete-message")}
            appearance="icon"
            onClick={handleDelete}
          >
            <span className="codicon codicon-trash" />
          </VSCodeButton>
        </>
      )}
      {!editing && isAssistant && (
        <VSCodeButton
          disabled={isLoading}
          title={t("regenerate-message")}
          appearance="icon"
          onClick={handleRegenerate}
        >
          <span className="codicon codicon-sync" />
        </VSCodeButton>
      )}
    </div>
  )

  useEffect(() => {
    if (editor) editorRef.current = editor
    editorRef.current?.commands.focus()
  }, [editor])

  // A reply is split into rows, so each row keeps its own padding; the head carries the top and the tail the bottom.
  const rowClass =
    message.role === ASSISTANT
      ? [
          styles.message,
          styles.row,
          part?.kind === "head" && styles.rowHead,
          part?.kind === "tail" && styles.rowTail
        ]
          .filter(Boolean)
          .join(" ")
      : `${styles.message} ${styles.userMessage}${index === 0 ? ` ${styles.firstMessage}` : ""}`
  const showHead = !part || part.kind === "head"
  // The conversation's opening message is its task; its box replaces the role label.
  const isTask = message.role !== ASSISTANT && index === 0 && !part
  const taskIsOpen =
    taskChoice?.conversationId === taskConversationId ? taskChoice?.open ?? !taskReplied : !taskReplied

  const content = (
    <>
      {showHead && thinking && (
        <ThinkingSection
          thinking={thinking}
          isCollapsed={isThinkingCollapsed}
          onToggle={handleThinkingToggle}
          markdownComponents={markdownComponents}
        />
      )}
      {showHead && !isTask && (
        <div className={styles.messageRole}>
          <span className={styles.roleLabel}>
            {message.role !== ASSISTANT && (
              <span className={styles.rolePrompt} aria-hidden="true">
                &#10095;
              </span>
            )}
            {message.role === ASSISTANT ? TWINNY : YOU}
          </span>
          {!footerActions && options}
        </div>
      )}
      {showHead && message.role === ASSISTANT && (
        <WorkspaceContext report={message.context ?? context} />
      )}
      {showHead && message.meta?.unverified && <UnverifiedBanner unverified={message.meta.unverified} />}
      {editing ? (
        <EditorContent className={styles.tiptap} editor={editor} />
      ) : part ? (
        <>
          {part.kind === "round" && (
            <ReasoningRound
              round={part.round}
              active={part.active}
              interrupted={paused ? "paused" : "stopped"}
            />
          )}
          {part.kind === "steps" && <ToolSteps steps={part.steps} />}
          {part.kind === "text" && (
            <div className={message.meta?.unverified ? styles.unverifiedBody : undefined}>
              <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                {part.text}
              </Markdown>
            </div>
          )}
          {part.kind === "tail" && (
            <>
              {renderImageGallery()}
              {message.changes && (
                <ReplyChanges
                  changes={message.changes}
                  onUpdate={(changes) => index !== undefined && onChangesUpdate?.(index, changes)}
                  onError={showToast}
                />
              )}
              {message.meta && (
                <ReplyFooter
                  meta={message.meta}
                  paused={paused}
                  onContinue={onContinue}
                  onStopTask={onStopTask}
                  actions={footerActions ? options : undefined}
                />
              )}
            </>
          )}
        </>
      ) : (
        <Collapsible>
          {message.contentFormat === "markdown" ? (
            <div className={styles.messageContent}>
              <Markdown
                remarkPlugins={[remarkGfm, remarkUnderline]}
                components={userMarkdownComponents}
              >
                {messageContent.trimStart()}
              </Markdown>
            </div>
          ) : (
            renderContent(messageContent.trimStart())
          )}
          {renderImageGallery()}
        </Collapsible>
      )}
    </>
  )

  return (
    <div ref={messageRef} className={rowClass}>
      {Toast}
      {isTask ? (
        <TaskBox
          title={taskTitle || t("chat-new-conversation-title")}
          open={taskIsOpen}
          onToggle={() => setTaskChoice({ conversationId: taskConversationId, open: !taskIsOpen })}
          actions={!footerActions && options}
        >
          {content}
        </TaskBox>
      ) : (
        content
      )}
    </div>
  )
}

export default Message
