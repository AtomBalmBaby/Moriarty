import { createHash } from "crypto"
import * as path from "path"
import * as vscode from "vscode"

import type { AgentProfileSummary } from "../../common/agents"
import { discoverAgentFileNames } from "../../common/agents"
import { logger } from "../../common/logger"

import type { ParsedAgentProfile } from "./profile"
import { parseAgentProfile } from "./profile"

interface AgentDefinition {
  id?: string
  name?: string
  path: string
  enabled?: boolean
  scope?: "workspace" | "user"
}

interface AgentSettings {
  autoDiscover?: boolean
  searchPaths?: string[]
  definitions?: AgentDefinition[]
  excludedPaths?: string[]
}

interface ResolvedAgent {
  id: string
  name: string
  uri: vscode.Uri
  source: AgentProfileSummary["source"]
  enabled: boolean
  definition?: AgentDefinition
  validation?: string
}

export interface LoadedAgent {
  summary: AgentProfileSummary
  profile: ParsedAgentProfile
}

const profileId = (uri: vscode.Uri) => `agent-${createHash("sha256").update(uri.toString()).digest("hex").slice(0, 16)}`
const isAgentFile = (name: string) => name.toLowerCase().endsWith(".agent.md")
const isMissing = (error: unknown) =>
  error instanceof vscode.FileSystemError && error.code === "FileNotFound"

export class AgentRegistry {
  constructor(private readonly context: Pick<vscode.ExtensionContext, "globalStorageUri">) {}

  private config(): AgentSettings {
    return vscode.workspace.getConfiguration("twinny").get<AgentSettings>("agents", {})
  }

  private async save(settings: AgentSettings): Promise<void> {
    const configuration = vscode.workspace.getConfiguration("twinny")
    const scope = configuration.inspect<AgentSettings>("agents")
    const target = scope?.workspaceFolderValue !== undefined
      ? vscode.ConfigurationTarget.WorkspaceFolder
      : scope?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global
    await configuration.update("agents", settings, target)
  }

  private resolvePath(value: string): vscode.Uri {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri
    if (value.startsWith("${workspaceFolder}/")) {
      if (!workspaceFolder) throw new Error(`Cannot resolve relative agent path without an open workspace: ${value}`)
      return vscode.Uri.joinPath(workspaceFolder, value.slice("${workspaceFolder}/".length))
    }
    if (value.startsWith("${extensionGlobalStorage}/")) {
      return vscode.Uri.joinPath(this.context.globalStorageUri, value.slice("${extensionGlobalStorage}/".length))
    }
    if (path.isAbsolute(value)) return vscode.Uri.file(value)
    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return vscode.Uri.parse(value)
    if (!workspaceFolder) throw new Error(`Cannot resolve relative agent path without an open workspace: ${value}`)
    return vscode.Uri.joinPath(workspaceFolder, value)
  }

  private async discover(): Promise<ResolvedAgent[]> {
    const settings = this.config()
    if (settings.autoDiscover === false) return []
    const folders = vscode.workspace.workspaceFolders ?? []
    const configuredPaths = settings.searchPaths?.length
      ? settings.searchPaths
      : ["${workspaceFolder}/.github/agents"]
    const directories = new Map<string, { uri: vscode.Uri; source: ResolvedAgent["source"] }>()
    const userDirectory = vscode.Uri.joinPath(this.context.globalStorageUri, "agents")
    directories.set(userDirectory.toString(), { uri: userDirectory, source: "user" })
    for (const folder of folders) {
      const standard = vscode.Uri.joinPath(folder.uri, ".github", "agents")
      directories.set(standard.toString(), { uri: standard, source: "workspace" })
    }
    for (const searchPath of configuredPaths) {
      try {
        const uri = this.resolvePath(searchPath)
        directories.set(uri.toString(), {
          uri,
          source: uri.toString().startsWith(this.context.globalStorageUri.toString()) ? "user" : "workspace"
        })
      } catch (error) {
        logger.warn(`Agent discovery path '${searchPath}' could not be resolved: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const excluded = new Set((settings.excludedPaths ?? []).map((value) => {
      try { return this.resolvePath(value).toString() } catch { return value }
    }))
    const results: ResolvedAgent[] = []
    for (const { uri: directory, source } of directories.values()) {
      try {
        const entries = await vscode.workspace.fs.readDirectory(directory)
        const files = discoverAgentFileNames(entries.map(([name, type]) => [name, type === vscode.FileType.File]))
        for (const file of files) {
          const uri = vscode.Uri.joinPath(directory, file)
          if (excluded.has(uri.toString())) continue
          results.push({ id: profileId(uri), name: file.replace(/\.agent\.md$/i, ""), uri, source, enabled: true })
        }
      } catch (error) {
        if (!isMissing(error)) logger.warn(`Agent discovery could not read ${directory.toString()}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return results
  }

  private async resolved(): Promise<ResolvedAgent[]> {
    const settings = this.config()
    const discovered = await this.discover()
    const byPath = new Map(discovered.map((entry) => [entry.uri.toString(), entry]))
    for (const definition of settings.definitions ?? []) {
      try {
        const uri = this.resolvePath(definition.path)
        const canonical = uri.toString()
        const found = byPath.get(canonical)
        byPath.set(canonical, {
          id: definition.id?.trim() || found?.id || profileId(uri),
          name: definition.name?.trim() || found?.name || path.basename(definition.path).replace(/\.agent\.md$/i, ""),
          uri,
          source: definition.scope === "user" ? "user" : found?.source ?? "registered",
          enabled: definition.enabled !== false,
          definition
        })
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        const fallback = vscode.Uri.file(path.resolve(definition.path))
        const id = definition.id?.trim() || profileId(fallback)
        byPath.set(`invalid:${id}`, {
          id,
          name: definition.name?.trim() || path.basename(definition.path).replace(/\.agent\.md$/i, ""),
          uri: fallback,
          source: definition.scope === "user" ? "user" : "registered",
          enabled: definition.enabled !== false,
          definition,
          validation: detail
        })
        logger.warn(`Registered agent '${definition.path}' could not be resolved: ${detail}`)
      }
    }
    return [...byPath.values()]
  }

  async list(): Promise<AgentProfileSummary[]> {
    const serverSettings = vscode.workspace.getConfiguration("twinny").get<Record<string, unknown>>("chatToolsMcpServers", {})
    const agents = await this.resolved()
    const idCounts = new Map<string, number>()
    for (const item of agents) idCounts.set(item.id, (idCounts.get(item.id) ?? 0) + 1)
    const summaries: AgentProfileSummary[] = []
    for (const item of agents) {
      const warnings: string[] = []
      let profile: ParsedAgentProfile | undefined
      let validation: string | undefined = item.validation
      try {
        const bytes = await vscode.workspace.fs.readFile(item.uri)
        profile = parseAgentProfile(Buffer.from(bytes).toString("utf8"), item.uri.path)
        if (item.definition?.name?.trim()) profile.name = item.definition.name.trim()
        if (!profile.userInvocable) warnings.push("user-invocable is false; this profile is hidden from the picker.")
        if (profile.model) warnings.push(`Model hint '${profile.model}' is recognized but Twinny keeps the selected provider and model.`)
        if (profile.unsupportedFields.length) warnings.push(`Unsupported fields preserved in the file: ${profile.unsupportedFields.join(", ")}.`)
        const referencedServers = new Set([
          ...profile.mcpServers,
          ...(profile.tools ?? []).flatMap((tool) => {
            const separator = tool.indexOf("/")
            return separator > 0 ? [tool.slice(0, separator)] : []
          })
        ])
        for (const name of referencedServers) {
          const server = serverSettings[name]
          if (!server) warnings.push(`MCP server '${name}' is not configured in Twinny.`)
          else if (typeof server === "object" && server !== null && Reflect.get(server, "enabled") === false) {
            warnings.push(`MCP server '${name}' is disabled in Twinny.`)
          } else {
            warnings.push(`MCP server '${name}' is configured and enabled; Twinny connects it when this profile is selected.`)
          }
        }
      } catch (error) {
        validation = error instanceof Error ? error.message : String(error)
      }
      if ((idCounts.get(item.id) ?? 0) > 1) validation = `Duplicate agent ID '${item.id}'.`
      summaries.push({
        id: item.id,
        name: profile?.name ?? item.name,
        path: item.uri.toString(),
        enabled: item.enabled,
        userInvocable: profile?.userInvocable ?? true,
        valid: !!profile && !validation,
        ...(validation ? { validation } : {}),
        warnings,
        mcpServers: profile?.mcpServers ?? [],
        source: item.source
      })
    }
    return summaries
  }

  async load(id: string): Promise<LoadedAgent | undefined> {
    const item = (await this.resolved()).find((agent) => agent.id === id)
    if (!item || !item.enabled) return undefined
    const bytes = await vscode.workspace.fs.readFile(item.uri)
    const profile = parseAgentProfile(Buffer.from(bytes).toString("utf8"), item.uri.path)
    if (!profile.userInvocable) return undefined
    const summary = (await this.list()).find((agent) => agent.id === id)
    if (!summary?.valid || !summary.enabled) return undefined
    return { summary, profile }
  }

  async add(filePath: string, name?: string): Promise<AgentProfileSummary[]> {
    const uri = this.resolvePath(filePath.trim())
    const settings = this.config()
    const definitions = (settings.definitions ?? []).filter((entry) => {
      try { return this.resolvePath(entry.path).toString() !== uri.toString() } catch { return true }
    })
    definitions.push({ id: profileId(uri), ...(name?.trim() ? { name: name.trim() } : {}), path: filePath.trim(), enabled: true })
    await this.save({ ...settings, definitions })
    return this.list()
  }

  async setEnabled(id: string, enabled: boolean): Promise<AgentProfileSummary[]> {
    const item = (await this.resolved()).find((agent) => agent.id === id)
    if (!item) throw new Error(`Agent '${id}' is no longer registered.`)
    const settings = this.config()
    const definitions = [...(settings.definitions ?? [])]
    const index = definitions.findIndex((entry) => {
      if (item.definition && entry.path === item.definition.path) return true
      try { return this.resolvePath(entry.path).toString() === item.uri.toString() } catch { return false }
    })
    if (index >= 0) definitions[index] = { ...definitions[index], enabled }
    else definitions.push({ id, path: item.uri.toString(), enabled, scope: item.source === "user" ? "user" : "workspace" })
    await this.save({ ...settings, definitions })
    return this.list()
  }

  async remove(id: string): Promise<AgentProfileSummary[]> {
    const item = (await this.resolved()).find((agent) => agent.id === id)
    if (!item) return this.list()
    const settings = this.config()
    const definitions = (settings.definitions ?? []).filter((entry) => {
      if (item.definition && entry.path === item.definition.path) return false
      try { return this.resolvePath(entry.path).toString() !== item.uri.toString() } catch { return true }
    })
    const excludedPaths = [...new Set([...(settings.excludedPaths ?? []), item.uri.toString()])]
    await this.save({ ...settings, definitions, excludedPaths })
    return this.list()
  }

  async open(id: string): Promise<void> {
    const item = (await this.resolved()).find((agent) => agent.id === id)
    if (!item) throw new Error(`Agent '${id}' is no longer registered.`)
    await vscode.window.showTextDocument(item.uri)
  }

  async pick(): Promise<AgentProfileSummary[]> {
    const selected = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: "Register Agent",
      filters: { "Twinny agent profiles": ["md"] }
    })
    if (selected?.[0] && isAgentFile(selected[0].path)) await this.add(selected[0].toString())
    else if (selected?.[0]) throw new Error("Selectable agent files must end in '.agent.md'.")
    return this.list()
  }

  async create(name: string): Promise<AgentProfileSummary[]> {
    const cleanName = name.trim()
    if (!cleanName) throw new Error("An agent name is required.")
    const directory = vscode.Uri.joinPath(this.context.globalStorageUri, "agents")
    await vscode.workspace.fs.createDirectory(directory)
    const filename = `${cleanName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agent"}.agent.md`
    const uri = vscode.Uri.joinPath(directory, filename)
    try {
      await vscode.workspace.fs.stat(uri)
      throw new Error("The file already exists: " + uri.fsPath)
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    const content = "---\nname: " + JSON.stringify(cleanName) + "\ndescription: Describe this agent.\ntools: []\nuser-invocable: true\n---\n\nAdd instructions for this agent here.\n"
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"))
    await this.add(uri.toString(), cleanName)
    await vscode.window.showTextDocument(uri)
    return this.list()
  }
}
