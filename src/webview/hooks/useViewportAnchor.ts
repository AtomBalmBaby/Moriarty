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

const rowElement = (scroller: HTMLElement, index: number) =>
  index < 0 ? null : scroller.querySelector<HTMLElement>(`[data-index="${index}"]`)

const SCROLL_UP_KEYS = new Set(["ArrowUp", "PageUp", "Home"])
const SCROLL_KEYS = new Set([...SCROLL_UP_KEYS, "ArrowDown", "PageDown", "End", " "])

/**
 * Copilot-style anchoring for the transcript. A new response's prompt is
 * placed at the top, and blank space below it lets the response grow
 * downward. Once it overflows, the transcript follows its end. Manual
 * scrolling away suspends following; `jumpToLatest` or returning to the
 * bottom resumes it.
 */
export function useViewportAnchor<Item>(virtuosoRef: RefObject<VirtuosoHandle>) {
  const stateRef = useRef<ViewportAnchor>(followingViewport)
  const [following, setFollowing] = useState(true)
  const [scroller, setScroller] = useState<HTMLElement | null>(null)
  const scrollerRef = useRef<HTMLElement | null>(null)
  const spacerRef = useRef<HTMLDivElement | null>(null)
  const observerRef = useRef<ResizeObserver | null>(null)
  const rowCountRef = useRef(0)
  const anchorRowRef = useRef(0)
  const contentHeightRef = useRef(0)
  const frameRef = useRef<number | null>(null)
  const scrollTopRef = useRef(0)

  const commit = useCallback((next: ViewportAnchor) => {
    stateRef.current = next
    setFollowing(next.following)
  }, [])

  const fitSpacer = useCallback(() => {
    const scrollerElement = scrollerRef.current
    const spacer = spacerRef.current
    if (!scrollerElement || !spacer) return
    const list = scrollerElement.querySelector<HTMLElement>(ITEM_LIST)
    const anchor = rowElement(scrollerElement, anchorRowRef.current)
    const last = rowElement(scrollerElement, rowCountRef.current - 1)
    if (list) observerRef.current?.observe(list)
    if (anchor) observerRef.current?.observe(anchor)
    if (last) observerRef.current?.observe(last)
    // Measured from the anchored row's top, so the spacer only fills the viewport the response has not reached yet.
    // An anchor or last row that is not mounted means the response already overflows the viewport.
    const fill =
      stateRef.current.anchoredKey && anchor && last
        ? anchorSpacer(
            scrollerElement.clientHeight,
            last.getBoundingClientRect().bottom - anchor.getBoundingClientRect().top
          )
        : 0
    // A collapse can shrink the content below the reader's scroll position, and the browser then clamps it.
    // Reserving just the missing space keeps the reader where it was. Scrolling up releases the reservation.
    const contentHeight = scrollerElement.scrollHeight - spacer.offsetHeight
    const reserve = stateRef.current.following
      ? 0
      : Math.max(0, scrollTopRef.current + scrollerElement.clientHeight - contentHeight)
    spacer.style.height = `${Math.max(fill, reserve)}px`
  }, [])

  const scrollToEnd = useCallback(() => {
    if (frameRef.current !== null) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null
      virtuosoRef.current?.scrollTo({ top: Infinity, behavior: scrollBehavior(prefersReducedMotion()) })
    })
  }, [virtuosoRef])

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
    const onScroll = () => {
      const top = scroller.scrollTop
      const max = scroller.scrollHeight - scroller.clientHeight
      // Landing on the maximum from beyond it can only be the browser clamping after content shrank, not a user scroll.
      const clamped = top >= max && top < scrollTopRef.current
      if (clamped) {
        fitSpacer()
        scroller.scrollTop = scrollTopRef.current
        return
      }
      scrollTopRef.current = top
      fitSpacer()
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
    scroller.addEventListener("scroll", onScroll, { passive: true })
    scrollTopRef.current = scroller.scrollTop
    return () => {
      observer.disconnect()
      observerRef.current = null
      scroller.removeEventListener("wheel", onWheel)
      scroller.removeEventListener("touchmove", onDrag)
      scroller.removeEventListener("pointerdown", onDrag)
      scroller.removeEventListener("keydown", onKey)
      scroller.removeEventListener("scroll", onScroll)
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

  const components = useMemo<Components<Item>>(
    () => ({
      Footer: () => createElement("div", { ref: attachSpacer, "aria-hidden": "true" })
    }),
    [attachSpacer]
  )

  /** Records how many rows the list shows and which row the newest response starts at. */
  const setLayout = useCallback(
    (rowCount: number, anchorRow: number) => {
      rowCountRef.current = rowCount
      anchorRowRef.current = anchorRow
      fitSpacer()
    },
    [fitSpacer]
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
          index: anchorRowRef.current,
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
    setLayout,
    anchorOperation,
    scrolledAway,
    resume,
    jumpToLatest,
    reset
  }
}
