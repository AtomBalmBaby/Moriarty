/**
 * Stage 1's byte store, tested on the paths the chat actually uses: a scratch project under /tmp, the
 * real repository, the real connection, the real tool dispatch. Every number here is measured by the
 * test, not quoted from the plan. Real command-stream capture belongs to Stage 10; these cases prove
 * that the storage layer keeps independent streams apart and reports coverage as it measured it.
 */
import BetterSqlite from "better-sqlite3"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { isRecordableToolResult, recordToolResult, toolObservationInput } from "../../extension/chat/tool-evidence"
import { createPolicySource, describeEffectivePolicy, readEvidenceStoragePolicy } from "../../extension/todos/evidence-config"
import { type CapturedResult, type EvidenceStream, MAX_INDEXED_LINES, ProjectEvidenceStore, type StoredOutcome, storedOutcomeForObservation } from "../../extension/todos/evidence-store"
import { DEFAULT_EVIDENCE_STORAGE_LIMITS, TodoRepository, workspaceProjectFingerprint } from "../../extension/todos/repository"
import { prepareProjectTodoStorage, resolveProjectTodoStorage, SqliteFile } from "../../extension/todos/sqlite"
import type { ToolErrorDetail } from "../../extension/tools/arguments"
import { fitResult } from "../../extension/tools/budget"
import { ToolCall } from "../../extension/tools/protocol"
import { CommandSink, workspaceTools } from "../../extension/tools/workspace"

interface ScratchProject {
  directory: string
  root: string
  databasePath: string
  projectId: string
  repository: TodoRepository
  store: ProjectEvidenceStore
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

const outcomeFor = (file: string, projectId: string, observationId: string): StoredOutcome | undefined =>
  withSqlite(file, (database) => storedOutcomeForObservation(database, projectId, observationId))

const streamOf = (outcome: StoredOutcome, name: EvidenceStream) => outcome.streams.find((state) => state.stream === name)

const countOf = (file: string, sql: string, value: unknown): number =>
  (withSqlite(file, (database) => database.prepare(sql).get(...(sql.includes("?") ? [value] : []))) as { n: number }).n

const storedBytesOf = (file: string, blobId: string): Buffer =>
  (withSqlite(file, (database) => database.prepare("SELECT inline_bytes FROM evidence_blobs WHERE id = ?").get(blobId)) as { inline_bytes: Buffer }).inline_bytes

/** A capture as the host would build one for bytes that arrived on separate streams. */
const capturedOf = (invocationId: string, entries: { stream: EvidenceStream; bytes: Buffer }[], extra: Partial<CapturedResult> = {}): CapturedResult => {
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
    chunks: entries.map((entry, index) => ({ stream: entry.stream, seq: index, bytes: entry.bytes, receivedAt: arrivedAt })),
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
  const repository = new TodoRepository(databasePath, DEFAULT_EVIDENCE_STORAGE_LIMITS, () => [root])
  const scope = { projectFingerprint: workspaceProjectFingerprint([`file://${root}`]), conversationId: conversation, writer: conversation }
  try {
    await repository.initialize()
    // The project row exists once the repository has read its list; that is the production path.
    await repository.getList(scope)
    await run({
      directory, root, databasePath, projectId: projectOf(databasePath), repository, store: new ProjectEvidenceStore(new SqliteFile(databasePath), createPolicySource(root), root), scope
    })
  } finally {
    repository.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
}


test("a complete tool result is stored before display fitting and the delivered copy is smaller than the stored bytes", async () => {
  await withProject("stage1-fits-after-storing-", async (project) => {
    const text = new Array(2_000).fill("const line = 1").join("\n")
    fs.writeFileSync(path.join(project.root, "src", "big.ts"), text)
    const tools = workspaceTools(project.root)
    // A whole-file read over 2,000 lines is refused at the documented default limit, so this asks for a range the tool delivers complete.
    const call: ToolCall = { name: "read_file", args: { path: "src/big.ts", start_line: 1, end_line: 400 } }
    const result = await tools.run(call)
    assert.ok(result.rawOutput !== undefined, "the tool hands the host its raw output before fitting")
    assert.equal(result.integrity?.status, "complete", "the tool delivered what it was asked for whole")
    const delivered = fitResult(result.output, 4_000)
    assert.ok(delivered.length < (result.rawOutput ?? "").length, "what the model is given is smaller than what was produced")
    const observation = await recordToolResult({ repository: project.repository, scope: project.scope }, call, { ...result, output: delivered }, { invocationId: "fit-after-store" })
    const outcome = outcomeFor(project.databasePath, project.projectId, observation.id)
    assert.ok(outcome !== undefined, "the invocation has an outcome recorded before fitting")
    const payload = streamOf(outcome!, "payload")
    assert.ok(payload !== undefined)
    assert.equal(payload!.storedBytes, Buffer.byteLength(result.rawOutput ?? "", "utf8"), "the store kept every byte it received")
    assert.ok(payload!.storedBytes > delivered.length, "storage is not the display copy")
    assert.equal(payload!.storageComplete, "complete")
    assert.equal(delivered.length < payload!.storedBytes, true)
  })
})

test("a failed call records its typed arguments, status, timing and structured error, and nothing claims it executed", async () => {
  await withProject("stage1-refused-attempt-", async (project) => {
    const call: ToolCall = { name: "edit_lines", args: { path: "src/a.ts", expected_hash: "xxh64:0000000000000000" } }
    const refused: ToolErrorDetail = { code: "stale_hash", message: "the file is not the version the call named", executed: false, current_hash: "xxh64:1111111111111111" }
    const result = { output: "the call was refused before anything ran", summary: "refused", failed: true, error: refused }
    assert.equal(isRecordableToolResult(call, result), true, "an attempt is recordable even though nothing executed")
    const input = toolObservationInput({ repository: project.repository, scope: project.scope }, call, result, "refused-edit")
    assert.equal(input.executed, false)
    assert.ok(input.capture !== undefined && input.capture.executed === false, "the capture carries the structured error")
    const observation = await project.repository.recordToolObservation(project.scope, input)
    const outcome = observation.outcome
    assert.ok(outcome !== undefined)
    assert.equal(outcome!.executed, false)
    assert.equal(outcome!.status, "refused")
    assert.equal(outcome!.exitCode, undefined, "a call that never ran earns no exit code")
    assert.equal(outcome!.state, "recorded")
    const storedArguments = (withSqlite(project.databasePath, (database) => database.prepare("SELECT arguments_json FROM todo_tool_observations WHERE id = ?").get(observation.id)) as { arguments_json: string }).arguments_json
    const capture = input.capture!
    assert.deepEqual(capture.args, call.args, "the store keeps the typed arguments as they were sent")
    // The row is the presentation copy Feedback and lookup already read; it disagrees with the capture in the documented way.
    assert.deepEqual(JSON.parse(storedArguments) as Record<string, unknown>, { path: "src/a.ts" }, "the presentation copy stays what existing consumers read")
    const errorRow = (withSqlite(project.databasePath, (database) => database.prepare("SELECT error_code FROM todo_tool_observations WHERE id = ?").get(observation.id)) as { error_code: string | null }).error_code
    assert.equal(errorRow, "refused_before_execution")
    const row = (withSqlite(project.databasePath, (database) => database.prepare("SELECT executed, started_at, finished_at FROM todo_tool_observations WHERE id = ?").get(observation.id)) as { executed: number; started_at: string | null; finished_at: string | null })
    assert.deepEqual({ executed: row.executed, started_at: row.started_at, finished_at: row.finished_at }, { executed: 0, started_at: capture.startedAt, finished_at: capture.finishedAt ?? null }, "the timing is the tool's own and nothing claims it executed")
  })
})

test("a refused command records an attempt with executed false and no exit code", async () => {
  await withProject("stage1-refused-command-", async (project) => {
    const call: ToolCall = { name: "run_command", args: { command: "rm -rf src" } }
    const refused: ToolErrorDetail = { code: "permission_denied", message: "the command was not approved", executed: false }
    const outcome = await project.store.record(capturedOf("command-refused", [], { toolName: "run_command", args: call.args, executed: false, status: "unknown", error: refused, exitCode: undefined, terminationReason: undefined }), { projectId: project.projectId })
    assert.equal(outcome.executed, false)
    assert.equal(outcome.status, "refused")
    assert.equal(outcome.exitCode, undefined, "no exit code is invented for a process that never started")
    const decliningSink: CommandSink = { mode: "ask", run: async () => ({ ran: false, output: "" }) }
    const declining = workspaceTools(project.root, [], { commands: decliningSink })
    const skipped = await declining.run(call)
    assert.equal(skipped.execution, undefined, "a skipped approval ran nothing")
    assert.equal(isRecordableToolResult(call, skipped), false, "a command that ran nothing is still not an observation")
    assert.equal(countOf(project.databasePath, "SELECT COUNT(*) AS n FROM todo_tool_observations WHERE project_id = ?", project.projectId), 1, "the attempt is one record and the skipped approval adds none of its own")
  })
})

test("synthetic independent stdout and stderr streams round-trip separately in BLOB storage", async () => {
  await withProject("stage1-separate-streams-", async (project) => {
    const stdout = Buffer.from("printed on fd 1\nwith a trailing newline\n", "utf8")
    const stderr = Buffer.from("warning on fd 2\n", "utf8")
    const outcome = await project.store.record(capturedOf("two-streams", [{ stream: "stdout", bytes: stdout }, { stream: "stderr", bytes: stderr }]), { projectId: project.projectId })
    const out = streamOf(outcome, "stdout")
    const err = streamOf(outcome, "stderr")
    assert.ok(out !== undefined && err !== undefined)
    assert.notEqual(out!.blobId, err!.blobId, "the two streams are not one blob")
    assert.equal(storedBytesOf(project.databasePath, out!.blobId!).toString("utf8"), stdout.toString("utf8"))
    assert.equal(storedBytesOf(project.databasePath, err!.blobId!).toString("utf8"), stderr.toString("utf8"))
    assert.deepEqual(out!.coverage, [{ fromByte: 0, toByte: stdout.length }])
    assert.deepEqual(err!.coverage, [{ fromByte: 0, toByte: stderr.length }])
    assert.equal(out!.chunks + err!.chunks, 2, "the order each stream arrived in is kept per stream")
  })
})

test("a synthetic merged terminal stream remains one truthfully named stream", async () => {
  await withProject("stage1-merged-terminal-", async (project) => {
    const merged = Buffer.from("both sides in one transcript\n", "utf8")
    const outcome = await project.store.record(capturedOf("pty-run", [{ stream: "terminal", bytes: merged }], { captureMode: "pty" }), { projectId: project.projectId })
    assert.equal(outcome.captureMode, "pty")
    assert.equal(outcome.streams.length, 1, "one captured stream, not three")
    assert.equal(outcome.streams[0].stream, "terminal")
    assert.equal(streamOf(outcome, "stderr"), undefined, "no stderr is invented for a transcript that cannot separate one")
  })
})

test("invalid UTF-8 and binary bytes round-trip losslessly, or are recorded as excluded by policy", async () => {
  await withProject("stage1-binary-bytes-", async (project) => {
    const raw = Buffer.from([0xff, 0xfe, 0x00, 0x41, 0x0a, 0xc3, 0x28])
    const outcome = await project.store.record(capturedOf("binary", [{ stream: "stdout", bytes: raw }]), { projectId: project.projectId })
    const stream = outcome.streams[0]
    assert.equal(stream.storageComplete, "complete")
    assert.equal(stream.bytePreservation, "lossless")
    assert.equal(stream.encoding, "bytes", "invalid UTF-8 is not presented as decodable text")
    assert.equal(storedBytesOf(project.databasePath, stream.blobId!).equals(raw), true, "the bytes come back exactly as they arrived")

    const secret = Buffer.from("apiKey: \"sk-ant-abcdefghijklmnopqrstuvwx\",", "utf8")
    const config = path.join(project.root, ".twinny", "config.json")
    fs.writeFileSync(config, JSON.stringify({ evidence: { storage: { redactionMode: "exclude_raw_secrets" } } }))
    const excluded = await project.store.record(capturedOf("secret-excluded", [{ stream: "stdout", bytes: secret }]), { projectId: project.projectId })
    const excludedStream = excluded.streams[0]
    assert.equal(excludedStream.redaction, "excluded_by_policy")
    assert.equal(excludedStream.bytePreservation, "excluded")
    assert.equal(excludedStream.blobId, undefined, "nothing is retained, so no ID exists for it")
    assert.equal(excludedStream.storageComplete, "inaccessible")
    assert.deepEqual(excludedStream.coverage, [])
    assert.equal(excludedStream.gapReason, "redaction")
  })
})

test("a result larger than maxBlobBytes is recorded incomplete with the exact coverage gap and no phantom blob ID", async () => {
  await withProject("stage1-blob-cap-", async (project) => {
    fs.writeFileSync(path.join(project.root, ".twinny", "config.json"), JSON.stringify({ evidence: { storage: { maxBlobBytes: 1_000 } } }))
    const big = Buffer.from("x".repeat(2_400), "utf8")
    const outcome = await project.store.record(capturedOf("over-blob-cap", [{ stream: "stdout", bytes: big }]), { projectId: project.projectId })
    const stream = outcome.streams[0]
    assert.equal(stream.blobId, undefined)
    assert.equal(stream.contentDigest, undefined, "no digest is claimed for bytes the store does not hold")
    assert.equal(stream.originalBytes, 2_400)
    assert.equal(stream.capturedBytes, 2_400)
    assert.equal(stream.storedBytes, 0)
    assert.equal(stream.storageComplete, "inaccessible")
    assert.equal(stream.gapReason, "storage_limit")
    assert.deepEqual(stream.coverage, [])
    assert.equal(outcome.capturedComplete, "complete", "the bytes were received; they were not retained")
    assert.equal(countOf(project.databasePath, "SELECT COUNT(*) AS n FROM evidence_blobs WHERE project_id = ?", project.projectId), 0)
  })
})

test("project storage exhaustion is visible: a capped write reports partial, and evicted only on an actual eviction", async () => {
  await withProject("stage1-project-cap-", async (project) => {
    const config = path.join(project.root, ".twinny", "config.json")
    fs.writeFileSync(config, JSON.stringify({ evidence: { storage: { maxProjectBytes: 400, maxBlobBytes: 10_000 } } }))
    const first = Buffer.from("a".repeat(600), "utf8")
    const capped = await project.store.record(capturedOf("capped-write", [{ stream: "stdout", bytes: first }]), { projectId: project.projectId })
    const cappedStream = capped.streams[0]
    assert.equal(cappedStream.storageComplete, "partial")
    assert.equal(cappedStream.gapReason, "storage_limit")
    assert.equal(cappedStream.storedBytes, 400, "what the cap allowed is what is reported")
    assert.deepEqual(cappedStream.coverage, [{ fromByte: 0, toByte: 400 }])
    const beforeEviction = outcomeFor(project.databasePath, project.projectId, capped.observationId)
    assert.equal(beforeEviction!.streams[0].storageComplete, "partial", "nothing has been evicted yet")
    fs.writeFileSync(config, JSON.stringify({ evidence: { storage: { maxProjectBytes: 500, maxBlobBytes: 10_000 } } }))
    const second = Buffer.from("b".repeat(200), "utf8")
    const secondRun = await project.store.record(capturedOf("needs-room", [{ stream: "stdout", bytes: second }]), { projectId: project.projectId })
    assert.equal(secondRun.streams[0].storageComplete, "complete", "the eviction made room for it")
    const evicted = outcomeFor(project.databasePath, project.projectId, capped.observationId)
    assert.equal(evicted!.streams[0].storageComplete, "evicted")
    assert.equal(evicted!.streams[0].gapReason, "eviction")
    assert.ok(evicted!.streams[0].blobId !== undefined)
    const evictedAt = (withSqlite(project.databasePath, (database) => database.prepare("SELECT evicted_at FROM evidence_blobs WHERE id = ?").get(evicted!.streams[0].blobId!)) as { evicted_at: string | null }).evicted_at
    assert.ok(evictedAt !== null, "the eviction state names the moment it happened")
    assert.equal(countOf(project.databasePath, "SELECT COUNT(*) AS n FROM evidence_blobs WHERE project_id = ? AND evicted_at IS NULL", project.projectId), 1)
  })
})

test("project config.json defaults, overrides, reload, invalid JSON, invalid values and unrelated keys are reported on scratch projects", async () => {
  await withProject("stage1-config-", async (project) => {
    const config = path.join(project.root, ".twinny", "config.json")
    const defaults = await readEvidenceStoragePolicy(project.root)
    assert.equal(defaults.state, "effective")
    if (defaults.state === "effective") {
      assert.equal(defaults.reading.source, "defaults")
      assert.deepEqual(defaults.reading.policy, { maxProjectBytes: 64_000_000, maxBlobBytes: 2_000_000, evictionOrder: "oldest_unfavourited_first", redactionMode: "presentation_only", enabled: true })
    }
    fs.writeFileSync(config, JSON.stringify({ evidence: { storage: { maxProjectBytes: 4_096, maxBlobBytes: 512 } }, unrelated: { keep: true } }))
    const source = createPolicySource(project.root)
    const override = await source.effective()
    assert.equal(override.state, "effective")
    if (override.state === "effective") {
      assert.equal(override.reading.policy.maxProjectBytes, 4_096)
      assert.equal(override.reading.policy.maxBlobBytes, 512)
      assert.deepEqual(override.reading.otherKeys, ["unrelated"], "the reader reports what it does not use")
    }
    fs.writeFileSync(config, "{ evidence: { storage: {} }")
    const corrupt = await source.effective()
    assert.equal(corrupt.state, "invalid")
    if (corrupt.state === "invalid") assert.ok(/is not JSON/.test(corrupt.reason), corrupt.reason)
    fs.writeFileSync(config, JSON.stringify({ evidence: { storage: { maxBlobBytes: "2000000" } } }))
    const mistyped = await source.effective()
    assert.equal(mistyped.state, "invalid")
    if (mistyped.state === "invalid") assert.ok(/must be a whole nonnegative number of bytes/.test(mistyped.reason), mistyped.reason)
    fs.writeFileSync(config, JSON.stringify({ evidence: { storage: { maxProjectBytes: -1 } }, other: 1 }))
    const negative = await source.effective()
    assert.equal(negative.state, "invalid")
    if (negative.state === "invalid") assert.ok(/nonnegative/.test(negative.reason), negative.reason)
    fs.writeFileSync(config, JSON.stringify({ evidence: { storage: { evictionOrder: "newest_first" } } }))
    const badOrder = await source.effective()
    assert.equal(badOrder.state, "invalid")
    if (badOrder.state === "invalid") assert.ok(/evictionOrder/.test(badOrder.reason), badOrder.reason)
    assert.equal(describeEffectivePolicy(negative).includes("the file was left as it is"), true, "the report says what was not done")
    fs.writeFileSync(config, JSON.stringify({ evidence: { storage: { maxProjectBytes: 9_000 } }, other: 1 }))
    const reloaded = await source.effective()
    assert.equal(reloaded.state, "effective", "a corrected file is read again without a restart")
    if (reloaded.state === "effective") assert.equal(reloaded.reading.policy.maxProjectBytes, 9_000)
    assert.equal(fs.readFileSync(config, "utf8").includes("\"other\""), true, "unrelated content is preserved, not rewritten")
    await project.store.record(capturedOf("mirror-write", [{ stream: "stdout", bytes: Buffer.from("bytes\n", "utf8") }]), { projectId: project.projectId })
    const mirror = withSqlite(project.databasePath, (database) => database.prepare("SELECT max_project_bytes, max_blob_bytes, eviction_order, redaction_mode, enabled FROM storage_policy WHERE project_id = ?").get(project.projectId)) as Record<string, unknown>
    assert.deepEqual(mirror, { max_project_bytes: 9_000, max_blob_bytes: 2_000_000, eviction_order: "oldest_unfavourited_first", redaction_mode: "presentation_only", enabled: 1 }, "the audit row mirrors the effective settings, as a snapshot not a setting")
    assert.equal(countOf(project.databasePath, "SELECT COUNT(*) AS n FROM todo_projects", null), 1, "reading the policy did not touch the project database")
  })
})

test("a crash between a streamed chunk and the final status leaves a recoverable pending record that a reopen reconciles to lost or unknown, never to success", async () => {
  await withProject("stage1-crash-pending-", async (project) => {
    const arrived = Buffer.from("half of what it printed before the crash\n", "utf8")
    const pending = await project.store.beginPending(capturedOf("crashed-run", [{ stream: "stdout", bytes: arrived }], { status: "running", finishedAt: undefined, terminationReason: undefined }), { projectId: project.projectId })
    assert.equal(pending.state, "pending")
    assert.equal(pending.pending, true)
    const before = await project.store.pending("crashed-run", { projectId: project.projectId })
    assert.equal(before!.outcomeId, pending.outcomeId)
    assert.equal(before!.status, "running", "the record still says what it knew at the crash")
    const report = await project.store.reconcile()
    assert.equal(report.settled.length, 1)
    assert.equal(report.settled[0].settledTo, "lost", "bytes had arrived, so something ran and its end is unknown")
    const settled = await project.store.pending("crashed-run", { projectId: project.projectId })
    assert.equal(settled!.status, "lost")
    const neverConfirmed = await project.store.beginPending(capturedOf("never-confirmed", [], { status: "accepted", finishedAt: undefined, terminationReason: undefined }), { projectId: project.projectId })
    const second = await project.store.reconcile()
    assert.equal(second.settled.length, 1)
    assert.equal(second.settled[0].settledTo, "unknown")
    assert.equal((await project.store.pending("never-confirmed", { projectId: project.projectId }))!.status, "unknown")
    assert.equal(settled!.status !== "completed" && settled!.status !== "exited", true)
    void neverConfirmed
  })
})

test("replay of the same request id returns the prior observation with its outcome, with no second row and no rerun", async () => {
  await withProject("stage1-replay-", async (project) => {
    const runs = { count: 0 }
    const countingSink: CommandSink = { mode: "allow", run: async () => { runs.count += 1; return { ran: true, output: "once", exitCode: 0 } } }
    const tools = workspaceTools(project.root, [], { commands: countingSink })
    const call: ToolCall = { name: "run_command", args: { command: "node --version" } }
    const first = await tools.run(call)
    const stored = await project.repository.recordToolObservation(project.scope, { toolName: call.name, arguments: Object.fromEntries(Object.entries(call.args).map(([key, value]) => [key, String(value)])), output: first.output, evidenceOutput: first.execution?.output, failed: false, exitCode: first.execution?.exitCode, requestId: "replay-me", executionId: "execution-1" })
    const again = await project.repository.recordToolObservation(project.scope, { toolName: call.name, arguments: Object.fromEntries(Object.entries(call.args).map(([key, value]) => [key, String(value)])), output: first.output, evidenceOutput: first.execution?.output, failed: false, exitCode: first.execution?.exitCode, requestId: "replay-me" })
    assert.ok(again.outcome !== undefined && stored.outcome !== undefined)
    assert.equal(again.outcome!.outcomeId, stored.outcome!.outcomeId)
    assert.deepEqual({
      observations: countOf(project.databasePath, "SELECT COUNT(*) AS n FROM todo_tool_observations WHERE project_id = ?", project.projectId),
      outcomes: countOf(project.databasePath, "SELECT COUNT(*) AS n FROM evidence_outcomes WHERE project_id = ?", project.projectId)
    }, { observations: 1, outcomes: 1 }, "no second row")
  })
})

test("observations, outcomes, blobs, chunks, lines and dependencies survive deletion of a task, a list and a conversation", async () => {
  await withProject("stage1-survives-deletion-", async (project) => {
    fs.writeFileSync(path.join(project.root, "src", "parser.ts"), "export function parse() {}\n")
    const plan = {
      planId: "plan-survival", version: 1 as const, revision: 1, goal: "Keep the record", constraints: [],
      tasks: [{ id: "inspect", title: "Inspect parser", description: "Read parser source", criteria: [{ id: "read", description: "Parser source was read", verification: { kind: "semantic_review" as const } }], dependencies: [] }]
    }
    const [item] = (await project.repository.synchronizeIntentPlan(project.scope, plan, { objective: plan.goal, prompt: "Read the parser", plan })).items
    const stored = await project.repository.recordToolObservation(project.scope, { itemId: item.id, toolName: "read_file", arguments: { path: "src/parser.ts" }, output: "read it", evidenceOutput: "export function parse() {}\n", failed: false, requestId: "survival-record", sources: [{ path: "src/parser.ts", role: "read", observedVersion: "disk" }] })
    const derived = await project.repository.recordToolObservation(project.scope, { toolName: "grep", arguments: { pattern: "parse" }, output: "one hit", evidenceOutput: "{\"results\":[{\"path\":\"src/parser.ts\",\"line\":1,\"preview\":\"export function parse\"}]}", failed: false, requestId: "survival-derived", sources: [{ path: "src/parser.ts", role: "read", observedVersion: "disk" }] })
    withSqlite(project.databasePath, (database) => {
      database.prepare("PRAGMA foreign_keys = ON").run()
      const list = database.prepare("SELECT id FROM todo_lists WHERE conversation_id = ?").get(project.scope.conversationId) as { id: string }
      database.prepare("INSERT INTO evidence_dependencies(derived_observation_id, source_observation_id, kind, established_at) VALUES (?, ?, 'accepted_fact', ?)").run(derived.id, stored.id, new Date().toISOString())
      database.prepare("DELETE FROM todo_items WHERE id = ?").run(item.id)
      database.prepare("DELETE FROM todo_lists WHERE id = ?").run(list.id)
    })
    const outcome = stored.outcome!
    assert.deepEqual({
      observation: countOf(project.databasePath, "SELECT COUNT(*) AS n FROM todo_tool_observations WHERE id = ?", stored.id),
      outcome: countOf(project.databasePath, "SELECT COUNT(*) AS n FROM evidence_outcomes WHERE observation_id = ?", outcome.observationId),
      blob: countOf(project.databasePath, "SELECT COUNT(*) AS n FROM evidence_blobs WHERE id = ?", outcome.streams[0].blobId!),
      chunk: countOf(project.databasePath, "SELECT COUNT(*) AS n FROM evidence_chunks WHERE outcome_id = ?", outcome.outcomeId),
      line: countOf(project.databasePath, "SELECT COUNT(*) AS n FROM evidence_lines WHERE blob_id = ?", outcome.streams[0].blobId!),
      dependency: countOf(project.databasePath, "SELECT COUNT(*) AS n FROM evidence_dependencies WHERE derived_observation_id = ?", derived.id)
    }, { observation: 1, outcome: 1, blob: 1, chunk: 1, line: 1, dependency: 1 }, "the record outlives the task, the list and the conversation that made it")
    assert.equal(stored.itemId, item.id, "its task is kept as provenance, not as an owner")
  })
})

test("a huge single line is stored whole with its line index bounded", async () => {
  await withProject("stage1-huge-line-", async (project) => {
    const line = "z".repeat(20_000)
    const outcome = await project.store.record(capturedOf("huge-line", [{ stream: "stdout", bytes: Buffer.from(`${line}\n`, "utf8") }]), { projectId: project.projectId })
    assert.equal(outcome.streams[0].storedBytes, line.length + 1, "the whole line is stored, not a fragment of it")
    assert.equal(outcome.lineIndex.lines, 1, "the stored content is one line; a terminal newline is not an extra line")
    assert.equal(outcome.lineIndex.bounded, false, "two lines do not reach the bound")
    const many = Buffer.from(new Array(MAX_INDEXED_LINES + 5).fill("x").join("\n"), "utf8")
    const bounded = await project.store.record(capturedOf("many-lines", [{ stream: "stdout", bytes: many }]), { projectId: project.projectId })
    assert.equal(bounded.lineIndex.bounded, true)
    assert.equal(bounded.lineIndex.lines, MAX_INDEXED_LINES, "the index reports its bound instead of pretending to cover everything")
    assert.equal(bounded.streams[0].storageComplete, "complete", "the bytes stay whole where the line index stops")
  })
})

test("two different files with the same content share one blob and keep two observations", async () => {
  await withProject("stage1-shared-blob-", async (project) => {
    const text = "same content in two places\n"
    const first = await project.store.record(capturedOf("read-a", [{ stream: "payload", bytes: Buffer.from(text, "utf8") }], { toolName: "read_file", args: { path: "src/a.ts" } }), { projectId: project.projectId })
    const second = await project.store.record(capturedOf("read-b", [{ stream: "payload", bytes: Buffer.from(text, "utf8") }], { toolName: "read_file", args: { path: "src/b.ts" } }), { projectId: project.projectId })
    assert.equal(first.streams[0].blobId, second.streams[0].blobId, "content-addressed storage shares the bytes")
    assert.notEqual(first.observationId, second.observationId, "the invocation history is not merged")
    const readByUuid = (observationId: string) => outcomeFor(project.databasePath, project.projectId, observationId)
    assert.equal(readByUuid(first.observationId)!.streams[0].chunks, 1)
    assert.equal(readByUuid(second.observationId)!.streams[0].chunks, 1)
    assert.deepEqual({ blobs: countOf(project.databasePath, "SELECT COUNT(*) AS n FROM evidence_blobs WHERE project_id = ?", project.projectId), outcomes: countOf(project.databasePath, "SELECT COUNT(*) AS n FROM evidence_outcomes WHERE project_id = ?", project.projectId) }, { blobs: 1, outcomes: 2 })
    assert.deepEqual([countOf(project.databasePath, "SELECT COUNT(*) AS n FROM evidence_chunks WHERE outcome_id = ?", first.outcomeId), countOf(project.databasePath, "SELECT COUNT(*) AS n FROM evidence_chunks WHERE outcome_id = ?", second.outcomeId)], [1, 1], "sharing the bytes does not merge each outcome's own receipt history")
  })
})

test("redaction that would change bytes is not presented as lossless", async () => {
  await withProject("stage1-redaction-view-", async (project) => {
    const original = Buffer.from("apiKey: \"sk-ant-abcdefghijklmnopqrstuvwx\",", "utf8")
    const view = Buffer.from("apiKey: \"[REDACTED]\",", "utf8")
    const claimedRedacted = await project.store.record(capturedOf("redacted-bytes", [{ stream: "payload", bytes: view }], { capture: { originalBytes: original.length, capturedBytes: view.length, storedBytes: view.length, redaction: "applied", encoding: "utf8" } }), { projectId: project.projectId })
    assert.equal(claimedRedacted.streams[0].bytePreservation, "normalized", "bytes that were changed cannot be reported as the bytes as produced")
    assert.equal(claimedRedacted.streams[0].redaction, "applied")
    const keptWhole = await project.store.record(capturedOf("raw-bytes", [{ stream: "payload", bytes: original }]), { projectId: project.projectId })
    assert.equal(keptWhole.streams[0].bytePreservation, "lossless")
    assert.equal(keptWhole.streams[0].redaction, "none", "the presentation copy is where redaction belongs")
  })
})

test("cross-project access is denied and a foreign UUID does not say which project it belongs to", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stage1-cross-project-"))
  const rootA = path.join(directory, "a")
  const rootB = path.join(directory, "b")
  for (const root of [rootA, rootB]) fs.mkdirSync(root, { recursive: true })
  const databaseA = await prepareProjectTodoStorage(resolveProjectTodoStorage([{ scheme: "file", fsPath: rootA }]))
  const databaseB = await prepareProjectTodoStorage(resolveProjectTodoStorage([{ scheme: "file", fsPath: rootB }]))
  const repositoryA = new TodoRepository(databaseA, DEFAULT_EVIDENCE_STORAGE_LIMITS, () => [rootA])
  const scopeA = { projectFingerprint: workspaceProjectFingerprint([`file://${rootA}`]), conversationId: "chat-a", writer: "chat-a" }
  const repositoryB = new TodoRepository(databaseB, DEFAULT_EVIDENCE_STORAGE_LIMITS, () => [rootB])
  const scopeB = { projectFingerprint: workspaceProjectFingerprint([`file://${rootB}`]), conversationId: "chat-b", writer: "chat-b" }
  try {
    await repositoryA.initialize()
    await repositoryB.initialize()
    await repositoryB.getList(scopeB)
    const projectB = projectOf(databaseB)
    const stored = await repositoryA.recordToolObservation(scopeA, { toolName: "read_file", arguments: { path: "src/a.ts" }, output: "a", evidenceOutput: "a", failed: false, requestId: "cross-project" })
    assert.ok(stored.outcome !== undefined)
    assert.equal(outcomeFor(databaseB, projectB, stored.id), undefined, "the other project reads nothing of this one")
    assert.equal(countOf(databaseB, "SELECT COUNT(*) AS n FROM evidence_outcomes WHERE project_id = ?", projectB), 0, "no row and no project name is disclosed")
    const denied = new ProjectEvidenceStore(new SqliteFile(databaseB), createPolicySource(rootB), rootB)
    assert.equal((await denied.pending(stored.id, { projectId: projectB })), undefined, "a lookup that is denied names no restricted candidate")
    assert.notEqual(projectB, projectOf(databaseA))
  } finally {
    repositoryA.close()
    repositoryB.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
  })

test("a storage write failure is reported as storage_error, never as a successful record", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stage1-write-fault-"))
  const root = path.join(directory, "project")
  fs.mkdirSync(path.join(root, ".twinny"), { recursive: true })
  const databasePath = await prepareProjectTodoStorage(resolveProjectTodoStorage([{ scheme: "file", fsPath: root }]))
  const blocked = path.join(directory, "byte-folder-is-a-file")
  fs.writeFileSync(blocked, "this path is a file, not the byte folder")
  const repository = new TodoRepository(databasePath, DEFAULT_EVIDENCE_STORAGE_LIMITS, () => [root])
  try {
    await repository.initialize()
    const scope = { projectFingerprint: workspaceProjectFingerprint([`file://${root}`]), conversationId: "fault-chat", writer: "fault-chat" }
    await repository.getList(scope)
    const projectId = projectOf(databasePath)
    const store = new ProjectEvidenceStore(new SqliteFile(databasePath), createPolicySource(root), root, { blobDirectory: blocked, forceStorageKind: "file" })
    const outcome = await store.record(capturedOf("faulted-write", [{ stream: "stdout", bytes: Buffer.from("bytes that cannot be filed\n", "utf8") }]), { projectId })
    assert.equal(outcome.state, "storage_error", "the record says the write failed")
    assert.equal(outcome.storageComplete, "inaccessible")
    assert.equal(outcome.streams[0].storedBytes, 0)
    assert.equal(outcome.streams[0].blobId, undefined, "no ID exists for bytes that were not written")
    assert.equal(outcome.streams[0].gapReason, "storage_error")
    const event = (withSqlite(databasePath, (database) => database.prepare("SELECT result, details_json FROM evidence_io_events WHERE outcome_id = ? AND kind = 'capture_gap'").get(outcome.outcomeId)) as { result: string; details_json: string })
    assert.equal(event.result, "storage_error", "the persisted event names the gap it recorded")
    const persisted = JSON.parse(event.details_json) as { reason?: string; error?: string }
    assert.equal(persisted.reason, "storage_error", "read-back reports the gap reason from the persisted metadata, not the fault message")
    assert.ok((persisted.error ?? "").includes("mkdir"), "the fault itself is stored beside the reason, not in place of it")
    assert.equal(outcomeFor(databasePath, projectId, outcome.observationId)!.state, "storage_error", "reading the row back gives the same state the write reported")
    assert.equal(countOf(databasePath, "SELECT COUNT(*) AS n FROM evidence_blobs WHERE project_id = ?", projectId), 0, "no phantom blob row exists")
    const reopened = new ProjectEvidenceStore(new SqliteFile(databasePath), createPolicySource(root), root)
    const reconciled = await reopened.reconcile()
    assert.deepEqual(reconciled.settled, [], "the record that failed is not settled to a success")
    assert.equal(reconciled.byteObjectsUnverified.length, 0, "no pointer is left claiming bytes that are not there")
    assert.deepEqual(reconciled.orphanFiles, [], "the faulted path is not a byte folder, so nothing is deleted")
  } finally {
    repository.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("a partial delivery for a successful tool stays successful, and an unsuccessful tool stays unsuccessful even when its output was captured completely", async () => {
  await withProject("stage1-delivery-states-", async (project) => {
    const bytes = Buffer.from("the whole output, delivered in pieces\n", "utf8")
    const succeeded = await project.store.record(capturedOf("partial-delivery", [{ stream: "payload", bytes }], { toolName: "read_file", status: "exited", exitCode: undefined, terminationReason: undefined, captureMode: "not_applicable" }), { projectId: project.projectId, display: { output: "the fitted copy", arguments: { path: "src/a.ts" }, failed: false } })
    assert.equal(succeeded.status, "exited", "delivery being partial does not make the run a failure")
    const failed = await project.store.record(capturedOf("captured-failure", [{ stream: "stderr", bytes }], { toolName: "read_file", status: "exited", exitCode: 2, terminationReason: "exit", captureMode: "not_applicable" }), { projectId: project.projectId, display: { output: "could not be read", arguments: { path: "src/b.ts" }, failed: true } })
    assert.equal(failed.exitCode, 2, "a completed process with a nonzero code is not a tool failure by the store's account; the tool said it failed")
    assert.equal(failed.streams[0].storageComplete, "complete", "its diagnostic output was captured whole")
    const rows = withSqlite(project.databasePath, (database) => database.prepare("SELECT request_id, failed FROM todo_tool_observations WHERE project_id = ? ORDER BY created_at, request_id").all(project.projectId)) as { request_id: string; failed: number }[]
    assert.deepEqual(rows.map((row) => [row.request_id, row.failed]), [["partial-delivery", 0], ["captured-failure", 1]], "the recorded failure stays a failure")
    const observed = await recordToolResult({ repository: project.repository, scope: project.scope }, { name: "read_file", args: { path: "src/a.ts" } }, { output: "cut to fit", summary: "read", failed: false, rawOutput: bytes.toString("utf8"), integrity: { status: "partial", rawChars: bytes.length, deliveredChars: 10 } }, { invocationId: "delivery-partial" })
    assert.equal(observed.failed, false, "partial delivery does not make the tool call unsuccessful")
    const unsuccessful = await recordToolResult({ repository: project.repository, scope: project.scope }, { name: "read_file", args: { path: "src/b.ts" } }, { output: "could not be read", summary: "read", failed: true, rawOutput: bytes.toString("utf8") }, { invocationId: "delivery-failed" })
    assert.equal(unsuccessful.failed, true)
  })
})

test("zero matches from a search is a success, and no storage state claims bytes it does not hold", async () => {
  await withProject("stage1-zero-matches-", async (project) => {
    const empty = Buffer.from("", "utf8")
    const outcome = await project.store.record(capturedOf("no-matches", [{ stream: "payload", bytes: empty }], { toolName: "grep", status: "exited", exitCode: 0, captureMode: "not_applicable" }), { projectId: project.projectId })
    assert.equal(outcome.status, "exited", "zero matches is a successful run")
    const stream = outcome.streams[0]
    assert.ok(stream !== undefined, "the stream that produced nothing is still reported as what it produced")
    assert.equal(stream.capturedComplete, "not_captured", "\"no output\" and \"output not captured\" stay different states")
    assert.equal(stream.storedBytes, 0)
    assert.equal(stream.blobId, undefined, "no ID exists for content the store does not hold")
    assert.equal(stream.storageComplete, "inaccessible", "no storage state claims bytes the store does not hold")
    const notRun = await project.store.record(capturedOf("not-run", [], { toolName: "grep", status: "unknown", exitCode: undefined, executed: false }), { projectId: project.projectId })
    assert.equal(notRun.status, "refused")
    assert.equal(notRun.capturedComplete, "not_captured")
    assert.equal(notRun.storageComplete, "inaccessible", "\"not run\" is never a successful zero-result execution")
  })
})
