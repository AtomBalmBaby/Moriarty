/**
 * Resource identity for source references. A source is stored as the root it
 * belongs to plus the POSIX path relative to that root, and the canonical path
 * — the string shown to and accepted from the model — is home-relative under the
 * project home and absolute anywhere else.
 *
 * Identity only: nothing here decides access, and rows are read from the table
 * on every call rather than cached.
 */
import { randomUUID } from "node:crypto"
import path from "node:path"

import type { Database } from "./sqlite"

export type SourceRootKind = "home" | "workspace" | "external"

export interface SourceRootRecord {
  readonly rootId: string
  readonly kind: SourceRootKind
  readonly host: string
  readonly locator: string
  readonly label: string
}

/** A source reference: the root and the POSIX path relative to it ("." for the root itself). */
export interface SourceLocation {
  readonly rootId: string
  readonly path: string
}

/** The `source_root` DDL, verbatim from Appendix A of the plan. */
export const SOURCE_ROOT_SCHEMA = `
CREATE TABLE source_root (
  root_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('home','workspace','external')),
  host TEXT NOT NULL DEFAULT '',
  locator TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_bound_at TEXT NOT NULL,
  UNIQUE(host, locator)
);
CREATE UNIQUE INDEX source_root_one_home ON source_root(kind) WHERE kind = 'home';
`

const DRIVE_ROOT = /^[A-Za-z]:\/$/

const now = (): string => new Date().toISOString()

const isFilesystemRoot = (value: string): boolean => value === "/" || DRIVE_ROOT.test(value)

/** POSIX absolute: it starts with "/" or with a drive root such as "C:/". */
const isAbsolutePosix = (value: string): boolean =>
  isFilesystemRoot(value) || value.startsWith("/") || /^[A-Za-z]:\/(?![/])/.test(value)

/** The filesystem root a POSIX absolute path hangs from: "/" or a drive root like "C:/". */
const filesystemRootOf = (absolute: string): string => {
  const drive = absolute.match(/^[A-Za-z]:(?=\/)/)
  return drive ? `${drive[0]}/` : "/"
}

/**
 * Backslashes become "/", dot segments and repeated separators are resolved,
 * and a trailing separator is dropped — except on a filesystem root, which keeps
 * its own.
 */
export const toPosixPath = (value: string): string => {
  const normalized = path.posix.normalize(value.replace(/\\/g, "/"))
  return isFilesystemRoot(normalized) ? normalized : normalized.replace(/\/+$/, "")
}

/**
 * The home for a database file: a database inside `.twinny/` belongs to the
 * folder that holds that folder, otherwise to its own directory.
 */
export const homePathOfDatabase = (databasePath: string): string => {
  const directory = path.posix.dirname(toPosixPath(databasePath))
  return path.posix.basename(directory) === ".twinny" ? path.posix.dirname(directory) : directory
}

/** Whole-segment containment, so /p2/x is not under /p. */
const insideRoot = (locator: string, absolute: string): boolean => {
  if (locator === absolute) return true
  const boundary = locator.endsWith("/") ? locator : `${locator}/`
  return absolute.startsWith(boundary)
}

/** The path inside a root that already contains the absolute path. */
const pathWithinRoot = (locator: string, absolute: string): string => {
  if (locator === absolute) return "."
  return absolute.slice(locator.length).replace(/^\/+/, "") || "."
}

interface SourceRootRow {
  root_id: string
  kind: SourceRootKind
  host: string
  locator: string
  label: string
}

const recordOf = (row: SourceRootRow): SourceRootRecord => ({
  rootId: row.root_id,
  kind: row.kind,
  host: row.host,
  locator: row.locator,
  label: row.label
})

/**
 * The shared source-reference service the repository builds on: it owns the
 * `source_root` table and turns absolute paths into (root, root-relative path)
 * identities and canonical paths.
 */
export class SourceRoots {
  private readonly database: Database
  private readonly homeLocator: string

  constructor(database: Database, homePath: string) {
    this.database = database
    const home = toPosixPath(homePath)
    if (!isAbsolutePosix(home)) throw new Error(`The project home ${homePath} is not an absolute path`)
    this.homeLocator = home
  }

  /** The home root: created on first use, and moved with the project folder while its id is kept. */
  home(): SourceRootRecord {
    const existing = this.rowWhere("kind = 'home'")
    if (!existing) return this.insert("home", this.homeLocator, path.posix.basename(this.homeLocator))
    if (existing.locator === this.homeLocator) return recordOf(existing)
    try {
      this.database.prepare("UPDATE source_root SET locator = ?, last_bound_at = ? WHERE root_id = ?")
        .run(this.homeLocator, now(), existing.root_id)
    } catch (error) {
      throw this.locatorConflict(this.homeLocator, error)
    }
    return this.byId(existing.root_id)!
  }

  /** Idempotent by (host, locator); the home locator always answers with the home root. */
  register(locator: string, label: string): SourceRootRecord {
    const root = toPosixPath(locator)
    if (!isAbsolutePosix(root)) throw new Error(`The resource root ${locator} is not an absolute path`)
    if (root === this.homeLocator) return this.home()
    const existing = this.rowWhere("host = ? AND locator = ?", "", root)
    if (existing) return recordOf(existing)
    try {
      return this.insert("workspace", root, label)
    } catch (error) {
      throw this.locatorConflict(root, error)
    }
  }

  /** The longest home or workspace root containing the path, else the external filesystem root. */
  locate(absolutePath: string): SourceLocation {
    const target = toPosixPath(absolutePath)
    if (!isAbsolutePosix(target)) throw new Error(`${absolutePath} is not an absolute path, so it cannot be located in a root`)
    let match: SourceRootRecord | undefined
    for (const row of this.rowsWhere("kind <> 'external'")) {
      if (!insideRoot(row.locator, target)) continue
      const candidate = recordOf(row)
      if (!match || match.locator.length < candidate.locator.length) match = candidate
    }
    const root = match ?? this.externalRoot(target)
    return { rootId: root.rootId, path: pathWithinRoot(root.locator, target) }
  }

  absolutePath(location: SourceLocation): string {
    const root = this.byId(location.rootId)
    if (!root) throw new Error(`Unknown source root ${location.rootId}`)
    return path.posix.join(root.locator, location.path)
  }

  /**
   * Canonical paths are decided on the absolute path, so a workspace root nested
   * under the home still answers with a home-relative string.
   */
  canonicalPath(location: SourceLocation): string {
    const absolute = this.absolutePath(location)
    const home = this.home()
    return insideRoot(home.locator, absolute) ? pathWithinRoot(home.locator, absolute) : absolute
  }

  /** An absolute canonical path is located; a relative one is resolved against the home first. */
  fromCanonical(canonical: string): SourceLocation {
    const value = toPosixPath(canonical)
    if (isAbsolutePosix(value)) return this.locate(value)
    return this.locate(path.posix.join(this.home().locator, value))
  }

  byId(rootId: string): SourceRootRecord | undefined {
    const row = this.rowWhere("root_id = ?", rootId)
    return row ? recordOf(row) : undefined
  }

  /** The single external root, created on first use, is the filesystem root. */
  private externalRoot(absolute: string): SourceRootRecord {
    const locator = filesystemRootOf(absolute)
    const existing = this.rowWhere("kind = 'external' AND host = ? AND locator = ?", "", locator)
    return existing ? recordOf(existing) : this.insert("external", locator, "filesystem")
  }

  private insert(kind: SourceRootKind, locator: string, label: string): SourceRootRecord {
    const created = now()
    const rootId = randomUUID()
    this.database.prepare(
      "INSERT INTO source_root(root_id, kind, host, locator, label, created_at, last_bound_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(rootId, kind, "", locator, label, created, created)
    return { rootId, kind, host: "", locator, label }
  }

  /** The plan's message for a locator two roots cannot share. */
  private locatorConflict(locator: string, error: unknown): Error {
    if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
      const clash = this.rowWhere("host = ? AND locator = ?", "", locator)
      if (clash) return new Error(`The project folder ${locator} is already registered as a ${clash.kind} root of this database`)
    }
    return error instanceof Error ? error : new Error(String(error))
  }

  private rowsWhere(where: string, ...values: (string | number | null)[]): SourceRootRow[] {
    return this.database
      .prepare(`SELECT root_id, kind, host, locator, label FROM source_root WHERE ${where}`)
      .all(...values) as SourceRootRow[]
  }

  private rowWhere(where: string, ...values: (string | number | null)[]): SourceRootRow | undefined {
    return this.database
      .prepare(`SELECT root_id, kind, host, locator, label FROM source_root WHERE ${where}`)
      .get(...values) as SourceRootRow | undefined
  }
}
