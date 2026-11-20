/**
 * The tools beyond reading and editing: globs, symbol positions, the
 * read-only git tool (against a real repository) and finding files.
 */
import * as assert from "node:assert"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"

import { fingerprintContent } from "../../extension/tools/fingerprint"
import { globToRegExp, locateSymbol, readOnlyGitArgs, splitArgs } from "../../extension/tools/helpers"
import { FileOpsSink } from "../../extension/tools/more"
import { EditOutcome, IndexRefreshOutcome, workspaceTools } from "../../extension/tools/workspace"

test("globs match relative paths; a bare pattern matches the name anywhere", () => {
  const match = (glob: string, file: string) => globToRegExp(glob).test(file)
  assert.ok(match("*.test.ts", "src/a/b.test.ts"))
  assert.ok(match("**/*.test.ts", "b.test.ts"))
  assert.ok(match("src/**/index.*", "src/a/b/index.tsx"))
  assert.ok(match("src/*.{ts,tsx}", "src/a.tsx"))
  assert.ok(!match("src/*.ts", "src/a/b.ts"))
  assert.ok(!match("*.ts", "src/a.tsx"))
  assert.ok(match("package.json", "package.json"))
})

test("a symbol is found on the line asked for, nearby, or where it is declared", () => {
  const text = "import { warm } from './w'\n\nexport function warmUp() {\n  return warm()\n}\nconst warm = 1"
  assert.deepStrictEqual(locateSymbol(text, "warm", 4), { line: 3, character: 9 })
  assert.deepStrictEqual(locateSymbol(text, "warm", 2), { line: 0, character: 9 }, "nearest line when not on the one asked")
  assert.deepStrictEqual(locateSymbol(text, "warm"), { line: 5, character: 6 }, "the declaration without a line")
  assert.deepStrictEqual(locateSymbol(text, "warmUp"), { line: 2, character: 16 })
  assert.strictEqual(locateSymbol(text, "cold"), undefined)
})

test("git arguments: read-only subcommands only, and settings cannot run programs", () => {
  assert.deepStrictEqual(splitArgs("log -3 --format=\"%h %s\" -- 'a b.ts'"), ["log", "-3", "--format=%h %s", "--", "a b.ts"])
  assert.deepStrictEqual(readOnlyGitArgs("git diff --stat"), ["diff", "--no-ext-diff", "--no-textconv", "--stat"])
  assert.deepStrictEqual(readOnlyGitArgs("status -u"), ["status", "-u"])
  assert.deepStrictEqual(readOnlyGitArgs("branch -a"), ["branch", "-a"])
  assert.deepStrictEqual(readOnlyGitArgs("log -C -n 2"), ["log", "--no-ext-diff", "--no-textconv", "-C", "-n", "2"], "copy detection is a plain diff option")
  assert.deepStrictEqual(readOnlyGitArgs("shortlog -sn"), ["shortlog", "-sn", "HEAD"], "without a revision shortlog would wait on standard input")
  for (const bad of [
    "push",
    "commit -m x",
    "checkout main",
    "diff --output=/tmp/x",
    "-c core.pager=evil log",
    "branch new-thing",
    "branch -D main",
    "diff --ext-diff",
    "diff --no-index /etc/passwd /dev/null",
    "blame --contents /etc/passwd README.md",
    "log -p --no-prefix",
    "log --oneline | head -5",
    "status > out.txt"
  ]) {
    assert.strictEqual(typeof readOnlyGitArgs(bad), "string", bad)
  }
})

const repo = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-git-"))
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" })
  git("init", "-q")
  git("config", "user.email", "t@example.com")
  git("config", "user.name", "T")
  fs.mkdirSync(path.join(root, "src"))
  fs.writeFileSync(path.join(root, "src", "a.ts"), "export const a = 1\n")
  fs.writeFileSync(path.join(root, "src", "a.test.ts"), "test\n")
  fs.writeFileSync(path.join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]))
  git("add", ".")
  git("commit", "-qm", "first")
  fs.writeFileSync(path.join(root, "src", "a.ts"), "export const a = 2\n")
  return root
}

test("the git tool reads a real repository and refuses to change it", async () => {
  const tools = workspaceTools(repo())
  const diff = await tools.run({ name: "git", args: { args: "diff" } })
  assert.match(diff.output, /^\$ git diff\n\(exit code 0\)\ndiff --git a\/src\/a.ts b\/src\/a.ts[\s\S]*-export const a = 1\n\+export const a = 2/)
  assert.strictEqual(diff.summary, "git `diff`")
  const log = await tools.run({ name: "git", args: { args: "log --oneline" } })
  assert.match(log.output, /first/)
  const refused = await tools.run({ name: "git", args: { args: "commit -am sneaky" } })
  assert.match(refused.output, /not allowed here/)
  assert.ok(refused.failed)
})

test("find_files finds every file by glob, binaries included", async () => {
  const tools = workspaceTools(repo())
  assert.strictEqual((await tools.run({ name: "find_files", args: { pattern: "*.test.ts" } })).output, "src/a.test.ts")
  assert.strictEqual((await tools.run({ name: "find_files", args: { pattern: "*.png" } })).output, "logo.png")
  assert.strictEqual((await tools.run({ name: "find_files", args: { pattern: "src/**" } })).output, "src/a.test.ts\nsrc/a.ts")
  assert.strictEqual((await tools.run({ name: "find_files", args: { pattern: "*.rs" } })).output, "No files match.")
})

test("editor tools, rename, delete and move are offered only when there is an editor and somewhere for edits to go", () => {
  const names = (tools: ReturnType<typeof workspaceTools>) => tools.tools.map((t) => t.name)
  const root = repo()
  assert.deepStrictEqual(names(workspaceTools(root)), ["list_dir", "find_files", "read_file", "grep", "find_symbol", "git"])
  const noop = async () => ({ ok: true, message: "" })
  const editor = {
    diagnostics: async () => [],
    references: async () => [],
    definition: async () => [],
    rename: noop,
    context: async () => ({ openFiles: [] })
  }
  const edits = { mode: "apply" as const, edit: noop, create: noop, editLines: noop, remove: noop, move: noop }
  assert.deepStrictEqual(names(workspaceTools(root, [], { edits, editor })), [
    "editor_context", "list_dir", "find_files", "read_file", "grep", "find_symbol",
    "go_to_definition", "find_references", "diagnostics", "git",
    "create_file", "edit_lines", "rename_symbol", "move_file", "delete_file"
  ])
})

test("edit_file is not offered; a call to it is refused with the tools that are, and edit_lines is among them", async () => {
  const root = repo()
  const noop = async () => ({ ok: true, message: "" })
  const tools = workspaceTools(root, [], {
    edits: { mode: "apply" as const, edit: noop, create: noop, editLines: noop }
  })
  assert.ok(tools.tools.some((t) => t.name === "edit_lines"))
  assert.ok(!tools.tools.some((t) => t.name === "edit_file"))
  const refused = await tools.run({ name: "edit_file", args: { path: "src/a.ts", find: "a", replace: "b" } })
  assert.match(refused.output, /There is no tool called edit_file\./)
  assert.match(refused.output, /edit_lines/)
})

test("read_file obeys the configured line cap and advertises it", async () => {
  const root = repo()
  const file = path.join(root, "src", "many-lines.ts")
  fs.writeFileSync(file, Array.from({ length: 250 }, (_, i) => `line ${i + 1}`).join("\n") + "\n")
  const tools = workspaceTools(root, [], { readFileMaxLines: 120 })
  const refused = await tools.run({ name: "read_file", args: { path: "src/many-lines.ts" } })
  assert.equal(refused.failed, true)
  assert.match(refused.output, /contains 250 lines\.\nConfigured maximum: 120 lines\./)
  const read = await tools.run({ name: "read_file", args: { path: "src/many-lines.ts", start_line: "1", end_line: "120" } })
  assert.match(read.output, /lines 1–120 of 250/)
  assert.strictEqual(read.summary, "read `src/many-lines.ts:1–120`")
  const desc = tools.tools.find((tool) => tool.name === "read_file")?.description
  assert.match(desc ?? "", /longer than 120 lines is refused/)
})

test("grep tries the pattern as plain text when it matches nothing as a regex", async () => {
  const root = repo()
  fs.writeFileSync(path.join(root, "keys.json"), "{ \"key\": \"ctrl+i\", \"call\": \"f(x)\" }\n")
  const tools = workspaceTools(root)
  const found = await tools.run({ name: "grep", args: { pattern: "\"key\": \"ctrl+i\"" } })
  assert.match(found.output, /^\(Nothing matched as a regular expression; these match the text as written\.\)\nkeys.json\n1: /)
  assert.strictEqual((await tools.run({ name: "grep", args: { pattern: "f(x)" } })).output.split("\n").length, 3)
  assert.strictEqual((await tools.run({ name: "grep", args: { pattern: "nothing+here" } })).output, "No matches.")
})

/** The tools with a sink for the change itself, so what the model reads is the outcome under test. */
const fileOpsTools = (root: string, ops: FileOpsSink) =>
  workspaceTools(root, [], {
    edits: {
      mode: "apply",
      edit: async () => ({ ok: true, message: "Applied." }),
      create: async () => ({ ok: true, message: "Created." }),
      remove: ops.remove,
      move: ops.move
    }
  })

const failureNote = (reason: string) =>
  ` Saved, but the search index could not be refreshed (${reason}); the change is complete and must not be repeated.`

test("move_file prints the moved file's hash only when the sink gives one", async () => {
  const root = repo()
  const hash = await fingerprintContent(fs.readFileSync(path.join(root, "src", "a.ts"), "utf8"))
  const run = async (extra: Partial<EditOutcome>) => (await fileOpsTools(root, {
    remove: async () => ({ ok: true, message: "" }),
    move: async () => ({ ok: true, message: "Moved src/a.ts to src/b.ts.", ...extra })
  }).run({ name: "move_file", args: { from: "src/a.ts", to: "src/b.ts" } }))
  assert.strictEqual((await run({ contentHash: hash })).output, `Moved src/a.ts to src/b.ts.\ncontent_hash: ${hash} (unchanged by the move)`)
  assert.strictEqual((await run({})).output, "Moved src/a.ts to src/b.ts.", "a sink that read nothing back leaves the line out")
})

test("delete_file reports a failed index refresh as a completed change and tells the model not to repeat it", async () => {
  const root = repo()
  const reason = "src/a.ts: could not be indexed"
  const tools = fileOpsTools(root, {
    remove: async () => ({ ok: true, message: "Deleted src/a.ts.", indexRefresh: { status: "failed", reason } }),
    move: async () => ({ ok: true, message: "" })
  })
  const deleted = await tools.run({ name: "delete_file", args: { path: "src/a.ts" } })
  assert.strictEqual(deleted.failed, undefined, "the change itself is still reported as a success")
  assert.strictEqual(deleted.output, `Deleted src/a.ts.${failureNote(reason)}`)
  assert.strictEqual(deleted.summary, "deleted `src/a.ts`", "the step line does not claim the index agreed")
})

test("move_file reports a failed index refresh the same way", async () => {
  const root = repo()
  const reason = "the database is busy"
  const tools = fileOpsTools(root, {
    remove: async () => ({ ok: true, message: "" }),
    move: async () => ({ ok: true, message: "Moved src/a.ts to src/b.ts.", indexRefresh: { status: "failed", reason } })
  })
  const moved = await tools.run({ name: "move_file", args: { from: "src/a.ts", to: "src/b.ts" } })
  assert.strictEqual(moved.failed, undefined, "the change itself is still reported as a success")
  assert.strictEqual(moved.output, `Moved src/a.ts to src/b.ts.${failureNote(reason)}`)
  assert.strictEqual(moved.summary, "moved `src/a.ts` → `src/b.ts`", "the step line does not claim the index agreed")
})

test("a synced or skipped refresh leaves delete_file and move_file output as it was", async () => {
  const root = repo()
  const run = async (indexRefresh?: IndexRefreshOutcome) => {
    const tools = fileOpsTools(root, {
      remove: async () => ({ ok: true, message: "Deleted src/a.ts.", indexRefresh }),
      move: async () => ({ ok: true, message: "Moved src/a.ts to src/b.ts.", indexRefresh })
    })
    return [
      await tools.run({ name: "delete_file", args: { path: "src/a.ts" } }),
      await tools.run({ name: "move_file", args: { from: "src/a.ts", to: "src/b.ts" } })
    ]
  }
  const plain = await run(undefined)
  assert.deepStrictEqual(plain, [
    { output: "Deleted src/a.ts.", summary: "deleted `src/a.ts`" },
    { output: "Moved src/a.ts to src/b.ts.", summary: "moved `src/a.ts` → `src/b.ts`" }
  ], "a success with nothing to say about the index is byte for byte as it was")
  assert.deepStrictEqual(await run({ status: "synced" }), plain)
  assert.deepStrictEqual(await run({ status: "skipped", reason: "excluded from the index" }), plain)
  assert.strictEqual((await run({ status: "skipped", reason: "indexing is disabled" }))[1].summary, plain[1].summary)
})

/** The rename tool with a sink answering with the outcome under test; the tool layer only formats what the sink was given. */
const renameTools = (
  root: string,
  outcome: EditOutcome & { files?: string[]; fileHashes?: Record<string, string> }
) =>
  workspaceTools(root, [], {
    edits: {
      mode: "apply",
      edit: async () => ({ ok: true, message: "Applied." }),
      create: async () => ({ ok: true, message: "Created." })
    },
    editor: {
      diagnostics: async () => [],
      references: async () => [],
      definition: async () => [],
      rename: async () => outcome,
      context: async () => ({ openFiles: [] })
    }
  })

const renamedMessage = "Renamed to b: 3 changes in src/a.ts, src/b.ts, saved."

test("rename_symbol prints the whole-file hash of every file the rename reached", async () => {
  const root = repo()
  const hashA = await fingerprintContent(fs.readFileSync(path.join(root, "src", "a.ts"), "utf8"))
  const hashB = await fingerprintContent("renamed b\n")
  const renamed = await renameTools(root, {
    ok: true,
    message: renamedMessage,
    files: ["src/a.ts", "src/b.ts"],
    fileHashes: { "src/a.ts": hashA, "src/b.ts": hashB }
  }).run({ name: "rename_symbol", args: { path: "src/a.ts", symbol: "a", new_name: "b" } })
  assert.strictEqual(renamed.failed, undefined)
  assert.strictEqual(
    renamed.output,
    `${renamedMessage}\ncontent_hash(src/a.ts): ${hashA}\ncontent_hash(src/b.ts): ${hashB}`
  )
  assert.strictEqual(renamed.summary, "renamed `a` → `b` · 2 files", "the step line is as it was")
})

test("the rename hash lines stop at 20 files and say how many more there are", async () => {
  const root = repo()
  const hash = await fingerprintContent("renamed\n")
  const files: string[] = []
  const fileHashes: Record<string, string> = {}
  for (let i = 0; i < 25; i++) {
    const name = `src/f${i}.ts`
    files.push(name)
    fileHashes[name] = hash
  }
  const renamed = await renameTools(root, { ok: true, message: "Renamed to b: 25 changes.", files, fileHashes })
    .run({ name: "rename_symbol", args: { path: "src/a.ts", symbol: "a", new_name: "b" } })
  const lines = renamed.output.split("\n")
  assert.strictEqual(lines.length, 22, "the message, 20 hashes and the count of the rest")
  assert.strictEqual(lines[1], `content_hash(src/f0.ts): ${hash}`)
  assert.strictEqual(lines[20], `content_hash(src/f19.ts): ${hash}`)
  assert.strictEqual(lines[21], "… and 5 more files")
})

test("a rename whose refresh failed is still the change, with the failure sentence after its hashes", async () => {
  const root = repo()
  const hash = await fingerprintContent("renamed\n")
  const reason = "src/a.ts: could not be indexed"
  const renamed = await renameTools(root, {
    ok: true,
    message: renamedMessage,
    files: ["src/a.ts"],
    fileHashes: { "src/a.ts": hash },
    indexRefresh: { status: "failed", reason }
  }).run({ name: "rename_symbol", args: { path: "src/a.ts", symbol: "a", new_name: "b" } })
  assert.strictEqual(renamed.failed, undefined, "the change itself is still reported as a success")
  assert.strictEqual(renamed.output, `${renamedMessage}\ncontent_hash(src/a.ts): ${hash}${failureNote(reason)}`)
})

test("a rename with no hashes and no failed refresh answers exactly as it did before", async () => {
  const root = repo()
  const run = async (extra: Partial<EditOutcome & { files?: string[]; fileHashes?: Record<string, string> }>) =>
    (await renameTools(root, { ok: true, message: renamedMessage, ...extra })
      .run({ name: "rename_symbol", args: { path: "src/a.ts", symbol: "a", new_name: "b" } }))
  const plain = await run({ files: ["src/a.ts"] })
  assert.strictEqual(plain.output, renamedMessage, "no hash lines, no note")
  assert.strictEqual(plain.summary, "renamed `a` → `b` · 1 file")
  assert.strictEqual((await run({ files: ["src/a.ts"], indexRefresh: { status: "synced" } })).output, renamedMessage)
  assert.strictEqual(
    (await run({ files: ["src/a.ts"], indexRefresh: { status: "skipped", reason: "excluded from the index" } })).output,
    renamedMessage
  )
  const refused = await run({ ok: false, message: "The editor refused the rename." })
  assert.strictEqual(refused.failed, true)
  assert.strictEqual(refused.output, "The editor refused the rename.", "a failure is the message alone")
})
