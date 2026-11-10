import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Virtuoso, VirtuosoHandle } from "react-virtuoso"
import Mention from "@tiptap/extension-mention"
import Placeholder from "@tiptap/extension-placeholder"
import { Editor, EditorContent, JSONContent, useEditor } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"
import { VSCodeButton, VSCodePanelView } from "@vscode/webview-ui-toolkit/react"
import * as cheerio from "cheerio"
import cx from "classnames"
import { v4 as uuidv4 } from "uuid"

import type { AgentProfileSummary, AgentSelection } from "../common/agents"
import { AGENT_GLYPHS, agentGlyphState, nextAgentSelection, withAgentSelection } from "../common/agents"
import { ASSISTANT, EVENT_NAME, TODO_EVENT_NAME, USER } from "../common/constants"
import { exportConversation } from "../common/conversation-export"
import { PROMPT_COMPILER_ENABLED_KEY } from "../common/feedback-settings"
import { isStaleTodoSnapshot } from "../common/guards"
import { shouldResumeQueuedChat } from "../common/messaging/chat-stop"
import type { EntireChatAction, PromptCompileResult } from "../common/messaging/protocol"
import { attachLateSteps } from "../common/reply-steps"
import { messageText } from "../common/text"
import {
  AnyContextItem,
  ChatCompletionMessage,
  ImageAttachment,
  MentionType,
  ReplyChangesView,
  TodoFeedbackStatus,
  TodoListSnapshot,
  ToolStepView
} from "../common/types"

import { useAgentMode } from "./hooks/useAgentMode"
import { useAutoRun } from "./hooks/useAutoRun"
import { useAutosizeTextArea } from "./hooks/useAutosizeTextArea"
import { useComposerSuggestions } from "./hooks/useComposerSuggestions"
import { useConversationHistory } from "./hooks/useConversationHistory"
import { useProviders } from "./hooks/useProviders"
import { useSelection } from "./hooks/useSelection"
import { useSuggestion } from "./hooks/useSuggestion"
import { useToolSteps } from "./hooks/useToolSteps"
import { useWorkspaceContext } from "./hooks/useWorkspaceContext"
import { useWorkspaceSearch } from "./hooks/useWorkspaceSearch"
import { ProviderSelect } from "./providers/provider-select"
import AgentSettings from "./agent-settings"
import { composerIsBusy, ComposerOperationEvent, ComposerOperationPhase, reduceComposerOperation } from "./composer-operation"
import { EmptyChat } from "./empty-chat"
import { GhostText } from "./ghost-text"
import { createCustomImageExtension } from "./image-extension"
import MessageItem from "./message-item"
import { bridge, emit, useServerEvent } from "./messaging"
import {
  decideCompiledDraft,
  isMacPlatform,
  PendingCompilation,
  sendButtonAction,
  textToComposerHtml
} from "./prompt-compiler-draft"
import { Shortcuts } from "./shortcuts"
import { Suggestions } from "./suggestions"
import { TodoPanel } from "./todo-panel"
import { answerToolStep } from "./tool-steps"
import { conversationMarkdown } from "./transcript"
import type { TypingActivity } from "./typing-indicator"
import { CustomKeyMap, getThinkingMessage } from "./utils"

import styles from "./styles/chat.module.css"

const IS_MAC = isMacPlatform(typeof navigator === "undefined" ? undefined : navigator.platform || navigator.userAgent)
/** A little longer than the extension's own compiler timeout, which answers first. */
const PROMPT_COMPILE_TIMEOUT_MS = 130_000

const COMPOSER_MIN_HEIGHT = 44
const COMPOSER_HEIGHT_KEY = "twinny.composerHeight"
const PROMPT_HISTORY_KEY = "twinny.promptHistory"
const PROMPT_HISTORY_LIMIT = 50
const REASONING_LIMIT = 20_000
const REASONING_FLUSH_MS = 200
const CELEBRATION_MS = 3000
/** Two presses of Esc this close together clear the draft. */
const DOUBLE_ESCAPE_MS = 800
/** Where a key belongs to whatever has focus, not to the chat. */
const KEY_OWNERS =
  "input, textarea, select, .ProseMirror, [contenteditable='true'], " +
  "vscode-text-field, vscode-text-area, vscode-dropdown"

const loadPromptHistory = (): string[] => {
  try {
    const stored = JSON.parse(localStorage.getItem(PROMPT_HISTORY_KEY) || "[]")
    return Array.isArray(stored) ? stored.filter((p) => typeof p === "string") : []
  } catch {
    return []
  }
}

interface QueuedMessage {
  id: string
  conversationId?: string
  /** As the composer had it, so it can go back there. */
  html: string
  /** As sent: paragraphs joined with line breaks. */
  input: string
  /** The actual execution prompt the agent should receive. */
  prompt?: string
  /** The original user wording, kept when a refined execution prompt is later used. */
  originalPrompt?: string
  text: string
  mentions: MentionType[]
  images: ImageAttachment[]
  /**
   * Offered to the agent reply that is working, for the model to read at
   * its next step; sent as a turn of its own if the reply ends first.
   */
  steer?: boolean
}

/** A message's text with its line breaks, as the agent is handed it mid-reply. */
const steeringText = (input: string) =>
  cheerio
    .load(input.replace(/<br\s*\/?>/g, "\n"))
    .root()
    .text()
    .trim()

interface ChatProps {
  fullScreen?: boolean
  active?: boolean
}

export const Chat = (props: ChatProps): JSX.Element => {
  const { fullScreen, active = true } = props
  const generatingRef = useRef(false)
  const editorRef = useRef<Editor | null>(null)
  const imagesRef = useRef<ImageAttachment[]>([])
  const stopRef = useRef(false)
  const selection = useSelection()
  const { t } = useTranslation()
  const [operationPhase, setOperationPhase] = useState<ComposerOperationPhase>("idle")
  const operationPhaseRef = useRef<ComposerOperationPhase>("idle")
  const isLoading = composerIsBusy(operationPhase)
  /** Stop and Send follow the host's operation events only; the ref keeps callbacks in step. */
  const dispatchOperation = useCallback((event: ComposerOperationEvent) => {
    const next = reduceComposerOperation(operationPhaseRef.current, event)
    operationPhaseRef.current = next
    generatingRef.current = composerIsBusy(next)
    setOperationPhase(next)
  }, [])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [messages, setMessages] = useState<ChatCompletionMessage[]>([])
  // Nothing can answer without a chat provider, so the composer is off
  // until one is set; the empty transcript says where to set it.
  const { chatProvider, ready: providersReady } = useProviders()
  const chatDisabled = providersReady && !chatProvider
  const [completion, setCompletion] = useState<ChatCompletionMessage | null>()
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const { contextItems, removeContextItem } = useWorkspaceContext()
  const {
    report: searchReport,
    clear: clearSearchReport,
    take: takeSearchReport
  } = useWorkspaceSearch()
  // Kept as the events arrive, not on render, so a step that comes in
  // right behind a chunk of text is placed after that chunk.
  const completionRef = useRef<ChatCompletionMessage | null | undefined>()
  completionRef.current = completion
  const { steps: toolSteps, clear: clearToolSteps, take: takeToolSteps } = useToolSteps(
    () => getThinkingMessage(String(completionRef.current?.content ?? "")).message
  )
  const [isBottom, setIsBottom] = useState(false)
  const [agentProfiles, setAgentProfiles] = useState<AgentProfileSummary[]>([])
  const { conversation, conversationLoaded, saveLastConversation, setActiveConversation } = useConversationHistory()
  const [agentProfilesSettled, setAgentProfilesSettled] = useState(false)
  const { agentMode, teamAgentRules, agentSelection, storedAgentSelection, lastAgentSelection, setAgentSelection, resetAgentSelectionForNewChat, agentPreferenceError, agentSessionReady } = useAgentMode(
    agentProfiles.filter((profile) => profile.enabled && profile.valid && profile.userInvocable).map((profile) => profile.id),
    { profilesSettled: agentProfilesSettled, conversationLoaded, restoredSelection: conversation?.agentSelection }
  )
  const [agentProfilesLoaded, setAgentProfilesLoaded] = useState(false)
  const lastSyncedConversationId = useRef<string | undefined>(undefined)
  const [agentPickerError, setAgentPickerError] = useState("")
  const [agentMenuOpen, setAgentMenuOpen] = useState(false)
  const agentPickerRef = useRef<HTMLDivElement>(null)
  const agentPickerButtonRef = useRef<HTMLButtonElement>(null)
  const agentMenuItemsRef = useRef<Array<HTMLButtonElement | null>>([])
  const agentModeRef = useRef(agentMode)
  agentModeRef.current = agentMode
  const { autoRun, autoRunAvailable, toggleAutoRun, setAutoRun } = useAutoRun(teamAgentRules)
  const [agentSettingsOpen, setAgentSettingsOpen] = useState(false)
  const [promptCompilerEnabled, setPromptCompilerEnabled] = useState(false)
  const promptCompilerEnabledRef = useRef(false)
  promptCompilerEnabledRef.current = promptCompilerEnabled
  useEffect(() => {
    bridge
      .request(EVENT_NAME.twinnyGetConfigValue, { key: PROMPT_COMPILER_ENABLED_KEY })
      .then((answer) => setPromptCompilerEnabled(answer?.value === true))
      .catch(() => undefined)
  }, [])
  useServerEvent(EVENT_NAME.twinnyConfigValueChanged, ({ key, value }) => {
    if (key === PROMPT_COMPILER_ENABLED_KEY && typeof value === "boolean") setPromptCompilerEnabled(value)
  })
  /** The explicit compilation of the draft, and what came of it. */
  const [compileState, setCompileState] = useState<
    | { status: "running"; requestId: string }
    | { status: "offer"; requestId: string; prompt: string }
    | { status: "error"; message: string }
    | null
  >(null)
  const pendingCompileRef = useRef<PendingCompilation | null>(null)
  /** Bumped by every change to the composer, so a late result never overwrites newer typing. */
  const composerRevisionRef = useRef(0)
  const closeAgentSettings = useCallback(() => setAgentSettingsOpen(false), [])
  const agentMenuOptions = useMemo(() => [
    { value: "off" as AgentSelection, label: "Agent off" },
    { value: "default" as AgentSelection, label: "Default Agent" },
    ...agentProfiles
      .filter((profile) => profile.valid && profile.enabled && profile.userInvocable)
      .map((profile) => ({ value: profile.id as AgentSelection, label: profile.name }))
  ], [agentProfiles])
  const selectedAgentLabel = agentMenuOptions.find((option) => option.value === agentSelection)?.label ?? "Agent off"
  const focusAgentMenuItem = useCallback((index: number) => {
    const count = agentMenuOptions.length + 1
    const next = (index + count) % count
    agentMenuItemsRef.current[next]?.focus()
  }, [agentMenuOptions.length])
  useEffect(() => {
    if (!agentMenuOpen) return
    const selectedIndex = agentMenuOptions.findIndex((option) => option.value === agentSelection)
    agentMenuItemsRef.current[selectedIndex >= 0 ? selectedIndex : 0]?.focus()
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!agentPickerRef.current?.contains(event.target as Node)) setAgentMenuOpen(false)
    }
    document.addEventListener("pointerdown", closeOnOutsidePointer)
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer)
  }, [agentMenuOpen, agentMenuOptions, agentSelection])
  const handleAgentMenuKeyDown = useCallback((event: React.KeyboardEvent<HTMLButtonElement>) => {
    const currentIndex = Number(event.currentTarget.dataset.menuIndex)
    if (event.key === "ArrowDown") {
      event.preventDefault()
      focusAgentMenuItem(currentIndex + 1)
    } else if (event.key === "ArrowUp") {
      event.preventDefault()
      focusAgentMenuItem(currentIndex - 1)
    } else if (event.key === "Home") {
      event.preventDefault()
      focusAgentMenuItem(0)
    } else if (event.key === "End") {
      event.preventDefault()
      focusAgentMenuItem(agentMenuOptions.length)
    } else if (event.key === "Escape") {
      event.preventDefault()
      setAgentMenuOpen(false)
      agentPickerButtonRef.current?.focus()
    } else if (event.key === "Tab") {
      setAgentMenuOpen(false)
    }
  }, [agentMenuOptions.length, focusAgentMenuItem])
  const chooseAgentSelection = useCallback((next: import("../common/agents").AgentSelection, source = "dropdown") => {
    if (!setAgentSelection(next, source)) return
    if (conversation?.id) {
      const updated = { ...conversation, agentSelection: next }
      saveLastConversation(updated)
      setActiveConversation(updated)
    }
  }, [conversation, saveLastConversation, setActiveConversation, setAgentSelection])
  const toggleAgentForChat = useCallback(() => {
    const available = new Set(agentProfiles.filter((profile) => profile.enabled && profile.valid && profile.userInvocable).map((profile) => profile.id))
    const next = nextAgentSelection(agentSelection, lastAgentSelection, available)
    chooseAgentSelection(next, "shift-tab")
    return true
  }, [agentSelection, agentProfiles, chooseAgentSelection, lastAgentSelection])
  const toggleAgentForChatRef = useRef(toggleAgentForChat)
  toggleAgentForChatRef.current = toggleAgentForChat
  const toggleAgentForEditor = useCallback(() => toggleAgentForChatRef.current(), [])

  useEffect(() => {
    let cancelled = false
    bridge.request(EVENT_NAME.twinnyAgentRegistry, { action: "list" })
      .then((profiles) => {
        if (cancelled) return
        setAgentProfiles(profiles)
        setAgentProfilesLoaded(true)
        setAgentProfilesSettled(true)
        setAgentPickerError("")
      })
      .catch((error) => {
        if (cancelled) return
        setAgentPickerError(error instanceof Error ? error.message : String(error))
        setAgentProfilesLoaded(false)
        setAgentProfilesSettled(true)
      })
    return () => { cancelled = true }
  }, [])

  useServerEvent(EVENT_NAME.twinnyNotification, (message) => setAgentPickerError(message))

  useEffect(() => {
    const conversationId = conversation?.id
    if (!conversationId || lastSyncedConversationId.current === conversationId) return
    lastSyncedConversationId.current = conversationId
    if (conversation.agentSelection) setAgentSelection(conversation.agentSelection, "history-restore")
  }, [conversation?.agentSelection, conversation?.id, setAgentSelection])

  useServerEvent(EVENT_NAME.twinnyNewConversation, resetAgentSelectionForNewChat)

  useServerEvent(EVENT_NAME.twinnyAgentRegistry, (profiles) => {
    setAgentProfiles(profiles)
    setAgentProfilesLoaded(true)
    setAgentProfilesSettled(true)
    setAgentPickerError("")
  })

  useEffect(() => {
    if (!agentSessionReady || !agentProfilesLoaded || storedAgentSelection === "off" || storedAgentSelection === "default") return
    const selected = agentProfiles.find((profile) => profile.id === storedAgentSelection)
    if (selected?.valid && selected.enabled && selected.userInvocable) return
    setAgentSelection("off")
    emit(EVENT_NAME.twinnyNotification, "The selected agent is unavailable or disabled. Agent selection was reset to Agent off.")
  }, [agentProfiles, agentProfilesLoaded, agentSessionReady, setAgentSelection, storedAgentSelection])

  // A compilation belongs to the conversation it started in.
  const conversationIdRef = useRef(conversation?.id)
  conversationIdRef.current = conversation?.id
  useEffect(() => {
    const pending = pendingCompileRef.current
    if (pending) emit(EVENT_NAME.twinnyCancelPromptCompile, { requestId: pending.requestId })
    pendingCompileRef.current = null
    setCompileState(null)
  }, [conversation?.id])

  const chatRef = useRef<HTMLTextAreaElement>(null)
  const editorWrapRef = useRef<HTMLDivElement>(null)
  const resizeRef = useRef<{ startY: number; startHeight: number } | null>(null)
  // Sent prompts, oldest first, recalled with the arrow keys. `recallIndex`
  // counts back from the newest; -1 is the draft being typed.
  const promptHistoryRef = useRef<string[]>(loadPromptHistory())
  const recallIndexRef = useRef(-1)
  const draftRef = useRef("")
  const [showShortcuts, setShowShortcuts] = useState(false)
  /*
   * Messages typed while a reply is running: each goes out when the one
   * before it is answered. Stopping the reply puts them back in the
   * composer instead, since what they followed on from was cut short.
   */
  const [queued, setQueued] = useState<QueuedMessage[]>([])
  const queuedRef = useRef<QueuedMessage[]>([])
  const userStoppedRef = useRef(false)
  const showShortcutsRef = useRef(false)
  const lastEscapeRef = useRef(0)
  const hintTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const [hint, setHint] = useState<string | null>(null)
  const [composerHeight, setComposerHeight] = useState<number | null>(() => {
    const stored = Number(localStorage.getItem(COMPOSER_HEIGHT_KEY))
    return stored > 0 ? stored : null
  })

  const [reasoning, setReasoning] = useState("")
  const [continuation, setContinuation] = useState(0)
  const [todoSnapshot, setTodoSnapshot] = useState<TodoListSnapshot>()
  const [feedbackState, setFeedbackState] = useState<TodoFeedbackStatus>()
  const [celebration, setCelebration] = useState<"milestone" | "complete">()
  const reasoningRef = useRef("")
  const reasoningTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const celebrationTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const progressRef = useRef<Pick<TodoListSnapshot, "id" | "conversationId" | "revision"> & { verified: number }>()

  useEffect(() => () => {
    clearTimeout(reasoningTimerRef.current)
    clearTimeout(celebrationTimerRef.current)
  }, [])

  // Reasoning streams token by token; the view is updated at most every REASONING_FLUSH_MS.
  const resetReasoning = () => {
    clearTimeout(reasoningTimerRef.current)
    reasoningTimerRef.current = undefined
    reasoningRef.current = ""
    setReasoning("")
  }

  useServerEvent(EVENT_NAME.twinnyOnReasoning, (delta) => {
    reasoningRef.current = (reasoningRef.current + delta).slice(-REASONING_LIMIT)
    if (reasoningTimerRef.current !== undefined) return
    reasoningTimerRef.current = setTimeout(() => {
      reasoningTimerRef.current = undefined
      setReasoning(reasoningRef.current)
    }, REASONING_FLUSH_MS)
  })

  const acceptTodoSnapshot = (next: TodoListSnapshot) => {
    if (next.conversationId !== conversationIdRef.current) return
    const previous = progressRef.current
    if (isStaleTodoSnapshot(previous, next)) return
    setTodoSnapshot(next)
    const live = next.items.filter((item) => item.status !== "cancelled")
    const verified = live.filter((item) => item.verification === "passed").length
    progressRef.current = { id: next.id, conversationId: next.conversationId, revision: next.revision, verified }
    // The first snapshot of a conversation is a load, not a result.
    if (!previous || previous.conversationId !== next.conversationId || verified <= previous.verified) return
    const finished = live.length > 0 && live.every((item) => item.status === "completed" && item.verification === "passed")
    setCelebration(finished ? "complete" : "milestone")
    clearTimeout(celebrationTimerRef.current)
    celebrationTimerRef.current = setTimeout(() => setCelebration(undefined), CELEBRATION_MS)
  }

  useEffect(() => {
    setTodoSnapshot(undefined)
    setCelebration(undefined)
    const conversationId = conversation?.id
    if (!conversationId) return
    void bridge.request(TODO_EVENT_NAME.getList, { conversationId }).then(acceptTodoSnapshot).catch(() => undefined)
  }, [conversation?.id])

  useServerEvent(TODO_EVENT_NAME.changed, acceptTodoSnapshot)

  useServerEvent(TODO_EVENT_NAME.feedbackStatus, (next) => {
    if (next.conversationId === conversationIdRef.current) setFeedbackState(next)
  })

  const handleAddMessage = (added: ChatCompletionMessage | undefined) => {
    // A reply message does not end the operation; the host's terminal event does.
    if (!added) {
      setCompletion(null)
      return
    }

    // A reply keeps the workspace search that fed it, so the sources stay
    // with the message once it is saved. A new user turn starts afresh.
    let incoming = added
    if (added.role === ASSISTANT) {
      const context = takeSearchReport()
      const steps = takeToolSteps()
      incoming = { ...added, ...(context ? { context } : {}), ...(steps ? { toolSteps: steps } : {}) }
    } else {
      clearSearchReport()
      clearToolSteps()
    }

    setMessages((prev) => {
      if (incoming.id) {
        const existingIndex = prev?.findIndex((m) => m.id === incoming.id)

        if (existingIndex !== -1) {
          const updatedMessages = [...(prev || [])]
          updatedMessages[existingIndex || 0] = incoming

          saveLastConversation({
            ...conversation,
            messages: updatedMessages
          })
          return updatedMessages
        }
      }

      const messages = [...(prev || []), incoming]
      saveLastConversation({
        ...conversation,
        messages: messages
      })
      return messages
    })

    setTimeout(() => {
      editorRef.current?.commands.focus()
      stopRef.current = false
    }, 200)

    setCompletion(null)
    resetReasoning()
  }

  useServerEvent(EVENT_NAME.twinnyAddMessage, (incoming) => {
    handleAddMessage(incoming)
  })

  useServerEvent(EVENT_NAME.twinnyOnCompletion, (incoming) => {
    completionRef.current = incoming
    setCompletion(incoming)
  })

  useServerEvent(EVENT_NAME.twinnyOnLoading, (turn) => {
    resetReasoning()
    setContinuation(typeof turn === "object" ? turn.continuation ?? 0 : 0)
    dispatchOperation({ type: "started" })
  })

  useServerEvent(EVENT_NAME.twinnyNewConversation, () => {
    updateQueue([])
    setMessages([])
    setCompletion(null)
    clearSearchReport()
    clearToolSteps()
    setActiveConversation({
      id: uuidv4(),
      title: t("chat-new-conversation-title"),
      messages: []
    })
    chatRef.current?.focus()
    setTimeout(() => {
      stopRef.current = false
    }, 1000)
  })

  useServerEvent(EVENT_NAME.twinnyStopGeneration, (stop) => {
    dispatchOperation({ type: "terminal" })
    setCompletion(null)
    stopRef.current = false
    const stoppedByUser = userStoppedRef.current
    userStoppedRef.current = false
    const [next, ...rest] = queuedRef.current
    if (next && shouldResumeQueuedChat(stoppedByUser, stop?.cancelled === true)) {
      updateQueue(rest)
      // After this event's own state updates, so the reply is in the transcript first.
      setTimeout(() => sendRef.current(next), 0)
      return
    }
    if (next) restoreQueue()
    setTimeout(() => {
      chatRef.current?.focus()
    }, 200)
  })

  const updateQueue = (next: QueuedMessage[]) => {
    queuedRef.current = next
    setQueued(next)
  }

  // A queued message the model has read is in the reply now, no longer
  // waiting. Taken as the steps arrive, ahead of the reply's end, which
  // sends what is still queued.
  useServerEvent(EVENT_NAME.twinnyToolSteps, (incoming) => {
    const read = new Set((incoming ?? []).filter((step) => step.said).map((step) => step.id))
    if (!read.size) return
    const left = queuedRef.current.filter((message) => !read.has(`said.${message.id}`))
    if (left.length !== queuedRef.current.length) updateQueue(left)
  })

  /* Queued messages back in the composer, after anything already typed there. */
  const restoreQueue = () => {
    const editor = editorRef.current
    const waiting = queuedRef.current
    updateQueue([])
    if (!editor || !waiting.length) return
    const draft = editor.isEmpty ? "" : editor.getHTML()
    editor.commands.setContent(draft + waiting.map((message) => message.html).join(""), false)
    imagesRef.current = [...imagesRef.current, ...waiting.flatMap((message) => message.images)]
    editor.commands.focus("end")
  }

  const handleStopGeneration = useCallback(() => {
    userStoppedRef.current = true
    dispatchOperation({ type: "stop-requested" })
    emit(EVENT_NAME.twinnyStopGeneration, {})
  }, [dispatchOperation])

  const handleRegenerateMessage = (
    index: number,
    mentions: MentionType[] | undefined
  ): void => {
    dispatchOperation({ type: "started" })
    clearSearchReport()
    clearToolSteps()
    setMessages((prev) => {
      if (!prev) return prev
      const updatedMessages = prev.slice(0, index)

      emit(EVENT_NAME.twinnyChatMessage, withAgentSelection({
        messages: updatedMessages,
        mentions: mentions || [],
        conversationId: conversation?.id,
      }, storedAgentSelection))

      return updatedMessages
    })
  }

  const handleDeleteMessage = (index: number): void => {
    setMessages((prev) => {
      if (!prev || prev.length === 0) return prev
      if (prev.length === 2) return prev

      const updatedMessages = [
        ...prev.slice(0, index),
        ...prev.slice(index + 2)
      ]

      saveLastConversation({
        ...conversation,
        messages: updatedMessages
      })

      return updatedMessages
    })
  }

  /** A reply's changed files after an undo: kept with the message and saved. */
  const handleChangesUpdate = useCallback(
    (index: number, changes: ReplyChangesView) => {
      setMessages((prev) => {
        if (!prev?.[index] || prev[index].changes?.id !== changes.id) return prev
        const updatedMessages = prev.map((message, i) => (i === index ? { ...message, changes } : message))
        saveLastConversation({ ...conversation, messages: updatedMessages })
        return updatedMessages
      })
    },
    [conversation, saveLastConversation]
  )

  const handleEditMessage = (
    message: string,
    index: number,
    mentions: MentionType[] | undefined,
    images?: ImageAttachment[]
  ): void => {
    dispatchOperation({ type: "started" })
    clearSearchReport()
    clearToolSteps()
    setMessages((prev) => {
      if (!prev) return prev

      const updatedMessages = [
        ...prev.slice(0, index),
        {
          ...prev[index],
          content: message
            .replace(/<p>/g, "")
            .replace(/<\/p>/g, "<br>")
            .replace(/<br>$/, ""),
          images: images && images.length > 0 ? images : undefined,
          // The user rewrote it: what a feature recorded no longer applies.
          prompt: undefined
        }
      ]

      emit(EVENT_NAME.twinnyChatMessage, withAgentSelection({
        messages: updatedMessages,
        mentions: mentions || [],
        conversationId: conversation?.id,
      }, storedAgentSelection))

      return updatedMessages
    })
  }

  const getMentions = useCallback(() => {
    const mentions: MentionType[] = []
    editorRef.current?.getJSON().content?.forEach((node) => {
      if (node.type === "paragraph" && Array.isArray(node.content)) {
        node.content.forEach((innerNode: JSONContent) => {
          if (innerNode.type === "mention" && innerNode.attrs) {
            mentions.push({
              name: innerNode.attrs.label,
              path: innerNode.attrs.id
            })
          }
        })
      }
    })

    return mentions
  }, [])

  /* Images are left out: they are large and belong to the turn they were sent with. */
  const rememberPrompt = (html: string) => {
    const prompt = html.replace(/<img[^>]*>/g, "").trim()
    recallIndexRef.current = -1
    if (!prompt) return
    const history = promptHistoryRef.current.filter((p) => p !== prompt)
    history.push(prompt)
    promptHistoryRef.current = history.slice(-PROMPT_HISTORY_LIMIT)
    try {
      localStorage.setItem(
        PROMPT_HISTORY_KEY,
        JSON.stringify(promptHistoryRef.current)
      )
    } catch {
      // A full or blocked store only costs the history.
    }
  }

  /** Step through sent prompts; false leaves the key to the editor. */
  const recallPrompt = useCallback((step: -1 | 1, isEmpty: boolean) => {
    const editor = editorRef.current
    const history = promptHistoryRef.current
    const index = recallIndexRef.current
    if (!editor || !history.length) return false
    if (index === -1 && (step === 1 || !isEmpty)) return false

    if (index === -1) draftRef.current = editor.getHTML()
    const next = Math.min(history.length - 1, index - step)
    if (next === index) return true
    recallIndexRef.current = next
    editor.commands.setContent(
      next === -1 ? draftRef.current : history[history.length - 1 - next],
      false
    )
    editor.commands.focus("end")
    return true
  }, [])

  const clearEditor = useCallback(() => {
    editorRef.current?.commands.clearContent()
  }, [])

  const setShortcuts = useCallback((open: boolean) => {
    showShortcutsRef.current = open
    setShowShortcuts(open)
  }, [])

  /* The draft goes into the prompt history, so the up arrow brings it back. */
  const clearDraft = useCallback(() => {
    const editor = editorRef.current
    if (!editor || editor.isEmpty) return false
    rememberPrompt(editor.getHTML())
    imagesRef.current = []
    editor.commands.clearContent()
    return true
  }, [])

  /* A command or change waiting on the user, answered from the keys. */
  const waitingStepRef = useRef<ToolStepView>()
  waitingStepRef.current = toolSteps.find((step) => step.status === "waiting")
  const approveWaiting = useCallback((how: "run" | "always" | "skip") => {
    const step = waitingStepRef.current
    if (!step) return false
    // Shift+Enter means Always run, which only a command the team lets
    // run unasked has; on a change or such a command it is a new line.
    if (how === "always" && (step.approval !== "command" || step.noAlways)) return false
    answerToolStep(step, how)
    return true
  }, [])

  const stopIfGenerating = useCallback(() => {
    if (!generatingRef.current) return false
    userStoppedRef.current = true
    dispatchOperation({ type: "stop-requested" })
    emit(EVENT_NAME.twinnyStopGeneration, {})
    return true
  }, [dispatchOperation])

  /*
   * Esc closes the shortcuts, else skips what a tool is waiting on, else
   * stops a reply, else clears the draft on the second press. False leaves
   * the key to the editor.
   */
  const handleEscape = useCallback(() => {
    if (showShortcutsRef.current) {
      setShortcuts(false)
      return true
    }
    if (approveWaiting("skip")) return true
    if (stopIfGenerating()) return true
    const editor = editorRef.current
    if (!editor || editor.isEmpty) return false

    clearTimeout(hintTimerRef.current)
    if (Date.now() - lastEscapeRef.current < DOUBLE_ESCAPE_MS) {
      lastEscapeRef.current = 0
      setHint(null)
      return clearDraft()
    }
    lastEscapeRef.current = Date.now()
    setHint(t("shortcuts-esc-again"))
    hintTimerRef.current = setTimeout(() => setHint(null), DOUBLE_ESCAPE_MS)
    return true
  }, [approveWaiting, clearDraft, setShortcuts, stopIfGenerating, t])

  /* Ctrl+C with nothing selected; with a selection it is still a copy. */
  const handleInterrupt = useCallback(() => {
    if (!window.getSelection()?.isCollapsed) return false
    return stopIfGenerating() || clearDraft()
  }, [clearDraft, stopIfGenerating])

  const toggleShortcuts = useCallback(() => {
    setShortcuts(!showShortcutsRef.current)
    return true
  }, [setShortcuts])

  const scrollTranscript = useCallback((direction: -1 | 1) => {
    virtuosoRef.current?.scrollBy({
      top: direction * window.innerHeight * 0.6
    })
    return true
  }, [])

  useEffect(() => () => clearTimeout(hintTimerRef.current), [])

  /** One message to the model: into the transcript and out to the extension. */
  const sendMessage = (message: QueuedMessage) => {
    dispatchOperation({ type: "started" })
    clearSearchReport()
    clearToolSteps()

    const conversationId = message.conversationId || conversation?.id || uuidv4()

    setMessages((prevMessages) => {
      const executedPrompt = message.prompt ?? message.input
      const updatedMessages: ChatCompletionMessage[] = [
        ...(prevMessages || []),
        {
          role: USER,
          content: message.input,
          prompt: executedPrompt,
          originalPrompt: message.originalPrompt ?? message.input,
          images: message.images.length > 0 ? message.images : undefined
        }
      ]

      const currentConversation = {
        id: conversationId,
        messages: updatedMessages,
        title: conversation?.title || t("chat-new-conversation-title"),
        agentSelection: storedAgentSelection
      }

      saveLastConversation(currentConversation)
      setActiveConversation(currentConversation)

      emit(EVENT_NAME.twinnyChatMessage, withAgentSelection({
        messages: updatedMessages,
        mentions: message.mentions,
        conversationId,
      }, storedAgentSelection))

      return updatedMessages
    })
  }
  // The queue sends from an event handler; it always reaches this render's.
  const sendRef = useRef(sendMessage)
  sendRef.current = sendMessage

  const resolveCompilerHistory = useCallback(() => {
    const asText = (value: unknown): string => {
      if (typeof value === "string") return value
      if (Array.isArray(value)) return value.map((item) => asText(item)).join(" ")
      if (value && typeof value === "object") return JSON.stringify(value)
      return String(value ?? "")
    }

    const stableKey = (message: ChatCompletionMessage, fallbackIndex: number) => {
      const text = asText(message.prompt ?? message.originalPrompt ?? message.content ?? "")
      return message.id ?? `${message.role}:${fallbackIndex}:${text.slice(0, 80).replace(/\s+/g, " ").trim()}`
    }

    const merged = [...(conversation?.messages ?? []), ...messages]
    const completed: ChatCompletionMessage[] = []
    let pendingUser: ChatCompletionMessage | undefined
    const seen = new Set<string>()

    for (const [index, message] of merged.entries()) {
      if (message.role === "user") {
        const key = stableKey(message, index)
        if (!seen.has(key)) {
          seen.add(key)
          pendingUser = message
        }
        continue
      }
      if (message.role === "assistant" && pendingUser) {
        const promptText = asText(pendingUser.prompt ?? pendingUser.originalPrompt ?? pendingUser.content)
        const responseText = asText(message.content)
        if (promptText.trim() || responseText.trim()) {
          const pairKey = `${stableKey(pendingUser, index)}:${stableKey(message, index)}`
          if (!seen.has(pairKey)) {
            seen.add(pairKey)
            completed.push({
              ...pendingUser,
              content: promptText,
              prompt: promptText,
              originalPrompt: pendingUser.originalPrompt ?? promptText,
              id: pendingUser.id ?? stableKey(pendingUser, index)
            })
            completed.push({
              ...message,
              content: responseText,
              prompt: responseText,
              id: message.id ?? stableKey(message, index)
            })
          }
        }
        pendingUser = undefined
      }
    }

    // The extension trims this to twinny.promptCompiler.maxTurns.
    return completed.slice(-20)
  }, [conversation?.messages, messages])

  /** Sends the composer's message, or queues it while a reply is running. */
  const handleSubmitForm = useCallback(async () => {
    const html = editorRef.current?.getHTML() || ""
    const input = html
      .replace(/<p>/g, "")
      .replace(/<\/p>/g, "<br>")
      .replace(/<br>$/, "")

    const text = cheerio
      .load(input || "")
      .root()
      .text()
      .trim()

    if (!text || !input || chatDisabled) return

    const message: QueuedMessage = {
      id: uuidv4(),
      conversationId: conversation?.id || uuidv4(),
      html,
      input,
      text,
      mentions: getMentions(),
      images: imagesRef.current
    }
    imagesRef.current = []
    clearEditor()
    rememberPrompt(html)
    // Sending takes the draft as written; a compilation of it is moot.
    if (pendingCompileRef.current) emit(EVENT_NAME.twinnyCancelPromptCompile, { requestId: pendingCompileRef.current.requestId })
    pendingCompileRef.current = null
    setCompileState(null)

    if (generatingRef.current) {
      // In agent mode the model can read it between steps; one that brings
      // files or images waits for a turn of its own, where those are added.
      const steer = agentModeRef.current && !message.mentions.length && !message.images.length
      updateQueue([...queuedRef.current, { ...message, steer }])
      if (steer) emit(EVENT_NAME.twinnySteer, { id: message.id, text: steeringText(input) })
      return
    }

    sendRef.current(message)
  }, [agentMode, chatDisabled])

  const resolveCompilerHistoryRef = useRef(resolveCompilerHistory)
  resolveCompilerHistoryRef.current = resolveCompilerHistory
  const composerText = () => editorRef.current?.getText({ blockSeparator: "\n" }).trim() ?? ""

  /** Replaces the draft with compiled text the user can still edit. */
  const replaceComposer = useCallback((prompt: string) => {
    const current = editorRef.current
    if (!current) return
    current.commands.setContent(textToComposerHtml(prompt), true)
    current.commands.focus("end")
  }, [])

  /**
   * Ctrl/Cmd+Click Send: compiles the draft into the composer. Nothing is
   * sent, and the result only replaces a draft nobody has touched since.
   */
  const handleCompileDraft = useCallback(async () => {
    if (pendingCompileRef.current) return
    const draft = composerText()
    if (!draft) return
    const pending: PendingCompilation = {
      requestId: uuidv4(),
      conversationId: conversationIdRef.current,
      revision: composerRevisionRef.current,
      draft
    }
    pendingCompileRef.current = pending
    setCompileState({ status: "running", requestId: pending.requestId })
    let result: PromptCompileResult
    try {
      result = await bridge.request(EVENT_NAME.twinnyCompilePrompt, {
        requestId: pending.requestId,
        prompt: draft,
        history: resolveCompilerHistoryRef.current(),
        conversationId: pending.conversationId
      }, { timeoutMs: PROMPT_COMPILE_TIMEOUT_MS })
    } catch (error) {
      emit(EVENT_NAME.twinnyCancelPromptCompile, { requestId: pending.requestId })
      result = { requestId: pending.requestId, status: "failed", error: error instanceof Error ? error.message : String(error) }
    }
    const latestRequestId = pendingCompileRef.current?.requestId
    if (latestRequestId === pending.requestId) pendingCompileRef.current = null
    const decision = decideCompiledDraft(pending, {
      latestRequestId,
      conversationId: conversationIdRef.current,
      revision: composerRevisionRef.current,
      text: composerText()
    })
    // Sent, cancelled or replaced meanwhile: whatever replaced it owns the notice.
    if (decision.action === "discard" && decision.reason === "superseded") return
    if (result.status === "compiled") {
      if (decision.action === "apply") {
        replaceComposer(result.prompt)
        setCompileState(null)
      } else if (decision.action === "offer") {
        setCompileState({ status: "offer", requestId: pending.requestId, prompt: result.prompt })
      } else {
        setCompileState(null)
      }
      return
    }
    if (result.status === "failed") setCompileState({ status: "error", message: result.error })
    else if (result.status === "disabled") setCompileState({ status: "error", message: t("prompt-compiler-disabled") })
    else setCompileState(null)
    editorRef.current?.commands.focus()
  }, [replaceComposer, t])

  const cancelCompile = useCallback(() => {
    const pending = pendingCompileRef.current
    if (pending) emit(EVENT_NAME.twinnyCancelPromptCompile, { requestId: pending.requestId })
    pendingCompileRef.current = null
    setCompileState(null)
    editorRef.current?.commands.focus()
  }, [])

  /** The Send button: a plain click sends; the modifier gesture compiles when enabled. */
  const handleSendClick = useCallback((event: React.MouseEvent) => {
    const action = sendButtonAction(event, {
      mac: IS_MAC,
      compilerEnabled: promptCompilerEnabledRef.current,
      compiling: !!pendingCompileRef.current
    })
    if (action === "ignore") return
    if (action === "compile") {
      event.preventDefault()
      event.stopPropagation()
      void handleCompileDraft()
      return
    }
    void handleSubmitForm()
  }, [handleCompileDraft, handleSubmitForm])

  /*
   * A stopped reply is picked up by asking for the rest. The transcript
   * shows a short "Continue"; the model is told not to start over. One that
   * ran out of tool steps goes back to the task, with what its tools did
   * in the notes this turn carries.
   */
  const handleContinue = useCallback(() => {
    if (generatingRef.current || chatDisabled) return
    dispatchOperation({ type: "started" })
    clearSearchReport()
    clearToolSteps()
    setMessages((prev) => {
      const last = prev?.[prev.length - 1]
      const outOfSteps = !!last?.meta?.outOfSteps && !last.meta.stopped
      const updatedMessages: ChatCompletionMessage[] = [
        ...(prev || []),
        {
          role: USER,
          content: t("reply-continue"),
          prompt: outOfSteps
            ? "Carry on with the task from where your last reply got to, using the tools again as you need them. " +
              "Do not redo steps that already worked."
            : "Continue exactly where your last reply stopped. " +
              "Do not repeat anything you already wrote."
        }
      ]
      saveLastConversation({ ...conversation, messages: updatedMessages })
      emit(EVENT_NAME.twinnyChatMessage, withAgentSelection({
        messages: updatedMessages,
        mentions: [],
        conversationId: conversation?.id,
      }, storedAgentSelection))
      return updatedMessages
    })
  }, [conversation, chatDisabled, clearSearchReport, clearToolSteps, t])

  const handleOpenAsMarkdown = useCallback(() => {
    if (!messages.length) return
    emit(EVENT_NAME.twinnyNewDocument, {
      content: conversationMarkdown(conversation?.title, messages),
      language: "markdown"
    })
  }, [conversation?.title, messages])

  // The sidebar's title-bar menu asks; the panel has its own button.
  useServerEvent(EVENT_NAME.twinnyExportConversation, handleOpenAsMarkdown)

  /**
   * The whole chat as Markdown, from the conversation state: every saved
   * message, then the reply still streaming with the steps it has so far.
   */
  const handleEntireChatExport = (action: EntireChatAction) => {
    const streaming = completionRef.current
    const streamingSteps = toolSteps.length ? toolSteps : streaming?.toolSteps
    const inProgress: ChatCompletionMessage | null = streaming || streamingSteps?.length
      ? { role: ASSISTANT, content: messageText(streaming), toolSteps: streamingSteps }
      : null
    const markdown = messages.length || inProgress
      ? exportConversation(messages, { title: conversation?.title, inProgress })
      : ""
    emit(EVENT_NAME.twinnyEntireChatExport, { action, markdown })
  }

  useServerEvent(EVENT_NAME.twinnyExportEntireChat, handleEntireChatExport)

  // A feedback review finishes after its reply was saved, so it joins that reply.
  useServerEvent(EVENT_NAME.twinnyReplySteps, (late) => {
    const last = messages[messages.length - 1]
    if (!last || last.role !== ASSISTANT || !late?.length) return
    setMessages((prev) => {
      const current = prev[prev.length - 1]
      if (!current || current.role !== ASSISTANT) return prev
      const updated = [...prev.slice(0, -1), attachLateSteps(current, late)]
      saveLastConversation({ ...conversation, messages: updated })
      return updated
    })
    clearToolSteps()
  })

  const handleNewConversation = useCallback(() => {
    setActiveConversation({
      id: uuidv4(),
      title: t("chat-new-conversation-title"),
      messages: []
    })

    emit(EVENT_NAME.twinnyNewConversation)
  }, [setActiveConversation, t])

  // The composer's key map outlives a render, so it calls through a ref.
  const newConversationRef = useRef(handleNewConversation)
  newConversationRef.current = handleNewConversation

  const startNewConversation = useCallback(() => {
    stopIfGenerating()
    newConversationRef.current()
    return true
  }, [stopIfGenerating])

  useServerEvent(EVENT_NAME.twinnyShowShortcuts, () => setShortcuts(true))

  /*
   * The same keys with the focus on the transcript rather than the composer.
   * Anything typed there goes to the composer.
   */
  useEffect(() => {
    if (!active) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.altKey) return
      const target = e.target instanceof Element ? e.target : null
      if (target?.closest(KEY_OWNERS)) return

      let handled = false
      if (e.ctrlKey) {
        if (e.shiftKey) return
        if (e.key === "c") {
          handled = handleInterrupt()
        } else if (e.key === "l") {
          handled = startNewConversation()
        }
      } else if (e.key === "Escape") {
        handled = handleEscape()
      } else if (e.key === "?") {
        handled = toggleShortcuts()
      } else if (e.key.length === 1 && e.key !== " " && !chatDisabled) {
        // Not handled: the key itself lands in the composer.
        if (!target?.closest("button, vscode-button, a, summary")) {
          editorRef.current?.commands.focus("end")
        }
      }
      if (handled) e.preventDefault()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [
    active,
    chatDisabled,
    handleEscape,
    handleInterrupt,
    startNewConversation,
    toggleShortcuts
  ])

  const handleOpenFile = useCallback((filePath: string) => {
    emit(EVENT_NAME.twinnyOpenFile, filePath)
  }, [])

  // Coming back to the chat hides the other tabs' back button and puts the
  // cursor in the composer, as opening it did when it was remounted.
  useEffect(() => {
    if (!active) return
    emit(EVENT_NAME.twinnyHideBackButton)
    editorRef.current?.commands.focus()
  }, [active])

  useEffect(() => {
    if (editorRef.current) emit(EVENT_NAME.twinnySidebarReady)
  }, [editorRef.current])

  useEffect(() => {
    editorRef.current?.commands.focus()
  }, [])

  // Switching conversation shows its messages, including none for a new one.
  // Messages queued in the one left belong to it, and are not sent here.
  useEffect(() => {
    if (conversation?.id) setMessages(conversation.messages || [])
    if (queuedRef.current.length) updateQueue([])
  }, [conversation?.id])

  const { suggestion, filePaths } = useSuggestion()

  const memoizedSuggestion = useMemo(
    () => suggestion,
    [JSON.stringify(filePaths)]
  )

  const { updateSuggestion } = useComposerSuggestions({
    editorRef,
    messages,
    promptHistoryRef,
    busyRef: generatingRef
  })
  // The editor keeps the handlers it was made with; this one changes.
  const updateSuggestionRef = useRef(updateSuggestion)
  updateSuggestionRef.current = updateSuggestion

  const CustomImageExtension = createCustomImageExtension((id: string) => {
    imagesRef.current = imagesRef.current.filter((img) => img.id !== id)
  })

  const editor = useEditor(
    {
      extensions: [
        StarterKit,
        Mention.configure({
          HTMLAttributes: {
            class: "mention"
          },
          suggestion: memoizedSuggestion,
          renderText({ node }) {
            return node.attrs.label
          }
        }),
        CustomImageExtension.configure({
          allowBase64: true
        }),
        CustomKeyMap.configure({
          handleSubmitForm,
          clearEditor,
          recallPrompt,
          escape: handleEscape,
          approve: approveWaiting,
          interrupt: handleInterrupt,
          newConversation: startNewConversation,
          toggleShortcuts,
          toggleAgentMode: toggleAgentForEditor,
          scrollTranscript
        }),
        GhostText,
        Placeholder.configure({
          placeholder: t("placeholder"),
          // Still shown while the composer is off for want of a provider.
          showOnlyWhenEditable: false
        })
      ],
      // Typing into a recalled prompt makes it the draft.
      onUpdate: () => {
        composerRevisionRef.current++
        recallIndexRef.current = -1
        lastEscapeRef.current = 0
        if (showShortcutsRef.current) setShortcuts(false)
        updateSuggestionRef.current()
      }
    },
    [
      memoizedSuggestion,
      handleSubmitForm,
      clearEditor,
      recallPrompt,
      handleEscape,
      handleInterrupt,
      startNewConversation,
      t,
      imagesRef
    ]
  )

  useEffect(() => {
    editor?.setEditable(!chatDisabled)
  }, [editor, chatDisabled])

  const handleImageUpload = useCallback(
    (file: File) => {
      const reader = new FileReader()
      reader.onload = (e) => {
        const base64 = e.target?.result as string
        const imageData = base64.startsWith("data:")
          ? base64
          : `data:${file.type};base64,${base64.split(",").pop()}`
        const id = crypto.randomUUID()
        const newImage = { id, data: imageData, type: file.type }

        imagesRef.current = [...imagesRef.current, newImage]

        const { state } = editor?.view || {}

        if (state) {
          if (
            state.selection.empty &&
            state.selection.$head.pos === state.doc.content.size
          ) {
            editor?.chain().focus().createParagraphNear().run()
          }

          editor
            ?.chain()
            .focus()
            .insertContent({
              type: "image",
              attrs: { src: imageData, id }
            })
            .run()

          editor?.chain().focus().createParagraphNear().run()
        } else {
          editor
            ?.chain()
            .focus()
            .insertContent({
              type: "image",
              attrs: { src: imageData, id }
            })
            .run()
        }
      }
      reader.readAsDataURL(file)
    },
    [editor]
  )

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      const files = Array.from(e.dataTransfer.files).filter((file) =>
        file.type.startsWith("image/")
      )
      files.forEach(handleImageUpload)
    },
    [handleImageUpload]
  )

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLFormElement>) => {
      const items = Array.from(e.clipboardData?.items || [])
      const imageItem = items.find((item) => item.type.startsWith("image/"))

      if (imageItem) {
        e.preventDefault()
        const file = imageItem.getAsFile()
        if (file) handleImageUpload(file)
        return
      }
    },
    [handleImageUpload]
  )

  const handleFileSelect = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files || []).filter((file) =>
        file.type.startsWith("image/")
      )
      files.forEach(handleImageUpload)
      e.target.value = ""
    },
    [handleImageUpload]
  )

  const handleDeleteImage = (id: string) => {
    imagesRef.current = imagesRef.current.filter((img) => img.id !== id)
  }

  useAutosizeTextArea(chatRef, editorRef.current?.getText() || "")

  useEffect(() => {
    if (editor) editorRef.current = editor
    editorRef.current?.commands.focus()
  }, [editor])

  useEffect(() => {
    if (editorRef.current) {
      editorRef.current.extensionManager.extensions.forEach((extension) => {
        if (extension.name === "mention") {
          extension.options.suggestion = memoizedSuggestion
        }
      })
    }
  }, [memoizedSuggestion])

  useEffect(() => {
    if (composerHeight === null) {
      localStorage.removeItem(COMPOSER_HEIGHT_KEY)
      return
    }
    localStorage.setItem(COMPOSER_HEIGHT_KEY, String(composerHeight))
  }, [composerHeight])

  /*
   * Dragging the strip above the composer grows the typing area upwards,
   * so a long prompt can be written without the transcript being in the way.
   */
  const handleResizeStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const wrap = editorWrapRef.current
      if (!wrap) return
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      resizeRef.current = {
        startY: e.clientY,
        startHeight: wrap.getBoundingClientRect().height
      }
    },
    []
  )

  const handleResizeMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const resize = resizeRef.current
      if (!resize) return
      const max = Math.max(COMPOSER_MIN_HEIGHT, window.innerHeight - 140)
      const height = resize.startHeight + (resize.startY - e.clientY)
      setComposerHeight(Math.min(max, Math.max(COMPOSER_MIN_HEIGHT, height)))
    },
    []
  )

  /* Anywhere in the box is fair game for a click: focus the editor at the end. */
  const handleComposerMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement
      if (target.closest("button, input, a, .ProseMirror")) return
      e.preventDefault()
      editorRef.current?.commands.focus("end")
    },
    []
  )

  const handleResizeEnd = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!resizeRef.current) return
      resizeRef.current = null
      e.currentTarget.releasePointerCapture(e.pointerId)
    },
    []
  )

  const scrollToBottom = useCallback(() => {
    virtuosoRef.current?.scrollTo({
      top: Infinity,
      behavior: "auto"
    })
  }, [])

  const renderContextItem = useCallback(
    (item: AnyContextItem) => {
      let codicon = ""
      const displayName = item.name
      const title =
        "selectionRange" in item
          ? `${item.path} (lines ${item.selectionRange.startLine + 1}-${
              item.selectionRange.endLine + 1
            })`
          : item.path

      if (item.category === "files") {
        codicon = "codicon codicon-file-code"
      } else if (item.category === "selection") {
        codicon = "codicon codicon-symbol-snippet"
      }

      return (
        <div
          key={item.id}
          title={title}
          className={styles.contextItem}
          onClick={() => handleOpenFile(item.path)}
        >
          <span className={`${codicon} ${styles.contextItemIcon}`}></span>
          <span className={styles.contextItemName}>{displayName}</span>
          <span
            onClick={(e) => {
              e.stopPropagation()
              removeContextItem(item.id)
            }}
            data-id={item.id}
            className={cx("codicon codicon-close", styles.contextItemClose)}
          />
        </div>
      )
    },
    [handleOpenFile, removeContextItem]
  )

  const currentTodo = todoSnapshot?.conversationId === conversation?.id ? todoSnapshot : undefined
  const currentFeedback = feedbackState?.conversationId === conversation?.id ? feedbackState : undefined
  const feedbackPlanning = currentFeedback?.state === "planning" || currentFeedback?.state === "retrying"
  const activeTask = currentTodo?.items.find((item) => item.status === "in_progress")?.title
  const verifiedDone = currentTodo?.items.filter((item) => item.status === "completed").length ?? 0
  const verifiedTotal = currentTodo?.items.length ?? 0
  const lastToolStep = toolSteps[toolSteps.length - 1]
  const glyphState = agentGlyphState({
    enabled: agentSelection !== "off",
    toolsRunning: toolSteps.some((step) => step.status === "running"),
    toolsWaiting: toolSteps.some((step) => step.status === "waiting"),
    toolFailed: isLoading && lastToolStep?.status === "failed",
    feedbackPlanning,
    feedbackFailed: currentFeedback?.state === "failed",
    todoBlocked: !!currentTodo?.items.some((item) => item.status === "blocked"),
    generating: isLoading,
    celebration
  })
  const typingActivity = useMemo<TypingActivity>(
    () => ({
      reasoning,
      continuation,
      activeTask,
      feedbackPlanning,
      status: AGENT_GLYPHS[glyphState],
      verified: { done: verifiedDone, total: verifiedTotal }
    }),
    [reasoning, continuation, activeTask, feedbackPlanning, glyphState, verifiedDone, verifiedTotal]
  )

  const itemContent = useCallback(
    (index: number) => (
      <MessageItem
        key={`message-list-${index}`}
        completion={completion}
        context={searchReport}
        steps={toolSteps}
        activity={typingActivity}
        generatingRef={generatingRef}
        handleDeleteImage={handleDeleteImage}
        handleDeleteMessage={handleDeleteMessage}
        handleEditMessage={handleEditMessage}
        handleRegenerateMessage={handleRegenerateMessage}
        handleContinue={handleContinue}
        handleChangesUpdate={handleChangesUpdate}
        index={index}
        isLoading={isLoading}
        message={messages[index]}
        messages={messages}
      />
    ),
    [
      handleDeleteMessage,
      handleEditMessage,
      handleRegenerateMessage,
      handleContinue,
      handleChangesUpdate,
      isLoading,
      messages,
      completion,
      searchReport,
      toolSteps,
      typingActivity,
      generatingRef
    ]
  )

  return (
    <VSCodePanelView>
      <div className={styles.container}>
        {!!fullScreen && (
          <div className={styles.fullScreenActions}>
            <VSCodeButton
              onClick={handleNewConversation}
              appearance="icon"
              title={t("new-conversation")}
            >
              <i className="codicon codicon-comment-discussion" />
            </VSCodeButton>
            <VSCodeButton
              onClick={handleOpenAsMarkdown}
              appearance="icon"
              disabled={!messages.length}
              title={t("open-as-markdown")}
            >
              <i className="codicon codicon-markdown" />
            </VSCodeButton>
          </div>
        )}
        {!!contextItems.length && (
          <div className={styles.contextItems}>
            {contextItems.map(renderContextItem)}
          </div>
        )}
        <TodoPanel conversationId={conversation?.id} />
        <div className={styles.transcript}>
          {messages.length === 0 ? (
            <EmptyChat />
          ) : (
            <Virtuoso
              followOutput
              style={{ height: "100%" }}
              ref={virtuosoRef}
              data={messages}
              initialTopMostItemIndex={messages?.length}
              defaultItemHeight={800}
              itemContent={itemContent}
              atBottomThreshold={20}
              atBottomStateChange={(bottom) => setIsBottom(bottom)}
              alignToBottom
            />
          )}
        </div>
        {!!selection.length && (
          <Suggestions isDisabled={!!generatingRef.current || chatDisabled} />
        )}
        <div className={styles.chatOptions}>
          <div>
            {!isBottom && messages.length > 0 && (
              <VSCodeButton
                appearance="icon"
                className={styles.scrollDown}
                onClick={scrollToBottom}
                title={t("scroll-to-bottom")}
              >
                <i className="codicon codicon-arrow-down" />
              </VSCodeButton>
            )}
          </div>
          {hint ? (
            <span className={styles.selectionCount}>{hint}</span>
          ) : (
            !!selection.length && (
              <span className={styles.selectionCount}>
                {t("selection-chars", { chars: selection.length })}
              </span>
            )
          )}
        </div>
        <div className={cx(styles.composer, { [styles.agentBusy]: agentMode && (isLoading || generatingRef.current) })}>
          {showShortcuts && <Shortcuts />}
          {agentSettingsOpen && (
            <AgentSettings team={teamAgentRules} autoRun={autoRun} setAutoRun={setAutoRun} onClose={closeAgentSettings} agentSelection={agentSelection} />
          )}
          {!!queued.length && (
            <ol className={styles.queue} aria-label={t("queued-title")}>
              {queued.map((message) => (
                <li key={message.id} className={styles.queued}>
                  <span
                    className={styles.queuedLabel}
                    title={message.steer ? t("queued-steer-title") : undefined}
                  >
                    {t(message.steer ? "queued-steer" : "queued")}
                  </span>
                  <span className={styles.queuedText} title={message.text}>
                    {message.text}
                  </span>
                  <button
                    type="button"
                    className={styles.queuedRemove}
                    onClick={() => {
                      if (message.steer) emit(EVENT_NAME.twinnySteer, { id: message.id })
                      updateQueue(queuedRef.current.filter((entry) => entry.id !== message.id))
                    }}
                    title={t("queued-remove")}
                    aria-label={t("queued-remove")}
                  >
                    <i className="codicon codicon-close" />
                  </button>
                </li>
              ))}
            </ol>
          )}
          <div
            role="separator"
            aria-orientation="horizontal"
            title={t("resize-composer")}
            className={styles.resizeHandle}
            onPointerDown={handleResizeStart}
            onPointerMove={handleResizeMove}
            onPointerUp={handleResizeEnd}
            onPointerCancel={handleResizeEnd}
            onDoubleClick={() => setComposerHeight(null)}
          >
            <span className={styles.resizeGrip} />
          </div>
          {compileState && (
            <div className={styles.compileNotice} role="status" aria-live="polite">
              {compileState.status === "running" && (
                <>
                  <span className="codicon codicon-loading codicon-modifier-spin" aria-hidden="true" />
                  <span className={styles.compileNoticeText}>{t("prompt-compiler-running")}</span>
                  <button type="button" className={styles.compileNoticeAction} onClick={cancelCompile}>{t("prompt-compiler-cancel")}</button>
                </>
              )}
              {compileState.status === "offer" && (
                <>
                  <span className={styles.compileNoticeText}>{t("prompt-compiler-edited")}</span>
                  <button
                    type="button"
                    className={styles.compileNoticeAction}
                    onClick={() => {
                      replaceComposer(compileState.prompt)
                      setCompileState(null)
                    }}
                  >
                    {t("prompt-compiler-apply")}
                  </button>
                  <button type="button" className={styles.compileNoticeAction} onClick={cancelCompile}>{t("prompt-compiler-discard")}</button>
                </>
              )}
              {compileState.status === "error" && (
                <>
                  <span className="codicon codicon-error" aria-hidden="true" />
                  <span className={styles.compileNoticeText}>{compileState.message}</span>
                  <button type="button" className={styles.compileNoticeAction} onClick={cancelCompile}>{t("prompt-compiler-dismiss")}</button>
                </>
              )}
            </div>
          )}
          <form onDrop={handleDrop} onPaste={handlePaste}>
            <div
              className={cx(styles.chatBox, {
                [styles.chatBoxDisabled]: chatDisabled,
                [styles.agent]: agentMode
              })}
              title={chatDisabled ? t("chat-disabled-no-provider") : undefined}
              onMouseDown={handleComposerMouseDown}
            >
              <input
                type="file"
                ref={fileInputRef}
                onChange={handleFileChange}
                accept="image/*"
                multiple
                style={{ display: "none" }}
              />
              <span className={styles.prompt} aria-hidden="true">
                {agentMode ? <>&#10095;&#10095;</> : <>&#10095;</>}
              </span>
              <div
                ref={editorWrapRef}
                className={styles.editorWrap}
                style={
                  composerHeight === null
                    ? undefined
                    : { height: composerHeight, maxHeight: composerHeight }
                }
              >
                <EditorContent
                  className={styles.tiptap}
                  editor={editorRef.current}
                />
              </div>
              <div className={styles.modeSwitches}>
                <div className={styles.agentPicker} ref={agentPickerRef} data-agent-picker>
                  <span className={styles.agentGlyph} data-state={glyphState} title={AGENT_GLYPHS[glyphState].label} aria-hidden="true">{AGENT_GLYPHS[glyphState].glyph}</span>
                  <button
                    ref={agentPickerButtonRef}
                    type="button"
                    className={cx(styles.agentSelect, { [styles.agentToggleOn]: agentSelection !== "off" })}
                    aria-label="Select chat agent"
                    aria-haspopup="menu"
                    aria-expanded={agentMenuOpen}
                    aria-controls="twinny-agent-menu"
                    title={agentPickerError || agentPreferenceError || selectedAgentLabel}
                    aria-describedby={agentPickerError || agentPreferenceError ? "agent-picker-status" : undefined}
                    onClick={() => setAgentMenuOpen((open) => !open)}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                        event.preventDefault()
                        setAgentMenuOpen(true)
                      }
                    }}
                  >
                    <span>{selectedAgentLabel}</span>
                    <span className="codicon codicon-chevron-down" aria-hidden="true" />
                  </button>
                  {agentMenuOpen && (
                    <div className={styles.agentMenu} id="twinny-agent-menu" role="menu" aria-label="Chat agent">
                      {agentMenuOptions.map((option, index) => (
                        <button
                          key={option.value}
                          ref={(element) => { agentMenuItemsRef.current[index] = element }}
                          type="button"
                          role="menuitemradio"
                          aria-checked={agentSelection === option.value}
                          data-menu-index={index}
                          className={styles.agentMenuOption}
                          onKeyDown={handleAgentMenuKeyDown}
                          onClick={() => {
                            chooseAgentSelection(option.value)
                            setAgentMenuOpen(false)
                            setAgentSettingsOpen(false)
                          }}
                        >
                          {option.label}
                        </button>
                      ))}
                      <div className={styles.agentMenuSeparator} role="separator" />
                      <button
                        ref={(element) => { agentMenuItemsRef.current[agentMenuOptions.length] = element }}
                        type="button"
                        role="menuitem"
                        data-menu-index={agentMenuOptions.length}
                        className={styles.agentMenuOption}
                        onKeyDown={handleAgentMenuKeyDown}
                        onClick={() => {
                          setAgentMenuOpen(false)
                          setAgentSettingsOpen(true)
                        }}
                      >
                        + Manage Agents…
                      </button>
                    </div>
                  )}
                  <button
                    type="button"
                    className={styles.agentSettingsButton}
                    aria-label="Agent settings"
                    title="Agent settings"
                    onClick={() => {
                      setAgentMenuOpen(false)
                      setAgentSettingsOpen(true)
                    }}
                  >
                    <span className="codicon codicon-gear" aria-hidden="true" />
                  </button>
                  <span className={styles.switchKey}>{t("agent-mode-key")}</span>
                </div>
                {(agentPickerError || agentPreferenceError) && <span id="agent-picker-status" className={styles.agentPickerError} role="status" title={agentPickerError || agentPreferenceError}>{agentPickerError || agentPreferenceError}</span>}
                {autoRunAvailable && (
                  <button
                    type="button"
                    role="switch"
                    aria-checked={autoRun}
                    disabled={chatDisabled || !agentMode}
                    className={cx(styles.agentToggle, { [styles.agentToggleOn]: autoRun })}
                    onClick={toggleAutoRun}
                    title={t(autoRun ? "auto-run-on-title" : "auto-run-off-title")}
                  >
                    <span className="codicon codicon-terminal" aria-hidden="true" />
                    <span className={styles.switchLabel}>{t("auto-run")}</span>
                  </button>
                )}

              </div>
              <div className={styles.chatButtons}>
                <VSCodeButton
                  appearance="icon"
                  role="button"
                  disabled={chatDisabled}
                  onClick={handleFileSelect}
                  title={t("upload-image")}
                >
                  <span className="codicon codicon-device-camera" />
                </VSCodeButton>
                {isLoading ? (
                  <VSCodeButton
                    appearance="icon"
                    role="button"
                    className={cx(styles.stopButton, { [styles.stopping]: operationPhase === "stopping" })}
                    aria-busy={operationPhase === "stopping"}
                    onClick={handleStopGeneration}
                    title={t("stop-generation-esc")}
                    aria-label={t("stop-generation")}
                  >
                    <span className="codicon codicon-debug-stop"></span>
                  </VSCodeButton>
                ) : (
                  <VSCodeButton
                    appearance="icon"
                    role="button"
                    disabled={chatDisabled}
                    onClick={handleSendClick}
                    title={promptCompilerEnabled ? t("send-compile-hint", { gesture: IS_MAC ? "⌘" : "Ctrl" }) : t("send")}
                    aria-label={t("send")}
                    aria-busy={compileState?.status === "running"}
                  >
                    <span className="codicon codicon-send"></span>
                  </VSCodeButton>
                )}
              </div>
            </div>
          </form>
          <div className={styles.footer}>
            <ProviderSelect />
            <button
              type="button"
              className={styles.shortcutsHint}
              onClick={toggleShortcuts}
              aria-expanded={showShortcuts}
              title={t("shortcuts-hint")}
            >
              <span className={styles.shortcutsHintText}>{t("shortcuts-hint")}</span>
              <span className={styles.shortcutsHintKey}>?</span>
            </button>
          </div>
        </div>
      </div>
    </VSCodePanelView>
  )
}
