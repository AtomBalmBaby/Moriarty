import * as fs from "fs/promises"

export type PromptInstructionRoute = "chat" | "intent"
export type PromptInstructionMode = "default" | "custom" | "none"

export interface MarkdownInstructionSource {
  content: string
  source?: string
  warning?: string
}

const routeLabel = (route: PromptInstructionRoute) => route === "intent" ? "Prompt Compiler" : route

export const resolveMarkdownInstructionSource = async (
  route: PromptInstructionRoute,
  mode: PromptInstructionMode,
  file: string | undefined,
  bundledFile: string
): Promise<MarkdownInstructionSource> => {
  if (mode === "none") return { content: "" }
  if (mode === "custom") {
    if (!file?.trim()) {
      return {
        content: await fs.readFile(bundledFile, "utf8"),
        source: bundledFile,
        warning: "Custom " + routeLabel(route) + " base instructions are selected, but no Markdown file is configured. The built-in default is being used."
      }
    }
    try {
      return { content: await fs.readFile(file, "utf8"), source: file }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return {
        content: await fs.readFile(bundledFile, "utf8"),
        source: bundledFile,
        warning: "Could not read the " + routeLabel(route) + " base-instructions file \"" + file + "\": " + detail + ". The built-in default is being used."
      }
    }
  }
  return { content: await fs.readFile(bundledFile, "utf8"), source: bundledFile }
}
