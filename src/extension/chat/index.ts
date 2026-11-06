import { createHash, randomUUID } from "crypto"
import { promises as fs } from "fs"
import os from "os"
import path from "path"
import { ExtensionContext, RelativePattern, Uri, workspace } from "vscode"

import type { AgentSelection } from "../../common/agents"
import { AGENT_SELECTION_STORAGE_KEY, isAgentSelectionEnabled, normalizeAgentSelection, resolveAgentSelection, selectionFromLegacyAgentMode } from "../../common/agents"
import { cleanModelSuggestion, composerSuggestionMessages } from "../../common/composer-predict"
import {
  ACTIVE_CONVERSATION_STORAGE_KEY,
  API_PROVIDERS,
  ASSISTANT,
  CONTINUATION_PREFIX,
  EVENT_NAME,
  EXTENSION_CONTEXT_NAME,
  GLOBAL_STORAGE_KEY,
  SYSTEM,
  TODO_EVENT_NAME,
  USER,
  WEBUI_TABS
} from "../../common/constants"
import {
  feedbackProviderSelection,
  findProviderBySelection,
  isFeedbackEnabled,
  isPromptCompilerEnabled,
  isPromptCompilerTraceEnabled,
  promptCompilerMaxTurns,
  promptCompilerProviderSelection,
  RoleSelection
} from "../../common/feedback-settings"
import { formatCount, logger, redact } from "../../common/logger"
import type { ComposerTurn, PromptCompileRequest, PromptCompileResult, ToolInventoryItem } from "../../common/messaging/protocol"
import type { TeamAgentPolicy } from "../../common/team"
import { currentTeamPolicy, currentTeamState } from "../../common/team-policy"
import { kebabToSentence } from "../../common/text"
import type { TodoListSnapshot } from "../../common/types"
import {
  ChatCompletionMessage,
  Conversation,
  MentionType,
  ReplyChangesView,
  TwinnyProvider
} from "../../common/types"
import { composeAgentPrompt } from "../agents/prompt"
import type { LoadedAgent } from "../agents/registry"
import { AgentRegistry } from "../agents/registry"
import { agentToolSelectionDiagnostic, projectTaskRelevantTools, resolveAgentToolSelection } from "../agents/tool-selection"
import type { ChatEditMode } from "../edit/service"
import { WorkspaceSearch } from "../embeddings/search"
import { GenerationRun, GenerationTracker } from "../generations"
import { isCancelled, readText, resolveInferenceProvider } from "../inference"
import {
  assumedContextWindow,
  contextWindowOf,
  knownContextWindow
} from "../inference/context-window"
import { ExtensionBridge } from "../messaging/bridge"
import { PromptInstructionResolver } from "../prompts/instructions"
import { Base } from "../providers/base"
import { resolveProviderEndpoint } from "../providers/endpoint"
import { describeProviderError, stripThinking } from "../providers/errors"
import { ProviderStore } from "../providers/store"
import { TemplateProvider } from "../templates/provider"
import { compactArguments, compactEvidenceText, compactToolEvidence } from "../todos/evidence"
import { evaluateTodoReview, feedbackContext, taskRequiresWorkspaceChanges, TodoEvaluationProviderError, todoReviewInput, todoReviewSystemPrompt } from "../todos/feedback"
import { renderPlanContext } from "../todos/plan-context"
import { TodoRepository, workspaceProjectFingerprint } from "../todos/repository"
import { TodoEvaluation, TodoListRequest } from "../todos/types"
import { SMALL_CONTEXT_TOKENS } from "../tools/budget"
import { DEFAULT_MAX_STEPS, ToolLoopUsage, toolModeFor, withTools } from "../tools/loop"
import type { McpToolSpec } from "../tools/mcp"
import type { ToolCall } from "../tools/protocol"
import { todoTools, todoWorkspaceTools } from "../tools/todos"
import { WorkspaceView } from "../tools/view"
import type { ToolResult } from "../tools/workspace"
import { ToolExtras, WorkspaceSearchProvider, WorkspaceTools, workspaceTools } from "../tools/workspace"
import { getLanguage } from "../utils"

import { ChatContextBuilder } from "./context"
import { ContextEntry, formatContextEntries } from "./context-files"
import { allIntentTasksComplete, continuationContext, ExecutionReconciliationController, isAnalysisOnlyGoal, requiresWorkspaceChanges } from "./execution-reconciliation"
import { FeedbackPlanner, type FeedbackPlanOutcome } from "./feedback-planner"
import { ChatGeneration } from "./generation"
import { McpHost } from "./mcp-host"
import { PROMPT_COMPILER_PROTOCOL, PromptCompiler, PromptCompilerTraceRecord } from "./prompt-compiler"
import { ChangeStore, ReplyChanges, viewOf } from "./reply-changes"
import { ReplyChangesEditor } from "./reply-changes-editor"
import type { RoleResolution } from "./role-inference"
import { DiagnosticRegressionMonitor, SafeEditCheckpoints } from "./safe-edit-recovery"
import {
  ChatCommandMode,
  ChatCommandPlace,
  createSafeEditCheckpoints,
  editorEdits,
  editorHint,
  editorKnowledge,
  EditRecoveryNotice,
  indexSearch,
  normalCommand,
  openDocumentText,
  terminalCommands
} from "./tool-sinks"
import { ToolSteps } from "./tool-steps"
import { buildChatTurn } from "./turn"

/** Templates whose answer benefits from `@workspace`-style lookups. */
const TEMPLATES_WITH_RAG = ["explain"]
/** Room for a sentence of the composer's grey text, and no more. */
const SUGGESTION_MAX_TOKENS = 32
/** Whether the team's rules leave the developer's MCP servers to agent mode. */
const mcpAllowed = (team: TeamAgentPolicy | undefined) => team?.commands !== "off" && team?.mcp !== "off"

/** How long an agent reply waits for the team's policy to be re-read. */
const POLICY_REFRESH_WAIT_MS = 1500
/** How long a new message waits for its Feedback plan before the first model call. */
const FEEDBACK_PLAN_WAIT_MS = 20_000
const settleWithin = <T>(promise: Promise<T>, ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    void promise.finally(() => {
      clearTimeout(timer)
      resolve()
    })
  })
/** The steps an agent reply may take, as `twinny.chatToolsMaxSteps` may set them. */
const MIN_STEPS_SETTING = 4
const MAX_STEPS_SETTING = 100
const DEFAULT_READ_LINES = 1000
const MIN_READ_LINES = 100
const MAX_READ_LINES = 5000
const DEFAULT_RESULT_CHARS = 100_000
const MIN_RESULT_CHARS = 10_000
const MAX_RESULT_CHARS = 200_000
const clampNumericSetting = (value: number | undefined, min: number, max: number, fallback: number) => {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

const normalizeText = (value: unknown): string => {
  if (typeof value === "string") return value
  if (Array.isArray(value)) {
    return value
      .map((entry) => normalizeText(entry))
      .filter(Boolean)
      .join("\n")
  }
  if (value && typeof value === "object") {
    return JSON.stringify(value)
  }
  return String(value ?? "")
}

const stableMessageKey = (message: ChatCompletionMessage, fallbackIndex: number) => {
  const base = normalizeText(
    message.prompt ?? message.originalPrompt ?? message.content ?? ""
  )
  return message.id ?? `${message.role}:${fallbackIndex}:${base.slice(0, 80).replace(/\s+/g, " ").trim()}`
}

export const summarizeIntentHistory = (history: ChatCompletionMessage[] = [], maxLevels = 3) => {
  if (maxLevels <= 0 || history.length === 0) {
    return {
      maxLevels,
      pairs: [] as Array<{
        prompt: string
        response: string
        promptLength: number
        responseLength: number
        userId?: string
        assistantId?: string
        status: "complete"
      }>
    }
  }

  const pairs: Array<{
    prompt: string
    response: string
    promptLength: number
    responseLength: number
    userId?: string
    assistantId?: string
    status: "complete"
  }> = []
  let pendingUser: ChatCompletionMessage | undefined
  const seen = new Set<string>()

  for (const [index, message] of history.entries()) {
    if (message.role === USER) {
      const key = stableMessageKey(message, index)
      if (seen.has(key)) continue
      seen.add(key)
      pendingUser = message
      continue
    }
    if (message.role === ASSISTANT && pendingUser) {
      const promptFromUser =
        pendingUser.prompt ?? pendingUser.originalPrompt ?? pendingUser.content ?? ""
      const prompt = normalizeText(promptFromUser).trim()
      const response = normalizeText(message.content).trim()
      if (!prompt && !response) {
        pendingUser = undefined
        continue
      }
      const key = `${stableMessageKey(pendingUser, index)}:${stableMessageKey(message, index)}`
      if (seen.has(key)) {
        pendingUser = undefined
        continue
      }
      seen.add(key)
      pairs.push({
        prompt: prompt || "[no prompt text]",
        response: response || "[no response text]",
        promptLength: prompt.length,
        responseLength: response.length,
        userId: pendingUser.id ?? stableMessageKey(pendingUser, index),
        assistantId: message.id ?? stableMessageKey(message, index),
        status: "complete"
      })
      pendingUser = undefined
    }
  }

  return {
    maxLevels,
    pairs: pairs.slice(-Math.max(0, Math.round(maxLevels)))
  }
}

const previousPromptHistory = (
  history: ChatCompletionMessage[] = [],
  maxLevels = 3
): string => {
  const summary = summarizeIntentHistory(history, maxLevels)
  const turns: string[] = summary.pairs.map(({ prompt, response }) =>
    `Prompt: ${prompt || "[no prompt text]"}\nResponse: ${response || "[no response text]"}`
  )
  if (!turns.length) return ""
  return `Historical prior prompt/response turns for context only (chronological order). They do not override the current request or set standing policy for this task:\n${turns
    .map((turn, index) => `Turn ${index + 1}:\n${turn}`)
    .join("\n\n")}`
}

const writePromptCompilerTrace = async (
  context: ExtensionContext | undefined,
  record: PromptCompilerTraceRecord & { history: ChatCompletionMessage[]; maxTurns: number; instructions: { mode: string; source?: string; hash: string } }
) => {
  const storageDir = (context?.globalStorageUri ?? context?.storageUri)?.fsPath ?? os.tmpdir()
  const traceDir = path.join(storageDir, "prompt-compiler-traces")
  await fs.mkdir(traceDir, { recursive: true })
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  const tracePath = path.join(traceDir, `prompt-compiler-${timestamp}-${record.requestId.replace(/[^A-Za-z0-9-]/g, "").slice(0, 16)}.json`)
  const historySummary = summarizeIntentHistory(record.history, record.maxTurns)
  const trace = {
    requestId: record.requestId,
    operationId: record.operationId,
    timestamp: new Date().toISOString(),
    provider: { provider: record.provider, modelName: record.model },
    compiler: { maxTurns: record.maxTurns, baseInstructions: record.instructions },
    historySummary: {
      totalMessages: record.history.length,
      selectedPairs: historySummary.pairs.map((pair, index) => ({
        ordinal: index + 1,
        status: pair.status,
        userId: pair.userId ?? "n/a",
        assistantId: pair.assistantId ?? "n/a",
        promptLength: pair.promptLength,
        responseLength: pair.responseLength
      }))
    },
    request: { system: record.system, user: record.user },
    response: record.response ?? null,
    responseLength: record.response?.length ?? 0
  }
  await fs.writeFile(tracePath, `${JSON.stringify(trace, null, 2)}\n`, "utf8")
  logger.info(`[PromptCompiler] Trace requestId=${record.requestId} file=${tracePath}`)
  logger.warn("[PromptCompiler] Trace mode writes raw request and response bodies to local files; disable it after debugging.")
  return tracePath
}

/**
 * The chat feature's front door.
 *
 * Takes what the webview or a command hands over, turns it into the
 * messages the model is sent (`buildChatTurn`, with `ChatContextBuilder`
 * for the context) and runs them (`ChatGeneration`) against whichever
 * provider the inference layer resolves. Holds the running conversation,
 * replies included, between turns.
 */
export class Chat extends Base {
  private _conversation: ChatCompletionMessage[] = []
  private readonly _backgroundRuns = new Set<GenerationRun>()
  private _suggestion?: GenerationRun
  private readonly _bridge: ExtensionBridge
  private readonly _context: ChatContextBuilder
  private readonly _generation: ChatGeneration
  private _executionAbort?: AbortController
  private _activeExecution?: ExecutionReconciliationController
  private readonly _search: WorkspaceSearch | undefined
  private readonly _workspaceSearch: WorkspaceSearchProvider | undefined
  private readonly _agents: AgentRegistry
  private _requestAgentSelection: AgentSelection = "off"
  private _activeAgent?: LoadedAgent
  private _activeMcpTools: McpToolSpec[] = []
  private _missingMcpCapabilities: string[] = []
  private _agentToolDiagnostic?: string
  private readonly _steps: ToolSteps
  private readonly _stopSubscription: { dispose(): void }
  /** What agent replies changed, kept so each can be compared or undone from the chat. */
  private _changes?: { store: ChangeStore; editor: ReplyChangesEditor }
  /** The MCP servers in the user's settings, running for this chat. */
  private readonly _mcp = new McpHost(
    () => this.config.get<Record<string, unknown>>("chatToolsMcpServers", {}),
    () => this.workspaceRoot()
  )
  /** A typed message's context is being gathered; its reply has not started. */
  private _preparing = false
  /**
   * Messages the user queued while an agent reply works, offered for the
   * model to read at its next step. Only taken while that reply runs: one
   * offered too late stays the webview's, to send as a turn of its own.
   */
  private _steering: { id: string; text: string }[] = []
  private _steerable = false
  /** Aborted when this chat goes: the commands it started end with it. */
  private readonly _lifetime = new AbortController()
  private readonly _generations: GenerationTracker
  private readonly _extensionContext: ExtensionContext
  private readonly _promptInstructions: PromptInstructionResolver
  private readonly _todoRepository?: TodoRepository
  private _activeConversationId?: string
  /** Explicit draft rewriting; independent of Feedback and of sending. */
  private readonly _promptCompiler: PromptCompiler
  /** TODO planning on the Feedback provider, alongside each agent turn. */
  private readonly _feedbackPlanner: FeedbackPlanner

  constructor(
    generations: GenerationTracker,
    templateDir: string | undefined,
    extensionContext: ExtensionContext,
    bridge: ExtensionBridge,
    search: WorkspaceSearch | undefined,
    agents: AgentRegistry = new AgentRegistry(extensionContext),
    todoRepository?: TodoRepository,
    workspaceSearch?: WorkspaceSearchProvider
  ) {
    super(extensionContext)
    this._generations = generations
    this._extensionContext = extensionContext
    this._todoRepository = todoRepository
    this._promptInstructions = new PromptInstructionResolver(extensionContext)
    this._bridge = bridge
    this._search = search
    this._agents = agents
    this._workspaceSearch = workspaceSearch
    this._steps = new ToolSteps((steps) => {
      const last = steps[steps.length - 1]
      logger.debug(`[ToolSteps] emit count=${steps.length} last=${last ? `${last.id}:${last.status}` : "none"} at=${Date.now()}`)
      bridge.emit(EVENT_NAME.twinnyToolSteps, steps)
    })
    this._promptCompiler = new PromptCompiler({
      enabled: () => isPromptCompilerEnabled(workspace.getConfiguration("twinny")),
      resolve: () => this.roleResolution("Prompt Compiler", promptCompilerProviderSelection(workspace.getConfiguration("twinny")))
    })
    this._feedbackPlanner = new FeedbackPlanner({
      enabled: () => isFeedbackEnabled(workspace.getConfiguration("twinny")),
      resolve: () => this.roleResolution("Feedback", feedbackProviderSelection(workspace.getConfiguration("twinny"))),
      repository: () => this._todoRepository,
      onSnapshot: (snapshot) => this._bridge.emit(TODO_EVENT_NAME.changed, snapshot),
      onStatus: (status) => this._bridge.emit(TODO_EVENT_NAME.feedbackStatus, status),
      onFailure: (message) => this._bridge.emit(EVENT_NAME.twinnyNotification, message)
    })

    // Initialize generation and context
    this._generation = new ChatGeneration(bridge, generations)
    this._context = new ChatContextBuilder(extensionContext, bridge, new TemplateProvider(templateDir), search)
    this._stopSubscription = generations.onDidStop(() => this._steps.cancelWaiting())

this._bridge.handle(EVENT_NAME.twinnyToolInventory, async () => {
  logger.info("twinny-tool-inventory requested");
  try {
    // Ensure MCP is ready before accessing its tools
    await this._mcp.ready();
    const root = workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
    let nativeList: ToolInventoryItem[] = [];
    if (root) {
      // Build a minimal extras object that enables all native tools
      const extras: ToolExtras = {
        workspaceSearch: this._workspaceSearch,
        edits: {
          mode: "apply" as const,
          read: async (): Promise<string | undefined> => undefined,
          edit: async () => ({ ok: true, message: "" }),
          editLines: async () => ({ ok: true, message: "" }),
          create: async () => ({ ok: true, message: "" }),
          remove: async () => ({ ok: true, message: "" }),
          move: async () => ({ ok: true, message: "" }),
        },
        editor: {
          diagnostics: async () => [],
          references: async () => [],
          definition: async () => [],
          rename: async () => ({ ok: true, message: "" }),
          context: async () => ({ openFiles: [] }),
        },
      };
      const nativeTools = workspaceTools(root, [], extras);
      nativeList = nativeTools.tools.map((t) => ({
        name: t.name,
        description: t.description,
        server: "native",
        tool: t.name,
      }));
    }
    const activeConversation = this._extensionContext.globalState.get<Conversation>(ACTIVE_CONVERSATION_STORAGE_KEY)
    const todoInventory = this._todoRepository ? todoTools(
      this._todoRepository,
      {
        projectFingerprint: workspaceProjectFingerprint((workspace.workspaceFolders ?? []).map((folder) => folder.uri.toString(true))),
        conversationId: activeConversation?.id ?? "__todo-inventory__"
      },
      () => undefined
    ).map((tool) => ({ name: tool.name, description: tool.description, server: "native", tool: tool.name })) : []
    nativeList = [...nativeList, ...todoInventory]
    const mcpList = this._mcp.tools.map((t) => ({
      name: t.tool,
      description: t.description,
      server: t.server,
      tool: t.tool,
    }));
    const inventory = [...nativeList, ...mcpList];
    logger.info(`twinny-tool-inventory: native=${nativeList.length} mcp=${mcpList.length} total=${inventory.length}`);
    return inventory;
  } catch (e) {
    logger.error(`twinny-tool-inventory error: ${e}`);
    throw e;
  }
});
}
  
  
  
  public get cancelled(): boolean {
    return this._generation.cancelled
  }
  
  public abort = () => {
    this._steps.cancelWaiting()
    this._feedbackPlanner.cancel("user")
    this._executionAbort?.abort()
    this._activeExecution?.cancel()
    this._generation.abort()
  }

  /** Stop every chat request, including background titles and draft hints. */
  public abortAll = () => {
    this.abort()
    this._promptCompiler.cancelAll("host")
    this._suggestion?.abort()
    for (const run of [...this._backgroundRuns]) run.abort()
  }

  /**
   * Run, Always run or Skip, on a command waiting in the tool steps.
   * Always run keeps that exact command, to run unasked from then on.
   */
  public answerToolApproval(id: string, run: boolean, always = false) {
    const step = this._steps.steps.find((s) => s.id === id)
    if (run && always && step?.approval === "command" && step.command && !currentTeamPolicy()?.agent?.commands) {
      // An MCP tool is kept by name: its arguments differ from call to call.
      const list = step.mcpTool ? GLOBAL_STORAGE_KEY.alwaysRunMcpTools : GLOBAL_STORAGE_KEY.alwaysRunCommands
      const key = `${EVENT_NAME.twinnyGlobalContext}-${list}`
      const kept = this.context?.globalState.get<string[]>(key) ?? []
      const entry = step.mcpTool ?? normalCommand(step.command)
      if (!kept.includes(entry)) void this.context?.globalState.update(key, [...kept, entry])
    }
    this._steps.answer(id, run)
  }

  /**
   * Whether a call to an MCP tool may go ahead: asked in the steps, unless
   * the user chose Always run for that tool (and the team does not ask for
   * every command).
   */
  private approveMcp(detail: string, tool: McpToolSpec): Promise<boolean> {
    const team = currentTeamPolicy()?.agent?.commands
    const name = `${tool.server}/${tool.tool}`
    const kept = this.context?.globalState.get<string[]>(
      `${EVENT_NAME.twinnyGlobalContext}-${GLOBAL_STORAGE_KEY.alwaysRunMcpTools}`
    )
    if (!team && kept?.includes(name)) return Promise.resolve(true)
    return this._steps.approve(detail, "command", { always: !team, mcpTool: name })
  }

  /** Whether a reply is being written now. */
  public get replying(): boolean {
    return this._generation.running || this._preparing
  }

  /**
   * Stop the reply and keep none of it, nor its steps: the user started a
   * new conversation or opened another one while it was being written, or
   * while its context was still being gathered (then it never starts).
   */
  public discardReply() {
    if (!this.replying) return
    this._steps.discard()
    this._generation.discard()
  }

  /**
   * Where what agent replies changed is kept: the workspace's storage,
   * made on first use.
   */
  private changes() {
    if (!this._changes) {
      const storage = (this.context?.storageUri ?? this.context?.globalStorageUri)?.fsPath ?? os.tmpdir()
      const store = new ChangeStore(path.join(storage, "agent-changes"))
      this._changes = { store, editor: new ReplyChangesEditor(store, openDocumentText) }
    }
    return this._changes
  }

  /** A file a reply changed, beside what it was before. */
  public openChange(id: string, file: string) {
    return this.changes().editor.openDiff(id, file)
  }

  /** Put a reply's changed files (all, or `paths`) back as they were. */
  public undoChanges(id: string, paths?: string[]) {
    return this.changes().editor.undo(id, paths)
  }

  /** The stop button on a running command: ends it, and the reply carries on. */
  public stopToolStep(id: string) {
    this._steps.stop(id)
  }

  /** A queued message offered to the agent reply that is working (`text`), or taken back. */
  public steer(id: string, text?: string) {
    this._steering = this._steering.filter((entry) => entry.id !== id)
    if (text?.trim() && this._steerable) this._steering.push({ id, text: text.trim() })
  }

  /** The messages on offer, handed to the model now and shown in the steps where it read them. */
  private takeSteering(): string[] {
    const taken = this._steering
    this._steering = []
    for (const { id, text } of taken) {
      this._steps.said(id, text)
      logger.info(`Chat tools · the user's message reached the model mid-reply (${formatCount(text.length)} chars)`)
    }
    return taken.map(({ text }) => text)
  }

  public dispose() {
    this.abortAll()
    super.dispose()
    this._stopSubscription.dispose()
    this._steps.cancelWaiting()
    this._lifetime.abort()
    this._mcp.dispose()
    this._generation.dispose()
  }

  public resetConversation() {
    this._conversation = []
    this._feedbackPlanner.cancel("conversation-changed")
  }

  /**
   * Feedback plans TODOs from every ordinary user message, compiled or not,
   * on its own provider and alongside the reply. Planning reads the execution
   * prompt, the text the agent acts on. Continuation turns bypass this path,
   * so they keep the plan they continue.
   */
  private startFeedbackPlanning(messages: ChatCompletionMessage[]): Promise<FeedbackPlanOutcome> | undefined {
    const scope = this.activeTodoScope()
    const latest = messages.at(-1)
    if (!scope || latest?.role !== USER) return undefined
    const source = typeof latest.prompt === "string" && latest.prompt.trim() ? latest.prompt : latest.content
    const text = (typeof source === "string" ? source : normalizeText(source))
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .trim()
    if (!text) return undefined
    return this._feedbackPlanner.start(scope, text)
  }

  /**
   * The provider a role runs on: the one its setting names (by ID or
   * label), else the active Feedback provider chosen in the providers
   * panel. A named provider that cannot be found is an error, never a
   * silent switch to another one.
   */
  private async roleProvider(role: "Feedback" | "Prompt Compiler", selection: RoleSelection): Promise<{ provider?: TwinnyProvider; error?: string }> {
    let provider: TwinnyProvider | undefined
    if (selection.provider) {
      const providers = Object.values(await new ProviderStore(this._extensionContext).getProviders())
      provider = resolveProviderEndpoint(findProviderBySelection(providers, selection.provider))
      if (!provider) return { error: `${role} provider "${selection.provider}" is not configured. Choose an existing provider ID or label, or clear the setting.` }
    } else {
      provider = this.getIntentProvider()
      if (!provider) return { error: `${role} has no provider. Select a Feedback provider in Twinny's providers panel or set the ${role === "Feedback" ? "twinny.feedback.provider" : "twinny.promptCompiler.provider"} setting.` }
    }
    return { provider: selection.model ? { ...provider, modelName: selection.model } : provider }
  }

  private async roleResolution(role: "Feedback" | "Prompt Compiler", selection: RoleSelection): Promise<RoleResolution> {
    const { provider, error } = await this.roleProvider(role, selection)
    if (!provider) return { ok: false, error: error ?? `${role} has no provider.` }
    return {
      ok: true,
      endpoint: {
        provider: provider.provider,
        model: provider.modelName,
        label: provider.label,
        infer: async ({ system, user }, { signal, trace }) => {
          try {
            return await readText(resolveInferenceProvider(provider).chat({
              model: provider.modelName,
              messages: [
                ...(system ? [{ role: SYSTEM, content: system }] : []),
                { role: USER, content: user }
              ] as ChatCompletionMessage[]
            }, { signal, trace }))
          } catch (failure) {
            if (isCancelled(failure)) throw failure
            throw new Error(`${role} (${provider.label}): ${describeProviderError(failure, provider)}`)
          }
        }
      }
    }
  }

  /**
   * Rewrites a composer draft on explicit request (Ctrl/Cmd+Click Send).
   * Returns text for the composer only: nothing is sent, and TODOs and
   * feedback are untouched.
   */
  public async compilePrompt(request: PromptCompileRequest): Promise<PromptCompileResult> {
    const settings = workspace.getConfiguration("twinny")
    const limit = promptCompilerMaxTurns(settings, 3)
    const history = request.history ?? []
    const historySummary = summarizeIntentHistory(history, limit)
    logger.debug(`[PromptCompiler] requestId=${request.requestId} historyPairs=${historySummary.pairs.length} maxTurns=${limit} draftChars=${request.prompt.trim().length}`)
    let instructions: { mode: string; source?: string; hash: string } = { mode: "default", hash: "" }
    return this._promptCompiler.compile({
      requestId: request.requestId,
      prompt: request.prompt,
      history: previousPromptHistory(history, limit)
    }, {
      systemPrompt: async () => {
        const resolved = await this._promptInstructions.resolve("intent")
        instructions = { mode: resolved.mode, source: resolved.source, hash: resolved.hash }
        logger.debug("[Prompt] prompt-compiler mode=" + resolved.mode + " order=" + [resolved.content.trim() ? "compiler-base" : "", "compiler-input", "compiler-protocol"].filter(Boolean).join(","))
        return [resolved.content.trim(), PROMPT_COMPILER_PROTOCOL].filter(Boolean).join("\n\n")
      },
      trace: isPromptCompilerTraceEnabled(settings)
        ? async (record) => { await writePromptCompilerTrace(this.context, { ...record, history, maxTurns: limit, instructions }) }
        : undefined
    })
  }

  public cancelPromptCompile(requestId: string) {
    this._promptCompiler.cancel(requestId, "user")
  }

  public async previewPromptInstructions(agentSelection: AgentSelection = "off") {
    const [chatSnapshot, intent] = await Promise.all([this._context.systemPromptSnapshot(), this._promptInstructions.resolve("intent")])
    const chat = chatSnapshot.instructions
    const chatBase = chatSnapshot.prompt
    let agent: LoadedAgent | undefined
    if (agentSelection !== "off" && agentSelection !== "default") {
      agent = await this._agents.load(agentSelection)
    }
    const enabled = agentSelection !== "off"
    const workspaceContext = enabled ? await this.agentWorkspaceContext(this.toolsView()) : ""
    const chatEffective = enabled
      ? composeAgentPrompt(chatBase, agent?.profile.instructions ?? "", workspaceContext)
      : chatBase
    return {
      chat,
      intent,
      chatEffective,
      intentEffective: [intent.content.trim(), PROMPT_COMPILER_PROTOCOL].filter(Boolean).join("\n\n"),
      agentId: agent?.summary.id ?? (agentSelection === "default" ? "default" : undefined),
      agentWarning: agentSelection !== "off" && agentSelection !== "default" && !agent
        ? "The selected agent profile " + agentSelection + " is unavailable."
        : undefined,
      chatRuntimeContext: workspaceContext || "Request-specific workspace, editor, and attachment context is assembled at send time and is not included in this preview.",
      toolGuidance: "Provider tool declarations and Twinny's approval, authorization, workspace-boundary, and credential-protection policies are applied at request time; they are not user-editable Markdown."
    }
  }

  /** A message typed in the chat, with whatever the user attached. */
  public async completion(
    messages: ChatCompletionMessage[],
    mentions?: MentionType[],
    requestedSelection?: AgentSelection,
    conversationId?: string
  ): Promise<string | undefined> {
    this._activeConversationId = conversationId
    const provider = this.start()
    if (!provider) return undefined
    // Gathering context can take a while (a workspace search, the team's
    // policy); a conversation left meanwhile stops this reply too.
    this._preparing = true
    let view: WorkspaceView | undefined
    try {
      this._requestAgentSelection = await this.currentAgentSelection(requestedSelection)
      this._activeAgent = undefined
      this._activeMcpTools = []
      this._missingMcpCapabilities = []
      this._agentToolDiagnostic = undefined
      if (this._requestAgentSelection !== "off" && this._requestAgentSelection !== "default") {
        try {
          this._activeAgent = await this._agents.load(this._requestAgentSelection)
          if (this._activeAgent) {
            const hash = createHash("sha256").update(JSON.stringify({ frontmatter: this._activeAgent.profile.frontmatter, instructions: this._activeAgent.profile.instructions })).digest("hex")
            logger.debug(`[Agent] profile id=${this._activeAgent.summary.id} path=${this._activeAgent.summary.path} sha256=${hash}`)
          }
        } catch (error) {
          logger.warn(`Agent '${this._requestAgentSelection}' could not be loaded: ${error instanceof Error ? error.message : String(error)}`)
        }
        if (!this._activeAgent) {
          await this.setAgentSelection("off")
          this._requestAgentSelection = "off"
          this._bridge.emit(EVENT_NAME.twinnyNotification, "The selected agent is missing, disabled, or invalid. Agent selection was reset to Agent off.")
        }
      }
      // Asked on the developer's own selection, so team policy is current before tools are exposed.
      if (this._requestAgentSelection !== "off") await this.freshTeamPolicy()
      view = this.toolsView()
      const team = currentTeamPolicy()?.agent
      if (view && mcpAllowed(team)) {
        const profile = this._activeAgent?.profile
        const toolMcpNames = profile?.tools?.flatMap((tool) => {
          const separator = tool.indexOf("/")
          const namespace = separator > 0 ? tool.slice(0, separator).toLowerCase() : ""
          return separator > 0 && !["twinny", "vscode", "workspace", "builtin"].includes(namespace)
            ? [tool.slice(0, separator)]
            : []
        }) ?? []
        const explicitNames = [...new Set([...(profile?.mcpServers ?? []), ...toolMcpNames])]
        const hasToolRestriction = profile?.tools !== undefined
        const includesWildcard = profile?.tools?.includes("*") ?? false
        const serverNames = profile && (profile.mcpServers.length > 0 || (hasToolRestriction && !includesWildcard)) ? explicitNames : undefined
        const serverSettings = this.config.get<Record<string, unknown>>("chatToolsMcpServers", {}) ?? {}
        if (serverNames) {
          for (const name of serverNames) {
            const configured = serverSettings[name]
            if (!configured) this._missingMcpCapabilities.push(`${name} (not configured)`)
            else if (typeof configured === "object" && configured !== null && Reflect.get(configured, "enabled") === false) {
              this._missingMcpCapabilities.push(`${name} (disabled)`)
            }
          }
        }
        await this._mcp.ready(serverNames)
        const availableMcpTools = this._mcp.toolsFor(serverNames)
        if (serverNames) {
          for (const name of serverNames) {
            const configured = serverSettings[name]
            if (configured && typeof configured === "object" && Reflect.get(configured, "enabled") !== false && !availableMcpTools.some((tool) => tool.server === name)) {
              this._missingMcpCapabilities.push(`${name} (unavailable or exposes no tools)`)
            }
          }
        }
        this._activeMcpTools = availableMcpTools
      } else if (this._activeAgent) {
        const referenced = new Set([
          ...this._activeAgent.profile.mcpServers,
          ...(this._activeAgent.profile.tools ?? []).flatMap((tool) => {
            const separator = tool.indexOf("/")
            const namespace = separator > 0 ? tool.slice(0, separator).toLowerCase() : ""
            return separator > 0 && !["twinny", "vscode", "workspace", "builtin"].includes(namespace)
              ? [tool.slice(0, separator)]
              : []
          })
        ])
        this._missingMcpCapabilities = [...referenced].map((name) => `${name} (blocked by team policy or no workspace tools are available)`)
      }
      if (this._missingMcpCapabilities.length) {
        this._bridge.emit(EVENT_NAME.twinnyNotification, `Agent MCP capabilities unavailable: ${this._missingMcpCapabilities.join(", ")}`)
      }
      // The first model call must see the plan for this message, so planning
      // is awaited here with a bound; a slower plan still reconciles after the reply.
      if (isFeedbackEnabled(workspace.getConfiguration("twinny"))) {
        const planning = this.startFeedbackPlanning(messages)
        if (planning) await settleWithin(planning, FEEDBACK_PLAN_WAIT_MS)
      }
      this._conversation = await buildChatTurn(messages, {
        systemPrompt: async () => {
          const snapshot = await this._context.systemPromptSnapshot()
          const base = snapshot.prompt
          const baseLayers = [snapshot.hasTeamPolicy ? "team-policy" : "", snapshot.instructions.content.trim() ? "chat-base" : ""].filter(Boolean)
          const agentId = this._activeAgent?.summary.id ?? this._requestAgentSelection
          const taskContext = await this.activeIntentTaskProjection()
          if (this._requestAgentSelection === "off") {
            logger.debug("[Prompt] chat mode=" + snapshot.instructions.mode + " agent=off order=" + [...baseLayers, ...(taskContext ? ["active-intent-task"] : []), "runtime-user-context", ...(view ? ["provider-tool-definitions"] : [])].join(","))
            return taskContext ? base + "\n\n" + taskContext : base
          }
          const workspaceContext = await this.agentWorkspaceContext(view)
          const context = [workspaceContext, taskContext].filter(Boolean).join("\n\n")
          const layers = [...baseLayers]
          if (this._activeAgent?.profile.instructions.trim()) layers.push("agent-profile")
          if (workspaceContext.trim()) layers.push("workspace-context")
          if (taskContext) layers.push("active-intent-task")
          if (this._missingMcpCapabilities.length) layers.push("mcp-capability-notes")
          layers.push("runtime-user-context")
          if (view) layers.push("provider-tool-definitions")
          logger.debug("[Prompt] chat mode=" + snapshot.instructions.mode + " agent=" + agentId + " order=" + layers.join(","))
          return composeAgentPrompt(base, this._activeAgent?.profile.instructions ?? "", context, [...this._missingMcpCapabilities, ...(this._agentToolDiagnostic ? [this._agentToolDiagnostic] : [])])
        },
        additionalContext: async (question, sources, history) => {
          const context = await this._context.additionalContext(question, sources, mentions, history)
          // With tools, where the user is in the editor comes with the
          // question, so "this function" needs no tool call to place.
          const hint = view ? editorHint(view) : ""
          return hint ? `${hint}\n\n${context}` : context
        }
      })
    } finally {
      this._preparing = false
    }
    return this.run(provider, "", view)
  }

  /** A code action (explain, refactor…) run over the editor selection. */
  public async templateCompletion(template: string, context?: string) {
    const provider = this.start()
    if (!provider) return ""
    this._conversation = await this.buildTemplateConversation(template, context)
    return this.run(provider)
  }

  /**
   * A question raised by a command rather than typed: shown in the chat as
   * if the user had sent `display`, answered from `prompt` with `attached`
   * code, and kept in the conversation so follow-ups work.
   */
  public async ask(
    display: string,
    prompt: string,
    attached: ContextEntry[] = []
  ): Promise<string> {
    const provider = this.start()
    if (!provider) return ""
    const code = formatContextEntries(attached)
    const content = (code ? `${prompt}\n\nAttached code:\n\n${code}` : prompt).trim()
    this._bridge.emit(EVENT_NAME.twinnySetTab, WEBUI_TABS.chat)
    this._bridge.emit(EVENT_NAME.twinnyAddMessage, {
      role: USER,
      content: display,
      prompt: content
    })
    if (!this._conversation.length) {
      this._conversation = [
        { role: SYSTEM, content: await this._context.systemPrompt() }
      ]
    }
    this._conversation = [
      ...this._conversation,
      { role: USER, content }
    ]
    return this.run(provider)
  }

  /**
   * Stream a reply to exactly these messages, skipping the chat's own prompt
   * building (system prompt, editor selection, workspace context). The reply
   * is shown in the chat as it arrives and returned when complete.
   */
  public async streamMessages(
    messages: ChatCompletionMessage[],
    prefix = ""
  ): Promise<string> {
    const provider = this.start()
    if (!provider) return ""
    this._conversation = messages
    return this.run(provider, prefix)
  }

  /** One-shot, no UI: used for conversation titles and commit messages. */
  public async generateSimpleCompletion(
    prompt: string
  ): Promise<string | undefined> {
    const provider = this.getProvider()
    if (!provider) {
      logger.error("No chat provider configured.")
      return undefined
    }
    const run = this._generations.start("completion")
    this._backgroundRuns.add(run)
    try {
      const content = await readText(
        resolveInferenceProvider(provider).chat(
          {
            model: provider.modelName,
            messages: [{ role: USER, content: prompt }]
          },
          { signal: run.signal }
        )
      )
      return stripThinking(content) || undefined
    } catch (error) {
      if (!isCancelled(error)) {
        logger.error(
          `Simple completion failed: ${describeProviderError(error, provider)}`
        )
      }
      return undefined
    } finally {
      run.finish()
      this._backgroundRuns.delete(run)
    }
  }

  /**
   * The rest of the message the user is typing, as the model guesses it
   * from the last few turns, for the composer's grey text. A newer call
   * cancels the one before; any failure is just no guess.
   */
  public async suggestDraft(draft: string, recent: ComposerTurn[]): Promise<string> {
    this._suggestion?.abort()
    const provider = this.getProvider()
    if (!provider || !draft.trim()) return ""
    const run = this._generations.start("completion")
    this._backgroundRuns.add(run)
    this._suggestion = run

    try {
      const reply = await readText(
        resolveInferenceProvider(provider).chat(
          {
            model: provider.modelName,
            messages: composerSuggestionMessages(draft, recent),
            maxTokens: SUGGESTION_MAX_TOKENS,
            temperature: 0,
            think: false
          },
          { signal: run.signal }
        )
      )
      if (run.signal.aborted) return ""
      return cleanModelSuggestion(draft, stripThinking(reply))
    } catch (error) {
      if (!isCancelled(error)) {
        logger.debug(`Composer suggestion failed: ${describeProviderError(error, provider)}`)
      }
      return ""
    } finally {
      run.finish()
      this._backgroundRuns.delete(run)
      if (this._suggestion === run) this._suggestion = undefined
    }
  }

  /* ------------------------------------------------------------------------ */
  /*  Internals                                                                */
  /* ------------------------------------------------------------------------ */

  /**
   * Re-reads the team's policy (at most once a minute, by the provider
   * manager), so an admin's change to the agent rules holds from the next
   * agent reply rather than the next VS Code start. A slow gateway is not
   * waited on for long: what was agreed holds meanwhile.
   */
  public refreshTeamPolicy?: () => Promise<void>

  private async freshTeamPolicy() {
    if (!this.refreshTeamPolicy || !currentTeamState()) return
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      this.refreshTeamPolicy().catch(() => undefined),
      new Promise<void>((resolve) => (timer = setTimeout(resolve, POLICY_REFRESH_WAIT_MS)))
    ])
    clearTimeout(timer)
  }

  /** Common preamble: clear the stop flag, tell the webview the language. */
  private start(): TwinnyProvider | undefined {
    this._generation.reset()
    this._bridge.emit(EVENT_NAME.twinnySendLanguage, getLanguage())
    return this.getProvider()
  }

  /**
   * Agent selection, as the composer's picker left it (stored the way the webview
   * stores global values). Until it is first switched, `twinny.chatTools`.
   */
  private agentMode(): boolean {
    return !currentTeamPolicy()?.agent?.off && isAgentSelectionEnabled(this._requestAgentSelection)
  }

  private async currentAgentSelection(requested?: AgentSelection): Promise<AgentSelection> {
    const state = this.context?.globalState
    const key = `${EVENT_NAME.twinnyGlobalContext}-${AGENT_SELECTION_STORAGE_KEY}`
    const stored = state?.get<unknown>(key)
    const legacy = selectionFromLegacyAgentMode(
      state?.get<unknown>(`${EVENT_NAME.twinnyGlobalContext}-${GLOBAL_STORAGE_KEY.agentMode}`)
    )
    const defaultSelection = this.config.get<{ defaultSelection?: "off" | "default" }>("agents", {})?.defaultSelection
    const selection = resolveAgentSelection(
      requested,
      stored,
      legacy,
      this.config.get<boolean>("chatTools", false),
      defaultSelection
    )
    if (normalizeAgentSelection(stored) !== selection) {
      await state?.update(key, selection)
      this._bridge.emit(EVENT_NAME.twinnyGlobalContext, { key: AGENT_SELECTION_STORAGE_KEY, value: selection })
    }
    return selection
  }

  private async setAgentSelection(selection: AgentSelection): Promise<void> {
    const key = `${EVENT_NAME.twinnyGlobalContext}-${AGENT_SELECTION_STORAGE_KEY}`
    await this.context?.globalState.update(key, selection)
    this._bridge.emit(EVENT_NAME.twinnyGlobalContext, { key: AGENT_SELECTION_STORAGE_KEY, value: selection })
  }

  private async agentWorkspaceContext(view?: WorkspaceView): Promise<string> {
    const folders = workspace.workspaceFolders?.slice(0, 1) ?? []
    if (!folders.length) return "No workspace folder is open."
    let filesByRoot: Uri[][]
    try {
      filesByRoot = await Promise.all(folders.map((folder) => workspace.findFiles(
        new RelativePattern(folder, "**/*"),
        "**/{.git,node_modules,.venv,dist,build}/**,**/.env*,**/*.{pem,key,p12,pfx}",
        101
      )))
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      logger.warn(`Agent workspace inventory could not be generated: ${detail}`)
      return `Runtime workspace context (generated for this request): inventory unavailable: ${detail}`
    }
    const entries = folders.map((folder, index) => {
      const base = folder.uri.path.replace(/\/$/, "")
      const files = filesByRoot[index] ?? []
      const relative = files
        .filter((file) => file.path.startsWith(`${base}/`))
        .map((file) => file.path.slice(base.length + 1))
        .filter((name) => !/(^|\/)(\.git|node_modules|\.venv|secrets?)(\/|$)|(^|\/)\.env|\.(pem|key|p12|pfx)$/i.test(name))
        .filter((name) => index !== 0 || !view || view.visible(path.join(view.root, name)))
      return `Workspace root: ${folder.uri.toString()}\nPaths are relative to this root on the workspace extension host (including Remote/SSH workspaces). Current bounded file inventory:\n${relative.slice(0, 100).map((name) => `- ${name}`).join("\n")}${relative.length > 100 || files.length > 100 ? "\n- (inventory truncated; inspect with permitted tools)" : ""}`
    })
    const toolRootNote = folders.length > 1
      ? `Twinny's existing workspace tools operate on the first root (${folders[0].uri.toString()}); additional roots are listed for context only.`
      : "Use the listed workspace root for every relative path."
    return `Runtime workspace context (generated for this request):\n${entries.join("\n\n")}\n\n${toolRootNote}`
  }
  /**
   * Whether a command asks first: not when the composer's auto-run switch
   * is on (until it is first switched, `twinny.chatToolsCommands`), nor
   * when the user chose Always run for that exact command. Read for each
   * command, so either holds for the rest of the reply.
   */
  private commandMode(setting: ChatCommandMode, command: string): "ask" | "allow" {
    // A team that asks for every command is asked for every command.
    if (currentTeamPolicy()?.agent?.commands) return "ask"
    const state = this.context?.globalState
    const stored = state?.get<boolean>(`${EVENT_NAME.twinnyGlobalContext}-${GLOBAL_STORAGE_KEY.autoRunCommands}`)
    if (stored ?? setting === "allow") return "allow"
    const kept = state?.get<string[]>(`${EVENT_NAME.twinnyGlobalContext}-${GLOBAL_STORAGE_KEY.alwaysRunCommands}`)
    return kept?.includes(normalCommand(command)) ? "allow" : "ask"
  }

  /** The folder agent mode works in: the first workspace folder. */
  protected workspaceRoot(): string | undefined {
    return workspace.workspaceFolders?.[0]?.uri.fsPath
  }

  /**
   * The workspace as the tools will see it, when the user has tools on
   * and a folder open. Made once per reply: its ignore rules are read at
   * the start and hold until the end.
   */
  private toolsView(): WorkspaceView | undefined {
    if (!this.agentMode()) return undefined
    const root = this.workspaceRoot()
    if (!root) return undefined
    return new WorkspaceView(
      root,
      this.config.get<string[]>("embeddingIgnoredGlobs", []),
      openDocumentText,
      currentTeamPolicy()?.agent?.blockedPaths ?? []
    )
  }

  public async evaluateTodoTask(scope: TodoListRequest, itemId: string): Promise<TodoListSnapshot> {
    await this.reviewTodoTasks(scope, itemId)
    return this._todoRepository!.getList(scope)
  }

  /** Re-runs Feedback planning for the conversation's last message after a failure. */
  public async retryFeedback(conversationId: string): Promise<FeedbackPlanOutcome> {
    return this._feedbackPlanner.retry(conversationId)
  }

  private async reviewTodoTasks(
    scope: TodoListRequest,
    itemId?: string,
    changes?: ReplyChangesView,
    options: { strict?: boolean; finalResponse?: string; requireWorkspaceChanges?: boolean; signal?: AbortSignal } = {}
  ): Promise<TodoEvaluation[]> {
    if (!this._todoRepository) return []
    const reviews = await this._todoRepository.getReviewPackages(scope)
    const candidates = itemId
      ? reviews.filter((review) => review.task.id === itemId)
      : reviews.filter((review) => !review.lastEvaluation || review.lastEvaluation.metadata.taskVersion !== review.task.version - 1)
    if (!candidates.length) {
      if (itemId) throw new Error("This TODO is not awaiting evaluation")
      return []
    }
    const { provider, error: providerError } = await this.roleProvider("Feedback", feedbackProviderSelection(workspace.getConfiguration("twinny")))
    if (!provider) {
      const message = "Feedback evaluation is unavailable: " + (providerError ?? "no Feedback provider is configured.")
      logger.warn(message)
      if (itemId || options.strict) throw new Error(message)
      this._bridge.emit(EVENT_NAME.twinnyNotification, message)
      return []
    }
    let providerFailure: string | undefined
    const evaluations = await Promise.all(candidates.map(async (review) => {
      try {
        const evaluation = await evaluateTodoReview(this._todoRepository!, scope, review, async (correction) => {
          const controller = new AbortController()
          let timeout: ReturnType<typeof setTimeout>
          const abortFromExecution = () => controller.abort(options.signal?.reason)
          if (options.signal?.aborted) abortFromExecution()
          else options.signal?.addEventListener("abort", abortFromExecution, { once: true })
          const timedOut = new Promise<never>((_, reject) => {
            timeout = setTimeout(() => {
              const error = new Error("Feedback evaluator timed out after 30 seconds")
              controller.abort(error)
              reject(error)
            }, 30_000)
          })
          try {
            try {
              return await Promise.race([readText(resolveInferenceProvider(provider).chat({
              model: provider.modelName,
              messages: [
                { role: SYSTEM, content: todoReviewSystemPrompt },
                { role: USER, content: todoReviewInput(review, candidates.length === 1 ? changes : undefined, options.finalResponse) + (correction ? "\n\nCorrection required: " + correction : "") }
              ] as ChatCompletionMessage[]
            }, { signal: controller.signal, trace: { operationId: `feedback-evaluation-${randomUUID()}`, operationKind: "feedback", requestId: `request-${randomUUID()}`, provider: provider.provider } })), timedOut])
            } catch (error) {
              throw new TodoEvaluationProviderError(redact(isCancelled(error) ? "Feedback evaluation was cancelled" : describeProviderError(error, provider)))
            }
          } finally {
            clearTimeout(timeout!)
            options.signal?.removeEventListener("abort", abortFromExecution)
          }
        }, provider.modelName, {
          requireWorkspaceChanges: options.requireWorkspaceChanges && taskRequiresWorkspaceChanges(review.task, review.acceptanceCriteria),
          hasVerifiedFileChanges: !!changes?.files.length,
          allowEvidenceFreeAnalysis: isAnalysisOnlyGoal(review.goal)
        })
        logger.info("Feedback evaluation " + evaluation.decision + " for TODO " + review.task.id)
        const snapshot = await this._todoRepository!.getList(scope)
        this._bridge.emit(TODO_EVENT_NAME.changed, snapshot)
        return evaluation
      } catch (error) {
        logger.warn("Feedback evaluation failed for TODO " + review.task.id + " (" + (error instanceof TodoEvaluationProviderError ? "provider" : "validation/parsing") + "): " + redact(error instanceof Error ? error.message : String(error)))
        if (itemId || options.strict) throw error
        if (error instanceof TodoEvaluationProviderError && !options.signal?.aborted) providerFailure ??= error.message
        return undefined
      }
    }))
    if (providerFailure) this._bridge.emit(EVENT_NAME.twinnyNotification, "Feedback evaluation failed (" + provider.label + "): " + providerFailure)
    return evaluations.filter((evaluation): evaluation is TodoEvaluation => !!evaluation)
  }

  private async reconcileIntentTurn(
    scope: TodoListRequest,
    intent: NonNullable<Awaited<ReturnType<TodoRepository["getActiveIntentContext"]>>>,
    finalResponse: string,
    changes: ReplyChangesView | undefined,
    view: WorkspaceView | undefined,
    workflow: ExecutionReconciliationController,
    recovery?: EditRecoveryNotice
  ): Promise<string | undefined> {
    if (!this._todoRepository || this.cancelled || workflow.isCancelled()) {
      if (this.cancelled) workflow.cancel()
      return undefined
    }
    if (recovery && (!recovery.fileVerified || !recovery.diagnosticsVerified)) {
      workflow.reconcile("blocked", recovery.reason)
      const state = recovery.fileVerified
        ? "File contents were restored and verified, but diagnostic verification was " + recovery.diagnosticsStatus + "."
        : "File contents could not be safely restored."
      this._bridge.emit(EVENT_NAME.twinnyAddMessage, { role: ASSISTANT, content: `Execution is blocked after edit recovery. ${state} ${recovery.reason}` })
      return undefined
    }

    const goal = intent.goal
    const requireChanges = requiresWorkspaceChanges(goal)
    let evaluation: TodoEvaluation | undefined
    let reviewFailure: string | undefined
    const before = await this._todoRepository.getList({ ...scope, includeCompleted: true })
    let current = before.items.find((item) => item.id === intent.task.id)

    if (current && current.status !== "completed" && current.status !== "cancelled" && current.status !== "blocked") {
      if (current.status !== "in_review") {
        current = await this._todoRepository.updateItem(scope, {
          itemId: current.id,
          expectedVersion: current.version,
          patch: { status: "in_review" },
          actor: "model",
          requestId: randomUUID()
        })
      }
      const reviewId = "feedback.review." + intent.planTaskId
      this._steps.review(reviewId, `Feedback reviewing \`${intent.task.title}\``, "running")
      try {
        const results = await this.reviewTodoTasks(scope, current.id, changes, {
          strict: true,
          finalResponse,
          requireWorkspaceChanges: requireChanges,
          signal: this._executionAbort?.signal
        })
        evaluation = results.find((result) => result.taskId === intent.planTaskId)
        if (!evaluation) throw new Error("Independent evaluator returned no decision for the active task")
      } catch (error) {
        reviewFailure = error instanceof Error ? error.message : String(error)
        logger.error("[Execution] independent evaluation failed (" + (error instanceof TodoEvaluationProviderError ? "provider" : "validation/parsing") + "): " + redact(reviewFailure))
      }
      const accepted = !reviewFailure && evaluation?.decision === "accept"
      const verdict = reviewFailure
        ? `Feedback could not evaluate \`${intent.task.title}\`: ${reviewFailure}`
        : accepted
          ? `Feedback accepted \`${intent.task.title}\``
          : `Feedback ${evaluation?.decision === "blocked" ? "blocked" : "rejected"} \`${intent.task.title}\`${evaluation?.explanation ? `: ${evaluation.explanation}` : ""}`
      this._steps.review(reviewId, verdict.slice(0, 300), accepted ? "done" : "failed", verdict.length > 300 ? verdict : undefined)
    }

    if (this.cancelled || workflow.state === "cancelled") {
      workflow.cancel()
      return undefined
    }

    const after = await this._todoRepository.getList({ ...scope, includeCompleted: true })
    current = after.items.find((item) => item.id === intent.task.id)
    if (reviewFailure && current?.status === "in_review") {
      current = await this._todoRepository.updateItem(scope, {
        itemId: current.id,
        expectedVersion: current.version,
        patch: { status: "in_progress" },
        actor: "model",
        requestId: randomUUID()
      })
    }

    const allPlanTasks = after.items.filter((item) => item.source === "intent_compiler")
    const outstandingPlanTasks = allPlanTasks.filter((item) => item.status !== "completed")
    if (reviewFailure) {
      const reason = "Independent evaluator could not validate this task; no decision was persisted. " + reviewFailure
      workflow.reconcile("blocked", "evaluation-failed:" + intent.planTaskId)
      this._bridge.emit(EVENT_NAME.twinnyAddMessage, { role: ASSISTANT, content: "Execution is blocked: " + reason.slice(0, 800) })
      logger.warn("[Execution] progression blocked because evaluation failed for " + intent.planTaskId)
      return undefined
    }
    if (evaluation?.decision === "blocked" || current?.status === "blocked") {
      const reason = evaluation?.explanation ?? current?.blockedReason ?? "The active task is blocked."
      const alternative = evaluation?.decision === "blocked" ? undefined : await this._todoRepository.getActiveIntentContext(scope)
      if (!alternative || alternative.planTaskId === intent.planTaskId) {
        workflow.reconcile("blocked", "blocked:" + intent.planTaskId)
        this._bridge.emit(EVENT_NAME.twinnyAddMessage, {
          role: ASSISTANT,
          content: `Execution is blocked: ${reason.slice(0, 800)}`
        })
        logger.warn("[Execution] blocked: " + reason)
        return undefined
      }
      logger.warn("[Execution] task blocked; continuing with independent task " + alternative.planTaskId + ": " + reason)
    }

    if (allIntentTasksComplete(allPlanTasks.map((task) => task.status))) {
      workflow.reconcile("accept", `accepted:${intent.planId}:${intent.revision}`)
      logger.info("[Execution] accepted after all intent-plan tasks were completed")
      return undefined
    }

    if (evaluation?.decision === "revise" || evaluation?.decision === "needs_evidence") {
      if (current?.status === "in_review") {
        current = await this._todoRepository.updateItem(scope, {
          itemId: current.id,
          expectedVersion: current.version,
          patch: { status: "in_progress" },
          actor: "model",
          requestId: randomUUID()
        })
      }
    }

    const next = await this._todoRepository.getActiveIntentContext(scope)
    if (!next) {
      const reasons = outstandingPlanTasks.map((task) => `${task.title} (${task.status})`).slice(0, 5)
      const reason = `No eligible task remains; unresolved plan tasks: ${reasons.join(", ")}`
      workflow.reconcile("blocked", reason)
      this._bridge.emit(EVENT_NAME.twinnyAddMessage, { role: ASSISTANT, content: `Execution is blocked: ${reason}.` })
      logger.warn("[Execution] blocked: " + reason)
      return undefined
    }

    // Progress is new evidence for the task still open, not the files a reply touched.
    const progress = `${next.planTaskId}|${next.task.status}`
    const decision = evaluation?.decision === "revise" ? "revise" : "needs_evidence"
    const passedCriteria = evaluation?.criteria.filter((criterion) => criterion.status === "passed").map((criterion) => criterion.criterion) ?? []
    const outcome = evaluation?.decision === "accept"
      ? workflow.advanceAcceptedTask(progress)
      : workflow.reconcile(decision, progress, workflow.recordEvidence({ observations: next.observations ?? [], passedCriteria }))
    if (!outcome.continue) {
      const reason = outcome.reason ?? "The autonomous execution retry budget was exhausted."
      this._bridge.emit(EVENT_NAME.twinnyAddMessage, { role: ASSISTANT, content: `Execution stopped: ${reason}` })
      logger.warn("[Execution] stopped: " + reason)
      return undefined
    }

    const feedback = recovery?.restored
      ? [recovery.reason, "Diagnostics: " + recovery.diagnostics, "The regression was rolled back. Reinspect diagnostics before making a corrected edit."]
      : reviewFailure
        ? [`Independent evaluation failed: ${reviewFailure}. Do not treat this as approval; continue with verifiable work.`]
        : evaluation?.decision === "accept"
        ? [`The prior task was accepted. Begin the next unresolved task now: ${next.task.title}. Use the verified observations below instead of repeating source discovery.`]
        : [
            ...(evaluation?.problems ?? ["The requested outcome is not yet demonstrated."]),
            ...(evaluation?.correctiveInstructions ?? []),
            ...(evaluation?.criteria.filter((criterion) => criterion.status !== "passed").map((criterion) => `${criterion.status}: ${criterion.criterion}`) ?? [])
          ]
    if (view === undefined && requireChanges) feedback.push("No workspace editing tools are currently available; do not claim implementation completion.")
    const outline = await this._todoRepository.getPlanOutline(scope)
    const todoTargets = (outline?.tasks ?? [])
      .filter((task) => task.status !== "completed" && task.status !== "cancelled")
      .slice(0, 6)
      .map((task) => {
        const needs = task.unmetCriteria.length ? ` — needs evidence: ${task.unmetCriteria.slice(0, 3).join("; ")}` : ""
        const problem = task.problems.length ? ` — problem: ${task.problems[0]}` : ""
        return `${task.itemId} (version ${task.version}, ${task.status}): ${task.title}${needs}${problem}`
      })
    return continuationContext({
      goal,
      constraints: intent.constraints,
      task: `${next.task.title}${next.task.details ? ` — ${next.task.details}` : ""}`,
      todoTargets,
      criteria: next.acceptanceCriteria,
      feedback,
      verifiedObservations: [
        ...(intent.observations ?? []).filter((observation) => !observation.failed).slice(0, 5).map((observation) => {
          const path = observation.arguments.path ?? observation.arguments.file
          return observation.toolName + (path ? " " + path : "") + ": " + observation.output.slice(0, 240)
        }),
        ...(changes?.files ?? []).slice(0, 5).map((file) => "Current reply change: " + file.path + " (" + file.status + ", +" + file.added + "/-" + file.removed + ")")
      ],
      failedActions: (intent.observations ?? []).filter((observation) => observation.failed).slice(0, 3).map((observation) =>
        observation.toolName + " " + JSON.stringify(observation.arguments) + ": " + observation.output.slice(0, 240)
      ),
      finalResponse
    })
  }

  private activeTodoScope(): TodoListRequest | undefined {
    if (!this._todoRepository || !this._activeConversationId) return undefined
    return {
      projectFingerprint: workspaceProjectFingerprint((workspace.workspaceFolders ?? []).map((folder) => folder.uri.toString(true))),
      conversationId: this._activeConversationId
    }
  }

  private async planRequestContext(): Promise<string | undefined> {
    const scope = this.activeTodoScope()
    if (!scope || !this._todoRepository) return undefined
    try {
      const outline = await this._todoRepository.getPlanOutline(scope)
      return outline && outline.tasks.length ? renderPlanContext(outline) : undefined
    } catch (error) {
      logger.warn(`[Intent] Could not load the TODO plan for this request: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  private async activeIntentTaskProjection(): Promise<string> {
    if (!isFeedbackEnabled(workspace.getConfiguration("twinny"))) return ""
    const scope = this.activeTodoScope()
    if (!scope || !this._todoRepository) return ""
    try {
      const active = await this._todoRepository.getActiveIntentContext(scope)
      if (!active) return ""
      const clip = (value: string, limit: number) => value.length > limit ? value.slice(0, limit - 1) + "…" : value
      const projection = {
        type: "twinny_active_intent_task",
        feedbackIsNonAuthoritative: true,
        plan: { id: active.planId, revision: active.revision, goal: clip(active.goal, 400) },
        constraints: active.constraints.slice(0, 3).map((value) => clip(value, 160)),
        task: {
          id: active.planTaskId,
          todoItemId: active.task.id,
          title: clip(active.task.title, 180),
          description: clip(active.task.details ?? "", 400),
          status: active.task.status,
          acceptanceCriteria: active.acceptanceCriteria.slice(0, 6).map((value) => clip(value, 180)),
          acceptanceCriteriaTruncated: active.acceptanceCriteria.length > 6,
          dependencies: active.dependencies.slice(0, 3).map((dependency) => ({
            id: dependency.id,
            title: clip(dependency.title, 120),
            status: dependency.status
          })),
          previousEvidence: active.evidence.slice(0, 2).map((evidence) => ({
            id: evidence.id,
            kind: clip(evidence.kind, 80),
            result: evidence.result,
            summary: clip(evidence.summary, 220)
          })),
          feedback: feedbackContext(active) || undefined
        }
      }
      return "Active task from Twinny's native TODO plan (context only; preserve all other instructions):\n" + JSON.stringify(projection)
    } catch (error) {
      logger.warn(`[Intent] Could not load active task context: ${error instanceof Error ? error.message : String(error)}`)
      return ""
    }
  }

  /**
   * Send the conversation; the reply joins it, so the next turn follows on.
   * With a `view`, the model may work in the workspace first.
   */
  private async run(
    provider: TwinnyProvider,
    prefix = "",
    view?: WorkspaceView,
    workflow?: ExecutionReconciliationController,
    checkpoints?: SafeEditCheckpoints
  ): Promise<string> {
    if (!workflow) this._executionAbort = new AbortController()
    const execution = workflow ?? new ExecutionReconciliationController({
      maxIterations: clampNumericSetting(this.config.get<number>("chatToolsReconciliationMaxIterations", 12), 1, 20, 12),
      maxNoProgress: clampNumericSetting(this.config.get<number>("chatToolsReconciliationMaxNoProgressTurns", 2), 1, 5, 2)
    })
    if (!workflow) this._activeExecution = execution
    let toolNotes: string | undefined
    let instructionFiles = (): string[] => []
    let tracked: ReplyChanges | undefined
    let changed: ReplyChangesView | undefined
    let recoveryNotice: EditRecoveryNotice | undefined
    const activeCheckpoints = checkpoints ?? (view ? createSafeEditCheckpoints(this._extensionContext.globalStorageUri) : undefined)
    const usage: ToolLoopUsage = {}
    let outOfSteps = false
    // Asked now, so the reply can say how much of the context it used.
    void contextWindowOf(provider)
    this._steering = []
    this._steerable = !!view
    const hooks = {
      onNotes: (notes: string | undefined) => (toolNotes = notes),
      onUsage: (counted: ToolLoopUsage) => Object.assign(usage, counted),
      onTools: (tools: WorkspaceTools) => (instructionFiles = () => tools.instructionFiles?.() ?? []),
      onChanges: (changes: ReplyChanges) => (tracked = changes),
      onOutOfSteps: () => (outOfSteps = true),
      onToolResult: async (call: ToolCall, result: ToolResult) => {
        if (!this._todoRepository || call.name.startsWith("twinny_todo_") || (call.name === "run_command" && !result.execution)) return
        const scope = this.activeTodoScope()
        if (!scope) return
        const invocationId = randomUUID()
        const evidence = compactToolEvidence({
          name: call.name,
          args: call.args,
          output: result.execution?.output ?? result.output,
          failed: result.failed ?? false,
          exitCode: result.execution?.exitCode,
          invocationId
        })
        let itemId: string | undefined
        try {
          const active = await this._todoRepository.getActiveIntentContext(scope)
          if (!active) return
          itemId = active.task.id
          await this._todoRepository.recordToolObservation(scope, {
            itemId,
            toolName: call.name,
            arguments: compactArguments(evidence),
            output: compactEvidenceText(evidence),
            failed: evidence.failed,
            exitCode: evidence.exitCode,
            requestId: invocationId
          })
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          logger.error(`[Todo] todo.evidence.missing ${JSON.stringify({ tool_name: call.name, invocation_id: invocationId, reason })}`)
          if (itemId) {
            await this._todoRepository.addEvidence(scope, {
              itemId,
              kind: "evidence_storage_failed",
              summary: `Result of ${call.name} (${invocationId}) was not recorded as evidence: ${reason}`.slice(0, 400),
              result: "failed",
              requestId: randomUUID()
            }).catch((storageError: unknown) => logger.error("[Todo] could not record the evidence storage failure: " + String(storageError)))
          }
        }
      }
    }
    const todoScope = this.activeTodoScope()
    const intentAtStart = todoScope && this._todoRepository ? await this._todoRepository.getActiveIntentContext(todoScope) : undefined
    // Native TODO actions are conversation-scoped and do not require workspace Agent mode.
    const todoOnly = !view && !!todoScope
    const onCatastrophic = async (notice: EditRecoveryNotice) => {
      recoveryNotice = notice
      if (!notice.fileVerified) logger.error("[Execution] edit recovery failed to restore file contents: " + notice.reason)
      else if (!notice.diagnosticsVerified) logger.warn("[Execution] file contents restored; diagnostic verification " + notice.diagnosticsStatus + ": " + notice.reason)
      if (todoScope && intentAtStart && this._todoRepository) {
        await this._todoRepository.addEvidence(todoScope, {
          itemId: intentAtStart.task.id,
          kind: "automatic_edit_recovery",
          summary: `${notice.reason}\nFile verified: ${notice.fileVerified}; diagnostics: ${notice.diagnosticsStatus}.\n${notice.diagnostics}`.slice(0, 2000),
          result: notice.fileVerified ? "observed" : "failed",
          requestId: randomUUID()
        })
        await this._todoRepository.recordToolObservation(todoScope, {
          itemId: intentAtStart.task.id,
          toolName: "automatic_edit_recovery",
          arguments: { fileVerified: String(notice.fileVerified), diagnosticsVerified: String(notice.diagnosticsVerified) },
          output: `${notice.reason}\nFile verified: ${notice.fileVerified}; diagnostics: ${notice.diagnosticsStatus}.\n${notice.diagnostics}`.slice(0, 2000),
          failed: !notice.fileVerified || !notice.diagnosticsVerified,
          requestId: randomUUID()
        })
      }
    }
    const client = view
      ? this.toolsClient(provider, view, hooks, intentAtStart?.goal, activeCheckpoints, onCatastrophic)
      : todoOnly && todoScope
        ? this.todoToolsClient(provider, todoScope, hooks)
        : resolveInferenceProvider(provider)
    const reply = await this._generation.generate(
      client,
      { model: provider.modelName, messages: this._conversation },
      provider,
      prefix,
      {
        toolNotes: () => toolNotes,
        keepEmpty: () => (!!view || todoOnly) && this._steps.steps.length > 0,
        // What the reply changed, read once it is over and kept for undo.
        settle: async () => {
          if (!tracked?.touched) return
          const record = await tracked.record()
          if (!record) return
          try {
            this.changes().store.save(record)
            changed = viewOf(record)
          } catch (error) {
            logger.warn(`Chat · could not keep what the reply changed: ${error}`)
          }
        },
        changes: () => changed,
        meta: () => {
          const contextWindow = knownContextWindow(provider)
          const instructions = instructionFiles()
          return {
            ...(instructions.length ? { instructions } : {}),
            ...(usage.promptTokens ? { promptTokens: usage.promptTokens } : {}),
            ...(usage.completionTokens ? { completionTokens: usage.completionTokens } : {}),
            ...(contextWindow ? { contextWindow } : {}),
            ...(outOfSteps ? { outOfSteps: true } : {})
          }
        }
      }
    ).finally(() => {
      this._steerable = false
      this._steering = []
    })
    if (reply) {
      this._conversation = [
        ...this._conversation,
        { role: ASSISTANT, content: reply }
      ]
    }
    const feedbackEnabled = isFeedbackEnabled(workspace.getConfiguration("twinny"))
    if (this.cancelled) execution.cancel()
    let intentForTurn = intentAtStart
    // A plan started with this message is written alongside the reply; it
    // is awaited (bounded, and cancelled with the turn) before reconciling.
    if (!intentForTurn && reply !== undefined && !this.cancelled && feedbackEnabled && todoScope && this._todoRepository) {
      const planning = this._feedbackPlanner.pending()
      if (planning) {
        const outcome = await planning
        logger.debug("[Feedback] plan outcome for this turn: " + outcome.status)
        if (outcome.status === "planned" && !this.cancelled) {
          intentForTurn = await this._todoRepository.getActiveIntentContext(todoScope)
        }
      }
    }
    if (reply !== undefined && !this.cancelled && feedbackEnabled && todoScope && intentForTurn) {
      const priorSteps = new Set(this._steps.steps)
      const continuation = await this.reconcileIntentTurn(todoScope, intentForTurn, reply, changed, view, execution, recoveryNotice)
      // Reviews run after this reply was saved; the webview attaches them to it.
      const late = this._steps.steps.filter((step) => step.name === "feedback" && !priorSteps.has(step))
      if (late.length) this._bridge.emit(EVENT_NAME.twinnyReplySteps, late)
      if (continuation && execution.claimContinuation() && !this.cancelled) {
        this._conversation = [...this._conversation, { role: USER, content: continuation }]
        logger.info("[Execution] continuing automatically after independent reconciliation")
        execution.continuationStarted()
        return this.run(provider, CONTINUATION_PREFIX, view, execution, activeCheckpoints)
      }
    } else if (reply !== undefined && feedbackEnabled && todoScope) {
      void this.reviewTodoTasks(todoScope, undefined, changed).catch((error) => {
        logger.error("Automatic TODO evaluation could not load review tasks: " + (error instanceof Error ? error.message : String(error)))
      })
    }
    if (!this.cancelled && (!recoveryNotice || recoveryNotice.restored)) await activeCheckpoints?.clear()
    if (this._activeExecution === execution) {
      this._executionAbort = undefined
      this._activeExecution = undefined
    }
    return reply
  }

  /**
   * The provider's client with the workspace's tools: reading and
   * searching (by meaning too, when there is an index), what the language
   * servers know, editing files and running commands, each as the
   * settings say.
   */
  private todoToolsClient(
    provider: TwinnyProvider,
    scope: TodoListRequest,
    hooks: {
      onNotes(notes: string | undefined): void
      onUsage(usage: ToolLoopUsage): void
      onTools(tools: WorkspaceTools): void
      onChanges(changes: ReplyChanges): void
      onOutOfSteps(): void
      onToolResult(call: ToolCall, result: ToolResult): Promise<void>
    }
  ) {
    this._steps.reset()
    const available = todoWorkspaceTools(this._todoRepository!, scope, () => {
      void this._todoRepository!.getList(scope).then((snapshot) => this._bridge.emit(TODO_EVENT_NAME.changed, snapshot)).catch((error) => {
        logger.error(`Native TODO snapshot refresh failed: ${error}`)
      })
    })
    // TODO tools are always offered: agent profile tool restrictions must not hide task tracking.
    logger.info(`[ToolTrace] outgoing=${available.tools.length} native TODO tools: ${available.tools.map((tool) => tool.name).join(", ")}`)
    hooks.onTools(available)
    const maxResultChars = clampNumericSetting(
      this.config.get<number>("chatToolsMaxResultChars", DEFAULT_RESULT_CHARS),
      MIN_RESULT_CHARS,
      MAX_RESULT_CHARS,
      DEFAULT_RESULT_CHARS
    )
    let warned = false
    return withTools(resolveInferenceProvider(provider), available, {
      mode: toolModeFor(provider.provider),
      maxSteps: Math.min(MAX_STEPS_SETTING, Math.max(MIN_STEPS_SETTING, this.config.get<number>("chatToolsMaxSteps", DEFAULT_MAX_STEPS) || DEFAULT_MAX_STEPS)),
      maxResultChars,
      reasoningEffort: provider.provider === API_PROVIDERS.OpenAI ? "low" : undefined,
      contextWindow: async () => {
        const told = await contextWindowOf(provider)
        if (told && told < SMALL_CONTEXT_TOKENS && !warned) {
          warned = true
          logger.warn(`Chat tools · ${provider.modelName} is loaded with a ${formatCount(told)}-token context. Tools need about 8k to work well.`)
        }
        return told ?? assumedContextWindow(provider)
      },
      stepLines: false,
      steering: () => this.takeSteering(),
      requestContext: () => this.planRequestContext(),
      onOutOfSteps: hooks.onOutOfSteps,
      onNotes: hooks.onNotes,
      onUsage: hooks.onUsage,
      onRequest: (chars, step, mode, tokens) => logger.info(`Chat TODO tools · request ${step + 1} (${mode}) · ${formatCount(chars)} chars, about ${formatCount(tokens)} tokens`),
      onToolStart: (start) => this._steps.start(start),
      onToolResult: hooks.onToolResult,
      onStep: (step) => {
        this._steps.finish(step)
        logger.info(`Chat TODO tools · ${step.summary}`)
      },
      onTrim: (results, tokens) => logger.info(`Chat TODO tools · trimmed ${results} older result${results === 1 ? "" : "s"} (now about ${formatCount(tokens)} tokens)`),
      onFallback: (reason) => logger.warn(`Chat TODO tools · provider fell back to text tool calls: ${reason}`),
      onEnd: () => this._steps.settle()
    })
  }

  private toolsClient(
    provider: TwinnyProvider,
    view: WorkspaceView,
    hooks: {
      onNotes(notes: string | undefined): void
      onUsage(usage: ToolLoopUsage): void
      onTools(tools: WorkspaceTools): void
      onChanges(changes: ReplyChanges): void
      onOutOfSteps(): void
      onToolResult(call: ToolCall, result: ToolResult): Promise<void>
    },
    intentGoal: string | undefined,
    checkpoints: SafeEditCheckpoints | undefined,
    onCatastrophic: (notice: EditRecoveryNotice) => Promise<void>
  ) {
    this._steps.reset()
    // The team's rules only ever tighten what the developer set.
    const team = currentTeamPolicy()?.agent
    const commandMode = team?.commands === "off" ? "off" : this.config.get<ChatCommandMode>("chatToolsCommands", "ask")
    const editMode = team?.edits === "review" ? "review" : this.config.get<ChatEditMode>("chatToolsEdits", "apply")
    const changes = new ReplyChanges(view.root, openDocumentText)
    let mutationsBlocked = false
    const safety = {
      goal: intentGoal,
      checkpoints,
      diagnosticMonitor: new DiagnosticRegressionMonitor(
        clampNumericSetting(this.config.get<number>("chatToolsRegressionErrorSpike", 20), 10, 1000, 20),
        clampNumericSetting(this.config.get<number>("chatToolsRegressionCumulativeErrors", 40), 20, 2000, 40)
      ),
      canMutate: () => !mutationsBlocked,
      blockMutations: () => { mutationsBlocked = true },
      onCatastrophic
    }
    hooks.onChanges(changes)
    const approveChange = (detail: string, approval: "command" | "change") =>
      this._steps.approve(detail, approval)
    const search = this._search
    const maxReadLines = clampNumericSetting(
      this.config.get<number>("chatToolsMaxReadLines", DEFAULT_READ_LINES),
      MIN_READ_LINES,
      MAX_READ_LINES,
      DEFAULT_READ_LINES
    )
    const maxResultChars = clampNumericSetting(
      this.config.get<number>("chatToolsMaxResultChars", DEFAULT_RESULT_CHARS),
      MIN_RESULT_CHARS,
      MAX_RESULT_CHARS,
      DEFAULT_RESULT_CHARS
    )
    const todoScope = this._todoRepository && this._activeConversationId ? {
      projectFingerprint: workspaceProjectFingerprint((workspace.workspaceFolders ?? []).map((folder) => folder.uri.toString(true))),
      conversationId: this._activeConversationId
    } : undefined
    let available = workspaceTools(view, [], {
      workspaceSearch: this._workspaceSearch,
      edits: editorEdits(view, editMode, approveChange, changes, safety),
      editor: editorKnowledge(view, editMode, approveChange, changes, safety),
      readFileMaxLines: maxReadLines,
      todos: this._todoRepository && todoScope ? {
        repository: this._todoRepository,
        scope: todoScope,
        onChanged: () => {
          void this._todoRepository!.getList(todoScope).then((snapshot) => this._bridge.emit(TODO_EVENT_NAME.changed, snapshot)).catch((error) => {
            logger.error(`Native TODO snapshot refresh failed: ${error}`)
          })
        }
      } : undefined,
      commands:
        commandMode === "off"
          ? undefined
          : terminalCommands(
              (command) => this.commandMode(commandMode, command),
              view.root,
              (command) => this._steps.approve(command, "command", { always: !team?.commands }),
              {
                place: this.config.get<ChatCommandPlace>("chatToolsCommandsRunIn", "background"),
                onOutput: (output) => this._steps.progress(output),
                onStart: (stop) => this._steps.stoppable(stop),
                lifetime: this._lifetime.signal,
                changes,
                visible: (file) => view.visible(file)
              }
            ),
      codeSearch: search?.available
        ? indexSearch(search, () =>
            Number(
              this.context?.globalState.get(
                `${EVENT_NAME.twinnyGlobalContext}-${EXTENSION_CONTEXT_NAME.twinnyRerankThreshold}`
              )
            )
          )
        : undefined,
      // A team that takes commands away takes MCP servers too: neither can be undone.
      mcp:
        !mcpAllowed(team) || !this._activeMcpTools.length
          ? undefined
          : this._mcp.sink(
              (detail, tool) => this.approveMcp(detail, tool),
              () => this.config.get<boolean>("mcpNeverAskAgain", false) && !currentTeamPolicy()?.agent?.commands,
              this._activeMcpTools
            )
    })
    // workspaceTools supplies the model-facing tool definitions, including
    // MCP wrappers. McpToolSpec is a separate type and must not be concatenated
    // with executable Tool objects or mistaken for an `isMcp` property.
    const mcpNames = new Set(this._activeMcpTools.map((tool) => tool.name))
    const nativeTools = available.tools.filter((tool) => !mcpNames.has(tool.name))
    const allAvailableNames = [
      ...nativeTools.map((tool) => tool.name),
      ...this._activeMcpTools.map((tool) => `${tool.server}/${tool.tool}`)
    ]
    logger.info(`[ToolTrace] discovered=${nativeTools.length} native, ${this._activeMcpTools.length} MCP`)

    // This override ignores only the selected profile's tool list. Workspace,
    // team, MCP enablement, and execution-approval restrictions still apply.
    const requestedTools = this.config.get<boolean>("agents.ignoreAgentToolRestrictions", false)
      ? undefined
      : this._activeAgent?.profile.tools
    const selection = resolveAgentToolSelection(requestedTools, nativeTools, this._activeMcpTools)
    logger.info("[ToolTrace] eligible=" + selection.native.length + " native, " + selection.mcp.length + " MCP")
    const adaptiveExposure = this.config.get<boolean>("chatToolsAdaptiveExposureEnabled", false)
    const projection = projectTaskRelevantTools(selection.native, selection.mcp, intentGoal ?? "", adaptiveExposure)
    const permittedNames = new Set([...selection.native, ...selection.mcp].map((tool) => tool.name))
    const schemaChars = (tools: typeof available.tools) => JSON.stringify(tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))).length
    const beforeSchemaChars = schemaChars(available.tools.filter((tool) => permittedNames.has(tool.name)))

    // Select by the actual model-facing names. Native and MCP metadata stay
    // separate; the returned WorkspaceTools object still contains Tool values.
    const selectedNames = new Set([
      ...projection.native.map((tool) => tool.name),
      ...projection.mcp.map((tool) => tool.name)
    ])
    available = {
      ...available,
      tools: available.tools.filter((tool) => selectedNames.has(tool.name))
    }

    if (requestedTools === undefined && this._activeAgent?.profile.tools !== undefined) {
      const exposed = projection.native.length + projection.mcp.length
      this._agentToolDiagnostic = `Ignored the agent profile's tool restrictions; ${exposed} eligible tool${exposed === 1 ? "" : "s"} exposed to the provider.`
      logger.warn(this._agentToolDiagnostic)
      this._bridge.emit(EVENT_NAME.twinnyNotification, this._agentToolDiagnostic)
    } else if (selection.explicit && (selection.unmatched.length || (!selection.native.length && !selection.mcp.length))) {
      this._agentToolDiagnostic = agentToolSelectionDiagnostic(
        requestedTools,
        selection.unmatched,
        allAvailableNames,
        selection.native.length + selection.mcp.length
      )
      logger.warn(this._agentToolDiagnostic)
      this._bridge.emit(EVENT_NAME.twinnyNotification, this._agentToolDiagnostic)
    }

    // These are the definitions passed to the tool loop; the provider may
    // subsequently choose native or text-mode tool serialization.
    const outgoingNames = available.tools.map((tool) => tool.name)
    const outgoingSchemaChars = schemaChars(available.tools)
    logger.info(`[ToolTrace] outgoing=${outgoingNames.length} tools: ${outgoingNames.join(", ")}`)
    if (adaptiveExposure) logger.info("[ToolTrace] adaptive projection retained " + projection.native.length + " native, " + projection.mcp.length + " MCP; excluded=" + (projection.excluded.map((entry) => entry.name + " (" + entry.reason + ")").join(", ") || "none") + "; schema chars " + beforeSchemaChars + " (~" + Math.ceil(beforeSchemaChars / 4) + " tokens) -> " + outgoingSchemaChars + " (~" + Math.ceil(outgoingSchemaChars / 4) + " tokens)")
    const missingFromOutgoing = [...selectedNames].filter((name) => !outgoingNames.includes(name))
    if (missingFromOutgoing.length) {
      logger.warn(`[ToolTrace] selected tools absent from outgoing definitions: ${missingFromOutgoing.join(", ")}`)
    }
    hooks.onTools(available)

    let warned = false
    return withTools(resolveInferenceProvider(provider), available, {
      mode: toolModeFor(provider.provider),
      maxSteps: Math.min(MAX_STEPS_SETTING, Math.max(MIN_STEPS_SETTING, this.config.get<number>("chatToolsMaxSteps", DEFAULT_MAX_STEPS) || DEFAULT_MAX_STEPS)),
      maxResultChars,
      // OpenAI's reasoning models think silently on the chat route; at their
      // default effort one tool step can take minutes.
      reasoningEffort: provider.provider === API_PROVIDERS.OpenAI ? "low" : undefined,
      contextWindow: async () => {
        const told = await contextWindowOf(provider)
        if (told && told < SMALL_CONTEXT_TOKENS && !warned) {
          warned = true
          logger.warn(
            `Chat tools · ${provider.modelName} is loaded with a ${formatCount(told)}-token context. ` +
              "Tools need about 8k to work well; older results will be trimmed often. Raise the server's context length if you can."
          )
        }
        return told ?? assumedContextWindow(provider)
      },
      stepLines: false,
      steering: () => this.takeSteering(),
      requestContext: () => this.planRequestContext(),
      onOutOfSteps: hooks.onOutOfSteps,
      onNotes: hooks.onNotes,
      onUsage: hooks.onUsage,
      onRequest: (chars, step, mode, tokens) =>
        logger.info(
          `Chat tools · request ${step + 1} (${mode}) · ${formatCount(chars)} chars, about ${formatCount(tokens)} tokens`
        ),
      onToolStart: (start) => this._steps.start(start),
      onToolResult: hooks.onToolResult,
      shouldStop: () => !safety.canMutate(),
      onStep: (step) => {
        this._steps.finish(step)
        logger.info(`Chat tools · ${step.summary}`)
      },
      onTrim: (results, tokens) =>
        logger.info(
          `Chat tools · trimmed ${results} older tool result${results === 1 ? "" : "s"} to fit the context (now about ${formatCount(tokens)} tokens)`
        ),
      onFallback: (reason, what) =>
        logger.warn(
          what === "tools"
            ? `Chat tools · ${provider.modelName} refused native tool calls, using the text protocol: ${reason}`
            : `Chat tools · ${provider.modelName} does not take a reasoning effort, carrying on without: ${reason}`
        ),
      // A step cut off by a stop or a failure is marked so before the
      // reply (and its steps) are saved.
      onEnd: () => this._steps.settle()
    })
  }

  private async buildTemplateConversation(
    template: string,
    context?: string
  ): Promise<ChatCompletionMessage[]> {
    const { language } = getLanguage()
    const { prompt, selection } = await this._context.templatePrompt(
      template,
      language,
      context
    )

    this._bridge.emit(EVENT_NAME.twinnySetTab, WEBUI_TABS.chat)
    this._bridge.emit(EVENT_NAME.twinnyAddMessage, {
      role: USER,
      content:
        `${kebabToSentence(template)}\n\n\n<pre><code>${selection}</code></pre>`.trim() ||
        " ",
      // Like a typed turn, the conversation keeps the question; what the
      // workspace search adds is for this reply only.
      prompt: prompt.trim()
    })

    const rag = TEMPLATES_WITH_RAG.includes(template)
      ? await this._context.ragContext(selection, new Set())
      : undefined
    const content =
      (rag ? `${prompt}\n\nAdditional Context:\n${rag}` : prompt).trim() || " "

    return [...this._conversation, { role: USER, content }]
  }
}
