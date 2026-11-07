# Custom agent profiles

Twinny's chat composer has one agent dropdown: **Agent off**, **Default Agent**, enabled `.agent.md` profiles, and **+ Manage Agents…**. New chats start with the agent chosen by `twinny.agents.startupSelection` (Default Agent by default). Shift+Tab toggles between Off and the last enabled selection. Auto-run remains a separate command-approval preference.

## Add a profile

The management panel lets you register an explicit file path, choose a file, create a starter profile, open a profile, enable or disable it, remove its registration, and refresh discovery. By default Twinny discovers `.github/agents/*.agent.md` in open workspaces and `agents/` under the extension's VS Code global storage directory. `AGENTS.md` remains project instructions, not a selectable profile.

Example `review.agent.md`:

```markdown
---
name: Review Agent
description: Review changes for correctness and regressions
tools:
  - read
  - search
  - ha-mcp/*
mcp-servers:
  - ha-mcp
model: coder-model
user-invocable: true
disable-model-invocation: false
---

Review the requested changes. Prioritize correctness, security, and focused tests.
```

Twinny parses the YAML frontmatter and adds the Markdown body once to the selected agent's request. `name`, `description`, `tools`, `model`, `user-invocable`, `disable-model-invocation`, and `mcp-servers` are recognized. Non-user-invocable profiles are not shown in the picker. `model` is recognized and reported, but Twinny keeps the active provider/model. `disable-model-invocation` is parsed; Twinny does not implement subagent/model invocation. Other fields are preserved in the file and reported as unsupported.

`tools` restricts the workspace and MCP tools already permitted by Twinny. Omitting `tools` leaves the normally eligible tools available; an explicit empty list allows none. Built-in tool names are case-insensitive, accept `vscode/` or `twinny/` qualified aliases (for example `vscode/readFile`), and support the Copilot-style `read`, `search`, `edit`, and `execute` groups. MCP tool names should be qualified as `server/tool` (or `server/*`) to avoid ambiguity with built-ins. MCP server names in `mcp-servers` refer only to entries already configured in `twinny.chatToolsMcpServers`. Twinny starts only those enabled configured servers, discovers their real tools, and keeps normal Twinny approval rules. Command definitions or credentials placed in frontmatter are never executed or used to configure servers. Missing, disabled, invalid, or unavailable references are reported with the unmatched names and currently eligible alternatives; they do not create tools or broaden an explicit restriction.

## Settings

The chat dropdown’s **+ Manage Agents…** panel exposes the startup selection, automatic discovery, additional search directories, and registration controls. The extension also contributes `twinny.agents` to VS Code Settings:

- `autoDiscover`: whether automatic discovery is enabled (default `true`).
- `searchPaths`: additional directory paths. Workspace-relative paths can use `${workspaceFolder}/`; user storage can use `${extensionGlobalStorage}/`.
- `definitions`: explicit registrations with `path`, optional `id`/`name`, `enabled`, and `scope`.
- `excludedPaths`: discovered profile paths to exclude.

User-created files are stored under `ExtensionContext.globalStorageUri/agents`, not a hardcoded home-directory location. Settings are persisted through VS Code configuration; existing MCP connections remain configured in `twinny.chatToolsMcpServers`.

Twinny generates the active workspace root, relative-path guidance, and a bounded live inventory at request time for enabled agents. Inventory excludes common private/build paths and files hidden by Twinny's workspace visibility rules. In multi-root workspaces, the existing tool executor operates on the first root, so that is the root inventoried for tool use.


## Base instructions

The agent settings panel also offers independent **Chat Base Instructions** and **Prompt Compiler Base Instructions** selectors. Each can use the bundled default, a user-owned Markdown file, or None. Custom files are read for each new request; missing or unreadable files show a warning and fall back to that route's bundled default. None removes only that optional behavioral layer; agent profiles, compiler JSON protocol, runtime context, tool approvals, and application-enforced workspace/security boundaries remain separate. Use **Preview Effective Prompt** in the panel to inspect the resolved layers without making an inference request.
