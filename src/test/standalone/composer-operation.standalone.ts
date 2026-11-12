import { JSDOM } from "jsdom"
import assert from "node:assert/strict"
import Module from "node:module"
import path from "node:path"
import { test } from "node:test"

import { EVENT_NAME, TODO_EVENT_NAME } from "../../common/constants/events"
import { applyTodoSnapshot, isStaleTodoSnapshot, snapshotForConversation } from "../../common/guards"
import type { TodoItem, TodoListSnapshot } from "../../common/types"
import {
  composerIsBusy,
  ComposerOperationEvent,
  ComposerOperationPhase,
  reduceComposerOperation
} from "../../webview/composer-operation"

/** The composer's button for each host event, in the order the host sends them. */
const replay = (events: ComposerOperationEvent[]) => {
  let phase: ComposerOperationPhase = "idle"
  return events.map((event) => {
    phase = reduceComposerOperation(phase, event)
    return { phase, stop: composerIsBusy(phase) }
  })
}

test("Stop stays through Feedback, replies, and continuations until the terminal event", () => {
  const trace = replay([
    { type: "started" },
    { type: "started" },
    { type: "started" }
  ])
  assert.ok(trace.every((step) => step.stop))
  const done = reduceComposerOperation(trace.at(-1)!.phase, { type: "terminal" })
  assert.equal(composerIsBusy(done), false)
})

test("a stop request shows the stopping state and keeps Stop until the terminal event", () => {
  const trace = replay([
    { type: "started" },
    { type: "stop-requested" },
    { type: "started" },
    { type: "terminal" }
  ])
  assert.deepEqual(trace.map((step) => step.phase), ["running", "stopping", "stopping", "idle"])
  assert.deepEqual(trace.map((step) => step.stop), [true, true, true, false])
})

test("a late start cannot undo a stop already requested", () => {
  const phase = reduceComposerOperation("stopping", { type: "started" })
  assert.equal(phase, "stopping")
})

test("a stop request while idle does nothing", () => {
  assert.equal(reduceComposerOperation("idle", { type: "stop-requested" }), "idle")
})

test("a reply message alone never returns the composer to Send", () => {
  // Per-request replies are not operation events, so they cannot change the phase.
  const phase = reduceComposerOperation("running", { type: "started" })
  assert.equal(composerIsBusy(phase), true)
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

/** CSS modules resolve each class to its own name, so `styles.stopping` is "stopping". */
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
const STOP_LABEL = "Stop generation"
const SEND_LABEL = "Send"

const clickStop = async (document: Document): Promise<void> => {
  const { act, window } = await loadWebview()
  const stop = document.querySelector<HTMLElement>(`[aria-label="${STOP_LABEL}"]`)
  assert.ok(stop, "the Stop button should be rendered before it is clicked")
  await act(async () => {
    stop.dispatchEvent(new window.MouseEvent("click", { bubbles: true }))
  })
}

/** The composer button the user can see: Stop while busy, otherwise Send. */
const visibleButton = (document: Document): "stop" | "send" | "none" => {
  if (document.querySelector(`[aria-label="${STOP_LABEL}"]`)) return "stop"
  if (document.querySelector(`[aria-label="${SEND_LABEL}"]`)) return "send"
  return "none"
}

const stopIsBusy = (document: Document): boolean =>
  document.querySelector(`[aria-label="${STOP_LABEL}"]`)?.getAttribute("aria-busy") === "true"

const postedStops = (): { type: string; data?: unknown; id?: string }[] =>
  outbound.filter((message) => message.type === EVENT_NAME.twinnyStopGeneration)

test("the Stop button stays visible through Feedback review and automatic continuation", async () => {
  outbound.length = 0
  const chat = await mountChat()
  try {
    assert.equal(visibleButton(chat.document), "send")

    await sendHost(EVENT_NAME.twinnyOnLoading, { continuation: 0 })
    assert.equal(visibleButton(chat.document), "stop")

    // The first request has replied; the host is still working (Feedback review, then the next request).
    await sendHost(EVENT_NAME.twinnyOnCompletion, { role: "assistant", content: "First request" })
    assert.equal(visibleButton(chat.document), "stop")

    // The gap before the continuation is dispatched carries no host event.
    assert.equal(visibleButton(chat.document), "stop")

    await sendHost(EVENT_NAME.twinnyOnLoading, { continuation: 1 })
    assert.equal(visibleButton(chat.document), "stop")

    await sendHost(EVENT_NAME.twinnyOnCompletion, { role: "assistant", content: "Continuation" })
    assert.equal(visibleButton(chat.document), "stop")
    assert.equal(postedStops().length, 0)
  } finally {
    await chat.unmount()
  }
})

test("clicking Stop posts the stop message and keeps Stop until the host is terminal", async () => {
  outbound.length = 0
  const chat = await mountChat()
  try {
    await sendHost(EVENT_NAME.twinnyOnLoading, { continuation: 0 })
    await clickStop(chat.document)

    assert.deepEqual(postedStops(), [{ type: EVENT_NAME.twinnyStopGeneration, data: {} }])
    assert.equal(visibleButton(chat.document), "stop")
    assert.equal(stopIsBusy(chat.document), true)

    // Late events from the cancelled operation must not restore Send.
    await sendHost(EVENT_NAME.twinnyOnLoading, { continuation: 1 })
    await sendHost(EVENT_NAME.twinnyOnCompletion, { role: "assistant", content: "Late reply" })
    assert.equal(visibleButton(chat.document), "stop")
    assert.equal(stopIsBusy(chat.document), true)
    assert.equal(postedStops().length, 1)

    await sendHost(EVENT_NAME.twinnyStopGeneration, { cancelled: true })
    assert.equal(visibleButton(chat.document), "send")
  } finally {
    await chat.unmount()
  }
})

test("a webview reconnect during an operation restores Stop once the host re-announces it", async () => {
  outbound.length = 0
  const first = await mountChat()
  await sendHost(EVENT_NAME.twinnyOnLoading, { continuation: 1 })
  assert.equal(visibleButton(first.document), "stop")
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
    assert.equal(visibleButton(second.document), "stop")

    await clickStop(second.document)
    assert.equal(postedStops().length, 1)
    assert.equal(stopIsBusy(second.document), true)

    await sendHost(EVENT_NAME.twinnyStopGeneration, { cancelled: true })
    assert.equal(visibleButton(second.document), "send")
  } finally {
    await second.unmount()
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

test("two completed TODOs both show after switching away and back once Show Completed is enabled", async () => {
  todoLists.set(TODO_CONVERSATION, todoSnapshot(TODO_CONVERSATION, 5, { first: "completed", second: "completed" }))
  todoLists.set(OTHER_CONVERSATION, todoSnapshot(OTHER_CONVERSATION, 1, { other: "in_progress" }))
  const panel = await mountTodoPanel(TODO_CONVERSATION)
  try {
    // An all-completed list is retired, so its items stay hidden until Show Completed is pressed.
    assert.equal(showsTask(panel.document, "first"), false)
    assert.equal(showsTask(panel.document, "second"), false)
    await panel.click("button[aria-pressed]")
    assert.equal(showsTask(panel.document, "first"), true)
    assert.equal(showsTask(panel.document, "second"), true)

    await panel.render(OTHER_CONVERSATION)
    assert.equal(showsTask(panel.document, "other"), true)
    assert.equal(showsTask(panel.document, "first"), false)

    await panel.render(TODO_CONVERSATION)
    assert.equal(showsTask(panel.document, "first"), true, "the first completed TODO is restored on return")
    assert.equal(showsTask(panel.document, "second"), true, "the second completed TODO is restored on return")
    assert.equal(panel.document.querySelector("button[aria-pressed]")?.getAttribute("aria-pressed"), "true")
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
    assert.equal(panel.document.querySelector("button[aria-pressed]"), null, "no Show Completed control without completed TODOs")
    assert.equal(panel.document.body.textContent?.includes("No TODO list"), false, "a missing list is not reported as an error")
    await panel.render(TODO_CONVERSATION)
    assert.equal(showsTask(panel.document, "first"), true)
  } finally {
    await panel.unmount()
  }
})
