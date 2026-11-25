/**
 * The tools beyond reading and editing: finding files by name, read-only
 * git, and what the editor knows (errors, references, definitions,
 * renames, what the user has open), plus deleting and moving files.
 *
 * Git and file finding are plain Node. The editor's knowledge comes
 * through an `EditorSink` the extension provides, so these tools are
 * offered only where there is an editor to ask. What the editor reports
 * is held to the same rules as everything else: a place outside the
 * workspace, or in a file `.gitignore` ignores, is named but never read.
 */
import fs from "fs"
import path from "path"

import { GitRefusal, refuse } from "../git/baseline"
import {
  createGitExecutionService,
  cutToLine,
  GIT_OPERATIONS,
  gitCallIsReadOnly,
  GitInspectReading,
  GitOperation,
  GitServiceOptions,
  GitStatusReading,
  MAX_GIT_OUTPUT,
  RUN_GIT_OPERATIONS,
  toolCodeOfGitRefusal
} from "../git/service"

import type { AccessPreflight, AccessTarget } from "./access-preflight"
import { argumentFailure, type ArgumentReader, argumentReader, jsonType, type ToolArguments } from "./arguments"
import {
  gitNamedPaths,
  globToRegExp,
  indexChangeNote,
  locateSymbol,
  readOnlyGitArgs,
  withoutHiddenDiffs,
  withoutHiddenLines
} from "./helpers"
import type { OperationAuthorization } from "./operation-authorization"
import { clip, linesOf, plural, ToolInputError, WorkspaceView } from "./view"
import type { EditOutcome, Tool, ToolContext, ToolResult, WorkspaceSearchProvider } from "./workspace"

const MAX_FOUND_FILES = 100
const MAX_LOCATIONS = 50
/** How many of a rename's files the tool lists with their hash. */
const MAX_RENAME_HASH_LINES = 20

/** A place in a file, as the editor reports it. `line` is 1-based. */
export interface EditorLocation {
  file: string
  line: number
}

export interface EditorDiagnostic extends EditorLocation {
  severity: "error" | "warning" | "info"
  message: string
  source?: string
}

export interface EditorContextView {
  activeFile?: string
  /** 1-based. */
  cursorLine?: number
  selection?: { startLine: number; endLine: number; text: string }
  openFiles: string[]
}

/**
 * What the extension answers from VS Code and its language servers.
 * Positions are 0-based here, as the editor takes them.
 */
export interface EditorSink {
  diagnostics(file?: string): Promise<EditorDiagnostic[]>
  references(file: string, line: number, character: number): Promise<EditorLocation[]>
  definition(file: string, line: number, character: number): Promise<EditorLocation[]>
  /**
   * Rename everywhere the language server knows of; applied or put to the user as the edit mode says.
   * Before anything changes, `authorizeOutside` is asked about the affected files outside the workspace; a message back refuses the whole rename.
   * Once the change was attempted, every file it reached is caught up with the index; `fileHashes` is the whole-file hash of each, keyed by the same paths as `files`.
   */
  rename(file: string, line: number, character: number, newName: string, authorizeOutside?: (files: string[]) => Promise<string | undefined>): Promise<EditOutcome & { files?: string[]; fileHashes?: Record<string, string> }>
  context(): Promise<EditorContextView>
}

/** Deleting and moving files, applied or put to the user as the edit mode says. */
export interface FileOpsSink {
  remove(file: string, write?: OperationAuthorization): Promise<EditOutcome>
  move(from: string, to: string, write?: OperationAuthorization): Promise<EditOutcome>
}

// The words in a glob, for looking around when it matches nothing:
// "src/**" + "/*adapter*.ts" gives "adapter".
const globWords = (glob: string) =>
  [...new Set(glob.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) ?? [])].filter(
    (word) => !["src", "test", "tests", "index"].includes(word)
  )

export const findFiles = (view: WorkspaceView, search?: WorkspaceSearchProvider): Tool => ({
  name: "find_files",
  readOnly: true,
  description:
    "Find files and folders by path or glob. In automatic mode, a plain-text query with no path match may also find source symbols or content; that fallback is labeled. Use mode=path to keep the search filename-only.",
  parameters: [{ name: "pattern", description: "A filename or path glob, or a plain-text discovery query." }, { name: "mode", description: "auto (default) or path to disable symbol/content fallback.", optional: true }],
  async run(raw) {
    const a = argumentReader("find_files", raw)
    const pattern = a.text("pattern")
    const mode = a.text("mode")
    const glob = pattern?.trim().replace(/\/+$/, "")
    if (!glob) throw new ToolInputError("find_files needs a pattern.")
    const regex = globToRegExp(glob)
    const files = (await view.allFiles()).map((file) => view.relative(file)).filter((rel) => regex.test(rel))
    const dirs = (await view.allDirs()).map((dir) => view.relative(dir))
    const matches = [...dirs.filter((rel) => regex.test(rel)).map((rel) => `${rel}/`), ...files].sort()
    const shown = matches.slice(0, MAX_FOUND_FILES)
    if (!shown.length) {
      const plainText = !glob.includes("/") && !/[/*?{}[\]]/.test(glob) && !/\.[a-z0-9]{1,10}$/i.test(glob)
      if (search && mode !== "path" && plainText) {
        const fallback = await search.search({ query: glob, mode: "auto", limit: MAX_FOUND_FILES }, view.root)
        if (fallback.results.length) {
          const entries = fallback.results.map((hit) => hit.category + ": " + hit.path + (hit.line ? ":" + hit.line + (hit.column ? ":" + hit.column : "") : "") + " [" + hit.source + "]" + (hit.symbol ? " " + (hit.kind ?? "symbol") + " " + hit.symbol : "") + " — " + hit.preview)
          return { output: "No file path matched. Automatic symbol/content fallback (discovery only):\n" + entries.join("\n"), summary: "searched symbols and source for '" + glob + "' · " + plural(fallback.total, "match") }
        }
      }
      // A dead end costs a step; a folder with the same word in its name is usually where to look.
      const words = globWords(glob)
      const near = dirs
        .filter((rel) => words.some((word) => (rel.split("/").pop() ?? "").toLowerCase().includes(word)))
        .slice(0, 5)
      return {
        output: near.length ? `No files match. Folders with a similar name: ${near.map((rel) => `${rel}/`).join(", ")}` : "No files match.",
        summary: `found files \`${glob}\` · none`
      }
    }
    return {
      output: shown.join("\n") + (matches.length > shown.length ? `\n… ${matches.length - shown.length} more; narrow the pattern` : ""),
      summary: `found files \`${glob}\` · ${plural(files.length, "file")}${matches.length > files.length ? `, ${plural(matches.length - files.length, "folder")}` : ""}`
    }
  }
})

/** Whether `root` is in a git working tree: a `.git` in it or in a folder above. */
export const insideGitRepository = (root: string): boolean => {
  for (let dir = root; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, ".git"))) return true
    if (path.dirname(dir) === dir) return false
  }
}

/**
 * The existing read-only `git` tool, extended on the same name. Legacy `args` answers exactly as it did -
 * the same allowlist, the same path rules, the same capped output - while operation "status" and operation
 * "inspect" run through the shared Git service. The two forms are mutually exclusive, and the read-only
 * classification is per call: an operation that would change the repository is named here but not run,
 * because commit, push and recovery belong to the stages that own staging and the transaction. One tool
 * name stays in the inventory.
 */
export const git = (view: WorkspaceView, options: Omit<GitServiceOptions, "view"> = {}): Tool => {
  const service = createGitExecutionService({ ...options, view })

  /** A refusal as §14 shapes it: what was asked for, that nothing ran, and what the call can do instead. */
  const refused = (refusal: GitRefusal, operation: string): ToolResult => {
    const shared = toolCodeOfGitRefusal(refusal.code)
    return {
      output: JSON.stringify({ ok: false, error: { code: refusal.code, executed: refusal.executed, message: refusal.summary, recovery: refusal.output } }),
      summary: `git \`${operation}\` · ${refusal.summary}`,
      failed: true,
      ...(shared === undefined ? {} : { error: argumentFailure(shared, `${shared}: ${refusal.summary}`, { recovery: refusal.output }) })
    }
  }

  const summaryOf = (reading: GitStatusReading | GitInspectReading): string => {
    if (reading.kind === "git_status")
      return `git \`status\` · ${plural(reading.staged.length, "staged file", "staged files")}, ${plural(reading.unstaged.length, "unstaged file", "unstaged files")}, ${plural(reading.untracked.length, "untracked file")}` + (reading.leftOut ? `; ${plural(reading.leftOut, "file")} left out` : "")
    return `git \`inspect\` · ${plural(reading.changes.length, "path")}` + (reading.clipped ? `, ${reading.clipped} characters kept for the recorded raw output` : "") + (reading.leftOut ? `; ${plural(reading.leftOut, "file")} left out` : "")
  }

  /** The structured reading as the model sees it: compact, with the whole bounded text left to the recorded raw output. */
  const shaped = (reading: GitStatusReading | GitInspectReading, raw: ToolArguments): ToolResult => {
    const fields = reading as GitInspectReading & { retained?: string }
    const { retained, kind, ...visible } = fields
    const observationId = options.observations?.({ name: "git", args: raw })
    return {
      output: JSON.stringify({ kind, ...(observationId === undefined ? {} : { observationId }), ...visible }),
      summary: summaryOf(reading),
      ...(retained === undefined ? {} : { rawOutput: retained })
    }
  }

  const typed = async (a: ArgumentReader, raw: ToolArguments, operation: string, context?: ToolContext): Promise<ToolResult> => {
    if (a.sent("args"))
      return refused(refuse("git_argument_conflict", "git refused: args and operation cannot be sent together", "Send one or the other: `args` for a read-only command line, `operation` for status or inspect."), operation)
    const wanted = operation.trim()
    if (!GIT_OPERATIONS.includes(wanted as GitOperation))
      return refused(refuse("git_argument_conflict", `git refused: operation "${wanted}" is not one this tool answers for`, `Ask for ${GIT_OPERATIONS.join(", ")}, or send args instead.`), operation)
    if (!RUN_GIT_OPERATIONS.includes(wanted as GitOperation))
      return refused(refuse("git_operation_not_supported", `git refused: ${wanted} is not run by this stage`, "This stage reads only. Commit, push and recovery belong to the stages that own the alternate index and the transaction; nothing here runs them."), operation)
    const given = a.structure("paths")
    const paths: string[] = []
    if (given !== undefined) {
      if (!Array.isArray(given))
        return refused(refuse("git_argument_conflict", "git refused: paths must be a list of paths", `paths came as ${jsonType(given)}; send an array such as ["src/a.ts"].`), operation)
      for (const entry of given) {
        if (typeof entry !== "string")
          return refused(refuse("git_argument_conflict", "git refused: paths must name each path as text", `paths holds ${jsonType(entry)}; each entry must be a path as text.`), operation)
        paths.push(entry)
      }
    }
    const named = a.text("repository")
    const reading = wanted === "status" ? await service.status(named, context?.signal) : await service.inspect(paths, named, context?.signal)
    if ("code" in reading) return refused(reading, wanted)
    return shaped(reading, raw)
  }

  return {
    name: "git",
    readOnly: true,
    readOnlyFor: gitCallIsReadOnly,
    description:
      "Run a read-only git command in the workspace, or ask for one of the typed operations: status and inspect. No approval needed; nothing is changed.",
    guidance: "Use git to see what changed (git diff, git status) or the history of a file (git log -p -- path) before you edit. For repository state, and for who owns a change, ask operation status or operation inspect.",
    parameters: [
      { name: "args", description: "The git command without `git`, e.g. `diff --stat` or `log -5 --oneline -- src/a.ts`.", optional: true },
      { name: "operation", description: "A typed operation instead of args: status for repository state, inspect for the selected paths and what the host can say about each.", optional: true },
      { name: "repository", description: "A repository to read when it is not the workspace folder itself; it must be inside the workspace or granted.", optional: true },
      { name: "paths", description: "The paths an operation answers for; every change this workspace may show when left out.", optional: true, type: "array" }
    ],
    async run(raw, context) {
      const a = argumentReader("git", raw)
      const operation = a.text("operation")
      if (operation !== undefined && operation.trim() !== "") return typed(a, raw, operation, context)
      const args = a.text("args")
      const line = args?.trim()
      if (!line) throw new ToolInputError("git needs arguments such as status, or an operation such as status or inspect.")
      const parsed = readOnlyGitArgs(line)
      if (typeof parsed === "string") throw new ToolInputError(`${parsed}.`)
      const at = await service.prefix(view.root)
      // What .gitignore keeps from read_file, git does not hand over either.
      const named = gitNamedPaths(parsed).find((p) => (p.inRepo ? service.hiddenIn(p.path, at) : service.hiddenHere(p.path)))
      if (named) throw new ToolInputError(`${named.path} is outside the workspace or ignored by .gitignore and cannot be read.`)
      const refusal = await service.refuseBareArguments(parsed, context?.signal)
      if (refusal) throw new ToolInputError(refusal)
      const { output: stdout, exitCode } = await service.runGit(view.root, parsed, context?.signal)
      // ls-files names what git tracks, ignored or not; the hidden ones are left out.
      const listed = parsed[0] === "ls-files" ? withoutHiddenLines(stdout, service.hiddenHere) : { text: stdout, dropped: 0 }
      const diffs = withoutHiddenDiffs(listed.text, (file) => service.hiddenIn(file, at))
      const text = diffs.text
      const dropped = diffs.dropped + listed.dropped
      const shown =
        text.length > MAX_GIT_OUTPUT
          ? `${cutToLine(text, MAX_GIT_OUTPUT)}\n… ${text.length - MAX_GIT_OUTPUT} more characters; narrow it with a path, -n or --stat`
          : text
      const command = line.replace(/^\s*git\s+/, "")
      return {
        output: `$ git ${command}\n(exit code ${exitCode})\n${shown.trim() || "(no output)"}`,
        summary:
          `git \`${command}\`` +
          (exitCode ? ` · exit ${exitCode}` : "") +
          (dropped ? ` · ${plural(dropped, "file")} left out` : ""),
        failed: exitCode !== 0
      }
    }
  }
}

/** The lines of each file a result points into, read once per call. */
const lineReader = (view: WorkspaceView) => {
  const files = new Map<string, Promise<string[]>>()
  return async (file: string, line: number): Promise<string> => {
    let lines = files.get(file)
    if (!lines) {
      lines = view.text(file).then((text) => (text === undefined ? [] : linesOf(text)))
      files.set(file, lines)
    }
    return ((await lines)[line - 1] ?? "").trim()
  }
}

/**
 * Places as `path:line: text`, the workspace's own first. A place outside
 * the workspace or in an ignored file is named, not read.
 */
const locatedLines = async (view: WorkspaceView, locations: EditorLocation[]) => {
  const read = lineReader(view)
  const seen = new Set<string>()
  const unique = locations.filter((l) => {
    const key = `${l.file}:${l.line}`
    return seen.has(key) ? false : (seen.add(key), true)
  })
  const inside = unique.filter((l) => view.visible(l.file))
  const outside = unique.filter((l) => !view.visible(l.file))
  const lines = await Promise.all(
    inside.slice(0, MAX_LOCATIONS).map(async (l) => `${view.relative(l.file)}:${l.line}: ${clip(await read(l.file, l.line))}`)
  )
  if (inside.length > MAX_LOCATIONS) lines.push(`… ${inside.length - MAX_LOCATIONS} more`)
  return { lines, inside, outside }
}

/** A place the tools may not read, named so the model knows why it stops there. */
const outsidePlace = (view: WorkspaceView, location: EditorLocation) => {
  const relative = view.relative(location.file)
  const shown = relative.startsWith("..") || path.isAbsolute(relative) ? location.file : relative
  return `${shown}:${location.line}: (outside the workspace or ignored; it cannot be read)`
}

/** The position of `symbol` in `file`, for asking the language server. */
const symbolAt = async (view: WorkspaceView, file: string | undefined, symbol: string | undefined, line?: number) => {
  if (!file) throw new ToolInputError("A path is needed.")
  const wanted = symbol?.trim()
  if (!wanted) throw new ToolInputError("A symbol name is needed.")
  const absolute = view.resolve(file, "file")
  const text = await view.text(absolute)
  if (text === undefined) throw new ToolInputError(`${view.relative(absolute)} is binary or too large.`)
  const at = locateSymbol(text.replace(/\r\n/g, "\n"), wanted, line && line > 0 ? line : undefined)
  if (!at) throw new ToolInputError(`${wanted} does not appear in ${view.relative(absolute)}.`)
  return { absolute, rel: view.relative(absolute), wanted, ...at }
}

const SYMBOL_PARAMETERS = [
  { name: "path", description: "A file where the symbol appears." },
  { name: "symbol", description: "The symbol's name." },
  { name: "line", description: "The line it is on, when the name appears more than once.", optional: true, type: "integer" as const }
]

export const diagnostics = (view: WorkspaceView, editor: EditorSink): Tool => ({
  name: "diagnostics",
  description:
    "The errors and warnings the editor's language servers report for a file. Without a path: for every file the editor has checked, which is usually the open ones.",
  guidance: "After editing, call diagnostics on the files you changed to catch errors before you finish.",
  parameters: [{ name: "path", description: "A file; everything the editor has checked when left out.", optional: true }],
  async run(raw) {
      const a = argumentReader("diagnostics", raw)
      const file = a.text("path")
    const absolute = file ? view.resolve(file, "file") : undefined
    const found = (await editor.diagnostics(absolute)).filter(
      (d) => d.severity !== "info" && view.visible(d.file)
    )
    const errors = found.filter((d) => d.severity === "error").length
    const where = absolute ? `\`${view.relative(absolute)}\`` : "the workspace"
    return {
      output: found.length
        ? found
            .slice(0, MAX_LOCATIONS)
            .map((d) => `${view.relative(d.file)}:${d.line}: ${d.severity}: ${clip(d.message)}${d.source ? ` (${d.source})` : ""}`)
            .join("\n") + (found.length > MAX_LOCATIONS ? `\n… ${found.length - MAX_LOCATIONS} more` : "")
        : `No errors or warnings in ${absolute ? view.relative(absolute) : "the files the editor has checked"}.`,
      summary: `checked ${where} · ${found.length ? `${plural(errors, "error")}, ${plural(found.length - errors, "warning")}` : "clean"}`
    }
  }
})

export const findReferences = (view: WorkspaceView, editor: EditorSink): Tool => ({
  name: "find_references",
  readOnly: true,
  description: "Every place a function, class, variable or type is used, from the language server; exact, unlike grep.",
  parameters: SYMBOL_PARAMETERS,
  async run(raw) {
    const a = argumentReader("find_references", raw)
    const file = a.text("path")
    const symbol = a.text("symbol")
    const line = a.line("line")
    const at = await symbolAt(view, file, symbol, line)
    const { lines, inside, outside } = await locatedLines(view, await editor.references(at.absolute, at.line, at.character))
    if (outside.length) lines.push(`… and ${plural(outside.length, "place")} outside the workspace or in ignored files`)
    return {
      output: lines.length ? lines.join("\n") : `The language server found no references to ${at.wanted}.`,
      summary: `references to \`${at.wanted}\` · ${plural(inside.length, "place")}`
    }
  }
})

export const goToDefinition = (view: WorkspaceView, editor: EditorSink): Tool => ({
  name: "go_to_definition",
  readOnly: true,
  description: "Where the symbol used at a place is defined, from the language server; follows imports.",
  parameters: SYMBOL_PARAMETERS,
  async run(raw) {
    const a = argumentReader("go_to_definition", raw)
    const file = a.text("path")
    const symbol = a.text("symbol")
    const line = a.line("line")
    const at = await symbolAt(view, file, symbol, line)
    const { lines, inside, outside } = await locatedLines(view, await editor.definition(at.absolute, at.line, at.character))
    // A library's definition is worth knowing about even though it cannot be opened.
    if (!inside.length) lines.push(...outside.slice(0, 3).map((l) => outsidePlace(view, l)))
    return {
      output: lines.length ? lines.join("\n") : `The language server does not know where ${at.wanted} is defined.`,
      summary:
        `definition of \`${at.wanted}\` · ` +
        (inside.length ? view.relative(inside[0].file) : outside.length ? "outside the workspace" : "not found")
    }
  }
})

export const renameSymbol = (view: WorkspaceView, editor: EditorSink, access?: AccessPreflight): Tool => ({
  name: "rename_symbol",
  description: "Rename a function, class, variable or type everywhere it is used, through the language server. Better than editing each use.",
  parameters: [...SYMBOL_PARAMETERS.slice(0, 2), { name: "new_name", description: "The new name." }, SYMBOL_PARAMETERS[2]],
  async run(raw, context) {
    const a = argumentReader("rename_symbol", raw)
    const file = a.text("path")
    const symbol = a.text("symbol")
    const new_name = a.text("new_name")
    const line = a.line("line")
    const newName = new_name?.trim()
    if (!newName) throw new ToolInputError("rename_symbol needs new_name.")
    const at = await symbolAt(view, file, symbol, line)
    const authorizeOutside = access
      ? async (files: string[]) => {
          const verdict = await access.authorize(
            files.map((target): AccessTarget => ({ path: target, access: "write" })),
            "rename_symbol",
            context?.signal
          )
          return verdict.ok ? undefined : verdict.message
        }
      : undefined
    const outcome = await editor.rename(at.absolute, at.line, at.character, newName, authorizeOutside)
    view.forgetFiles()
    if (!outcome.ok) {
      return { output: outcome.message, summary: `\`${at.wanted}\` not renamed · ${outcome.message}`, failed: true }
    }
    const files = outcome.files?.length ?? 0
    const hashes = Object.entries(outcome.fileHashes ?? {})
    const lines = hashes.slice(0, MAX_RENAME_HASH_LINES).map(([file, hash]) => `content_hash(${file}): ${hash}`)
    if (hashes.length > MAX_RENAME_HASH_LINES) lines.push(`… and ${hashes.length - MAX_RENAME_HASH_LINES} more files`)
    return {
      output: outcome.message + (lines.length ? `\n${lines.join("\n")}` : "") + indexChangeNote(outcome),
      summary: `renamed \`${at.wanted}\` → \`${newName}\`${files ? ` · ${plural(files, "file")}` : ""}`,
      final: outcome.pending
    }
  }
})

export const editorContext = (view: WorkspaceView, editor: EditorSink): Tool => ({
  name: "editor_context",
  description: "What the user is looking at now: the active file, the cursor line, the selected text and the other open files.",
  parameters: [],
  async run() {
    const context = await editor.context()
    const active = context.activeFile && view.visible(context.activeFile) ? view.relative(context.activeFile) : undefined
    const open = context.openFiles.filter((f) => view.visible(f)).map((f) => view.relative(f)).filter((f) => f !== active)
    const lines = [
      active
        ? `Active file: ${active}${context.cursorLine ? `, cursor on line ${context.cursorLine}` : ""}`
        : context.activeFile
          ? "The active file is outside the workspace or ignored by .gitignore; it cannot be read."
          : "No file is active.",
      ...(context.selection && active
        ? [`Selected, lines ${context.selection.startLine}-${context.selection.endLine}:`, context.selection.text]
        : []),
      ...(open.length ? [`Also open: ${open.join(", ")}`] : [])
    ]
    return {
      output: lines.join("\n"),
      summary: `looked at the editor · ${active ? `\`${active}\`` : "nothing readable open"}${context.selection && active ? " with a selection" : ""}`
    }
  }
})

export const deleteFile = (view: WorkspaceView, ops: FileOpsSink): Tool => ({
  name: "delete_file",
  description: "Delete a file in the workspace.",
  parameters: [{ name: "path", description: "The file to delete." }],
  async run(raw, context) {
    const a = argumentReader("delete_file", raw)
    const file = a.text("path")
    if (!file) throw new ToolInputError("delete_file needs a path.")
    const absolute = view.resolve(file, "file")
    const rel = view.relative(absolute)
    const outcome = await ops.remove(absolute, context?.write)
    view.forgetFiles()
    return outcome.ok
      ? { output: outcome.message + indexChangeNote(outcome), summary: `deleted \`${rel}\`` }
      : { output: outcome.message, summary: `\`${rel}\` not deleted · ${outcome.message}`, failed: true }
  }
})

export const moveFile = (view: WorkspaceView, ops: FileOpsSink): Tool => ({
  name: "move_file",
  description:
    "Move or rename a file; missing folders are made. Imports of it elsewhere are not rewritten for you: find them with find_references or grep and fix them.",
  parameters: [
    { name: "from", description: "The file now." },
    { name: "to", description: "Where it goes; must not exist yet." }
  ],
  async run(raw, context) {
    const a = argumentReader("move_file", raw)
    const from = a.text("from")
    const to = a.text("to")
    if (!from || !to) throw new ToolInputError("move_file needs from and to.")
    const source = view.resolve(from, "file")
    const target = view.resolveNew(to)
    const outcome = await ops.move(source, target, context?.write)
    view.forgetFiles()
    const summary = `\`${view.relative(source)}\` → \`${view.relative(target)}\``
    const hash = outcome.contentHash ? `\ncontent_hash: ${outcome.contentHash} (unchanged by the move)` : ""
    return outcome.ok
      ? { output: outcome.message + hash + indexChangeNote(outcome), summary: `moved ${summary}` }
      : { output: outcome.message, summary: `not moved ${summary} · ${outcome.message}`, failed: true }
  }
})
