# Moriarty Native Git Integration Implementation Plan

**Status:** Implementation plan - no implementation
**Repository:** `/home/stark/source/twinny`
**Branch audited:** `context-management`
**Audited at:** 2026-11-24

This staged plan begins only after the design in
`Moriarty_Git_Integration_Design.md` has been reviewed and the in-progress context-management
work has reached a stable contract checkpoint.

## 0. Repository-grounded audit

### 0.1 Existing components to reuse

| Component | Grounded purpose |
|---|---|
| `src/extension/tools/workspace.ts` | Tool definitions, typed argument parsing, dispatch and mutation serialization |
| `src/extension/tools/more.ts` | Existing read-only `git` tool and `insideGitRepository` |
| `src/extension/tools/helpers.ts` | Read-only Git allowlist and Git path safety |
| `src/extension/tools/operation-authorization.ts` | Existing one-call write authorization mechanism |
| `src/extension/tools/access-preflight.ts` | Outside-workspace and host authorization |
| `src/extension/tools/access-grants.ts` | Host-scoped grants and access store |
| `src/extension/chat/command-snapshot.ts` | Alternate-index tree snapshots and command change detection |
| `src/extension/chat/reply-changes.ts` | Agent file change tracking and undo evidence |
| `src/extension/chat/tool-sinks.ts` | Applied edit ledger and source reconciliation |
| `src/extension/chat/tool-evidence.ts` | Project tool observation recording |
| `src/extension/todos/evidence-config.ts` | Project `.twinny/config.json` parsing/reload behavior |
| `src/extension/todos/sqlite.ts` | Unified database schema v21 |
| `src/extension/todos/repository.ts` | Project/evidence/edit/source-validity APIs |
| `src/extension/todos/dependency-index.ts` | Source event reporting |
| `src/extension/todos/source-validity.ts` | Stale/current/historical validity types |
| `src/extension/chat/index.ts` | Conversation, model/provider, task and tool construction |
| `src/common/types.ts` | Existing tool-result, reply metadata and conversation types |
| `package.json` | Existing VS Code setting surface and test scripts |

### 0.1.1 Existing native Git implementation audit

The current implementation to extend, not replace, is identified by actual symbols:

- `src/extension/tools/more.ts`
  - `insideGitRepository(root)` checks `.git` in or above the workspace root.
  - `GIT_PINNED` fixes color/diff presentation.
  - `runGit(root,args,signal)` executes `git` with `execFile`, a timeout and
    `GIT_TERMINAL_PROMPT=0`.
  - `git(view)` registers the existing native tool with name `git`, parameter `args`,
    `readOnly: true` and model-facing output/summary behavior.
- `src/extension/tools/helpers.ts`
  - `READ_ONLY_GIT` allowlists `status`, `diff`, `log`, `show`, `blame`, `branch`,
    `shortlog`, `ls-files` and `rev-parse`.
  - `readOnlyGitArgs(line)` preserves legacy text parsing and rejects mutations/unsafe options.
  - `gitNamedPaths(args)` and `tidyGitPath(raw)` preserve repository/workspace path rules.
- `src/extension/tools/workspace.ts`
  - `workspaceTools(...)` registers `git(view)` only for a repository.
  - `WorkspaceTools.run(...)` dispatches the tool and `serializeMutation(...)` serializes
    mutations.
- `src/test/standalone/more-tools.standalone.ts`
  - real-repository tests prove legacy read-only argument behavior and mutation refusal.

The implementation plan therefore keeps one public tool name, `git`, and extends it with typed
operations. It does not introduce `git_status`, `git_commit`, `git_push` or equivalent public
tools.

### 0.2 Existing architecture constraints

- Native tools are `Tool` objects registered by `workspaceTools`.
- Mutating tools pass through `serializeMutation`.
- Tool access is checked with `createAccessPreflight`.
- Tool observations are stored with `conversationId`, `executionId`, task and source refs.
- The project database refuses schema versions other than v21.
- The project config reader is currently evidence-specific and has no generic Git section.
- `run_command` is already an unrestricted mutation-capable command surface.
- Accepted temporary limitation: native Git policies do not constrain Git commands invoked
  through `run_command`. Shell interception and Git subcommand classification are explicitly
  outside this implementation. The later managed `run_command` redesign must integrate the
  reusable Git execution boundary below.
- Existing `reply-changes.ts` tracks whole-file state while edit operations carry per-target
  pre/post digests.
- Existing `snapshotTree` already demonstrates how to copy the real index and use
  `GIT_INDEX_FILE`.
- Commit generation is currently not a native operation.

### 0.3 Dependencies on in-progress work

Do not modify the implementation of:

- context-management contracts;
- unified evidence tables or projections;
- source-validity contracts;
- edit-line/save reconciliation.

Git implementation may consume them but must use the stable public interfaces after the relevant
context branch stages are complete. In particular:

- Git source references must use `ObservedSourceReference`;
- Git tool calls must use `ToolResult`/`TodoToolObservation`;
- Git source changes must use `DependencyIndex.noteEvent` only when working-tree content actually
  changes;
- Git operation model provenance must use host-derived ToolContext fields;
- Git operation progress must survive context pruning through the database, not a second context
  message system.

### 0.4 Development database safety gate

Do not automatically reset or replace `.twinny/project.sqlite`.

Before any schema stage:

1. verify an existing database is v21;
2. copy it to a timestamped `.git-migration-backup-*` file in the project `.twinny` directory;
3. verify backup integrity;
4. run only additive `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`;
5. set `user_version=22` only after transaction success;
6. refuse the migration on any integrity or backup failure;
7. run tests against scratch databases, never the developer database.

No destructive migration or destructive SQLite reset is permitted.

## 1. Progress Log

Use this table in every stage update.

| Stage | Title | Status | Date | Verification | Result | Notes |
|---|---|---|---|---|---|---|
| 0 | Repository audit and contracts | in progress | 2026-11-24 | design documents and repository audit | no code changed | This plan is design-only |
| 1 | Project Git configuration and identity | complete | 2026-11-24 | `npm run build-tests`; `node --test out/test/standalone/git-config.standalone.js` (16 cases); existing evidence suites re-run; `npm run lint` | 16/16 pass; evidence suites unchanged at 19/15/14/6; eslint clean; no schema change and no Git process run | Shared reader in `src/extension/todos/project-config.ts`; `git/config.ts`, `git/identity.ts`, `git/auth.ts` added. Defaults: manual-approval, tagging true, remote origin, branch current, auth inherit. Invalid values fail with an actionable line instead of falling back; credential values stay out of readings and diagnostics; the tagging opt-out is not exposed in settings or the GUI |
| 2 | Git session baseline and ownership tracker | complete | 2026-11-25 | `npm run build-tests`; `node --test out/test/standalone/git-baseline.standalone.js` (14 cases); `command-snapshot.standalone.js` (4) and `git-config.standalone.js` (16) re-run; `npm run lint` | 14/14 pass; the reused suites unchanged at 4 and 16; eslint clean; no schema change and no staging, commit, push or branch change | `git/baseline.ts` reads the chat-start state through `status --porcelain=v1 -z`, `rev-parse` and `symbolic-ref` plus the existing `snapshotTree`, once per conversation and kept as it was; `git/ownership.ts` accepts the five host sources only and refuses any claim that is not host-derived |
| 3 | Repository/status/change native tools | complete | 2026-11-25 | `npm run build-tests`; `node --test out/test/standalone/git-tool-dispatch.standalone.js` (14 cases); `more-tools.standalone.js` (17), `git-baseline.standalone.js` (14), `git-config.standalone.js` (16), `line-edit.standalone.js` (101), `access-preflight.standalone.js` (23), `command-snapshot.standalone.js` (4) re-run; `npm run lint`; `npm run build`; `npx tsc -p . --noEmit`; `git diff --check` | every command exit 0: the Stage 3 suite 14/14 with the two cases that were red now green, and the reused suites unchanged at 17, 14, 16, 23, 4 (line-edit at its current 101); eslint, tsc and `git diff --check` clean; nothing staged, committed, pushed or branch-changed and no project database opened | `git/service.ts` runs the two typed reads behind the same `git` tool name: `status --porcelain=v1 -z`, `rev-parse`, `symbolic-ref` and bounded `diff --numstat -z` with the patch for the paths named, as argument arrays with no shell. The legacy `args` path is unchanged, its allowlist, path rules and output cap read through the service, and read-only is answered per call. The two audit failures were corrected in that file only: a named path is read both ways (as the open folder names it, and as the repository names it from its top) and answered for whichever reading this workspace may show; rename pairs are carried, and a `-z` pair record's counts belong to the name the path became. No assertion was weakened or removed |
| 4 | Alternate-index staging and commit | complete (the corrupted `src/extension/git/service.ts` line was the only thing standing between this stage's shapes and a compiling body; the truncated constant became the terminal-state set and the missing staging, commit and recovery bodies were written against the interfaces already in place — nothing that worked was rewritten) | 2026-11-27 | `npm run build-tests` exit 0; `node --test out/test/standalone/git-attribution.standalone.js` (9 cases), `git-index-staging.standalone.js` (11 cases), `git-transaction.standalone.js` (14 cases) — exit 0 each; every standalone suite together, 0 failures, including the reused Stage 2 and 3 suites (`git-baseline` 14, `git-tool-dispatch` 14, `access-preflight` 23, `more-tools`, `line-edit`, `command-snapshot`, `git-config`); `npm run lint` exit 0; `npm run build` exit 0; `npx tsc -p . --noEmit` exit 0; `git diff --check` clean. Staging writes only to a private copy of the real index in its own scratch folder, and each case compares the user's index bytes before and after. Commit dispatch runs from the persisted record by operation id, re-checks HEAD, branch, the real-index digest, recorded file digests and prepared blobs, ownership, claimed intent, task restriction and approval, then moves the ref through an atomic compare-and-set only. No test committed in the development repository, opened a database, amended, rebased, reset, stashed or pushed. |
| 5 | Push and ambiguous operation recovery | not started | | | | |
| 6 | Database/evidence/source-validity integration | not started | | | | |
| 7 | Authorization, workflow and UI integration | not started | | | | |
| 8 | Adversarial tests and final verification | not started | | | | |

Update this table only after the stage's acceptance gates pass. A stage's handoff must include:

- branch/HEAD;
- changed files;
- tests run;
- database state and migration status;
- unresolved risks;
- next stage;
- exact fresh-agent prompt.

### Stage 1 handoff

- Branch/HEAD: `integrated-git` at `6cbf2bf`; the working tree was clean before the stage started.
- Changed files: `src/extension/todos/project-config.ts` (new shared file reader and stamp cache), `src/extension/todos/evidence-config.ts` (reads through the shared parser; its defaults, validation wording, `otherKeys` report and reload behavior are unchanged), `src/extension/git/config.ts`, `src/extension/git/identity.ts`, `src/extension/git/auth.ts` (new), `src/test/standalone/git-config.standalone.ts` (new), `docs/twinny.config.example.json` (the Git example added).
- Tests run: the 11 named Stage 1 cases plus 5 added coverage cases, 16 total, all passing; existing evidence suites re-run unchanged (19, 15, 14, 6); `npm run build-tests` compiles and `npm run lint` is clean.
- Database state: schema stays v21. No table was created or changed, no migration was proposed or applied, and `.twinny/project.sqlite` was never opened by Stage 1 code or tests; every test ran on a scratch project under `/tmp`.
- Unresolved risks: the machine/user preference layer is validated as an input but no `package.json` setting exists yet (Stage 7 owns that); `managed` credentials are only a seam and report `managed credential provider not installed`; the child-process environment is assembled as data and has not been proven against a real Git process; explicit task restrictions are not read here.
- Next stage: Stage 2, session baseline and ownership tracker. Stage 2 must use `createDocumentSource` or `createGitConfigSource` rather than re-reading `config.json`, because file parsing and the stamp cache now belong to `project-config.ts`.
- Redacted credential diagnostic, as a test produced it: `mode=environment, GIT_TERMINAL_PROMPT=0, references=GIT_HTTP_EXTRA_HEADER` - the variable name is shown, the value is not.

### Stage 2 handoff

- Branch/HEAD: `integrated-git` at `6e89437`; the working tree was clean before the stage started. Stage 2's files are in the working tree and were not committed.
- Changed files: `src/extension/git/baseline.ts`, `src/extension/git/ownership.ts`, `src/test/standalone/git-baseline.standalone.ts` (new), and `src/extension/chat/command-snapshot.ts` where the snapshot primitives are exported for reuse (`runGitInRepository`, `GitAnswer`, `repositoryOf`, `RepositoryLocation`); its behaviour is unchanged. `reply-changes.ts` and `tool-sinks.ts` are read through their existing exports (`readState`, `ChangeRecord`, `EditOperationInput`) and were not changed; no extra session feed was needed.
- Tests run: the 6 named positive and 4 named negative Stage 2 cases plus 4 added coverage cases (a folder that is not a repository, a claim that is not host-derived, config read through the shared source with no credential value, clean-to-dirty and dirty-to-mixed transitions), 14 total, all passing; `command-snapshot` 4/4 and `git-config` 16/16 re-run unchanged; `npm run build-tests` compiles and `npm run lint` is clean.
- Baseline example, as the store's own `describe` printed it for a scratch repository: `conversation-demo session 8b27dab1-d6c3-4de7-b7e1-99931279e143 /tmp/show-repo-piH6QY head=e85d975c3888bdb3ddd71defa29b8b4aa28f7bf1 branch=master staged=0, unstaged=1, untracked=1 snapshot=98264f58b94b9f93f77139dbd902d92f50d6ccb0 index=89a74434c49341cfddf2f81ae327956cb959e506cc17e3a5d3a594f1b3c026e5; /tmp/show-home-MJqdo8/.twinny/config.json (config.json), auth.mode=environment, auth.env=GIT_HTTP_EXTRA_HEADER->MORIARTY_GIT_HTTP_EXTRA_HEADER` - the reference is named, what it holds is not.
- Ownership table example from the same run: `a.ts agent/verified` (the reply touched it first and read both sides) and `b.ts human/known` (what the baseline already had, named by a source save); `claimFor("a.ts")` allowed, `claimFor("b.ts")` refused with `git_not_agent_owned`, and a mixed file is refused for a whole-file claim with `git_mixed_ownership`.
- Git state: no staging, commit or push was run anywhere. The only writes are what a command snapshot already does - a temporary index copy and the objects `git write-tree` puts in each scratch repository's own object store. The real index is hashed as it sits on disk before git is asked anything, and every case asserts the file stayed byte-for-byte as it was and that `status` reported exactly what it did before.
- Database state: schema stays v21. No table was created or changed, no migration was proposed or applied, and `.twinny/project.sqlite` was never opened by Stage 2 code or tests; every case ran on a scratch repository and its own scratch project home under `/tmp`, and asserts that home holds nothing but `config.json`.
- Unresolved risks: no production path calls these stores yet, so no conversation captures a baseline until the hook is attached at `chat/index.ts` `completion()` (Stage 7 owns that wiring); the baseline lives in memory only until Stage 6 makes it durable; a staged entry's digest is what the host read from the working copy, not necessarily the index blob, so Stage 4 compares against that reading; hunk ownership exists only when an evidence source names hunks, so `splitFor` can name verified agent hunks but cannot split a file nothing attributed hunk by hunk; the baseline refuses a repository wider than `MAX_COMMAND_CHANGES` rather than guessing.
- Next stage: Stage 3, repository status and change inspection tools, which read through these two modules and keep the existing read-only `git` contract.
- Exact fresh-agent prompt: the one in section 5 of this plan, unchanged.

### Stage 3 handoff

- Branch/HEAD: `integrated-git` at `a04e81b`. Stages 1 and 2 were already in the working tree, uncommitted, when this stage started.
- Changed files: `src/extension/git/service.ts` (new - the one place a Git call runs), `src/extension/tools/more.ts` (the same `git` tool name answering both forms; its read-only safeguards - the allowlist, the path rules, the hidden-path filtering and the capped output - are read through the service rather than duplicated), `src/test/standalone/git-tool-dispatch.standalone.ts` (new). Wiring only: `protocol.ts` gains `readOnlyFor`, the per-call read-only answer for a tool whose classification depends on what the call asks for; `loop.ts` reads that same answer for its duplicate-call key; `workspace.ts` passes `ToolExtras.gitOptions` to the tool at registration; `access-preflight.ts` names the repository a `git` call targets as a read target, so a granted outside repository is reached through the existing authorization and an ungranted one is refused; `baseline.ts` exports `STATUS_OF_CODE` and `parsePorcelain` for reuse. No public tool name was added and no second inventory entry.
- Tests run: 8 cases - the 4 named positives (`git status reports repository state`, `git inspect changes separates staged unstaged and untracked`, `git tools respect workspace boundaries`, `git tools join the real tool dispatcher`) and the 4 named negatives (`git status outside repository fails clearly`, `git inspect rejects blocked path`, `git inspect rejects outside-workspace repository`, `git status does not dump credentials`). The three named cases about the existing contract - read-only `args` and output, real-repository `diff/status/log` reads, ignored/blocked path filtering - are proven unchanged by `more-tools.standalone.js`, re-run at its previous 17; one dispatch case runs a legacy `args` line again through the same tool. `npm run build-tests` compiles and `npm run lint` is clean.
- Representative status payload (a scratch repository, one change on each side, `dist/` ignored): `{"kind":"git_status","succeeded":true,"repository":{"top":"/tmp/git-rep-...","head":"d2b33b0c99263026375217e89d02e03bb08fb85c","branch":"master"},"staged":["src/b.ts"],"unstaged":["src/a.ts"],"untracked":["scratch.txt"],"baselineId":"d6b0abcf-2dc6-4648-ac8c-751889a515eb","config":{"mode":"manual-approval","plainCommit":"commit-only"},"auth":{"mode":"inherit","references":[]},"capabilities":{"commit":"approval-required","push":"approval-required","basis":"git.workflow.mode=manual-approval; the preset's permission only, and this stage runs neither commit nor push"},"leftOut":1}` - the permission is named with where it came from, and `leftOut` says one path was kept out rather than silently dropped.
- Representative inspect payload for the same repository: `{"kind":"git_inspect","succeeded":true,"paths":["scratch.txt","src/a.ts","src/b.ts"],"changes":[{"path":"src/b.ts","side":"staged","status":"modified","ownership":"unknown","confidence":"known","added":1,"removed":1,"digest":"a971c227..."},{"path":"src/a.ts","side":"unstaged","status":"modified","ownership":"unknown","confidence":"known","added":1,"removed":1,"digest":"81be7ce0..."},{"path":"scratch.txt","side":"untracked","status":"untracked","ownership":"unknown","confidence":"uncertain","digest":"be818c87..."}],"stat":{"files":3,"additions":2,"deletions":2},"baselineId":"d6b0abcf-2dc6-4648-ac8c-751889a515eb","diff":"...","leftOut":1}`. A path named outright that may not be shown is refused, not left out: `{"code":"git_path_not_visible","executed":false,"message":"Inspection refused: logs/secret.log cannot be shown","recovery":"logs/secret.log is kept from the agent by the team's rules and cannot be read. Name a path this workspace may show."}`. `ownership` is `unknown` with no host fact for the path; nothing here claims an owner.
- Git state: no staging, commit, push or branch change anywhere. Only read commands run, as argument arrays with no shell, and each case hashes the real index before git is asked anything and asserts it stayed byte-for-byte, that porcelain says the same after the read, and that HEAD is the same. Test fixtures build their own scratch repository with an initial commit; no case lets the tool write to one.
- Database state: schema stays v21. No table was created or changed, no migration was proposed or applied, and `.twinny/project.sqlite` was never opened by Stage 3 code or tests; every case keeps its own project home apart from the repository it reads, and asserts that home holds nothing but `config.json`. Recorded raw output is left to the existing evidence recording through the host's observation lookup; an id is only printed when the host recorded one, never invented.
- Unresolved risks: nothing in production passes `gitOptions` yet, so status and inspect read the stores as the host gives them until Stage 7 wires the call (the same wiring that attaches the baseline capture at `chat/index.ts` `completion()`); `readOnlyFor` is consulted by `workspace.ts` and `loop.ts` only - any other consumer still reads `tool.readOnly`, which stays true for the whole tool, so a caller that does not look per call treats a typed commit or push as read-only; `prepare_commit`, `commit`, `push` and `recover` are named in the type list and refused with `git_operation_not_supported` before anything runs, so no alternate index, no temporary-index staging code and no transaction exists yet; `recover` is listed as read-only because Stage 5 needs a classification for it now, and Stage 5 must decide what it actually does; the credential environment is assembled as data and proved not to print a value, not against a real remote; a repository wider than `MAX_COMMAND_CHANGES` is refused rather than guessed.
- Next stage: Stage 4, alternate-index staging and commit, which reads through this service's `resolveRepository`, `runGit`, the hidden-path rules and the ownership index, and must keep the same refusal shape (`code`, `executed: false`, message, recovery) and the same single tool name.
- Exact fresh-agent prompt: the one in section 6 of this plan, unchanged.

### Stage 3 final acceptance audit (2026-11-25)

Branch `integrated-git` at `a04e81b`; the working tree held Stages 1 and 2 uncommitted plus Stage 3's own files.
Each command was run on its own with its real exit code, output captured to a log:

| Command | Exit code | Final summary |
|---|---|---|
| `npm run build-tests` | 0 | compiles clean |
| `node --test out/test/standalone/git-tool-dispatch.standalone.js` | **1** | 14 tests, 12 pass, **2 fail** |
| `node --test out/test/standalone/more-tools.standalone.js` | 0 | 17/17, unchanged |
| `node --test out/test/standalone/git-baseline.standalone.js` | 0 | 14/14, unchanged |
| `node --test out/test/standalone/git-config.standalone.js` | 0 | 16/16, unchanged |
| `node --test out/test/standalone/line-edit.standalone.js` | 0 | 100/100, the reconciliation cases included |
| `node --test out/test/standalone/access-preflight.standalone.js` | 0 | 23/23, unchanged |
| `npm run lint` | 0 | clean |
| `npm run build` | 0 | clean |
| `npx tsc -p . --noEmit` | 0 | 0 findings |
| `git diff --check` | 0 | no whitespace findings |

Two criteria fail, both in the implementation and not in the test, its fixture or the environment:

- `a path named as the open folder names it is answered for, not refused`: with the open folder a subfolder of the repository, `inspect` answers for a path named from the repository top (as `status` names it) and refuses the same visible file named from the open folder - `Inspection refused: kept.ts cannot be shown`, saying it is not a path this workspace may show. `hiddenHere` reads the given path from the open folder while `hiddenIn` reads it from the repository top, so the two disagree whenever the prefix is not empty. Proposed correction: read each given path as the name the call gave it and as the same path under the prefix, accept either when this workspace may show it, and refuse only what is genuinely outside, ignored or kept.
- `a rename answers as the pair git named it`: `GitInspectedChange.from` is declared but never set, so a rename carries no pair; a rename source named outright is answered as `clean`; and `parseNumstat` skips the `-z` pair record because its path field is empty (`if (!named) continue`), so what reaches the reading is the count from a run restricted to one side - a pure rename read as `+3/-0` where git's own record says `0/0`. Proposed correction: keep the pair `parsePorcelain` already reads, attribute that record's counts to the name it became, answer a selected source with the status git gave it, and carry `from` only for a name this workspace may show.

Two narrow corrections were applied, and nothing else:

- `src/extension/tools/access-preflight.ts`: the `git` case now takes its access class from the same per-call answer the dispatcher and the loop use (`gitCallIsReadOnly`) instead of naming every git call a read. A mutating operation asks for write, so a grant taken for `status` cannot carry it - read never covers write. No commit or push code was added and no write operation name is invented here; the stage that stages names its own. Covered by `the access preflight decides git access for the call, not for the tool`, which measures both sides.
- `src/extension/git/baseline.ts`: `parsePorcelain` read the path with `field.slice(2).replace(/^ +/, "")`, taking the separating space and a name that starts with one together, so `" x.ts"` was reported as `"x.ts"`. It now reads the path after porcelain's single separating space (`field.slice(3)`), which is what porcelain v1 writes. Covered by `git inspect answers renames, deletions and names holding spaces`, which compares each status, side and count against git's own `-z` records on a scratch repository holding a staged rename, an unstaged deletion, an unstaged change and an untracked file at once.

Not repaired here: `src/extension/git/service.ts` is still held by unresolved edit operation `cae44bc9-86ba-4d39-9f1d-1804ee106f71` (status `diverged`, from another window or an earlier session), so the path rule cannot be changed from this host. Nothing was reset, stashed, settled or cleared - that block is what keeps external content from being overwritten, and it still stands.

Read-only consumers traced: tool registration (`more.ts`: `readOnly: true` plus `readOnlyFor`), `WorkspaceTools.run` (source-resolver kind, the aborted-signal gate and mutation serialization), the loop's duplicate/read-only cache key, `access-preflight.ts`, the source resolver through that preflight, and the tool inventory. Every one now answers per call; nothing takes the whole-tool `readOnly: true` as permission for a typed commit or push, and no read grant carries a mutating git call.

Real-repository results through `WorkspaceTools.run` (scratch repositories under `/tmp`, never the development repository): legacy `args` reads unchanged, including a refused shell line that ran no process; `status` matched `diff --name-status -z` and `ls-files --others --exclude-standard` for every category at once; `inspect` matched git's own `-z` counts for each path named as `status` names it (a `-z` pair record is not attributed to the path, which is what the second failing case shows); names holding spaces were carried as git named them, including a name beginning with one after the `parsePorcelain` correction; ignored and blocked paths stayed out with `leftOut` counting them; an outside repository was refused without a grant and reached no further than a grant; failing git reads answered as bounded results (`git_too_many_changes`, `git_read_failed`); repeated inspection answered the same way and left the real index, the porcelain record and HEAD as they were; and the inventory holds exactly one native `git` tool with no `git_status`-style name.

Ownership and evidence: inspection reads Stage 2's contracts through `STATUS_OF_CODE`, `parsePorcelain`, the baseline store and the ownership index, with nothing duplicated. A path the baseline already had stayed `unknown` until a host fact named it; a second host source on the same path made it `mixed`; a claim naming a provenance outside the five host sources was refused with `git_ownership_not_host_derived` and left `unknown`. The digests matched what the host measured, and the whole retained patch came back through the existing read-only evidence access on a scratch project - 3,127 stored bytes, retrievable in bounded pages and searchable - with no credential value in the reading, the summary or the recorded output. An `observationId` is printed only when the host's lookup names one; none was invented.

Wired for tests only, not for production: `ToolExtras.gitOptions` reaches the tool through `workspaceTools`, but no production call site supplies the conversation, the stores or the observation lookup, so live conversation ownership tracking does not work yet - Stage 7 owns that wiring. No claim of live ownership tracking is made here.

Verdict: **NO-GO**. The authorization mismatch was real and is now closed by a narrow correction; two criteria remain unmet - the path naming above, and rename pairs (`from` declared but never carried, a selected rename source answered as `clean`, and `-z` pair counts dropped). Both belong to `src/extension/git/service.ts`, which cannot be edited from this host while the operation named above is unsettled, so the suite is left red for those two cases rather than the assertions being softened. Stage 3 cannot be accepted as complete and Stage 4 must not start until these are settled in the window holding that pending operation.

**Superseded 2026-11-25 by the Stage 3 close below:** the two criteria in this verdict are met, and Stage 3 is complete. This paragraph stands as the audit as it was recorded at the time.

That block is now closed: the native editing lockout was recovered and live-verified by `003d7d5` (the P0 repair), so `src/extension/git/service.ts` could be edited from this host on 2026-11-25. Nothing was reset, stashed, settled or cleared by hand, and no earlier part of this audit is re-opened here.

### Stage 3 close (2026-11-25) - both criteria met, stage complete

Branch `integrated-git` at `003d7d5`. The only change for this close is `src/extension/git/service.ts`; no test, fixture or assertion was touched, and the two failing regression tests were used as the acceptance criteria exactly as they stand.

Criterion 1 - workspace-relative against repository-relative path handling. A name the call gives is now read both ways: as the open folder names it, and as the same path under the prefix, as the repository names it (`nameOf`, answering through the existing `hiddenIn`). The reading is given for whichever reading this workspace may show; what is genuinely outside, ignored by `.gitignore` or kept by the team's rules is still refused with the reason the call named, before anything runs, and the refusal shape (`code`, `executed: false`, message, recovery) is unchanged. Workspace authorization is untouched: the repository a call reaches is still decided by the existing access preflight, and pathspec magic and an absolute or `..` name are still refused outright.

Live through the real dispatcher on a scratch repository with the open folder at `packages/api` inside the repository top:

- `paths: ["kept.ts"]` answers `[{"path":"packages/api/kept.ts","side":"unstaged","status":"modified",…}]`, and the counts match git's own record for that path (`2\t1\tpackages/api/kept.ts`);
- naming the same file as the repository names it answers identically;
- `../packages/web/sibling.ts` is still refused (outside the workspace), an ignored name is still refused by the `.gitignore` rule, and a name the team's rules keep is still refused - each with `executed: false`;
- `status` reports the open folder's own change as the repository names it and counts what it keeps out with `leftOut`; nothing kept from the agent is named.

Criterion 2 - rename source/destination reporting and `git diff --numstat -z`. `GitInspectedChange.from` is carried for the name the path became, as porcelain's pair record names it, and only when this workspace may show that name as well; a name the workspace's rules keep is never put into the reading. A rename source named outright is answered with git's own status instead of `clean`. `parseNumstat` now reads the `-z` pair record - counts, an empty path field, then the name it came from and the name it became as their own fields - instead of skipping it, so those counts are attributed to the name the path became.

Live on a scratch repository holding a pure staged rename:

- git's own record `0\t0\t` + `read as.ts` + `became.ts` answers as `{"path":"became.ts","side":"staged","status":"renamed","from":"read as.ts","added":0,"removed":0}`;
- the name it came from answers `renamed`, not clean;
- a rename whose other name is kept from the agent carries no pair name (`from` left out) and names no kept path anywhere in the reading.

Gates, each run on its own with its real exit code:

| Command | Exit code | Result |
|---|---|---|
| `npm run build-tests` | 0 | compiles clean |
| `node --test out/test/standalone/git-tool-dispatch.standalone.js` | 0 | 14/14; the two cases named above are green |
| `node --test out/test/standalone/more-tools.standalone.js` | 0 | 17/17, unchanged |
| `node --test out/test/standalone/git-baseline.standalone.js` | 0 | 14/14, unchanged |
| `npm run lint` | 0 | clean |
| `npm run build` | 0 | clean |
| `git diff --check` | 0 | no whitespace findings |

Re-run unchanged: `git-config` 16/16, `line-edit` 101/101 (the reconciliation cases included), `access-preflight` 23/23, `command-snapshot` 4/4; `npx tsc -p . --noEmit` 0 findings.

Read-only and the mutation boundary, checked live: the inventory holds exactly one native `git` tool, registered read-only with `readOnlyFor`; `status`, `inspect` and legacy `args` answer read-only, while `commit`, `prepare_commit` and `push` answer not-read-only and are refused with `git_operation_not_supported` before anything runs; the access preflight asks write for each of those three for its own call, a grant taken for a read does not carry them (read never covers write), an ungranted outside repository is refused before any process runs, and every read left the real index, the porcelain record and HEAD as they were. Every consumer that decides read or write - `workspace.ts`, `loop.ts`, `access-preflight.ts`, the tool inventory and the source resolver through the preflight - answers per call.

Database state: schema stays v21. No table was created or changed, no migration was proposed or applied, and `.twinny/project.sqlite` was never opened by Stage 3 code, tests or this close; every case runs on a scratch repository and its own scratch project home under `/tmp`, which holds nothing but `config.json`.

Remaining limitations (unchanged from the audit, recorded here as accepted):

- Nothing in production passes `gitOptions`: no call site supplies the conversation, the baseline/ownership stores or the observation lookup, so live conversation ownership tracking does not work yet. Stage 7 owns that wiring, including attaching the baseline capture at `chat/index.ts` `completion()`.
- `paths` in an inspection reading reports each name as the repository names it, which is what `status` already does; a file named from the open folder is answered for that name. The view's ignore rules are read from the open folder down, so a `.gitignore` rule written above the open folder is not this workspace's rule - behaviour unchanged by this close, recorded as a limitation.
- Rename counts depend on what git measured for the paths named: with both names in the call git prints the pair record (0/0 for a pure rename), while a read restricted to one side prints that side's own counts. The reading answers with what git printed, never with an inferred pair.
- `recover` is listed as read-only because Stage 5 needs a classification for it now; Stage 5 must decide what it actually does.
- Native Git policies still do not constrain Git run through `run_command`; the documented temporary bypass stands, and the managed run-command redesign must reuse this service's execution boundary.

Stage 3 is complete. Next stage: Stage 4, alternate-index staging and commit, reading through this service's `resolveRepository`, `runGit`, `hiddenHere`/`hiddenIn`/`nameOf`, the hidden-path rules and the ownership index, keeping the same refusal shape (`code`, `executed: false`, message, recovery) and the same single tool name, and carrying a staged rename's pair into its own staging decision. Stage 4 must not inherit read-only authorization: a commit call asks for write access for its own call, as the close above measured. Exact fresh-agent prompt: the one in section 6 of this plan, unchanged.

Git state for this close: nothing was staged, committed, pushed, reset or branch-changed. The development repository's working tree holds this stage's changed source file plus this plan update, and no Git write command was run anywhere.

## 2. Cross-stage contracts

### 2.1 Project configuration

Add/extend these exact components:

- `src/extension/todos/project-config.ts` - new generic project config reader shared by Git and
  evidence configuration;
- `src/extension/todos/evidence-config.ts` - adapt to the shared reader while preserving existing
  evidence behavior;
- `docs/twinny.config.example.json` - add the Git example without adding the tagging opt-out as
  a GUI setting;
- `package.json` - add only minimal machine-scoped Git workflow/destination user preferences;
  do not add tagging or secrets.

No config reader may overwrite the project file.

### 2.2 Git implementation

Add:

- `src/extension/git/config.ts` - effective config resolution and identity types;
- `src/extension/git/auth.ts` - credential mode resolution and child-process environment assembly;
- `src/extension/git/baseline.ts` - session baseline and repository snapshot;
- `src/extension/git/ownership.ts` - session ownership index;
- `src/extension/git/service.ts` - authoritative Git execution, repository resolution,
  temporary-index staging, commit/push and recovery behind `git(view)`;
- `src/extension/git/transaction.ts` - commit/push state machine and idempotent recovery;
- `src/extension/git/identity.ts` - Moriarty/human attribution resolution;
- `src/extension/tools/more.ts` - remain the public `git(view)` tool registrar and
  compatibility adapter; add typed operation dispatch to the shared service.

Reuse, do not duplicate:

- `snapshotTree` behavior from `src/extension/chat/command-snapshot.ts`;
- change observation behavior from `src/extension/chat/reply-changes.ts`;
- edit operation behavior from `src/extension/chat/tool-sinks.ts`;
- tool evidence behavior from `src/extension/chat/tool-evidence.ts`.

### 2.3 Authorization extension

Extend existing files:

- `src/extension/tools/operation-authorization.ts`;
- `src/extension/tools/access-preflight.ts`;
- `src/extension/tools/workspace.ts`;
- `src/extension/chat/access-approval.ts`.

The Git authorization is one host-issued authorization object in the same lifecycle as file write
authorization. It is not a new approval store or model-facing mechanism.

### 2.4 Database extension

If no generic transaction contract is established by the context-management checkpoint, add:

- `git_sessions`;
- `git_operations`;
- `git_change_ownership`.

Update:

- `src/extension/todos/sqlite.ts`;
- `src/extension/todos/repository.ts`;
- `src/extension/todos/types.ts`.

Schema remains v21 until an approved additive v22 migration is implemented.

## 3. Stage 1 - Project Git configuration and identity

### Purpose and prerequisites

Purpose: establish reliable effective Git configuration, identity resolution and the hidden tagging
opt-out before any mutation is possible.

Prerequisites:

- Design reviewed;
- existing evidence config behavior understood;
- no uncommitted unrelated work overwritten.

### Exact expected files/components

- `src/extension/todos/project-config.ts`;
- `src/extension/todos/evidence-config.ts`;
- `src/extension/git/config.ts`;
- `src/extension/git/identity.ts`;
- `src/extension/git/auth.ts`;
- `src/test/standalone/git-config.standalone.ts`;
- `docs/twinny.config.example.json`.

### Contracts introduced

```ts
export type GitWorkflowMode =
  "manual-approval" | "local-commits" | "commit-and-push" | "autonomous";

export interface GitProjectConfig {
  workflow: {
    mode: GitWorkflowMode;
    plainCommit: "commit-only" | "commit-and-push";
  };
  destination: {
    remote: string;
    branch: "current" | string;
    setUpstream: boolean;
  };
  identity: {
    tagging: boolean;
    email: ConfigValue | undefined;
    human: { name: string; email: ConfigValue } | undefined;
  };
  auth: GitAuthConfig;
}
```

`ConfigValue` is `{ value: string } | { env: string }`.

Add a credential-provider seam:

```ts
export interface GitCredentialProvider {
  resolve(request: GitCredentialRequest): Promise<GitCredentialContext>;
}
```

V1 implements `inherit`, `dedicated` and `environment`; `managed` resolves a future provider
throwing a clear `"managed credential provider not installed"` error.

### Implementation tasks

1. Extract or wrap existing evidence config reading into a generic project-config reader.
2. Preserve existing evidence defaults and invalid-file behavior.
3. Validate `git` as an object and validate only keys Moriarty owns.
4. Preserve unrelated keys and report them when appropriate.
5. Merge built-in, user preferences and project config in order.
6. Resolve Moriarty email only at execution time.
7. Resolve human identity from explicit project human config, then Git config, then explicit
   host instruction.
8. Implement auth environment assembly without exposing secret values.
9. Cache config reload by file stamp like `createPolicySource`.

### Acceptance criteria

- Missing config uses tagging enabled and manual-approval default.
- Missing Moriarty email yields a clear commit refusal.
- Invalid `tagging` values fail clearly.
- Invalid workflow, branch, auth mode or env-reference shape fails clearly.
- Direct and env email resolve correctly.
- Environment secret values are not stored or returned.
- Evidence config behavior remains unchanged.

### Named tests

Positive:

- `git config uses defaults when config is absent`
- `git config merges project and user precedence`
- `git config resolves Moriarty email from an environment variable`
- `git config resolves human co-author identity`
- `git config reloads after file stamp change`
- `git config preserves unrelated project keys`

Negative:

- `git config rejects invalid tagging value`
- `git config rejects invalid workflow`
- `git config rejects missing env variable`
- `git config rejects corrupt JSON`
- `git config never exposes credential value`

### Verification commands

```bash
npm run build-tests
node --test out/test/standalone/git-config.standalone.js
npm run lint
```

### No-go conditions

- No implementation if config invalid values silently fall back.
- No implementation if secret values enter parsed config/evidence types.
- No implementation if tagging is exposed in the GUI/package setting.
- No implementation if project config overwrites evidence settings.

### Completion report requirements

Report effective-config examples, file change set, test counts, and one redacted credential
diagnostic. State that no database or repository mutation occurred.

### Handoff prompt

```text
Fresh-agent handoff: Stage 1 of Moriarty Git integration.

Read docs/Moriarty_Git_Integration_Implementation_Plan.md and
docs/Moriarty_Git_Integration_Design.md.
Implement only Stage 1: project Git config and identity/auth resolution.

Reuse src/extension/todos/evidence-config.ts conventions; do not expose credentials.
Do not add GUI tagging controls or mutate project.sqlite.
Add src/extension/todos/project-config.ts only if evidence-config can safely share parsing.
Add src/extension/git/config.ts, identity.ts and auth.ts.
Add src/test/standalone/git-config.standalone.ts and run:
npm run build-tests
node --test out/test/standalone/git-config.standalone.js
npm run lint

Stop and report if existing evidence config behavior would change.
Update the Progress Log only after every Stage 1 acceptance gate passes.
Use no network, commit, push or branch change.
```

## 4. Stage 2 - Git session baseline and ownership tracker

### Purpose and prerequisites

Purpose: capture chat-start state and classify agent/human/external change ownership.

Prerequisites:

- Stage 1 passes;
- context conversation ID and ToolContext model/provider hooks are stable;
- no git source-validity contract changes.

### Exact expected files/components

- `src/extension/git/baseline.ts`;
- `src/extension/git/ownership.ts`;
- `src/extension/chat/command-snapshot.ts` - extract/reuse snapshot primitives only;
- `src/extension/chat/reply-changes.ts` - add session ownership feed if needed;
- `src/extension/chat/tool-sinks.ts` - feed edit postdigests;
- `src/extension/chat/index.ts` - capture at `completion()`/active conversation start;
- `src/test/standalone/git-baseline.standalone.ts`.

### Contracts introduced

```ts
export interface GitSessionBaseline {
  id: string;
  conversationId: string;
  repositoryTop: string;
  headBefore: string | null;
  branchBefore: string | null;
  realIndexDigest: string;
  staged: GitChange[];
  unstaged: GitChange[];
  untracked: string[];
  workingTreeSnapshot: string;
}

export interface GitOwnershipChange {
  path: string;
  ownership: "agent" | "human" | "external" | "mixed" | "unknown";
  confidence: "verified" | "known" | "uncertain";
  preDigest?: string;
  postDigest?: string;
  hunks?: GitHunkOwnership[];
}
```

Capture baseline once per conversation at host completion start and expose by
conversation/session ID.

### Implementation tasks

1. Reuse repository detection and `snapshotTree`.
2. Capture HEAD, branch, index digest, staged/unstaged/untracked.
3. Persist baseline to in-memory state and, once Stage 6 DB exists, database.
4. Feed native edit pre/post digest data into ownership.
5. Feed command snapshots before/after into ownership.
6. Mark baseline-only changes human/external/unknown, never agent.
7. Track clean-to-dirty and dirty-to-mixed transitions.
8. Attach model/provider/provenance from the host only.

### Acceptance criteria

- Clean baseline has no pre-existing changes.
- Dirty baseline records all staged/unstaged/untracked categories.
- Agent edits are owner-agent.
- Existing staged changes are owner-human/unknown, not agent.
- Later external edits on a touched file become mixed/unknown.
- Context pruning or model change does not alter baseline.
- Multiple conversations do not merge ownership baselines.

### Named tests

Positive:

- `git baseline captures clean repository`
- `git baseline captures staged unstaged and untracked`
- `git ownership marks native edit agent`
- `git ownership marks command snapshot agent`
- `git ownership survives model change`
- `git ownership keeps multiple conversations separate`

Negative:

- `git baseline does not claim preexisting changes`
- `git ownership refuses unknown mixed file`
- `git ownership does not claim later external edit`
- `git baseline ignores unrelated repository`

### Verification commands

```bash
npm run build-tests
node --test out/test/standalone/git-baseline.standalone.js
node --test out/test/standalone/command-snapshot.standalone.js
npm run lint
```

### No-go conditions

- No implementation if baseline captures model-inferred ownership.
- No implementation if a new context subsystem is introduced.
- No implementation if `run_command` change snapshots are inferred to be Moriarty-owned without
  the existing before/after evidence.
- No implementation if pre-existing changes are retroactively tagged.

### Completion report requirements

Include baseline examples, ownership table examples and test counts. Confirm no staging or commit
was run.

### Handoff prompt

```text
Fresh-agent handoff: Stage 2 of Moriarty Git integration.

Read docs/Moriarty_Git_Integration_Implementation_Plan.md and
docs/Moriarty_Git_Integration_Design.md.
Implement only Stage 2: Git chat-start baseline and ownership tracking.

Reuse src/extension/chat/command-snapshot.ts, reply-changes.ts and tool-sinks.ts.
Do not create a second context system or modify context-management contracts.
Do not mutate Git state beyond temporary snapshots.
Add src/extension/git/baseline.ts, ownership.ts and git-baseline standalone tests.
Run:
npm run build-tests
node --test out/test/standalone/git-baseline.standalone.js
node --test out/test/standalone/command-snapshot.standalone.js
npm run lint

Stop if ownership would need inferred model claims.
Update Progress Log only after acceptance gates pass.
Do not commit, push or change branches.
```

## 5. Stage 3 - Repository status and change inspection tools

### Purpose and prerequisites

Purpose: expose typed, read-only native Git status and diff/ownership inspection.

Prerequisites:

- Stages 1-2 pass;
- `workspaceTools` dispatch and access preflight are stable;
- read-only Git tool safety remains available.

### Exact expected files/components

- `src/extension/tools/more.ts`;
- `src/extension/git/baseline.ts`;
- `src/extension/git/ownership.ts`;
- `src/extension/tools/workspace.ts`;
- `src/test/standalone/git-tool-dispatch.standalone.ts`;
- existing `src/extension/tools/more.ts` remains as read-only Git helper.

### Contracts introduced

- `git(operation:"status")`;
- `git(operation:"inspect")`;
- the existing `args` read-only compatibility contract;
- dynamic call-aware read-only classification for the existing tool.

Do not add public tool names or a second tool inventory entry.

### Implementation tasks

1. Keep `git(view)` registered only inside a confirmed Git repository.
2. Restrict paths to workspace/repository authorization.
3. Use argument arrays and no shell interpolation.
4. Use `git status --porcelain=v1 -z` and bounded diff/stat commands.
5. Add compact ownership projection.
6. Add `observationId` to tool results.
7. Reuse existing evidence recording automatically.

### Acceptance criteria

- Status reports HEAD/branch/staged/unstaged/untracked accurately.
- Change inspection reports exact selected paths and ownership.
- `.gitignore` and blocked workspace paths remain hidden.
- No outside-workspace repository is reached without access authorization.
- Tool results remain compact and evidence-retrievable.

### Named tests

Positive:

- existing read-only `git` arguments and output remain unchanged;
- existing real-repository `git diff/status/log` reads remain unchanged;
- existing ignored/blocked path filtering remains unchanged;
- `git status reports repository state`
- `git inspect changes separates staged unstaged and untracked`
- `git tools respect workspace boundaries`
- `git tools join the real tool dispatcher`

Negative:

- `git status outside repository fails clearly`
- `git inspect rejects blocked path`
- `git inspect rejects outside-workspace repository`
- `git status does not dump credentials`

### Verification commands

```bash
npm run build-tests
node --test out/test/standalone/git-tool-dispatch.standalone.js
node --test out/test/standalone/more-tools.standalone.js
npm run lint
```

### No-go conditions

- No implementation if Git tools bypass `WorkspaceTools.run`.
- No implementation if tool output exposes ignored/blocked files.
- No implementation if read-only Git mutates repository state.

### Completion report requirements

Include representative status/inspect payloads and test counts.

### Handoff prompt

```text
Fresh-agent handoff: Stage 3 of Moriarty Git integration.

Read docs/Moriarty_Git_Integration_Implementation_Plan.md and
docs/Moriarty_Git_Integration_Design.md.
Implement only Stage 3: `git(operation:"status")` and
`git(operation:"inspect")` while preserving legacy `args` reads.

Extend src/extension/tools/more.ts and src/extension/git/service.ts.
Reuse src/extension/tools/more.ts read-only safeguards and
src/extension/tools/access-preflight.ts authorization.
Do not implement commit or push yet.
Add src/test/standalone/git-tool-dispatch.standalone.ts.

Run:
npm run build-tests
node --test out/test/standalone/git-tool-dispatch.standalone.js
node --test out/test/standalone/more-tools.standalone.js
npm run lint

Stop if a tool can reach blocked/outside content or mutate the repository.
Do not commit, push or change branches.
Update Progress Log only after acceptance gates pass.
```

## 6. Stage 4 - Alternate-index staging and commit

### Purpose and prerequisites

Purpose: create isolated, idempotent commits with accurate identity and no real-index changes.

Prerequisites:

- Stages 1-3 pass;
- database schema decision made (Stage 6 can overlap after schema review);
- commit authorization extension approved.

### Exact expected files/components

- `src/extension/git/service.ts`;
- `src/extension/git/identity.ts`;
- `src/extension/git/transaction.ts`;
- `src/extension/tools/more.ts`;
- `src/extension/tools/operation-authorization.ts`;
- `src/extension/tools/access-preflight.ts`;
- `src/test/standalone/git-index-staging.standalone.ts`;
- `src/test/standalone/git-attribution.standalone.ts`;
- `src/test/standalone/git-transaction.standalone.ts`.

### Contracts introduced

- `git(operation:"prepare_commit")`;
- `git(operation:"commit")`;
- `git(operation:"recover")`;
- commit operation state machine;
- typed attribution resolution.

### Implementation tasks

1. Copy the real index to a private temporary `GIT_INDEX_FILE`.
2. Never call `git add -A`.
3. Implement exact untracked/tracked/delete staging.
4. Implement verified hunk patches where native edit evidence supplies exact hunks.
5. Refuse mixed/unknown whole-file selection.
6. Write a temporary tree and compute its SHA/diff digest.
7. Preserve real-index and working-tree digests.
8. Persist prepared operation state before commit dispatch.
9. Recheck HEAD, real index and selected file/hunk digests.
10. Resolve author/committer/human co-author from trusted host policy.
11. Set `GIT_AUTHOR_*` and `GIT_COMMITTER_*` in the Git child process.
12. Record commit SHA, parents, tree, author, committer, co-authors and changed files.
13. On interruption inspect matching parent/tree/message before creating another commit.
14. Delete temp index and patch files.

### Attribution matrix

| Start state / change ownership | Tagging | Author | Committer | Co-author |
|---|---|---:|---|---|
| clean, Moriarty changed | true | Moriarty | Moriarty | human if known |
| clean, Moriarty changed | false | normal identity | normal identity | no Moriarty trailer |
| dirty, only pre-existing work | true | known human/original identity | Moriarty | none solely for Moriarty commit |
| dirty, only pre-existing work | false | normal identity | normal identity | none |
| mixed/uncertain | true | explicit/split, not guessed | Moriarty | human if explicitly known |

### Acceptance criteria

- Real staged content remains unchanged after prepare and commit.
- Unrelated unstaged/untracked changes remain untouched.
- Exact file commit contains only selected file diff.
- Mixed files require split/explicit choice.
- Interrupted commit is not duplicated.
- Empty commit is refused unless explicit.
- Author/committer/co-author values match policy.
- Hidden opt-out uses normal Git identities and no Moriarty trailer.
- No credentials are present in commit metadata or evidence.

### Named tests

Positive:

- `git commit stages exact agent file in alternate index`
- `git commit preserves existing staged changes`
- `git commit attributes Moriarty clean work`
- `git commit adds human co-author once`
- `git commit preserves human author for existing work`
- `git commit opt-out uses normal identities`
- `git commit interrupted response inspects before retry`
- `git commit duplicate invocation returns existing commit`

Negative:

- `git commit refuses git add -A equivalent`
- `git commit refuses mixed ownership`
- `git commit refuses stale HEAD`
- `git commit refuses changed selected file`
- `git commit refuses changed real index`
- `git commit refuses missing Moriarty email`
- `git commit refuses empty commit`
- `git commit refuses no-commit task restriction`
- `git commit does not mutate unrelated working tree`

### Verification commands

```bash
npm run build-tests
node --test out/test/standalone/git-attribution.standalone.js
node --test out/test/standalone/git-index-staging.standalone.js
node --test out/test/standalone/git-transaction.standalone.js
npm run lint
```

### No-go conditions

- No implementation if real index is touched.
- No implementation if commit can include unrelated hunks.
- No implementation if commit uses shell-joined command text.
- No implementation if attribution depends on model name.
- No implementation if interrupted commit creates a second commit.
- No implementation if tagging opt-out is exposed as a setting.

### Completion report requirements

Report commit SHAs from scratch tests, real-index before/after hashes and no credential-bearing
payloads. Include tag-enabled/tag-disabled examples.

### Handoff prompt

```text
Fresh-agent handoff: Stage 4 of Moriarty Git integration.

Read docs/Moriarty_Git_Integration_Implementation_Plan.md and
docs/Moriarty_Git_Integration_Design.md.
Implement only Stage 4: isolated alternate-index staging and commit.

Reuse src/extension/chat/command-snapshot.ts snapshot/index patterns and
src/extension/tools/operation-authorization.ts.
Never call git add -A. Never touch the real index for staging.
Implement `git(operation:"prepare_commit")`,
`git(operation:"commit")` and `git(operation:"recover")` behind the existing
`git(view)` tool and shared GitExecutionService.
Add the three named standalone test files and run:
npm run build-tests
node --test out/test/standalone/git-attribution.standalone.js
node --test out/test/standalone/git-index-staging.standalone.js
node --test out/test/standalone/git-transaction.standalone.js
npm run lint

Stop if schema, evidence or authorization contracts are unstable.
Do not push, amend, rebase or change branches.
Update Progress Log only after acceptance gates pass.
```

## 7. Stage 5 - Push and ambiguous operation recovery

### Purpose and prerequisites

Purpose: implement safe destination push, separate push authorization and ambiguous outcome
inspection.

Prerequisites:

- Stage 4 commit operations pass;
- local bare repositories available for tests;
- auth modes from Stage 1 pass.

### Exact expected files/components

- `src/extension/git/auth.ts`;
- `src/extension/git/transaction.ts`;
- `src/extension/git/service.ts`;
- `src/extension/tools/more.ts`;
- `src/test/standalone/git-push-recovery.standalone.ts`.

### Contracts introduced

- `git(operation:"push")`;
- push state machine;
- remote ref expected/actual snapshot;
- separate push authorization.

### Implementation tasks

1. Resolve remote and branch from effective destination config.
2. Sanitize remote identity and URLs.
3. Inspect remote state before push where available.
4. Push exact local commit/branch with no force options.
5. Set upstream only as explicitly configured.
6. Record expected and actual remote refs.
7. On timeout call `ls-remote`/remote-tracking inspection before retry.
8. Reuse existing commit; never create a commit on push failure.
9. Report non-fast-forward as rejection.

### Acceptance criteria

- Plain push is non-force.
- Push never rewrites remote history.
- Push can be authorized independently of commit.
- Ambiguous push is reconciled from local/remote state.
- Duplicate push invocation is idempotent.
- Non-fast-forward never triggers rebase/reset/amend/force.
- No credential or secret URL enters logs/evidence.

### Named tests

Positive:

- `git push publishes exact commit to local bare remote`
- `git push sets authorized upstream`
- `git push duplicate invocation is idempotent`
- `git push timeout reconciles remote success`

Negative:

- `git push rejects non-fast-forward`
- `git push rejects remote branch change`
- `git push never force pushes`
- `git push denied by no-push task restriction`
- `git push failure does not create commit`
- `git push no credentials in result`

### Verification commands

```bash
npm run build-tests
node --test out/test/standalone/git-push-recovery.standalone.js
npm run lint
```

### No-go conditions

- No implementation if push uses force.
- No implementation if remote state is inferred only from exit status.
- No implementation if push retries create/rewrites commit.
- No implementation if credential values are captured.

### Completion report requirements

Include local bare remote test commands/results and redacted remote identities.

### Handoff prompt

```text
Fresh-agent handoff: Stage 5 of Moriarty Git integration.

Read docs/Moriarty_Git_Integration_Implementation_Plan.md and
docs/Moriarty_Git_Integration_Design.md.
Implement only Stage 5: `git(operation:"push")` and push recovery behind
the existing `git(view)` tool.

Reuse exact commit operations from Stage 4.
Never force push or rewrite history.
On timeout inspect local and remote state before retry.
No credential values in outputs/evidence.
Add src/test/standalone/git-push-recovery.standalone.ts.

Run:
npm run build-tests
node --test out/test/standalone/git-push-recovery.standalone.js
npm run lint

Do not implement rebase/reset/amend or branch administration.
Do not commit or change branches in the source repository.
Update Progress Log only after acceptance gates pass.
```

## 8. Stage 6 - Database, evidence and source-validity integration

### Purpose and prerequisites

Purpose: make Git operations durable, retrievable and safe for context pruning/model changes.

Prerequisites:

- Stages 1-5 pass;
- context/evidence contracts stable;
- database migration backup policy reviewed;
- no developer database used by tests.

### Exact expected files/components

- `src/extension/todos/sqlite.ts`;
- `src/extension/todos/repository.ts`;
- `src/extension/todos/types.ts`;
- `src/extension/git/baseline.ts`;
- `src/extension/git/transaction.ts`;
- `src/extension/chat/tool-evidence.ts`;
- `src/extension/todos/dependency-index.ts` - no contract change;
- `src/test/standalone/git-transaction.standalone.ts`;
- `src/test/standalone/evidence-...` existing files may be extended.

### Database migration

The implementation uses current schema v21 and proposes additive v22 migration:

```sql
CREATE TABLE git_sessions (...);
CREATE TABLE git_operations (...);
CREATE TABLE git_change_ownership (...);
```

Required migration behavior:

- database version only changes after successful transaction;
- backup created before migration;
- integrity verification before and after;
- no reset or table replacement;
- no credentials or raw patches;
- existing v21 tables remain unchanged.

If context/evidence branch publishes a generic transaction table, replace this proposal with that
contract before implementation. Do not maintain duplicate transaction ledgers.

### Implementation tasks

1. Add schema v22 migration and scratch tests.
2. Persist baseline/session.
3. Persist commit/push operations and ownership records.
4. Record no-commit/no-push restrictions in compact JSON.
5. Extend tool-result evidence with commit/push operation IDs.
6. Store model/provider/execution in operation metadata only.
7. Store source refs and digests for committed source versions.
8. Report no source-validity mutation for normal commit/push.
9. Add Git operation lookup/reconciliation repository methods.

### Acceptance criteria

- Existing v21 DB is preserved and opened.
- v21→v22 migration is additive and backed up.
- Migration fails without destructive reset if backup/integrity fails.
- Scratch DBs only in tests.
- Git operations remain durable after context pruning.
- Context/model changes do not alter commit attribution provenance.
- Normal commit/push does not invalidate source observations.
- Multiple sessions can retrieve project operations.

### Named tests

Positive:

- `git database migration preserves v21 tables`
- `git database migration records sessions operations ownership`
- `git evidence records commit SHA and source digests`
- `git source validity stays current after commit`
- `git source validity stays current after push`
- `git provenance survives context compaction`

Negative:

- `git database migration refuses incompatible corrupt database`
- `git database migration does not reset developer database`
- `git evidence omits credentials`
- `git operation evidence omits raw patch`
- `git commit/push does not falsely invalidate content`

### Verification commands

```bash
npm run build-tests
npm run test:sqlite
node --test out/test/standalone/git-transaction.standalone.js
npm run lint
```

Also run the existing evidence/source-validity suites:

```bash
node --test out/test/standalone/evidence-storage.standalone.js
node --test out/test/standalone/evidence-validity.standalone.js
```

### No-go conditions

- No implementation if migration can reset existing DB.
- No implementation if Git metadata duplicates the evidence system.
- No implementation if credentials or raw patches enter metadata.
- No implementation if commit/push falsely marks source content stale.
- No implementation if database transactions span network operations.

### Completion report requirements

Include schema v21/v22 status, backup behavior, migration test counts and database file paths used
only in scratch directories.

### Handoff prompt

```text
Fresh-agent handoff: Stage 6 of Moriarty Git integration.

Read docs/Moriarty_Git_Integration_Implementation_Plan.md and
docs/Moriarty_Git_Integration_Design.md.
Implement only Stage 6: Git database/evidence/source-validity integration.

No developer database reset or destructive migration.
Preserve v21 and add only safe additive v22 tables/backups.
Do not span SQLite transactions across network operations.
Reuse todo_tool_observations/evidence/source-validity contracts.

Run:
npm run build-tests
npm run test:sqlite
node --test out/test/standalone/git-transaction.standalone.js
node --test out/test/standalone/evidence-storage.standalone.js
node --test out/test/standalone/evidence-validity.standalone.js
npm run lint

Stop if context/evidence contracts are not stable or a migration could be destructive.
Do not commit, push or change branches.
Update Progress Log only after acceptance gates pass.
```

## 9. Stage 7 - Authorization, workflow and UI integration

### Purpose and prerequisites

Purpose: connect workflow presets, explicit no-commit/no-push restrictions and minimal UI status
through the native Git interface.

Prerequisites:

- Stages 1-6 pass;
- real tool dispatch and access approval stable.

### Exact expected files/components

- `src/extension/tools/operation-authorization.ts`;
- `src/extension/tools/access-preflight.ts`;
- `src/extension/tools/workspace.ts`;
- `src/extension/chat/access-approval.ts`;
- `src/extension/chat/index.ts`;
- `src/extension/agents/tool-selection.ts`;
- `src/webview/settings.tsx` - read-only status only if existing settings architecture supports it;
- `package.json` - minimal workflow/destination user preferences;
- `src/test/standalone/git-tool-dispatch.standalone.ts`;
- `src/test/standalone/destructive-approvals.standalone.ts`;
- `src/test/standalone/tool-safety.standalone.ts`.

### Contracts introduced

- commit capability separate from push capability;
- explicit task restriction policy;
- host-derived Git operation authorization;
- future `run_command` integration contract only.

The future contract is an interface, not an implementation in this stage:

```ts
interface GitCapabilityRequest {
  operation: "status" | "commit" | "push" | "prepare_commit";
  repository: string;
  destination?: { remote: string; branch: string };
  force: false;
  taskId?: string;
  conversationId?: string;
}

interface GitCapabilityDecision {
  allowed: boolean;
  authorizationId?: string;
  denial?: "no_commit" | "no_push" | "approval_required" | "destructive_operation";
}

interface GitExecutionBoundary {
  authorize(request: GitCapabilityRequest): Promise<GitCapabilityDecision>;
  execute(request: GitCapabilityRequest, authorizationId: string): Promise<unknown>;
}
```

This boundary belongs to the future managed `run_command` redesign and must reuse the native
`GitExecutionService`, existing operation authorization and project policy. This stage adds no
shell classifier and no `run_command` permission implementation.

### Implementation tasks

1. Extend `OperationAuthorization` for exact commit/push requests.
2. Preflight commit approval separately from push approval.
3. Derive explicit no-commit/no-push/no-force policy from trusted host instructions.
4. Keep task restrictions higher precedence than project/workflow.
5. Keep only the existing public `git` tool in the tool inventory.
6. Allow agent profiles to select or adapt the existing `git` tool; do not add
   separate operation names to `NATIVE_GROUPS`.
7. Refuse force/rebase/reset/amend/destructive branch operations explicitly in native Git.
8. Add minimal active-workflow/destination UI diagnostics.
9. Never show secrets or tagging opt-out.
10. Define but do not implement the reusable future `run_command` Git authorization interface.

### Acceptance criteria

- Commit authorization does not imply push.
- Push authorization does not imply force.
- No-commit and no-push win over all presets.
- Plain commit behavior follows project setting.
- Existing `run_command` test/build behavior remains unchanged.
- Agent profile tool selection can expose Git tools.
- GUI never exposes tagging opt-out or credential values.
- Native Git policies apply only through native Git operations; the temporary shell bypass is
  documented and no global claim is made.

### Named tests

Positive:

- `manual approval asks separately`
- `local commits permits commit not push`
- `commit and push handles explicit publish`
- `autonomous permits authorized destinations`
- `ui reports active workflow and destination`
- `run_command read-only git remains allowed`

Negative:

- `no-commit wins over autonomous`
- `no-push wins over commit-and-push`
- `force push denied`
- `amend denied`
- `rebase denied`
- `reset denied`
- `tagging opt-out not exposed in UI`
- no shell interception or Git subcommand classification is attempted

### Verification commands

```bash
npm run build-tests
node --test out/test/standalone/git-tool-dispatch.standalone.js
node --test out/test/standalone/destructive-approvals.standalone.js
node --test out/test/standalone/tool-safety.standalone.js
npm run lint
npm run build
```

### No-go conditions

- No implementation if explicit task restrictions are not host-derived.
- No implementation if commit and push share one authorization.
- No implementation if shell interception or `run_command` authorization is added under this scope.
- No implementation if tagging opt-out appears in UI/settings.
- No implementation if secrets are shown.

### Completion report requirements

Report workflow matrix, approval traces (redacted), run-command refusal behavior and UI files
changed.

### Handoff prompt

```text
Fresh-agent handoff: Stage 7 of Moriarty Git integration.

Read docs/Moriarty_Git_Integration_Implementation_Plan.md and
docs/Moriarty_Git_Integration_Design.md.
Implement only Stage 7: native Git workflow, authorization and UI integration.

Extend existing operation authorization/preflight.
Keep commit and push separate.
Host-derived explicit no-commit/no-push restrictions override all presets.
Do not intercept Git commands or change run_command. Leave tests/builds working.
Define only the reusable future run_command Git authorization contract.
Document the accepted temporary shell bypass.
Do not expose tagging opt-out or credentials in UI.

Run:
npm run build-tests
node --test out/test/standalone/git-tool-dispatch.standalone.js
node --test out/test/standalone/destructive-approvals.standalone.js
node --test out/test/standalone/tool-safety.standalone.js
npm run lint
npm run build

Stop if a competing approval mechanism or destructive operation is needed.
Do not commit, push or change branches.
Update Progress Log only after acceptance gates pass.
```

## 10. Stage 8 - Adversarial tests, integration tests and final verification

### Purpose and prerequisites

Purpose: verify real dispatch, repository state, authorization, evidence and concurrency end to end.

Prerequisites:

- Stages 1-7 pass;
- isolated scratch repositories are available.

### Exact expected files/components

- all Git standalone test files;
- `src/test/suite/git.test.ts` - extend or replace existing basic Git tests;
- `src/test/suite/agent-reply.test.ts` - real agent Git dispatch integration;
- `src/test/standalone/evidence-validity.standalone.ts`;
- no live GitHub/GitLab tests.

### Named positive tests

- existing `git` legacy argument parsing passes unchanged;
- existing read-only real-repository Git reads pass unchanged;
- existing hidden/ignored path filtering passes unchanged;
- clean baseline commit/push end-to-end;
- dirty baseline split commits;
- hunk-level mixed file handling;
- existing staged content preservation;
- untracked agent file inclusion;
- tagging enabled human co-author;
- tagging disabled normal identity;
- inherited/dedicated/environment auth;
- context compaction continuation;
- model change continuation;
- multiple chat sessions;
- local bare remote branch changes;
- push timeout reconciliation;
- interrupted commit reconciliation.

### Named negative tests

- no blind `git add -A`;
- no credentials in logs;
- no false Moriarty attribution;
- no commit/push from denied workflow;
- no commit after no-commit instruction;
- no push after no-push instruction;
- no force/amend/rebase/reset;
- no commit of unrelated staged/unstaged/untracked changes;
- no duplicate commit on interrupted response;
- no duplicate commit on duplicate invocation;
- no second commit after push failure;
- no source invalidation after commit/push;
- no database reset.

### Verification commands

```bash
npm run clean
npm run build-tests
npm run build
npm run lint
npm run test:sqlite
npm test
```

Run at least these standalone suites:

```bash
node --test out/test/standalone/git-config.standalone.js
node --test out/test/standalone/git-baseline.standalone.js
node --test out/test/standalone/git-attribution.standalone.js
node --test out/test/standalone/git-index-staging.standalone.js
node --test out/test/standalone/git-transaction.standalone.js
node --test out/test/standalone/git-push-recovery.standalone.js
node --test out/test/standalone/git-tool-dispatch.standalone.js
```

### No-go conditions

- No stage is complete if any full suite mutates the developer database or repository.
- No stage is complete if live hosting credentials are required.
- No stage is complete if one test creates a secret in evidence/log.
- No stage is complete if native commit/push operations bypass native tool authorization.
- No stage is complete if the implementation claims shell/`run_command` restrictions are globally
  enforced; the documented temporary bypass must remain explicit.
- No stage is complete if unrelated user changes are staged.

### Completion report requirements

Provide:

- final branch/HEAD;
- exact files changed;
- migration status;
- test counts/pass rates;
- scratch repository cleanup confirmation;
- developer database unchanged/backup status;
- no secrets observed;
- unresolved risks;
- implementation handoff and review status.

### Handoff prompt

```text
Fresh-agent handoff: Stage 8 of Moriarty Git integration.

Read docs/Moriarty_Git_Integration_Implementation_Plan.md and
docs/Moriarty_Git_Integration_Design.md.
Implement only Stage 8: adversarial and integration verification.

Use temporary repositories and local bare remotes only.
Do not use live GitHub/GitLab credentials.
Do not reset or migrate the developer database.
Do not commit, push or change branches.

Run:
npm run clean
npm run build-tests
npm run build
npm run lint
npm run test:sqlite
npm test

Also run every git-*.standalone suite produced by Stages 1-7.
Report exact pass/fail counts and no-go conditions.
Update Progress Log only after the gates pass.
```
