# Twinny Native TODO System


## Reconciled governing decisions (2026-11-08)

This is **one system**, described by three complementary documents. The [intent/feedback overview](TWINNY_INTENT_FEEDBACK_SYSTEM_OVERVIEW_RECONCILED.md) owns architectural boundaries and internal message protocol; the [native TODO specification](TWINNY_NATIVE_TODO_SYSTEM_RECONCILED.md) owns task identity, dependencies, state and persistence; the [evidence manifesto](TWINNY_EVIDENCE_MANIFESTO_RECONCILED.md) owns observation/fact trust, criterion proofs, freshness and live acceptance. When an older example in any document differs, this reconciled contract governs. **Design target is not evidence of implementation.**

- **Structured internal control:** Planner, host, implementer, verifier, and reviewer exchange versioned JSON objects conforming to validated schemas. Human-readable descriptions are labels/explanations and never the executable acceptance condition. Model-facing tool calls already have structured arguments; internal prompt transport may still serialize JSON as text, but must validate the parsed object before acting.
- **Stable responsibilities:** Models propose plans, investigations, claims and semantic judgments. Twinny owns identity, permissions, execution outcomes, evidence capture, objective verification, transitions and retries. The user owns requirements and explicit authorization. No prose explanation or model-proposed `passed` flag overrides a contradictory trusted host observation.
- **Typed criteria:** Each criterion has a stable ID, explicit `verification.kind`, expected predicate, evidence requirements, subject/scope, a proof owner and freshness policy. Implemented known types are a **target**, not an assertion of currently shipped behavior. Unsupported semantics go to `semantic_review`; they do not quietly become `proven` or `disproven`.
- **Independent reconciliation:** A task's mandatory criteria resolve individually as `proven`, `disproven`, `unknown` or `requires_semantic_review`. One observation may support several criteria; a criterion may require several observations accumulated over turns. Proof has immutable references, verified scope and an invalidation rule. A task is not one monolithic reviewer verdict.
- **Lookup semantics:** A successful `evidence_lookup` with `resolution=none` proves **a lookup was completed**, when the query and scope cover the requirement. It does **not** prove that a matching accepted fact exists. A historical negative lookup remains proof that the lookup occurred at that time, while any claim of present absence must be revalidated.
- **Host-owned invariants:** Prohibitions such as “do not modify files” are audited within the host's demonstrable operation scope, over the entire relevant task interval. A host cannot assert that arbitrary shell/MCP/external filesystem side effects did not occur unless they were monitored. Pending approvals or unknown side effects keep an invariant unresolved rather than falsely satisfied.
- **Evidence is not a shortcut for doing unrelated work:** Accepted knowledge is projected to inform new tasks. Evidence can complete an objective criterion only when it directly establishes that criterion; it never auto-completes a broader mutation, test or user-deliverable obligation.
- **Liveness:** Before automatic continuation, reconcile new and retained observations. Advance satisfied dependencies atomically, and ask only for genuinely missing information. Repeating the same failing state with no new evidence or changed conditions is a controller defect; stop with a bounded actionable blocker instead.
- **Truth in reporting:** Distinguish *observed live*, *reported by Copilot/tests*, *designed*, and *unverified*. A zero-failure helper suite does not prove the actual VSCodium extension-host orchestration works.


**Status:** Reconciled implementation contract; legacy proposed migration examples are historical sketches, not a description of shipped storage  
**Baseline:** 2026-11-02; reconciled 2026-11-08 (design and observed implementation distinguished)  
**Parent architecture:** [TWINNY_INTENT_FEEDBACK_SYSTEM_OVERVIEW.md](TWINNY_INTENT_FEEDBACK_SYSTEM_OVERVIEW.md)

## 1. Objective

Add a **single, native, persistent TODO system** to Twinny. Tasks are scoped to projects and chats, visible in a compact collapsible checklist, accessible through native tools, and recoverable after reload, model failure, or an interrupted coding session.

This is the first vertical slice of the larger intent, execution, feedback, and recovery architecture. It must be useful **before** Cerebras orchestration or evaluator scoring is implemented.

**Hard requirement:** Do not create a separate `todo.md` for every conversation, task, run, or project. Thousands of tiny documents are neither a reliable query engine nor a sane backing store.

## 2. Storage decision

### 2.1 Recommended default

**One SQLite database per Twinny extension-host storage location**, placed under VS Code's `ExtensionContext.globalStorageUri`. The following WAL filenames describe an earlier native-SQLite proposal, **not** the implemented `sql.js` persistence strategy:

```text
ExtensionContext.globalStorageUri/
  twinny-state.sqlite
  twinny-state.sqlite-wal   (present when WAL is active)
  twinny-state.sqlite-shm   (present when WAL is active)
```

These names are illustrative; resolve the actual location from the ExtensionContext at runtime. The directory may need to be created. Do not hardcode `~/.vscode-oss`, `.vscode`, or repository paths.

The database is **physically global to this extension host**, but **logically scoped** using stable project IDs, conversation IDs, and list IDs. Nothing appears in a project's source tree unless explicitly exported.

Why SQLite:

- One compact managed store instead of thousands of Markdown files.
- Transactional changes and crash recovery.
- Efficient lookup by project, chat, status, task ID, and revision.
- Atomic state transitions and an append-only evidence/audit trail.
- Works offline with a self-hosted agent; no database server to administer.
- A simple export/backup story, with an adapter boundary for future engines.

Do **not** put the full TODO database in `globalState` or `workspaceState` key/value storage. These are suitable for small preferences and the current selection marker, not a growing relational task journal. Workspace-local `storageUri` is a valid alternative for one-workspace data, but a single global database is better for cross-workspace search, conversation discovery, migration management, and one consistent backup.

### 2.2 Remote-host behavior

The store exists **where the extension host executes**. A local VSCodium instance and an SSH/remote extension host may have different physical `globalStorageUri` directories. The UI must not imply automatic synchronization. The first release is local-to-host only, with explicit portable export/import planned.

The implemented adapter is `sql.js` (SQLite WASM) with serialized writes, transactions, and atomic file replacement. It does **not** use WAL. The WAL discussion above is retained only as a caution for any future native-SQLite adapter; never silently switch persistence engines or put a native WAL database on NFS/SMB.

### 2.3 Storage abstraction

Expose a narrowly scoped `TodoRepository` interface to the rest of Twinny. SQLite is the first adapter, not a dependency of React, model prompts, or the execution controller.

```ts
interface TodoRepository {
  initialize(): Promise<void>;
  resolveProject(workspace: WorkspaceIdentity): Promise<ProjectId>;
  ensureConversation(projectId: ProjectId, chatId: string): Promise<void>;
  getOrCreateList(scope: TodoScope): Promise<TodoList>;
  getList(listId: string): Promise<TodoListSnapshot>;
  createItem(input: CreateTodoInput, requestId: string): Promise<TodoItem>;
  updateItem(input: UpdateTodoInput, requestId: string): Promise<TodoItem>;
  addEvidence(input: AddEvidenceInput, requestId: string): Promise<TodoEvidence>;
  getEvents(listId: string, afterRevision?: number): Promise<TodoEvent[]>;
  close(): Promise<void>;
}
```

These are contract sketches, not a claim about current Twinny type names. Keep database transactions inside the adapter and ensure all mutating operations support idempotency or optimistic concurrency.

## 3. Identity and scoping

### 3.1 Project identity

A project gets a stable `project_id` (UUID). Resolve it from the current workspace identity, using normalized folder URIs, remote authority, and a deterministic fingerprint as a **lookup hint**, not as the permanent identity itself. Store aliases so a moved/renamed directory or linked Git worktree can later be associated with the original project intentionally.

Requirements:

- Support normal folders, `.code-workspace` multi-root workspaces, and remote URIs.
- Do not equate identical folder names with identical projects.
- Do not treat a Git branch change as a new project.
- Do not merge two projects automatically just because their Git remote matches.
- Provide a reserved unscoped project for chats with no open workspace.
- Avoid assuming `workspace.workspaceFolders[0]` always represents the intended project.

### 3.2 Conversation identity

A conversation gets a stable `conversation_id`, preferably reusing Twinny's existing persistent chat ID after verifying its lifecycle. If it cannot be trusted, add a UUID mapping. Conversation title, model, provider, and message order are **not** identities.

- Reloading or reopening a chat must resolve to the same TODO list.
- Switching providers or compaction must not change the task identity.
- A chat may link to one primary project in v1; plan for explicit relinking and moves.
- Renaming a conversation does not create another list.
- Importing a conversation must detect identifier conflicts and resolve them deliberately.

### 3.3 TODO list scopes

| Scope | Ownership | Visibility | First release |
|---|---|---|---|
| Chat | `project_id + conversation_id` | One list shown in that chat | **Required** |
| Project | `project_id`, no conversation | Shared board across the project's chats | Schema-ready; UI can follow |
| Cross-project | Explicitly linked IDs | Future portfolios or coordinated tasks | Not in v1 |

A project can contain many chats; each chat has its own canonical list. Project-scoped work is a *separate* intentional list, not an automatic union that silently duplicates chat tasks. A task can later be promoted or linked by an explicit operation that retains its stable ID and provenance.

## 4. Data model

### 4.1 Main entities

| Entity | Main fields | Purpose |
|---|---|---|
| `projects` | `id`, `display_name`, `created_at` | Stable project namespace |
| `project_aliases` | `project_id`, `workspace_fingerprint`, `remote_authority`, `observed_uri` | Resolve physical workspace references |
| `conversations` | `id`, `project_id`, `title`, `created_at`, `updated_at` | Tie chats to projects without using filenames |
| `todo_lists` | `id`, `project_id`, `conversation_id?`, `scope`, `revision`, `intent_id?`, `created_at` | One canonical board per scope |
| `todo_items` | `id`, `list_id`, `parent_id?`, `title`, `details?`, `status`, `verification`, `priority`, `sort_order`, `version`, `assigned_run_id?`, `blocked_reason?`, timestamps | Current task state |
| `todo_dependencies` | `item_id`, `depends_on_item_id` | Explicit dependency graph |
| `todo_events` | `id`, `list_id`, `item_id?`, `list_revision`, `event_type`, `actor`, `request_id`, `payload_json`, `created_at` | Append-only record of changes |
| `todo_evidence` | `id`, `item_id`, `run_id?`, `kind`, `summary`, `result`, `reference?`, `created_at` | Verification and observations |
| `agent_runs` | `id`, `conversation_id`, `item_id?`, `provider`, `model`, `status`, `started_at`, `finished_at` | Trace task attempts and interruptions |

Later, introduce separate `intents`, `intent_revisions`, evaluator judgments, playbook invocations, and richer handoff records. Do not prematurely embed those semantics in TODO title fields.

### 4.2 Legacy example schema (historical, **not** the active migration)

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS todo_lists (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  conversation_id TEXT REFERENCES conversations(id),
  scope TEXT NOT NULL CHECK (scope IN ('chat', 'project')),
  revision INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  CHECK ((scope = 'chat' AND conversation_id IS NOT NULL)
      OR (scope = 'project' AND conversation_id IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS one_chat_todo_list
  ON todo_lists(conversation_id) WHERE scope = 'chat';
CREATE UNIQUE INDEX IF NOT EXISTS one_project_todo_list
  ON todo_lists(project_id) WHERE scope = 'project';

CREATE TABLE IF NOT EXISTS todo_items (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL REFERENCES todo_lists(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES todo_items(id),
  title TEXT NOT NULL,
  details TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  verification TEXT NOT NULL DEFAULT 'not_checked',
  priority INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  assigned_run_id TEXT,
  blocked_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (status IN ('pending','in_progress','in_review',
                   'blocked','completed','cancelled')),
  CHECK (verification IN ('not_checked','passed','failed','waived'))
);

CREATE INDEX IF NOT EXISTS todo_items_by_list_status
  ON todo_items(list_id, status, sort_order);

CREATE TABLE IF NOT EXISTS todo_events (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL REFERENCES todo_lists(id) ON DELETE CASCADE,
  item_id TEXT REFERENCES todo_items(id),
  list_revision INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(list_id, list_revision)
);

CREATE TABLE IF NOT EXISTS todo_evidence (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES todo_items(id) ON DELETE CASCADE,
  run_id TEXT,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  result TEXT NOT NULL,
  reference TEXT,
  created_at TEXT NOT NULL
);
```

This is a representative core, **not** a complete drop-in migration: add the remaining entity tables, foreign-key consistency enforcement, full migration metadata, and dependency-cycle validation before shipping. Use monotonically increasing list revisions and item versions. A task's `parent_id`, dependencies, project and conversation relationship must be validated within the repository, not trusted from raw model input.

### 4.3 Write transactions and event journal (adapter-neutral intent)

Each accepted mutation executes in **one SQLite transaction**:

1. Validate project/chat/list scope and agent authorization.
2. Check `request_id` for repeat delivery; return the existing result if already applied.
3. Compare `expected_item_version` or `expected_list_revision` to the database.
4. Validate the state transition and any dependencies/verification constraints.
5. Update current task rows, increment revision, and append the event.
6. Commit and notify subscribers; never notify before a successful commit.

An event is provenance, not an enormous copy of source code or an entire chat transcript. Store compact metadata and bounded result summaries. Link to external trace logs or artifacts when needed.

Concurrency: SQLite has a single writer at a time. Keep write transactions short, use a busy timeout, use connection coordination for multiple extension windows, and test concurrent revision conflicts. Use an appropriate SQLite online backup method rather than blindly copying a live WAL database file.

## 5. Task state machine

### 5.1 Status vs. verification

The **task status** reflects workflow progress; **verification** reflects the quality of evidence. Keep these independent.

```text
pending -> in_progress -> in_review -> completed
   |          |              |
   +-------> blocked <--------+
   |          |              |
   +-------> cancelled <------+
              |
              +-> in_progress (resumed after blocker resolved)
```

- `pending`: accepted into the plan, not being executed.
- `in_progress`: assigned to an active or recoverable work attempt.
- `in_review`: implementer reports ready; verification is not yet accepted.
- `blocked`: requires an explicit reason and next recovery action.
- `completed`: acceptance criteria met with recorded verification, or a deliberate user-authorized waiver.
- `cancelled`: intentionally discontinued; not a successful result.

Verification values: `not_checked`, `passed`, `failed`, `waived`.

**Guardrails:**

- A model's `todo_update(status="completed")` remains `in_review`; only the dedicated `twinny_todo_complete` tool, used in response to an explicit user completion request, can record a waived completion. Parent and dependency requirements still apply.
- Failed verification returns the task to `in_progress` or `blocked`, with an event explaining why.
- `waived` requires an authorized user or explicit controller policy and must preserve a reason.
- After a crash, an orphaned `in_progress` task is marked as interrupted/stale at the run level, not auto-completed or silently duplicated.
- Reopening a task preserves its previous attempts and evidence.
- Parent completion requires satisfied child/dependency rules or explicit documented override.

### 5.2 Single-active-task rule for v1

Allow at most **one active task per chat** at a time by controller policy, to simplify context projection, verification, and error recovery. The schema can accommodate parallel tasks later. Project-scoped tasks may be read from any chat, but must not accidentally start multiple conflicting agents.

## 6. Native TODO tool API

Use namespaced native tools to avoid ambiguity with an existing external Todos MCP server. Suggested initial tool names:

| Native tool | Arguments (conceptual) | Result |
|---|---|---|
| `twinny_todo_list` | `project_id?`, `conversation_id?`, `include_completed?` | Canonical list snapshot with revision |
| `twinny_todo_get` | `item_id` | Task details, acceptance checks, evidence summary, version |
| `twinny_todo_create` | `list_id`, `title`, `details?`, `parent_id?`, `priority?`, `request_id` | Created task and list revision |
| `twinny_todo_update` | `item_id`, `expected_version`, patch, `request_id` | Updated task, version, or explicit conflict; completion claims become `in_review` |
| `twinny_todo_complete` | `item_id`, `expected_version`, `request_id`, explicit user-request reason | Completed task with `waived` verification, subject to child/dependency rules |
| `twinny_todo_evidence` | `item_id`, `kind`, `summary`, `result`, `run_id?`, `request_id` | Evidence record and updated revision |

The controller supplies trustworthy scope and caller identity. Do not let a model forge `project_id`, agent identity, or completed verification results merely by providing strings. Read tools are read-only. Mutations pass through a single validated service, never directly through webview SQL.

Tasks can be created manually in the UI or proposed by models. Bulk replace/reconcile and reordering can wait for a subsequent stage; when introduced, preserve task IDs, human edits, evidence, and explicit user decisions.

### Example tool result

```json
{
  "list_id": "list-uuid",
  "project_id": "project-uuid",
  "conversation_id": "chat-uuid",
  "revision": 14,
  "items": [
    {
      "id": "task-uuid",
      "title": "Repair first TypeScript compiler error",
      "status": "in_progress",
      "verification": "not_checked",
      "version": 3,
      "acceptance": ["npx tsc -p . --noEmit exits 0"],
      "last_run_id": "run-uuid"
    }
  ]
}
```

These IDs are illustrative and need not match Twinny's current format.

## 7. UI requirements

### 7.1 Above-chat TODO control

- Compact collapsible list displayed above chat, **not** inside a transient settings popup.
- Show current task and `n of m` count; distinguish completed, blocked, in review, and executing.
- Checkbox/action changes must be validated by the extension host and then reflected from its authoritative response.
- Expand to see nested tasks, priority/dependencies, verification evidence, latest failure, and who made changes.
- Keep the list stable when the model generates new chat output or the user changes providers.
- Avoid duplicate lists when an intent compiler or implementer emits plans in chat.
- Search/filter completed items; hide completed by default without deleting their history.
- Surface an interrupted run clearly and offer resume/retry or manual intervention.

### 7.2 Human control

- User can create, edit, reorder, block, reopen, cancel, or explicitly approve completion.
- Manual actions supersede uncommitted model proposals. Record the actor and revision.
- A model may suggest revising a user-authored task, but must not silently overwrite the user's instructions.
- The panel is a projection of stored state, never a second copy of TODO truth.

## 8. Integrating with the Intent Compiler and evaluator

> **Current behavior:** TODO plans now come from **Feedback** (`twinny.feedback.*`) on every ordinary agent request, independently of the explicitly invoked Prompt Compiler (`twinny.promptCompiler.*`). See [INTENT.md](INTENT.md).

**Stage 1:** Native TODOs work with no intent compiler, no Cerebras, and no external TODO MCP.

**Stage 2:** An intent compiler creates or revises tasks using stable IDs and acceptance criteria. Plan reconciliation compares an incoming proposal to the existing list and performs targeted updates, not wholesale deletion/recreation.

**Stage 3:** Mycroft or another implementer operates on the current task. The execution controller links actual tool results and compiler/test evidence to the task. Implementer claims become `in_review` proposals rather than automatic completion.

**Stage 4:** An evaluator compares task evidence to the latest intent and criteria, requests correction or accepts completion, and may suggest a revised plan. Its decision and rationale are recorded. It can send feedback to the implementer through the controller, and the implementer may send new facts upstream.

The models are replaceable. The store, state machine, and tool contracts do not depend on a single model or provider.

## 9. Recovery, retention, and backup

- Every model invocation has a `run_id` and an outcome (started, completed, failed, cancelled, interrupted).
- If a malformed GPT-OSS tool response produces HTTP 500, record bounded details (status, error category, request/correlation IDs, provider/model, token counts when available). Keep the task pending/in-progress/review as appropriate; **never** infer success from a failed response.
- On restart, reconstruct list state from canonical rows, reconcile interrupted runs, and show an actionable resume status.
- Tool argument size limits and duplicate-edit detection belong to the execution/tool layer, not the TODO database.
- Prune or archive old verbose run diagnostics by policy while retaining task/event provenance needed for audit and deduplication.
- Offer export of a task list as Markdown or JSON on demand. Markdown is a presentation/export format, **not** the system of record.
- Support deliberate JSON export/import for portability. Include schema version and stable IDs; detect collisions and avoid duplicate imports.
- Use SQLite's backup facility or a safe checkpoint/closed-database process. Include WAL considerations and backup restoration tests.

## 10. Delivery: one complete vertical slice

### Slice A: persistence + tools + UI

1. Inspect existing Twinny chat IDs, workspace identity, and extension lifecycle; do not assume conventions.
2. Add a `TodoRepository` interface and SQLite implementation in extension-host code.
3. Implement migrations and project/chat resolution, including no-workspace fallback.
4. Implement canonical list CRUD, item versions, request idempotency, and event logging.
5. Add initial native TODO tools to the existing model-facing tool registry, subject to normal permission checks.
6. Add the above-chat collapsible checklist and bridge events for snapshots/changes.
7. On startup, load the correct list; on reload, render the same IDs/states with no duplicates.
8. Add unit/integration tests, run `npx tsc -p . --noEmit` and `npm run build`, inspect the diff, then test actual UI behavior.

**Slice A is complete only when:** A task can be created by the user or native tool, displayed exactly once, updated, reopened, and recovered after editor restart. A stale update produces a conflict rather than overwriting newer changes. The existing Tool Picker, MCP discovery, and inference still work.

### Slice B: execution and evidence

Implemented for Feedback & Verification v1: actual workspace tool results are associated with the active Intent task, command exit codes are preserved, and model-authored evidence summaries remain separate. Evaluations are applied atomically with optimistic task-version and plan-revision checks; duplicate requests are idempotent and user-completed tasks are never reopened.

### Slice C: planner/evaluator and repair playbook

Intent plan reconciliation, bounded active-task projection, structured evaluation, revision feedback, and manual review retry are implemented. The evaluator is not permitted to execute commands. PEG-native 500 recovery, autonomous retries, and recursive replanning remain out of scope.

**Do not build Slices A, B, and C as one enormous agent edit.** Each slice has explicit tests, stable checkpoints, and a reviewable diff.

## 11. Acceptance test matrix

| Scenario | Expected result |
|---|---|
| Chat A and B in same project | Separate chat lists; no task bleed |
| Two projects with same folder name | Separate project IDs |
| Chat reload, rename, provider switch | Same canonical list and task IDs |
| Window/extension restart | Persisted statuses and revisions restored |
| Repeated identical tool request ID | No duplicate task/event |
| Conflicting concurrent update | Explicit version conflict; no last-writer-wins overwrite |
| Complete without verified evidence | Rejected or moved to review |
| Compiler test passes | Evidence linked; controller may accept completion |
| Runtime HTTP 500 or parser error | Task remains recoverable; never falsely completed |
| Remote extension host vs local host | Clearly distinct stores unless explicitly imported/synced |
| Project-scope task vs chat-scope task | Correct isolation and intentional project sharing |
| Existing MCP Todo server enabled | Namespaced native tools; no accidental duplicate canonical state |
| Large task history | Fast indexed list queries; no thousands of Markdown files |
| Existing Tool Picker and agent tooling | No regressions |

## 12. Decisions still requiring code inspection

- **Resolved:** the existing stable conversation ID scopes one list per conversation. Project scope uses the sorted workspace URI set; chats without a workspace use a reserved unscoped project.
- **Resolved:** use `sql.js` SQLite WASM instead of relying on `node:sqlite`, which is not guaranteed by the supported VS Code engine. The build packages the WASM runtime with the extension. Writes are serialized with a lock, a SQLite transaction, and atomic database-file replacement rather than WAL.
- **Resolved for Slice A:** the repository is the persistence boundary; no existing database abstraction was suitable to extend.
- **Deferred:** moved/renamed project aliases require a deliberate association flow; URI changes currently resolve to a distinct project identity.
- **Resolved for Slice A:** verification states are `not_checked`, `passed`, `failed`, and `waived`. Model completion claims change task status to `in_review`; the explicit `twinny_todo_complete` tool or checklist action can waive verification only in response to a user completion request.
- **Resolved:** this is a native Twinny toolset. It does not depend on, import, or merge with an external Todos MCP; any separately configured MCP tools remain independent.

## 13. Implementation status

The first vertical slice is implemented: one persistent, project-and-chat-scoped list; host-validated native tools (`twinny_todo_list`, `twinny_todo_get`, `twinny_todo_create`, `twinny_todo_update`, `twinny_todo_complete`, and `twinny_todo_evidence`); and an above-chat checklist for creating, editing, reordering, and changing task status. The extension host owns scope and authoritative state. The native TODO-only tool loop is available in ordinary chats even when Agent mode is off; it exposes no workspace tools. User-authored task content is protected from silent model overwrite; stale writes conflict; model completion claims become `in_review`; explicit user completion through the checklist or `twinny_todo_complete` is audited as `waived`; reopening clears stale verification. Intent Compilation v1 now emits a validated, versioned task plan and reconciles it transactionally into the same chat-scoped list using stable task IDs. Compiler-managed tasks retain their source, acceptance criteria, dependencies, and plan association; repeated or failed compiles do not duplicate or erase tasks, and definition updates preserve status, verification, and evidence. The active task is projected into the implementing model context with bounded goal, constraints, acceptance criteria, dependencies, and recent evidence.

Persistence, tool, protocol, and checklist code are in place. llama.cpp receives a reduced projection of tool JSON schemas (types, object/array structure, required fields, and enum values conveyed in descriptions) to avoid constraints that its grammar parser may reject; Twinny still validates tool arguments at execution. If llama.cpp nevertheless rejects native tools, the loop falls back to the text tool protocol before any tool runs. Other providers receive their original schemas. Empty optional parent IDs are normalized to no parent, evidence accepts common success/failure aliases for canonical results, and tool instructions require reporting errors even if a later retry succeeds. An explicit chat request to complete a TODO can use `twinny_todo_complete`; a model status claim through `twinny_todo_update` continues to become `in_review`. The focused persistence, scope-isolation, idempotency, concurrency, completion-guard, and native-tool tests pass; the bundled-WASM test passes, and the packaged VSIX includes `out/sql-wasm.wasm`. In-editor interaction and restart checks remain part of the final Slice A validation. Feedback & Verification v1 is now implemented in the same SQLite backend: actual Twinny tool results (including command output and exit codes) are attached to active Intent tasks separately from model-authored evidence notes; a configured Intent-role provider evaluates each eligible task after the implementing turn; decisions and evidence references are version-checked and durably recorded; accepted tasks become verified completed, revision decisions return tasks to progress with next-turn context, insufficient evidence remains in review, and blocked decisions preserve a reason. The TODO panel provides an explicit manual review retry. Automatic evaluation can be disabled independently of Intent Compilation. Bounded execution reconciliation now reviews the active intent task after an implementing turn and can automatically dispatch a corrective continuation through the existing chat/provider/tool loop. Retry and no-progress limits, cancellation checks, and evaluator failure handling prevent an unverified turn from being treated as success. Workspace edit operations use bounded checkpoints that capture both editor-buffer and disk contents, reject rollback after concurrent changes, and monitor newly introduced diagnostics; a confirmed catastrophic regression blocks further mutations and supplies recovery feedback. The controller does not yet resume an interrupted execution after extension reload, and arbitrary side effects from `run_command` are outside file-checkpoint rollback. Full extension-host verification of diagnostic-spike rollback remains outstanding.

Administrative-TODO control: when Feedback manages a plan, every title, description, and acceptance criterion is validated structurally before synchronization. Text that instructs Mycroft to create, update, verify, or report on the TODO system is rejected unless the user's objective concerns TODO functionality. A violating plan gets one corrective Feedback retry that names the offending paths, and an invalid plan is never stored. An already active plan can be repaired by removing only the offending criteria, which increments the plan revision, preserves task identity, observations, and verification, and leaves unrelated tasks unchanged. This detector is heuristic. Its objective basis is the stored intent goal, which can differ from the user's original prompt.

Deterministic verification runs before Feedback. A plan whose criteria are all source-location or other objective facts is decided by the host from trusted observations: the fact must have a successful read, a workspace-relative path, a matching symbol and line span, and a current fingerprint. Outcomes are `proven`, `disproven`, `unknown`, and `semantic`. The currently documented English-criterion classifier attempts to decide an accepted-evidence criterion with no path or symbol anchor from the host's `host_evidence_check` observation, which records the project-wide accepted-fact lookup (`resolution: found` or `none`, the query, the scope, and the fact IDs) when the turn's preflight runs. That observation is host-recorded, not a tool the model can call. An inquiry ("Confirm whether accepted evidence exists") **should** be proven by any completed, successful, sufficiently scoped lookup, including `none`; November 8 live traces show this behavior failed and it is not verified as fixed. A claim ("Accepted evidence exists") is decided by count: absence is proven only while no accepted fact was recorded after that check, and presence needs a listed fact that is still live. A failed or subject-scoped lookup proves neither. The no-modification criterion is a prohibition: it is proven when the plan's operation record exists and holds no successful mutation Twinny executed, unknown when no operation was recorded at all, and it is scoped to operations Twinny controls. Only `semantic` criteria reach Feedback. Facts are recorded in `todo_accepted_evidence` (schema version 6), keyed by list, symbol, and path. Replacing a fact marks the older row historical rather than deleting it. The read-only `twinny_evidence_lookup` tool returns accepted facts with freshness, and the Mycroft context lists current facts before the tasks. Limits: a fact covers the declaration's line span rather than the whole function body, and "fresh" means the host re-fingerprints the file on verification. It does not mean the agent performed a new read. As of the uploaded implementation notes, typed criterion descriptors are **not** established end-to-end; symbol/path anchors and English-language classifiers remain in use. The reconciled contract below replaces these with a versioned, typed JSON control protocol as the target, not a claim of current completion.


## Reconciled TODO and persistence implementation contract

### Task/criterion ownership

A TODO is a durable **unit of user-relevant work**, not an administrative instruction to manage Twinny. Preflight, repository lookup, criterion verification and feedback dispatch are host/controller activities; add them as task criteria or linked events when useful, not as synthetic dependent tasks whose completion obstructs the user's actual deliverable. Genuine multi-step dependencies are supported and can be satisfied by host-owned events without Mycroft repeating a tool call.

A task's `status` (`pending`, `in_progress`, `in_review`, `blocked`, `completed`, `cancelled`) is different from overall `verification` (`not_checked`, `passed`, `failed`, `waived`), and both differ from the **per-criterion** results (`proven`, `disproven`, `unknown`, `requires_semantic_review`). The canonical repository must retain the criterion ID, original typed contract, supporting observation/accepted-fact IDs, check time, verifier, reason code, source/plan version and invalidation rule. These can use existing normalized tables or versioned JSON payloads if atomic and indexed enough; do not assume a new table is necessary. A TODO is complete only after all mandatory criteria and execution constraints have been reconciled. An implementer's `twinny_todo_update(status=completed)` is a *claim* and never directly overrides verification.

### Persistence reality and migration policy

Existing implementation documentation identifies `sql.js` WASM plus serialized SQLite transactions and atomic file replacement under extension-host global storage. This is the **current documented adapter**. Native SQLite WAL files and `node:sqlite` are historical proposals, not shipping assumptions. Preserve the repository adapter boundary and per-project/per-conversation scoping; do not introduce another DB, shadow memory index, or WAL mode merely to implement criterion contracts. Any storage migration must be reversible or safely backable up, idempotent, preserve existing TODO/evidence/plan IDs and history, and be tested through close/reopen. Use the actual source migrations to establish live schema version rather than relying on a document's version number.

### Identity, authorization and durable facts

The host assigns project, chat, plan, task, criterion and observation identities. A project is the knowledge/read boundary; a conversation is the default TODO-write boundary. Same-project, other-conversation evidence and TODOs can be read when authorized but not modified. Other-project records are private. Retrieval and source validity do not depend on chat transcript length or an LLM's memory. A fact from another conversation may be cited by reference in the active task without copying or mutating its origin record.

`todo_evidence`/observation and accepted-fact rows have separate trust states. Acceptance must atomically promote demonstrable source facts (when the actual criterion calls for source knowledge) or record an idempotent recovery obligation. Completion by itself cannot fabricate or promote a fact. Preflight's `none` result is a valid completed lookup but **not** an accepted source-location fact. A file's authoritative fingerprint must be derived from the same current buffer/disk representation the `read_file` tool used. When source changes, preserve the older fact as history and require fresh proof for current criteria.

### State transitions and liveness

A host-proven task may move directly to completed through the validated controller transition; it need not manufacture `in_review` and a Feedback call first. When unresolved semantic checks exist, `in_review` is appropriate. `blocked` requires a reason, precise missing criterion and recovery possibility; `completed` requires a persisted result and provenance. After task completion, dependent tasks become eligible immediately under the same transaction/reconciliation cycle, even if the satisfying lookup returned zero matches. Automatically continue only for a new actionable step. Stop unchanged rejection loops with a structured no-progress outcome, rather than claiming successful execution.

For “no files modified,” maintain a task-interval invariant based on **observed** mutations plus their outcomes and tool categories. Native edit tools can be monitored; `run_command`, unknown MCP side effects, other applications, and external writes require explicit tracking or an honestly bounded claim. A failed edit is not a successful mutation. Revalidate the invariant at final commit, not only at the beginning.

### User-facing status and API

Keep the above-chat TODO panel a projection of repository state. Its eventual criterion detail should show each typed criterion's proof state, evidence reference(s) and specific missing/failed reason, without exposing private internal prompts. Existing native tools stay namespaced and operate through the host's validated API. The model receives structured `task.dispatch` data and returns structured claims/references; the host does not infer task completion from a conversational “done.”

### Required task lifecycle regression

A single read-only implementation task asks to (i) check existing knowledge, (ii) find source location, (iii) establish declaration-body end boundary, (iv) obtain current authoritative fingerprint and (v) avoid modifications. Start with a successful subject-scoped `none` lookup. Assert lookup criterion `proven`, not `disproven`; then carry out reads with a real native `read_file`. Persist per-criterion proof IDs and complete the task without semantic review or repeated investigation. If the planner legitimately splits the work, assert the lookup prerequisite completes and releases its dependent task immediately. Close/reopen the repository, then use the accepted fact from another chat in the same project without a redundant source read. Exercise both 169–219 incomplete and 169–220 complete source observations against the **specific test snapshot** rather than pinning those line numbers globally.


## 14. References

- [VS Code extension data storage](https://code.visualstudio.com/api/extension-capabilities/common-capabilities)
- [VS Code ExtensionContext API](https://code.visualstudio.com/api/references/vscode-api)
- [SQLite WAL design and limitations](https://www.sqlite.org/wal.html)
- [SQLite isolation and concurrency](https://www.sqlite.org/isolation.html)
