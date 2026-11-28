/**
 * Stage 3's typed git operations, run through the real tool dispatcher on scratch repositories under /tmp.
 * Every case reads only: `status --porcelain=v1 -z`, `rev-parse`, `symbolic-ref` and bounded `diff`. Nothing
 * stages, commits, pushes or changes a branch, and each case asserts that the repository it read stayed as it
 * was — the real index byte for byte, the porcelain record the same, HEAD the same. No case opens a project
 * database: every one keeps its own project home apart from the repository it reads, and the home holds
 * nothing but `config.json`. The legacy `args` contract is proven unchanged in more-tools.standalone.ts; one
 * case below runs it again through the same tool, so the typed fields have not disturbed it.
 */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { contentDigest, createGitBaselineStore, GitSessionCapture } from "../../extension/git/baseline"
import { createGitConfigSource } from "../../extension/git/config"
import { createGitOwnershipStore, GitOwnershipIndex } from "../../extension/git/ownership"
import type { GitObservationLookup, GitServiceOptions } from "../../extension/git/service"
import { gitCallIsReadOnly, toolCodeOfGitRefusal } from "../../extension/git/service"
import { AccessStore } from "../../extension/tools/access-grants"
import { accessTargetsOf, createAccessPreflight } from "../../extension/tools/access-preflight"
import { tidyGitPath } from "../../extension/tools/helpers"
import { git, insideGitRepository } from "../../extension/tools/more"
import { WorkspaceView } from "../../extension/tools/view"
import type { ToolExtras, ToolResult } from "../../extension/tools/workspace"
import { workspaceTools } from "../../extension/tools/workspace"

const SECRET = "s3cret-askpass-value-that-must-never-be-printed"
const HOST = "local|test"

const scratch = (prefix: string): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))

/** A project home with the folder the shared reader expects, and nothing else. */
const projectHome = (prefix: string): string => {
  const home = scratch(prefix)
  fs.mkdirSync(path.join(home, ".twinny"), { recursive: true })
  return home
}

/** Reading a status or an inspection must not create a project database. */
const noDatabase = (home: string): void =>
  assert.deepEqual(fs.readdirSync(path.join(home, ".twinny")).filter((name) => name !== "config.json"), [], "the tool created no project database")

type RepositoryRef = { top: string; head: string | null; branch: string | null }
type StatusReading = {
  kind: string
  observationId?: string
  succeeded: boolean
  repository: RepositoryRef
  baselineId?: string
  staged: string[]
  unstaged: string[]
  untracked: string[]
  capabilities?: { commit: string; push: string; basis: string }
  auth?: { mode: string; references: string[] }
  configProblem?: string
  leftOut?: number
}
type InspectReading = {
  kind: string
  observationId?: string
  succeeded: boolean
  repository: RepositoryRef
  baselineId?: string
  paths: string[]
  changes: { path: string; side: string; status: string; ownership: string; confidence: string; from?: string; added?: number; removed?: number; digest?: string }[]
  stat: { files: number; additions: number; deletions: number }
  diff?: string
  clipped?: number
  error?: { code: string; executed: boolean }
}
type RefusalPayload = { ok: false; error: { code: string; executed: boolean; message: string; recovery?: string } }

/** What the model is sent for a typed call, read back as §7.2 and §14 shape it. */
const statusOf = (result: ToolResult): StatusReading => JSON.parse(result.output) as StatusReading
const inspectOf = (result: ToolResult): InspectReading => JSON.parse(result.output) as InspectReading
const refusalOf = (result: ToolResult): RefusalPayload => JSON.parse(result.output) as RefusalPayload

const toolsFor = (
  root: string | WorkspaceView,
  gitOptions: Omit<GitServiceOptions, "view"> = {},
  extras: ToolExtras = {}
) => workspaceTools(root, [], { gitOptions, access: gitOptions.access, ...extras })

const gitRunIn = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, stdio: "pipe" }).toString()
const porcelainOf = (cwd: string): string => gitRunIn(cwd, ["status", "--porcelain=v1", "-z"])

/** What a repository looked like before a read, so the read can be proved to have changed nothing. */
const stateOf = (root: string): { index: Buffer; status: string; head: string } => ({
  index: fs.readFileSync(path.join(root, ".git", "index")),
  status: porcelainOf(root),
  head: gitRunIn(root, ["rev-parse", "HEAD"])
})

type Repo = { root: string; write: (file: string, content: string) => void }

/** A scratch repository with one commit. The test writes into it; nothing here commits or pushes. */
const withRepository = async (files: Record<string, string>, run: (repo: Repo) => Promise<void>): Promise<void> => {
  const root = scratch("git-dispatch-")
  const write = (file: string, content: string): void => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), content)
  }
  gitRunIn(root, ["init", "-q"])
  gitRunIn(root, ["config", "user.email", "t@example.com"])
  gitRunIn(root, ["config", "user.name", "T"])
  for (const [file, content] of Object.entries(files)) write(file, content)
  gitRunIn(root, ["add", "."])
  gitRunIn(root, ["commit", "-qm", "first"])
  try { await run({ root, write }) } finally { fs.rmSync(root, { recursive: true, force: true }) }
}


test("git status reports repository state", async () => {
  const home = projectHome("git-dispatch-status-")
  await withRepository({ ".gitignore": "dist/\n", "src/a.ts": "one\n", "src/b.ts": "two\n", "dist/out.js": "x\n" }, async ({ root, write }) => {
    const source = createGitConfigSource(home)
    const baselines = createGitBaselineStore(source, { hostKey: HOST })
    const captured = await baselines.capture("conversation-status", root)
    assert.ok(!("code" in captured), JSON.stringify(captured))
    const tools = toolsFor(root, { configSource: source, baselines, conversationId: "conversation-status" })
    const clean = statusOf(await tools.run({ name: "git", args: { operation: "status" } }))
    assert.equal(clean.kind, "git_status")
    assert.equal(clean.succeeded, true)
    assert.equal(clean.repository.top, root)
    assert.equal(clean.repository.head, (captured as GitSessionCapture).baseline.headBefore, "HEAD as git names it, the same as the session started with")
    assert.equal(clean.repository.branch, (captured as GitSessionCapture).baseline.branchBefore)
    assert.deepEqual(clean.staged, [], "a clean repository reports nothing changed")
    assert.equal(clean.baselineId, (captured as GitSessionCapture).baseline.id)
    assert.deepEqual(clean.capabilities, {
      commit: "approval-required",
      push: "approval-required",
      basis: "git.workflow.mode=manual-approval; the preset's permission only, and a permission is not an approval"
    }, "the reading says where the permission came from, and does not claim more")
    assert.equal(clean.auth?.mode, "inherit")

    // Now the same repository, read with one change on each side.
    write("src/a.ts", "unstaged change\n")
    write("src/b.ts", "staged change\n")
    gitRunIn(root, ["add", "src/b.ts"])
    write("scratch.txt", "made in the session\n")
    const before = stateOf(root)
    const dirty = statusOf(await tools.run({ name: "git", args: { operation: "status" } }))
    assert.deepEqual(dirty.staged, ["src/b.ts"])
    assert.deepEqual(dirty.unstaged, ["src/a.ts"])
    assert.deepEqual(dirty.untracked, ["scratch.txt"], "an ignored file is not listed as untracked")
    assert.equal(dirty.baselineId, (captured as GitSessionCapture).baseline.id, "the baseline the host captured, not a new reading")
    assert.equal((await tools.run({ name: "git", args: { operation: "status" } })).summary, "git `status` · 1 staged file, 1 unstaged file, 1 untracked file")

    // A read changes nothing.
    const after = stateOf(root)
    assert.equal(after.index.equals(before.index), true, "the real index was not rewritten")
    assert.equal(after.status, before.status, "nothing was staged or unstaged")
    assert.equal(after.head, before.head, "no commit was made")
    assert.equal(JSON.stringify(dirty).includes(SECRET), false, "and the reading carries no credential value")
    noDatabase(home)
  })
  fs.rmSync(home, { recursive: true, force: true })
})


test("git inspect changes separates staged unstaged and untracked", async () => {
  const home = projectHome("git-dispatch-inspect-")
  await withRepository({ "a.ts": "original\n", "b.ts": "original b\n", "clean.ts": "untouched\n", "big.ts": "first line\n" }, async ({ root, write }) => {
    const source = createGitConfigSource(home)
    const baselines = createGitBaselineStore(source)
    // What was already changed when the session started stays what the baseline found.
    write("a.ts", "staged part\n")
    gitRunIn(root, ["add", "a.ts"])
    const captured = await baselines.capture("conversation-inspect", root)
    assert.ok(!("code" in captured), JSON.stringify(captured))
    const ownership = createGitOwnershipStore(baselines)
    const index = ownership.for("conversation-inspect")
    assert.ok(!("code" in index), JSON.stringify(index))
    // What the tool itself changed, as a host source recorded it.
    write("b.ts", "the agent part of b\n")
    const noted = (index as GitOwnershipIndex).note({
      conversationId: "conversation-inspect",
      file: path.join(root, "b.ts"),
      provenance: "native_edit",
      preDigest: contentDigest("original b\n"),
      postDigest: contentDigest("the agent part of b\n")
    })
    assert.ok(!("code" in noted), JSON.stringify(noted))
    write("new.ts", "made after the session started\n")
    const tools = toolsFor(root, { configSource: source, baselines, ownership, conversationId: "conversation-inspect" })
    const result = await tools.run({ name: "git", args: { operation: "inspect", paths: ["b.ts", "a.ts", "clean.ts", "new.ts"] } })
    assert.ok(!result.failed, result.output)
    const reading = inspectOf(result)
    assert.deepEqual(reading.paths, ["a.ts", "b.ts", "clean.ts", "new.ts"], "the paths the call selected, as the repository names them")
    assert.deepEqual(
      reading.changes.map((change) => [change.path, change.side, change.status, change.ownership, change.confidence]),
      [
        ["a.ts", "staged", "modified", "unknown", "known"],
        ["b.ts", "unstaged", "modified", "agent", "verified"],
        ["clean.ts", "clean", "clean", "unknown", "uncertain"],
        ["new.ts", "untracked", "untracked", "unknown", "uncertain"]
      ],
      "each side keeps its own class, and what no host fact proves stays unknown"
    )
    assert.deepEqual(reading.stat, { files: 4, additions: 2, deletions: 2 }, "the bounded diff counts, per side")
    assert.equal(reading.baselineId, (captured as GitSessionCapture).baseline.id)
    assert.equal(reading.changes[1].digest, contentDigest("the agent part of b\n"), "the digest is what the host measured")
    assert.equal(typeof reading.diff, "string", "a patch within the cap is shown whole")
    assert.ok(reading.clipped === undefined, "and nothing of it was cut off")
    // A patch larger than the model-visible cap stays in the raw output recorded for the call.
    write("big.ts", "first line\n" + "x".repeat(3000) + "\n")
    const before = stateOf(root)
    const wide = await tools.run({ name: "git", args: { operation: "inspect", paths: ["big.ts"] } })
    const seen = inspectOf(wide)
    assert.ok(typeof seen.clipped === "number" && seen.clipped > 0, `the model-visible part is capped: ${seen.clipped} characters left for the record`)
    assert.ok(typeof wide.rawOutput === "string" && (wide.rawOutput as string).length > (seen.diff ?? "").length, "the whole bounded text is kept for the observation, not shown to the model")
    assert.ok(wide.output.length < 3000, "the reading itself stays compact")
    const after = stateOf(root)
    assert.equal(after.index.equals(before.index), true, "the real index was not rewritten")
    assert.equal(after.status, before.status, "inspection staged nothing")
    noDatabase(home)
  })
  fs.rmSync(home, { recursive: true, force: true })
})

test("git tools respect workspace boundaries", async () => {
  const home = projectHome("git-dispatch-boundaries-")
  const base = scratch("git-dispatch-monorepo-")
  const top = path.join(base, "repo")
  const root = path.join(top, "packages", "api")
  fs.mkdirSync(path.join(base, "repo", "packages", "api"), { recursive: true })
  gitRunIn(top, ["init", "-q"])
  gitRunIn(top, ["config", "user.email", "t@example.com"])
  gitRunIn(top, ["config", "user.name", "T"])
  fs.writeFileSync(path.join(root, ".gitignore"), "ignored.txt\n")
  fs.mkdirSync(path.join(top, "packages", "web"), { recursive: true })
  fs.writeFileSync(path.join(root, "kept.ts"), "in the open folder\n")
  fs.writeFileSync(path.join(top, "packages", "web", "sibling.ts"), "another package\n")
  gitRunIn(top, ["add", "."])
  gitRunIn(top, ["commit", "-qm", "first"])
  const view = new WorkspaceView(root, [], undefined, ["secret*"])
  const tools = toolsFor(view, { configSource: createGitConfigSource(home) })
  fs.writeFileSync(path.join(root, "kept.ts"), "changed in the open folder\n")
  fs.writeFileSync(path.join(top, "packages", "web", "sibling.ts"), "changed in another package\n")
  fs.writeFileSync(path.join(root, "ignored.txt"), "TOPSECRET in an ignored file\n")
  fs.writeFileSync(path.join(root, "secretkey.txt"), "TOPSECRET kept by the team's rules\n")
  const status = statusOf(await tools.run({ name: "git", args: { operation: "status" } }))
  assert.deepEqual(status.unstaged, ["packages/api/kept.ts"], "the open folder reports its own change")
  assert.deepEqual(status.untracked, [], "git keeps the ignored file out, and the blocked one is kept from the agent here")
  assert.equal(status.leftOut, 2, "the sibling package and the blocked file are counted, not silently dropped")
  assert.ok(!JSON.stringify(status).includes("TOPSECRET") && !JSON.stringify(status).includes("another package"), "what is kept from the agent is never named")
  const outside = refusalOf(await tools.run({ name: "git", args: { operation: "inspect", paths: ["../packages/web/sibling.ts"] } }))
  assert.equal(outside.error.code, "git_path_not_visible")
  assert.equal(outside.error.executed, false, "nothing ran")
  assert.match(outside.error.recovery ?? "", /outside the workspace/, outside.error.recovery)
  const hidden = refusalOf(await tools.run({ name: "git", args: { operation: "inspect", paths: ["ignored.txt"] } }))
  assert.equal(hidden.error.code, "git_path_not_visible")
  assert.match(hidden.error.recovery ?? "", /.gitignore/, hidden.error.recovery)
  noDatabase(home)
  fs.rmSync(base, { recursive: true, force: true })
  fs.rmSync(home, { recursive: true, force: true })
})

test("git tools join the real tool dispatcher", async () => {
  const home = projectHome("git-dispatch-inventory-")
  await withRepository({ "a.ts": "one\n" }, async ({ root, write }) => {
    const source = createGitConfigSource(home)
    const baselines = createGitBaselineStore(source)
    await baselines.capture("conversation-dispatch", root)
    const recorded: GitObservationLookup = (call) => (call.args.operation === "status" ? "observation-dispatch-1" : undefined)
    const tools = toolsFor(root, { configSource: source, baselines, conversationId: "conversation-dispatch", observations: recorded })
    assert.equal(tools.tools.filter((tool) => tool.name === "git").length, 1, "one tool name, no second inventory entry")
    const spec = tools.tools.find((tool) => tool.name === "git")
    assert.ok(spec !== undefined && spec.readOnlyFor !== undefined, "the read-only classification is per call")
    assert.equal(gitCallIsReadOnly({ args: "status -u" }), true, "legacy args always read")
    assert.equal(gitCallIsReadOnly({ operation: "inspect" }), true)
    assert.equal(gitCallIsReadOnly({ operation: "commit" }), false, "a mutating operation is not a read, so the loop serialises it")
    const counted = await tools.run({ name: "git", args: { operation: "status" } })
    assert.equal(statusOf(counted).observationId, "observation-dispatch-1", "the observation the host recorded for this call")
    const plain = toolsFor(root, { configSource: source, baselines, conversationId: "conversation-dispatch" })
    assert.ok(statusOf(await plain.run({ name: "git", args: { operation: "status" } })).observationId === undefined, "no id is invented when nothing was recorded")
    const later = refusalOf(await tools.run({ name: "git", args: { operation: "push" } }))
    assert.equal(later.error.code, "git_approval_required", "Stage 5 runs a send, but this call was not approved")
    assert.equal(later.error.executed, false, "nothing ran and no transaction was opened")
    const both = refusalOf(await tools.run({ name: "git", args: { operation: "status", args: "diff --stat" } }))
    assert.equal(both.error.code, "git_argument_conflict")
    // The legacy contract still answers through the same tool, as it did.
    write("a.ts", "two\n")
    const legacy = await tools.run({ name: "git", args: { args: "diff --stat" } })
    assert.match(legacy.output, /^\$ git diff --stat\n\(exit code 0\)\n/)
    assert.equal(legacy.summary, "git `diff --stat`")
    assert.match((await tools.run({ name: "git", args: { args: "commit -m x" } })).output, /not allowed here/)
    noDatabase(home)
  })
  fs.rmSync(home, { recursive: true, force: true })
})

test("git status outside repository fails clearly", async () => {
  const home = projectHome("git-dispatch-norepository-")
  const folder = scratch("git-dispatch-plain-")
  assert.equal(insideGitRepository(folder), false, "a folder above it holds no repository either")
  assert.ok(!workspaceTools(folder).tools.some((tool) => tool.name === "git"), "the tool is offered only inside a confirmed repository")
  const tool = git(new WorkspaceView(folder), { configSource: createGitConfigSource(home), conversationId: "conversation-outside" })
  const refused = refusalOf(await tool.run({ operation: "status" }))
  assert.equal(refused.error.code, "git_not_a_repository")
  assert.equal(refused.error.executed, false, "nothing was read, let alone changed")
  assert.match(refused.error.message, /not inside a git repository/i, refused.error.message)
  noDatabase(home)
  fs.rmSync(folder, { recursive: true, force: true })
  fs.rmSync(home, { recursive: true, force: true })
})

test("git inspect rejects blocked path", async () => {
  const home = projectHome("git-dispatch-blocked-")
  const base = scratch("git-dispatch-blocked-repo-")
  gitRunIn(base, ["init", "-q"])
  gitRunIn(base, ["config", "user.email", "t@example.com"])
  gitRunIn(base, ["config", "user.name", "T"])
  fs.writeFileSync(path.join(base, "secret.log"), "TOPSECRET in a blocked file\n")
  gitRunIn(base, ["add", "secret.log"])
  gitRunIn(base, ["commit", "-qm", "first"])
  const view = new WorkspaceView(base, [], undefined, ["*.log"])
  const tools = toolsFor(view, { configSource: createGitConfigSource(home) })
  fs.writeFileSync(path.join(base, "secret.log"), "TOPSECRET changed\n")
  const refused = refusalOf(await tools.run({ name: "git", args: { operation: "inspect", paths: ["secret.log"] } }))
  assert.equal(refused.error.code, "git_path_not_visible")
  assert.equal(refused.error.executed, false, "the call was refused before anything ran")
  assert.match(refused.error.recovery ?? "", /kept from the agent by the team's rules/, refused.error.recovery)
  const listed = statusOf(await tools.run({ name: "git", args: { operation: "status" } }))
  assert.deepEqual(listed.unstaged, [], "a blocked path is not listed")
  assert.equal(listed.leftOut, 1, "the reading says what it kept out")
  assert.ok(!JSON.stringify(listed).includes("TOPSECRET"), JSON.stringify(listed))
  noDatabase(home)
  fs.rmSync(base, { recursive: true, force: true })
  fs.rmSync(home, { recursive: true, force: true })
})

test("git inspect rejects outside-workspace repository", async () => {
  const home = projectHome("git-dispatch-outside-")
  const inside = scratch("git-dispatch-inside-")
  const outside = scratch("git-dispatch-outside-repo-")
  for (const root of [inside, outside]) {
    gitRunIn(root, ["init", "-q"])
    gitRunIn(root, ["config", "user.email", "t@example.com"])
    gitRunIn(root, ["config", "user.name", "T"])
    fs.writeFileSync(path.join(root, "a.ts"), "content\n")
    gitRunIn(root, ["add", "."])
    gitRunIn(root, ["commit", "-qm", "first"])
  }
  assert.deepEqual(accessTargetsOf("git", { repository: outside }), [{ path: outside, access: "read" }], "the repository a git call names is the place it may reach")
  const before = { inside: stateOf(inside), outside: stateOf(outside) }
  // Without an approver nothing is granted, so the service refuses before it runs.
  const unasked = refusalOf(await toolsFor(new WorkspaceView(inside), { configSource: createGitConfigSource(home) }).run({ name: "git", args: { operation: "inspect", repository: outside, paths: ["a.ts"] } }))
  assert.equal(unasked.error.code, "git_access_denied")
  assert.equal(unasked.error.executed, false, "no git process was created for it")
  const store = new AccessStore(undefined, HOST)
  const view = new WorkspaceView(inside, [], undefined, [], [], () => store.grants().map((grant) => ({ root: grant.root, real: grant.real, scope: grant.scope })))
  const denied = refusalOf(await toolsFor(view, { configSource: createGitConfigSource(home), access: createAccessPreflight({ store, view, approve: async () => "deny" }) }).run({ name: "git", args: { operation: "inspect", repository: outside, paths: ["a.ts"] } }))
  assert.equal(denied.error.code, "permission_denied")
  assert.equal(denied.error.executed, false, "the whole call was refused before anything ran")
  // A folder the settings allow is read, and only that folder.
  const allowed = new AccessStore(undefined, HOST)
  const grantedView = new WorkspaceView(inside, [], undefined, [], [outside], () => allowed.grants().map((grant) => ({ root: grant.root, real: grant.real, scope: grant.scope })))
  const reading = statusOf(await toolsFor(grantedView, { configSource: createGitConfigSource(home), access: createAccessPreflight({ store: allowed, view: grantedView }) }).run({ name: "git", args: { operation: "status", repository: outside } }))
  assert.equal(reading.repository.top, outside, "the granted repository answers for its own state")
  const nested = path.join(outside, "sub")
  fs.mkdirSync(nested, { recursive: true })
  const nestedView = new WorkspaceView(inside, [], undefined, [], [nested], () => allowed.grants().map((grant) => ({ root: grant.root, real: grant.real, scope: grant.scope })))
  const escaped = refusalOf(await toolsFor(nestedView, { configSource: createGitConfigSource(home), access: createAccessPreflight({ store: allowed, view: nestedView }) }).run({ name: "git", args: { operation: "status", repository: nested } }))
  assert.equal(escaped.error.code, "git_access_denied")
  assert.equal(toolCodeOfGitRefusal(escaped.error.code), "permission_denied", "and it reports under the class existing consumers read")
  assert.match(escaped.error.recovery ?? "", /was not granted/, escaped.error.recovery)
  assert.equal(stateOf(inside).index.equals(before.inside.index), true, "the workspace repository was not touched")
  assert.equal(stateOf(outside).index.equals(before.outside.index), true, "and the granted one was read only")
  noDatabase(home)
  fs.rmSync(inside, { recursive: true, force: true })
  fs.rmSync(outside, { recursive: true, force: true })
  fs.rmSync(home, { recursive: true, force: true })
})

test("git status does not dump credentials", async () => {
  const home = projectHome("git-dispatch-credentials-")
  fs.writeFileSync(path.join(home, ".twinny", "config.json"), JSON.stringify({ git: { auth: { mode: "environment", env: { GIT_HTTP_EXTRA_HEADER: { env: "MORIARTY_GIT_HTTP_EXTRA_HEADER" } } } } }))
  process.env.MORIARTY_GIT_HTTP_EXTRA_HEADER = SECRET
  await withRepository({ "a.ts": "one\n" }, async ({ root }) => {
    const tools = toolsFor(root, { configSource: createGitConfigSource(home) })
    const result = await tools.run({ name: "git", args: { operation: "status" } })
    const reading = statusOf(result)
    assert.equal(reading.auth?.mode, "environment")
    assert.deepEqual(reading.auth?.references, ["GIT_HTTP_EXTRA_HEADER"], "the reference is named, as the shared reader reports it")
    assert.ok(!JSON.stringify(reading).includes(SECRET), "and what it holds is not in the reading")
    assert.ok(!result.output.includes(SECRET) && !result.summary.includes(SECRET) && !(result.rawOutput ?? "").includes(SECRET), "nor anywhere else the call returns")
    const invalid = projectHome("git-dispatch-invalid-config-")
    fs.writeFileSync(path.join(invalid, ".twinny", "config.json"), JSON.stringify({ git: { auth: { mode: "wrong" } } }))
    const reported = statusOf(await toolsFor(root, { configSource: createGitConfigSource(invalid) }).run({ name: "git", args: { operation: "status" } }))
    assert.ok(reported.capabilities === undefined, "an invalid file reports itself instead of falling back on a preset")
    assert.match(reported.configProblem ?? "", /must be/, reported.configProblem)
    assert.ok(!JSON.stringify(reported).includes(SECRET), JSON.stringify(reported))
    noDatabase(home)
    fs.rmSync(invalid, { recursive: true, force: true })
  })
  delete process.env.MORIARTY_GIT_HTTP_EXTRA_HEADER
  fs.rmSync(home, { recursive: true, force: true })
})

test("the access preflight decides git access for the call, not for the tool", async () => {
  const home = projectHome("git-dispatch-access-")
  const inside = scratch("git-dispatch-access-inside-")
  const outside = scratch("git-dispatch-access-outside-")
  for (const root of [inside, outside]) {
    gitRunIn(root, ["init", "-q"])
    gitRunIn(root, ["config", "user.email", "t@example.com"])
    gitRunIn(root, ["config", "user.name", "T"])
    fs.writeFileSync(path.join(root, "a.ts"), "content\n")
    gitRunIn(root, ["add", "."])
    gitRunIn(root, ["commit", "-qm", "first"])
  }
  assert.deepEqual(accessTargetsOf("git", { operation: "status", repository: outside }), [{ path: outside, access: "read" }], "a read asks read access")
  assert.deepEqual(accessTargetsOf("git", { operation: "inspect", repository: outside }), [{ path: outside, access: "read" }], "and so does an inspection")
  assert.deepEqual(accessTargetsOf("git", { args: "status -u", repository: outside }), [{ path: outside, access: "read" }], "legacy args always ask read")
  assert.deepEqual(accessTargetsOf("git", { operation: "commit", repository: outside }), [{ path: outside, access: "write" }], "a mutating operation asks for what it does, not for how the tool was registered")
  assert.deepEqual(accessTargetsOf("git", { operation: "push", repository: outside }), [{ path: outside, access: "write", git: { kind: "push", absolute: outside, remote: "", branch: "", force: false } }], "a push asks for write access and names its own typed request, which covers no force")
  const store = new AccessStore(undefined, HOST)
  const view = new WorkspaceView(inside, [], undefined, [], [], () => store.grants().map((grant) => ({ root: grant.root, real: grant.real, scope: grant.scope })))
  const tools = toolsFor(view, { configSource: createGitConfigSource(home), access: createAccessPreflight({ store, view, approve: async (prompt) => prompt.access === "read" ? { target: "exact", lifetime: "session" } : "deny" }) })
  const read = statusOf(await tools.run({ name: "git", args: { operation: "status", repository: outside } }))
  assert.equal(read.repository.top, outside, "the read grant was taken and the read ran")
  assert.ok(store.covering(outside, "read") !== undefined && store.covering(outside, "write") === undefined, "a read grant covers a read and never a write")
  const mutating = refusalOf(await tools.run({ name: "git", args: { operation: "commit", repository: outside, paths: ["a.ts"] } }))
  assert.equal(mutating.error.code, "permission_denied", "so the mutating call is refused on the access it needs, not carried by the read grant")
  assert.equal(mutating.error.executed, false, "and nothing ran for it")
  const before = stateOf(outside)
  assert.ok(store.grants().every((grant) => grant.access === "read"), "only a read grant is in force")
  assert.equal(stateOf(outside).index.equals(before.index), true, "the outside repository was not touched")
  noDatabase(home)
  fs.rmSync(inside, { recursive: true, force: true })
  fs.rmSync(outside, { recursive: true, force: true })
  fs.rmSync(home, { recursive: true, force: true })
})

test("git inspect answers renames, deletions and names holding spaces", async () => {
  const home = projectHome("git-dispatch-names-")
  await withRepository({ "keep me.ts": "one\n", "rename me.ts": "two\n", "delete me.ts": "three\n" }, async ({ root, write }) => {
    write("new file here.ts", "made after the session started\n")
    const source = createGitConfigSource(home)
    const baselines = createGitBaselineStore(source, { hostKey: HOST })
    const captured = await baselines.capture("conversation-names", root)
    assert.ok(!("code" in captured), JSON.stringify(captured))
    const tools = toolsFor(root, { configSource: source, baselines, conversationId: "conversation-names" })
    // What the repository holds at once: a staged rename, an unstaged deletion,
    // an unstaged change on a name with spaces, and an untracked file.
    write("keep me.ts", "changed in the working copy\n")
    gitRunIn(root, ["mv", "rename me.ts", "renamed here.ts"])
    fs.rmSync(path.join(root, "delete me.ts"))
    const before = stateOf(root)
    const reading = inspectOf(await tools.run({ name: "git", args: { operation: "inspect", paths: ["renamed here.ts", "delete me.ts", "keep me.ts", "new file here.ts"] } }))
    assert.deepEqual(reading.paths, ["delete me.ts", "keep me.ts", "new file here.ts", "renamed here.ts"].sort((a, b) => a.localeCompare(b)), "the paths as the call named them")
    const byPath = Object.fromEntries(reading.changes.map((change) => [change.path, change]))
    assert.deepEqual([byPath["renamed here.ts"].side, byPath["renamed here.ts"].status], ["staged", "renamed"], "the rename the index knows")
    assert.deepEqual([byPath["delete me.ts"].side, byPath["delete me.ts"].status], ["unstaged", "deleted"], "the deletion the working copy shows")
    assert.deepEqual([byPath["keep me.ts"].side, byPath["keep me.ts"].status], ["unstaged", "modified"])
    assert.deepEqual([byPath["new file here.ts"].side, byPath["new file here.ts"].status], ["untracked", "untracked"])
    // The counts are what git's own -z record gives for the path as the tool read it.
    const counts = (cached: boolean): Map<string, [number, number]> => {
      const out = gitRunIn(root, ["diff", "--no-ext-diff", "--no-textconv", ...(cached ? ["--cached"] : []), "--numstat", "-z", "--", ...reading.paths])
      const found = new Map<string, [number, number]>()
      for (const field of out.split("\0")) {
        if (!field) continue
        const parts = field.split("\t")
        const named = parts.pop()
        if (!named) continue
        found.set(tidyGitPath(named), [Number(parts[0]), Number(parts[1])])
      }
      return found
    }
    const truth = new Map([...counts(true), ...counts(false)])
    assert.ok(truth.size > 0, `there was something to count: ${JSON.stringify([...truth])}`)
    for (const [named, counted] of truth) {
      const change = byPath[named]
      if (change === undefined) continue
      assert.equal(change.added, counted[0], `${named} additions as git counted them`)
      assert.equal(change.removed, counted[1], `${named} deletions as git counted them`)
    }
    const after = stateOf(root)
    assert.equal(after.index.equals(before.index), true, "the read left the real index as it was")
    assert.equal(after.status, before.status, "and staged nothing")
    assert.equal(after.head, before.head, "and committed nothing")
    // The same read asked twice answers the same way and still changes nothing.
    const once = await tools.run({ name: "git", args: { operation: "inspect", paths: ["renamed here.ts"] } })
    const twice = await tools.run({ name: "git", args: { operation: "inspect", paths: ["renamed here.ts"] } })
    assert.equal(twice.output, once.output, "the same read answers the same way")
    assert.equal(stateOf(root).index.equals(before.index), true, "and the repeated read changed nothing")
    noDatabase(home)
  })
  fs.rmSync(home, { recursive: true, force: true })
})

test("a rename whose other name is kept from the agent names no secret path", async () => {
  const home = projectHome("git-dispatch-pair-")
  const root = scratch("git-dispatch-pair-repo-")
  gitRunIn(root, ["init", "-q"])
  gitRunIn(root, ["config", "user.email", "t@example.com"])
  gitRunIn(root, ["config", "user.name", "T"])
  fs.mkdirSync(path.join(root, "logs"), { recursive: true })
  fs.writeFileSync(path.join(root, "logs/secret.log"), `${SECRET} tracked content\n`)
  gitRunIn(root, ["add", "."])
  gitRunIn(root, ["commit", "-qm", "first"])
  gitRunIn(root, ["mv", "logs/secret.log", "moved away.txt"])
  const view = new WorkspaceView(root, [], undefined, ["*.log"])
  const tools = toolsFor(view, { configSource: createGitConfigSource(home) })
  const reading = inspectOf(await tools.run({ name: "git", args: { operation: "inspect", paths: ["moved away.txt"] } }))
  assert.ok(reading.changes.length === 1 && reading.changes[0].status === "renamed", JSON.stringify(reading.changes))
  // The path the team's rules keep is not named, and no pair name is carried for it: the answer is
  // given for the name this workspace may show.
  assert.equal(reading.changes[0].from, undefined, "no name kept from the agent is carried into the reading")
  assert.ok(!JSON.stringify(reading).includes("secret.log"), JSON.stringify(reading))
  noDatabase(home)
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(home, { recursive: true, force: true })
})

test("a rename answers as the pair git named it", async () => {
  const home = projectHome("git-dispatch-pair-shown-")
  const root = scratch("git-dispatch-pair-shown-repo-")
  gitRunIn(root, ["init", "-q"])
  gitRunIn(root, ["config", "user.email", "t@example.com"])
  gitRunIn(root, ["config", "user.name", "T"])
  fs.writeFileSync(path.join(root, "read as.ts"), "the same content on both sides\nsecond line\nthird line\n")
  gitRunIn(root, ["add", "."])
  gitRunIn(root, ["commit", "-qm", "first"])
  gitRunIn(root, ["mv", "read as.ts", "became.ts"])
  const tools = toolsFor(root, { configSource: createGitConfigSource(home) })
  const before = stateOf(root)
  const reading = inspectOf(await tools.run({ name: "git", args: { operation: "inspect", paths: ["read as.ts", "became.ts"] } }))
  assert.ok(reading.error === undefined, JSON.stringify(reading))
  const byPath = Object.fromEntries(reading.changes.map((change) => [change.path, change]))
  assert.equal(byPath["became.ts"].status, "renamed")
  assert.equal(byPath["became.ts"].from, "read as.ts", "the pair is named as git named it")
  assert.equal(byPath["read as.ts"].status, "renamed", "and the name the call asked for is not answered as clean when git says it was renamed")
  const pair = gitRunIn(root, ["diff", "--no-ext-diff", "--no-textconv", "--cached", "--numstat", "-z"]).split("\0").filter(Boolean)
  assert.equal(reading.changes[0].added, Number(pair[0].split("\t")[0]), `git counted the pair as ${pair[0]}`)
  assert.equal(reading.changes[0].removed, Number(pair[0].split("\t")[1]))
  assert.equal(stateOf(root).index.equals(before.index), true, "and the read changed nothing")
  noDatabase(home)
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(home, { recursive: true, force: true })
})

test("the inspection answers for a path as the open folder names it", async () => {
  const home = projectHome("git-dispatch-prefix-shown-")
  const base = scratch("git-dispatch-prefix-shown-repo-")
  gitRunIn(base, ["init", "-q"])
  gitRunIn(base, ["config", "user.email", "t@example.com"])
  gitRunIn(base, ["config", "user.name", "T"])
  fs.mkdirSync(path.join(base, "packages", "api"), { recursive: true })
  fs.writeFileSync(path.join(base, "packages/api/kept.ts"), "in the open folder\n")
  gitRunIn(base, ["add", "."])
  gitRunIn(base, ["commit", "-qm", "first"])
  fs.writeFileSync(path.join(base, "packages/api/kept.ts"), "changed\nsecond line\n")
  const view = new WorkspaceView(path.join(base, "packages", "api"))
  const tools = toolsFor(view, { configSource: createGitConfigSource(home) })
  const before = stateOf(base)
  const reading = inspectOf(await tools.run({ name: "git", args: { operation: "inspect", paths: ["kept.ts"] } }))
  assert.ok(reading.error === undefined, JSON.stringify(reading))
  assert.deepEqual(reading.changes.map((change) => [change.path, change.status]), [["packages/api/kept.ts", "modified"]], "answered for the visible path the open folder holds")
  const counted = gitRunIn(base, ["diff", "--no-ext-diff", "--no-textconv", "--numstat", "-z", "--", "packages/api/kept.ts"]).split("\0").filter(Boolean)
  assert.equal(reading.changes[0].added, Number(counted[0].split("\t")[0]), `git counted it as ${counted[0]}`)
  assert.equal(reading.changes[0].removed, Number(counted[0].split("\t")[1]))
  assert.equal(stateOf(base).index.equals(before.index), true, "and the read changed nothing")
  noDatabase(home)
  fs.rmSync(base, { recursive: true, force: true })
  fs.rmSync(home, { recursive: true, force: true })
})


test("a git call is refused before anything runs when nothing covers what it does", async () => {
  const home = projectHome("git-dispatch-prepare-")
  await withRepository({ "a.ts": "one\n" }, async ({ root }) => {
    const tools = toolsFor(root, { configSource: createGitConfigSource(home) })
    const before = stateOf(root)
    // Stage 5 runs a send, and a send names no paths: the call is refused before anything runs.
    const conflict = refusalOf(await tools.run({ name: "git", args: { operation: "push", paths: ["a.ts"] } }))
    assert.equal(conflict.error.code, "git_argument_conflict", "a send that names paths answers as a conflict")
    assert.equal(conflict.error.executed, false, "and it ran nothing")
    const unauthorized = refusalOf(await tools.run({ name: "git", args: { operation: "push" } }))
    assert.equal(unauthorized.error.code, "git_approval_required", "a send is refused until an approval covers it")
    assert.equal(unauthorized.error.executed, false)
    // The operations Stage 4 owns are still refused for an authorization the call did not carry.
    const staging = refusalOf(await tools.run({ name: "git", args: { operation: "prepare_commit", paths: ["a.ts"] } }))
    assert.equal(staging.error.code, "git_commit_not_authorized", JSON.stringify(staging))
    assert.equal(staging.error.executed, false, "and nothing was staged")
    const approved = toolsFor(root, { configSource: createGitConfigSource(home), policy: { approved: true } })
    const ungranted = refusalOf(await approved.run({ name: "git", args: { operation: "push" } }))
    assert.equal(ungranted.error.code, "git_push_not_authorized", "and an approval without the push request covers no send")
    assert.equal(ungranted.error.executed, false)
    const unapproved = refusalOf(await tools.run({ name: "git", args: { operation: "commit", operationId: "operation-nothing-prepared" } }))
    assert.equal(unapproved.error.code, "git_approval_required", "a preset that needs an approval refuses before the record is read")
    assert.equal(unapproved.error.executed, false)
    const committed = refusalOf(await approved.run({ name: "git", args: { operation: "commit", operationId: "operation-nothing-prepared" } }))
    assert.equal(committed.error.code, "git_commit_not_prepared", "and a commit answers for a prepared operation only")
    assert.equal(committed.error.executed, false)
    const after = stateOf(root)
    assert.equal(after.index.equals(before.index), true, "the real index was never touched")
    assert.equal(after.status, before.status, "nothing was staged")
    assert.equal(after.head, before.head, "nothing was committed")
    assert.equal(gitRunIn(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).trim(), "master", "and the branch is as it was")
    noDatabase(home)
  })
  fs.rmSync(home, { recursive: true, force: true })
})

