/**
 * The composer's side of explicit prompt compilation. Kept free of React so
 * the rules that protect the user's draft can be tested directly.
 */

export interface PointerModifiers {
  ctrlKey?: boolean
  metaKey?: boolean
}

export const isMacPlatform = (platform: string | undefined): boolean =>
  /mac|iphone|ipad|ipod/i.test(platform ?? "")

/**
 * Ctrl+Click asks for compilation; on macOS, where Ctrl+Click is a
 * secondary click, Command+Click does.
 */
export const isCompileGesture = (event: PointerModifiers, mac: boolean): boolean =>
  mac ? !!event.metaKey : !!event.ctrlKey

export type SendAction = "send" | "compile" | "ignore"

/**
 * What a Send-button click does. The compiler only runs on the modifier
 * gesture and only when enabled; disabled, the click still sends so the
 * user's action is never dropped. A second compile request while one is
 * running is ignored rather than queued.
 */
export const sendButtonAction = (
  event: PointerModifiers,
  options: { mac: boolean; compilerEnabled: boolean; compiling: boolean }
): SendAction => {
  if (!isCompileGesture(event, options.mac) || !options.compilerEnabled) return "send"
  return options.compiling ? "ignore" : "compile"
}

/** A compilation in flight, with the draft it was started from. */
export interface PendingCompilation {
  requestId: string
  conversationId: string | undefined
  revision: number
  draft: string
}

/** The composer as it is when the compiler answers. */
export interface ComposerState {
  /** The compilation the composer is still waiting for, if any. */
  latestRequestId: string | undefined
  conversationId: string | undefined
  revision: number
  text: string
}

export type CompiledDraftDecision =
  /** The draft is untouched: replace it with the compiled prompt. */
  | { action: "apply" }
  /** The user edited meanwhile: keep their text, offer the result. */
  | { action: "offer" }
  /** The result no longer belongs to this composer: drop it. */
  | { action: "discard"; reason: "superseded" | "conversation-changed" | "cleared" }

export const decideCompiledDraft = (
  pending: PendingCompilation,
  composer: ComposerState
): CompiledDraftDecision => {
  if (composer.latestRequestId !== pending.requestId) return { action: "discard", reason: "superseded" }
  if (composer.conversationId !== pending.conversationId) return { action: "discard", reason: "conversation-changed" }
  if (!composer.text.trim()) return { action: "discard", reason: "cleared" }
  if (composer.revision === pending.revision && composer.text === pending.draft) return { action: "apply" }
  return { action: "offer" }
}

/** Plain text as composer paragraphs, escaped for the editor's HTML input. */
export const textToComposerHtml = (text: string): string => {
  const escape = (value: string) =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  return text
    .split(/\r?\n/)
    .map((line) => `<p>${escape(line)}</p>`)
    .join("")
}
