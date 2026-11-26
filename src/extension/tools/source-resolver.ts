/**
 * The shared source resolver: a file a call names by its content fingerprint.
 *
 * A fingerprint is an assertion about a version of content, not a permanent identity
 * for a file. The index gives candidates and the current content decides. The resolver
 * only says "this is the one file" when it can prove it: either the project index holds
 * a row for every file the tools may consider and those rows are current, or every one
 * of those files was checked. A scan that stopped before its end proves nothing, so such
 * a call is refused with an error that says why and asks for `path`.
 *
 * Candidates come from where the tools are already allowed to look: the project's own
 * index, the files open in the editor, and the view's own file list inside the workspace.
 * Nothing is searched on the disk for a matching hash beyond what a call could read
 * anyway. A match grants nothing: the same authorization rules apply, and a file the
 * caller may not see is never discovered, named or changed.
 */
import path from "path"

import { diagnosticEvent } from "../diagnostics"

import type { AccessOutcome, AccessTarget } from "./access-preflight"
import { argumentFailure, type ToolArguments, type ToolErrorDetail } from "./arguments"
import { fingerprintContent, getContentHashAlgorithm, verifyContentFingerprint } from "./fingerprint"
import type { OperationAuthorization, WriteOperation } from "./operation-authorization"
import type { WorkspaceView } from "./view"

/** Whether the index can answer "no other file holds this content". */
export interface IndexCoverage {
  /** Every file the tools may consider has a row here.
   * Rows are keyed by path, so a file the index never saw cannot be answered for.
   */
  complete: boolean
  /** Those rows are current: nothing pending, dirty or renamed since the last sync.
   * Without this a stale row can hide a file that now holds the content.
   */
  fresh: boolean
  /** Files with no row, when the answer is not complete. */
  unexamined?: number
  reason?: string
}

/** Where the project keeps fingerprints. A candidate is a lead, never proof. */
export interface FingerprintCandidates {
  /** Paths the index holds with this fingerprint, as the tools would show them. */
  candidatesFor(fingerprint: string): Promise<string[]>
  /** Whether those paths are the whole eligible set; `shown` is what the caller may see. */
  coverage(shown: string[]): Promise<IndexCoverage>
}

/** What one resolution cost, so the common case can be measured rather than assumed. */
export interface ResolutionCost {
  /** Where the candidates came from. */
  source: "index" | "buffers" | "scan" | "none"
  /** Whether uniqueness was proved over the whole eligible set, not just over what was found. */
  proven: boolean
  candidates: number
  verified: number
  /** Files whose content was read to check a fingerprint; zero when the index settled it. */
  scanned: number
  /** Eligible files the call could not prove it examined. */
  unexamined?: number
  ms: number
}

/** A target the call may use: as the tool would show it, and where it really is. */
export interface ResolvedSource {
  ok: true
  path: string
  absolute: string
  /** `hash` when the fingerprint named the file, `path` when the call did. */
  via: "hash" | "path"
  fingerprint: string
  cost: ResolutionCost
  /** The write the call was given for this file, when it had to be asked for. */
  write?: OperationAuthorization
}

export type ResolvedTarget = ResolvedSource | { ok: false; detail: ToolErrorDetail }

/** A fingerprint as it may be written: the configured algorithm, or bare hex for it. */
export const normalizeFingerprint = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined
  const text = value.trim().toLowerCase()
  if (!text) return undefined
  if (/^xxh64:[0-9a-f]{16}$/.test(text)) return text
  if (/^xxh3_128:[0-9a-f]{32}$/.test(text)) return text
  if (/^sha256:[0-9a-f]{64}$/.test(text)) return text
  if (/^[0-9a-f]{64}$/.test(text)) return `sha256:${text}`
  if (/^[0-9a-f]{32}$/.test(text)) return `xxh3_128:${text}`
  if (/^[0-9a-f]{16}$/.test(text)) return `xxh64:${text}`
  return undefined
}

/**
 * How many eligible files one resolution may read, and still be able to say it saw them
 * all. Past this the caller is refused rather than given a guess: a partial scan cannot
 * establish that one file is the only one with this content.
 */
export const MAX_RESOLVER_SCAN_FILES = 400

export interface SourceResolverOptions {
  view: WorkspaceView
  /** The project's index, when the host has one. */
  index?: FingerprintCandidates
  /** Files open in the editor: their buffer may not be what the index recorded. */
  openFiles?: () => string[] | Promise<string[]>
  /** The same preflight every call goes through, asked about the file this resolved to. */
  authorize?: (targets: AccessTarget[], tool: string, signal?: AbortSignal) => Promise<AccessOutcome>
  /** Leads this session has already seen for a fingerprint, so a repeated call does not rewalk.
   * They are candidates only: the current content still decides every time.
   */
  cache?: Map<string, string[]>
  /** The fingerprint implementation, so a conformance test can stage a genuine collision. */
  fingerprint?: (text: string) => Promise<string>
  maxScanFiles?: number
}

export interface ResolveRequest {
  tool: string
  args: ToolArguments
  /** What the call would do to the file: reading one needs no permission, changing one does. */
  kind: "read" | "write"
  operation?: WriteOperation
  signal?: AbortSignal
}

const refuse = (tool: string, code: ToolErrorDetail["code"], message: string, extra: { required_argument?: string; candidates?: string[]; recovery?: string; current_hash?: string } = {}): ResolvedTarget =>
  ({ ok: false, detail: argumentFailure(code, `${tool}: ${message}`, extra) })

/**
 * The candidate paths a hash-only call may be pointed at, inside what the caller may see,
 * and whether that set is the whole eligible one.
 */
const candidatesOf = async (options: SourceResolverOptions, hash: string): Promise<{ paths: string[]; cost: ResolutionCost }> => {
  const seen = new Set<string>()
  const paths: string[] = []
  const add = (absolute: string) => {
    const target = path.resolve(absolute)
    if (!seen.has(target) && options.view.visible(target)) {
      seen.add(target)
      paths.push(target)
    }
  }
  const found = options.index ? await options.index.candidatesFor(hash) : options.cache?.get(hash) ?? []
  for (const candidate of found) add(path.isAbsolute(candidate) ? candidate : path.resolve(options.view.root, candidate))
  const buffers = await options.openFiles?.() ?? []
  for (const open of buffers) add(open)

  const shown = paths.map((absolute) => options.view.relative(absolute))
  const coverage = options.index ? await options.index.coverage(shown) : { complete: false, fresh: false }
  const cost: ResolutionCost = { source: found.length ? "index" : paths.length ? "buffers" : "none", proven: false, candidates: paths.length, verified: 0, scanned: 0, ms: 0 }
  if (coverage.complete && coverage.fresh) return { paths, cost: { ...cost, proven: true } }

  // The index cannot answer for the whole eligible set: check every file the tools may
  // consider, and refuse rather than guess when that set does not fit in one bound.
  const eligible = await options.view.files()
  const limit = options.maxScanFiles ?? MAX_RESOLVER_SCAN_FILES
  if (eligible.length > limit) {
    return {
      paths,
      cost: { ...cost, proven: false, unexamined: eligible.length }
    }
  }
  for (const file of eligible) add(file)
  return { paths, cost: { ...cost, source: found.length ? "index" : "scan", proven: true, candidates: paths.length } }
}

/**
 * The file this call is about. A `path` is verified against its own content; a
 * fingerprint that names exactly one current, allowed file resolves to it.
 */
export const resolveSourceTarget = async (options: SourceResolverOptions, request: ResolveRequest): Promise<ResolvedTarget> => {
  const started = Date.now()
  const hash = normalizeFingerprint(request.args.expected_hash)
  const named = typeof request.args.path === "string" ? request.args.path.trim() : ""
  if (!named && !hash)
    return refuse(request.tool, "missing_target", "name the file with path, or send a content fingerprint from read_file as expected_hash.", {
      required_argument: "path",
      recovery: "Send path, or an expected_hash that names one current file."
    })
  if (request.args.expected_hash !== undefined && request.args.expected_hash !== null && !hash)
    return refuse(request.tool, "invalid_hash", "expected_hash is not a content fingerprint this tool can check.", {
      required_argument: "expected_hash",
      recovery: `Send it as ${getContentHashAlgorithm()}:<hex> exactly as read_file printed it.`
    })

  /** Whether content still carries the fingerprint the call was sent with, whatever algorithm it names. */
  const sameFingerprint = async (text: string): Promise<boolean> => {
    try {
      return await verifyContentFingerprint(text, hash!)
    } catch {
      // A fingerprint the checker cannot read is not a content assertion at all.
      return false
    }
  }

  // The call named a file: that file is the target, and its content must still be what the call says.
  if (named) {
    let absolute: string
    try {
      absolute = options.view.resolve(named, "file")
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return refuse(request.tool, /outside|ignored|blocked|protected|permission|rules/i.test(message) ? "permission_denied" : "document_unavailable", message, {
        required_argument: "path",
        recovery: "Name a file the tools may use, or ask for that path first."
      })
    }
    const text = await options.view.text(absolute)
    if (text === undefined)
      return refuse(request.tool, "document_unavailable", `${options.view.relative(absolute)} is binary or too large for the tool to read; no changes were applied.`, {
        required_argument: "path",
        recovery: "Name a readable file, or open a smaller text file."
      })
    if (hash) {
      if (!(await sameFingerprint(text)))
        return refuse(request.tool, "stale_hash", `${options.view.relative(absolute)} is not the content this call was sent with; nothing was changed.`, {
          required_argument: "path",
          recovery: "Read the file again to get its current fingerprint, then edit that.",
          current_hash: await fingerprintContent(text)
        })
    }
    return { ok: true, path: options.view.relative(absolute), absolute, via: "path", fingerprint: hash ?? "", cost: report(request, { source: "none", proven: true, candidates: 0, verified: 0, scanned: 0, ms: Date.now() - started }) }
  }

  const found = await candidatesOf(options, hash!)
  const verified: string[] = []
  let scanned = 0
  for (const absolute of found.paths) {
    const text = await options.view.text(absolute)
    if (text === undefined) continue
    scanned += 1
    if (await sameFingerprint(text)) {
      verified.push(absolute)
      if (options.cache && hash) options.cache.set(hash, [...(options.cache.get(hash) ?? []), absolute])
    }
  }
  const cost = report(request, { ...found.cost, scanned, verified: verified.length, ms: Date.now() - started })

  if (!verified.length && !cost.proven)
    return refuse(request.tool, "hash_unproven", `this fingerprint was not proved unique or absent: ${plural(cost.unexamined ?? Math.max(0, cost.scanned))} could not be examined within the resolver bound.`, {
      required_argument: "path",
      recovery: "Supply path, or let the project index cover these files before naming a file by its content."
    })
  if (!verified.length)
    return refuse(request.tool, "hash_not_found", "no file this caller may see has that content fingerprint.", {
      required_argument: "path",
      recovery: cost.proven
        ? "Read the file again to refresh its fingerprint, or supply path."
        : "Supply path: the index could not name this fingerprint and the workspace is too large to check file by file."
    })
  if (verified.length > 1)
    return refuse(request.tool, "ambiguous_hash", "Multiple files match this content fingerprint. Supply path to select the target.", {
      required_argument: "path",
      candidates: verified.map((absolute) => options.view.relative(absolute)),
      recovery: "Call again with path, the one file to change."
    })

  // One match is only an answer when nothing else could have matched.
  if (!cost.proven)
    return refuse(request.tool, "hash_unproven", `the file that matches this fingerprint was checked, but ${plural(cost.unexamined ?? cost.scanned)} was not, so it cannot be called the only one.`, {
      required_argument: "path",
      recovery: "Supply path, or let the project index cover these files before naming a file by its content.",
      candidates: [options.view.relative(verified[0])] // the caller may already see it
    })

  const absolute = verified[0]
  const relative = options.view.relative(absolute)
  const targets: AccessTarget[] = [{ path: relative, access: request.kind, ...(request.operation ? { operation: request.operation } : {}) }]
  let write: OperationAuthorization | undefined
  if (options.view.isExternal(absolute)) {
    if (!options.authorize)
      return refuse(request.tool, "permission_denied", `${relative} is outside the workspace and access to it was not granted.`, {
        required_argument: "path",
        recovery: "Name a file inside the workspace, or ask for that folder first."
      })
    const outcome = await options.authorize(targets, request.tool, request.signal)
    if (!outcome.ok) return refuse(request.tool, "permission_denied", outcome.message, { required_argument: "path" })
    write = outcome.write
  }

  // The content is checked once more, straight before it is used: what was proved above may have changed.
  const text = await options.view.text(absolute)
  if (text === undefined || !(await sameFingerprint(text)))
    return refuse(request.tool, "stale_hash", `${relative} changed while this call was resolving it; nothing was changed.`, {
      required_argument: "path",
      recovery: "Read it again to get its current fingerprint."
    })
  return { ok: true, path: relative, absolute, via: "hash", fingerprint: hash!, ...(write ? { write } : {}), cost: { ...cost, verified: Math.max(cost.verified, 1) } }
}

const plural = (count: number): string => (count === 1 ? "one file" : `${count} files`)

/** What one resolution cost, recorded as the host measures it. */
const report = (request: ResolveRequest, cost: ResolutionCost): ResolutionCost => {
  diagnosticEvent("toolcalls", "tool.source.resolution", {}, {
    toolName: request.tool,
    by: request.args.path ? "path" : "fingerprint",
    candidates: cost.candidates,
    verified: cost.verified,
    scanned: cost.scanned,
    proven: cost.proven,
    durationMs: cost.ms,
    candidateSource: cost.source
  })
  return cost
}
