import { createElement, type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { type Components, type VirtuosoHandle } from "react-virtuoso"

import {
  anchorResponse,
  anchorSpacer,
  followingViewport,
  followLatest,
  scrollAway,
  scrollBehavior,
  shouldFollow,
  type ViewportAnchor
} from "../viewport-anchor"

const ITEM_LIST = "[data-testid=\"virtuoso-item-list\"]"
/** Distance from the end that still counts as following the latest content. */
const BOTTOM_THRESHOLD = 20

const prefersReducedMotion = () =>
  typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches

const isNearBottom = (scroller: HTMLElement) =>
  scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= BOTTOM_THRESHOLD

const SCROLL_UP_KEYS = new Set(["ArrowUp", "PageUp", "Home"])
const SCROLL_KEYS = new Set([...SCROLL_UP_KEYS, "ArrowDown", "PageDown", "End", " "])

/**
 * Copilot-style anchoring for the transcript. A new response's prompt is
 * placed at the top, and blank space below it lets the response grow
 * downward. Once it overflows, the transcript follows its end. Manual
 * scrolling away suspends following; `jumpToLatest` or returning to the
 * bottom resumes it.
 */
export function useViewportAnchor(virtuosoRef: RefObject<VirtuosoHandle>, count: number) {
  const stateRef = useRef<ViewportAnchor>(followingViewport)
  const [following, setFollowing] = useState(true)
  const [scroller, setScroller] = useState<HTMLElement | null>(null)
  const scrollerRef = useRef<HTMLElement | null>(null)
  const spacerRef = useRef<HTMLDivElement | null>(null)
  const observerRef = useRef<ResizeObserver | null>(null)
  const countRef = useRef(count)
  countRef.current = count
  const contentHeightRef = useRef(0)
  const frameRef = useRef<number | null>(null)

  const commit = useCallback((next: ViewportAnchor) => {
    stateRef.current = next
    setFollowing(next.following)
  }, [])

  const fitSpacer = useCallback(() => {
    const scrollerElement = scrollerRef.current
    const spacer = spacerRef.current
    if (!scrollerElement || !spacer) return
    const list = scrollerElement.querySelector<HTMLElement>(ITEM_LIST)
    const last = scrollerElement.querySelector<HTMLElement>(`[data-index="${countRef.current - 1}"]`)
    if (list) observerRef.current?.observe(list)
    if (!last) return
    observerRef.current?.observe(last)
    const height = stateRef.current.anchoredKey
      ? anchorSpacer(scrollerElement.clientHeight, last.offsetHeight)
      : 0
    spacer.style.height = `${height}px`
  }, [])

  const scrollToEnd = useCallback(() => {
    if (frameRef.current !== null) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null
      virtuosoRef.current?.scrollTo({ top: Infinity, behavior: scrollBehavior(prefersReducedMotion()) })
    })
  }, [virtuosoRef])

  useEffect(() => {
    fitSpacer()
  }, [count, fitSpacer])

  useEffect(() => {
    if (!scroller) return
    const away = () => commit(scrollAway(stateRef.current))
    // Checked after the scroll applies, so a wheel or drag that reaches the end keeps following.
    const awayUnlessAtEnd = () =>
      requestAnimationFrame(() => {
        if (!isNearBottom(scroller)) away()
      })
    const onKey = (event: KeyboardEvent) => {
      if (SCROLL_KEYS.has(event.key)) awayUnlessAtEnd()
    }
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY !== 0) awayUnlessAtEnd()
    }
    const onDrag = () => awayUnlessAtEnd()

    const observer = new ResizeObserver(() => {
      fitSpacer()
      const spacerHeight = spacerRef.current?.offsetHeight ?? 0
      const height = scroller.scrollHeight - spacerHeight
      if (shouldFollow(stateRef.current, contentHeightRef.current, height, scroller.clientHeight)) {
        scrollToEnd()
      }
      contentHeightRef.current = height
    })
    observerRef.current = observer
    observer.observe(scroller)
    fitSpacer()

    scroller.addEventListener("wheel", onWheel, { passive: true })
    scroller.addEventListener("touchmove", onDrag, { passive: true })
    scroller.addEventListener("pointerdown", onDrag)
    scroller.addEventListener("keydown", onKey)
    return () => {
      observer.disconnect()
      observerRef.current = null
      scroller.removeEventListener("wheel", onWheel)
      scroller.removeEventListener("touchmove", onDrag)
      scroller.removeEventListener("pointerdown", onDrag)
      scroller.removeEventListener("keydown", onKey)
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
  }, [scroller, commit, fitSpacer, scrollToEnd])

  const attachScroller = useCallback((element: HTMLElement | Window | null) => {
    const next = element instanceof HTMLElement ? element : null
    scrollerRef.current = next
    setScroller(next)
  }, [])

  const attachSpacer = useCallback((element: HTMLDivElement | null) => {
    spacerRef.current = element
    fitSpacer()
  }, [fitSpacer])

  const components = useMemo<Components>(
    () => ({
      Footer: () => createElement("div", { ref: attachSpacer, "aria-hidden": "true" })
    }),
    [attachSpacer]
  )

  /** Anchors the response `key` at the top; a key already anchored, or a scrolled-away viewport, changes nothing. */
  const anchorOperation = useCallback(
    (key: string) => {
      const next = anchorResponse(stateRef.current, key)
      if (next === stateRef.current) return
      commit(next)
      requestAnimationFrame(() => {
        fitSpacer()
        virtuosoRef.current?.scrollToIndex({
          index: countRef.current - 1,
          align: "start",
          behavior: scrollBehavior(prefersReducedMotion())
        })
      })
    },
    [commit, fitSpacer, virtuosoRef]
  )

  const scrolledAway = useCallback(() => commit(scrollAway(stateRef.current)), [commit])

  const resume = useCallback(() => commit(followLatest(stateRef.current)), [commit])

  const jumpToLatest = useCallback(() => {
    resume()
    virtuosoRef.current?.scrollTo({ top: Infinity, behavior: scrollBehavior(prefersReducedMotion()) })
  }, [resume, virtuosoRef])

  const reset = useCallback(() => {
    commit(followingViewport)
    fitSpacer()
  }, [commit, fitSpacer])

  return {
    following,
    components,
    scrollerRef: attachScroller,
    anchorOperation,
    scrolledAway,
    resume,
    jumpToLatest,
    reset
  }
}
