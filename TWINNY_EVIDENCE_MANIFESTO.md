# Twinny Evidence-First Execution Manifesto


## Development-phase contract policy (2026-11-08)

**Twinny is an unreleased development fork with no external users who depend on old state or APIs. Backward compatibility with obsolete development formats is explicitly NOT a requirement.** This decision supersedes any earlier instruction in these three documents to retain old acceptance-criterion strings, run dual interpreters, maintain legacy model protocols, or migrate abandoned test-state schemas. It does **not** relax authorization, evidence provenance, durability of the *new* system, stop/cancellation semantics, or correctness tests.

- **One canonical criterion representation:** a versioned, schema-validated typed JSON criterion with a stable criterion ID, `description` for display only, `verification.kind`, typed operands, subject/scope, and evidence requirements. Do not persist a separate `acceptanceCriteria: string[]` authority or require its text to mirror the typed objects. Derive any display labels from the typed record.
- **One live decision path:** new planner output MUST use typed contracts. Remove the old English/regex criterion classifier, automatic legacy-plan fallback, dual interpretation, and old reviewer gates once the typed path is wired through production. Unknown or malformed contracts are rejected with bounded structured correction, never silently reinterpreted as prose.
- **Development data reset is permitted, not automatic:** inventory the current extension-host `sql.js` database, identify anything worth keeping, and offer/export a backup before any destructive reset. After an intentional reset, use the single current schema; obsolete compatibility migrations and shadow columns need not survive. Do not wipe databases implicitly on extension startup or upgrade.
- **Preserve capabilities, not legacy representations:** project/conversation isolation, stable IDs for newly created work, accepted-evidence persistence, cross-chat read permissions, atomic task transitions, concurrency guards, current-source freshness, cancellation, approvals, and provenance remain essential. Refactor or delete only after identifying the current call sites and replacing all uses.
- **Tests and documentation follow the new contract:** replace tests asserting obsolete string-based verification with tests of the same user-visible behavior under typed contracts. Keep historical failure fixtures as evidence of what went wrong, but never interpret them as compatibility requirements. A green helper suite alone cannot establish production integration.
- **No architecture fork:** reuse the existing planner, `TodoRepository`, `sql.js` adapter, native tools, verifier and execution controller. Consolidate conflicting behavior rather than introducing a second state machine, database, parser or API layer.

**Current verification status:** Gate 1 has been *reported* as implemented with typed criteria and passing automated suites, but the full live Mycroft/controller/evidence path is not independently proven here. The subsequent gate must remove remaining dual-format machinery and validate production behavior; do not mistake this policy for a claim that cleanup is already complete.

## Reconciled governing decisions (2026-11-08)

This is **one system**, described by three complementary documents. The [intent/feedback overview](TWINNY_INTENT_FEEDBACK_SYSTEM_OVERVIEW.md) owns architectural boundaries and internal message protocol; the [native TODO specification](TWINNY_NATIVE_TODO_SYSTEM.md) owns task identity, dependencies, state and persistence; the [evidence manifesto](TWINNY_EVIDENCE_MANIFESTO.md) owns observation/fact trust, criterion proofs, freshness and live acceptance. When an older example in any document differs, this reconciled contract governs. **Design target is not evidence of implementation.**

- **Structured internal control:** Planner, host, implementer, verifier, and reviewer exchange versioned JSON objects conforming to validated schemas. Human-readable descriptions are labels/explanations and never the executable acceptance condition. Model-facing tool calls already have structured arguments; internal prompt transport may still serialize JSON as text, but must validate the parsed object before acting.
- **Stable responsibilities:** Models propose plans, investigations, claims and semantic judgments. Twinny owns identity, permissions, execution outcomes, evidence capture, objective verification, transitions and retries. The user owns requirements and explicit authorization. No prose explanation or model-proposed `passed` flag overrides a contradictory trusted host observation.
- **Typed criteria:** Each criterion has a stable ID, explicit `verification.kind`, expected predicate, evidence requirements, subject/scope, a proof owner and freshness policy. Implemented known types are a **target**, not an assertion of currently shipped behavior. Unsupported semantics go to `semantic_review`; they do not quietly become `proven` or `disproven`.
- **Independent reconciliation:** A task's mandatory criteria resolve individually as `proven`, `disproven`, `unknown` or `requires_semantic_review`. One observation may support several criteria; a criterion may require several observations accumulated over turns. Proof has immutable references, verified scope and an invalidation rule. A task is not one monolithic reviewer verdict.
- **Lookup semantics:** A successful `evidence_lookup` with `resolution=none` proves **a lookup was completed**, when the query and scope cover the requirement. It does **not** prove that a matching accepted fact exists. A historical negative lookup remains proof that the lookup occurred at that time, while any claim of present absence must be revalidated.
- **Host-owned invariants:** Prohibitions such as “do not modify files” are audited within the host's demonstrable operation scope, over the entire relevant task interval. A host cannot assert that arbitrary shell/MCP/external filesystem side effects did not occur unless they were monitored. Pending approvals or unknown side effects keep an invariant unresolved rather than falsely satisfied.
- **Evidence is not a shortcut for doing unrelated work:** Accepted knowledge is projected to inform new tasks. Evidence can complete an objective criterion only when it directly establishes that criterion; it never auto-completes a broader mutation, test or user-deliverable obligation.
- **Liveness:** Before automatic continuation, reconcile new and retained observations. Advance satisfied dependencies atomically, and ask only for genuinely missing information. Repeating the same failing state with no new evidence or changed conditions is a controller defect; stop with a bounded actionable blocker instead.
- **Truth in reporting:** Distinguish *observed live*, *reported by Copilot/tests*, *designed*, and *unverified*. A zero-failure helper suite does not prove the actual VSCodium extension-host orchestration works.


**Status:** Reconciled evidence and verification contract; live failures remain unresolved until end-to-end reproduction passes  
**Scope:** Native TODOs, Feedback planning and verification, source evidence, SQLite persistence, cross-conversation authorization, prompt construction, and logging  
**Priority:** Correctness and demonstrable end-to-end behavior before expanding features

## 1. Purpose and non-negotiable architecture

Twinny's models should not have to rediscover code facts simply because a chat ended, the model's context was compacted, or another model took over. Work proceeds through an authoritative host-managed task plan and trusted evidence.

> **The model discovers. The host remembers. The verifier establishes trust. Feedback reasons where reasoning is necessary. The project shares knowledge. Each conversation owns its writable TODO state.**

Responsibilities:

- **User:** owns goals, explicit permissions, cancellation, and any decisions that require user authority.
- **Feedback / overseer (Cerebras):** owns authoritative planning, meaningful plan revisions, and evaluation of *genuinely semantic* unresolved claims. It does not assign busywork about maintaining the TODO system.
- **Mycroft / implementer (local llama.cpp):** executes and investigates; searches, reads, performs authorized tools, cites trusted observations, and proposes necessary child work. It does not independently alter Feedback's authoritative plan unless the user explicitly authorized a relevant operation.
- **Twinny host (TypeScript):** owns authorization, persistent observations, verification of objective facts, task state transitions, proposal checkpoints, operation-wide cancellation, evidence retrieval, and context projections.
- **SQLite repository:** durable, queryable record of observations, accepted facts, provenance, revisions, and plan history. No second memory database is required.

Preserve the working source-location capability, current repository interface, Feedback semantic-review role, tool approvals, tool picker, MCP, and Stop. Obsolete compatibility migrations and prose-driven verifiers may be removed after the typed replacement is verified. Avoid parallel controllers or new generic rule engines.

## 2. Verified observations and live regressions

### 2.1 Successful definition lookup

A small live investigation successfully identified the native `read_file` tool in **three investigative tool calls**:

1. `search_workspace("read_file")`.
2. `read_file` reading `src/extension/tools/workspace.ts:1–400`.
3. `read_file` reading `src/extension/tools/workspace.ts:169–216`.

The source snapshot reported `content_hash: xxh64:d5c69eebc0ba0792`. The definition begins with `const readFile = ...` at line 169 and declares `name: "read_file"` at line 172. The completion was accepted, the task marked completed, and there were zero automatic continuations. **These values identify a particular test snapshot, not immutable expectations for future checkouts.**

### 2.2 The persistence/retrieval failure

A later lookup from the original chat requested `twinny_evidence_lookup({symbol:"read_file", path:"src/extension/tools/workspace.ts"})` and received:

```json
{"ok":true,"facts":[],"total":0,"limit":20}
```

The visible `twinny_todo_get` result included `"evidence":[]` for a completed/passed TODO, despite source observations being logged during the original investigation. A separate fresh chat also failed to retrieve the prior accepted fact. Therefore, **successful task completion is not yet proof that usable accepted knowledge was persisted and accessible**. Do not assume the cause; inspect the full observation -> claim -> verification -> promotion -> commit -> query path.

### 2.3 The authorization failure

Cross-conversation TODO read attempts encountered `TODO operations are limited to the active conversation`. This is appropriate for foreign-chat writes, but **not for authorized same-project read-only access**.

### 2.4 The planning lifecycle question

Logs showed Feedback sometimes returned `{"track":false,"plan":null}` on a later, simple user request. That is not inherently a failure: a factual question might not need tasks. However, every new substantive request must be evaluated independently and must not be silently blocked or conflated with the previous completed plan. Retrieval of accepted evidence must work regardless of whether a new plan is tracked.

### 2.5 The verification question

The original live export displayed `Feedback review: accepted`; it did not prove that the deterministic fast path bypassed a Cerebras verification call. Instrument the real routing and establish why the host did or did not accept an objectively provable source location by itself.

## 3. LAW: no self-administrative TODOs

**A Feedback-generated task may NEVER require the agent to create, update, maintain, verify, or report on TODO bookkeeping merely because the user's workflow instructions mention using TODOs.** Apply this law to titles, descriptions, children, acceptance criteria, and completion conditions. The exception is a user's *real objective* to implement, test, or operate TODO functionality.

A prior malformed example:

- Task: Locate native `read_file` tool definition.
- Legitimate criterion: Identify the definition's filename and line range.
- **Forbidden criterion:** Create a TODO entry documenting this location.

The planner must distinguish **user outcomes** from **orchestration/workflow**. Acceptance criteria must be minimal, relevant, and objectively verifiable; never invent administrative deliverables. Give Feedback clear instructions and enforce the invariant in TypeScript. Validate all criteria, not only task titles. Avoid simplistic keyword bans that block genuine TODO-system engineering.

On a malformed generated plan, return the specific offending fields/criteria to Feedback for a bounded corrective retry. Never silently sync a still-invalid plan. For existing malformed active plans, implement controlled in-place reconciliation preserving authorized user tasks, IDs where possible, valid criteria, trusted observations, verification history, and plan revision lineage. Do not simply delete arbitrary requirements from a user's plan.

## 4. LAW: project is the knowledge boundary; conversation is the write boundary

Project identity comes from **trusted host workspace/project/session context**, not an untrusted model argument. Same-project history is readable; other-project history is inaccessible without separate explicit authorization. Cross-chat TODO mutation is forbidden at the **repository boundary**, not just the UI.

| Resource / action | Current conversation | Another chat in same project | Different project |
|---|---|---|---|
| Read accepted evidence/facts | Allowed | Allowed | Denied |
| Read historical/stale evidence | Allowed | Allowed | Denied |
| Read unverified observations | Allowed, with provenance | Allowed, with provenance | Denied |
| Read TODOs, criteria, plan history, and outcomes | Allowed | **Read-only** | Denied |
| Create/update/reorder/complete/delete/reopen TODOs | Existing policy | **Denied** | Denied |
| Modify another chat's evidence or authoritative plan | Existing policy for owned state | **Denied** | Denied |
| Reference prior verified fact in a new task | Allowed | **Allowed by reference** | Denied |

Read-only snapshots must not expose mutable repository objects. A conversation may cite an old task or evidence by ID without altering the origin record. If the original fact becomes stale, new validation/observations belong in the current conversation, leaving the historical record intact.

Preserve existing approval and tool-access controls. **Readable evidence is not necessarily accepted proof**: unverified evidence remains unverified; stale evidence remains historical, not current.

## 5. LAW: accepting a fact must preserve its provenance

Distinguish:

- **Observation:** trusted host record of a tool invocation, inputs, outputs, status, source anchors, hashes, and provenance. May be unverified.
- **Accepted fact:** structured finding supported by one or more trusted observations, linked to a successfully verified criterion and task.
- **Current fact:** accepted finding whose relevant source state still validates against the authoritative document.
- **Historical/stale fact:** formerly accepted finding that no longer proves the current state, still preserved for audit/history.
- **Unknown freshness:** current-state validation could not be performed. Never mislabel as current.

A completed task that required source evidence should not silently lack evidence associations. Verify which observations actually support each accepted criterion; never fabricate a fact from model prose or the mere `completed` status. Make acceptance/fact promotion atomic with task verification if the existing SQLite transaction supports it; otherwise implement an idempotent, durable recovery mechanism with explicit inconsistency handling.

### Required diagnosis path (before editing behavior)

Trace actual production code and data through:

1. Native tool execution and output.
2. Recording trusted observations against correct `projectId`, `conversationId`, `listId`, `itemId`, criterion/revision, and stable observation IDs.
3. Mycroft's completion claim and attached evidence references, including cases where a completion claim omits IDs.
4. Deterministic/Feedback verification and accepted evidence IDs.
5. SQLite write, transaction, close, reopen, and schema migration.
6. Project-scoped lookup and symbol/path filtering.
7. Context projection / tool lookup path.

Determine whether the original zero-result is due to missing promotion, missing observation/task linkage, symbol naming (`readFile` versus `read_file`), overly restrictive conversation scoping, or multiple issues. Add a test reproducing the real failure **before** applying the fix. Do not merely relax a lookup filter without establishing that a persisted fact exists.

### Schema/query considerations

Use the existing `sql.js` repository and indexes. A deliberate backed-up development reset may replace obsolete schema layouts instead of carrying legacy migrations indefinitely. Support retrieval by project, source path, source symbol, native tool name, task/criterion, observation ID, verification status, source hash, and revision. Store explicit symbol/tool-name relationships when proven (`readFile` implements tool `read_file`). Do not use unsafe fuzzy matching. Avoid duplicating large evidence payloads.

Allow idempotent backfill of older verified tasks **only when trusted observations and a valid acceptance decision establish the fact**; otherwise leave the record historical/unproven rather than manufacturing certainty.

## 6. LAW: look up before rediscovering

A newly dispatched task should receive a **bounded, relevant projection of accepted project evidence before the next model request**. If current accepted evidence already proves its criterion, the host can satisfy it without a source search or model reinvestigation. If additional agent lookup is needed, `twinny_evidence_lookup` must search the active **project** across conversations by default.

Return compact structured facts: `symbol`, `tool_name`, `path`, `start_line`, `end_line`, `source_hash`, current/historical/unknown freshness, verification status, originating conversation and task, and trusted observation references. Only claim fields the repository actually knows.

Freshness must compare with the authoritative source, including unsaved editor buffers when applicable; a disk-only hash is insufficient for an open dirty document. Preserve stale findings historically. A later chat must not get foreign-chat write authority just because it can look up evidence.

Expected behavior: conversation A verifies `read_file`; repository closes and reopens; conversation B in the same project with a fresh model context looks it up and answers with **zero** `search_workspace` and **zero** `read_file` calls if evidence is current. Conversation C in another project cannot access the fact.

## 7. LAW: objective proof should not need an LLM judge

For straightforward source facts, use TypeScript evidence reconciliation **before** requesting Cerebras review. The target contract is typed JSON emitted by the planner and validated by the host; English-heuristic verification is obsolete development code to remove, not an ongoing compatibility bridge.

The task `Locate native read_file tool definition` needs: workspace-relative filename, precise definition location/range, trusted successful source read containing the real symbol/tool declaration, and a fresh authoritative source fingerprint if claiming current state.

Make typed deterministic criteria practical for at least:

- `source_symbol_location`
- `source_contains`
- `tool_registered`
- `tool_execution_succeeded`
- `command_exit_status`

Preserve semantic fallback for unprovable relationships. Each criterion must resolve to `proven`, `disproven`, `unknown`, or `requires_semantic_review`. **Classified as factual** does not mean **proven**. An incorrect symbol/range, unsuccessful tool run, unknown freshness, or unsupported model claim must not pass.

When *all required criteria* are proven with valid provenance, host transitions the task to verified/passed and persists accepted findings without another Cerebras evaluation, subject to the existing authorization model. Consult Feedback only for genuinely unresolved semantic claims; provide it compact relevant evidence, not everything. Missing evidence leads to one precise next action, not restarting all work.

A UI label reading `Feedback review: accepted` alone does not establish whether the host or Cerebras performed the verification. Add instrumentation and tests of actual evaluator invocation counts.

## 8. LAW: source investigation is a short operation

Mycroft's default source-investigation procedure:

> **Search narrowly. Read broadly. Reuse evidence. Submit once. Finish.**

- Check project-accepted facts before source search.
- Search for the exact symbol/tool registration signature.
- Prefer substantive contextual reads (typically 150–250 lines, potentially larger when useful) instead of a dozen tiny overlapping reads.
- Avoid repeated reads of fresh, already observed ranges; allow safe retained-observation reuse and compact output projections.
- Make one concise completion claim linking trusted observation IDs after proof is available.
- Do not generate separate TODOs to satisfy bookkeeping.
- No lengthy narrative is necessary to prove a location.

The successful baseline used **three investigative tool calls**. A soft target of six or fewer is reasonable; never enforce an arbitrary hard cap when more investigation is genuinely justified. Test the actual tool-loop behavior, not merely prompt strings or a source-reading helper.

## 9. LAW: every user turn has an independent planning decision

When a previous plan finishes, a new substantive user request must get a fresh, traceable planning decision. A simple question may correctly result in `track:false`, but this must not block evidence retrieval or inherit a completed task as active. Do not automatically create a TODO for every chat message.

At DEBUG, log whether planning was invoked, request/operation identity, accepted decision (`track:true/false`), and why the host used the result. INFO should not dump prompts or internal lifecycle JSON.

Tests: finish task A; submit substantive task B and confirm it can receive a new plan; ask trivial factual question and confirm `track:false` is supported; earlier tasks stay unchanged.

## 10. LAW: observable operation ownership and readable logging

Stop belongs to the complete operation, not an individual model request, and must persist through Feedback, tool calls, retries, child proposals, and automatic continuations. Preserve previously implemented UI and cancellation tests. No continuation after cancellation; late results are fenced.

Logging policy:

- **INFO:** meaningful project/operation milestones, concise summaries; successful background FIM normally silent.
- **DEBUG:** request lifecycle, provider routing, retry decisions, planning decisions, detailed outcomes.
- **TRACE:** HTTP headers, first-byte/event times, streaming internals, correlation/transport details.
- **WARN/ERROR:** recoverable/terminal failures, always visible at appropriate thresholds.

Audit excessive INFO from tool discovery, full inventory names, routine evidence recording, and workspace sync. Preserve diagnostics at DEBUG/TRACE rather than deleting them. No secrets in logs, and no duplicated JSON timestamps in ordinary INFO summaries.

## 11. Verification strategy and acceptance tests

**Use scripted/mock providers, deterministic tool results, and real SQLite repository code. Do not repeatedly call live Cerebras/llama.cpp.** Run supported Node so SQLite tests actually execute. Confirm Stop and existing native/MCP flows still work.

### A. Persistence and provenance

- Original live-like source observation attaches to the correct active task.
- Completion with valid supporting observations promotes the factual result into the accepted index.
- Verified state and promoted evidence survive repository close/reopen.
- Invalid or absent provenance does **not** create an accepted fact.
- Repeated acceptance/recovery is idempotent, without duplicate facts.
- `read_file` and `readFile` resolve through an explicitly proven relationship.
- Stale source hash retains historical evidence; unknown freshness is not called current.
- Unsaved editor contents are respected when determining authoritative freshness.

### B. Project authorization

- Two conversations in the same project can read each other's TODOs (read-only) and evidence, including unverified/historical with status preserved.
- They cannot mutate each other's tasks, criteria, plan, hierarchy, or evidence, even through alternate repository routes.
- Cross-chat evidence references are allowed without editing the origin.
- Another project cannot read any of those resources.
- Forged model-provided project IDs cannot grant access.

### C. Planning and verification

- No invented administrative TODOs or criteria, including `Create a TODO entry documenting this location`.
- Genuine user work on TODO features still plans normally.
- Invalid planner output gets bounded corrective retry; never silently syncs.
- Existing malformed plan can be repaired without losing trusted evidence/valid criteria.
- Correct source location with fresh observation is proven deterministically; evaluator calls = **0**.
- Wrong range, failed tool execution, or unsupported claim cannot be proven.
- Semantic criteria still call Feedback when necessary.
- Completing A doesn't prevent planning B; factual `track:false` doesn't prevent lookup.

### D. Full lifecycle, not helper-only

Run a scripted production-path integration test:

1. Conversation A starts in project P; Feedback produces a single valid location task.
2. Mycroft searches/reads and host records trusted source observations.
3. Completion claim is submitted, verified, persisted, and indexed.
4. Close/reopen the repository.
5. Conversation B starts in project P, **different model/fresh context**.
6. B retrieves accepted location and hash without source search/read.
7. B can read A's TODO but cannot change it.
8. Conversation C in project Q cannot see A's TODO/evidence.
9. Source fixture changes; old fact becomes historical and requires bounded revalidation.
10. Back in A, a new substantive instruction gets a new independent planning decision.

Assert actual number of tool calls and Cerebras evaluator calls, not only final outputs. Preserve the successful baseline of approximately three investigation calls and no unnecessary continuation.

### Commands

```bash
npx tsc -p . --noEmit
npm run build
npm run build-tests
npm run lint
npm test
git diff --check
```

Also run complete standalone and VS Code extension-host suites with a Node runtime supporting SQLite. Report **actual pass/fail/skip counts** and distinguish isolated tests from complete integration coverage. Never call a skipped test passed; never relax rules or tests to manufacture green output.

## 12. Implementation order and operating rules

**P0: Demonstrate and fix lost accepted evidence** (observation -> acceptance -> promotion -> SQLite -> project query), then establish correct cross-chat read/foreign-chat write enforcement. Everything else depends on this.

**P1: Correct deterministic verification and new-turn planning**, including typed factual criteria and in-place malformed-plan repair.

**P2: Complete integration tests, broad nonredundant reads, and INFO log discipline.**

For each stage: inspect current code, reproduce a failing case, implement through actual production boundaries, add tests that fail before the fix, and validate. Preserve functioning code; keep scope constrained. **No placeholders, no parallel orchestration systems, no new report files, no automatic commit.**

If the entire scope cannot be completed, do not claim it is done: finish the highest-priority vertical slice, run its tests, and report exact remaining gaps. Avoid endless implementation narration; give concise factual results.


## Reconciled evidence and verification laws

### Structured fact contract, never prose-driven verdicts

The planner emits versioned, **typed JSON criteria**, the tool dispatcher emits host-owned structured observations, the implementer submits structured evidence references and completion claims, and Feedback emits structured criterion-scoped semantic judgments. Human English summaries are optional and cannot substitute for criterion predicates or evidence IDs. The full envelope, sample JSON and reconciliation algorithm are specified in the [system overview](TWINNY_INTENT_FEEDBACK_SYSTEM_OVERVIEW.md). Typed contracts are mandatory for the current architecture; any remaining English-heuristic implementation is technical debt to remove and verify, not an alternative supported mode.

A verifier must not infer the desired result from a word such as “exists,” “verified” or “modified.” Its decision comes from the typed predicate and scope. `lookup_completed` may accept either `found` or `none`; `accepted_fact_exists` requires a real current matching fact; `source_fingerprint` needs a trusted current `read_file` fingerprint; `execution_invariant` needs a host audit over the task interval. Store the observation's *result* separately from whether it *satisfies a criterion*.

### Observation, fact, claim and proof are different entities

- **Observation:** immutable host-recorded operation result with status, inputs, output references, project/task/operation identity, request ID, time, source version/scope, and error classification. An unsuccessful operation is still a valid observation of failure.
- **Claim:** model request or statement, including `task.completion_claim`; never evidence by itself.
- **Criterion proof:** individually evaluated, durable association of a validated typed predicate with trusted observation/fact IDs, result, reason, verifier, scope and freshness.
- **Accepted fact:** reusable, verified source knowledge promoted only from actual proof. Its scope and provenance outlive the producing chat.
- **Current vs historical:** source-linked facts are current only after authoritative freshness checks; stale facts remain accessible as history; unknown freshness remains unknown.
- **Execution freshness:** a `command_exit_status` that requires execution after activation is proven only by a run recorded after the task's latest host-owned requirement activation. A run that predates the activation or the latest renewal is unknown, not proven. Feedback reviews and completion claims never renew it. Source freshness is checked independently against the current fingerprint, not inferred from timestamps.

One observation can establish more than one criterion, and multiple compatible observations can satisfy one criterion. Evidence may arrive with the first tool call, later submissions, or subsequent turns. Never require four different evidence IDs just because a task has four requirements. When a check is negated (e.g. no successful file mutation), observe the **whole interval**, not merely one `git status` result.

### Negative lookup and lookup completeness

The November 8 live failure is a canonical regression: the host records a successful preflight `none`, but then labels a criterion “Confirm whether accepted evidence exists” **disproven**. This is invalid if the criterion's actual predicate is “perform a lookup and report whether a match exists.” A `none` result only contradicts a **positive existence requirement**. Preserve both the query scope and the timestamp. A subject-only query cannot establish universal project-wide absence; if the requirement is a comprehensive search, perform the appropriate broader query. Historical evidence that a lookup occurred does not expire when a later source fact gets accepted; a claim that no fact exists *now* may expire.

### Reviewer scope and authority

A source-location result proven by current authoritative evidence stays proven unless later trusted information invalidates it. Feedback only reviews criteria marked `requires_semantic_review`; it cannot force a repeat lookup because its prose contradicts a host-computed criterion. Its JSON decision is advisory on semantics and is validated at the controller boundary. Likewise a reviewer `passed` citing an unrelated trusted read does **not** prove a missing source boundary. Track facts against exact typed predicates and validated evidence IDs.

### Evidence as useful work context

The primary value of accepted evidence is that the next implementer can use verified project knowledge in a **different, broader task** without researching it again. Auto-completion of an objective criterion is permitted where proof is genuinely sufficient, but a fact about a source filename cannot satisfy a requirement to edit code, run tests, or deliver a user artifact. Context projection should rank current, directly relevant facts before limiting count or tokens, and distinguish accepted facts from raw observations.

### Required integrated acceptance scenario

Run the actual extension-host controller with scripted planner/reviewer outputs and real native tools, not only isolated `feedback.ts` helpers:

1. Plan a source-lookup task with typed criteria and a host-run preflight. Include both `none` and `found` fixtures. Validate the planner contract against the original request.
2. Confirm host preflight is persisted on the right task and **correct** project and scope. For `none`, `evidence_lookup_completed=proven` while `accepted_fact_exists` (if required) is not proven.
3. Read the actual native source, verify the true implementation closing boundary, and capture the authoritative `content_hash` from `read_file`. Verify no out-of-scope mutation occurred.
4. Model submits criterion-scoped references incrementally or in one batch. Host reconciles all mandatory criteria, persists proofs, completes the task and releases dependencies with zero unnecessary Feedback calls and zero no-progress continuations.
5. Reopen SQLite, start fresh conversation B and verify the same current accepted source fact is discoverable across chat boundaries with **zero** source rereads; ensure B cannot mutate A's tasks. Different project C cannot read it.
6. Change the source or buffer, prove stale/historical classification, and require new current evidence. Exercise approval pending, tool failure, unknown shell side effects, cancellation, and malicious/incorrect reviewer output.
7. Run `npm run build-tests`, the full standalone suite, `npm run lint`, `npm run build`, the VS Code extension-host integration tests when available, and `git diff --check`; record actual counts and skipped coverage. Verify a real UI trace before stating fixed.

**Green unit tests are not substitute evidence for the execution controller path.** These tests must fail for the old `none → disproven` bug and pass for the repaired typed contract. Preserve original live logs as regression fixtures, without embedding private secrets in the repo.


## 13. Definition of done

A source-location fact is discovered once, backed by trusted observation IDs, objectively verified without unnecessary LLM evaluation, and durably retained. A second chat in the same project retrieves it after context reset and repository reopen without researching the source again. The second chat can **read** the first chat's TODOs but can never **write** them. Other projects have no access. New user tasks get fresh planning decisions. No self-administering TODO criteria, no stale evidence misrepresented as current, no INFO-level transport flood.

**Find it. Prove it. Remember it. Share it within the project. Keep ownership intact.**
