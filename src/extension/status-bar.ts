import { ExtensionContext, StatusBarItem, workspace } from "vscode"

import {
  ACTIVE_FIM_PROVIDER_STORAGE_KEY,
  TWINNY_COMMAND_NAME
} from "../common/constants"
import { TwinnyProvider } from "../common/types"

import { GenerationTracker } from "./generations"
import {
  WorkspaceIndexState,
  WorkspaceIntelligenceIndex
} from "./workspace-index"

const ICON_IDLE = "$(code)"
const ICON_BUSY = "$(loading~spin)"

const formatBytes = (size: number) => {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Twinny's existing status item reflects FIM settings and the workspace index.
 */
export class TwinnyStatusBar {
  private readonly _subscription: { dispose(): void }
  private readonly _indexSubscription?: { dispose(): void }
  private _refreshTimer?: ReturnType<typeof setTimeout>

  constructor(
    private readonly _item: StatusBarItem,
    private readonly _context: Pick<ExtensionContext, "globalState">,
    private readonly _generations: GenerationTracker,
    private readonly _workspaceIndex?: WorkspaceIntelligenceIndex
  ) {
    this._item.name = "Twinny"
    this._subscription = _generations.onDidChange((state) => {
      if (state.busy) this.showBusy()
      else this.refresh()
    })
    this._indexSubscription = _workspaceIndex?.onDidChange(() => {
      if (this._refreshTimer) return
      this._refreshTimer = setTimeout(() => {
        this._refreshTimer = undefined
        if (this._generations.state.busy) this.showBusy()
        else this.refresh()
      }, 250)
    })
  }

  private indexLines(state: WorkspaceIndexState | undefined): string[] {
    if (!state) return ["Workspace index: not initialized"]
    const folders = (workspace.workspaceFolders ?? []).map((folder) => folder.name).join(", ") || "no workspace folder"
    const pending = state.filesPending ? ` · ${state.filesPending} pending` : ""
    const progress = state.status === "scanning"
      ? `${state.filesDiscovered} files discovered`
      : state.status === "indexing"
        ? `${state.filesIndexed}/${state.filesDiscovered} files indexed${pending}`
        : `${state.filesIndexed} files indexed`
    return [
      `Workspace index: ${state.status} · ${folders}`,
      `${progress} · ${state.symbolsIndexed} symbols · ${state.filesSkipped} skipped · ${state.filesFailed} failed`,
      `Storage: ${formatBytes(state.storageBytes)}${state.lastSynchronized ? ` · last sync ${state.lastSynchronized}` : " · never synchronized"}`,
      ...(state.error ? [`Index error: ${state.error}`] : [])
    ]
  }

  private indexIcon(): string {
    const status = this._workspaceIndex?.snapshot.status
    if (status === "scanning" || status === "indexing") return " $(sync~spin)"
    if (status === "paused") return " $(debug-pause)"
    if (status === "error") return " $(warning)"
    return ""
  }

  private showBusy() {
    this._item.text = `${ICON_BUSY}${this.indexIcon()}`
    this._item.tooltip = ["Twinny is generating — click to stop", ...this.indexLines(this._workspaceIndex?.snapshot)].join("\n")
    this._item.command = TWINNY_COMMAND_NAME.stopGeneration
    this._item.show()
  }

  /** Re-read FIM settings and index metrics; no-op while generation state owns the item. */
  public refresh() {
    if (this._generations.state.busy) return

    const config = workspace.getConfiguration("twinny")
    if (!config.get<boolean>("enabled", true)) {
      this._item.hide()
      return
    }

    const autoSuggest = config.get<boolean>("autoSuggestEnabled", true)
    const provider = this._context.globalState.get<TwinnyProvider>(
      ACTIVE_FIM_PROVIDER_STORAGE_KEY
    )

    const lines = [
      provider
        ? `Twinny · ${provider.modelName} (${provider.label})`
        : "Twinny · no FIM provider selected",
      autoSuggest
        ? "Auto-suggest is on"
        : "Auto-suggest is off — trigger completions manually with Alt+\\",
      ...this.indexLines(this._workspaceIndex?.snapshot),
      "Click for options"
    ]

    this._item.text = `${autoSuggest ? ICON_IDLE : `${ICON_IDLE} off`}${this.indexIcon()}`
    this._item.tooltip = lines.join("\n")
    this._item.command = TWINNY_COMMAND_NAME.statusBarMenu
    this._item.show()
  }

  public dispose() {
    if (this._refreshTimer) clearTimeout(this._refreshTimer)
    this._subscription.dispose()
    this._indexSubscription?.dispose()
    this._item.dispose()
  }
}
