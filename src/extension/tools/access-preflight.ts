/**
 * Asks before a native tool touches a path outside the workspace. Every path
 * the call needs is checked before anything runs: a refused path refuses the
 * whole call, and nothing is asked for unless every path is allowed. The
 * question is put to the user through an injected approver, so the decision
 * logic can be tested without the editor. No approver, a throw, a cancel or
 * an unexpected answer all deny.
 */
import fs from "fs"
import path from "path"

import { gitCallIsReadOnly } from "../git/service"

import { AccessClass, AccessGrant, AccessStore, canonicalPath, GrantLifetime, isFilesystemRoot, isWithin, makeGrant } from "./access-grants"
import { AuthorizedRequest, GitOperationRequest, gitRequestsForCall, OperationAuthorization, WriteOperation } from "./operation-authorization"
import type { WorkspaceView } from "./view"

/** A path a call needs, as the tool wrote it, how it is used, and whether the tool creates it (judged as `resolveNew` does). */
export interface AccessTarget {
  path: string
  access: AccessClass
  creates?: boolean
  /** The write the call makes to this path, when it changes the file: the approval covers only that write. */
  operation?: WriteOperation
  /** The typed Git request this call names for this path. Stage 4 names its own requests; a read names none. */
  git?: GitOperationRequest
}

export interface AccessPrompt {
  /** The path, absolute, as the tool named it. */
  path: string
  /** Where the path really leads, when a link makes it differ from the path named. */
  real?: string
  tool: string
  access: AccessClass
  /** Whether the path is a folder: its exact choice is then "this directory". */
  isDirectory: boolean
  /** The folder the folder choices would cover, or undefined when none is offered. */
  folder?: string
}

/** What the user chose: the exact path or its folder, for how long. Anything else denies. */
export type AccessChoice = { target: "exact" | "folder"; lifetime: GrantLifetime } | "deny"

export type AccessApprover = (prompt: AccessPrompt, signal?: AbortSignal) => Promise<AccessChoice | undefined>

export type AccessOutcome = { ok: true; write?: OperationAuthorization; requests?: readonly AuthorizedRequest[] } | { ok: false; message: string }

export interface AccessPreflight {
  authorize(targets: AccessTarget[], tool: string, signal?: AbortSignal): Promise<AccessOutcome>
  /** Ends the current call: its once grants no longer apply. */
  endCall(): void
}

export type AccessView = Pick<WorkspaceView, "outsideLexical" | "preauthorized" | "refusal">

/** The paths a native tool call will use, and how. Tools whose `path` is a glob or a prefix are not listed. */
export const accessTargetsOf = (tool: string, args: Record<string, unknown>, root?: string): AccessTarget[] => {
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value : undefined)
  const pick = (access: AccessClass, key: string, operation?: WriteOperation): AccessTarget[] => {
    const target = text(args[key])
    return target ? [{ path: target, access, ...(operation ? { operation } : {}) }] : []
  }
  switch (tool) {
    case "read_file":
    case "list_dir":
    case "grep":
    case "diagnostics":
    case "find_references":
    case "go_to_definition":
      return pick("read", "path")
    case "create_file":
      return pick("write", "path", "create").map((target) => ({ ...target, creates: true }))
    case "edit_lines":
    case "edit_file":
      return pick("write", "path", "edit")
    case "delete_file":
      return pick("write", "path", "remove")
    case "rename_symbol":
      return pick("write", "path")
    case "move_file":
      return [...pick("write", "from", "move"), ...pick("write", "to", "move").map((target) => ({ ...target, creates: true }))]
    case "git": {
      // The repository a git call may reach: as the call wrote it, or the open folder when it named none.
      // What the call does to it is decided per call, not by how the tool was registered: a read asks read
      // access, an operation that changes the repository asks write, so a grant taken for `status` cannot carry
      // it. The typed request Stage 4 names is what the operation is approved for - exact repository with exact
      // paths, or exact repository with exact operation id - and a read names none.
      const named = text(args.repository) ?? (root === undefined ? undefined : path.resolve(root))
      if (named === undefined) return []
      const request = gitRequestsForCall(args, path.resolve(named))[0]
      return [{ path: named, access: gitCallIsReadOnly(args) ? "read" : "write", ...(request === undefined ? {} : { git: request }) }]
    }
    default:
      return []
  }
}

const isDirectoryPath = (absolute: string): boolean => {
  try {
    return fs.statSync(canonicalPath(absolute)).isDirectory()
  } catch {
    return false
  }
}

/** The folder a folder choice would grant: the one holding the path, when the path really lies in it and it is not a disk root. */
const folderOf = (absolute: string): string | undefined => {
  const folder = path.dirname(absolute)
  const realFolder = canonicalPath(folder)
  if (isFilesystemRoot(realFolder)) return undefined
  return isWithin(realFolder, canonicalPath(absolute)) ? folder : undefined
}

const grantFor = (prompt: AccessPrompt, choice: AccessChoice, host: string): AccessGrant | undefined => {
  if (choice === "deny") return undefined
  if (choice.target === "folder") {
    return prompt.folder ? makeGrant(prompt.folder, "folder", prompt.access, choice.lifetime, host) : undefined
  }
  return makeGrant(prompt.path, prompt.isDirectory ? "folder" : "file", prompt.access, choice.lifetime, host)
}

export const createAccessPreflight = ({
  store,
  view,
  approve,
}: {
  store: AccessStore
  view: AccessView
  approve?: AccessApprover
}): AccessPreflight => {
  const denied = (absolute: string, access: AccessClass) =>
    ({ ok: false, message: `${absolute} is outside the workspace and access to ${access === "write" ? "change" : "read"} it was not granted.` }) as const

  return {
    async authorize(targets, tool, signal) {
      const pending: { absolute: string; access: AccessClass; operation?: WriteOperation }[] = []
      // A typed Git request is part of what this call is approved for even when the repository it names is
      // inside the workspace: it is the request the operation spends, not a path grant.
      const requests: AuthorizedRequest[] = []
      for (const target of targets) {
        if (target.git) requests.push(target.git)
        const absolute = view.outsideLexical(target.path, target.creates)
        if (!absolute || view.preauthorized(absolute)) continue
        const refusal = view.refusal(absolute)
        if (refusal) return { ok: false, message: refusal }
        pending.push({ absolute, access: target.access, operation: target.operation })
      }

      for (const item of pending) {
        if (store.covering(item.absolute, item.access)) continue
        if (!approve || signal?.aborted) return denied(item.absolute, item.access)
        const real = canonicalPath(item.absolute)
        const prompt: AccessPrompt = {
          path: item.absolute,
          real: real === item.absolute ? undefined : real,
          tool,
          access: item.access,
          isDirectory: isDirectoryPath(item.absolute),
          folder: folderOf(item.absolute),
        }
        let choice: AccessChoice | undefined
        try {
          choice = await approve(prompt, signal)
        } catch {
          choice = undefined
        }
        if (signal?.aborted) return denied(item.absolute, item.access)
        const grant = choice ? grantFor(prompt, choice, store.host) : undefined
        if (!grant) return denied(item.absolute, item.access)
        await store.add(grant)
      }
      const writes = pending.flatMap((item) => (item.operation ? [{ operation: item.operation, absolute: item.absolute }] : []))
      const covered = [...requests, ...writes]
      return covered.length > 0 ? { ok: true, write: OperationAuthorization.issue(store.host, covered), requests: covered } : { ok: true }
    },
    endCall() {
      store.endCall()
    },
  }
}
