/**
 * Stage 2's read-only access service, tested on the paths the chat actually uses: a scratch project under
 * /tmp, the real repository, the real tool dispatch and the real byte store. Every state §4.3 names is
 * reached by a real request, the reproduction answers from stored bytes without a second read_file, and no
 * path here reruns a tool for retrieval. Tests run on scratch projects only; nothing in the repository tree
 * or the developer's project database is touched.
 */
import BetterSqlite from "better-sqlite3"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { recordToolResult } from "../../extension/chat/tool-evidence"
import { MAX_RETAINED_EVIDENCE_CHARS } from "../../extension/todos/evidence"
import { createPolicySource } from "../../extension/todos/evidence-config"
import { type CapturedResult, type EvidenceStream, ProjectEvidenceStore, type StoredOutcome } from "../../extension/todos/evidence-store"
import { DEFAULT_EVIDENCE_STORAGE_LIMITS, TodoRepository, workspaceProjectFingerprint } from "../../extension/todos/repository"
import { prepareProjectTodoStorage, resolveProjectTodoStorage, SqliteFile } from "../../extension/todos/sqlite"
import type { EvidenceAccess } from "../../extension/todos/types"
import { fitResult } from "../../extension/tools/budget"
import { fingerprintContent } from "../../extension/tools/fingerprint"
import { ToolCall } from "../../extension/tools/protocol"
import { workspaceTools } from "../../extension/tools/workspace"

interface ScratchProject {
  directory: string
  root: string
  databasePath: string
  projectId: string
  repository: TodoRepository
  store: ProjectEvidenceStore
  access: EvidenceAccess
  scope: { projectFingerprint: string; conversationId: string; writer: string }
}

/** The plan Stage 0 measured: 1,374 lines, read whole through the production tool path. */
const PLAN_FILE = path.join(path.resolve(__dirname, "..", "..", ".."), "docs", "Moriarty_Unified_Index_Evidence_Implementation_Plan.md")

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

const countOf = (file: string, sql: string, value: unknown): number =>
  (withSqlite(file, (database) => database.prepare(sql).get(...(sql.includes("?") ? [value] : []))) as { n: number }).n

const streamOf = (outcome: StoredOutcome, name: EvidenceStream) => outcome.streams.find((state) => state.stream === name)

/** A capture as the host would build one for bytes that arrived on separate streams. */
const capturedOf = (invocationId: string, entries: { stream: EvidenceStream; bytes: Buffer; seq?: number; receivedAt?: string }[], extra: Partial<CapturedResult> = {}): CapturedResult => {
  const received = entries.reduce((sum, entry) => sum + entry.bytes.length, 0)
  const arrivedAt = new Date().toISOString()
  return {
    invocationId,
    toolName: "run_command",
    args: { command: "check" },
    executed: true,
    status: "exited",
    streams: {},
    captureMode: "pipes",
    chunks: entries.map((entry, index) => ({ stream: entry.stream, seq: entry.seq ?? index, bytes: entry.bytes, receivedAt: entry.receivedAt ?? arrivedAt })),
    startedAt: arrivedAt,
    finishedAt: arrivedAt,
    exitCode: 0,
    terminationReason: "exit",
    capture: { originalBytes: received, capturedBytes: received, storedBytes: 0, redaction: "none", encoding: "utf8" },
    ...extra
  }
}

const withProject = async (prefix: string, run: (project: ScratchProject) => Promise<void>): Promise<void> => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const root = path.join(directory, "project")
  fs.mkdirSync(path.join(root, "src"), { recursive: true })
  const storage = resolveProjectTodoStorage([{ scheme: "file", fsPath: root }])
  const databasePath = await prepareProjectTodoStorage(storage)
  const conversation = prefix.replace(/[^a-z]/g, "")
  const repository = new TodoRepository(databasePath, DEFAULT_EVIDENCE_STORAGE_LIMITS, () => [root], {}, { hostKey: "stage2-host" })
  const scope = { projectFingerprint: workspaceProjectFingerprint([`file://${root}`]), conversationId: conversation, writer: conversation }
  try {
    await repository.initialize()
    await repository.getList(scope)
    await run({
      directory, root, databasePath, projectId: projectOf(databasePath), repository,
      store: new ProjectEvidenceStore(new SqliteFile(databasePath), createPolicySource(root), root),
      access: await repository.evidenceAccess(scope), scope
    })
  } finally {
    repository.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

const storedLines = (text: string): string[] => text.split("\n")

const eventOf = (file: string, projectId: string, operation: string) =>
  withSqlite(file, (database) => database.prepare("SELECT operation, arguments_json, outcome, execution_id FROM evidence_access_events WHERE project_id = ? AND operation = ? ORDER BY created_at, id LIMIT 1").get(projectId, operation)) as { operation: string; arguments_json: string; outcome: string; execution_id: string | null } | undefined

test("the 1,374-line plan reproduction answers beginning, line 687 and the final non-empty line from durable evidence without repeating read_file", async () => {
  await withProject("stage2-reproduction-", async (project) => {
    const plan = fs.readFileSync(PLAN_FILE, "utf8")
    const fileLines = storedLines(plan.replace(/\n$/, ""))
    assert.equal(fileLines.length, 1374, "the reproduction case is the same 1,374-line plan, measured from the file itself")
    const target = path.join(project.root, "plan.md")
    fs.writeFileSync(target, plan)
    const tools = workspaceTools(project.root, [], { readFileMaxLines: 5000, readFileAllowFullFile: true })
    const call: ToolCall = { name: "read_file", args: { path: "plan.md" } }
    const result = await tools.run(call)
    assert.ok(result.rawOutput !== undefined, "the tool hands the host its raw output before fitting")
    assert.equal(result.integrity?.status, "complete", "the whole read was produced complete")
    const captured = result.rawOutput!
    // What the model is given is a fitted copy, smaller than what the store holds.
    const delivered = fitResult(captured, 4_000)
    assert.ok(delivered.length < captured.length, "delivery is a cut of the stored content")
    const observation = await recordToolResult({ repository: project.repository, scope: project.scope }, call, { ...result, output: delivered }, { invocationId: "reproduction-read" })
    const retained = (await project.repository.projectObservations(project.scope))[0]
    assert.ok(retained.outcome !== undefined, "the invocation has its outcome recorded before fitting")
    const outcome = retained.outcome!
    const payload = streamOf(outcome, "payload")!
    assert.equal(payload.storageComplete, "complete", "the store holds every byte it received")
    assert.equal(payload.storedBytes, Buffer.byteLength(captured), "original bytes are measured, not quoted")
    assert.ok(payload.storedBytes > delivered.length, "storage is not the display copy")
    assert.equal(retained.originalChars, captured.length)
    assert.ok(retained.preservedChars <= MAX_RETAINED_EVIDENCE_CHARS, "the presentation copy stays bounded")
    assert.ok(retained.complete === false || delivered.length === retained.preservedChars, "a cut presentation copy is never called whole")

    const lines = storedLines(captured)
    const beginning = await project.access.range(observation.id, { startLine: 1, endLine: 3 })
    assert.equal(beginning.state, "retained")
    assert.equal(beginning.text, lines.slice(0, 3).join("\n"), "the beginning comes from stored bytes")

    const indexed = lines.findIndex((line) => line.startsWith("687:"))
    assert.ok(indexed > 0, "the delivered output numbers its lines")
    const middle = await project.access.range(observation.id, { startLine: indexed + 1, endLine: indexed + 1 })
    assert.equal(middle.state, "retained")
    assert.equal(middle.text, lines[indexed], "line 687 comes from durable evidence, not a reread")
    assert.equal(middle.coverage.fromLine, indexed + 1)
    assert.equal(middle.text.replace(/^\d+: /, ""), fileLines[686], "and it is the plan's own line 687")

    const lastContent = lines.length - 1
    const end = await project.access.range(observation.id, { startLine: lastContent, endLine: lastContent })
    assert.equal(end.state, "retained")
    assert.equal((end.text ?? "").replace(/^\d+: /, ""), fileLines.filter((line) => line !== "").pop(), "the final non-empty line is retrievable without rereading; the plan file ends with a blank line")

    // No rerun: the tool was not called again, so a changed source cannot change what is answered.
    const before = countOf(project.databasePath, "SELECT COUNT(*) AS n FROM todo_tool_observations WHERE project_id = ?", project.projectId)
    fs.writeFileSync(target, `${plan}mutated after the capture\n`)
    const afterChange = await project.access.range(observation.id, { startLine: indexed + 1, endLine: indexed + 1 })
    assert.equal(afterChange.text, lines[indexed], "the service served stored evidence, not current source")
    assert.equal(countOf(project.databasePath, "SELECT COUNT(*) AS n FROM todo_tool_observations WHERE project_id = ?", project.projectId), before, "retrieval recorded no new observation")
    assert.equal(afterChange.historical, true, "a stale record is labelled historical")
    const currentHash = await fingerprintContent(fs.readFileSync(target, "utf8"), "xxh64")
    assert.ok((afterChange.originalHash ?? "") !== currentHash, "no replacement fingerprint leaks through the result (Rule 3)")
    assert.equal(afterChange.originalHash, retained.sources[0]?.contentHash, "the hash reported is the one as it was observed")
    assert.ok((JSON.stringify(afterChange).includes(currentHash)) === false, "the result names no current hash")
    const event = eventOf(project.databasePath, project.projectId, "range")
    assert.ok(event !== undefined && event.outcome === "retained", "the retrieval itself is recorded as an event")
  })
})

test("long-line fragments and exact byte offsets round-trip, and a query beyond stored coverage returns the state that is true", async () => {
  await withProject("stage2-fragments-", async (project) => {
    const long = "a".repeat(20_000)
    const captured = `first line\n${long}\nlast line\n`
    const outcome = await project.store.record(capturedOf("fragment-read", [{ stream: "payload", bytes: Buffer.from(captured, "utf8") }], { toolName: "read_file" }), { projectId: project.projectId })
    const fragment = await project.access.range(outcome.observationId, { startLine: 2, startChar: 5_000, endChar: 5_050 })
    assert.equal(fragment.state, "retained")
    assert.equal(fragment.text, long.slice(4_999, 5_050), "the fragment is what the stored line holds")
    assert.equal(fragment.coverage.fromByte, Buffer.byteLength("first line\n") + Buffer.byteLength(long.slice(0, 4_999)), "character offsets are mapped back to bytes, not assumed equal")
    const byts = await project.access.range(outcome.observationId, { startByte: 10, endByte: 20 })
    assert.equal(byts.state, "retained")
    assert.equal(Buffer.from(captured, "utf8").subarray(10, 20).equals(Buffer.from(byts.text ?? "", "utf8")), true, "byte offsets count stored bytes exactly")

    fs.writeFileSync(path.join(project.root, ".twinny", "config.json"), JSON.stringify({ evidence: { storage: { maxProjectBytes: 400, maxBlobBytes: 10_000 } } }))
    const capped = await project.store.record(capturedOf("partial-store", [{ stream: "stdout", bytes: Buffer.from("b".repeat(600), "utf8") }]), { projectId: project.projectId })
    const beyond = await project.access.range(capped.observationId, { startByte: 500, endByte: 600 })
    assert.equal(beyond.state, "missing_tail", "a query past retained coverage says what is not there")
    assert.equal(beyond.text, undefined, "and it does not advertise content it cannot give")
    assert.deepEqual(beyond.coverage, { fromByte: 0, toByte: 400 }, "the coverage reported is what the store holds")
    const crossing = await project.access.range(capped.observationId, { startByte: 300, endByte: 600 })
    assert.equal(crossing.state, "missing_tail")
    assert.equal(crossing.text, "b".repeat(100), "the part that is retained is still served")
    assert.deepEqual(crossing.coverage, { fromByte: 300, toByte: 400 })
  })
})

test("stdout and stderr selection returns each stream on its own, and merged presentation is only offered where chunk order allows it", async () => {
  await withProject("stage2-streams-", async (project) => {
    const out = Buffer.from("printed on fd 1\n", "utf8")
    const err = Buffer.from("warning on fd 2\n", "utf8")
    const outcome = await project.store.record(capturedOf("two-streams", [
      { stream: "stdout", bytes: out, seq: 0, receivedAt: "2026-11-23T10:00:01.000Z" },
      { stream: "stderr", bytes: err, seq: 1, receivedAt: "2026-11-23T10:00:02.000Z" }
    ]), { projectId: project.projectId })
    const alone = await project.access.range(outcome.observationId, { stream: "stdout" })
    assert.equal(alone.text, out.toString("utf8"), "one stream on its own")
    const other = await project.access.range(outcome.observationId, { stream: "stderr" })
    assert.equal(other.text, err.toString("utf8"))
    const ambiguous = await project.access.range(outcome.observationId, {})
    assert.equal(ambiguous.state, "not_retrievable")
    assert.ok((ambiguous.reason ?? "").includes("names no stream"), "no single output is claimed for two separate streams")
    const merged = await project.access.range(outcome.observationId, { stream: "terminal" })
    assert.equal(merged.state, "retained")
    assert.equal(merged.coordinates, "merged_view")
    assert.equal(merged.text, out.toString("utf8") + err.toString("utf8"), "the merged view follows the recorded chunk order")
    assert.deepEqual(merged.mergedFrom, [{ stream: "stdout", coverage: [{ fromByte: 0, toByte: out.length }] }, { stream: "stderr", coverage: [{ fromByte: out.length, toByte: out.length + err.length }] }])
    const tied = await project.store.record(capturedOf("tie-order", [
      { stream: "stdout", bytes: out, seq: 0, receivedAt: "2026-11-23T10:00:03.000Z" },
      { stream: "stderr", bytes: err, seq: 0, receivedAt: "2026-11-23T10:00:03.000Z" }
    ]), { projectId: project.projectId })
    const refused = await project.access.range(tied.observationId, { stream: "terminal" })
    assert.equal(refused.state, "not_retrievable")
    assert.ok((refused.reason ?? "").includes("does not allow one"), "an order that cannot be decided without guessing is not presented as a transcript")
    assert.equal((await project.access.range(tied.observationId, { stream: "stdout" })).text, out.toString("utf8"), "each stream is still readable on its own")
  })
})

test("search over retained output returns zero matches as a successful result with match_count 0", async () => {
  await withProject("stage2-zero-matches-", async (project) => {
    const text = "one line\nanother line\n"
    const outcome = await project.store.record(capturedOf("searched", [{ stream: "payload", bytes: Buffer.from(text, "utf8") }], { toolName: "grep", status: "exited", exitCode: 0, captureMode: "not_applicable" }), { projectId: project.projectId })
    const page = await project.access.search(outcome.observationId, { query: "absent needle", mode: "literal" })
    assert.equal(page.state, "retained", "an empty result over content that is there is a success, not a failure")
    assert.equal(page.matchCount, 0)
    assert.deepEqual(page.matches, [])
    assert.ok((page.reason ?? "").includes("successful"), page.reason)
    const neverRun = await project.store.record(capturedOf("never-searched", [], { toolName: "grep", status: "unknown", executed: false }), { projectId: project.projectId })
    const honest = await project.access.search(neverRun.observationId, { query: "absent needle" })
    assert.equal(honest.state, "not_retrievable")
    assert.equal(honest.matchCount, 0)
    assert.ok((honest.reason ?? "").includes("no match count can be claimed"), "a search that ran over nothing does not report a zero total")
  })
})

test("pagination is deterministic: the same cursor returns the same page, and a page that cannot fit reports its continuation", async () => {
  await withProject("stage2-pagination-", async (project) => {
    const lines = new Array(40).fill("needle " + "x".repeat(150))
    const text = `${lines.join("\n")}\n`
    const outcome = await project.store.record(capturedOf("paged", [{ stream: "payload", bytes: Buffer.from(text, "utf8") }], { toolName: "grep" }), { projectId: project.projectId })
    const request = { query: "needle", mode: "literal" as const, limit: 5 }
    const first = await project.access.search(outcome.observationId, request)
    assert.equal(first.state, "partial_prefix", "the page reports its own bound instead of pretending a total")
    assert.ok(first.matchLimit !== undefined && first.scannedBytes !== undefined, "the bound is reported as a bound")
    assert.ok(first.cursor !== undefined, "and it can be continued")
    const again = await project.access.search(outcome.observationId, { ...request, cursor: first.cursor })
    const againAgain = await project.access.search(outcome.observationId, { ...request, cursor: first.cursor })
    assert.deepEqual(again, againAgain, "the same cursor returns the same page")
    assert.ok(again.matches.length > 0 && again.matches[0].byte! > first.matches[first.matches.length - 1].byte!, "continuation moves forward in (stream, byte) order")
    assert.ok(again.matches.every((match, index) => index === 0 || match.byte! > again.matches[index - 1].byte!), "pages are ordered by byte")
    const foreign = await project.access.search(outcome.observationId, { query: "needle", mode: "literal", limit: 5, cursor: first.cursor })
    assert.deepEqual(foreign, again)
    const crossed = await project.access.search(outcome.observationId, { query: "needle", mode: "regex", cursor: `e1:stdout:${first.matches[0].byte}:deadbeef` })
    assert.equal(crossed.state, "not_retrievable")
    assert.ok((crossed.reason ?? "").includes("does not belong to this request"), "a cursor from another request is refused rather than guessed")
  })
})

test("an evicted blob, a missing tail and an inaccessible record each report their own state and never advertise retrieval they cannot perform", async () => {
  await withProject("stage2-states-", async (project) => {
    fs.writeFileSync(path.join(project.root, ".twinny", "config.json"), JSON.stringify({ evidence: { storage: { maxProjectBytes: 500, maxBlobBytes: 10_000 } } }))
    const kept = await project.store.record(capturedOf("kept-then-evicted", [{ stream: "stdout", bytes: Buffer.from("a".repeat(400), "utf8") }]), { projectId: project.projectId })
    await project.store.record(capturedOf("needed-room", [{ stream: "stderr", bytes: Buffer.from("b".repeat(200), "utf8") }]), { projectId: project.projectId })
    const evicted = await project.access.range(kept.observationId, { stream: "stdout" })
    assert.equal(evicted.state, "evicted", "the eviction is its own state")
    assert.equal(evicted.text, undefined)
    assert.ok((evicted.reason ?? "").includes("what the store held, not what it still holds"), evicted.reason)
    const searched = await project.access.search(kept.observationId, { query: "a" })
    assert.equal(searched.state, "evicted")
    assert.equal(searched.matchCount, 0, "no count is claimed across content that is gone")

    const byFile = await new ProjectEvidenceStore(new SqliteFile(project.databasePath), createPolicySource(project.root), project.root, { forceStorageKind: "file" }).record(capturedOf("external-bytes", [{ stream: "stdout", bytes: Buffer.from("verified bytes\n", "utf8") }]), { projectId: project.projectId })
    const row = withSqlite(project.databasePath, (database) => database.prepare("SELECT relative_path FROM evidence_blobs WHERE id = ?").get(byFile.streams[0].blobId!)) as { relative_path: string | null }
    fs.writeFileSync(path.join(project.root, ".twinny", "blobs", row.relative_path ?? ""), "bytes that no longer match the row\n")
    const unverifiable = await project.access.range(byFile.observationId, { stream: "stdout" })
    assert.equal(unverifiable.state, "unknown_content", "content the store cannot verify is not presented as retrievable")
    assert.equal(unverifiable.text, undefined)

    const nothing = await project.store.record(capturedOf("no-bytes", [], { toolName: "read_file", status: "exited", executed: true }), { projectId: project.projectId })
    const inaccessible = await project.access.range(nothing.observationId, {})
    assert.equal(inaccessible.state, "not_retrievable")
    assert.ok((inaccessible.reason ?? "").includes("nothing was retained"), inaccessible.reason)
  })
})

test("cross-project and unauthorized access is refused without naming restricted candidates", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stage2-scope-"))
  const inside = path.join(directory, "inside")
  const outside = path.join(directory, "outside")
  for (const root of [inside, outside]) fs.mkdirSync(root, { recursive: true })
  const databasePath = await prepareProjectTodoStorage(resolveProjectTodoStorage([{ scheme: "file", fsPath: inside }]))
  const writer = new TodoRepository(databasePath, DEFAULT_EVIDENCE_STORAGE_LIMITS, () => [inside, outside], {}, { hostKey: "writer-host" })
  const reader = new TodoRepository(databasePath, DEFAULT_EVIDENCE_STORAGE_LIMITS, () => [inside], {}, { hostKey: "reader-host" })
  const writerScope = { projectFingerprint: workspaceProjectFingerprint([`file://${inside}`]), conversationId: "writer-chat", writer: "writer-chat" }
  const readerScope = { projectFingerprint: workspaceProjectFingerprint([`file://${inside}`]), conversationId: "reader-chat", writer: "reader-chat" }
  try {
    await writer.initialize()
    await writer.getList(writerScope)
    const recorded = await recordToolResult({ repository: writer, scope: writerScope }, { name: "read_file", args: { path: outside + "/secret.md" } }, { output: "a reference under a root the reader does not hold", summary: "read", failed: false, rawOutput: "the stored text\n" }, { invocationId: "outside-reference" })
    const readerAccess = await reader.evidenceAccess(readerScope)
    const denied = await readerAccess.get(recorded.id)
    assert.equal(denied.access, "denied")
    assert.equal(denied.path, undefined, "a denied lookup names no restricted candidate")
    assert.ok(!JSON.stringify(denied).includes("secret.md"), JSON.stringify(denied))
    const searched = await readerAccess.search(recorded.id, { query: "text" })
    assert.equal(searched.state, "not_retrievable")
    assert.deepEqual(await readerAccess.find({ path: outside + "/secret.md" }), [], "a filter that reaches outside the scope names nothing")
    const otherProject = await readerAccess.get("00000000-0000-4000-8000-000000000000")
    assert.equal(otherProject.access, "missing")
    assert.ok(!JSON.stringify(otherProject).includes(projectOf(databasePath)), "a foreign identity does not say which project it belongs to")
    assert.equal(countOf(databasePath, "SELECT COUNT(*) AS n FROM evidence_access_events WHERE operation = ?", "get"), 1, "the cross-project lookup records no event, because it names nothing this project can reference")
    const foreignHost = withSqlite(databasePath, (database) => {
      const id = "11111111-1111-4111-8111-111111111111"
      database.prepare("INSERT INTO todo_tool_observations(id, project_id, request_id, tool_name, arguments_json, output, failed, created_at, executed, host_key) VALUES (?, ?, ?, ?, ?, ?, 0, ?, 1, ?)").run(id, projectOf(databasePath), "host-claim", "read_file", "{}", "", new Date().toISOString(), "other-host")
      return id
    })
    assert.equal((await readerAccess.get(foreignHost)).access, "denied", "an observation recorded on another extension host is not read here")
    const legacy = await recordToolResult({ repository: writer, scope: writerScope }, { name: "read_file", args: { path: "inside/a.md" } }, { output: "a reference inside both scopes", summary: "read", failed: false, rawOutput: "shared text\n" }, { invocationId: "inside-reference" })
    assert.equal((await readerAccess.get(legacy.id)).access, "found", "a row that names no host makes no claim on it")
  } finally {
    writer.close()
    reader.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("retrieval records an execution event without duplicating the stored blob", async () => {
  await withProject("stage2-events-", async (project) => {
    const text = "the stored output\nwith a needle line\n"
    const outcome = await project.store.record(capturedOf("event-read", [{ stream: "payload", bytes: Buffer.from(text, "utf8") }], { toolName: "read_file" }), { projectId: project.projectId })
    const blobBefore = withSqlite(project.databasePath, (database) => database.prepare("SELECT id, inline_bytes, stored_bytes FROM evidence_blobs WHERE project_id = ?").all(project.projectId)) as { id: string; inline_bytes: Buffer | null; stored_bytes: number }[]
    const observationsBefore = countOf(project.databasePath, "SELECT COUNT(*) AS n FROM todo_tool_observations WHERE project_id = ?", project.projectId)
    const evidenceRowsBefore = countOf(project.databasePath, "SELECT COUNT(*) AS n FROM todo_tool_evidence AS evidence JOIN todo_tool_observations AS observations ON observations.id = evidence.observation_id WHERE observations.project_id = ?", project.projectId)
    const span = await project.access.range(outcome.observationId, { startLine: 2, endLine: 2 })
    const page = await project.access.search(outcome.observationId, { query: "needle" })
    const matches = await project.access.find({ toolName: "read_file", limit: 5 })
    assert.equal(span.state, "retained")
    assert.equal(page.state, "retained")
    assert.equal(matches.length, 1)
    assert.equal(countOf(project.databasePath, "SELECT COUNT(*) AS n FROM evidence_blobs WHERE project_id = ?", project.projectId), blobBefore.length, "no second copy of the bytes is made")
    const bytesAfter = (withSqlite(project.databasePath, (database) => database.prepare("SELECT inline_bytes FROM evidence_blobs WHERE id = ?").get(blobBefore[0].id)) as { inline_bytes: Buffer | null }).inline_bytes
    assert.equal(bytesAfter?.equals(blobBefore[0].inline_bytes ?? Buffer.alloc(0)), true, "the stored bytes are unchanged")
    assert.equal(countOf(project.databasePath, "SELECT COUNT(*) AS n FROM todo_tool_observations WHERE project_id = ?", project.projectId), observationsBefore, "retrieval is not recorded as model-visible evidence")
    assert.equal(countOf(project.databasePath, "SELECT COUNT(*) AS n FROM todo_tool_evidence AS evidence JOIN todo_tool_observations AS observations ON observations.id = evidence.observation_id WHERE observations.project_id = ?", project.projectId), evidenceRowsBefore, "no evidence-of-evidence chain")
    const events = withSqlite(project.databasePath, (database) => database.prepare("SELECT operation, arguments_json, outcome, execution_id FROM evidence_access_events WHERE project_id = ? AND observation_id = ? ORDER BY operation").all(project.projectId, outcome.observationId)) as { operation: string; arguments_json: string; outcome: string; execution_id: string | null }[]
    assert.deepEqual(events.map((event) => event.operation), ["find", "range", "search"])
    assert.deepEqual(JSON.parse(events[1].arguments_json) as Record<string, unknown>, { startLine: 2, endLine: 2 }, "the event names the request it answered")
    assert.equal(events[2].outcome, "retained", "and the state the service returned")
    assert.ok(events.every((event) => event.execution_id === null), "a retrieval runs nothing, so no execution identity is invented for it")
    const content = withSqlite(project.databasePath, (database) => database.prepare("SELECT arguments_json FROM evidence_access_events WHERE project_id = ? LIMIT 1").get(project.projectId)) as { arguments_json: string }
    assert.ok(!content.arguments_json.includes("needle line"), "the event copies no bytes")
  })
})

test("every state §4.3 names is reachable by a real request", async () => {
  await withProject("stage2-every-state-", async (project) => {
    const reached = new Set<string>()
    const text = `${"line one\n".repeat(1_000)}needle line\n`
    const outcome = await project.store.record(capturedOf("state-reader", [{ stream: "payload", bytes: Buffer.from(text, "utf8") }], { toolName: "grep" }), { projectId: project.projectId })
    reached.add((await project.access.range(outcome.observationId, { startLine: 1, endLine: 1 })).state)
    const long = await project.access.range(outcome.observationId, {})
    reached.add(long.state)
    assert.ok(long.continuation !== undefined && long.continuation.cursor !== undefined, "a bounded page can be continued")
    const missing = await project.store.record(capturedOf("state-missing", [{ stream: "stdout", bytes: Buffer.from("x".repeat(50), "utf8") }]), { projectId: project.projectId })
    reached.add((await project.access.range(missing.observationId, { startByte: 40, endByte: 60 })).state)
    const unknown = await new ProjectEvidenceStore(new SqliteFile(project.databasePath), createPolicySource(project.root), project.root, { forceStorageKind: "file" }).record(capturedOf("state-unknown", [{ stream: "stderr", bytes: Buffer.from([0xff, 0xfe]) }]), { projectId: project.projectId })
    const row = withSqlite(project.databasePath, (database) => database.prepare("SELECT relative_path FROM evidence_blobs WHERE id = ?").get(unknown.streams[0].blobId!)) as { relative_path: string | null }
    fs.writeFileSync(path.join(project.root, ".twinny", "blobs", row.relative_path ?? ""), "not what the row claims")
    reached.add((await project.access.range(unknown.observationId, { stream: "stderr" })).state)
    fs.writeFileSync(path.join(project.root, ".twinny", "config.json"), JSON.stringify({ evidence: { storage: { maxProjectBytes: 60, maxBlobBytes: 10_000 } } }))
    const small = await project.store.record(capturedOf("state-evicted", [{ stream: "stdout", bytes: Buffer.from("y".repeat(50), "utf8") }]), { projectId: project.projectId })
    await project.store.record(capturedOf("state-room", [{ stream: "stderr", bytes: Buffer.from("z".repeat(20), "utf8") }]), { projectId: project.projectId })
    reached.add((await project.access.range(small.observationId, { stream: "stdout" })).state)
    const empty = await project.store.record(capturedOf("state-empty", [], { toolName: "grep", status: "exited" }), { projectId: project.projectId })
    reached.add((await project.access.range(empty.observationId, {})).state)
    assert.deepEqual([...reached].sort(), ["evicted", "missing_tail", "not_retrievable", "partial_prefix", "retained", "unknown_content"], "each state is reached by a test, not asserted")
  })
})

test("binary stderr queried by byte offsets and invalid UTF-8 in a returned range stay honest about what they are", async () => {
  await withProject("stage2-binary-", async (project) => {
    const raw = Buffer.from([0xff, 0xfe, 0x00, 0x41, 0x0a, 0xc3, 0x28])
    const outcome = await project.store.record(capturedOf("binary-run", [{ stream: "stderr", bytes: raw }]), { projectId: project.projectId })
    const byBytes = await project.access.range(outcome.observationId, { stream: "stderr", startByte: 0, endByte: raw.length })
    assert.equal(byBytes.state, "retained")
    assert.equal(byBytes.encoding, "bytes", "invalid UTF-8 is not presented as decodable text")
    assert.ok((byBytes.reason ?? "").includes("decoding of these bytes"), byBytes.reason)
    assert.equal(Buffer.from(byBytes.text ?? "", "utf8").equals(raw), false, "what is returned is a decoding, and the byte offsets are the truth")
    assert.deepEqual(byBytes.coverage, { fromByte: 0, toByte: raw.length })
    const byChars = await project.access.range(outcome.observationId, { stream: "stderr", startLine: 1, startChar: 1, endChar: 4 })
    assert.equal(byChars.state, "not_retrievable")
    assert.ok((byChars.reason ?? "").includes("cannot be mapped back to stored bytes"), byChars.reason)
    const literal = await project.access.search(outcome.observationId, { query: "A", stream: "stderr" })
    assert.equal(literal.state, "retained")
    assert.equal(literal.matchCount, 1)
    assert.equal(literal.matches[0].byte, 3, "a raw-byte search reports the offset in stored bytes")
  })
})

test("a policy that forbids exposing a raw secret reports the count while withholding the text", async () => {
  await withProject("stage2-secret-line-", async (project) => {
    const line = "apiKey: \"sk-ant-abcdefghijklmnopqrstuvwx\","
    const outcome = await project.store.record(capturedOf("secret-line", [{ stream: "payload", bytes: Buffer.from(`${line}\nsecond line\n`, "utf8") }], { toolName: "grep" }), { projectId: project.projectId })
    assert.equal(outcome.streams[0].redaction, "none", "the bytes were retained whole under the policy in force at the write")
    fs.writeFileSync(path.join(project.root, ".twinny", "config.json"), JSON.stringify({ evidence: { storage: { redactionMode: "exclude_raw_secrets" } } }))
    const page = await project.access.search(outcome.observationId, { query: "apikey" })
    assert.equal(page.matchCount, 1, "the bounded count the scan measured is still reported")
    assert.equal(page.matches[0].withheld, true)
    assert.equal(page.matches[0].preview, "", "and no raw secret reaches the model through a preview")
    const range = await project.access.range(outcome.observationId, { startLine: 1, endLine: 1 })
    assert.equal(range.state, "not_retrievable")
    assert.equal(range.text, undefined)
    assert.ok((range.reason ?? "").includes("withholds"), range.reason)
  })
})

test("a query against an observation for a failed tool reports the state that is true for it", async () => {
  await withProject("stage2-failed-tool-", async (project) => {
    const call: ToolCall = { name: "read_file", args: { path: "src/a.ts" } }
    const observation = await recordToolResult({ repository: project.repository, scope: project.scope }, call, { output: "could not be read", summary: "read", failed: true }, { invocationId: "failed-tool" })
    assert.equal(observation.failed, true)
    const looked = await project.access.get(observation.id)
    assert.equal(looked.access, "found")
    assert.equal(looked.failed, true, "the record still says the call went wrong")
    // A failed call whose bytes were kept stays readable; one with nothing retained says so instead of answering.
    const nothing = await project.store.record(capturedOf("failed-nothing", [], { toolName: "read_file", args: { path: "src/a.ts" }, executed: true, status: "exited", exitCode: 2, terminationReason: "exit", captureMode: "not_applicable" }), { projectId: project.projectId, display: { output: "could not be read", arguments: { path: "src/a.ts" }, failed: true } })
    const page = await project.access.search(nothing.observationId, { query: "read" })
    assert.equal(page.state, "not_retrievable")
    assert.equal(page.matchCount, 0)
    assert.ok((page.reason ?? "").includes("no match count can be claimed"), page.reason)
    const span = await project.access.range(nothing.observationId, {})
    assert.equal(span.state, "not_retrievable")
    assert.equal(span.text, undefined)
    assert.equal((await project.access.get(nothing.observationId)).completeness?.captured, "not_captured", "no bytes arrived, so nothing is claimed as retained")
  })
})

test("two observations sharing one content blob are each retrievable by their own UUID", async () => {
  await withProject("stage2-shared-blob-", async (project) => {
    const text = "same content in two places\n"
    const first = await project.store.record(capturedOf("share-a", [{ stream: "payload", bytes: Buffer.from(text, "utf8") }], { toolName: "read_file", args: { path: "src/a.ts" } }), { projectId: project.projectId })
    const second = await project.store.record(capturedOf("share-b", [{ stream: "payload", bytes: Buffer.from(text, "utf8") }], { toolName: "read_file", args: { path: "src/b.ts" } }), { projectId: project.projectId })
    assert.equal(first.streams[0].blobId, second.streams[0].blobId)
    const fromFirst = await project.access.range(first.observationId, {})
    const fromSecond = await project.access.range(second.observationId, {})
    assert.equal(fromFirst.text, text)
    assert.equal(fromSecond.text, text)
    assert.equal(fromFirst.observationId, first.observationId)
    assert.notEqual(fromFirst.observationId, fromSecond.observationId)
    assert.equal(countOf(project.databasePath, "SELECT COUNT(*) AS n FROM evidence_blobs WHERE project_id = ?", project.projectId), 1, "sharing bytes does not merge receipt history")
    assert.deepEqual([countOf(project.databasePath, "SELECT COUNT(*) AS n FROM evidence_chunks WHERE outcome_id = ?", first.outcomeId), countOf(project.databasePath, "SELECT COUNT(*) AS n FROM evidence_chunks WHERE outcome_id = ?", second.outcomeId)], [1, 1])
  })
})

test("a bounded filter stays discoverable and its page is deterministic", async () => {
  await withProject("stage2-filter-", async (project) => {
    for (let index = 0; index < 6; index += 1) {
      await project.store.record(capturedOf(`filter-${index}`, [{ stream: "payload", bytes: Buffer.from(`row ${index}\n`, "utf8") }], { toolName: "grep", args: { pattern: "needle" } }), { projectId: project.projectId })
    }
    const page = await project.access.find({ toolName: "grep", limit: 3 })
    assert.equal(page.length, 3)
    assert.ok(page[page.length - 1].cursor !== undefined, "the last item of a full page says where the next one starts")
    const next = await project.access.find({ toolName: "grep", limit: 3, cursor: page[page.length - 1].cursor })
    assert.equal(next.length, 3)
    assert.deepEqual(next.map((match) => match.observationId), (await project.access.find({ toolName: "grep", limit: 3, cursor: page[page.length - 1].cursor })).map((match) => match.observationId), "the same cursor returns the same page")
    const overlap = new Set(page.map((match) => match.observationId))
    assert.equal(next.filter((match) => overlap.has(match.observationId)).length, 0, "pages do not repeat")
    const bounded = await project.access.find({ toolName: "grep", limit: 1_000 })
    assert.ok(bounded.length <= 100, "the filter bound is enforced rather than trusted")
    const byStatus = await project.access.find({ status: "exited" })
    assert.equal(byStatus.length, 6)
    assert.ok(byStatus.every((match) => match.state === "retained"))
    assert.ok(byStatus.every((match) => match.completeness !== undefined && match.completeness.stored === "complete"))
  })
})

test("the service never reads current source to answer a query, and labels stale content as historical", async () => {
  await withProject("stage2-historical-", async (project) => {
    fs.writeFileSync(path.join(project.root, "src", "a.ts"), "the text as it was read\n")
    const tools = workspaceTools(project.root)
    const call: ToolCall = { name: "read_file", args: { path: "src/a.ts" } }
    const result = await tools.run(call)
    const observation = await recordToolResult({ repository: project.repository, scope: project.scope }, call, result, { invocationId: "historical-read" })
    const observedHash = (await project.repository.projectObservations(project.scope))[0].sources[0]?.contentHash
    assert.ok(observedHash !== undefined)
    fs.writeFileSync(path.join(project.root, "src", "a.ts"), "the text as it is now\n")
    const span = await project.access.range(observation.id, { startLine: 3, endLine: 3 })
    assert.equal(span.text, storedLines(result.rawOutput!)[2], "stored content, not current source")
    assert.ok((span.text ?? "").startsWith("1: "), "the number in the stored output is the file line it came from")
    assert.equal(span.historical, true, "labelled historical, never presented as current source")
    assert.equal(span.originalHash, observedHash)
    const changedHash = await fingerprintContent(fs.readFileSync(path.join(project.root, "src", "a.ts"), "utf8"), "xxh64")
    assert.ok(!JSON.stringify(span).includes(changedHash), "no replacement fingerprint travels with a stale result")
    const looked = await project.access.get(observation.id)
    assert.equal(looked.historical, true)
  })
})