/** Small string helpers shared by the extension host and the webview. */

export const kebabToSentence = (kebab: string) => {
  if (!kebab) return ""
  const words = kebab.split("-")
  words[0] = words[0].charAt(0).toUpperCase() + words[0].slice(1)
  return words.join(" ")
}

export const getLineBreakCount = (text: string) => text.split("\n").length

/**
 * A message's text whatever its content form: a string, or the text and
 * refusal parts of a reply. Image parts carry no text and are left out.
 */
export const messageText = (
  message: { content?: unknown } | null | undefined
): string => {
  const content = message?.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part: unknown) => {
      if (!part || typeof part !== "object") return ""
      if ("text" in part && typeof part.text === "string") return part.text
      if ("refusal" in part && typeof part.refusal === "string")
        return part.refusal
      return ""
    })
    .join("")
}

/**
 * A reply's thinking and its message. An agent reply is several requests
 * in a row and a model may think before each, so every block is taken
 * out, an unfinished last one included.
 */
export const getThinkingMessage = (
  content: string
): { thinking: string | null; message: string } => {
  const blocks = [
    ...content.matchAll(
      /<(?:think|thinking)>([\s\S]*?)(?:<\/(?:think|thinking)>|$)/g
    )
  ]
  if (!blocks.length) return { thinking: null, message: content }

  const thinking = blocks
    .map((block) => block[1].trim())
    .filter(Boolean)
    .join("\n\n")
  const message = content
    .replace(/<(?:think|thinking)>[\s\S]*?(?:<\/(?:think|thinking)>|$)/g, "")
    .trim()
  return { thinking, message }
}
