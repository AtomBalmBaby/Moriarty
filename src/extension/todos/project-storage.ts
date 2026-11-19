/**
 * The project database location for the window that is open now, read by every
 * consumer that opens it: the TODO repository and the workspace index. The home
 * decides where the database lives; it never says which paths a tool may reach.
 */
import * as vscode from "vscode"

import { type ProjectTodoStorage } from "./project-home"
import { resolveProjectTodoStorage } from "./sqlite"

/** `workspaceFileUri` is the current form; `workspaceFile` is the older one the extension typings still declare. */
const savedWorkspaceFile = (): string | undefined =>
  ((vscode.workspace as { workspaceFileUri?: vscode.Uri }).workspaceFileUri ?? vscode.workspace.workspaceFile)?.fsPath

/** The folder that owns the project database, chosen without workspace folder order. */
export const currentProjectTodoStorage = (): ProjectTodoStorage => resolveProjectTodoStorage(
  (vscode.workspace.workspaceFolders ?? []).map((folder) => ({ scheme: folder.uri.scheme, fsPath: folder.uri.fsPath })),
  { workspaceFile: savedWorkspaceFile(), projectHome: vscode.workspace.getConfiguration("twinny").get<string>("projectHome") }
)
