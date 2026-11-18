/**
 * The project home: the folder that owns the project database. It is decided
 * without workspace folder order, so reordering or adding folders never selects
 * a different database and never splits project evidence.
 *
 * Identity only: the home decides where the project database lives, never which
 * paths a native tool may read or write.
 */
import os from "node:os"
import path from "node:path"

import { toPosixPath } from "./source-roots"

export const PROJECT_TODO_DIRECTORY = ".twinny"
export const PROJECT_TODO_DATABASE_NAME = "project.sqlite"

export interface WorkspaceFolderLocation {
  readonly scheme: string
  readonly fsPath: string
}

/** What the resolver may be given besides the open folders: a saved workspace file and the machine-scoped home setting. */
export interface ProjectHomeOptions {
  readonly workspaceFile?: string
  readonly projectHome?: string
}

export interface ProjectHomeInput extends ProjectHomeOptions {
  readonly folders: readonly WorkspaceFolderLocation[]
}

/**
 * The project identity: the home that owns the project database, and every
 * local workspace root to register in `source_root`. Roots are path-sorted, so the
 * same folder set always answers in the same order.
 */
export interface ProjectIdentity {
  readonly home: string
  readonly roots: readonly string[]
}

/** The project database belongs to the home folder; `.twinny/` is git-ignored. */
export interface ProjectTodoStorage extends ProjectIdentity {
  readonly databasePath: string
}

/** Folders that can hold the project database, path-sorted. Non-local folders are not candidates. */
export const localRootsOf = (folders: readonly WorkspaceFolderLocation[]): string[] =>
  folders
    .filter((folder) => folder.scheme === "file")
    .map((folder) => toPosixPath(path.resolve(folder.fsPath)))
    .sort()

/**
 * The configured home is validated as an absolute folder, with `~` read as the
 * user's home like the allowed-path setting does. It is a storage location, not
 * a permission: it never names a path a tool may reach.
 */
export const validatedProjectHome = (configured: string | undefined, home = os.homedir()): string | undefined => {
  const value = configured?.trim()
  if (!value) return undefined
  const expanded = value === "~" ? home : /^[~][\\/]/.test(value) ? path.resolve(path.join(home, value.slice(1))) : path.resolve(value)
  if (!path.isAbsolute(expanded)) throw new Error(`twinny.projectHome must name an absolute folder, not ${value}`)
  return toPosixPath(expanded)
}

/**
 * Which folder owns the project database: the validated `twinny.projectHome`
 * setting first, then the folder of a single root, then the folder holding the
 * `.code-workspace` file of a saved multi-root window, and finally the
 * path-sorted first local root. That last fallback is deterministic but depends
 * on folder membership, so adding or removing a folder can change it.
 */
export const resolveProjectHome = (input: ProjectHomeInput): string => {
  const configured = validatedProjectHome(input.projectHome)
  if (configured) return configured
  const roots = localRootsOf(input.folders)
  if (roots.length === 0) {
    const scheme = input.folders[0]?.scheme
    throw new Error(scheme
      ? `Twinny TODO storage needs a local project folder, not a "${scheme}" folder`
      : `Twinny TODO storage needs an open project folder to create ${PROJECT_TODO_DIRECTORY}/${PROJECT_TODO_DATABASE_NAME}`)
  }
  if (roots.length === 1) return roots[0]
  if (input.workspaceFile && path.posix.extname(toPosixPath(input.workspaceFile)) === ".code-workspace") {
    return toPosixPath(path.dirname(toPosixPath(input.workspaceFile)))
  }
  return roots[0]
}

/** The label a source root is stored under: its folder name. */
export const rootLabelOf = (locator: string): string => toPosixPath(locator).split("/").filter(Boolean).pop() ?? "filesystem"

/** The project database location for a window: the home, every local root to register, and the file itself. */
export const projectTodoStorageOf = (input: ProjectHomeInput): ProjectTodoStorage => {
  const home = resolveProjectHome(input)
  return { home, roots: localRootsOf(input.folders), databasePath: path.posix.join(home, PROJECT_TODO_DIRECTORY, PROJECT_TODO_DATABASE_NAME) }
}
