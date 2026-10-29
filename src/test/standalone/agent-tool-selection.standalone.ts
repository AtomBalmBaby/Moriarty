import * as assert from "node:assert/strict"
import { test } from "node:test"

import { agentToolSelectionDiagnostic, resolveAgentToolSelection } from "../../extension/agents/tool-selection"

const native = ["read_file", "list_dir", "grep", "edit_file", "run_command"].map((name) => ({ name }))
const mcp = [
  { server: "ha-mcp", tool: "search" },
  { server: "ha-mcp", tool: "status" }
]

test("an omitted tools declaration preserves all eligible native and MCP tools", () => {
  const resolved = resolveAgentToolSelection(undefined, native, mcp)
  assert.equal(resolved.explicit, false)
  assert.deepEqual(resolved.native, native)
  assert.deepEqual(resolved.mcp, mcp)
  assert.deepEqual(resolved.unmatched, [])
})

test("Copilot categories and built-in aliases resolve to Twinny native tools", () => {
  const resolved = resolveAgentToolSelection(["Read", "vscode/readFile"], native, mcp)
  assert.deepEqual(resolved.native.map((tool) => tool.name), ["read_file", "list_dir", "grep"])
  assert.deepEqual(resolved.mcp, [])
  assert.deepEqual(resolved.unmatched, [])

  const searchableNative = [...native.map((tool) => tool.name), "search_code", "find_files", "find_symbol", "find_references"].map((name) => ({ name }))
  const search = resolveAgentToolSelection(["Search"], searchableNative, mcp)
  assert.deepEqual(search.native.map((tool) => tool.name), ["grep", "search_code", "find_files", "find_symbol", "find_references"])
  assert.deepEqual(search.mcp, [], "Copilot Search should not implicitly grant an MCP tool with the same short name")
})

test("MCP names match by qualified server/tool name without granting native tools", () => {
  const resolved = resolveAgentToolSelection(["ha-mcp/search"], native, mcp)
  assert.deepEqual(resolved.native, [])
  assert.deepEqual(resolved.mcp.map((tool) => tool.tool), ["search"])
  assert.deepEqual(resolved.unmatched, [])
})

test("explicit restrictive and empty declarations never expand to available tools", () => {
  const restricted = resolveAgentToolSelection(["read_file", "vscode/webSearch"], native, mcp)
  assert.deepEqual(restricted.native.map((tool) => tool.name), ["read_file"])
  assert.deepEqual(restricted.mcp, [])
  assert.deepEqual(restricted.unmatched, ["vscode/webSearch"])

  const empty = resolveAgentToolSelection([], native, mcp)
  assert.equal(empty.explicit, true)
  assert.deepEqual(empty.native, [])
  assert.deepEqual(empty.mcp, [])
  assert.match(agentToolSelectionDiagnostic([], [], native.map((tool) => tool.name), 0), /explicitly declares an empty tools list/)
})
