/**
 * The permissions the user gives the native file tools for paths outside the
 * workspace: what a grant covers, how long it lasts, and where the always
 * grants are kept. Pure except for the memento it is handed, so the rules can
 * be tested without the editor.
 *
 * A grant names a path as it was asked about and the real location it had
 * when granted. A later change of link does not widen it: the real location
 * is compared with what was recorded, never with where the link points now.
 */
import fs from "fs"
import path from "path"

export type AccessClass = "read" | "write"
/** A file is the path itself; a folder is the path and every path under it. */
export type GrantScope = "file" | "folder"
/** Once: the pending operation only. Session: this extension host's life. Always: kept until revoked. */
export type GrantLifetime = "once" | "session" | "always"

export interface AccessGrant {
  /** The path as granted, absolute and normalized. */
  root: string
  /** Where that path really was when it was granted, links resolved. */
  real: string
  scope: GrantScope
  access: AccessClass
  lifetime: GrantLifetime
  /** The extension host the grant was made on; a grant never applies to another. */
  host: string
}

/**
 * The identity always grants are kept under. `remoteName` alone names only the kind of remote, so
 * the workspace authority (which carries the SSH host), the machine id and the hostname are included:
 * different servers do not share a key. A change to any of them ends the grants kept under the old key.
 */
export const accessHostKey = ({
  remoteName,
  authority,
  machineId,
  hostname,
}: {
  remoteName?: string
  authority?: string
  machineId: string
  hostname: string
}): string => JSON.stringify([remoteName ?? "local", authority ?? "", machineId, hostname])

/** The part of a `Memento` the store needs, so a test can hand it a plain object. */
export interface GrantMemento {
  get<T>(key: string): T | undefined
  update(key: string, value: unknown): PromiseLike<void>
}

export const ALWAYS_ACCESS_GRANTS_KEY = "alwaysAllowedFileAccess"

/** Whether `target` is `root` or lies under it, by whole path segments. */
export const isWithin = (root: string, target: string): boolean => {
  const within = path.relative(root, target)
  if (within === "") return true
  return !path.isAbsolute(within) && within.split(path.sep)[0] !== ".."
}

/**
 * The path with links resolved for the part of it that exists. Anything
 * after the first missing part is kept as written, so a new file is judged
 * by the real folder it would be created in.
 */
export const canonicalPath = (absolute: string): string => {
  const target = path.resolve(absolute)
  const missing: string[] = []
  let existing = target
  for (;;) {
    try {
      return path.join(fs.realpathSync(existing), ...missing)
    } catch {
      const parent = path.dirname(existing)
      if (parent === existing) return target
      missing.unshift(path.basename(existing))
      existing = parent
    }
  }
}

/** The filesystem root or a drive root: granting it would authorize the whole disk. */
export const isFilesystemRoot = (absolute: string): boolean => path.parse(absolute).root === absolute

/** Whether a grant's access covers the access asked for: write covers read, read never covers write. */
export const accessAllows = (grant: AccessGrant, access: AccessClass): boolean =>
  grant.access === "write" || access === "read"

/** Whether a grant's path is the target, or for a folder grant, holds it, by whole segments. */
export const grantReaches = (grant: AccessGrant, target: string): boolean => {
  if (grant.scope === "file") return path.resolve(target) === grant.root
  return isWithin(grant.root, path.resolve(target))
}

/** Whether the real location of a target is still the one the grant recorded. */
const realReaches = (grant: AccessGrant, real: string): boolean =>
  grant.scope === "file" ? real === grant.real : isWithin(grant.real, real)

/** A grant for `absolute` as it is now, with its real location recorded. */
export const makeGrant = (
  absolute: string,
  scope: GrantScope,
  access: AccessClass,
  lifetime: GrantLifetime,
  host: string
): AccessGrant => {
  const root = path.resolve(absolute)
  return { root, real: canonicalPath(root), scope, access, lifetime, host }
}

const isGrant = (value: unknown): value is AccessGrant => {
  const grant = value as Partial<AccessGrant> | null
  return !!grant && typeof grant.root === "string" && typeof grant.real === "string" && typeof grant.host === "string" &&
    (grant.scope === "file" || grant.scope === "folder") && (grant.access === "read" || grant.access === "write") &&
    (grant.lifetime === "once" || grant.lifetime === "session" || grant.lifetime === "always")
}

/**
 * The grants in force. Once grants last until `endCall`; session grants until
 * the extension host shuts down; always grants are kept in the memento, each
 * for the host it was made on, until revoked.
 */
export class AccessStore {
  private _once: AccessGrant[] = []
  private _session: AccessGrant[] = []
  private _stored: AccessGrant[]

  constructor(
    private readonly _memento: GrantMemento | undefined,
    readonly host: string
  ) {
    const saved = _memento?.get<unknown>(ALWAYS_ACCESS_GRANTS_KEY)
    this._stored = Array.isArray(saved) ? saved.filter(isGrant).map((grant) => ({ ...grant, lifetime: "always" as const })) : []
  }

  /** Every grant in force for this host. */
  grants(): AccessGrant[] {
    return [...this._once, ...this._session, ...this.always()]
  }

  /** The always grants for this host, for showing and revoking. */
  always(): AccessGrant[] {
    return this._stored.filter((grant) => grant.host === this.host)
  }

  /** Records a grant. Always grants are written to the memento before they count. */
  async add(grant: AccessGrant): Promise<void> {
    if (grant.lifetime === "once") this._once.push(grant)
    else if (grant.lifetime === "session") this._session.push(grant)
    else {
      const next = [...this._stored, grant]
      await this._memento?.update(ALWAYS_ACCESS_GRANTS_KEY, next)
      this._stored = next
    }
  }

  /** Drops the once grants: the pending operation they were for has finished. */
  endCall(): void {
    this._once = []
  }

  /** Removes this host's always grants that match, and returns how many went. */
  async revoke(match: (grant: AccessGrant) => boolean): Promise<number> {
    const removed = this._stored.filter((grant) => grant.host === this.host && match(grant))
    if (!removed.length) return 0
    const next = this._stored.filter((grant) => !removed.includes(grant))
    await this._memento?.update(ALWAYS_ACCESS_GRANTS_KEY, next)
    this._stored = next
    return removed.length
  }

  /** The grant that lets `absolute` be used for `access`, when one is in force and its real location still matches. */
  covering(absolute: string, access: AccessClass): AccessGrant | undefined {
    const target = path.resolve(absolute)
    const real = canonicalPath(target)
    return this.grants().find((grant) => accessAllows(grant, access) && grantReaches(grant, target) && realReaches(grant, real))
  }
}
