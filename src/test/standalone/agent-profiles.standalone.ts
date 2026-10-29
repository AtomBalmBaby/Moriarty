import * as assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"

import {
  discoverAgentFileNames,
  nextAgentSelection,
  normalizeAgentSelection,
  resolveAgentSelection,
  selectionFromLegacyAgentMode,
  withAgentSelection
} from "../../common/agents"
import { parseAgentProfile } from "../../extension/agents/profile"
import { composeAgentPrompt } from "../../extension/agents/prompt"
import { McpHost } from "../../extension/chat/mcp-host"

const profile = (frontmatter: string, body = "Profile instructions.") => `---\n${frontmatter}\n---\n${body}`

test("parses Copilot-compatible agent frontmatter and preserves unknown fields as warnings", () => {
  const parsed = parseAgentProfile(profile([
    "name: LCARS Developer",
    "description: Build the dashboard",
    "tools: [read, edit, ha-mcp/*]",
    "model: coder-model",
    "user-invocable: true",
    "disable-model-invocation: false",
    "mcp-servers: [ha-mcp]",
    "handoffs: []"
  ].join("\n")), "/workspace/lcars.agent.md")
  assert.strictEqual(parsed.name, "LCARS Developer")
  assert.deepStrictEqual(parsed.tools, ["read", "edit", "ha-mcp/*"])
  assert.deepStrictEqual(parsed.mcpServers, ["ha-mcp"])
  assert.strictEqual(parsed.model, "coder-model")
  assert.strictEqual(parsed.userInvocable, true)
  assert.strictEqual(parsed.disableModelInvocation, false)
  assert.deepStrictEqual(parsed.unsupportedFields, ["handoffs"])
  assert.deepStrictEqual(parsed.frontmatter.handoffs, [])
  assert.strictEqual(parsed.instructions, "Profile instructions.")
  const referenced = parseAgentProfile(profile("mcp-servers:\n  trusted:\n    command: never-run\n    args: [untrusted]"), "/workspace/safe.agent.md")
  assert.deepStrictEqual(referenced.mcpServers, ["trusted"])
  const serverReference = referenced.frontmatter["mcp-servers"] as Record<string, unknown>
  const serverConfiguration = serverReference.trusted as Record<string, unknown>
  assert.strictEqual(serverConfiguration.command, "never-run")
})

test("rejects malformed or wrongly typed metadata without injecting a partial body", () => {
  assert.throws(() => parseAgentProfile("---\nname: [\n---\nunsafe", "/x/bad.agent.md"), /Invalid YAML frontmatter/)
  assert.throws(() => parseAgentProfile(profile("tools: read"), "/x/bad.agent.md"), /tools.*list/)
  assert.throws(() => parseAgentProfile("Body only", "/x/bad.agent.md"), /frontmatter/)
  assert.throws(() => parseAgentProfile(profile("name: Not selectable"), "/x/AGENTS.md"), /end in/)
  const fallback = parseAgentProfile(profile("description: no explicit name"), "/x/code-review.agent.md")
  assert.strictEqual(fallback.name, "code-review")
})

test("discovers only .agent.md files and does not treat AGENTS.md as a selectable profile", () => {
  assert.deepStrictEqual(discoverAgentFileNames([
    ["AGENTS.md", true],
    ["review.agent.md", true],
    ["not-agent.md", true],
    ["directory.agent.md", false]
  ]), ["review.agent.md"])
})

test("migrates the old boolean and Shift+Tab selects only Off or an enabled profile", () => {
  assert.strictEqual(selectionFromLegacyAgentMode(true), "default")
  assert.strictEqual(selectionFromLegacyAgentMode(false), "off")
  assert.strictEqual(selectionFromLegacyAgentMode(undefined), undefined)
  assert.strictEqual(resolveAgentSelection("off", undefined, "default", false, "off"), "default")
  assert.strictEqual(resolveAgentSelection("off", undefined, undefined, false, "off"), "off")
  assert.strictEqual(resolveAgentSelection(undefined, undefined, undefined, false, "default"), "default")
  assert.strictEqual(normalizeAgentSelection("custom-a"), "custom-a")
  assert.strictEqual(normalizeAgentSelection("invalid"), "invalid")
  const available = new Set(["custom-a"])
  const turnedOff = nextAgentSelection("custom-a", "custom-a", available)
  assert.strictEqual(turnedOff, "off")
  assert.strictEqual(nextAgentSelection(turnedOff, "custom-a", available), "custom-a")
  assert.strictEqual(nextAgentSelection("off", "removed-agent", available), "default")
})

test("chat payloads carry the exact Off, Default or custom profile selection", () => {
  const base = { messages: [{ role: "user", content: "hello" }], mentions: [], conversationId: "chat-1" }
  assert.deepStrictEqual(withAgentSelection(base, "off"), { ...base, agentSelection: "off" })
  assert.deepStrictEqual(withAgentSelection(base, "default"), { ...base, agentSelection: "default" })
  assert.deepStrictEqual(withAgentSelection(base, "lcars-developer"), { ...base, agentSelection: "lcars-developer" })
})

test("custom prompt instructions and workspace context are included once, with missing MCP reported", () => {
  const prompt = composeAgentPrompt("Helpful Assistant", "Use the LCARS style.", "Workspace root: file:///workspace", ["ha-mcp (disabled)"])
  assert.strictEqual(prompt.split("Use the LCARS style.").length - 1, 1)
  assert.strictEqual(prompt.split("Workspace root:").length - 1, 1)
  assert.match(prompt, /Helpful Assistant/)
  assert.match(prompt, /ha-mcp \(disabled\)/)
  const offPrompt = composeAgentPrompt("Helpful Assistant", "", "", [])
  assert.strictEqual(offPrompt, "Helpful Assistant")
})

test("MCP startup is scoped to the selected server and cannot leak a neighboring server tool", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-agent-mcp-"))
  const fake = { command: process.execPath, args: [path.join(__dirname, "..", "suite", "support", "fake-mcp-server.js")] }
  const host = new McpHost(() => ({ first: fake, second: fake }), () => root)
  try {
    const firstTools = await host.ready(["first"])
    assert.ok(firstTools.length > 0)
    assert.ok(firstTools.every((tool) => tool.server === "first"))
    assert.deepStrictEqual(host.toolsFor(["second"]), [])
    const secondTools = await host.ready(["second"])
    assert.ok(secondTools.length > 0)
    assert.ok(secondTools.every((tool) => tool.server === "second"))
    assert.ok(host.toolsFor(["first"]).length > 0, "switching profiles reuses, rather than kills, shared connections")
    let approvalCalls = 0
    const sink = host.sink(async () => { approvalCalls++; return true }, () => false, firstTools)
    const rejected = await sink.call(secondTools[0], {}, undefined)
    assert.strictEqual(rejected.failed, true)
    assert.match(rejected.output, /not permitted/)
    assert.strictEqual(approvalCalls, 0)
  } finally {
    host.dispose()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("missing, disabled and invalid MCP servers do not produce invented tools", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-agent-mcp-error-"))
  const host = new McpHost(() => ({
    disabled: { command: process.execPath, enabled: false },
    invalid: { args: ["no-command"] },
    unavailable: { command: process.execPath, args: ["/path/that/does/not/exist/twinny-mcp-server.js"] }
  }), () => root, { startMs: 1_000 })
  try {
    assert.deepStrictEqual(await host.ready(["disabled", "missing", "invalid"]), [])
    assert.deepStrictEqual(await host.ready(["unavailable"]), [])
    assert.deepStrictEqual(host.tools, [])
  } finally {
    host.dispose()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("compiled webview exposes one interactive agent selector and its management UI", () => {
  const bundlePath = path.resolve(__dirname, "../../sidebar.js")
  const bundle = fs.readFileSync(bundlePath, "utf8")
  const controlIndex = bundle.indexOf("\"aria-label\": \"Select chat agent\"")
  assert.notStrictEqual(controlIndex, -1)
  assert.strictEqual(bundle.split("\"aria-label\": \"Select chat agent\"").length - 1, 1)
  const control = bundle.slice(controlIndex - 450, controlIndex + 5000)
  assert.match(control, /"button"/)
  assert.match(control, /"aria-haspopup": "menu"/)
  assert.match(control, /"aria-expanded": agentMenuOpen/)
  assert.doesNotMatch(control.slice(0, control.indexOf("children:")), /disabled:/)
  assert.match(control, /setAgentMenuOpen/)
  assert.match(control, /setAgentSettingsOpen\(true\)/)
  assert.match(bundle, /role: "menu"/)
  assert.match(bundle, /Agent off/)
  assert.match(bundle, /Default Agent/)
  assert.match(bundle, /\+ Manage Agents/)
  assert.match(bundle, /Agent settings/)
  assert.doesNotMatch(bundle, /__manage_agents__/)
  assert.match(bundle, /Additional discovery directories/)
  assert.match(bundle, /Excluded profile files/)
  const settingsStyles = fs.readFileSync(path.resolve(__dirname, "../../../src/webview/styles/agent-settings.module.css"), "utf8")
  assert.match(settingsStyles, /\.agentsSection\s*\{[^}]*overflow: visible;/)
  assert.match(settingsStyles, /\.agentAddForm\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\);/)
})

test("agents settings schema defaults new profiles to Off and provides registration fields", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../package.json"), "utf8")) as { contributes: { configuration: { properties: Record<string, { default?: unknown; properties?: Record<string, unknown> }> } } }
  const schema = packageJson.contributes.configuration.properties["twinny.agents"]
  assert.deepStrictEqual(schema.default, { defaultSelection: "off", autoDiscover: true, searchPaths: [], definitions: [], excludedPaths: [] })
  assert.ok(schema.properties?.definitions)
  assert.ok(schema.properties?.searchPaths)
  assert.ok(schema.properties?.defaultSelection)
  assert.ok(schema.properties?.autoDiscover)
  assert.ok(schema.properties?.excludedPaths)
})
