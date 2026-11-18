/**
 * The write permission for one native tool call. The preflight issues it for
 * the outside paths the call will change. The file sinks check it before they
 * read or copy a file, and the edit service and the sinks claim it right before
 * they change one. A claim checks the operation, the host and the current
 * canonical target of each path, and it is spent by the first success. It ends
 * with the call, so a later command cannot reuse it.
 * Only what this module issued is accepted, so a caller of a public command cannot forge one.
 */
import path from "path"

import { canonicalPath } from "./access-grants"

export type WriteOperation = "edit" | "create" | "remove" | "move"

export interface WriteRequest {
  operation: WriteOperation
  absolute: string
}

interface Approved {
  operation: WriteOperation
  absolute: string
  /** Where the path really was when the call was approved. */
  real: string
}


/** What an accepted authorization has to be able to do. */
interface WriteAuthorization {
  covers(requests: readonly WriteRequest[], host: string): boolean
  take(requests: readonly WriteRequest[], host: string): boolean
}

/**
 * The authorizations issued in this process. The shipped extension runs as one bundle that holds its
 * own copy of this file, while the extension host also loads this file as its own module, so the same
 * approval can be issued through one copy and claimed through the other. Being in this set is what
 * makes an authorization genuine: an object built by hand, or one from another process, is refused.
 */
const sharedIssued = (globalThis as { twinnyIssuedWrites?: WeakSet<WriteAuthorization> }).twinnyIssuedWrites ??=
  new WeakSet<WriteAuthorization>()

export class OperationAuthorization implements WriteAuthorization {
  private open = true
  private readonly approved: readonly Approved[]

  private constructor(
    readonly host: string,
    requests: readonly WriteRequest[]
  ) {
    this.approved = requests.map(({ operation, absolute }) => ({
      operation,
      absolute: path.resolve(absolute),
      real: canonicalPath(absolute),
    }))
  }

  static issue(host: string, requests: readonly WriteRequest[]): OperationAuthorization {
    const authorization = new OperationAuthorization(host, requests)
    sharedIssued.add(authorization)
    return authorization
  }

  /** Ends the call: an unspent authorization can no longer be claimed. */
  end(): void {
    this.open = false
  }

  /** Whether `requests` match exactly what it approved, one for one. Spends nothing. */
  covers(requests: readonly WriteRequest[], host: string): boolean {
    if (!this.open || host !== this.host || requests.length === 0 || requests.length !== this.approved.length) return false
    const unused = [...this.approved]
    for (const request of requests) {
      const absolute = path.resolve(request.absolute)
      const real = canonicalPath(absolute)
      const index = unused.findIndex(
        (entry) => entry.operation === request.operation && entry.absolute === absolute && entry.real === real
      )
      if (index < 0) return false
      unused.splice(index, 1)
    }
    return true
  }

  /** Spends the authorization when `requests` match exactly what it approved. */
  take(requests: readonly WriteRequest[], host: string): boolean {
    if (!this.covers(requests, host)) return false
    this.open = false
    return true
  }
}

/** Whether `authorization` is one issued in this process that covers exactly `requests` on `host`. Spends nothing. */
const isIssued = (authorization: unknown): authorization is WriteAuthorization =>
  typeof authorization === "object" && authorization !== null && sharedIssued.has(authorization as WriteAuthorization)

export const coversWrites = (authorization: unknown, requests: readonly WriteRequest[], host: string): boolean =>
  isIssued(authorization) && authorization.covers(requests, host)

/** As `coversWrites`, and spends the authorization. */
export const claimWrites = (authorization: unknown, requests: readonly WriteRequest[], host: string): boolean =>
  isIssued(authorization) && authorization.take(requests, host)
