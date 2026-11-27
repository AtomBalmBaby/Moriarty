/**
 * Stage 4's exact staging into a private copy of the real index, tested on scratch repositories under /tmp.
 * Every case stages through the service, never with `git add -A`, and compares the user's index byte for
 * byte before and after: what this stage writes is the copy in its own scratch folder, not the index. A
 * commit here happens only in a repository the test created, so nothing in the development repository is
 * staged, committed or moved.
 */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { contentDigest, createGitBaselineStore, GitRefusal } from "../../extension/git/baseline"
import { createGitConfigSource } from "../../extension/git/config"
import { createGitOwnershipStore, GitOwnershipIndex } from "../../extension/git/ownership"
import { createGitExecutionService, GitExecutionService, GitStagingCall } from "../../extension/git/service"
import { createGitTransactionStore, GitPreparedReading, GitRunRefusal } from "../../extension/git/transaction"
import { accessTargetsOf } from "../../extension/tools/access-preflight"
import { GitPrepareRequest, OperationAuthorization } from "../../extension/tools/operation-authorization"
import { WorkspaceView } from "../../extension/tools/view"

const HOST = "local|test"
const CONVERSATION = "conversation-staging"

const scratch = (prefix: string): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))

const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, stdio: "pipe" }).toString()

/** What the user's own index holds, as bytes, so a stage can be shown not to have touched it. */
const realIndex = (repo: string): Buffer => fs.readFileSync(path.join(repo, ".git", "index"))

const refusedOf = (answer: GitPreparedReading | GitRunRefusal): GitRefusal => {
  assert.ok("code" in answer, `the stage should have answered with a prepared scope, not ${JSON.stringify(answer)}`)
  return answer as GitRefusal
}

const preparedOf = (answer: GitPreparedReading | GitRunRefusal): GitPreparedReading => {
  const refusal = "code" in answer ? answer as GitRunRefusal : undefined
  assert.ok(refusal === undefined, `the stage should have prepared the scope: ${refusal?.summary} — ${refusal?.output}`)
  return answer as GitPreparedReading
}

interface Project {
  home: string
  repo: string
  service: GitExecutionService
  index: GitOwnershipIndex
  /** A host fact for one path, with the digests the host read. */
  note: (relative: string, pre: string, post: string) => void
  /** The authorization the preflight would issue for exactly this staging call. */
  approve: (call: GitStagingCall) => OperationAuthorization
}

/** A scratch project: the config the shared reader expects, a repository with one commit, and Stage 4's service. */
const withProject = async (files: Record<string, string>, run: (project: Project) => Promise<void>): Promise<void> => {
  const base = scratch("git-staging-")
  const home = path.join(base, "home")
  fs.mkdirSync(path.join(home, ".twinny"), { recursive: true })
  fs.writeFileSync(path.join(home, ".twinny", "config.json"), JSON.stringify({
    git: { workflow: { mode: "local-commits" }, identity: { email: "moriarty@example.org", human: { name: "Ada Human", email: "ada@example.com" } } }
  }))
  const repo = path.join(base, "repo")
  fs.mkdirSync(repo)
  git(repo, ["init", "-q"])
  git(repo, ["config", "user.name", "T"])
  git(repo, ["config", "user.email", "t@example.com"])
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
    fs.writeFileSync(path.join(repo, file), content)
  }
  git(repo, ["add", "."])
  git(repo, ["commit", "-qm", "first"])

  const source = createGitConfigSource(home)
  const baselines = createGitBaselineStore(source, { hostKey: HOST })
  const capture = await baselines.capture(CONVERSATION, repo)
  assert.ok(!("code" in capture), `the baseline should have been captured: ${(capture as GitRefusal).summary}`)
  const ownership = createGitOwnershipStore(baselines)
  const service = createGitExecutionService({
    view: new WorkspaceView(repo),
    configSource: source,
    baselines,
    ownership,
    transactions: createGitTransactionStore("project-staging"),
    conversationId: CONVERSATION,
    hostKey: HOST,
    policy: { approved: true }
  })

  try {
    await run({
      home,
      repo,
      service,
      index: ownership.for(CONVERSATION) as GitOwnershipIndex,
      note: (relative, pre, post) => {
        const fact = (ownership.for(CONVERSATION) as GitOwnershipIndex).note({ conversationId: CONVERSATION, path: relative, provenance: "native_edit", preDigest: pre, postDigest: post })
        assert.ok(!("code" in fact), `the fact should have been recorded: ${(fact as GitRefusal).summary}`)
      },
      approve: (call) => {
        const request: GitPrepareRequest = { kind: "prepare_commit", absolute: path.resolve(call.repository ?? repo), paths: call.paths.map((given) => given.replace(/^\.\/+/, "")) }
        return OperationAuthorization.issue(HOST, [request])
      }
    })
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
}

test("git commit stages exact agent work into the private copy and leaves the user's index alone", async () => {
  await withProject({ "src/a.ts": "original\n" }, async ({ repo, service, note, approve }) => {
    note("src/a.ts", contentDigest("original\n"), contentDigest("agent change\n"))
    fs.writeFileSync(path.join(repo, "src/a.ts"), "agent change\n")
    const before = realIndex(repo)
    const prepared = preparedOf(await service.prepareCommit({ paths: ["src/a.ts"], message: "stage the agent file" }, approve({ paths: ["src/a.ts"], message: "stage the agent file" }), { invocationId: "inv-1" }))
    assert.deepEqual(prepared.selectedFiles, ["src/a.ts"])
    assert.equal(prepared.realIndexPreserved, true, "the reading says what the real index still is")
    assert.equal(realIndex(repo).equals(before), true, "staging wrote nothing to the user's index")
    assert.equal(git(repo, ["status", "--porcelain"]).trim(), "M src/a.ts", "the change is still reported as unstaged work")
    const committed = await service.commit(prepared.operationId, OperationAuthorization.issue(HOST, [{ kind: "commit", absolute: path.resolve(repo), operationId: prepared.operationId }]), { invocationId: "inv-2" })
    assert.equal((committed as { state?: string }).state, "succeeded", JSON.stringify(committed))
    assert.equal(realIndex(repo).equals(before), true, "and the commit still did not write to it")
    const tree = git(repo, ["show", "--format=", "--name-only", "HEAD"]).trim().split("\n")
    assert.deepEqual(tree, ["src/a.ts"], "the commit holds exactly what this stage took")
    assert.equal(git(repo, ["show", "--format=", "HEAD:src/a.ts"]), "agent change\n")
  })
})

test("staging takes only the paths the call named; unrelated work stays out of the prepared scope", async () => {
  await withProject({ "a.ts": "one\n", "b.ts": "two\n" }, async ({ repo, service, note, approve }) => {
    note("a.ts", contentDigest("one\n"), contentDigest("agent line\n"))
    fs.writeFileSync(path.join(repo, "a.ts"), "agent line\n")
    fs.writeFileSync(path.join(repo, "b.ts"), "someone else's change\n")
    const prepared = preparedOf(await service.prepareCommit({ paths: ["a.ts"], message: "only a" }, approve({ paths: ["a.ts"], message: "only a" }), { invocationId: "inv-3" }))
    const entries = prepared.entries ?? []
    assert.deepEqual(entries.filter((entry) => entry.source !== "index").map((entry) => entry.path), ["a.ts"], "the scope is exactly the path this session made")
    assert.ok(entries.some((entry) => entry.path === "b.ts" && entry.source === "index"), "what the user's index already held is carried, not re-staged")
    await service.commit(prepared.operationId, OperationAuthorization.issue(HOST, [{ kind: "commit", absolute: path.resolve(repo), operationId: prepared.operationId }]), { invocationId: "inv-4" })
    assert.equal(git(repo, ["show", "--format=", "HEAD:b.ts"]), "two\n", "the commit carries the version the index already held, not the change this call never took")
    assert.ok(git(repo, ["status", "--porcelain"]).split("\n").includes(" M b.ts"), "the unrelated change is still reported as unstaged work this session never made")
  })
})

test("a whole file is refused when the host cannot prove this session owns it", async () => {
  await withProject({ "a.ts": "original\nsecond\n" }, async ({ repo, service, index, approve }) => {
    fs.writeFileSync(path.join(repo, "a.ts"), "agent line\nsecond\nthird\n")
    const recorded = index.note({ conversationId: CONVERSATION, path: "a.ts", provenance: "native_edit", preDigest: contentDigest("original\nsecond\n"), postDigest: contentDigest("agent line\nsecond\nthird\n") })
    assert.ok(!("code" in recorded))
    const changed = index.note({ conversationId: CONVERSATION, path: "a.ts", provenance: "source_save", postDigest: contentDigest("agent line\nsecond\nthird (saved by the user)\n") })
    assert.ok(!("code" in changed))
    const problem = refusedOf(await service.prepareCommit({ paths: ["a.ts"], message: "mixed file" }, approve({ paths: ["a.ts"], message: "mixed file" }), { invocationId: "inv-5" }))
    assert.equal(problem.code, "git_mixed_ownership", JSON.stringify(problem))
    assert.equal(problem.executed, false)
    assert.equal(git(repo, ["status", "--porcelain"]).trim().split("\n").length, 1, "nothing was staged")
  })
})

test("a verified hunk stages only what the host proved, and a patch that adds something else is refused", async () => {
  await withProject({ "a.ts": "one\ntwo\nthree\n" }, async ({ repo, service, index, approve }) => {
    const call = { paths: ["a.ts"], message: "the verified hunk", hunks: [{ path: "a.ts", patch: "--- a/a.ts\n+++ b/a.ts\n@@ -1,3 +1,3 @@\n one\n-two\n+agent line\n three\n" }] }
    const recorded = index.note({
      conversationId: CONVERSATION,
      path: "a.ts",
      provenance: "native_edit",
      preDigest: contentDigest("one\ntwo\nthree\n"),
      postDigest: contentDigest("one\nagent line\nthree\n"),
      sourceObservationId: "obs-1",
      hunks: [{ path: "a.ts", ownership: "agent", confidence: "verified", digest: contentDigest("agent line\n") }]
    })
    assert.ok(!("code" in recorded), JSON.stringify(recorded))
    const prepared = preparedOf(await service.prepareCommit(call, approve(call), { invocationId: "inv-6" }))
    assert.equal(prepared.entries?.[0].source, "patch", "the scope came from the verified hunk, not from the whole file")
    await service.commit(prepared.operationId, OperationAuthorization.issue(HOST, [{ kind: "commit", absolute: path.resolve(repo), operationId: prepared.operationId }]), { invocationId: "inv-7" })
    assert.equal(git(repo, ["show", "--format=", "HEAD:a.ts"]), "one\nagent line\nthree\n")

    const wrong = { paths: ["a.ts"], message: "something else", hunks: [{ path: "a.ts", patch: "--- a/a.ts\n+++ b/a.ts\n@@ -1,3 +1,3 @@\n one\n-two\n+not what the host proved\n three\n" }] }
    const problem = refusedOf(await service.prepareCommit(wrong, approve(wrong), { invocationId: "inv-8" }))
    assert.equal(problem.code, "git_hunk_patch_mismatch", JSON.stringify(problem))
  })
})

test("a patch named for a path the call did not name to stage is refused", async () => {
  await withProject({ "a.ts": "one\n" }, async ({ service, index, approve }) => {
    index.note({ conversationId: CONVERSATION, path: "a.ts", provenance: "native_edit", preDigest: contentDigest("one\n"), postDigest: contentDigest("two\n") })
    const call = { paths: ["a.ts"], message: "patch for another file", hunks: [{ path: "b.ts", patch: "--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-x\n+y\n" }] }
    const problem = refusedOf(await service.prepareCommit(call, approve(call), { invocationId: "inv-9" }))
    assert.equal(problem.code, "git_hunk_patch_mismatch", JSON.stringify(problem))
  })
})

test("an agent-owned deletion is recorded by name, not by sweeping the tree", async () => {
  await withProject({ "a.ts": "one\n" }, async ({ repo, service, index, approve }) => {
    index.note({ conversationId: CONVERSATION, path: "a.ts", provenance: "native_edit", preDigest: contentDigest("one\n"), postDigest: "" })
    fs.rmSync(path.join(repo, "a.ts"))
    const before = realIndex(repo)
    const call = { paths: ["a.ts"], message: "the file this session removed" }
    const prepared = preparedOf(await service.prepareCommit(call, approve(call), { invocationId: "inv-10" }))
    await service.commit(prepared.operationId, OperationAuthorization.issue(HOST, [{ kind: "commit", absolute: path.resolve(repo), operationId: prepared.operationId }]), { invocationId: "inv-11" })
    assert.equal(git(repo, ["ls-tree", "-r", "HEAD"]).trim(), "", "the commit records the removal")
    assert.equal(realIndex(repo).equals(before), true, "and the removal never touched the user's index")
  })
})

test("a rename pair the host proved is recorded as the pair, not as one new file", async () => {
  await withProject({ "a.ts": "one\n" }, async ({ repo, service, index, approve }) => {
    index.note({ conversationId: CONVERSATION, path: "c.ts", provenance: "native_edit", preDigest: contentDigest("one\n"), postDigest: contentDigest("one renamed\n") })
    index.note({ conversationId: CONVERSATION, path: "a.ts", provenance: "native_edit", preDigest: contentDigest("one\n"), postDigest: "" })
    // What the user's own index already recorded as a pair. This stage copies that state; it does not write the index.
    git(repo, ["mv", "a.ts", "c.ts"])
    fs.writeFileSync(path.join(repo, "c.ts"), "one renamed\n")
    const before = realIndex(repo)
    const call = { paths: ["c.ts"], message: "the file this session renamed" }
    const prepared = preparedOf(await service.prepareCommit(call, approve(call), { invocationId: "inv-12" }))
    assert.ok((prepared.entries ?? []).some((entry) => entry.path === "a.ts" && (entry.basis ?? "").includes("rename pair")), JSON.stringify(prepared.entries))
    await service.commit(prepared.operationId, OperationAuthorization.issue(HOST, [{ kind: "commit", absolute: path.resolve(repo), operationId: prepared.operationId }]), { invocationId: "inv-13" })
    assert.deepEqual(git(repo, ["ls-tree", "-r", "--name-only", "HEAD"]).trim().split("\n"), ["c.ts"], "the commit holds the pair: the name it became, not the name it was")
    assert.equal(realIndex(repo).equals(before), true, "and the user's index is still exactly what it was")
  })
})

test("an add -A equivalent is refused before anything runs", async () => {
  await withProject({ "a.ts": "one\n" }, async ({ repo, service, index, approve }) => {
    index.note({ conversationId: CONVERSATION, path: "a.ts", provenance: "native_edit", preDigest: contentDigest("one\n"), postDigest: contentDigest("two\n") })
    const call = { paths: ["."], message: "everything" }
    const problem = refusedOf(await service.prepareCommit(call, approve(call), { invocationId: "inv-12" }))
    assert.equal(problem.code, "git_add_all_equivalent", JSON.stringify(problem))
    assert.equal(problem.executed, false)
    assert.equal(git(repo, ["status", "--porcelain"]).trim(), "", "nothing was staged")
  })
})

test("an empty prepared scope is refused unless the call said so outright", async () => {
  await withProject({ "a.ts": "one\n" }, async ({ service, index, approve }) => {
    index.note({ conversationId: CONVERSATION, path: "a.ts", provenance: "native_edit", preDigest: contentDigest("one\n"), postDigest: contentDigest("one\n") })
    const call = { paths: ["a.ts"], message: "nothing changed" }
    const problem = refusedOf(await service.prepareCommit(call, approve(call), { invocationId: "inv-13" }))
    assert.equal(problem.code, "git_commit_empty", JSON.stringify(problem))
    const said = preparedOf(await service.prepareCommit({ ...call, allowEmpty: true }, approve({ ...call, allowEmpty: true }), { invocationId: "inv-14" }))
    assert.equal(said.empty, true, "an explicit empty scope is recorded as empty")
  })
})

test("the preflight names the exact staging request, and a read call names none", async () => {
  const root = scratch("git-staging-targets-")
  const staged = accessTargetsOf("git", { operation: "prepare_commit", paths: ["src/a.ts"] }, root)
  assert.equal(staged.length, 1)
  assert.equal(staged[0].access, "write")
  assert.deepEqual((staged[0].git as GitPrepareRequest).paths, ["src/a.ts"])
  assert.equal((staged[0].git as GitPrepareRequest).absolute, path.resolve(root))
  const read = accessTargetsOf("git", { operation: "status", paths: ["src/a.ts"] }, root)
  assert.equal(read[0].access, "read")
  assert.equal(read[0].git, undefined, "a read names no request to spend")
  fs.rmSync(root, { recursive: true, force: true })
})

test("a commit is refused when the user's index changed after the scope was prepared", async () => {
  await withProject({ "a.ts": "original\n" }, async ({ repo, service, note, approve }) => {
    note("a.ts", contentDigest("original\n"), contentDigest("agent change\n"))
    fs.writeFileSync(path.join(repo, "src/a.ts".replace("src/", "")), "ignored")
    const call = { paths: ["a.ts"], message: "the agent file" }
    const prepared = preparedOf(await service.prepareCommit(call, approve(call), { invocationId: "inv-15" }))
    git(repo, ["add", "a.ts"]) // the user stages their own work: the index the stage promised not to write has moved
    const committed = await service.commit(prepared.operationId, OperationAuthorization.issue(HOST, [{ kind: "commit", absolute: path.resolve(repo), operationId: prepared.operationId }]), { invocationId: "inv-16" })
    assert.ok("code" in committed, JSON.stringify(committed))
    assert.equal((committed as GitRefusal).code, "git_real_index_changed")
    assert.equal(git(repo, ["log", "-1", "--format=%s"]).trim(), "first", "nothing was committed")
  })
})
