import assert from "node:assert/strict"
import { test } from "node:test"
import {
  ALL_RETRIEVAL_CHANNELS,
  validateChannelSelection,
  type RetrievalChannel,
} from "./interface"

test("ALL_RETRIEVAL_CHANNELS lists all four retrieval channels", () => {
  assert.deepEqual([...ALL_RETRIEVAL_CHANNELS], ["vector", "bm25", "graph", "pageIndex"])
})

test("validateChannelSelection(undefined) returns all four channels (backward compat)", () => {
  const result = validateChannelSelection(undefined)
  assert.deepEqual(result, ["vector", "bm25", "graph", "pageIndex"])
})

test("validateChannelSelection(['vector']) returns single-channel subset", () => {
  assert.deepEqual(validateChannelSelection(["vector"]), ["vector"])
})

test("validateChannelSelection(['vector', 'bm25']) returns multi-channel subset", () => {
  assert.deepEqual(validateChannelSelection(["vector", "bm25"]), ["vector", "bm25"])
})

test("validateChannelSelection(['vector', 'bm25', 'graph', 'pageIndex']) returns all four (explicit all)", () => {
  assert.deepEqual(
    validateChannelSelection(["vector", "bm25", "graph", "pageIndex"]),
    ["vector", "bm25", "graph", "pageIndex"]
  )
})

test("validateChannelSelection([]) throws 'at least one retrieval channel must be selected'", () => {
  assert.throws(
    () => validateChannelSelection([]),
    { message: "at least one retrieval channel must be selected" }
  )
})

test("validateChannelSelection(['unknown']) throws 'unknown retrieval channel: unknown'", () => {
  assert.throws(
    () => validateChannelSelection(["unknown" as RetrievalChannel]),
    { message: "unknown retrieval channel: unknown" }
  )
})

test("validateChannelSelection(['vector', 'vector']) dedupes to ['vector']", () => {
  assert.deepEqual(validateChannelSelection(["vector", "vector"]), ["vector"])
})

test("validateChannelSelection(['vector', 'bm25', 'vector']) dedupes preserving caller order", () => {
  assert.deepEqual(
    validateChannelSelection(["vector", "bm25", "vector"]),
    ["vector", "bm25"]
  )
})

test("validateChannelSelection returns a mutable array (not the readonly const)", () => {
  const result = validateChannelSelection(undefined)
  result.push("vector")
  // The const should be unaffected by caller mutations
  assert.deepEqual([...ALL_RETRIEVAL_CHANNELS], ["vector", "bm25", "graph", "pageIndex"])
})
