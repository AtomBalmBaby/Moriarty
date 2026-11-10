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
