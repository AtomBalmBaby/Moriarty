# Twinny: Intent, Execution, Feedback, and Recovery System

**Status:** Proposed architecture  
**Version:** 0.1, 2026-11-02  
**Companion specification:** [TWINNY_NATIVE_TODO_SYSTEM.md](TWINNY_NATIVE_TODO_SYSTEM.md)

## 1. Purpose

Make Twinny's coding agent dependable for tasks that span many tool calls, compiler iterations, model responses, chat sessions, and provider handoffs. The system must preserve the user's objective, track demonstrable progress, reconcile failures, and keep agents working without repeatedly requesting routine approval.

The immediate motivation is concrete: Twinny's agent can perform short operations such as inspecting a repository and making a commit, but long-running coding work has suffered malformed PEG-native tool calls (HTTP 500), repeated or oversized edits, cascading TypeScript errors, false completion reports, lost task context, and uncertain recovery after interruption.

The architecture is **not** merely a prettier checklist. TODO tracking is the visible and executable projection of a broader, durable intent and feedback system.

## 2. Design principles

1. **Application state is authoritative.** Models may propose changes; Twinny validates and records actual state transitions.
2. **Intent outlives an inference.** Task objectives, constraints, plans, evidence, and decisions survive compaction, reloads, crashes, and model/provider changes.
3. **Evidence outranks narration.** A model saying "done" does not prove a file changed, a test passed, or a tool ran.
4. **Small, verifiable units of work.** Each step has an observable result, exit condition, and bounded recovery strategy.
5. **Bidirectional feedback.** Planning, implementation, verification, and user input can continuously revise one another; they are not a mandatory one-way pipeline.
6. **One source of truth.** The UI, native TODO tools, controller, and model projections read/write the same store.
7. **Tools and permissions are separate.** Tool enumeration does not require fake executable sinks; actual execution still obeys workspace, agent, and policy restrictions.
8. **Autonomy without silent corruption.** Routine tool execution can proceed unattended under allowed policy, while structural failures are detected and made recoverable.
9. **Self-hosted and open-source first.** Local inference and local storage are first-class, with no commercial service dependency for core operation.
10. **Incremental, testable delivery.** Complete one vertical slice before introducing elaborate multi-agent coordination.

## 3. Conceptual model

```text
User objective and constraints
             |
             v
    Durable versioned Intent <-----------------------------+
             |                                           |
             v                                           |
    Plan / Native TODOs <--------------------+             |
             |                              |             |
             v                              |             |
    Execution controller                     |             |
      |       |                              |             |
      |       +--> Model(s) / tools          |             |
      |                   |                  |             |
      +<-- Observations / tool results      |             |
             |                              |             |
             v                              |             |
    Verification / evaluator                |             |
             |                              |             |
             +--> accept verified progress -+             |
             +--> revise or retry ---------+-------------+
             +--> mark blocked with evidence

    All transitions -> durable event journal -> UI and projections
```

These roles are **logical responsibilities**, not fixed model assignments. Initially, an intent-capable provider such as Cerebras may plan and evaluate while Mycroft implements. A single model can cover multiple responsibilities, or another provider can take over after a handoff. Agents may provide feedback to one another through the controller. The longer-term ALICE workbench may use richer peer coordination; Twinny should not hardwire a linear architecture into the shared data contracts.

## 4. Full feature set

### 4.1 Durable, versioned intent

An intent record describes *what success means*, independent of a particular model or prompt window:

- Stable `intent_id`, project identity, owning or linked conversations, creation time, revision number.
- User goal, scope, exclusions, constraints, assumptions, and requested outcomes.
- Acceptance criteria and preferred verification methods.
- Relevant repository/environment context and permitted capabilities.
- Dependencies, unresolved questions, user decisions, and feedback history.
- Immutable intent revisions with author, rationale, and links to previous revisions.

An intent revision must not silently rewrite the user's original requirements. Preserve user-authored statements and distinguish them from model interpretations. Keep `/intent` unassigned as a future control surface until its semantics are explicitly designed.

### 4.2 Native task planning and TODOs

- One canonical task model with project and conversation scopes, hierarchical tasks, dependencies, priorities, ordering, and statuses.
- Stable IDs across re-planning. A plan revision updates existing tasks instead of duplicating the whole list.
- Explicit acceptance criteria, verification status, evidence, attempts, timestamps, and blocked reasons.
- A collapsible checklist over chat with progress, current task, and details on demand.
- Native create/read/update/list operations callable by the controller and permitted agents.
- The plan is stored by Twinny, not embedded solely in model chat or a `todo.md` document.

See the companion TODO specification for exact schemas and transition rules.

### 4.3 Execution controller

The controller should:

- Select the next eligible task according to dependencies and priorities.
- Establish the current project, chat, intent revision, and tool-permission context.
- Dispatch a bounded step to a selected provider/model.
- Record model request IDs, tool attempts, result summaries, and execution status.
- Maintain one active task per chat initially; allow broader concurrency later only with conflict control.
- Apply deterministic stop conditions and recover from interrupted turns.
- Treat tool results, filesystem changes, compiler exit codes, and evaluator decisions as separate observations.

The controller must not assume that the agent's last narrative message constitutes task completion.

### 4.4 Feedback and reconciliation

Feedback comes from the implementer, evaluator, compiler, tests, diagnostics, tool results, user edits, and application state. A reconciler compares those observations with intent and task acceptance criteria.

Example loop:

1. Planner proposes a step: modify a native-tool inventory function without changing runtime permissions.
2. Controller starts a task and records the expected observations.
3. Implementer edits source and invokes a TypeScript playbook.
4. Compiler returns diagnostics; agent repairs the earliest underlying error and retries.
5. Verifier checks compilation, build, relevant tests, actual diff, and requested behavior.
6. Evaluator accepts, requests changes, revises the plan, or marks the task blocked with evidence.
7. Controller commits the validated transition and chooses the next step.

Feedback & Verification v1 uses a separate, structured evaluator prompt over the configured Intent-role provider. It records versioned decisions, criterion results, supporting observation IDs, corrective instructions, and completion/correctness/alignment scores in the existing project-and-chat-scoped TODO database. Scores are advisory. **Completion is a validated state transition**, never a score threshold or a fluent assertion. Model-authored evidence notes are kept distinct from Twinny-recorded tool results; accepting a test or compile criterion requires a trusted successful run_command observation with exit code 0. Review happens after the implementing turn has persisted its TODO claims and tool results. Stale, malformed, timed-out, or unavailable evaluations do not change task state; revision feedback is projected into the next task context.

Verification is deterministic first. When every criterion is an objective source fact that trusted observations already establish, the host decides it without calling Feedback. Feedback is consulted only for criteria that need a semantic judgment, and it is given only those criteria with their evidence. Accepted facts are stored durably in SQLite as current or historical records, keyed by list, symbol, and path. They are retrieved before new investigation and are not held in the model's conversation. A fact is never silently rewritten: when its source changes, the old record is kept as historical evidence, and the fact is accepted again only after new trusted evidence verifies.

Feedback is ongoing: an implementer can report a newly discovered dependency, a verifier can invalidate an earlier assumption, and a user can change scope. Every actor can trigger reconciliation without destroying the original goal.

### 4.5 Playbooks and deterministic work loops

A playbook is a reusable procedure with inputs, allowed tools, observable checks, exit conditions, bounded retries, and failure escalation. Initial playbooks:

- **TypeScript compile and repair:** run `npx tsc -p . --noEmit`; on failure inspect the first causal diagnostic and recent diff; fix minimally; rerun until success or bounded failure.
- **Build and verify:** type-check, build, targeted tests, `git diff --check`, and evidence capture.
- **Safe edit:** snapshot, unique-anchor validation, apply once, check postconditions, roll back if an edit structurally corrupts a file.
- **Git checkpoint:** inspect status/diff, stage requested files, commit only after configured checks.
- **Malformed response recovery:** preserve active state and last tool result; reduce context and retry appropriately instead of restarting the whole task.

Playbooks should work even when no separate planner is connected. They are deterministic controller behavior where possible, not prose that the model is merely asked to remember.

### 4.6 Error handling and resilience

Handle at least these failure categories distinctly:

| Failure | Required behavior |
|---|---|
| PEG-native parser / model response HTTP 500 | Record bounded diagnostic details; keep task active or blocked, not completed; retry only under policy; support alternative response format/provider |
| Oversized or repetitive tool arguments | Reject before mutation, with a useful diagnostic; do not silently truncate executable content |
| Failed or ambiguous edit | Preserve before-image and undo data; require unique match and postcondition check |
| Compiler error cascade | Inspect the initiating edit; rollback a structurally broken edit before chasing hundreds of diagnostics |
| Tool timeout / provider stall | Bounded generation and tool time budgets; cancel and record the interrupted attempt |
| Agent assertion conflicts with tool evidence | Keep task unverified; request reconciliation |
| Window reload, extension crash, context compaction | Restore intent, task state, and latest verified checkpoint from durable storage |
| Provider/model handoff | Build a budgeted context projection from authoritative state, not from a giant chat transcript |

These requirements do not assume every observed 500 has the same root cause. Collect sufficient structured evidence to distinguish provider formatting, model output, serializer, and tool dispatcher failures.

### 4.7 Context projection and model handoffs

Provide each inference with a **bounded projection** containing:

- Current intent revision and non-negotiable constraints.
- Current task, dependencies, expected verification, and last known outcome.
- Recent relevant evidence and changed files, not every historical tool result.
- Relevant project instructions and policy/tool permissions.
- A concise failure/retry summary and explicit stop condition.

Keep full event history in storage, not in the model prompt. Projection format may vary by provider and context budget, but all views resolve to the same canonical data.

### 4.8 Tool registry, permissions, and approval policy

- One authoritative tool-metadata inventory, shared by Tool Picker and model-facing execution assembly.
- Discoverable tools can remain visible when unavailable or disabled; display why.
- Persist user/agent tool selections separately from organizational policies and execution availability.
- Existing team/seat policies remain intact; this feature must not alter licensing or bypass organization restrictions.
- Auto-run or a "Never ask me" preference applies only to permitted actions in its configured scope. It avoids routine prompts, but does not silently authorize forbidden tools or out-of-scope destructive operations.
- No fake editor or file-operation sinks should be required to populate the Tool Picker.

### 4.9 UI and observability

- Collapsible TODO strip/panel above chat; expandable task detail, history, evidence, current attempt, and blocked reason.
- Plan revisions and evaluator feedback visible without flooding chat.
- Model/provider identity and status shown for active runs.
- Clearly distinguish **executing**, **awaiting verification**, **blocked**, **failed attempt**, and **completed**.
- Trace mode records lifecycle events and compact correlation IDs.
- Diagnostics include actual 500 responses and parser failures when available, with sensitive details redacted and output size limits.
- Prefer no standalone implementation report files by default. Reports or Markdown exports are explicit user actions.

### 4.10 Persistence, import/export, and portability

**Default:** one SQLite database owned by the Twinny extension under `ExtensionContext.globalStorageUri`; logically partition records by project UUID and conversation UUID. Do not generate `todo.md` for each task/chat.

The storage module exposes an internal repository interface so a future backend or synchronization service can be added without changing the controller or UI. The initial application remains fully functional offline.

Because the database lives with the extension host, different local or remote extension hosts may have separate stores. Never silently imply shared cross-machine state. Provide user-visible export/import, backup, and eventual explicit synchronization semantics.

Use SQLite transactions, migrations, foreign keys, indexes, and an event journal. Local WAL mode can be considered with proper checkpoint and backup handling; **do not place a WAL database on a network filesystem**.

## 5. Component boundaries

| Component | Owns | Does not own |
|---|---|---|
| Intent store | Intent revisions, goal constraints | Deciding whether model prose is true |
| TODO store | Task identities, statuses, events | Executing tools |
| Execution controller | Dispatch, retry policy, lifecycle | UI rendering |
| Agent/model adapter | Provider requests and responses | Permanent task truth |
| Tool dispatcher | Permission checks and actual tool execution | Re-planning intent |
| Verification/evaluator | Evidence-based judgment and recommendations | Mutating tasks without validated transitions |
| Playbook engine | Deterministic steps and stop conditions | Unbounded reasoning loops |
| Webview | Presentation and user actions | Direct database access |
| Storage adapter | Transactions, concurrency, migrations, queries | Provider-specific assumptions |

## 6. Security and data protection

- The extension host, not the webview, owns database access and policy enforcement.
- Validate and authorize every inbound bridge request, including project/chat identity and task revision.
- Store minimal error details by default. Do not automatically persist credentials, full prompts, secret-bearing tool payloads, or extensive source snapshots in the task database.
- Protect sensitive credentials through the platform's secure secret store; never put them in TODO text or SQLite configuration records.
- Maintain an auditable record of automatic actions without dumping enormous unbounded logs into SQLite.
- Workspaces and remote hosts are not automatically trusted because their files appear in a project.

## 7. Delivery roadmap

| Stage | Deliverable | Verification gate |
|---|---|---|
| **0: Baseline** | Preserve current Tool Picker, commit baseline, characterize existing chat IDs and storage | Existing build and tools continue working |
| **1: Native TODO vertical slice** | SQLite adapter, project/chat IDs, native CRUD/status tools, single list in UI, persistence | Create/update/reload/restart retains exactly one canonical list |
| **2: Execution evidence** | Run/attempt IDs, tool-result links, verification states, crash recovery | Interrupted task survives reload and is not falsely marked done |
| **3: Compiler playbook** | Deterministic compile/fix/retry workflow with bounded retries and diff safeguards | Controlled TypeScript failure resolved and verified |
| **4: Intent integration** | Versioned intent, plan reconciliation, current-task projections | Planner can revise a plan without duplicating tasks |
| **5: Feedback evaluation** | Separate implementer/evaluator decisions, evidence gates, bidirectional revision | Unsupported completion rejected; verified work accepted |
| **6: 500 resilience** | Instrument malformed responses, bounded generation, retries, fallback, resume | Simulated PEG/HTTP 500 leaves durable consistent state |
| **7: Portability** | Export/import, backup, merge semantics, optional backends | Recovery on another host without duplicate IDs |

Do not combine every stage in one large change. A working stage 1 is useful independently of later multi-model orchestration.

## 8. Decisions, assumptions, and open questions

### Recommended decisions

- SQLite is the initial default persistence engine, wrapped behind a replaceable adapter.
- Use extension-global storage for database bytes, with per-project/per-chat logical scopes.
- A TODO record is not an intent record; TODOs are mutable work projections linked to durable intent revisions.
- The controller records authoritative state transitions; models propose or request them.
- Verification evidence and reported completion are distinct.
- One active task per chat and no cross-host automatic sync in the first release.
- No generated Markdown files as the default persistence scheme.

### To settle during implementation

1. Actual existing Twinny chat/conversation identifiers and their stability across reloads.
2. How project identity should map renamed folders, worktrees, and multi-root workspaces.
3. SQLite runtime packaging compatibility with the supported VSCodium/VS Code extension hosts.
4. Whether the first UI supports shared project boards or only chat-scoped lists (schema supports both).
5. Maximum retained event history and how large diagnostics are archived or pruned.
6. Exact planner/evaluator protocol and scoring rubric after native TODO state is stable.

## 9. References

- [VS Code extension data storage](https://code.visualstudio.com/api/extension-capabilities/common-capabilities)
- [VS Code ExtensionContext API](https://code.visualstudio.com/api/references/vscode-api)
- [VS Code remote extensions](https://code.visualstudio.com/api/advanced-topics/remote-extensions)
- [SQLite write-ahead logging](https://www.sqlite.org/wal.html)
- [SQLite appropriate uses](https://www.sqlite.org/whentouse.html)
