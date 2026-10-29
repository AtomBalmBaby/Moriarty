# Copilot implementation prompt: Twinny custom agents

Implement the attached specification **`Twinny_Custom_Agents_Spec.md`** in the **Twinny VS Code/VSCodium extension repository**. This is an implementation assignment, not an architecture essay. Inspect the existing source before modifying it, then implement, test, and package the extension.

**CRITICAL UI CORRECTION:** Replace Twinny's current **agent on/off button** in the bottom chat composer with **ONE dropdown**, located in that same position:

- `Agent off` = the **current agent-disabled behavior** (fresh chat default, or preserve Twinny's existing default on upgrades).
- `Default Agent` = the **current built-in agent-on behavior**.
- Named enabled `*.agent.md` profiles = existing agent loop with selected custom instructions/tools.
- `+ Manage Agents…` = opens the settings GUI for managing agent registrations.

**Do not add a second agent on/off button or separate agent-mode selector.** The dropdown IS the agent control. Preserve `auto-run` independently and retain/adapt `Shift+Tab` to toggle between Off and the last enabled agent.

### Required implementation

1. Locate the current composer agent toggle, backing state, settings storage, relevant message payload construction, MCP manager, and tests. Follow their actual architecture rather than inventing new configuration infrastructure.
2. Refactor to one canonical selection (`off`, `default`, or custom ID), with an adapter for the old on/off state. Migrate existing sessions/preferences safely. No parallel mutable `agentEnabled` state.
3. Create an agent registry and GUI settings section with agent name, path, enabled flag, add/create/open/remove-registration, validation status, and refresh. Support explicit file paths and auto-discovery of `.github/agents/*.agent.md`.
4. Parse VS Code/GitHub Copilot-compatible `*.agent.md` YAML frontmatter and Markdown body. Support `name`, `description`, `tools`, `model`, `user-invocable`, `disable-model-invocation`, and relevant `mcp-servers` references; preserve and report unsupported fields. Do not confuse `AGENTS.md` project instructions with selectable custom agents.
5. Use VS Code `ExtensionContext.globalStorageUri` (and `storageUri`/state APIs as appropriate) for default user/profile storage, not a hardcoded `~/.config/twinny`. Make locations configurable. Add an `agents` section in Twinny's actual existing config representation and corresponding VS Code settings integration; avoid duplicate sources of truth.
6. Move the generic assistant/coding guidance from the current hardcoded agent prompt into the shared **Helpful Assistant** default prompt, respecting the tool-disabled behavior of Agent off. Generate the active workspace root, relative-path rule, and bounded live file inventory automatically for the enabled agent at request time. Inject selected `.agent.md` instructions once, not into global policy.
7. On selecting a custom agent, resolve referenced MCP server names against **already configured, enabled** Twinny MCP connections, including STDIO and Streamable HTTP. Connect/start them if necessary using the existing manager; await discovery and expose only actual permitted tools to the selected agent. Do not execute arbitrary `mcp-servers` command definitions from frontmatter or bypass approval settings. Missing or disabled servers should be reported, not fabricated.
8. Preserve current model/provider behavior, the existing tool executor, approval/auto-run rules, chat history, and unrelated settings. Do not leak tools between agent selections.
9. Add unit/integration tests for dropdown state, upgrade migration, parser validation, file discovery, prompt composition, MCP startup/error cases, settings persistence, and keyboard shortcut. Test actual payload output for Off, Default, and custom agents.
10. Run relevant lint, type-check, tests, extension build, and VSIX packaging. Fix regressions caused by this change. Do not claim success for unexecuted tests or placeholder UI.

### Execution policy

Implement autonomously, using the existing repository tools. You may modify the **Twinny repository** and run safe tests/builds. Do not alter Home Assistant, the LCARS repository, third-party repositories, Git history, or remote services. Do not commit/push. Do not install dependencies without first determining whether existing dependencies suffice.

Use the specification as acceptance criteria. If a particular advanced standard field is unsupported, document the limitation instead of pretending to implement it. Keep the implementation scoped to selectable agents, configuration, prompt composition, and MCP association. Do not implement a new playbook engine in this change.

### Completion report

Provide changed file paths, settings schema, user-facing behavior, example `.agent.md`, commands and actual test results, the resulting VSIX path if built, and any known limitations. **Do the work; do not stop after writing a plan.**
