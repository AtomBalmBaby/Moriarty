import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"

import {
  ConfigurationReader,
  FEEDBACK_ENABLED_KEY,
  findProviderBySelection,
  isFeedbackEnabled,
  isPromptCompilerEnabled,
  LEGACY_SETTING_KEYS,
  planSettingMigrations,
  PROMPT_COMPILER_ENABLED_KEY,
  PROMPT_COMPILER_INSTRUCTIONS_MODE_KEY,
  PROMPT_COMPILER_MAX_TURNS_KEY,
  promptCompilerMaxTurns,
  readSettingWithLegacy,
  RETIRED_SETTING_KEYS,
  SettingInspection
} from "../../common/feedback-settings"

type Scoped = Record<string, SettingInspection<unknown>>

/** A VS Code configuration with per-scope user values and contributed defaults. */
const config = (values: Scoped, defaults: Record<string, unknown> = {}): ConfigurationReader => ({
  get: <T>(key: string) => {
    const scoped = values[key]
    return (scoped?.workspaceFolderValue ?? scoped?.workspaceValue ?? scoped?.globalValue ?? defaults[key]) as T | undefined
  },
  inspect: <T>(key: string) => values[key] as SettingInspection<T> | undefined
})

const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
  contributes: { configuration: { properties: Record<string, Record<string, unknown>> } }
}
const properties = manifest.contributes.configuration.properties

test("new users get Feedback on and the Prompt Compiler off", () => {
  const empty = config({})
  assert.equal(isFeedbackEnabled(empty), true)
  assert.equal(isPromptCompilerEnabled(empty), false)
  assert.equal(promptCompilerMaxTurns(empty), 3)
})

test("explicit legacy values keep working; the new key wins when both are set", () => {
  assert.equal(isPromptCompilerEnabled(config({ chatToolsIntentCompilerEnabled: { globalValue: true } })), true)
  assert.equal(isFeedbackEnabled(config({ chatToolsFeedbackEvaluatorEnabled: { workspaceValue: false } })), false)
  assert.equal(isPromptCompilerEnabled(config({
    chatToolsIntentCompilerEnabled: { workspaceValue: true },
    [PROMPT_COMPILER_ENABLED_KEY]: { globalValue: false }
  })), false)
  assert.equal(promptCompilerMaxTurns(config({ chatToolsIntentCompilerMaxLevels: { globalValue: 42 } })), 10, "clamped")
  assert.equal(readSettingWithLegacy(config({ intentBaseInstructionsMode: { globalValue: "none" } }), PROMPT_COMPILER_INSTRUCTIONS_MODE_KEY), "none")
})

test("a legacy automatic compiler mode never enables or triggers compilation", () => {
  for (const mode of ["always-refined", "ask", "always-original"]) {
    const legacy = config({ chatToolsIntentCompilerMode: { globalValue: mode } })
    assert.equal(isPromptCompilerEnabled(legacy), false, mode)
    assert.deepEqual(planSettingMigrations(legacy), [], mode)
  }
  assert.deepEqual([...RETIRED_SETTING_KEYS], ["chatToolsIntentCompilerMode"])
  assert.ok(!Object.values(LEGACY_SETTING_KEYS).flat().includes("chatToolsIntentCompilerMode"))
})

test("migration copies only explicit legacy values, at their own scope, without overwriting new keys", () => {
  const migrations = planSettingMigrations(config({
    chatToolsIntentCompilerEnabled: { globalValue: true, workspaceValue: false },
    [PROMPT_COMPILER_ENABLED_KEY]: { workspaceValue: true },
    chatToolsFeedbackEvaluatorEnabled: { workspaceFolderValue: false },
    chatToolsIntentCompilerMaxTurns: { globalValue: 5 },
    chatToolsIntentCompilerMaxLevels: { globalValue: 7 }
  }))
  assert.deepEqual(migrations.sort((a, b) => (a.key + a.scope).localeCompare(b.key + b.scope)), [
    { key: FEEDBACK_ENABLED_KEY, value: false, scope: "workspaceFolder", from: "chatToolsFeedbackEvaluatorEnabled" },
    { key: PROMPT_COMPILER_ENABLED_KEY, value: true, scope: "global", from: "chatToolsIntentCompilerEnabled" },
    { key: PROMPT_COMPILER_MAX_TURNS_KEY, value: 5, scope: "global", from: "chatToolsIntentCompilerMaxTurns" }
  ])
  assert.deepEqual(planSettingMigrations(config({}, { chatToolsIntentCompilerEnabled: false })), [], "defaults are never copied")
})

test("role providers are found by ID, then by label, and never guessed", () => {
  const providers = [
    { id: "a1", label: "Local llama" },
    { id: "b2", label: "Cloud" }
  ]
  assert.equal(findProviderBySelection(providers, "b2")?.label, "Cloud")
  assert.equal(findProviderBySelection(providers, " local LLAMA ")?.id, "a1")
  assert.equal(findProviderBySelection(providers, "missing"), undefined)
  assert.equal(findProviderBySelection(providers, ""), undefined)
})

test("Feedback and Prompt Compiler settings are contributed to the VS Code Settings UI", () => {
  const expected: Record<string, { type: string; default: unknown }> = {
    "twinny.feedback.enabled": { type: "boolean", default: true },
    "twinny.feedback.provider": { type: "string", default: "" },
    "twinny.feedback.model": { type: "string", default: "" },
    "twinny.promptCompiler.enabled": { type: "boolean", default: false },
    "twinny.promptCompiler.provider": { type: "string", default: "" },
    "twinny.promptCompiler.model": { type: "string", default: "" },
    "twinny.promptCompiler.maxTurns": { type: "integer", default: 3 },
    "twinny.promptCompiler.trace": { type: "boolean", default: false }
  }
  for (const [key, { type, default: fallback }] of Object.entries(expected)) {
    const property = properties[key]
    assert.ok(property, key + " is contributed")
    assert.equal(property.type, type, key)
    assert.deepEqual(property.default, fallback, key)
    assert.ok(property.markdownDescription || property.description, key + " is described")
    assert.ok(!property.deprecationMessage && !property.markdownDeprecationMessage, key + " is current")
  }
  assert.ok(properties["twinny.promptCompiler.baseInstructionsMode"])
  assert.ok(properties["twinny.promptCompiler.baseInstructionsFile"])
  assert.match(String(properties["twinny.promptCompiler.enabled"].markdownDescription ?? properties["twinny.promptCompiler.enabled"].description), /Click/)
})

test("legacy Intent settings stay registered only as deprecated", () => {
  const legacy = [...new Set([...Object.values(LEGACY_SETTING_KEYS).flat(), ...RETIRED_SETTING_KEYS])]
    .filter((key) => properties["twinny." + key])
  assert.ok(legacy.includes("chatToolsIntentCompilerEnabled"))
  assert.ok(legacy.includes("chatToolsIntentCompilerMode"))
  for (const key of legacy) {
    const property = properties["twinny." + key]
    assert.ok(property.markdownDeprecationMessage || property.deprecationMessage, key + " is deprecated")
  }
})
