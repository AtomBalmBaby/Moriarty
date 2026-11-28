/**
 * The write permission for one native tool call. The preflight issues it for
 * the outside paths the call will change. The file sinks check it before they
 * read or copy a file, and the edit service and the sinks claim it right before
 * they change one. A claim checks the operation, the host and the current
 * canonical target of each path, and it is spent by the first success. It ends
 * with the call, so a later command cannot reuse it.
 * Only what this module issued is accepted, so a caller of a public command cannot forge one.
 * Stage 4 adds the typed Git requests in the same lifecycle. An approval for a file write and an
 * approval for a commit are different requests, so a grant taken for `status`, or for a path, never
 * carries a commit call: what an authorization covers is a write request or one of these typed requests.
 * A commit authorization is tied to the host, the call and the operation id it was issued for, and it is
 * spent by that operation.
 * Stage 5 adds the push request: it is a separate approval, tied to the destination the call was approved for, and it never covers force.
 */
import path from "path"

import { canonicalPath } from "./access-grants"
import { tidyGitPath } from "./helpers"

export type WriteOperation = "edit" | "create" | "remove" | "move"

export interface WriteRequest {
  operation: WriteOperation
  absolute: string
}

/** A typed Git request (§13 of the design) as Stage 4 names it: where, and what it is spent on. Never a credential. */
export interface GitPrepareRequest { kind: "prepare_commit"; absolute: string; paths: readonly string[] }
export interface GitCommitRequest { kind: "commit"; absolute: string; operationId: string }
/** Stage 5's push request, in its own shape. A commit approval never covers a push, and a push approval never covers force: what the call left unnamed stays empty here rather than being guessed later. */
export interface GitPushRequest { kind: "push"; absolute: string; operationId?: string; remote: string; branch: string; force: false }
export type GitOperationRequest = GitPrepareRequest | GitCommitRequest | GitPushRequest

/** Either kind of request one call can be approved for. */
export type AuthorizedRequest = WriteRequest | GitOperationRequest

/** A path a call names with what the call does to it, so requests come from one place. */
export interface RequestedTarget { path: string; operation?: WriteOperation; git?: GitOperationRequest }

/** The requests an authorization covers from targets that name one. A plain read names nothing to spend. */
export const requestsFromTargets = (targets: readonly RequestedTarget[]): AuthorizedRequest[] => {
  const requests: AuthorizedRequest[] = []
  for (const target of targets) {
    if (target.git) requests.push(target.git)
    else if (target.operation) requests.push({ operation: target.operation, absolute: target.path })
  }
  return requests
}

/** The typed request one `git` call names for itself, from the arguments as they were sent. A read names none. */
export const gitRequestsForCall = (args: Record<string, unknown>, absolute: string): GitOperationRequest[] => {
  const operation = typeof args.operation === "string" ? args.operation.trim() : ""
  if (operation === "prepare_commit") {
    const paths = (Array.isArray(args.paths) ? args.paths : []).filter((given): given is string => typeof given === "string").map(tidyGitPath).filter((path) => path !== "")
    return paths.length > 0 ? [{ kind: "prepare_commit", absolute, paths }] : []
  }
  if (operation === "commit") {
    const operationId = typeof args.operationId === "string" ? args.operationId.trim() : ""
    return operationId === "" ? [] : [{ kind: "commit", absolute, operationId }]
  }
  if (operation === "push") return [pushRequestFromCall(args, absolute)]
  return []
}
/** A push request as the call named it. The destination is what the effective config decides at execution time, so a part the call did not name stays empty here instead of being guessed. */
export const pushRequestFromCall = (args: Record<string, unknown>, absolute: string): GitPushRequest => {
  const named = (value: unknown): string => (typeof value === "string" ? value.trim() : "")
  const operationId = named(args.operationId)
  return { kind: "push", absolute, ...(operationId === "" ? {} : { operationId }), remote: named(args.remote), branch: named(args.branch), force: false }
}


interface Approved {
  request: AuthorizedRequest
  absolute: string
  /** Where the path really was when the call was approved. */
  real: string
}

/** What an accepted authorization has to be able to do. */
interface WriteAuthorization {
  covers(requests: readonly AuthorizedRequest[], host: string): boolean
  take(requests: readonly AuthorizedRequest[], host: string): boolean
}

/**
 * The authorizations issued in this process. The shipped extension runs as one bundle that holds its
 * own copy of this file, while the extension host also loads this file as its own module, so the same
 * approval can be issued through one copy and claimed through the other. Being in this set is what
 * makes an authorization genuine: an object built by hand, or one from another process, is refused.
 */
const sharedIssued = (globalThis as { twinnyIssuedWrites?: WeakSet<WriteAuthorization> }).twinnyIssuedWrites ??=
  new WeakSet<WriteAuthorization>()

const isGitRequest = (request: AuthorizedRequest): boolean => "kind" in request

const samePaths = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && [...left].sort().join("\n") === [...right].sort().join("\n")

/** One request against what was approved: the same place, the same real path, and the same thing to do there. */
const matches = (approved: Approved, given: AuthorizedRequest): boolean => {
  if (isGitRequest(approved.request) !== isGitRequest(given)) return false
  const absolute = path.resolve(given.absolute)
  if (approved.absolute !== absolute || approved.real !== canonicalPath(absolute)) return false
  if (isGitRequest(given)) {
    const approvedRequest = approved.request as GitOperationRequest
    const givenRequest = given as GitOperationRequest
    if (approvedRequest.kind !== givenRequest.kind) return false
    if (approvedRequest.kind === "prepare_commit")
      return samePaths((approvedRequest as GitPrepareRequest).paths, (givenRequest as GitPrepareRequest).paths)
    if (approvedRequest.kind === "push") {
      // Force is never part of what a push approval can cover, and the destination has to be the one that was approved.
      const approvedPush = approvedRequest as GitPushRequest
      const givenPush = givenRequest as GitPushRequest
      if (approvedPush.force !== false || givenPush.force !== false) return false
      if (approvedPush.remote !== givenPush.remote || approvedPush.branch !== givenPush.branch) return false
      return approvedPush.operationId === givenPush.operationId
    }
    return (approvedRequest as GitCommitRequest).operationId === (givenRequest as GitCommitRequest).operationId
  }
  return (approved.request as WriteRequest).operation === (given as WriteRequest).operation
}

export class OperationAuthorization implements WriteAuthorization {
  private open = true
  private readonly approved: readonly Approved[]

  private constructor(
    readonly host: string,
    requests: readonly AuthorizedRequest[]
  ) {
    this.approved = requests.map((request) => ({
      request,
      absolute: path.resolve(request.absolute),
      real: canonicalPath(request.absolute),
    }))
  }

  static issue(host: string, requests: readonly AuthorizedRequest[]): OperationAuthorization {
    const authorization = new OperationAuthorization(host, requests)
    sharedIssued.add(authorization)
    return authorization
  }

  /** Ends the call: an unspent authorization can no longer be claimed. */
  end(): void {
    this.open = false
  }
  /** Whether `requests` match exactly what it approved, one for one. Spends nothing. */
  covers(requests: readonly AuthorizedRequest[], host: string): boolean {
    if (!this.open || host !== this.host || requests.length === 0 || requests.length !== this.approved.length) return false
    const unused = [...this.approved]
    for (const request of requests) {
      const index = unused.findIndex((entry) => matches(entry, request))
      if (index < 0) return false
      unused.splice(index, 1)
    }
    return true
  }

  /** Spends the authorization when `requests` match exactly what it approved. */
  take(requests: readonly AuthorizedRequest[], host: string): boolean {
    if (!this.covers(requests, host)) return false
    this.open = false
    return true
  }
}

/** Whether `authorization` is one issued in this process that covers exactly `requests` on `host`. Spends nothing. */
const isIssued = (authorization: unknown): authorization is WriteAuthorization =>
  typeof authorization === "object" && authorization !== null && sharedIssued.has(authorization as WriteAuthorization)

export const coversWrites = (authorization: unknown, requests: readonly AuthorizedRequest[], host: string): boolean =>
  isIssued(authorization) && authorization.covers(requests, host)

/** As `coversWrites`, and spends the authorization. */
export const claimWrites = (authorization: unknown, requests: readonly AuthorizedRequest[], host: string): boolean =>
  isIssued(authorization) && authorization.take(requests, host)

/**
 * As `coversWrites` for a call whose requests are typed Git requests. A file-write approval is not a commit
 * approval: an authorization issued for paths is refused here even when it names the same folder.
 */
export const coversGitRequests = (authorization: unknown, requests: readonly GitOperationRequest[], host: string): boolean =>
  isIssued(authorization) && requests.length > 0 && requests.every(isGitRequest) && authorization.covers(requests, host)

/** As `coversGitRequests`, and spends the authorization on this call. */
export const claimGitRequests = (authorization: unknown, requests: readonly GitOperationRequest[], host: string): boolean =>
  isIssued(authorization) && requests.length > 0 && requests.every(isGitRequest) && authorization.take(requests, host)
