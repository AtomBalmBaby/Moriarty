/**
 * The identity of the server this extension host runs on, so grants kept
 * across sessions and write claims apply only to the server they were made on.
 */
import os from "os"
import { env, workspace } from "vscode"

import { accessHostKey } from "./access-grants"

export const currentAccessHostKey = (): string =>
  accessHostKey({
    remoteName: env.remoteName,
    authority: workspace.workspaceFolders?.[0]?.uri.authority,
    machineId: env.machineId,
    hostname: os.hostname(),
  })
