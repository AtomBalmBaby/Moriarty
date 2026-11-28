/**
 * Stage 5's send, on scratch repositories and local bare remotes: the commit this stage already made is
 * published to the destination the effective config names, no force option is ever sent, a duplicate call
 * answers from the state it had instead of sending again, and an answer that was lost is settled from what
 * the ref on the remote actually holds. Nothing here reaches a hosting service, opens a project database, or
 * touches the development repository.
 */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { contentDigest, createGitBaselineStore } from "../../extension/git/baseline"
import { createGitConfigSource } from "../../extension/git/config"
import { createGitOwnershipStore } from "../../extension/git/ownership"
import { createGitExecutionService, type GitPushCall,pushArgsFor } from "../../extension/git/service"
import { createGitTransactionStore, GitPushReading, type GitRunRefusal } from "../../extension/git/transaction"
import { accessTargetsOf } from "../../extension/tools/access-preflight"
import { claimGitRequests, OperationAuthorization, pushRequestFromCall } from "../../extension/tools/operation-authorization"
import { WorkspaceView } from "../../extension/tools/view"

const HOST = "local|stage5-push"
const CONVERSATION = "conversation-stage5"
const SECRET = "credential-value-never-shown"

const scratch = (prefix: string): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))

const git = (cwd: string, args: string[]): string => execFileSync("git", ["--no-pager", ...args], { cwd, stdio: "pipe" }).toString().trim()

interface Harness {
  repo: string
  remote: string
  service: ReturnType<typeof createGitExecutionService>
  store: ReturnType<typeof createGitTransactionStore>
  /** How many times the bare remote's receive hook ran. A send that never reached the remote leaves no entry. */
  sends: () => number
  /** What the bare remote holds for refs/heads/master, read outside this stage. */
  refOnRemote: () => string
  /** The commit this stage makes from a path the host proved as this session's work: its operation id and its sha. */
  commitThrough: (message: string) => Promise<{ operationId: string; sha: string }>
  /** One push call with its own authorization, as the tool carries it. */
  pushWith: (call: Record<string, unknown>, invocationId?: string) => Promise<GitPushReading | GitRunRefusal>
}

/** A hook the remote itself runs. The first counts every receive, so a send that never reached the remote shows up as nothing; the other runs after the refs are already written. */
const writeHook = (remote: string, name: string, body: string[]): void => {
  fs.writeFileSync(path.join(remote, "hooks", name), `${body.join("\n")}\n`)
  fs.chmodSync(path.join(remote, "hooks", name), 0o755)
}

const withHarness = async (
  run: (harness: Harness) => Promise<void>,
  settings: { mode?: string; setUpstream?: boolean; branch?: string; pushTimeoutMs?: number; deny?: boolean; echoSecret?: boolean; sleepSeconds?: number; noPush?: boolean; approved?: boolean } = {}
): Promise<void> => {
  const base = scratch("git-push-")
  const home = path.join(base, "home")
  fs.mkdirSync(path.join(home, ".twinny"), { recursive: true })
  fs.writeFileSync(path.join(home, ".twinny", "config.json"), JSON.stringify({
    git: {
      workflow: { mode: settings.mode ?? "autonomous", plainCommit: "commit-only" },
      destination: { remote: "origin", branch: settings.branch ?? "current", setUpstream: settings.setUpstream ?? true },
      identity: { email: "moriarty@example.org" },
      ...(settings.echoSecret ? { auth: { mode: "environment", env: { GIT_HTTP_EXTRA_HEADER: { env: "MORIARTY_TEST_SECRET" } } } } : {}),
    }
  }))

  const repo = path.join(base, "repo")
  const remote = path.join(base, "remote")
  const log = path.join(base, "sends.log")
  fs.mkdirSync(repo)
  git(repo, ["init", "-q"])
  git(repo, ["config", "user.name", "Someone"])
  git(repo, ["config", "user.email", "someone@example.com"])
  fs.writeFileSync(path.join(repo, "a.ts"), "one\n")
  git(repo, ["add", "."])
  git(repo, ["commit", "-qm", "the first commit"])

  git(repo, ["init", "-q", "--bare", remote])
  git(repo, ["remote", "add", "origin", remote])
  fs.mkdirSync(path.join(remote, "hooks"), { recursive: true })
  writeHook(remote, "pre-receive", ["#!/bin/sh", `echo run >> "${log}"`, "exit 0"])
  writeHook(remote, "post-receive", ["#!/bin/sh", ...(settings.echoSecret ? [`echo "saw ${SECRET}" >&2`] : []), settings.sleepSeconds !== undefined ? `sleep ${settings.sleepSeconds}` : "exit 0"])

  // The destination branch already exists on the remote, so a send here has nothing to create.
  git(repo, ["push", "--", "origin", "HEAD:refs/heads/master"])
  if (settings.deny) writeHook(remote, "pre-receive", ["#!/bin/sh", `echo run >> "${log}"`, "echo refused >&2", "exit 1"])

  const source = createGitConfigSource(home)
  const baselines = createGitBaselineStore(source, { hostKey: HOST })
  const capture = await baselines.capture(CONVERSATION, repo)
  assert.ok(!("code" in capture), JSON.stringify(capture))
  const ownership = createGitOwnershipStore(baselines)
  const store = createGitTransactionStore("project-stage5")
  const service = createGitExecutionService({
    view: new WorkspaceView(repo),
    configSource: source,
    baselines,
    ownership,
    transactions: store,
    conversationId: CONVERSATION,
    hostKey: HOST,
    ...(settings.pushTimeoutMs === undefined ? {} : { pushTimeoutMs: settings.pushTimeoutMs }),
    ...(settings.noPush || settings.approved ? { policy: { ...(settings.noPush ? { restrictions: { noPush: true } } : {}), approved: settings.approved } } : {})
  })

  const harness: Harness = {
    repo,
    remote,
    service,
    store,
    sends: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter((line) => line !== "").length : 0),
    refOnRemote: () => git(remote, ["rev-parse", "--verify", "--quiet", "refs/heads/master"]),
    commitThrough: async (message: string) => {
      const index = ownership.for(CONVERSATION)
      assert.ok(!("code" in index), JSON.stringify(index))
      fs.writeFileSync(path.join(repo, "a.ts"), "agent change\n")
      const fact = (index as { note: (f: object) => { code?: string } }).note({ conversationId: CONVERSATION, path: "a.ts", provenance: "native_edit", preDigest: contentDigest("one\n"), postDigest: contentDigest("agent change\n") })
      assert.ok(!("code" in fact), JSON.stringify(fact))
      const prepared = await service.prepareCommit({ paths: ["a.ts"], message }, OperationAuthorization.issue(HOST, [{ kind: "prepare_commit", absolute: path.resolve(repo), paths: ["a.ts"] }]), { invocationId: "inv-1" })
      assert.ok(!("code" in prepared), JSON.stringify(prepared))
      const committed = await service.commit((prepared as { operationId: string }).operationId, OperationAuthorization.issue(HOST, [{ kind: "commit", absolute: path.resolve(repo), operationId: (prepared as { operationId: string }).operationId }]), { invocationId: "inv-1" })
      assert.ok(!("code" in committed), JSON.stringify(committed))
      return { operationId: (prepared as { operationId: string }).operationId, sha: (committed as { commit?: { sha: string } }).commit?.sha ?? "" }
    },
    pushWith: async (call, invocationId = "inv-1") => service.push(call as GitPushCall, OperationAuthorization.issue(HOST, [pushRequestFromCall(call, path.resolve(repo))]), { invocationId })
  }
  try {
    await run(harness)
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
}

test("git push publishes the exact commit to a local bare remote", async () => {
  await withHarness(async (harness) => {
    const before = harness.sends()
    const made = await harness.commitThrough("the agent's change")
    const answer = await harness.pushWith({ operationId: made.operationId })
    assert.ok(!("code" in answer), JSON.stringify(answer))
    assert.equal(answer.state, "succeeded", JSON.stringify(answer))
    assert.equal(answer.commitSha, made.sha, "the commit the record made is the one published")
    assert.equal(harness.refOnRemote(), made.sha, "the bare remote holds that exact commit")
    assert.equal(harness.sends(), before + 1, "one send reached the remote")
    assert.ok(harness.store.records().some((record) => record.kind === "push"), "the send is recorded as its own operation")
    assert.equal(harness.store.records().filter((record) => record.kind === "commit").length, 1, "and no commit was made by it")
  })
})

test("git push sets the authorized upstream only as the project configured it", async () => {
  await withHarness(async (harness) => {
    const made = await harness.commitThrough("the agent's change")
    const answer = await harness.pushWith({ operationId: made.operationId })
    assert.ok(!("code" in answer), JSON.stringify(answer))
    assert.equal(git(harness.repo, ["config", "--get", "branch.master.remote"]), "origin")
    assert.equal(git(harness.repo, ["config", "--get", "branch.master.merge"]), "refs/heads/master")
    const changed = await harness.pushWith({ operationId: made.operationId, setUpstream: false }, "inv-2")
    assert.ok("code" in changed, JSON.stringify(changed))
    assert.equal((changed as { code: string }).code, "git_destination_not_authorized", "a call cannot change what the project configured")
  })
})

test("a duplicate push invocation answers from the state it had and sends nothing again", async () => {
  await withHarness(async (harness) => {
    const made = await harness.commitThrough("the agent's change")
    const first = await harness.pushWith({ operationId: made.operationId })
    assert.ok(!("code" in first), JSON.stringify(first))
    const sent = harness.sends()
    const again = await harness.pushWith({ operationId: made.operationId }, "inv-2")
    assert.ok(!("code" in again), JSON.stringify(again))
    assert.equal(again.duplicate, true)
    assert.equal(again.state, "succeeded")
    assert.equal(harness.sends(), sent, "no second send reached the remote")
  })
})

test("a push whose answer was lost at the timeout is settled from what the remote holds", async () => {
  await withHarness(async (harness) => {
    const made = await harness.commitThrough("the agent's change")
    const answer = await harness.pushWith({ operationId: made.operationId })
    assert.ok(!("code" in answer), JSON.stringify(answer))
    assert.equal(answer.state, "succeeded", JSON.stringify(answer))
    assert.ok((answer.inspected ?? "").includes("killed"), "the reading says the process never answered")
    assert.ok((answer.inspected ?? "").includes("reads as"), "and that it read the ref instead of trusting an exit code")
    assert.equal(harness.refOnRemote(), made.sha)
  }, { pushTimeoutMs: 400, sleepSeconds: 2 })
})

test("git push reports a non-fast-forward rejection without rewriting anything", async () => {
  await withHarness(async (harness) => {
    const before = harness.sends()
    const seed = git(harness.repo, ["rev-parse", "HEAD"])
    const made = await harness.commitThrough("the agent's change")
    // Another line of work reaches the destination first, so this commit is not a descendant of what it holds.
    git(harness.repo, ["checkout", "-q", "-b", "alt", seed])
    fs.writeFileSync(path.join(harness.repo, "other.ts"), "other work\n")
    git(harness.repo, ["add", "other.ts"])
    git(harness.repo, ["commit", "-qm", "another line of work"])
    const divergent = git(harness.repo, ["rev-parse", "HEAD"])
    git(harness.repo, ["push", "--", "origin", `${divergent}:refs/heads/master`])
    const answer = await harness.pushWith({ operationId: made.operationId }, "inv-2")
    assert.ok(!("code" in answer), JSON.stringify(answer))
    assert.equal(answer.state, "rejected", JSON.stringify(answer))
    assert.equal(harness.refOnRemote(), divergent, "the remote kept what it held")
    assert.equal(harness.sends(), before + 1, "the send was refused as a non-fast-forward before anything was received; nothing was forced")
    assert.ok(!(answer.inspected ?? "").includes("force"), "and the reading says no force was attempted")
  }, { branch: "master" })
})

test("a ref that moved from what the operation expected is refused before anything is sent", async () => {
  await withHarness(async (harness) => {
    const before = harness.sends()
    const held = harness.refOnRemote()
    const made = await harness.commitThrough("the agent's change")
    // The record was prepared when the ref read as what it held then; it has since moved.
    const record = harness.store.preparePush({ id: "op-ref-moved", invocationId: "inv-1", kind: "push", projectKey: "project-stage5", repositoryTop: harness.repo, conversationId: CONVERSATION, commitSha: made.sha, headBefore: made.sha, branchBefore: "master", remote: "origin", branch: "master", setUpstream: false, force: false, expectedRemoteSha: held })
    const moved = harness.store.transition(record.id, "authorized", record.invocationId)
    assert.ok(!("code" in moved), JSON.stringify(moved))
    git(harness.repo, ["checkout", "-q", "-b", "alt", held])
    fs.writeFileSync(path.join(harness.repo, "other.ts"), "other work\n")
    git(harness.repo, ["add", "other.ts"])
    git(harness.repo, ["commit", "-qm", "another line of work"])
    const other = git(harness.repo, ["rev-parse", "HEAD"])
    git(harness.repo, ["push", "--", "origin", `${other}:refs/heads/master`])
    const answer = await harness.pushWith({ operationId: record.id }, "inv-1")
    assert.ok(!("code" in answer), JSON.stringify(answer))
    assert.equal(answer.state, "rejected", JSON.stringify(answer))
    assert.equal(harness.sends(), before + 1, "the move came from the other call; this one sent nothing")
    assert.equal(answer.expectedRemoteSha, held, "and the reading still names what it expected")
    assert.equal(answer.actualRemoteSha, other)
  }, { branch: "master" })
})

test("git push never uses a force option, and a call that asks for one is refused", async () => {
  await withHarness(async (harness) => {
    const before = harness.sends()
    const made = await harness.commitThrough("the agent's change")
    const refused = await harness.pushWith({ operationId: made.operationId, force: true }, "inv-2")
    assert.ok("code" in refused, JSON.stringify(refused))
    assert.equal((refused as { code: string }).code, "git_force_not_allowed", "force is not part of what this stage can do")
    assert.equal(harness.sends(), before, "nothing was sent")
    const answer = await harness.pushWith({ operationId: made.operationId }, "inv-3")
    assert.ok(!("code" in answer), JSON.stringify(answer))
    const record = harness.store.records().find((item) => item.kind === "push")
    assert.ok(record !== undefined && record.kind === "push")
    const args = pushArgsFor(record, {})
    assert.ok(!args.some((word) => word.includes("force") || word === "-f"), `the arguments it runs with: ${args.join(" ")}`)
    assert.ok(args.includes(`${record.commitSha}:refs/heads/master`), "the exact commit, to the destination branch")
  })
})

test("a no-push task restriction outranks the preset and sends nothing", async () => {
  await withHarness(async (harness) => {
    const before = harness.sends()
    const made = await harness.commitThrough("the agent's change")
    const answer = await harness.pushWith({ operationId: made.operationId })
    assert.ok("code" in answer, JSON.stringify(answer))
    assert.equal((answer as { code: string }).code, "git_task_restriction", JSON.stringify(answer))
    assert.equal(harness.sends(), before, "nothing reached the remote")
    assert.equal(harness.refOnRemote(), git(harness.repo, ["rev-parse", "HEAD~1"]), "the remote still holds what it held before")
    assert.equal(harness.store.records().filter((item) => item.kind === "push").length, 0, "and no push operation was recorded")
  }, { mode: "autonomous", noPush: true })
})

test("a send that fails does not create a commit", async () => {
  await withHarness(async (harness) => {
    const before = harness.sends()
    const made = await harness.commitThrough("the agent's change")
    const commitsBefore = git(harness.repo, ["rev-list", "--count", "HEAD"])
    const answer = await harness.pushWith({ operationId: made.operationId }, "inv-2")
    assert.ok(!("code" in answer), JSON.stringify(answer))
    assert.equal(answer.state, "failed", JSON.stringify(answer))
    assert.equal(git(harness.repo, ["rev-list", "--count", "HEAD"]), commitsBefore, "the send made no commit")
    assert.equal(harness.refOnRemote(), git(harness.repo, ["rev-parse", "HEAD~1"]), "and the remote was not moved")
    assert.equal(harness.sends(), before + 1, "the receive was reached and refused there")
  }, { deny: true })
})

test("a push result names the destination without naming a credential", async () => {
  await withHarness(async (harness) => {
    process.env.MORIARTY_TEST_SECRET = SECRET
    try {
      const made = await harness.commitThrough("the agent's change")
      const answer = await harness.pushWith({ operationId: made.operationId }, "inv-2")
      assert.ok(!("code" in answer), JSON.stringify(answer))
      const shown = JSON.stringify(answer)
      assert.ok(!shown.includes(SECRET), `the result carries no credential value: ${shown}`)
      assert.ok(shown.includes("credential withheld"), "what the process echoed was withheld")
      assert.equal(answer.remote, "origin", "the remote is named as a name")
    } finally {
      delete process.env.MORIARTY_TEST_SECRET
    }
  }, { echoSecret: true })
})

test("a push is approved by its own request, not by a commit approval", async () => {
  await withHarness(async (harness) => {
    const made = await harness.commitThrough("the agent's change")
    const repo = path.resolve(harness.repo)
    const commitOnly = OperationAuthorization.issue(HOST, [{ kind: "commit", absolute: repo, operationId: made.operationId }])
    const before = harness.sends()
    assert.equal(claimGitRequests(commitOnly, [pushRequestFromCall({ operationId: made.operationId }, repo)], HOST), false, "a grant taken for the commit call does not carry a send")
    const refused = await harness.service.push({ operationId: made.operationId }, commitOnly, { invocationId: "inv-2" })
    assert.ok("code" in refused, JSON.stringify(refused))
    assert.equal((refused as { code: string }).code, "git_push_not_authorized", JSON.stringify(refused))
    const pushOnly = OperationAuthorization.issue(HOST, [pushRequestFromCall({ operationId: made.operationId }, repo)])
    assert.equal(claimGitRequests(pushOnly, [{ kind: "commit", absolute: repo, operationId: made.operationId }], HOST), false, "and a send grant does not carry a commit call")
    assert.equal(harness.sends(), before, "nothing ran for either refusal")
    const asked = accessTargetsOf("git", { operation: "push", repository: repo })
    assert.ok(asked.length > 0 && (asked[0] as { git?: { kind?: string } }).git?.kind === "push", "the dispatcher asks for the send as its own request")
  })
})

test("recovery settles a lost send by reading what the ref holds, before anything runs again", async () => {
  await withHarness(async (harness) => {
    const held = harness.refOnRemote()
    const made = await harness.commitThrough("the agent's change")
    const record = harness.store.preparePush({ id: "op-lost-answer", invocationId: "inv-1", kind: "push", projectKey: "project-stage5", repositoryTop: harness.repo, conversationId: CONVERSATION, commitSha: made.sha, headBefore: made.sha, branchBefore: "master", remote: "origin", branch: "master", setUpstream: false, force: false, expectedRemoteSha: held })
    const authorized = harness.store.transition(record.id, "authorized", record.invocationId)
    assert.ok(!("code" in authorized), JSON.stringify(authorized))
    // The state a call whose answer never came back leaves.
    const running = harness.store.transition(record.id, "running", record.invocationId)
    assert.ok(!("code" in running), JSON.stringify(running))
    const before = harness.sends()
    git(harness.repo, ["push", "--", "origin", `${made.sha}:refs/heads/master`])
    const answer = await harness.service.recover(record.id)
    assert.ok(!("code" in answer), JSON.stringify(answer))
    assert.equal(answer.state, "succeeded", JSON.stringify(answer))
    assert.ok((answer.inspected ?? "").includes("reads as"), "settled from what the ref reads, not from an exit code")
    assert.equal(harness.sends(), before + 1, "recovery sent nothing itself")
  })
})
