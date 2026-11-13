# Moriarty: Intent, TODOs, Feedback, Recovery and Evaluation

**Status:** Proposed consolidated architecture and first implementation contract, NOT a claim of shipped functionality  
**Revision:** 2026-11-13, native SQLite architecture revision, reconciled from `feature/todo`  
**Repository:** `AtomBalmBaby/Moriarty`, branch `feature/todo`  
**Scope:** Twinny/Moriarty coding-agent workbench, Mycroft implementation, Cerebras planning/Feedback, native TODO panel and repository

> **The user's objective is the authority. TODOs guide the work; evidence preserves what is known; Feedback assesses whether the objective was achieved. None of these should become procedural obstacles to genuine progress.**

## 0. Source authority, consolidation, and migration

This document is the proposed **canonical architecture for intent, TODO planning, execution, evaluation, recovery, and TODO UI**. It consolidates two existing documents:

- `TWINNY_INTENT_FEEDBACK_SYSTEM_OVERVIEW.md`, GitHub blob `c1c7a5111261bdf5ce0d8beae9c062f74104bbe5`.
- `TWINNY_NATIVE_TODO_SYSTEM.md`, GitHub blob `33e0bc5891f4cc103c68d0a7bb1b257609f1329c`.

**Keep `TWINNY_EVIDENCE_MANIFESTO.md` separate**, GitHub blob `597f67e13e54f7d9bd28aeedacdb2456144d00e7`. It remains the authority for observation/fact trust, project-scoped knowledge, source fingerprinting, freshness, objective proof, and provenance. This draft updates *how* those facts are used in planning and judgment; it does **not** weaken their validity requirements.

**Precedence proposed once adopted:** actual user request and constraints; host-enforced security and trustworthy observations; Evidence Manifesto for evidence/proof; this document for planning, evaluation, recovery, state and UI; existing code only as the record of **currently implemented** behavior. A design proposal is not implementation evidence. Resolve any remaining conflict explicitly, without creating parallel decision paths.

Do **not** delete or replace the original documents yet. Keep the two merged documents as historical baselines until reviewed, accepted, and their incoming references updated. The contents of this file were reconciled from the full GitHub `feature/todo` documents, not earlier incomplete Library copies.

### Existing constraints we retain

- One native `TodoRepository` and one extension-host state store; **no new planning database, duplicate controller, or shadow verifier**.
- **Storage decision (new): retire `sql.js` and replace it with native SQLite via `better-sqlite3` inside the extension host.** This is a design change, not a claim that the running extension has already migrated. Retain the existing `TodoRepository` boundary and identity, authorization and event contracts; replace the adapter, not the data model or controller.
- Stable project, conversation, list, task, criterion, run and observation identities; project-scoped read access to knowledge, conversation-scoped TODO write authority; no cross-project leakage.
- Canonical versioned **typed JSON criteria**, with IDs, `verification.kind`, subject, predicate, expected observation, freshness and proof owner. Description text is for humans, not the executable predicate. Do not revive regex/English interpreters or legacy `acceptanceCriteria: string[]` authority.
- One trusted host-owned transition and reconciliation path; idempotent request IDs; compare-and-set revisions; an append-only event/observation trail.
- Observations, claims, criterion proofs and reusable accepted facts remain different things. A model saying “done” does not establish success.
- Preserve approval rules, tools/permissions, cancellation, pause/Continue/Stop ownership, reproducibility, and source freshness (including unsaved buffers).
- This is a private **unreleased development fork**. Obsolete dev-state format compatibility is not a requirement, but resets must be deliberate, scoped, and preceded by inventory/backup where valuable; never silently delete data.

## 1. Outcome-first operating model

The hierarchy is:

1. **User intent:** what the user asked to achieve, including constraints, exclusions, authorization and desired result.
2. **Working plan / TODOs:** a revisable explanation of work likely to achieve that result.
3. **Execution:** actual tool actions, discoveries, changes, tests, failures and outputs, attributable to an operation and task(s).
4. **Evidence:** durable, appropriately scoped observations and accepted facts, including failed operations and uncertain findings.
5. **Feedback:** independent assessment of what has been done, what remains, and whether verification genuinely supports the user goal.
6. **Reconciliation:** correction of task statuses, dependencies, stale/invalid criteria, and planned next steps against observed reality.
7. **Outcome:** a truthful “done,” “partially done,” or specific blocker report. Completion concerns **the requested task/turn**, not that software development is forever finished.

**Never infer that a generated TODO, its order, or its initial acceptance criterion is more authoritative than the user's actual objective.** A planner error is not a reason to trap an implementer in repeated work. Conversely, the evaluator must not excuse unfinished work merely because it is difficult or the implementer claims it is impossible.

### Responsibilities

| Actor | Authority and responsibility | Cannot do |
|---|---|---|
| User | Sets objectives/constraints; authorizes actions and waivers; gives optional evaluation feedback | Required to debug routine agent retry loops |
| Cerebras planner / Feedback evaluator | Proposes and revises intent projections, TODOs, semantic assessments, both observational ratings and recovery approaches | Override host facts, grant permissions or unilaterally prove a failed test passed |
| Mycroft implementer | Uses permitted tools, investigates, changes code, tests, reports work and submits TODO completion claims | Directly mark unverified claims as host-proven or write another chat's TODOs |
| Moriarty host/controller | Validates permissions/schemas; records operations and evidence; reconciles criteria, task states, retries, continuation and termination | Treat model prose or unsupported metrics as trusted evidence |
| Evidence repository / verifier | Makes accepted knowledge reusable; checks typed objective predicates and provenance/freshness | Convert a historical lookup into a current fact, or mandate irrelevant rituals |

## 2. TODOs are a flexible work plan

A TODO is a user-relevant unit of work, not an instruction to administer the TODO system. Preflight checks, evidence lookups, reviewer dispatch, and status bookkeeping are generally **controller operations/events**, not synthetic TODOs. The exception is when developing or operating TODO functionality is itself the **actual user's request**. A naive ban on phrases like “TODO” in planner output is incorrect: it caused a real regression while editing the TODO UI.

TODOs are **guidance**, not a step-by-step legal contract. Mycroft may:

- Perform several independent tasks together or out of displayed order.
- Make progress on another ready task while one completion claim awaits review.
- Satisfy multiple tasks with one tool action or a shared set of observations, as long as each has adequate proof or semantic support.
- Discover a task is unnecessary, redundant or already achieved and propose a revision instead of repeating it.
- Ask the controller/planner to add, split, merge or reorder tasks when execution reveals a better path, preserving task IDs and audit lineage where practical.

**Do not auto-close a newly issued TODO solely because old project evidence exists.** Old accepted knowledge can prove a directly relevant current fact, but cannot satisfy a fresh request to edit files, run a build or produce a new deliverable. Conversely, don't require Mycroft to re-read already-current trustworthy facts just to earn a checkbox.

### Omelet example: independent order versus genuine prerequisites

- Gathering tools and ingredients may be independent.
- Chopping onions, peppers and ham can happen in any order, possibly alongside heating the pan.
- Beating eggs needs cracked eggs; pouring eggs needs prepared mixture and a ready pan.
- Several related actions can jointly satisfy one outcome, or one action can satisfy multiple TODOs.
- Being “done” is assessed from the **actual cooked omelet**, not whether a rigid list was followed in precisely its original order.

### Three separate order concepts

- **Display order:** a human-friendly sequence or grouping, not a mandatory execution constraint.
- **Dependency edges:** explicit true prerequisites, forming an acyclic task graph; validate against cycles.
- **Scheduling/concurrency:** controller policy regarding tools, resource conflicts and safe simultaneous work. A single active *worker* per chat may remain a sensible initial resource constraint, but **does not imply one TODO must be fully verified before all unrelated work can proceed**.

For dependencies, distinguish where justified between **work-output available** and **verified result required**. A code edit may use the source location as soon as it has been found, even while Feedback reviews the location claim. Higher-risk or irreversible actions may require verified prerequisites. Dependencies must never be inferred from `sort_order` alone.

## 3. State model and reconciliation

Keep distinct records for the following dimensions:

| Dimension | Example values | Meaning |
|---|---|---|
| Workflow | `pending`, `in_progress`, `in_review`, `blocked`, `completed`, `cancelled` | Where work is operationally |
| Overall verification | `not_checked`, `passed`, `failed`, `waived` | Established quality of a task completion |
| Per-criterion proof | `proven`, `disproven`, `unknown`, `requires_semantic_review` | Deterministic/semantic support for each typed predicate |
| **New observational progress score** | 1–5 or unavailable | Cerebras's assessment of work accomplished |
| **New observational evidence score** | 1–5 or unavailable | Cerebras's assessment of support for the actual result |
| **New human reaction** | `agree`, `disagree`, `facepalm`, unset | User's rating of Cerebras's assessment |
| Outcome | `satisfied`, `partial`, `blocked`, `not_satisfied`, `unknown` | Whether the original user request is fulfilled |

**The 1–5 scores and the three human reactions are not task states and are not completion approvals.** During phase one, they are observational diagnostics only; they must never update workflow status, acceptance criteria, dependencies or agent execution.

A valid completion claim moves a task into `in_review` when semantic judgment is needed. A host-proven task may complete directly by the existing validated transition when all real mandatory requirements are satisfied. `cancelled` is not `completed`. A user-authorized waiver is explicit, audited and does not manufacture proof. Historical claims, unsuccessful edits, and old attempts remain visible as evidence but do not override current successful results.

### Multi-TODO reconciliation

After relevant operations and reviews, reconcile **all potentially affected TODOs**, not only the selected/first TODO. One observation may support more than one criterion; one criterion may need several observations. Use fresh current source fingerprints and task-interval audit limits. When several tasks are completed by one operation, their reviews can be independently accepted and closed without redundant work. If an unnecessary TODO is retired, record *why* and distinguish `superseded` or `not_needed` plan dispositions from successful accomplishment (can be a reason code/event if schema changes are unnecessary).

Maintain plan revision lineage, user edits and dependencies across continuation, provider changes and crash/restart. The visible TODO panel is a repository projection, not a second authority.

### Outcome completion gate

Before Moriarty declares “I'm done,” reconcile the current user objective against actual results and outstanding material obligations. A zero-open-TODO condition is useful but **not sufficient** by itself: an incomplete or defective plan can omit required work. Conversely, an irrelevant zombie TODO must not prevent truthfully reporting a satisfied user objective; it should be corrected/retired through a traceable plan revision.

If verification is inherently unavailable, report the limitation and make a context-appropriate judgment about whether to finish, continue attempting another viable check, or return a specific blocker. Do not quietly present uncertainty as certainty.

## 4. Evidence Manifesto integration

The Evidence Manifesto remains normative for evidence trust. In summary:

- Host-owned observations record tool inputs/outcomes, scope, operation/run/request identity, time and causal list revision. **Failed attempts are observations of failure, not evidence that a successful mutation occurred.**
- Claims request acceptance; they are not themselves facts. Typed criterion proofs link valid predicates to observation/fact IDs and validity/freshness rules.
- Accepted source knowledge is durable and readable across chats **within the same project**; cross-chat writes are denied. Different project boundaries remain closed.
- Current source-fingerprint checks include unsaved editor buffers; historical facts are never silently described as current.
- A successful `evidence_lookup` with `resolution=none` may prove a lookup was completed, but not that an accepted fact exists; the actual query scope matters.
- Host invariants such as “no files modified” are proven only within the observed task interval and observable tool scope; unknown shell or external MCP side effects remain unknown.
- `after_activation` command criteria require actual execution after host-owned requirement activation, not simply a prior successful command. Feedback claims do not renew activation.
- Objective typed predicates should be determined by code/host facts where possible. Cerebras semantic review is for genuine interpretation, not for contradicting trusted host-verifiable facts.

**New reconciliation rule:** A criterion that is not causally relevant to the user objective, or whose typed predicate mismatches the user's requested outcome, is a **planner/criterion defect** to be diagnosed and revised, not a reason to force Mycroft to perform meaningless actions. Never silently delete a user-authored requirement; preserve provenance, obtain authorized revision where needed, and log the corrected plan.

## 5. Cerebras two-axis observational evaluation, phase one

**Primary experiment:** At an existing Feedback evaluation/reconciliation boundary, request a pair of independent 1–5 ratings **for every relevant TODO being assessed**, including when the task remains open, completed, blocked or in review. Ratings are advisory and should be recorded with the evaluator's concise reasons and evidence references. Do not add unnecessary extra inference calls on every UI redraw or token event. Preserve enough time/sequence history to see ratings change across attempts.

### Axis A: work progress (1–5)

| Score | Interpretation |
|---|---|
| 1 | No meaningful progress demonstrated |
| 2 | Partial effort, stuck or repeated ineffective attempts |
| 3 | Meaningful progress underway, significant work remains |
| 4 | Requested work appears completed, confirmation remains |
| 5 | Requested work has been accomplished |

### Axis B: evidence and verification support (1–5)

| Score | Interpretation |
|---|---|
| 1 | Trusted evidence directly contradicts the claimed result |
| 2 | Significant gaps or inconsistent observations |
| 3 | Evidence insufficient to establish outcome; neither disproven nor verified |
| 4 | Strong supporting evidence, limited uncertainty |
| 5 | Independently verified by appropriate authoritative observations |

Scores are **ordered categories**, not probabilities. A score of `4` does not mean 80% confidence. There must be an explicit `unavailable`/`not_evaluated` state if Cerebras was not called, timed out, or produced invalid output; never invent `3` as a fallback. Record at least a one-sentence rationale for **each axis**, the evaluated scope, linked evidence IDs, evaluator/model ID, task ID, task version, plan revision, operation/run ID and timestamp. A score must reflect the **task's user-relevant objective**, not merely administrative success such as calling `evidence_lookup`.

### Typed assessment envelope (proposed, schema to reconcile with current implementation)

```json
{
  "schemaVersion": 1,
  "kind": "feedback.observational_assessment",
  "projectId": "<host-derived>",
  "conversationId": "<host-derived>",
  "taskId": "<host-derived>",
  "taskVersion": 7,
  "planRevision": 4,
  "runId": "<host-derived>",
  "evaluator": { "provider": "cerebras", "model": "<configured model>" },
  "progress": { "score": 5, "reason": "Requested CSS change is present" },
  "verification": { "score": 3, "reason": "No rendered contrast check is available" },
  "observationIds": ["<trusted observation ID>"],
  "evaluatedAt": "<host timestamp>"
}
```

The **model proposes** scores and reasons. The **host validates** schema, identity, task linkage, score ranges and known evidence references, stamps authoritative metadata and logs rejection of malformed envelopes. Do not let a model forge host identity, source freshness, timestamps or successful test outcomes. Store the raw model reply only in bounded, suitably redacted diagnostic tracing where permitted.

### Examples to calibrate against real traces

| Scenario | Plausible scores (illustrative, not prescribed) | What to learn |
|---|---|---|
| CSS change applied/read back but not visually checked | Progress 4–5; verification around 3–4 | Do not equate missing screenshot with no edit |
| TypeScript check still fails after purported fix | Progress depends on actual attempted work; verification 1–2 | Real correction needed; include compiler diagnostics |
| Accepted current source fact located but lookup criterion falsely rejected | Progress high; verification high for the **location fact**, separate from defective criterion | Distinguish plan defect from implementation failure |
| Repeated unchanged evidence lookup with no new discovery | Progress 1–2 for recent attempts; evidence may remain high for prior established facts | Recognize no-progress loop without erasing history |
| No available visual inspection tool | Progress may be 5; verification can remain 3 | Report genuine limitation, not fabricate a failure |

First deliver these as **observations**, not a hard-coded 25-cell controller matrix. The classifications need real-world calibration before they are permitted to drive recovery decisions.

## 6. TODO panel, phase-one human evaluation

**Every TODO displays** a compact evaluator footer (or a clear placeholder while not evaluated):

- **Progress `P: n/5` and Verification `V: n/5`**, each with a readable short explanation (tooltip/expand on demand); avoid dumping verbose JSON or full internal prompts into the panel.
- Three immediate, accessible reaction controls replacing the currently unused **primary** Review / Delete / Promote-style administrative controls:
  - **✓ Green check: `agree`**. User considers Cerebras's assessment reasonable.
  - **✕ X: `disagree`**. Assessment appears incorrect or insufficient.
  - **🤦 Facepalm: `facepalm`**. A fundamentally unreasonable decision, bogus criterion or circular recovery was observed.
- Persist at most one current reaction per assessment by default, with an append-only event if changed. Reaction applies to the **specific assessment version**, not vaguely to the TODO forever. Show the selected state, permit change/clear, and record when/by whom it was changed.

**These are user annotations about Cerebras's judgment, not commands to Mycroft and not TODO acceptance/denial.** None of the three buttons may mark the task complete, restart execution, trigger retry, delete a TODO or modify evidence. They should be available **on every TODO**, regardless of current progress or verification score.

Do not lose administrative capabilities merely by removing prominent buttons. Move manual edit/delete/reorder/review/waive actions to a compact secondary menu if still required and authorized, with the same existing safety/audit rules. Do not mistake the user's lack of use of those controls for authorization to remove the underlying APIs.

Illustrative compact row:

```text
☐ Edit disabled button contrast                         In review
   Cerebras   Progress 5/5   Verification 3/5
   CSS updated; rendered result not independently checked
   [✓] [✕] [🤦]                              (more …)
```

The scores come from Cerebras, **never hard-coded UI heuristics**. Host/frontend renders `not evaluated` when unavailable. Reopening the panel or chat must load the same persisted evaluation and reaction. Updates must not silently change or lose human feedback attached to an older assessment.

## 7. Audit and trace: make the experiment observable

Both score assignments and user reactions must appear in the existing Moriarty trace and structured event history, with cross-links to task, assessment, run, evaluator and plan revision. Prefer a compact single-line summary in INFO and structured details in DEBUG; don't flood logs with transport dumps.

Example trace shape (illustrative, not from a real run):

```text
feedback.assessment task=<id> planRev=4 assessment=<id> P=5 V=3 evidence=[<id>] reasonProgress="CSS applied" reasonVerification="visual check unavailable" mode=observe-only
feedback.user_reaction task=<id> assessment=<id> reaction=facepalm actor=user
```

Record `assessment_requested`, `received`, `validated`, `persisted`, `rendered`, and failures/timeouts with exact reason codes where useful. Never claim the score is authoritative proof. Keep enough prior assessments to compare whether a correction improved progress or simply repeated the same operation. Do not expose secrets in traces.

An implementation is **not complete** merely because a mock component renders numbers: prove that a **real Cerebras evaluator response** reaches the host, validates, persists, shows in the actual VSCodium TODO panel, survives reload, and produces traceable user reactions. No placeholder scoring provider.

## 8. Feedback and recovery: future control policy, not phase-one behavior

We want **persistence about the goal, flexibility about methods**. After observational scoring is validated, the controller may use progress, verification, plan validity and attempts to choose among:

- `continue`: meaningful work remains and the present strategy is advancing.
- `correct`: trusted diagnostics show a concrete implementation defect.
- `verify_differently`: work may be done but current inspection is insufficient; choose an available and relevant check.
- `revise_plan_or_criterion`: the proposed TODO or proof requirement is irrelevant, contradictory, too strict, or outdated; preserve lineage and user requirements.
- `change_strategy`: repeated attempts produce no new information; use failure history, alternative tools, changed decomposition or Cerebras feedback.
- `escalate_blocker`: genuine unavailable permission/tool/input or exhausted justified attempts; report a specific next action, not false success.
- `finish`: objective demonstrably satisfied, task states reconciled, residual uncertainties truthfully disclosed.

Before any automatic continuation, compare a **progress signature**: new valid observations, changed source fingerprint, changed diagnostics, newly resolved criteria, changed approach, changed plan, or discovered facts. **The same rejected claim with the same state and same instruction is not progress.** Do not send Mycroft into a no-op loop. However, preserve the ability to challenge premature surrender and demand another *different, feasible* attempt where the actual objective is still unmet. Don't use a raw retry count as the principal success/failure classifier; enforce bounded costs and safe cancellation as a backstop.

Distinguish `implementation failure`, `evidence gap`, `plan/criterion defect`, `external blocker`, and `verifier defect`. These can be structured diagnostic reasons **without** adding another mandatory axis. Deterministic trusted observations outrank reviewer prose. If unsupported semantics require review, Cerebras may judge them but must not override host facts.

**Deferred:** automatic 5×5 cell routing, strategy-selection authority, dynamic retry budget by score, and any attempt to train/calibrate Cerebras from reactions. Only implement after measurement proves scoring yields sensible separations. Avoid turning the grid into another inflexible rulebook.

## 9. Persistence, identity, and versioning

Follow the existing `TodoRepository` interface and source schema contracts, but implement storage through the **single native SQLite adapter described in §10A**. `sql.js` is retired, not retained as a fallback or parallel authority. Store evaluator assessments and user reactions in the same authoritative database using queryable normalized records (or carefully versioned JSON plus indexes) linked to task, evaluation, run and conversation identities. Preserve request idempotency, optimistic revision guards and transactional event journaling.

Key entities already contemplated by the source documents include `projects`, `project_aliases`, `conversations`, `todo_lists`, `todo_items`, `todo_dependencies`, `todo_events`, `todo_requirement_activations`, `todo_evidence`, and `agent_runs`. Do not invent a separate item ID from its displayed row index. Source revisions, activation revisions, timestamps, and list/item compare-and-set versions have distinct meanings; preserve them.

**When a new assessment is produced:** retain prior history, associate the current one with the corresponding task/plan revision and evidence set, update only the panel projection, and never overwrite an older reaction as if it applied to the new assessment. A late response for an old run must not bind to the active new chat or newer task revision.

Project read boundary and conversation write boundary apply to both assessments and human reactions. Cross-project access is denied. Historical same-project data can inform new tasks by reference, but must not mutate another chat's record.

## 10. First implementation vertical slice (deliver this before changing controller recovery)

1. **Inspect current production wiring.** Identify actual planner, Cerebras Feedback/reviewer payloads, `TodoRepository` schema, TODO webview controls, event journal and trace output. Record tested behavior versus design assumptions. Preserve existing user state.
2. **Define one typed observational response.** Add both 1–5 scores, distinct short reasons, optional evidence refs, `not_evaluated` and validation errors, versioned at a real evaluator boundary. No invented scoring from host/UI.
3. **Persist and trace.** One canonical assessment attached to the correct TODO version/plan/run; immutable history; idempotent events and concise readable trace output.
4. **Wire the real TODO UI.** Show scores, reason(s), and ✓ / ✕ / 🤦 on **every** TODO, replacing prominent unused administrative controls. Move admin controls to secondary access as necessary. User clicks persist reactions **without changing task execution or status**.
5. **Verify a complete live vertical slice.** Real Cerebras response → strict host validation → repository → event trace → VSCodium TODO row → user reaction → persisted trace → reload persistence. Preserve pause/Continue/conversation ownership and display no stale cross-chat scores.
6. **Run regression coverage and report accurately.** Tests for invalid/absent scores; task version races; multiple TODOs; one observation informing several tasks; claims held for review; user reaction replacement; reload; opposite-project access; unchanged legacy execution; formatting/types/lint/build; actual UI proof. Separate mocked tests from live verification.

### Explicit phase-one non-goals

- **Do not alter** reviewer acceptance rules, completion transitions, automatic continuations, dependency scheduler, retry routing, approvals, or evidence acceptance **based on these scores/reactions**.
- Do not auto-accept a TODO when the user presses ✓; do not auto-reject or retry for ✕/🤦.
- Do not rewrite existing evidence facts, change source fingerprint semantics, ship legacy format shims, or silently migrate/delete local evidence DB.
- Do not add dummy model outputs, placeholder UI, a new MCP server, a second schema branch or an implementation report document as a substitute for working integrated code.

## 10A. Native SQLite replacement (new architectural decision)

**Decision:** The extension-host implementation must retire the `sql.js` WASM driver and its in-memory database/export-and-replace persistence cycle. Use **native SQLite through `better-sqlite3`**, hosted entirely in the VS Code/VSCodium extension host, behind the existing `TodoRepository` adapter boundary. `better-sqlite3` is the selected initial native binding, not an optional second driver. `node:sqlite` may be reconsidered only in a separate, explicit architectural decision when the actual extension-host Node/Electron runtime and API stability make it a better fit. Do not build an automatic driver fallback.

**Why:** Native SQLite offers durable, per-transaction writes, SQLite WAL and checkpoint/recovery, ordinary SQL indexes and integrity tooling, and avoids serializing the entire WASM database after each transaction. It also introduces an important deployment responsibility: native bindings must match the extension host's platform, architecture and Electron/Node ABI. An npm install or green TypeScript check alone does not prove the extension works in VSCodium.

### 10A.1 Data location and one authority

- Put the authoritative database in the host's `ExtensionContext.globalStorageUri` under the current extension-host user, not in the source repository or the webview. Treat the existing filename and location as discoverable runtime facts, not assumptions.
- Keep the same `TodoRepository` interface, schema/identity semantics, typed criteria, evidence provenance, project/conversation authorization and host-owned state transitions. Do not introduce a separate database for scoring, intent, logs or evidence.
- Before any database change, inventory all current database paths and live writers. Prevent two copies or two adapters from becoming simultaneously writable. Shut down/close the old connection before cutover; reopen the native connection as the only authority.
- SQLite WAL is supported **only on a local filesystem** where all connections share a host. Do not place the WAL database directly on SMB/NFS or assume that two remote extension hosts access the same file. Preserve clear per-host storage boundaries.

### 10A.2 Transactions, concurrency and reliability

- Enable `PRAGMA journal_mode=WAL` on supported local storage, `PRAGMA foreign_keys=ON`, and an explicit bounded `busy_timeout`; document and test the chosen `synchronous` durability policy. WAL improves reader/writer coexistence but **does not permit multiple simultaneous writers**.
- Use database transactions for every accepted TODO/evidence/evaluation/reaction mutation: validate authorization; deduplicate `request_id`; enforce expected item/list revision; write authoritative state and append audit event(s); commit; then publish the UI update.
- Retain stable IDs and append-only observation history. Capture proof references, source fingerprints, criterion evaluation, and review metadata atomically where the workflow requires it.
- Reuse source-managed schema migration/versioning for the **native** database. For this unreleased development fork, legacy dev-state migration is not automatically required, but never silently discard existing evidence.
- Implement clean close, reopen, crash recovery, rollback, WAL checkpoint/backup and corruption diagnostics. Back up using a consistent SQLite snapshot/backup procedure, not a raw copy of a busy main `.sqlite` file without its WAL.
- Keep DB access inside the extension host, isolate operations from the React webview, avoid blocking long computations inside a synchronous driver call, and preserve cancellation/Stop semantics at the execution-controller boundary.

### 10A.3 Development data cutover

1. **Inspect live code and data first.** Locate the current `sql.js` adapter, initialization, atomic serialization points, database schema version, extension-host storage path, tests, and every transitive caller. Verify whether other services share this driver.
2. **Protect existing state.** Pause operations, close or quiesce the store, inventory the old dev database, and export/backup valuable TODOs, evidence, accepted facts, plans, IDs and audit history. Explain whether historical data will be imported or intentionally reset; neither outcome is implicit.
3. **Replace the adapter as a vertical slice.** Keep `TodoRepository` callers stable while porting initialization, schema creation, transactions, query semantics, revisions, idempotency, evidence lookups, live subscribers and backup/reopen behavior. Remove `sql.js` execution paths instead of adding a second live interpretation.
4. **Cut over once.** On a deliberately selected development state, initialize or restore the native database and ensure there is only one active authoritative store. Do not silently recreate empty data after a failure to open an existing database.
5. **Remove obsolete artifacts.** Remove obsolete dependency/package assets, WASM loaders, export-and-replace persistence, outdated tests and documentation **only after** the native path is verified. Retain valuable regression fixtures even if old format compatibility is discontinued.

### 10A.4 Native module packaging gate

- Verify the actual VSCodium/VS Code extension-host Electron/Node runtime and its native module ABI **before selecting the compiled binary**. The `Node.js` version running `vsce` in a terminal is not necessarily the extension-host runtime.
- Confirm the selected `better-sqlite3` release supports the target host runtimes; pin compatible versions. Rebuild/package for each supported OS and architecture as necessary, including local and remote extension hosts.
- Make native module loading explicit in the build and VSIX packaging process. A prebuilt `.node` file that works on the developer's machine is not portable by default.
- Run an **installed VSIX smoke test** in the actual VSCodium extension host: open/close DB; create and retrieve a TODO; close/reopen and recover state; update task and verify event log; check that the native binding is packaged and loaded. Repeat for any supported platform/architecture combination.
- Verify extension-host startup failures produce actionable logs instead of starting with an empty replacement store. Native packaging compatibility is a release blocker, not a reason to quietly re-enable `sql.js`.

### 10A.5 Native storage acceptance tests

A successful cutover demonstrates that (a) only one persistent native SQLite store is active; (b) transactions are durable across extension restart and simulated crash; (c) compare-and-set and request-idempotency survive concurrent/replayed calls; (d) accepted project evidence is reusable across conversations without cross-project leakage; (e) WAL backup/checkpoint and corruption handling behave as documented; (f) pause/Continue/Stop and all TODO/Feedback workflows retain existing semantics; and (g) the packaged extension loads its native binding in the actual extension host. Preserve the old regression suite's behavioral assertions while retiring obsolete driver-specific assertions.

**Implementation status:** Proposed. No source code, database, package configuration or deployed extension has been changed by this document.

## 11. Acceptance scenarios to run and examine

| Scenario | Essential assertion |
|---|---|
| A. CSS contrast change applied; feedback rejects unrelated evidence lookup | Progress reflects the actual edit; verification reflects actual proof; a criterion defect is separately visible; no false score from mere reviewer rejection |
| B. Compiler failure after a real attempted fix | Cerebras differentiates effort/progress and contradictory test evidence; traces include failure identity |
| C. Repeated identical lookup/edit loop | Each assessment is attributable; traces reveal no-progress repetitions; phase one does not change retry behavior |
| D. Multiple TODOs satisfied by one operation | All relevant TODOs can receive independent assessments; existing completion paths remain unchanged |
| E. Same-project evidence used in a second chat | Current facts accessible by reference, old TODO writes denied, evidence scope preserved |
| F. Missing, malformed or timed-out Cerebras response | UI shows **not evaluated**, not fabricated scores; error logged; normal execution unaffected |
| G. All three human reactions | Each persists against exact assessment; selecting another reaction is auditable; no TODO status mutation |
| H. Reopen, reload, pause/Continue | Task/list/run binding remains stable; latest relevant assessment displayed; old reviews still accessible |
| I. Cross-project scope | No assessment/evidence/reaction leaks across project boundaries |
| J. New request vs obsolete TODO | Old TODO may be retired with a reason only via appropriate reconciliation; explicit user request remains authoritative |

The experiment succeeds when we can **observe and compare Cerebras's judgments with human judgments** over multiple real tasks, not merely when the code compiles. Once several traces show useful distinctions, design and test the recovery routing using the observed data rather than hypothetical matrix rules.

## 12. Deferred architectural capabilities from the existing overview

The consolidated system still anticipates durable/versioned intent; richer native dependency graphs and resource-aware scheduling; playbooks such as TypeScript compile/fix/test loops; resilient tool errors and provider handoffs; context-budgeted projections for smaller local models; import/export and portable backups; model-independent task persistence; workspace/model security; and the ability for planner, implementer and evaluator to revise one another's projections through validated host arbitration. These are **not dropped**, but are independent later slices rather than prerequisites for scoring. For ALICE, cross-agent coordination may be more autonomous and bidirectional; Moriarty can retain a simpler host-mediated controller.

## 13. Conflict-resolution register

| Prior wording or assumption | Reconciled disposition |
|---|---|
| “Small verifiable units” read as rigid mandatory sequential checklist | Keep small useful TODOs, but make order advisory unless explicitly dependent; permit multi-TODO accomplishment |
| “One active task per chat” read as no unrelated progress during review | May remain a one-worker execution guard; **not** a global task dependency and **not** exclusive evidence association |
| Mandatory criteria treated as infallible, even if irrelevant | Preserve typed deterministic proofs, but add explicit plan/criterion-defect diagnosis and revision; cannot silently waive a user's requirement |
| `in_review` interpreted as no execution can proceed | Review is a state of one task, not a universal freeze; respect real verified dependency/safety constraints |
| Absence of accepted evidence interpreted as failed lookup | Retain Manifesto: `resolution=none` can prove completed lookup, not fact existence |
| Evidence used to auto-complete new, broader tasks | Retain Manifesto prohibition; old evidence may directly establish a relevant fact but does not perform new edits/tests |
| TODO bookkeeping tasks generated from ordinary user code requests | Reject fake administrative obligations; do not block genuine TODO UI development based on keywords |
| `sql.js` presented as the current storage adapter | Historical implementation only. Replace with native SQLite through `better-sqlite3`; enable WAL on a supported local filesystem and validate packaging/recovery |
| TODO panel's Review / Delete / Promote controls as primary surface | Replace *primary* actions with P/V scores and ✓ ✕ 🤦; keep permitted administrative actions accessible secondarily |
| Reviewer accepted/rejected verdict used as whole task truth | Separate typed per-criterion proof, work status, two observational assessments and objective outcome |
| Five-by-five matrix could control retries immediately | Phase one only measures and logs both scores; future routing requires calibrated traces |
| “Every TODO completed” alone means request done | Reconcile original user outcome too; avoid zombie tasks and false completion |

## 14. Normative short form

**Plan what helps. Do the actual work. Retain trustworthy facts. Review the real result. When stuck, change approach. When successful, recognize success. Tell the user the truth.**

**First experiment:** Cerebras rates progress and verification separately for each TODO; Moriarty displays and traces those ratings; the user can mark ✓, ✕ or 🤦; **nothing in these new ratings or reactions controls execution yet**.
