import { createHash } from "crypto"
import * as path from "path"
import { ExtensionContext, window, workspace } from "vscode"

import { logger } from "../../common/logger"
import { resolveMarkdownInstructionSource } from "../../common/prompt-instructions"

export type InstructionRoute = "chat" | "intent"
export type InstructionMode = "default" | "custom" | "none"

export interface ResolvedInstructions {
  route: InstructionRoute
  mode: InstructionMode
  file?: string
  source?: string
  content: string
  hash: string
  warning?: string
}

const ROUTES: Record<InstructionRoute, { modeKey: string; fileKey: string; bundledFile: string }> = {
  chat: { modeKey: "chatBaseInstructionsMode", fileKey: "chatBaseInstructionsFile", bundledFile: "chat-base.default.md" },
  intent: { modeKey: "intentBaseInstructionsMode", fileKey: "intentBaseInstructionsFile", bundledFile: "intent-compiler-base.default.md" }
}

const hashContent = (content: string) => createHash("sha256").update(content).digest("hex")
const warnedFallbacks = new Set<string>()

const isMode = (value: unknown): value is InstructionMode =>
  value === "default" || value === "custom" || value === "none"

export const composeChatBaseInstructions = (team: string | undefined, base: string): string =>
  [team?.trim(), base.trim()].filter(Boolean).join("\n\n")

export class PromptInstructionResolver {
  constructor(private readonly _context: ExtensionContext) {}

  public async resolve(route: InstructionRoute): Promise<ResolvedInstructions> {
    const config = workspace.getConfiguration("twinny")
    const setting = ROUTES[route]
    const configuredMode = config.get<unknown>(setting.modeKey, "default")
    const mode = isMode(configuredMode) ? configuredMode : "default"
    const file = config.get<string>(setting.fileKey)

    const bundledFile = path.join(this._context.extensionUri.fsPath, "resources", "prompts", setting.bundledFile)
    const selection = await resolveMarkdownInstructionSource(route, mode, file, bundledFile)
    const invalidModeWarning = configuredMode !== mode
      ? "The configured " + route + " base-instructions mode is invalid. The built-in default is being used."
      : undefined
    const warning = selection.warning ?? invalidModeWarning
    if (warning) this.warnOnce(route + ":" + (file ?? "mode") + ":" + warning, warning)
    const result = {
      route,
      mode,
      file,
      source: selection.source,
      content: selection.content,
      hash: hashContent(selection.content),
      warning
    }
    this.trace(result)
    return result
  }

  private trace(result: ResolvedInstructions) {
    logger.debug("[Prompt] route=" + result.route + " mode=" + result.mode + " source=" + (result.source ?? "none") + " file=" + (result.file ?? "n/a") + " sha256=" + result.hash + " fallback=" + (result.warning ? "yes" : "no"))
  }

  private warnOnce(key: string, warning: string) {
    if (warnedFallbacks.has(key)) return
    warnedFallbacks.add(key)
    logger.warn(warning)
    void window.showWarningMessage(warning)
  }
}

export const promptInstructionConfigKeys = {
  chatMode: ROUTES.chat.modeKey,
  chatFile: ROUTES.chat.fileKey,
  intentMode: ROUTES.intent.modeKey,
  intentFile: ROUTES.intent.fileKey
} as const
