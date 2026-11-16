/**
 * The workspace as the tools see it: one root folder, its ignore rules,
 * and the checks that keep every tool inside it, or inside a folder the
 * user named in `twinny.chatToolsAllowedPaths`.
 *
 * Paths are resolved and their real location checked, so `..` and
 * symlinks cannot leave the root. Whatever a `.gitignore` ignores (where
 * `.env` files and build output live) cannot be listed, searched or read:
 * the root's `.gitignore` and the ones in the folders below it all count,
 * each for its own folder, as git reads them. A rule in a deeper file
 * cannot bring back what a file above it ignores; erring that way keeps
 * a secret hidden rather than shown.
 */
import fs from "fs"
import ignore, { Ignore } from "ignore"
import path from "path"

import { isIndexablePath, looksBinary } from "../embeddings/indexable"

import { authorizedRootOf, normalizeAuthorizedRoots } from "./authorized-paths"

export const MAX_LINE_CHARS = 200
const MAX_FILE_BYTES = 512 * 1024

export const clip = (line: string) =>
  line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line

export const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`

/** A file's lines as the tools number them: no carriage returns, and no empty line for the final newline. */
export const linesOf = (text: string): string[] => {
  const unix = text.replace(/\r\n/g, "\n")
  return unix === "" ? [] : unix.replace(/\n$/, "").split("\n")
}

/** Whether anything is at `file`, a link that leads nowhere included. */
const present = (file: string) => {
  try {
    fs.lstatSync(file)
    return true
  } catch {
    return false
  }
}

/** A tool's input was wrong; the message goes back to the model to fix its call. */
export class ToolInputError extends Error {}

/** A folder outside the root the tools were allowed in: as it was written, and as it really is. */
export interface AuthorizedRoot {
  /** The folder, absolute, normalized and deduplicated. */
  root: string
  /** Its path with links resolved, so a link inside it cannot lead out of it. */
  real: string
}

/** A granted folder as it really is, or the folder itself where it does not exist yet. */
const realPathOf = (dir: string): string => {
  try {
    return fs.realpathSync(dir)
  } catch {
    return dir
  }
}

/** The workspace as the tools see it: a root, its ignore rules, its files. */
export class WorkspaceView {
  private readonly _realRoot: string
  /** Rules that hold everywhere: `.git`, `node_modules`, the user's ignored globs. */
  private readonly _base: Ignore
  /** Each folder's own `.gitignore`, read once; null where there is none. */
  private readonly _gitignores = new Map<string, Ignore | null>()
  private _files?: Promise<string[]>
  private _tree?: Promise<{ files: string[]; dirs: string[] }>

  /** Paths the team's rules keep from the agent, said so when one is asked for. */
  private readonly _blocked?: Ignore

  /** Folders the tools were granted outside the root, never inside it. */
  private readonly _authorized: AuthorizedRoot[]

  constructor(
    readonly root: string,
    ignoredGlobs: string[] = [],
    private readonly _read?: (file: string) => Promise<string | undefined>,
    blockedGlobs: string[] = [],
    authorizedRoots: readonly string[] = []
  ) {
    this._realRoot = fs.realpathSync(root)
    this._base = ignore().add([".git", "node_modules", ...ignoredGlobs])
    if (blockedGlobs.length) this._blocked = ignore().add(blockedGlobs)
    this._authorized = normalizeAuthorizedRoots(authorizedRoots)
      .filter((entry) => !this.inside(entry))
      .map((entry) => ({ root: entry, real: realPathOf(entry) }))
  }

  /** Whether the team's rules keep a path under the root from the agent. */
  blocked(relative: string, isDirectory = false): boolean {
    if (!this._blocked) return false
    const parts = relative.split(/[\\/]+/).filter(Boolean)
    if (!parts.length || parts[0] === "..") return false
    return this._blocked.ignores(parts.join("/") + (isDirectory ? "/" : ""))
  }

  private gitignoreOf(dir: string): Ignore | null {
    let rules = this._gitignores.get(dir)
    if (rules === undefined) {
      try {
        rules = ignore().add(fs.readFileSync(path.join(dir, ".gitignore"), "utf8"))
      } catch {
        rules = null
      }
      this._gitignores.set(dir, rules)
    }
    return rules
  }

  /**
   * Whether a path under the root is ignored. `relative` is relative to
   * the root, in either separator.
   */
  ignored(relative: string, isDirectory = false): boolean {
    const parts = relative.split(/[\\/]+/).filter(Boolean)
    if (!parts.length || parts[0] === "..") return false
    const whole = parts.join("/") + (isDirectory ? "/" : "")
    if (this._base.ignores(whole) || this._blocked?.ignores(whole)) return true
    for (let depth = 0; depth < parts.length; depth++) {
      const rules = this.gitignoreOf(path.join(this.root, ...parts.slice(0, depth)))
      if (rules?.ignores(parts.slice(depth).join("/") + (isDirectory ? "/" : ""))) return true
    }
    return false
  }

  /** Whether `real` is `root` itself or a folder under it, by whole segments. */
  private inside(real: string, root = this._realRoot) {
    return real === root || real.startsWith(root + path.sep)
  }

  /** The granted folder `absolute` sits in, when it is outside the root itself. */
  private externalRoot(absolute: string): AuthorizedRoot | undefined {
    const target = path.resolve(absolute)
    const granted = authorizedRootOf(target, this._authorized.map((entry) => entry.root))
    if (!granted) return undefined
    // A path inside the root is the root's own, with the root's own rules.
    const relative = path.relative(this.root, target)
    if (relative === "" || (!path.isAbsolute(relative) && !relative.startsWith(".."))) return undefined
    return this._authorized.find((entry) => entry.root === granted)
  }

  /** Whether the path is outside the root but inside a folder the user granted. */
  isExternal(absolute: string): boolean {
    return this.externalRoot(absolute) !== undefined
  }

  /**
   * What keeps a path in a granted folder from the agent: the team's rules
   * matching it without its leading separator or drive prefix, or the rules
   * that hold everywhere matching it against that folder. A `.gitignore` file
   * is not read there, since it is not the project's own.
   */
  private externalDenied(external: AuthorizedRoot, absolute: string, isDirectory = false): "blocked" | "ignored" | undefined {
    const target = path.resolve(absolute)
    if (this._blocked && path.isAbsolute(target)) {
      const whole = target.slice(path.parse(target).root.length).split(path.sep).join("/")
      if (whole && this._blocked.ignores(whole + (isDirectory ? "/" : ""))) return "blocked"
    }
    const within = path.relative(external.real, target).split(path.sep).join("/")
    if (within && this._base.ignores(within + (isDirectory ? "/" : ""))) return "ignored"
    return undefined
  }

  /** Whether a path is kept from the agent, wherever it is: the project's own rules inside the root, the rules that hold everywhere in a granted folder. */
  private ignoredAt(absolute: string, isDirectory = false): boolean {
    const external = this.externalRoot(absolute)
    if (external) return this.externalDenied(external, absolute, isDirectory) !== undefined
    return this.ignored(path.relative(this.root, absolute), isDirectory)
  }

  /** Whether an absolute path is one the tools may show: inside the root and not ignored, or in a granted folder and not kept. */
  visible(absolute: string): boolean {
    const external = this.externalRoot(absolute)
    if (external) return this.externalDenied(external, absolute, false) === undefined
    const relative = path.relative(this.root, absolute)
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return false
    return !this.ignored(relative)
  }

  /** `relative` as an absolute path inside the root, or a reason it is not allowed. */
  resolve(relative = ".", kind: "file" | "dir" | "any"): string {
    const cleaned = relative.trim().replace(/^\.\/+/, "") || "."
    let absolute = path.resolve(this.root, cleaned)
    // `/src/a.ts` meaning the workspace's src, as models sometimes write it.
    if (path.isAbsolute(cleaned) && !this.inside(absolute) && !fs.existsSync(absolute)) {
      absolute = path.join(this.root, cleaned)
    }
    let real: string
    try {
      real = fs.realpathSync(absolute)
    } catch {
      throw new ToolInputError(`${cleaned} does not exist.`)
    }
    // A granted folder is checked by where the path really is, not only by
    // where it was written: a link inside it could lead out of it.
    const external = this.externalRoot(absolute)
    if (external) {
      if (!this.inside(real, external.real)) {
        throw new ToolInputError(`${cleaned} is outside the workspace.`)
      }
      const stat = fs.statSync(real)
      const denied = this.externalDenied(external, real, stat.isDirectory())
      if (denied === "blocked") {
        throw new ToolInputError(`${cleaned} is kept from the agent by the team's rules and cannot be read.`)
      }
      if (denied === "ignored") {
        throw new ToolInputError(`${cleaned} is ignored and cannot be read.`)
      }
      if (kind === "file" && !stat.isFile()) throw new ToolInputError(`${cleaned} is not a file.`)
      if (kind === "dir" && !stat.isDirectory()) throw new ToolInputError(`${cleaned} is not a directory.`)
      return absolute
    }
    const rel = path.relative(this.root, absolute)
    if (!this.inside(real) || rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new ToolInputError(`${cleaned} is outside the workspace.`)
    }
    const stat = fs.statSync(real)
    // A link is judged by where it leads as well as by its own name, so
    // `envlink -> .env` hides what `.env` hides.
    const realRel = path.relative(this._realRoot, real)
    if (realRel && realRel !== rel && this.ignored(realRel, stat.isDirectory())) {
      throw new ToolInputError(
        this.blocked(realRel, stat.isDirectory())
          ? `${cleaned} leads to a path the team's rules keep from the agent, and cannot be read.`
          : `${cleaned} leads to a path ignored by .gitignore and cannot be read.`
      )
    }
    if (rel && this.ignored(rel, stat.isDirectory())) {
      throw new ToolInputError(
        this.blocked(rel, stat.isDirectory())
          ? `${cleaned} is kept from the agent by the team's rules and cannot be read.`
          : `${cleaned} is ignored by .gitignore and cannot be read.`
      )
    }
    if (kind === "file" && !stat.isFile()) throw new ToolInputError(`${cleaned} is not a file.`)
    if (kind === "dir" && !stat.isDirectory()) throw new ToolInputError(`${cleaned} is not a directory.`)
    return absolute
  }

  /** Where a new file at `relative` would go, or why it cannot go there. */
  resolveNew(relative = ""): string {
    const cleaned = relative.trim().replace(/^\.\/+/, "")
    if (!cleaned || /[\\/]$/.test(cleaned)) throw new ToolInputError("A file path is needed, not a folder.")
    const absolute = path.resolve(this.root, cleaned)
    const rel = path.relative(this.root, absolute)
    const external = this.externalRoot(absolute)
    if (!external && (!rel || rel.startsWith("..") || path.isAbsolute(rel))) {
      throw new ToolInputError(`${cleaned} is outside the workspace.`)
    }
    // Anything at the path counts, a link that leads nowhere included:
    // writing the new file would follow it, wherever it points.
    if (present(absolute)) {
      throw new ToolInputError(`${cleaned} already exists; read it, then use edit_lines to change it.`)
    }
    let parent = path.dirname(absolute)
    while (!present(parent)) parent = path.dirname(parent)
    let realParent: string
    try {
      realParent = fs.realpathSync(parent)
    } catch {
      throw new ToolInputError(`${cleaned} is outside the workspace.`)
    }
    if (external) {
      // A new file is judged by where its folder really is, since a link
      // inside a granted folder could put it somewhere never granted.
      if (!this.inside(realParent, external.real)) {
        throw new ToolInputError(`${cleaned} is outside the workspace.`)
      }
      const denied = this.externalDenied(external, path.join(realParent, path.relative(parent, absolute)), false)
      if (denied === "blocked") {
        throw new ToolInputError(`${cleaned} is kept from the agent by the team's rules; twinny does not write there.`)
      }
      if (denied === "ignored") {
        throw new ToolInputError(`${cleaned} is ignored; twinny does not write there.`)
      }
      return absolute
    }
    if (!this.inside(realParent)) {
      throw new ToolInputError(`${cleaned} is outside the workspace.`)
    }
    if (this.ignored(rel)) {
      throw new ToolInputError(
        this.blocked(rel)
          ? `${cleaned} is kept from the agent by the team's rules; twinny does not write there.`
          : `${cleaned} is ignored by .gitignore; twinny does not write there.`
      )
    }
    return absolute
  }

  /** Files were made, moved or removed: the next search walks the tree again. */
  forgetFiles() {
    this._files = undefined
    this._tree = undefined
  }

  /** The path as a tool shows it: relative to the root, or absolute in a granted folder, always with `/` separators. */
  relative(absolute: string) {
    const target = path.resolve(absolute)
    if (this.isExternal(target)) return target.split(path.sep).join("/")
    return path.relative(this.root, target).split(path.sep).join("/") || "."
  }

  /** Where `absolute` really is, relative to the root, links followed as far as they exist; `/` separators. */
  realRelative(absolute: string): string {
    let existing = absolute
    const rest: string[] = []
    while (!fs.existsSync(existing) && path.dirname(existing) !== existing) {
      rest.unshift(path.basename(existing))
      existing = path.dirname(existing)
    }
    try {
      const real = path.join(fs.realpathSync(existing), ...rest)
      if (!this.inside(real)) {
        const granted = authorizedRootOf(real, this._authorized.map((entry) => entry.real))
        if (granted) return real.split(path.sep).join("/")
      }
      return path.relative(this._realRoot, real).split(path.sep).join("/") || "."
    } catch {
      return this.relative(absolute)
    }
  }

  /** Entries of a directory that are not ignored, directories first. */
  entries(dir: string): { name: string; dir: boolean }[] {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((dirent) => !this.ignoredAt(path.join(dir, dirent.name), dirent.isDirectory()))
      .map((dirent) => ({ name: dirent.name, dir: dirent.isDirectory() }))
      .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
  }

  /** Every searchable file, walked once per view. */
  files(): Promise<string[]> {
    this._files ??= this.tree().then(({ files }) => files.filter(isIndexablePath))
    return this._files
  }

  /** Every file that is not ignored, binary or not, for finding by name. */
  allFiles(): Promise<string[]> {
    return this.tree().then(({ files }) => files)
  }

  /** Every folder that is not ignored. */
  allDirs(): Promise<string[]> {
    return this.tree().then(({ dirs }) => dirs)
  }

  private tree() {
    this._tree ??= this.walk()
    return this._tree
  }

  private async walk() {
    const files: string[] = []
    const dirs: string[] = []
    const visit = async (dir: string) => {
      let dirents: fs.Dirent[]
      try {
        dirents = await fs.promises.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const dirent of dirents) {
        const entry = path.join(dir, dirent.name)
        // Symbolic links are neither files nor directories here, so a
        // search never follows one out of the workspace.
        if (this.ignored(path.relative(this.root, entry), dirent.isDirectory())) continue
        if (dirent.isDirectory()) {
          dirs.push(entry)
          await visit(entry)
        } else if (dirent.isFile()) {
          files.push(entry)
        }
      }
    }
    await visit(this.root)
    return { files: files.sort(), dirs: dirs.sort() }
  }

  /**
   * A file's text: as the editor has it when it is open there, unsaved
   * changes included, else from disk. Undefined for a binary file or one
   * too large to be worth a model's context.
   */
  async text(file: string): Promise<string | undefined> {
    const open = await this._read?.(file)
    if (open !== undefined) return open
    try {
      const stat = await fs.promises.stat(file)
      if (stat.size > MAX_FILE_BYTES) return undefined
      const buffer = await fs.promises.readFile(file)
      if (looksBinary(buffer)) return undefined
      // The editor never shows a byte-order mark, so neither do the tools.
      const text = buffer.toString("utf8")
      return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
    } catch {
      return undefined
    }
  }
}
