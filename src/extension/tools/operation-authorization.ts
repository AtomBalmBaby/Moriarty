/**
 * The write permission for one native tool call. The preflight issues it for
 * the outside paths the call will change. The file sinks check it before they
 * read or copy a file, and the edit service and the sinks claim it right before
 * they change one. A claim checks the operation, the host and the current
 * canonical target of each path, and it is spent by the first success. It ends
 * with the call, so a later command cannot reuse it.
 * Only instances this module issued are accepted, so a caller of a public
 * command cannot forge one.
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

const issued = new WeakSet<OperationAuthorization>()

export class OperationAuthorization {
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
    issued.add(authorization)
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

/** Whether `authorization` is a live authorization this module issued that covers exactly `requests` on `host`. Spends nothing. */
export const coversWrites = (authorization: unknown, requests: readonly WriteRequest[], host: string): boolean =>
  authorization instanceof OperationAuthorization && issued.has(authorization) && authorization.covers(requests, host)

/** As `coversWrites`, and spends the authorization. */
export const claimWrites = (authorization: unknown, requests: readonly WriteRequest[], host: string): boolean =>
  authorization instanceof OperationAuthorization && issued.has(authorization) && authorization.take(requests, host)
