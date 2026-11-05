/**
 * Feedback (TODO planning, progress tracking, evaluation and reconciliation)
 * and the Prompt Compiler (explicit draft rewriting) are configured
 * independently. Both replace the legacy "Intent" settings, which are still
 * read when the new keys are unset so existing users keep their choices.
 *
 * The legacy `chatToolsIntentCompilerMode` is intentionally never read: the
 * compiler only runs when the user asks for it, so no old value can make it
 * run automatically.
 */

export const FEEDBACK_ENABLED_KEY = "feedback.enabled"
export const FEEDBACK_PROVIDER_KEY = "feedback.provider"
export const FEEDBACK_MODEL_KEY = "feedback.model"

export const PROMPT_COMPILER_ENABLED_KEY = "promptCompiler.enabled"
export const PROMPT_COMPILER_PROVIDER_KEY = "promptCompiler.provider"
export const PROMPT_COMPILER_MODEL_KEY = "promptCompiler.model"
export const PROMPT_COMPILER_MAX_TURNS_KEY = "promptCompiler.maxTurns"
export const PROMPT_COMPILER_TRACE_KEY = "promptCompiler.trace"
export const PROMPT_COMPILER_INSTRUCTIONS_MODE_KEY = "promptCompiler.baseInstructionsMode"
export const PROMPT_COMPILER_INSTRUCTIONS_FILE_KEY = "promptCompiler.baseInstructionsFile"

/** Each current key and the legacy keys it replaces, newest first. */
export const LEGACY_SETTING_KEYS: Readonly<Record<string, readonly string[]>> = {
  [FEEDBACK_ENABLED_KEY]: ["chatToolsFeedbackEvaluatorEnabled"],
  [PROMPT_COMPILER_ENABLED_KEY]: ["chatToolsIntentCompilerEnabled"],
  [PROMPT_COMPILER_MAX_TURNS_KEY]: ["chatToolsIntentCompilerMaxTurns", "chatToolsIntentCompilerMaxLevels"],
  [PROMPT_COMPILER_TRACE_KEY]: ["chatToolsIntentCompilerTrace"],
  [PROMPT_COMPILER_INSTRUCTIONS_MODE_KEY]: ["intentBaseInstructionsMode"],
  [PROMPT_COMPILER_INSTRUCTIONS_FILE_KEY]: ["intentBaseInstructionsFile"]
}

/** Never migrated or read: automatic compilation is no longer supported. */
export const RETIRED_SETTING_KEYS = ["chatToolsIntentCompilerMode"] as const

export type SettingScope = "global" | "workspace" | "workspaceFolder"

export interface SettingInspection<T> {
  globalValue?: T
  workspaceValue?: T
  workspaceFolderValue?: T
}

/** The parts of `vscode.WorkspaceConfiguration` these helpers need. */
export interface ConfigurationReader {
  get<T>(key: string): T | undefined
  inspect<T>(key: string): SettingInspection<T> | undefined
}

const SCOPES: Array<[SettingScope, keyof SettingInspection<unknown>]> = [
  ["workspaceFolder", "workspaceFolderValue"],
  ["workspace", "workspaceValue"],
  ["global", "globalValue"]
]

/** The user-set value of `key` at its most specific scope, ignoring defaults. */
export const explicitSetting = <T>(config: ConfigurationReader, key: string): T | undefined => {
  const inspection = config.inspect<T>(key)
  if (!inspection) return undefined
  for (const [, field] of SCOPES) {
    const value = inspection[field] as T | undefined
    if (value !== undefined) return value
  }
  return undefined
}

/**
 * The current key when the user set it, else the first legacy key the user
 * set, else `fallback`. Values failing `valid` are ignored.
 */
export const readCompatibleSetting = <T>(
  config: ConfigurationReader,
  key: string,
  fallback: T,
  valid: (value: unknown) => value is T
): T => {
  for (const candidate of [key, ...(LEGACY_SETTING_KEYS[key] ?? [])]) {
    const value = explicitSetting<unknown>(config, candidate)
    if (valid(value)) return value
  }
  return fallback
}

const isBoolean = (value: unknown): value is boolean => typeof value === "boolean"
const isString = (value: unknown): value is string => typeof value === "string"
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)

export const isFeedbackEnabled = (config: ConfigurationReader): boolean =>
  readCompatibleSetting(config, FEEDBACK_ENABLED_KEY, true, isBoolean)

/** A capability toggle only: it never makes the compiler run by itself. */
export const isPromptCompilerEnabled = (config: ConfigurationReader): boolean =>
  readCompatibleSetting(config, PROMPT_COMPILER_ENABLED_KEY, false, isBoolean)

export const promptCompilerMaxTurns = (config: ConfigurationReader, fallback = 3): number => {
  const value = readCompatibleSetting(config, PROMPT_COMPILER_MAX_TURNS_KEY, fallback, isFiniteNumber)
  return Math.min(10, Math.max(0, Math.round(value)))
}

export const isPromptCompilerTraceEnabled = (config: ConfigurationReader): boolean =>
  readCompatibleSetting(config, PROMPT_COMPILER_TRACE_KEY, false, isBoolean)

export const promptCompilerInstructionsMode = (config: ConfigurationReader): unknown =>
  readCompatibleSetting<unknown>(config, PROMPT_COMPILER_INSTRUCTIONS_MODE_KEY, "default", isString)

export const promptCompilerInstructionsFile = (config: ConfigurationReader): string | undefined => {
  const value = readCompatibleSetting<string>(config, PROMPT_COMPILER_INSTRUCTIONS_FILE_KEY, "", isString)
  return value || undefined
}

export interface RoleSelection {
  /** Provider ID or label; empty selects the role's default provider. */
  provider: string
  /** Overrides the provider's model; empty keeps it. */
  model: string
}

export const feedbackProviderSelection = (config: ConfigurationReader): RoleSelection => ({
  provider: (config.get<string>(FEEDBACK_PROVIDER_KEY) ?? "").trim(),
  model: (config.get<string>(FEEDBACK_MODEL_KEY) ?? "").trim()
})

export const promptCompilerProviderSelection = (config: ConfigurationReader): RoleSelection => ({
  provider: (config.get<string>(PROMPT_COMPILER_PROVIDER_KEY) ?? "").trim(),
  model: (config.get<string>(PROMPT_COMPILER_MODEL_KEY) ?? "").trim()
})

export interface SettingMigration {
  key: string
  value: unknown
  scope: SettingScope
  from: string
}

/**
 * Copies explicitly set legacy values into the new keys, scope by scope,
 * where the new key is not set at that scope. Defaults are never copied, so
 * new users get the new defaults (Feedback on, Prompt Compiler off).
 */
export const planSettingMigrations = (config: ConfigurationReader): SettingMigration[] => {
  const migrations: SettingMigration[] = []
  for (const [key, legacyKeys] of Object.entries(LEGACY_SETTING_KEYS)) {
    const current = config.inspect<unknown>(key)
    for (const [scope, field] of SCOPES) {
      if (current?.[field] !== undefined) continue
      for (const legacy of legacyKeys) {
        const value = config.inspect<unknown>(legacy)?.[field]
        if (value === undefined) continue
        migrations.push({ key, value, scope, from: legacy })
        break
      }
    }
  }
  return migrations
}

/** Where a role's provider is looked up: by ID first, then by label. */
export const findProviderBySelection = <P extends { id: string; label: string }>(
  providers: Iterable<P>,
  selection: string
): P | undefined => {
  const wanted = selection.trim()
  if (!wanted) return undefined
  const list = [...providers]
  return list.find((provider) => provider.id === wanted) ??
    list.find((provider) => provider.label.trim().toLowerCase() === wanted.toLowerCase())
}

/**
 * `config.get(key)`, except that a current key the user never set falls
 * back to a legacy key the user did set before its default.
 */
export const readSettingWithLegacy = (config: ConfigurationReader, key: string): unknown => {
  const legacy = LEGACY_SETTING_KEYS[key]
  if (!legacy) return config.get<unknown>(key)
  for (const candidate of [key, ...legacy]) {
    const value = explicitSetting<unknown>(config, candidate)
    if (value !== undefined) return value
  }
  return config.get<unknown>(key)
}
