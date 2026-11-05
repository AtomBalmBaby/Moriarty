import { ConfigurationTarget, workspace } from "vscode"

import { explicitSetting, planSettingMigrations, RETIRED_SETTING_KEYS } from "../common/feedback-settings"
import { logger } from "../common/logger"

/**
 * Copies explicitly set legacy Intent settings to the Feedback and Prompt
 * Compiler keys once, at the scope they were set. Folder-scoped values are
 * left in place: the readers fall back to them at runtime.
 */
export const migrateFeedbackSettings = async (): Promise<void> => {
  const config = workspace.getConfiguration("twinny")
  for (const migration of planSettingMigrations(config)) {
    if (migration.scope === "workspaceFolder") continue
    try {
      await config.update(
        migration.key,
        migration.value,
        migration.scope === "global" ? ConfigurationTarget.Global : ConfigurationTarget.Workspace
      )
      logger.info(`[Settings] migrated twinny.${migration.from} to twinny.${migration.key} (${migration.scope})`)
    } catch (error) {
      logger.warn(`[Settings] could not migrate twinny.${migration.from}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  for (const key of RETIRED_SETTING_KEYS) {
    const value = explicitSetting<unknown>(config, key)
    if (value === undefined) continue
    logger.info(`[Settings] twinny.${key}=${JSON.stringify(value)} is retired and ignored: the Prompt Compiler only runs on Ctrl/Cmd+Click Send and never submits automatically`)
  }
}
