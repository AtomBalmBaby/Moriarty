/**
 * Stage 4's validity classes, recorded dependency edges and invalidation events. Every case runs on a scratch
 * project under /tmp through the real repository, the real tool dispatch and the real dependency index. The
 * development database policy is kept: no code deletes a database, `-wal`/`-shm` are left alone, and the
 * developer's `.twinny/project.sqlite` is never opened from this file.
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { DependencyIndex } from "../../extension/todos/dependency-index"
import { type ObservedSourceReference, observedSourceReferences } from "../../extension/todos/evidence"
import { DEFAULT_EVIDENCE_STORAGE_LIMITS, TodoRepository, workspaceProjectFingerprint } from "../../extension/todos/repository"
import { aggregateValidity, type RecordedSourceReference, type SourceBoundaryOptions, staleNoticeOf } from "../../extension/todos/source-validity"
import { prepareProjectTodoStorage, resolveProjectTodoStorage } from "../../extension/todos/sqlite"
import type { RecordedObservation } from "../../extension/todos/types"
import { fingerprintContent } from "../../extension/tools/fingerprint"
import type { ToolCall } from "../../extension/tools/protocol"
import { workspaceTools } from "../../extension/tools/workspace"

interface Stage4 {
  directory: string
  root: string
  databasePath: string
  repository: TodoRepository
  index: DependencyIndex
  scope: { projectFingerprint: string; conversationId: string; writer: string }
}

const scopeOf = (root: string, name: string) => ({
  projectFingerprint: workspaceProjectFingerprint([`file://${root}`]),
  conversationId: name,
  writer: name
})

/** One scratch project under /tmp, the real repository over it, and the dependency index the repository owns. */
const withProject = async (prefix: string, run: (project: Stage4) => Promise<void>, source: SourceBoundaryOptions = {}): Promise<void> => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const root = path.join(directory, "project")
  fs.mkdirSync(path.join(root, "src"), { recursive: true })
  const storage = resolveProjectTodoStorage([{ scheme: "file", fsPath: root }])
  const databasePath = await prepareProjectTodoStorage(storage)
  const name = prefix.replace(/[^a-z]/g, "")
  const repository = new TodoRepository(databasePath, DEFAULT_EVIDENCE_STORAGE_LIMITS, () => [root], source)
  const scope = scopeOf(root, name)
  try {
    await repository.initialize()
    // The project row exists once the repository has read its list; that is the production path.
    await repository.getList(scope)
    await run({ directory, root, databasePath, repository, index: repository.dependencyIndex(), scope })
  } finally {
    repository.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

/** Records one result the way the chat hook records it, from what the tool actually produced. */
const recordResult = async (project: Stage4, call: ToolCall, requestId: string): Promise<RecordedObservation> => {
  const result = await workspaceTools(project.root).run(call)
  assert.ok(!result.failed, `${call.name} failed: ${result.output}`)
  const raw = result.rawOutput ?? result.output
  return project.repository.recordToolObservation(project.scope, {
    toolName: call.name,
    arguments: Object.fromEntries(Object.entries(call.args).map(([key, value]) => [key, String(value)])),
    output: result.output,
    evidenceOutput: raw,
    integrity: result.integrity,
    rawIntegrity: result.rawIntegrity,
    failed: false,
    exitCode: result.execution?.exitCode,
    requestId,
    sources: observedSourceReferences({ name: call.name, args: call.args, output: raw, failed: false })
  })
}

/** Records one observation for the source references the production recorder would have read off its output. */
const recordReference = async (project: Stage4, requestId: string, toolName: string, output: string, sources: ObservedSourceReference[]): Promise<RecordedObservation> =>
  project.repository.recordToolObservation(project.scope, { toolName, arguments: { path: sources[0]?.path ?? "" }, output, evidenceOutput: output, failed: false, requestId, sources })

/** The classes the boundary gave the records stored for one path. */
const classesFor = async (project: Stage4, file: string): Promise<string[]> =>
  (await project.repository.projectObservations(project.scope, { path: file })).map((record) => record.class ?? "none")

test("four reads of one version then a verified edit makes those four current-state reads stale while the historical records survive", async () => {
  await withProject("stage4-four-reads-", async (project) => {
    const file = "src/parser.ts"
    const first = "export function parse() {}\n"
    fs.writeFileSync(path.join(project.root, file), first)
    const hash = await fingerprintContent(first)
    const recorded: string[] = []
    for (let pass = 0; pass < 4; pass += 1) {
      const observation = await recordResult(project, { name: "read_file", args: { path: file, start_line: 1, end_line: 1 } }, `version-a-read-${pass}`)
      assert.equal(observation.class, "current", `the read of the version it saw is current before any change (pass ${pass})`)
      recorded.push(observation.id)
    }
    const run = await recordReference(project, "history-run", "run_command", "3 assertions passed", [])
    assert.equal(run.class, "historical", "what ran stays history: it says what happened then, not what is true now")

    fs.writeFileSync(path.join(project.root, file), "export function parse() { return 1 }\n")
    const event = project.index.noteEvent({ path: file, reason: "source_modified", origin: "native_edit" })
    assert.ok(event.event !== undefined, `the edit the host performed is recorded against a source it had a record for: ${event.reason ?? ""}`)

    assert.deepEqual(await classesFor(project, file), ["stale", "stale", "stale", "stale"], "those four current-state reads of version A are stale")
    const history = await project.repository.projectObservations(project.scope, { toolName: "run_command" })
    assert.equal(history.length, 1, "the historical record is still listed")
    assert.equal(history[0].retained, true, "and its retained content is still there")
    assert.equal(history[0].class, "historical", "history survives the invalidation; a source change does not make it stale")
    assert.deepEqual((await project.repository.projectObservations(project.scope, { path: file })).map((record) => record.validity?.references[0]?.contentHash), recorded.map(() => hash), "the recorded fingerprint stays the obsolete one and is never rewritten")
  })
})

test("a derived claim is invalidated only when its recorded dependency is invalidated; an unrelated claim keeps its state", async () => {
  await withProject("stage4-derived-claim-", async (project) => {
    const x = "export const x = 1\n"
    const y = "export const y = 1\n"
    fs.writeFileSync(path.join(project.root, "src/x.ts"), x)
    fs.writeFileSync(path.join(project.root, "src/y.ts"), y)
    const readX = await recordResult(project, { name: "read_file", args: { path: "src/x.ts", start_line: 1, end_line: 1 } }, "claim-read-x")
    const readY = await recordResult(project, { name: "read_file", args: { path: "src/y.ts", start_line: 1, end_line: 1 } }, "claim-read-y")
    const claimX = await recordReference(project, "claim-from-x", "grep", "one hit in x", [{ path: "src/x.ts", role: "read", observedVersion: "disk", contentHash: await fingerprintContent(x) }])
    const claimY = await recordReference(project, "claim-from-y", "grep", "one hit in y", [{ path: "src/y.ts", role: "read", observedVersion: "disk", contentHash: await fingerprintContent(y) }])
    assert.ok(project.index.recordEdge({ derivedObservationId: claimX.id, sourceObservationId: readX.id, kind: "accepted_fact" }, new Date().toISOString()))
    assert.ok(project.index.recordEdge({ derivedObservationId: claimY.id, sourceObservationId: readY.id, kind: "accepted_fact" }, new Date().toISOString()))

    fs.writeFileSync(path.join(project.root, "src/x.ts"), "export const x = 2\n")
    assert.equal((await project.repository.projectObservations(project.scope, { toolName: "grep", path: "src/x.ts" }))[0].class, "stale", "the claim whose recorded dependency changed is stale for the current state")
    assert.equal((await project.repository.projectObservations(project.scope, { toolName: "grep", path: "src/y.ts" }))[0].class, "current", "an unrelated claim keeps its own state")
  })
})

test("no dependency exists that the code did not establish: the edge table stays empty for a command run with unknown side effects", async () => {
  await withProject("stage4-no-invented-edge-", async (project) => {
    const text = "export const a = 1\n"
    fs.writeFileSync(path.join(project.root, "src/a.ts"), text)
    const read = await recordResult(project, { name: "read_file", args: { path: "src/a.ts", start_line: 1, end_line: 1 } }, "edge-read")
    // The command named a file inside its own text. The recorder has no source reference for it, so a string is
    // not a dependency: nothing can be established from command text.
    const run = await recordReference(project, "edge-run", "run_command", `cat src/a.ts\n${text}done`, [])
    assert.equal(project.index.edgesFor(run.id).length, 0, "the run named no source, so nothing was established for it")
    assert.equal(project.index.claimsDependingOn(read.id).length, 0, "a file named inside command text is not a recorded dependency")
    assert.equal(project.index.affectedClaims("src/a.ts").length, 0, "no claim depends on the file this run read")
    assert.equal(run.class, "historical", "whether it proves the current build stays unknown until an operation establishes it")
  })
})

test("a stale notice names the original hash and the UUID and never contains the new hash", async () => {
  await withProject("stage4-notice-hash-", async (project) => {
    const file = "src/notice.ts"
    const old = "export const value = 1\n"
    const fresh = "export const value = 2\n"
    fs.writeFileSync(path.join(project.root, file), old)
    const recorded = await recordReference(project, "notice-read", "read_file", `read ${file}`, [{ path: file, role: "read", observedVersion: "disk", contentHash: await fingerprintContent(old) }])
    fs.writeFileSync(path.join(project.root, file), fresh)
    const newHash = await fingerprintContent(fresh)
    const assessment = await project.repository.sourceValidity().classifyRecord(recorded.validity?.references ?? [], recorded.id)
    const notice = assessment.references[0].notice
    assert.ok(notice !== undefined, "a stale record can be rendered as a notice")
    assert.equal(notice.observationId, recorded.id)
    assert.equal(notice.originalHash, await fingerprintContent(old), "the notice carries the hash as it was observed")
    assert.equal(notice.reason, "source_modified")
    const text = JSON.stringify(notice)
    assert.ok(!text.includes(newHash), `a notice must not carry a current hash: ${text}`)
    assert.deepEqual(Object.keys(notice).sort(), ["observationId", "originalHash", "reason"], "and it carries nothing else")
  })
})

test("renamed sources resolve to their recorded link; identical-content files at different paths stay separate", async () => {
  await withProject("stage4-rename-link-", async (project) => {
    const content = "export const marker = 1\n"
    const hash = await fingerprintContent(content)
    fs.writeFileSync(path.join(project.root, "src/from.ts"), content)
    fs.writeFileSync(path.join(project.root, "src/other.ts"), content)
    await recordReference(project, "rename-read", "read_file", "read src/from.ts", [{ path: "src/from.ts", role: "read", observedVersion: "disk", contentHash: hash }])
    await recordReference(project, "collision-read", "read_file", "read src/other.ts", [{ path: "src/other.ts", role: "read", observedVersion: "disk", contentHash: hash }])
    await recordReference(project, "rename-op", "move_file", "moved src/from.ts to src/to.ts", [
      { path: "src/from.ts", role: "moved_from", observedVersion: "disk" },
      { path: "src/to.ts", role: "moved_to", observedVersion: "disk", contentHash: hash }
    ])
    assert.deepEqual(project.index.recordedLinks("src/from.ts"), [{ from: "src/from.ts", to: "src/to.ts" }], "the link the operation recorded is the answer, not a file chosen by content")
    assert.equal(project.index.recordsSource("src/other.ts"), true, "the identical-content file is its own source")
    assert.deepEqual(project.index.recordedLinks("src/other.ts"), [], "and it gets no link to another path")
  })
})

test("deleted sources report invalid and stale with reason source_deleted, and the record is still listed", async () => {
  await withProject("stage4-deleted-source-", async (project) => {
    const file = "src/gone.ts"
    const text = "export const gone = 1\n"
    fs.writeFileSync(path.join(project.root, file), text)
    const recorded = await recordResult(project, { name: "read_file", args: { path: file, start_line: 1, end_line: 1 } }, "gone-read")
    assert.equal(recorded.class, "current")
    fs.rmSync(path.join(project.root, file))
    const [after] = await project.repository.projectObservations(project.scope, { path: file })
    assert.ok(after, "the record is still listed after its source is gone")
    assert.equal(after.retained, true, "and it keeps its retained content as history")
    assert.equal(after.validity?.references[0].validity, "invalid", "the existing state keeps its meaning")
    assert.equal(after.class, "stale", "the class reports it as stale for the current state")
    assert.equal(staleNoticeOf(after.validity?.references[0], { observationId: after.observationId })?.reason, "source_deleted", "and the notice says what happened to the source")
  })
})

test("external change reports unknown until reconciled, then the reconciled state", async () => {
  await withProject("stage4-external-change-", async (project) => {
    const file = "src/watched.ts"
    const text = "export const watched = 1\n"
    fs.writeFileSync(path.join(project.root, file), text)
    const recorded = await recordResult(project, { name: "read_file", args: { path: file, start_line: 1, end_line: 1 } }, "watched-read")
    assert.equal(recorded.class, "current", "before any change the record is current")
    fs.writeFileSync(path.join(project.root, file), `${text}// changed outside the editor\n`)
    const reference = recorded.validity?.references[0]
    assert.ok(reference !== undefined)
    const event = project.index.noteEvent({ path: file, reason: "source_modified", origin: "file_watcher" })
    assert.ok(event.event !== undefined && !event.event.reconciled)
    const first = await project.repository.sourceValidity().classifyRecord([reference], recorded.id)
    assert.equal(first.class, "unknown", "a change detected with latency is not a state before a verified read reconciles it")
    const second = await project.repository.sourceValidity().classifyRecord([reference], recorded.id)
    assert.equal(second.class, "stale", "the reconciled answer reports the state the read showed")
    assert.equal(project.index.eventFor(file)?.reconciled, true, "the boundary's own read settled the event")
  })
})

test("Git operation invalidation is recorded only when it touched the recorded source", async () => {
  await withProject("stage4-git-operation-", async (project) => {
    const file = "src/git.ts"
    const text = "export const git = 1\n"
    fs.writeFileSync(path.join(project.root, file), text)
    const recorded = await recordResult(project, { name: "read_file", args: { path: file, start_line: 1, end_line: 1 } }, "git-read")
    // A git report names the paths the operation touched. The index accepts one only for a path this project
    // recorded as a source, and it never reads the command string to decide what a run affected.
    const touched = project.index.noteEvent({ path: file, reason: "git_operation", origin: "git_operation" })
    assert.ok(touched.event !== undefined, "the path the operation touched and this project recorded is recorded")
    assert.equal(touched.event?.reason, "git_operation")
    const unrecorded = project.index.noteEvent({ path: "src/never-recorded.ts", reason: "git_operation", origin: "git_operation" })
    assert.equal(unrecorded.event, undefined)
    assert.ok(unrecorded.reason !== undefined, "a file no record names gets no event, so no claim is invalidated by it")
    assert.equal(project.index.edgesFor(recorded.id).length, 0, "and the git change recorded no dependency")
  })
})

test("buffer-versus-disk distinction is preserved for every class", async () => {
  const open = new Map<string, { text: string; version?: number }>()
  await withProject("stage4-buffer-disk-", async (project) => {
    const file = "src/buffer.ts"
    const saved = "export const buffer = 1\n"
    const unsaved = `${saved}// only the open document has this\n`
    fs.writeFileSync(path.join(project.root, file), saved)
    open.set(path.join(project.root, file), { text: unsaved, version: 4 })
    const bufferHash = await fingerprintContent(unsaved)
    const whileOpen = await recordReference(project, "buffer-read", "read_file", `read ${file}`, [{ path: file, role: "read", observedVersion: "buffer", contentHash: bufferHash, editorVersion: 4 }])
    assert.equal(whileOpen.class, "current", "while the buffer is open the record is judged against that buffer")
    assert.equal(whileOpen.validity?.references[0].checkedAgainst, "buffer")
    assert.equal(whileOpen.validity?.references[0].persistedSource, false)
    open.delete(path.join(project.root, file))
    const [closed] = await project.repository.projectObservations(project.scope, { path: file })
    assert.equal(closed.class, "stale", "once the buffer closes the saved file decides, and the closed buffer is not trusted")
    assert.equal(closed.validity?.references[0].checkedAgainst, "disk")
    assert.equal(closed.validity?.references[0].persistedSource, true)
    const unhashed = await recordReference(project, "buffer-grep", "grep", "no fingerprint recorded for this hit", [{ path: file, role: "read", observedVersion: "disk" }])
    assert.equal(unhashed.class, "unknown", "a reference with no recorded fingerprint stays unknown; nothing is assumed for it")
    const eventOnly = await recordReference(project, "buffer-event", "rename_symbol", "renamed buffer in src/buffer.ts", [])
    assert.equal(eventOnly.class, "historical", "an event-only record stays history, and its reference was still read as disk content")
  }, { openDocument: (absolute) => open.get(absolute) })
})

test("a hash collision across two files never resolves to one source", async () => {
  await withProject("stage4-hash-collision-", async (project) => {
    const content = "export const shared = 1\n"
    const hash = await fingerprintContent(content)
    fs.writeFileSync(path.join(project.root, "src/one.ts"), content)
    fs.writeFileSync(path.join(project.root, "src/two.ts"), content)
    const one = await recordReference(project, "collision-one", "read_file", "read src/one.ts", [{ path: "src/one.ts", role: "read", observedVersion: "disk", contentHash: hash }])
    const two = await recordReference(project, "collision-two", "read_file", "read src/two.ts", [{ path: "src/two.ts", role: "read", observedVersion: "disk", contentHash: hash }])
    fs.writeFileSync(path.join(project.root, "src/one.ts"), `${content}// only the first file changed\n`)
    const after = await project.repository.projectObservations(project.scope, { toolName: "read_file" })
    assert.equal(after.find((record) => record.observationId === one.id)?.class, "stale", "the record that names the changed file is stale")
    assert.equal(after.find((record) => record.observationId === two.id)?.class, "current", "the other file with identical content is not judged through it")
    assert.deepEqual(project.index.recordedLinks("src/one.ts"), [], "and a matching fingerprint is never read as a move link")
  })
})

test("a claim whose dependency was never recorded is judged only by its own reference", async () => {
  await withProject("stage4-unrecorded-claim-", async (project) => {
    const text = "export const claim = 1\n"
    fs.writeFileSync(path.join(project.root, "src/claim.ts"), text)
    const claim = await recordReference(project, "claim-alone", "grep", "one hit in src/claim.ts", [{ path: "src/claim.ts", role: "read", observedVersion: "disk", contentHash: await fingerprintContent(text) }])
    assert.equal(project.index.edgesFor(claim.id).length, 0, "the code recorded no dependency for it")
    assert.equal(claim.class, "current", "so its own reference is all the boundary has to decide from")
    fs.writeFileSync(path.join(project.root, "src/other.ts"), `${text}// another file\n`)
    assert.equal((await project.repository.projectObservations(project.scope, { toolName: "grep" }))[0].class, "current", "a change to a file it does not depend on leaves its state alone")
  })
})

test("an event for a file outside the authorized roots records nothing and names no candidate", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stage4-outside-roots-"))
  const root = path.join(directory, "project")
  const other = path.join(directory, "other")
  fs.mkdirSync(path.join(root, "src"), { recursive: true })
  fs.mkdirSync(path.join(other, "src"), { recursive: true })
  const text = "export const outside = 1\n"
  fs.writeFileSync(path.join(other, "src", "outside.ts"), text)
  const repository = new TodoRepository(path.join(root, ".twinny", "project.sqlite"), DEFAULT_EVIDENCE_STORAGE_LIMITS, () => [root])
  const scope = scopeOf(root, "stage4out")
  try {
    await repository.initialize()
    await repository.getList(scope)
    const index = repository.dependencyIndex()
    const outside = `${path.posix.resolve(other).replace(/\\/g, "/")}/src/outside.ts`
    await repository.recordToolObservation(scope, { toolName: "read_file", arguments: { path: outside }, output: `read ${outside}`, evidenceOutput: text, failed: false, requestId: "outside-record", sources: [{ path: outside, role: "read", observedVersion: "disk", contentHash: await fingerprintContent(text) }] })
    const denied = index.noteEvent({ path: outside, reason: "source_modified", origin: "file_watcher" })
    assert.equal(denied.event, undefined, "the event is refused for a root this repository was not given")
    assert.ok((denied.reason ?? "").includes("outside the roots"), denied.reason ?? "")
    assert.ok(!(denied.reason ?? "").includes(path.posix.resolve(root).replace(/\\/g, "/")), "the refusal names no candidate it cannot name")
  } finally {
    repository.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("a file restored to matching content reads valid again and is not resurrected as freshly authorized evidence", async () => {
  await withProject("stage4-restored-", async (project) => {
    const file = "src/restored.ts"
    const original = "export const restored = 1\n"
    fs.writeFileSync(path.join(project.root, file), original)
    const hash = await fingerprintContent(original)
    const read = await recordReference(project, "restored-read", "read_file", `read ${file}`, [{ path: file, role: "read", observedVersion: "disk", contentHash: hash }])
    assert.equal(read.class, "current")
    fs.writeFileSync(path.join(project.root, file), `${original}// edited\n`)
    assert.equal((await project.repository.projectObservations(project.scope, { path: file }))[0].class, "stale")
    fs.writeFileSync(path.join(project.root, file), original)
    const again = (await project.repository.projectObservations(project.scope, { path: file }))[0]
    assert.equal(again.validity?.references[0].validity, "valid", "the boundary's own check says the content matches again")
    assert.equal(again.class, "current", "and it is current only through that check, not through a matching hash alone")
    assert.equal(project.index.edgesFor(again.observationId).length, 0, "the restore established no dependency, so none appears")
    assert.equal(again.validity?.references[0].contentHash, hash, "the recorded fingerprint is still the one as it was observed")
  })
})

test("the aggregate order stays invalid over stale over valid and unknown is reported separately", async () => {
  await withProject("stage4-aggregate-", async (project) => {
    const text = "export const value = 1\n"
    const hash = await fingerprintContent(text)
    for (const file of ["gone.ts", "kept.ts"]) fs.writeFileSync(path.join(project.root, "src", file), text)
    const references: RecordedSourceReference[] = [
      { path: "src/gone.ts", role: "read", observedVersion: "disk", contentHash: hash },
      { path: "src/kept.ts", role: "read", observedVersion: "disk", contentHash: hash }
    ]
    fs.rmSync(path.join(project.root, "src", "gone.ts"))
    const mixed = await project.repository.sourceValidity().classifyRecord(references)
    assert.equal(aggregateValidity(mixed.references), "invalid", "the existing aggregate keeps its order")
    assert.equal(mixed.class, "stale", "and the class reports that as stale for the current state")
    const noHash = await project.repository.sourceValidity().classifyRecord([{ path: "src/kept.ts", role: "read", observedVersion: "disk" }])
    assert.equal(noHash.unknown, 1, "unknown is counted on its own and never folded into a stronger state")
    assert.equal(noHash.class, "unknown", "and it is reported as its own class when nothing stronger was decided")
  })
})
