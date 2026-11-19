`# Moriarty: Unified Project Database, Synchronous Index and Evidence — Implementation Plan

**Audience:** Claude Haiku (or any implementer) working in fresh conversations, one stage at a time.
**Repository:** `/home/stark/source/twinny` · **Base commit:** `0ca082a` on `feature/todo` · **Work branch:** `feature/unified-project-db` (created in Stage 0).
**Status of this document:** written from a verified investigation of the base commit. Every file path, symbol and baseline number below was checked against that commit. Line numbers drift as stages land: **locate code by symbol name with `grep -n`, treat line numbers as hints.**

> Nothing in this plan has been implemented. Do not skip stages, reorder them, or merge them unless a stage says so.

---

## Progress Log (update this table at the end of every stage — it is the only cross-conversation memory)

| Stage | Title | Status | Date | Verification (command → actual counts) | Notes / deviations |
|---|---|---|---|---|---|
| 0 | Baseline, branch, progress log | done | 2026-11-16 | clean exit 0; build-tests exit 0; build exit 0; eslint --quiet 0 findings; tsc type check exit 0 (0 findings); git diff --check no output; test:sqlite 966 tests / 966 pass / 0 fail / 0 skipped (4761 ms). VS Code suite NOT RUN to completion: the full gate run was cut by the 120 s tool window (timeout exit 124, no Mocha summary printed); per-suite runs of the four configured files each exit 0 - Agent reply, end to end 16 passing (10 s); Read-file acceptance, production controller 51 passing (60 s, includes nested edit operation recovery 17); custom agent registry 2 passing (1 s); Hash-verified native line edits 32 passing (15 s); Persistent workspace intelligence index 1 passing (12 s) = 102 passing, 0 failing, 0 pending | Branch feature/unified-project-db, HEAD 9205cc4 (not base 0ca082a); only this plan file differs from base, so Appendix B was spot-checked, not re-verified: fingerprintContent 23, CURRENT_SCHEMA_VERSION 214, resolveProjectTodoStorage 562, prepareProjectTodoStorage 591, ensureProjectGitignore 601, retireLegacyTodoDatabase 660, WorkspaceIntelligenceIndex 245 - all as recorded. Suites that did not run: Chat edit_file and the prompt-compiler suite (.vscode-test.js lists only agent-reply, agents, line-edit, workspace-index). No source changed, nothing committed. |
| 1 | Static outside-workspace path authorization | done | 2026-11-16 | `npx tsc -p . --noEmit` exit 0 (0 findings); `npx eslint --quiet src` 0 findings; `npm run build-tests` exit 0; `npm run build` exit 0 (both also run in the `npm test` pretest, exit 0); `git diff --check` no output; `npm run test:sqlite` 970 tests / 970 pass / 0 fail / 0 skipped (4951 ms) = base 966 + 4 new tests. Focused `npx vscode-test --grep "Persistent workspace intelligence index"`: 2 passing, 0 failing (15 s). VS Code suite `xvfb-run -a npm test`: **103 passing, 0 failing** (2 m), exit 0 (previously 102 passing + 1 failing shared-setup hook; see Notes). | New `src/extension/tools/authorized-paths.ts` (pure `normalizeAuthorizedRoots`, `authorizedRootOf`); `view.ts` fifth constructor argument `authorizedRoots`, `AuthorizedRoot` + `realPathOf`, `inside(real, root)`, `externalRoot`, `isExternal`, `externalDenied`, `ignoredAt`, external branches in `resolve`/`resolveNew`/`visible`/`relative`/`realRelative`/`entries` (`walk()`, `files()`, `allFiles()`, `allDirs()` untouched); `Chat.workspaceView()` passes the other `file` folders plus the setting; `outsideWorkspace` in `edit/service.ts` returns false for a granted folder; `package.json` `twinny.chatToolsAllowedPaths` (machine scope, order 20, next to `chatToolsEdits`); `create_file` path description. Tests: `authorized-paths.standalone.ts` 2 tests, `tool-safety.standalone.ts` +1, `chat-tools.standalone.ts` +1, and the suite test named as the plan says; the existing refusal tests are unmodified and pass. Deviations: the `markdownDescription` wording is paraphrased (order/type/items/default/scope as specified); `~` is expanded with `path.join` because the plan's `path.resolve(home, "/notes")` gives `/notes`; `inside()` took an optional `root` argument defaulting to `_realRoot`; the setting is read with `getConfiguration("twinny")` and no folder argument, so a machine-scoped setting resolves from the user/machine value only. Blocker resolved: the failing item was the shared `setup` hook in `workspace-index.test.ts`, not Stage 1 code, and the trash-move failure was not its trigger (an earlier guess, now disproved). VS Code 1.146.0's extension-host `updateWorkspaceFolders` returns `false` while a previous change is unconfirmed (`_unconfirmedWorkspace` clears only on the main thread's `$acceptWorkspaceData`); the suite's teardown update was still unconfirmed when the next setup ran. Control: a 1 s wait after teardown made both tests pass. Fix (test infrastructure only, `src/test/suite/workspace-index.test.ts`): an `updateWorkspaceFolders` helper awaits `onDidChangeWorkspaceFolders` after each successful change, used in setup and teardown, with 30 s hook timeouts. No production code, assertion or skip changed. Observed, not changed: the test host's persisted empty-window workspace (`.vscode-test/user-data/Workspaces/*/workspace.json`) can restore deleted temp folders, so VS Code logs `Ignoring the error while validating workspace folder` warnings; these predate the fix and do not fail tests. |
| 1a | Interactive outside-workspace native file approval | done | 2026-11-17 | Closing run, all exit 0 unless noted: `npx tsc -p . --noEmit` 0 findings; `npx eslint src --quiet` 0 findings; `npm run build-tests` exit 0; `npm run build` exit 0; `node --test out/test/standalone/access-*.standalone.js out/test/standalone/operation-authorization.standalone.js` 64 pass / 0 fail / 0 skipped; `npm run test:sqlite` 1034 pass / 0 fail / 0 skipped; `git --no-pager diff --check` no output; `node ./out/test/runTest.js` (full VS Code suite, 2 m): **129 passing, 0 failing**. Earlier, the same configuration ran 127 passing before the deletion and rename suites were added. `npx tsc -p . --noEmit` 0 findings; `npx eslint --fix` on changed files, then `npx eslint src --quiet` 0 findings; `npm run build-tests` exit 0; `npm run build` exit 0; `node --test out/test/standalone/access-*.standalone.js out/test/standalone/operation-authorization.standalone.js` 64 pass / 0 fail; `npm run test:sqlite` 1034 pass / 0 fail / 0 skipped; `git --no-pager diff --check` no output; `node ./out/test/runTest.js` (full VS Code suite, 2 m): **127 passing, 0 failing** (includes the re-enabled approved-outside-write test, the new `deletion and move through the editor` suite, and the new checkpoint-order regression test). An earlier run of this change failed `workspace-index` "a file outside the workspace folders is refused until its folder is allowed" because the sink peek read a stale allowlist; fixed by `preauthorizedNow` (live `chatToolsAllowedPaths`, as the service reads it). Verified by the VS Code suite: approved outside edit, line edit, create and move reach the real sinks; each approval applies once; read-only grant does not allow write; denial or unexpected answer refuses with no mutation; multi-path move with one denied path refused whole; an unapproved outside edit, line edit or create is refused before its file is read or copied for a checkpoint; protected `.git` and symlink-escape refusals; approved external read not added to the index; `/tmp` read returns the whole-file hash and resumes the same call. Standalone: `operation-authorization` covers peek-without-spend, claim-once, multi-path all-or-nothing, forgery, host and path mismatch. Approved outside DELETE is verified on disk: the `deletion and move through the editor` suite sets `files.enableTrash=false` in the test host only (the `/tmp` tmpfs refuses the OS trash). Production deletion behavior is unchanged. The approved delete removes the file once (one editor hand-off, file gone from disk); the unapproved and denied cases leave it in place. Rename: the `rename through the editor` suite registers a real rename provider. A denied outside rename returns `failed` with no file changed. An approved rename renames each affected file once. Limitation (pre-existing, not changed here): the rename sink needs the target document open in the extension host, and `executeDocumentRenameProvider` throws `Unexpected type` otherwise. The suite opens the target first. | Branch feature/unified-project-db, HEAD 85b0fa1 (base 0ca082a per plan; Stage 0 recorded 9205cc4). New: `src/extension/tools/access-grants.ts`, `access-preflight.ts`, `access-host.ts`, `operation-authorization.ts`, `src/extension/chat/access-approval.ts`, `src/test/standalone/access-*.standalone.ts`, `operation-authorization.standalone.ts`, `src/test/suite/file-access.test.ts`. Changed: `tools/view.ts`, `tools/workspace.ts`, `tools/more.ts`, `chat/tool-sinks.ts`, `edit/service.ts` (`preauthorizedNow`, `approvedOutsideWrite`, claim in `chatEdit`/`chatCreate`), `chat/index.ts`, `src/index.ts`, `package.json`, `commands.ts`, `.vscode-test.js`. `run_command` unchanged. Design: runtime write grants are operation-scoped. The preflight mints an `OperationAuthorization` token covering only the pending call's outside, non-preauthorized write targets (operation, absolute path, canonical real path, host key). The dispatcher passes it through `ToolContext.write` to the sinks and the `twinny.chatFileEdit`/`chatFileCreate` commands as an internal argument. Sinks peek (non-spending) before any read or copy, and the claim spends it at the mutation point. Public command calls without a token keep the existing refusal. Session grants do not reach public commands. Deviations: approval UI is a QuickPick with seven choices, not the `tool-steps` Run/Skip/Always prompt; the service claims the token before its later running/pending-review checks, so a later refusal still spends it (fail-closed); `rename_symbol` checks each affected file via the preflight with no token, so its real language-server behavior is unverified. **Closed (maintainer decisions):** (a) The symlink race between the sink's peek and `openTextDocument` is documented as future hardening, not a Stage 1a blocker. Existing canonical-path and symlink-escape checks remain mandatory. A symlink retargeted in that window can have its content read before the service refuses it. No mutation results (fail-closed). Revalidating at read time is a future hardening item. (b) Host isolation: automated tests use distinct host identities (`accessHostKey` in standalone `access-grants.standalone.ts`, and the VS Code always-grant test on separate hosts). **Manual, not a blocker:** connect two different Remote-SSH servers, grant on one, and confirm the other prompts again. (c) Language-server rename: the automated tests exercise the real authorization and mutation paths, including denial before mutation. **Manual, not a blocker:** a rename through a real language server across an outside file. (d) Trash: see the deletion note above; a real OS-trash host is a manual check only if a trash-based delete is later required. |
| 2 | Remove evidence handoff and owner gating (revised above) | done (gate not fully passing - see the closing run) | 2026-11-18 | `npx tsc -p . --noEmit` exit 0 (0 findings); `npx eslint src --quiet` 0 findings; `npm run build-tests` exit 0; `npm run build` exit 0; `git --no-pager diff --check` no output; `npm run test:sqlite` 1035 tests / 1035 pass / 0 fail / 0 skipped (4852 ms). Focused files: `todo-feedback.standalone.js` 276 / 276 / 0 / 0; `operation-authorization.standalone.js` 8 / 8 / 0 / 0. **Closing full VS Code suite** (`xvfb-run -a npm test` in a detached shell with a 420 s timeout, one clean run, no concurrent runners): **124 passing, 5 failing, 129 tests, exit 1** - the two Stage 1a authorization tests pass, `Persistent workspace intelligence index` passes (11.5 s); the 5 failures are all in `Hash-verified native line edits` (undo assertions) and reproduce in that suite alone and at unmodified HEAD, so they are not Stage 2 regressions. Earlier, the same gate run was cut by the 120 s tool window (timeout exit 124, no Mocha summary); per-suite runs then: Agent reply end to end 16 passing (10 s); Read-file acceptance, production controller 51 passing, 0 failing (1 m, exit 0); custom agent registry 2 passing (1 s); Hash-verified native line edits 32 passing (14 s); Persistent workspace intelligence index 2 passing (16 s); Native file access outside the workspace 24 passing + 2 failing (10 s, exit 1) = 127 passing, 2 failing, 129 tests in total. | Removed with no replacement rule: `evidence_from` from `twinny_todo_update`'s parameters and schema, its parsing, `claimCompletion`'s `evidenceFrom` input, its validation, the `evidence_linked` event, `TodoReviewPackage.evidenceSources`, `declaredEvidenceSourcesOf` and `prerequisiteIdsOf` (no transitive prerequisite inheritance). A stray legacy argument is ignored - `run` never reads it - so a valid completion claim is not rejected. `criterionOwners` deleted; `typedOutcome` decides from the plan's records with no owner filter. Relevance is the criterion's typed contract: the operation a `workspace_mutation` names, the exact command digest a `command_exit_status` names, the file a source predicate matches against (`samePath` in `authenticateSource`, so no extra filter was needed and a helper added mid-stage was removed as dead code). Sufficiency is unchanged: a successful persisted mutation, the exact exit code, a fingerprint that still matches the current document. `commandOutcome`'s `taskRecords`/`planRecords` params collapsed into one record set; `taskHasVerifiedMutation` answers through `mutationOutcome`. `getReviewPackages` needed no change - `retainedEvidenceFor(..., sharedListId)` already returns the plan's records, and each record keeps the task it was recorded under (`observed_item_id`). No second evidence cache; `todos/evidence.ts` has no diff. Tests (only the three Stage 2 names): the sibling test -> a relevant record serves any task, a wrong-operation record does not, a failed record does not even when recorded under a prerequisite (the plan edge gates release only), a record naming another file answers nothing (checked through the production reconciler), records keep their recorded task; the Locate/Replace/Verify test -> no dependency edges, the tool advertises no `evidence_from` (parameters and schema), each claim accepted, Replace and Verify proven from records recorded under Locate, an unrelated run is not evidence, all three complete; the declared-handoff test -> a stray legacy `evidence_from` is accepted, no `evidence_linked` row exists, the three `completion_claimed` rows are still recorded. No other test was touched. **Proven defect fixed here (Stage 1a path, not Stage 2 code):** the two authorization tests failed because the approval and the claim ran in two copies of `operation-authorization` - `package.json` `main` is `./out/index.js`, so the shipped bundle holds its own inlined copy of the module while the extension host also loads `out/extension/tools/operation-authorization.js` as its own module. An instrumented baseline run printed the failing condition: `ISSUE ... inst=1`, then `CLAIM inst=2 ok=false not this instance's class` - operation, host, path, canonical real path, request count and open state all matched, only the issuer identity failed. Fix: the set of what was issued is held once for the process (`globalThis.twinnyIssuedWrites`), so `coversWrites`/`claimWrites` accept any authorization issued in this process while a hand-built object or one from another process is still refused. Regression test `src/test/standalone/operation-authorization.standalone.ts` (the new test asserts two module instances are distinct and each accepts what the other issued); it fails without the fix, shown on unmodified HEAD: cross-instance claim false at HEAD, true with the fix. Verified on the real path: the full suite run now passes both tests. Baseline method: `git archive HEAD` (58072e0) extracted to a scratch directory, no change to the working tree. **Unresolved gate failures, recorded not fixed:** (1) the 5 `Hash-verified native line edits` undo assertions - `one undo restores the entire batch`, `the unsaved edit is undoable` (x2), `one undo restores the buffer` (x2), at `line-edit.test.js` lines 91/149/218 - fail in the clean full run, in that suite alone, and at unmodified HEAD, so they are pre-existing/environment, not Stage 2; the suite's `EACCES ... EntryWriteLocked` save-error lines belong to the tests that deliberately make the file read-only (chmod 0444), so they are not the cause. (2) `Persistent workspace intelligence index` - `indexes multiple roots, labels skips, finds read_file, and keeps explicit path searches path-only` failed in two runs and passed in the closing run and in the suite alone: the rename hit is absent from `search` within the test's 10 s `waitUntil` (that wait has no assertion, so it caps out before the assertion at line 173). Its own initial measurements are identical in the alone and the paired runs (`filesDiscovered 652, filesIndexed 626, filesSkipped 19`), so the difference is the rename event not reaching the index; `line-edit.test.ts` replaces the workspace folders in setup/teardown and the index resolves a changed file's root through `vscode.workspace.getWorkspaceFolder`, so shared folder state and watcher rebuild (`resetFileWatchers`) are the candidates - not proven, and no test was weakened, skipped or reordered. Stage 2's own gates pass; the `npm test` gate as a whole does not until these two items are resolved. Unrelated working-tree change left untouched: `package.json` `chatTools` maximum 100 -> 1000. No commit; working tree on feature/unified-project-db, HEAD 58072e0; diagnostic scratch files removed.
| 3 | `SourceRoots` (resource identity + path normalization) | done | 2026-11-18 | `npx tsc -p . --noEmit` exit 0 (0 findings); `npx eslint src --quiet` 0 findings (import order fixed with `npx eslint <files> --fix`); `npm run build-tests` exit 0; `npm run build` exit 0; `git --no-pager diff --check` no output; `npm run test:sqlite` 1043 tests / 1043 pass / 0 fail / 0 skipped (4852 ms) = Stage 2's 1035 + the 8 new tests; the new file alone `node --test out/test/standalone/source-roots.standalone.js` 8 / 8 / 0 / 0. Stage 3 marks no [VS Code suite] work, but the gate was still run: the full `xvfb-run -a npm test` was cut by the 120 s tool window (no Mocha summary), so the suites were run one at a time (each exit 0 except line-edit, exit 1) - Agent reply end to end 16 passing (12 s), Read-file acceptance production controller 51 passing (2 m), custom agent registry 2 passing (2 s), Hash-verified native line edits 27 passing + 5 failing (17 s), Persistent workspace intelligence index 2 passing (16 s), Native file access outside the workspace 26 passing (11 s) = 124 passing, 5 failing, 129 tests. The 5 failures are the same undo assertions recorded as pre-existing in the Stage 2 row, reproduced in that suite alone with no Stage 3 code loaded by the extension host. | New `src/extension/todos/source-roots.ts` and `src/test/standalone/source-roots.standalone.ts`; no other source file changed, nothing committed, HEAD 72a2451 on feature/unified-project-db. `SOURCE_ROOT_SCHEMA` is Appendix A's DDL verbatim, without `IF NOT EXISTS`, so it is executed once per database; `host` is always `""`; every method is synchronous and no row is cached in memory. Deviations: `fromCanonical` resolves a relative canonical with `path.posix.join(home, value)` rather than `path.posix.resolve`, because POSIX `resolve` prepends the process cwd to a drive-letter home (`C:/p`) and breaks the round-trip, while `join` still resolves `..` escapes inside an absolute home; `canonicalPath` decides on the absolute path through `home()`, the documented create-or-rebind accessor, so its first call can create the home row; the external row is created lazily through a `(host, locator)` lookup with the filesystem root taken from the path (`/`, or `C:/` for a drive path) so a drive path round-trips, which is one row per host in practice; the home label is `basename(homeLocator)` at creation and a rebind changes only `locator` and `last_bound_at`; `register` also requires an absolute locator (the plan does not state this, kept consistent with `locate`). In the round-trip test the expectation is the canonical string, not the root: `fromCanonical("packages/lib.ts")` answers with the nested workspace root because `locate` takes the longest match. In-memory database only, no test database written into the repository tree, scratch logs removed. |
| 4 | Unified project DB, stable multi-root home (revised above) | done | 2026-11-18 | `npx tsc -p . --noEmit` exit 0 (0 findings); `npx eslint src --quiet` exit 0 (0 findings); `npm run build-tests` exit 0; `npm run build` exit 0; `git --no-pager diff --check` no output; `npm run test:sqlite` 1048 tests / 1048 pass / 0 fail / 0 skipped (4916 ms). Focused Stage 4 tests: 13 / 13 pass / 0 fail, including v20 schema/objects, read_file tool-observation INSERT, multi-root/root ordering, override/saved-workspace resolution, older/newer refusal, relocation, isolation, reset, symlink, and evidence/retained-output/source/accepted-fact deletion survival. VS Code gate (`npm test`) pretest clean/build/lint stages all exit 0, then the integration host ran for 6:15 and was stopped without a completed exit or Mocha summary: log `/tmp/twinny-vscode-test.log`; the host had progressed through some suites and showed repeated AgentHost customization/marketplace environment warnings, but did not reach a final pass/fail count. Not counted as a suite pass. The previously observed 5 `Hash-verified native line edits` undo assertions remain separately recorded under Stage 2 and Stage 3; this run did not reach or assert those results, and no undo assertion was changed. | Confirmed SQL defect: `todo_tool_observations` had 14 placeholders for a 13-column INSERT and 13 bound values. Corrected `VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`; all 13 column names and bound values are ordered consistently, nullable `list_id`, `item_id`, `exit_code`, `execution_id` use null where absent, and the repository operation passes against a freshly created v20 database. Implemented source-reference persistence in `SourceRoots.recordObservationSources` and wired it from `TodoRepository.recordToolObservation`; source and hit rows survive TODO/list deletion because `observation_source` is owned only by the observation and observations are project-provenance rows with nullable list/item IDs. `SCHEMA` is v20 with `project.sqlite`, stable project-home resolver, local root registration, project/observation/source indexes, FTS5, integrity/foreign-key checks and older/newer refusal. Removed exactly the eight obsolete historical migration-ladder tests named in Appendix E and rewrote the old `evidence.sqlite` filename, v19, ambiguous multi-root and v20-future expectations. Existing recovery fixes in `chat/index.ts`, `safe-edit-recovery.ts`, `tool-sinks.ts`, and their tests are preserved unchanged by Stage 4. |
| 5 | Synchronous SQL facade for the index | done | 2026-11-18 | `npx tsc -p . --noEmit` exit 0 (0 findings); `npx eslint src --quiet` 0 findings; `npm run build-tests` exit 0; `npm run build` exit 0; `node --test out/test/standalone/index-sql.standalone.js` 6 / 6 pass / 0 fail / 0 skipped; `npm run test:sqlite` 1054 / 1054 pass / 0 fail / 0 skipped (4590 ms); `git diff --check` no output. VS Code suite NOT RUN: Stage 5 adds no VS Code-only code and does not consume the facade yet; no integration suite was launched. | New `src/extension/workspace-index/sql.ts` and `src/test/standalone/index-sql.standalone.ts` only for Stage 5. The facade imports `better-sqlite3` types only, is `vscode`-free, keeps synchronous plain-value `run/get/rows/exec` calls, caches prepared statements per database in a bounded WeakMap, uses `BEGIN IMMEDIATE` transactions with promise/thenable rejection and rollback, and pages `eachRow` queries in URI order with event-loop yields only when another page exists. `exec` executes compound SQL through `database.exec`. Existing untracked/uncommitted files outside Stage 5 were preserved; no commit, push, stash or reset. The native `better-sqlite3` module required an environment rebuild for the Node 24 runtime; no dependency manifest or lockfile changed. |
| 6 | Port the workspace index onto the project database | todo | | | |
| 7 | Index `refresh()` API and index fixes | todo | | | |
| 8 | Synchronous refresh: `edit_lines` and `edit_file` | todo | | | |
| 9 | Synchronous refresh: `create_file`, `delete_file`, `move_file` | todo | | | |
| 10 | Synchronous refresh: `rename_symbol` | todo | | | |
| 11 | Independent project observations, including no-TODO chats (revised above) | todo | | | |
| 12 | Centralized validity on all evidence paths (revised above) | todo | | | |
| 13 | Moves, renames and relocation candidates | todo | | | |
| 14 | `grep` under authorized external directories | todo | | | |
| 15 | Canonical multi-root search paths (required) | todo | | | |
| 16 | Cleanup: drop `sqlite3`, documentation, changelog | todo | | | |
| 17 | Final verification and manual Remote-SSH checklist | todo | | | |

Status values: `todo` · `in-progress` · `done` · `blocked`. A stage is `done` only when every acceptance criterion in its section is met **and** its verification numbers are recorded here.

---

## Maintainer-reviewed architecture corrections (2026-11-16)

**This section is authoritative over conflicting text elsewhere in this document, including old test descriptions and Appendix A's explanatory inventory. The revised Stage 2, 4, 11, 12 and 15 specifications below replace their original stage requirements. Do not implement the superseded rules.** Keep the existing code maps and tests not affected by these corrections.

### Binding decisions

1. **Evidence has no exclusive TODO, list or conversation owner.** A task/list ID is optional historical provenance, not an eligibility gate. `evidence_from` is removed and **must not be replaced with transitive prerequisite inheritance**. All tasks may use relevant project observations; deterministic verification must still match operation outcome, target, criterion, and current source validity. A relevant observation from a sibling or unrelated task is acceptable; an irrelevant observation from a prerequisite is not.
2. **Historical observations, retained tool outputs, source references and reusable accepted facts must survive deletion of TODOs, lists and conversations.** Database foreign keys and repository APIs must enforce this, not just a comment. TODO-specific assessment/association rows can be deleted without cascading into project evidence.
3. **Project identity is stable under reordering workspace folders.** Resolve the project home independently of array position: single root defaults to that root; saved multi-root defaults to the directory containing the `.code-workspace` file; explicit machine-scoped `twinny.projectHome` overrides; unsaved multi-root without an override uses the path-sorted first normalized root as a documented deterministic fallback (changing membership can still change this fallback). Register *every* workspace root in the database. Database location is not an access permission.
4. **One automatic evidence-integrity boundary:** the repository validates every file-backed observation/fact on both storage and retrieval, including retained outputs, project lookup, preflight, review and multi-source records. Per-source and aggregate flags must be returned; no optional consumer-side validator determines correctness. Existing equal hash = `valid`, changed hash = `stale`, deleted source = `invalid`, restored matching content = `valid` again. I/O errors use existing error handling.
5. **Buffer versus disk is explicit:** file-read observations carry `observed_version: "buffer" | "disk"` and optionally the editor version. A buffer observation checks the current buffer while open and disk after close, while a persisted-file observation checks disk. The index describes disk. A buffer-only read never proves a persisted write.
6. **Multi-root search tool interoperability is mandatory**, not an optional polish stage. Any indexed hit in any root must provide a path that the native read/edit tools can resolve without guessing. Preserve existing permissions.
7. **Runtime approval for native outside-workspace file tools:** allow file/folder once, session or always, or deny. Grants are scoped by actual extension host and operation (read/write); user approval resumes the exact pending tool call once. Static allowlists remain optional preauthorization; approval never expands index scope.
8. **Everything else stays:** one project-local SQLite database; reuse existing fingerprints; opaque model-carried expected hashes; synchronous index refresh only for dedicated file mutations; `run_command` and other external modifications use existing asynchronous watchers; Remote-SSH extension host paths like `/etc` remain accessible when authorized; LanceDB stays separate. No general SSH provider framework, command-side-effect scan, evidence dependency graph or automatic relocation rewrite.

### Required schema corrections to Appendix A (Stage 4)

Apply these changes to the Appendix A DDL **before treating it as paste-ready**:

- `todo_tool_observations`: add `project_id TEXT NOT NULL REFERENCES todo_projects(id)`; make `list_id` and `item_id` nullable provenance values, **not** cascading `REFERENCES todo_lists` or `REFERENCES todo_items`. Preserve tool name, request, output, outcome and execution metadata; scope uniqueness by project and request/execution when list is absent.
- `todo_tool_evidence`: preserve `observation_id` FK to the project observation, but make `list_id` nullable provenance without list-delete cascade.
- `todo_accepted_evidence`: add `project_id TEXT NOT NULL REFERENCES todo_projects(id)`; originating `list_id` and `item_id` are nullable provenance, with no ownership cascade. Keep reusable facts, source hashes, and their observation links. A task-specific acceptance link may be represented separately but cannot own or delete the fact.
- `observation_source`: add `observed_version TEXT NOT NULL DEFAULT 'disk' CHECK(observed_version IN ('disk','buffer'))` and `editor_version INTEGER`, retaining each file's root, path, hash, role and range.
- Add project-query indexes to observations and accepted facts. **Regenerate** the schema object counts and exact-index tests from the corrected DDL. The old Appendix A count of 27 named indexes is no longer authoritative.
- Test deletion of a task, a list and a conversation, verifying that relevant observations, retained output, accepted facts and source records still exist and are independently searchable.

### Revised Stage 2: remove the evidence handoff without inventing ownership by ancestry

Remove `evidence_from` from `twinny_todo_update`, parsing, claims and events. Do **not** set `evidenceSources` to `prerequisiteIdsOf(...)` as a new proof rule. Refactor `getReviewPackages`, `criterionOwners`, and Feedback to find relevant candidate observations through project evidence and then verify actual success/target/criterion. Stage 2 may temporarily use existing repository queries; Stage 11 completes project-wide queries. A valid unrelated-task mutation can prove a matching criterion, but a failed mutation, wrong-target edit or model assertion cannot. Rewrite the old handoff/sibling tests to assert relevance and sufficiency rather than owner identity.

### Revised Stage 4: stable project home and independent project schema

Use the §2.1 project-home precedence above, not `workspaceFolders[0]`. Introduce a shared `resolveProjectHome` and reuse it at all repository and index construction sites. Register all workspace roots. Keep a stable project ID within the selected database. Replace the dev schema with the corrected Appendix A DDL. Explicitly test that reordering roots yields the identical database path, project ID, registered roots and search identity; verify evidence survives task/list deletion. Keep old databases untouched unless a separately controlled dev reset is requested. Do not accidentally broaden tool permissions with the project-home setting.

### Revised Stage 11: project-level observation recording, including no-TODO chats

Make observation recording independent of an active TODO or even the presence of a TODO plan. With an available project database, eligible native tool results are recorded as project observations with optional provenance. Capture each file reference (read, edit, create, delete, move, rename) with actual resource/path/hash and observed disk/buffer version; never make up a hash for arbitrary `run_command` results. Reuse the existing observation hook and persistence machinery, but remove list/task lifetime constraints. Queries find relevant observations across tasks/conversations, while Feedback still determines sufficiency. Add tests for no-plan recording, deletion survival, cross-conversation reuse, actual source references and repeated request idempotency.

### Revised Stage 12: validity belongs to the repository boundary

Centralize file-backed evidence validation on **every storage and retrieval path**. Use authoritative current source and original observed-version semantics; never use a possibly stale search-index hit as proof of current content. Return per-reference and aggregate validity with observations, retained evidence, accepted facts, lookup, preflight and Feedback packages. Validate every source for multi-file observations. Preserve old `freshness` fields when useful for compatibility, but do not make correctness depend on a caller supplying `readCurrentSource`. Confirm that deletion and rollback validity are observed on successive retrievals. File-free historical command results have no fabricated file validity.

### Revised Stage 15: mandatory multi-root search paths

Stage 15 is **not optional**. Use the stable project home/source-root identity to generate canonical search hit paths: relative inside home, absolute and unambiguous in other roots. Every returned path must round-trip to native `read_file` and permitted edits. Reversing the workspace folder order must not change project DB identity or projected paths. Update the Stage 15 handoff prompt, Progress Log and regression expectations accordingly.

### Runtime permission amendment (2026-11-16)

An agent can redirect large test results to `/tmp/test.log` but cannot inspect it through `read_file` when it lies outside the workspace. Stage 1's static allowed-paths setting is insufficient for this recovery flow. **Stage 1a is mandatory:** native tools prompt for file/folder approval at the point of access and resume the pending call with its normal hash-backed result. No arbitrary `/tmp` indexing, no shell workaround and no model-side permission tool. Do **not** implement item 1 (command timeout/output-size overrides) in this change.

### Handoff gate for Haiku

Before a stage is marked complete, reconcile its old source-line/test hints against these corrections, update the original Progress Log, and run the actual build/typecheck/lint and stage tests. **Do not silently implement an older contradictory stage instruction.** If an unexpectedly large refactor is needed, report the concrete conflict instead of reintroducing task-owned evidence or a first-root storage dependency.

---

## 0. How to use this plan

### 0.1 One stage per conversation

1. Read this section (§0), §1 (decisions), §2 (target architecture), the **Progress Log**, and **only** the section of the stage you are given, plus the appendices it cites.
2. Confirm every stage listed under that stage's **Depends on** is `done` in the Progress Log. If not, stop and report.
3. Do exactly that stage. Do not start the next one, even if it looks trivial.
4. Finish with the report format in §0.5 and update the Progress Log row.

### 0.2 Hard rules (from the project's Haiku conventions in `COPILOT_HAIKU_TASK.md`)

- **No commits, pushes, stashes, resets or `git add`.** Leave all changes in the working tree on `feature/unified-project-db`.
- **Inspect before editing.** Read the files named in the stage. Reuse existing functions; do not create competing subsystems. If a stage tells you to reuse a symbol, `grep -n` for it first.
- **Never weaken, skip, delete or loosen an existing test** except the ones a stage names explicitly (by title). When a stage says "update" a test, change only the assertions it names.
- **No placeholders, TODO comments, dead code, speculative abstractions, generated reports or planning files.** Do not add dependencies except where a stage says so.
- **Tests must exercise the production code path** (real `workspaceTools(...).run`, real `TodoRepository`, real `SqliteFile`, real `WorkspaceView`), not a reimplementation of it.
- Comments only where the code is not self-explanatory. Double quotes, no semicolons (the repo style; `npx eslint` enforces quotes and import order — run `npx eslint <files> --fix` for import-order errors).
- If the plan contradicts what you observe in the code, **stop and report the contradiction** instead of improvising. Do not ask routine questions the plan already answers.
- Scratch files go in `/tmp` and are deleted before you finish. Never write test databases into the repository tree.

### 0.3 Verification gates

Run from the repository root. "Gate" = the commands every stage must pass before it is `done`.

| Gate | Command | Expected at base commit `0ca082a` |
|---|---|---|
| Types | `npx tsc -p . --noEmit` | exit 0 |
| Lint | `npx eslint src --quiet` | 0 findings |
| Build for tests | `npm run build-tests` | exit 0 (writes ignored `out/`) |
| Bundle | `npm run build` | exit 0 (needed once so the agent-profiles webview test can find `out/sidebar.js`) |
| Standalone tests | `npm run test:sqlite` | **966 tests, 966 pass, 0 fail, 0 skipped** (965/966 if you skipped `npm run build`; the single failure is the agent-profiles webview bundle test) |
| Whitespace | `git diff --check` | no output |
| VS Code suite | `xvfb-run -a npm test` (the `pretest` hook cleans, builds, bundles and lints first) | not measured at planning time — Stage 0 records it |

Rules for the VS Code suite (`out/test/suite/*.test.js`: `agent-reply`, `agents`, `line-edit`, `workspace-index`; configured in `.vscode-test.js`):

- Stages marked **[VS Code suite]** change code that only runs inside VS Code (`chat/tool-sinks.ts`, `edit/service.ts`, `workspace-index/index.ts`, `chat/index.ts`). Run `xvfb-run -a npm test` (or a subset: `npx vscode-test --grep "<test title>"`) and record real counts.
- If the suite cannot run in your environment (no display, VS Code download blocked, crash on start), record `NOT RUN: <exact error>` in the Progress Log and in your report. **Never claim a VS Code suite pass you did not observe.** Still write the integration tests the stage requires.
- Compiled tests live in `out/`; always `npm run build-tests` before `npm run test:sqlite`. Run one standalone file with `node --test out/test/standalone/<name>.standalone.js`.

### 0.4 Test conventions

- Standalone tests: `src/test/standalone/*.standalone.ts`, `node:test` + `node:assert`, no `vscode` import. New SQLite-backed tests use `fs.mkdtempSync(path.join(os.tmpdir(), "twinny-..."))` and remove the directory in `finally`.
- VS Code tests: `src/test/suite/*.test.ts`, Mocha `suite`/`test`, may `import * as vscode from "vscode"`.
- Name tests as sentences that state the behaviour (existing style), and name them exactly as the stage says when it gives a title.
- A bug you fix must have a test that fails without the fix.

### 0.5 Final report format (end of every stage)

```
Stage N report
- Changed files: <list, one line each, with a few words on the change>
- Commands run and actual results: <command → "N tests, N pass, N fail, N skipped">   (include tsc, eslint, build-tests, test:sqlite, git diff --check, and the VS Code suite or "NOT RUN: reason")
- Acceptance criteria: <each criterion → met / not met, with the evidence>
- Deviations from the plan: <none, or each deviation and why>
- Remaining / blocked: <none, or exact blocker>
- Progress Log: updated
```

### 0.6 Handoff prompt template

Each stage ends with a prompt block. If you are the maintainer starting a stage, paste that block as the first message of a fresh conversation. The block always has this shape:

```
You are implementing Stage N of docs/Moriarty_Unified_Index_Evidence_Implementation_Plan.md in /home/stark/source/twinny (branch feature/unified-project-db, base 0ca082a). Do not commit.
Read first: §0, §1, §2, the Progress Log, Stage N, and the appendices Stage N cites. Confirm the stages Stage N depends on are done.
Do only Stage N. Satisfy its acceptance criteria, run its gates, update the Progress Log, and finish with the §0.5 report.
```

## 1. Decisions (frozen — do not revisit) and non-goals

These were decided by the maintainer. Implement them; do not re-litigate them.

1. **One project-local SQLite database** holds the workspace search index and the TODO/evidence records. LanceDB (embeddings) stays separate and untouched.
2. **Reuse** existing indexing, fingerprinting and evidence code wherever possible. No competing subsystems, no wholesale rewrites.
3. **Hashes are opaque tokens** to the model. Moriarty computes and compares them. `edit_lines` keeps `expected_hash`; the editing protocol does not change.
4. **Dedicated native mutations refresh affected indexed files synchronously before reporting complete success:** `edit_lines`, legacy `edit_file`, `create_file`, `delete_file`, `move_file`, `rename_symbol`. **`run_command` is exempt:** its side effects (scripts, subprocesses) are handled by the existing automatic indexer. No special reconciliation or waiting.
5. **Evidence is project-scoped, reusable across TODOs and conversations, and has no exclusive owner.** The `evidence_from` mechanism is eliminated.
6. **Evidence validity is derived automatically** when evidence is stored or retrieved: hash matches → `valid`; file exists with a different hash → `stale`; file gone → `invalid`; restored with matching contents → `valid` again. Historical evidence is always retained.
7. **Observations carry the actual source path and fingerprint.** Historical references survive moves; a matching hash at another path is only a *relocation candidate* and never rewrites a historical reference.
8. **Workspace roots define indexing scope, not tool access or evidence eligibility.** Native tools support authorized paths outside the workspace, including normal VSCodium Remote-SSH work in `/root/docker`, `/etc` and other server directories. Every successfully read file can produce hash-backed evidence whether indexed or not.
9. **Multi-root identity is in the schema now** (logical project / resource root / source path are separate). No SSH or provider framework is introduced.
10. **Preserve** native tool interfaces, permissions, TODO behaviour and editor functionality.
11. **Private development phase:** schema changes reset the development database; no migrations. (Not a production policy.)

### Design choices made by the planner (implement as written; flagged for the maintainer in Appendix D)

- **JC-1** Prerequisite evidence is derived from the plan's dependency edges: a task's recorded work = its own + its transitive prerequisites'. Dependents therefore inherit prerequisites' recorded mutations (previously only declared handoffs counted).
- **JC-2** If the filesystem change succeeded but the index refresh failed, the tool still reports the change as done and adds an explicit `index_refresh` failure note; the change is never repeated.
- **JC-3** The project's **home root is the first workspace folder.** Multi-root windows share the first folder's database; reordering folders selects a different database.
- **JC-4** External access is authorized by one new machine-scoped setting `twinny.chatToolsAllowedPaths` (default `[]`) plus the other workspace folders.
- **JC-5** The database file is renamed `project.sqlite` (fresh v20 schema). The old `.twinny/evidence.sqlite` and the global `workspace-index.sqlite` are left on disk untouched and unused.
- **JC-6** In a conversation that has a TODO plan, every tool result is recorded as project evidence; when no task is active the observation has `item_id = NULL`.

### Non-goals (do not implement)

SSH/remote provider abstractions · registering additional workspace folders as `source_root` rows in production code (the API exists and is tested; wiring is a later additive step) · reconciling `run_command` side effects · migrating or deleting old database files · showing evidence validity inside model prompts beyond the lookup/preflight outputs named in Stage 12 · recording evidence for chats that have no TODO plan · any change to LanceDB/embeddings · UI changes other than the one setting contribution.

---

## 2. Target architecture

### 2.1 Storage

- **File:** `<home>/.twinny/project.sqlite`, `PRAGMA user_version = 20`. `<home>` is the first workspace folder (must be a `file` folder). `.twinny/` is created and git-ignored by the existing `prepareProjectTodoStorage`.
- **Pragmas:** WAL, `busy_timeout = 5000`, `foreign_keys = ON`. TODO connections use `synchronous = FULL` (existing). The index connection sets `synchronous = NORMAL` on its own connection (rebuildable cache, thousands of small commits).
- **Connections:** one `SqliteFile` (= one `better-sqlite3` connection) per consumer: every `TodoRepository` (sidebar and fullscreen providers each make one) and the `WorkspaceIntelligenceIndex`. All writes are **short synchronous transactions** (`SqliteFile.write`, or `transaction()` from the Stage 5 facade). **No transaction ever spans an `await`.** Because both sides are synchronous and share one thread, in-process write locks cannot collide; other processes wait on `busy_timeout`.
- **Table groups (full DDL in Appendix A):** (a) project/TODO/evidence tables `todo_*` as in v19 except `todo_tool_observations.item_id` becomes nullable; (b) new `source_root` and `observation_source`; (c) the index tables `index_meta`, `documents`, `symbols`, `documents_fts` (moved from the old global index database).
- **Lifecycle:** created on first open; reopened by path; closed by `closeTodoDatabases()` on deactivate; **reset = delete `project.sqlite`, `-wal`, `-shm` and reopen.** A pre-v20 or newer database is refused with a clear message and left untouched.
- **Integrity check:** `PRAGMA quick_check` once per database path per process (replaces the per-open full `integrity_check`).

### 2.2 Identity layers

| Layer | Identifier | Stored in | Notes |
|---|---|---|---|
| Logical project | `todo_projects.id` (uuid); production key is the constant `PROJECT_FINGERPRINT = "project"` | `todo_projects` | One project per database. Replaces the folder-set hash so adding or reordering folders never splits evidence. |
| Resource root | `source_root.root_id` (uuid) | `source_root` | `kind`: `home` (exactly one, rebound when the project folder moves), `workspace` (reserved), `external` (the host filesystem root `/`). `host` is `''` for this extension host. |
| Source path | POSIX path **relative to its root** | `observation_source.path` | Never starts with `/`. `.` only for a root itself. |
| Canonical path | the string shown to and accepted from the model | accepted facts `path`, edit ledger `target`, tool output | Under home → home-relative (`src/a.ts`); anywhere else → absolute POSIX (`/etc/nginx/nginx.conf`). Produced by `SourceRoots.canonicalPath`. |

### 2.3 Three independent axes

| Axis | Decided by | Never decided by |
|---|---|---|
| Tool access (read, list, grep, edit, create, move, delete) | all workspace folders + `twinny.chatToolsAllowedPaths` + team `blockedPaths` + `.gitignore` (inside the workspace only) + edit mode, approvals, protected-path rules | the database or the index |
| Indexing scope (`search_workspace`) | workspace folders, `twinny.indexing.*`, `.gitignore`, size limits | tool access |
| Evidence eligibility | any successful native read or mutation that yields a hash | indexing or workspace membership |

### 2.4 Hash contract (existing semantics; Stage 17 audits it)

- One function: `fingerprintContent` in `src/extension/tools/fingerprint.ts`. Token `<algorithm>:<hex>` (`xxh64:`, `xxh3_128:`, `sha256:`); `verifyContentFingerprint` also accepts a legacy bare sha256. Computed over **decoded text, BOM stripped, line endings preserved**, whole file only.
- `read_file` always prints `content_hash: <token>; total_lines: N` in its header, for ranged reads too. `edit_lines` requires `expected_hash`, returns the new `content_hash` on success and `current_hash` on conflict. The index stores the same token in `documents.fingerprint`, computed by the same function from saved bytes.
- The model carries the token; Moriarty computes and compares it. **New in this plan:** `create_file` and `rename_symbol` also return resulting whole-file hashes; `move_file` reports the unchanged hash.

### 2.5 Synchronous mutation contract

For each dedicated mutating tool whose change persisted to disk:

1. Validate (existing: hash precondition, permissions, protected paths).
2. Apply and persist (existing editor/`WorkspaceEdit` path, checkpoints, diagnostics recovery).
3. **`refreshIndex(changes)` is awaited** (Stage 7 API). It reads the **saved file from disk** and updates `documents`, `symbols` and `documents_fts` in one short synchronous transaction. No debounce, no queue, no background refresh.
4. Settle the edit-ledger record (existing `settleEdit`) and return the outcome. The observation (evidence) is recorded by the existing `onToolResult` hook after the tool returns.
5. The tool output carries the new hash where applicable.

Refresh result: `synced` · `skipped` (indexing disabled, file not indexable or outside indexed roots, no index) · `failed` (with reason). On `failed` the tool still reports the change (`ok: true`) and adds `index_refresh: {status:"failed", reason}` plus a sentence telling the model the change is complete and must not be repeated (JC-2). Moves and renames refresh **both** old and new paths (delete + write). Deletions remove the active index entry only — evidence rows are never deleted. If a rollback restored the file, the restored content is what gets indexed.

### 2.6 Evidence model

- **Observation** = immutable `todo_tool_observations` row (+ `todo_tool_evidence` text and metadata). `list_id` = the conversation list it was recorded in; `item_id` = the task active at that time (**provenance only, nullable**).
- **File references** = `observation_source` rows: `(root_id, path, role, start_line, end_line, total_lines, content_hash)`. Roles: `read`, `created`, `modified`, `deleted`, `moved_from`, `moved_to`. A rename of a symbol across files, or a move, yields several rows for one observation.
- **Relationships are derived, not copied:** a task's recorded work = its own observations + those of its transitive prerequisites (replaces `evidence_from`). Accepted facts stay project-scoped. `twinny_evidence_lookup` is project-wide. Relevance and proof sufficiency are still judged against the actual criterion; nothing is attributed to every task.
- **Validity is derived on every retrieval and when facts are accepted — never persisted:**

| Condition (per reference) | Validity |
|---|---|
| file exists, whole-file fingerprint equals the recorded hash | `valid` |
| file exists, fingerprint differs | `stale` |
| file does not exist | `invalid` |
| file restored with matching contents | `valid` again |

Several references: any `invalid` → `invalid`; else any `stale` → `stale`; else `valid`. Ordinary I/O errors (permission, too large, binary) are **not** validity states: they keep the existing error handling (the legacy `freshness: "unverifiable"` path).

### 2.7 What does not change

LanceDB and `src/extension/embeddings`; `run_command` semantics and working directory; the `expected_hash` protocol; tool names and parameters (changes are additive outputs, one additive setting, and one removed optional parameter `evidence_from`); edit modes, approvals, checkpoints and diagnostics recovery; `.gitignore`-based hiding inside the workspace; protected-path rules; the legacy global TODO database retirement (`retireLegacyTodoDatabase`).

---

## 3. Stage index, dependencies and regression coverage

### 3.1 Dependency graph

```
0 ─┬─ 1 ─────────────────────────────┬─ 12 ─┐
   ├─ 2                               ├─ 14  │
   ├─ 3 ─ 4 ─┬─ 6 ─ 7 ─ 8 ─ 9 ─ 11 ──┴─ 13 ─┴─ 17
   └─ 5 ────┘  │        └─ 10 ─┘                (16 after 6; 15 after 6)
```

| Stage | Depends on | Touches VS Code-only code? |
|---|---|---|
| 0 | — | no |
| 1 | 0 | `chat/index.ts`, `edit/service.ts` → **[VS Code suite]** |
| 1a | 1 | Native tool preflight and approval UI → **[VS Code suite]** |
| 2 | 0 | no |
| 3 | 0 | no |
| 4 | 3 | `webview/base.ts`, `chat/index.ts` → **[VS Code suite]** |
| 5 | 0 | no |
| 6 | 4, 5 | `workspace-index/index.ts`, `src/index.ts` → **[VS Code suite]** |
| 7 | 6 | **[VS Code suite]** |
| 8 | 7 | **[VS Code suite]** |
| 9 | 8 | **[VS Code suite]** |
| 10 | 8 | **[VS Code suite]** |
| 11 | 1a, 4, 8, 9, 10 | `chat/index.ts` → **[VS Code suite]** |
| 12 | 1, 1a, 4, 11 | `chat/index.ts` (`currentSourceReader`) → **[VS Code suite]** |
| 13 | 6, 11, 12 | no |
| 14 | 1, 1a | no |
| 15 | 4, 6 | **[VS Code suite]** |
| 16 | 6 (do it after 7–15 are done) | no |
| 17 | all | **[VS Code suite]** |

### 3.2 Regression coverage required by the maintainer

| Required regression | Where it is tested |
|---|---|
| Immediate post-edit search visibility | Stage 8 (`edit_lines`/`edit_file`), Stage 9 (`create_file`), Stage 10 (`rename_symbol`) — search **immediately** after the tool returns, no polling |
| Moves | Stage 9 (old path gone, new path found at once), Stage 13 (historical reference kept, relocation candidate offered) |
| Deletions | Stage 9 (active entry gone at once), Stage 12 (evidence retained, `invalid`) |
| Source-hash conflicts | Stage 8 (stale `expected_hash` leaves file and index unchanged; two edits from the same hash — second conflicts) |
| Rollback validity | Stage 8 (catastrophic-edit rollback re-syncs the index to the restored content), Stage 12 (restored contents → `valid` again) |
| Outside-workspace approvals and evidence | Stage 1a (permission-scoped /tmp log read, same-call continuation, full-file hash); Stages 11–12 (project evidence and automatic validity for approved files outside index) |
| Cross-TODO evidence reuse | Stage 2 (relevance without task ancestry), Stage 11 (project-owned evidence and deletion survival), existing accepted-fact reuse test kept |
| Database lifecycle | Stage 4 (create/reopen/refuse old and newer/reset/two connections/multi-root home), Stage 6 (index and TODO share one file; reset recreates both; project-folder move rebinds home), Stage 16 (no `sqlite3` left) |

## 4. Stages

> **Stage 1a** is mandatory immediately after Stage 1, before Stages 11, 12 and 14. It does not renumber Stages 0–17. Record it separately in the Progress Log; Stage 17's full verification includes it.

### Stage 0 — Baseline, branch, progress log

**Depends on:** nothing. **Goal:** a clean working branch and recorded baseline numbers. **No source changes.**

**Steps**

1. `git status --short` must show nothing except (possibly) `?? docs/Moriarty_Unified_Index_Evidence_Implementation_Plan.md`. Do not edit that file except its Progress Log. Record `git branch --show-current` (expected `feature/todo`) and `git rev-parse --short HEAD` (expected `0ca082a`). If HEAD differs, record it and spot-check Appendix B; if the symbols it lists have moved materially, stop and report.
2. `git switch -c feature/unified-project-db`.
3. `npm run clean && npm run build-tests && npm run build && npm run lint` — all must pass; lint must report 0 findings.
4. `npm run test:sqlite` — expected `tests 966 / pass 966 / fail 0 / skipped 0`. Record the actual numbers.
5. `xvfb-run -a npm test` — record the pass/fail counts and the titles of any failing tests as *pre-existing*; or record `NOT RUN: <exact error>` (for example no display, VS Code download blocked). Do not fix anything. **Also record which suites actually ran** (the Mocha output prints suite names: `Persistent workspace intelligence index`, `Chat edit_file`, …). `.vscode-test.js` lists only `agent-reply`, `agents`, `line-edit` and `workspace-index`; if `Chat edit_file` or the prompt-compiler suite did not run, say so — every new VS Code test in this plan is placed in `line-edit.test.ts` or `workspace-index.test.ts` for that reason.
6. Fill in Progress Log row 0, including the HEAD hash and the measured baselines.

**Acceptance:** branch `feature/unified-project-db` exists; Progress Log row 0 holds the baselines; `git status --short` shows no source changes.

**Do not:** edit source, commit, install packages.

```
You are implementing Stage 0 of docs/Moriarty_Unified_Index_Evidence_Implementation_Plan.md in /home/stark/source/twinny. Do not commit.
Read §0 and Stage 0 only. Create branch feature/unified-project-db, run the baseline commands, record the real numbers in the Progress Log, and finish with the §0.5 report. Change no source files.
```

---

### Stage 1 — External path authorization in the native tools

**Depends on:** 0. **[VS Code suite]** (touches `chat/index.ts`, `edit/service.ts`).
**Goal:** the native file tools can read, list, edit, create, move and delete files under **authorized absolute paths outside the workspace root** (other workspace folders, and folders listed in the new setting `twinny.chatToolsAllowedPaths`), including paths on a Remote-SSH extension host. With nothing extra authorized, behaviour is byte-for-byte unchanged.

**Read first:** `src/extension/tools/view.ts` (all 298 lines), `isProtectedPath` in `tools/helpers.ts`, `outsideWorkspace` + `chatEdit`/`chatCreate` in `src/extension/edit/service.ts`, `Chat.workspaceView()` in `src/extension/chat/index.ts`, the `twinny.chatToolsEdits` block in `package.json`, and the existing refusal tests `tool-safety.standalone.ts` ("paths resolve inside the workspace only…") and `chat-tools.standalone.ts` (search `/etc/passwd`, `../escape.ts`).

**Changes**

1. **New file `src/extension/tools/authorized-paths.ts`** (no `vscode` import):
   ```ts
   /** Absolute, normalized, deduplicated roots. `~` and `~/x` expand against `home`. Relative entries, empty entries and filesystem roots are dropped. */
   export const normalizeAuthorizedRoots = (entries: readonly string[], home = os.homedir()): string[]
   /** The longest root equal to or containing `absolute` (compared as path segments, so /etc2 is not under /etc); undefined if none. Pure: no filesystem access. */
   export const authorizedRootOf = (absolute: string, roots: readonly string[]): string | undefined
   ```
2. **`WorkspaceView` (`view.ts`)** — add a fifth optional constructor parameter `authorizedRoots: readonly string[] = []` (all existing positional callers stay valid). Store `normalizeAuthorizedRoots(authorizedRoots)` as `{ root, real }[]` (`real` = `fs.realpathSync` or the root itself if it does not exist), dropping entries equal to or inside the primary root. Then:
   - `private externalRoot(absolute)`: the authorized entry containing `absolute` **lexically**, only when `absolute` is lexically outside the primary root.
   - `isExternal(absolute): boolean` (public) = `externalRoot(absolute) !== undefined`.
   - `private externalDenied(external, real, isDirectory): "blocked" | "ignored" | undefined`: with `within` = `path.relative(external.real, real)` in POSIX form; `blocked` when the team's blocked globs match the **absolute path without its leading `/` (or drive prefix)**; `ignored` when the base rules (`.git`, `node_modules`, `ignoredGlobs`) match `within`. `.gitignore` files are **not** consulted for external paths.
   - `resolve()`: keep the existing flow. After `real` is computed, if `externalRoot(absolute)` exists, run `resolveExternal`: the **real** path must also lie inside the same authorized root's real path (a symlink leading out of it → `"<cleaned> is outside the workspace."`); then `externalDenied` (messages: blocked → `"<cleaned> is kept from the agent by the team's rules and cannot be read."`, ignored → `"<cleaned> is ignored and cannot be read."`); then the file/dir kind checks; return `absolute`. Paths that are neither inside the root nor under an authorized root keep the existing `"is outside the workspace."` error text unchanged.
   - `resolveNew()`: allow an absolute target under an authorized root when the nearest existing ancestor's real path is inside the same authorized root and `externalDenied` (computed on `realParent` + the not-yet-existing remainder) is `undefined`; otherwise `"is outside the workspace."` / `"... is ignored; twinny does not write there."` / the team-rules message already used for in-workspace paths.
   - `visible(absolute)`: for an external path, `externalDenied(external, absolute, false) === undefined` (lexical; `resolve()` remains the real gate).
   - `relative(absolute)`: external → the absolute path with `/` separators; everything else unchanged. `realRelative(absolute)`: when the real path is outside `_realRoot` but inside an authorized real root → the absolute real path with `/` separators; otherwise unchanged.
   - `entries(dir)`: filter with a new private `ignoredAt(absolute, isDirectory)` (primary root → existing `ignored()`, external → `externalDenied`).
   - Do **not** change `files()`, `allFiles()`, `allDirs()` or `walk()` (they stay workspace-only; Stage 14 adds the bounded external walk used by `grep`).
3. **`Chat.workspaceView()` (`chat/index.ts`)**: pass a fifth argument = the `fsPath`s of `workspace.workspaceFolders` entries after the first that have `scheme === "file"`, followed by `this.config.get<string[]>("chatToolsAllowedPaths", [])`.
4. **`edit/service.ts` `outsideWorkspace`**: keep "no folders open → false" and "inside a workspace folder → false"; additionally return `false` when `uri.scheme === "file"` and `authorizedRootOf(uri.fsPath, normalizeAuthorizedRoots(<twinny.chatToolsAllowedPaths>)) !== undefined`. Everything else stays outside. Both `chatEdit` and `chatCreate` already call it.
5. **`package.json`**: add next to `twinny.chatToolsEdits`:
   ```json
   "twinny.chatToolsAllowedPaths": {
     "order": 20,
     "type": "array",
     "items": { "type": "string" },
     "default": [],
     "markdownDescription": "Absolute folders outside the workspace that the chat tools may read, list, edit, create, move and delete files in (with `#twinny.chatTools#` on), for example `/etc/nginx` or `/root/docker` on a Remote-SSH host. Other folders of a multi-root workspace are always allowed. Edits still follow `#twinny.chatToolsEdits#`, protected-file approvals and the team's blocked paths. `~` is your home folder. The filesystem root cannot be allowed. Files in these folders are not hidden by `.gitignore`, so allow only folders you are willing to expose.",
     "scope": "machine"
   }
   ```
6. Tool descriptions: in `create_file` change `"relative to the workspace root"` to `"relative to the workspace root, or an absolute path inside an allowed folder"`. Touch no other tool text.

**Tests**

- New `src/test/standalone/authorized-paths.standalone.ts`: `~` expansion; relative/empty/`/` entries dropped; dedupe and trailing-slash normalization; `authorizedRootOf` exact match, child, **sibling with a common prefix is not inside**, longest root wins.
- Add to `tool-safety.standalone.ts` (real temp dirs, `new WorkspaceView(root, [], undefined, blocked, [external])`): `resolve(abs-in-external, "file")` returns it; `resolve` of a path in a **second, unauthorized** temp dir still throws `/outside the workspace/`; `resolve("/etc/passwd")` still throws with no roots; a symlink inside the external dir pointing outside it is refused; `.git/` and `node_modules/` inside the external dir are refused; a blocked glob matches an external file; `resolveNew(external/new.txt)` returns it, `resolveNew(external/../escape.txt)` is refused; `visible()` true/false accordingly; `relative()` is absolute POSIX for external and relative for internal; `entries()` of an external dir hides `.git`; `realRelative` of an external file is absolute.
- Add to `chat-tools.standalone.ts` (production tool path, `workspaceTools(view)`): `read_file` of an external absolute path prints a header with the absolute path **and** `content_hash: <token>; total_lines: N` that equals `fingerprintContent` of the file text; `list_dir` of the external dir works; an unauthorized path is refused. Existing refusal assertions stay untouched.
- **[VS Code suite]** in `workspace-index.test.ts` (its setup already opens three workspace folders, and its `storage` temp directory lies outside all of them): through the real command path, `editorEdits(new WorkspaceView(root), "apply", async () => true).create(<storage>/outside.ts, "export const x = 1\n")` is refused with `/outside the workspace/`; after setting `twinny.chatToolsAllowedPaths` to `[<storage>]` (`ConfigurationTarget.Global`; restore the previous value in `finally`) the same call succeeds and the file exists. Name it *a file outside the workspace folders is refused until its folder is allowed*.

**Acceptance criteria**

- All gates in §0.3 pass; the existing refusal tests pass unmodified.
- With `authorizedRoots` empty, `WorkspaceView` behaves exactly as before (the new tests above plus the whole existing suite).
- `grep -n "chatToolsAllowedPaths" package.json src` shows the setting, the `Chat.workspaceView()` read and the `outsideWorkspace` read — and nothing reads it at workspace scope.

**Do not:** add UI; authorize `/`; change `run_command`, `git`, `search_workspace`, `files()`; read `.gitignore` for external paths; change `WorkspaceView.root` semantics; weaken any existing assertion.

```
You are implementing Stage 1 of docs/Moriarty_Unified_Index_Evidence_Implementation_Plan.md in /home/stark/source/twinny (branch feature/unified-project-db, base 0ca082a). Do not commit.
Read first: §0, §1, §2.3, the Progress Log, Stage 1. Confirm Stage 0 is done.
Do only Stage 1. Satisfy its acceptance criteria, run its gates (including the VS Code suite or record NOT RUN with the error), update the Progress Log, and finish with the §0.5 report.
```

---

### Stage 1a — Interactive approval for native tools outside the workspace

**Depends on:** Stage 1. **[VS Code suite].** **Goal:** permit the model to use native file tools on otherwise permissible outside-workspace paths by asking the user and then resuming the *same pending tool call*. A typical example is `read_file("/tmp/test.log")` following redirected test output. Do not make the model retry, use `cat`/`tail`, or enlarge index scope.

**Read first:** `src/extension/tools/authorized-paths.ts` and `view.ts` from Stage 1; `workspaceTools` and `run` in `tools/workspace.ts`; `Chat.workspaceView` in `chat/index.ts`; `outsideWorkspace` and mutation sinks in `edit/service.ts`; existing VS Code approval flows, extension-host machine storage, the native tool dispatcher and the exact protected-path checks. Verify these interfaces in the current code, not only the line hints.

**Contract**

- **Prompt choices:** Allow file once; Allow folder once; Allow file for session; Allow folder for session; Always allow file; Always allow folder; Deny. A directory-targeted operation uses “this directory” for the exact-target choice. Show the requested path, operation/tool, and **read or write** access. Default to the narrowest scope, not an always grant.
- **Operation class:** read covers `read_file`, `list_dir`, file-directed `grep` and other nonmutating native tools; write covers `edit_lines`, `edit_file`, `create_file`, `delete_file`, `move_file`, `rename_symbol` and other dedicated file mutations. Read grants do not grant write. Existing edit approvals, modes and protected paths still apply.
- **Lifetime and storage:** once is valid only for the pending operation; session exists only while the extension-host session lives; always grants persist in machine/extension-host scope with a discoverable view/revoke action. Do not persist session grants or make repository/workspace settings silently widen host access. The existing static machine-scoped allowlist is a separate explicit preauthorization option.
- **Host:** isolate grants by actual local or Remote-SSH extension host so a grant on Jarvis does not automatically apply to a server, or to another server. Do not introduce an SSH filesystem client.
- **Path security:** whole path-segment matching, canonical real paths and symlink checks. For nonexistent write targets, validate the nearest existing ancestor. Revalidate immediately before executing to prevent swapped symlinks. Refuse `/` and drive-root grants, protected/team-blocked/ignored files, and unauthorized traversal. Hard denials are not converted into approval prompts. File grants never cover siblings; folder grants never cover similarly-prefixed sibling directories.
- **Prompt outcomes:** cancel, deny, dismiss, unavailable UI and host shutdown fail closed with an explicit tool denial and no mutation. Any multi-path operation must verify grants on **all** affected paths before changing any file.
- **Index versus evidence:** after permission, native reads still return normal `content_hash` (whole file, even for partial reads) and `total_lines`. Approved outside-workspace files are eligible for Stage 11 source-backed project evidence and Stage 12 validity checks **without** being added to FTS/index. A permission is not index enrollment.

**Implementation steps**

1. Add a small testable permission matcher and injected prompt adapter, using existing authorization helpers rather than a second security engine. Keep grant state scoped by file/folder, read/write, duration and actual extension host. Persist always-grants in machine-scoped extension storage and implement a straightforward way to revoke them.
2. Add a shared **asynchronous preflight** to actual native tool dispatch, before synchronous `WorkspaceView.resolve`/`resolveNew` or edit sink invocation. This is necessary because the existing path resolver is synchronous and must not create UI itself. Detect already-allowed workspace/static paths and proceed without prompts.
3. For an outside path without a grant, display the permission prompt; on allow, continue **the original pending native tool call exactly once** under the granted scope. On deny, return a single clear denied result. Do not route approval through another agent step or repeat file mutations.
4. Integrate across reads, list/grep, creates, edits, deletes, moves and renames; require all source/destination permissions before multi-path mutations. Re-check actual resolved paths and existing hard safety rules immediately before execution. Preserve the current protected-file approval mechanism.
5. Keep `run_command` unchanged. Command time limits and output-size overrides are **not part of this stage**.

**Required tests and acceptance criteria**

- Real tool path: `read_file` on an unapproved external `/tmp/test.log` prompts once. Choosing Allow file once resumes the original read, returns original path and correct whole-file hash, and **does not re-invoke the model or add an index entry**.
- Denial/dismissal, missing UI/headless mode and cancellation return clear denied results, never hang or perform a mutation.
- Read-only allowance does not permit write; file scope does not cover neighbors; directory scope covers descendants only; once/session/always expirations and persistent revocation work.
- Grants do not cross host identities or bypass a protected/team-blocked path. Symlink escapes and symlink retargeting between approval and execution are rejected.
- Moves and multi-file renames check every destination/source and never partially mutate after a denial.
- No new prompt for in-workspace files or explicit Stage 1 allowlist entries. A nonindexed approved file can be observed with its actual source hash for Stages 11–12.
- Run production-path tests with an injected prompt adapter, standalone grant-matcher tests and VS Code integration tests covering UI + same-call continuation. Pass all §0.3 gates or record exact test failures/NOT RUN. Update the Progress Log.

**Do not:** add a new remote filesystem provider, grant write on a read approval, index arbitrary external paths, or modify `run_command` timeout/size policies.

```
Implement Stage 1a of docs/Moriarty_Unified_Index_Evidence_Implementation_Plan.md. Read §0, the maintainer correction and runtime permission amendment, the Progress Log, Stages 1 and 1a. Confirm Stage 1 is done. Implement permission prompts and operation/host-scoped file/folder once/session/always grants; resume the pending tool call once; test nonindexed /tmp log read returning whole-file hash. Run gates, update Progress Log, report results. Do not change run_command limits.
```

---

### Stage 2 — Remove `evidence_from` and task-owned eligibility

**Depends on:** Stage 0. **Goal:** no model-side handoff and no proof eligibility determined by task ancestry. This stage refactors existing proof logic; Stage 11 broadens project observation storage and queries.

**Read first:** `src/extension/tools/todos.ts` (`twinny_todo_update`); `src/extension/todos/repository.ts` (`prerequisiteIdsOf`, `declaredEvidenceSourcesOf`, `getReviewPackages`, `claimCompletion`); `src/extension/todos/feedback.ts` (`criterionOwners`, `taskHasVerifiedMutation`); the existing handoff/sibling/failure tests.

**Changes**
1. Remove `evidence_from` from the model-facing schema, argument parsing, `claimCompletion` inputs, validation and `evidence_linked` event. Ignore a stray legacy argument instead of rejecting a valid completion.
2. Do **not** replace declared handoffs with transitive prerequisite inheritance. Use existing repository observations as candidate proof, without task ownership as an eligibility gate. A matching successful mutation can support a criterion regardless of its original task; an unrelated successful edit or failed mutation cannot.
3. Keep deterministic verification of source target, tool result, successful persisted mutation, and criterion relevance. Do not count mere task proximity or the model's narrative.
4. Stage 11 extends the candidate pool to all project observations, including other conversations and sessions without a TODO plan; do not invent a temporary second evidence cache.

**Tests:** rewrite the Locate/Replace/Verify and declared-handoff tests to prove relevant evidence reuses without dependency edges or `evidence_from`. A sibling/other-task observation with the **correct target and successful outcome** may count; a wrong-target or failed observation must not, even when recorded under a prerequisite. Assert the tool no longer advertises `evidence_from`. Preserve all unrelated tests.

**Acceptance:** no owner/ancestor rule for candidate evidence; deterministic proof remains strict. Run the §0.3 gates, record actual results, update the Progress Log. Do only Stage 2.

```
Implement Stage 2 of docs/Moriarty_Unified_Index_Evidence_Implementation_Plan.md. Read §0, the maintainer-reviewed corrections, §2, the Progress Log and Stage 2. Do only this stage. Remove evidence_from and owner-gated proof, preserve deterministic verification, run all gates, update the log and report results.
```

---

### Stage 3 — `SourceRoots` (resource identity and path normalization)

**Depends on:** 0. **Goal:** one small, `vscode`-free class that owns the `source_root` table and turns absolute paths into `(root, root-relative path)` identities and canonical paths. It is the *shared source-reference service* the repository (Stages 4, 11–13) uses. Nothing consumes it yet.

**Read first:** §2.2; `export type Database` in `src/extension/todos/sqlite.ts`; how existing standalone tests open an in-memory database (`import BetterSqlite from "better-sqlite3"`).

**Changes — new file `src/extension/todos/source-roots.ts`** (no `vscode` import; `import type { Database } from "./sqlite"` so there is no runtime cycle):

```ts
export type SourceRootKind = "home" | "workspace" | "external"
export interface SourceRootRecord { readonly rootId: string; readonly kind: SourceRootKind; readonly host: string; readonly locator: string; readonly label: string }
/** A source reference: the root and the POSIX path relative to it ("." for the root itself). */
export interface SourceLocation { readonly rootId: string; readonly path: string }

export const SOURCE_ROOT_SCHEMA: string   // the DDL for `source_root` and `source_root_one_home` from Appendix A, verbatim
export const toPosixPath = (value: string): string            // backslashes → "/", path.posix.normalize, no trailing "/" except the root itself
export const homePathOfDatabase = (databasePath: string): string  // dirname(dirname(db)) when the parent directory is ".twinny", else dirname(db)

export class SourceRoots {
  constructor(database: Database, homePath: string)
  home(): SourceRootRecord                                   // creates the home row, or rebinds its locator (keeping root_id) when the project folder moved
  register(locator: string, label: string): SourceRootRecord // kind "workspace"; idempotent by (host "", locator); the home locator returns the home record
  locate(absolutePath: string): SourceLocation               // longest matching home/workspace root, else the external filesystem root ("/" or "C:/")
  absolutePath(location: SourceLocation): string
  canonicalPath(location: SourceLocation): string            // under the home locator → home-relative; anywhere else → absolute POSIX
  fromCanonical(canonical: string): SourceLocation           // absolute → locate(); relative → under home (".." escapes are resolved, then located)
  byId(rootId: string): SourceRootRecord | undefined
}
```

Rules: all methods are synchronous; `host` is always `""` in this plan; `locate()` normalizes with `toPosixPath` first (so `/p/src/../x.ts` → `x.ts`), requires an absolute path (`/…` or `C:/…`, otherwise throw), matches whole path segments (`/p2/x` is not under `/p`), and creates the single external row lazily (`kind "external"`, locator = filesystem root, label `"filesystem"`). `canonicalPath` is defined on the absolute path, so a nested workspace root under home still yields the home-relative string. If the unique index rejects a rebind (another root already owns the new home locator), throw `Error("The project folder <locator> is already registered as a <kind> root of this database")`.

**Tests — new `src/test/standalone/source-roots.standalone.ts`** (in-memory `better-sqlite3`, `db.exec(SOURCE_ROOT_SCHEMA)`):

- *the home root is created once and keeps its root id when the project folder moves*
- *locate picks the longest matching root and never confuses /p with /p2*
- *a path outside every root gets the single external filesystem root, so external files keep an absolute identity*
- *canonical paths are home-relative under home and absolute elsewhere, and round-trip through fromCanonical*
- *registering a workspace root is idempotent, is used by locate, and canonicalPath of a file in it is absolute*
- *dot segments, duplicate separators and backslashes are normalized before matching; a relative path is rejected by locate*
- *homePathOfDatabase maps <project>/.twinny/project.sqlite to <project> and <dir>/todos.sqlite to <dir>*
- *a rebind onto a locator already owned by another root is reported, not silently merged*

**Acceptance:** the module imports nothing from `vscode`; all new tests pass; gates pass; no other source file changed.

**Do not:** wire it into `sqlite.ts` or the repository (Stage 4), add providers, hosts or remote logic, or cache rows in memory.

```
You are implementing Stage 3 of docs/Moriarty_Unified_Index_Evidence_Implementation_Plan.md in /home/stark/source/twinny (branch feature/unified-project-db, base 0ca082a). Do not commit.
Read first: §0, §2.2, Appendix A (the source_root DDL), the Progress Log, Stage 3. Confirm Stage 0 is done.
Do only Stage 3. Satisfy its acceptance criteria, run its gates, update the Progress Log, and finish with the §0.5 report.
```

---

### Stage 4 — Unified project database v20, stable multi-root home and independent evidence

**Depends on:** Stage 3. **[VS Code suite].** **Goal:** one project-local database selected independently of workspace folder order, with evidence that survives TODO/list deletion.

**Read first:** `src/extension/todos/sqlite.ts` (`SCHEMA`, `SqliteFile`, `resolveProjectTodoStorage`, `prepareProjectTodoStorage`, `retireLegacyTodoDatabase`); `SourceRoots`; `workspaceProjectFingerprint` and its production call sites in `chat/index.ts` and `webview/base.ts`; Appendix A as **corrected** by the maintainer-reviewed schema section.

**Changes**
1. Replace the private-development schema/migration ladder with revised v20 DDL, retaining existing transaction/connection helpers. Version 0 initializes, v20 reopens; another version is refused with a safe reset message. No automatic deletion, migrations or unrelated file changes.
2. Implement a shared `resolveProjectHome`: explicit validated machine-scoped `twinny.projectHome` if configured; otherwise saved multi-root `.code-workspace` file directory; single-root folder; otherwise lexicographically smallest normalized local root for unsaved multi-root. Document the unsaved-root membership caveat. Use the same resolver everywhere that opens the project database; do **not** choose `workspaceFolders[0]` in multi-root windows.
3. Register home and all local workspace roots, idempotently, in `source_root`. Use one project key per database, not folder-set hash. Preserve source-root identity when moving an entire project home, without silently merging two distinct databases.
4. Ensure observations, retained tool content, accepted facts and source references have project lifetime. Originating task and list IDs are optional provenance, not deleting FKs. The source records' observation FK remains intact.
5. Keep `prepareProjectTodoStorage`, `.gitignore`, existing unrelated legacy retirement safety and guarded database reset. The storage-location setting must not widen native-tool filesystem permissions.

**Tests:** exact revised DDL objects and FKs, FTS5, two connections, newer/older invalid versions left byte-for-byte intact, project move/reopen, stable DB identity and root registrations when folders are reordered, override and saved multi-root home resolution, empty/unsupported workspace errors, project isolation, **task/list deletion retains observations, retained text, source references and accepted facts**, legacy safety tests.

**Acceptance:** all gates and VS Code suite pass or exact NOT RUN recorded; no first-root identity dependency, no project evidence deletion cascade. Regenerate Appendix A object-count tests from actual revised DDL.

```
Implement Stage 4 of docs/Moriarty_Unified_Index_Evidence_Implementation_Plan.md. Read §0, the maintainer corrections, §2, Stage 4, Appendix A and the Progress Log. Do only Stage 4; verify stable multi-root identity and evidence retention; run gates and update the log.
```

---

### Stage 5 — Synchronous SQL facade for the index

**Depends on:** 0. **Goal:** a small `vscode`-free module that lets the existing index code keep its `run/get/rows/exec` call shapes while running on `better-sqlite3`, plus a real synchronous `transaction()` and a paged, event-loop-friendly `eachRow`. Nothing consumes it yet.

**Read first:** the helper block at the top of `src/extension/workspace-index/index.ts` (`run`, `get`, `rows`, `eachRow`, `exec`, `closeDatabase`, `openDatabase`); the five `BEGIN IMMEDIATE … COMMIT` blocks and the two `eachRow` call sites in `search()`; `SqliteFile.write` in `todos/sqlite.ts` (it rejects asynchronous work — mirror that).

**Changes — new file `src/extension/workspace-index/sql.ts`** (`import type { Database } from "better-sqlite3"`; no `vscode`, no `sqlite3`):

```ts
export type SqlValue = string | number | null | Buffer
export const run: (db: Database, sql: string, values?: SqlValue[]) => { changes: number; lastInsertRowid: number | bigint }
export const get: <T>(db: Database, sql: string, values?: SqlValue[]) => T | undefined
export const rows: <T>(db: Database, sql: string, values?: SqlValue[]) => T[]
export const exec: (db: Database, sql: string) => void
/** BEGIN IMMEDIATE … COMMIT around a SYNCHRONOUS closure; rolls back on a throw; a closure that returns a promise is rolled back and rejected. */
export const transaction: <T>(db: Database, work: () => T) => T
/** Visits every row of `sql` in `uri` order, 50 rows per page, yielding to the event loop (`setImmediate`) between pages. `sql` must select a `uri` column. */
export const eachRow: <T extends { uri: string }>(db: Database, sql: string, values: SqlValue[], visit: (row: T) => void, pageSize?: number) => Promise<number>
```

Rules: prepared statements are cached per `Database` in a bounded `Map` (clear it when it exceeds 200 entries, so dynamic `IN (?,?,…)` statements cannot grow it without bound); the functions are **synchronous** (callers may keep writing `await run(...)`; do not make them return promises); `eachRow` wraps `sql` as `SELECT * FROM (<sql>) WHERE uri > ? ORDER BY uri LIMIT ?`, binds the caller's values first, and never holds a `better-sqlite3` iterator across an `await`; an exception thrown by `visit` or by SQLite propagates to the caller.

**Tests — new `src/test/standalone/index-sql.standalone.ts`** (in-memory database):

- *run, get, rows and exec return plain values and reuse prepared statements*
- *transaction commits its writes and rolls back everything when the closure throws*
- *transaction rejects a closure that returns a promise and leaves nothing written*
- *eachRow visits every row once, in uri order, across page boundaries (page size 2 over 5 rows), with the caller's bound parameters*
- *eachRow yields to the event loop between pages* (a `setImmediate` scheduled before the call runs before the last page is visited)
- *eachRow propagates an error thrown by the visitor and by an invalid query*

**Acceptance:** module is `vscode`-free; tests pass; gates pass; no other file changed.

**Do not:** edit `workspace-index/index.ts` here, add a connection pool, or expose an iterator API.

```
You are implementing Stage 5 of docs/Moriarty_Unified_Index_Evidence_Implementation_Plan.md in /home/stark/source/twinny (branch feature/unified-project-db, base 0ca082a). Do not commit.
Read first: §0, §2.1, the Progress Log, Stage 5. Confirm Stage 0 is done.
Do only Stage 5. Satisfy its acceptance criteria, run its gates, update the Progress Log, and finish with the §0.5 report.
```

### Stage 6 — Port the workspace index onto the project database

**Depends on:** 4, 5. **[VS Code suite]** (touches `workspace-index/index.ts`, `src/index.ts`).
**Goal:** `WorkspaceIntelligenceIndex` keeps its data in `<home>/.twinny/project.sqlite` through `SqliteFile` and the Stage 5 facade instead of `globalStorage/workspace-index.sqlite` through `sqlite3`. Search behaviour, ranking, results and the status bar do not change. No refresh API yet.

**Read first:** all of `src/extension/workspace-index/index.ts` (constructor, `start`, `search`, `dispose`, `initialize`, `open`, `migrateFingerprints`, the five transaction blocks, `removeDocument`, `storeSymbols`, `measureDatabaseSize`); `src/index.ts` (index construction near the top of `activate`, `deactivate`); `currentProjectTodoStorage` in `webview/base.ts`; `src/test/suite/workspace-index.test.ts`; Stage 5's `sql.ts`; the index tables in Appendix A.

**Changes**

1. **`todos/sqlite.ts`:** add `get filePath(): string` to `SqliteFile` (the resolved path; valid after the first open).
2. **New `src/extension/todos/project-storage.ts`** (imports `vscode`): move `currentProjectTodoStorage` here from `webview/base.ts` (export it) and import it back in `base.ts`.
3. **`src/index.ts`:** construct the index with `new WorkspaceIntelligenceIndex(async () => prepareProjectTodoStorage(currentProjectTodoStorage()))`. After construction, if `<globalStorage>/workspace-index.sqlite` exists, `logger.info` once that it is no longer used and can be deleted. **Do not delete it.**
4. **`workspace-index/index.ts`:**
   - Constructor takes `location: SqliteLocation` (from `../todos/sqlite`) instead of `storageUri`; create `private readonly file = new SqliteFile(location)`. Remove the `databasePath` getter, `import sqlite3`, the helper block (`run/get/rows/eachRow/exec/closeDatabase/openDatabase`) and the index's own `SCHEMA` constant; import `eachRow, exec, get, rows, run, transaction, SqlValue` from `./sql` and the `Database` type from `../todos/sqlite`.
   - `open()`: `const database = await this.file.read((db) => db)`; then `database.pragma("synchronous = NORMAL")`, `cache_size = -8192`, `mmap_size = 0`, `temp_store = FILE`. **Delete:** `fs.mkdir(storageUri)`, `configure("busyTimeout")`, every `PRAGMA user_version` read/write (the version now belongs to `sqlite.ts` — the old index schema ended with `PRAGMA user_version=3`, which would corrupt the shared version), `exec(SCHEMA)`, the two `ALTER TABLE documents ADD COLUMN` checks, the lazy `CREATE VIRTUAL TABLE documents_fts` try/catch (set `this.state.fts5 = true`; leave the `fts5`-conditional branches alone) and the second read-only `reader` connection with its field and lifecycle. Replace every `this.reader!` with `this.database!`; `initialize()` succeeds when `this.database` is set.
   - Convert the five `BEGIN IMMEDIATE … COMMIT/ROLLBACK` blocks (`flushPendingDeletes` batch, scan sweep, `indexFile` write, `cacheSymbols`, `storeSkipped`) to `transaction(this.database!, () => { … })` with **synchronous closures**: inside them no `await`; all awaited work (file reads, hashing, symbol provider) stays outside. Make `removeDocument` and `storeSymbols` synchronous (each has exactly one caller, inside a transaction). Keep `withWrite` (it still orders writes against scans). Leave the `await`s on `run/get/rows` calls outside transactions as they are (the facade is synchronous; awaiting a plain value is harmless).
   - `search()` content scan keeps using `eachRow` (now the paged facade; the existing queries already select `uri`).
   - `dispose()`: after pending work settles, `this.file.close()`. `measureDatabaseSize` uses `this.file.filePath`.
   - **No project folder:** add `private projectAvailable(): boolean` (`workspaceFolders?.[0]?.uri.scheme === "file"`). `start()` and `synchronize()` set status `not-initialized` and return quietly when false; `search()` returns `{ results: [], total: 0 }`; nothing throws and no error is logged.
   - Resolve the database path once at `initialize()`; changing the first workspace folder takes effect after a window reload (Appendix D, JC-3).

**Tests**

- Update `workspace-index.test.ts`: the two constructor calls pass `path.join(storage, "project.sqlite")`; the `twinny-state.sqlite` sentinel stays and now proves *the index leaves unrelated files in its storage directory alone*. All other existing assertions stay.
- **[VS Code suite]** add: *the index lives in the project database: after rebuild the file holds indexed documents and `PRAGMA user_version` is 20* (open it read-only with `better-sqlite3`); *deleting the database files and rebuilding recreates the index tables and the TODO tables* (also asserts a `TodoRepository` on the same path works afterwards).
- Standalone, in `todos-sqlite.standalone.ts`: *the index tables and the TODO tables coexist in one database and two connections can read and write both* — a `TodoRepository` and a second `SqliteFile` on the same path; write a `documents` row with `transaction()` from `sql.ts`, create a TODO item through the repository, read each from the other connection.

**Acceptance criteria**

- `grep -n "sqlite3\|BEGIN IMMEDIATE\|this.reader\|user_version" src/extension/workspace-index/index.ts` returns nothing; `grep -rn "from \"sqlite3\"" src` returns nothing (the package itself stays until Stage 16).
- All existing `workspace-index.test.ts` tests pass with only the named updates; all gates pass including the VS Code suite (or the recorded `NOT RUN`).

**Do not:** change search ranking or result shape, add the refresh API (Stage 7), delete the old global database, or hold a transaction across an `await`.

```
You are implementing Stage 6 of docs/Moriarty_Unified_Index_Evidence_Implementation_Plan.md in /home/stark/source/twinny (branch feature/unified-project-db, base 0ca082a). Do not commit.
Read first: §0, §1, §2.1, Appendix A (index tables), Appendix B (index map), the Progress Log, Stage 6. Confirm Stages 4 and 5 are done.
Do only Stage 6. Satisfy its acceptance criteria, run its gates (including the VS Code suite or record NOT RUN with the error), update the Progress Log, and finish with the §0.5 report.
```

---

### Stage 7 — Index `refresh()` API and index fixes

**Depends on:** 6. **[VS Code suite].** **Goal:** an awaited, targeted refresh the native tools can call, plus the two index defects that would otherwise break it.

**Read first:** `indexFile`, `storeSkipped`, `recordFailure`, `removeDocument`, `folderFor`, `isEligibleUri`, `refreshCounts`, the scan loop (where `scanId` is created and the sweep runs), `flushPendingUris`/`handleFileChange` in `workspace-index/index.ts`; `WorkspaceSearchProvider` and `EditOutcome` in `tools/workspace.ts`.

**Changes**

1. **`tools/workspace.ts`** (types only):
   ```ts
   export interface IndexChange { path: string; kind: "write" | "delete" }   // path: absolute file-system path
   export type IndexRefreshOutcome = { status: "synced" } | { status: "skipped"; reason: string } | { status: "failed"; reason: string }
   ```
   Add optional `refresh?(changes: readonly IndexChange[]): Promise<IndexRefreshOutcome>` to `WorkspaceSearchProvider`, and `indexRefresh?: IndexRefreshOutcome` to `EditOutcome`.
2. **`workspace-index/index.ts`:**
   - **Defect fix 1 — skip rows are swept:** the three `storeSkipped(…)` calls inside `indexFile` (oversized, invalid UTF-8, binary) omit `scanId`, so the end-of-scan sweep (`scan_id IS NULL OR scan_id <> ?`) deletes the skip rows. Pass `scanId` in all three.
   - `indexFile` returns `"indexed" | "skipped" | "failed" | "cancelled"` instead of a boolean (the unchanged-fingerprint fast path is `"indexed"`); update its callers so existing counters behave exactly as before.
   - **Defect fix 2 — scan/refresh races:** keep `private activeScanId?: string` (set when a scan starts, cleared when it ends); `refresh` stamps the rows it writes with it, so a file created after the scan enumerated its folders is not swept. Inside the write transaction of `indexFile`, if the existing row's `mtime_ms` is **newer** than the `mtime` just read, leave it alone (a slower scan must not overwrite a newer refresh).
   - `async refresh(changes)`: `indexing.enabled` false → `skipped("indexing is disabled")`; `!projectAvailable()` → `skipped("no project database")`; otherwise `await this.initialize()` and **never wait for a running scan**. For each distinct path: `folderFor(uri)` undefined → `skipped("outside the indexed workspace folders")`; `kind: "delete"` → remove the document (file or tree) and its FTS/symbol rows in one transaction → synced (also when no row existed); `kind: "write"` and not `isEligibleUri` (excluded, ignored, oversized limits handled by `indexFile`) → remove any active row, `skipped("excluded from the index")`; otherwise `indexFile(uri, algorithm, signal, this.activeScanId)` where `"indexed"`/`"skipped"` → synced (a skip row is a current entry), `"failed"` → `failed(<documents.error or "could not be indexed">)`, `"cancelled"` → `failed("the refresh was cancelled")`. Call `refreshCounts()` once at the end. Aggregate: any failed → `{ status: "failed", reason: "<path>: <reason>; …" }`; else any synced → synced; else skipped (first reason). Never throw: wrap in try/catch and return `failed(message)`.
   - `refresh` ignores `automaticSyncEnabled()` (that gate belongs to the watchers) but honours `indexing.enabled`. Watcher events for the same files keep working and become no-ops through the fingerprint fast path.

**Tests (VS Code suite, `workspace-index.test.ts`)**

- *refresh makes an edited file searchable immediately, with no polling* (write the file on disk with a new unique token, `await index.refresh(...)`, search at once: new token found, old token gone).
- *refresh of a created file finds it at once and refresh of a deleted file removes it at once* (path search and content search).
- *refresh does not wait for a running scan and a refreshed new file survives that scan's sweep* (start `rebuild()` without awaiting; create 300 small files in the temp root beforehand so the scan lasts; create one more file after `discoveryComplete` is true; `refresh` it; await the rebuild; the file is still indexed).
- *refresh is skipped with a reason outside the indexed folders and when indexing is disabled*.
- *a refresh of a missing file written as "write" reports failed with a reason*.
- *oversized, binary and non-UTF-8 files keep their skip rows after a full scan* (regression for defect fix 1: `SELECT COUNT(*) FROM documents WHERE skip_reason IS NOT NULL` equals the skipped count the state reports).
- *a slower scan never overwrites a newer refreshed entry* (unit-level through the public API: refresh a changed file, then re-run a scan that read the older mtime is not reproducible deterministically — instead assert the guard by writing a document row with a newer `mtime_ms` through the database and calling `refresh` on the unchanged older file; the row must keep the newer `mtime_ms`).

**Acceptance criteria:** the API and types exist and are exercised by the tests above; defect fixes proven by their regression tests; gates pass including the VS Code suite (or recorded `NOT RUN`).

**Do not:** wire any tool to `refresh` yet; add debouncing or queues; change watcher behaviour.

```
You are implementing Stage 7 of docs/Moriarty_Unified_Index_Evidence_Implementation_Plan.md in /home/stark/source/twinny (branch feature/unified-project-db, base 0ca082a). Do not commit.
Read first: §0, §2.5, Appendix B (index map), the Progress Log, Stage 7. Confirm Stage 6 is done.
Do only Stage 7. Satisfy its acceptance criteria, run its gates (including the VS Code suite or record NOT RUN with the error), update the Progress Log, and finish with the §0.5 report.
```

---

### Stage 8 — Synchronous refresh: `edit_lines` and `edit_file`

**Depends on:** 7. **[VS Code suite].** **Goal:** when `edit_lines` (or legacy `edit_file`) persisted a change — including when a catastrophic-edit rollback restored the file — the index matches disk **before the tool returns**, and a refresh failure is reported accurately.

**Read first:** `editorEdits` in `chat/tool-sinks.ts` (`EditSafetyOptions`, `checkedOutcome`, `beginEdit`, `settleEdit`, the `editLines` and `edit` methods); the `editLines` and `editFile` tools in `tools/workspace.ts`; the safety wiring block in `chat/index.ts` (`const safety = { … }` near `workspaceTools(view, [], {`); `line-edit.test.ts` (ledger and rollback test patterns).

**Changes**

1. `chat/tool-sinks.ts`: add `refreshIndex?: (changes: readonly IndexChange[]) => Promise<IndexRefreshOutcome>` to `EditSafetyOptions`. Add a local helper in `editorEdits`:
   ```ts
   const refreshed = async (files: string[], outcome: EditOutcome): Promise<EditOutcome>
   ```
   that returns `outcome` unchanged when `safety.refreshIndex` is absent; otherwise awaits `safety.refreshIndex(files.map((path) => ({ path, kind: "write" })))` (a thrown error becomes `{ status: "failed", reason }`), logs a warning on `failed`, and returns `{ ...outcome, indexRefresh }` when `outcome.ok`.
2. **`editLines` sink:** after `checkedOutcome(file, outcome)` and **before** `settleEdit(...)`: if the raw command outcome was `ok` and `persisted !== false`, refresh `[file]` (this covers success **and** a rollback that restored the file, whose restored content must be what the index holds). Attach `indexRefresh` to `checked` only when `checked.ok`. Do not refresh when the command outcome was not ok, when the hash check refused the edit, or when the edit was left unsaved (`save: false`).
3. **`edit` sink (legacy `edit_file`):** same placement, only in `apply` mode when the command outcome is `ok` and not `pending`.
4. `chat/index.ts`: add `refreshIndex: this._workspaceSearch?.refresh?.bind(this._workspaceSearch)` to the `safety` object.
5. `tools/workspace.ts`:
   - `edit_lines` success JSON: when `outcome.indexRefresh?.status === "failed"`, add `index_refresh: { status: "failed", reason }` and append to `message`: ` Saved, but the search index could not be refreshed (<reason>); the edit is complete and must not be repeated. search_workspace may show stale results for this file until the index recovers.` For `synced`, `skipped` or absent the output is **byte-for-byte unchanged**. The result stays a success (`failed` unset).
   - `edit_file`: append the same sentence to `outcome.message` when failed.
6. The new whole-file hash is already returned by `edit_lines` (`content_hash`); change nothing in the hash protocol.

**Tests**

- Standalone (`chat-tools.standalone.ts`, fake `EditSink`): *edit_lines reports an index refresh failure as a completed edit and tells the model not to repeat it* (`ok: true`, `index_refresh`, the sentence, `failed` unset); *a synced or skipped refresh leaves the edit_lines output unchanged* (deepEqual against the same outcome without `indexRefresh`); *edit_file appends the same sentence on a failed refresh*.
- **[VS Code suite]** in `line-edit.test.ts` (real `editorEdits`, fake `refreshIndex`, fake ledger): *refreshIndex runs once with the edited file after a successful edit_lines and before the ledger settles* (record call order); *a stale expected_hash does not refresh and leaves file and index untouched*; *two edit_lines from the same expected_hash: the second conflicts and only one refresh happens*; *after a catastrophic-edit rollback refreshIndex sees the restored content on disk* (the fake reads the file when called and compares it with the original); *an unsaved edit (save false) does not refresh*.
- **[VS Code suite]** in `workspace-index.test.ts`: *edit_lines is visible to search_workspace immediately after it returns* — real index, `editorEdits(view, "apply", approve, undefined, { refreshIndex: index.refresh.bind(index) })`, `workspaceTools(root, [], { workspaceSearch: index, edits })`: `read_file`, `edit_lines` adding a unique token, then **at once** `search_workspace` finds the new token and not the replaced one (no polling helper).

**Acceptance criteria:** `grep -n "refreshIndex" src/extension/chat/tool-sinks.ts` shows the option and the two call sites; the tests above pass; existing `line-edit` and `agent-reply` tests pass unchanged; gates including the VS Code suite (or recorded `NOT RUN`).

**Do not:** put the refresh in the tool layer, debounce it, repeat the filesystem edit on refresh failure, or change `expected_hash` handling.

```
You are implementing Stage 8 of docs/Moriarty_Unified_Index_Evidence_Implementation_Plan.md in /home/stark/source/twinny (branch feature/unified-project-db, base 0ca082a). Do not commit.
Read first: §0, §2.4, §2.5, the Progress Log, Stage 8. Confirm Stage 7 is done.
Do only Stage 8. Satisfy its acceptance criteria, run its gates (including the VS Code suite or record NOT RUN with the error), update the Progress Log, and finish with the §0.5 report.
```

### Stage 9 — Synchronous refresh: `create_file`, `delete_file`, `move_file`

**Depends on:** 8. **[VS Code suite].** **Goal:** the three file-level mutations refresh the index before returning; `create_file` and `move_file` also return the resulting whole-file hash (`delete_file` has none).

**Read first:** the `create`, `remove` and `move` methods in `chat/tool-sinks.ts`; `createFile` in `tools/workspace.ts`; `deleteFile` and `moveFile` in `tools/more.ts` (they accept **files**, not directories); `fingerprint.ts` (`contentHash`/`fingerprintContent`).

**Changes**

1. **`create` sink:** in `apply` mode, after `checkedOutcome` and before `settleEdit`, when the command outcome is `ok` and not `pending`: refresh `[{ path: file, kind: "write" }]` via the Stage 8 helper, then read the saved file back from disk, decode it as UTF-8 (BOM stripped, as the index does), and set `contentHash` (via `contentHash(text)`), `contentSource: "disk"` and `persisted: true` on the outcome. A failed read-back leaves the hash unset; it never turns a successful create into a failure. Review-mode (pending, unsaved) creates are **not** refreshed.
2. **`remove` sink:** after `applied` and `markChanged`, refresh `[{ path: file, kind: "delete" }]` and attach `indexRefresh` to the success outcome.
3. **`move` sink:** after `applied` and `markChanged`, refresh `[{ path: from, kind: "delete" }, { path: to, kind: "write" }]` (**both** paths) and return the unchanged whole-file hash of `to` read from disk as `contentHash`.
4. **Tools** (additive text only; unchanged when nothing new is present):
   - `create_file` appends `\ncontent_hash: <hash>; total_lines: <linesOf(content).length>` to `output` when `outcome.contentHash` is set.
   - `move_file` appends `\ncontent_hash: <hash> (unchanged by the move)` when `outcome.contentHash` is set.
   - All three append, when `outcome.indexRefresh?.status === "failed"`: `Saved, but the search index could not be refreshed (<reason>); the change is complete and must not be repeated.`

**Tests**

- Standalone (`chat-tools.standalone.ts`, `more-tools.standalone.ts`, fake sinks): hash lines present only when the sink returns a hash (`create_file`, `move_file`); the failure sentence for each of the three tools; success output unchanged without `indexRefresh`.
- **[VS Code suite]** (`line-edit.test.ts` for the sinks with a fake `refreshIndex`; `workspace-index.test.ts` with the real index): *create_file is searchable at once, by path and by content, and returns the hash of the saved file* (equals `fingerprintContent` of the file text); *delete_file removes the entry at once and no `documents` row remains*; *move_file: the old path and content are gone and the new path and content are found at once, and the returned hash equals the file's hash*; *a review-mode create does not refresh*; the existing delete/move approval tests pass unchanged.

**Acceptance criteria:** tests above pass; `grep -n "refreshIndex\|refreshed(" src/extension/chat/tool-sinks.ts` shows call sites for `editLines`, `edit`, `create`, `remove`, `move`; gates including the VS Code suite (or recorded `NOT RUN`).

**Do not:** add directory support, change approval/checkpoint behaviour, or delete evidence.

```
You are implementing Stage 9 of docs/Moriarty_Unified_Index_Evidence_Implementation_Plan.md in /home/stark/source/twinny (branch feature/unified-project-db, base 0ca082a). Do not commit.
Read first: §0, §2.4, §2.5, the Progress Log, Stage 9. Confirm Stage 8 is done.
Do only Stage 9. Satisfy its acceptance criteria, run its gates (including the VS Code suite or record NOT RUN with the error), update the Progress Log, and finish with the §0.5 report.
```

---

### Stage 10 — Synchronous refresh: `rename_symbol`

**Depends on:** 8. **[VS Code suite].** **Goal:** a symbol rename refreshes every file it touched before returning and reports each file's new whole-file hash.

**Read first:** the `rename` method of `editorEdits`/`editorKnowledge` in `chat/tool-sinks.ts` (the inner `rename()` closure: checkpoints, `applyAndSave`, diagnostics baseline, catastrophic rollback, `renameFailure`), the `EditorSink.rename` type and `renameSymbol` in `tools/more.ts`.

**Changes**

1. `tools/more.ts`: `EditorSink.rename` returns `Promise<EditOutcome & { files?: string[]; fileHashes?: Record<string, string> }>` (`fileHashes` keyed by canonical path = the strings already in `files`).
2. Sink `rename`: set a flag `attempted = true` immediately before `applyAndSave(edit!)`. After the inner closure completes (applied **or** rolled back), if `attempted`, refresh **all** `absoluteFiles` as `write` through the Stage 8 helper. On success (`ok: true`) read each file back from disk, compute `contentHash` of its decoded text, and return `{ ok: true, files, fileHashes, message, indexRefresh }`. On failure/rollback keep today's failure result (log a warning if the refresh failed; the failure message does not change).
3. `rename_symbol` tool: after `outcome.message` add one line per file `content_hash(<path>): <hash>` (at most 20, then `… and N more files`), then the Stage 9 failure sentence when `indexRefresh.status === "failed"`. Output is unchanged when `fileHashes` and `indexRefresh` are absent.

**Tests**

- Standalone (`more-tools.standalone.ts`, fake sink): per-file hash lines, the 20-file cap, the failure sentence, unchanged output without the new fields.
- **[VS Code suite]** (`line-edit.test.ts`): register a throw-away rename provider with `vscode.languages.registerRenameProvider` for a test-only file pattern that returns a `WorkspaceEdit` changing **two** files; with a fake `refreshIndex` assert it receives both files (`write`) after the rename and that the files on disk already hold the new text when it is called; a rollback case (the existing catastrophic-diagnostics pattern) refreshes the restored files. If the harness cannot run a rename provider, keep the fake-sink standalone tests, record the limitation in the report, and do not weaken the assertion.

**Acceptance criteria:** the above tests pass; no change to the rename approval, checkpoint or rollback logic; gates including the VS Code suite (or recorded `NOT RUN`).

**Do not:** refresh before `applyAndSave` ran, or alter `files: string[]`'s meaning.

```
You are implementing Stage 10 of docs/Moriarty_Unified_Index_Evidence_Implementation_Plan.md in /home/stark/source/twinny (branch feature/unified-project-db, base 0ca082a). Do not commit.
Read first: §0, §2.4, §2.5, the Progress Log, Stage 10. Confirm Stage 8 is done.
Do only Stage 10. Satisfy its acceptance criteria, run its gates (including the VS Code suite or record NOT RUN with the error), update the Progress Log, and finish with the §0.5 report.
```

---

### Stage 11 — Independent project observations and source references

**Depends on:** Stages 1a, 4, 8, 9, 10. **[VS Code suite].** **Goal:** retain project evidence regardless of conversation/TODO plan existence, including actual file source references and disk/buffer origin.

**Read first:** `recordToolObservation`, `TodoToolObservationInput`/`TodoToolObservation`, `preserveEvidence`, `getReviewPackages`, `listIntentEvidence`, `SourceRoots`, and `onToolResult` in `chat/index.ts`.

**Changes**
1. Store `project_id`, a durable observation ID, tool name, structured args, tool output, failure status, execution/request metadata, optional list/task/conversation provenance and references to retained evidence. A task ID or TODO plan is **not required**. Preserve request-id idempotency, including observations without list IDs; prefer unique project+request IDs where request IDs are globally unique.
2. Insert `observation_source` rows from authoritative native reads and structured mutations: source root, actual path, relevant line range, role (`read`, `modified`, `created`, `deleted`, `moved_from`, `moved_to`), whole-file fingerprint, `observed_version` (`disk`/`buffer`) and optional editor version. Include both paths of moves and every known rename target. Do not fabricate file hashes for a command with unknown side effects.
3. Extract a reusable `recordToolResult` implementation from the live `onToolResult` path; continue existing security/declination handling. With a valid project repository, capture eligible tool results when there is no active TODO and even in chats with **no TODO plan**. Never fabricate a TODO to justify observation storage.
4. Expose project-wide candidate observations to Feedback and evidence lookup regardless of which task or conversation saw them. Retain source and provenance; matching target, success and criterion decide proof. Stage 12 supplies automatic validity on every repository result.
5. Do not let task/list deletion erase the project observation, retained output, source references or accepted fact. Write actual foreign-key tests.

**Tests:** no-plan capture via real hook, unowned project observation, cross-TODO/cross-conversation project reuse, correct source path/range/hash for full and partial reads, external paths, buffer vs disk provenance, both sides of move, deduped tool-result replay, list/task deletion survival, successful matching mutation vs unrelated/failed record. Existing agent-reply suite must pass.

**Acceptance:** independent evidence lifetime and project-wide retrieval work, with no criterion auto-satisfied merely by observation existence. Run all gates and VS Code integration tests.

```
Implement Stage 11 of docs/Moriarty_Unified_Index_Evidence_Implementation_Plan.md. Read §0, maintainer corrections, §2, Stage 11 and the Progress Log. Do only Stage 11; prove no-plan capture, cross-task relevance and deletion survival; run gates and update the log.
```

---

### Stage 12 — Automatic validity on every file-backed evidence boundary

**Depends on:** Stages 1, 1a, 4, 11. **[VS Code suite].** **Goal:** file source validity checked centrally whenever evidence is stored or retrieved.

**Read first:** `CurrentSourceReader`, `assessAcceptedFacts`, `evidencePreflight`, `twinny_evidence_lookup`, `WorkspaceView` file reads, Stage 11 observation/source repository APIs and existing freshness tests.

**Changes**
1. Implement a shared source-reference validity service in the project evidence repository. Use current authoritative source text and `fingerprintContent`, never trust stale indexed text. Consumers do **not** opt in to correctness by passing a reader callback.
2. Validate each file reference during **storage** and **retrieval** of observations, retained source-backed evidence and reusable accepted facts. Apply the boundary to project-wide lookup, preflight and Feedback packages. Return per-reference and aggregate validity, not just an accepted-fact-specific `freshness` field.
3. For matching whole-file hash return `valid`; changed hash `stale`; missing file `invalid`; restoring matching content `valid` again. Multi-file aggregate: invalid > stale > valid. Preserve every historical record. Normal I/O errors are errors, not `invalid`; non-file tool results receive no invented file hash.
4. Respect the original source kind: `disk` observations validate against disk, `buffer` observations validate against the current unsaved editor buffer if open, otherwise disk. Track editor version when available. A buffer-only read cannot certify a persisted edit.
5. Reuse/extend existing accepted-fact freshness logic rather than introducing another independent cache. Preserve compatible `freshness` fields, but ensure central source checks underpin them.

**Tests:** valid → stale → invalid → restored valid on original record; same behavior on accepted facts; per-file and aggregate multi-source flags; correct validation through every public evidence API plus lookup/preflight/Feedback; external authorized paths; unsaved buffer vs saved disk, buffer close; invalid file vs unreadable-file error; project evidence survives task/list deletion; unknown `run_command` side effects not hashed; no model-side hash comparisons. Run VS Code suite and all gates.

```
Implement Stage 12 of docs/Moriarty_Unified_Index_Evidence_Implementation_Plan.md. Read §0, maintainer corrections, §2, Stage 12 and the Progress Log. Do only Stage 12; prove centralized validity across all evidence paths; run gates and update the log.
```

---

### Stage 13 — Moves, renames and relocation candidates

**Depends on:** 6, 11, 12. **Goal:** historical references stay exactly as recorded when a file moves; the shared database can propose where the content went. A matching hash elsewhere is a **candidate only**.

**Read first:** `observationSources` (Stage 11), `documents` in Appendix A, `SourceRoots.locate/canonicalPath` (Stage 3), `twinny_evidence_lookup` (Stage 12).

**Changes**

1. `repository.findRelocationCandidates(reference: { path: string; contentHash: string }): Promise<{ path: string; source: "recorded_move" | "matching_hash" }[]>`, in one read:
   - `recorded_move`: observations whose `observation_source` has a `moved_from` row for the reference's `(root, path)` → the `moved_to` rows of the same observation.
   - `matching_hash`: `SELECT uri FROM documents WHERE fingerprint = ? AND skip_reason IS NULL AND error IS NULL LIMIT 20` → `uri` → absolute path (decode the `file:` URI without `vscode`) → `canonicalPath(locate(absolute))`.
   - Exclude the reference's own canonical path; deduplicate; return at most 5; never pick one. Identical files at different paths are separate candidates.
2. `twinny_evidence_lookup`: for facts whose `validity` is `invalid` or `stale`, add `relocation_candidates: [{ path, source }]` and extend the `refresh` hint with "if the file moved, read a candidate to confirm; this fact keeps its original path as history". **Never modify** `todo_accepted_evidence` or `observation_source` rows.

**Tests (standalone; real repository and real `documents` rows written through `sql.ts`)**

- *a moved file's evidence keeps its original reference, becomes invalid, and the new path is offered as a relocation candidate* (accepted fact → rename the file on disk → insert/update the `documents` row as the index would → lookup shows `invalid` + candidate; the fact's `path` and the `observation_source` rows are unchanged).
- *identical files at different paths are separate candidates and none is selected*.
- *a recorded move links the old and new paths even when the index has no row*.
- *the reference's own path is never its own candidate*.
- **[VS Code suite]** (optional if the harness allows): `move_file` through the real index, then `findRelocationCandidates` returns the new path because the refresh already wrote its fingerprint.

**Acceptance criteria:** the tests above pass; gates pass.

**Do not:** rewrite historical paths, auto-select a candidate, or search the filesystem for hashes (the index is the only source).

```
You are implementing Stage 13 of docs/Moriarty_Unified_Index_Evidence_Implementation_Plan.md in /home/stark/source/twinny (branch feature/unified-project-db, base 0ca082a). Do not commit.
Read first: §0, §2.6, the Progress Log, Stage 13. Confirm Stages 6, 11 and 12 are done.
Do only Stage 13. Satisfy its acceptance criteria, run its gates, update the Progress Log, and finish with the §0.5 report.
```

### Stage 14 — `grep` under authorized external directories

**Depends on:** 1, 1a. **Goal:** `grep` with a `path` under an authorized external directory (or a single external file) searches it instead of silently returning nothing. `list_dir` already works through `entries()`; `search_workspace`, `find`-style tools and `files()` stay workspace/index-only.

**Read first:** the `grep` tool in `tools/workspace.ts` (`scope = view.relative(view.resolve(dir, "any"))`, the `view.files()` loop), `WorkspaceView.walk()`/`entries()`/`ignoredAt()` (Stage 1).

**Changes**

1. `WorkspaceView.filesUnder(target: string, limit = 5000): Promise<string[]>`: `target` is an absolute path already returned by `resolve()`. A file → `[target]`. A directory → depth-first walk using `fs.promises.readdir`, skipping entries `ignoredAt(...)` hides and anything that is not a regular file (symbolic links are never followed), stopping after `limit` files; returns sorted absolute paths. Every regular file qualifies (no extension allow-list); `text()` already skips binary and oversized files.
2. `grep`: `const target = dir ? view.resolve(dir, "any") : undefined`. When `target` is defined and `view.isExternal(target)`, iterate `await view.filesUnder(target)` instead of `view.files()`; `scope` is the external absolute path and the existing prefix test (`rel === scope || rel.startsWith(scope + "/")`) works because `view.relative()` returns absolute paths for external files. If the walk hit its limit, add the note `… stopped early: only the first 5000 files were searched; narrow the path`. In-workspace behaviour is untouched.

**Tests (standalone, `tool-safety.standalone.ts` / `chat-tools.standalone.ts`)**

- *grep finds lines under an authorized external directory and prints absolute paths*; *grep of a single external file works*; *grep skips .git and node_modules inside an external directory*; *grep of an unauthorized directory is refused*; `filesUnder(dir, 3)` stops at the limit and never follows a symlink; all existing grep tests pass unchanged.

**Acceptance criteria:** tests pass; gates pass.

**Do not:** make `files()`/`allFiles()` external-aware, follow symlinks, or search outside authorized roots.

```
You are implementing Stage 14 of docs/Moriarty_Unified_Index_Evidence_Implementation_Plan.md in /home/stark/source/twinny (branch feature/unified-project-db, base 0ca082a). Do not commit.
Read first: §0, §2.3, the Progress Log, Stage 14. Confirm Stage 1 is done.
Do only Stage 14. Satisfy its acceptance criteria, run its gates, update the Progress Log, and finish with the §0.5 report.
```

---

### Stage 15 — Canonical paths in search results (required)

**Depends on:** 4, 6. **[VS Code suite].** Required. Multi-root search hits must be usable directly by native read/edit tools. Today a multi-root hit may be displayed as `<folderName>/<relative>`, which `read_file` cannot resolve.

**Changes (`workspace-index/index.ts`)**: replace the two display-path computations (`folders.length > 1 ? \`${folder.name}/${relative}\` : relative`, one in the scan loop and one in `indexFile`) with one helper `canonicalDisplayPath(uri)`: home = the first workspace folder; a file under home → home-relative POSIX path; any other file → its absolute POSIX path. `documents.relative_path`, the FTS column and every search hit use it. Do not touch `workspace_uri` or the scope filters.

**Tests (`workspace-index.test.ts`)**: change the path-mode assertion `index-main/src/extension/**/*.ts` to `src/extension/**/*.ts` (home is `index-main`); assert the second root's hit path equals the absolute `<secondRoot>/src/other.ts` and that an absolute-path glob finds it; add *a search hit from a second workspace folder can be read with read_file* (take `hit.path`, run `read_file` through `workspaceTools` built on a `WorkspaceView(root, [], undefined, [], [secondRoot])`).

**Acceptance criteria:** the updated assertions and the new round-trip test pass; gates including the VS Code suite (or recorded `NOT RUN`).

**Do not:** keep both display forms, or change single-root output (it is already home-relative).

```
You are implementing Stage 15 of docs/Moriarty_Unified_Index_Evidence_Implementation_Plan.md in /home/stark/source/twinny (branch feature/unified-project-db, base 0ca082a). Do not commit.
Read first: §0, §2.2, the Progress Log, Stage 15. Confirm Stages 4 and 6 are done. Stage 15 is mandatory.
Do only Stage 15. Satisfy its acceptance criteria, run its gates (including the VS Code suite or record NOT RUN with the error), update the Progress Log, and finish with the §0.5 report.
```

---

### Stage 16 — Cleanup: drop `sqlite3`, changelog

**Depends on:** 6 (run it after 7–15 are done). **Goal:** the callback `sqlite3` driver is gone from the project; the change is documented.

**Changes**

1. `npm uninstall sqlite3` (updates `package.json` and `package-lock.json`). Then `grep -rn "sqlite3" package.json scripts .vscodeignore src` and remove the remaining references that are **only** about the `sqlite3` package: the `sqlite3` entry in `scripts/build.mjs`' externals and the `!node_modules/sqlite3/**` line in `.vscodeignore`. Leave `better-sqlite3` and `node:sqlite` (the gateway) alone.
2. `CHANGELOG.md`: add one entry in the format of the newest section: the workspace search index now lives in `.twinny/project.sqlite` together with TODO and evidence records (the old `.twinny/evidence.sqlite` and the global `workspace-index.sqlite` are no longer used and can be deleted); native edits refresh the search index before they return; accepted evidence is checked against the current file and reported as valid, stale or invalid; `evidence_from` is gone because relevant project-wide evidence can be reused without TODO ownership; new machine-scoped setting `twinny.chatToolsAllowedPaths` lets the chat tools work in folders outside the workspace, for example on a Remote-SSH host; the project database is shared across roots using a stable project home independent of folder ordering.

**Acceptance criteria**

- `grep -rn "sqlite3" package.json scripts .vscodeignore src` shows only `better-sqlite3`/`node:sqlite` matches (none of the bare `sqlite3` package).
- `npm run build`, `npm run build-tests`, lint and `npm run test:sqlite` pass; the VS Code suite passes (or is recorded `NOT RUN`).

**Do not:** remove `better-sqlite3`, touch the gateway's `node:sqlite`, or delete user data.

```
You are implementing Stage 16 of docs/Moriarty_Unified_Index_Evidence_Implementation_Plan.md in /home/stark/source/twinny (branch feature/unified-project-db, base 0ca082a). Do not commit.
Read first: §0, §1, the Progress Log, Stage 16. Confirm Stage 6 is done and Stages 7–15 are done or explicitly skipped.
Do only Stage 16. Satisfy its acceptance criteria, run its gates, update the Progress Log, and finish with the §0.5 report.
```

---

### Stage 17 — Final verification and manual Remote-SSH checklist

**Depends on:** all. **[VS Code suite].** **Goal:** prove the whole plan holds together and record what was not proven. **No new features.**

**Steps**

1. Run every gate in §0.3 and the whole VS Code suite; compare with the Stage 0 baseline (`966` standalone tests plus the tests the stages added; no test removed except the eight named in Stage 4 and the ones rewritten in Stages 2 and 15).
2. **Hash audit (read-only):** `grep -rn "fingerprintContent\|contentHash(" src/extension` — confirm the index (`documents.fingerprint`), `read_file`, `edit_lines`, `create_file`, `move_file`, `rename_symbol` and accepted facts all use `tools/fingerprint.ts`; `grep -rn "createHash(" src/extension` — list the remaining digests (edit ledger `editDigest`, checkpoints, embeddings, command digests) and confirm none is compared with a `content_hash` token.
3. **Mutation audit (read-only):** `grep -n "refreshed(\|refreshIndex" src/extension/chat/tool-sinks.ts src/extension/chat/index.ts` — confirm call sites for `editLines`, `edit`, `create`, `remove`, `move` and `rename`, the `safety.refreshIndex` wiring, and that no other tool mutates files without refreshing (`run_command` is exempt by decision).
4. **Lifecycle audit:** `grep -rn "workspace-index.sqlite\|evidence.sqlite\|twinny-state.sqlite" src` — only the legacy-retirement code, the obsolete-file log line and tests may match.
5. Execute **Appendix C** in a real VSCodium Remote-SSH window if available; otherwise list each step as `NOT RUN`.
6. Write the final summary in the Progress Log: every deviation, every `NOT RUN`, and the Appendix D items the maintainer must confirm.

**Acceptance criteria:** all gates green (or each exception recorded with its exact error); audits 2–4 show no unexplained match; Appendix C executed or explicitly marked not run.

```
You are implementing Stage 17 of docs/Moriarty_Unified_Index_Evidence_Implementation_Plan.md in /home/stark/source/twinny (branch feature/unified-project-db, base 0ca082a). Do not commit.
Read first: §0, §1, §2, Appendix C, Appendix D, the Progress Log, Stage 17. Confirm every earlier stage is done or explicitly skipped.
Do only Stage 17: verify and audit, change no behaviour, update the Progress Log, and finish with the §0.5 report.
```

---

## Appendix A — Schema v20 (the complete DDL for `SqliteFile`)

Paste this as the `SCHEMA` constant in `src/extension/todos/sqlite.ts` (Stage 4), replacing the `source_root` block and its index with `${SOURCE_ROOT_SCHEMA}`. It is the effective v19 schema (extracted from a live database) plus: `todo_tool_observations.item_id` nullable with `ON DELETE SET NULL` and a new `todo_tool_observations_item` index; `source_root`; `observation_source`; and the index tables moved from the old global index database (with a new `documents_fingerprint` index). `PRAGMA foreign_keys = ON` is set per connection, not here.

```sql
CREATE TABLE todo_projects (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE todo_lists (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES todo_projects(id),
  conversation_id TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, conversation_id)
);
CREATE TABLE todo_items (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL REFERENCES todo_lists(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES todo_items(id),
  title TEXT NOT NULL,
  details TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending','in_progress','in_review','blocked','completed','cancelled')),
  verification TEXT NOT NULL CHECK(verification IN ('not_checked','passed','failed','waived')),
  priority TEXT NOT NULL CHECK(priority IN ('low','normal','high','urgent')),
  created_by TEXT NOT NULL CHECK(created_by IN ('user','model')),
  source TEXT NOT NULL DEFAULT 'model' CHECK(source IN ('user','model','intent_compiler')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  blocked_reason TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX todo_items_list_status ON todo_items(list_id, status, created_at);
CREATE TABLE todo_dependencies (
  item_id TEXT NOT NULL REFERENCES todo_items(id) ON DELETE CASCADE,
  depends_on_item_id TEXT NOT NULL REFERENCES todo_items(id) ON DELETE CASCADE,
  PRIMARY KEY(item_id, depends_on_item_id),
  CHECK(item_id != depends_on_item_id)
);
CREATE TABLE todo_events (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL REFERENCES todo_lists(id) ON DELETE CASCADE,
  item_id TEXT REFERENCES todo_items(id) ON DELETE SET NULL,
  list_revision INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL CHECK(actor IN ('user','model','system')),
  request_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX todo_events_list_revision ON todo_events(list_id, list_revision);
CREATE TABLE todo_evidence (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES todo_items(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  result TEXT NOT NULL CHECK(result IN ('observed','passed','failed')),
  created_at TEXT NOT NULL
);
CREATE TABLE todo_requests (
  list_id TEXT NOT NULL REFERENCES todo_lists(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(list_id, request_id)
);
CREATE TABLE todo_intent_plans (
  list_id TEXT PRIMARY KEY REFERENCES todo_lists(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  goal TEXT NOT NULL,
  constraints_json TEXT NOT NULL,
  intent_result_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  answer_json TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE todo_intent_tasks (
  list_id TEXT NOT NULL REFERENCES todo_lists(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  item_id TEXT NOT NULL UNIQUE REFERENCES todo_items(id) ON DELETE CASCADE,
  dependencies_json TEXT NOT NULL,
  criteria_json TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(list_id, task_id)
);
CREATE TABLE todo_tool_observations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES todo_projects(id),
  list_id TEXT,
  item_id TEXT,
  request_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  arguments_json TEXT NOT NULL,
  output TEXT NOT NULL,
  failed INTEGER NOT NULL,
  exit_code INTEGER,
  created_at TEXT NOT NULL,
  list_revision INTEGER,
  execution_id TEXT,
  UNIQUE(project_id, request_id)
);
CREATE INDEX todo_tool_observations_list_revision ON todo_tool_observations(list_id, list_revision);
CREATE INDEX todo_tool_observations_execution ON todo_tool_observations(list_id, execution_id);
CREATE INDEX todo_tool_observations_item ON todo_tool_observations(item_id);
CREATE INDEX todo_tool_observations_project ON todo_tool_observations(project_id, created_at);
CREATE TABLE todo_evaluations (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL REFERENCES todo_lists(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES todo_items(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  task_version INTEGER NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('accept','revise','needs_evidence','blocked')),
  evaluation_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(list_id, request_id)
);
CREATE INDEX todo_evaluations_item ON todo_evaluations(item_id, created_at);
CREATE TABLE todo_tool_evidence (
  observation_id TEXT PRIMARY KEY REFERENCES todo_tool_observations(id) ON DELETE CASCADE,
  list_id TEXT,
  content TEXT,
  retained INTEGER NOT NULL DEFAULT 1,
  complete INTEGER NOT NULL,
  original_chars INTEGER NOT NULL,
  preserved_chars INTEGER NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX todo_tool_evidence_list ON todo_tool_evidence(list_id, retained, created_at);
CREATE TABLE todo_child_proposals (
  list_id TEXT NOT NULL REFERENCES todo_lists(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  parent_id TEXT NOT NULL REFERENCES todo_items(id),
  decision TEXT NOT NULL CHECK(decision IN ('accepted','existing_task','revised','rejected','needs_clarification')),
  item_id TEXT REFERENCES todo_items(id),
  plan_revision INTEGER NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(list_id, request_id)
);
CREATE INDEX todo_child_proposals_fingerprint ON todo_child_proposals(list_id, fingerprint, created_at);
CREATE TABLE todo_accepted_evidence (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES todo_projects(id),
  list_id TEXT,
  plan_id TEXT,
  plan_revision INTEGER,
  item_id TEXT,
  criterion_index INTEGER NOT NULL,
  criterion TEXT NOT NULL,
  observation_id TEXT NOT NULL REFERENCES todo_tool_observations(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  symbol TEXT NOT NULL,
  path TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  source_hash TEXT NOT NULL,
  superseded_by TEXT REFERENCES todo_accepted_evidence(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  registered_tool TEXT
);
CREATE INDEX todo_accepted_evidence_lookup ON todo_accepted_evidence(list_id, symbol, path, superseded_by);
CREATE INDEX todo_accepted_evidence_item ON todo_accepted_evidence(item_id, criterion_index);
CREATE INDEX todo_accepted_evidence_project ON todo_accepted_evidence(project_id, symbol, path);
CREATE INDEX todo_accepted_evidence_observation ON todo_accepted_evidence(observation_id);
CREATE INDEX todo_accepted_evidence_revision ON todo_accepted_evidence(list_id, plan_id, plan_revision);
CREATE TABLE todo_symbol_aliases (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL REFERENCES todo_lists(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  implementation TEXT NOT NULL,
  path TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  observation_id TEXT NOT NULL REFERENCES todo_tool_observations(id) ON DELETE CASCADE,
  source_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX todo_symbol_aliases_tool ON todo_symbol_aliases(tool_name, path);
CREATE INDEX todo_symbol_aliases_list ON todo_symbol_aliases(list_id);
CREATE TABLE todo_requirement_activations (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL REFERENCES todo_lists(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES todo_items(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('activation','renewal')),
  list_revision INTEGER NOT NULL,
  activated_at INTEGER NOT NULL,
  UNIQUE(list_id, request_id)
);
CREATE INDEX todo_requirement_activations_item ON todo_requirement_activations(list_id, item_id, list_revision);
CREATE TABLE todo_edit_operations (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL REFERENCES todo_lists(id) ON DELETE CASCADE,
  item_id TEXT REFERENCES todo_items(id) ON DELETE CASCADE,
  target TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('apply','review')),
  pre_digest TEXT NOT NULL,
  post_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('dispatched','succeeded','failed','reconciled_applied','reconciled_absent','diverged')),
  detail TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  owner_id TEXT
);
CREATE INDEX todo_edit_operations_target ON todo_edit_operations(list_id, target, status);
CREATE TABLE todo_evidence_usage (
  id TEXT PRIMARY KEY,
  fact_id TEXT NOT NULL REFERENCES todo_accepted_evidence(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES todo_projects(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('lookup', 'reuse')),
  created_at TEXT NOT NULL,
  UNIQUE (fact_id, kind, execution_id)
);
CREATE INDEX todo_evidence_usage_project ON todo_evidence_usage(project_id, fact_id);
CREATE TABLE todo_assessments (
  id TEXT PRIMARY KEY,
  list_id TEXT NOT NULL REFERENCES todo_lists(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES todo_items(id) ON DELETE CASCADE,
  evaluation_id TEXT NOT NULL REFERENCES todo_evaluations(id) ON DELETE CASCADE,
  evaluation_request_id TEXT NOT NULL,
  task_version INTEGER NOT NULL,
  result_version INTEGER NOT NULL,
  plan_revision INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('assessed', 'unavailable')),
  progress_score INTEGER CHECK (progress_score BETWEEN 1 AND 5),
  progress_explanation TEXT,
  verification_score INTEGER CHECK (verification_score BETWEEN 1 AND 5),
  verification_explanation TEXT,
  evidence_refs_json TEXT NOT NULL,
  reason TEXT,
  evaluator_provider TEXT NOT NULL,
  evaluator_model TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (list_id, evaluation_request_id, item_id),
  CHECK (
    (status = 'assessed' AND progress_score IS NOT NULL AND progress_explanation IS NOT NULL
      AND verification_score IS NOT NULL AND verification_explanation IS NOT NULL AND reason IS NULL)
    OR (status = 'unavailable' AND progress_score IS NULL AND progress_explanation IS NULL
      AND verification_score IS NULL AND verification_explanation IS NULL AND reason IS NOT NULL)
  )
);
CREATE INDEX todo_assessments_item ON todo_assessments(item_id, created_at);
CREATE TRIGGER todo_assessments_immutable BEFORE UPDATE ON todo_assessments
BEGIN SELECT RAISE(ABORT, 'TODO assessments are immutable'); END;
CREATE TABLE todo_assessment_current (
  item_id TEXT PRIMARY KEY REFERENCES todo_items(id) ON DELETE CASCADE,
  list_id TEXT NOT NULL REFERENCES todo_lists(id) ON DELETE CASCADE,
  assessment_id TEXT NOT NULL REFERENCES todo_assessments(id) ON DELETE CASCADE
);
CREATE INDEX todo_assessment_current_list ON todo_assessment_current(list_id);
CREATE TABLE todo_assessment_reactions (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  list_id TEXT NOT NULL REFERENCES todo_lists(id) ON DELETE CASCADE,
  assessment_id TEXT NOT NULL REFERENCES todo_assessments(id) ON DELETE CASCADE,
  reaction TEXT CHECK (reaction IS NULL OR reaction IN ('agree', 'disagree', 'facepalm')),
  actor TEXT NOT NULL CHECK (actor = 'user'),
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (list_id, request_id)
);
CREATE INDEX todo_assessment_reactions_assessment ON todo_assessment_reactions(assessment_id, seq);
CREATE TRIGGER todo_assessment_reactions_append_only BEFORE UPDATE ON todo_assessment_reactions
BEGIN SELECT RAISE(ABORT, 'TODO assessment reactions are append-only'); END;
CREATE TABLE source_root (
  root_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('home','workspace','external')),
  host TEXT NOT NULL DEFAULT '',
  locator TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_bound_at TEXT NOT NULL,
  UNIQUE(host, locator)
);
CREATE UNIQUE INDEX source_root_one_home ON source_root(kind) WHERE kind = 'home';
CREATE TABLE observation_source (
  observation_id TEXT NOT NULL REFERENCES todo_tool_observations(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  root_id TEXT NOT NULL REFERENCES source_root(root_id),
  path TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('read','created','modified','deleted','moved_from','moved_to')),
  start_line INTEGER,
  end_line INTEGER,
  total_lines INTEGER,
  content_hash TEXT,
  observed_version TEXT NOT NULL DEFAULT 'disk' CHECK(observed_version IN ('disk','buffer')),
  editor_version INTEGER,
  created_at TEXT NOT NULL,
  PRIMARY KEY(observation_id, ordinal)
);
CREATE INDEX observation_source_location ON observation_source(root_id, path);
CREATE INDEX observation_source_hash ON observation_source(content_hash);
CREATE TABLE index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE documents (
  uri TEXT PRIMARY KEY, workspace_uri TEXT NOT NULL, relative_path TEXT NOT NULL,
  filename TEXT NOT NULL, language_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
  hash_algorithm TEXT NOT NULL, size INTEGER NOT NULL, mtime_ms REAL,
  text TEXT NOT NULL, indexed_at TEXT NOT NULL, skip_reason TEXT, error TEXT,
  symbols_fingerprint TEXT, scan_id TEXT
);
CREATE INDEX documents_workspace ON documents(workspace_uri);
CREATE INDEX documents_path ON documents(relative_path);
CREATE INDEX documents_fingerprint ON documents(fingerprint);
CREATE TABLE symbols (
  document_uri TEXT NOT NULL REFERENCES documents(uri) ON DELETE CASCADE,
  name TEXT NOT NULL, kind TEXT NOT NULL, line INTEGER NOT NULL, column_no INTEGER NOT NULL,
  end_line INTEGER NOT NULL, end_column INTEGER NOT NULL, container TEXT,
  PRIMARY KEY(document_uri,name,kind,line,column_no)
);
CREATE INDEX symbols_name ON symbols(name);
CREATE VIRTUAL TABLE documents_fts USING fts5(uri UNINDEXED, relative_path, text);
PRAGMA user_version = 20;
```

**Expected objects of a fresh database** (Stage 4's schema test; shadow tables of `documents_fts` and `sqlite_sequence` are not counted):

- **Tables (27):** `todo_accepted_evidence`, `todo_assessment_current`, `todo_assessment_reactions`, `todo_assessments`, `todo_child_proposals`, `todo_dependencies`, `todo_edit_operations`, `todo_evaluations`, `todo_events`, `todo_evidence`, `todo_evidence_usage`, `todo_intent_plans`, `todo_intent_tasks`, `todo_items`, `todo_lists`, `todo_projects`, `todo_requests`, `todo_requirement_activations`, `todo_symbol_aliases`, `todo_tool_evidence`, `todo_tool_observations`, `source_root`, `observation_source`, `index_meta`, `documents`, `symbols`, and the virtual table `documents_fts`.
- **Named indexes (29, revised):** the 19 of v19 (`todo_accepted_evidence_item|lookup|observation|revision`, `todo_assessment_current_list`, `todo_assessment_reactions_assessment`, `todo_assessments_item`, `todo_child_proposals_fingerprint`, `todo_edit_operations_target`, `todo_evaluations_item`, `todo_events_list_revision`, `todo_evidence_usage_project`, `todo_items_list_status`, `todo_requirement_activations_item`, `todo_symbol_aliases_list|tool`, `todo_tool_evidence_list`, `todo_tool_observations_execution|list_revision`) plus `todo_tool_observations_item`, `todo_tool_observations_project`, `todo_accepted_evidence_project`, `source_root_one_home`, `observation_source_location`, `observation_source_hash`, `documents_workspace`, `documents_path`, `documents_fingerprint`, `symbols_name`.
- **Triggers (2):** `todo_assessments_immutable`, `todo_assessment_reactions_append_only`.

## Appendix B — Verified code map (base commit `0ca082a`; line numbers are hints, search by symbol)

**Workspace search index** — `src/extension/workspace-index/index.ts` (1254 lines)

- Helpers `run/get/rows/eachRow/exec/closeDatabase/openDatabase` ~88–134 (callback `sqlite3`); `DEFAULT_EXCLUDES` ~136 (includes `**/.twinny/**`, `*secret*`, `*credentials*`); `SCHEMA` ~143 (ends with `PRAGMA user_version=3`).
- `class WorkspaceIntelligenceIndex` ~245; constructor ~283 (`storageUri`); `start` ~325; `search` ~604 (reads `this.reader`; content scan through `eachRow` ~711/715); `flushPendingDeletes` ~556 (transaction ~566); `dispose` ~754; `databasePath` getter ~780 (`<globalStorage>/workspace-index.sqlite`); `initialize` ~784; `open` ~807 (writer + read-only reader connections, `ALTER TABLE` column checks, lazy FTS5 creation); `migrateFingerprints` ~862; scan sweep ~984–1001 (`scan_id IS NULL OR scan_id <> ?`); `indexFile` ~1028 (reads **bytes from disk**, fatal UTF-8 decode, NUL ⇒ "binary content", `fingerprintContent(text, algorithm)`, fast path on equal fingerprint+size+mtime; returns `boolean`); `cacheSymbols` ~1132; `storeSymbols` ~1151; `storeSkipped` ~1157 (**defect:** the calls at ~1040/1054/1058 omit `scanId`); `recordFailure` ~1177; `removeDocument` ~1184 (file or tree, by URI prefix); `isEligibleUri` ~1197; `measureDatabaseSize` ~1214.
- Today's freshness: `onDidSaveTextDocument` → debounced (250 ms) `scheduleUris` → `flushPendingUris` (waits for a running scan); watchers gated by `automaticSyncEnabled()`; no `onDidRenameFiles`. Search overlays unsaved buffers of open dirty documents (`source: "live"`). Hit shape `{ uri?, path, line?, column?, category, symbol?, kind?, preview, source }` — no hash or status.
- Activation: `src/index.ts` `new WorkspaceIntelligenceIndex(context.globalStorageUri)` (~255) then `start()`; the instance is passed on as the `WorkspaceSearchProvider` (`webview/base.ts` → `Chat._workspaceSearch`). `deactivate()` (~770) calls `closeTodoDatabases()`. The **LanceDB** embeddings index (`WorkspaceIndex.open(context)`, `src/extension/embeddings`) is a different object and is not touched.

**Project database** — `src/extension/todos/sqlite.ts`

- `SCHEMA` 6–209 (base v12) + migration ladder to v19; `CURRENT_SCHEMA_VERSION` ~214; `SqliteFile` ~252 (`open` ~269, `openDatabase` ~280 with per-open `integrity_check`, `migrate` ~302, `backup` (`VACUUM INTO`) ~316, `read` ~514, `write` ~518 — `database.transaction(...).immediate()`, rejects async closures —, `close` ~527); `PROJECT_TODO_DIRECTORY`/`PROJECT_TODO_DATABASE_NAME` ~541; `resolveProjectTodoStorage` ~562 (throws for 0 or >1 folders); `prepareProjectTodoStorage` ~591; `ensureProjectGitignore` ~601; `retireLegacyTodoDatabase` ~660 (deletes the legacy global `twinny-state.sqlite`; independent of the ladder).
- better-sqlite3 13.1.1 (SQLite with FTS5), WAL, `synchronous=FULL`, `busy_timeout=5000`; prebuilt binaries for darwin/linux (glibc and musl)/win32, x64 and arm64.
- `todos/repository.ts`: `TodoRepository` ~815 (owns a `SqliteFile`; each `BaseProvider` makes one); `prerequisiteIdsOf` ~552; `declaredEvidenceSourcesOf` ~558; `ensureList` ~339; `bumpList` ~433 (accepts an undefined item); `getActiveIntentContext` ~997; `hasAuthoritativePlan` ~1709; `recordToolObservation` ~1208 (requires an actionable task and an active intent task; idempotent per `(list_id, request_id)`); `getReviewPackages` ~1131; `claimCompletion` ~1940; `editDigest` ~99 (LF-normalized sha256 for the edit ledger — a different digest domain); `workspaceProjectFingerprint` ~2069 (sha256 of the sorted folder URIs; production sites: `chat/index.ts` ×4, `webview/base.ts` ×1); `acceptedFactsFor` ~627; `recordAcceptedFacts` ~711.
- `todos/feedback.ts`: `CurrentSourceReader` ~190; `cachedCurrentReader` ~227 (swallows errors); `AcceptedFactStatus` ~240; `assessAcceptedFacts` ~266; `evidencePreflight` ~345; `mutationOutcome` ~443 (any successful mutating tool for owner items); `criterionOwners` ~976; `taskHasVerifiedMutation` ~1507; `evaluateTodoReview` ~1636–1700.
- `todos/evidence.ts`: `compactToolEvidence` 91, `observationArguments` 129, `READ_HEADER` 159, `CONTENT_HASH` 161, `parseSources` 199, `preserveEvidence` 244.

**Native tools**

- `tools/view.ts` (298 lines): constructor `(root, ignoredGlobs, _read, blockedGlobs)`; `visible` ~113, `resolve` ~120, `resolveNew` ~161, `relative` ~201, `realRelative` ~206, `entries` ~222, `files()` ~231, `text()` ~283 (buffer-first, 512 KiB cap, binary sniff, BOM stripped; `undefined` for absent **and** unreadable alike).
- `tools/workspace.ts`: `ToolResult` ~37, `EditOutcome` ~102, `readFile` ~223 (hashes the whole text before slicing; header `<path> (lines a–b of N)` + `content_hash: <token>; total_lines: N`), `grep` ~296, `createFile` ~470, `serializeMutation` ~501, `editLines` ~514 (`run` ~574, success JSON ~597), `editFile` ~604, `WorkspaceSearchProvider` ~960. `tools/more.ts`: `EditorSink`/`FileOpsSink` ~57–70, `renameSymbol` ~395, `deleteFile` ~443, `moveFile` ~459 (files only). `tools/todos.ts`: `todoTools` ~119, `twinny_evidence_lookup` ~164, `twinny_todo_update` ~290. `tools/fingerprint.ts`: `fingerprintContent` ~23. `tools/helpers.ts`: `isProtectedPath` ~279 (segment-anchored, works on absolute strings).
- `chat/tool-sinks.ts`: `EditSafetyOptions` ~119; `editorEdits` ~429 (`checkedOutcome` ~444, `beginEdit` ~500, `settleEdit` ~519, `read` ~526, `editLines` ~529, `edit` ~599, `create` ~632, `remove` ~663, `move` ~685); `rename` ~803 (inner closure ~844–933 with checkpoints, diagnostics baseline and catastrophic rollback). `edit/service.ts`: `outsideWorkspace` ~92, `chatEdit` ~296, `chatCreate` ~375. `edit/line-edit.ts`: `applyDocumentLineEdits` ~45 (atomic `document.version` check ~97), `saveAndVerify` ~111 (reads the saved file back and hashes it).
- `chat/index.ts`: `workspaceRoot()` ~1259 (= first folder), `workspaceView()` ~1274 (the only production `WorkspaceView`), `currentSourceReader()` ~1409, `editOperationLedger` ~1892, `onToolResult` ~2212, safety/tool wiring ~2486–2531, `run_command` cwd = `view.root` ~2549. `chat/reply-changes.ts` computes its own `path.relative(root, …)`, so changing `WorkspaceView.relative()` does not affect undo.

**Hash audit (verified at base):** one algorithm, `fingerprintContent`. The index and `read_file` agree for UTF-8 text ≤ 512 KiB (607 of 608 indexed files of this repository hashed identically; the exception exceeds the read cap). By design the index reads **disk**, `read_file`/`edit_lines` are **buffer-first**; the index skips NUL/invalid-UTF-8/oversized files, the read tools refuse binary or >512 KiB. `editDigest`, checkpoint hashes, embeddings and command digests are separate domains.

**Test facts (baseline):** `npm run test:sqlite` = 966 tests in ~4.5 s (todo-feedback 274, todos-sqlite 28, chat-tools 35, more-tools 9, line-edit 12, fingerprint 3, safe-edit-recovery 13, execution-reconciliation 16, tool-loop 79, …). VS Code suite files: `agent-reply`, `agents`, `line-edit`, `workspace-index` (`.vscode-test.js`). `chat-edit.test.ts` and `prompt-compiler.test.ts` also exist under `src/test/suite/`; whether `npm test` runs them is recorded in Stage 0. **Place every new VS Code test in `line-edit.test.ts` or `workspace-index.test.ts`.**

---

## Appendix C — Manual Remote-SSH checklist (Stage 17)

Environment: VSCodium connected with Remote-SSH to a Linux host; the project in `/root/docker/<project>`; Moriarty installed on the remote extension host. Settings on the **remote** machine scope: `twinny.chatToolsAllowedPaths = ["/etc/nginx", "/root/docker"]`. Record each step as pass / fail / NOT RUN.

1. The extension host log shows no `better-sqlite3` load error; `<project>/.twinny/project.sqlite` exists and `.gitignore` lists `.twinny/`.
2. `read_file /etc/nginx/nginx.conf` prints a header with the absolute path and `content_hash: <token>`; `read_file` of `/etc/shadow` (not allowed) is refused as outside the workspace.
3. `edit_lines` on a file in `/root/docker/<project>` succeeds; `search_workspace` for the new text finds it **immediately**; the result path is project-relative.
4. `edit_lines` on `/etc/nginx/conf.d/<file>` (authorized, outside the workspace) succeeds and returns a new `content_hash`; `search_workspace` does **not** list it (indexing scope is the workspace) but `read_file` shows the new text.
5. `create_file` then `move_file` then `delete_file` inside the project: search reflects each at once (new path found, old path gone, deleted file gone).
6. Accept a criterion from a read of `/etc/nginx/nginx.conf`; `twinny_evidence_lookup path=/etc/nginx/nginx.conf` → `validity: valid`. Change the file in an SSH terminal → `stale`. Delete it → `invalid` (fact still listed). Restore the same bytes → `valid` again.
7. Move an evidenced project file with `move_file`: the fact keeps its old path, is `invalid`, and `relocation_candidates` names the new path.
8. Open the same project as a second VS Code window (or a multi-root window with a second folder): TODO lists, evidence and the index come from the same `project.sqlite`; no "multiple workspace folders" error appears; `edit_lines` works in the multi-root window.
9. Close all windows, delete `project.sqlite`, `-wal`, `-shm`, reopen: a clean database is created and the index rebuilds.

---

## Appendix D — Judgment calls, limitations and out of scope

**Judgment calls to confirm (implemented as written unless the maintainer says otherwise)**

- **JC-1 (superseded)** Task ancestry does not govern evidence eligibility. See maintainer corrections.
- **JC-2** Index-refresh failure after a successful change: the tool reports success plus an explicit `index_refresh` failure and a "do not repeat" sentence. Reporting it as a failed call would make the model retry a completed change.
- **JC-3 (superseded)** Project-home identity is stable under folder reordering. See maintainer corrections.
- **JC-4 (expanded)** Authorization = workspace paths + static machine-scoped `twinny.chatToolsAllowedPaths` + user-approved, operation/host/scoped, time-limited or persistent runtime grants (Stage 1a). Runtime grants are revocable and do not affect indexing scope.
- **JC-5** New file name `project.sqlite`; old `.twinny/evidence.sqlite` and `<globalStorage>/workspace-index.sqlite` are left untouched and unused (the old data is abandoned by the dev reset).
- **JC-6 (superseded)** Eligible observations can be captured without a TODO plan. See maintainer corrections.

**Known limitations**

- L-1 Old TODO/evidence history in `evidence.sqlite` is not carried over (dev reset). At planning time that file held 88 lists, 787 observations, 4 accepted facts and 21 edit operations.
- L-2 One database means one blast radius: corruption blocks both index and evidence until the file is reset. `quick_check` runs once per path per process; on a very large index the first open can block the extension host for seconds.
- L-3 `run_command` side effects reach the index only through the watchers and can be briefly stale (decision).
- L-4 A scan already in flight can still read bytes older than a refresh; the `mtime_ms` guard and scan-id stamping make this narrow, not impossible.
- L-5 A non-`file` first workspace folder has no project database (TODO storage already refuses; the index stays idle).
- L-6 Secrets inside authorized external folders are readable (no `.gitignore` there). Team `blockedPaths` and `embeddingIgnoredGlobs` still apply; `/` cannot be authorized.
- L-7 `SourceRoots` compares paths case-sensitively and has only been designed for POSIX hosts; drive letters are normalized but Windows is untested.
- L-8 Remote-SSH needs the `better-sqlite3` native prebuild for the server's platform (linux x64/arm64 prebuilds ship in the package; not verified on a server).
- L-9 The VS Code integration suite was not run while planning; its baseline is unknown until Stage 0.
- L-10 Multi-file observation validity exists as `assessSourceReferences` (tested) but is not shown to the model; accepted facts, lookup and preflight show validity.
- L-11 `documents` rows have no `root_id`; the index is keyed by URI and relocation maps URI → canonical path through `SourceRoots`.
- L-12 `todo_symbol_aliases` remains as a dead v19 table to avoid unrelated test churn.
- L-13 The status bar's `storageBytes` now measures the whole project database (index plus TODO data).
- L-14 Chats without a TODO plan record no evidence.

**Defects at the base commit that this plan fixes:** skip rows swept by the scan sweep (Stage 7); multi-root windows refuse the edit tools because `resolveProjectTodoStorage` throws (Stage 4); search can be stale after native edits (Stages 8–10); a deleted file and an unreadable file are indistinguishable (Stage 12); observations are owned by one task and evidence needs a declared handoff (Stages 2 and 11); the project key changes with the folder set (Stage 4); multi-root search hits cannot be opened with `read_file` (Stage 15, required).

**Out of scope:** see §1 "Non-goals".

---

## Appendix E — Test inventory

**Deleted (Stage 4, exactly these eight, all in `todo-feedback.standalone.ts`):** the migration-ladder tests titled *existing version-2 TODO databases migrate review tables without losing tasks* · *a version-15 database keeps its alias rows as history, gains a nullable registered_tool, and does not promote them into authoritative links* · *a version-16 database keeps its tool observations as history with no execution owner, and gains the execution index* · *existing version-4 TODO databases gain child proposals and accepted evidence without losing tasks* · *a version-10 database with accepted evidence upgrades to version 11 with every evidence row and relationship intact* · *the v12 edit ledger rebuilds for optional task association, keeps its rows, and keeps a v12 backup* · *the owner column is additive: legacy edit rows stay unowned and each reopened row keeps its owner* · *the v11 TODO database gains the edit operation ledger while keeping the active intent task*.

**Rewritten or renamed:** Stage 2 — the two handoff tests (*the live Locate, Replace, Verify sequence…*, *a handoff is accepted only from a prerequisite…*); Stage 4 — in `todos-sqlite.standalone.ts` the first project-database test (title mentions `evidence.sqlite`) and *ambiguous, empty, and non-local workspace folders fail explicitly…*; literal `evidence.sqlite` → `project.sqlite` (about ten places), `user_version` assertion 19 → 20, the *newer schema* test uses 21.

**Updated in place:** `workspace-index.test.ts` constructor calls (Stage 6) and the `index-main/src/extension/**/*.ts` path assertion (Stage 15, optional).

**Must preserve as safety guards:** the `/etc/passwd`, `../escape.ts` and `/packages/web/…` unauthorized-path refusal tests (`tool-safety`, `chat-tools`); a *failed or wrong-target* edit must not satisfy another task's workspace mutation criterion (matching evidence from any task may); every existing `freshness` / `unverifiable` test; the legacy-retirement tests in `todos-sqlite.standalone.ts`; *accepted evidence is shared across conversations of the same project while TODO lists stay conversation-scoped*; the whole `agent-reply` suite.

**Stage 1a regressions:** file/folder scopes, read/write separation, once/session/always persistence and revocation, host isolation, prompts and denial, symlink safety, same-call continuation, hash-backed `/tmp` reads with no index expansion.

**New test files:** `authorized-paths.standalone.ts` (Stage 1), `source-roots.standalone.ts` (Stage 3), `index-sql.standalone.ts` (Stage 5). All other new tests are additions to existing files, named in their stage. The regression-to-stage mapping is §3.2.

---

*End of plan. Nothing here has been implemented; the first action is Stage 0.*

