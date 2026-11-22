# Moriarty: Evidence Reuse and Context Management
**Design proposal | 2026-11-22 | Branch: `context-management` | Status: design, not implementation**

## 0. Decision record and non-negotiable rules

This document consolidates the agreed direction from the Moriarty/Twinny discussions, the completed unified-project-database effort, the oversized-result investigation, and related backlog. It is a design specification for implementation in independently verifiable stages, not a claim that the features below already exist.

**Rule 0: User requests never become stale.** Original user messages and their authoritative task requirements are durable, non-prunable records. A newer user instruction may **supersede** an earlier requirement for future action, but does not make the earlier request stale or delete it. Context budgeting may use a faithful task-intent projection, but may not silently drop or distort operative user requirements. Model-generated plans, TODOs and summaries do not outrank user requests.

**Rule 1: Preserve execution history.** Every actual tool invocation and relevant raw outcome, success or failure, is recorded durably before lossy presentation/context truncation: tool name; typed original arguments; invocation/execution/session identity; start and finish times; status; paths/targets and authorization scope; source and observed fingerprints; return payload; stdout and stderr as separate byte streams when applicable; exit code, signal and timeout/cancellation; structured errors; result and delivery completeness. Attempted calls rejected before execution must be recorded as attempts with `executed=false`, never represented as successful execution.

**Rule 2: Context is a projection, not the evidence database.** Pruning a prompt never deletes an observation, rewrites the transcript or changes historical records. Evidence validity determines whether an observation describes **current** state, not whether it historically happened.

**Rule 3: Never leak a replacement fingerprint via invalidation.** A stale notice may include the **original/obsolete** source hash and observation UUID, but not a new current hash or current file contents. The model must obtain a new fingerprint from a verified current source observation, not a pruning notification.

**Rule 4: Sparse model-facing metadata.** Omit fields whose absence has a well-defined default; do not send `favourite:false`, empty lists, redundant wrappers, repeated paths/hashes, `null` placeholders or other fluff in every observation. Do **not** use an optimistic default when a state is actually unknown: unknown freshness, completeness, execution status or authorization cannot be silently inferred as valid, complete, executed or permitted.

**Rule 5: Favourites are opt-in except user input.** All tool observations start unfavourited. User input is inherently protected/favourite for context policy. The model may mark or unmark evidence via a small ID-based operation. Favourite affects retention priority, **not** source validity, write authorization or tool success.

**Rule 6: Honest integrity and bounded retrieval.** Do not advertise an unavailable observation, omitted tail, evicted blob or failed command as retrievable. Do not mark a partially delivered/retained result complete, or a launched background command successful.

**Rule 7: Authorization is independent of evidence.** Neither hash matching nor possession of an observation ID conveys read/write/command permission. Existing canonical-path, outside-workspace approval, operation-scoped write authorization and source verification remain intact.

## 1. Existing foundation and reproduced problem

The unified-project-database/index/evidence work is complete and merged to `main` per maintainer. The subsequent native tool argument and hash-first-source-resolution P0 patch has also been completed and merged. This design must first inspect the current branch rather than assuming historical line numbers, old database schemas or unfinished P0 work still apply.

Relevant code areas at the time of design:
- `src/extension/tools/loop.ts`: execution loop and context/result budgeting integration.
- `src/extension/tools/budget.ts`: capacity planning, result fitting, integrity, utilization diagnostics.
- `src/extension/tools/workspace.ts`: native tools, `ToolResult`, raw output and source metadata.
- `src/extension/tools/protocol.ts`, `arguments.ts`, `source-resolver.ts`: typed tool contract and hash-first addressing.
- `src/extension/todos/repository.ts`, `evidence.ts`, `source-validity.ts`, `feedback.ts`: unified storage, observation metadata and validity.
- `src/extension/chat/tool-evidence.ts`, `tools/todos.ts`: recording/lookup path.
- `src/webview` and `package.json`: inline chat settings and context diagnostics.

**Primary reproduction from Copilot's read-only investigation:** a real 1,374-line, 200,853-byte implementation plan generated a 207,507-character `read_file` result. At a 65,536-token context, the model received only 42,077 characters, delivering lines 1–25. Evidence retained 199,910 characters through line 1318 (incomplete); the final 56 lines could not be recovered from evidence. `twinny_evidence_lookup` returned metadata only and `query_evidence` did not exist at investigation time. Existing result trimming, repeated-call suppression and stale-evidence messages often recommended rereading or rerunning unnecessarily. **Rerun this baseline against the current branch before implementing; the numbers describe the investigation, not a permanent invariant.**

Existing context capacity discovery/Auto override, prompt budget, output-token reservation and utilization reporting must be reused and corrected where needed. Agent tool operation expects at least 65,536 tokens; support confirmed 128K/256K/1M contexts without equating configured window with physically resident GPU KV pages.

## 2. Architecture and data-flow boundaries

```text
user instructions (durable, authoritative, never stale)
             |
tool call -> typed invocation record -> execution -> raw outcome/blob store
                                            |          |
                                            |          +-> provenance/dependencies
                                            +-> observation UUID + integrity/coverage
                                                             |
workspace index + source version changes -> validity tracker
                                                             |
                                      evidence lookup/range/search service
                                                             |
                  context projector <- favourites + user policy + token budget
                          |
               sparse, bounded model-visible messages
```

The **immutable event/observation record** answers “what was observed or attempted then?” The **mutable derived validity index** answers “does this observation still describe the current source?” The **context projector** answers “what do we send this request?” These responsibilities must not share a destructive retention mechanism.

Records should be scoped by project identity, execution/conversation and authorized host/root. UUIDs identify invocations, observations and blobs; content hashes identify observed content versions and provide optimistic concurrency checks, **not globally unique file identity**. Repeated reads may reference identical content blobs while remaining separate timed observations; deduplication must not erase separate invocation histories.

The authoritative byte representation is a SQLite **BLOB** (or crash-consistent file-backed byte object with a SQLite reference) rather than `TEXT`; do not turn invalid UTF-8, NULs or binary stdout/stderr into lossy strings. The database may store blob data in separate tables/files with transactional references; content-addressed deduplication and compression are implementation details. Prefer lossless storage of bytes where exact stdout/stderr/source results matter. Define UTF-8 decoding and line-index views separately, preserving original bytes and streaming chunk ordering. Persist byte offsets and chunk coverage as **half-open `[start,end)` intervals**; line coordinates remain 1-based inclusive only at the model-facing interface. A line/character view must map back to bytes, recording decoding/normalization differences rather than silently changing authoritative offsets. Make writes crash-consistent; append terminal execution results and observation metadata atomically or via recoverable pending records. Retention limits must be explicit configurable **storage policies**, never hidden model-context caps.

Security: apply existing secret-shield/redaction policy to model-visible projections and log/diagnostic exports; design at-rest protection or policy-driven exclusion for credentials. Raw retention must not silently expose secrets via range retrieval. Preserve a clear distinction between original captured bytes, redacted presentation and access-controlled storage; if policy forbids retaining raw sensitive bytes, record that exclusion honestly in completeness/integrity metadata.

## 3. Canonical evidence model and sparse projection

Suggested conceptual schema; adapt to the established SQLite project schema rather than introducing a competing database:

- **Invocation**: `invocation_id`, `tool_name`, typed arguments, `call_id`, project/host/authorization context, time, `executed`, lifecycle/status, optional process/session IDs and error.
- **Outcome**: independently captured stdout/stderr blobs **or a truthfully labelled merged `terminal`/PTY stream** where a terminal cannot separate them, with per-stream sequence/timestamps, structured result, exit code/signal, final status, original length/hash, capture completeness and storage completeness. Record stdin input-write events separately, subject to secret policy; fd 3+ are not universal streams and require explicit attachment. One execution UUID represents one actual launch, never two invocations for capture.
- **Observation**: `observation_id`, invocation reference, observed source locations/ranges and **original** fingerprints, content coverage map, derived validity class, optional dependency edges, optional favourite marker.
- **Evidence access**: ID lookup, bounded content-range retrieval, search/filter/count, deterministic pagination, provenance and access checks.
- **Context segment**: user instruction or projected evidence/result segment referencing UUID(s), approximate/actual token cost, chronology, optional protected/favourite designation; do not store one giant opaque conversation text as the only source.

Defaults: ordinary observation `favourite=false` and omit that key from model output. Prefer absence of optional `error`, cursor, empty arrays and unused explanations. Never default `current=true` or `retained_complete=true` when not established. Model-visible examples are **illustrative**, not mandated field names:

~~~json
{"observation_id":"<uuid>","tool":"read_file","original_hash":"xxh64:<old>","delivery":"partial","retrieve":{"tool":"query_evidence","start_line":687,"end_line":710}}
~~~

A complete, unexceptional short result can remain plain text (with a lightweight source ID only where needed), rather than forcing every response into verbose JSON. Failed operations carry explicit failure, execution truth and actionable recovery, even under sparse encoding. Use an envelope only when integrity, status or retrieval semantics require it.

Never conflate source hashes with observation UUIDs or command digest with run identity. Do not infer unknown source dependencies from arbitrary command text.

## 4. Complete retention and model delivery

1. Capture the **entire raw tool result** before display fitting and context budgeting, including failed calls, structured errors and command stdout/stderr; mark what was executed versus refused.
2. Preserve capture/storage integrity: `original_size`, `captured_size`, `retained_size`, hash(es), exact covered ranges, completeness and reason for gaps (capture limit, redaction, eviction, failure, inaccessible).
3. A successful tool can have **partial or omitted model delivery** without becoming a failed execution. Conversely an unsuccessful tool remains unsuccessful even when its diagnostic output was captured completely.
4. For oversized outputs send a compact reference to the real stored observation, with original operation status, delivered coverage, retained coverage and **only supported** recovery tool calls. Avoid sending the retained blob and its summary together.
5. Never claim the final tail is recoverable if storage capped it. Return `not_recoverable`/coverage error and recommend a source reread only when actually necessary.
6. The evidence database is historical truth; context budget caps do not silently truncate its authoritative content. Storage quota exhaustion must be visible and not produce phantom evidence IDs.
7. Deduplicate repeated identical read-only calls **only while their identity, arguments, source versions, authorization context and observation semantics are still valid**. Reuse a real observation ID, not a claim that an unrun call ran.
8. Source edits and `run_command` side effects must synchronously invalidate affected source projections; external change detection may have latency and must report `unknown` until reconciled.

## 5. Read-only evidence query and range API

Implement one native model-visible **`query_evidence`** API with explicit `range`, `search`, `filter` and continuation modes over persisted observations, **not by rerunning `read_file` or `run_command`**. `query_evidence_range` is a historical design name only, not a separate registered tool.

Minimum operations:
- Resolve by `observation_id` (optional invocation ID alias); enforce project/host/authorization boundaries.
- Fetch bounded inclusive **source/result lines**, 1-based character fragments for extremely long lines, and exact byte/character offsets for arbitrary output; define conversions unambiguously.
- Support stream selection for commands: `stdout`, `stderr`, `terminal` (PTY or merged-only mode), merged *presentation* where sequence metadata permits, and structured result metadata. No after-the-fact splitting of a PTY transcript into invented stdout/stderr.
- Search retained output using literal text and optional regex with limits, surrounding lines/context, exact match counts where bounded computation permits, and deterministic cursor/page continuation; zero matches is **successful** with `match_count:0`. SQLite can perform bounded BLOB byte-pattern search (`instr()`), while full-text/FTS5 search requires a **separate derived text view/index** over decoded, redacted content. FTS5 is optional until performance justifies it; the API remains stable. Index and display offsets must map back to authoritative stored byte ranges and must not leak redacted bytes.
- Filter observations by source path, fingerprint, tool, time/execution, status and project when authorized. General evidence lookup remains discoverable without duplicating a huge response list.
- Return exact retrieved coverage, provenance, original hash/UUID and completeness; distinguish retained prefix, missing tail, unknown content and evicted blobs. A query result itself is size-bounded and can be continued.
- Avoid recursive giant evidence-of-evidence chains. Record retrieval invocations as lightweight execution events, but deduplicate references to underlying blobs.
- Use relevant native tools and accepted evidence before rereading files or rerunning commands. A stale result may be retrieved as **historical evidence** explicitly, never described as current source.

**Acceptance reproduction:** capture the whole 1,374-line plan once; retrieve beginning, line 687, and the final nonempty line from durable evidence without repeating `read_file`. Verify original bytes/content and model-delivery coverage independently. Verify long-line fragments, offsets, zero-match search, pagination, evicted/unavailable content, and failed tool observations.

## 6. Validity, staleness, supersession and dependencies

Validity is a computed classification, independent of favourite status:
- `current`: verified observed source versions still match.
- `stale`: verified source content/version changed or dependency invalidated.
- `unknown`: insufficient/currently inaccessible evidence to determine.
- `historical`: event/old snapshot that happened; remains factual as history even though not current.
- `superseded`: user/task decision replaced by a newer authoritative instruction; original user request is **not stale**.

File reads are linked to canonical source identity plus **observed original fingerprint**, line range and editor/disk source distinction. On change, all prior reads tied to the changed version are eligible stale-context projections. Four reads of a file at hash A followed by a verified edit to hash B makes those four version-A current-state reads stale; keep them in history. A later hash A due to a revert does **not** automatically resurrect an old observation as freshly authorized evidence without revalidation.

Derived accepted facts and claims carry dependency links to their source observations; invalidating a source invalidates only claims whose current-state validity depends on it. Command/test output is immutable history; whether it verifies the **current build** depends on recorded source set, revision, configuration and runtime dependencies. Unknown dependencies must not be guessed. A historical failure remains useful evidence, but does not prove today's test status.

**Invalidate via notifications/index events**, including edits, file saves, rename, create, delete, external changes, Git operations and successful native writes. Existing hash-first resolution is used for verification when authorized, not to infer new file content from invalidation alone.

**Crucial wire rule:** When the context projector removes or compresses an invalidated source, its notice may give `observation_id`, original obsolete hash and `reason:"source_modified"`; **never include the new hash**. New fingerprint requires a new authorized read or verified source observation. Do not indiscriminately insert stale notices when deletion is adequate; send one if the active plan depends on the invalidated fact.

User requests and their original text/intent are immutable and **never stale**. Later user changes have explicit supersession relationships; operative constraints are preserved. System/tool authorization policy and actively pending TODO/task state are protected, not treated as ordinary evidence to prune.


### 6.1 Resolve stale observation to current authorized source

**Required model-visible capability:** a read-only operation such as \`resolve_current_evidence\` accepts an **old \`observation_id\`**, or a legacy **original source fingerprint** with enough source/project scope to disambiguate. It returns the verified current source observation (and its new fingerprint/ID) **only on an explicit, authorized model request**. This is distinct from an automatic invalidation notice, which must *never* disclose a replacement hash.

Design invariants:

1. Historical observation identity is immutable. The old UUID/hash provides a **lineage and origin query**, not write authorization, a guarantee that the file still exists, or a globally unique file key. Prefer UUID over hash; with hash alone, identical contents or collisions require path/root or explicit disambiguation.
2. Follow recorded source identity/path, workspace root and verified rename/move relationships to locate the successor; do **not** simply find any current file with a matching old hash and pretend it is the same source.
3. Verify file existence, active permission scope, disk-versus-unsaved-buffer source selection, current contents and fingerprint at lookup time. Source index mappings are candidate hints, not proof of currency. Handle concurrent edits by returning a race/stale status or retrying safe read validation, not a misleading current claim.
4. **If current content is already available as a verified, authorized observation**, return its current \`observation_id\`, fingerprint, path and optional bounded content/retrieval reference without repeating a read. If no such observation exists but the source remains accessible, perform an authorized, explicit fresh source read/observation and store it **before** returning a fresh fingerprint. In either case report where the information came from.
5. For a source deleted since the old observation, return \`deleted\` or \`no_current_version\`; do not invent a replacement or reuse an unrelated file. For rename/move, return the verified successor location, with evidence of the link. For ambiguous histories or duplicate candidates, return \`ambiguous\` and bounded authorized candidates. For a missing/evicted old observation, return \`not_found\` or \`history_unavailable\`; for denied access, return \`permission_denied\` without disclosing restricted candidate names.
6. Some tool outputs have **no single current successor** (transient commands, time-sensitive diagnostics, multi-file searches, test runs). Return \`not_applicable\` or a dependency-specific stale classification and suggest an appropriate **new authorized operation**; do not silently rerun side-effecting commands or fabricate a replacement evidence ID.
7. Retrieval can request a bounded **current content range** or just a current reference. Every successful fresh lookup is persisted as an observation/invocation with provenance linking \`supersedes_observation_id\` or \`derived_from_observation_id\` to the old item. Keep histories and timestamps intact. An unchanged file may reuse a currently verified observation ID where valid, rather than inventing a new version.
8. Do not allow lookup of a current hash merely to bypass \`edit_lines\` concurrency/authorization guards. Mutations still require appropriate permissions and an expected current fingerprint verified at write time.
9. Responses are sparse but truthful: successful \`current\` includes verified \`observation_id\` and \`content_hash\`; \`deleted\` contains neither; ambiguity and unknown validity are explicit. The old hash is never automatically upgraded in the context projector.
10. Avoid round trips: a direct successful lookup can include the small requested current range along with the new ID/hash, while large source bodies stay in the evidence store and are served by \`query_evidence\`.

Example read-only query (illustrative syntax):

~~~json
{"observation_id":"<old-observation-uuid>","start_line":90,"end_line":110}
~~~

Verified response after a user/model-requested lookup:

~~~json
{"state":"current","observation_id":"<new-observation-uuid>","content_hash":"xxh64:<verified-new-hash>","path":"src/extension/tools/protocol.ts","content_ref":"<retrievable-ref>"}
~~~

If source was deleted:

~~~json
{"state":"deleted","previous_observation_id":"<old-observation-uuid>"}
~~~

**Testing:** four reads of the same old version then edit -> each old UUID resolves to the same independently verified current source version; delete -> no replacement; rename -> correct linked target; two identical old hashes -> ambiguous without identity; stale/evicted evidence; cross-project/permission denial; unsaved editor changes; concurrent modification during lookup; no-current-observation fallback creates a legitimate new read; old hash never appears as newly authorized current; invalidation projection **never** contains the new hash but explicit lookup **does**.

## 7. Favourite evidence

Add a small native `set_evidence_favourite` operation that marks or unmarks **exactly one observation UUID per model tool call**, with authorization scoped to the correct project/conversation. There is deliberately no multi-ID/batch operation: keeping multiple observations requires multiple independent model decisions and calls. No repeated `favourite:false` in read/tool outputs. Update database metadata without modifying the immutable observation body.

Default: **all tool results are unfavourited; user input is intrinsically protected/favourite**. Favourites tell the projector which evidence to prefer keeping; they **do not** make a stale source current, elevate permission, immunize bytes from storage policy or defeat hard context limits. A stale favourite can be represented by a compact **historical** UUID/old-hash reference when its content no longer fits. Provide idempotent single-ID toggles and a compact acknowledgement; persist replay history independently from favourite membership (so an unmark does not erase past request outcomes). Reject arrays/batches; never replay entire records just to toggle a bit. Test multi-ID updates, nonexistent IDs, permission checks, repeat calls, and favourite stale evidence.

## 8. Two-tier context pruning and inline settings

Expose in existing **inline chat settings** (not only VS Code's global settings):
- `Automatic context pruning` enabled/disabled.
- `Maximum context utilization` percentage slider (illustrative 40–95%, step 5, suggested 80% starting point, subject to usability testing).
- Optionally allow `Two-tier` (recommended) versus `Immediately remove stale`, but **default to two-tier** and avoid needless UI switches if no meaningful demand.
- Display configured context capacity, estimated current usage and projected threshold; do not label estimated prompt utilization as physical VRAM or per-slot KV occupancy.

Meaning of slider: percentage of **effective model context capacity** at which the next request is pruned, accounting for required response reserve, tool definitions, system instructions and a safety margin. Respect hard server limits even when auto pruning is disabled. Continue using Auto provider discovery/manual override, but expose confirmed vs assumed capacity and warn when context under 65,536.

**Default two-tier procedure (before each provider request):**
0. Construct protected operative user instructions, system/tool policy and current task state. Never classify user requests stale or prune them as ordinary evidence.
1. Estimate pending request utilization using current capacity and token estimator/provider measurements. If below threshold, keep both stale and valid result bodies in chronological context; their validity must be known to the renderer, so stale bodies are not silently presented as current.
2. If at/above threshold, remove or compact **oldest non-favourite stale** evidence projections first. Recompute after changes.
3. If still above threshold, remove/compact **oldest non-favourite valid** evidence projections. Prioritize task relevance and dependencies as a tie-breaker, never age alone at the expense of critical operative state.
4. Compact **favourite evidence** to retrievable references only if necessary to meet capacity. Keep immutable user requests/operative intent protected and preserve evidence in the DB.
5. Stop at an internal target below cutoff (e.g. configurable cutoff minus ~5 percentage points) to prevent pruning every single step. Ensure no negative budget or starvation. If non-prunable context alone exceeds the physical capacity, fail transparently rather than silently alter user instructions.

Do not delete the underlying user/assistant conversation, TODO history or stored evidence when projecting a shorter request. Retain model-visible tool-call/result protocol consistency, preserving matching call IDs and minimal continuation markers. Pruning must not leave orphaned tool messages or inadvertently trigger duplicate execution. Expose compact diagnostic counters: oldest stale removed, valid removed, favourite compacted, token estimates, threshold reason and retrieval references. Store sufficient projection history to debug model-visible differences, without duplicating full blobs.

Consider actual token counts when available; token-estimation uncertainty requires a buffer. Large output reserve settings must not incorrectly cause the model to believe its context is exhausted at 30K/128K. Context compaction must preserve provider-specific message ordering.

## 9. Error-message and output-guidance audit

Use Copilot's evidence-oriented inventory as a regression checklist. Existing messages in `loop.ts` and `budget.ts` include “Not included: this result ... did not fit”, “was not run again”, “already called”, “The rest was trimmed ... Run the tool again”, and “cut to fit ... ask for less”. Others in `workspace.ts`/`more.ts` suggest narrowing grep/files/git; `line-edit.ts`/`edit/service.ts` suggest rereads on hash changes; `todos/evidence.ts` and `evidence-context.ts` report retained, incomplete or evicted evidence.

For each response template audit: triggering condition, execution status, what was truly retained, observation ID, exact recoverable coverage, freshness, available native retrieval and honest next action. Replace rerun advice with `query_evidence` **only when its data exists and access is allowed**. Keep a fresh read requirement for stale source before mutation; never use an old hash as current edit authorization. Do not invent a model tool that is not registered. A repeated command/test execution is not necessarily replaceable with historical output if live reevaluation is needed.

The 20-row investigation catalogue and its beginning/middle/end tests are an input to this stage; update its source locations and coverage for current `main`. Audit redundant JSON fields/summaries/duplicate hashes and measure actual tokens saved, without hiding failed status, missing data, permission details or true uncertainty.

## 10. `run_command` interface: separate design, shared evidence contract

**Decision: maintain the dedicated `docs/Moriarty_Managed_Run_Command_Design.md` and freeze its stream/transport requirements before implementing the context schema.** Do not fold its process/session lifecycle into the context-management implementation. However, design and test the evidence interface now so there is no future schema rewrite.

Outstanding `run_command` backlog to capture in that document:
- **One launch for every actual command:** the host owns the execution; both evidence and terminal presentation consume the same captured process. For true stdout/stderr attribution attach separate OS pipes at launch. When only a PTY merged transcript is available, label it `terminal` and declare the limitation. Never run a command twice to collect a missing stream.
- Managed command/session/execution UUIDs; reusable shell sessions and environment/cwd state with defined persistence and isolation.
- One foreground command per request by default; structured JSON batches for ordered commands (`stop_on_error`), rather than ad hoc shell-composed multi-command chains.
- Parser-based detection/refusal of shell backgrounding and unsupported command composition (not brittle regex), with explicit safe allowances.
- Background process launch with **running** state, non-consuming poll/attach, streamed stdout/stderr kept separately and in order, precise exit code/signal, cancellation and process-tree cleanup. Starting is **not** successful completion.
- Configurable timeouts, retention/storage quotas, resource caps, orphan-session restart behavior, and correct host/approval scoping.
- Approval/permission model preserved; no unapproved outside-workspace or destructive actions from shell wrappers.
- Evidence records capture command ID, session/execution ID, exact structured arguments, cwd/host, typed status, stdout/stderr chunks, exit code, termination reason, invocation timestamps and provenance. Completion/failed/cancelled must be queryable separately from launch.
- Native tool **preference/redirection** at `run_command` boundary: for clearly read-only `sed`/`cat`/`grep`/`rg`/similar commands merely reading/filtering files or already retained output that native `read_file`, `grep`, or evidence query can handle, optionally **soft-refuse** with suggested native tool and concrete arguments; report `executed:false`. **Do not auto-translate or silently run a different operation.** Make behavior configurable; permit legitimate shell semantics and debugging when native equivalence is not established.
- Read-only native search/filter over **retained tool output** as well as source files; exact zero matches are successful; paginated results, immutable source UUID, no rerunning shell processes for filtering.
- Avoid redundant `2>&1` output merging; preserve stderr as a distinct evidence stream in pipe mode. Capture stdin writes separately when supplied, along with non-stream exit/signal/control events. Explicit exit codes and statuses; don't infer success from zero textual output.
- Integrate process statuses with Pause/Continue/Stop, long detached tests, notification hooks and durable work continuation, but keep the full orchestration UX in its own design.

**Dependency:** settle managed-command capture/PTY capability requirements **before Stage 1**; then implement generic evidence BLOBs, typed events and query primitives before managed `run_command` sessions. Stage 1 proves independent streams using synthetic inputs; Stage 11 must prove actual single-launch capture with the current one-shot process path, recording `terminal` when the transport cannot separate streams. Never attempt a second execution to obtain absent stderr. The eventual process supervisor can arrive later without a second database design. The later managed-command design consumes the interfaces described in sections 3–5. Do not prematurely interpret legacy command output formatting as a structured terminal status.

## 11. Other related backlog: scope now versus later

**Include in this context-management stage:**
- Evidence range retrieval + unified search/filter over retained results; compact model-facing recovery hints; full capture, integrity, and explicit storage quota behavior.
- Revisioned source validity, derived-fact invalidation, old-hash-only notices, multi-root and open-editor distinctions.
- User-requests-as-protected-input, sparse protocol fields, model favourites.
- Context slider, two-tier pruning, provider capacity/reservation diagnostics, continuity across context compaction.
- Native-tool preference guidance in agent instructions to prefer `read_file`/`grep`/evidence retrieval when authoritative results exist; **do not** implement `run_command` command interception here.
- Tests for repeated read suppression, no duplicate edits/side effects after context projection, and tool error recovery.

**Specify interfaces now; deliver in separate follow-up work:**
- Managed `run_command` sessions, batches, polling/cancellation, streaming, shell-policy/preflight and boundary soft-refusal (dedicated design above).
- Full agent Pause/Continue/Stop semantics and resumption across restart, step-limit recovery, terminal vs in-review TODO status; observe invariants but don't rewrite state machine in this stage.
- Completion/failure/approval-needed notification scripts/webhooks, with deduplication; observe events through durable execution records.
- General ALICE multi-model/intent reconciliation and durable playbook coordination. Keep project/task intent portable but avoid making Moriarty's context stage into ALICE.
- Outside-workspace symlink/read-time hardening and live LSP rename issues remain distinct authorization backlog.
- New physical GPU/Strata KV telemetry and server memory allocation policies: do not confuse with request-side utilization slider.

## 12. Proposed staged implementation and gates

Maintain a progress table in this document when work starts. A stage ends only on actual test outputs, not a claimed or timed-out green status. Preserve unrelated changes; no automatic commit/push unless user directs it.

| Stage | Deliverable | Required acceptance |
|---|---|---|
| 0 | Current-code audit, storage schema/integrity contract, baseline reproductions | Identify actual project DB APIs, old caps, model-visible pipeline, baseline counts, permissions; no speculative migration |
| 1 | Durable full invocation/outcome/blob recording | Complete generic BLOB/event schema and synthetic separate-stream coverage; stdin/control events and merged terminal supported as types; no claim of actual command sink separation until Stage 11; no silent 200K cap |
| 2 | `query_evidence` + retained-output search | Beginning/middle/end retrieve without rerun, offsets/long lines, zero match, scope, pagination, bounded output and no fabricated recovery |
| 3 | Sparse reference/result envelopes and guidance catalogue | Actual observation IDs across loop/budget/GUI/export; correct source/completeness; repeated calls reuse stored content safely |
| 4 | Source and derived-evidence validity engine + explicit stale-to-current lookup | Four reads then edit marks old snapshots stale, with only **old hashes** in notices; user requests never stale; authorized model-requested lookup returns verified successor ID/hash or clear deleted/ambiguous/unavailable state |
| 5 | Model favourite operations + protected intent | Opt-in UUID updates, favourites prefer retention but cannot bypass validity, access or hard token cap; user input always protected |
| 6 | Inline slider + two-tier projector | Threshold behavior, stale-first then valid then favourite compact refs, safety reserve/hysteresis, reproducible diagnostics |
| 7 | Integration/regression and design handoff | Full verification, context budget coverage, storage audit, and separate managed-`run_command` design contract accepted |

Suggested verification: `npx tsc -p . --noEmit`, `npx eslint src --quiet`, `npm run build-tests`, `npm run build`, `npm run test:sqlite`, `git --no-pager diff --check`, focused evidence/context/authorization tests and a **completed** full VS Code integration suite with exit status and Mocha totals.

Additional adversarial tests: huge single-line output; binary stderr; two different files with same hash; cross-project UUID; revoked access; redaction/secret handling; source edited externally; disk and unsaved buffer disagree; duplicated read calls; stale favourite; user request superseded but historical request preserved; provider returns misleading window; model prompt at threshold; no room except protected context; evidence DB quota; crash between streamed chunks and final status; replay after restart; wrong current hash never emitted by pruning.

## 13. Open implementation questions requiring evidence before coding

1. Does the current project DB retain raw bytes, normalized text, or only compact/redacted excerpts; which schema path is authoritative for `run_command` and failed calls?
2. What is the guaranteed storage policy for very large/binary outputs and credentials, including quota exhaustion and eviction? Never silently claim “all retained” when capacity is finite.
3. Which observed fingerprint corresponds to disk versus editor buffer, and can the index atomically identify source generations/renames without rereading every file?
4. How much derived-fact dependency metadata already exists in accepted evidence, and what is the minimal additive schema to invalidate conservatively?
5. What are the current provider-estimated token counts versus Strata's reported counts and slots; is projected utilization reliably tied to effective prompt capacity?
6. Which minimal context fields are required by native tool call/result pairing so pruning never breaks the provider protocol?
7. Whether existing evidence lookup changed since Copilot's investigation; `query_evidence` is the single model tool with range/search/filter modes (no separate `query_evidence_range`).
8. Whether favourites are scoped per project, conversation or task. Default recommendation: per-project observation preference with conversation/task visibility filtered by authorization.

These are implementation research questions, **not blockers to approving this design direction**.

## 14. Exit criteria for this branch

A long Moriarty run can repeatedly read and edit files, preserve all original authorized tool execution evidence, retrieve any retained part by UUID without repeating the operation, invalidate old source-dependent facts without exposing the new hash, honour favourites and **Rule 0**, can explicitly resolve old observations to independently verified current sources (or deletion/ambiguity), and automatically prune stale then older valid model-visible results at the configured inline threshold. The model can distinguish “not seen”, “seen historically”, “still current”, “not stored”, and “not authorized”. Tests prove tool-call/result pairing, permissions, sparse protocol accuracy and no fake success or duplicated execution.

The managed `run_command` redesign remains a separate reviewed design/implementation effort, but can adopt this branch's observation, output-stream and retrieval contracts without redesigning the evidence database.
