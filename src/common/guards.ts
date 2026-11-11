/** Type guards shared across the extension, the protocol and the gateway. Pure. */
import type { TodoListSnapshot } from "./types"

/** A plain object: not null, not an array. What JSON.parse gives for `{...}`. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * True when `next` is an older revision of the list `current` already shows, so applying it would roll the panel back.
 * Snapshots of another list or conversation are always new state.
 */
export const isStaleTodoSnapshot = (
  current: Pick<TodoListSnapshot, "id" | "conversationId" | "revision"> | undefined,
  next: Pick<TodoListSnapshot, "id" | "conversationId" | "revision">
): boolean =>
  !!current && current.id === next.id && current.conversationId === next.conversationId && next.revision < current.revision

/**
 * Applies a snapshot delivered while `activeConversationId` is on screen. A response for any other conversation, late
 * or from a superseded request, is ignored, and an older revision never replaces a newer one.
 */
export const applyTodoSnapshot = <T extends Pick<TodoListSnapshot, "id" | "conversationId" | "revision">>(
  activeConversationId: string | undefined,
  current: T | undefined,
  next: T
): T | undefined => {
  if (next.conversationId !== activeConversationId) return current
  return isStaleTodoSnapshot(current, next) ? current : next
}

/** The held snapshot only when it belongs to the conversation on screen; another conversation's list is never shown. */
export const snapshotForConversation = <T extends Pick<TodoListSnapshot, "conversationId">>(
  conversationId: string | undefined,
  snapshot: T | undefined
): T | undefined => (conversationId !== undefined && snapshot?.conversationId === conversationId ? snapshot : undefined)
