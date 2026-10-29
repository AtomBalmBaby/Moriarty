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
import { nextAgentSelection, withAgentSelection } from "../common/agents"
import { ASSISTANT, EVENT_NAME, USER } from "../common/constants"
import {
  AnyContextItem,
  ChatCompletionMessage,
  ImageAttachment,
  MentionType,
  ReplyChangesView,
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
import { EmptyChat } from "./empty-chat"
import { GhostText } from "./ghost-text"
import { createCustomImageExtension } from "./image-extension"
import MessageItem from "./message-item"
import { bridge, emit, useServerEvent } from "./messaging"
import { Shortcuts } from "./shortcuts"
import { Suggestions } from "./suggestions"
import { answerToolStep } from "./tool-steps"
import { conversationMarkdown } from "./transcript"
import { CustomKeyMap, getThinkingMessage } from "./utils"

import styles from "./styles/chat.module.css"

const COMPOSER_MIN_HEIGHT = 44
const COMPOSER_HEIGHT_KEY = "twinny.composerHeight"
const PROMPT_HISTORY_KEY = "twinny.promptHistory"
const PROMPT_HISTORY_LIMIT = 50
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

interface IntentCompilerReview {
  objective: string
  prompt: string
  constraints: string[]
  exclusions: string[]
  strategy?: string
  verification: string[]
  assumptions: string[]
  originalPrompt: string
  waiting?: boolean
  error?: string
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
  const [isLoading, setIsLoading] = useState(false)
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
  const { conversation, saveLastConversation, setActiveConversation } = useConversationHistory()
  const { agentMode, teamAgentRules, agentSelection, storedAgentSelection, lastAgentSelection, setAgentSelection, resetAgentSelectionForNewChat, agentPreferenceError } = useAgentMode(
    agentProfiles.filter((profile) => profile.enabled && profile.valid && profile.userInvocable).map((profile) => profile.id)
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
  const [intentCompilerEnabled, setIntentCompilerEnabled] = useState(false)
  const [intentCompilerMode, setIntentCompilerMode] = useState("ask")
  const [intentCompilerMaxTurns, setIntentCompilerMaxTurns] = useState(3)
  const syncIntentCompilerSettings = useCallback(async () => {
    try {
      const enabled = await bridge.request(EVENT_NAME.twinnyGetConfigValue, {
        key: "chatToolsIntentCompilerEnabled"
      })
      const mode = await bridge.request(EVENT_NAME.twinnyGetConfigValue, {
        key: "chatToolsIntentCompilerMode"
      })
      const maxTurns = await bridge.request(EVENT_NAME.twinnyGetConfigValue, {
        key: "chatToolsIntentCompilerMaxTurns"
      })
      if (typeof enabled?.value === "boolean") setIntentCompilerEnabled(enabled.value)
      if (typeof mode?.value === "string") setIntentCompilerMode(mode.value)
      if (typeof maxTurns?.value === "number") setIntentCompilerMaxTurns(Math.max(0, Math.min(10, Math.round(maxTurns.value))))
      else {
        const legacyMaxTurns = await bridge
          .request(EVENT_NAME.twinnyGetConfigValue, { key: "chatToolsIntentCompilerMaxLevels" })
          .catch(() => undefined)
        if (typeof legacyMaxTurns?.value === "number") {
          setIntentCompilerMaxTurns(Math.max(0, Math.min(10, Math.round(legacyMaxTurns.value))))
        }
      }
    } catch {
      // Keep the current UI state when the config cannot be read.
    }
  }, [])
  useServerEvent(EVENT_NAME.twinnyConfigValueChanged, ({ key, value }) => {
    if (key === "chatToolsIntentCompilerEnabled" && typeof value === "boolean") {
      setIntentCompilerEnabled(value)
    }
    if (key === "chatToolsIntentCompilerMode" && typeof value === "string") {
      setIntentCompilerMode(value)
    }
    if (key === "chatToolsIntentCompilerMaxTurns" && typeof value === "number") {
      setIntentCompilerMaxTurns(Math.max(0, Math.min(10, Math.round(value))))
    }
    if (key === "chatToolsIntentCompilerMaxLevels" && typeof value === "number") {
      setIntentCompilerMaxTurns(Math.max(0, Math.min(10, Math.round(value))))
    }
  })
  const [intentCompilerReview, setIntentCompilerReview] = useState<{
    originalPrompt: string
    draft: string
    review: IntentCompilerReview
    message: QueuedMessage
    rememberChoice: boolean
    waiting?: boolean
    error?: string
  } | null>(null)
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
        setAgentPickerError("")
      })
      .catch((error) => {
        if (cancelled) return
        setAgentPickerError(error instanceof Error ? error.message : String(error))
        setAgentProfilesLoaded(false)
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
    setAgentPickerError("")
  })

  useEffect(() => {
    if (!agentProfilesLoaded || storedAgentSelection === "off" || storedAgentSelection === "default") return
    const selected = agentProfiles.find((profile) => profile.id === storedAgentSelection)
    if (selected?.valid && selected.enabled && selected.userInvocable) return
    setAgentSelection("off")
    emit(EVENT_NAME.twinnyNotification, "The selected agent is unavailable or disabled. Agent selection was reset to Agent off.")
  }, [agentProfiles, agentProfilesLoaded, setAgentSelection, storedAgentSelection])

  useEffect(() => {
    void syncIntentCompilerSettings()
  }, [syncIntentCompilerSettings])

  useEffect(() => {
    setIntentCompilerReview(null)
  }, [conversation?.id])

  const chatRef = useRef<HTMLTextAreaElement>(null)
  const intentReviewTextareaRef = useRef<HTMLTextAreaElement | null>(null)
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

  const handleAddMessage = (added: ChatCompletionMessage | undefined) => {
    if (!added) {
      setCompletion(null)
      setIsLoading(false)
      generatingRef.current = false
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
    setIsLoading(false)
  }

  useServerEvent(EVENT_NAME.twinnyAddMessage, (incoming) => {
    generatingRef.current = true
    handleAddMessage(incoming)
  })

  useServerEvent(EVENT_NAME.twinnyOnCompletion, (incoming) => {
    completionRef.current = incoming
    setCompletion(incoming)
  })

  useServerEvent(EVENT_NAME.twinnyOnLoading, () => setIsLoading(true))

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
    generatingRef.current = false
    setIsLoading(false)
    chatRef.current?.focus()
    setTimeout(() => {
      stopRef.current = false
    }, 1000)
  })

  useServerEvent(EVENT_NAME.twinnyStopGeneration, () => {
    setIsLoading(false)
    setCompletion(null)
    stopRef.current = false
    generatingRef.current = false
    const stopped = userStoppedRef.current
    userStoppedRef.current = false
    const [next, ...rest] = queuedRef.current
    if (next && !stopped) {
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
    emit(EVENT_NAME.twinnyStopGeneration)
  }, [])

  const handleRegenerateMessage = (
    index: number,
    mentions: MentionType[] | undefined
  ): void => {
    generatingRef.current = true
    setIsLoading(true)
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
    generatingRef.current = true
    setIsLoading(true)
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
    emit(EVENT_NAME.twinnyStopGeneration)
    return true
  }, [])

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
    generatingRef.current = true
    setIsLoading(true)
    clearSearchReport()
    clearToolSteps()

    const conversationId = conversation?.id || uuidv4()

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

    return completed.slice(-Math.max(0, Math.round(intentCompilerMaxTurns)) * 2)
  }, [conversation?.messages, messages, intentCompilerMaxTurns])

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
      html,
      input,
      text,
      mentions: getMentions(),
      images: imagesRef.current
    }
    imagesRef.current = []
    clearEditor()
    rememberPrompt(html)

    if (generatingRef.current) {
      // In agent mode the model can read it between steps; one that brings
      // files or images waits for a turn of its own, where those are added.
      const steer = agentModeRef.current && !message.mentions.length && !message.images.length
      updateQueue([...queuedRef.current, { ...message, steer }])
      if (steer) emit(EVENT_NAME.twinnySteer, { id: message.id, text: steeringText(input) })
      return
    }

    const currentIntentCompilerEnabled =
      intentCompilerEnabled ||
      (await bridge
        .request(EVENT_NAME.twinnyGetConfigValue, { key: "chatToolsIntentCompilerEnabled" })
        .then((answer) => typeof answer?.value === "boolean" ? answer.value : false)
        .catch(() => false))
    const currentIntentCompilerMode =
      intentCompilerMode ||
      (await bridge
        .request(EVENT_NAME.twinnyGetConfigValue, { key: "chatToolsIntentCompilerMode" })
        .then((answer) => (typeof answer?.value === "string" ? answer.value : "ask"))
        .catch(() => "ask"))
    const currentIntentCompilerMaxTurns =
      typeof intentCompilerMaxTurns === "number"
        ? intentCompilerMaxTurns
        : await bridge
            .request(EVENT_NAME.twinnyGetConfigValue, { key: "chatToolsIntentCompilerMaxTurns" })
            .then((answer) => (typeof answer?.value === "number" ? answer.value : 3))
            .catch(() => 3)

    if (agentMode && currentIntentCompilerEnabled && currentIntentCompilerMode !== "always-original") {
      setIntentCompilerReview({
        originalPrompt: message.text,
        draft: message.text,
        review: {
          objective: "Refining your request…",
          prompt: message.text,
          constraints: [],
          exclusions: [],
          verification: ["Waiting for the compiler to return a refined prompt."],
          assumptions: ["Twinny is checking whether a clearer execution prompt is needed."],
          originalPrompt: message.text
        },
        message: { ...message, originalPrompt: message.text },
        rememberChoice: false,
        waiting: true
      })

      const review = await bridge
        .request(EVENT_NAME.twinnyCompileIntent, {
          prompt: message.text,
          history: resolveCompilerHistory(),
          maxLevels: Math.max(0, Math.round(currentIntentCompilerMaxTurns))
        })
        .catch(() => undefined)

      if (review && review.prompt && review.prompt.trim() !== message.text.trim()) {
        if (currentIntentCompilerMode === "always-refined") {
          setIntentCompilerReview(null)
          sendRef.current({
            ...message,
            originalPrompt: message.text,
            input: review.prompt,
            prompt: review.prompt,
            text: review.prompt,
            html: review.prompt
          })
          return
        }
        setIntentCompilerReview({
          originalPrompt: message.text,
          draft: review.prompt,
          review: {
            ...review,
            originalPrompt: review.originalPrompt ?? message.text,
            constraints: review.constraints ?? [],
            exclusions: review.exclusions ?? [],
            verification: review.verification ?? [],
            assumptions: review.assumptions ?? []
          },
          message: { ...message, originalPrompt: message.text },
          rememberChoice: false
        })
        return
      }

      setIntentCompilerReview({
        originalPrompt: message.text,
        draft: message.text,
        review: {
          objective: review && review.prompt ? "The compiler kept the original request." : "The compiler did not return a usable refinement.",
          prompt: message.text,
          constraints: [],
          exclusions: [],
          verification: ["Run the original request, or edit the draft before executing."],
          assumptions: [review ? "The model returned no material change to the request." : "The compiler timed out or failed to return valid JSON."],
          originalPrompt: message.text
        },
        message: { ...message, originalPrompt: message.text },
        rememberChoice: false,
        error: review ? "The compiler kept the original wording, so Twinny is offering the original request instead." : "The compiler timed out or returned an invalid result. You can run the original request or edit the prompt before sending."
      })
      return
    }

    sendRef.current(message)
  }, [agentMode, chatDisabled, intentCompilerEnabled, intentCompilerMode])

  /*
   * A stopped reply is picked up by asking for the rest. The transcript
   * shows a short "Continue"; the model is told not to start over. One that
   * ran out of tool steps goes back to the task, with what its tools did
   * in the notes this turn carries.
   */
  const handleContinue = useCallback(() => {
    if (generatingRef.current || chatDisabled) return
    generatingRef.current = true
    setIsLoading(true)
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

  const itemContent = useCallback(
    (index: number) => (
      <MessageItem
        key={`message-list-${index}`}
        completion={completion}
        context={searchReport}
        steps={toolSteps}
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
        <div className={styles.transcript}>
          {intentCompilerReview ? (
            <div className={styles.intentReviewPanel}>
              <div className={styles.intentReviewHead}>
                {intentCompilerReview.waiting
                  ? "Refining your request…"
                  : "I refined your request. Does this capture your intent?"}
              </div>
              {!!intentCompilerReview.error && (
                <div className={styles.intentReviewSummary}>
                  <span className={styles.intentLabel}>Status</span>
                  <div>{intentCompilerReview.error}</div>
                </div>
              )}
              <div className={styles.intentReviewSection}>
                <textarea
                  ref={intentReviewTextareaRef}
                  value={intentCompilerReview.draft}
                  onChange={(event) =>
                    setIntentCompilerReview((current) =>
                      current ? { ...current, draft: event.target.value } : current
                    )
                  }
                  className={styles.intentReviewTextarea}
                  disabled={intentCompilerReview.waiting}
                />
              </div>
              <div className={styles.intentReviewActions}>
                <VSCodeButton disabled={intentCompilerReview.waiting} onClick={() => {
                    const next = {
                      ...intentCompilerReview.message,
                      input: intentCompilerReview.draft,
                      prompt: intentCompilerReview.draft,
                      text: intentCompilerReview.draft,
                      html: intentCompilerReview.draft,
                      originalPrompt: intentCompilerReview.originalPrompt
                    }
                    setIntentCompilerReview(null)
                    if (intentCompilerReview.rememberChoice) {
                      emit(EVENT_NAME.twinnySetConfigValue, { key: "chatToolsIntentCompilerEnabled", value: true })
                      emit(EVENT_NAME.twinnySetConfigValue, { key: "chatToolsIntentCompilerMode", value: "always-refined" })
                    }
                    sendRef.current(next)
                }}>{intentCompilerReview.waiting ? "Waiting…" : "Run Refined"}</VSCodeButton>
                <VSCodeButton appearance="secondary" onClick={() => {
                    const next = {
                      ...intentCompilerReview.message,
                      input: intentCompilerReview.originalPrompt,
                      prompt: intentCompilerReview.originalPrompt,
                      text: intentCompilerReview.originalPrompt,
                      html: intentCompilerReview.originalPrompt,
                      originalPrompt: intentCompilerReview.originalPrompt
                    }
                    setIntentCompilerReview(null)
                    if (intentCompilerReview.rememberChoice) {
                      emit(EVENT_NAME.twinnySetConfigValue, { key: "chatToolsIntentCompilerEnabled", value: true })
                      emit(EVENT_NAME.twinnySetConfigValue, { key: "chatToolsIntentCompilerMode", value: "always-original" })
                    }
                    sendRef.current(next)
                }}>Run Original</VSCodeButton>
                <VSCodeButton appearance="secondary" disabled={intentCompilerReview.waiting} onClick={() => intentReviewTextareaRef.current?.focus()}>
                  Edit Refined
                </VSCodeButton>
                <label>
                  <input
                    type="checkbox"
                    checked={intentCompilerReview.rememberChoice}
                    onChange={(event) => setIntentCompilerReview((current) => current ? { ...current, rememberChoice: event.target.checked } : current)}
                  />
                  Always choose this option
                </label>
              </div>
            </div>
          ) : messages.length === 0 ? (
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
                  <span className="codicon codicon-hubot" aria-hidden="true" />
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
                {generatingRef.current ? (
                  <VSCodeButton
                    appearance="icon"
                    role="button"
                    className={styles.stopButton}
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
                    onClick={handleSubmitForm}
                    title={t("send")}
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
