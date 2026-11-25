/**
 * Stage 2's chat-start baseline and session ownership index, tested on scratch repositories under /tmp.
 * Every case reads a repository the test itself made. None of them stages, commits, pushes or changes a
 * branch: the only thing a snapshot does is what `command-snapshot.ts` already does — write objects to the
 * scratch repository's own object store through a copy of its index, leaving the real index and the user's
 * staging as they were. No case opens a database; each one keeps its project home apart from the repository
 * it reads, and the effective config is read through Stage 1's shared source, never by re-reading
 * `config.json`.
 */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { changesBetween, snapshotTree } from "../../extension/chat/command-snapshot"
import { ReplyChanges } from "../../extension/chat/reply-changes"
import { contentDigest, createGitBaselineStore, GitRefusal, GitSessionCapture } from "../../extension/git/baseline"
import { createGitConfigSource, GitConfigSource } from "../../extension/git/config"
import {
  createGitOwnershipIndex,
  createGitOwnershipStore,
  factFromEditOperation,
  factFromSourceSave,
  factsFromCommandSnapshot,
  factsFromReplyChangeRecord,
  GitOwnershipIndex
} from "../../extension/git/ownership"

const SECRET = "s3cret-askpass-value-that-must-never-be-printed"

const scratch = (prefix: string): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))

/** A project home with the folder the shared reader expects, and nothing else. */
const projectHome = (prefix: string): string => {
  const home = scratch(prefix)
  fs.mkdirSync(path.join(home, ".twinny"), { recursive: true })
  return home
}

/** Reading a config must not create a project database. */
const noDatabase = (home: string): void =>
  assert.deepEqual(fs.readdirSync(path.join(home, ".twinny")).filter((name) => name !== "config.json"), [], "the baseline created no project database")

const captureOf = async (conversationId: string, root: string, source: GitConfigSource): Promise<GitSessionCapture> => {
  const capture = await createGitBaselineStore(source).capture(conversationId, root)
  if ("code" in capture) {
    const problem = refused(capture)
    assert.fail(`the baseline should have been read: ${problem.summary} — ${problem.output}`)
    throw new Error(problem.summary)
  }
  return capture
}

const refused = (decision: unknown): GitRefusal => {
  assert.ok(typeof decision === "object" && decision !== null && typeof (decision as GitRefusal).code === "string", `expected a refusal, got ${String(decision)}`)
  return decision as GitRefusal
}

const withScratch = async (prefix: string, run: (root: string) => Promise<void>): Promise<void> => {
  const root = scratch(prefix)
  try { await run(root) } finally { fs.rmSync(root, { recursive: true, force: true }) }
}

/** A scratch repository with one commit. The test writes into it; nothing here commits or pushes. */
const withRepository = async (
  files: Record<string, string>,
  run: (repo: { root: string; git: (...args: string[]) => string; write: (file: string, content: string) => void }) => Promise<void>
): Promise<void> => {
  const root = scratch("git-baseline-")
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" }).toString()
  const write = (file: string, content: string): void => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), content)
  }
  git("init", "-q")
  git("config", "user.email", "t@example.com")
  git("config", "user.name", "T")
  for (const [file, content] of Object.entries(files)) write(file, content)
  git("add", ".")
  git("commit", "-qm", "first")
  try { await run({ root, git, write }) } finally { fs.rmSync(root, { recursive: true, force: true }) }
}

test("git baseline captures clean repository", async () => {
  const home = projectHome("git-baseline-home-")
  await withRepository({ ".gitignore": "dist/\n", "src/a.ts": "one\n" }, async ({ root, git }) => {
    const indexBytes = fs.readFileSync(path.join(root, ".git", "index"))
    const statusBefore = git("status", "--porcelain=v1", "-z")
    const capture = await captureOf("conversation-clean", root, createGitConfigSource(home))
    assert.equal(capture.baseline.conversationId, "conversation-clean")
    assert.equal(capture.baseline.repositoryTop, root)
    assert.equal(capture.baseline.headBefore, git("rev-parse", "HEAD").trim())
    assert.equal(capture.baseline.branchBefore, git("branch", "--show-current").trim())
    assert.deepEqual(capture.baseline.staged, [], "a clean baseline claims no change")
    assert.deepEqual(capture.baseline.unstaged, [])
    assert.deepEqual(capture.baseline.untracked, [], "an ignored file is not listed as untracked")
    assert.equal(capture.baseline.realIndexDigest, createHash("sha256").update(indexBytes).digest("hex"), "the real index is hashed as it sits on disk")
    const snapshot = await snapshotTree(root)
    assert.ok(snapshot)
    assert.equal(capture.baseline.workingTreeSnapshot, snapshot!.tree, "the working tree is the snapshot command changes already take")

    // Reading a baseline changes nothing.
    assert.equal(fs.readFileSync(path.join(root, ".git", "index")).equals(indexBytes), true, "the real index was not rewritten")
    assert.equal(git("status", "--porcelain=v1", "-z"), statusBefore, "nothing was staged or unstaged")
    assert.equal(git("rev-parse", "HEAD").trim(), capture.baseline.headBefore, "no commit was made")
    noDatabase(home)
  })
  fs.rmSync(home, { recursive: true, force: true })
})

test("git baseline captures staged unstaged and untracked", async () => {
  const home = projectHome("git-baseline-dirty-")
  await withRepository({ "a.ts": "one\n", "b.ts": "two\n", "old.ts": "gone\n" }, async ({ root, git, write }) => {
    write("a.ts", "staged change\n")
    git("add", "a.ts")
    write("b.ts", "unstaged change\n")
    write("new.ts", "made before the session\n")
    git("mv", "old.ts", "renamed.ts")
    const stagedBefore = git("diff", "--cached", "--name-status", "-z")
    const capture = await captureOf("conversation-dirty", root, createGitConfigSource(home))
    assert.deepEqual(capture.baseline.staged.map((change) => [change.path, change.status, change.side]), [["a.ts", "modified", "staged"], ["renamed.ts", "renamed", "staged"]], "both sides come from git's own classification")
    assert.deepEqual(capture.baseline.unstaged.map((change) => [change.path, change.status]), [["b.ts", "modified"]])
    assert.deepEqual(capture.baseline.untracked, ["new.ts"])
    const rename = capture.baseline.staged.find((change) => change.status === "renamed")!
    assert.equal(rename.path, "renamed.ts")
    assert.equal(rename.from, "old.ts", "the pair git printed is kept as git gave it")
    assert.equal(capture.baseline.staged[0].digest, contentDigest("staged change\n"), "the digest is what the host read, so an edit fact can compare with it")
    assert.equal(git("diff", "--cached", "--name-status", "-z"), stagedBefore, "reading the baseline left the user's staging as it was")
    noDatabase(home)
  })
  fs.rmSync(home, { recursive: true, force: true })
})

test("git ownership marks native edit agent", async () => {
  const home = projectHome("git-baseline-edit-")
  await withRepository({ "src/a.ts": "original\n" }, async ({ root, write }) => {
    const capture = await captureOf("conversation-edit", root, createGitConfigSource(home))
    const index = createGitOwnershipIndex(capture)
    const changes = new ReplyChanges(root)
    await changes.touch(path.join(root, "src/a.ts"))
    write("src/a.ts", "edited by the agent\n")
    const record = await changes.record()
    assert.ok(record)
    for (const fact of factsFromReplyChangeRecord(record!, "conversation-edit")) {
      const answer = index.note(fact)
      assert.ok(!("code" in answer), JSON.stringify(answer))
      if ("code" in answer) continue
      assert.equal(answer.ownership, "agent", "what the reply touched first is the agent's own change")
      assert.equal(answer.confidence, "verified", "the fact carries both sides it read")
    }
    // The apply-mode edit ledger answers for its own operation, on the same path.
    const ledger = { id: "operation-1", target: "src/a.ts", mode: "apply" as const, preDigest: contentDigest("original\n"), postDigest: contentDigest("edited by the agent\n") }
    const settled = index.note(factFromEditOperation("conversation-edit", ledger, path.join(root, "src/a.ts")))
    assert.ok(!("code" in settled))
    assert.equal((settled as { ownership: string }).ownership, "agent")
    assert.equal(index.transitions()[1].kind, "same_owner", "the second host source restates the same change instead of opening a gap")
    assert.equal(index.transitions()[1].origin, "edit_ledger")
    const claim = index.claimFor("src/a.ts")
    assert.ok("allowed" in claim && claim.allowed, `a wholly agent-owned file may be claimed: ${String(claim)}`)
    noDatabase(home)
  })
  fs.rmSync(home, { recursive: true, force: true })
})

test("git ownership marks command snapshot agent", async () => {
  const home = projectHome("git-baseline-command-")
  await withRepository({ "a.ts": "before the command\n" }, async ({ root, write }) => {
    const capture = await captureOf("conversation-command", root, createGitConfigSource(home))
    const index = createGitOwnershipIndex(capture)
    const before = await snapshotTree(root)
    assert.ok(before)
    write("a.ts", "after the command\n")
    const after = await snapshotTree(root)
    assert.ok(after)
    const changed = await changesBetween(before!, after!)
    assert.ok(changed)
    for (const fact of factsFromCommandSnapshot(before!, after!, changed, "conversation-command")) {
      const answer = index.note(fact)
      assert.ok(!("code" in answer))
      if ("code" in answer) continue
      assert.equal(answer.ownership, "agent", "the before/after evidence is the host's own")
      assert.equal(answer.confidence, "verified")
      assert.equal(answer.path, "a.ts")
    }
    const fact = factsFromCommandSnapshot(before!, after!, changed, "conversation-command")[0]
    assert.equal(fact.beforeSnapshot, before!.tree, "the two snapshots a change was read from are kept with the fact")
    assert.equal(fact.afterSnapshot, after!.tree)
    noDatabase(home)
  })
  fs.rmSync(home, { recursive: true, force: true })
})

test("git ownership survives model change", async () => {
  const home = projectHome("git-baseline-model-")
  await withRepository({ "a.ts": "original\n" }, async ({ root, write }) => {
    const source = createGitConfigSource(home)
    const store = createGitBaselineStore(source, { hostKey: "host-a", model: { provider: "local", name: "first model" } })
    const capture = await store.capture("conversation-model", root)
    assert.ok(!("code" in capture))
    if ("code" in capture) return
    const held = JSON.parse(JSON.stringify(capture.baseline))
    const index = createGitOwnershipStore(store).for("conversation-model")
    assert.ok(!("code" in index))
    if ("code" in index) return
    const first = (index as GitOwnershipIndex).note({ conversationId: "conversation-model", path: "a.ts", provenance: "native_edit", preDigest: contentDigest("original\n"), postDigest: contentDigest("agent line\n") })
    write("a.ts", "agent line\n")
    const second = (index as GitOwnershipIndex).note({ conversationId: "conversation-model", path: "b.ts", provenance: "source_save", postDigest: contentDigest("saved by the user\n"), model: { provider: "other", name: "second model" } })
    assert.ok(!("code" in first) && !("code" in second))
    assert.deepEqual(JSON.parse(JSON.stringify(capture.baseline)), held, "pruning context or changing model does not move the baseline")
    assert.equal((capture as GitSessionCapture).model?.name, "first model", "the provenance recorded at capture time is the host's own")
    const again = await store.capture("conversation-model", root)
    assert.equal(again === capture, true, "a conversation that already has a baseline answers with the one it captured")
    assert.ok(!("code" in first) && (first as { ownership: string }).ownership === "agent")
    noDatabase(home)
  })
  fs.rmSync(home, { recursive: true, force: true })
})

test("git ownership keeps multiple conversations separate", async () => {
  const home = projectHome("git-baseline-two-")
  await withRepository({ "a.ts": "original\n" }, async ({ root, write }) => {
    const source = createGitConfigSource(home)
    const store = createGitBaselineStore(source)
    const indexes = createGitOwnershipStore(store)
    const first = await store.capture("conversation-one", root)
    const second = await store.capture("conversation-two", root)
    assert.ok(!("code" in first) && !("code" in second))
    if ("code" in first || "code" in second) return
    const a = indexes.for("conversation-one") as GitOwnershipIndex
    const b = indexes.for("conversation-two") as GitOwnershipIndex
    assert.notEqual(a.sessionId, b.sessionId, "two conversations keep two baselines")
    write("a.ts", "changed by the first conversation\n")
    a.note({ conversationId: "conversation-one", path: "a.ts", provenance: "native_edit", preDigest: contentDigest("original\n"), postDigest: contentDigest("changed by the first conversation\n") })
    assert.equal(a.change("a.ts")?.ownership, "agent")
    assert.equal(b.change("a.ts"), undefined, "the second conversation owns nothing the first one changed")
    assert.equal(refused(b.claimFor("a.ts")).code, "git_ownership_unknown")
    const crossed = b.note({ conversationId: "conversation-one", path: "a.ts", provenance: "native_edit" })
    assert.ok("code" in crossed)
    assert.equal(refused(crossed).code, "git_ownership_other_conversation", "a fact cannot be read into another conversation's baseline")
    noDatabase(home)
  })
  fs.rmSync(home, { recursive: true, force: true })
})

test("git baseline does not claim preexisting changes", async () => {
  const home = projectHome("git-baseline-preexisting-")
  await withRepository({ "a.ts": "one\n" }, async ({ root, git, write }) => {
    write("a.ts", "work already staged before the session\n")
    git("add", "a.ts")
    const capture = await captureOf("conversation-preexisting", root, createGitConfigSource(home))
    const index = createGitOwnershipIndex(capture)
    assert.equal(index.change("a.ts")?.ownership, "unknown", "what was already changed is not agent-owned by itself")
    assert.notEqual(index.change("a.ts")?.ownership, "agent")
    assert.equal(refused(index.claimFor("a.ts")).code, "git_ownership_unknown", "nothing here infers an owner")
    // A host fact that names what the baseline already had says who made the starting change.
    const named = index.note({ conversationId: "conversation-preexisting", path: "a.ts", provenance: "source_save", postDigest: capture.baseline.staged[0].digest })
    assert.ok(!("code" in named))
    assert.equal((named as { ownership: string }).ownership, "human", "the origin is named by the host, not guessed")
    assert.equal(refused(index.claimFor("a.ts")).code, "git_not_agent_owned")
    noDatabase(home)
  })
  fs.rmSync(home, { recursive: true, force: true })
})

test("git ownership refuses unknown mixed file", async () => {
  const home = projectHome("git-baseline-mixed-")
  await withRepository({ "a.ts": "original\n" }, async ({ root, write }) => {
    const capture = await captureOf("conversation-mixed", root, createGitConfigSource(home))
    const index = createGitOwnershipIndex(capture)
    write("a.ts", "the agent's part\n")
    index.note({ conversationId: "conversation-mixed", path: "a.ts", provenance: "native_edit", preDigest: contentDigest("original\n"), postDigest: contentDigest("the agent's part\n"), hunks: [{ path: "a.ts", startLine: 1, endLine: 1, ownership: "agent", confidence: "verified" }] })
    // Something else changed the file after that, and no host source says who.
    const gap = index.note({ conversationId: "conversation-mixed", path: "a.ts", provenance: "source_save", preDigest: contentDigest("something unreadable here\n"), postDigest: contentDigest("and then this\n") })
    assert.ok(!("code" in gap))
    assert.equal((gap as { ownership: string }).ownership, "mixed", "two owners on one path")
    const claim = index.claimFor("a.ts")
    assert.ok("code" in claim)
    assert.equal(refused(claim).code, "git_mixed_ownership")
    assert.ok(/select hunks or choose an explicit authorship/i.test(refused(claim).output), refused(claim).output)
    // Splitting names only what its own evidence proved hunk by hunk; what nobody attributed is not
    // claimed by it, and a file with no hunk evidence needs an explicit authorship.
    const split = index.splitFor("a.ts")
    assert.deepEqual(split, { allowed: true, hunks: [{ path: "a.ts", startLine: 1, endLine: 1, ownership: "agent", confidence: "verified" }] }, "the verified agent hunk is what a split can name")
    write("b.ts", "the agent's part of b\n")
    index.note({ conversationId: "conversation-mixed", path: "b.ts", provenance: "native_edit", preDigest: contentDigest("original\n"), postDigest: contentDigest("the agent's part of b\n") })
    index.note({ conversationId: "conversation-mixed", path: "b.ts", provenance: "source_save", preDigest: contentDigest("a line nobody named\n"), postDigest: contentDigest("and then this\n") })
    assert.equal(refused(index.splitFor("b.ts")).code, "git_hunk_selection_required", "nothing was verified hunk by hunk, so the split needs an explicit authorship")
    write("c.ts", "the agent's part of c\n")
    index.note({ conversationId: "conversation-mixed", path: "c.ts", provenance: "native_edit", preDigest: contentDigest("original\n"), postDigest: contentDigest("the agent's part of c\n"), hunks: [{ path: "c.ts", ownership: "unknown", confidence: "uncertain" }] })
    index.note({ conversationId: "conversation-mixed", path: "c.ts", provenance: "source_save", postDigest: contentDigest("and then this\n") })
    assert.equal(refused(index.splitFor("c.ts")).code, "git_hunk_selection_required", "an unverified hunk is not claimed as the agent's either")
    const unknown = index.claimFor("never-touched.ts")
    assert.equal(refused(unknown).code, "git_ownership_unknown", "a path with no fact and no baseline change is not claimed")
    noDatabase(home)
  })
  fs.rmSync(home, { recursive: true, force: true })
})

test("git ownership does not claim later external edit", async () => {
  const home = projectHome("git-baseline-external-")
  await withRepository({ "a.ts": "original\n", "b.ts": "other file\n" }, async ({ root, write }) => {
    const capture = await captureOf("conversation-external", root, createGitConfigSource(home))
    const index = createGitOwnershipIndex(capture)
    write("a.ts", "the agent's part\n")
    index.note({ conversationId: "conversation-external", path: "a.ts", provenance: "native_edit", preDigest: contentDigest("original\n"), postDigest: contentDigest("the agent's part\n") })
    write("a.ts", "then the user saved it\n")
    const later = index.note(factFromSourceSave(path.join(root, "a.ts"), "conversation-external", contentDigest("then the user saved it\n")))
    assert.ok(!("code" in later))
    assert.equal((later as { ownership: string }).ownership, "mixed", "the file holds both, and neither is erased by the other")
    assert.equal(refused(index.claimFor("a.ts")).code, "git_mixed_ownership", "the later external part is not claimed as agent work")
    // The agent's own file, untouched by anyone else, is still claimable.
    write("b.ts", "the agent's other file\n")
    index.note({ conversationId: "conversation-external", path: "b.ts", provenance: "command_snapshot", preDigest: contentDigest("other file\n"), postDigest: contentDigest("the agent's other file\n") })
    const claim = index.claimFor("b.ts")
    assert.ok("allowed" in claim && claim.allowed, JSON.stringify(claim))
    noDatabase(home)
  })
  fs.rmSync(home, { recursive: true, force: true })
})

test("git baseline ignores unrelated repository", async () => {
  const home = projectHome("git-baseline-unrelated-")
  await withRepository({ "a.ts": "one\n" }, async ({ root, git }) => {
    const source = createGitConfigSource(home)
    const store = createGitBaselineStore(source)
    const statusBefore = git("status", "--porcelain=v1", "-z")
    const capture = await store.capture("conversation-first", root)
    assert.ok(!("code" in capture))
    if ("code" in capture) return
    const other = await withOther()
    const crossed = await store.capture("conversation-first", other)
    assert.ok("code" in crossed)
    assert.equal(refused(crossed).code, "git_baseline_other_repository", "one conversation keeps one repository")
    assert.equal(store.capturedFor("conversation-first") === capture, true, "the baseline it already read is not moved")
    const index = createGitOwnershipIndex(capture)
    assert.equal(refused(index.note({ conversationId: "conversation-first", file: path.join(other, "elsewhere.ts"), provenance: "native_edit" })).code, "git_ownership_path_outside_repository", "a path in another repository is not this session's")
    assert.equal(git("status", "--porcelain=v1", "-z"), statusBefore, "reading another repository changed nothing in this one")
    noDatabase(home)
  })
  fs.rmSync(home, { recursive: true, force: true })
})

const withOther = async (): Promise<string> => {
  const root = scratch("git-baseline-other-")
  execFileSync("git", ["init", "-q"], { cwd: root, stdio: "pipe" })
  fs.writeFileSync(path.join(root, "elsewhere.ts"), "in another repository\n")
  return root
}

test("git baseline refuses a folder that is not a repository", async () => {
  const home = projectHome("git-baseline-norepository-")
  await withScratch("git-baseline-norepo-", async (root) => {
    const answer = await createGitBaselineStore(createGitConfigSource(home)).capture("conversation-none", root)
    assert.ok("code" in answer)
    const problem = refused(answer)
    assert.equal(problem.code, "git_baseline_no_repository")
    assert.equal(problem.executed, false, "a baseline never runs anything that could change a repository")
    assert.ok(/nothing was read/i.test(`${problem.summary} ${problem.output}`), `${problem.summary} ${problem.output}`)
    noDatabase(home)
  })
  fs.rmSync(home, { recursive: true, force: true })
})

test("git ownership refuses a claim that is not host-derived", async () => {
  const home = projectHome("git-baseline-inferred-")
  await withRepository({ "a.ts": "one\n" }, async ({ root }) => {
    const capture = await captureOf("conversation-inferred", root, createGitConfigSource(home))
    const index = createGitOwnershipIndex(capture)
    const answer = index.note({ conversationId: "conversation-inferred", path: "a.ts", provenance: "model_claim", postDigest: contentDigest("one\n") })
    assert.ok("code" in answer)
    assert.equal(refused(answer).code, "git_ownership_not_host_derived")
    assert.ok(/does not infer an owner/i.test(refused(answer).output), refused(answer).output)
    assert.equal(index.change("a.ts"), undefined, "and nothing was recorded from it")
    noDatabase(home)
  })
  fs.rmSync(home, { recursive: true, force: true })
})

test("git baseline reads config through the shared source and never prints a credential value", async () => {
  const home = projectHome("git-baseline-config-")
  fs.writeFileSync(path.join(home, ".twinny", "config.json"), JSON.stringify({ git: { auth: { mode: "environment", env: { GIT_HTTP_EXTRA_HEADER: { env: "MORIARTY_GIT_HTTP_EXTRA_HEADER" } } } } }))
  process.env.MORIARTY_GIT_HTTP_EXTRA_HEADER = SECRET
  await withRepository({ "a.ts": "one\n" }, async ({ root }) => {
    const inner = createGitConfigSource(home)
    let reads = 0
    const counting: GitConfigSource = { effective: async () => { reads++; return inner.effective() }, last: () => inner.last() }
    const store = createGitBaselineStore(counting, { hostKey: "host-a", model: { provider: "local", name: "moriarty" } })
    const capture = await store.capture("conversation-config", root)
    assert.ok(!("code" in capture))
    if ("code" in capture) return
    assert.equal(capture.config === inner.last(), true, "the reading came from the shared source, not from a second read of the file")
    assert.equal(reads, 1)
    await store.capture("conversation-config", root)
    assert.equal(reads, 1, "a conversation that already has a baseline does not read the config again")
    const line = store.describe("conversation-config")
    assert.ok(/GIT_HTTP_EXTRA_HEADER->MORIARTY_GIT_HTTP_EXTRA_HEADER/.test(line), line)
    assert.equal(line.includes(SECRET), false, "the diagnostic names the reference, never what it holds")
    assert.equal(JSON.stringify(capture).includes(SECRET), false, "and the reading carries no value either")
    const invalid = projectHome("git-baseline-invalid-")
    fs.writeFileSync(path.join(invalid, ".twinny", "config.json"), JSON.stringify({ git: { identity: { tagging: "yes" } } }))
    const invalidStore = createGitBaselineStore(createGitConfigSource(invalid))
    const reported = await invalidStore.capture("conversation-invalid", root)
    assert.ok(!("code" in reported))
    if ("code" in reported) return
    assert.equal(reported.config.state, "invalid", "an invalid value is read as it stands, not fallen back on")
    const invalidLine = invalidStore.describe("conversation-invalid")
    assert.ok(/git\.identity\.tagging must be true or false/.test(invalidLine), invalidLine)
    assert.equal(invalidLine.includes(SECRET), false, "and the invalid reading prints no credential value either")
    assert.ok(!/must be true or false/.test(store.describe("conversation-config")), "the invalid file is reported for its own conversation, not through another one's baseline")
    noDatabase(home)
    fs.rmSync(invalid, { recursive: true, force: true })
  })
  delete process.env.MORIARTY_GIT_HTTP_EXTRA_HEADER
  fs.rmSync(home, { recursive: true, force: true })
})

test("git baseline records clean-to-dirty and dirty-to-mixed transitions", async () => {
  const home = projectHome("git-baseline-transitions-")
  await withRepository({ "a.ts": "original\n", "b.ts": "already changed\n" }, async ({ root, git, write }) => {
    write("b.ts", "staged before the session\n")
    git("add", "b.ts")
    const capture = await captureOf("conversation-transitions", root, createGitConfigSource(home))
    const index = createGitOwnershipIndex(capture)
    write("a.ts", "the agent's change\n")
    index.note({ conversationId: "conversation-transitions", path: "a.ts", provenance: "native_edit", preDigest: contentDigest("original\n"), postDigest: contentDigest("the agent's change\n") })
    index.note(factFromSourceSave(path.join(root, "a.ts"), "conversation-transitions", contentDigest("and then the user saved it\n")))
    const kinds = index.transitions().map((transition) => [transition.path, transition.from, transition.to, transition.kind])
    assert.deepEqual(kinds, [["a.ts", "clean", "agent", "clean_to_dirty"], ["a.ts", "agent", "mixed", "dirty_to_mixed"]], "the path went from clean to dirty, then to mixed")
    assert.equal(index.transitions()[1].origin, "source_save")
    noDatabase(home)
  })
  fs.rmSync(home, { recursive: true, force: true })
})
