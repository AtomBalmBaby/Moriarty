import assert from "node:assert/strict"
import { test } from "node:test"

import {
  anchorResponse,
  anchorSpacer,
  followingViewport,
  followLatest,
  scrollAway,
  scrollBehavior,
  shouldFollow
} from "../../webview/viewport-anchor"

test("a new response anchors once while following", () => {
  const first = anchorResponse(followingViewport, "op-1")
  assert.deepEqual(first, { following: true, anchoredKey: "op-1" })
  assert.equal(anchorResponse(first, "op-1"), first, "a repeated key changes nothing")
  assert.deepEqual(anchorResponse(first, "op-2"), { following: true, anchoredKey: "op-2" })
})

test("a scrolled-away viewport does not anchor a new response", () => {
  const away = scrollAway(followingViewport)
  assert.equal(anchorResponse(away, "op-1"), away)
})

test("manual scroll suspends following and only a return to the end resumes it", () => {
  const away = scrollAway({ following: true, anchoredKey: "op-1" })
  assert.deepEqual(away, { following: false, anchoredKey: "op-1" })
  assert.equal(scrollAway(away), away, "a repeated scroll-away is idempotent")
  assert.deepEqual(followLatest(away), { following: true, anchoredKey: "op-1" })
  assert.equal(followLatest(followingViewport), followingViewport)
})

test("anchor spacer fills the space below a short response and vanishes once it overflows", () => {
  assert.equal(anchorSpacer(600, 150), 450)
  assert.equal(anchorSpacer(600, 600), 0)
  assert.equal(anchorSpacer(600, 900), 0)
  assert.equal(anchorSpacer(600.7, 150), 450)
})

test("following chases only overflowing growth", () => {
  const following = { following: true }
  assert.equal(shouldFollow(following, 400, 700, 600), true)
  assert.equal(shouldFollow(following, 400, 500, 600), false, "under the viewport: the anchor holds")
  assert.equal(shouldFollow(following, 700, 650, 600), false, "shrinking content never moves the view")
  assert.equal(shouldFollow(following, 700, 700, 600), false, "unchanged content never moves the view")
  assert.equal(shouldFollow({ following: false }, 400, 700, 600), false, "a scrolled-away viewport is not followed")
})

test("scroll behavior respects reduced motion", () => {
  assert.equal(scrollBehavior(true), "auto")
  assert.equal(scrollBehavior(false), "smooth")
})
