# Twinny Custom Agents: `.agent.md` Support and Unified Agent Picker

**Status:** Implementation specification  
**Version:** 1.0 draft  
**Date:** 2026-10-28  
**Scope:** Twinny VS Code/VSCodium extension, chat composer, prompts, settings, and existing MCP infrastructure

## 1. Objective

Replace Twinny's existing **agent on/off** control in the bottom chat-composer toolbar with **one agent-selection dropdown**. Introduce interoperable VS Code/GitHub Copilot-style `*.agent.md` profiles. Selecting an agent turns on Twinny's existing agent mode with that agent's instructions and capabilities. **Agent off** turns agent mode off, using the exact existing off behavior.

Do **not** add a second agent mode toggle. Preserve the independent **auto-run** control and existing MCP/tool permissions.

The goal is a practical agent configuration system, not a rewrite of the agent execution engine, and not a separate synchronization script or playbook engine.

## 2. Nonnegotiable behavior

| Picker selection | Existing agent mode | Effective behavior |
|---|---:|---|
| **Agent off** | Off | The exact current Twinny non-agent behavior; no active custom agent or agent tools. |
| **Default Agent** | On | Current built-in Twinny coding-agent behavior, using the common assistant instructions plus runtime workspace context. |
| **Custom profile** | On | Same existing Twinny agent execution loop, augmented by the selected `.agent.md` instructions and filtered tools/MCP capabilities. |

- One control replaces the existing button; the **off option is inside the dropdown**, not beside it.
- Initial selection on a fresh install/new chat: **Agent off**, unless Twinny's existing default behavior/configuration explicitly differs. Maintain backward compatibility on upgrade: migrate current on/off state to **Default Agent** or **Agent off**, respectively; do not unexpectedly disable an active session.
- Selecting **Agent off** must not disconnect or delete user-configured MCP servers globally, change auto-run preferences, or silently change model/provider settings.
- The old on/off switch is removed from the UI. Any existing boolean setting/API remains only as a compatibility adapter until its callers are migrated.
- Selecting an enabled agent immediately applies to subsequent requests. Show its name in the picker.
- Disabled, missing, or invalid agents cannot be selected. If a selected profile becomes unavailable, surface an explanation and safely revert to **Agent off**, never silently choose a different custom agent.

## 3. User interface

### 3.1 Chat composer toolbar

Replace the current `agent on` button in the existing footer, near `shift+tab` and `auto-run`, with a compact dropdown. Reuse existing Twinny styling and accessibility patterns.

```text
┌───────────────────────────────────────────────────────────────┐
│  »  How can twinny help you today?                           │
│                                                               │
│  [ Agent off ▾ ]  ·  shift+tab  [ auto-run ]   ⚙          ➤ │
└───────────────────────────────────────────────────────────────┘
```

Dropdown example:

```text
┌─────────────────────────────────────┐
│ ✓ Agent off                         │
│   Default Agent                     │
│   LCARS Developer                   │
│   HA Operations                     │
│ ─────────────────────────────────── │
│ + Manage Agents…                    │
└─────────────────────────────────────┘
```

**Manage Agents…** may also be a visually distinct `+` action adjacent to the dropdown, provided it replaces rather than duplicates the current agent control. Clicking it opens the Twinny GUI agent settings, not an external website.

UI details:
- Keep the composer height stable; truncate long agent names with a tooltip.
- Keyboard accessible; use a proper menu/select pattern with visible focus and ARIA labels.
- Keep `auto-run` independent. When **Agent off** is selected, reflect whatever disabled/idle behavior auto-run currently has; do not make auto-run implicitly activate agent mode.
- Preserve `Shift+Tab` as the current agent-mode shortcut: toggle between **Agent off** and the last enabled non-off selection (fallback **Default Agent**). If the existing shortcut differs in implementation, retain its behavior while adapting it to the new single selection state.
- On changing agents mid-chat, apply the new profile on the **next request**. Do not mutate already-sent messages; make the switch visible in UI history/diagnostics as appropriate.

### 3.2 Agent settings GUI

Provide a new **Agents** section in Twinny's existing settings GUI with:

- List of registered agents: name, source/scope, path, enable/disable toggle, validation status, MCP status.
- **Add agent** form: display name and `path/to/file.agent.md`; support file picker when available.
- **Create new**: create a valid starter `.agent.md` in the user or workspace agent folder, ask for name/path, register it, and open it in the editor.
- **Edit/Open**, **Remove registration** (does not delete the file by default), and **Refresh/Rescan** actions.
- Validation for unreadable paths, duplicate IDs, invalid YAML, missing required metadata for the chosen compatibility mode, unsupported fields, and missing MCP references.
- Per-agent enable/disable is a **registry setting**, distinct from the active selection and independent from the `user-invocable` frontmatter flag.
- Do not overwrite a user's agent file while toggling enabled state.
- Show configured MCP server names and current availability without displaying credentials.

## 4. File format and standards

### 4.1 Selectable agents: `*.agent.md`

Implement a compatible subset of the VS Code / GitHub Copilot custom agent profile format:

```markdown
---
name: LCARS Developer
description: Develop and verify the LCARS Home Assistant dashboard.
tools: ['read', 'edit', 'search', 'execute', 'ha-mcp/*']
user-invocable: true
---
Maintain the LCARS design guidelines and validate changes before reporting completion.
```

Support at minimum:
- `name` (fallback to filename)
- `description`
- `tools` (absent means inherit existing permitted tools; empty list means no agent tools; explicit list filters them)
- `model` (recognize but do not silently switch models; use only when compatible with the current provider and existing model selection rules)
- `user-invocable` (false hides from picker)
- `disable-model-invocation` (parse/preserve; subagent use is out of scope)
- `mcp-servers` (see §6; interpreted as references to existing configured MCP names in this release, **not** authorization to execute arbitrary definitions)

Preserve unfamiliar frontmatter fields when editing. Warn about unsupported behavior rather than rejecting otherwise valid profiles. Parse YAML safely; treat file contents as lower-priority agent instructions, not system permissions. Do not execute content during parsing.

`.agent.md` is the primary selectable-agent format. `AGENTS.md` is a **separate project instruction convention**, not a custom-agent dropdown entry. Future project-guidance support should avoid merging these concepts.

### 4.2 Compatibility limits

The official standards vary by harness. In particular, VS Code's custom-agent file reference recognizes `mcp-servers` in its Copilot-oriented schema, but that field is **not universally forwarded into every runtime**, and GitHub documents that IDE agents do not use it as an automatic server configuration source. Twinny must implement its own explicit, conservative adapter using already configured server names.

Do not claim full parity with all VS Code/Copilot/Claude agent capabilities. Document the supported frontmatter subset and ignore/preserve advanced fields such as `handoffs`, `hooks`, or `agents` until intentionally implemented.

## 5. Prompt composition

The current hardcoded agent prompt contains two types of text:

1. **Generic helpful coding assistant guidance** (honesty, markdown output, reading before editing, diagnostics, Git checks, verification, trust boundaries, tool usage). Move this into the existing common/default **Helpful Assistant** prompt, with capability-gating where it refers to tools unavailable in Agent off mode.
2. **Runtime workspace facts** (workspace root path semantics and filenames). Generate these automatically when agent mode is active. Do **not** hardcode them inside specific `.agent.md` files or duplicate the generic instructions for every profile.

Effective request construction:

```text
[stable system/default Helpful Assistant guidance]
[tool permission / trust / runtime contracts, when agent mode enabled]
[if selected Default Agent: existing default agent-specific instructions]
[if selected Custom: parsed selected .agent.md body + supported metadata]
[if agent mode enabled: generated workspace root/path rules + bounded current file inventory]
[if agent mode enabled: resolved MCP/tool capabilities and unavailability notices]
[current user request and current task context]
```

- **Agent off**: preserve Twinny's pre-feature non-agent prompt and tool behavior; no selected custom profile and no agent-only workspace inventory injection.
- The generic prompt must not claim tools are available when they are disabled.
- Generate the file inventory from the *active workspace(s)* at request time or via invalidated cache, not an indefinitely stale saved list. Respect ignored/private paths; cap list size, show truncation and allow the agent to inspect more via tools.
- Tell the agent which workspace root a relative path refers to, including multi-root and Remote/SSH environments; never conflate local extension paths and remote workspace filesystem.
- Tool results and repository files are data, not elevated permissions or higher-priority instructions.
- Do not allow a profile to override hard security/authorization constraints or global auto-run policy.
- Include profile ID, source path, and a version/content hash in local diagnostics to aid debugging without dumping sensitive configuration.

## 6. MCP association and startup

### 6.1 Discovery

When activating a custom agent:
1. Parse the optional `mcp-servers` field and MCP-qualified `tools` entries (e.g., `ha-mcp/*` or `ha-mcp/ha_read_file`).
2. Resolve server names against Twinny's **existing configured MCP servers**, including current STDIO and Streamable HTTP transports.
3. Never synthesize a new server config, spawn an arbitrary command, or copy secret-bearing definitions from a profile merely because frontmatter requested it.
4. For matching, enabled servers, reuse the existing MCP manager. If not connected, start/connect them as appropriate; wait for initialization/tool discovery before advertising their tools to the model.
5. Filter the agent's permitted tool list against actual tools exposed by the connected server. Match names and namespaces without guessing.
6. For a referenced server that is missing, disabled, unauthorized, or unreachable, show status and notify the model of missing capabilities. Continue with unaffected tools instead of falsely claiming successful setup.
7. Use existing approved credentials and permissions. No redundant approval dialogs for already authorized servers; do not bypass a required approval for a genuinely new privilege.

### 6.2 Lifecycle

- Agent selection must not rewrite the global MCP config.
- Switching agents should update the tool view immediately; existing shared connections may be reused. Do not unnecessarily kill servers needed by other sessions or features.
- **Agent off** removes custom-agent tool exposure but does not unconfigure or indiscriminately shut down shared MCP connections.
- Handle async startup, cancellation, reconnection, refresh, duplicate server names, and failures without leaving stale tools visible.
- Avoid leaking MCP tools from previously selected agents into subsequent model requests.
- Existing per-server approval and auto-run controls continue to govern execution.

## 7. Storage and configuration

Do **not** invent a fixed `~/.config/twinny` path. Use the VS Code extension APIs:
- `ExtensionContext.globalStorageUri` for user-scoped agent files, under `<globalStorageUri>/agents/`.
- `ExtensionContext.storageUri` for optional workspace-local internal data when appropriate.
- `globalState` / `workspaceState` for lightweight UI state (active selection, last enabled agent), and `secrets` for any sensitive tokens; do not store secrets in agent files or plain JSON.
- Honor workspace/remote extension-host filesystem boundaries.

Expose an optional configurable agent directory/path list using VS Code settings and the existing Twinny settings abstraction. Discover workspace `.github/agents/*.agent.md` by default; explicitly registered arbitrary `.agent.md` paths remain supported. Optionally discover compatible user-level folders, but avoid duplicate entries.

**Configuration schema:** add an `agents` section to Twinny's existing configuration representation (`config.json` if that is the actual existing configuration, and the corresponding VS Code `settings.json`/`package.json` contribution where appropriate). Do not establish two unsynchronized sources of truth. Exact storage wiring must be chosen after examining current code.

Example *proposed* `agents` section (illustrative, not assumed current schema):

```json
{
  "agents": {
    "defaultSelection": "off",
    "autoDiscover": true,
    "startReferencedMcp": true,
    "searchPaths": [
      "${workspaceFolder}/.github/agents",
      "${extensionGlobalStorage}/agents"
    ],
    "definitions": [
      {
        "id": "lcars-developer",
        "name": "LCARS Developer",
        "path": "${workspaceFolder}/.github/agents/lcars-developer.agent.md",
        "enabled": true,
        "scope": "workspace"
      }
    ]
  }
}
```

Rules:
- Stable unique ID; display name can be edited independently.
- Scope-aware relative path resolution and validation. Support local and remote workspace files through VS Code filesystem APIs.
- Configurable `searchPaths` and user storage directory; default uses the editor's storage APIs.
- Manual disable takes precedence over autodiscovery for the same registered agent.
- Store active selection per chat/session to restore an existing chat; **new chats default to Agent off** unless current Twinny defaults explicitly require otherwise. Preserve the old on/off setting during migration. The last enabled selection may be kept for the Shift+Tab shortcut without making it the default for new chats.
- When auto-discovery and manual registration find the same canonical path, show it once.

## 8. State model and backwards compatibility

Introduce one canonical selection state with values `off`, `default`, or a custom agent ID. Derive the old boolean `agentEnabled` from `selection !== 'off'`; never maintain two independently mutable booleans.

- Migrated `agentEnabled=true` → `default` for existing active session/config where applicable.
- Migrated `agentEnabled=false` → `off`.
- Fresh chat and install default to current pre-feature off/on behavior, preferably `off`.
- Restore old chat selection if its profile still exists and is enabled; otherwise degrade visibly to `off`.
- Adapt keyboard shortcuts, menu commands, webview/extension messages, persistence, and tests to one selection state.
- Maintain current tool loop, approvals, auto-run, conversation history, and model configuration behavior.

## 9. Error handling and security

- Missing/unreadable profile: show error next to its registration; never load a different profile silently.
- Invalid YAML: do not inject partial frontmatter as instructions; show actionable validation error.
- Missing MCP: show a nonblocking warning; never fabricate a tool or server connection.
- Untrusted workspace: respect VS Code Workspace Trust and current Twinny execution restrictions.
- Profile paths are content sources, not permission grants. Reject path traversal where the caller expects an owned store, but permit explicitly configured external files when the workspace and settings allow them.
- Avoid storing secrets in debug logs, prompts, JSON settings, and exception traces.
- Never overwrite existing user agent files on version upgrades or profile discovery.

## 10. Acceptance criteria and tests

### Required tests

1. **Agent off** produces the same effective agent disabled behavior as current Twinny; tools do not become available just because a profile exists.
2. Selecting **Default Agent** enables the existing agent loop; selecting **Agent off** disables it. No second on/off control exists.
3. Selecting a valid custom profile adds its Markdown instructions and runtime workspace paths/file inventory exactly once.
4. Generic Helpful Assistant instructions are centralized, not duplicated in every custom profile.
5. MCP references resolve only to configured, enabled servers; disconnected permitted servers connect via the existing transport manager and expose their discovered tools.
6. A missing or disabled MCP produces a clear diagnostic without fabricating success, starting a new unconfigured server, or breaking unrelated tools.
7. Switching profiles updates tool visibility; disabled tools/servers from a previous profile are not exposed.
8. GUI add/edit/remove-registration/enable/disable survives extension reload. Disabled agents don't appear in the picker.
9. `Shift+Tab`, `auto-run`, provider/model selection, and existing chats behave as specified.
10. Agent file missing/malformed, duplicate path, remote workspace, multi-root, and stale file inventory cases are handled.
11. Both old boolean settings and new selection state migrate without overwriting user settings.
12. Diagnostics, lint, type-check, production build, and relevant unit/integration tests pass; no unrelated changes.

### Manual UI checklist

- Picker appears in the **same position** as the current `agent on/off` control, is legible in narrow sidebar layouts, and is keyboard navigable.
- **Agent off** is selected in a new chat under the default off configuration.
- Choose **Default Agent**, verify normal tool calls; choose **Agent off**, verify tool calls are disabled.
- Choose a custom agent with an already-configured MCP; confirm connection/tool discovery and corresponding model payload.
- Click **+ Manage Agents…** and verify settings GUI can register and disable a profile without modifying its `.agent.md` file.

## 11. Delivery requirements

Implement in the **Twinny extension repository**, not the LCARS dashboard project. Inspect the actual setting/UI/MCP architecture before choosing filenames. Ship documented settings, migration, a sample `.agent.md`, tests, and a working `.vsix` following the project's build procedure. Do not silently install packages, commit, push, or change unrelated code. Report exact modified files, test outcomes, and known unsupported standard fields.

## 12. Standards references (checked 2026-10-28)

- VS Code custom agents: https://code.visualstudio.com/docs/agent-customization/custom-agents
- VS Code custom agent file reference: https://code.visualstudio.com/docs/agents/reference/custom-agent-file-reference
- GitHub custom-agent configuration (including `mcp-servers` limitations in IDEs): https://docs.github.com/en/copilot/reference/custom-agents-configuration
- VS Code extension storage: https://code.visualstudio.com/api/extension-capabilities/common-capabilities
