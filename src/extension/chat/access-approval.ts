/**
 * The VS Code side of file access: the question asked before a native tool
 * touches a path outside the workspace, and the list of always grants the
 * user can revoke. Both fail closed: a dismissed or cancelled question is a
 * denial.
 */
import * as vscode from "vscode"

import type { AccessGrant } from "../tools/access-grants"
import type { AccessApprover, AccessChoice, AccessPrompt } from "../tools/access-preflight"

type ChoiceItem = vscode.QuickPickItem & { choice: AccessChoice }

const choiceItems = (prompt: AccessPrompt): ChoiceItem[] => {
  const noun = prompt.isDirectory ? "this directory" : "file"
  const exact = (lifetime: "once" | "session" | "always") => ({
    description: prompt.path,
    choice: { target: "exact" as const, lifetime }
  })
  const folder = (lifetime: "once" | "session" | "always") => ({
    description: prompt.folder,
    choice: { target: "folder" as const, lifetime }
  })
  const folderItems = (lifetime: "once" | "session" | "always", label: string): ChoiceItem[] =>
    prompt.folder ? [{ label, ...folder(lifetime) }] : []
  return [
    { label: `Allow ${noun} once`, ...exact("once") },
    ...folderItems("once", "Allow folder once"),
    { label: `Allow ${noun} for session`, ...exact("session") },
    ...folderItems("session", "Allow folder for session"),
    { label: `Always allow ${noun}`, ...exact("always") },
    ...folderItems("always", "Always allow folder"),
    { label: "Deny", description: prompt.path, choice: "deny" }
  ]
}

/**
 * Asks in a quick pick, which stays open when focus moves. Dismissing it,
 * cancelling, or a missing editor all resolve to undefined, which the
 * preflight treats as a denial.
 */
export const chatAccessApprover: AccessApprover = async (prompt, signal) => {
  if (signal?.aborted) return undefined
  const source = new vscode.CancellationTokenSource()
  const cancel = () => source.cancel()
  signal?.addEventListener("abort", cancel)
  try {
    const verb = prompt.access === "write" ? "change" : "read"
    const reached = prompt.real ? ` It really leads to ${prompt.real}.` : ""
    const picked = await vscode.window.showQuickPick(choiceItems(prompt), {
      title: `Twinny: ${prompt.tool} wants ${prompt.access} access to ${prompt.path}`,
      placeHolder: `Allow Twinny to ${verb} this path?${reached} Read access never allows changes.`,
      ignoreFocusOut: true
    }, source.token)
    return picked?.choice
  } finally {
    signal?.removeEventListener("abort", cancel)
    source.dispose()
  }
}

/** Lists the always grants for this host and returns those the user picks to revoke. */
export const pickAlwaysGrantsToRevoke = async (grants: AccessGrant[]): Promise<AccessGrant[] | undefined> => {
  if (!grants.length) {
    await vscode.window.showInformationMessage("Twinny has no always-allowed file access to revoke.")
    return undefined
  }
  const items = grants.map((grant) => ({
    label: `${grant.access === "write" ? "Write" : "Read"} · ${grant.scope === "folder" ? "Folder" : "File"}`,
    description: grant.root,
    grant
  }))
  const picked = await vscode.window.showQuickPick(items, {
    title: "Twinny: revoke always-allowed file access",
    placeHolder: "Select the access to revoke",
    canPickMany: true,
    ignoreFocusOut: true
  })
  return picked?.map((item) => item.grant)
}
