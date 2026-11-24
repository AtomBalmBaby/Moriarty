/**
 * Stage 3's native `query_evidence` tool, tested on the paths the chat actually uses: a scratch project under
 * /tmp, the real `workspaceTools` dispatch with the tool registered through `extras.evidence`, the production
 * recording hook, and Stage 2's real service. The tool answers from stored bytes, never by re-reading a source
 * or re-running a command; the model-facing copy is sparse (§4.7); nothing claims coverage the store does not
 * have (Rule 6); and scope is decided before content is read (Rule 7). Tests run on scratch projects only:
 * nothing in the repository tree, and never the developer's project database, is touched.
 */
import BetterSqlite from "better-sqlite3"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { recordToolResult } from "../../extension/chat/tool-evidence"
import { DEFAULT_EVIDENCE_STORAGE_LIMITS, TodoRepository, workspaceProjectFingerprint } from "../../extension/todos/repository"
import { prepareProjectTodoStorage, resolveProjectTodoStorage } from "../../extension/todos/sqlite"
import type { EvidenceAccess } from "../../extension/todos/types"
import { type ToolResult, type WorkspaceTools, workspaceTools } from "../../extension/tools/workspace"

interface ScratchProject {
  directory: string
  root: string
  databasePath: string
  projectId: string
  repository: TodoRepository
  access: EvidenceAccess
  tools: WorkspaceTools
  scope: { projectFingerprint: string; conversationId: string; writer: string }
}

const withSqlite = <T>(file: string, action: (database: BetterSqlite.Database) => T): T => {
  const database = new BetterSqlite(file, { fileMustExist: true })
  try {
    return action(database)
  } finally {
    database.close()
  }
}

const projectOf = (file: string): string =>
  (withSqlite(file, (database) => database.prepare("SELECT id FROM todo_projects").get()) as { id: string }).id

const rowsOf = (file: string, sql: string, ...values: unknown[]): Record<string, unknown>[] =>
  withSqlite(file, (database) => database.prepare(sql).all(...values)) as Record<string, unknown>[]

const observationsOf = (project: ScratchProject, toolName: string): number =>
  rowsOf(project.databasePath, "SELECT id FROM todo_tool_observations WHERE project_id = ? AND tool_name = ?", project.projectId, toolName).length

const asJson = (result: ToolResult): Record<string, unknown> => {
  assert.ok(result.output.startsWith("{"), `the result was plain text, not an envelope: ${result.output}`)
  return JSON.parse(result.output) as Record<string, unknown>
}

const withProject = async (prefix: string, run: (project: ScratchProject) => Promise<void>): Promise<void> => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const root = path.join(directory, "project")
  fs.mkdirSync(path.join(root, "src"), { recursive: true })
  const storage = resolveProjectTodoStorage([{ scheme: "file", fsPath: root }])
  const databasePath = await prepareProjectTodoStorage(storage)
  const conversation = prefix.replace(/[^a-z]/g, "")
  const repository = new TodoRepository(databasePath, DEFAULT_EVIDENCE_STORAGE_LIMITS, () => [root], {}, { hostKey: "stage3-host" })
  const scope = { projectFingerprint: workspaceProjectFingerprint([`file://${root}`]), conversationId: conversation, writer: conversation }
  try {
    await repository.initialize()
    await repository.getList(scope)
    const access = await repository.evidenceAccess(scope)
    await run({
      directory, root, databasePath, projectId: projectOf(databasePath), repository, access, scope,
      tools: workspaceTools(root, [], { evidence: { access }, readFileMaxLines: 5000, readFileAllowFullFile: true })
    })
  } finally {
    repository.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

test("query_evidence answers the beginning, line 687 and the last non-empty line of a stored large result without rerunning the tool", async () => {
  await withProject("stage3-retrieval-", async (project) => {
    const lines: string[] = []
    for (let index = 1; index <= 1374; index += 1) lines.push(index === 687 ? "| MIDDLE_MARKER | row 687 |" : index === 1374 ? "| END_MARKER | row 1374 |" : `row ${index}`)
    const target = path.join(project.root, "src", "plan.md")
    fs.writeFileSync(target, `${lines.join("\n")}\n`)
    const read = { name: "read_file", args: { path: "src/plan.md" } }
    const produced = await project.tools.run(read)
    assert.equal(produced.integrity?.status, "complete", "the whole read was produced complete")
    const observation = await recordToolResult({ repository: project.repository, scope: project.scope }, read, produced, { invocationId: "stage3-retrieval-read" })
    const stored = (produced.rawOutput ?? produced.output).split("\n").filter((line) => line !== "")
    assert.ok(stored.length >= 1376, `the stored output is the whole read, counted as the store indexes it: ${stored.length} lines`)

    // Before the source changes, a short page needs no envelope: it is plain text.
    const beginning = await project.tools.run({ name: "query_evidence", args: { observation_id: observation.id, start_line: 1, end_line: 2 } })
    assert.equal(beginning.observationId, observation.id, "the result names the real observation it answers from")
    assert.ok(!beginning.output.startsWith("{"), `the beginning is plain text: ${beginning.output}`)
    assert.ok(beginning.output.startsWith(stored.slice(0, 2).join("\n")), beginning.output)

    // The source changes after the capture, so anything that still matches what was recorded came from the store.
    fs.writeFileSync(target, `${lines.join("\n")}\nmutated after the capture\n`)
    const before = observationsOf(project, "read_file")

    const middle = stored.findIndex((line) => line.startsWith("687:"))
    assert.ok(middle > 0, "the recorded output numbers its lines")
    const line687 = asJson(await project.tools.run({ name: "query_evidence", args: { observation_id: observation.id, start_line: middle + 1, end_line: middle + 1 } }))
    assert.equal(line687.state, "retained")
    assert.equal(line687.text, stored[middle], "line 687 comes from durable evidence, not a reread")
    assert.match(String(line687.text), /MIDDLE_MARKER/)
    assert.equal(line687.historical, true, "the record is historical: it says what was observed, not what the file holds now")
    assert.equal((line687.provenance as Record<string, unknown>).tool, "read_file", "and it says what the record is an account of")
    const lastLine = stored.length /* the stored output is numbered from its own first line */
    const end = asJson(await project.tools.run({ name: "query_evidence", args: { observation_id: observation.id, start_line: lastLine, end_line: lastLine } }))
    assert.equal(end.text, stored[stored.length - 1], "the last non-empty line is retrievable without rerunning the tool")
    assert.match(String(end.text), /END_MARKER/)

    assert.equal(observationsOf(project, "read_file"), before, "no second read was recorded: the tool was not run again")
    const events = rowsOf(project.databasePath, "SELECT operation, outcome, arguments_json, execution_id FROM evidence_access_events WHERE project_id = ? ORDER BY created_at, id", project.projectId)
    assert.equal(events.length, 3, "each retrieval is recorded as one event")
    assert.ok(events.every((event) => event.operation === "range"), events.map((event) => String(event.operation)).join(", "))
    assert.ok(events.every((event) => event.execution_id === null), "a retrieval runs nothing, so no execution identity is invented for it")
    assert.ok(!JSON.stringify(events).includes("MIDDLE_MARKER"), "an event names its request, not the bytes it read")
  })
})

test("a complete short result stays plain text; an envelope appears only when integrity or retrieval semantics require it", async () => {
  await withProject("stage3-sparse-", async (project) => {
    const lines = Array.from({ length: 40 }, (_, index) => `row ${index + 1} ${"x".repeat(120)}`)
    fs.writeFileSync(path.join(project.root, "src", "rows.txt"), `${lines.join("\n")}\n`)
    const read = { name: "read_file", args: { path: "src/rows.txt" } }
    const produced = await project.tools.run(read)
    const observation = await recordToolResult({ repository: project.repository, scope: project.scope }, read, produced, { invocationId: "stage3-sparse-read" })

    const short = await project.tools.run({ name: "query_evidence", args: { observation_id: observation.id, start_line: 1, end_line: 2 } })
    assert.ok(!short.output.startsWith("{"), `a complete short page is plain text: ${short.output}`)
    assert.ok(!short.output.includes("[result_integrity]"), "a delivery with nothing to qualify carries no integrity line")
    assert.equal(short.failed, undefined, "and it is not reported as a failure")

    const long = asJson(await project.tools.run({ name: "query_evidence", args: { observation_id: observation.id, start_line: 3, end_line: 40 } }))
    assert.equal(long.state, "partial_prefix", "a result larger than its own bound says so")
    assert.ok(String(long.reason).includes("larger than its own bound"), String(long.reason))
    const continuation = long.continuation as { cursor?: string; next_byte?: number }
    assert.ok(typeof continuation.cursor === "string" && (continuation.cursor as string).startsWith("e1:payload:"), `the envelope carries the continuation of the same request: ${JSON.stringify(long)}`)
    assert.equal(continuation.next_byte, (long.coverage as { to_byte: number }).to_byte, "and it continues where this page stopped")
    assert.ok(!JSON.stringify(long).includes("null"), "no null placeholders")
    assert.ok(!JSON.stringify(long).includes("favourite"), "no default value is written")

    const zero = asJson(await project.tools.run({ name: "query_evidence", args: { observation_id: observation.id, operation: "search", query: "absent needle" } }))
    assert.equal(zero.match_count, 0, "zero matches is a successful result, not a failure")
    assert.ok(!JSON.stringify(zero).includes("[]"), "and an empty page writes no empty array")
    assert.equal(zero.state, "retained", "the search ran over content that is there")

    const found = asJson(await project.tools.run({ name: "query_evidence", args: { operation: "find", tool: "read_file" } }))
    assert.ok(!JSON.stringify(found).includes("[]"), "a filter writes no empty array")
    assert.equal((found.matches as Record<string, unknown>[])[0].observation_id, observation.id, "find names the real id")
  })
})

test("a partial delivery for a successful tool reports both delivered coverage and retained coverage without claiming the tail is recoverable when it is not", async () => {
  await withProject("stage3-coverage-", async (project) => {
    fs.writeFileSync(path.join(project.root, ".twinny", "config.json"), JSON.stringify({ evidence: { storage: { maxProjectBytes: 400, maxBlobBytes: 10_000 } } }))
    const access = await project.repository.evidenceAccess(project.scope)
    const capped = workspaceTools(project.root, [], { evidence: { access } })
    const bytes = Buffer.from("b".repeat(600), "utf8")
    const observation = await recordToolResult({ repository: project.repository, scope: project.scope }, { name: "run_command", args: { command: "check" } }, { output: "ran check", summary: "ran check", failed: false, rawOutput: bytes.toString("utf8"), rawStreams: { stdout: bytes } }, { invocationId: "stage3-coverage-run" })

    const past = asJson(await capped.run({ name: "query_evidence", args: { observation_id: observation.id, operation: "range", start_byte: 500, end_byte: 600 } }))
    assert.equal(past.state, "missing_tail", "a query past retained coverage says what is not there")
    assert.ok(String(past.reason).includes("[0,400)"), `the retained coverage is named: ${past.reason}`)
    const retained = (past.retained as { streams: { stream: string; coverage: Record<string, unknown>[] }[] }).streams[0].coverage
    assert.deepEqual(retained, [{ from_byte: 0, to_byte: 400 }], "what the store holds")
    assert.ok(past.continuation === undefined, "content past retained coverage is not advertised as recoverable")

    const crossing = asJson(await capped.run({ name: "query_evidence", args: { observation_id: observation.id, operation: "range", start_byte: 300, end_byte: 600 } }))
    assert.deepEqual(crossing.coverage, { from_byte: 300, to_byte: 400 }, "the delivered part is reported apart from the retained whole")
    assert.equal(crossing.text, "b".repeat(100), "and only the part that is retained is served")
    assert.deepEqual(crossing.completeness, { captured: "complete", stored: "partial" }, "capture and storage are reported apart")
  })
})

test("an evicted observation, a wrong-typed argument and a command whose output was never captured are each answered in their own words", async () => {
  await withProject("stage3-negatives-", async (project) => {
    fs.writeFileSync(path.join(project.root, ".twinny", "config.json"), JSON.stringify({ evidence: { storage: { maxProjectBytes: 400, maxBlobBytes: 10_000 } } }))
    const access = await project.repository.evidenceAccess(project.scope)
    const capped = workspaceTools(project.root, [], { evidence: { access } })
    const kept = await recordToolResult({ repository: project.repository, scope: project.scope }, { name: "run_command", args: { command: "check" } }, { output: "ran check", summary: "ran check", failed: false, rawOutput: "a".repeat(400), rawStreams: { stdout: Buffer.from("a".repeat(400), "utf8") } }, { invocationId: "stage3-kept-then-evicted" })
    await recordToolResult({ repository: project.repository, scope: project.scope }, { name: "run_command", args: { command: "room" } }, { output: "ran room", summary: "ran room", failed: false, rawOutput: "b".repeat(200), rawStreams: { stderr: Buffer.from("b".repeat(200), "utf8") } }, { invocationId: "stage3-needed-room" })
    const evicted = asJson(await capped.run({ name: "query_evidence", args: { observation_id: kept.id, operation: "range", stream: "stdout" } }))
    assert.equal(evicted.state, "evicted", "the eviction is its own state")
    assert.ok(String(evicted.reason).includes("what the store held, not what it still holds"), String(evicted.reason))
    assert.equal(evicted.text, undefined, "no content is claimed for bytes that are gone")

    // A call the contract cannot read: nothing ran, and the refusal says so.
    const wrong = await capped.run(
      { name: "query_evidence", args: { observation_id: kept.id, start_line: true } },
      { diagnostic: { operationId: "stage3-refusal", requestId: "stage3-refusal-request", step: 1 } }
    )
    assert.equal(wrong.failed, true)
    assert.equal(wrong.error?.executed, false, "a refused call is never represented as having run")
    assert.ok((wrong.output ?? "").includes("must be integer"), wrong.output)

    // A command whose output was never captured.
    const never = await recordToolResult({ repository: project.repository, scope: project.scope }, { name: "run_command", args: { command: "nothing arrived" } }, { output: "ran nothing", summary: "ran nothing", failed: false, rawOutput: "" }, { invocationId: "stage3-never-captured" })
    const uncaptured = asJson(await capped.run({ name: "query_evidence", args: { observation_id: never.id, operation: "range" } }))
    assert.equal(uncaptured.state, "not_retrievable", "no content is claimed where none was received")
    assert.ok(String(uncaptured.reason).includes("nothing was retained"), String(uncaptured.reason))
  })
})

test("a lookup that reaches outside this project and this caller's roots names no restricted candidate", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stage3-scope-"))
  const inside = path.join(directory, "inside")
  const outside = path.join(directory, "outside")
  for (const root of [inside, outside]) fs.mkdirSync(root, { recursive: true })
  const databasePath = await prepareProjectTodoStorage(resolveProjectTodoStorage([{ scheme: "file", fsPath: inside }]))
  const writer = new TodoRepository(databasePath, DEFAULT_EVIDENCE_STORAGE_LIMITS, () => [inside, outside], {}, { hostKey: "writer-host" })
  const reader = new TodoRepository(databasePath, DEFAULT_EVIDENCE_STORAGE_LIMITS, () => [inside], {}, { hostKey: "stage3-host" })
  const writerScope = { projectFingerprint: workspaceProjectFingerprint([`file://${inside}`]), conversationId: "stage3-writer", writer: "stage3-writer" }
  const readerScope = { projectFingerprint: workspaceProjectFingerprint([`file://${inside}`]), conversationId: "stage3-reader", writer: "stage3-reader" }
  try {
    await writer.initialize()
    await writer.getList(writerScope)
    await reader.initialize()
    await reader.getList(readerScope)
    fs.writeFileSync(path.join(outside, "secret.md"), "a reference under a root the reader does not hold\n")
    const recorded = await recordToolResult({ repository: writer, scope: writerScope }, { name: "read_file", args: { path: path.join(outside, "secret.md") } }, { output: "the recorded line", summary: "read", failed: false, rawOutput: "the recorded line\n" }, { invocationId: "stage3-outside-reference" })
    const readerAccess = await reader.evidenceAccess(readerScope)
    const readerTools = workspaceTools(inside, [], { evidence: { access: readerAccess } })
    assert.ok(readerTools.tools.some((tool) => tool.name === "query_evidence"), "the tool is registered for the reader")
    const denied = asJson(await readerTools.run({ name: "query_evidence", args: { observation_id: recorded.id } }))
    assert.equal(denied.access, "denied")
    assert.equal(denied.ok, false, "a refused lookup is reported as a refusal, not as content")
    assert.ok(!JSON.stringify(denied).includes("secret.md"), `a denied lookup names nothing it cannot name: ${JSON.stringify(denied)}`)
    const searched = asJson(await readerTools.run({ name: "query_evidence", args: { observation_id: recorded.id, operation: "search", query: "line" } }))
    assert.equal(searched.state, "not_retrievable", "a denied scope serves no content")
    const filtered = asJson(await readerTools.run({ name: "query_evidence", args: { operation: "find", path: outside } }))
    assert.equal(filtered.total, 0, "a filter that reaches outside the scope names nothing")
    const foreign = asJson(await readerTools.run({ name: "query_evidence", args: { observation_id: "77777777-7777-4777-8777-777777777777" } }))
    assert.equal(foreign.access, "missing", "an id this project holds no record for is not advertised")
    assert.ok(!JSON.stringify(foreign).includes(projectOf(databasePath)), "the refusal does not say which project it belongs to")
  } finally {
    writer.close()
    reader.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("the tool is only advertised when it is registered, and an unregistered call is refused rather than invented", async () => {
  await withProject("stage3-registration-", async (project) => {
    const plain = workspaceTools(project.root)
    assert.ok(!plain.tools.some((tool) => tool.name === "query_evidence"), "without the access service there is no tool to recommend")
    const unknown = await plain.run({ name: "query_evidence", args: { observation_id: "88888888-8888-4888-8888-888888888888" } })
    assert.equal(unknown.failed, true)
    assert.ok(unknown.output.includes("There is no tool called query_evidence"), unknown.output)
    assert.ok(project.tools.tools.some((tool) => tool.name === "query_evidence"), "with the service it is the only evidence tool registered")
    assert.equal(project.tools.tools.filter((tool) => tool.name === "query_evidence").length, 1, "one tool, not a second one")
    assert.equal(project.tools.tools.find((tool) => tool.name === "query_evidence")?.readOnly, true, "read-only, so repeat suppression applies to it")
  })
})
