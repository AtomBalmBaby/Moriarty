/**
 * Stage 4's transaction store and the recovery that reads from it: one record per prepared operation, moves
 * only along the states §10.2 names, a duplicate call answered as a status check, recovery read from what the
 * repository actually holds, and private scratch copies removed when an operation ends. Every case runs
 * against a repository created under /tmp; nothing here touches the development repository, and no case opens
 * a database.
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
import { createGitExecutionService, GitStagingCall } from "../../extension/git/service"
import { COMMIT_TRANSITIONS, createGitTransactionStore, GitCommitRecord, GitPreparedReading } from "../../extension/git/transaction"
import { OperationAuthorization } from "../../extension/tools/operation-authorization"
import { WorkspaceView } from "../../extension/tools/view"

const HOST = "local|test"
const CONVERSATION = "conversation-transaction"

const scratch = (prefix: string): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))

const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, stdio: "pipe" }).toString()

const codeOf = (answer: GitRefusal | { code?: string }): string | undefined => answer.code
const commitsIn = (repo: string): number => git(repo, ["log", "--format=%H"]).trim().split("\n").filter((line) => line !== "").length

interface Harness {
  repo: string
  service: ReturnType<typeof createGitExecutionService>
  store: ReturnType<typeof createGitTransactionStore>
  /** Record another host fact for a path the index already has. */
  note: (relative: string, pre: string, post: string, extraPost?: string) => void
}

/** A scratch repository with one commit and one path the host proved as this session's work. */
const withHarness = async (run: (harness: Harness) => Promise<void>, policy: { approved?: boolean; restrictions?: { noCommit?: boolean }; mode?: string; auth?: boolean } = {}): Promise<void> => {
  const base = scratch("git-transaction-")
  const home = path.join(base, "home")
  fs.mkdirSync(path.join(home, ".twinny"), { recursive: true })
  fs.writeFileSync(path.join(home, ".twinny", "config.json"), JSON.stringify({ git: { workflow: { mode: policy.mode ?? "local-commits" }, identity: { email: "moriarty@example.org", human: { name: "Ada Human", email: "ada@example.com" }, ...(policy.auth ? { auth: { mode: "environment", env: { GIT_HTTP_EXTRA_HEADER: "MORIARTY_TEST_SECRET" } } } : {}) } } }))
  const repo = path.join(base, "repo")
  fs.mkdirSync(repo)
  git(repo, ["init", "-q"])
  git(repo, ["config", "user.name", "T"])
  git(repo, ["config", "user.email", "t@example.com"])
  fs.writeFileSync(path.join(repo, "a.ts"), "original\n")
  git(repo, ["add", "."])
  git(repo, ["commit", "-qm", "first"])

  const source = createGitConfigSource(home)
  const baselines = createGitBaselineStore(source, { hostKey: HOST })
  const capture = await baselines.capture(CONVERSATION, repo)
  assert.ok(!("code" in capture), JSON.stringify(capture))
  const ownership = createGitOwnershipStore(baselines)
  const index = ownership.for(CONVERSATION) as GitOwnershipIndex
  assert.ok(!("code" in index), JSON.stringify(index))
  fs.writeFileSync(path.join(repo, "a.ts"), "agent change\n")
  const fact = index.note({ conversationId: CONVERSATION, path: "a.ts", provenance: "native_edit", preDigest: contentDigest("original\n"), postDigest: contentDigest("agent change\n") })
  assert.ok(!("code" in fact), JSON.stringify(fact))

  const store = createGitTransactionStore("project-transaction")
  const service = createGitExecutionService({
    view: new WorkspaceView(repo),
    configSource: source,
    baselines,
    ownership,
    transactions: store,
    conversationId: CONVERSATION,
    hostKey: HOST,
    scratch: path.join(base, "scratch"),
    policy: { approved: policy.approved ?? true, ...(policy.restrictions === undefined ? {} : { restrictions: policy.restrictions }) }
  })

  try {
    await run({
      repo,
      service,
      store,
      note: (relative, pre, post, extraPost) => {
        const answer = index.note({ conversationId: CONVERSATION, path: relative, provenance: "source_save", preDigest: pre, postDigest: post, ...(extraPost === undefined ? {} : { extraPost }) })
        assert.ok(!("code" in answer), JSON.stringify(answer))
      }
    })
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
}
/** A staging call carried to the service the way the tool carries it. */
const prepareWith = async (harness: Harness, call: GitStagingCall): Promise<GitPreparedReading> => {
  const authorization = OperationAuthorization.issue(HOST, [{ kind: "prepare_commit", absolute: path.resolve(harness.repo), paths: [...call.paths] }])
  const answer = await harness.service.prepareCommit(call, authorization, { invocationId: "inv-1" })
  assert.ok(!("code" in answer), JSON.stringify(answer))
  return answer as GitPreparedReading
}

/** A commit call, and what it answers with when it refuses instead. */
const commitWith = async (harness: Harness, operationId: string, invocationId = "inv-1"): Promise<{ state?: string; code?: string; duplicate?: boolean }> => {
  const authorization = OperationAuthorization.issue(HOST, [{ kind: "commit", absolute: path.resolve(harness.repo), operationId }])
  const answer = await harness.service.commit(operationId, authorization, { invocationId })
  return "code" in answer ? { code: codeOf(answer) } : { state: answer.state, ...(answer.duplicate === undefined ? {} : { duplicate: answer.duplicate }) }
}

test("the record a staging call leaves is what the commit dispatch runs from", async () => {
  await withHarness(async (harness) => {
    const prepared = await prepareWith(harness, { paths: ["a.ts"], message: "the agent's change" })
    const record = harness.store.get(prepared.operationId) as GitCommitRecord
    assert.equal(record.state, "prepared", "the operation is recorded before any commit runs")
    assert.equal(record.invocationId, "inv-1", "and names the call that prepared it")
    assert.ok(record.entries.some((entry) => entry.path === "a.ts" && entry.source === "working"), JSON.stringify(record.entries))
    assert.equal(record.selectedDiffSha256, prepared.selectedDiffSha256)
  })
})

test("a duplicate call for an operation that already ended answers as a status check", async () => {
  await withHarness(async (harness) => {
    const prepared = await prepareWith(harness, { paths: ["a.ts"], message: "the agent's change" })
    const first = await commitWith(harness, prepared.operationId)
    assert.equal(first.state, "succeeded", JSON.stringify(first))
    const again = await commitWith(harness, prepared.operationId, "inv-2")
    assert.equal(again.duplicate, true, "the second call says it is answering from the state the record had")
    assert.equal(again.state, "succeeded")
    assert.equal(commitsIn(harness.repo), 2, "and no second commit was made")
  })
})

test("an interrupted operation is read from what the repository holds before anything else is claimed", async () => {
  await withHarness(async (harness) => {
    const prepared = await prepareWith(harness, { paths: ["a.ts"], message: "the agent's change, interrupted" })
    const record = harness.store.get(prepared.operationId) as GitCommitRecord
    const authorized = harness.store.transition(record.id, "authorized", record.invocationId)
    assert.ok(!("code" in authorized), JSON.stringify(authorized))
    const running = harness.store.transition((authorized as GitCommitRecord).id, "running", (authorized as GitCommitRecord).invocationId)
    assert.ok(!("code" in running), JSON.stringify(running))
    // Something else wrote the commit this operation had prepared. Recovery reads it rather than making another.
    const sha = git(harness.repo, ["commit-tree", record.alternateTree, "-p", record.headBefore ?? "", "-m", record.message]).trim()
    git(harness.repo, ["update-ref", "HEAD", sha])
    const settled = await harness.service.recover(record.id, { invocationId: "inv-2" })
    assert.ok(!("code" in settled), JSON.stringify(settled))
    assert.equal((settled as { state?: string }).state, "succeeded")
    assert.ok(((settled as { inspected?: string }).inspected ?? "").includes(sha), "recovery names what it read")
    assert.equal(commitsIn(harness.repo), 2, "and made nothing of its own")
  })
})

test("a verified absence is reported as a failure, not as a guess", async () => {
  await withHarness(async (harness) => {
    const prepared = await prepareWith(harness, { paths: ["a.ts"], message: "nothing was committed here" })
    const record = harness.store.get(prepared.operationId) as GitCommitRecord
    assert.ok(COMMIT_TRANSITIONS[record.state].includes("authorized"), "a prepared record moves only through the states the table names")
    const moved = harness.store.transition(record.id, "authorized", record.invocationId)
    const running = harness.store.transition((moved as GitCommitRecord).id, "running", (moved as GitCommitRecord).invocationId)
    assert.ok(!("code" in running), JSON.stringify(running))
    const answer = await harness.service.recover(record.id, { invocationId: "inv-2" })
    assert.ok(!("code" in answer), JSON.stringify(answer))
    assert.equal((answer as { state?: string }).state, "failed")
    assert.ok(((answer as { reason?: string }).reason ?? "").includes("no commit"), JSON.stringify(answer))
  })
})

test("a record cannot move on from a terminal state, and cancel removes its private copy", async () => {
  await withHarness(async (harness) => {
    const prepared = await prepareWith(harness, { paths: ["a.ts"], message: "cancelled before commit" })
    const record = harness.store.get(prepared.operationId) as GitCommitRecord
    const answer = await harness.service.cancelCommit(record.id, "the user stopped this operation", { invocationId: "inv-2" })
    assert.ok(!("code" in answer), JSON.stringify(answer))
    assert.equal((answer as { state?: string }).state, "refused")
    assert.equal(commitsIn(harness.repo), 1, "nothing was committed")
    assert.equal(fs.existsSync(record.scratchIndex), false, "the private index copy is removed when the operation ends")
    const again = harness.store.transition(record.id, "authorized", record.invocationId)
    assert.ok("code" in again, JSON.stringify(again))
    assert.equal((again as { code?: string }).code, "git_transaction_bad_transition")
  })
})

test("another invocation cannot re-own a record this one prepared", async () => {
  await withHarness(async (harness) => {
    const prepared = await prepareWith(harness, { paths: ["a.ts"], message: "an operation this call owns" })
    const record = harness.store.get(prepared.operationId) as GitCommitRecord
    const foreign = harness.store.transition(record.id, "authorized", "some-other-invocation")
    assert.ok("code" in foreign, JSON.stringify(foreign))
    assert.equal((foreign as { code?: string }).code, "git_transaction_other_conversation")
  })
})

test("a preset that needs an approval refuses the commit until the call is approved", async () => {
  await withHarness(async (harness) => {
    const prepared = await prepareWith(harness, { paths: ["a.ts"], message: "needs approval" })
    const answer = await commitWith(harness, prepared.operationId)
    assert.equal(answer.code, "git_approval_required", JSON.stringify(answer))
  }, { mode: "manual-approval", approved: false })
})

test("commit re-reads what preparation recorded before it writes anything", async () => {
  await withHarness(async (harness) => {
    const prepared = await prepareWith(harness, { paths: ["a.ts"], message: "the agent's change" })
    git(harness.repo, ["commit", "--allow-empty", "-qm", "someone else's commit"])
    const moved = await commitWith(harness, prepared.operationId, "inv-2")
    assert.equal(moved.code, "git_head_changed", JSON.stringify(moved))
    assert.equal(commitsIn(harness.repo), 2, "the recheck committed nothing of its own")
  })
})

test("a selected file that changed after preparation is refused at commit", async () => {
  await withHarness(async (harness) => {
    const prepared = await prepareWith(harness, { paths: ["a.ts"], message: "the agent's change" })
    fs.writeFileSync(path.join(harness.repo, "a.ts"), "the human changed it again\n")
    const answer = await commitWith(harness, prepared.operationId, "inv-2")
    assert.equal(answer.code, "git_selected_file_changed", JSON.stringify(answer))
    assert.equal(commitsIn(harness.repo), 1, "nothing was committed on a scope that no longer matches")
  })
})

test("the user's own index moving after preparation is refused at commit", async () => {
  await withHarness(async (harness) => {
    const prepared = await prepareWith(harness, { paths: ["a.ts"], message: "the agent's change" })
    git(harness.repo, ["add", "a.ts"])
    const answer = await commitWith(harness, prepared.operationId, "inv-2")
    assert.equal(answer.code, "git_real_index_changed", JSON.stringify(answer))
    assert.equal(commitsIn(harness.repo), 1)
  })
})

test("ownership that no longer reads as this session's work is refused at commit, not only at preparation", async () => {
  await withHarness(async (harness) => {
    const prepared = await prepareWith(harness, { paths: ["a.ts"], message: "the agent's change" })
    // The same path now carries another owner's work as well.
    harness.note("a.ts", contentDigest("original\n"), contentDigest("a different result\n"), contentDigest("agent change\n"))
    const answer = await commitWith(harness, prepared.operationId, "inv-2")
    assert.equal(answer.code, "git_mixed_ownership", JSON.stringify(answer))
    assert.equal(commitsIn(harness.repo), 1)
  })
})

test("a commit intent already claimed by another operation is not manufactured twice", async () => {
  await withHarness(async (harness) => {
    const first = await prepareWith(harness, { paths: ["a.ts"], message: "the same intent" })
    const second = await prepareWith(harness, { paths: ["a.ts"], message: "the same intent" })
    assert.notEqual(first.operationId, second.operationId, "two calls leave two records")
    const answer = await commitWith(harness, second.operationId, "inv-2")
    assert.equal(answer.code, "git_commit_intent_claimed", JSON.stringify(answer))
    assert.equal(commitsIn(harness.repo), 1, "the claimed intent is not committed twice")
  })
})

test("a task restriction outranks the preset and runs nothing", async () => {
  await withHarness(async (harness) => {
    const answer = await harness.service.prepareCommit({ paths: ["a.ts"], message: "not allowed" }, OperationAuthorization.issue(HOST, [{ kind: "prepare_commit", absolute: path.resolve(harness.repo), paths: ["a.ts"] }]), { invocationId: "inv-1" })
    assert.ok("code" in answer, JSON.stringify(answer))
    assert.equal((answer as { code?: string }).code, "git_task_restriction")
    assert.equal(commitsIn(harness.repo), 1, "nothing ran and no record was written")
  }, { restrictions: { noCommit: true } })
})

test("a message holding what this call resolved for a credential is refused before anything is recorded, and names nothing it found", async () => {
  process.env.MORIARTY_TEST_SECRET = "zqv7kqx3mqt8v9jy6x5w4t3s2r1q"
  await withHarness(async (harness) => {
    const answer = await harness.service.prepareCommit({ paths: ["a.ts"], message: `the fix, keyed by ${process.env.MORIARTY_TEST_SECRET}` }, OperationAuthorization.issue(HOST, [{ kind: "prepare_commit", absolute: path.resolve(harness.repo), paths: ["a.ts"] }]), { invocationId: "inv-1" })
    assert.ok("code" in answer, JSON.stringify(answer))
    assert.equal((answer as { code?: string }).code, "git_commit_message_secret")
    assert.ok(!JSON.stringify(answer).includes(process.env.MORIARTY_TEST_SECRET ?? ""), "the refusal names the condition, not what it found")
    assert.equal(commitsIn(harness.repo), 1, "and nothing was recorded")
  }, { auth: true })
  delete process.env.MORIARTY_TEST_SECRET
})

