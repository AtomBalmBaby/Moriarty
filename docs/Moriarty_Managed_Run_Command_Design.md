# Moriarty: Managed `run_command` and Reusable Shell Sessions
**Design proposal | 2026-11-22 | Branch: `context-management` | Status: design only**

**Companion:** [Moriarty: Evidence Reuse and Context Management](Moriarty_Context_Management_and_Evidence_Reuse_Design.md)

## 0. Intent and decisions

Replace the current one-shot, command-string-centric `run_command` interface with a **managed execution service** that owns shell/session lifecycle, working directory, environment, output streams, exit status, cancellation, and durable evidence. Give the agent reliable, low-token commands and deliberate reuse of shells. Do **not** require repeated `cd`, manual stdout/stderr redirection, polling by re-executing commands, or ad hoc backgrounding.

This document defines a separate implementation track from context-management. **The context-management branch must establish the common evidence records and range-retrieval interfaces now**; this managed-command implementation can follow in its own stages. Nothing here asserts these features already work.

Core principles:

0. **User requests never become stale.** Persistent shell state, logs, pruning, or execution status may never supersede user instructions.
1. A **command invocation** (request to run) is different from a **process execution** (what actually ran), and **launched** is different from **completed successfully**.
2. Capture stdout and stderr **separately**, including binary bytes and ordered chunks; capture actual exit status out-of-band. Redirection inside the command must not be required for reliable reporting.
3. Shell reuse is explicit, scoped, bounded, and observable. Default working directory comes from the project/session, not a model-supplied `cd` prefix on every command.
4. Every attempted and actual operation has a stable UUID and a durable, queryable evidence record. Context fitting does not truncate the authoritative captured output.
5. No silent command rewriting, hidden auto-translation to another tool, or permission escalation through an existing shell.
6. Concurrency is a **future-compatible execution model**, not a requirement to run multiple commands concurrently in the initial implementation.

## 1. Problems this redesign addresses

### 1.1 Wasteful generated shell boilerplate

Examples of patterns Moriarty has emitted:

~~~sh
cd /home/stark/source/twinny && npm run build
cd /home/stark/source/twinny && git status
grep -R foo src 2>&1
npm test 2>&1 2>&1
~~~

These repeat project location, needlessly combine stdout/stderr, hide exit-code semantics behind a command string, and encourage the model to spend tokens reconstructing terminal setup for every request. Model-facing guidance should make these redundant.

### 1.2 Weak execution and reporting semantics

Historically, command output can be treated as one textual response; exit code, stderr, timeout and completion status may not be distinct first-class fields. Time-limited tool calls can interrupt tests before Mocha summaries appear. A nonzero exit status must remain observable even when stderr is empty, and stderr must remain observable when the exit code is zero. Do not infer completion from silence.

### 1.3 No durable process handle

A long build/test currently may outlive the request's normal timeout. Repeating the same command to see whether it finished risks duplicate builds, duplicated writes, orphaned processes and unnecessary work. The host should return an execution ID and permit polling, attaching and cancellation **without running the command again**.

### 1.4 Shell text processing used where native evidence already exists

An agent often runs `sed`, `cat`, `grep`, `rg`, `awk`, or similar programs to reread/filter source or output. When native `read_file`, `grep`, source indexing or `query_evidence` can answer equivalently, that costs time, tokens and loses provenance. Native preference must be configurable and enforced carefully at the **command boundary**, not by pretending every shell command has an equivalent native operation.

## 1.5 One execution: transport and capture decision

**Non-negotiable:** a command executes **once** under one host-owned execution ID. Capture, terminal presentation, status and durable evidence come from that same process. Never launch a duplicate process to recover independent streams, and never re-execute a command merely to retrieve output.

Current code paths must be audited independently: the VS Code terminal `execution.read()` view and the background runner's rolling merged output do **not** automatically provide separate byte-perfect streams.

- For independent stdout/stderr, the host owns a child process and connects separate pipes at **process creation**. The capture service records both streams; terminal presentation may subscribe to the same stream events. Do not launch a second process for display.
- Where a VS Code terminal/PTY provides only a merged transcript, record a single **`terminal`** (or `pty`) stream with honest origin/completeness. It is impossible to reconstruct authoritative stdout/stderr attribution from merged bytes.
- Persistent-shell sessions must establish capture and per-command attribution **when the shell is created**, with a private reliable control protocol. They may be pipe-based (separate output) or PTY-backed (single merged terminal transcript); the advertised capability must match reality.
- Context-management Stage 1 owns generic storage and synthetic stream tests. Its Stage 10 owns the existing real one-shot command capture adapter and must prove that one process was launched; the separate managed-command stages own the eventual process supervisor and session/terminal rework. Do not silently change approval, timeout or process lifecycle semantics during Stage 10.

## 2. Scope and non-goals

**In scope:** persistent named shell sessions; explicit cwd and environment semantics; structured command execution and ordered batches; background/detached execution; stdout/stderr capture and query; exact exit/signal/timeout status; cancellation and process-tree cleanup; approval/preflight; native-tool soft-refusal; evidence integration; stable identifiers; bounded result delivery; future concurrency primitives.

**Out of scope for initial delivery:** a general shell language parser, unrestricted terminal multiplexing, arbitrary remote host management, an embedded terminal UI replacement, cross-project shared shells, speculative parallel writes, automatic correction of failed commands, or implementing full agent Pause/Continue/Stop in this patch. Define integration points instead.

Do not try to intercept every possible shell spelling using regex. Keep an escape hatch for legitimate complex shell operations consistent with permissions.

## 3. Proposed architecture

~~~text
model tool request
     |
typed argument validation / request ID / policy
     |
command-boundary native preference classifier -> optional soft refusal (executed=false)
     |
canonical scope + approval + cwd/env validation
     |
managed execution coordinator ----> session registry (scope, cwd, env, shell, health)
     |                                      |
     +----> execution registry (UUID, lifecycle, owner, cancellation)
                      |
                shell / child process
                      |
       stdout bytes  stderr bytes  exit/signal/stop
               \         |          /
                evidence event / blob store
                      |
       bounded model response + query_evidence
~~~

Separate responsibilities:

- **Tool adapter:** validate JSON arguments and preserve types; produce compact, actionable errors.
- **Session manager:** own session creation, working directory, shell process, environment and reuse.
- **Execution manager:** launch, track, poll, stream, cancel, wait, terminate/reap and mark terminal status.
- **Policy/preflight:** decide scope/approvals, detect forbidden or discouraged command classes, ensure command execution cannot bypass permissions.
- **Evidence recorder:** persist invocations, process lifecycle, output chunks, return codes and completeness before context truncation.
- **Context projector:** show concise current status and evidence UUID; never re-execute merely to retrieve retained output.

## 4. API shape and sparse defaults

Use typed tool definitions, not stringifying booleans/numbers/arrays. Names below are **conceptual**, subject to matching existing registered tools. Avoid introducing multiple overlapping tools if the existing dispatcher can expose these as explicit operations.

### 4.1 Session control

- `create_shell_session`: optional `name`, `shell`, `cwd`, `env`, `host`. Return `session_id` and current cwd. Default shell and initial cwd are configured from active workspace.
- `list_shell_sessions`: show bounded accessible sessions with IDs, cwd, state and currently active execution count.
- `close_shell_session`: graceful shutdown, optional explicit termination policy for active commands; never silently abandon child processes.
- A reusable session is project/host/security-context scoped and may persist for multiple calls. Restart recovery is explicit; a host restart must not invent live process state.

### 4.2 One command, normal foreground case

~~~json
{"command":"npm run build"}
~~~

Defaults are implicit: project default session, cwd and environment; foreground execution; captured separate streams; no redundant `background:false`, `redirect_stderr:false`, `stop_on_error:true`, or other booleans sent merely to repeat defaults.

When a specific shell is intentionally reused:

~~~json
{"session_id":"<session-uuid>","command":"npm run build"}
~~~

On initial integration, existing `run_command` with `command` alone remains compatible.

### 4.3 Ordered batch

~~~json
{"commands":["npm run build-tests","npm run build","npx tsc -p . --noEmit"]}
~~~

- Explicit array, **not** model-authored shell `&&`/`;` chains.
- Execute in order in one session; default `stop_on_error=true` (omit when default).
- Each item gets its own **immutable observation UUID plus execution UUID**, started/finished timestamps, independently attributable stdout/stderr or declared merged terminal stream, and exit code; batch UUID references children. Reusing a session never combines commands into a single evidence record.
- Return overall status derived from actual child statuses, with the stopping point and references.
- Opting out of stop-on-error must be explicit and recorded.
- No batch is automatically parallel; batches must not suppress earlier failures.

### 4.4 Long-running command

~~~json
{"command":"npm test","mode":"background"}
~~~

Return `execution_id`, `session_id` and status `running` **after confirmed launch**, not `success`. Follow with bounded operations conceptually called `poll_command`, `wait_command`, `read_command_output`, `cancel_command`. Await/poll should not consume shell execution slots or rerun work. Polling optionally returns only changes since a cursor. A completion event records true process exit.

### 4.5 Compact response examples

Launch:

~~~json
{"execution_id":"<uuid>","state":"running"}
~~~

Completed and exit zero, no meaningful output:

~~~json
{"execution_id":"<uuid>","state":"exited","exit_code":0}
~~~

Nonzero plus retrievable output:

~~~json
{"execution_id":"<uuid>","state":"exited","exit_code":1,"stdout_ref":"<uuid>","stderr_ref":"<uuid>"}
~~~

Tool-side refusal:

~~~json
{"executed":false,"error":{"code":"prefer_native_tool","tool":"read_file","args":{"path":"src/extension/tools/protocol.ts","start_line":1,"end_line":80}}}
~~~

These are illustrative; don't omit execution truth, terminal reason, output completeness or cursor when essential. Sparse defaults are safe only when their meanings are guaranteed by the contract.

## 5. Persistent shells, cwd, and environment

### Default workspace cwd

- New sessions begin in the canonical active workspace root (or selected project root for multi-root workspaces).
- The runner passes a **cwd separately from the command**. The model should write `npm run build`, not `cd /home/stark/source/twinny && npm run build`.
- If the workspace root is ambiguous, return a bounded list of authorized roots or require one; never guess a write target.
- `cwd` can be overridden for a single invocation, or a deliberate `set_shell_cwd` can update the reusable session.
- Reject cwd outside authorized roots unless separately approved using the existing outside-workspace access mechanism.

### Two possible modes: define state precisely

**Persistent shell mode:** a dedicated shell process retains state across sequential calls, including legitimate `cd`, exported variables, shell functions and aliases. Commands in this session are serialized by default. A single command's exit is reported independently even though the shell continues. The host must use robust framing/protocol to distinguish command boundaries and stdout/stderr from shell internals.

**Managed per-command mode:** each command launches in a new child environment inheriting session-configured cwd/env but **not arbitrary shell-local state**. This is easier to isolate and later parallelize.

Recommended contract: support both as explicit capabilities, but prefer persistent-shell reuse for interactive multi-step workflows and managed per-command execution for isolated reproducible tests. Specify which mode a session uses; do not silently pretend exported variables persist if they do not.

### State and isolation

- Session state includes current cwd, shell kind, environment overrides and scope, plus health and in-flight execution.
- Changes to session cwd/env made through tools must be reflected in later diagnostics. If arbitrary shell `cd`/`export` are allowed, reconcile state or clearly declare it shell-private and not automatically reflected in out-of-band metadata.
- No shell state crosses project, host, user, trust or permission boundary by default.
- Reuse must not persist a one-time authorization grant into permission for all future commands.
- Shell output can contain secrets and untrusted content. Apply the same secret/access policy as other evidence.
- Shell process exit, crash, timeout or restart makes session health explicit; new session IDs on recreation unless a proven recovery mechanism preserves identity.

## 5.0 One evidence object per command in a persistent terminal

**Maintainer decision:** shell/terminal lifetime and command evidence lifetime are different. A persistent terminal has a durable `session_id`, but **every individual command request/attempt has its own immutable invocation/observation UUID**, and every actual execution has its own `execution_id`. Reusing the terminal must never merge command outputs into a single session-wide observation. A session transcript may exist as a separate optional historical view, but is **not** a replacement for independent per-command evidence.

The command object contains the exact typed request/command text, session ID, unique command/execution IDs, effective cwd/env scope, authorization/refusal decision, start/end time, source transport/capture mode, stdin-write events, stdout and stderr separately when pipe-capable (or truthfully labelled `terminal` for merged PTY capture), ordered chunk references, exit code/signal/status, storage completeness and retrievable evidence ranges. A refusal still gets an invocation observation with `executed:false`, but not a fabricated running process/exit code. A batch has a parent batch ID and **one object per child command**, never a single concatenated result.

**Attribution is mandatory and must be trustworthy.** For a persistent interactive shell, the execution manager must establish command start and termination boundaries using a **host-controlled, unspoofable control channel or equivalent supervised child-execution mechanism**. Plain shell prompts, echoed command text, magic stdout markers or terminal scrollback are **not** reliable attribution. Capture from the start of each command, preserve bytes and exit status, and associate every chunk with its originating execution ID. Session startup output, idle shell output, prompt redraws and unsolicited output that cannot be proven to belong to a command go to a **separate session event/transcript record**, not into the nearest command's evidence.

**Long-running and asynchronous children:** identify descendants/process groups and their output ownership. An execution is not terminally complete merely because the parent shell displays another prompt if descendants still have output streams open. If a child outlives the initiating command or attribution is ambiguous, keep its separately attributable execution/job record or explicitly flag orphan/unknown output and incomplete coverage. Never silently attribute it to the next command. One active foreground command per persistent shell initially; any future concurrency uses independent execution IDs and supervised processes, not interleaved unlabelled PTY output.

**Acceptance demonstration:** in one reused session, execute three commands with distinctive stdout/stderr and distinct exit statuses; retrieve each UUID independently; show no bytes or status cross between commands, and no re-execution. Include a failed command, a command that emits no output, shell-state persistence across commands, delayed child output, noisy prompts, spoofed delimiters, cancellation, and a session restart. The session survives completed commands while their immutable evidence survives session termination.

## 5.1 stdin, auxiliary file descriptors and control events

A normal Unix process has three standard streams, but only two are output:

| Descriptor | Direction | Evidence contract |
|---|---|---|
| `stdin` / fd 0 | Into the child | Host-provided input **write events**, not an output stream; record execution identity, byte count, time and write status. Retain sensitive input bytes only when permitted by explicit policy. |
| `stdout` / fd 1 | Child to host | Capture raw bytes separately, from process start, with chunk ordering and exact coverage. |
| `stderr` / fd 2 | Child to host | Capture raw bytes separately, from process start, with chunk ordering and exact coverage. |

File descriptors **3 and higher** are application-defined, not universal additional streams. A future explicit `extraPipes` capability may attach named and authorized auxiliary descriptors; do not opportunistically intercept or infer them.

Also capture **non-stream control metadata**: spawn attempt/result, execution/session IDs, actual cwd/host, timestamps, process/PID and process group when permitted, exit code, termination signal, timeout/cancellation, limits, process reaping and any capture/storage gaps.

**stdin policy:** default isolated commands to closed/noninteractive stdin unless requested; interactive sessions may accept controlled writes. Log accepted/failed input writes, but never assume accepted bytes were consumed. Prevent secrets and password prompts from entering unprotected raw evidence. An approval question is not silently answered through stdin.

**PTY:** a pseudoterminal typically presents one terminal transcript (including prompt, echo, control sequences and possibly program output); it does not preserve authoritative stdout/stderr identity. Model/store representation must have a distinct `terminal`/PTY stream and a truthful capture-capability field. No content classifier may invent source descriptors.

## 6. stdout, stderr, ordering, exit codes

### Capture independent OS streams

- Launch **one child exactly once** with separate stdout/stderr pipes from spawn, or explicitly select a merged PTY/terminal transcript. Capture and terminal presentation share the same execution ID. Do not require `2>&1`, `1>&2`, `tee`, `echo $?`, or `; echo EXIT:$?` to see results.
- Store **raw bytes** from each output stream, not merely merged formatted text. Preserve binary and invalid UTF-8; decode only for presentation/search. Every output chunk records origin `stdout`, `stderr` or `terminal`, where `terminal` is intentionally merged. Distinguish an empty captured stderr from stderr that was never independently captured.
- Timestamp and sequence each chunk as received; preserve per-stream byte order exactly. Cross-stream interleaving is only observed delivery order, not a guarantee of emission order. Every chunk belongs to one execution ID, one stream and a precise half-open byte range `[start,end)`; do not merge output across concurrent jobs.
- A merged *presentation* can be reconstructed with caveats, but independent stdout and stderr remain authoritative.
- Process exit information comes from the host wait/exit event, not from parsing output. Record integer exit code when available, signal when applicable, and whether timed out or was cancelled. POSIX signal deaths are not silently converted into successful integer exits.
- A shell's final `$?` must be captured via a trustworthy session protocol without letting arbitrary user command output spoof the result. Prefer launching through an OS process supervisor for isolated commands; if a persistent interactive shell is used, frame command boundaries using a private, authenticated control channel rather than easily spoofed stdout markers.
- Track output capture loss, stream closure, hard caps, decoding gaps and DB write failures explicitly. “No stderr” and “stderr not captured” are different states.

### Result semantics

Lifecycle: `accepted` -> `queued` -> `starting` -> `running` -> terminal `exited` / `failed_to_start` / `cancelled` / `timed_out` / `lost`. Use stable precise enumerations in implementation. `exit_code=0` means process success only if execution truly reached a terminal exit state; tool policy may still classify reported results separately. Nonzero is not automatically a tool transport failure.

A command yielding exit 1 with useful grep matches, or a test suite with failures, must remain a **completed process with nonzero status**, not “successful command execution” or “tool failed to execute.” Distinguish process result from infrastructure failure and model-facing status.

## 7. Background, timeouts, pause, cancellation

- Configurable foreground wait period, per-command timeouts, maximum runtime and resource budgets; timeout policy must never masquerade as exit 0.
- Long-running jobs return an execution handle. Future requests can poll/wait/attach and fetch retained output without restarting.
- Cancellation is explicit and idempotent. Define graceful termination, escalation deadline, process-group/tree kill, reaping, and residual/orphan detection on Linux; don't kill unrelated processes.
- If an agent pauses, execution policy determines whether child processes continue. Show this in status and preserve evidence; agent Stop should have a clearly defined policy, not silently kill/relaunch commands.
- Session close with active jobs requires a documented decision: drain, reject, or explicit cancel. Never orphan silently.
- Interrupted host process/restart must reconcile persisted “running” state with OS reality. Mark `lost` / `unknown` if not verifiable; never infer success.
- Notifications on completion, failure, approval-needed or step limit remain a separate feature, consuming durable execution-state events with duplicate suppression.

## 8. Prevent model-generated shell anti-patterns

The objective is **less boilerplate and more reliable provenance**, not banning every shell feature.

| Pattern | Preferred approach | Enforcement |
|---|---|---|
| `cd /repo && command` every call | Session cwd or one-call `cwd` | Model guidance; optionally detect known redundant prefix and suggest clean form, no silent rewrite |
| `2>&1`, especially repeated `2>&1 2>&1` | Native separate stdout/stderr capture | Guidance; warn or soft-refuse only when output merging is demonstrably redundant |
| `; echo $?` / `echo EXITCODE=$?` | Host exit-code field | Guidance and suggested corrected call |
| `cmd &`, `nohup`, `disown`, improvised detached chains | Managed background mode + execution ID | Preflight parser/validated classifier; refuse unsupported/unmanaged backgrounding with actionable replacement |
| `sleep 10; cat /tmp/log` as polling | `poll_command` / `read_command_output` on execution UUID | Suggest native poll, do not rerun |
| `sed -n` or `cat` solely to read files | `read_file` with path/line range | Optional soft-refusal with tool + arguments |
| `grep`/`rg`/`awk` solely to search/filter known files/results | Native `grep`/evidence query | Optional soft-refusal only for clear semantic equivalence |
| repeated `npm test` merely to obtain omitted output | `query_evidence` or command-output retrieval | Reuse real completed observation; rerun only if fresh execution required |
| pipelines solely to truncate output (`| head`) | Bounded result delivery and range search | Guidance; honor legitimate transformations |

**Detection and refusal rules:**

1. Classify with an appropriate shell tokenizer/AST for the chosen shell dialect, with conservative fallback for unsupported syntax. **Do not use naive substring or regex matching as the authorization gate.**
2. Soft-refuse **only when semantic equivalence is high confidence**, command would be merely read-only, and a native tool can satisfy the request under the same scope.
3. Never auto-run the substitute tool or silently rewrite the original command. Reply with `executed:false`, reason, exact registered native tool and usable arguments, and an explicit escape/policy setting for cases with real shell semantics.
4. Allow `grep` or `sed` when used for shell-specific transformations, pipelines, process streams, diagnostics, remote contexts, or outputs not available to native tools. Do not penalize necessary command composition.
5. Soft-refusal must itself become a durable attempted-invocation event. Zero matches returned by native search are successful; “not run” is not a successful zero-result command.
6. Make native-preference mode configurable (e.g. `off` / `suggest` / `soft-refuse`), with a clear default informed by tests and no bypass of security preflight. User's explicit choice may permit legitimate shell usage.
7. Preserve exact original command text in evidence, even if refused; do not claim its effects occurred.

## 9. Security, approvals, and provenance

- Validate command, cwd, chosen session, host and environment scope **at each invocation**. A permitted session is not blanket approval for all future commands.
- Shell wrappers may access files outside project roots even when command text looks harmless. Preserve the current outside-workspace approvals and be conservative about claims of static command safety.
- Keep separate policy for execution permission, filesystem reads/writes, network/host access and high-risk commands. Do not infer permission from evidence IDs, source fingerprints or approval for a prior command.
- Record effective cwd and session environment fingerprints (not secret environment variable values in model-visible context), command text/typed args, approval decisions and execution identity.
- Treat command stdout/stderr as untrusted data. Never let an output line claiming “run this next” become a system instruction.
- Capture secrets under an explicit storage/retention/redaction policy and enforce it on all range/search/stream queries.
- Deduplicate retry requests only with stable invocation identity and explicit safe idempotency semantics. Re-execution of a stateful command must not be mistaken for replay of its output.

## 10. Evidence database contract and context integration

Use the canonical unified project database established by the companion context-management design. **Do not build another command-history database.**

For every attempted `run_command` operation preserve:
- Invocation UUID, provider call ID, tool name, original typed args/exact command, project/host/owner/authorization scope, requested session ID, timestamp and `executed` flag.
- Execution UUID(s), batch UUID if any, actual cwd, command/shell mode, start/end timestamps, lifecycle transitions, process/pid/group identity where safe, exit code/signal/timeout/cancellation/lost reason.
- Separate stdout/stderr blobs **or one explicitly labelled terminal/PTY blob** with ordered half-open byte offsets/chunk sequence and completeness/retention markers; optional reconstructed display only. Input writes and process-control events use distinct metadata/events, never fabricated output bytes.
- Structured tool result/errors, stdout/stderr reference IDs, lengths and content digests, model-delivery completeness versus storage completeness, provenance/dependencies **only when known**.
- Refusal/approval-needed events without a process launch; distinguish `never_executed` from failed process.
- Read and filter by exact execution ID via evidence tools, with authorization and bounded line/byte ranges, pagination and search. Retrieving command results must not rerun the command.

Synchronous persistence should make terminal exit status and final output chunk recovery consistent; use recoverable pending execution records on host crashes. Storage caps, truncation or secret exclusions must be visible. A command can return a compact UUID + exit code immediately while preserving complete permitted outputs for later retrieval.

**Staleness:** a historical command run never ceases to have happened. Its use as evidence of the *current* project state may become stale if verified dependencies change. Do not guess dependencies from arbitrary command text. If invalidated in projected context, refer only to the **original obsolete hashes** and observation UUID, not new/current source hashes. Rule 0: user requests are never stale.

**Favourites and pruning:** command observations are unfavourited by default. A model may favourite an execution/observation by UUID through the shared evidence API. On pressure, prune obsolete nonfavourite command-result projections before current ones; DB records remain intact. Do not include meaningless defaults or duplicate whole logs in model messages.

## 11. Future concurrency: design for it now, implement deliberately later

Do not couple an execution record to “the only command currently running.” Use independent IDs, jobs and stream cursors from day one:

- **Per-session serialization** for persistent interactive shells: one foreground command at a time so cwd, exported state and `$?` remain well-defined. Every serialized command has a separate observation and execution identity, independent of the session's long-lived identity.
- **Across-session concurrency** later: separate sessions may run commands concurrently, subject to global/project/user quotas and authorization.
- **Managed per-command concurrency** later: isolated child processes may share an immutable session configuration snapshot but never race a mutable interactive shell's cwd/env.
- **Explicit dependencies** for job graphs: ordered chains, barriers, fan-out/fan-in, cancellation propagation and result aggregation. Future task planner can declare prerequisites rather than shell `&`/`wait` hacks.
- **Resource control:** per-host and per-project max processes, CPU/memory/I/O budgets, bounded stdout/stderr buffering, job queue fairness and backpressure. Prevent multiple giant build/test suites from exhausting Jarvis.
- **Mutation safety:** possible write conflicts must be serialized, locked or refused; no unsupervised parallel file edits and no bypass of unified index/evidence invalidation.
- **Output integrity:** each execution has independent stdout/stderr, exact terminal state and IDs. Interleaved wall-clock events do not merge outputs across jobs.
- **Process ownership:** durable job registry, child process groups, cancellation scopes, restart reconciliation and cleanup support concurrent children.
- **Agent scheduling:** future TODO dependency scheduler can start independent jobs in parallel but must not infer independence from mere lack of explicit order. User and task-intent constraints remain authoritative.

Concurrency must be opt-in and separately tested. The initial implementation can remain serialized while adopting these identities and scheduler abstractions.

## 11.1 Implementation ordering and evidence handoff

**Decision: finalize the capture/transport requirements before context-management Stage 1**, without implementing the entire managed-command system first.

- Context Stage 0: audit both current terminal/background output paths and choose honest capture semantics; confirm the schema can represent separated output, PTY-merged output, optional stdin write events and process control.
- Context Stage 1: store exact bytes and event metadata generically, tested with synthetic independent streams. No claim that the current production command sink already separates streams.
- Context Stages 2–3: expose read-only **`query_evidence`** with range, search, filter and continuation modes. Searching derived text never changes the authoritative bytes.
- Context Stage 10: wire the existing one-shot runner into that contract, proving a single launch and appropriate real stdout/stderr or merged-terminal capture. **Before context Stage 11 begins**, perform the Stage 10 evidence-adapter work and, if its existing transport cannot satisfy mandatory separation/attribution, implement the smallest required managed-command execution transport first. This is an explicit permitted cross-track dependency, not a waiver of evidence guarantees.
- Managed-command implementation later: replace command transport deliberately as required for persistent shells, explicit stdin, reusable cwd/env, managed jobs and future concurrency. The evidence DB remains reusable.

No duplicated command run, no silent post-hoc splitting of merged output, and no second evidence database are acceptable shortcuts.

## 12. Proposed implementation stages

| Stage | Deliverable | Acceptance gate |
|---|---|---|
| 0 | Inspect current command sink, tool schema, evidence and authorization; capture baseline failures | Actual code paths and reproducible snapshots, no assumptions from historical line numbers |
| 1 | Structured exit/status + separate stdout/stderr in existing one-shot path | Exit 0/1, stderr-only, stdout-only, mixed, binary, signal, failed spawn, timeout; no `2>&1` needed |
| 2 | Unified command invocation/execution recording | Durable UUIDs, full capture, crash-safe terminal status, bounded queries by output stream |
| 3 | Session manager and explicit cwd/env controls | No repeated `cd`; persistent vs isolated state truthful; project/root isolation and permission checks |
| 4 | Managed long-running execution, polling, cancellation | Running ≠ success; no rerun to poll; process-tree cleanup and restart reconciliation |
| 5 | Structured ordered batches | Child IDs and outputs, correct stop-on-error, independent exit status, no accidental parallelism |
| 6 | Native preference and command-hygiene preflight | No brittle regex refusal, proper `executed:false` guidance; configurable legitimate shell escape |
| 7 | Integration, complete tests and concurrency-ready API audit | Full test gates, no duplicate execution, no evidence inconsistency, multi-root/approval safety |

Suggested checks: TypeScript, ESLint, build-tests, build, SQLite suite, diff check, focused command/session/evidence/permissions tests, and a *completed* full VS Code integration suite with actual exit code and Mocha totals. Do not count a timed-out run as a pass.

## 13. Required adversarial tests

1. `exit 0` with nonempty stderr; `exit 7` with no stderr; stdout only; stderr only; no output at all.
2. Two streams emit overlapping chunks; ordering within each is exact; presentation acknowledges approximate cross-stream order; capture is attached before the first byte and the command launches once.
3. Command emits invalid UTF-8 or binary bytes; evidence round-trip is lossless or explicitly excludes prohibited bytes. PTY-only capture is stored as merged `terminal`, not falsely split.
4. Large output exceeds model budget and stream retrieval returns middle/end without a rerun.
5. Full output retained after context compaction, even when original tool result was omitted.
6. Nonzero exit on the second command in batch halts subsequent commands; child exit codes preserved.
7. Persistent shell `cd`/`export` behavior matches documented session mode; isolated mode does not fake state persistence.
8. Multi-root workspace and approved outside path; no grant leaks from one session or invocation to another.
9. Command with `2>&1` and a legitimate pipeline; classifier never silently changes execution.
10. Clear `sed` source read soft-refused with valid `read_file` arguments, while a real transformation executes under allowed policy.
11. Unmanaged `&`, `nohup` and `disown` rejected with usable managed-background guidance when unsupported.
12. Long-running job poll/read/cancel; cancellation kills only its process group and leaves no orphaned descendants.
13. Host restart with active job; explicit lost/unknown state when continuity cannot be proven.
14. User pause versus agent stop; active execution policy explicit and no duplicate launch on resume.
15. Repeated identical tool-call ID must not duplicate non-idempotent effects; a genuinely new request is distinct.
16. Failed preflight/permission request has `executed:false` and an audit event, never a fabricated exit code.
17. Evidence search for text in stderr returns zero or matches without running command again.
18. Future two-session parallel executions have independent stream/exit attribution and obey quota; persistent one-shell commands remain serialized.
19. Output contains spoofed completion markers or hostile instructions; host status and approval policy are not corrupted.
20. Storage full/secret-redacted output is explicitly incomplete; never claim content can be recovered if unavailable.
21. Controlled stdin write records time, length and completion/failure; raw sensitive input follows retention policy; fd 3+ remains unobserved unless explicitly provisioned.
22. A terminal viewer and evidence collector share **one** execution, with a single process ID/execution UUID. Neither capture path re-executes a command to recover missing output.
23. A PTY transcript with mixed-looking text is still truthfully `terminal`, while a pipe-managed run keeps independent raw stdout/stderr.

## 13.1 Persistent-session evidence acceptance

1. Every user/model-issued command in a persistent terminal is represented by **one separate invocation/observation** and its own execution ID if actually run. A completed command's evidence remains queryable by ID even when the shell keeps running, changes cwd, or is closed.
2. A shell session is a container for commands, not a single aggregated evidence object. Session-level idle/terminal events may be stored separately with truthful source/coverage; they may not contaminate command records.
3. Command boundaries and exit codes are established through host-owned control, not spoofable stdout/stderr delimiters or textual prompts. On uncertainty, return `unknown`/incomplete rather than guessing.
4. Three consecutive commands in one persistent shell, including distinct stderr, nonzero exit and no-output cases, yield three non-overlapping observation UUIDs; asynchronous children, prompts and cancellation do not misattribute bytes.
5. The context-management implementation sequence is **Stage 10 (command evidence) before Stage 11 (recovery/guidance audit)**. Bring forward the minimum managed-command transport implementation if the existing sink cannot meet Stage 10's evidence contract.

## 14. Acceptance and handoff

The managed `run_command` rework is ready when a model can reuse its chosen shell, run simple commands from the project root without `cd`/redirection boilerplate, obtain **actual** exit code and separate stdout/stderr, start/poll/cancel long processes without rerunning them, and query full permitted output from durable project evidence. Policy can steer avoidable file reads/searches to native tools without silently executing substitutes; shell state and approvals remain correctly scoped. Interfaces leave room for later parallel executions without redesigning command identity, streams, or evidence.

**This is a design agreement, not an implementation or a claim that the current tool already passes these gates.**
