/**
 * Viewport state for following the newest response. While following, a new
 * response is anchored near the top of the chat and grows downward; once it
 * overflows the viewport the chat follows its end. A manual scroll suspends
 * following until the user returns to the bottom or chooses Jump to latest.
 */

export interface ViewportAnchor {
  following: boolean
  /** The response most recently anchored; anchoring happens once per key. */
  anchoredKey?: string
}

export const followingViewport: ViewportAnchor = { following: true }

export function anchorResponse(state: ViewportAnchor, key: string): ViewportAnchor {
  if (!state.following || state.anchoredKey === key) return state
  return { following: true, anchoredKey: key }
}

export function scrollAway(state: ViewportAnchor): ViewportAnchor {
  return state.following ? { ...state, following: false } : state
}

export function followLatest(state: ViewportAnchor): ViewportAnchor {
  return state.following ? state : { ...state, following: true }
}

/** Blank space below an anchored response, so it can sit at the top; zero once it fills the viewport. */
export function anchorSpacer(viewportHeight: number, responseHeight: number): number {
  return Math.max(0, Math.floor(viewportHeight - responseHeight))
}

/** Follow only growth that has overflowed the viewport, so collapsing or shrinking content never moves it. */
export function shouldFollow(
  state: ViewportAnchor,
  previousHeight: number,
  height: number,
  viewportHeight: number
): boolean {
  return state.following && height > previousHeight && height >= viewportHeight
}

export function scrollBehavior(reducedMotion: boolean): ScrollBehavior {
  return reducedMotion ? "auto" : "smooth"
}
