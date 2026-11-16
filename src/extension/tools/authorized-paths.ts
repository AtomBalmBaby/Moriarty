/**
 * The folders a view may work in besides its own root: the rest of a
 * multi-root window, and the ones the user named in
 * `twinny.chatToolsAllowedPaths`. These are the only places outside the
 * root a tool is allowed to go, and they are never searched or indexed.
 *
 * Pure path work: nothing here touches the filesystem, so the same rules can
 * be read by the view, by the editor's edit service, and by a test.
 */
import os from "os"
import path from "path"

/**
 * The configured entries as roots worth comparing: absolute, normalized (a
 * trailing separator is dropped), deduplicated. `~` and `~/x` expand against
 * `home`. Relative entries, blank entries and a filesystem root are dropped,
 * because authorizing the whole disk is not a folder grant.
 */
export const normalizeAuthorizedRoots = (entries: readonly string[], home = os.homedir()): string[] => {
  const roots: string[] = []
  for (const entry of entries) {
    const written = entry.trim()
    if (!written) continue
  const expanded = written === "~" ? home : /^[~][\\/]/.test(written) ? path.resolve(path.join(home, written.slice(1))) : written
    if (!path.isAbsolute(expanded)) continue
    const root = path.resolve(expanded)
    if (root === path.parse(root).root) continue
    if (!roots.includes(root)) roots.push(root)
  }
  return roots
}

/**
 * The longest of `roots` that is `absolute` itself or contains it. Folders are
 * compared as whole segments, so `/etc2` is not under `/etc`. Undefined when
 * no root covers the path. Pure: no filesystem access.
 */
export const authorizedRootOf = (absolute: string, roots: readonly string[]): string | undefined => {
  if (!path.isAbsolute(absolute)) return undefined
  const target = path.resolve(absolute)
  let longest: string | undefined
  for (const entry of roots) {
    if (!path.isAbsolute(entry)) continue
    const root = path.resolve(entry)
    const within = path.relative(root, target)
    if (within === "" || (!path.isAbsolute(within) && !within.startsWith(".."))) {
      if (!longest || longest.length < root.length) longest = root
    }
  }
  return longest
}
