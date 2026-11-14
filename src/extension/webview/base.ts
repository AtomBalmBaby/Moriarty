import { models } from "fluency.js"
import * as vscode from "vscode"

import { AGENT_STARTUP_SELECTION_SETTING } from "../../common/agents"
import {
  ACTIVE_CONVERSATION_STORAGE_KEY,
  ACTIVE_FIM_PROVIDER_STORAGE_KEY,
  EVENT_NAME,
  TODO_EVENT_NAME,
  TWINNY_COMMAND_NAME,
  WORKSPACE_STORAGE_KEY
} from "../../common/constants"
import { FEEDBACK_ENABLED_KEY, isFeedbackEnabled, isPromptCompilerEnabled, PROMPT_COMPILER_ENABLED_KEY, readSettingWithLegacy } from "../../common/feedback-settings"
import { logger, redact } from "../../common/logger"
import {
  ContextValue,
  NewDocumentRequest,
  PromptInstructionsRequest,
  PromptInstructionsResponse
} from "../../common/messaging/protocol"
import {
  AnyContextItem,
  Conversation,
  ModelCatalogue,
  TodoListSnapshot,
  TwinnyProvider
} from "../../common/types"
import { AgentRegistry, writeAgentsSetting } from "../agents/registry"
import { Chat } from "../chat"
import { ConversationHistory } from "../chat/conversation-history"
import { deliverEntireChat, type EntireChatExportDeps } from "../chat/entire-chat-export"
import { searchSymbols } from "../chat/symbols"
import { WorkspaceIndex } from "../embeddings"
import { EmbeddingService } from "../embeddings/service"
import { GenerationTracker } from "../generations"
import { ExtensionBridge } from "../messaging/bridge"
import { P2pBridge } from "../p2p/bridge"
import { P2pRuntime } from "../p2p/runtime"
import { promptInstructionConfigKeys } from "../prompts/instructions"
import { resolveProviderEndpoint } from "../providers/endpoint"
import { ProviderManager } from "../providers/manager"
import { ReviewService } from "../review/service"
import { SessionManager } from "../session-manager"
import { TeamPluginsBridge, TeamShareBridge } from "../team/bridge"
import type { TeamPlugins } from "../team/plugins-page"
import { TeamShare } from "../team/share"
import { TemplateProvider } from "../templates/provider"
import { TodoRepository, trustedTodoPanelApproval, workspaceProjectFingerprint } from "../todos/repository"
import { prepareProjectTodoStorage, resolveProjectTodoStorage, retireLegacyTodoDatabase } from "../todos/sqlite"
import type { CreateTodoInput, TodoWriteRequest, UpdateTodoInput } from "../todos/types"
import type { WorkspaceSearchProvider } from "../tools/workspace"
import { getLanguage, getTerminal, getTextSelection, getTheme } from "../utils"

import { resolveLanguageId, stripShellPrompts } from "./code-actions"
import { FileHandler } from "./file-handler"
import { FileTreeProvider } from "./file-tree"

/** Prefix under which a scoped context value lives in extension storage. */
const storageKeyFor = (scope: string, key: string) => `${scope}-${key}`

/** Set once the extension-global TODO database has been retired, so that removal never repeats. */
const LEGACY_TODO_RETIRED_KEY = "twinny.legacyTodoDatabaseRetired"

/** The TODO database belongs to the single open project; throws when the workspace has none or several. */
const currentProjectTodoStorage = () =>
  resolveProjectTodoStorage((vscode.workspace.workspaceFolders ?? []).map((folder) => ({ scheme: folder.uri.scheme, fsPath: folder.uri.fsPath })))

let legacyTodoRetirement: Promise<void> | undefined

export class BaseProvider {
  private _workspaceIndex: WorkspaceIndex | undefined
  private _embeddingService: EmbeddingService | undefined
  private _fileTreeProvider: FileTreeProvider
  private readonly _agentRegistry: AgentRegistry
  private _p2p: P2pRuntime | undefined
  private _p2pBridge: P2pBridge | undefined
  private _teamShare: TeamShare | undefined
  private _teamShareBridge: TeamShareBridge | undefined
  private _teamPlugins: TeamPlugins | undefined
  private _teamPluginsBridge: TeamPluginsBridge | undefined
  private readonly _workspaceSearch: WorkspaceSearchProvider | undefined
  private _sessionManager: SessionManager | undefined
  private _generations: GenerationTracker
  private readonly _todoRepository: TodoRepository
  private _templateDir: string | undefined
  private _templateProvider: TemplateProvider
  private _disposables: vscode.Disposable[] = []
  public bridge: ExtensionBridge | undefined
  public chat: Chat | undefined
  public providers: ProviderManager | undefined
  public context: vscode.ExtensionContext
  public conversationHistory: ConversationHistory | undefined
  public reviewService: ReviewService | undefined
  public webView?: vscode.Webview

  private _sidebarReadyHandler?: () => void

  public registerSidebarReadyHandler(handler: () => void) {
    this._sidebarReadyHandler = handler
  }

  constructor(
    context: vscode.ExtensionContext,
    templateDir: string,
    generations: GenerationTracker,
    index?: WorkspaceIndex,
    sessionManager?: SessionManager,
    p2p?: P2pRuntime,
    teamShare?: TeamShare,
    teamPlugins?: TeamPlugins,
    workspaceSearch?: WorkspaceSearchProvider
  ) {
    this.context = context
    this._todoRepository = new TodoRepository(async () => prepareProjectTodoStorage(currentProjectTodoStorage()))
    this._agentRegistry = new AgentRegistry(context)
    this._fileTreeProvider = new FileTreeProvider()
    this._workspaceIndex = index
    this._p2p = p2p
    this._teamShare = teamShare
    this._teamPlugins = teamPlugins
    this._sessionManager = sessionManager
    this._workspaceSearch = workspaceSearch
    this._generations = generations
    this._templateDir = templateDir
    this._templateProvider = new TemplateProvider(templateDir)
    void this.retireLegacyTodoDatabaseOnce()
  }

  /** Runs the one-time removal of the old extension-global TODO database after the project database initializes. */
  private retireLegacyTodoDatabaseOnce(): Promise<void> {
    if (this.context.globalState.get<boolean>(LEGACY_TODO_RETIRED_KEY)) return Promise.resolve()
    legacyTodoRetirement ??= this.runLegacyTodoRetirement().finally(() => {
      legacyTodoRetirement = undefined
    })
    return legacyTodoRetirement
  }

  private async runLegacyTodoRetirement(): Promise<void> {
    try {
      await this._todoRepository.initialize()
      const storage = currentProjectTodoStorage()
      const outcome = await retireLegacyTodoDatabase(this.context.globalStorageUri.fsPath, storage.databasePath)
      logger.info(`Legacy TODO database ${outcome.legacyPath} -> project TODO database ${storage.databasePath}: ${outcome.status}`)
      if (outcome.status === "blocked") {
        logger.warn(`Legacy TODO database kept: ${outcome.reason}`)
        return
      }
      if (outcome.status === "removed") logger.info(`Removed legacy TODO database files: ${outcome.removed.join(", ")}`)
      await this.context.globalState.update(LEGACY_TODO_RETIRED_KEY, true)
    } catch (error) {
      logger.warn(`Legacy TODO database retirement deferred: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  public registerWebView(webView: vscode.Webview) {
    this.dispose()
    this.webView = webView
    this.bridge = new ExtensionBridge(webView)
    this.initializeServices(this.bridge)
    this.registerHandlers(this.bridge)
    this.registerEditorListeners(this.bridge)
    logger.info("Webview registered successfully")
  }

  public dispose() {
    this.bridge?.dispose()
    this.bridge = undefined
    this._p2pBridge?.dispose()
    this._p2pBridge = undefined
    this._teamShareBridge?.dispose()
    this._teamShareBridge = undefined
    this._teamPluginsBridge?.dispose()
    this._teamPluginsBridge = undefined
    this.chat?.dispose()
    this._embeddingService?.dispose()
    this._embeddingService = undefined
    this.conversationHistory?.dispose()
    this._disposables.forEach((disposable) => disposable.dispose())
    this._disposables = []
  }

  /**
   * Scope for mutations. The writer is the active conversation from host state, never the message payload,
   * and the repository rejects any write whose writer is not the target list's conversation.
   */
  private todoScope(conversationId: string): TodoWriteRequest {
    const writer = this.activeConversationId()
    if (!conversationId || writer !== conversationId) {
      throw new Error("TODO operations are limited to the active conversation")
    }
    return { ...this.todoReadScope(conversationId), writer }
  }

  /** Scope for read-only access: any conversation in this workspace's project. Writes must use todoScope. */
  private todoReadScope(conversationId: string) {
    if (!conversationId) throw new Error("A conversation is required")
    return {
      projectFingerprint: workspaceProjectFingerprint((vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.toString(true))),
      conversationId
    }
  }

  private activeConversationId(): string | undefined {
    return this.context.globalState.get<Conversation>(ACTIVE_CONVERSATION_STORAGE_KEY)?.id
  }

  private async emitTodoSnapshot(conversationId: string): Promise<TodoListSnapshot> {
    const snapshot = await this._todoRepository.getList(this.todoScope(conversationId))
    this.bridge?.emit(TODO_EVENT_NAME.changed, snapshot)
    return snapshot
  }

  private initializeServices(bridge: ExtensionBridge) {
    this.chat = new Chat(
      this._generations,
      this._templateDir,
      this.context,
      bridge,
      this._workspaceIndex?.search,
      this._agentRegistry,
      this._todoRepository,
      this._workspaceSearch
    )

    this.conversationHistory = new ConversationHistory(
      this.context,
      bridge,
      this.chat
    )

    this.reviewService = new ReviewService(
      this.context,
      bridge,
      this._templateDir,
      this.chat,
      this.conversationHistory
    )

    const teamShare = this._teamShare
    const teamPlugins = this._teamPlugins
    const providerManager = new ProviderManager(this.context, bridge, {
      teamChanged: async () => {
        await Promise.all([teamShare?.teamChanged(), teamPlugins?.teamChanged()])
      },
      chatGPTPlanSigningOut: () => {
        this._generations.stopAll("host")
        this.chat?.abortAll()
      }
    })
    this.providers = providerManager
    this.chat.refreshTeamPolicy = () => providerManager.refreshTeamPolicy()
    if (this._p2p) {
      this._p2pBridge = new P2pBridge(this._p2p, bridge, providerManager)
    }
    if (teamShare) {
      this._teamShareBridge = new TeamShareBridge(teamShare, bridge)
    }
    if (teamPlugins) {
      this._teamPluginsBridge = new TeamPluginsBridge(teamPlugins, bridge)
    }
    this._embeddingService = new EmbeddingService(
      this.context,
      bridge,
      this._workspaceIndex
    )
    new FileHandler(bridge)

    logger.info("Provider services initialized successfully")
  }

  /**
   * Every channel this provider owns, in one table.
   *
   * Handlers are plain functions of their payload: return a value and the
   * bridge routes it back to whoever asked (or broadcasts it if nobody is
   * waiting on a specific reply). Nothing here mentions `postMessage`.
   */
  private async promptInstructions(request: PromptInstructionsRequest): Promise<PromptInstructionsResponse> {
    if (request.action === "inspect") {
      if (!this.chat) throw new Error("Chat is not initialized; prompt preview is unavailable.")
      return this.chat.previewPromptInstructions(request.agentSelection)
    }
    if (request.action === "pick") {
      const files = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        openLabel: "Select Markdown file",
        filters: { Markdown: ["md"] }
      })
      return { selectedFile: files?.[0]?.fsPath }
    }
    const key = request.route === "chat" ? promptInstructionConfigKeys.chatFile : promptInstructionConfigKeys.intentFile
    const file = vscode.workspace.getConfiguration("twinny").get<string>(key)
    if (!file) throw new Error("No custom Markdown file is selected for " + request.route + " base instructions.")
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file))
    await vscode.window.showTextDocument(document)
    return {}
  }

  private registerHandlers(bridge: ExtensionBridge) {
    bridge.handleAll({
      [EVENT_NAME.twinntGetLocale]: () => this.getLocale(),
      [EVENT_NAME.twinnyAcceptSolution]: (code) =>
        void vscode.commands.executeCommand(TWINNY_COMMAND_NAME.applyCode, code),
      [EVENT_NAME.twinnyAgentRegistry]: async (request) => {
        let profiles
        switch (request.action) {
          case "list":
          case "refresh":
            profiles = await this._agentRegistry.list()
            break
          case "pick":
            profiles = await this._agentRegistry.pick()
            break
          case "add":
            profiles = await this._agentRegistry.add(request.path, request.name)
            break
          case "create":
            profiles = await this._agentRegistry.create(request.name)
            break
          case "open":
            await this._agentRegistry.open(request.id)
            profiles = await this._agentRegistry.list()
            break
          case "enable":
            profiles = await this._agentRegistry.setEnabled(request.id, request.enabled)
            break
          case "remove":
            profiles = await this._agentRegistry.remove(request.id)
            break
        }
        bridge.emit(EVENT_NAME.twinnyAgentRegistry, profiles)
        return profiles
      },
      [EVENT_NAME.twinnyPromptInstructions]: (request) => this.promptInstructions(request),
      [EVENT_NAME.twinnyChatMessage]: ({ messages, mentions, agentSelection, conversationId }) => {
        if (!this.chat) {
          this.bridge?.emit(EVENT_NAME.twinnyNotification, "The chat is not ready. Reload the window and send again.")
          this.bridge?.emit(EVENT_NAME.twinnyStopGeneration, { cancelled: true })
          return
        }
        void this.chat.completion(messages, mentions, agentSelection, conversationId).catch((error: unknown) => {
          logger.error(`[Chat] message failed conversation=${conversationId ?? "-"}: ${error instanceof Error ? error.message : String(error)}`)
          this.bridge?.emit(EVENT_NAME.twinnyNotification, "The message could not be sent. See the Twinny output log for details.")
        })
      },
      [TODO_EVENT_NAME.getList]: async ({ conversationId }) => {
        if (this.activeConversationId() === conversationId) return this._todoRepository.getList(this.todoScope(conversationId))
        return this._todoRepository.readList(this.todoReadScope(conversationId))
      },
      [TODO_EVENT_NAME.createItem]: async ({ conversationId, requestId, ...input }) => {
        await this._todoRepository.createItem(this.todoScope(conversationId), input as CreateTodoInput, requestId, "user")
        return this.emitTodoSnapshot(conversationId)
      },
      [TODO_EVENT_NAME.updateItem]: async ({ conversationId, ...input }) => {
        await this._todoRepository.updateItem(this.todoScope(conversationId), { ...input, actor: "user" } as UpdateTodoInput)
        return this.emitTodoSnapshot(conversationId)
      },
      [TODO_EVENT_NAME.completeItem]: async ({ conversationId, itemId, expectedVersion, requestId }) => {
        await this._todoRepository.completeByUser(
          this.todoScope(conversationId), itemId, expectedVersion,
          "Completed by an explicit action in the TODO checklist.", requestId, trustedTodoPanelApproval
        )
        return this.emitTodoSnapshot(conversationId)
      },
      [TODO_EVENT_NAME.renewRequirement]: async ({ conversationId, itemId, requestId }) => {
        await this._todoRepository.renewRequirement(this.todoScope(conversationId), itemId, requestId)
        return this.emitTodoSnapshot(conversationId)
      },
      [TODO_EVENT_NAME.setAssessmentReaction]: async ({ conversationId, assessmentId, reaction, requestId }) => {
        await this._todoRepository.setAssessmentReaction(this.todoScope(conversationId), assessmentId, reaction, requestId)
        return this.emitTodoSnapshot(conversationId)
      },
      [TODO_EVENT_NAME.evaluateItem]: async ({ conversationId, itemId }) => {
        const snapshot = await this.chat?.evaluateTodoTask(this.todoScope(conversationId), itemId)
        if (!snapshot) throw new Error("The feedback evaluator is unavailable")
        this.bridge?.emit(TODO_EVENT_NAME.changed, snapshot)
        return snapshot
      },
      [TODO_EVENT_NAME.retryFeedback]: async ({ conversationId }) => {
        const outcome = await this.chat?.retryFeedback(conversationId)
        if (!outcome) throw new Error("The feedback planner is unavailable")
        return { status: outcome.status }
      },
      [EVENT_NAME.twinnyCompilePrompt]: async (request) =>
        this.chat
          ? this.chat.compilePrompt(request)
          : { requestId: request.requestId, status: "failed", error: "The chat is not ready." },
      [EVENT_NAME.twinnyCancelPromptCompile]: ({ requestId }) => this.chat?.cancelPromptCompile(requestId),
      [EVENT_NAME.twinnyClickSuggestion]: (template) =>
        void vscode.commands.executeCommand(
          TWINNY_COMMAND_NAME.templateCompletion,
          template
        ),
      [EVENT_NAME.twinnyComposerSuggest]: async ({ draft, recent }) =>
        (await this.chat?.suggestDraft(draft, recent)) ?? "",
      [EVENT_NAME.twinnyEditDefaultTemplates]: () => this.editDefaultTemplates(),
      [EVENT_NAME.twinnyFileListRequest]: () =>
        this._fileTreeProvider.getAllFiles(),
      [EVENT_NAME.twinnyGetConfigValue]: ({ key }) => ({
        key,
        value: readSettingWithLegacy(vscode.workspace.getConfiguration("twinny"), key)
      }),
      [EVENT_NAME.twinnyGetContextItems]: () =>
        this.broadcastContextItems(this.readContextItems()),
      [EVENT_NAME.twinnyGetGitChanges]: () =>
        void vscode.commands.executeCommand(
          TWINNY_COMMAND_NAME.generateCommitMessage
        ),
      [EVENT_NAME.twinnyGetModels]: () => models as unknown as ModelCatalogue,
      [EVENT_NAME.twinnyGlobalContext]: ({ key }) =>
        this.readGlobalContext(key),
      [EVENT_NAME.twinnyGetWorkspaceContext]: ({ key }) =>
        this.readWorkspaceContext(key),
      [EVENT_NAME.twinnySessionContext]: ({ key }) =>
        this.readSessionContext(key),
      [EVENT_NAME.twinnySetGlobalContext]: (value) =>
        this.writeGlobalContext(value),
      [EVENT_NAME.twinnySetWorkspaceContext]: (value) =>
        this.writeWorkspaceContext(value),
      [EVENT_NAME.twinnySetSessionContext]: (value) =>
        this.writeSessionContext(value),
      [EVENT_NAME.twinnyHideBackButton]: () =>
        void vscode.commands.executeCommand(TWINNY_COMMAND_NAME.hideBackButton),
      [EVENT_NAME.twinnyOpenProviders]: () =>
        void vscode.commands.executeCommand(TWINNY_COMMAND_NAME.manageProviders),
      [EVENT_NAME.twinnyListTemplates]: () =>
        this._templateProvider.listTemplates(),
      [EVENT_NAME.twinnyNewConversation]: () => this.newConversation(),
      [EVENT_NAME.twinnyNewDocument]: (request) =>
        this.createNewUntitledDocument(request),
      [EVENT_NAME.twinnyEntireChatExport]: (request) =>
        deliverEntireChat(request, this.entireChatExportDeps()),
      [EVENT_NAME.twinnyNotification]: (message) =>
        void vscode.window.showInformationMessage(message),
      [EVENT_NAME.twinnyRemoveContextItem]: (id) => this.removeContextItem(id),
      [EVENT_NAME.twinnyRunInTerminal]: (command) =>
        this.sendToTerminal(command),
      [EVENT_NAME.twinnyInsertAtCursor]: (code) => this.insertAtCursor(code),
      [EVENT_NAME.twinnySendLanguage]: () => getLanguage(),
      [EVENT_NAME.twinnySendTheme]: () => getTheme(),
      [EVENT_NAME.twinnySetConfigValue]: async ({ key, value }) => {
        const configuration = vscode.workspace.getConfiguration("twinny")
        // Written where the user already set it, so a workspace value is not left overriding the change.
        const scopedSetting = key === "agents" || key.startsWith("agents.") || key.startsWith("chatBaseInstructions") || key.startsWith("promptCompiler.") || key.startsWith("feedback.")
        const scope = scopedSetting ? configuration.inspect(key) : undefined
        const target = scope?.workspaceFolderValue !== undefined
          ? vscode.ConfigurationTarget.WorkspaceFolder
          : scope?.workspaceValue !== undefined
            ? vscode.ConfigurationTarget.Workspace
            : vscode.ConfigurationTarget.Global
        await (key === "agents" ? writeAgentsSetting(value, target) : configuration.update(key, value, target))
        this.bridge?.emit(EVENT_NAME.twinnyConfigValueChanged, { key, value })
      },
      [EVENT_NAME.twinnySidebarReady]: () => {
        this._sidebarReadyHandler?.()
        this.chat?.announceOperation()
      },
      [EVENT_NAME.twinnyStopGeneration]: () => this.destroyStream(),
      [EVENT_NAME.twinnyPauseGeneration]: ({ operationId }) => this.chat?.pause(operationId),
      [EVENT_NAME.twinnyToolApproval]: ({ id, run, always }) => this.chat?.answerToolApproval(id, run, always),
      [EVENT_NAME.twinnyToolStop]: ({ id }) => this.chat?.stopToolStep(id),
      [EVENT_NAME.twinnySteer]: ({ id, text }) => this.chat?.steer(id, text),
      [EVENT_NAME.twinnyOpenChange]: ({ id, path }) => void this.chat?.openChange(id, path),
      [EVENT_NAME.twinnyOpenAgentSettings]: () =>
        void vscode.commands.executeCommand("workbench.action.openSettings", "twinny.agents"),
      [EVENT_NAME.twinnyUndoChanges]: async ({ id, paths }) =>
        (await this.chat?.undoChanges(id, paths)) ?? { error: "The chat is not ready." },
      [EVENT_NAME.twinnySymbolSearch]: ({ query }) => searchSymbols(query),
      [EVENT_NAME.twinnyTextSelection]: () => getTextSelection()
    })
  }

  private registerEditorListeners(bridge: ExtensionBridge) {
    this._disposables.push(
      vscode.window.onDidChangeActiveColorTheme(() => {
        bridge.emit(EVENT_NAME.twinnySendTheme, getTheme())
      }),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        bridge.emit(
          EVENT_NAME.twinnyTextSelection,
          event.textEditor.document.getText(event.selections[0])
        )
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        // Edits made in VS Code's Settings reach the composer without a reload.
        for (const key of [PROMPT_COMPILER_ENABLED_KEY, FEEDBACK_ENABLED_KEY]) {
          if (!event.affectsConfiguration("twinny." + key)) continue
          const configuration = vscode.workspace.getConfiguration("twinny")
          const value = key === PROMPT_COMPILER_ENABLED_KEY ? isPromptCompilerEnabled(configuration) : isFeedbackEnabled(configuration)
          bridge.emit(EVENT_NAME.twinnyConfigValueChanged, { key, value })
        }
        if (event.affectsConfiguration("twinny.agents")) {
          bridge.emit(EVENT_NAME.twinnyConfigValueChanged, {
            key: "agents",
            value: vscode.workspace.getConfiguration("twinny").get("agents")
          })
        }
        if (event.affectsConfiguration("twinny." + AGENT_STARTUP_SELECTION_SETTING)) {
          bridge.emit(EVENT_NAME.twinnyConfigValueChanged, {
            key: AGENT_STARTUP_SELECTION_SETTING,
            value: vscode.workspace.getConfiguration("twinny").get(AGENT_STARTUP_SELECTION_SETTING)
          })
        }
        // A new locale remounts the whole webview, so only a change to it is sent.
        if (!event.affectsConfiguration("twinny.locale")) return
        bridge.emit(EVENT_NAME.twinnySetLocale, this.getLocale())
      })
    )
  }

  private getLocale() {
    return vscode.workspace.getConfiguration("twinny").get<string>("locale") || "en"
  }

  public getFimProvider = () => {
    return resolveProviderEndpoint(
      this.context.globalState.get<TwinnyProvider>(ACTIVE_FIM_PROVIDER_STORAGE_KEY)
    )
  }

  public editDefaultTemplates = async () => {
    if (!this._templateDir) return
    await vscode.commands.executeCommand(
      "vscode.openFolder",
      vscode.Uri.file(this._templateDir),
      true
    )
  }

  public destroyStream = () => {
    this.chat?.abort()
    if (!this.chat) this.bridge?.emit(EVENT_NAME.twinnyStopGeneration, { cancelled: true })
  }

  public async streamTemplateCompletion(template: string) {
    this.chat?.templateCompletion(template)
  }

  /* ---------------------------------------------------------------------- */
  /*  Context items                                                          */
  /* ---------------------------------------------------------------------- */

  private readContextItems = () =>
    this.context?.workspaceState.get<AnyContextItem[]>(
      WORKSPACE_STORAGE_KEY.contextItems
    ) || []

  addContextItem = (item: AnyContextItem) => {
    const items = this.readContextItems()
    const index = items.findIndex((existing) => existing.id === item.id)
    const updated = [...items]
    if (index > -1) updated[index] = item
    else updated.push(item)
    this.saveContextItems(updated)
  }

  removeContextItem = (id: string) => {
    this.saveContextItems(this.readContextItems().filter((i) => i.id !== id))
  }

  private saveContextItems = (items: AnyContextItem[]) => {
    this.context?.workspaceState.update(
      WORKSPACE_STORAGE_KEY.contextItems,
      items
    )
    this.broadcastContextItems(items)
  }

  private broadcastContextItems = (items: AnyContextItem[]) => {
    this.bridge?.emit(EVENT_NAME.twinnyUpdateContextItems, items)
  }

  /* ---------------------------------------------------------------------- */
  /*  Scoped context storage                                                 */
  /* ---------------------------------------------------------------------- */

  private readGlobalContext = (key: string): ContextValue => ({
    key,
    value: this.context?.globalState.get(
      storageKeyFor(EVENT_NAME.twinnyGlobalContext, key)
    )
  })

  private writeGlobalContext = ({ key, value }: ContextValue) => {
    this.context?.globalState.update(
      storageKeyFor(EVENT_NAME.twinnyGlobalContext, key),
      value
    )
    this.bridge?.emit(EVENT_NAME.twinnyGlobalContext, { key, value })
  }

  private readWorkspaceContext = (key: string): ContextValue => ({
    key,
    value: this.context?.workspaceState.get(
      storageKeyFor(EVENT_NAME.twinnyGetWorkspaceContext, key)
    )
  })

  private writeWorkspaceContext = ({ key, value }: ContextValue) => {
    this.context?.workspaceState.update(
      storageKeyFor(EVENT_NAME.twinnyGetWorkspaceContext, key),
      value
    )
    this.bridge?.emit(EVENT_NAME.twinnyGetWorkspaceContext, { key, value })
  }

  private readSessionContext = (key: string): ContextValue => ({
    key,
    value: this._sessionManager?.get(key)
  })

  private writeSessionContext = ({ key, value }: ContextValue) => {
    this._sessionManager?.set(key, value)
    this.bridge?.emit(EVENT_NAME.twinnySessionContext, { key, value })
  }

  /* ---------------------------------------------------------------------- */

  /** From the chat's button or the command: both sides start over. */
  public newConversation = () => {
    this.conversationHistory?.resetConversation()
    this.chat?.resetConversation()
    this.bridge?.emit(EVENT_NAME.twinnyNewConversation)
    // A reply still being written belongs to the conversation left; the
    // chat has cleared what it queued there before the reply stops.
    this.chat?.discardReply()
  }

  private createNewUntitledDocument = async ({
    content,
    language
  }: NewDocumentRequest) => {
    const document = await vscode.workspace.openTextDocument({
      content,
      language: await resolveLanguageId(language, getLanguage().languageId)
    })
    await vscode.window.showTextDocument(document)
  }

  private entireChatExportDeps = (): EntireChatExportDeps => ({
    redact,
    writeClipboard: async (text) => {
      await vscode.env.clipboard.writeText(text)
    },
    saveMarkdown: async (text) => {
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri
      const target = await vscode.window.showSaveDialog({
        defaultUri: folder ? vscode.Uri.joinPath(folder, "twinny-chat.md") : undefined,
        filters: { Markdown: ["md"] },
        saveLabel: "Save Entire Chat"
      })
      if (!target) return undefined
      await vscode.workspace.fs.writeFile(target, Buffer.from(text, "utf8"))
      return target.fsPath
    },
    notify: (level, message) =>
      level === "error"
        ? void vscode.window.showErrorMessage(message)
        : void vscode.window.showInformationMessage(message)
  })

  /*
   * Pasted, not executed: the user reads the command in the terminal and
   * presses Enter themselves. Models get commands wrong often enough that an
   * auto-run button would be a foot-gun.
   */
  /*
   * Straight into the last editor, as if typed: a selection is replaced,
   * otherwise the code goes in at the cursor. Apply is for changes to
   * review; this is for a snippet that only adds.
   */
  private insertAtCursor = async (code: string) => {
    const editor = vscode.window.activeTextEditor
    if (!editor) {
      void vscode.window.showWarningMessage(
        "Open a file to insert the code into."
      )
      return
    }
    await vscode.window.showTextDocument(editor.document, editor.viewColumn)
    await editor.edit((builder) => {
      for (const selection of editor.selections) builder.replace(selection, code)
    })
  }

  private sendToTerminal = async (command: string) => {
    const terminal = await getTerminal()
    if (!terminal) return
    terminal.show()
    terminal.sendText(stripShellPrompts(command), false)
  }
}
