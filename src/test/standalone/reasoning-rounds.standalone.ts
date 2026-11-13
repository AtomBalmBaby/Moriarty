import assert from "node:assert/strict"
import { test } from "node:test"

import {
  activeReasoningId,
  appendReasoning,
  closeReasoning,
  LiveReasoningRound,
  mergeReasoningRounds,
  nextActivityOrder,
  toReasoningViews
} from "../../webview/reasoning-rounds"

test("activity order only grows, so a later arrival always sorts after an earlier one", () => {
  const first = nextActivityOrder()
  const second = nextActivityOrder()
  assert.ok(second > first)
})

const stream = (chunks: Array<[string, string]>, start = 0) =>
  chunks.reduce<LiveReasoningRound[]>(
    (rounds, [round, text], index) => appendReasoning(rounds, round, text, start + index * 10),
    []
  )

test("streamed text accumulates in order within one round", () => {
  const rounds = stream([
    ["a:0", "First "],
    ["a:0", "then more"]
  ])
  assert.equal(rounds.length, 1)
  assert.equal(rounds[0].text, "First then more")
  assert.equal(rounds[0].complete, false)
  assert.equal(activeReasoningId(rounds), "a:0")
})

test("a new round closes the previous one as complete and starts another", () => {
  const rounds = stream([
    ["a:0", "thinking"],
    ["a:1", "again"]
  ])
  assert.deepEqual(
    rounds.map((item) => [item.id, item.complete]),
    [
      ["a:0", true],
      ["a:1", false]
    ]
  )
  assert.equal(activeReasoningId(rounds), "a:1")
})

test("late text for a closed round does not reopen or extend it", () => {
  const rounds = stream([
    ["a:0", "done"],
    ["a:1", "next"],
    ["a:0", " late"]
  ])
  assert.equal(rounds[0].text, "done")
  assert.equal(rounds[0].complete, true)
})

test("completion ends the active round and reports its duration", () => {
  const rounds = closeReasoning(stream([["a:0", "think"]], 1000), true, 4500)
  assert.equal(activeReasoningId(rounds), undefined)
  assert.deepEqual(toReasoningViews(rounds), [{ id: "a:0", text: "think", complete: true, durationMs: 3500 }])
})

test("an interrupted round keeps its text but has no duration", () => {
  const rounds = closeReasoning(stream([["a:0", "partial"]], 1000), false, 4500)
  assert.deepEqual(toReasoningViews(rounds), [{ id: "a:0", text: "partial", complete: false }])
})

test("rounds without text are dropped rather than shown as empty blocks", () => {
  const rounds = stream([
    ["a:0", "   "],
    ["a:1", "real"]
  ])
  assert.deepEqual(
    toReasoningViews(rounds).map((item) => item.id),
    ["a:1"]
  )
  assert.deepEqual(toReasoningViews(stream([])), [])
})

test("a round keeps where it opened and its order into the reply's view", () => {
  const rounds = appendReasoning([], "a:0", "think", 0, () => ({ at: 0, order: 1 }))
  const later = appendReasoning(rounds, "a:1", "more", 10, () => ({ at: 9, order: 3 }))
  assert.deepEqual(toReasoningViews(closeReasoning(later, true, 20)), [
    { id: "a:0", text: "think", complete: true, durationMs: 10, at: 0, order: 1 },
    { id: "a:1", text: "more", complete: true, durationMs: 10, at: 9, order: 3 }
  ])
})

test("a round's place is read once, when it opens, and not for its later text", () => {
  let reads = 0
  const place = () => {
    reads += 1
    return { at: 0, order: reads }
  }
  const rounds = appendReasoning([], "a:0", "one ", 0, place)
  appendReasoning(rounds, "a:0", "two", 1, place)
  assert.equal(reads, 1)
})

test("rounds opened without a place carry none, as saved replies always did", () => {
  assert.deepEqual(toReasoningViews(closeReasoning(stream([["a:0", "think"]], 0), true, 5)), [
    { id: "a:0", text: "think", complete: true, durationMs: 5 }
  ])
})

test("merging keeps earlier rounds and does not count a repeated round twice", () => {
  const earlier = [{ id: "a:0", text: "one", complete: true, durationMs: 5 }]
  const later = [
    { id: "a:0", text: "one", complete: true, durationMs: 5 },
    { id: "b:0", text: "two", complete: false }
  ]
  assert.deepEqual(mergeReasoningRounds(earlier, later), later)
  assert.equal(mergeReasoningRounds(undefined, undefined), undefined)
  assert.deepEqual(mergeReasoningRounds(earlier, undefined), earlier)
  assert.deepEqual(mergeReasoningRounds(undefined, later), later)
})
