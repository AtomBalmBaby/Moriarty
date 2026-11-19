import * as assert from "node:assert/strict"
import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"

import { parseReadFile } from "../../common/tool-output"
import { resolveAgentToolSelection } from "../../extension/agents/tool-selection"
import { buildStreamingRequest } from "../../extension/inference/adapters/fluency"
import { contentHash, patchedText, planLineEdits } from "../../extension/tools/line-edit"
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
  assert.ok(full.output.includes(jsx), "the legacy full_line option also has no hidden size cap")
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


