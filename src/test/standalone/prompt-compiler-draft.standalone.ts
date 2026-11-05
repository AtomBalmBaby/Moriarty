import assert from "node:assert/strict"
import { test } from "node:test"

import {
  decideCompiledDraft,
  isMacPlatform,
  PendingCompilation,
  sendButtonAction,
  textToComposerHtml
} from "../../webview/prompt-compiler-draft"

const off = { mac: false, compilerEnabled: false, compiling: false }
const on = { mac: false, compilerEnabled: true, compiling: false }

test("a plain Send click always sends, whether or not the compiler is enabled", () => {
  assert.equal(sendButtonAction({}, off), "send")
  assert.equal(sendButtonAction({}, on), "send")
  assert.equal(sendButtonAction({}, { ...on, compiling: true }), "send")
  assert.equal(sendButtonAction({ metaKey: true }, on), "send", "Command is not the gesture off macOS")
})

test("Ctrl+Click compiles when enabled, Command+Click on macOS", () => {
  assert.equal(sendButtonAction({ ctrlKey: true }, on), "compile")
  assert.equal(sendButtonAction({ metaKey: true }, { ...on, mac: true }), "compile")
  assert.equal(sendButtonAction({ ctrlKey: true }, { ...on, mac: true }), "send", "Ctrl+Click on macOS is a context click, not the gesture")
  assert.equal(isMacPlatform("MacIntel"), true)
  assert.equal(isMacPlatform("Win32"), false)
  assert.equal(isMacPlatform(undefined), false)
})

test("the gesture sends normally when the compiler is disabled, and is ignored while one runs", () => {
  assert.equal(sendButtonAction({ ctrlKey: true }, off), "send")
  assert.equal(sendButtonAction({ ctrlKey: true }, { ...on, compiling: true }), "ignore", "no duplicate compilation")
})

const pending: PendingCompilation = { requestId: "r1", conversationId: "c1", revision: 4, draft: "fix it" }
const composer = { latestRequestId: "r1", conversationId: "c1", revision: 4, text: "fix it" }

test("an untouched draft is replaced by the compiled prompt", () => {
  assert.deepEqual(decideCompiledDraft(pending, composer), { action: "apply" })
})

test("edits made during compilation are never overwritten", () => {
  assert.deepEqual(decideCompiledDraft(pending, { ...composer, revision: 5, text: "fix it now" }), { action: "offer" })
  // Typed and undone back to the same text still counts as an edit.
  assert.deepEqual(decideCompiledDraft(pending, { ...composer, revision: 6 }), { action: "offer" })
})

test("late, superseded, cleared or moved results never touch the active draft", () => {
  assert.deepEqual(decideCompiledDraft(pending, { ...composer, latestRequestId: "r2" }), { action: "discard", reason: "superseded" })
  assert.deepEqual(decideCompiledDraft(pending, { ...composer, latestRequestId: undefined }), { action: "discard", reason: "superseded" })
  assert.deepEqual(decideCompiledDraft(pending, { ...composer, conversationId: "c2" }), { action: "discard", reason: "conversation-changed" })
  assert.deepEqual(decideCompiledDraft(pending, { ...composer, revision: 5, text: "  " }), { action: "discard", reason: "cleared" })
})

test("compiled text becomes escaped composer paragraphs", () => {
  assert.equal(textToComposerHtml("a <b> & c\r\nnext"), "<p>a &lt;b&gt; &amp; c</p><p>next</p>")
})
