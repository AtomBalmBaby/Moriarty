import * as assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"

import { compactToolEvidence, preserveEvidence } from "../../extension/todos/evidence"
import { contentHash } from "../../extension/tools/line-edit"
import { readFileSettings, ToolExtras, workspaceTools } from "../../extension/tools/workspace"

const TEXT = "const a = 1\nconst b = 2\nconst c = 3\n"

const fixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-read-args-"))
  fs.writeFileSync(path.join(root, "three.ts"), TEXT)
  return workspaceTools(root)
}

const read = (tools: ReturnType<typeof fixture>, args: Record<string, string>) =>
  tools.run({ name: "read_file", args: { path: "three.ts", ...args } })

const isFailure = (result: { failed?: boolean }) => assert.equal(result.failed, true)

test("a range read returns the requested lines with their numbers", async () => {
  const result = await read(fixture(), { start_line: "1", end_line: "2" })
  assert.notEqual(result.failed, true)
  assert.match(result.output, /^three\.ts \(lines 1–2 of 3\)\n/)
  assert.ok(result.output.endsWith("1: const a = 1\n2: const b = 2"), result.output)
})

test("a single-line read is start_line and end_line set to the same number", async () => {
  const result = await read(fixture(), { start_line: "2", end_line: "2" })
  assert.notEqual(result.failed, true)
  assert.match(result.output, /^three\.ts \(lines 2–2 of 3\)\n/)
  assert.ok(result.output.endsWith("2: const b = 2"), result.output)
})

test("a valid full_line read returns exactly the line at start_line", async () => {
  const result = await read(fixture(), { start_line: "2", full_line: "true" })
  assert.notEqual(result.failed, true)
  assert.match(result.output, /^three\.ts \(full line 2\)\n/)
  assert.ok(result.output.endsWith("2: const b = 2"), result.output)
})

test("full_line with an end_line equal to start_line is the same single-line read, and the flag is read in any case", async () => {
  const tools = fixture()
  const plain = await read(tools, { start_line: "2", full_line: "true" })
  const redundant = await read(tools, { start_line: "2", end_line: "2", full_line: "true" })
  const spelled = await read(tools, { start_line: " 2 ", full_line: " True " })
  assert.notEqual(redundant.failed, true)
  assert.equal(redundant.output, plain.output)
  assert.equal(spelled.output, plain.output)
})

test("full_line with a genuinely conflicting end_line is rejected, and the message says how to ask for a range", async () => {
  const result = await read(fixture(), { start_line: "1", end_line: "3", full_line: "true" })
  isFailure(result)
  assert.match(result.output, /full_line returns exactly one line, but end_line 3 differs from start_line 1/)
  assert.match(result.output, /For a range, drop full_line and pass start_line and end_line/)
})

test("a line number that cannot be inferred is rejected, never guessed", async () => {
  const tools = fixture()
  const bare = await read(tools, { full_line: "true" })
  isFailure(bare)
  assert.match(bare.output, /full_line needs start_line/)
  const endOnly = await read(tools, { end_line: "2", full_line: "true" })
  isFailure(endOnly)
  assert.match(endOnly.output, /full_line needs start_line/)
  const unknownFlag = await read(tools, { start_line: "1", full_line: "maybe" })
  isFailure(unknownFlag)
  assert.match(unknownFlag.output, /full_line must be true or false, got "maybe"/)
})

test("line numbers outside the file are rejected with the valid bounds", async () => {
  const tools = fixture()
  const pastEnd = await read(tools, { start_line: "4", full_line: "true" })
  isFailure(pastEnd)
  assert.match(pastEnd.output, /full_line start_line 4 is past the last line, 3\. Pass a start_line from 1 to 3/)
  const rangeStart = await read(tools, { start_line: "9" })
  isFailure(rangeStart)
  assert.match(rangeStart.output, /has only 3 lines/)
  const zero = await read(tools, { start_line: "0" })
  isFailure(zero)
  assert.match(zero.output, /start_line must be a line number from 1, got "0"/)
  const word = await read(tools, { start_line: "two" })
  isFailure(word)
  assert.match(word.output, /start_line must be a line number from 1, got "two"/)
  const backwards = await read(tools, { start_line: "3", end_line: "1" })
  isFailure(backwards)
  assert.match(backwards.output, /end_line 1 is before start_line 3/)
})

test("an end_line past the end of the file is clamped, and the header shows the lines actually read", async () => {
  const result = await read(fixture(), { start_line: "2", end_line: "9" })
  assert.notEqual(result.failed, true)
  assert.match(result.output, /^three\.ts \(lines 2–3 of 3\)\n/)
})

test("the source coverage of a normalized read is the lines it showed, in the evidence and the observation", async () => {
  const tools = fixture()
  const ranged = await read(tools, { start_line: "2", end_line: "9" })
  const sources = preserveEvidence(ranged.output).sources
  assert.equal(sources.length, 1)
  assert.equal(sources[0].path, "three.ts")
  assert.equal(sources[0].startLine, 2)
  assert.equal(sources[0].endLine, 3)
  const observed = compactToolEvidence({ name: "read_file", args: { path: "three.ts", start_line: "2", end_line: "9" }, output: ranged.output, failed: false, invocationId: "range" })
  assert.deepEqual(observed.lineRange, { start: 2, end: 3 })

  const single = await read(tools, { start_line: "2", end_line: "2", full_line: "true" })
  const singleSources = preserveEvidence(single.output).sources
  assert.equal(singleSources[0].startLine, 2)
  assert.equal(singleSources[0].endLine, 2)
  const singleObserved = compactToolEvidence({ name: "read_file", args: { path: "three.ts", start_line: "2", end_line: "2", full_line: "true" }, output: single.output, failed: false, invocationId: "single" })
  assert.deepEqual(singleObserved.lineRange, { start: 2, end: 2 })
})

test("the whole-file fingerprint is the same for a normalized line read as for the whole document", async () => {
  const tools = fixture()
  const hash = await contentHash(TEXT)
  const line = await read(tools, { start_line: "2", end_line: "2", full_line: "true" })
  const range = await read(tools, { start_line: "1", end_line: "3" })
  assert.equal(preserveEvidence(line.output).sources[0].contentHash, hash)
  assert.equal(preserveEvidence(range.output).sources[0].contentHash, hash)
  assert.equal(preserveEvidence(line.output).sources[0].totalLines, 3)
})

test("a failed read produces no accepted source evidence", async () => {
  const tools = fixture()
  const invalid: Record<string, string>[] = [
    { start_line: "1", end_line: "3", full_line: "true" },
    { full_line: "true" },
    { start_line: "4", full_line: "true" },
    { start_line: "3", end_line: "1" },
    { start_line: "0" }
  ]
  for (const args of invalid) {
    const result = await read(tools, args)
    isFailure(result)
    assert.deepEqual(preserveEvidence(result.output).sources, [], JSON.stringify(args))
  }
})

const SHORT = "const a = 1\nconst b = 2\nconst c = 3\n"
const LONG = Array.from({ length: 250 }, (_, i) => `line ${i + 1}`).join("\n") + "\n"
const HUGE = Array.from({ length: 1200 }, (_, i) => `line ${i + 1}`).join("\n") + "\n"
const LIMIT = 120

/** A workspace with one file per case, plus a file outside it and an ignored file beside it. */
const makeRoot = () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-full-file-"))
  const root = path.join(base, "root")
  fs.mkdirSync(root)
  fs.writeFileSync(path.join(base, "outside.txt"), "outside the workspace\n")
  fs.writeFileSync(path.join(root, "three.ts"), SHORT)
  fs.writeFileSync(path.join(root, "long.ts"), LONG)
  fs.writeFileSync(path.join(root, "huge.ts"), HUGE)
  fs.writeFileSync(path.join(root, "secret.env"), "TOKEN=1\n")
  return root
}

const workspace = (extras: ToolExtras = {}, ignored: string[] = []) =>
  workspaceTools(makeRoot(), ignored, { readFileMaxLines: LIMIT, ...extras })

const readFrom = (tools: ReturnType<typeof workspace>, args: Record<string, string>, file = "long.ts") =>
  tools.run({ name: "read_file", args: { path: file, ...args } })

test("a path-only read returns the whole file when it is within the line limit", async () => {
  const result = await readFrom(workspace(), {}, "three.ts")
  assert.notEqual(result.failed, true)
  assert.equal(result.output.split("\n")[0], "three.ts (lines 1–3 of 3)")
  assert.ok(result.output.endsWith("1: const a = 1\n2: const b = 2\n3: const c = 3"), result.output)
})

test("full_file true reads the same whole file as a path-only read", async () => {
  const tools = workspace()
  const plain = await readFrom(tools, {}, "three.ts")
  const explicit = await readFrom(tools, { full_file: "true" }, "three.ts")
  assert.notEqual(explicit.failed, true)
  assert.equal(explicit.output, plain.output)
  assert.equal(explicit.summary, plain.summary)
})

test("a whole file over the line limit is refused with its size, the limit, suggested ranges and the override setting, not truncated", async () => {
  const result = await readFrom(workspace(), {})
  isFailure(result)
  assert.equal(result.output, [
    "read_file: long.ts contains 250 lines.",
    "Configured maximum: 120 lines.",
    "",
    "Use multiple read_file calls:",
    "  start_line=1, end_line=120",
    "  start_line=121, end_line=240",
    "  start_line=241, end_line=250",
    "",
    "Or enable the full-file limit override in Twinny settings: \"Allow Full-File Reads Beyond Maximum Lines\" (twinny.chatToolsAllowFullFileReadsBeyondMaxReadLines)."
  ].join("\n"))
  const explicit = await readFrom(workspace(), { full_file: "true" })
  isFailure(explicit)
  assert.equal(explicit.output, result.output)
})

test("a very large file gets a bounded list of suggested ranges, with a count of the rest", async () => {
  const result = await readFrom(workspace(), {}, "huge.ts")
  isFailure(result)
  assert.match(result.output, /^read_file: huge\.ts contains 1200 lines\.\n/)
  assert.equal(result.output.split("\n").filter((line) => line.startsWith("  start_line=")).length, 5)
  assert.ok(result.output.includes("  start_line=481, end_line=600\n  … 5 more reads of up to 120 lines, through line 1200"), result.output)
})

test("with the full-file override enabled, a whole file over the limit is returned in full, from a path-only or a full_file read", async () => {
  const tools = workspace({ readFileAllowFullFile: true })
  const plain = await readFrom(tools, {})
  assert.notEqual(plain.failed, true)
  assert.match(plain.output, /^long\.ts \(lines 1–250 of 250\)\n/)
  assert.ok(plain.output.endsWith("250: line 250"))
  const explicit = await readFrom(tools, { full_file: "true" })
  assert.equal(explicit.output, plain.output)
})

test("with the full-file override disabled, a whole file over the limit is still refused", async () => {
  const tools = workspace({ readFileAllowFullFile: false })
  isFailure(await readFrom(tools, {}))
  isFailure(await readFrom(tools, { full_file: "true" }))
})

test("bounded range reads within the limit return exactly the requested lines", async () => {
  const range = await readFrom(workspace(), { start_line: "10", end_line: "20" })
  assert.notEqual(range.failed, true)
  assert.match(range.output, /^long\.ts \(lines 10–20 of 250\)\n/)
  assert.ok(range.output.endsWith("10: line 10\n11: line 11\n12: line 12\n13: line 13\n14: line 14\n15: line 15\n16: line 16\n17: line 17\n18: line 18\n19: line 19\n20: line 20"), range.output)
})

test("a range longer than the limit is refused, not cut short, even when the full-file override is enabled", async () => {
  for (const tools of [workspace(), workspace({ readFileAllowFullFile: true })]) {
    const result = await readFrom(tools, { start_line: "1", end_line: "200" })
    isFailure(result)
    assert.match(result.output, /^read_file: long\.ts lines 1–200 are 200 lines\.\nConfigured maximum: 120 lines\./)
    assert.match(result.output, / {2}start_line=1, end_line=120\n {2}start_line=121, end_line=200/)
    assert.match(result.output, /The full-file override does not apply to ranges/)
    assert.doesNotMatch(result.output, /of 250\)/)
  }
})

test("a start_line without end_line reads to the end of the file, subject to the limit and not to the override", async () => {
  const tools = workspace()
  const tooLong = await readFrom(tools, { start_line: "130" })
  isFailure(tooLong)
  assert.match(tooLong.output, /lines 130–250 are 121 lines/)
  const fits = await readFrom(tools, { start_line: "131" })
  assert.notEqual(fits.failed, true)
  assert.match(fits.output, /^long\.ts \(lines 131–250 of 250\)\n/)
  isFailure(await readFrom(workspace({ readFileAllowFullFile: true }), { start_line: "130" }))
})

test("full_file cannot be combined with a range or full_line, and its flag must be true or false", async () => {
  const tools = workspace()
  const conflicting: Record<string, string>[] = [
    { full_file: "true", start_line: "1" },
    { full_file: "true", end_line: "2" },
    { full_file: "true", start_line: "1", end_line: "2" },
    { full_file: "true", start_line: "2", full_line: "true" }
  ]
  for (const args of conflicting) {
    const result = await readFrom(tools, args, "three.ts")
    isFailure(result)
    assert.match(result.output, /full_file reads the whole file, so it cannot be combined with start_line, end_line or full_line/, JSON.stringify(args))
  }
  const unknown = await readFrom(tools, { full_file: "maybe" }, "three.ts")
  isFailure(unknown)
  assert.match(unknown.output, /full_file must be true or false, got "maybe"/)
  const falseWithRange = await readFrom(tools, { full_file: "false", start_line: "2", end_line: "2" }, "three.ts")
  assert.equal(falseWithRange.output.split("\n")[0], "three.ts (lines 2–2 of 3)")
})

test("full_line stays accepted but is not advertised, and full_file is advertised as an optional boolean", async () => {
  const tools = workspace()
  const schema = tools.tools.find((tool) => tool.name === "read_file")
  assert.deepEqual(schema?.parameters.map((parameter) => parameter.name), ["path", "full_file", "start_line", "end_line"])
  const fullFile = schema?.parameters.find((parameter) => parameter.name === "full_file")
  assert.equal(fullFile?.type, "boolean")
  assert.equal(fullFile?.optional, true)
  const legacy = await readFrom(tools, { start_line: "2", full_line: "true" }, "three.ts")
  assert.match(legacy.output, /^three\.ts \(full line 2\)\n/)
})

test("a whole-file read records the whole file as its coverage, with the authoritative fingerprint", async () => {
  const whole = await readFrom(workspace({ readFileAllowFullFile: true }), {})
  const [source] = preserveEvidence(whole.output).sources
  assert.equal(source.path, "long.ts")
  assert.equal(source.startLine, 1)
  assert.equal(source.endLine, 250)
  assert.equal(source.totalLines, 250)
  assert.equal(source.contentHash, await contentHash(LONG))
  const observed = compactToolEvidence({ name: "read_file", args: { path: "long.ts" }, output: whole.output, failed: false, invocationId: "whole" })
  assert.deepEqual(observed.lineRange, { start: 1, end: 250 })
})

test("a partial read is recorded as the lines it showed, never as the whole file", async () => {
  const tail = await readFrom(workspace(), { start_line: "200" })
  const [source] = preserveEvidence(tail.output).sources
  assert.equal(source.startLine, 200)
  assert.equal(source.endLine, 250)
  assert.equal(source.totalLines, 250)
  assert.equal(source.contentHash, await contentHash(LONG))
  const observed = compactToolEvidence({ name: "read_file", args: { path: "long.ts", start_line: "200" }, output: tail.output, failed: false, invocationId: "tail" })
  assert.deepEqual(observed.lineRange, { start: 200, end: 250 })
})

test("a refused oversized read produces no accepted source evidence", async () => {
  const tools = workspace()
  const refused: Record<string, string>[] = [{}, { full_file: "true" }, { start_line: "1", end_line: "200" }, { start_line: "130" }]
  for (const args of refused) {
    const result = await readFrom(tools, args)
    isFailure(result)
    assert.deepEqual(preserveEvidence(result.output).sources, [], JSON.stringify(args))
    const record = compactToolEvidence({ name: "read_file", args: { path: "long.ts", ...args }, output: result.output, failed: true, invocationId: "refused" })
    assert.equal(record.failed, true)
  }
})

test("the full-file override does not reach files outside the workspace or ignored files", async () => {
  const tools = workspace({ readFileAllowFullFile: true }, ["secret.env"])
  isFailure(await readFrom(tools, {}, "../outside.txt"))
  isFailure(await readFrom(tools, { full_file: "true" }, "../outside.txt"))
  isFailure(await readFrom(tools, {}, "secret.env"))
  isFailure(await readFrom(tools, { full_file: "true" }, "secret.env"))
})

test("the configuration reader supplies the maximum and the override to the tool", async () => {
  const settings = (values: Record<string, unknown>) =>
    readFileSettings(<T>(key: string, fallback: T): T => (key in values ? values[key] as T : fallback))
  const root = makeRoot()
  const run = (extras: ToolExtras) => workspaceTools(root, [], extras).run({ name: "read_file", args: { path: "huge.ts" } })

  const defaults = await run(settings({}))
  isFailure(defaults)
  assert.match(defaults.output, /Configured maximum: 1000 lines\./)

  assert.notEqual((await run(settings({ chatToolsMaxReadLines: 1500 }))).failed, true)

  const overridden = await run(settings({ chatToolsMaxReadLines: 300, chatToolsAllowFullFileReadsBeyondMaxReadLines: true }))
  assert.notEqual(overridden.failed, true)
  assert.match(overridden.output, /^huge\.ts \(lines 1–1200 of 1200\)\n/)

  const capped = await run(settings({ chatToolsMaxReadLines: 300, chatToolsAllowFullFileReadsBeyondMaxReadLines: false }))
  isFailure(capped)
  assert.match(capped.output, /Configured maximum: 300 lines\./)
})

test("the override is declared in package.json as an off-by-default boolean beside the read limit", () => {
  const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../package.json"), "utf8"))
  const properties = manifest.contributes.configuration.properties
  assert.equal(properties["twinny.chatToolsAllowFullFileReadsBeyondMaxReadLines"].type, "boolean")
  assert.equal(properties["twinny.chatToolsAllowFullFileReadsBeyondMaxReadLines"].default, false)
  assert.equal(properties["twinny.chatToolsMaxReadLines"].default, 1000)
})
