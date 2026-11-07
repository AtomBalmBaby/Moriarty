# Twinny Evidence-First Execution Manifesto

**Status:** Engineering contract for the next integration and hardening iteration  
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

Preserve the working source-location workflow, existing repository/migrations, Feedback, tool approvals, tool picker, MCP, and Stop. Avoid parallel controllers or new generic rule engines.

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

Use existing SQLite structures and add minimal migrations/indexes as needed. Support retrieval by project, source path, source symbol, native tool name, task/criterion, observation ID, verification status, source hash, and revision. Store explicit symbol/tool-name relationships when proven (`readFile` implements tool `read_file`). Do not use unsafe fuzzy matching. Avoid duplicating large evidence payloads.

Allow idempotent backfill of older verified tasks **only when trusted observations and a valid acceptance decision establish the fact**; otherwise leave the record historical/unproven rather than manufacturing certainty.

## 6. LAW: look up before rediscovering

A newly dispatched task should receive a **bounded, relevant projection of accepted project evidence before the next model request**. If current accepted evidence already proves its criterion, the host can satisfy it without a source search or model reinvestigation. If additional agent lookup is needed, `twinny_evidence_lookup` must search the active **project** across conversations by default.

Return compact structured facts: `symbol`, `tool_name`, `path`, `start_line`, `end_line`, `source_hash`, current/historical/unknown freshness, verification status, originating conversation and task, and trusted observation references. Only claim fields the repository actually knows.

Freshness must compare with the authoritative source, including unsaved editor buffers when applicable; a disk-only hash is insufficient for an open dirty document. Preserve stale findings historically. A later chat must not get foreign-chat write authority just because it can look up evidence.

Expected behavior: conversation A verifies `read_file`; repository closes and reopens; conversation B in the same project with a fresh model context looks it up and answers with **zero** `search_workspace` and **zero** `read_file` calls if evidence is current. Conversation C in another project cannot access the fact.

## 7. LAW: objective proof should not need an LLM judge

For straightforward source facts, use existing TypeScript evidence reconciliation **before** requesting Cerebras review.

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

## 13. Definition of done

A source-location fact is discovered once, backed by trusted observation IDs, objectively verified without unnecessary LLM evaluation, and durably retained. A second chat in the same project retrieves it after context reset and repository reopen without researching the source again. The second chat can **read** the first chat's TODOs but can never **write** them. Other projects have no access. New user tasks get fresh planning decisions. No self-administering TODO criteria, no stale evidence misrepresented as current, no INFO-level transport flood.

**Find it. Prove it. Remember it. Share it within the project. Keep ownership intact.**
