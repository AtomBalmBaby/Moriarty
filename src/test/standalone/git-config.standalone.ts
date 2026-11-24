/**
 * Stage 1's project Git config, identity and credential resolution, tested on scratch projects under
 * /tmp. Every case reads a file the test itself wrote. None of them runs a Git process, opens or touches
 * a database, uses the network, or writes the project config back; one case exists to prove that sharing
 * the parser changed nothing for the evidence section.
 */
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { describeGitCredentials, GIT_CREDENTIAL_ENV_NAMES, MANAGED_CREDENTIAL_PROVIDER_ERROR, resolveGitCredentials, resolveManagedCredentials } from "../../extension/git/auth"
import { createGitConfigSource, DEFAULT_GIT_PROJECT_CONFIG, describeGitConfig, GitProjectConfig, GitUserPreferences, readGitProjectConfig, sanitizeRemoteForDisplay } from "../../extension/git/config"
import { coAuthorTrailers, describeGitIdentity, MORIARTY_IDENTITY_NAME, resolveGitIdentity } from "../../extension/git/identity"
import { createPolicySource, describeEffectivePolicy, readEvidenceStoragePolicy } from "../../extension/todos/evidence-config"

const HOME = "/home/testuser"
const SECRET = "s3cret-askpass-value-that-must-never-be-printed"

const configOf = (root: string): string => path.join(root, ".twinny", "config.json")

/** Writes the file the reader will read, and hands back exactly what was written. */
const writeConfig = (root: string, document: Record<string, unknown>): string => {
  const text = JSON.stringify(document)
  fs.writeFileSync(configOf(root), text)
  return text
}

/** A scratch project with the folder the reader expects, and nothing else. */
const withProject = async (prefix: string, run: (root: string) => Promise<void>): Promise<void> => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  fs.mkdirSync(path.join(root, ".twinny"), { recursive: true })
  try {
    await run(root)
    assert.deepEqual(fs.readdirSync(path.join(root, ".twinny")).filter((name) => name !== "config.json"), [], "reading the config created no project database")
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

const configFor = async (root: string, preferences: GitUserPreferences = {}): Promise<GitProjectConfig> => {
  const reading = await readGitProjectConfig(root, preferences, HOME)
  assert.equal(reading.state, "effective", reading.state === "invalid" ? reading.reason : "")
  return reading.state === "effective" ? reading.reading.config : DEFAULT_GIT_PROJECT_CONFIG
}

test("git config uses defaults when config is absent", async () => {
  await withProject("git-config-defaults-", async (root) => {
    const reading = await readGitProjectConfig(root, {}, HOME)
    assert.equal(reading.state, "effective")
    if (reading.state !== "effective") return
    assert.equal(reading.reading.source, "defaults")
    assert.equal(reading.reading.config.workflow.mode, "manual-approval", "nothing is permitted until the project says so")
    assert.equal(reading.reading.config.workflow.plainCommit, "commit-only")
    assert.equal(reading.reading.config.destination.remote, "origin")
    assert.equal(reading.reading.config.destination.branch, "current")
    assert.equal(reading.reading.config.destination.setUpstream, true)
    assert.equal(reading.reading.config.identity.tagging, true, "attribution stays on until the project turns it off")
    assert.equal(reading.reading.config.identity.email, undefined, "the Moriarty email is never hardcoded")
    assert.equal(reading.reading.config.auth.mode, "inherit")
    assert.equal(reading.reading.origins["workflow.mode"], "default")
    assert.deepEqual(reading.reading.reportedKeys, [])
    assert.equal(fs.existsSync(configOf(root)), false, "reading a missing file did not create one")
  })
})

test("git config merges project and user precedence", async () => {
  await withProject("git-config-precedence-", async (root) => {
    const written = writeConfig(root, { git: { workflow: { mode: "commit-and-push" }, destination: { branch: "feature/git-stage-1" } } })
    const preferences: GitUserPreferences = { workflow: { mode: "local-commits", plainCommit: "commit-and-push" }, destination: { remote: "upstream", setUpstream: false } }
    const reading = await readGitProjectConfig(root, preferences, HOME)
    assert.equal(reading.state, "effective")
    if (reading.state !== "effective") return
    const config = reading.reading.config
    assert.equal(config.workflow.mode, "commit-and-push", "the project file outranks the user preference")
    assert.equal(config.workflow.plainCommit, "commit-and-push", "a key only the user names still counts")
    assert.equal(config.destination.remote, "upstream")
    assert.equal(config.destination.branch, "feature/git-stage-1")
    assert.equal(config.destination.setUpstream, false)
    assert.equal(reading.reading.origins["workflow.mode"], "project", "the reading says which layer decided it")
    assert.equal(reading.reading.origins["destination.remote"], "user")
    assert.equal(reading.reading.origins["identity.tagging"], "default")
    assert.equal(fs.readFileSync(configOf(root), "utf8"), written, "the reader wrote nothing back")
  })
})

test("git config resolves Moriarty email from an environment variable", async () => {
  await withProject("git-config-email-env-", async (root) => {
    writeConfig(root, {"git":{"identity":{"email":{"env":"MORIARTY_GIT_EMAIL"}}}})
    const reading = await readGitProjectConfig(root, {}, HOME)
    assert.equal(reading.state, "effective")
    if (reading.state !== "effective") return
    assert.deepEqual(reading.reading.config.identity.email, { env: "MORIARTY_GIT_EMAIL" }, "the parsed config keeps the reference, not the value")
    const answer = resolveGitIdentity({ config: reading.reading.config, origin: "project", environment: { MORIARTY_GIT_EMAIL: "moriarty@example.org" } })
    assert.equal(answer.state, "resolved")
    if (answer.state !== "resolved") return
    assert.equal(answer.resolution.moriarty?.name, MORIARTY_IDENTITY_NAME, "the logical name is not the account, the model or the machine user")
    assert.equal(answer.resolution.moriarty?.email, "moriarty@example.org")
    assert.equal(answer.resolution.sources.moriartyEmail, "project config")
    const line = describeGitConfig(reading)
    assert.ok(line.includes("MORIARTY_GIT_EMAIL"), "the diagnostic names the reference")
    assert.equal(line.includes("moriarty@example.org"), false, "and not what it holds")
  })
})

test("git config resolves human co-author identity", async () => {
  await withProject("git-config-human-", async (root) => {
    writeConfig(root, { git: { identity: { email: "moriarty@example.org", human: { name: "Ada Human", email: "ada@example.com" } } } })
    const config = await configFor(root)
    const fromFile = resolveGitIdentity({ config, environment: {}, gitConfig: { "user.name": "From Git Config", "user.email": "gitconfig@example.com" }, hostInstruction: { name: "Host Person", email: "host@example.com" } })
    assert.equal(fromFile.state, "resolved")
    if (fromFile.state !== "resolved") return
    assert.deepEqual(fromFile.resolution.human, { name: "Ada Human", email: "ada@example.com" }, "explicit project human config is first")
    assert.equal(fromFile.resolution.sources.human, "project config")
    const again = { name: "ada human", email: "ADA@EXAMPLE.COM" }
    assert.deepEqual(coAuthorTrailers([fromFile.resolution.human!, again], true, fromFile.resolution.tagging), ["Co-authored-by: Ada Human <ada@example.com>"], "one trailer per identity, de-duplicated case-insensitively")
    assert.deepEqual(coAuthorTrailers([{ name: "Moriarty", email: "moriarty@example.org" }], true, fromFile.resolution.tagging), [], "Moriarty is never a co-author of a commit it already authors")

    // A config with the Moriarty email but no human block, so only the order of sources changes.
    const noHuman = { ...DEFAULT_GIT_PROJECT_CONFIG, identity: { tagging: true, email: { value: "moriarty@example.org" }, human: undefined } }
    const fromGitConfig = resolveGitIdentity({ config: noHuman, environment: {}, gitConfig: { "user.name": "From Git Config", "user.email": "gitconfig@example.com" }, hostInstruction: { name: "Host Person", email: "host@example.com" } })
    assert.equal(fromGitConfig.state, "resolved")
    if (fromGitConfig.state !== "resolved") return
    assert.deepEqual(fromGitConfig.resolution.human, { name: "From Git Config", email: "gitconfig@example.com" }, "Git config comes after the project human config")
    assert.equal(fromGitConfig.resolution.sources.human, "git config")

    const fromHost = resolveGitIdentity({ config: noHuman, environment: {}, hostInstruction: { name: "Host Person", email: "host@example.com" } })
    assert.equal(fromHost.state, "resolved")
    if (fromHost.state !== "resolved") return
    assert.deepEqual(fromHost.resolution.human, { name: "Host Person", email: "host@example.com" }, "an explicit host instruction is the last word")
    assert.deepEqual(coAuthorTrailers([fromFile.resolution.human!], true, false), [], "a tagging-disabled commit carries no Moriarty trailer")
  })
})

test("git config reloads after file stamp change", async () => {
  await withProject("git-config-reload-", async (root) => {
    const source = createGitConfigSource(root, {}, HOME)
    const first = await source.effective()
    assert.equal(first.state, "effective")
    if (first.state !== "effective") return
    assert.equal(first.reading.config.workflow.mode, "manual-approval", "the absent file answered with defaults")
    writeConfig(root, { git: { workflow: { mode: "local-commits" } } })
    const changed = await source.effective()
    assert.equal(changed.state, "effective")
    if (changed.state !== "effective") return
    assert.equal(changed.reading.config.workflow.mode, "local-commits", "a corrected file is read again without a restart")
    const cached = await source.effective()
    assert.equal(cached === changed, true, "a file that did not change is not parsed again")
    assert.equal(source.last() === cached, true, "the source can say what it last answered with")
  })
})

test("git config preserves unrelated project keys", async () => {
  await withProject("git-config-unrelated-", async (root) => {
    const written = writeConfig(root, { evidence: { storage: { maxProjectBytes: 4096 } }, git: { workflow: { mode: "local-commits" }, unowned: { note: "kept" } }, other: { keep: true } })
    const reading = await readGitProjectConfig(root, {}, HOME)
    assert.equal(reading.state, "effective")
    if (reading.state !== "effective") return
    assert.deepEqual(reading.reading.reportedKeys, ["git.unowned"], "a key inside git that Moriarty does not own is reported, not read")
    assert.equal(reading.reading.config.workflow.mode, "local-commits")
    const evidence = await readEvidenceStoragePolicy(root)
    assert.equal(evidence.state, "effective")
    if (evidence.state !== "effective") return
    assert.deepEqual(evidence.reading.otherKeys, ["git", "other"], "the evidence reader still reports what it does not use")
    assert.equal(evidence.reading.policy.maxProjectBytes, 4096, "the evidence section is unchanged by the shared parser")
    assert.equal(fs.readFileSync(configOf(root), "utf8"), written, "nothing was rewritten")
  })
})

test("git config rejects invalid tagging value", async () => {
  await withProject("git-config-tagging-", async (root) => {
    writeConfig(root, { git: { identity: { tagging: "yes" } } })
    const reading = await readGitProjectConfig(root, {}, HOME)
    assert.equal(reading.state, "invalid")
    if (reading.state !== "invalid") return
    assert.ok(/git.identity.tagging must be true or false/.test(reading.reason), reading.reason)
    assert.ok(/the file was left as it is/.test(reading.reason), "the report says what was not done")
  })
})

test("git config rejects invalid workflow", async () => {
  await withProject("git-config-workflow-", async (root) => {
    writeConfig(root, { git: { workflow: { mode: "always" } } })
    const reading = await readGitProjectConfig(root, {}, HOME)
    assert.equal(reading.state, "invalid")
    if (reading.state !== "invalid") return
    assert.ok(/workflow.mode must be "manual-approval" or "local-commits" or "commit-and-push" or "autonomous", not "always"/.test(reading.reason), reading.reason)
    writeConfig(root, { git: { destination: { branch: "bad name" } } })
    const branch = await readGitProjectConfig(root, {}, HOME)
    assert.equal(branch.state, "invalid")
    if (branch.state === "invalid") assert.ok(/destination.branch must be "current" or a branch name/.test(branch.reason), branch.reason)
    writeConfig(root, { git: { destination: { remote: "https://user:token@example.com/a/b" } } })
    const remote = await readGitProjectConfig(root, {}, HOME)
    assert.equal(remote.state, "invalid")
    if (remote.state === "invalid") assert.ok(/without credentials in it/.test(remote.reason), remote.reason)
  })
})

test("git config rejects missing env variable", async () => {
  await withProject("git-config-missing-env-", async (root) => {
    writeConfig(root, { git: { auth: { mode: "environment", env: { GIT_ASKPASS: { env: "MORIARTY_GIT_ASKPASS" } } } } })
    const config = await configFor(root)
    assert.deepEqual(Object.keys(config.auth.env), ["GIT_ASKPASS"])
    assert.ok((GIT_CREDENTIAL_ENV_NAMES as readonly string[]).includes("GIT_ASKPASS"), "only the documented credential names are read")
    writeConfig(root, { git: { auth: { mode: "environment", env: { GIT_TOKEN: { env: "MORIARTY_GIT_TOKEN" } } } } })
    const undocumented = await readGitProjectConfig(root, {}, HOME)
    assert.equal(undocumented.state, "invalid")
    if (undocumented.state === "invalid") assert.ok(/is not a documented credential name/.test(undocumented.reason), undocumented.reason)
    const resolved = await resolveGitCredentials({ auth: config.auth, environment: {}, home: HOME })
    if (!("code" in resolved)) {
      assert.fail("a reference to a variable that is not set must be reported, not worked around")
      return
    }
    assert.equal(resolved.code, "git_auth_environment_missing")
    assert.ok(resolved.summary.includes("MORIARTY_GIT_ASKPASS"), resolved.summary)
    assert.ok(resolved.output.includes("MORIARTY_GIT_ASKPASS"), "the error names the variable")
    assert.equal(resolved.output.includes(SECRET), false, "and says nothing about a value")
    writeConfig(root, { git: { auth: { mode: "environment", env: { GIT_ASKPASS: SECRET } } } })
    const shape = await readGitProjectConfig(root, {}, HOME)
    assert.equal(shape.state, "invalid")
    if (shape.state === "invalid") assert.ok(/must reference an environment variable as \{ "env": "NAME" \}, not a value/.test(shape.reason), shape.reason)
  })
})

test("git config rejects corrupt JSON", async () => {
  await withProject("git-config-corrupt-", async (root) => {
    fs.writeFileSync(configOf(root), "{ git: { workflow: {} }")
    const reading = await readGitProjectConfig(root, {}, HOME)
    assert.equal(reading.state, "invalid")
    if (reading.state !== "invalid") return
    assert.ok(/is not JSON/.test(reading.reason), reading.reason)
    assert.ok(/correct it or remove it/.test(reading.reason), "the report says what a user can do")
    fs.writeFileSync(configOf(root), "[1, 2]")
    const array = await readGitProjectConfig(root, {}, HOME)
    assert.equal(array.state, "invalid")
    if (array.state === "invalid") assert.ok(/must hold a JSON object/.test(array.reason), array.reason)
  })
})

test("git config never exposes credential value", async () => {
  await withProject("git-config-credentials-", async (root) => {
    writeConfig(root, { git: { auth: { mode: "environment", username: "ada", env: { GIT_HTTP_EXTRA_HEADER: { env: "MORIARTY_GIT_HTTP_EXTRA_HEADER" } } } } })
    const reading = await readGitProjectConfig(root, {}, HOME)
    assert.equal(reading.state, "effective")
    if (reading.state !== "effective") return
    assert.deepEqual(reading.reading.config.auth.env, { GIT_HTTP_EXTRA_HEADER: { env: "MORIARTY_GIT_HTTP_EXTRA_HEADER" } }, "the parsed config holds names only")
    assert.equal(JSON.stringify(reading).includes(SECRET), false, "no credential value enters a reading")
    const line = describeGitConfig(reading)
    assert.ok(/GIT_HTTP_EXTRA_HEADER->MORIARTY_GIT_HTTP_EXTRA_HEADER/.test(line), line)
    assert.equal(line.includes(SECRET), false, "the diagnostic names the reference, never what it holds")
    const credentials = await resolveGitCredentials({ auth: reading.reading.config.auth, environment: { MORIARTY_GIT_HTTP_EXTRA_HEADER: SECRET }, home: HOME })
    if ("code" in credentials) return
    assert.equal(credentials.environment.GIT_HTTP_EXTRA_HEADER, SECRET, "the value exists only for the Git process it is about to create")
    assert.equal(credentials.environment.GIT_TERMINAL_PROMPT, "0", "nothing is ever typed at a Git process")
    assert.equal(describeGitCredentials(credentials.report).includes(SECRET), false, "what may be reported is the name")
    assert.ok(/\[credential withheld\]/.test(sanitizeRemoteForDisplay("https://user:s3cret@github.com/twinny/twinny")), "a remote that carries credentials is shown without them")
  })
})

test("git identity refuses a commit when the Moriarty email is missing", async () => {
  const answer = resolveGitIdentity({ config: DEFAULT_GIT_PROJECT_CONFIG, environment: {} })
  assert.equal(answer.state, "refused")
  if (answer.state !== "refused") return
  assert.equal(answer.refusal.code, "git_identity_missing_email")
  assert.equal(answer.refusal.executed, false, "nothing ran because the identity was missing")
  assert.equal(answer.refusal.summary, "Commit refused: Moriarty Git email is missing")
  assert.ok(answer.refusal.output.includes("MORIARTY_GIT_EMAIL"), answer.refusal.output)
  assert.ok(describeGitIdentity(answer).includes("Commit refused"), describeGitIdentity(answer))
  const off = resolveGitIdentity({ config: { ...DEFAULT_GIT_PROJECT_CONFIG, identity: { tagging: false, email: undefined, human: undefined } }, environment: {} })
  assert.equal(off.state, "resolved")
  if (off.state !== "resolved") return
  assert.equal(off.resolution.moriarty, undefined, "a tagging-disabled commit uses normal Git identities")
  assert.deepEqual(coAuthorTrailers([], true, off.resolution.tagging), [])
})

test("git auth reports a managed mode with no installed provider", async () => {
  const problem = await resolveGitCredentials({ auth: { mode: "managed", env: {} }, environment: {} })
  assert.equal("code" in problem, true, "without an installed provider the mode is reported, not guessed")
  if (!("code" in problem)) return
  assert.equal(problem.code, "git_auth_provider_not_installed")
  assert.equal(problem.summary, MANAGED_CREDENTIAL_PROVIDER_ERROR)
  let message = ""
  try {
    await resolveManagedCredentials(undefined, { repository: "/scratch", remote: "origin", operation: "push" })
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  assert.equal(message, MANAGED_CREDENTIAL_PROVIDER_ERROR, "the seam itself throws the clear error")
  const used = await resolveGitCredentials({ auth: { mode: "managed", env: {} }, environment: {}, provider: { resolve: async () => ({ environment: new Map([["GIT_ASKPASS", SECRET]]) }) }, request: { repository: "/scratch", remote: "origin", operation: "push" } })
  assert.equal("code" in used, false, "an installed provider answers for the process only")
  if (!("code" in used)) assert.equal(used.environment.GIT_ASKPASS, SECRET)
})

test("git auth keeps a dedicated mode as credential selection, never attribution", async () => {
  const resolved = await resolveGitCredentials({ auth: { mode: "dedicated", sshIdentityFile: "~/.ssh/moriarty_key", credentialHelper: "store", username: "ada", env: {} }, environment: {}, home: HOME })
  assert.equal("code" in resolved, false)
  if ("code" in resolved) return
  assert.equal(resolved.gitConfig["credential.helper"], "store")
  assert.equal(resolved.gitConfig["user.name"], undefined, "credential configuration never decides who is named in a commit")
  assert.ok(resolved.environment.GIT_SSH_COMMAND.includes("/home/testuser/.ssh/moriarty_key"), resolved.environment.GIT_SSH_COMMAND)
  assert.equal(describeGitCredentials(resolved.report).includes(SECRET), false)
})

test("the shared parser leaves existing evidence config behavior unchanged", async () => {
  await withProject("git-config-evidence-", async (root) => {
    const written = writeConfig(root, { evidence: { storage: { maxBlobBytes: 512 } }, git: { workflow: { mode: "local-commits" } }, unrelated: { keep: true } })
    const source = createPolicySource(root)
    const reading = await source.effective()
    assert.equal(reading.state, "effective")
    if (reading.state !== "effective") return
    assert.equal(reading.reading.source, "config.json")
    assert.equal(reading.reading.policy.maxBlobBytes, 512)
    assert.equal(reading.reading.policy.maxProjectBytes, 64000000, "the documented default still applies to a key the file does not name")
    assert.deepEqual(reading.reading.otherKeys, ["git", "unrelated"], "what evidence does not read is still reported")
    assert.equal(fs.readFileSync(configOf(root), "utf8"), written, "the shared reader wrote nothing back")
    const second = writeConfig(root, { evidence: { storage: { redactionMode: "not_a_mode" } }, unrelated: { keep: true } })
    const invalid = await source.effective()
    assert.equal(invalid.state, "invalid")
    if (invalid.state === "invalid") assert.ok(/redactionMode must be/.test(invalid.reason), invalid.reason)
    assert.ok(describeEffectivePolicy(invalid).includes("the file was left as it is"), "and the wording is still the same")
    assert.equal(fs.readFileSync(configOf(root), "utf8"), second, "unrelated content is preserved and nothing was rewritten")
  })
})
test("git config rejects an invalid auth mode and a credential-shaped key", async () => {
  await withProject("git-config-auth-mode-", async (root) => {
    writeConfig(root, { git: { auth: { mode: "whatever" } } })
    const reading = await readGitProjectConfig(root, {}, HOME)
    assert.equal(reading.state, "invalid")
    if (reading.state !== "invalid") return
    assert.ok(/auth.mode must be "inherit" or "dedicated" or "environment" or "managed", not "whatever"/.test(reading.reason), reading.reason)
    // A key that would hold a secret is never read: it is reported as a key this stage does not use.
    const secret = writeConfig(root, { git: { auth: { mode: "inherit", username: "ada", password: "a-value-that-is-never-read" } } })
    const reported = await readGitProjectConfig(root, {}, HOME)
    assert.equal(reported.state, "effective")
    if (reported.state !== "effective") return
    assert.deepEqual(reported.reading.reportedKeys, ["git.auth.password"], "preserved and reported, not read")
    assert.equal(fs.readFileSync(configOf(root), "utf8"), secret, "the credential-shaped key stays in the file as it was")
    assert.equal(JSON.stringify(reported).includes("a-value-that-is-never-read"), false, "and its value is not carried in the reading")
    assert.ok(/keys read but not used: git.auth.password/.test(describeGitConfig(reported)), describeGitConfig(reported))
    // A direct email is attribution data, and it resolves without an environment.
    writeConfig(root, { git: { identity: { email: "moriarty@example.org" } } })
    const direct = await readGitProjectConfig(root, {}, HOME)
    assert.equal(direct.state, "effective")
    if (direct.state !== "effective") return
    assert.deepEqual(direct.reading.config.identity.email, { value: "moriarty@example.org" }, "a direct value is kept as a reference shape")
    const answer = resolveGitIdentity({ config: direct.reading.config, origin: "project", environment: {} })
    assert.equal(answer.state, "resolved")
    if (answer.state !== "resolved") return
    assert.equal(answer.resolution.moriarty?.email, "moriarty@example.org", "direct and env emails both resolve")
  })
})
