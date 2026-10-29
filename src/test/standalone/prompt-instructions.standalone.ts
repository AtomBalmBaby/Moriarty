import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"

import { resolveMarkdownInstructionSource } from "../../common/prompt-instructions"

const bundled = (name: string) => path.join(process.cwd(), "resources", "prompts", name)

test("both bundled instruction profiles are available and preserve default guidance", async () => {
  const chat = await resolveMarkdownInstructionSource("chat", "default", undefined, bundled("chat-base.default.md"))
  const intent = await resolveMarkdownInstructionSource("intent", "default", undefined, bundled("intent-compiler-base.default.md"))
  assert.match(chat.content, /helpful, respectful and honest coding assistant/)
  assert.match(chat.content, /Earlier conversation turns are historical context only/)
  assert.match(intent.content, /without changing its intent/)
  assert.match(intent.content, /constraints and exclusions/)
  assert.ok(chat.content.length > 0)
  assert.ok(intent.content.length > 0)
})

test("chat and compiler custom files resolve independently and changes apply on each read", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "twinny-prompt-instructions-"))
  const chatFile = path.join(root, "chat.md")
  const intentFile = path.join(root, "intent.md")
  const chatDefault = bundled("chat-base.default.md")
  const intentDefault = bundled("intent-compiler-base.default.md")
  try {
    await fs.writeFile(chatFile, "chat custom one")
    await fs.writeFile(intentFile, "compiler custom")
    const chat = await resolveMarkdownInstructionSource("chat", "custom", chatFile, chatDefault)
    const intent = await resolveMarkdownInstructionSource("intent", "custom", intentFile, intentDefault)
    assert.equal(chat.content, "chat custom one")
    assert.equal(intent.content, "compiler custom")
    assert.equal(chat.source, chatFile)
    assert.equal(intent.source, intentFile)
    await fs.writeFile(chatFile, "chat custom two")
    assert.equal((await resolveMarkdownInstructionSource("chat", "custom", chatFile, chatDefault)).content, "chat custom two")
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("missing and unreadable custom files report fallback while empty files remain empty", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "twinny-prompt-fallback-"))
  const fallback = bundled("chat-base.default.md")
  const emptyFile = path.join(root, "empty.md")
  await fs.writeFile(emptyFile, "")
  try {
    for (const file of [path.join(root, "missing.md"), root]) {
      const resolved = await resolveMarkdownInstructionSource("chat", "custom", file, fallback)
      assert.equal(resolved.source, fallback)
      assert.equal(resolved.content, await fs.readFile(fallback, "utf8"))
      assert.match(resolved.warning ?? "", /built-in default is being used/)
    }
    const empty = await resolveMarkdownInstructionSource("chat", "custom", emptyFile, fallback)
    assert.equal(empty.content, "")
    assert.equal(empty.source, emptyFile)
    assert.equal(empty.warning, undefined)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("None omits optional instructions without attempting file access", async () => {
  const resolved = await resolveMarkdownInstructionSource("intent", "none", "/does/not/exist.md", "/does/not/exist/default.md")
  assert.equal(resolved.content, "")
  assert.equal(resolved.source, undefined)
  assert.equal(resolved.warning, undefined)
})
