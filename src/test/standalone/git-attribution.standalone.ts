/**
 * Stage 4's commit attribution (§9 of the design), tested row by row through the matrix, plus one commit in a
 * scratch repository to show what the resolver actually puts on a commit. What can decide an author is a
 * host-proved owner of the change, the project's own human config, `git config`, or an explicit trusted host
 * instruction — never a model name, a provider, and never the fact that this stage ran the command. No case
 * opens a database, and the only repository it commits in is one it created under /tmp.
 */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { contentDigest, createGitBaselineStore } from "../../extension/git/baseline"
import { createGitConfigSource, DEFAULT_GIT_PROJECT_CONFIG, GitProjectConfig } from "../../extension/git/config"
import { coAuthorTrailers, CommitScopeReading, resolveCommitAttribution } from "../../extension/git/identity"
import { createGitOwnershipStore, GitOwnershipIndex } from "../../extension/git/ownership"
import { createGitExecutionService, GitStagingCall } from "../../extension/git/service"
import { createGitTransactionStore } from "../../extension/git/transaction"
import { OperationAuthorization } from "../../extension/tools/operation-authorization"
import { WorkspaceView } from "../../extension/tools/view"

const HOST = "local|test"
const CONVERSATION = "conversation-attribution"
const MORIARTY = { name: "Moriarty", email: "moriarty@example.org" }
const HUMAN = { name: "Ada Human", email: "ada@example.com" }

const scratch = (prefix: string): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))

const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, stdio: "pipe" }).toString()

/** One row of the matrix as the resolver answers it. */
const rowOf = (
  scope: CommitScopeReading[],
  agentWork: boolean,
  options: { tagging?: boolean; email?: string; human?: { name: string; email: string }; gitConfig?: Record<string, string>; hostInstruction?: { name?: string; email?: string }; environment?: Record<string, string | undefined> } = {}
): { state: string; attribution?: { author: unknown; committer: unknown; coAuthors: unknown[] }; refusal?: { code: string } } => {
  const config: GitProjectConfig = {
    ...DEFAULT_GIT_PROJECT_CONFIG,
    workflow: { mode: "local-commits", plainCommit: "commit-only" },
    identity: {
      tagging: options.tagging ?? true,
      email: options.email === undefined ? DEFAULT_GIT_PROJECT_CONFIG.identity.email : { value: options.email },
      human: options.human === undefined ? DEFAULT_GIT_PROJECT_CONFIG.identity.human : { name: options.human.name, email: { value: options.human.email } }
    }
  }
  const answer = resolveCommitAttribution({
    config,
    origin: "project",
    environment: options.environment ?? {},
    agentWork,
    scope,
    ...(options.gitConfig === undefined ? {} : { gitConfig: options.gitConfig }),
    ...(options.hostInstruction === undefined ? {} : { hostInstruction: options.hostInstruction })
  })
  return answer.state === "resolved" ? { state: "resolved", attribution: answer.attribution } : { state: "refused", refusal: answer.refusal }
}

test("clean work, only this session's: Moriarty authors and commits, the known human appears once as co-author", () => {
  const answer = rowOf([{ path: "src/a.ts", ownership: "agent", confidence: "verified" }], true, { email: MORIARTY.email, human: HUMAN })
  assert.equal(answer.state, "resolved", JSON.stringify(answer.refusal))
  assert.deepEqual(answer.attribution?.author, MORIARTY)
  assert.deepEqual(answer.attribution?.committer, MORIARTY)
  assert.deepEqual(answer.attribution?.coAuthors, [HUMAN])
})

test("dirty work that is only pre-existing: the known human stays the author, Moriarty commits, no co-author is added for running the command", () => {
  const answer = rowOf([{ path: "src/a.ts", ownership: "human", confidence: "known" }], false, { email: MORIARTY.email, human: HUMAN })
  assert.equal(answer.state, "resolved", JSON.stringify(answer.refusal))
  assert.deepEqual(answer.attribution?.author, HUMAN)
  assert.deepEqual(answer.attribution?.committer, MORIARTY)
  assert.deepEqual(answer.attribution?.coAuthors, [])
})

test("clean work with a mixed file needs a split or an explicit authorship before anything is named", () => {
  const without = rowOf([{ path: "src/a.ts", ownership: "mixed", confidence: "verified" }], true, { email: MORIARTY.email })
  assert.equal(without.state, "refused")
  assert.equal(without.refusal?.code, "git_mixed_ownership")
  const stated = rowOf([{ path: "src/a.ts", ownership: "mixed", confidence: "verified" }], true, { email: MORIARTY.email, hostInstruction: { name: HUMAN.name, email: HUMAN.email } })
  assert.equal(stated.state, "resolved", JSON.stringify(stated.refusal))
})

test("a commit is refused when the author of existing work cannot be proven", () => {
  const answer = rowOf([{ path: "src/a.ts", ownership: "unknown", confidence: "known" }], false, { email: MORIARTY.email })
  assert.equal(answer.state, "refused")
  assert.equal(answer.refusal?.code, "git_authorship_not_proven")
})

test("tagging off names Moriarty nowhere and signs the commit with the normal configured identity", () => {
  const answer = rowOf([{ path: "src/a.ts", ownership: "agent", confidence: "verified" }], true, { tagging: false, gitConfig: { "user.name": "Zoe Config", "user.email": "zoe@example.com" } })
  assert.equal(answer.state, "resolved", JSON.stringify(answer.refusal))
  assert.deepEqual(answer.attribution?.author, { name: "Zoe Config", email: "zoe@example.com" })
  assert.deepEqual(answer.attribution?.committer, { name: "Zoe Config", email: "zoe@example.com" })
  assert.deepEqual(answer.attribution?.coAuthors, [])
  const nothing = rowOf([{ path: "src/a.ts", ownership: "agent", confidence: "verified" }], true, { tagging: false })
  assert.equal(nothing.refusal?.code, "git_identity_not_configured")
})

test("a missing Moriarty email is a configuration error, not an invented default; a normal environment variable answers it", () => {
  const missing = rowOf([{ path: "src/a.ts", ownership: "agent", confidence: "verified" }], true, { environment: {} })
  assert.equal(missing.state, "refused")
  assert.equal(missing.refusal?.code, "git_identity_missing_email")
  const fromEnvironment = rowOf([{ path: "src/a.ts", ownership: "agent", confidence: "verified" }], true, { environment: { MORIARTY_GIT_EMAIL: "from.env@example.com" } })
  assert.equal(fromEnvironment.state, "resolved", JSON.stringify(fromEnvironment.refusal))
  assert.deepEqual(fromEnvironment.attribution?.author, { name: "Moriarty", email: "from.env@example.com" })
})

test("one trailer per human identity, de-duplicated case-insensitively, and Moriarty is never its own co-author", () => {
  const trailers = coAuthorTrailers([HUMAN, { name: "ada human", email: "ADA@EXAMPLE.COM" }, MORIARTY], true, true)
  assert.deepEqual(trailers, ["Co-authored-by: Ada Human <ada@example.com>"])
  assert.deepEqual(coAuthorTrailers([HUMAN], false, false), [], "a tagging-off commit carries no trailer at all")
})

test("a commit in a scratch repository carries the identities the matrix decided", async () => {
  const base = scratch("git-attribution-")
  const home = path.join(base, "home")
  fs.mkdirSync(path.join(home, ".twinny"), { recursive: true })
  fs.writeFileSync(path.join(home, ".twinny", "config.json"), JSON.stringify({ git: { workflow: { mode: "local-commits" }, identity: { email: MORIARTY.email, human: { name: HUMAN.name, email: HUMAN.email } } } }))
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
  index.note({ conversationId: CONVERSATION, path: "a.ts", provenance: "native_edit", preDigest: contentDigest("original\n"), postDigest: contentDigest("agent change\n") })
  fs.writeFileSync(path.join(repo, "a.ts"), "agent change\n")

  const service = createGitExecutionService({
    view: new WorkspaceView(repo),
    configSource: source,
    baselines,
    ownership,
    transactions: createGitTransactionStore("project-attribution"),
    conversationId: CONVERSATION,
    hostKey: HOST
  })
  const call: GitStagingCall = { paths: ["a.ts"], message: "the agent's own change" }
  const prepared = await service.prepareCommit(call, OperationAuthorization.issue(HOST, [{ kind: "prepare_commit", absolute: path.resolve(repo), paths: ["a.ts"] }]), { invocationId: "inv-a1" })
  assert.ok(!("code" in prepared), JSON.stringify(prepared))
  const committed = await service.commit(prepared.operationId, OperationAuthorization.issue(HOST, [{ kind: "commit", absolute: path.resolve(repo), operationId: prepared.operationId }]), { invocationId: "inv-a2" })
  assert.ok(!("code" in committed), JSON.stringify(committed))
  assert.equal(git(repo, ["log", "-1", "--format=%an <%ae>|%cn <%ce>"]).trim(), "Moriarty <moriarty@example.org>|Moriarty <moriarty@example.org>")
  assert.equal(git(repo, ["log", "-1", "--format=%B"]).trim(), "the agent's own change\n\nCo-authored-by: Ada Human <ada@example.com>")
  fs.rmSync(base, { recursive: true, force: true })
})

test("committing only existing work names the human as author and Moriarty as committer on the commit itself", async () => {
  const base = scratch("git-attribution-")
  const home = path.join(base, "home")
  fs.mkdirSync(path.join(home, ".twinny"), { recursive: true })
  fs.writeFileSync(path.join(home, ".twinny", "config.json"), JSON.stringify({ git: { workflow: { mode: "local-commits" }, identity: { email: MORIARTY.email, human: { name: HUMAN.name, email: HUMAN.email } } } }))
  const repo = path.join(base, "repo")
  fs.mkdirSync(repo)
  git(repo, ["init", "-q"])
  git(repo, ["config", "user.name", "T"])
  git(repo, ["config", "user.email", "t@example.com"])
  fs.writeFileSync(path.join(repo, "a.ts"), "the human's work\n")
  git(repo, ["add", "."])
  git(repo, ["commit", "-qm", "first"])

  const source = createGitConfigSource(home)
  const baselines = createGitBaselineStore(source, { hostKey: HOST })
  const capture = await baselines.capture(CONVERSATION, repo)
  assert.ok(!("code" in capture), JSON.stringify(capture))
  const ownership = createGitOwnershipStore(baselines)
  const index = ownership.for(CONVERSATION) as GitOwnershipIndex
  assert.ok(!("code" in index), JSON.stringify(index))
  // The human staged their own work; the host recorded it as theirs, not as this session's.
  fs.writeFileSync(path.join(repo, "a.ts"), "the human's staged work\n")
  git(repo, ["add", "a.ts"])
  index.note({ conversationId: CONVERSATION, path: "a.ts", provenance: "source_save", preDigest: contentDigest("the human's work\n"), postDigest: contentDigest("the human's staged work\n") })
  const service = createGitExecutionService({
    view: new WorkspaceView(repo),
    configSource: source,
    baselines,
    ownership,
    transactions: createGitTransactionStore("project-attribution"),
    conversationId: CONVERSATION,
    hostKey: HOST,
    policy: { approved: true, explicitChoice: true }
  })
  const call: GitStagingCall = { paths: ["a.ts"], message: "committing work this session did not make" }
  const prepared = await service.prepareCommit(call, OperationAuthorization.issue(HOST, [{ kind: "prepare_commit", absolute: path.resolve(repo), paths: ["a.ts"] }]), { invocationId: "inv-a3" })
  assert.ok(!("code" in prepared), JSON.stringify(prepared))
  assert.equal((prepared.entries ?? [])[0]?.source, "index", "what the user staged is carried into the copy, not re-claimed as this session's work")
  const committed = await service.commit(prepared.operationId, OperationAuthorization.issue(HOST, [{ kind: "commit", absolute: path.resolve(repo), operationId: prepared.operationId }]), { invocationId: "inv-a4" })
  assert.ok(!("code" in committed), JSON.stringify(committed))
  assert.equal(git(repo, ["log", "-1", "--format=%an <%ae>|%cn <%ce>"]).trim(), "Ada Human <ada@example.com>|Moriarty <moriarty@example.org>")
  assert.equal(git(repo, ["log", "-1", "--format=%B"]).trim(), "committing work this session did not make", "no co-author is added just because this stage ran the commit")
  fs.rmSync(base, { recursive: true, force: true })
})
