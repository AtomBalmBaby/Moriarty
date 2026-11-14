import { createElement, Fragment, type ReactNode } from "react"
import { JSDOM } from "jsdom"
import assert from "node:assert/strict"
import Module from "node:module"
import path from "node:path"
import { test } from "node:test"

import { CONVERSATION_EVENT_NAME, EVENT_NAME, TODO_EVENT_NAME } from "../../common/constants/events"
import { applyTodoSnapshot, isStaleTodoSnapshot, snapshotForConversation } from "../../common/guards"
import type { ChatCompletionMessage, TodoItem, TodoListSnapshot } from "../../common/types"
import {
  composerIsBusy,
  ComposerOperationEvent,
  ComposerOperationPhase,
  continuablePausedIndex,
  isPausedReply,
  reduceComposerOperation,
  resumePausedReply,
  stopPausedReply
} from "../../webview/composer-operation"

/** The composer's button for each host event, in the order the host sends them. */
const replay = (events: ComposerOperationEvent[]) => {
  let phase: ComposerOperationPhase = "idle"
  return events.map((event) => {
    phase = reduceComposerOperation(phase, event)
    return { phase, stop: composerIsBusy(phase) }
  })
}

test("Pause stays through Feedback, replies, and continuations until the terminal event", () => {
  const trace = replay([
    { type: "started" },
    { type: "started" },
    { type: "started" }
  ])
  assert.ok(trace.every((step) => step.stop))
  const done = reduceComposerOperation(trace.at(-1)!.phase, { type: "terminal" })
  assert.equal(composerIsBusy(done), false)
})

test("a pause request interrupts a running task, which then leaves the composer usable", () => {
  const trace = replay([
    { type: "started" },
    { type: "pause-requested" },
    { type: "terminal", paused: true }
  ])
  assert.deepEqual(trace.map((step) => step.phase), ["running", "paused", "paused"])
  assert.deepEqual(trace.map((step) => step.stop), [true, false, false])
})

test("a late start cannot undo a pause, and only Continue resumes it", () => {
  assert.equal(reduceComposerOperation("paused", { type: "started" }), "paused")
  assert.equal(reduceComposerOperation("paused", { type: "continue-requested" }), "running")
  assert.equal(reduceComposerOperation("running", { type: "continue-requested" }), "running")
})

test("duplicate pause and continue requests are no-ops", () => {
  const paused = reduceComposerOperation("running", { type: "pause-requested" })
  assert.equal(reduceComposerOperation(paused, { type: "pause-requested" }), "paused")
  const running = reduceComposerOperation(paused, { type: "continue-requested" })
  assert.equal(reduceComposerOperation(running, { type: "continue-requested" }), "running")
})

test("Stop from a paused task ends it at once; while running it waits for the host", () => {
  assert.equal(reduceComposerOperation("paused", { type: "stop-requested" }), "idle")
  assert.equal(reduceComposerOperation("running", { type: "stop-requested" }), "running")
})

test("a paused terminal stays paused, but a plain terminal returns the composer to idle", () => {
  assert.equal(reduceComposerOperation("running", { type: "terminal", paused: true }), "paused")
  assert.equal(reduceComposerOperation("paused", { type: "terminal" }), "idle")
  assert.equal(reduceComposerOperation("running", { type: "terminal" }), "idle")
})

test("pause and stop requests while idle do nothing", () => {
  assert.equal(reduceComposerOperation("idle", { type: "pause-requested" }), "idle")
  assert.equal(reduceComposerOperation("idle", { type: "stop-requested" }), "idle")
})

test("a reply message alone never returns the composer to Send", () => {
  // Per-request replies are not operation events, so they cannot change the phase.
  const phase = reduceComposerOperation("running", { type: "started" })
  assert.equal(composerIsBusy(phase), true)
})

const pausedReply = (): ChatCompletionMessage[] => [
  { role: "user", content: "Write it" },
  { role: "assistant", content: "Partial", meta: { stopped: true, durationMs: 4200, task: { operationId: "op-1", state: "paused" } } }
]

test("a new message starts work from any phase, so it never needs a Stop first", () => {
  assert.equal(reduceComposerOperation("paused", { type: "submitted" }), "running")
  assert.equal(reduceComposerOperation("idle", { type: "submitted" }), "running")
  assert.equal(reduceComposerOperation("running", { type: "submitted" }), "running")
})

test("a paused reply is stoppable and continuable; a legacy stopped reply is paused only while last", () => {
  const paused = pausedReply()
  assert.equal(isPausedReply(paused, 1), true)
  const withNext: ChatCompletionMessage[] = [...paused, { role: "user", content: "Next" }]
  assert.equal(isPausedReply(withNext, 1), true)
  const legacy: ChatCompletionMessage[] = [{ role: "assistant", content: "Cut", meta: { stopped: true } }]
  assert.equal(isPausedReply(legacy, 0), true)
  const legacyEarlier: ChatCompletionMessage[] = [...legacy, { role: "user", content: "Next" }]
  assert.equal(isPausedReply(legacyEarlier, 0), false)
  assert.equal(isPausedReply([{ role: "assistant", content: "Done", meta: { durationMs: 1 } }], 0), false)
})

test("stopPausedReply ends a paused task for good, once, and keeps its content", () => {
  const stopped = stopPausedReply(pausedReply(), 1)
  assert.deepEqual(stopped.at(-1)?.meta, { stopped: true, durationMs: 4200, task: { operationId: "op-1", state: "stopped" } })
  assert.equal(stopped.at(-1)?.content, "Partial")
  assert.equal(isPausedReply(stopped, 1), false)
  assert.equal(stopPausedReply(stopped, 1), stopped)
})

test("stopPausedReply closes a legacy stopped reply without inventing an operation", () => {
  const legacy: ChatCompletionMessage[] = [{ role: "assistant", content: "Cut", meta: { stopped: true } }]
  assert.deepEqual(stopPausedReply(legacy, 0).at(-1)?.meta, { stopped: true, task: { state: "stopped" } })
})

test("resumePausedReply hands the last paused reply to Continue without the paused or stopped marks", () => {
  const resumed = resumePausedReply(pausedReply())
  assert.deepEqual(resumed.at(-1)?.meta, { durationMs: 4200 })
  assert.deepEqual(resumed.map((message) => message.content), ["Write it", "Partial"])
})

test("stop and resume leave replies that are not paused alone", () => {
  const plain: ChatCompletionMessage[] = [{ role: "assistant", content: "Done", meta: { stopped: true, task: { operationId: "op-2", state: "stopped" } } }]
  assert.equal(stopPausedReply(plain, 0), plain)
  assert.equal(resumePausedReply(plain), plain)
  const earlier = [...pausedReply(), { role: "user" as const, content: "Later" }]
  assert.equal(resumePausedReply(earlier), earlier)
})

test("host notices after a paused reply keep Continue on it, and resume leaves the notices alone", () => {
  const notices: ChatCompletionMessage[] = [
    ...pausedReply(),
    { role: "assistant", content: "Execution is paused: waiting for review" },
    { role: "assistant", content: "Authoritative TODO status for plan plan-001 (revision 1)." }
  ]
  assert.equal(continuablePausedIndex(notices), 1)
  const resumed = resumePausedReply(notices)
  assert.deepEqual(resumed[1].meta, { durationMs: 4200 })
  assert.deepEqual(resumed.slice(2), notices.slice(2))
})

test("only the newest paused reply without a user turn after it is continuable", () => {
  assert.equal(continuablePausedIndex(pausedReply()), 1)
  assert.equal(continuablePausedIndex([...pausedReply(), { role: "user", content: "Other work" }]), -1)
  const empty: ChatCompletionMessage[] = [
    { role: "user", content: "Read it" },
    { role: "assistant", content: "", meta: { durationMs: 900, task: { operationId: "op-3", state: "paused" } } }
  ]
  assert.equal(continuablePausedIndex(empty), 1)
  assert.equal(continuablePausedIndex([{ role: "user", content: "Hi" }]), -1)
})

// The tests below drive the real `Chat` component under jsdom. Host events
// arrive as window messages, and every webview post lands in `outbound`.

const outbound: { type: string; data?: unknown; id?: string }[] = []

// `getList` answers from the lists the host holds for each conversation.
const todoLists = new Map<string, TodoListSnapshot>()

// While set, `getList` replies are queued instead of sent, so a test can release a slow host's answers in any order.
let heldListReplies: { conversationId: string; reply: () => void }[] | undefined

/** The host's answer to a webview request on mount, shaped as the webview expects each reply. */
const hostReply = (type: string, request?: unknown): unknown => {
  if (type === EVENT_NAME.twinnyAgentRegistry) return []
  if (type === EVENT_NAME.twinnyTextSelection) return ""
  if (type === TODO_EVENT_NAME.getList) return todoLists.get((request as { conversationId: string }).conversationId)
  return {}
}

class InertObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/** Renders each transcript row in place, the way Virtuoso would once it had measured them. */
const VirtuosoStub = (props: {
  data?: unknown[]
  itemContent: (index: number, item: unknown) => unknown
}) =>
  createElement(
    "div",
    null,
    (props.data ?? []).map((item, index) => createElement(Fragment, { key: index }, props.itemContent(index, item) as ReactNode))
  )

/** CSS modules resolve each class to its own name, so `styles.replyStopped` is "replyStopped". */
const classNames = new Proxy({}, { get: (_target, key) => (typeof key === "string" ? key : undefined) })

const startWebview = async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
    pretendToBeVisual: true
  })
  const { window } = dom
  Object.assign(window, {
    matchMedia: () => ({
      matches: false,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined
    })
  })
  const globals: Record<string, unknown> = {
    window,
    document: window.document,
    navigator: window.navigator,
    MessageEvent: window.MessageEvent,
    MouseEvent: window.MouseEvent,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: (callback: FrameRequestCallback) => window.setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (id: number) => window.clearTimeout(id),
    ResizeObserver: InertObserver,
    IntersectionObserver: InertObserver,
    acquireVsCodeApi: () => ({
      postMessage: (message: { type: string; data?: unknown; id?: string }) => {
        outbound.push(message)
        // Requests the webview makes on mount need a reply, or their 30s timers outlive the test.
        if (message.id) {
          const reply = () =>
            window.dispatchEvent(
              new window.MessageEvent("message", {
                data: { type: message.type, id: message.id, data: hostReply(message.type, message.data) }
              })
            )
          if (heldListReplies && message.type === TODO_EVENT_NAME.getList) {
            heldListReplies.push({ conversationId: (message.data as { conversationId: string }).conversationId, reply })
          } else {
            queueMicrotask(reply)
          }
        }
      },
      getState: () => undefined,
      setState: () => undefined
    }),
    IS_REACT_ACT_ENVIRONMENT: true
  }
  for (const name of Object.getOwnPropertyNames(window)) {
    if (!(name in globalThis)) {
      Object.defineProperty(globalThis, name, { value: Reflect.get(window, name), configurable: true, writable: true })
    }
  }
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  }
  const loader = Module as unknown as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown
  }
  const loadModule = loader._load
  // tiptap-markdown is `type: module`, so its UMD build breaks under require(). The webview bundler
  // uses the ES build, and the harness loads the same entry. react-syntax-highlighter's ESM subpaths
  // use extensionless imports Node cannot load, so the harness loads their CJS twins.
  const esEntries = new Map([
    ["tiptap-markdown", path.join(path.dirname(require.resolve("tiptap-markdown")), "tiptap-markdown.es.js")]
  ])
  loader._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request.endsWith(".css")) return { __esModule: true, default: classNames }
    // Virtuoso sizes its rows from layout, which jsdom does not have, so it would render no transcript.
    // The stub renders every row in order instead; the scroll handle is unused under test.
    if (request === "react-virtuoso") return { __esModule: true, Virtuoso: VirtuosoStub }
    const target = esEntries.get(request) ?? request.replace("react-syntax-highlighter/dist/esm/", "react-syntax-highlighter/dist/cjs/")
    return loadModule.call(this, target, parent, isMain)
  }

  // The webview entry initialises i18n. Without it `t` changes identity on every render, which
  // makes tiptap re-create the editor in a loop.
  await import("../../webview/i18n")
  const { act, createElement } = await import("react")
  const { createRoot } = await import("react-dom/client")
  const { Chat } = await import("../../webview/chat")
  return { window, act, createElement, createRoot, Chat }
}

let webview: ReturnType<typeof startWebview> | undefined
const loadWebview = () => (webview ??= startWebview())

const mountChat = async () => {
  const { act, createElement, createRoot, Chat, window } = await loadWebview()
  const container = window.document.createElement("div")
  window.document.body.append(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(createElement(Chat, { fullScreen: true }))
  })
  return {
    document: window.document,
    unmount: async () => {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    }
  }
}

/** Delivers a host message to the webview exactly as the extension bridge does. */
const sendHost = async (type: string, data?: unknown): Promise<void> => {
  const { act, window } = await loadWebview()
  await act(async () => {
    window.dispatchEvent(new window.MessageEvent("message", { data: { type, data } }))
  })
}

// Accessible names as rendered from the English locale.
const PAUSE_LABEL = "Pause generation"
const SEND_LABEL = "Send"

const clickPause = async (document: Document): Promise<void> => {
  const { act, window } = await loadWebview()
  const pause = document.querySelector<HTMLElement>(`[aria-label="${PAUSE_LABEL}"]`)
  assert.ok(pause, "the Pause button should be rendered before it is clicked")
  await act(async () => {
    pause.dispatchEvent(new window.MouseEvent("click", { bubbles: true }))
  })
}

/** Clicks a footer control on the paused or stopped reply, by its visible label. */
const footerButton = (document: Document, label: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label)

const clickFooterButton = async (document: Document, label: string): Promise<void> => {
  const { act, window } = await loadWebview()
  const button = footerButton(document, label)
  assert.ok(button, `the "${label}" control should be rendered`)
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }))
  })
}

/** The composer button the user can see: Pause while running, otherwise Send. */
const visibleButton = (document: Document): "pause" | "send" | "none" => {
  if (document.querySelector(`[aria-label="${PAUSE_LABEL}"]`)) return "pause"
  if (document.querySelector(`[aria-label="${SEND_LABEL}"]`)) return "send"
  return "none"
}

const postedPauses = (): { type: string; data?: unknown; id?: string }[] =>
  outbound.filter((message) => message.type === EVENT_NAME.twinnyPauseGeneration)

const postedStops = (): { type: string; data?: unknown; id?: string }[] =>
  outbound.filter((message) => message.type === EVENT_NAME.twinnyStopGeneration)

const postedChats = (): { type: string; data?: unknown; id?: string }[] =>
  outbound.filter((message) => message.type === EVENT_NAME.twinnyChatMessage)

const hasText = (document: Document, text: string): boolean => document.body.textContent?.includes(text) ?? false

test("the Pause button stays visible through Feedback review and automatic continuation", async () => {
  outbound.length = 0
  const chat = await mountChat()
  try {
    assert.equal(visibleButton(chat.document), "send")

    await sendHost(EVENT_NAME.twinnyOnLoading, { continuation: 0 })
    assert.equal(visibleButton(chat.document), "pause")

    // The first request has replied; the host is still working (Feedback review, then the next request).
    await sendHost(EVENT_NAME.twinnyOnCompletion, { role: "assistant", content: "First request" })
    assert.equal(visibleButton(chat.document), "pause")

    // The gap before the continuation is dispatched carries no host event.
    assert.equal(visibleButton(chat.document), "pause")

    await sendHost(EVENT_NAME.twinnyOnLoading, { continuation: 1 })
    assert.equal(visibleButton(chat.document), "pause")

    await sendHost(EVENT_NAME.twinnyOnCompletion, { role: "assistant", content: "Continuation" })
    assert.equal(visibleButton(chat.document), "pause")
    assert.equal(postedPauses().length, 0)
    assert.equal(postedStops().length, 0)
  } finally {
    await chat.unmount()
  }
})

test("Pause interrupts the task, leaves the composer usable, and ignores late events", async () => {
  outbound.length = 0
  const chat = await mountChat()
  try {
    await sendHost(EVENT_NAME.twinnyOnLoading, { continuation: 0 })
    await clickPause(chat.document)

    assert.equal(postedPauses().length, 1)
    assert.equal(postedStops().length, 0)
    assert.equal(visibleButton(chat.document), "send")

    // Late events from the paused operation must not make the composer busy again.
    await sendHost(EVENT_NAME.twinnyOnLoading, { continuation: 1 })
    await sendHost(EVENT_NAME.twinnyOnCompletion, { role: "assistant", content: "Late reply" })
    assert.equal(visibleButton(chat.document), "send")
    assert.equal(postedPauses().length, 1)

    await sendHost(EVENT_NAME.twinnyStopGeneration, { cancelled: true, paused: true })
    assert.equal(visibleButton(chat.document), "send")
  } finally {
    await chat.unmount()
  }
})

test("a webview reconnect during an operation restores Pause once the host re-announces it", async () => {
  outbound.length = 0
  const first = await mountChat()
  await sendHost(EVENT_NAME.twinnyOnLoading, { continuation: 1 })
  assert.equal(visibleButton(first.document), "pause")
  await first.unmount()

  outbound.length = 0
  const second = await mountChat()
  try {
    assert.ok(
      outbound.some((message) => message.type === EVENT_NAME.twinnySidebarReady),
      "a fresh webview announces itself to the host"
    )
    // The host answers the announcement by re-sending the active operation.
    await sendHost(EVENT_NAME.twinnyOnLoading, { continuation: 1 })
    assert.equal(visibleButton(second.document), "pause")

    await clickPause(second.document)
    assert.equal(postedPauses().length, 1)
    assert.equal(visibleButton(second.document), "send")

    await sendHost(EVENT_NAME.twinnyStopGeneration, { cancelled: true, paused: true })
    assert.equal(visibleButton(second.document), "send")
  } finally {
    await second.unmount()
  }
})

const PAUSED_REPLY: ChatCompletionMessage = {
  role: "assistant",
  content: "Partial answer",
  meta: { stopped: true, durationMs: 4200, task: { operationId: "op-7", state: "paused" } }
}

test("a paused reply shows its duration, paused, and Continue and Stop controls", async () => {
  outbound.length = 0
  const chat = await mountChat()
  try {
    await sendHost(EVENT_NAME.twinnyOnLoading, { continuation: 0, operationId: "op-7" })
    await clickPause(chat.document)
    await sendHost(EVENT_NAME.twinnyStopGeneration, { operationId: "op-7", cancelled: true, paused: true })
    await sendHost(EVENT_NAME.twinnyAddMessage, PAUSED_REPLY)

    assert.ok(hasText(chat.document, "paused"), "the footer should say paused")
    assert.ok(!hasText(chat.document, "stopped"), "a paused reply is not shown as stopped")
    assert.ok(hasText(chat.document, "Continue"))
    assert.ok(hasText(chat.document, "Stop"))
    assert.equal(visibleButton(chat.document), "send")
  } finally {
    await chat.unmount()
  }
})

test("Continue resumes a paused task once: the control is replaced at once, so a second press finds nothing", async () => {
  outbound.length = 0
  const chat = await mountChat()
  try {
    await setConversation("conv-1", [])
    await sendHost(EVENT_NAME.twinnyOnLoading, { continuation: 0, operationId: "op-7" })
    await clickPause(chat.document)
    await sendHost(EVENT_NAME.twinnyStopGeneration, { operationId: "op-7", cancelled: true, paused: true })
    await sendHost(EVENT_NAME.twinnyAddMessage, PAUSED_REPLY)

    await clickFooterButton(chat.document, "Continue")

    assert.equal(postedChats().length, 1)
    assert.equal((postedChats()[0].data as { conversationId?: string }).conversationId, "conv-1")
    assert.equal(footerButton(chat.document, "Continue"), undefined)
    assert.equal(visibleButton(chat.document), "pause")
    assert.ok(!hasText(chat.document, "paused"), "a resumed reply no longer reads paused")
  } finally {
    await chat.unmount()
  }
})

test("Continue stays available after a host notice follows the paused reply, and sends to its conversation", async () => {
  outbound.length = 0
  const chat = await mountChat()
  try {
    await setConversation("conv-1", [])
    await sendHost(EVENT_NAME.twinnyOnLoading, { continuation: 0, operationId: "op-7" })
    await clickPause(chat.document)
    await sendHost(EVENT_NAME.twinnyStopGeneration, { operationId: "op-7", cancelled: true, paused: true })
    await sendHost(EVENT_NAME.twinnyAddMessage, PAUSED_REPLY)
    await sendHost(EVENT_NAME.twinnyAddMessage, { role: "assistant", content: "Authoritative TODO status for plan plan-001 (revision 1)." })

    assert.ok(footerButton(chat.document, "Continue"), "Continue is offered on the paused reply, not only when it is last")
    assert.ok(footerButton(chat.document, "Stop"))

    await clickFooterButton(chat.document, "Continue")
    assert.equal(postedChats().length, 1)
    assert.equal((postedChats()[0].data as { conversationId?: string }).conversationId, "conv-1")
  } finally {
    await chat.unmount()
  }
})

test("Continue without a bound conversation sends nothing, rather than inventing one", async () => {
  outbound.length = 0
  const chat = await mountChat()
  try {
    await sendHost(EVENT_NAME.twinnyOnLoading, { continuation: 0, operationId: "op-7" })
    await clickPause(chat.document)
    await sendHost(EVENT_NAME.twinnyStopGeneration, { operationId: "op-7", cancelled: true, paused: true })
    await sendHost(EVENT_NAME.twinnyAddMessage, PAUSED_REPLY)

    await clickFooterButton(chat.document, "Continue")
    assert.equal(postedChats().length, 0)
  } finally {
    await chat.unmount()
  }
})

test("Stop ends a paused task for good: no controls remain and nothing is sent to the host", async () => {
  outbound.length = 0
  const chat = await mountChat()
  try {
    await sendHost(EVENT_NAME.twinnyOnLoading, { continuation: 0, operationId: "op-7" })
    await clickPause(chat.document)
    await sendHost(EVENT_NAME.twinnyStopGeneration, { operationId: "op-7", cancelled: true, paused: true })
    await sendHost(EVENT_NAME.twinnyAddMessage, PAUSED_REPLY)

    await clickFooterButton(chat.document, "Stop")

    assert.ok(hasText(chat.document, "stopped"))
    assert.ok(!hasText(chat.document, "Continue"))
    assert.equal(postedStops().length, 0)
    assert.equal(postedChats().length, 0)
    assert.equal(visibleButton(chat.document), "send")

    // A late terminal for the paused operation changes nothing.
    await sendHost(EVENT_NAME.twinnyStopGeneration, { operationId: "op-7", cancelled: true, paused: true })
    assert.ok(hasText(chat.document, "stopped"))
    assert.ok(!hasText(chat.document, "Continue"))
  } finally {
    await chat.unmount()
  }
})

const postedSaves = () =>
  outbound.filter((message) => message.type === CONVERSATION_EVENT_NAME.saveConversation) as { data?: { messages: ChatCompletionMessage[] } }[]

/** Types into the composer through the editor's DOM and presses Send, as the user does. */
const sendComposerText = async (document: Document, text: string): Promise<void> => {
  const { act, window } = await loadWebview()
  const editor = document.querySelector<HTMLElement>(".ProseMirror")
  assert.ok(editor, "the composer editor should be rendered")
  await act(async () => {
    editor.innerHTML = `<p>${text}</p>`
    await new Promise((resolve) => window.setTimeout(resolve, 0))
  })
  const send = document.querySelector<HTMLElement>(`[aria-label="${SEND_LABEL}"]`)
  assert.ok(send, "the Send button should be rendered")
  await act(async () => {
    send.dispatchEvent(new window.MouseEvent("click", { bubbles: true }))
  })
}

const setConversation = async (id: string, messages: ChatCompletionMessage[]): Promise<void> =>
  sendHost(CONVERSATION_EVENT_NAME.setActiveConversation, { id, title: id, messages })

test("a new message while paused is independent work and does not stop the paused task", async () => {
  outbound.length = 0
  const chat = await mountChat()
  try {
    await sendHost(EVENT_NAME.twinnyOnLoading, { continuation: 0, operationId: "op-7" })
    await clickPause(chat.document)
    await sendHost(EVENT_NAME.twinnyStopGeneration, { operationId: "op-7", cancelled: true, paused: true })
    await sendHost(EVENT_NAME.twinnyAddMessage, PAUSED_REPLY)

    await sendComposerText(chat.document, "A different question")

    assert.equal(postedChats().length, 1, "the new message is sent as a new request")
    assert.equal(postedStops().length, 0, "sending a message never stops the paused task")
    assert.equal(visibleButton(chat.document), "pause", "the new request is running")
    assert.ok(footerButton(chat.document, "Stop"), "the paused reply keeps its Stop control")
    assert.equal(footerButton(chat.document, "Continue"), undefined, "Continue moves with the last reply only")
  } finally {
    await chat.unmount()
  }
})

test("Stop on a paused reply does not touch a newer request that is running", async () => {
  outbound.length = 0
  const chat = await mountChat()
  try {
    await sendHost(EVENT_NAME.twinnyOnLoading, { continuation: 0, operationId: "op-7" })
    await clickPause(chat.document)
    await sendHost(EVENT_NAME.twinnyStopGeneration, { operationId: "op-7", cancelled: true, paused: true })
    await sendHost(EVENT_NAME.twinnyAddMessage, PAUSED_REPLY)
    await sendComposerText(chat.document, "A different question")

    await clickFooterButton(chat.document, "Stop")

    assert.ok(hasText(chat.document, "stopped"))
    assert.equal(postedStops().length, 0)
    assert.equal(visibleButton(chat.document), "pause", "the newer request keeps running")
  } finally {
    await chat.unmount()
  }
})

test("late events for a stopped task cannot revive it or change a newer running task", async () => {
  outbound.length = 0
  const chat = await mountChat()
  try {
    await sendHost(EVENT_NAME.twinnyOnLoading, { continuation: 0, operationId: "op-7" })
    await clickPause(chat.document)
    await sendHost(EVENT_NAME.twinnyStopGeneration, { operationId: "op-7", cancelled: true, paused: true })
    await sendHost(EVENT_NAME.twinnyAddMessage, PAUSED_REPLY)
    await clickFooterButton(chat.document, "Stop")

    await sendHost(EVENT_NAME.twinnyOnLoading, { continuation: 1, operationId: "op-7" })
    assert.equal(visibleButton(chat.document), "send", "a late event does not revive the stopped task")
    assert.equal(footerButton(chat.document, "Continue"), undefined)

    await sendComposerText(chat.document, "A different question")
    assert.equal(visibleButton(chat.document), "pause")
    await sendHost(EVENT_NAME.twinnyStopGeneration, { operationId: "op-7", cancelled: true, paused: true })
    assert.equal(visibleButton(chat.document), "pause", "a late terminal for the stopped task leaves the newer request running")
  } finally {
    await chat.unmount()
  }
})

test("legacy stopped replies: the last one is paused and continuable, an earlier one is plain stopped history", async () => {
  outbound.length = 0
  const chat = await mountChat()
  try {
    await sendHost(EVENT_NAME.twinnyAddMessage, { role: "user", content: "Write it" })
    await sendHost(EVENT_NAME.twinnyAddMessage, { role: "assistant", content: "Cut", meta: { stopped: true, durationMs: 1000 } })
    assert.ok(hasText(chat.document, "paused"), "the last legacy stopped reply reads paused")
    assert.ok(footerButton(chat.document, "Continue"), "the last legacy stopped reply stays continuable")

    await sendHost(EVENT_NAME.twinnyAddMessage, { role: "user", content: "Later" })
    assert.equal(footerButton(chat.document, "Continue"), undefined)
    assert.ok(hasText(chat.document, "stopped"), "an earlier legacy reply reads stopped")
    assert.ok(!hasText(chat.document, "paused"))
  } finally {
    await chat.unmount()
  }
})

test("Escape and Ctrl+C pause a running reply and never stop a paused task", async () => {
  const { act, window } = await loadWebview()
  const press = async (document: Document, init: KeyboardEventInit) => {
    await act(async () => {
      document.body.dispatchEvent(new window.KeyboardEvent("keydown", { ...init, bubbles: true }))
    })
  }

  outbound.length = 0
  const escape = await mountChat()
  try {
    await sendHost(EVENT_NAME.twinnyOnLoading, { continuation: 0, operationId: "op-7" })
    await press(escape.document, { key: "Escape" })
    assert.equal(postedPauses().length, 1)
    assert.equal(postedStops().length, 0)
    assert.equal(visibleButton(escape.document), "send")
  } finally {
    await escape.unmount()
  }

  outbound.length = 0
  const ctrlC = await mountChat()
  try {
    await sendHost(EVENT_NAME.twinnyOnLoading, { continuation: 0, operationId: "op-8" })
    await press(ctrlC.document, { key: "c", ctrlKey: true })
    assert.equal(postedPauses().length, 1)
    assert.equal(postedStops().length, 0)
    assert.equal(visibleButton(ctrlC.document), "send")
  } finally {
    await ctrlC.unmount()
  }
})

test("a paused task survives a reload and a conversation switch, and Stop persists as terminal", async () => {
  outbound.length = 0
  const first = await mountChat()
  await sendHost(EVENT_NAME.twinnyOnLoading, { continuation: 0, operationId: "op-7" })
  await clickPause(first.document)
  await sendHost(EVENT_NAME.twinnyStopGeneration, { operationId: "op-7", cancelled: true, paused: true })
  await setConversation("conv-a", [{ role: "user", content: "Write it" }, PAUSED_REPLY])
  assert.ok(footerButton(first.document, "Continue"), "the paused reply is continuable on screen")
  await first.unmount()

  // Reload: a fresh webview receives the same saved conversation.
  const reloaded = await mountChat()
  try {
    await setConversation("conv-a", [{ role: "user", content: "Write it" }, PAUSED_REPLY])
    assert.ok(footerButton(reloaded.document, "Continue"), "Continue survives a reload")
    assert.ok(hasText(reloaded.document, "paused"))

    await setConversation("conv-b", [{ role: "user", content: "Unrelated" }])
    assert.equal(footerButton(reloaded.document, "Continue"), undefined, "the other conversation has no paused reply")
    await setConversation("conv-a", [{ role: "user", content: "Write it" }, PAUSED_REPLY])
    assert.ok(footerButton(reloaded.document, "Continue"), "switching back restores the paused reply")

    await clickFooterButton(reloaded.document, "Stop")
    const saved = postedSaves().at(-1)?.data?.messages
    assert.equal(saved?.[1]?.meta?.task?.state, "stopped", "the saved reply records the terminal state")
  } finally {
    await reloaded.unmount()
  }

  // Reload again: the saved terminal state is shown, with no controls.
  const restored = await mountChat()
  try {
    const saved = postedSaves().at(-1)?.data?.messages ?? []
    await setConversation("conv-a", saved)
    assert.ok(hasText(restored.document, "stopped"))
    assert.equal(footerButton(restored.document, "Continue"), undefined)
    assert.equal(footerButton(restored.document, "Stop"), undefined)
  } finally {
    await restored.unmount()
  }
})

// The TODO panel under the same harness. Snapshots arrive as host `changed` messages, as the bridge delivers them.

const TODO_CONVERSATION = "todo-conversation"
const OTHER_CONVERSATION = "todo-other-conversation"

const todoSnapshot = (conversationId: string, revision: number, statuses: Record<string, TodoItem["status"]>): TodoListSnapshot => ({
  id: `list-${conversationId}`,
  projectId: "project",
  conversationId,
  revision,
  items: Object.entries(statuses).map(
    ([name, status], sortOrder) =>
      ({ id: name, title: `Task ${name}`, details: "", status, priority: "normal", sortOrder, source: "model", criteria: [], verification: "none", version: revision }) as unknown as TodoItem
  )
})

const mountTodoPanel = async (conversationId: string) => {
  const { act, createElement, createRoot, window } = await loadWebview()
  const { TodoPanel } = await import("../../webview/todo-panel")
  const container = window.document.createElement("div")
  window.document.body.append(container)
  const root = createRoot(container)
  const render = async (id: string) => {
    await act(async () => {
      root.render(createElement(TodoPanel, { conversationId: id }))
    })
  }
  await render(conversationId)
  return {
    document: window.document,
    render,
    click: async (selector: string) => {
      const element = window.document.querySelector<HTMLElement>(selector)
      assert.ok(element, `expected an element matching ${selector}`)
      await act(async () => {
        element.click()
      })
    },
    unmount: async () => {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    }
  }
}

const showsTask = (document: Document, name: string) => !!document.body.textContent?.includes(`Task ${name}`)
const inProgressCount = (document: Document) => document.querySelectorAll("[aria-label=\"in progress\"]").length

test("the open TODO panel shows each completion as it is pushed, and an older snapshot cannot undo it", async () => {
  todoLists.set(TODO_CONVERSATION, todoSnapshot(TODO_CONVERSATION, 3, { first: "in_progress", second: "in_progress", third: "pending" }))
  const panel = await mountTodoPanel(TODO_CONVERSATION)
  try {
    assert.equal(showsTask(panel.document, "second"), true)
    assert.equal(inProgressCount(panel.document), 2)

    await sendHost(TODO_EVENT_NAME.changed, todoSnapshot(TODO_CONVERSATION, 4, { first: "completed", second: "in_progress", third: "pending" }))
    assert.equal(showsTask(panel.document, "first"), false)
    assert.equal(showsTask(panel.document, "second"), true)

    // The second TODO completes during final reconciliation, after the last reply has been emitted.
    const finalList = todoSnapshot(TODO_CONVERSATION, 5, { first: "completed", second: "completed", third: "pending" })
    todoLists.set(TODO_CONVERSATION, finalList)
    await sendHost(TODO_EVENT_NAME.changed, finalList)
    assert.equal(showsTask(panel.document, "second"), false, "the completed TODO leaves the active list without a conversation switch")
    assert.equal(showsTask(panel.document, "third"), true)
    assert.equal(inProgressCount(panel.document), 0)

    // A snapshot from before the completion arrives late and must not bring the TODO back.
    await sendHost(TODO_EVENT_NAME.changed, todoSnapshot(TODO_CONVERSATION, 4, { first: "completed", second: "in_progress", third: "pending" }))
    assert.equal(showsTask(panel.document, "second"), false, "an older revision cannot overwrite the final completion")
    assert.equal(inProgressCount(panel.document), 0)

    // Switching conversations restores each conversation's own persisted state, and back again.
    todoLists.set(OTHER_CONVERSATION, todoSnapshot(OTHER_CONVERSATION, 1, { other: "in_progress" }))
    await panel.render(OTHER_CONVERSATION)
    assert.equal(showsTask(panel.document, "other"), true)
    assert.equal(showsTask(panel.document, "third"), false)
    await panel.render(TODO_CONVERSATION)
    assert.equal(showsTask(panel.document, "third"), true)
    assert.equal(showsTask(panel.document, "other"), false)
    assert.equal(showsTask(panel.document, "second"), false)
  } finally {
    await panel.unmount()
  }
})

test("a snapshot is stale only when an older revision of the same list arrives", () => {
  const list = { id: "list-a", conversationId: "conv-a", revision: 5 }
  assert.equal(isStaleTodoSnapshot(undefined, list), false)
  assert.equal(isStaleTodoSnapshot(list, { ...list, revision: 4 }), true)
  assert.equal(isStaleTodoSnapshot(list, { ...list, revision: 5 }), false)
  assert.equal(isStaleTodoSnapshot(list, { ...list, revision: 6 }), false)
  assert.equal(isStaleTodoSnapshot(list, { ...list, id: "list-b", revision: 1 }), false)
  assert.equal(isStaleTodoSnapshot(list, { ...list, conversationId: "conv-b", revision: 1 }), false)
})

test("a snapshot is applied only for the conversation on screen and never replaces a newer revision", () => {
  const a2 = { id: "list-a", conversationId: "conv-a", revision: 2 }
  const a1 = { ...a2, revision: 1 }
  const b1 = { id: "list-b", conversationId: "conv-b", revision: 1 }
  assert.equal(applyTodoSnapshot("conv-a", undefined, a1), a1)
  assert.equal(applyTodoSnapshot("conv-a", a1, a2), a2)
  assert.equal(applyTodoSnapshot("conv-a", a2, a1), a2, "an older revision of the same list is dropped")
  assert.equal(applyTodoSnapshot("conv-a", a2, b1), a2, "another conversation's list is dropped while this one is on screen")
  assert.equal(applyTodoSnapshot("conv-b", a2, b1), b1)
  assert.equal(applyTodoSnapshot(undefined, undefined, a1), undefined)
})

test("a held snapshot is shown only for the conversation that owns it", () => {
  const a = { conversationId: "conv-a", revision: 1 }
  assert.equal(snapshotForConversation("conv-a", a), a)
  assert.equal(snapshotForConversation("conv-b", a), undefined)
  assert.equal(snapshotForConversation(undefined, a), undefined)
  assert.equal(snapshotForConversation("conv-a", undefined), undefined)
})

/** Answers one held `getList` for the conversation, as a slow host would, inside the same act scope React uses. */
const releaseListReply = async (conversationId: string): Promise<void> => {
  const { act } = await loadWebview()
  const pending = heldListReplies ?? []
  const index = pending.findIndex((held) => held.conversationId === conversationId)
  assert.notEqual(index, -1, `a list request for ${conversationId} should be waiting for the host`)
  const [held] = pending.splice(index, 1)
  await act(async () => held.reply())
}

test("rapid conversation switches clear the previous list at once and ignore late replies for it", async () => {
  todoLists.set(TODO_CONVERSATION, todoSnapshot(TODO_CONVERSATION, 1, { first: "in_progress" }))
  todoLists.set(OTHER_CONVERSATION, todoSnapshot(OTHER_CONVERSATION, 1, { other: "in_progress" }))
  heldListReplies = []
  const panel = await mountTodoPanel(TODO_CONVERSATION)
  try {
    await releaseListReply(TODO_CONVERSATION)
    assert.equal(showsTask(panel.document, "first"), true)

    // The first conversation's list is gone as soon as the switch renders, before the second list has loaded.
    await panel.render(OTHER_CONVERSATION)
    assert.equal(showsTask(panel.document, "first"), false)
    assert.equal(showsTask(panel.document, "other"), false)

    // Switch away and back while both requests are outstanding; the A reply is the one that matters.
    await panel.render(TODO_CONVERSATION)
    await releaseListReply(OTHER_CONVERSATION)
    assert.equal(showsTask(panel.document, "other"), false, "B's late reply cannot appear while A is on screen")
    assert.equal(showsTask(panel.document, "first"), false)

    await releaseListReply(TODO_CONVERSATION)
    assert.equal(showsTask(panel.document, "first"), true)
    assert.equal(showsTask(panel.document, "other"), false)

    // A server event for B while A is on screen must not replace A's list.
    await sendHost(TODO_EVENT_NAME.changed, todoSnapshot(OTHER_CONVERSATION, 2, { other: "completed" }))
    assert.equal(showsTask(panel.document, "first"), true)
    assert.equal(showsTask(panel.document, "other"), false)
  } finally {
    const { act } = await loadWebview()
    await act(async () => {
      for (const held of heldListReplies ?? []) held.reply()
    })
    heldListReplies = undefined
    await panel.unmount()
  }
})

const EMPTY_CONVERSATION = "todo-empty-conversation"

const SHOW_COMPLETED_CONTROL = "[data-control=\"show-completed\"]"

test("the Show Completed toggle is one header control whenever some TODOs are completed", async () => {
  todoLists.set(TODO_CONVERSATION, todoSnapshot(TODO_CONVERSATION, 3, { first: "completed", second: "in_progress" }))
  const panel = await mountTodoPanel(TODO_CONVERSATION)
  try {
    const toggles = panel.document.querySelectorAll(SHOW_COMPLETED_CONTROL)
    assert.equal(toggles.length, 1, "exactly one Show Completed control")
    assert.equal(toggles[0].getAttribute("aria-pressed"), "false")
    const header = toggles[0].parentElement
    assert.ok(header?.querySelector("strong")?.textContent?.length, "the control sits in the panel header beside the title")
    assert.equal(showsTask(panel.document, "first"), false)
    await panel.click(SHOW_COMPLETED_CONTROL)
    assert.equal(showsTask(panel.document, "first"), true)
    assert.equal(panel.document.querySelector(SHOW_COMPLETED_CONTROL)?.getAttribute("aria-pressed"), "true")
  } finally {
    await panel.unmount()
  }
})

test("two completed TODOs both show after switching away and back once Show Completed is enabled", async () => {
  todoLists.set(TODO_CONVERSATION, todoSnapshot(TODO_CONVERSATION, 5, { first: "completed", second: "completed" }))
  todoLists.set(OTHER_CONVERSATION, todoSnapshot(OTHER_CONVERSATION, 1, { other: "in_progress" }))
  const panel = await mountTodoPanel(TODO_CONVERSATION)
  try {
    // An all-completed list is retired, so its items stay hidden until Show Completed is pressed.
    assert.equal(showsTask(panel.document, "first"), false)
    assert.equal(showsTask(panel.document, "second"), false)
    await panel.click(SHOW_COMPLETED_CONTROL)
    assert.equal(showsTask(panel.document, "first"), true)
    assert.equal(showsTask(panel.document, "second"), true)

    await panel.render(OTHER_CONVERSATION)
    assert.equal(showsTask(panel.document, "other"), true)
    assert.equal(showsTask(panel.document, "first"), false)

    await panel.render(TODO_CONVERSATION)
    assert.equal(showsTask(panel.document, "first"), true, "the first completed TODO is restored on return")
    assert.equal(showsTask(panel.document, "second"), true, "the second completed TODO is restored on return")
    assert.equal(panel.document.querySelector(SHOW_COMPLETED_CONTROL)?.getAttribute("aria-pressed"), "true")
  } finally {
    await panel.unmount()
  }
})

test("a conversation with no TODO list stays empty, with no fabricated items and no error", async () => {
  todoLists.set(TODO_CONVERSATION, todoSnapshot(TODO_CONVERSATION, 2, { first: "in_progress" }))
  const panel = await mountTodoPanel(TODO_CONVERSATION)
  try {
    assert.equal(showsTask(panel.document, "first"), true)
    await panel.render(EMPTY_CONVERSATION)
    assert.equal(showsTask(panel.document, "first"), false, "the previous conversation's TODO must not carry over")
    assert.equal(inProgressCount(panel.document), 0)
    assert.equal(panel.document.querySelector(SHOW_COMPLETED_CONTROL), null, "no Show Completed control without completed TODOs")
    assert.equal(panel.document.body.textContent?.includes("No TODO list"), false, "a missing list is not reported as an error")
    await panel.render(TODO_CONVERSATION)
    assert.equal(showsTask(panel.document, "first"), true)
  } finally {
    await panel.unmount()
  }
})

// Reasoning arrives as deltas that the webview batches, so each assertion waits past the flush interval.
const settleReasoning = async (): Promise<void> => {
  const { act } = await loadWebview()
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250))
  })
}

const reasoningSections = (document: Document): Element[] => [...document.querySelectorAll("[data-reasoning-state]")]

const clickElement = async (element: HTMLElement): Promise<void> => {
  const { act, window } = await loadWebview()
  await act(async () => {
    element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }))
  })
}

const reasoningHeader = (document: Document, label: string): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>("[role=\"button\"]")].find((item) => item.textContent?.includes(label))

test("streamed reasoning opens while thinking and collapses when the answer begins", async () => {
  outbound.length = 0
  const chat = await mountChat()
  try {
    await sendHost(EVENT_NAME.twinnyAddMessage, { role: "user", content: "Think it through" })
    await sendHost(EVENT_NAME.twinnyOnLoading, { continuation: 0, operationId: "op-r1" })
    await sendHost(EVENT_NAME.twinnyOnReasoning, { round: "r1:0", text: "Weighing options" })
    await sendHost(EVENT_NAME.twinnyOnReasoning, { round: "r1:0", text: " carefully" })
    await settleReasoning()

    assert.ok(hasText(chat.document, "Weighing options carefully"), "the active reasoning is visible while streaming")
    assert.equal(reasoningSections(chat.document)[0]?.getAttribute("data-reasoning-state"), "active")
    assert.ok(reasoningHeader(chat.document, "Thinking"), "the active block is labelled Thinking")

    await sendHost(EVENT_NAME.twinnyOnCompletion, { role: "assistant", content: "The answer" })
    assert.equal(hasText(chat.document, "Weighing options carefully"), false, "completed reasoning collapses")
    assert.ok(reasoningHeader(chat.document, "Thought"), "the completed block shows a compact header")
    assert.ok(hasText(chat.document, "The answer"))
  } finally {
    await chat.unmount()
  }
})

test("a new reasoning round starts its own block and closes the previous one", async () => {
  outbound.length = 0
  const chat = await mountChat()
  try {
    await sendHost(EVENT_NAME.twinnyAddMessage, { role: "user", content: "Two rounds" })
    await sendHost(EVENT_NAME.twinnyOnLoading, { continuation: 0, operationId: "op-r4" })
    await sendHost(EVENT_NAME.twinnyOnReasoning, { round: "r4:0", text: "First round" })
    await settleReasoning()
    await sendHost(EVENT_NAME.twinnyOnReasoning, { round: "r4:1", text: "Second round" })
    await settleReasoning()

    assert.equal(hasText(chat.document, "First round"), false, "the earlier round is collapsed")
    assert.ok(hasText(chat.document, "Second round"), "the new round is open")
    assert.equal(reasoningSections(chat.document).length, 2)
    assert.equal(reasoningSections(chat.document).filter((item) => item.getAttribute("data-reasoning-state") === "active").length, 1)
  } finally {
    await chat.unmount()
  }
})

test("a later reasoning round keeps every streamed delta after the reply already has visible text", async () => {
  outbound.length = 0
  const chat = await mountChat()
  try {
    const visible = "I'll look at the code."
    await sendHost(EVENT_NAME.twinnyAddMessage, { role: "user", content: "Find it" })
    await sendHost(EVENT_NAME.twinnyOnLoading, { continuation: 0, operationId: "op-late" })
    await sendHost(EVENT_NAME.twinnyOnReasoning, { round: "r12:0", text: "Let me look" })
    await sendHost(EVENT_NAME.twinnyOnCompletion, { role: "assistant", content: visible })
    await sendHost(EVENT_NAME.twinnyToolSteps, [{ id: "t-r12", name: "read_file", summary: "read a.ts", status: "done" }])
    // Every delta of the second round arrives with the reply's cumulative content, as the extension sends it.
    for (const delta of ["The user", " wants the", " panel fixed."]) {
      await sendHost(EVENT_NAME.twinnyOnReasoning, { round: "r12:1", text: delta })
      await sendHost(EVENT_NAME.twinnyOnCompletion, { role: "assistant", content: visible })
    }
    await settleReasoning()

    assert.ok(hasText(chat.document, "The user wants the panel fixed."), "the whole round is shown while it streams")
    const active = reasoningSections(chat.document).filter((item) => item.getAttribute("data-reasoning-state") === "active")
    assert.equal(active.length, 1, "the second round is the one still streaming")
  } finally {
    await chat.unmount()
  }
})

/** Reasoning sections and tool rows in the order they appear in the rendered reply. */
const renderedActivityOrder = (document: Document, toolSummaries: string[]): string[] => {
  const sections = reasoningSections(document)
  return [...document.querySelectorAll("[data-reasoning-state], li")].flatMap((node) => {
    const section = sections.indexOf(node)
    if (section >= 0) return [`reasoning ${section}`]
    const tool = toolSummaries.find((summary) => node.textContent?.includes(summary))
    return tool ? [`tool ${tool}`] : []
  })
}

test("reasoning and tool rows render in the order they happened, not grouped", async () => {
  outbound.length = 0
  const chat = await mountChat()
  try {
    const read = { id: "t-read", name: "read_file", summary: "read a.ts", status: "done" }
    const grep = { id: "t-grep", name: "grep", summary: "searched for foo", status: "done" }
    await sendHost(EVENT_NAME.twinnyAddMessage, { role: "user", content: "Investigate" })
    await sendHost(EVENT_NAME.twinnyOnLoading, { continuation: 0, operationId: "op-order" })
    await sendHost(EVENT_NAME.twinnyOnReasoning, { round: "r9:0", text: "Thinking one" })
    await sendHost(EVENT_NAME.twinnyToolSteps, [read])
    await sendHost(EVENT_NAME.twinnyOnReasoning, { round: "r9:1", text: "Thinking two" })
    await sendHost(EVENT_NAME.twinnyToolSteps, [read, grep])
    await sendHost(EVENT_NAME.twinnyOnReasoning, { round: "r9:2", text: "Thinking three" })
    await settleReasoning()

    assert.deepEqual(renderedActivityOrder(chat.document, [read.summary, grep.summary]), [
      "reasoning 0",
      "tool read a.ts",
      "reasoning 1",
      "tool searched for foo",
      "reasoning 2"
    ])

    await sendHost(EVENT_NAME.twinnyOnCompletion, { role: "assistant", content: "Final answer" })
    const body = chat.document.body.textContent ?? ""
    assert.ok(body.indexOf("searched for foo") < body.indexOf("Final answer"), "the answer follows the last tool row")
    assert.equal(reasoningSections(chat.document).length, 3, "each round keeps its own block")
    assert.equal(hasText(chat.document, "Thinking one"), false, "completed earlier rounds collapse")
  } finally {
    await chat.unmount()
  }
})

test("a reply without reasoning shows no reasoning block", async () => {
  outbound.length = 0
  const chat = await mountChat()
  try {
    await sendHost(EVENT_NAME.twinnyAddMessage, { role: "user", content: "Plain question" })
    await sendHost(EVENT_NAME.twinnyOnLoading, { continuation: 0, operationId: "op-r5" })
    await sendHost(EVENT_NAME.twinnyOnCompletion, { role: "assistant", content: "Plain answer" })
    assert.equal(reasoningSections(chat.document).length, 0, "no empty reasoning block")
    assert.ok(hasText(chat.document, "Plain answer"))
  } finally {
    await chat.unmount()
  }
})

test("a saved reply's reasoning reloads collapsed and can be expanded", async () => {
  outbound.length = 0
  const chat = await mountChat()
  try {
    await sendHost(EVENT_NAME.twinnyAddMessage, { role: "user", content: "Think" })
    await sendHost(EVENT_NAME.twinnyAddMessage, {
      role: "assistant",
      content: "Final",
      reasoningRounds: [{ id: "old:0", text: "Remembered thinking", complete: true, durationMs: 4000 }]
    })
    assert.equal(hasText(chat.document, "Remembered thinking"), false, "saved reasoning starts collapsed")
    const header = reasoningHeader(chat.document, "Thought for")
    assert.ok(header, "the saved block shows how long it thought")

    await clickElement(header)
    assert.ok(hasText(chat.document, "Remembered thinking"), "the reader can expand a completed block")
  } finally {
    await chat.unmount()
  }
})

test("Pause keeps the reasoning received so far, labelled paused rather than complete", async () => {
  outbound.length = 0
  const chat = await mountChat()
  try {
    await sendHost(EVENT_NAME.twinnyAddMessage, { role: "user", content: "Pause me" })
    await sendHost(EVENT_NAME.twinnyOnLoading, { continuation: 0, operationId: "op-r6" })
    await sendHost(EVENT_NAME.twinnyOnReasoning, { round: "r6:0", text: "Half a thought" })
    await settleReasoning()
    await clickPause(chat.document)
    await sendHost(EVENT_NAME.twinnyStopGeneration, { operationId: "op-r6", cancelled: true, paused: true })
    await sendHost(EVENT_NAME.twinnyAddMessage, {
      role: "assistant",
      content: "Partial",
      meta: { stopped: true, durationMs: 1000, task: { operationId: "op-r6", state: "paused" } }
    })

    const header = reasoningHeader(chat.document, "Thinking paused")
    assert.ok(header, "an unfinished round reads paused")
    assert.equal(hasText(chat.document, "Thought for"), false, "an interrupted round never claims a duration")
    await clickElement(header)
    assert.ok(hasText(chat.document, "Half a thought"), "the received reasoning is preserved")
  } finally {
    await chat.unmount()
  }
})

test("Stop finalises the open reasoning as stopped and keeps it out of the active state", async () => {
  outbound.length = 0
  const chat = await mountChat()
  try {
    await sendHost(EVENT_NAME.twinnyAddMessage, { role: "user", content: "Stop me" })
    await sendHost(EVENT_NAME.twinnyOnLoading, { continuation: 0, operationId: "op-r7" })
    await sendHost(EVENT_NAME.twinnyOnReasoning, { round: "r7:0", text: "Abandoned" })
    await settleReasoning()
    await sendHost(EVENT_NAME.twinnyStopGeneration, { operationId: "op-r7", cancelled: true })
    await sendHost(EVENT_NAME.twinnyAddMessage, {
      role: "assistant",
      content: "Cut short",
      meta: { stopped: true, task: { operationId: "op-r7", state: "stopped" } }
    })

    assert.equal(reasoningSections(chat.document).filter((item) => item.getAttribute("data-reasoning-state") === "active").length, 0)
    assert.ok(reasoningHeader(chat.document, "Thinking stopped"), "the open round reads stopped")
  } finally {
    await chat.unmount()
  }
})
