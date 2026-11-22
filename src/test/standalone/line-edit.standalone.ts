import * as assert from "node:assert/strict"
import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"

import { parseReadFile } from "../../common/tool-output"
import { resolveAgentToolSelection } from "../../extension/agents/tool-selection"
import { buildStreamingRequest } from "../../extension/inference/adapters/fluency"
import { contentHash, LINE_EDIT_OPERATIONS, patchedText, planLineEdits } from "../../extension/tools/line-edit"
import { findToolCall, toolDefinition } from "../../extension/tools/protocol"
import { EditSink, workspaceTools } from "../../extension/tools/workspace"

const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex")

const roots: string[] = []
process.once("exit", () => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true })
})

const fixture = (initial: string) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-line-edit-"))
  fs.writeFileSync(path.join(root, "panel.tsx"), initial)
  fs.writeFileSync(path.join(root, ".gitignore"), "secret.txt\n")
  fs.writeFileSync(path.join(root, "secret.txt"), "secret\n")
  roots.push(root)
  let text = initial
  let transactions = 0
  const sink: EditSink = {
    mode: "apply",
    read: async () => text,
    edit: async () => ({ ok: true, message: "legacy" }),
    create: async () => ({ ok: true, message: "created" }),
    async editLines(_file, request) {
      const patches = await planLineEdits(text, request)
      await Promise.resolve()
      text = patchedText(text, patches)
      transactions++
      return { ok: true, message: "applied", contentHash: await contentHash(text), persisted: true }
    }
  }
  const tools = workspaceTools(root, [], { edits: sink, git: false, instructions: false })
  const edit = (edits: unknown, expected_hash = hash(text), file = "panel.tsx") => tools.run({
    name: "edit_lines", args: { path: file, expected_hash, edits: JSON.stringify(edits) }
  })
  return { tools, root, sink, edit, text: () => text, change: (value: string) => { text = value }, transactions: () => transactions }
}

test("read_file hashes the entire authoritative dirty document, not its range or disk copy", async () => {
  const f = fixture("disk\n")
  const source = "first\nsecond\nthird\n"
  f.change(source)
  const read = await f.tools.run({ name: "read_file", args: { path: "panel.tsx", start_line: "2", end_line: "2" } })
  assert.match(read.output, new RegExp(`content_hash: ${await contentHash(source)}; total_lines: 3`))
  assert.match(read.output, /^panel\.tsx \(lines 2–2 of 3\)/)
  assert.equal(parseReadFile(read.output)?.code, "second")
  assert.equal(fs.readFileSync(path.join(f.root, "panel.tsx"), "utf8"), "disk\n")
  f.change(source + "fourth\n")
  const reread = await f.tools.run({ name: "read_file", args: { path: "panel.tsx" } })
  assert.ok(!reread.output.includes(hash(source)))
  assert.ok(reread.output.includes(await contentHash(f.text())))
})

test("long JSX lines with repeated closing tags are returned intact and edited without exact-text matching", async () => {
  const jsx = "  return <section>" + "<div><span>repeated</span></div>".repeat(900) + "</section>"
  const f = fixture("function Panel() {\n" + jsx + "\n}\n")
  const read = await f.tools.run({ name: "read_file", args: { path: "panel.tsx", start_line: "2", end_line: "2" } })
  assert.ok(read.output.includes("2: " + jsx))
  assert.ok(!read.output.includes("…"))
  const full = await f.tools.run({ name: "read_file", args: { path: "panel.tsx", start_line: "2", full_line: "true" } })
  assert.equal(full.integrity?.status, "partial")
  assert.equal(full.integrity?.truncation?.nextCharStart, 10001)
  assert.match(full.output, /line 2 fragment characters 1–10000/)
  const result = await f.edit([{ operation: "replace", start_line: 2, end_line: 2, content: [jsx.replace("section", "main").replace("</section>", "</main>")] }])
  assert.equal(result.failed, undefined)
  assert.ok(f.text().includes("return <main>"))
  assert.equal(f.transactions(), 1)
})

const cases: [string, string, unknown[], string][] = [
  ["replace one line", "a\nb\nc\n", [{ operation: "replace", start_line: 2, end_line: 2, content: ["B"] }], "a\nB\nc\n"],
  ["replace multiple lines", "a\nb\nc\nd", [{ operation: "replace", start_line: 2, end_line: 3, content: ["B", "C", "extra"] }], "a\nB\nC\nextra\nd"],
  ["insert before", "a\nb", [{ operation: "insert_before", line: 2, content: ["new"] }], "a\nnew\nb"],
  ["insert after", "a\nb", [{ operation: "insert_after", line: 1, content: ["new"] }], "a\nnew\nb"],
  ["delete range", "a\nb\nc\nd\n", [{ operation: "delete", start_line: 2, end_line: 3 }], "a\nd\n"],
  ["delete unterminated EOF", "a\nb", [{ operation: "delete", start_line: 2, end_line: 2 }], "a"],
  ["delete all", "a\nb\n", [{ operation: "delete", start_line: 1, end_line: 2 }], ""],
  ["insert empty before", "", [{ operation: "insert_before", line: 1, content: ["new", "line"] }], "new\nline"],
  ["insert empty after", "", [{ operation: "insert_after", line: 0, content: ["new"] }], "new"],
  ["insert EOF after", "a", [{ operation: "insert_after", line: 1, content: ["b"] }], "a\nb"],
  ["insert EOF before", "a\n", [{ operation: "insert_before", line: 2, content: ["b"] }], "a\nb\n"],
  ["LF preserved", "a\nb\nc\n", [{ operation: "replace", start_line: 2, end_line: 2, content: ["B", "extra"] }], "a\nB\nextra\nc\n"],
  ["CRLF preserved", "a\r\nb\r\nc\r\n", [{ operation: "replace", start_line: 2, end_line: 2, content: ["B", "extra"] }, { operation: "insert_after", line: 3, content: ["d"] }], "a\r\nB\r\nextra\r\nc\r\nd\r\n"],
  ["nonoverlapping original coordinates", "a\nb\nc\nd\ne\n", [{ operation: "replace", start_line: 4, end_line: 4, content: ["D"] }, { operation: "insert_before", line: 1, content: ["new", "top"] }, { operation: "delete", start_line: 2, end_line: 2 }], "new\ntop\na\nc\nD\ne\n"]
]
for (const [name, before, edits, after] of cases) test(name, async () => {
  const f = fixture(before)
  const result = await f.edit(edits)
  assert.equal(result.failed, undefined, result.output)
  assert.equal(f.text(), after)
  assert.equal(f.transactions(), 1)
  assert.deepEqual(JSON.parse(result.output), { ok: true, path: "panel.tsx", content_hash: await contentHash(after), hash_algorithm: "xxh64", persisted: true, message: "applied" })
})

const rejected: [string, unknown, string][] = [
  ["overlapping ranges", [{ operation: "replace", start_line: 1, end_line: 2, content: ["x"] }, { operation: "delete", start_line: 2, end_line: 3 }], "overlapping_edits"],
  ["duplicate insertion boundary", [{ operation: "insert_after", line: 1, content: ["x"] }, { operation: "insert_before", line: 2, content: ["y"] }], "overlapping_edits"],
  ["insertion touching replaced range", [{ operation: "replace", start_line: 2, end_line: 2, content: ["x"] }, { operation: "insert_after", line: 2, content: ["y"] }], "overlapping_edits"],
  ["zero line", [{ operation: "delete", start_line: 0, end_line: 1 }], "invalid_range"],
  ["fractional line", [{ operation: "insert_before", line: 1.5, content: ["x"] }], "invalid_range"],
  ["line beyond EOF", [{ operation: "replace", start_line: 4, end_line: 4, content: ["x"] }], "invalid_range"],
  ["reversed range", [{ operation: "delete", start_line: 3, end_line: 2 }], "invalid_range"],
  ["invalid later operation", [{ operation: "replace", start_line: 1, end_line: 1, content: ["x"] }, { operation: "delete", start_line: 9, end_line: 9 }], "invalid_range"],
  ["embedded newline", [{ operation: "insert_after", line: 1, content: ["x\ny"] }], "invalid_range"],
  ["string coordinate", [{ operation: "delete", start_line: "1", end_line: 1 }], "invalid_range"],
  ["empty content", [{ operation: "replace", start_line: 1, end_line: 1, content: [] }], "invalid_range"],
  ["unknown fields", [{ operation: "insert_before", line: 1, start_line: 1, content: ["x"] }], "invalid_range"],
  ["non-string operation", [{ operation: ["replace"], start_line: 1, end_line: 1, content: ["x"] }], "invalid_range"],
  ["unknown operation", [{ operation: "append", line: 1, content: ["x"] }], "invalid_range"],
  ["empty batch", [], "invalid_range"]
]
for (const [name, edits, code] of rejected) test("rejects " + name + " without modification", async () => {
  const f = fixture("a\nb\nc\n")
  const result = await f.edit(edits)
  assert.equal(result.failed, true)
  assert.equal(JSON.parse(result.output).error.code, code)
  assert.equal(f.text(), "a\nb\nc\n")
  assert.equal(f.transactions(), 0)
})

test("outdated hashes reject atomically and return the current hash", async () => {
  const f = fixture("old\n")
  const stale = hash(f.text())
  f.change("dirty buffer\n")
  const result = await f.edit([{ operation: "replace", start_line: 1, end_line: 1, content: ["new"] }], stale)
  assert.equal(result.failed, true)
  assert.equal(JSON.parse(result.output).error.code, "hash_mismatch")
  assert.equal(JSON.parse(result.output).error.current_hash, await contentHash("dirty buffer\n"))
  assert.equal(f.text(), "dirty buffer\n")
  assert.equal(f.transactions(), 0)
})

test("native schema, text dispatch, inventory and explicit tool selection expose edit_lines", async () => {
  const f = fixture("a\n")
  const tool = f.tools.tools.find((entry) => entry.name === "edit_lines")!
  assert.ok(tool)
  assert.equal(toolDefinition(tool).parameters, tool.schema)
  assert.equal(resolveAgentToolSelection(["Edit"], f.tools.tools, []).native.some((entry) => entry.name === "edit_lines"), true)
  assert.deepEqual(resolveAgentToolSelection(["read_file"], f.tools.tools, []).native.map((entry) => entry.name), ["read_file"])
  const call = findToolCall("```tool\n" + JSON.stringify({ name: "edit_lines", arguments: { path: "panel.tsx", expected_hash: hash(f.text()), edits: [{ operation: "replace", start_line: 1, end_line: 1, content: ["new"] }] } }) + "\n```")!.call!
  assert.equal((await f.tools.run(call)).failed, undefined)
  assert.equal(f.text(), "new\n")
  assert.equal(workspaceTools(f.root).tools.some((entry) => entry.name === "edit_lines"), false)
})

test("llama.cpp is told the operation key, the operations and their fields for edit_lines", () => {
  const f = fixture("a\n")
  const tool = f.tools.tools.find((entry) => entry.name === "edit_lines")!
  const request = buildStreamingRequest({ id: "llamacpp", label: "llama.cpp", provider: "llamacpp", type: "chat", modelName: "m" } as never, [{ role: "user", content: "Edit." }], { tools: [toolDefinition(tool)] }) as unknown as {
    tools: Array<{ function: { parameters: { properties: { edits: { items: { required?: string[]; properties?: Record<string, { description?: string }> } } } } } }>
  }
  const items = request.tools[0].function.parameters.properties.edits.items
  assert.deepEqual(items.required, ["operation"])
  for (const name of ["replace", "delete", "insert_before", "insert_after"]) assert.match(items.properties!.operation.description!, new RegExp(name))
  for (const field of ["start_line", "end_line", "line", "content"]) assert.ok(items.properties![field], field)
})

test("the logged type-keyed request is rejected through native dispatch, naming the operation key", async () => {
  const f = fixture("a\nb\n")
  const result = await f.edit([{ type: "replace", start_line: 2, end_line: 2, content: ["B"] }])
  assert.equal(result.failed, true)
  const error = JSON.parse(result.output).error
  assert.equal(error.code, "invalid_range")
  assert.match(error.message, /"operation"/)
  assert.match(error.message, /type/)
  assert.equal(f.text(), "a\nb\n")
  assert.equal(f.transactions(), 0)
})

test("a legitimate replace through native dispatch is applied and returns the resulting hash", async () => {
  const f = fixture("a\nb\nc\n")
  const result = await f.edit([{ operation: "replace", start_line: 2, end_line: 2, content: ["B"] }])
  assert.equal(result.failed, undefined)
  const output = JSON.parse(result.output)
  assert.equal(output.ok, true)
  assert.equal(output.persisted, true)
  assert.equal(f.text(), "a\nB\nc\n")
  assert.equal(output.content_hash, await contentHash("a\nB\nc\n"))
})

test("invalid operations name the unsupported field or value", async () => {
  const cases: [string, unknown, RegExp][] = [
    ["a missing operation key", [{ type: "replace", start_line: 1, end_line: 1, content: ["x"] }], /"operation".*type|type.*"operation"/],
    ["an unknown operation value", [{ operation: "append", line: 1, content: ["x"] }], /"append"/],
    ["an extra field", [{ operation: "delete", start_line: 1, end_line: 1, content: ["x"] }], /content/]
  ]
  for (const [name, edits, pattern] of cases) {
    const f = fixture("a\n")
    const result = await f.edit(edits)
    assert.equal(result.failed, true, name)
    assert.match(JSON.parse(result.output).error.message, pattern, name)
    assert.equal(f.transactions(), 0, name)
  }
})

test("concurrent Twinny requests serialize and revalidate instead of racing", async () => {
  const f = fixture("a\n")
  const expected = hash(f.text())
  const edit = [{ operation: "replace", start_line: 1, end_line: 1, content: ["new"] }]
  const otherTools = workspaceTools(f.root, [], { edits: f.sink, git: false, instructions: false })
  const results = await Promise.all([f.edit(edit, expected), otherTools.run({ name: "edit_lines", args: { path: "panel.tsx", expected_hash: expected, edits: JSON.stringify(edit) } })])
  assert.equal(results.filter((result) => !result.failed).length, 1)
  assert.equal(JSON.parse(results.find((result) => result.failed)!.output).error.code, "hash_mismatch")
  assert.equal(f.transactions(), 1)
})

test("missing and forbidden documents return structured errors", async () => {
  const f = fixture("a\n")
  const edits = [{ operation: "delete", start_line: 1, end_line: 1 }]
  assert.equal(JSON.parse((await f.edit(edits, hash(f.text()), "missing.txt")).output).error.code, "document_unavailable")
  assert.equal(JSON.parse((await f.edit(edits, hash(f.text()), "secret.txt")).output).error.code, "permission_denied")
  assert.equal(f.transactions(), 0)
})

test("cancelled queued edits never mutate the document", async () => {
  const f = fixture("a\n")
  const stop = new AbortController()
  const pending = f.tools.run({ name: "edit_lines", args: { path: "panel.tsx", expected_hash: hash(f.text()), edits: JSON.stringify([{ operation: "delete", start_line: 1, end_line: 1 }]) } }, { signal: stop.signal })
  stop.abort()
  const result = await pending
  assert.equal(result.failed, true)
  assert.match(JSON.parse(result.output).error.message, /execution stopped/)
  assert.equal(f.text(), "a\n")
  assert.equal(f.transactions(), 0)
})

test("legacy sinks without an open buffer still read the filesystem", async () => {
  const f = fixture("disk\n")
  const tools = workspaceTools(f.root, [], { edits: { ...f.sink, read: async () => undefined }, git: false, instructions: false })
  const read = await tools.run({ name: "read_file", args: { path: "panel.tsx" } })
  assert.equal(read.failed, undefined)
  assert.ok(read.output.includes(await contentHash("disk\n")))
  assert.equal(parseReadFile(read.output)?.code, "disk")
})

const orderRanges = [
  { operation: "insert_before", line: 1, content: ["top"] },
  { operation: "replace", start_line: 2, end_line: 2, content: ["B1", "B2", "B3"] },
  { operation: "replace", start_line: 4, end_line: 4, content: ["D"] }
]
const orderExpected = "top\na\nB1\nB2\nB3\nc\nD\ne\n"

for (const [name, order] of [["top-to-bottom", orderRanges], ["bottom-to-top", [...orderRanges].reverse()]] as [string, unknown[]][]) {
  test(`the same batch read ${name} leaves the same content through the production path`, async () => {
    const f = fixture("a\nb\nc\nd\ne\n")
    const result = await f.edit(order)
    assert.equal(result.failed, undefined, result.output)
    assert.equal(f.text(), orderExpected)
    assert.equal(JSON.parse(result.output).content_hash, await contentHash(orderExpected))
    assert.equal(f.transactions(), 1, "the batch stays one transaction")
  })
}

test("the planned ranges address the original snapshot and are ordered bottom-to-top", async () => {
  const source = "a\nb\nc\nd\ne\n"
  for (const order of [orderRanges, [...orderRanges].reverse()]) {
    const patches = await planLineEdits(source, { expected_hash: hash(source), edits: order })
    const starts = patches.map((patch) => patch.start)
    assert.deepEqual(starts, [...starts].sort((a, b) => b - a), "planned from the bottom up, whatever order the call supplied")
    for (const patch of patches) {
      assert.match(source.slice(patch.start, patch.end), /^(?:[a-e]\n)?$/, `the range at offset ${patch.start} still addresses the lines it named`)
    }
    assert.equal(patchedText(source, patches), orderExpected)
  }
})

test("a range that changes the line count does not shift the ranges after it", async () => {
  const source = "1\n2\n3\n4\n5\n6\n"
  const expected = "1\nA\nB\nC\n6\ntail\n"
  const f = fixture(source)
  const result = await f.edit([
    { operation: "replace", start_line: 2, end_line: 2, content: ["A", "B", "C"] },
    { operation: "delete", start_line: 3, end_line: 5 },
    { operation: "insert_after", line: 6, content: ["tail"] }
  ])
  assert.equal(result.failed, undefined, result.output)
  assert.equal(f.text(), expected, "the ranges below the changed one still land on the lines they named")
  assert.equal(JSON.parse(result.output).content_hash, await contentHash(expected))
})

test("an expected_hash that does not match leaves every range unapplied", async () => {
  const f = fixture("a\nb\nc\n")
  const result = await f.edit([{ operation: "replace", start_line: 1, end_line: 1, content: ["x"] }, { operation: "delete", start_line: 3, end_line: 3 }], hash("other text\n"))
  assert.equal(result.failed, true)
  assert.equal(JSON.parse(result.output).error.code, "hash_mismatch")
  assert.equal(JSON.parse(result.output).error.current_hash, await contentHash("a\nb\nc\n"))
  assert.equal(f.text(), "a\nb\nc\n")
  assert.equal(f.transactions(), 0)
})

test("a single range is planned and applied as it always was", async () => {
  const source = "a\nb\nc\n"
  const edits = [{ operation: "replace", start_line: 2, end_line: 2, content: ["B", "extra"] }]
  const f = fixture(source)
  const result = await f.edit(edits)
  assert.equal(result.failed, undefined, result.output)
  assert.equal(f.text(), "a\nB\nextra\nc\n")
  assert.equal(f.transactions(), 1)
  const planned = await planLineEdits(source, { expected_hash: hash(source), edits })
  assert.equal(planned.length, 1)
  assert.equal(patchedText(source, planned), "a\nB\nextra\nc\n")
})

const orderRejections: [string, unknown[], string][] = [
  ["overlapping ranges given bottom-to-top", [{ operation: "delete", start_line: 3, end_line: 4 }, { operation: "replace", start_line: 2, end_line: 3, content: ["x"] }], "overlapping_edits"],
  ["invalid range given bottom-to-top", [{ operation: "delete", start_line: 9, end_line: 9 }, { operation: "replace", start_line: 2, end_line: 2, content: ["x"] }], "invalid_range"]
]

for (const [name, edits, code] of orderRejections) {
  test(`rejects ${name} without modification`, async () => {
    const f = fixture("a\nb\nc\nd\n")
    const result = await f.edit(edits)
    assert.equal(result.failed, true, result.output)
    assert.equal(JSON.parse(result.output).error.code, code)
    assert.equal(f.text(), "a\nb\nc\nd\n")
    assert.equal(f.transactions(), 0)
  })
}

const substringCases: [string, string, unknown[], string][] = [
  ["replaces the substring on the line it names", "first\nsecond\nthird\n", [{ operation: "replace_text", line: 2, old_text: "second", new_text: "SECOND" }], "first\nSECOND\nthird\n"],
  ["accepts an empty new_text and removes the match", "first\nsecond\nthird\n", [{ operation: "replace_text", line: 2, old_text: "second", new_text: "" }], "first\n\nthird\n"],
  ["leaves the prefix, the suffix and the neighbouring lines alone", "keep|target|keep\nneighbour\n", [{ operation: "replace_text", line: 1, old_text: "target", new_text: "replaced" }], "keep|replaced|keep\nneighbour\n"],
  ["keeps CRLF endings and the terminal newline", "one\r\ntwo three\r\nfour\r\n", [{ operation: "replace_text", line: 2, old_text: "three", new_text: "THREE" }], "one\r\ntwo THREE\r\nfour\r\n"],
  ["takes two independently identified targets on one line", "one two three\nsecond\n", [{ operation: "replace_text", line: 1, old_text: "one", new_text: "ONE" }, { operation: "replace_text", line: 1, old_text: "three", new_text: "THREE" }], "ONE two THREE\nsecond\n"],
  ["takes two touching targets on one line", "abcdef\n", [{ operation: "replace_text", line: 1, old_text: "abc", new_text: "ABC" }, { operation: "replace_text", line: 1, old_text: "def", new_text: "DEF" }], "ABCDEF\n"],
  ["mixed ranges of different sizes in one batch", "one\ntwo\nthree\nfour\nfive\n", [{ operation: "replace_text", line: 2, old_text: "two", new_text: "TWO" }, { operation: "delete", start_line: 3, end_line: 4 }, { operation: "insert_after", line: 5, content: ["last"] }], "one\nTWO\nfive\nlast\n"],
  ["stays compatible with insert, replace and delete in one batch", "a\nb\nc\n", [{ operation: "replace_text", line: 1, old_text: "a", new_text: "A" }, { operation: "delete", start_line: 2, end_line: 2 }, { operation: "insert_after", line: 3, content: ["end"] }], "A\nc\nend\n"]
]
for (const [name, before, edits, after] of substringCases) test(`replace_text ${name}`, async () => {
  const f = fixture(before)
  const result = await f.edit(edits)
  assert.equal(result.failed, undefined, result.output)
  assert.equal(f.text(), after)
  assert.equal(f.transactions(), 1)
  assert.deepEqual(JSON.parse(result.output), { ok: true, path: "panel.tsx", content_hash: await contentHash(after), hash_algorithm: "xxh64", persisted: true, message: "applied" })
})

const substringRejections: [string, string, unknown[], string][] = [
  ["line 0", "a\nb\nc\n", [{ operation: "replace_text", line: 0, old_text: "a", new_text: "A" }], "invalid_range"],
  ["a line past the snapshot", "a\nb\nc\n", [{ operation: "replace_text", line: 4, old_text: "a", new_text: "A" }], "invalid_range"],
  ["no line at all", "a\nb\nc\n", [{ operation: "replace_text", old_text: "a", new_text: "A" }], "invalid_range"],
  ["a string line", "a\nb\nc\n", [{ operation: "replace_text", line: "1", old_text: "a", new_text: "A" }], "invalid_range"],
  ["a fractional line", "a\nb\nc\n", [{ operation: "replace_text", line: 2.5, old_text: "b", new_text: "B" }], "invalid_range"],
  ["a substring that is on another line", "a\nb\nc\n", [{ operation: "replace_text", line: 1, old_text: "b", new_text: "B" }], "invalid_range"],
  ["an ambiguous substring on the line named", "x x\ny\n", [{ operation: "replace_text", line: 1, old_text: "x", new_text: "z" }], "invalid_range"],
  ["a case that does not match exactly", "b\n", [{ operation: "replace_text", line: 1, old_text: "B", new_text: "z" }], "invalid_range"],
  ["an empty old_text", "a\n", [{ operation: "replace_text", line: 1, old_text: "", new_text: "z" }], "invalid_range"],
  ["an old_text holding a newline", "a\nb\n", [{ operation: "replace_text", line: 1, old_text: "a\nb", new_text: "z" }], "invalid_range"],
  ["a new_text holding a newline", "a\nb\n", [{ operation: "replace_text", line: 1, old_text: "a", new_text: "z\ny" }], "invalid_range"],
  ["an operand holding a carriage return", "a\r\nb\r\n", [{ operation: "replace_text", line: 1, old_text: "a\r", new_text: "z" }], "invalid_range"],
  ["a new_text that is not a string", "a\n", [{ operation: "replace_text", line: 1, old_text: "a", new_text: 3 }], "invalid_range"],
  ["content instead of old_text and new_text", "a\n", [{ operation: "replace_text", line: 1, content: ["z"] }], "invalid_range"],
  ["start_line and end_line with replace_text", "a\n", [{ operation: "replace_text", start_line: 1, end_line: 1, old_text: "a", new_text: "A" }], "invalid_range"],
  ["two overlapping substring targets on one line", "ab\n", [{ operation: "replace_text", line: 1, old_text: "a", new_text: "A" }, { operation: "replace_text", line: 1, old_text: "ab", new_text: "B" }], "overlapping_edits"],
  ["a substring inside a full-line replace", "a\nb\n", [{ operation: "replace", start_line: 1, end_line: 1, content: ["X"] }, { operation: "replace_text", line: 1, old_text: "a", new_text: "A" }], "overlapping_edits"],
  ["a substring inside a deleted line", "a\nb\n", [{ operation: "delete", start_line: 1, end_line: 1 }, { operation: "replace_text", line: 1, old_text: "a", new_text: "A" }], "overlapping_edits"],
  ["an invalid edit later in the batch", "a\nb\nc\n", [{ operation: "replace_text", line: 1, old_text: "a", new_text: "A" }, { operation: "replace_text", line: 9, old_text: "z", new_text: "y" }], "invalid_range"]
]
for (const [name, before, edits, code] of substringRejections) test(`rejects replace_text ${name} without modification`, async () => {
  const f = fixture(before)
  const result = await f.edit(edits)
  assert.equal(result.failed, true, result.output)
  assert.equal(JSON.parse(result.output).error.code, code)
  assert.equal(f.text(), before)
  assert.equal(f.transactions(), 0, "nothing was applied")
})

test("replace_text names the line it was asked for and the edit that failed", async () => {
  const source = "one\ntwo two\nthree\n"
  const f = fixture(source)
  const absent = await f.edit([{ operation: "replace_text", line: 1, old_text: "two", new_text: "TWO" }])
  assert.equal(absent.failed, true, absent.output)
  const message = JSON.parse(absent.output).error.message
  assert.match(message, /Edit 1/, "the failed edit is named")
  assert.match(message, /not on line 1/)
  assert.match(message, /line 2/, "it says where the text actually is, without using that line")
  const ambiguous = await f.edit([{ operation: "replace_text", line: 2, old_text: "two", new_text: "TWO" }])
  assert.equal(ambiguous.failed, true, ambiguous.output)
  assert.match(JSON.parse(ambiguous.output).error.message, /Edit 1.*occurs 2 times on line 2/)
  assert.equal(f.text(), source)
})

test("a stale expected_hash refuses a replace_text batch before anything is planned", async () => {
  const f = fixture("first\nsecond\n")
  const stale = hash(f.text())
  f.change("dirty buffer\nsecond\n")
  const result = await f.edit([{ operation: "replace_text", line: 1, old_text: "first", new_text: "FIRST" }], stale)
  assert.equal(result.failed, true)
  assert.equal(JSON.parse(result.output).error.code, "hash_mismatch")
  assert.equal(JSON.parse(result.output).error.current_hash, await contentHash("dirty buffer\nsecond\n"))
  assert.equal(f.text(), "dirty buffer\nsecond\n")
  assert.equal(f.transactions(), 0)
})

test("a substring inside a 4,000 character table row is changed without retyping the row", async () => {
  const row = "| Stage | " + "x".repeat(4_200) + " scratch logs in `/tmp` only. |"
  assert.ok(row.length > 4_000, "the row is the long one the failure was about")
  const source = "heading\n" + row + "\nfooter\n"
  const f = fixture(source)
  const edits = [{ operation: "replace_text", line: 2, old_text: "scratch logs in `/tmp` only.", new_text: "scratch logs in `/tmp` only. Closing verification completed." }]
  assert.ok(JSON.stringify(edits).length < 200, "the call names the substring, not the whole 4,000 character row")
  const result = await f.edit(edits)
  assert.equal(result.failed, undefined, result.output)
  const expected = "heading\n" + row.replace("only.", "only. Closing verification completed.") + "\nfooter\n"
  assert.equal(f.text(), expected, "the row's other text is untouched")
  assert.equal(JSON.parse(result.output).content_hash, await contentHash(expected), "the hash is the actual final content")
  const read = await f.tools.run({ name: "read_file", args: { path: "panel.tsx", start_line: "2", end_line: "2" } })
  assert.ok(read.output.includes(await contentHash(expected)), "and the hash read_file gives for the next edit is current")
  assert.equal(f.transactions(), 1)
})

test("replace_text patches address the original snapshot and are planned bottom-to-top", async () => {
  const source = "one\ntwo\nthree\nfour\nfive\n"
  const substringEdit = { operation: "replace_text", line: 2, old_text: "two", new_text: "TWO" }
  const edits = [substringEdit, { operation: "replace", start_line: 4, end_line: 4, content: ["FOUR", "extra"] }, { operation: "insert_after", line: 5, content: ["five-b"] }]
  const expected = "one\nTWO\nthree\nFOUR\nextra\nfive\nfive-b\n"
  for (const order of [edits, [...edits].reverse()]) {
    const patches = await planLineEdits(source, { expected_hash: hash(source), edits: order })
    const starts = patches.map((patch) => patch.start)
    assert.deepEqual(starts, [...starts].sort((a, b) => b - a), "planned from the bottom up whatever order the call supplied")
    const patch = patches.find((entry) => entry.text === substringEdit.new_text)
    assert.ok(patch, `the patch for ${substringEdit.old_text}`)
    assert.equal(source.slice(patch.start, patch.end), substringEdit.old_text, "the range still addresses the line it named in the snapshot")
    assert.equal(patchedText(source, patches), expected)
  }
})

test("two replace_text targets on one line stay separately identified", async () => {
  const source = "one two three\n"
  const edits = [{ operation: "replace_text", line: 1, old_text: "two", new_text: "TWO" }, { operation: "replace_text", line: 1, old_text: "three", new_text: "THREE" }]
  assert.equal(patchedText(source, await planLineEdits(source, { expected_hash: hash(source), edits })), "one TWO THREE\n")
})


test("the edit_lines schema and instructions advertise replace_text with its own fields", async () => {
  const f = fixture("a\n")
  const tool = f.tools.tools.find((entry) => entry.name === "edit_lines")!
  const advertised = "Do not reproduce the complete line."
  assert.ok(tool.description.includes(advertised), "the description tells the model not to retype a long line")
  assert.ok(tool.guidance?.includes(advertised), "and so do the instructions")
  const items = (tool.schema!.properties as Record<string, Record<string, unknown>>).edits.items as {
    properties: Record<string, unknown>
    oneOf: Array<{ required: string[]; properties: Record<string, unknown>; additionalProperties?: boolean }>
  }
  assert.deepEqual((items.properties.operation as { enum: string[] }).enum, LINE_EDIT_OPERATIONS)
  const branchFor = (operation: string) => items.oneOf.find((entry) => (entry.properties.operation as { enum: string[] }).enum[0] === operation)!
  const substring = branchFor("replace_text")
  assert.deepEqual(substring.required, ["operation", "line", "old_text", "new_text"])
  assert.equal(substring.additionalProperties, false)
  assert.ok(!substring.properties.content, "replace_text takes no content")
  assert.ok(items.properties.old_text && items.properties.new_text, "the fields are described for the model")
  const deletion = branchFor("delete")
  assert.deepEqual(deletion.required, ["operation", "start_line", "end_line"])
  assert.ok(!deletion.properties.content, "delete neither requires nor accepts content")
})


