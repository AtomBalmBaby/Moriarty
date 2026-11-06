/**
 * Copy and save of the whole chat: the export is built from the chat's
 * messages, so long and continued runs, tool calls, feedback, TODO activity,
 * failures and unavailable output all reach the Markdown in order, and
 * clipboard or file failures are reported rather than lost.
 */
import * as assert from "node:assert"
import { test } from "node:test"

import { CONTINUATION_PREFIX } from "../../common/constants"
import {
  exportConversation,
  htmlToMarkdown
} from "../../common/conversation-export"
import { attachLateSteps } from "../../common/reply-steps"
import type { ChatCompletionMessage, ToolStepView } from "../../common/types"
import {
  deliverEntireChat,
  EMPTY_CHAT_MESSAGE,
  EntireChatExportDeps
} from "../../extension/chat/entire-chat-export"
import { ToolSteps } from "../../extension/chat/tool-steps"

const EXPORTED_AT = new Date("2024-01-02T03:04:05.000Z")

const user = (content: string): ChatCompletionMessage => ({
  role: "user",
  content
})

const assistant = (
  content: string,
  extra: Partial<ChatCompletionMessage> = {}
): ChatCompletionMessage =>
  ({ role: "assistant", content, ...extra }) as ChatCompletionMessage

const step = (
  overrides: Partial<ToolStepView> & Pick<ToolStepView, "id" | "name">
): ToolStepView => ({
  summary: `${overrides.name} ran`,
  status: "done",
  ...overrides
})

const exportOf = (
  messages: ChatCompletionMessage[],
  inProgress?: ChatCompletionMessage | null
) => exportConversation(messages, { exportedAt: EXPORTED_AT, inProgress })

const indexOfInOrder = (text: string, needles: string[]) => {
  let cursor = 0
  for (const needle of needles) {
    const found = text.indexOf(needle, cursor)
    assert.ok(found >= 0, `expected "${needle}" after position ${cursor}`)
    cursor = found + needle.length
  }
}

test("a long conversation exports every message in order, none left out", () => {
  const messages: ChatCompletionMessage[] = []
  for (let turn = 1; turn <= 250; turn++) {
    messages.push(user(`question ${turn}`))
    messages.push(assistant(`answer ${turn}`))
  }
  const text = exportOf(messages)
  assert.match(
    text,
    /Exported from Twinny on 2024-01-02T03:04:05\.000Z: 500 messages, 0 automatic continuations/
  )
  for (let turn = 1; turn <= 250; turn++) {
    assert.ok(text.includes(`question ${turn}\n`), `question ${turn} missing`)
    assert.ok(text.includes(`answer ${turn}`), `answer ${turn} missing`)
  }
  indexOfInOrder(text, [
    "question 1\n",
    "answer 1",
    "question 2\n",
    "answer 250"
  ])
  assert.ok(text.includes("## 500. twinny"))
})

test("messages still streaming are appended last as in progress", () => {
  const text = exportOf(
    [user("hi")],
    assistant("partial reply", {
      toolSteps: [step({ id: "t1", name: "read_file", status: "running" })]
    })
  )
  indexOfInOrder(text, [
    "## 1. You",
    "## 2. twinny",
    "still running when exported",
    "partial reply"
  ])
  assert.match(text, /\*\*Status:\*\* in progress when exported/)
  assert.match(text, /2 messages/)
})

test("an empty inProgress reply says nothing was written yet", () => {
  const text = exportOf([user("hi")], assistant(""))
  assert.match(text, /_nothing written yet_/)
})

test("an empty chat exports only its header", () => {
  const text = exportOf([])
  assert.match(text, /^# Twinny chat/)
  assert.match(text, /0 messages, 0 automatic continuations/)
  assert.ok(!text.includes("## 1."))
})

test("automatic continuations are marked at each boundary, with the count", () => {
  const reply = [
    "first part of the work",
    CONTINUATION_PREFIX.trimEnd(),
    "",
    "second part",
    CONTINUATION_PREFIX.trimEnd(),
    "",
    "third part"
  ].join("\n")
  const text = exportOf([user("do the job"), assistant(reply)])
  assert.match(text, /2 automatic continuations/)
  assert.ok(
    !text.includes("continuing automatically"),
    "raw continuation prefix must not leak"
  )
  indexOfInOrder(text, [
    "first part of the work",
    "### Automatic continuation 1",
    "second part",
    "### Automatic continuation 2",
    "third part"
  ])
})

test("continuation prefixes in several assistant replies number across the whole chat", () => {
  const text = exportOf([
    user("one"),
    assistant(`alpha${CONTINUATION_PREFIX}beta`),
    user("two"),
    assistant(`gamma${CONTINUATION_PREFIX}delta`)
  ])
  assert.match(text, /### Automatic continuation 1[\s\S]*beta/)
  assert.match(text, /### Automatic continuation 2[\s\S]*delta/)
  assert.match(text, /2 automatic continuations/)
})

test("tool calls show their name, arguments, full output and success", () => {
  const output = "line one of the file\nline two of the file"
  const text = exportOf([
    user("read it"),
    assistant("Reading.", {
      toolSteps: [
        step({
          id: "read-1",
          name: "read_file",
          summary: "Read src/a.ts",
          args: { path: "src/a.ts", startLine: "1" },
          output,
          status: "done"
        })
      ]
    })
  ])
  assert.match(text, /#### Tool: `read_file` \(succeeded\)/)
  assert.match(text, /Summary: Read src\/a\.ts/)
  assert.ok(text.includes("path: src/a.ts\nstartLine: 1"))
  assert.ok(
    text.includes(`\`\`\`\n${output}\n\`\`\``),
    "full output must be fenced verbatim"
  )
  assert.ok(!text.includes("Output unavailable"))
})

test("a failed tool call is marked failed and counted in the status", () => {
  const text = exportOf([
    user("run it"),
    assistant("Trying.", {
      toolSteps: [
        step({
          id: "run-1",
          name: "run_command",
          status: "failed",
          output: "exit 1: boom",
          args: { cmd: "make" }
        }),
        step({
          id: "run-2",
          name: "run_command",
          status: "failed",
          output: "exit 2"
        })
      ]
    })
  ])
  assert.match(text, /#### Tool: `run_command` \(failed\)/)
  assert.ok(text.includes("exit 1: boom"))
  assert.match(text, /2 tool steps failed\./)
})

test("feedback reviews carry their verdict and the rejection reason", () => {
  const rejection =
    "The change does not compile: missing import of Foo, see line 12."
  const text = exportOf([
    user("edit"),
    assistant("Done.", {
      toolSteps: [
        step({
          id: "feedback.review.1",
          name: "feedback",
          status: "failed",
          summary: "Rejected",
          output: rejection
        }),
        step({
          id: "feedback.review.2",
          name: "feedback",
          status: "done",
          summary: "Accepted",
          output: "Looks good."
        })
      ]
    })
  ])
  assert.match(text, /#### Feedback review: rejected/)
  assert.ok(
    text.includes(rejection),
    "rejection reason must be exported in full"
  )
  assert.match(text, /#### Feedback review: accepted/)
  assert.ok(text.includes("Looks good."))
})

test("TODO tool events are labelled as TODO activity and keep their arguments", () => {
  const text = exportOf([
    user("plan"),
    assistant("Planning.", {
      toolSteps: [
        step({
          id: "todo-1",
          name: "twinny_todo_create",
          args: { title: "Write tests" }
        }),
        step({ id: "todo-2", name: "twinny_todo_complete", args: { id: "t1" } })
      ]
    })
  ])
  assert.match(text, /#### TODO tool: `twinny_todo_create` \(succeeded\)/)
  assert.match(text, /#### TODO tool: `twinny_todo_complete` \(succeeded\)/)
  assert.ok(text.includes("title: Write tests"))
})

test("a tool step without saved output is marked unavailable, not silently dropped", () => {
  const text = exportOf([
    user("x"),
    assistant("y", {
      toolSteps: [step({ id: "a", name: "grep", status: "done" })]
    })
  ])
  assert.match(text, /Output unavailable: it was not saved with this chat\./)
})

test("truncated arguments and output are marked as cut, with the amounts", () => {
  const text = exportOf([
    user("x"),
    assistant("y", {
      toolSteps: [
        step({
          id: "a",
          name: "read_file",
          args: { path: "big.txt" },
          argsOmitted: 2500,
          output: "first 4000 characters...",
          outputOmitted: 9000
        })
      ]
    })
  ])
  assert.match(
    text,
    /2500 characters of arguments were cut before they were saved; the rest is unavailable\./
  )
  assert.match(
    text,
    /Output truncated: 9000 characters were not kept, so the full output is unavailable\./
  )
  assert.ok(
    text.includes("first 4000 characters..."),
    "the kept part is still exported"
  )
})

test("a skipped or still-running tool says so instead of claiming output", () => {
  const text = exportOf([
    user("x"),
    assistant("y", {
      toolSteps: [
        step({ id: "s", name: "write_file", status: "skipped" }),
        step({ id: "r", name: "run_command", status: "running" })
      ]
    })
  ])
  assert.match(text, /Output: none, the step was not run\./)
  assert.match(
    text,
    /Output: not available, the step had not finished when exported\./
  )
  assert.ok(
    !text.includes("Output unavailable"),
    "neither step should claim missing output"
  )
})

test("tool steps appear at their place in the reply text, between the words around them", () => {
  const text = exportOf([
    user("go"),
    assistant("Before the tool. After the tool.", {
      toolSteps: [
        step({
          id: "mid",
          name: "list_dir",
          summary: "Listed",
          at: "Before the tool. ".length
        })
      ]
    })
  ])
  indexOfInOrder(text, [
    "Before the tool.",
    "#### Tool: `list_dir`",
    "After the tool."
  ])
})

test("the user's line breaks and Markdown survive, with HTML tags turned back into Markdown", () => {
  assert.equal(htmlToMarkdown("line one\nline two"), "line one\nline two")
  assert.equal(htmlToMarkdown("<p>first</p><p>second</p>"), "first\n\nsecond")
  assert.equal(htmlToMarkdown("a<br>b"), "a\nb")
  assert.equal(htmlToMarkdown("<pre><code>x\ny</code></pre>"), "```\nx\ny\n```")
  assert.equal(
    htmlToMarkdown("<strong>bold</strong> and <em>it</em>"),
    "**bold** and *it*"
  )
  assert.equal(
    htmlToMarkdown("<ul><li>one</li><li>two</li></ul>"),
    "- one\n- two"
  )
  assert.equal(
    htmlToMarkdown("<a href=\"https://x.test\">link</a>"),
    "[link](https://x.test)"
  )
  assert.ok(!/<[a-z][^>]*>/i.test(htmlToMarkdown("<div>a</div><span>b</span>")))
})

test("a multiline Markdown user message is exported with its lines intact", () => {
  const message =
    "Please change this:\n\n- first item\n- second item\n\n```ts\nconst x = 1\n```"
  const text = exportOf([user(message), assistant("ok")])
  assert.ok(
    text.includes(message),
    "the message must be exported exactly as typed"
  )
})

test("user messages with image parts still export their text and count the images", () => {
  const text = exportOf([
    {
      role: "user",
      content: [
        { type: "text", text: "look at this" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }
      ]
    } as unknown as ChatCompletionMessage
  ])
  assert.ok(text.includes("look at this"))
})

test("a late feedback review joins the reply it reviewed, replacing a step with the same id", () => {
  const reply = assistant("Result text.", {
    toolSteps: [
      step({
        id: "feedback.review.1",
        name: "feedback",
        status: "running",
        summary: "Reviewing"
      })
    ]
  })
  const merged = attachLateSteps(reply, [
    step({
      id: "feedback.review.1",
      name: "feedback",
      status: "failed",
      output: "Missing tests."
    }),
    step({
      id: "feedback.review.2",
      name: "feedback",
      status: "done",
      output: "Fine."
    })
  ])
  assert.equal(merged.toolSteps?.length, 2)
  assert.equal(merged.toolSteps?.[0].status, "failed")
  assert.equal(merged.toolSteps?.[0].output, "Missing tests.")
  assert.equal(merged.toolSteps?.[1].id, "feedback.review.2")
  assert.equal(merged.toolSteps?.[1].at, "Result text.".length)
  const text = exportOf([user("x"), merged])
  assert.match(text, /#### Feedback review: rejected/)
  assert.match(text, /Missing tests\./)
  assert.match(text, /#### Feedback review: accepted/)
})

test("late steps with nothing to add leave the reply unchanged", () => {
  const reply = assistant("same")
  assert.equal(attachLateSteps(reply, []), reply)
})

test("a late review keeps the order of its reply among later messages", () => {
  const merged = attachLateSteps(assistant("first reply"), [
    step({
      id: "feedback.review.1",
      name: "feedback",
      status: "done",
      output: "Accepted once."
    })
  ])
  const text = exportOf([
    user("q1"),
    merged,
    user("q2"),
    assistant("second reply")
  ])
  indexOfInOrder(text, [
    "## 1. You",
    "first reply",
    "Accepted once.",
    "## 3. You",
    "q2",
    "second reply"
  ])
})

test("the export is redacted before it reaches the clipboard or a file", async () => {
  const seen: string[] = []
  const notices: string[] = []
  const deps: EntireChatExportDeps = {
    redact: (value) => value.replace(/sk-[A-Za-z0-9]+/g, "[REDACTED]"),
    writeClipboard: async (value) => {
      seen.push(value)
    },
    saveMarkdown: async () => undefined,
    notify: (_level, message) => notices.push(message)
  }
  await deliverEntireChat(
    { action: "copy", markdown: "key sk-ABC123 used" },
    deps
  )
  assert.deepEqual(seen, ["key [REDACTED] used"])
  assert.deepEqual(notices, ["Entire chat copied to the clipboard."])
})

test("a clipboard failure is reported as an error, not silently ignored", async () => {
  const notices: { level: string; message: string }[] = []
  await deliverEntireChat(
    { action: "copy", markdown: "# chat" },
    {
      redact: (value) => value,
      writeClipboard: async () => {
        throw new Error("clipboard unavailable")
      },
      saveMarkdown: async () => undefined,
      notify: (level, message) => notices.push({ level, message })
    }
  )
  assert.deepEqual(notices, [
    {
      level: "error",
      message: "Could not copy the chat to the clipboard: clipboard unavailable"
    }
  ])
})

test("saving to a chosen file reports where it was written", async () => {
  const saved: string[] = []
  const notices: { level: string; message: string }[] = []
  await deliverEntireChat(
    { action: "save", markdown: "# chat" },
    {
      redact: (value) => value,
      writeClipboard: async () => undefined,
      saveMarkdown: async (value) => {
        saved.push(value)
        return "/work/twinny-chat.md"
      },
      notify: (level, message) => notices.push({ level, message })
    }
  )
  assert.deepEqual(saved, ["# chat"])
  assert.deepEqual(notices, [
    { level: "info", message: "Entire chat saved to /work/twinny-chat.md." }
  ])
})

test("cancelling the save dialog writes nothing and reports nothing", async () => {
  const notices: string[] = []
  await deliverEntireChat(
    { action: "save", markdown: "# chat" },
    {
      redact: (value) => value,
      writeClipboard: async () => undefined,
      saveMarkdown: async () => undefined,
      notify: (_level, message) => notices.push(message)
    }
  )
  assert.deepEqual(notices, [])
})

test("a failed file write is reported as an error", async () => {
  const notices: { level: string; message: string }[] = []
  await deliverEntireChat(
    { action: "save", markdown: "# chat" },
    {
      redact: (value) => value,
      writeClipboard: async () => undefined,
      saveMarkdown: async () => {
        throw new Error("EACCES: permission denied")
      },
      notify: (level, message) => notices.push({ level, message })
    }
  )
  assert.deepEqual(notices, [
    {
      level: "error",
      message: "Could not save the chat: EACCES: permission denied"
    }
  ])
})

test("an empty export is refused with a message and never written", async () => {
  const notices: { level: string; message: string }[] = []
  let wrote = false
  await deliverEntireChat(
    { action: "copy", markdown: "   " },
    {
      redact: (value) => value,
      writeClipboard: async () => {
        wrote = true
      },
      saveMarkdown: async () => {
        wrote = true
        return undefined
      },
      notify: (level, message) => notices.push({ level, message })
    }
  )
  assert.equal(wrote, false)
  assert.deepEqual(notices, [{ level: "error", message: EMPTY_CHAT_MESSAGE }])
})

test("a tool's cut output and arguments carry their amounts into the export, not silent gaps", () => {
  const steps = new ToolSteps(() => undefined)
  const huge = "x".repeat(20000)
  steps.start({ id: "0.0", name: "read_file", args: { path: "big.txt", content: huge } })
  steps.finish({ id: "0.0", index: 0, mode: "native", summary: "read big.txt", output: huge, promptChars: 0 })
  const [step] = steps.steps
  assert.ok((step.outputOmitted ?? 0) > 0, "the cut output must be counted")
  assert.ok((step.argsOmitted ?? 0) > 0, "the cut argument must be counted")
  const text = exportOf([user("read it"), assistant("Here.", { toolSteps: steps.steps })])
  assert.ok(text.includes(`Output truncated: ${step.outputOmitted} characters were not kept`))
  assert.ok(text.includes(`${step.argsOmitted} characters of arguments were cut`))
})

test("a feedback verdict cut short in its step keeps the whole verdict in the export", () => {
  const steps = new ToolSteps(() => undefined)
  const verdict = `Rejected. ${"Detail. ".repeat(200)}Final reason: tests missing.`
  steps.review("feedback.review.9", "Rejected. Detail…", "failed", verdict)
  const text = exportOf([user("x"), assistant("Done.", { toolSteps: steps.steps })])
  assert.ok(text.includes("Final reason: tests missing."), "the end of the verdict must not be lost")
  assert.match(text, /#### Feedback review: rejected/)
})
