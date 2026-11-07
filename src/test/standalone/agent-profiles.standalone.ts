import * as assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"

import {
  AGENT_GLYPHS,
  AGENT_STARTUP_SELECTION_SETTING,
  agentGlyphState,
  discoverAgentFileNames,
  isRememberedAgentSource,
  nextAgentSelection,
  normalizeAgentSelection,
  normalizeAgentStartupSelection,
  resolveAgentSelection,
  resolveStartupAgentSelection,
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

test("startup selection accepts off, default and lastUsed, and anything else means Default Agent", () => {
  assert.strictEqual(normalizeAgentStartupSelection("off"), "off")
  assert.strictEqual(normalizeAgentStartupSelection("default"), "default")
  assert.strictEqual(normalizeAgentStartupSelection("lastUsed"), "lastUsed")
  assert.strictEqual(normalizeAgentStartupSelection(undefined), "default")
  assert.strictEqual(normalizeAgentStartupSelection(""), "default")
  assert.strictEqual(normalizeAgentStartupSelection("custom-a"), "default")
  assert.strictEqual(normalizeAgentStartupSelection(true), "default")
})

test("startup off and default start a new chat from the preference, ignoring the remembered profile", () => {
  const available = new Set(["custom-a"])
  assert.strictEqual(resolveStartupAgentSelection("off", "custom-a", available), "off")
  assert.strictEqual(resolveStartupAgentSelection("default", "custom-a", available), "default")
  assert.strictEqual(resolveStartupAgentSelection("default", undefined, available), "default")
})

test("last used restores an enabled custom profile", () => {
  assert.strictEqual(resolveStartupAgentSelection("lastUsed", "custom-a", new Set(["custom-a"])), "custom-a")
  assert.strictEqual(resolveStartupAgentSelection("lastUsed", "default", new Set()), "default")
})

test("last used falls back to Default Agent when the profile is missing or disabled, or nothing is remembered", () => {
  const enabledProfiles = new Set(["custom-a"])
  assert.strictEqual(resolveStartupAgentSelection("lastUsed", "removed-agent", enabledProfiles), "default")
  assert.strictEqual(resolveStartupAgentSelection("lastUsed", "disabled-agent", new Set(["other"])), "default")
  assert.strictEqual(resolveStartupAgentSelection("lastUsed", undefined, enabledProfiles), "default")
  assert.strictEqual(resolveStartupAgentSelection("lastUsed", "", enabledProfiles), "default")
  assert.strictEqual(resolveStartupAgentSelection("lastUsed", 42, enabledProfiles), "default")
})

test("last used never restores Off, since Off is not remembered as a last-used profile", () => {
  assert.strictEqual(resolveStartupAgentSelection("lastUsed", "off", new Set(["custom-a"])), "default")
})

test("only explicit dropdown and Shift+Tab choices count as last used", () => {
  assert.strictEqual(isRememberedAgentSource("dropdown"), true)
  assert.strictEqual(isRememberedAgentSource("shift-tab"), true)
  for (const source of ["startup", "new-conversation", "history-restore", "legacy-migration", "storage-sync"]) {
    assert.strictEqual(isRememberedAgentSource(source), false, `${source} must not change the last-used profile`)
  }
})

test("resolving an explicit request or stored selection never consults the startup preference", () => {
  assert.strictEqual(resolveAgentSelection("off", "custom-a", "default"), "off")
  assert.strictEqual(resolveAgentSelection(undefined, "custom-a", "default"), "custom-a")
  assert.strictEqual(resolveAgentSelection(undefined, undefined, "default"), "default")
  assert.strictEqual(normalizeAgentSelection("custom-a"), "custom-a")
  assert.strictEqual(normalizeAgentSelection("invalid"), "invalid")
})

test("Shift+Tab toggles Off and back to the last-used profile, or Default when it is gone", () => {
  const available = new Set(["custom-a"])
  const turnedOff = nextAgentSelection("custom-a", "custom-a", available)
  assert.strictEqual(turnedOff, "off")
  assert.strictEqual(nextAgentSelection(turnedOff, "custom-a", available), "custom-a")
  assert.strictEqual(nextAgentSelection("off", "removed-agent", available), "default")
  assert.strictEqual(nextAgentSelection("default", "default", available), "off")
  assert.strictEqual(nextAgentSelection("off", "default", available), "default")
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

test("agent glyph precedence keeps blocked and failed states visible and celebrates only when idle", () => {
  const idle = { enabled: true, toolsRunning: false, toolsWaiting: false, toolFailed: false, feedbackPlanning: false, feedbackFailed: false, todoBlocked: false, generating: false }
  assert.equal(agentGlyphState(idle), "ready")
  assert.equal(agentGlyphState({ ...idle, enabled: false, toolFailed: true }), "off")
  assert.equal(agentGlyphState({ ...idle, generating: true, todoBlocked: true, toolsRunning: true }), "blocked")
  assert.equal(agentGlyphState({ ...idle, feedbackFailed: true, feedbackPlanning: true }), "blocked")
  assert.equal(agentGlyphState({ ...idle, toolFailed: true, generating: true }), "blocked")
  assert.equal(agentGlyphState({ ...idle, toolsWaiting: true, toolsRunning: true }), "waiting")
  assert.equal(agentGlyphState({ ...idle, toolsRunning: true, feedbackPlanning: true, generating: true }), "tools")
  assert.equal(agentGlyphState({ ...idle, feedbackPlanning: true, generating: true }), "verifying")
  assert.equal(agentGlyphState({ ...idle, generating: true }), "thinking")
  assert.equal(agentGlyphState({ ...idle, celebration: "complete" }), "complete")
  assert.equal(agentGlyphState({ ...idle, celebration: "milestone", generating: true }), "thinking")
  assert.equal(agentGlyphState({ ...idle, celebration: "milestone", todoBlocked: true }), "blocked")
})

test("agent glyph table gives every state one distinct glyph and a label", () => {
  const entries = Object.entries(AGENT_GLYPHS)
  assert.equal(entries.length, 9)
  assert.equal(new Set(entries.map(([, value]) => value.glyph)).size, entries.length)
  for (const [, value] of entries) assert.ok(value.label.length > 0)
  assert.equal(AGENT_GLYPHS.complete.glyph, "🎉")
  assert.equal(AGENT_GLYPHS.milestone.glyph, "🎆")
})

test("agent glyph animations are disabled for reduced motion", () => {
  const styles = fs.readFileSync(path.resolve(__dirname, "../../../src/webview/styles/chat.module.css"), "utf8")
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\) \{\s*\.agentGlyph \{\s*animation: none !important;/)
  assert.match(styles, /\.agentGlyph\[data-state="complete"\]/)
})

test("agents settings schema defaults new profiles to Off and provides registration fields", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../package.json"), "utf8")) as { contributes: { configuration: { properties: Record<string, { default?: unknown; properties?: Record<string, unknown> }> } } }
  const schema = packageJson.contributes.configuration.properties["twinny.agents"]
  assert.deepStrictEqual(schema.default, { autoDiscover: true, searchPaths: [], definitions: [], excludedPaths: [] })
  assert.ok(schema.properties?.definitions)
  assert.ok(schema.properties?.searchPaths)
  assert.ok(schema.properties?.autoDiscover)
  assert.ok(schema.properties?.excludedPaths)
})

test("startupSelection is a flat setting with off, default and lastUsed, defaulting to default", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../package.json"), "utf8")) as { contributes: { configuration: { properties: Record<string, { type?: string; enum?: string[]; default?: unknown; scope?: string; deprecationMessage?: string }> } } }
  const properties = packageJson.contributes.configuration.properties
  const startup = properties[`twinny.${AGENT_STARTUP_SELECTION_SETTING}`]
  assert.ok(startup, "twinny.agents.startupSelection must be registered as its own setting")
  assert.strictEqual(startup.type, "string")
  assert.deepStrictEqual(startup.enum, ["off", "default", "lastUsed"])
  assert.strictEqual(startup.default, "default")
  assert.strictEqual(startup.scope, "resource")
  const legacy = properties["twinny.agents"] as unknown as { properties: Record<string, { deprecationMessage?: string }> }
  assert.match(legacy.properties.defaultSelection.deprecationMessage ?? "", /startupSelection/)
})
