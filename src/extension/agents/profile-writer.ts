import * as fs from "fs"
import { dump } from "js-yaml"

import { ParsedAgentProfile } from "./profile"

export const writeAgentProfile = (filePath: string, profile: ParsedAgentProfile) => {
  // Build a fresh frontmatter object including only supported fields.
  const frontmatter: Record<string, unknown> = { ...profile.frontmatter }
  if (profile.tools !== undefined) frontmatter.tools = profile.tools
  // Dump YAML frontmatter
  const yamlText = dump(frontmatter, { lineWidth: 1024 })
  // Reconstruct full file content
  const content = "---\n" + yamlText + "---\n" + (profile.instructions ?? "")
  fs.writeFileSync(filePath, content, { encoding: "utf8" })
}
