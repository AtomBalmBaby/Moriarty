# Moriarty: Evidence Reuse, Validity-Aware Context Management and Automatic Context Pruning — Implementation Plan

**Audience:** any coding agent (Moriarty or a successor model) working in fresh conversations, one stage at a time.
**Repository:** `/home/stark/source/twinny` · **Work branch:** `context-management` (checked out at planning time; HEAD `3937f58`).
**Status of this document:** implementation plan. Nothing here has been implemented. It is the execution translation of two designs, verified against the current tree.

**Authoritative references**

| Document | Role |
|---|---|
| `docs/Moriarty_Context_Management_and_Evidence_Reuse_Design.md` | The primary design specification. Its rules are non-negotiable; where this plan conflicts with it, the design wins and the conflict must be reported, not silently resolved. |
| `docs/Moriarty_Managed_Run_Command_Design.md` | Related future functionality. Defines the shared execution/evidence interfaces Stage 10 must support. Not implemented here. |
| `docs/Moriarty_Unified_Index_Evidence_Implementation_Plan.md` | The reference for plan structure and rigour (staged execution, prerequisites, exact files, test requirements, acceptance criteria, progress log). Its architectural assumptions are historical: the completed unified-database work is described there as unimplemented. Do not re-implement what it already delivered; do **not** treat its historical line numbers as current. |

> **Maintainer decisions (2026-11-22):** Storage limits, eviction order and retention settings belong in project-owned `<projectHome>/.twinny/config.json`, not merely VS Code `package.json` settings. One favourite/unfavourite model tool call operates on exactly one observation UUID, never a batch. Stage 1 creates the complete v21 schema for later stages.

> **This is a planning document.** Stage 0 has not been executed. Do not skip stages, reorder them, or start a stage whose prerequisites are not `done`.

---

## Progress Log (the only cross-conversation memory; update at the end of every stage)

Status values: `todo` · `in-progress` · `in_review` · `done` · `blocked`. A stage is `done` only when every acceptance criterion in its section is met **and** its verification numbers are recorded here with actual exit statuses and pass/fail/pending counts.

| Stage | Title | Status | Date | Verification (command → actual counts) | Notes / deviations |
|---|---|---|---|---|---|
| 0 | Current-code audit, storage contract, baseline reproductions | done | 2026-11-22 | `npx tsc -p . --noEmit` exit 0 (0 findings); `npx eslint src --quiet` exit 0 (0 findings); `npm run build-tests` exit 0; `npm run build` exit 0; `npm run test:sqlite` 1161 tests / 1161 pass / 0 fail / 0 skipped (4.90 s, 0 todo, 0 cancelled); `git --no-pager diff --check` no output; `xvfb-run -a npm test` NOT RUN: killed at 118 s (exit 124), no Mocha summary; the attempt stays incomplete and is counted neither as a pass nor as a failure (run it per §0.3's procedure, outside the command tool) — 69 then 99 ✔ observed across `Agent reply, end to end`, `Read-file acceptance, production controller`, `Stage 12: the host hands the boundary...`, `custom agent registry`, `Hash-verified native line edits`, 0 failing; the five observed suites all sit inside the configured files, which is consistent with the corrected discovery path; a config-file run failed with `Running extension tests from the command line is currently only supported if no other instance of Code is running.` — read-only check: that message comes from the downloaded build's single-instance startup check, so it is an environment condition, not a test result; the gate needs no other Code instance open. | Branch `context-management` confirmed; HEAD `ac6d841` (plan written at `3937f58`). Reproduction measured, not quoted: file 1374 lines, 207,076 chars / 207,714 bytes, raw tool output 214,351 chars delivered complete; `planContext(65536, 131072, 6144)` → margin 6,553, reserved 6,144, limit 52,839, target 34,345, resultChars 43,253; real loop delivered 42,077 chars = lines 1–25 (omitted 172,937, next_start_line 26), request estimate 45,480 chars / 13,782 tokens = 21.0% utilization, nothing trimmed; stored row original 214,351 / preserved 199,560, retained=1, complete=0, last retained line 1278 (first missing 1279), redaction removed 0 chars here; tail lines 1279–1374 is not retrievable — `grep -rn "query_evidence" src` = 0 hits, lookup returns metadata only (excerpt cap 2,400; measured 2,399 truncated). Design figures differ (207,507 chars; retention to line 1318); delivered lines 1–25 agrees. Whole read is refused at the documented default (`maxReadLines` 1000, full-file override off); the live workspace value observed here is 1400 with the override on. §3 status column unchanged; two clarifications: row 11 — `onDidRenameFiles` IS subscribed, by the embeddings index (`src/extension/embeddings/index.ts`); only the workspace index relies on watchers. Row 8 — `twinny_evidence_lookup` returns metadata entries only (`projectCandidateEntries` in `todos/feedback.ts`); bounded excerpts come from `excerptEvidence` / `ENTRY_LIMIT` 600 in `todos/evidence-context.ts`, not from the lookup tool itself. Step 7, corrected at closeout: `.vscode-test.js` lists 5 files (176 `test(` call sites in the compiled files: 71/2/52/25/26; the earlier `38 tests` figure is not reproducible from source). `npm test` runs `out/test/runTest.js`, which spawns `@vscode/test-cli`; the CLI loads the nearest `.vscode-test.js` and substitutes its own runner (`runner.cjs`, fed by `VSCODE_TEST_OPTIONS.files`) for `extensionTestsPath`, so **those 5 files are what actually run** — verified read-only with `npx vscode-test --list-configuration` (exit 0). `src/test/suite/index.ts`'s glob (`**/*.test.js` under `out/test` → 85 compiled files, 1,118 recorded occurrences; 1,048 excluding regex `.test(` matches) is a separate discovery path the CLI does not use, and it runs only when `runTests` is pointed at that module directly. The four scopes (configured list / actual discovery / focused runs / full-suite regression) and the log + exit-status + Mocha-summary procedure are in §0.3. Live DB read-only (`<workspaceRoot>/.twinny/project.sqlite`): `PRAGMA user_version` 20, 33 tables / 65 indexes / 2 triggers, no `evidence_*`, `context_*` or `storage_policy` objects → §5.2 is additive and covers every later-stage table; no `.twinny/config.json` exists and no code reads one (only JSON-config convention is the gateway store: validate + revision hash + temp write + rename). Side effect to report: a PRAGMA probe opened `/home/stark/.twinny/project.sqlite` before read-only mode was set and created an empty 0-byte file there (`user_version` 0); nothing was written to it; recorded as reported — the maintainer has chosen to disregard that file, and it was not inspected or touched during this closeout. |
| 1 | Complete durable evidence capture (invocation/outcome/blob) | done | 2026-11-23 | `npx tsc -p . --noEmit` exit 0 (0 findings); `npx eslint src --quiet` exit 0 (0 findings); `npm run build-tests` exit 0; `npm run build` exit 0; `git --no-pager diff --check` no output; `npm run test:sqlite` 1183 tests / 1183 pass / 0 fail / 0 pending / 0 skipped (5.9 s) = Stage 0's base 1161 + 22 (new `evidence-storage.standalone.ts` 19, `chat-tools.standalone.ts` +2 → 44, `tool-loop.standalone.ts` +1 → 88, `todos-sqlite.standalone.ts` 41); focused VS Code run `xvfb-run -a npx vscode-test --grep "the real hook stores the raw bytes"` exit 0, 1 passing (the new `agent-reply.test.ts` case); full configured suite completed at closeout as five separate runs of the files `.vscode-test.js` lists, each finishing inside the command tool's ~120 s limit: `agent-reply` 72 passing / 0 failing exit 0 (the new Stage 1 case included, 147 ms), `agents` 2 passing exit 0, `line-edit` 55 passing + 6 pending exit 0, `workspace-index` 25 passing + 1 pending exit 0, `file-access` 26 passing exit 0 — totals 180 passing / 7 pending / 0 failing across the configured five. | v21 schema written as §5.2 complete, `CURRENT_SCHEMA_VERSION = 21`; object inventory measured from the DDL on a scratch project under /tmp, not quoted (the inventory as the test filters it, excluding the `documents_fts_` shadow tables): 27 tables / 29 named indexes / 2 triggers before → 40 / 39 / 2 after, the eight indexes Stage 1 freezes all present, and the refusal path now refuses version 22. Development database policy kept: no code deletes a database, `-wal`/`-shm` untouched, tests run on `fs.mkdtempSync` scratch projects under /tmp; the developer's `<workspaceRoot>/.twinny/project.sqlite` was checked read-only and left as Stage 0 recorded it (`user_version` 20, 33 tables / 65 indexes / 2 triggers), so it is refused by `refusedVersion` until the developer deletes it by hand — no code deletes it. Three defects from the interrupted session repaired and round-tripped: `recordGap` stores the gap reason as itself with the fault message in a separate `error` field (read-back was answering `inaccessible` instead of `storage_limit`/`storage_error`); the content-addressed shared blob now writes each outcome's own `evidence_chunks` rows, so sharing bytes does not merge receipt history; and a failed byte-object write reports state `storage_error` on read-back. Two further defects found in this continuation: `pending()` looked an outcome up by the observation id and answered undefined (now resolved through the observation), and `isRecordableToolResult` had been rewritten to decline every result without an execution, which stopped reads, greps and lists being recorded — it now declines only a command that ran nothing while a refused command still records an attempt. Deviations: the line index counts lines of the stored output text, so a 1,374-line whole read indexes 1376 (the test asserts at least the read's own lines rather than the file's count); the object-count test keeps the regenerated trigger assertion; `captureMode` is recorded from what the tool saw even when no bytes arrived on it. Acceptance: every completeness number is measured by this stage's own tests; the Stage 0 reproduction case is stored whole: a 1,374-line read measured 206,366 characters / 207,740 bytes of content and 213,590 characters / 214,966 bytes of tool output, the store reports that output complete with no 200K silent cap while the presentation copy is capped at 199,931 characters and the model's copy is a cut (43,197 delivered for the 65,536-token plan; in the VS Code case a 624-character note said the result was not included), with originalChars, capturedBytes and storedBytes reported apart. Storage policy documented in `docs/evidence-storage-config.md` with `docs/twinny.config.example.json`. Stage 10 still owns real `run_command` stream capture: this stage proves independent streams with synthetic inputs only. Closeout deviation: one existing test outside Stage 1's named list was corrected — `src/test/suite/workspace-index.test.ts` asserted `user_version` = 20 with the message "the schema version belongs to todos/sqlite.ts", which contradicts §5.2's mandated `CURRENT_SCHEMA_VERSION = 21`; the literal and its test title were set to 21, still comparing against the exact authoritative version, so nothing was weakened. Its first closeout run failed for that reason (24 passing / 1 pending / 1 failing, exit 1); after the correction it ran 25 passing + 1 pending, exit 0. The seven pending entries are pre-existing `test.pending` placeholders, not Stage 1 skips. Logs kept at `/tmp/closeout-*.log`. Nothing committed; Stage 2 not started. |
| 2 | Read-only evidence access service (range, offsets, search, pagination) | in_review | 2026-11-24 | `npx tsc -p . --noEmit` exit 0 (0 findings); `npx eslint src --quiet` exit 0 (0 findings); `npm run build-tests` exit 0; `npm run build` exit 0 (`out/sidebar.js` present); `git --no-pager diff --check` no output (exit 0); focused gate `node --test out/test/standalone/evidence-access.standalone.js` 15 tests / 15 pass / 0 fail / 0 pending / 0 skipped (0.58 s, exit 0); `npm run test:sqlite` 1208 tests / 1208 pass / 0 fail / 0 pending / 0 skipped (6.19 s, exit 0) = this stage's control run 1192 + Stage 2's 16 (`evidence-access.standalone.ts` 15 new, `todos-sqlite.standalone.ts` +1 to 42); VS Code suite as five separate completed runs of the files `.vscode-test.js` lists, each ending with a real Mocha summary and its own exit status: `agent-reply` 72 passing / 0 failing exit 0, `agents` 2 passing exit 0, `line-edit` 55 passing + 6 pending exit 0, `workspace-index` 25 passing + 1 pending exit 0, `file-access` 26 passing exit 0 - totals 180 passing / 7 pending / 0 failing; aggregate `xvfb-run -a npx vscode-test` NOT RUN: stopped at the command tool's ~120 s cap with no Mocha summary, 100 ✔ lines recorded in `/tmp/s2c-aggregate.log` before it was killed (the killed process reports `Exit code: 1` / `Error: Test run failed with code 1` from the broken X connection), counted neither as a pass nor as a failure per §0.3; needs a maintainer-terminal run to be recorded as observed. | The gate that was red at the previous closeout is now green, and its cause sits outside this stage's ownership: `repeated failed tool calls with no new evidence stop the task with a no-progress reason` asserted at most 13 requests and saw 22 because commit `4cdebc3` replaced `MAX_NO_PROGRESS_STEPS = 3` with the exported `DEFAULT_NO_PROGRESS_STEPS = 8` plus a `maxNoProgressSteps` option in `src/extension/tools/loop.ts`. The resolution present in the working tree at closeout was not authored by Stage 2 and was preserved as found: `src/test/suite/agent-reply.test.ts` pins the documented three-step bound for that test through `twinny.chatToolsMaxNoProgressSteps` and restores the previous global value in a finally block, leaving the bound assertion itself intact - nothing was weakened, skipped or loosened. Stage 2 changed no `chat/*` or `tools/*` file; `evidenceAccess` is referenced only by `repository.ts` and this stage's tests, so no Stage 2 change reaches the loop. The single `agents` timeout recorded earlier (`discovers only agent profiles and persists enable, remove and create operations`, Mocha Timeout of 2000ms) did not recur here: 2 passing, exit 0. Stage 2 scope: §4.3 types in `types.ts`, the vscode-free service in `evidence-access.ts` (get/range/search/find over Stage 1 storage, served only from stored bytes/lines, never from a reread or a rerun), exposed through `TodoRepository.evidenceAccess` on the project and validity boundary the repository already owns; line numbers 1-based inclusive over stored content, character offsets mapped back to stored bytes, byte offsets zero-based half-open; pages ordered by (stream, byte) and continuable, bound reported as a bound; redaction applied before delivery, so a withheld secret line still reports its count with no preview text; a denied scope returns no content and no candidate names; each retrieval writes one `evidence_access_events` row with arguments and outcome, no blob copy, no observation/evidence row, no invented execution id. All six §4.3 states are reached by real requests in the state test. Deviations: two named negatives - a range crossing an eviction boundary and a result larger than its own bound - are asserted inside the coverage and pagination tests rather than as separately titled cases; the control run measured 1192, nine more than Stage 1's recorded 1183, and Stage 1's per-file breakdown is not reproducible from source now (`tool-loop` measures 90 against its recorded 88) - reported as a prior-record discrepancy, nothing was corrected. Development database policy kept: every test runs on an `fs.mkdtempSync` scratch project under /tmp, no code deletes a database, `-wal`/`-shm` untouched; the developer's `.twinny/project.sqlite` was inspected read-only only (`node:sqlite` with `openReadOnly`) - `user_version` 21, raw sqlite_master counts 46 tables / 91 index entries / 2 triggers (Stage 1's filtered inventory excludes the FTS shadow tables), no Stage 2 DDL needed, nothing written. An earlier `edit_lines` call on `evidence-access.ts` was refused for a stale hash; the buffer and disk were reconciled by reading rather than retrying, and the file is verified by the gates above. The three Stage 2 completion claims are in Feedback review (`in_review`), not hand-approved, so this row stays `in_review` while every criterion itself is met with measured numbers. Logs kept at `/tmp/s2c-*.log`; nothing committed; Stage 3 not started. |
| 3 | `query_evidence` native tool + sparse result envelope | in_review | 2026-11-24 | Prerequisite check: Stage 2's row is `in_review`, not `done` - its recorded numbers were confirmed by this stage's control run, but §0.1 rule 2 was not satisfied at the start, so Stage 3 was entered on the user's explicit instruction and is reported as a deviation below. Control run before any change (same branch, clean tree): `npx tsc -p . --noEmit` exit 0 (0 findings); `npx eslint src --quiet` exit 0 (0 findings); `npm run build-tests` exit 0; `npm run build` exit 0 (`out/sidebar.js`, 5,816,265 bytes); `git --no-pager diff --check` no output (exit 0); `node --test out/test/standalone/*.standalone.js` 1208 tests / 1208 pass / 0 fail / 0 skipped (6.08 s, exit 0) = Stage 2's recorded total. After this stage's changes: `npx tsc -p . --noEmit` exit 0 (0 findings); `npx eslint src --quiet` exit 0 (0 findings); `npm run build-tests` exit 0; `npm run build` exit 0 (`out/sidebar.js`, 5,816,841 bytes); `git --no-pager diff --check` no output (exit 0) after removing the trailing blank lines this stage's appended tests left; full regression `node --test out/test/standalone/*.standalone.js` 1219 tests / 1219 pass / 0 fail / 0 skipped (6.03 s, exit 0) = control 1208 + Stage 3's 11, per-file (each exit 0): `evidence-query-tool.standalone.js` 6 / 6 / 0 (412 ms), `tool-loop` 92 / 92 / 0 (2.97 s), `chat-tools` 45 / 45 / 0 (490 ms), `tool-output` 6 / 6 / 0 (229 ms), `conversation-export` 45 / 45 / 0 (182 ms). `xvfb-run -a npx @vscode/test-cli run` NOT RUN: killed at the command tool's ~120 s cap (exit 124 after 118 s), no Mocha summary, 100 ✔ lines observed in `/tmp/s3-vscode4.log` before the cut and 0 failing observed - counted neither as a pass nor as a failure per §0.3; a per-file run could not be attempted because the CLI resolves its config inside the project (`--config /tmp/s3-scope.js` failed with `Can't resolve '@vscode/test-electron' in '/tmp'`) and no config file was added to the tree; needs a maintainer-terminal run to be recorded as observed. Grep check: `grep -rn 'query_evidence' src/test` = 20 hits, all in this stage's tests; `grep -rn 'query_evidence' src/test/suite` = 0 and no suite test asserts tool counts, so no existing assertion was weakened. | Stage 3 scope as implemented: the single native read-only tool lives in `src/extension/tools/evidence.ts` and calls only Stage 2's §4.3 service (get/range/search/filter/continuation), never re-reading a source or re-running a command; parameters typed (integer ranges, optional stream/mode/cursor) with nothing stringified, `readOnly: true` so repeat suppression applies; registered through the new `ToolExtras.evidence` option and, for the TODO-only set, `withEvidenceTools` in `chat/index.ts` - without an access service it is not advertised and a call to it is refused. Model-facing copy is sparse (§4.7): a complete short page stays plain text (only the service's own coverage note), an envelope appears only where integrity/status/retrieval semantics require it, no null placeholders, no empty arrays, no redundant wrapper, no duplicated status field, and the hash reported is always the one as it was observed. Production wiring: `chat/index.ts` resolves `repository.evidenceAccess(scope)` per reply (an unavailable window is logged, not a failed reply), the recording hook now resolves to the observation id it wrote, the loop keeps that id alongside the slot (`ResultSlot`, `ToolStep`, `ResultBudget` - all additive optional fields) and answers a trimmed read-only repeat through `storedResultAnswerer` only while identity, arguments, source version (`historical`), authorization scope and stored semantics still hold; when they do not, the call runs. A repeat left out of context is still reported as not run, never as a result; a retrieval answers from content the store can serve or returns nothing and lets the tool run. `[result_integrity]` keeps working for existing consumers and carries `observationId` when an envelope is emitted; the step view (`chat/tool-steps.ts`, `webview/tool-output.tsx`) and `common/conversation-export.ts` show/export an actual id only where one exists, never an invented one. Deviations: (1) the prerequisite above; (2) `chat/tool-evidence.ts` - `isRecordableToolResult` now declines a `query_evidence` result, which §4.3 requires through the production loop: the service already records the retrieval as one access event with its arguments and outcome and its text must not be stored again as model-visible evidence content (the focused test proves one event, no second observation row, no evidence-of-evidence row, no duplicated blob); this is a storage decision in a file Stage 3 did not list, recorded here rather than silently applied; (3) the tool's own `get`/denied-lookup form reports the access decision as `access` plus an actionable next step instead of a duplicated `state` field. Reported, not changed: `RESULT_INTEGRITY_LINE` in `tools/budget.ts` is written as `/^\\[result_integrity\\].*$/`, which matches lines containing literal backslashes, so `stripResultIntegrity` does not remove the lines production actually emits (Stage 11 owns that payload audit); the new `tool-output` test therefore asserts what today's parsers do with an id-carrying envelope line rather than asserting a strip. Development database policy kept: no schema change and no code path that deletes a database or touches `-wal`/`-shm`; every test runs on an `fs.mkdtempSync` scratch project under /tmp, and the developer's `.twinny/project.sqlite` was not opened by this stage. Acceptance: required tests are titled as the stage names them - the 1,374-line case (beginning, line 687, last non-empty line answered from stored bytes with the source changed after capture and no second read recorded), plain-text vs envelope, observation id through loop/budget/step view/export (`tool-loop.standalone.ts` + `conversation-export.standalone.ts` + `chat-tools.standalone.ts`), repeat reuse then rerun on a changed source version (`tool-loop.standalone.ts`), delivered-vs-retained coverage (`evidence-query-tool.standalone.ts`); negatives: range beyond retained coverage, evicted observation, wrong-typed argument refused with `executed: false`, another project's UUID and an unauthorized root naming no candidate, a command whose output was never captured, zero matches as a success, and an omitted result not described as retrievable. Nothing committed; Stage 4 not started; logs at `/tmp/s3-*.log`. |
| 4 | Validity classes, dependency edges, invalidation events | todo | | | |
| 5 | Explicit stale-to-current resolution | todo | | | |
| 6 | Model-controlled favourites + protected user intent | todo | | | |
| 7 | Context sizing and provider diagnostics corrections | todo | | | |
| 8 | Deterministic two-tier context projector core | todo | | | |
| 9 | Projector wiring + inline chat settings (toggle, slider, display) | todo | | | |
| 10 | `run_command` evidence adapter against the shared contract | todo | | | |
| 11 | Response-guidance catalogue and model-facing payload audit | todo | | | |
| 12 | Integration, adversarial matrix, managed-command handoff | todo | | | |

**Planning-time measurements (not a stage result; Stage 0 must re-measure and record them as its own baseline):** `node --test out/test/standalone/*.standalone.js` → 1161 tests / 1161 pass / 0 fail / 0 skipped (~5.1 s); `npx tsc -p . --noEmit` exit 0 (0 findings); `npx eslint src --quiet` 0 findings; working tree clean on `context-management`.

---

## 0. How to use this plan

### 0.1 One stage per conversation

1. Read §0, §1 (non-negotiable rules), §2 (current architecture), §3 (gap analysis), §4 (shared contracts), the **Progress Log**, and **only** the section of the stage you are given, plus the sections it cites.
2. Confirm every stage listed under that stage's **Depends on** is `done` in the Progress Log, with recorded numbers. **Execute stages in numeric order, after checking their declared dependencies.**
3. Establish the current repository state before writing anything (see 0.4). Do not trust line numbers from earlier conversations or from this plan; locate code by symbol name (`grep -n`, `find_symbol`).
4. Do exactly that stage. Do not start another stage in the same conversation, even if it looks trivial. Proceed to the next numbered stage once its prerequisites are complete.
5. Finish with the report in 0.5 and update the Progress Log row.

### 0.2 Hard rules

- **No commits, pushes, stashes, resets, `git add`, branch switches or discards.** Leave all changes in the working tree on `context-management`.
- **Planning stages are read-only.** Stage 0 changes no source, schema, test or configuration file; it may only edit its own Progress Log row.
- **Inspect before editing.** Read the files named in the stage; reuse existing functions; do not create competing subsystems. If a stage says to reuse a symbol, `grep -n` for it first.
- **Never weaken, skip, delete or loosen an existing test** except the ones a stage names explicitly by title. When a stage says "update" a test, change only the assertions it names. A deterministic failure is reported, not hidden; no indefinite retry loops after a deterministic failure.
- **Tests must exercise the production code path** (real `workspaceTools(...).run`, real `TodoRepository`, real `SqliteFile`, real `SourceRoots`, real `WorkspaceView`, real `ToolLoop`), not a reimplementation of it.
- **No placeholders, TODO comments, dead code, speculative abstractions, generated reports or planning files.** No new dependencies except where a stage says so.
- Comments only where the code is not self-explanatory; double quotes, no semicolons (the repo style — `npx eslint <files> --fix` for import-order findings).
- If the plan contradicts what you observe in the code, **stop and report the contradiction** instead of improvising. Do not ask routine questions the plan already answers.
- Scratch files go in `/tmp` and are deleted before you finish. Never write test databases into the repository tree.

### 0.3 Verification gates

Every stage must run these from the repository root and record actual exit statuses and counts:

| Gate | Command | Expected at planning time |
|---|---|---|
| Types | `npx tsc -p . --noEmit` | exit 0 |
| Lint | `npx eslint src --quiet` | 0 findings |
| Build for tests | `npm run build-tests` | exit 0 (writes ignored `out/`) |
| Bundle | `npm run build` | exit 0 (needed so the agent-profiles webview test finds `out/sidebar.js`) |
| Standalone tests | `npm run test:sqlite` | 1161 tests, 1161 pass, 0 fail, 0 skipped at planning time; a stage reports its own additions as `base + N` |
| Whitespace | `git --no-pager diff --check` | no output |
| VS Code suite | `xvfb-run -a npm test` (`pretest` cleans, builds, bundles, lints first) | record real counts; or `NOT RUN: <exact error>`. Runs the files `.vscode-test.js` lists, not the whole discovered suite — see the four scopes below |

The VS Code suite has four distinct scopes; keep them separate. Stage 0 measured them, and the numbers below are its own, re-verified at closeout against source:

1. **Configured list** — `.vscode-test.js` lists five files: `agent-reply`, `agents`, `line-edit`, `workspace-index`, `file-access`. They are literal paths, not globs, and hold 176 `test(` call sites in the compiled files (71 / 2 / 52 / 25 / 26); some tests are registered inside loops, so the executed count can be higher than the call-site count. The `38 tests` figure recorded in Progress Log row 0 is not reproducible from source.
2. **Actual discovery** — `npm test` runs `out/test/runTest.js`, which spawns `node_modules/.bin/vscode-test` (`@vscode/test-cli/out/bin.mjs`). The CLI loads the nearest `.vscode-test.js` and its desktop platform substitutes its own runner, `node_modules/@vscode/test-cli/out/runner.cjs`, for `extensionTestsPath`; that runner reads `VSCODE_TEST_OPTIONS.files`. **The five configured files are what actually run.** The glob runner `src/test/suite/index.ts` (`globSync("**/*.test.js", { cwd: out/test })` → 85 compiled files, 1,118 recorded occurrences / 1,048 call sites) is bypassed: the `--extensionTestsPath=` argument `runTest.ts` passes is not a CLI option and never selects tests. It runs only when `@vscode/test-electron`'s `runTests` is pointed at that module directly. Verified read-only without executing any test: `npx vscode-test --list-configuration` → exit 0, printing the five files and test-cli's runner as the tests path.
3. **Focused integration tests** — `npx vscode-test --grep "<test title>"` filters inside the configured five only (`--grep` reaches Mocha through `mochaOpts = {...args, ...test.mocha}` in `cli/platform/desktop.mjs`, which `runner.cjs` spreads into `new Mocha`). A test in one of the other 80 files must be named as well: `npx vscode-test --run out/test/suite/<name>.test.js --grep "<test title>"`. A single standalone file still runs with `node --test out/test/standalone/<name>.standalone.js`; `npm run build-tests` comes before running any compiled test.
4. **Full-suite regression testing** — covering all 85 discovered files needs either a config whose `files` entry is a glob (globbed relative to the config file's directory by `cli/gatherFiles.mjs`) or `--run` with the pattern expanded by the shell, because `--run` entries are resolved as paths, not globs. Adding a labelled full-suite entry to `.vscode-test.js` is a configuration change, so a stage may do it only when its own section says so.

**Running the full suite outside this plan's command tool.** A stage conversation cannot observe it: the command tool kills a call at about 120 s and cannot see a detached process. A run that cannot be finished is recorded as `NOT RUN` with the exact reason, never as a pass or a failure. `.github/workflows/ci.yml` budgets the suite 30 minutes (`timeout-minutes: 30`, `xvfb-run -a npm test`) — that is the reference budget; Stage 0's attempt was killed at 118 s and stays incomplete. Run it in a maintainer terminal, with no other Code instance open:

```
cd /home/stark/source/twinny
npm run build-tests                                                    # compile only; `pretest` also cleans, bundles and lints
xvfb-run -a npx vscode-test --run $(ls out/test/suite/*.test.js) > /tmp/vscode-suite-full.log 2>&1
echo "exit=$?"                                                         # the real process exit status; capture it before anything else overwrites $?
tail -n 15 /tmp/vscode-suite-full.log                                  # Mocha's epilogue: `N passing`, plus `N pending` and `N failing` only when nonzero
grep -c "✔" /tmp/vscode-suite-full.log                                 # per-test pass lines, as a cross-check on the summary
```

The log is the record: write its exit status and its passing/pending/failing counts into the Progress Log row from it, and keep the log until those numbers are written. A run that cannot start because another Code instance holds the single-instance socket reports `Running extension tests from the command line is currently only supported if no other instance of Code is running.` (the check lives in the downloaded build's startup code); that is an environment condition, not a test result.

Rules that keep their force:
- A stage that changes code which only runs inside VS Code (`chat/*`, `edit/*`, `workspace-index/*`, `src/index.ts`, webview) must run the suite and record real counts. Place new VS Code tests in a file `.vscode-test.js` already lists, otherwise this gate does not discover them; if a stage must add a suite file, it says so explicitly.
- A timeout or a missing final Mocha summary is not a pass. Report `NOT RUN` with the exact error, and never claim a suite pass you did not observe.
- Every stage reports per-command exit status and pass/fail/pending counts. Compilation alone is never a green stage.

### 0.4 How a fresh agent establishes the existing repository state

Before writing code, in this order:

1. `git status --short`, `git rev-parse --abbrev-ref HEAD`, `git branch --list` — record them; if the branch is not `context-management`, stop and report.
2. Read the Progress Log rows for this stage's prerequisites. Cite their recorded numbers instead of re-deriving them.
3. `twinny_evidence_lookup` on symbols/paths this stage names, before reading source. If an accepted fact is `current`, cite its `observation_id`; do not reread the file. Only when nothing is proven do you read — then read bounded ranges, not whole files.
4. Read the exact files the stage names, using `read_file` ranges, and record their fingerprints for any later edit.
5. Run the gates (0.3) once at the start to confirm the tree is green before your own changes; record the counts as this stage's control run.
6. Check the schema state directly where the stage touches storage: `PRAGMA user_version` and the object inventory named by Stage 1 (the development database is the project database at `<home>/.twinny/project.sqlite`; see §5).

Persistent state a fresh conversation must not lose: the Progress Log, the unified project database rows (observations, outcomes, blobs, dependencies, favourites, projection history), and the stage completion markers in this document. Nothing in this plan depends on conversational memory.

### 0.5 Final report format (end of every stage)

```
Stage N report
- Changed files: <list, one line each, with a few words on the change>
- Commands run and actual results: <command → exit status → "N tests, N pass, N fail, N pending", or "NOT RUN: reason">
- Acceptance criteria: <each criterion → met / not met, with the evidence (test title or command output)>
- Negative/adversarial tests: <each named test → result>
- Deviations from the plan: <none, or each deviation and why>
- Remaining / blocked: <none, or exact blocker>
- Progress Log: updated
```

Do not mark ordinary implementation TODOs complete by hand. A completion claim goes through the normal Feedback path; `in_review` means the claim was received, not accepted. Distinguish an actual approval requirement (an outside-workspace write, a protected file) from a TODO review status, and say which one blocks you.

### 0.6 Handoff prompt template

Every stage has its own **copy/paste prompt at the end of its section**. Use that stage-specific prompt in a fresh conversation rather than editing a generic Stage 0 prompt. Each prompt is an entry point; the full stage requirements and verification gates remain authoritative.

Paste as the first message of a fresh conversation:

```
You are implementing Stage N of docs/Moriarty_Context_Management_Implementation_Plan.md in /home/stark/source/twinny (branch context-management). Do not commit.
Read first: §0, §1, §2, §3, §4, the Progress Log, Stage N, and the sections Stage N cites. Confirm the stages Stage N depends on are done with recorded numbers.
Do only Stage N. Satisfy its acceptance criteria, run its gates (recording actual counts), update the Progress Log, and finish with the §0.5 report.
```

---

## 1. Non-negotiable design rules (restated as implementation constraints)

These are binding on every stage. A test that shows a violation is a defect in the stage, not a nuisance.

**Rule 0 — User requests never become stale.** Original user messages and their authoritative task requirements are durable, non-prunable records. Time passing or source files changing never makes them stale. A newer instruction may **supersede** an earlier requirement for future action without deleting or degrading the original. Context budgeting may use a faithful task-intent projection but may not drop or distort operative user requirements. Model-generated plans, TODOs and summaries never outrank user requests. User input is not a candidate for ordinary evidence pruning.

**Rule 1 — Preserve execution history.** Every actual tool invocation and its relevant raw outcome, success or failure, is recorded durably **before** any lossy presentation or context fitting: tool name; typed original arguments; invocation/execution/session identity; start and finish times; status; paths/targets and authorization scope; source and observed fingerprints; return payload; stdout and stderr as separate byte streams where applicable; exit code, signal, timeout/cancellation; structured errors; result and delivery completeness. Attempted calls rejected before execution are recorded as attempts with `executed = false` and must never be represented as successful execution. Context truncation must not silently truncate authoritative evidence.

**Rule 2 — Context is a projection, not the evidence database.** Pruning a prompt never deletes an observation, rewrites the transcript or changes a historical record. Evidence validity says whether an observation describes **current** state, not whether it historically happened. Historical observations remain historically true after their sources change. Source validity, evidence retention and model-context projection are three independent concerns and must not share a destructive retention mechanism.

**Rule 3 — Never leak a replacement fingerprint through invalidation.** A stale notice may carry the **original/obsolete** source hash and observation UUID, never a new current hash or new file contents. A newly verified current fingerprint comes only from an explicit, authorized, verified lookup (§4.4) or a fresh authorized read.

**Rule 4 — Sparse model-facing metadata.** Omit fields whose absence has a well-defined default: no `favourite:false` on every observation, no empty arrays, no redundant wrappers, no repeated paths/hashes, no `null` placeholders, no duplicated status fields. Unknown is not a default: unknown freshness, completeness, execution status or authorization must never be silently inferred as valid, complete, executed or permitted. A complete, unexceptional short result may stay plain text; an envelope is used only when integrity, status or retrieval semantics require it.

**Rule 5 — Favourites are opt-in except user input.** All ordinary tool observations begin unfavourited. User input is inherently protected for context policy. The model may mark or unmark evidence by UUID with compact idempotent operations. Favourites change **retention priority only**: not validity, not authorization, not storage policy, not the hard capacity limit.

**Rule 6 — Honest integrity and bounded retrieval.** Never advertise an unavailable observation, an omitted tail, an evicted blob or a failed command as retrievable. Never mark a partially delivered or partially retained result complete. Never call a launched background command successful. Zero matches from a search is a **success**, not a failure; "not run" is never a successful zero-result execution.

**Rule 7 — Authorization is independent of evidence.** Hash matching and possession of an observation ID convey no read, write or command permission. Existing canonical-path resolution, outside-workspace approval (`access-grants.ts`, `access-preflight.ts`, `operation-authorization.ts`), operation-scoped write authorization and source verification remain intact. A lookup that is denied names no restricted candidate.

---

## 2. Current repository architecture (as audited at planning time)

### 2.1 The unified project database

- `<home>/.twinny/project.sqlite`, `PRAGMA user_version = 20` (`CURRENT_SCHEMA_VERSION = 20` in `src/extension/todos/sqlite.ts`). `.twinny/` is created and git-ignored by `prepareProjectTodoStorage`; the project home is resolved by `resolveProjectHome` (`src/extension/todos/project-home.ts`) — explicit `twinny.projectHome`, then the saved workspace file's directory, then a single root, then the path-sorted first local root.
- One `SqliteFile` connection per consumer; writes are short synchronous transactions (`SqliteFile.write`, which rejects async closures); WAL, `busy_timeout = 5000`, `foreign_keys = ON`; the index connection sets `synchronous = NORMAL`. The workspace index (`src/extension/workspace-index/index.ts`) runs on `src/extension/workspace-index/sql.ts` in the same database (`index_meta`, `documents`, `symbols`, `documents_fts`).
- Development policy already stated in code (`refusedVersion` in `todos/sqlite.ts`): a database at any other version is refused and left untouched; resetting the development database means deleting `project.sqlite` and its `-wal`/`-shm` sidecars by hand. No migrations exist, and none may be added for development-only needs (§5).
- Evidence records: `todo_tool_observations` (immutable invocation record), `todo_tool_evidence` (retained content + `original_chars`/`preserved_chars`/`complete`/`metadata_json`), `observation_source` (per-file reference with role, range, hash, `observed_version`, `editor_version`), `source_root` (home/workspace/external identity, `SourceRoots` in `todos/source-roots.ts`), `todo_accepted_evidence` (facts with `superseded_by`), `todo_edit_operations`, `todo_events`, `todo_evidence_usage`.

### 2.2 Tool invocation, recording and dispatch

- Native tool contract: `ToolSpec` (`protocol.ts`: `name`, `description`, `parameters`, `guidance`, `readOnly`, `schema`), `ToolResult` (`workspace.ts`: `output`, `summary`, `integrity`, `rawOutput`, `rawIntegrity`, `failed`, `final`, `preface`, `execution`, `observation`, `error`), typed arguments with types preserved (`arguments.ts`), refused calls carrying `executed: false` in `ToolErrorDetail`.
- Dispatch: `workspaceTools(...).run` resolves the target through `resolveSourceTarget` (hash-first resolution, `source-resolver.ts`), authorizes outside paths, serialises mutations (`serializeMutation`), adds folder instructions, and returns a `ToolResult`.
- Recording: `Chat`'s `onToolResult` hook (`chat/index.ts`) → `chat/tool-evidence.ts` (`isRecordableToolResult`, `toolObservationInput`, `recordToolResult`, `reportRecordFailure`) → `repository.recordToolObservation` + `SourceRoots.recordObservationSources`. `run_command` results without an execution and declined commands are not recorded as observations.
- Fingerprints: one function, `fingerprintContent` (`tools/fingerprint.ts`), tokens `xxh64:`/`xxh3_128:`/`sha256:`; `verifyContentFingerprint` also accepts a bare legacy sha256. `read_file` prints `content_hash: <token>; total_lines: N`; `edit_lines` requires `expected_hash`; `create_file`/`move_file`/`rename_symbol` report resulting hashes.

### 2.3 Capture, retention and context budgeting today

- `todos/evidence.ts`: `compactToolEvidence` reduces a successful result to counts (only failures keep a short redacted excerpt); `compactEvidenceText` bounds the stored JSON at `MAX_EVIDENCE_TEXT = 1000`; `preserveEvidence` keeps content up to `MAX_RETAINED_EVIDENCE_CHARS = 200_000`, **redacted** (`redactEvidence`) and cut at a line boundary, with `originalChars`/`preservedChars`/`complete`; `parseSources`/`parseHits` read the read_file header and search JSON. Storage eviction: `enforceEvidenceBudget` (per-list `DEFAULT_EVIDENCE_STORAGE_LIMITS.listChars = 2_000_000`) sets `retained = 0, content = NULL` on the oldest rows.
- Presentation budgets are separate and smaller: `MAX_EXCERPT_CHARS = 2400`, `MAX_WINDOW_CHARS = 1200`, evidence-entry cap `600`.
- `tools/budget.ts`: `planContext(window, maxResultChars, outputTokens)` → `margin = 10%`, output reserve capped at `min(desired, 25% of window, window − margin − 512)`, `limit = window − reserved − margin`, `target = 0.65 × limit` (the hysteresis point), `resultChars = clamp(window × charsPerToken × 0.2, 2000, ceiling)`, `notesChars`. `fitResult`, `fitFileResult`, `trimmedResult`, `TokenEstimator` (learns chars-per-token from counted requests), `ContextUsageStore`, `formatResultIntegrity`/`stripResultIntegrity`/`withResultIntegrity`, `ContextDiagnostics` including `utilizationPercent`, `exhausted`, `outputCapped`.
- `tools/loop.ts`: `ToolLoop.fit(extraChars, step)` measures the request (tool definitions and closing prompt included), trims the oldest result slots in two passes (`step < newest − 1`, then `step < newest`) down to `plan.target`, cuts or omits fresh results, and reports through `onBudget`/`onContext`. Trimmed results are replaced by their first line plus a "Run the tool again" notice. Read-only repeats are answered from `_answered` (cleared on any workspace-mutating call): an earlier result whose content is still visible is not re-run; one that was trimmed *is* run again; one omitted for lack of room is refused with a notice.
- Conversation construction: `chat/turn.ts` (`buildChatTurn`) shapes each message for the API; `onTranscript` keeps the messages the model actually saw, so a Continue replays them rather than a summary. Native pairing uses `tool_calls` + tool messages with call IDs; text mode uses `<tool_result name=…>`.

### 2.4 Validity today

`todos/source-validity.ts` owns one boundary (`SourceValidityBoundary`) used on storage and retrieval, per reference and aggregate: `valid`, `stale`, `invalid`; an I/O error is `unverifiable`, not a state; disk-versus-buffer is explicit (`checkedAgainst`, `persistedSource`, `editorVersion`); nothing is cached across consumer sessions. Consumers (`feedback.ts`, `evidence-context.ts`, `delivery.ts`, `tools/todos.ts`) read through it. Relocation candidates (`repository.findRelocationCandidates`) return `recorded_move` and `matching_hash` proposals, never a chosen file. The index does not handle `onDidRenameFiles`; renames reach it through watchers.

### 2.5 Settings, UI and model-facing guidance

- Inline chat settings are the agent-settings panel (`src/webview/agent-settings.tsx`) read/written through `EVENT_NAME.twinnyGetConfigValue` / `twinnySetConfigValue` → `src/extension/webview/base.ts` (`readSettingWithLegacy`, scoped `configuration.update`). It has `NumberSetting` and `Choices` controls; there is no percentage slider control in this panel yet (`type="range"` appears only in `src/webview/embeddings/index.tsx`).
- Existing context settings: `twinny.chatContextWindow` (Auto or a number), `twinny.chatContextFallback`, `twinny.chatToolsMaxResultChars` (default 131072, max 2,000,000), `twinny.chatToolsMaxReadLines` (default 1000, ranges are refused rather than cut), `twinny.chatInferenceMaxOutputTokens` (default 6144), `chatInferenceMaxDurationSeconds` (900), `chatInferenceNoProgressSeconds` (300).
- Capacity discovery (`inference/context-window.ts`): per-provider probes; `confirmed` values are separated from `advertised`; `resolveCapacity` takes the **smallest confirmed** size, warns when a manual override disagrees with the server or is below `SUPPORTED_CONTEXT_TOKENS = 65_536`, and marks an unconfirmed fallback. The composer reads it through `twinnyGetContextWindow`/`twinnyGetContextUsage` (`Chat.contextWindowOf`, `contextUsageOf`) — a prompt-token estimate, not physical memory.
- Guidance catalogue lives in strings across `protocol.ts` (`GUIDANCE`, per-tool `guidance`), `budget.ts` (`fitResult`, `trimmedResult`), `workspace.ts` (`suggestedReads`, `overLimitMessage`, search notes), `line-edit.ts`/`edit/service.ts` (reread on hash change), `source-resolver.ts` (`recovery`), `todos/evidence.ts` (`describeGap`) and `tools/todos.ts` (the `refresh` hint).

---

## 3. Implementation inventory and gap analysis

Legend: **Done** = implemented; **Partial** = exists but incomplete for this design; **Missing**; **Incompatible** = an existing interface must be extended, not replaced; **Depends** = needs another stage.

| # | Design requirement | State today | Where the current code shows it | Stage |
|---|---|---|---|---|
| 1 | Immutable invocation record with typed arguments | Done | `todo_tool_observations`, `UNIQUE(project_id, request_id)`, replay returns the prior row in `recordToolObservation` | — |
| 2 | Complete raw capture before fitting | Partial | `ToolResult.rawOutput`/`rawIntegrity` exist; `compactToolEvidence` reduces successes to counts; failed calls store no retained content (`evidenceOutput: evidence.failed ? undefined : rawOutput` in `chat/tool-evidence.ts`) | 1 |
| 3 | Independent stdout/stderr, byte-preserving, ordered chunks | Missing | `tool-sinks.ts` merges both streams into one rolling tail (`MAX_CAPTURE_CHARS = 200_000`, head lost), ANSI-stripped; no per-stream storage | 0 (transport decision), 1 (generic store), 11 (real command sink) |
| 4 | Exit code, signal, timeout/cancellation, refusal with `executed:false` | Partial | exit code and `timedOut`/`stoppedByUser` exist; no signal, no terminal lifecycle enumeration, `run_command` records no execution identity (`execution_id` is set by the host, not the command) | 1, 11 |
| 5 | Retention and completeness metadata (original/captured/stored, gap reason) | Partial | `original_chars`, `preserved_chars`, `complete`, `retained`; `ToolTruncationStage` has `evidence_retention` but no capture/storage distinction and no per-stream completeness; eviction is silent (`retained = 0`) | 1, 3 |
| 6 | Storage quota as an explicit configurable policy | Missing | `DEFAULT_EVIDENCE_STORAGE_LIMITS.listChars = 2_000_000` is a per-list character budget, not a storage policy; no binary/long-line storage view | 1 |
| 7 | Redaction as presentation, separate from captured bytes | Partial | `redactEvidence` is applied to stored content itself, so original bytes are lost | 1 |
| 8 | Retrieval by observation UUID, bounded ranges, char/byte offsets, long-line fragments, stream selection, search/filter, pagination | Missing | `twinny_evidence_lookup` returns metadata and bounded excerpts; no `query_evidence`/`query_evidence_range`; the 1,374-line reproduction cannot be answered without rereading | 2, 3 |
| 9 | Retrieval must not rerun the tool | Partial (risk) | `_answered` re-runs a read whose result was trimmed; a stored result that is not exposed can still be described as needing a rerun | 8, 10 |
| 10 | Validity classes `current/stale/unknown/historical/superseded` | Partial | `SourceValidity` is `valid/stale/invalid/unverifiable`; `freshness` maps stale→`historical`; no explicit `unknown`, no user/task `superseded` class | 4 |
| 11 | Derived-dependency invalidation graph | Partial/Missing | accepted facts link to an observation via FK; no edge table, no invalidation events for edits/saves/renames/Git beyond the index refresh and watchers | 4 |
| 12 | Stale-to-current resolution returning a verified successor | Missing | `findRelocationCandidates` proposes paths only; no authorized current lookup, no `resolve_current_evidence` | 5 |
| 13 | Favourites (storage + model operations) | Missing | no column, no tool, no projector input | 6 |
| 14 | Protected user/task segments in the projection | Partial | `fit()` never trims user messages, but there is no protected-segment concept and `notes()` drops older blocks; task state reaches the prompt only through `requestContext()` | 6, 8 |
| 15 | Deterministic two-tier projector with threshold, hysteresis, diagnostics | Partial | `planContext` + `fit()` trim oldest-first regardless of validity/favourite; `target = 0.65 × limit` is the only hysteresis; no configured utilization threshold, no stale-vs-valid tiering, no favourite tier | 8 |
| 16 | Tool-call/result pairing survives compaction | Partial | call IDs and the per-reply transcript are kept (`_turn`, `replace()`); nothing proves pairing after a compacted body in the next turn | 8 |
| 17 | Inline settings: auto-pruning toggle, percentage slider, capacity/utilization display | Missing | agent-settings panel has no pruning controls; usage is shown as an estimate elsewhere | 9 |
| 18 | Context sizing / provider diagnostics corrections | Partial | `resolveCapacity` prefers the smallest confirmed size and warns; `planContext`'s reserve can make a large output maximum look like exhaustion (`plan.limit < 512` reason); no separation of prompt utilization from KV occupancy | 7 |
| 19 | Response guidance that uses evidence instead of recommending reread/rerun when data exists | Partial | `trimmedResult`, `fitResult`, `cut()`, `describeGap`, `tools/todos.ts` `refresh`, `source-resolver.ts` `recovery`, `line-edit.ts` hash-change messages | 11 |
| 20 | Sparse payload audit with measured savings | Missing | no measurement harness; `[result_integrity]` JSON lines are emitted for every partial delivery | 11 |
| 21 | run_command shared evidence contract (no second schema) | Depends | command evidence currently lands only as one merged text blob | 10 |
| 22 | Native-tool preference/soft refusal at the command boundary | Deliberately out of scope here | managed-command design §8; keep it in that work unless a context-stage interface must accommodate it | 11 (interface only) |
| 23 | Test infrastructure and gates | Done | `node:test` standalone suite, Mocha suites listed in `.vscode-test.js` (5 files — the gate runs exactly those; the glob runner that discovers all 85 is bypassed, see §0.3), all gate commands confirmed available | — |

---

## 4. Architectural decisions and shared contracts

These contracts are frozen. A stage may not change a contract it does not own; if it must, the deviation is reported in its section here before implementation.

### 4.1 Identity layers (never conflated)

| Layer | Identifier | Meaning | Never used for |
|---|---|---|---|
| Project | `todo_projects.id` | one project per database | access scope |
| Resource root | `source_root.root_id` | home / workspace / external root | permission |
| Source path | `observation_source.(root_id, path)` | root-relative POSIX identity | current content |
| Content version | content fingerprint (`xxh64:`/`xxh3_128:`/`sha256:`) | a claim about one version of content | file identity, uniqueness, write authorization |
| Invocation | `todo_tool_observations.id` (UUID) + `request_id` uniqueness | what was attempted/observed | permission |
| Execution | `execution_id`, plus `evidence_outcomes.execution_ref` for commands | what actually ran | output content |
| Outcome | `evidence_outcomes.id` | the captured result before fitting | delivery status |
| Blob | `evidence_blobs.id` + `content_digest` | stored bytes, content-addressed | historical record (repeated reads share a blob but keep separate observations) |
| Observation preference | `evidence_favourites.observation_id` | retention priority | validity or permission |

Deduplication is allowed at the blob level; it must never erase a separate invocation history. A command digest (`commandDigest` in `todos/evidence.ts`) is a verification identity for a command string, not a run identity.

### 4.2 Completeness contract (extends `ToolResultIntegrity`, additive only)

Existing consumers must keep working: `common/tool-output.ts` (`parseReadFile`, `parseCommandRun`), the webview's tool step view (`ToolStepView.outputOmitted`), `feedback.ts`, `evidence-context.ts`, and `[result_integrity]` line parsing in `budget.ts`. Additive fields only; no existing field changes meaning.

```ts
export type CaptureCompleteness = "complete" | "partial" | "not_captured" | "excluded"
export type StorageCompleteness = "complete" | "partial" | "evicted" | "inaccessible" | "unknown"

export interface ResultCapture {
  originalBytes: number
  capturedBytes: number          // what the host actually received
  storedBytes: number            // what the database holds (post-redaction where policy applies)
  redaction: "none" | "applied" | "excluded_by_policy"
  encoding: "utf8" | "bytes" | "mixed"
}

export interface ResultGap {
  stream: "stdout" | "stderr" | "terminal" | "payload" | "output"
  reason: "capture_limit" | "storage_limit" | "eviction" | "redaction" | "failure" | "inaccessible" | "not_captured"
  fromByte?: number              // where coverage stops
  toByte?: number
}

export interface DeliveryCoverage {
  stream: "stdout" | "stderr" | "terminal" | "payload" | "output"
  ranges: { fromByte: number; toByte: number }[]   // retained coverage, in order
  deliveredRanges?: { fromByte: number; toByte: number }[]
}
```

Rule: a result may be `status: "complete"` for delivery while storage is incomplete, and vice versa. The words "retained", "incomplete", "evicted", "missing", "not authorized" keep their distinct meanings (design §4.2, §4.5).

### 4.3 Evidence access contract (read-only service, Stage 2)

```ts
export interface EvidenceAccess {
  /** Resolve one observation by UUID; optional invocation-id alias. Enforces project/host/root scope. */
  get(observationId: string, options?: { invocationId?: string }): Promise<EvidenceObservation>
  /** Bounded inclusive retrieval over retained content. Never re-runs the original tool. */
  range(observationId: string, request: RangeRequest): Promise<RetrievedSpan>
  /** Literal and optional regex search over retained output with continuation. Zero matches is success. */
  search(observationId: string, request: SearchRequest): Promise<SearchPage>
  /** Filter observations by source path, fingerprint, tool, time, status, project — bounded. */
  find(filter: EvidenceFilter): Promise<EvidenceMatch[]>
}

export interface RangeRequest {
  stream?: "stdout" | "stderr" | "terminal" | "payload" | "output"   // default "output" for non-command results
  startLine?: number; endLine?: number                  // 1-based, inclusive
  startChar?: number; endChar?: number                  // 1-based character offsets on one line
  startByte?: number; endByte?: number                  // zero-based, half-open [startByte,endByte) in original bytes
}

export interface RetrievedSpan {
  observationId: string
  stream: "stdout" | "stderr" | "terminal" | "payload" | "output"
  requested: RangeRequest
  coverage: { fromLine?: number; toLine?: number; fromByte: number; toByte: number }
  text?: string
  state: "retained" | "partial_prefix" | "missing_tail" | "unknown_content" | "evicted" | "not_retrievable"
  completeness: { captured: CaptureCompleteness; stored: StorageCompleteness }
  originalHash?: string            // the fingerprint as it was observed, not a current one
  provenance: { toolName: string; path?: string; observedAt: string; executionId?: string }
  continuation?: { nextByte?: number; cursor?: string }
}

export interface SearchPage {
  observationId: string
  query: string
  mode: "literal" | "regex"
  stream: "stdout" | "stderr" | "terminal" | "payload" | "output"
  matchCount: number               // 0 is a successful result
  matches: { line?: number; byte?: number; preview: string }[]
  contextLines?: number
  cursor?: string                  // deterministic continuation, not a rerun
  state: "retained" | "partial_prefix" | "missing_tail" | "unknown_content" | "evicted" | "not_retrievable"
}
```

Determinism and bounds: pages are ordered by `(stream, byte)`; the same request on the same stored content returns the same page; every returned page is itself size-bounded and continuable; a query result never claims coverage it does not have. Retrieval invocations are recorded as lightweight execution events (an `evidence_access_event` row) without duplicating the blob, and they are **not** stored as model-visible evidence content.

### 4.3.1 Raw BLOB search versus indexed text search

**Source of truth:** original bytes in `evidence_blobs.inline_bytes BLOB` or a verified, crash-consistent external byte object. SQLite supports bounded literal byte-pattern search with `instr(BLOB, BLOB)`, but that is a **scan**, not a general indexed full-text search. FTS5 is a text indexing facility, so it **cannot index arbitrary binary stdout/stderr as if the raw BLOB were text**.

The required `query_evidence` service offers (1) exact bounded raw-byte substring search with original offsets; (2) bounded decoded/redacted literal and regex searches with a line/character-to-byte mapping; (3) deterministic, resumable, authorized pagination. Report partial coverage and never claim zero matches across unsearched/unretained content. Index redacted permitted text in a **derived** projection, not as an alternative source of truth. An optional FTS5 acceleration/index may be added after checking driver support and actual performance; it is **not mandatory for Stage 2**. If FTS5 is introduced, its indexing, eviction, redaction, offsets and rebuild consistency require tests. A raw secret that is withheld from retrieval must never leak via a search preview or index.

Model-visible `start_line/end_line` remain 1-based inclusive. Internal byte offsets for chunks, lines and range retrieval are **zero-based half-open `[start,end)`**. Keep original bytes intact for invalid UTF-8 and NULs; decoded character positions are explicitly mapped to raw bytes rather than assumed equal.

### 4.4 Stale-to-current contract (Stage 5)

```ts
export type CurrentResolution =
  | { state: "current"; observationId: string; contentHash: string; path: string; contentRef?: string }
  | { state: "unchanged"; observationId: string; contentHash: string; path: string }
  | { state: "deleted"; previousObservationId: string }
  | { state: "moved"; observationId: string; path: string; link: "recorded_move" | "rename_event" }
  | { state: "ambiguous"; previousObservationId: string; candidates: string[] }   // bounded, authorized only
  | { state: "unknown"; previousObservationId: string; reason: string }
  | { state: "not_found" | "history_unavailable"; reason: string }
  | { state: "permission_denied"; reason: string }
  | { state: "not_applicable"; reason: string; suggestedOperation?: string }

export interface ResolveCurrentRequest {
  observationId?: string            // preferred
  contentHash?: string              // legacy path, only with enough scope to disambiguate
  path?: string; root?: string
  startLine?: number; endLine?: number   // optional bounded current range in the same response
}
```

Invariants (from design §6.1): historical identity is a lineage query, not permission; follow recorded path/rename links, never "find any file with this hash"; verify existence, permission scope, disk-versus-buffer selection and content at lookup time; index mappings are candidate hints, not proof; concurrent edits return `unknown`/race, never a current claim; if a verified authorized observation already exists, return its ID and hash without re-reading; otherwise perform one explicit authorized read and store it before answering; every successful fresh lookup records provenance (`supersedes_observation_id` / `derived_from_observation_id`); a lookup must not be usable to bypass `edit_lines` concurrency or authorization guards.

### 4.5 Favourite contract (Stage 6)

```ts
export interface FavouriteOperation {
  observationId: string   // exactly one UUID per model tool call
  favourite: boolean     // true to mark, false to unmark
  requestId: string      // idempotent one-item request identity
}
export interface FavouriteOutcome {
  observationId?: string // omit if existence would disclose restricted identity
  state: "changed" | "already" | "unknown" | "denied"
}
```

**One model call changes one observation, never multiple.** The deliberate tool-call cost makes indiscriminate pinning unattractive. Reject arrays/batch inputs. Store request replay separately in `evidence_favourite_requests`, so a replay after unmark is idempotent; reject reuse of the same `requestId` for different parameters. Storage updates metadata only; the immutable observation body is never modified. Model-facing read output omits `favourite` when default false, though an explicit **unmark input** naturally sends `favourite:false`. A favourite cannot override storage quotas or stale validity.

### 4.6 Projection contract (Stage 8)

```ts
export type SegmentKind = "user_instruction" | "system_policy" | "task_state" | "assistant_reply" | "evidence_projection"
export interface ProjectedSegment {
  id: string
  kind: SegmentKind
  observationId?: string
  protected: boolean            // user input and mandatory system/task state are inherently protected
  favourite: boolean            // ordinary evidence starts false; never emitted when false
  ageOrder: number              // deterministic chronology key
  chars: number
  tokens: number
  relevance: number             // tie-breaker only, never age alone
}

export interface ProjectorSettings {
  enabled: boolean
  thresholdPercent: number      // 40–95, step 5, default 80
  strategy: "two-tier" | "stale-first"   // two-tier is the default
  hysteresisPoints: number      // internal target = threshold − hysteresis (default 5)
}

export interface ProjectionResult {
  segments: ProjectedSegment[]
  removedStale: number
  removedValid: number
  compactedFavourites: number
  tokensBefore: number; tokensAfter: number
  utilizationBefore: number; utilizationAfter: number
  threshold: number
  reason: string
  pairsPreserved: boolean       // tool call/result pairing intact
  duplicateExecutionPrevented: boolean
}
```

Determinism: the same segments, settings and token estimates produce the same projection. The projector never mutates stored records; it produces a message list. It reports which segments became references and why. A reference carries `observationId`, original obsolete hash (never the new hash), `reason` and only supported retrieval calls.

### 4.7 Sparse envelope contract (Stage 3)

Use plain text for a complete, unexceptional short result. Emit an envelope only when integrity, status or retrieval semantics require it. A model-facing example (illustrative, not mandated field names):

```json
{"observation_id":"<uuid>","tool":"read_file","original_hash":"xxh64:<old>","delivery":"partial","retrieve":{"tool":"query_evidence","start_line":687,"end_line":710}}
```

Rules: no `favourite:false`; no empty arrays; no null placeholders; no repeated path/hash; no duplicated status. Failed operations always carry execution truth (`executed`), failure status and an actionable next step, even under sparse encoding.

### 4.8 Managed-command compatibility contract (Stage 10 defines, does not implement)

The shapes below are the interface the future managed `run_command` consumes; they must exist as types and be exercised against the existing one-shot path without changing command behaviour.

```ts
export type ExecutionState = "accepted" | "queued" | "starting" | "running" | "exited" | "failed_to_start" | "cancelled" | "timed_out" | "lost" | "unknown"
export interface CommandEvidence {
  invocationId: string
  executionId?: string
  sessionId?: string
  batchId?: string
  children?: string[]
  cwd?: string; hostKey?: string
  state: ExecutionState
  exitCode?: number; signal?: string; terminationReason?: "exit" | "signal" | "timeout" | "cancel" | "lost" | "spawn_error"
  streams?: { stdout?: string; stderr?: string; terminal?: string } // PTY output is merged
  captureMode?: "pipes" | "pty" | "terminal_merged" | "unknown" | "not_applicable"
  inputEventRefs?: string[] // stdin writes/control; raw secret input excluded by default
  chunkOrder?: { stream: "stdout" | "stderr" | "terminal"; seq: number }[]
  capturedComplete?: boolean; storedComplete?: boolean
}
```

**Per-command evidence rule:** every attempted command in a persistent shell has its own immutable invocation/observation UUID and, if executed, its own execution UUID, even when commands share `sessionId`. An optional session transcript is separate and is never an aggregation substituting for command evidence. Attribute output and exit status using host-controlled per-command boundaries, never spoofable prompts or stdout delimiters; startup/idle/unattributable output belongs to separate session events. Batches group child observations without collapsing them.

Rules that must hold after Stage 10: `exit_code = 0` means process success only when a terminal exit state was truly reached; a nonzero exit with useful output is a completed process, not a tool failure; "no stderr" and "stderr not captured" are different states; starting is not completing; refused operations record `executed: false`; retrieving command output must not rerun it. Concurrency is designed for (independent IDs, jobs, stream cursors) but not implemented in this branch.

### 4.9 What Stage 10 does **not** take on

Sessions, batches, polling/cancellation, streaming, preflight parsers, shell-state semantics, `&`/`nohup`/`disown` policy and native-preference soft refusal remain in the managed-command stages. The native-tool preference guidance for agent instructions (prefer `read_file`/`grep`/evidence retrieval when authoritative results exist) **is** in this plan (Stage 11), as text guidance only — no command interception here.


---

## 5. Database and storage considerations

### 5.1 Development database policy

This is a private development branch. For schema changes during active development the established policy is **wipe/recreate the designated development database**, not migration — and that policy is already encoded in `refusedVersion` (`src/extension/todos/sqlite.ts`): a database at any other version is refused and left untouched, and the message tells the developer to delete `<home>/.twinny/project.sqlite` plus its `-wal`/`-shm` sidecars by hand.

Hard limits, binding on every stage:

- Never delete an arbitrary SQLite database.
- Never delete user or production data.
- Never silently reset a database outside the designated development environment. No stage may add automatic deletion code.
- Keep the established unified project database location and ownership model (`resolveProjectHome`, `PROJECT_TODO_DIRECTORY = ".twinny"`, `PROJECT_TODO_DATABASE_NAME = "project.sqlite"`). LanceDB/embeddings remain separate.
- Production migration requirements stay documented separately (§13): a production release would need a ladder, which this branch does not build.
- New schema work is written as complete `CREATE TABLE` text in the v21 SCHEMA; tests that count objects must be regenerated from the new DDL, exactly as Stage 4 of the unified plan did for v20.

The designated development database for this branch is the project database of a scratch test project under `/tmp` created by the test harness (`fs.mkdtempSync`), never anything in the repository tree. A stage that needs to exercise a schema bump may do so on its own temp database; it must not touch the developer's real `.twinny/project.sqlite`. Stage 1 must freeze the **complete** v21 schema (including `validity_class`, `context_segments`, favourite replay and projection tables); Stages 4 and 6 consume those objects and must not introduce another schema version.

### 5.2 v21 schema additions (Stage 1 owns this DDL)

Additive tables only; `todo_tool_observations` and `todo_tool_evidence` keep their existing meaning and columns, with a small additive set:

```sql
-- Added to todo_tool_observations (all additive, existing consumers unaffected)
executed          INTEGER NOT NULL DEFAULT 1 CHECK (executed IN (0,1)),
call_id           TEXT,
host_key          TEXT NOT NULL DEFAULT '',
started_at        TEXT,
finished_at       TEXT,
outcome_id        TEXT REFERENCES evidence_outcomes(id),
error_code        TEXT CHECK (error_code IS NULL OR error_code = 'refused_before_execution'),
validity_class    TEXT CHECK (validity_class IS NULL OR validity_class IN ('current','stale','unknown','historical','superseded')) -- audit only; current boundary remains authoritative

CREATE TABLE evidence_outcomes (
  id TEXT PRIMARY KEY,
  observation_id TEXT NOT NULL UNIQUE REFERENCES todo_tool_observations(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES todo_projects(id),
  execution_ref TEXT,                                   -- per-command process identity, not shell session
  session_id TEXT,                                      -- shared by commands in one persistent shell
  batch_id TEXT,                                        -- optional grouping; never consolidated evidence
  command_sequence INTEGER,                            -- optional session-local order
  status TEXT NOT NULL CHECK (status IN ('accepted','queued','starting','running','completed','exited','failed_to_start','cancelled','timed_out','lost','refused','unknown')),
  exit_code INTEGER,
  signal TEXT,
  termination_reason TEXT CHECK (termination_reason IS NULL OR termination_reason IN ('exit','signal','timeout','cancel','lost','spawn_error')),
  stdout_blob_id TEXT REFERENCES evidence_blobs(id),
  stderr_blob_id TEXT REFERENCES evidence_blobs(id),
  terminal_blob_id TEXT REFERENCES evidence_blobs(id), -- merged PTY transcript; never invent stderr
  capture_mode TEXT NOT NULL DEFAULT 'unknown' CHECK (capture_mode IN ('pipes','pty','terminal_merged','unknown','not_applicable')),
  payload_blob_id TEXT REFERENCES evidence_blobs(id),
  captured_complete INTEGER NOT NULL DEFAULT 0 CHECK (captured_complete IN (0,1)),
  storage_complete INTEGER NOT NULL DEFAULT 0 CHECK (storage_complete IN (0,1)),
  gap_reason TEXT CHECK (gap_reason IS NULL OR gap_reason IN ('capture_limit','storage_limit','eviction','redaction','failure','inaccessible','not_captured','storage_error')),
  created_at TEXT NOT NULL
);

CREATE TABLE evidence_blobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES todo_projects(id),
  content_digest TEXT NOT NULL,                         -- sha256 of stored bytes, content-addressed
  storage_kind TEXT NOT NULL CHECK (storage_kind IN ('inline','file')),
  relative_path TEXT,                                   -- storage_kind = 'file': under .twinny/blobs/
  inline_bytes BLOB,                                    -- inline exact original bytes incl binary/NUL
  original_bytes INTEGER NOT NULL,
  stored_bytes INTEGER NOT NULL,
  encoding TEXT NOT NULL DEFAULT 'bytes' CHECK (encoding IN ('utf8','bytes','mixed')),
  byte_preservation TEXT NOT NULL DEFAULT 'lossless' CHECK (byte_preservation IN ('lossless','normalized','excluded')),
  redaction TEXT NOT NULL DEFAULT 'none' CHECK (redaction IN ('none','applied','excluded_by_policy')),
  created_at TEXT NOT NULL,
  evicted_at TEXT,
  UNIQUE (project_id, content_digest)
);

CREATE TABLE evidence_chunks (
  outcome_id TEXT NOT NULL REFERENCES evidence_outcomes(id) ON DELETE CASCADE,
  stream TEXT NOT NULL CHECK (stream IN ('stdout','stderr','terminal','payload')),
  seq INTEGER NOT NULL,
  byte_start INTEGER NOT NULL,                          -- inclusive
  byte_end INTEGER NOT NULL,                            -- exclusive [start,end)
  received_at TEXT NOT NULL,
  PRIMARY KEY (outcome_id, stream, seq)
);

-- stdin writes and process control remain distinct from child output.
CREATE TABLE evidence_io_events (
  id TEXT PRIMARY KEY,
  outcome_id TEXT NOT NULL REFERENCES evidence_outcomes(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('stdin_write','stdin_close','spawn','exit','signal','cancel','timeout','pty_control','capture_gap')),
  byte_count INTEGER,
  result TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  details_json TEXT,                                   -- bounded/redacted; raw secret stdin excluded by default
  UNIQUE (outcome_id, seq)
);

CREATE TABLE evidence_lines (
  blob_id TEXT NOT NULL REFERENCES evidence_blobs(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,                             -- 1-based
  char_start INTEGER NOT NULL,
  char_end INTEGER NOT NULL,
  byte_start INTEGER NOT NULL,                          -- inclusive
  byte_end INTEGER NOT NULL,                            -- exclusive [start,end)
  PRIMARY KEY (blob_id, line_no)
);

CREATE TABLE evidence_dependencies (
  derived_observation_id TEXT NOT NULL REFERENCES todo_tool_observations(id) ON DELETE CASCADE,
  source_observation_id TEXT NOT NULL REFERENCES todo_tool_observations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('source_read','derived_claim','accepted_fact','supersedes')),
  established_at TEXT NOT NULL,
  PRIMARY KEY (derived_observation_id, source_observation_id, kind),
  CHECK (derived_observation_id <> source_observation_id)
);

CREATE TABLE evidence_favourites (
  observation_id TEXT PRIMARY KEY REFERENCES todo_tool_observations(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES todo_projects(id),
  marked_at TEXT NOT NULL
);
-- Persist one-item request replay history independently from favourite membership:
-- an unmark removes a favourite but must not erase its original outcome.
CREATE TABLE evidence_favourite_requests (
  project_id TEXT NOT NULL REFERENCES todo_projects(id),
  request_id TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('mark','unmark')),
  result TEXT NOT NULL CHECK (result IN ('changed','already','unknown','denied')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, request_id)
);

CREATE TABLE evidence_access_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES todo_projects(id),
  observation_id TEXT NOT NULL REFERENCES todo_tool_observations(id) ON DELETE CASCADE,
  operation TEXT NOT NULL CHECK (operation IN ('get','range','search','find','resolve_current')),
  arguments_json TEXT NOT NULL,
  outcome TEXT NOT NULL,                                 -- the state string the service returned
  execution_id TEXT,
  created_at TEXT NOT NULL
);

-- Stage 1 creates this table now; Stage 6 activates protection, Stage 8 consumes it.
CREATE TABLE context_segments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES todo_projects(id),
  conversation_id TEXT NOT NULL,
  execution_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('user_instruction','system_policy','task_state','assistant_reply','evidence_projection')),
  observation_id TEXT REFERENCES todo_tool_observations(id),
  protected INTEGER NOT NULL DEFAULT 0 CHECK (protected IN (0,1)),
  favourite INTEGER NOT NULL DEFAULT 0 CHECK (favourite IN (0,1)),
  age_order INTEGER NOT NULL,
  approx_tokens INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (kind <> 'user_instruction' OR protected = 1)
);
CREATE INDEX context_segments_conversation ON context_segments(conversation_id, kind, age_order);
CREATE INDEX context_segments_observation ON context_segments(observation_id);

CREATE TABLE context_projections (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES todo_projects(id),
  conversation_id TEXT NOT NULL,
  execution_id TEXT,
  request_seq INTEGER NOT NULL,
  capacity_tokens INTEGER NOT NULL,
  threshold_percent INTEGER NOT NULL,
  utilization_before INTEGER NOT NULL,
  utilization_after INTEGER NOT NULL,
  removed_stale INTEGER NOT NULL DEFAULT 0,
  removed_valid INTEGER NOT NULL DEFAULT 0,
  compacted_favourites INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE context_projection_segments (
  projection_id TEXT NOT NULL REFERENCES context_projections(id) ON DELETE CASCADE,
  segment_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('user_instruction','system_policy','task_state','assistant_reply','evidence_projection')),
  observation_id TEXT,
  decision TEXT NOT NULL CHECK (decision IN ('kept','reference','compact_reference','removed')),
  tokens INTEGER NOT NULL,
  PRIMARY KEY (projection_id, segment_id)
);

CREATE TABLE storage_policy (
  project_id TEXT PRIMARY KEY REFERENCES todo_projects(id),
  max_project_bytes INTEGER NOT NULL,
  max_blob_bytes INTEGER NOT NULL,
  eviction_order TEXT NOT NULL DEFAULT 'oldest_unfavourited_first',
  redaction_mode TEXT NOT NULL DEFAULT 'presentation_only',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1))
);
```

`todo_tool_evidence` is **not** replaced. It remains the presentation copy (redacted text, sources, hits) that Feedback and lookup already read; `evidence_blobs` becomes the authoritative byte store. Store inline payloads as actual SQLite BLOB bytes, not TEXT; crash-safe external file references need a staged-write, atomic rename and reconciliation protocol because a SQLite transaction alone does not atomically commit filesystem objects. Where both exist, tests must prove they report the same coverage and disagree only in the documented way (blob = original bytes, evidence row = redacted presentation).

### 5.3 Project `config.json` storage policy (Stage 1)

**Authoritative source:** `<projectHome>/.twinny/config.json` next to `project.sqlite`, resolved using the existing `resolveProjectHome` rules. Stage 0 must inspect any existing configuration conventions and preserve unrelated content. This is **not** the separate gateway config.json. A missing file uses safe documented defaults; never overwrite a user file automatically.

~~~json
{
  "evidence": {
    "storage": {
      "maxProjectBytes": 64000000,
      "maxBlobBytes": 2000000,
      "evictionOrder": "oldest_unfavourited_first",
      "enabled": true
    }
  }
}
~~~

- Limits and retention/eviction policy are configurable in this JSON file. Validate strict types, byte units, sensible bounds, policy enum and nonnegative values. Report invalid JSON/configuration as an actionable error; **do not** silently fall back, overwrite or reset the database when an existing file is invalid.
- Maintain a single source of truth: the database `storage_policy` table is a derived effective-policy snapshot/audit row, not an independent setting. Do not add the quota values as independently mutable `package.json`/VS Code settings.
- Document effective defaults, reload/invalidation behavior and accounting of inline and file-backed blobs, deduplication, metadata and pending writes. New settings apply safely at the next storage operation; changing config never silently deletes evidence or bypasses authorization.
- Explicitly report exact captured/stored coverage and why any limit was reached. A favourite affects eviction priority only, not project/blob caps; before Stage 6, use oldest-first and report the policy actually used.
- Test with a real scratch-project config.json: missing/default, custom quotas, eviction order, reload, corrupt JSON, invalid types/values, preservation of other keys and no accidental modification of the developer's project database.

---

## 6. Stage index, dependency graph and how to read a stage

```text
0 → 1 → 2 → 3 → 10 ─────────────────┐
    ├→ 4 → 5                        │
    └→ 6 → 8 → 9 ────────────────────┤
0 → 7 ──────→ 8                     ├→ 11 → 12
               8 also needs 2,4,6 │
              10 needs 1,2,3 ───────┘
11 needs 3,4,8,9,10; 12 needs all prior stages.
```


| Stage | Depends on | Touches VS Code-only code? | Main modules |
|---|---|---|---|
| 0 | — | no | audit only |
| 1 | 0 | `chat/tool-evidence.ts` wiring → **[VS Code suite]** | `todos/evidence-store.ts` (new), `todos/sqlite.ts` SCHEMA, `tools/budget.ts` completeness types |
| 2 | 1 | no | `todos/evidence-access.ts` (new) |
| 3 | 2 | tool registration in `tools/workspace.ts` | `tools/evidence.ts` (new), `tools/protocol.ts` guidance |
| 4 | 1 | `chat/index.ts`, `workspace-index/index.ts` → **[VS Code suite]** | `todos/source-validity.ts`, `todos/dependency-index.ts` (new) |
| 5 | 2, 4 | `chat/index.ts` (source reader) → **[VS Code suite]** | `todos/current-resolution.ts` (new), `tools/evidence.ts` |
| 6 | 1, 4 | no | `todos/favourites.ts` (new), `tools/evidence.ts`; Stage 8 owns projector-dependent tests |
| 7 | 0 | `inference/context-window.ts`, `chat/index.ts` → **[VS Code suite]** | `tools/budget.ts`, `inference/context-window.ts` |
| 8 | 2, 4, 6, 7 | no (pure) | `context/projector.ts` (new), `context/settings.ts` (new) |
| 9 | 8 | **[VS Code suite]** + webview | `tools/loop.ts`, `chat/index.ts`, `webview/agent-settings.tsx`, `package.json` |
| 10 | 1, 2, 3 | `chat/tool-sinks.ts` → **[VS Code suite]** | `tools/command-evidence.ts` (new); prove actual separate stream capture in the production command path |
| 11 | 3, 4, 8, 9, **10** | no | `tools/response-guidance.ts` (new), `tools/budget.ts`, `tools/workspace.ts`, `todos/evidence.ts`, `tools/todos.ts` |
| 12 | all | **[VS Code suite]** | verification only |

Every stage below carries the same fifteen parts in the same order: goal and scope; prerequisites; existing components reused; files expected to change; schema changes; new interfaces/contracts; implementation instructions; safety and backwards compatibility; required unit and integration tests; negative and adversarial tests; verification commands; acceptance criteria; completion report; conditions that prevent declaring the stage complete.


---

## 7. Stages

### Stage 0 — Current-code audit, storage contract and baseline reproductions

**Depends on:** nothing. **Read-only stage: no source, schema, test or configuration change.** Only this plan's Progress Log row is written.

**Goal:** re-verify the gap analysis in §3 against the current tree, measure the baselines this plan will be judged against, and freeze Stage 1's storage contract before any code changes. Line numbers from earlier conversations (including the unified plan) must not be reused as facts.

**Steps**

1. `git status --short`, `git rev-parse --abbrev-ref HEAD`, `git branch --list` — record them; confirm the branch is `context-management`.
2. Run every gate in §0.3 and record actual counts (planning-time expectation: standalone 1161/1161, tsc exit 0, eslint 0 findings).
3. Re-measure the design's reproduction case against the current branch, read-only, and record it as this stage's baseline:
   - read `docs/Moriarty_Unified_Index_Evidence_Implementation_Plan.md` (1374 lines) whole;
   - record the character count of the delivered result, the lines actually delivered at a 65,536-token capacity, what the evidence row retained, and whether the tail was recoverable. The design recorded 207,507 characters delivered as 42,077 (lines 1–25) with retention to line 1318; the numbers must be re-measured, not copied.
   - confirm whether `twinny_evidence_lookup` returns metadata only and that no range tool exists (`grep -rn "query_evidence" src`).
4. Confirm that §5.2 contains the **entire** Stage 1 v21 schema, including later-stage tables/columns, and inspect the project config.json conventions and collision risk. Inventory the actual project database APIs Stage 1 will extend: `recordToolObservation`, `retainedEvidenceFor`, `projectObservations`, `findRelocationCandidates`, `preserveEvidence`, `compactToolEvidence`, `enforceEvidenceBudget`, `SourceRoots.recordObservationSources`, `SourceValidityBoundary`; record the current caps (`MAX_EVIDENCE_TEXT`, `MAX_RETAINED_EVIDENCE_CHARS`, `DEFAULT_EVIDENCE_STORAGE_LIMITS`, `MAX_CAPTURE_CHARS`, `OUTPUT_TAIL`) with their file and the symbol, not a line number.
5. Record the model-visible pipeline for one tool result end to end: dispatch → `ToolResult` → per-result fit → conversation slot → request estimate → trim/omit → recorded observation. Name each function actually used. **Also inspect both current terminal and background command transport paths: identify which expose raw separate stdout/stderr, which expose only merged terminal bytes, how commands are launched, and where stdout/stderr bytes are already lost. Freeze one-launch, capture-at-spawn and truthful PTY capability contracts before Stage 1's schema is accepted.**
6. Record permissions still in force (`access-grants.ts`, `access-preflight.ts`, `operation-authorization.ts`, `isProtectedPath`) and confirm no stage may bypass them.
7. Confirm the gates' VS Code suite list (`.vscode-test.js`) and which configured files actually run. The four scopes and the full-suite procedure are recorded in §0.3.
8. Fill Progress Log row 0 with the measured numbers and every deviation from §3 you found; state explicitly that §3's status column changed if it did.

**Prerequisites:** the three design documents and §4/§5 of this plan; nothing else.

**Existing components reused:** every symbol named in step 4 — this stage writes no code, so its value is the contract it freezes for Stage 1.

**Files expected to change:** none. **Schema changes:** none; this stage records the live v20 inventory and confirms §5.2 against it.

**Tests:** none, because nothing changes behaviour. The baselines it records are what every later stage compares against; a gate failure is recorded as an exception here, not fixed.

**Verification commands:** the §0.3 gates exactly as run in step 2, plus `grep -rn "query_evidence" src` (must find nothing) and `grep -n "MAX_EVIDENCE_TEXT\|MAX_RETAINED_EVIDENCE_CHARS\|DEFAULT_EVIDENCE_STORAGE_LIMITS" src/extension/todos/evidence.ts`, and the standalone suite run that gives the counted baseline.


**Safety and backwards compatibility:** read-only. Compatibility is proven by the gates themselves — every existing test passes exactly as before this stage, and no baseline is restated from memory.

**Acceptance criteria**

- No file other than this plan's Progress Log row differs from the stage's start (`git --no-pager diff --check` clean; `git status --short` shows at most this plan).
- Every §3 row marked Done/Partial/Missing is supported by a named symbol in the current tree, and any correction is recorded in the Notes column.
- The reproduction numbers are measured, not quoted from the design.

**Conditions that prevent declaring complete:** any source/schema/test/configuration edit; a gate that fails without an exact recorded error; a baseline number copied instead of measured; the working branch being different from `context-management`.

```
You are executing Stage 0 of docs/Moriarty_Context_Management_Implementation_Plan.md in /home/stark/source/twinny (branch context-management). Do not commit.
Read §0, §1, §2, §3, §4, §5, the Progress Log and Stage 0. Run the gates, measure the reproduction, inventory the storage APIs, record actual numbers in the Progress Log, change no source file, and finish with the §0.5 report.
```

---

### Stage 1 — Complete durable evidence capture: invocation, outcome, blob

**Depends on:** Stage 0. **[VS Code suite]** (the recording path runs in the extension host).

**Goal:** store each captured invocation/outcome before display fitting with a generic, byte-preserving storage interface for independent stdout/stderr streams, status, errors, timing, identities and honest completeness. **Stage 1 validates independent streams with synthetic inputs; it does not claim the current production `run_command` sink provides them. Stage 10 wires and verifies actual command stream separation.** No silent cap: when a limit prevents retention, record exact coverage.

**Prerequisites:** Stage 0's frozen contract (§4.2, §5.2). The development database is reset by hand (delete `project.sqlite`, `-wal`, `-shm`) on the designated dev database — see §5.1; no migration ladder is written.

**Existing components reused (do not reimplement):** `SqliteFile` and the v20 SCHEMA (`todos/sqlite.ts`), `SourceRoots` (`todos/source-roots.ts`), `redactEvidence`/`preserveEvidence`/`compactToolEvidence`/`observationArguments` (`todos/evidence.ts`), `chat/tool-evidence.ts` (`isRecordableToolResult`, `toolObservationInput`, `recordToolResult`, `reportRecordFailure`), `repository.recordToolObservation` (replay idempotency per `(project_id, request_id)`), `TokenEstimator`, the existing read-only refusal path in `arguments.ts` (`argumentFailure` with `executed: false`).

**Files expected to change**

- new `src/extension/todos/evidence-store.ts` (capture + persistence; no `vscode` import)
- `src/extension/todos/sqlite.ts` (SCHEMA to v21 with §5.2, `CURRENT_SCHEMA_VERSION = 21`)
- `src/extension/todos/repository.ts` (`recordToolObservation` gains the outcome write; `retainedEvidenceFor` reports capture/storage states)
- `src/extension/todos/types.ts` (additive types; `TodoToolObservationInput`, `RetainedObservationEvidence`)
- `src/common/types.ts` (`ToolResultIntegrity` additive fields per §4.2)
- `src/extension/chat/tool-evidence.ts` (`toolObservationInput` passes the raw capture, including for failed calls)
- `src/extension/tools/workspace.ts` (`ToolResult.execution` gains stream references; nothing in tool behaviour changes)
- new `src/extension/todos/evidence-config.ts` (typed project `config.json` reader/validator, defaults, safe reload and effective-policy diagnostics; avoid coupling to gateway config)
- config format documentation/example; do not add independent evidence quotas to `package.json`
- tests: new `src/test/standalone/evidence-storage.standalone.ts`; additions to `todos-sqlite.standalone.ts`, `chat-tools.standalone.ts`, `tool-loop.standalone.ts`, and one suite test in `src/test/suite/agent-reply.test.ts`

**Schema changes:** **complete** §5.2 v21 SCHEMA, including `validity_class`, `context_segments` and indexes, favourite membership/replay, and all later-stage projection tables. No later stage adds surprise DDL. Regenerate the object-count tests from the new DDL (tables, named indexes, triggers) exactly as Stage 4 of the unified plan required; add indexes `evidence_outcomes_observation`, `evidence_blobs_project`, `evidence_chunks_order`, `evidence_lines_lookup`, `evidence_dependencies_source`, `evidence_favourites_project`, `evidence_access_events_project`, `context_projections_project`.

**New interfaces (this stage's contract for later stages)**

```ts
export interface CapturedResult {          // before fitting, straight from the tool
  invocationId: string
  executionId?: string
  sessionId?: string        // shared across calls; NOT a command observation ID
  batchId?: string
  toolName: string
  args: Record<string, unknown>              // typed original arguments, preserved as sent
  executed: boolean
  status: ExecutionState                     // §4.8 enumeration
  streams: { stdout?: Buffer; stderr?: Buffer; terminal?: Buffer }
  captureMode: "pipes" | "pty" | "terminal_merged" | "unknown" | "not_applicable"
  chunks: { stream: "stdout" | "stderr" | "terminal"; seq: number; bytes: Buffer; receivedAt: string }[]
  inputEvents?: { kind: "stdin_write" | "stdin_close"; byteCount: number; result: string; receivedAt: string }[]
  exitCode?: number
  signal?: string
  terminationReason?: TerminationReason
  error?: ToolErrorDetail
  startedAt: string
  finishedAt?: string
  capture: ResultCapture
}

export interface EvidenceStore {
  record(captured: CapturedResult): Promise<StoredOutcome>   // atomic, crash-consistent
  pending(invocationId: string): Promise<StoredOutcome | undefined>
}
```

**Implementation instructions**

1. `EvidenceStore.record` writes observation + outcome + blobs + chunks in **one synchronous transaction** (`SqliteFile.write`, which already rejects async closures). Pending records are written first (`status = 'starting'` or `'accepted'`), and the terminal result is appended atomically; a crash between them leaves a recoverable pending record, never a lost result.
2. Store bytes losslessly (`byte_preservation = 'lossless'`) and decode only when displaying/querying. Where policy forbids retaining raw sensitive bytes, set `redaction = 'excluded_by_policy'` and record the exclusion in `gap_reason`. Keep `todo_tool_evidence.content` as the redacted presentation copy; the blob keeps original bytes.
3. Content-addressed blobs (`UNIQUE(project_id, content_digest)`) may be shared by many observations; each timed observation stays separate and its invocation history is never merged. Inline payloads are BLOBs. External blob writes must stage bytes, verify hashes and reconcile orphan files/DB pointers after crash; never assert that the DB transaction by itself makes filesystem writes atomic.
4. Read quotas, retention and eviction settings from the project `config.json` (§5.3), with validated defaults/reload and one authoritative source. Enforce `maxBlobBytes` and `maxProjectBytes`; report `storage_complete = 0`, `gap_reason` and exact coverage when exceeded. Never invent an ID or falsely claim content is retained. The DB policy row mirrors the effective JSON settings.
5. Eviction becomes an explicit state (`evicted_at` + `gap_reason = 'eviction'`), ordered oldest-unfavourited-first (the ordering exists from Stage 6; until then, keep today's order and make the *state* honest).
6. Failed calls, refusals and skipped approvals are recorded: `executed = 0`, `status = 'refused'`, no fabricated exit code. `isRecordableToolResult` must keep declining TODO-tool self-records and non-executed commands, but a **refused command** still records an attempt.
7. Binary and invalid UTF-8 bytes round-trip losslessly or are explicitly excluded; the plan's tests prove which.
8. Retention/provenance keeps the existing model: nullable `list_id`/`item_id` as provenance only (no ownership cascade), project-scoped rows surviving task/list/conversation deletion.

**Safety and backwards compatibility**

- No tool behaviour change: no new tool, no changed output text, no changed hash protocol.
- Every existing consumer of `RetainedObservationEvidence` keeps working; new fields are additive and optional; existing tests asserting the stored shape pass unmodified.
- Access control unchanged: `WorkspaceView.resolve`, the access preflight and operation-scoped write grants still gate every path; storage never grants anything (Rule 7).
- Secrets: apply the existing `redactEvidence` policy to model-visible projections, log/diagnostic exports and range retrieval; raw retention must not silently expose secrets through a range query.

**Required tests** (`node:test`, production paths; new file `evidence-storage.standalone.ts`)

1. *a complete tool result is stored before display fitting and the delivered copy is smaller than the stored bytes*
2. *a failed call records its typed arguments, status, timing and structured error, and nothing claims it executed*
3. *a refused command records an attempt with `executed = false` and no exit code*
4. *synthetic independent stdout and stderr streams round-trip separately in BLOB storage; a synthetic merged `terminal` stream remains a single truthfully named stream* (real end-to-end command capture belongs to Stage 10)
5. *invalid UTF-8 and binary bytes round-trip losslessly, or are recorded as excluded by policy*
6. *the storage limit is reported honestly: a result larger than `maxBlobBytes` is recorded incomplete with the exact coverage gap, and no phantom blob ID exists*
7. *project storage exhaustion is visible: report `storage_limit`/partial on a capped write and `evicted` only on an actual eviction, never a false `retained`*
  7a. *project config.json defaults/overrides/reload/invalid JSON/invalid values and unrelated-key preservation are tested on scratch projects*
8. *crash between a streamed chunk and the final status leaves a recoverable pending record that a reopen reconciles to `lost` or `unknown`, never to success*
9. *replay of the same request idempotently returns the prior observation with its outcome; no second row, no rerun*
10. *observations, outcomes, blobs, chunks, lines and dependencies survive deletion of a task, a list and a conversation* (extend the existing unified-database Stage 11 survival tests)
11. **[VS Code suite]** in `agent-reply.test.ts`: *the real hook stores the raw bytes of one tool result before the loop fits it*, comparing the recorded `originalChars`/`originalBytes` with what the model received.

**Negative and adversarial tests**

- huge single line (over `MAX_LINE_FRAGMENT_CHARS`) stored whole, its line index bounded;
- two different files producing the same content digest → one blob, two observations, both retrievable by their own UUID;
- redaction that would change bytes must not be presented as lossless;
- cross-project observation access denied, and a cross-project UUID does not leak which project it belongs to;
- storage write failure reported as `storage_error`, never as a successful record;
- a partial delivery for a successful tool stays successful; an unsuccessful tool stays unsuccessful even when its output was captured completely.

**Verification commands:** the §0.3 gates, plus `node --test out/test/standalone/evidence-storage.standalone.ts` and the VS Code suite (or exact `NOT RUN`).

**Acceptance criteria**

- Every number in a recorded completeness field is measured by the stage's own tests, not asserted.
- The Stage 0 reproduction case: capture the whole 1,374-line plan once; the storage layer retains all of it (no 200K silent cap), and the record reports `original`/`captured`/`stored` independently. Retrieval itself is Stage 2, so this stage proves *storage completeness*, not delivery.
- No existing test changed except those this stage names; Formatting-only differences are not an approval gate.

**Completion report:** the §0.5 format plus the measured before/after object counts for the v21 inventory, and the exact reproduction numbers.

**Cannot be declared complete if:** any existing assertion was weakened or skipped; a completeness state is claimed without a test; the schema version was changed without the refusal-path test passing; any code path deletes a database by itself; the VS Code suite pass was claimed without observing it.

**Copy/paste prompt for Stage 1 (new Moriarty conversation):**

```text
You are implementing Stage 1 of docs/Moriarty_Context_Management_Implementation_Plan.md in /home/stark/source/twinny on branch context-management. Do not commit.

Read §0, §1, §2, §3, §4, §5, the Progress Log, the full Stage 1 section, and only the referenced design/contract sections needed for this stage. Confirm Stage 0 is marked done with recorded verification before editing. Check current branch/status and existing accepted evidence first; do not trust historical line numbers.

Stage 1 scope: Implement the complete v21 SQLite schema and durable byte-preserving invocation/outcome/BLOB capture, config.json storage policy, honest completeness and synthetic independent stdout/stderr and PTY cases. Stage 10, not this stage, owns real run_command stream capture. Keep existing evidence/feedback behavior intact.

Follow every Stage 1 instruction, acceptance criterion, negative/adversarial test, authorization boundary and no-go condition. Do only Stage 1; do not implement later stages or change stage contracts. Run §0.3 verification gates and this stage's focused tests, report actual exit codes and test totals. A timed-out or incomplete VS Code test run is NOT a pass. Preserve unrelated working-tree changes and development database safety policy.

Update only the Stage 1 Progress Log row with actual measured results and deviations. Finish with the complete §0.5 Stage 1 report, including changed files, commands/results, acceptance status, negative tests, blockers and remaining work. Do not start Stage 2.
```

---

### Stage 2 — Read-only evidence access service

**Depends on:** Stage 1.

**Goal:** the §4.3 service: resolve by observation UUID, bounded inclusive line ranges, character and byte offsets, fragments of extremely long lines, stream selection, search/filter with deterministic pagination and continuation, explicit `incomplete` / `evicted` / `missing` / `inaccessible` states. Retrieval never reruns the original tool.

**Prerequisites:** Stage 1's outcomes, blobs, chunks, line index and honest completeness states.

**Existing components reused:** `SourceRoots` (canonical path identity), `todos/evidence.ts` (`EvidenceSource`, `EvidenceHit`, `samePath`, `redactEvidence`), the repository's `retainedEvidenceFor`/`projectObservations` query style, `WorkspaceView` for authorization scope, the existing `MAX_EXCERPT_CHARS`/`MAX_WINDOW_CHARS` budget style. Do not create a second evidence cache.

**Files expected to change**

- new `src/extension/todos/evidence-access.ts` (`vscode`-free service implementing §4.3)
- `src/extension/todos/repository.ts` (exposes the access service through the same boundary it already owns)
- `src/extension/todos/types.ts` (§4.3 types)
- new `src/test/standalone/evidence-access.standalone.ts`; additions to `todos-sqlite.standalone.ts`

**Schema changes:** none beyond Stage 1. `evidence_access_events` records retrieval calls as lightweight execution events; it must not copy blob content.

**New contract:** exactly §4.3, plus the conversions stated unambiguously: line numbers are 1-based inclusive over the *stored* content; character offsets count decoded UTF-8 code units from the start of that line; byte offsets count stored bytes; when `byte_preservation = 'normalized'`, a byte query reports the normalization in its own words and the returned span is bounded to what exists.

**Implementation instructions**

1. Resolve by UUID first (invocation id as an optional alias); scope by project, host key and authorized roots before any content is read.
2. Serve from stored bytes/lines, never from `read_file` or a rerun; if the content is not there, return the state (`evicted`, `missing_tail`, `unknown_content`, `inaccessible`) with the exact coverage that *is* there.
3. Every returned page is size-bounded and continuable through a deterministic cursor (`(stream, byte)`), and the same cursor returns the same next page.
4. Search supports literal and optional regex with bounded computation, surrounding context lines, exact match counts where bounds allow, and `match_count: 0` as a **success**. A search that runs out of its bound reports the bound, not a false total.
5. Filter by source path, fingerprint, tool, time/execution, status and project when authorized, bounded by an explicit limit; general lookup stays discoverable without dumping a huge list.
6. Record each access as an event row with arguments and outcome, deduplicating references to underlying blobs (no evidence-of-evidence chains).
7. Report provenance in every result: original hash/UUID, tool, path, observed time, execution id, completeness. A stale observation retrieved as historical evidence is labelled historical, never presented as current source.

**Safety and backwards compatibility:** no existing lookup, Feedback, preflight or export path changes behaviour; `RetrievedSpan` and `SearchPage` are new shapes, not replacements for `EvidenceSource`/`EvidenceHit`. Redaction applies to every returned span before it reaches the model, and a read-only service result grants no access: a denied scope returns no content and no candidate names.

**Required tests** (production service over a real `TodoRepository`)

1. *the 1,374-line plan reproduction: beginning, line 687 and the final non-empty line come from durable evidence without repeating read_file* — verify original bytes and model-delivery coverage independently.
2. *long-line fragments and exact byte offsets round-trip, and a query beyond stored coverage returns the state that is true*
3. *stdout and stderr selection returns each stream on its own, and merged presentation is only offered where chunk order allows it*
4. *search over retained output returns zero matches as a successful result with `match_count: 0`*
5. *pagination is deterministic: the same cursor returns the same page, and a page that cannot fit reports its continuation*
6. *an evicted blob, a missing tail and an inaccessible record each report their own state and never advertise retrieval they cannot perform*
7. *cross-project and unauthorized access is refused without naming restricted candidates*
8. *retrieval records an execution event without duplicating the stored blob*

**Negative and adversarial tests:** binary stderr queried by byte offsets; invalid UTF-8 in a returned range; a request whose range crosses an eviction boundary; redaction that forbids exposing a secret line (the match count may be reported while the text is not); a query against an observation for a failed tool (no content was retained → honest state); a query result larger than its own bound; two observations sharing one content blob.

**Verification commands:** §0.3 gates + `node --test out/test/standalone/evidence-access.standalone.ts`.

**Acceptance criteria:** every state in §4.3 is reachable by at least one test; the reproduction case answers beginning/middle/end without a reread; no code path reruns a tool for retrieval.

**Cannot be declared complete if:** any state is asserted without a test; the service reads current source instead of stored evidence without labelling it; a zero-match search is reported as failure; an existing lookup test changed.

**Copy/paste prompt for Stage 2 (new Moriarty conversation):**

```text
You are implementing Stage 2 of docs/Moriarty_Context_Management_Implementation_Plan.md in /home/stark/source/twinny on branch context-management. Do not commit.

Read §0, §1, §2, §3, §4, §5, the Progress Log, the full Stage 2 section, and only the referenced design/contract sections needed for this stage. Confirm Stage 1 are marked done with recorded verification before editing. Check current branch/status and existing accepted evidence first; do not trust historical line numbers.

Stage 2 scope: Build the authorized read-only evidence access service over Stage 1 storage, including range/line/byte retrieval, long-line fragments, stream selection, literal/search/filter, deterministic cursors, missing/evicted/inaccessible states and no re-execution.

Follow every Stage 2 instruction, acceptance criterion, negative/adversarial test, authorization boundary and no-go condition. Do only Stage 2; do not implement later stages or change stage contracts. Run §0.3 verification gates and this stage's focused tests, report actual exit codes and test totals. A timed-out or incomplete VS Code test run is NOT a pass. Preserve unrelated working-tree changes and development database safety policy.

Update only the Stage 2 Progress Log row with actual measured results and deviations. Finish with the complete §0.5 Stage 2 report, including changed files, commands/results, acceptance status, negative tests, blockers and remaining work. Do not start Stage 3.
```

---

### Stage 3 — `query_evidence` native tool and the sparse result envelope

**Depends on:** Stage 2. **[VS Code suite]** (tool registration runs in the host).

**Goal:** expose the Stage 2 service to the model as one native read-only tool with explicit range mode, and make the model-facing copy of integrity/status/retrieval semantics real: actual observation IDs reach `loop.ts`, `budget.ts`, the GUI step view and conversation export, and repeated identical read-only calls reuse a real stored observation instead of re-running.

**Prerequisites:** Stage 2's service and states; Stage 1's completeness contract.

**Existing components reused:** `ToolSpec`/`ToolResult` (`tools/protocol.ts`, `tools/workspace.ts`), the `workspaceTools` tool list and its `extras` pattern, `argumentReader` + typed arguments (`tools/arguments.ts`), `formatResultIntegrity`/`stripResultIntegrity` (`tools/budget.ts`), the `_answered` repeat suppression in `ToolLoop`, `common/tool-output.ts` parsers (must keep parsing today's headers), the webview tool-step view, `common/conversation-export.ts`.

**Files expected to change**

- new `src/extension/tools/evidence.ts` (`evidenceTools(...)` implementing §4.7 envelope and the `query_evidence` tool)
- `src/extension/tools/workspace.ts` (register the tool through a new `extras.evidence` option; no behaviour change for existing tools)
- `src/extension/chat/index.ts` (wire the repository's access service into `workspaceTools`/`todoWorkspaceTools`)
- `src/extension/tools/loop.ts` (`onToolResult` keeps the observation id alongside the slot; repeated read-only calls reuse the stored content when identity, arguments, source version and authorization context are still valid)
- `src/webview/tool-steps.tsx` / `tool-output.tsx` and `src/common/conversation-export.ts` only where an actual ID is displayed or exported
- tests: new `src/test/standalone/evidence-query-tool.standalone.ts`; additions to `chat-tools.standalone.ts`, `tool-loop.standalone.ts`, `tool-output.standalone.ts`, `conversation-export.standalone.ts`

**Schema changes:** none; use Stage 1's `evidence_access_events`.

**New tool contract** (illustrative call and response shapes)

```json
{"observation_id":"<uuid>","start_line":687,"end_line":710}
```

```json
{"state":"retained","coverage":{"from_line":687,"to_line":710},"provenance":{"tool":"read_file","path":"docs/Moriarty_Unified_Index_Evidence_Implementation_Plan.md"},"retrieve":{"continuation":{"cursor":"byte:46120"}}}
```

Rules for the tool surface: read-only; `readOnly: true` so repeat suppression applies; parameters typed (integer ranges, optional stream/mode); no boolean/number stringifying; a response is sparse — omit default-valued fields, keep states that have no default; the tool is only advertised when registered (never invent a model tool that does not exist).

**Implementation instructions**

1. The tool calls Stage 2's service; it never re-reads source or reruns a command.
2. When integrity, status or retrieval semantics require an envelope, emit it; a complete plain result stays plain text with a lightweight source ID only where needed.
3. Keep `[result_integrity]` working for existing consumers while carrying `observation_id` through the loop, budgeting, GUI step view and export.
4. Repeat suppression: reuse a real observation ID only while identity, arguments, source versions, authorization context and observation semantics are still valid; otherwise run the tool. A refused repeat is reported as *not run*, never as a result.
5. Never send the retained blob and its summary together (design §4.4.4): one compact reference plus the delivered coverage.

**Safety and backwards compatibility:** existing tool output formats stay parseable (`common/tool-output.ts`, the webview step view, conversation export); new fields are additive. No message may reference a tool that is not registered, and repeat suppression may not change the outcome of a side-effecting call or answer from content that was never stored.

**Required tests**

1. *`query_evidence` answers the beginning, line 687 and the last non-empty line of a stored large result without rerunning the tool*
2. *a complete short result stays plain text; an envelope appears only when integrity or retrieval semantics require it*
3. *the model-visible copy carries the real observation id through loop, budget, the step view and the export*
4. *repeated identical read-only calls reuse the stored content while validity holds, and run again once the source version changes*
5. *a partial delivery for a successful tool reports both delivered coverage and retained coverage without claiming the tail is recoverable when it is not*

**Negative and adversarial tests:** asking for a range beyond retained coverage; asking for an evicted observation; a call with a wrong-typed argument (refused, `executed: false`); a lookup of another project's UUID; a command whose output was never captured; a search that returns zero matches (success); a tool call whose result is omitted from context (must not be described as retrievable when storage capped it).

**Verification commands:** §0.3 gates + the focused file, plus `grep -n "query_evidence" src/extension/tools/evidence.ts src/extension/tools/workspace.ts` showing registration and dispatch.

**Acceptance criteria:** every tool call a response recommends is a registered tool; every "recoverable" claim is backed by stored data and authorization; existing header parsers and step-view tests pass unmodified.

**Cannot be declared complete if:** an unregistered tool is referenced in any message; any response claims completeness the storage does not have; an existing GUI/export test needed a weakened assertion.

**Copy/paste prompt for Stage 3 (new Moriarty conversation):**

```text
You are implementing Stage 3 of docs/Moriarty_Context_Management_Implementation_Plan.md in /home/stark/source/twinny on branch context-management. Do not commit.

Read §0, §1, §2, §3, §4, §5, the Progress Log, the full Stage 3 section, and only the referenced design/contract sections needed for this stage. Confirm Stage 2 are marked done with recorded verification before editing. Check current branch/status and existing accepted evidence first; do not trust historical line numbers.

Stage 3 scope: Register the single native query_evidence tool (range/search/filter/continuation), wire actual observation IDs and sparse integrity/retrieval envelopes through the production loop and GUI/export, and ensure repeat reads reuse retained results rather than rerun.

Follow every Stage 3 instruction, acceptance criterion, negative/adversarial test, authorization boundary and no-go condition. Do only Stage 3; do not implement later stages or change stage contracts. Run §0.3 verification gates and this stage's focused tests, report actual exit codes and test totals. A timed-out or incomplete VS Code test run is NOT a pass. Preserve unrelated working-tree changes and development database safety policy.

Update only the Stage 3 Progress Log row with actual measured results and deviations. Finish with the complete §0.5 Stage 3 report, including changed files, commands/results, acceptance status, negative tests, blockers and remaining work. Do not start Stage 4.
```

---

### Stage 4 — Validity classes, dependency edges and invalidation events

**Depends on:** Stage 1. **[VS Code suite]** (the boundary is wired from the host).

**Goal:** extend the existing single validity boundary to the design's full classification, record **established** dependencies between source observations and derived claims, and invalidate through events (native edits, editor saves, external changes, Git operations, renames, deletes) without ever guessing a dependency.

**Prerequisites:** Stage 1 (outcome/blob identity so a derived claim can name the observation it came from); the existing `SourceValidityBoundary`, `SourceRoots`, `observation_source`, `todo_accepted_evidence`.

**Existing components reused (extend, do not replace):** `todos/source-validity.ts` (`SourceValidityBoundary.check/assess/read`, `aggregateValidity`, `CheckedSourceReference`, `decidedBy`), `feedback.ts` (`assessAcceptedFacts`, `factReason`, `FRESHNESS_OF`, `resolveAcceptedFacts`, `evidencePreflight`), `delivery.ts`, `evidence-context.ts`, `tools/todos.ts` (the lookup projection), `repository.recordObservationSources`/`recordedSourceReferences`, the synchronous index refresh path (`chat/tool-sinks.ts` `refreshed(...)`, `WorkspaceSearchProvider.refresh`), the existing watchers in `workspace-index/index.ts` (`dirtyUris`, `pendingDeletes`, `scheduleUris`, `flushPendingUris`).

**Files expected to change**

- `src/extension/todos/source-validity.ts` (the new classes plus the old ones preserved)
- new `src/extension/todos/dependency-index.ts`
- `src/extension/todos/repository.ts` (`recordToolObservation` records established edges; `assess` uses them)
- `src/extension/todos/types.ts` (the new validity types)
- `src/extension/workspace-index/index.ts` (rename/create/delete reporting: `onDidRenameFiles`, and the existing delete path feeding `IndexChange`)
- `src/extension/chat/index.ts` (`evidenceBoundary()` stays the single wiring point)
- `src/extension/tools/todos.ts` (stale notices: original hash + observation UUID only)
- tests: new `src/test/standalone/evidence-validity.standalone.ts`; additions to `todo-feedback.standalone.ts`, `source-analysis.standalone.ts`, `todos-sqlite.standalone.ts`, and one suite test in `workspace-index.test.ts`

**Schema changes:** **none.** Stage 1 creates `evidence_dependencies` and `todo_tool_observations.validity_class` in v21. Stage 4 populates/consumes them. Stored classification is an audit fact, not authority; the boundary rechecks validity.

**New contract**

```ts
export type ValidityClass = "current" | "stale" | "unknown" | "historical" | "superseded"
export interface DependencyEdge {
  derivedObservationId: string
  sourceObservationId: string
  kind: "source_read" | "derived_claim" | "accepted_fact" | "supersedes"
  establishedAt: string
}
/** A stale notice as the projector and tools may render it. Never carries a new hash. */
export interface StaleNotice {
  observationId: string
  originalHash: string
  reason: "source_modified" | "source_deleted" | "dependency_invalidated" | "rename" | "git_operation"
}
```

Preserve the existing per-reference states (`valid`/`stale`/`invalid`/`unverifiable`) and their mapping to `ValidityClass` (`valid → current`, `stale → stale`, `invalid → stale with reason source_deleted`, an event-only record → `historical`, insufficient or inaccessible evidence → `unknown`, a user/task decision → `superseded`). Aggregate order stays `invalid > stale > valid`; `unknown` is reported separately, never folded into a stronger state.

**Implementation instructions**

1. The boundary remains the single decider; consumers still do not opt in by passing a reader.
2. Record an edge only when the relationship was established by an actual operation (a claim reconciled from a read, a fact accepted from an observation, a supersession). Never infer dependencies from arbitrary command text.
3. Invalidating a source invalidates only claims whose **current-state** validity depends on it. A historical failure remains useful evidence; it does not prove today's test status.
4. Command/test output is immutable history: whether it verifies the current build depends on the recorded source set, revision, configuration and runtime dependencies — all `unknown` unless established.
5. Events: native edits (the existing `refreshed` path), editor saves (`onDidSaveTextDocument`), external changes (watchers, reported as `unknown` until reconciled), renames/creates/deletes (`onDidRenameFiles` + the existing delete path), Git operations (recorded as a `git_operation` reason only when the operation touched the recorded source).
6. A later matching hash after a revert does **not** resurrect an old observation as freshly authorized evidence; it stays `stale` until revalidated (`valid again` only through the boundary's own check, which is what today's rule already proves).
7. Stale notices carry `observationId`, the **original obsolete** hash and `reason` — never the new hash (Rule 3). A notice is inserted only when the active plan depends on the invalidated fact; indiscriminate insertion is forbidden.
8. User requests and their original text/intent are immutable and never classified stale; later user changes create explicit `supersession` links (§4.6 protected segments, Stage 6 records them).

**Safety and backwards compatibility:** the existing `SourceValidity` states and every existing validity/freshness test keep their meaning; the new classes are additive. The stored `validity_class` is an audit fact, never the authority, and no consumer may decide validity by itself.

**Required tests**

1. *four reads of one version then a verified edit makes those four current-state reads stale while the historical records survive*
2. *a derived claim is invalidated only when its recorded dependency is invalidated; an unrelated claim keeps its state*
3. *no dependency exists that the code did not establish* (the edge table stays empty for a command run with unknown side effects)
4. *a stale notice names the original hash and UUID and never contains the new hash* — proven by asserting the new hash does not appear anywhere in the notice text.
5. *renamed sources resolve to their recorded link; identical-content files at different paths stay separate*
6. *deleted sources report `invalid`/`stale with reason source_deleted`, and the record is still listed*
7. *external change reports `unknown` until reconciled, then the reconciled state*
8. *Git operation invalidation is recorded only when it touched the recorded source*
9. *buffer-versus-disk distinction is preserved for every class* (existing Stage 12 tests pass unmodified)
10. **[VS Code suite]** in `workspace-index.test.ts`: *a rename reaches the dependency index with its link, and the index reports the new path through `onDidRenameFiles`*.

**Negative and adversarial tests:** a hash collision across two files (never resolves to one); a claim whose dependency was never recorded; a stale buffer observation whose buffer closes; a file restored to matching content (`valid again`, not resurrected as authorized); an event that fires for a file outside the authorized roots; a notice built for a fact the active plan does not depend on (must not be inserted).

**Verification commands:** §0.3 gates + `node --test out/test/standalone/evidence-validity.standalone.ts` + `grep -n "ValidityClass\|StaleNotice" src/extension/todos/source-validity.ts`.

**Acceptance criteria:** the five classes are reachable and distinct; every existing validity test passes unmodified; no code path emits a replacement hash outside an explicit Stage 5 lookup.

**Cannot be declared complete if:** any existing assertion was changed except those this stage names; `unknown` is collapsed into a default; a dependency was inferred rather than recorded.

**Copy/paste prompt for Stage 4 (new Moriarty conversation):**

```text
You are implementing Stage 4 of docs/Moriarty_Context_Management_Implementation_Plan.md in /home/stark/source/twinny on branch context-management. Do not commit.

Read §0, §1, §2, §3, §4, §5, the Progress Log, the full Stage 4 section, and only the referenced design/contract sections needed for this stage. Confirm Stage 1 are marked done with recorded verification before editing. Check current branch/status and existing accepted evidence first; do not trust historical line numbers.

Stage 4 scope: Extend the existing validity boundary and recorded dependency/lineage edges; handle verified save/edit/external/Git/rename/delete events without leaking a replacement fingerprint or inventing dependencies. No new DDL: v21 schema belongs to Stage 1.

Follow every Stage 4 instruction, acceptance criterion, negative/adversarial test, authorization boundary and no-go condition. Do only Stage 4; do not implement later stages or change stage contracts. Run §0.3 verification gates and this stage's focused tests, report actual exit codes and test totals. A timed-out or incomplete VS Code test run is NOT a pass. Preserve unrelated working-tree changes and development database safety policy.

Update only the Stage 4 Progress Log row with actual measured results and deviations. Finish with the complete §0.5 Stage 4 report, including changed files, commands/results, acceptance status, negative tests, blockers and remaining work. Do not start Stage 5.
```

---

### Stage 5 — Explicit stale-to-current resolution (`resolve_current_evidence`)

**Depends on:** Stage 2 (content reference), Stage 4 (validity classes and lineage). **[VS Code suite]** for the buffer/disk and authorization paths.

**Goal:** give the model one read-only operation that takes an old observation UUID, or a sufficiently scoped old fingerprint, and returns the **verified current** source observation and its hash — only on an explicit, authorized request. Automatic invalidation notices keep carrying the old hash only.

**Prerequisites:** `SourceRoots`, `SourceValidityBoundary`, `findRelocationCandidates`, the access preflight (`access-preflight.ts`), `WorkspaceView.resolve`/`text`/`relative`/`isExternal`, `contentHash`/`fingerprintContent`/`verifyContentFingerprint`.

**Files expected to change**

- new `src/extension/todos/current-resolution.ts` (the resolver; `vscode`-free, reads through the repository's boundary)
- `src/extension/tools/evidence.ts` (the registered tool, §4.4 shapes, `readOnly: true`)
- `src/extension/todos/repository.ts` (records `supersedes_observation_id` / `derived_from_observation_id` edges)
- tests: new `src/test/standalone/resolve-current-evidence.standalone.ts`; additions to `source-analysis.standalone.ts`, `todo-feedback.standalone.ts`, and one suite test in `file-access.test.ts` (the file the harness lists for authorization paths)

**Schema changes:** none; use `evidence_dependencies` with kind `supersedes`/`derived_claim` and the existing `observation_source` rows.

**Implementation instructions**

1. Prefer UUID over hash. With a hash alone, require enough scope (path or root) to disambiguate; identical contents or a collision return `ambiguous` with bounded authorized candidates.
2. Follow recorded source identity, path, workspace root and verified rename/move links; never "find any file with this hash".
3. At lookup time verify existence, permission scope, disk-versus-unsaved-buffer selection, current content and fingerprint. Index mappings are candidate hints only.
4. If a verified authorized observation already covers the current content, return its `observation_id`, `content_hash`, `path` and an optional bounded retrieval reference **without repeating a read**. Otherwise perform one explicit authorized read, store it as an observation with provenance linking to the old item, then answer. Report where the information came from.
5. When the request asks for a bounded current range, return it in the same response (avoid round trips); large bodies stay in the store and are served by `query_evidence`.
6. Deleted source → `deleted`/`no_current_version`; no invented replacement, no unrelated file. Rename/move → verified successor location with the link as evidence. Ambiguous histories/duplicate candidates → `ambiguous`. Missing or evicted old observation → `not_found`/`history_unavailable`. Denied access → `permission_denied` without naming restricted candidates. No meaningful current successor (transient command, time-sensitive diagnostic, multi-file search, test run) → `not_applicable` plus an appropriate **suggested new authorized operation**; never silently rerun a side-effecting command.
7. Concurrent modification during the lookup returns `unknown`/race or retries the safe read validation once, and never a misleading current claim.
8. A lookup must not grant anything: it cannot be used to bypass `edit_lines`' `expected_hash` concurrency check or write authorization (Rule 7). An unchanged file may reuse a currently verified observation ID where valid rather than inventing a new version.
9. Responses are sparse but truthful: `current` carries the verified ID and hash; `deleted` carries neither; ambiguity and unknown validity are explicit; `favourite` is omitted unless true.

**Safety and backwards compatibility:** a resolution grants nothing. It cannot satisfy `edit_lines`' `expected_hash` check, cannot widen access, and cannot name a path the caller may not see. Every successful fresh lookup is stored as an observation with provenance; no lookup rewrites a historical row or its timestamps.

**Required tests** (each named as a test title)

1. *four reads of one old version then an edit resolve every old UUID to the same independently verified current source version*
2. *a deleted source returns no replacement*
3. *a renamed source resolves through its recorded link, not by hash guessing*
4. *two identical-content files with the same old hash are ambiguous without path identity*
5. *an evicted or stale-index record returns `history_unavailable`/`unknown`, never a current claim*
6. *cross-project and unauthorized lookups are refused without naming candidates*
7. *unsaved editor changes resolve against the buffer for a buffer observation and against disk once the buffer closes*
8. *concurrent modification during a lookup returns race/stale, not a current hash*
9. *when no current observation exists, the resolver creates one legitimate authorized read and records the provenance link*
10. *the old hash never appears as newly authorized current, and the invalidation projection never contains the new hash while an explicit lookup does*
11. *[VS Code suite]* *a lookup cannot be used to obtain a current hash for an edit that would otherwise fail its `expected_hash` check*
12. *a direct lookup returns the requested small current range in one response, avoiding a second tool call*

**Negative and adversarial tests:** a lookup against an observation whose tool was `run_command` (no file reference → `not_applicable`); a hash that resolves to a protected or team-blocked path; a lookup for a file inside `.git`; a stale index row whose file changed twice during the call; a candidate list longer than the bound; an invocation-id alias pointing at another project.

**Verification commands:** §0.3 gates + `node --test out/test/standalone/resolve-current-evidence.standalone.ts`.

**Acceptance criteria:** all **twelve** required tests pass; the single-round-trip rule is proven by a test that asserts no second read; no path in the code returns a current hash without a verified read or a verified existing observation.

**Cannot be declared complete if:** the resolver can answer from the index alone; it can infer identity from a matching hash; it can bypass an authorization check; it reruns a side-effecting command; any test asserts a hash without verifying it against the source.

**Copy/paste prompt for Stage 5 (new Moriarty conversation):**

```text
You are implementing Stage 5 of docs/Moriarty_Context_Management_Implementation_Plan.md in /home/stark/source/twinny on branch context-management. Do not commit.

Read §0, §1, §2, §3, §4, §5, the Progress Log, the full Stage 5 section, and only the referenced design/contract sections needed for this stage. Confirm Stages 2 and 4 are marked done with recorded verification before editing. Check current branch/status and existing accepted evidence first; do not trust historical line numbers.

Stage 5 scope: Implement explicit resolve_current_evidence with authorization and current-source verification, including disk/buffer distinctions, verified rename handling and race checks. Never return a fresh hash from passive invalidation or bypass edit_lines expected_hash.

Follow every Stage 5 instruction, acceptance criterion, negative/adversarial test, authorization boundary and no-go condition. Do only Stage 5; do not implement later stages or change stage contracts. Run §0.3 verification gates and this stage's focused tests, report actual exit codes and test totals. A timed-out or incomplete VS Code test run is NOT a pass. Preserve unrelated working-tree changes and development database safety policy.

Update only the Stage 5 Progress Log row with actual measured results and deviations. Finish with the complete §0.5 Stage 5 report, including changed files, commands/results, acceptance status, negative tests, blockers and remaining work. Do not start Stage 6.
```

---

### Stage 6 — Model-controlled favourites and protected user intent

**Depends on:** Stage 1, Stage 4.

**Goal:** compact idempotent mark/unmark by observation UUID with persistent storage and authorization semantics; protected user input; no unchanged/default favourite metadata transmitted.

**Prerequisites:** Stage 1's complete v21 favourite/replay/context-segment tables and Stage 4's supersession semantics. Stage 6 owns protection records/metadata **without importing Stage 8's projector**; Stage 8 tests pruning and protection together.

**Existing components reused:** `TodoRepository` write path and request-id idempotency pattern (`validateRequestId`, replay lookups), `assertWriter`, `SourceRoots`, `recordEvidenceUse` style in `tools/todos.ts`, `toolEvidence` recording path.

**Files expected to change**

- new `src/extension/todos/favourites.ts`
- new `src/extension/todos/protected-intent.ts` (the user-request/task-intent protection record; it does not store a copy of the conversation as its only source)
- `src/extension/tools/evidence.ts` (`set_evidence_favourite`, exactly one `observation_id` and required boolean `favourite`, `readOnly: false`)
- `src/extension/todos/types.ts` (§4.5 types, `context_segments` shape for Stage 8)
- tests: new `src/test/standalone/evidence-favourites.standalone.ts`; additions to `todo-feedback.standalone.ts`, `chat-tools.standalone.ts`

**Schema changes:** **none.** Stage 1 already created `evidence_favourites`, `evidence_favourite_requests`, `context_segments` and `context_projections` in v21. Stage 6 begins using them, without DDL.

**Single-item tool call:** `{"observation_id":"<uuid>","favourite":true}` or `{"observation_id":"<uuid>","favourite":false}`. One call changes at most one UUID; arrays, batch inputs and multiple IDs are invalid. `requestId` is tracked for idempotent replay independently of favourite membership. Favouriting several observations intentionally requires several tool calls. Respond with a compact one-item state, not the evidence body.

**Implementation instructions**

1. User input is inherently protected: `kind = 'user_instruction'` always sets `protected = 1`, and no ordinary pruning rule may drop it. A later user change writes a `supersedes` edge (Stage 4's kind), never a stale classification on the original.
2. All ordinary tool observations start unfavourited; `favourite` is stored, not inferred, and is omitted from model output when false.
3. The model may mark/unmark **one** UUID per call, and the operation authorizes only the correct project/conversation metadata and returns §4.5's one-item outcome. Refuse arrays/multiple IDs. Each additional favourite requires a separate model decision and tool call. It never modifies the immutable observation body.
4. Favourites affect retention priority only: they do not make a stale source current, elevate permission, immunise bytes from storage policy or defeat the hard capacity limit (Rule 5).
5. Idempotency: a replayed request ID with identical UUID/operation returns its original outcome even after unmark; conflicting reuse refuses. `already` is for state already matching desired value; `unknown` and `denied` are distinct internally without leaking inaccessible identity. Record replay in `evidence_favourite_requests`, independently of current membership.

**Safety and backwards compatibility:** favourites change priority only — never validity, permission, storage policy or the hard capacity limit. Protection of user input is inherent and cannot be toggled off by the model or by a settings value.

**Required tests**

1. *mark and unmark change only metadata and leave the observation body byte-for-byte unchanged*
2. *one-ID calls report changed, already, unknown or denied as appropriate; arrays/multiple IDs are rejected without changing anything*
3. *request-ID replay is idempotent after mark and after unmark; conflicting reuse refuses; two favourites require two calls*
4. *nonexistent IDs and other-project IDs are refused without revealing which project they belong to*
5. *no read or tool output transmits `favourite:false`, an empty array or a null placeholder* — asserted by exact output comparison.
6. *unknown state stays distinguishable from an established default* (a fact whose freshness is unknown is not reported as current)
7. *user input's protected metadata is persisted and cannot be unset by a model operation, without using Stage 8 code*. A separate Stage 8 projector test checks protected input under tight budgets.
8. *a superseded requirement keeps its original user request intact and unprunable*

**Negative and adversarial tests:** marking an observation belonging to another conversation in the same project (allowed only where authorization permits, per §8); marking a failed/refused invocation; marking while storage policy excludes bytes; unmarking a protected user segment (must be refused — protection is inherent, not a flag the model sets).

**Verification commands:** §0.3 gates + `node --test out/test/standalone/evidence-favourites.standalone.ts`.

**Acceptance criteria:** Rule 5 holds for single-item preference operations and protection metadata; ordinary outputs omit `favourite:false` (explicit unmark **inputs** may include false); protection cannot be turned off by the model. Projector integration belongs to Stage 8.

**Cannot be declared complete if:** a single call can change multiple observations; replay after unmark is not deterministic; a favourite can influence validity, permission or the hard cap; the model can unprotect user input; ordinary outputs carry `favourite:false`.

**Copy/paste prompt for Stage 6 (new Moriarty conversation):**

```text
You are implementing Stage 6 of docs/Moriarty_Context_Management_Implementation_Plan.md in /home/stark/source/twinny on branch context-management. Do not commit.

Read §0, §1, §2, §3, §4, §5, the Progress Log, the full Stage 6 section, and only the referenced design/contract sections needed for this stage. Confirm Stages 1 and 4 are marked done with recorded verification before editing. Check current branch/status and existing accepted evidence first; do not trust historical line numbers.

Stage 6 scope: Implement exactly one observation UUID per set_evidence_favourite call, authorized idempotent mark/unmark with persistent request replay, and protected immutable user intent. Reject arrays/batches. Do not import or implement the Stage 8 projector.

Follow every Stage 6 instruction, acceptance criterion, negative/adversarial test, authorization boundary and no-go condition. Do only Stage 6; do not implement later stages or change stage contracts. Run §0.3 verification gates and this stage's focused tests, report actual exit codes and test totals. A timed-out or incomplete VS Code test run is NOT a pass. Preserve unrelated working-tree changes and development database safety policy.

Update only the Stage 6 Progress Log row with actual measured results and deviations. Finish with the complete §0.5 Stage 6 report, including changed files, commands/results, acceptance status, negative tests, blockers and remaining work. Do not start Stage 7.
```

---

### Stage 7 — Context sizing, token accounting and provider diagnostics

**Depends on:** Stage 0 (its measured baselines), Stage 2 (the projector must measure retained evidence honestly).

**Goal:** correct the existing capacity and budget path so a long-running local-model workflow with a 128K/256K (or larger) window is planned correctly, warnings are not misleading, output reservation does not make the model believe its context is exhausted, tool-result delivery budgets scale sanely, and repeated-result suppression cannot cause duplicate execution.

**Prerequisites:** `planContext`, `TokenEstimator`, `ContextCapacity`, `ContextDiagnostics`, `resolveCapacity`, `serverProbeOf`, `parseContextSetting`, `resolveFallback`, `SUPPORTED_CONTEXT_TOKENS`, `SMALL_CONTEXT_TOKENS`, `ContextUsageStore`.

**Files expected to change**

- `src/extension/tools/budget.ts` (additive capacity accounting; no rename of existing fields)
- `src/extension/inference/context-window.ts` (separate *effective prompt capacity* from *advertised* and from physical memory; the manual override path and its warning)
- `src/extension/chat/index.ts` (`contextWindowOf`, `observeContext`, `logContext`, the loop's `maxResultChars` clamp)
- `src/extension/tools/loop.ts` only where it consumes the plan (`fit()`), plus the repeated-result rule (§4.3 in Stage 2, honoured here)
- tests: new `src/test/standalone/context-budget.standalone.ts`; additions to `context-usage.standalone.ts`, `context-breakdown.standalone.ts`, `tool-loop.standalone.ts`

**Schema changes:** none (Stage 1's `context_projections` table is written by Stage 8).

**Concrete issues this stage must resolve, each with a test that fails without the fix**

1. **Output reservation vs prompt budget.** With `chatInferenceMaxOutputTokens` set far above a small window, `planContext` caps the reserve at 25% and can leave `limit` tiny; the model then behaves as if its context is exhausted at a small token count (design §8). Fix: report `reserved`, `margin` and `limit` as separate facts and never describe a *reservation* as *used context*; when the reservation cannot fit, say which part is the reservation, and refuse to plan rather than reporting a negative budget (`plan.limit < 512` already exists — extend it so the reason names the setting and the effective value).
2. **Confirmed versus assumed capacity.** `resolveCapacity` uses the smallest confirmed size and marks an unconfirmed fallback. Keep that; add explicit display of "confirmed" vs "assumed", keep warning only when below 65,536, and stop calling a fallback a confirmed capacity.
3. **Advertised maxima are not capacities.** A model advertised at 1M with a server loaded at 32K must plan on 32K, and the display must show both — with wording that does not equate prompt utilization with physical KV residency or per-slot occupancy (llama.cpp `total_slots` stays informational).
4. **Estimation uncertainty buffer.** `margin = 10%` stays; add a configurable safety margin only where a stage names it, and prove the projector's threshold uses `limit` (which already subtracts reserve + margin), not raw capacity.
5. **Tool-result delivery budgets.** `resultChars` scales with the window; confirm the ceiling behaviour at 256K windows and that `MIN_RESULT_CHARS`/`MIN_FRESH_CHARS` do not cause a large result to be omitted when the window plainly allows it.
6. **Repeated-result suppression correctness.** A read whose content is still visible is answered from the stored observation (no rerun); a compacted result must remain *answerable* without executing the tool again; a side-effecting tool must never be replayed by a projection decision. Idempotency requires a stable invocation identity (Stage 1).
7. **Exhaustion diagnosis.** `exhausted` must mean "still over budget after trimming", not "the estimate exceeded the window before trimming".

**Safety and backwards compatibility:** existing `ContextDiagnostics` fields keep their meaning; the accounting added here is additive so the composer bar and the logs read the same numbers. The "smallest confirmed size wins" rule is not relaxed, and a manual override may not be used to plan above what a server holds.

**Required tests**

1. *a 128K window with a 6144 output reservation plans a prompt budget that does not look exhausted at 30K*
2. *an output maximum larger than the window cannot fit is reported as a reservation problem, not as context usage*
3. *confirmed, assumed and advertised capacities are reported distinctly and the warning appears only below the agent minimum*
4. *the projector threshold is computed against effective capacity (window − reserve − margin), not raw capacity*
5. *a repeated read-only call with unchanged source version does not execute the tool*
6. *a side-effecting call is never replayed by a projection or compaction decision*
7. *tool definitions and the closing prompt are counted in the utilization the threshold compares against*

**Negative and adversarial tests:** a server that reports an implausible window (`MAX_PLAUSIBLE_TOKENS`); an invalid `chatContextWindow` value (still treated as Auto and reported); a cached unconfirmed probe expiring before a confirmed one; a tool-result ceiling at its maximum with a huge output; a provider that counts tokens very differently from the estimator (`TokenEstimator.observe` clamp 2–6).

**Verification commands:** §0.3 gates + `node --test out/test/standalone/context-budget.standalone.ts`; report actual counts for each named test.

**Acceptance criteria:** every listed issue has a failing-without-the-fix test; existing context-usage tests pass unmodified; no warning text calls an estimate a physical measurement.

**Cannot be declared complete if:** a count is claimed without running it; a warning path was changed without a test; the threshold math reads raw capacity.

**Copy/paste prompt for Stage 7 (new Moriarty conversation):**

```text
You are implementing Stage 7 of docs/Moriarty_Context_Management_Implementation_Plan.md in /home/stark/source/twinny on branch context-management. Do not commit.

Read §0, §1, §2, §3, §4, §5, the Progress Log, the full Stage 7 section, and only the referenced design/contract sections needed for this stage. Confirm Stages 0 and 2 are marked done with recorded verification before editing. Check current branch/status and existing accepted evidence first; do not trust historical line numbers.

Stage 7 scope: Correct provider capacity discovery, token estimates, reserves and utilization diagnostics for 64K/128K/256K+ windows. Ensure repeat suppression does not re-execute prior reads or commands. Preserve real provider hard limits.

Follow every Stage 7 instruction, acceptance criterion, negative/adversarial test, authorization boundary and no-go condition. Do only Stage 7; do not implement later stages or change stage contracts. Run §0.3 verification gates and this stage's focused tests, report actual exit codes and test totals. A timed-out or incomplete VS Code test run is NOT a pass. Preserve unrelated working-tree changes and development database safety policy.

Update only the Stage 7 Progress Log row with actual measured results and deviations. Finish with the complete §0.5 Stage 7 report, including changed files, commands/results, acceptance status, negative tests, blockers and remaining work. Do not start Stage 8.
```

---

### Stage 8 — Deterministic two-tier context projector (pure core)

**Depends on:** Stages 2, 4, 6, 7.

**Goal:** implement §4.6 as a pure, deterministic, testable module that decides what the next request sends — never touching stored evidence — and produces meaningful diagnostics.

**Prerequisites:** validity classes (Stage 4), favourites and protected segments (Stage 6), honest capacity/token accounting (Stage 7), bounded historical references (Stage 2/3).

**Existing components reused:** `TokenEstimator`, `planContext` (reserve, margin, limit, target, resultChars, notesChars), `withToolPrompt`/`withClosingPrompt`/`withRequestContext` and `charsOf` in `tools/loop.ts`, `formatResultIntegrity`, the `ResultSlot` structure and `_turn` transcript, provider-specific ordering rules in `chat/turn.ts` (`buildChatTurn`).

**Files expected to change**

- new `src/extension/context/projector.ts` (pure; no `vscode` import)
- new `src/extension/context/settings.ts` (a pure settings reader taking a `get` function, matching `readFileSettings`' style in `tools/workspace.ts`)
- `src/extension/tools/loop.ts` gains an injectable projector hook (`project?(segments, settings): ProjectionResult`) used by `fit()`; `fit()` keeps its existing behaviour when no projector is supplied (byte-for-byte unchanged for current tests)
- tests: new `src/test/standalone/context-projector.standalone.ts`; additions to `tool-loop.standalone.ts`

**Schema changes:** writes to `context_projections` and `context_projection_segments` (Stage 1's DDL) through the repository; no schema work here.

**Algorithm (the default two-tier procedure, before each provider request)**

```text
0. Build protected segments: operative user instructions, system/tool policy, current task state.
   User requests are never classified stale and are never pruned as ordinary evidence.
1. Estimate utilization against effective capacity (capacity − output reserve − safety margin),
   including tool definitions and the closing prompt. Below threshold → keep stale and valid bodies
   in chronological order; the renderer must know validity, so a stale body is never presented as current.
2. At or above threshold: remove or compact the OLDEST NON-FAVOURITE STALE projections first. Recompute.
3. Still above: remove or compact the OLDEST NON-FAVOURITE VALID projections.
   Task relevance and recorded dependencies are tie-breakers; age alone never overrides critical operative state.
4. Compact FAVOURITE evidence to retrievable references only when required to meet the hard capacity limit.
5. Stop at the internal target (threshold − hysteresis, default 5 points). Never produce a negative budget or
   starvation. If non-prunable context alone exceeds physical capacity, fail transparently: report it and do not
   silently alter user instructions.
```

Removal means "replace the body with a bounded reference": `observation_id`, original obsolete hash, `reason`, and only supported retrieval calls (`query_evidence` with a concrete range). Stale notices may carry only the old hash (Rule 3).

**Pairing and duplicate-execution rules**

- Every tool call keeps its call ID; every result stays paired with its call. A compacted body is replaced inside the same message, never dropped.
- A minimal continuation marker is preserved where a provider requires one; provider-specific message ordering (`buildChatTurn`) is respected.
- No projection decision may cause a side-effecting tool to run again (Rule 2, and Stage 7's repeated-result tests).

**Safety and backwards compatibility:** the projector is pure — it never writes evidence, rewrites the transcript or changes stored records. `fit()` must behave byte-for-byte as today when no projector is injected, so existing loop tests stay meaningful.

**Required tests** (pure module, deterministic inputs)

1. *the same segments and settings produce the same projection* (run twice, compare)
2. *crossing the configured threshold prunes oldest non-favourite stale bodies before valid ones*
3. *favourite evidence is compacted only when capacity requires it*
4. *protected user instructions and mandatory system/tool state survive every tier, including tight budgets with a stale favourite* (integration contract for the Stage 6 protection metadata; never backport this test to Stage 6)
5. *the projector stops at the hysteresis target and does not prune on the next step*
6. *diagnostics report oldest stale removed, valid removed, favourites compacted, token estimates, threshold reason and retrieval references*
7. *tool call/result pairing stays intact after compaction, including a multi-call reply*
8. *a projection never changes the evidence database* (assert on a real repository: row counts unchanged)
9. *non-prunable context exceeding capacity fails transparently rather than dropping user text*
10. *no negative budget or starvation is possible: a zero-margin case and a tiny window each report a reason*

**Negative and adversarial tests:** a favourite that is stale (compacted to a reference, not made current); a dependency that exists only as history; a segment whose observation was evicted (reference must not advertise retrieval); a threshold at its minimum (40%) with a large tool-definition cost; a request where the estimate lands exactly on the threshold boundary (boundary inclusive, as designed); a projection where only protected content remains.

**Verification commands:** §0.3 gates + `node --test out/test/standalone/context-projector.standalone.ts`.

**Acceptance criteria:** all ten required tests plus the adversarial cases pass; `loop.ts` behaviour is byte-for-byte unchanged when no projector is injected (proven by existing tests passing unmodified).

**Cannot be declared complete if:** determinism is not proven by a repeat run; any test asserts pruning happened without checking the database stayed intact; pairing is asserted rather than tested.

**Copy/paste prompt for Stage 8 (new Moriarty conversation):**

```text
You are implementing Stage 8 of docs/Moriarty_Context_Management_Implementation_Plan.md in /home/stark/source/twinny on branch context-management. Do not commit.

Read §0, §1, §2, §3, §4, §5, the Progress Log, the full Stage 8 section, and only the referenced design/contract sections needed for this stage. Confirm Stages 2, 4, 6 and 7 are marked done with recorded verification before editing. Check current branch/status and existing accepted evidence first; do not trust historical line numbers.

Stage 8 scope: Implement the pure deterministic validity/favourite-aware two-tier context projector with protected user intent, threshold/hysteresis, budget diagnostics, references and valid tool-call/result pairing. No GUI or host wiring in this stage.

Follow every Stage 8 instruction, acceptance criterion, negative/adversarial test, authorization boundary and no-go condition. Do only Stage 8; do not implement later stages or change stage contracts. Run §0.3 verification gates and this stage's focused tests, report actual exit codes and test totals. A timed-out or incomplete VS Code test run is NOT a pass. Preserve unrelated working-tree changes and development database safety policy.

Update only the Stage 8 Progress Log row with actual measured results and deviations. Finish with the complete §0.5 Stage 8 report, including changed files, commands/results, acceptance status, negative tests, blockers and remaining work. Do not start Stage 9.
```

---

### Stage 9 — Projector wiring, inline chat settings and utilization display

**Depends on:** Stage 8. **[VS Code suite]** plus webview tests.

**Goal:** make the projector the thing that shapes each request in the chat, add the inline settings (automatic pruning toggle + percentage slider), and show effective capacity, estimated usage and the projected threshold — with wording that does not confuse prompt utilization with physical GPU KV-cache occupancy.

**Prerequisites:** §4.6, Stage 7's accounting, the existing agent-settings panel pattern (`useSetting`, `NumberSetting`, `Choices`), `EVENT_NAME.twinnyGetConfigValue` / `twinnySetConfigValue` / `twinnyConfigValueChanged` and `readSettingWithLegacy` in `webview/base.ts`.

**Files expected to change**

- `package.json`: three settings —
  `twinny.chatContextAutoPruning` (boolean, default `true`, machine scope), `twinny.chatContextMaxUtilization` (number, default `80`, min `40`, max `95`, step `5`, machine scope), `twinny.chatContextPruneStrategy` (`"two-tier"` default, with `"stale-first"` as the only alternative), each with a `markdownDescription` that states what the percentage measures.
- `src/extension/context/settings.ts` (reads them through an injected `get`, so it is testable without VS Code)
- `src/extension/chat/index.ts` (pass settings + projector into `withTools(...)` in both `todoToolsClient` and `toolsClient`; keep `onContext` logging, extend `ContextDiagnostics` with the projection counters through additive fields; expose the display through the existing `twinnyGetContextUsage` handler)
- `src/extension/tools/loop.ts` (`fit()` uses the injected projector when present; keeps the existing fallback path byte-for-byte when not)
- `src/webview/agent-settings.tsx` (a checkbox row for automatic pruning and a percentage slider row; add `RangeSetting` alongside `NumberSetting` — no existing control changes), plus new locale keys in `src/webview/assets/locales/en.json` (`agent-settings-pruning`, `agent-settings-pruning-title`, `agent-settings-max-utilization`, `agent-settings-max-utilization-title`, `agent-settings-strategy`, `agent-settings-strategy-two-tier`, `agent-settings-strategy-stale-first`) and the display row (configured capacity, estimated usage, projected threshold)
- tests: additions to `context-projector.standalone.ts` (settings mapping), `feedback-settings.standalone.ts` (settings read pattern), `agent-tool-selection.standalone.ts` or `chat-tools.standalone.ts` for wiring, and one suite test in `agent-reply.test.ts`; a webview test for the slider only if an existing harness covers component behaviour (`src/test/suite/…` files listed by `.vscode-test.js`).

**Implementation instructions**

1. Respect hard server limits even when automatic pruning is disabled (design §8).
2. Continue using Auto provider discovery and the manual override; expose confirmed vs assumed capacity and warn when context is under 65,536.
3. Default to two-tier; do not add a UI switch unless the plan's two strategies are both reachable through the setting (the `Choices` control already exists — use it rather than inventing a new control).
4. The slider changes **when the next request is pruned**, measured against effective capacity including response reserve, tool definitions, system instructions and safety margin. Its description must say so.
5. Display "automatic pruning activity" as counters from Stage 8's diagnostics (stale removed / valid removed / favourites compacted / threshold reason), not as a log of content.
6. Keep the physical-memory distinction explicit in every user-facing string: prompt utilization is an estimate; do not call it VRAM or per-slot KV occupancy.

**Safety and backwards compatibility:** existing settings and controls keep their behaviour; only new settings and rows are added. Hard provider limits stay authoritative when automatic pruning is off, and a settings change applies to the next request, never retroactively to recorded history.

**Required tests**

1. *the inline setting changes the threshold the projector uses and the change reaches the next request*
2. *automatic pruning off still respects the hard capacity limit and reports why a request could not fit*
3. *the display shows configured capacity, estimated usage and projected threshold, and never labels the estimate as physical memory* — asserted by string inspection in the settings/locale text.
4. *the hysteresis target prevents pruning on the step after a threshold crossing*
5. *projection diagnostics reach the log and the display counters with actual numbers*

**Negative and adversarial tests:** a threshold set at the minimum with tool definitions alone exceeding it; a provider reporting a window smaller than the settings range; a settings change mid-reply (applies to the next request, not retroactively); a disabled-pruning request that cannot fit; a strategy switch to `stale-first` (must still protect user input).

**Verification commands:** §0.3 gates including the VS Code suite (or exact `NOT RUN`), plus `grep -n "chatContextMaxUtilization\|chatContextAutoPruning" package.json src/extension/context/settings.ts src/webview/agent-settings.tsx`.

**Acceptance criteria:** the settings exist with the stated default/range/step; the projector is actually used in both chat paths; no existing loop test changed; display wording distinguishes estimate from physical memory.

**Cannot be declared complete if:** a control was added without wiring it to the projector; the hard limit can be bypassed when pruning is off; the suite pass was claimed without observing a Mocha summary.

**Copy/paste prompt for Stage 9 (new Moriarty conversation):**

```text
You are implementing Stage 9 of docs/Moriarty_Context_Management_Implementation_Plan.md in /home/stark/source/twinny on branch context-management. Do not commit.

Read §0, §1, §2, §3, §4, §5, the Progress Log, the full Stage 9 section, and only the referenced design/contract sections needed for this stage. Confirm Stage 8 are marked done with recorded verification before editing. Check current branch/status and existing accepted evidence first; do not trust historical line numbers.

Stage 9 scope: Wire the existing projector into real chat/request construction and inline settings: pruning toggle, percentage slider, estimated capacity/utilization/threshold display and next-request application. Preserve old behavior if disabled and hard provider limits.

Follow every Stage 9 instruction, acceptance criterion, negative/adversarial test, authorization boundary and no-go condition. Do only Stage 9; do not implement later stages or change stage contracts. Run §0.3 verification gates and this stage's focused tests, report actual exit codes and test totals. A timed-out or incomplete VS Code test run is NOT a pass. Preserve unrelated working-tree changes and development database safety policy.

Update only the Stage 9 Progress Log row with actual measured results and deviations. Finish with the complete §0.5 Stage 9 report, including changed files, commands/results, acceptance status, negative tests, blockers and remaining work. Do not start Stage 10.
```

---

### Stage 10 — `run_command` evidence adapter (shared contract only)

**Transport decision, frozen by Stage 0:** one process launch per command; capture and terminal presentation consume that same execution. A pipe-capable host-owned child provides independent stdout/stderr. A deliberate PTY mode provides one honestly labelled `terminal` stream, never invented separated streams. If existing VS Code terminal APIs cannot supply independent ordinary-command output, the minimal managed-command transport becomes a **Stage 10 prerequisite**. Documenting the gap alone is not completion. **Never run the command twice** to retrieve missing stderr or simulate a terminal.

**Depends on:** Stages 1, 2, 3. **[VS Code suite]** for the command path.

**Goal:** connect today's real one-shot `run_command` to the generic stream/outcome storage prepared in Stage 1 and evidence retrieval from Stage 2, so the future managed-command implementation needs **no second database redesign**. Stage 1 only proved synthetic stream storage; this stage proves real stdout/stderr capture from the existing production sink. Do not implement sessions, batches, polling, cancellation, streaming, preflight parsers or native-preference soft refusal here.

**Prerequisites:** Stage 1's outcomes/blobs/chunks tested synthetically; Stage 2's stream selection and byte ranges; the existing `CommandSink`/`CommandOutcome` shapes (`tools/workspace.ts`) and the background runner in `chat/tool-sinks.ts`.

**Files expected to change**

- new `src/extension/tools/command-evidence.ts` (the adapter: typed args → invocation identity → `CapturedResult` → bounded model response)
- `src/extension/chat/tool-sinks.ts` (**must** capture actual stdout and stderr separately in the existing production one-shot command path; if that requires changing the sink, change only capture plumbing and preserve command behavior, timeout, approval and process-tree rules)
- `src/extension/tools/workspace.ts` (`run_command`'s `execution` field gains stream references; the model-visible text stays as it is today except for the honest status fields this stage adds)
- tests: new `src/test/standalone/command-evidence.standalone.ts`; additions to `command-snapshot.standalone.ts`, `chat-tools.standalone.ts`, `tool-loop.standalone.ts`, `operation-lifecycle.standalone.ts`

**Schema changes:** none. Use Stage 1's tables; this stage is the first **production command-sink** consumer of `stdout_blob_id`, `stderr_blob_id`, `evidence_chunks` and `ExecutionState`. Stage 1/2 must already have tested these storage/retrieval shapes with synthetic streams.

**What this stage must establish (interfaces, tested against the existing path)**

1. Invocation and execution UUIDs, independent from "the only command currently running"; batch/child references optional and unused for now.
2. Independent stdout and stderr streams with ordered chunk sequence and per-stream completeness; `no stderr` and `stderr not captured` are different states.
3. Exit code, signal, timeout/cancellation and lost reasons recorded out of band, never inferred from output text; a POSIX signal death is not converted into a successful integer exit.
4. Lifecycle enumeration exactly as §4.8, with `running` distinct from terminal states; a head-only capture (today's rolling tail) must be reported as `capture_limit`, not as complete.
5. Bounded retrieval by execution id through Stage 2 — poll/read semantics preserved for the future: retrieving must not rerun.
6. Refused operations recorded with `executed: false` and no fabricated exit code.
7. Authorization and project/host scoping unchanged; a permitted session is not blanket approval (the interface carries the scope, the implementation stays in the managed-command stages).

**Deliberately left to the managed-command stages:** session registry, cwd/env semantics, persistent-shell vs per-command mode, ordered batches, background launch/poll/wait/cancel, process-tree cleanup policy, restart reconciliation, notification hooks, native-preference soft refusal (configurable `off`/`suggest`/`soft-refuse`), parser-based shell classification (never naive regex as the authorization gate).

**Safety and backwards compatibility:** command execution semantics stay as they are (same approval mode, timeout, cwd, process-tree rules, background-versus-terminal choice). Only evidence shapes are added; no session, batch, polling or soft-refusal behaviour is introduced here.

**Required tests**

1. *exit 0 with nonempty stderr and exit 7 with no stderr are both recorded truthfully*
2. *stdout-only, stderr-only and no-output runs keep their separate stream states*
3. *the same run records each stream in its own byte order when chunks interleave*
4. *binary and invalid UTF-8 bytes in stderr round-trip or are recorded as excluded*
5. *a head truncated by the capture limit is reported as `capture_limit`, and retrieval returns what exists, not a claim*
6. *retrieving command output does not rerun the command* (assert the sink is called once)
7. *a refused or skipped command records an attempt with `executed: false` and no exit code*
8. *a timeout is never recorded as exit 0*
9. *an execution id resolves to its own streams and exit status independently of any other run*

**Negative and adversarial tests:** hostile output containing a spoofed completion marker or an instruction ("run this next") — host status and approval policy must not be corrupted; a run whose child holds the pipes open after the shell exits (`EXIT_GRACE_MS` path); a run whose exit code arrives after the last chunk; two runs sharing one content blob.

**Verification commands:** §0.3 gates + `node --test out/test/standalone/command-evidence.standalone.ts`; `grep -n "ExecutionState\|CommandEvidence" src/extension/tools/command-evidence.ts`.

**Acceptance criteria:** one launch per command is proven; the **default ordinary execution path** captures distinct stdout/stderr from process creation, not after merging or truncation. In synthetic shared-session tests, three separate commands using one `sessionId` produce three independent observation/execution IDs and independently retrievable outcomes; real persistent-session attribution must satisfy the same contract when that mode is implemented. A deliberately selected PTY mode may produce only a labelled `terminal` transcript, with no claim of separated streams. **If current VS Code terminal APIs cannot meet the ordinary pipe-capture requirement, Stage 10 is BLOCKED until the single-launch host-owned pipe transport from the managed-command rework is available; documenting a capability gap does not satisfy this acceptance gate.** Exit/control events are distinct from output, and approval/timeout/cwd/termination safeguards remain intact. The managed-command implementation can consume the schema without redesign.

**Cannot be declared complete if:** separate stdout/stderr for ordinary commands are absent or were inferred by splitting merged text; one command executed twice; several commands in a persistent terminal are stored as one observation; attribution is guessed from prompt/marker text; or approval/timeout semantics change. Full sessions/batches/polling remain in managed-command work, but the **minimum host-managed capture/attribution transport may be brought forward** if needed to pass this gate. An ordinary-mode capture limitation is a prerequisite for the separate managed-command transport implementation, not a waiver.

**Copy/paste prompt for Stage 10 (new Moriarty conversation):**

```text
You are implementing Stage 10 of docs/Moriarty_Context_Management_Implementation_Plan.md in /home/stark/source/twinny on branch context-management. Do not commit.

Read §0, §1, §2, §3, §4, §5, the Progress Log, the full Stage 10 section, and only the referenced design/contract sections needed for this stage. Confirm Stages 1, 2 and 3 are marked done with recorded verification before editing. Check current branch/status and existing accepted evidence first; do not trust historical line numbers.

Stage 10 scope: Implement the run_command evidence adapter against the Stage 1/2 contracts. Capture one process launch once, with actual independent stdout and stderr from creation in ordinary pipe mode, honest merged PTY metadata, per-command observation/execution identity, exit/timeout/control state and no reruns. If the existing transport prevents mandatory capture, report the blocker and implement only the minimum supervised managed-command transport prerequisite, respecting approvals and timeouts.

Follow every Stage 10 instruction, acceptance criterion, negative/adversarial test, authorization boundary and no-go condition. Do only Stage 10; do not implement later stages or change stage contracts. Run §0.3 verification gates and this stage's focused tests, report actual exit codes and test totals. A timed-out or incomplete VS Code test run is NOT a pass. Preserve unrelated working-tree changes and development database safety policy.

Update only the Stage 10 Progress Log row with actual measured results and deviations. Finish with the complete §0.5 Stage 10 report, including changed files, commands/results, acceptance status, negative tests, blockers and remaining work. Do not start Stage 11.
```

---

### Stage 11 — Response-guidance catalogue and model-facing payload audit

**Depends on:** Stages 3, 4, 8, 9, **10**. Stage 10 must have proven command capture before this guidance audit recommends retained command output.

**Goal:** one auditable catalogue of every response/error string the tools can give the model, replacing needless rerun/reread advice with evidence retrieval **only when the retained result actually exists and access is allowed**, while keeping accurate success/failure reporting; and measure the token cost of model-facing payloads so sparse metadata is proven, not assumed.

**Prerequisites:** Stage 2's states (so a message can know what is truly retrievable), Stage 4's notices, Stage 8's references, Stage 3's registered tools.

**Files expected to change**

- new `src/extension/tools/response-guidance.ts`: one function per condition, each returning the message with the *actual* next action; every referenced tool must be a registered one.
- `src/extension/tools/budget.ts` (`fitResult`, `trimmedResult`), `src/extension/tools/loop.ts` (repeat/omitted notices), `src/extension/tools/workspace.ts` (`overLimitMessage`, `suggestedReads`, search notes), `src/extension/tools/line-edit.ts` and `src/extension/edit/service.ts` (hash-change reread advice), `src/extension/todos/evidence.ts` (`describeGap`), `src/extension/todos/plan-context.ts` (`acceptedFactEntry`) and `src/extension/tools/todos.ts` (the `refresh` hint).
- tests: new `src/test/standalone/response-guidance.standalone.ts`; additions to `tool-safety.standalone.ts`, `chat-tools.standalone.ts`, `read-file-arguments.standalone.ts`, `source-analysis.standalone.ts`, `tool-loop.standalone.ts`.

**Per-entry audit fields (the catalogue table each message must carry)**

| Field | Meaning |
|---|---|
| trigger | the exact condition that produced the message |
| execution status | executed / refused / not run / stopped / timed out |
| what was truly retained | nothing / prefix / full / evicted |
| observation id | present only when a real record exists |
| recoverable coverage | exact ranges, or an explicit statement that none is recoverable |
| freshness | current / stale / unknown / historical |
| available native retrieval | the registered tool and usable arguments, or "none" |
| honest next action | retrieve, reread (only when actually necessary), or a new authorized operation |

Rules: keep a fresh-read requirement for a stale source before mutation; never use an old hash as edit authorization; a repeated command/test execution is not automatically replaceable by historical output when live reevaluation is needed; zero matches from native search are successful.

**Payload audit (measured, with the measurement in the report)**

- redundant default fields (`favourite:false`, empty arrays, null placeholders, duplicated status), repeated hashes/paths, summary-plus-blob duplication;
- token cost before and after, per message class, using `TokenEstimator` and the existing request breakdown (`context-breakdown.ts`);
- savings reported as measured numbers (characters and tokens on a fixed fixture), not as an estimate.

**Safety and backwards compatibility:** wording changes only. No tool's behaviour, permission model or error semantics change, and a success/failure status may not be softened to make a message read better.

**Required tests**

1. *a message that recommends retrieval only appears when the retained data exists and access is allowed*
2. *a capped storage result never recommends retrieval it cannot perform; it says `not_retrievable` (§4.3)*
3. *success and failure reporting stays accurate under sparse encoding* (a failed call still reports failure)
4. *no message names a tool that is not registered* — asserted against the tool list built by `workspaceTools`
5. *zero-match search returns a successful result with `match_count: 0`*
6. *the fixed fixture produces the measured token saving, and the number is recorded in the report*
7. *a reread recommendation survives where it is genuinely required (stale source before an edit)*

**Negative and adversarial tests:** a message built for an evicted observation; one built for another project's UUID; one built for a refused command (`executed:false`); a regex pattern that matches nothing but is valid; a message that would otherwise recommend rerunning a side-effecting tool.

**Verification commands:** §0.3 gates + `node --test out/test/standalone/response-guidance.standalone.ts`; run the 20-row investigation catalogue as a regression checklist and record which rows changed and where each message now lives.

**Acceptance criteria:** every catalogued message has a trigger, an execution truth, a coverage statement and an honest next action; measured savings recorded; no existing refusal test weakened.

**Cannot be declared complete if:** the audit's numbers are estimated rather than measured; any message can claim retrievability that the service does not have; the update changes behaviour of a tool rather than its wording.

**Copy/paste prompt for Stage 11 (new Moriarty conversation):**

```text
You are implementing Stage 11 of docs/Moriarty_Context_Management_Implementation_Plan.md in /home/stark/source/twinny on branch context-management. Do not commit.

Read §0, §1, §2, §3, §4, §5, the Progress Log, the full Stage 11 section, and only the referenced design/contract sections needed for this stage. Confirm Stages 3, 4, 8, 9 and 10 are marked done with recorded verification before editing. Check current branch/status and existing accepted evidence first; do not trust historical line numbers.

Stage 11 scope: Audit and correct model-facing tool responses and guidance so commands/reads are only suggested again when evidence truly cannot be retrieved; centralize truthful status/coverage/recovery messages and measure sparse payload savings. Stage 10 must already be done.

Follow every Stage 11 instruction, acceptance criterion, negative/adversarial test, authorization boundary and no-go condition. Do only Stage 11; do not implement later stages or change stage contracts. Run §0.3 verification gates and this stage's focused tests, report actual exit codes and test totals. A timed-out or incomplete VS Code test run is NOT a pass. Preserve unrelated working-tree changes and development database safety policy.

Update only the Stage 11 Progress Log row with actual measured results and deviations. Finish with the complete §0.5 Stage 11 report, including changed files, commands/results, acceptance status, negative tests, blockers and remaining work. Do not start Stage 12.
```

---

### Stage 12 — Integration, adversarial matrix and design handoff

**Depends on:** all other stages. **[VS Code suite].** **No new features.**

**Steps**

1. Run every §0.3 gate and the whole VS Code suite (all 85 discovered files, not only the configured five — use §0.3's procedure); compare against Stage 0's recorded baselines (standalone 1161 + each stage's additions; no test removed except those a stage named by title). Record actual exit statuses and totals.
2. **Reproduction regression:** the 1,374-line implementation-plan case end to end — one read, complete durable storage, beginning/middle/end retrieval through `query_evidence` without rereading, long-line fragment, byte offsets, zero-match search, pagination, eviction state, failed-tool observation. Report the measured numbers against Stage 0's baseline.
3. **Read-only audits** (report matches; fix nothing here):
   - replacement-hash leak audit: `grep -rn "current_hash" src/extension` — a current hash may appear only in an explicit verified lookup (`todos/current-resolution.ts`) and the two existing conflict paths that already return it (`line-edit.ts` `lineEditFailure(..., current_hash)` and `source-resolver.ts`'s `hash_mismatch` refusal). Those are permitted because the caller named the file and the host verified its content at that moment; a stale notice or projection reference may never carry a current hash.
   - sparse-metadata audit: no `favourite:false`, no empty arrays, no null placeholders in any model-facing message (assert with the fixture tests);
   - rerun/reread audit: every recommendation names a registered tool and existing data;
   - projection audit: `grep -n "project(" src/extension/context/projector.ts src/extension/tools/loop.ts src/extension/chat/index.ts` shows the single projector path and its wiring;
   - storage audit: the eviction path is explicit (`evicted_at`, `gap_reason`) and no code deletes a database.
4. **Rule-by-rule verification** — for each of Rules 0–7, name the test that proves it and record its result.
5. Confirm the managed-command contract Stage 10 produced can be consumed without schema change: run §4.8's rules as tests, list which are interface-only today, and record which clauses are already satisfied in this plan's Progress Log row; the managed-command design document is not edited by any stage on this branch.
6. Record everything not proven as `NOT RUN` with the exact error, plus every deviation, in the Progress Log and §13.

**Acceptance criteria:** all gates green or each exception recorded with its exact error; no unexplained audit match; the reproduction case passes without a reread; every rule has a named test; the design's §13 open questions are answered with evidence or listed as unresolved.

**Cannot be declared complete if:** any stage's own gate was claimed without observed counts; a timed-out integration run is counted as a pass; an assertion was weakened to make the matrix pass.

**Copy/paste prompt for Stage 12 (new Moriarty conversation):**

```text
You are implementing Stage 12 of docs/Moriarty_Context_Management_Implementation_Plan.md in /home/stark/source/twinny on branch context-management. Do not commit.

Read §0, §1, §2, §3, §4, §5, the Progress Log, the full Stage 12 section, and only the referenced design/contract sections needed for this stage. Confirm Stages 0–11 are marked done with recorded verification before editing. Check current branch/status and existing accepted evidence first; do not trust historical line numbers.

Stage 12 scope: Run the complete integration/adversarial matrix and all mandatory verification gates, including the full VS Code suite with captured final exit and Mocha summary. Reproduce beginning/middle/end evidence retrieval without reread, confirm Rules 0–7, report remaining managed-command interfaces/deviations and implement no new features.

Follow every Stage 12 instruction, acceptance criterion, negative/adversarial test, authorization boundary and no-go condition. Do only Stage 12; do not implement later stages or change stage contracts. Run §0.3 verification gates and this stage's focused tests, report actual exit codes and test totals. A timed-out or incomplete VS Code test run is NOT a pass. Preserve unrelated working-tree changes and development database safety policy.

Update only the Stage 12 Progress Log row with actual measured results and deviations. Finish with the complete §0.5 Stage 12 report, including changed files, commands/results, acceptance status, negative tests, blockers and remaining work. Do not start Stage 13.
```

---

### Stage completion report requirements (all stages)

Every stage reports in the §0.5 form and additionally records the numbers its own acceptance criteria depend on:

| Stage | What its report must contain |
|---|---|
| 0 | Gate counts, measured reproduction numbers, the frozen contract |
| 1 | complete v21 object inventory before/after (including later-stage objects), validated project config.json quotas/eviction, synthetic stream byte round trips and original/captured/stored bytes |
| 2 | Reproduction retrieval results (beginning / line 687 / last line), page sizes, cursor determinism |
| 3 | Which messages now carry real observation IDs, and the measured payload change |
| 4 | Per-class counts (current/stale/unknown/historical/superseded) from the named tests |
| 5 | Resolution states reached, and whether a second read was avoided |
| 6 | single-ID call outcomes by state; rejected batch input; replay-after-unmark proof; exact output without redundant defaults |
| 7 | Planned reserve/margin/limit at 128K and 256K, with the settings used |
| 8 | Determinism proof (two identical runs), tier counts, pairing check |
| 9 | Settings values actually read, threshold applied, display counters |
| 10 | Actual production command stdout/stderr stream isolation, exit states and the no-rerun assertion |
| 11 | The catalogue rows changed and the measured token/character savings |
| 12 | Full gate counts, rule-by-rule proof table, every `NOT RUN` with its error |

A stage is not complete until its Progress Log row holds those numbers. A stage that cannot run a gate records `NOT RUN: <exact error>` in the same row.

---


## 8. Security and authorization requirements (all stages)

- Authorization is independent of evidence (Rule 7). No hash match, observation UUID, blob reference or favourite grants read, write or command permission.
- `WorkspaceView.resolve`/`resolveNew`, `isProtectedPath`, team `blockedPaths`, `.gitignore` hiding inside the workspace, the access preflight (`access-preflight.ts`), operation-scoped write tokens (`operation-authorization.ts`) and the existing grant model (`access-grants.ts`, host isolation in `access-host.ts`) remain in force unchanged.
- Range retrieval and search apply the redaction/access policy; a denied lookup names no restricted candidate. A file outside authorized roots is not discoverable through evidence even if its content hash matches.
- Command output is untrusted data: an output line that looks like an instruction never becomes a system instruction (`GUIDANCE` in `tools/protocol.ts` stays the rule; Stage 10 tests it).
- At-rest protection or policy-driven exclusion for credentials must be stated in the completeness metadata when bytes are excluded.
- Indexing scope, tool access and evidence eligibility stay three separate axes (unified plan §2.3): a permission is not index enrollment, and evidence storage never widens filesystem reach.

---

## 9. Evidence validity and supersession semantics (normative)

| Class | Meaning | Can it be pruned from context? | Can it prove a criterion today? |
|---|---|---|---|
| `current` | verified observed source still matches | yes, oldest non-favourite last | yes, if relevant and sufficient |
| `stale` | verified content/version changed or a recorded dependency was invalidated | first tier | no — historical only |
| `unknown` | insufficient or currently inaccessible evidence to decide | only after stale, never before reported uncertainty | no |
| `historical` | an event or old snapshot that happened; factual as history | compacted to a reference when needed | as history, not as current proof |
| `superseded` | a user/task decision replaced it | protected user text is never pruned | the newer requirement governs future action |

Independent axes (must not share a destructive mechanism): the **immutable event record** (what was observed or attempted), the **mutable derived validity index** (does this still describe the current source), and the **context projector** (what do we send this request). Storage completeness, capture completeness and delivery completeness are three different facts; `retained`, `complete`, `partial`, `evicted`, `inaccessible` and `not_retrievable` are never synonyms.

---

## 10. Context pruning and UI requirements (normative summary)

- Threshold semantics: percentage of **effective model context capacity** at which the next request is pruned, accounting for response reserve, tool definitions, system instructions and a safety margin.
- Default strategy two-tier; `stale-first` available; default threshold 80% (provisional, subject to usability testing); range 40–95, step 5.
- Hysteresis: an internal target at threshold − ~5 points so pruning does not happen every step.
- Protected content: operative user instructions, system/tool policy, actively pending TODO/task state. Ordinary evidence is not protected by default; user input is inherently protected.
- Pairing: matching call IDs and minimal continuation markers must survive; no orphaned tool messages; no duplicate execution caused by projection.
- Diagnostics: oldest stale removed, valid removed, favourites compacted, token estimates, threshold reason, retrieval references — stored as `context_projections` + `context_projection_segments` without duplicating blobs.
- Display: configured capacity, estimated current usage, projected threshold, and automatic-pruning activity. Estimated prompt utilization must never be labelled as physical VRAM or per-slot KV occupancy.

---

## 11. Regression and adversarial testing matrix

Every row names the stage that owns it and where it is tested. "Additional tests uncovered by the audit" are rows 24–31, which came from inspecting the current implementation rather than the design.

| # | Scenario | Stage | Where tested |
|---|---|---|---|
| 1 | 1,374-line plan reproduction: complete storage, beginning/middle/end retrieval without rereading | 2, 12 | `evidence-access.standalone.ts`, `evidence-query-tool.standalone.ts` |
| 2 | Multiple reads of one source then a modification | 4 | `evidence-validity.standalone.ts` |
| 3 | Explicit stale-to-current lookup returning a verified replacement | 5 | `resolve-current-evidence.standalone.ts` |
| 4 | Deleted source returns no replacement | 5 | same |
| 5 | Renamed source resolves through its recorded link | 4, 5 | same + `workspace-index.test.ts` |
| 6 | Identical-content files / hash ambiguity | 5 | same |
| 7 | One UUID per favourite/unfavourite call; favourite on current and stale observations; replay after unmark | 6, 8 | `evidence-favourites.standalone.ts`, `context-projector.standalone.ts` |
| 8 | User requests protected and never stale | 6, 8 | same |
| 9 | Utilization crossing the configured threshold | 8, 9 | `context-projector.standalone.ts` |
| 10 | Oldest stale pruned before valid | 8 | same |
| 11 | Favourite compacted only when necessary | 8 | same |
| 12 | Source mutation during retrieval | 2, 5 | `evidence-access.standalone.ts`, `resolve-current-evidence.standalone.ts` |
| 13 | Editor buffer versus disk content | 4, 5 | existing boundary tests + suite |
| 14 | Source validity across restarts | 1, 4 | `todos-sqlite.standalone.ts` (reopen) |
| 15 | Cross-project evidence access denial | 2, 3, 6 | each stage's named test |
| 16 | Complete recording of failed tools | 1 | `evidence-storage.standalone.ts` |
| 17 | Large stdout and stderr results, per-stream order | 1, 10 | `evidence-storage.standalone.ts`, `command-evidence.standalone.ts` |
| 18 | Search returning zero matches as success | 2, 11 | both named tests |
| 19 | Missing, inaccessible and evicted evidence | 1, 2 | named tests |
| 20 | Compaction without orphaning tool messages | 8 | `context-projector.standalone.ts`, `tool-loop.standalone.ts` |
| 21 | No accidental reexecution of side-effecting tools | 7, 8 | named tests |
| 22 | Storage-capacity and crash-recovery failure modes; configurable project `config.json` overrides/reload | 1 | `evidence-storage.standalone.ts` |
| 23 | Accurate context-budget diagnostics; sparse metadata correctness | 7, 11 | `context-budget.standalone.ts`, `response-guidance.standalone.ts` |
| 24 | Failed calls currently store no retained content (`tool-evidence.ts` passes `evidenceOutput: undefined` on failure) — must now store the error payload while keeping presentation bounded | 1 | new test, named above |
| 25 | Head loss from today's rolling-tail capture (`MAX_CAPTURE_CHARS`) must be reported as `capture_limit`, never as complete | 10 | named test |
| 26 | Silent eviction (`enforceEvidenceBudget` sets `retained = 0`) must become an explicit state that retrieval can report | 1, 2 | named tests |
| 27 | Redaction applied to stored bytes today: original bytes and redacted presentation must be distinguishable | 1 | named test |
| 28 | Binary/oversized source files (`documents` skip rows, `MAX_SOURCE_BYTES = 512 KiB` in the boundary) must not become `invalid` through an I/O error | 4 | existing tests + new case |
| 29 | `onDidRenameFiles` is absent from the index today; rename invalidation must not depend on a hash match elsewhere | 4, 5 | named tests |
| 30 | Repeat suppression today re-runs a trimmed read; with the projector it must answer from a reference without executing | 7, 8 | named tests |
| 31 | `notes()` drops oldest blocks and `MAX_EVIDENCE_TEXT` truncates stored JSON: neither may be presented as complete history | 1, 8 | named tests |

---

## 12. Verification and completion policy

- Use the gates in §0.3; confirm they still exist before prescribing them for a stage. `npm run test:sqlite`, `npm run build-tests`, `npm run build`, `npx tsc -p . --noEmit`, `npx eslint src --quiet`, `git --no-pager diff --check` are present at planning time; the VS Code gate is `xvfb-run -a npm test`.
- Focused gates where relevant: SQLite/evidence, context-budget, authorization, tool-protocol and VS Code integration tests.
- A long-running integration test may be executed detached, but a timeout or missing final Mocha summary is not a pass; report `NOT RUN` with the exact error.
- Every stage reports actual exit statuses and pass/fail/pending counts for every command it ran.
- Never weaken assertions, introduce hidden skips, or declare a stage green on compilation alone. A bug fixed here must have a test that fails without the fix.
- Formatting-only changes are not an approval gate; do not reformat lines outside a stage's own changes.

---

## 13. Known risks and unresolved decisions

**Resolved maintainer decisions:** storage limits, eviction and retention settings are project `config.json` data (§5.3); favourite operations are deliberately single-observation calls (§4.5/Stage 6); the full v21 schema is owned by Stage 1, including the Stage 4/6 structures; Stage 6 has no forward dependency on Stage 8; Stage 10 (not Stage 1) proves independent streams from actual `run_command` execution.

**Architecture conflicts found during the audit — these need attention before implementation.**

1. **Storage completeness versus presentation bounds.** Today `compactEvidenceText` truncates the stored record at `MAX_EVIDENCE_TEXT = 1000` and `compactToolEvidence` reduces successful output to counts, while `preserveEvidence` keeps up to `200_000` chars of *redacted* text. Stage 1 must separate "authoritative captured bytes" from "bounded presentation", or the design's completeness fields would measure a copy rather than the truth. Decision needed: keep `todo_tool_evidence` as presentation only (this plan's choice) and make blobs authoritative.
2. **Stream capture shape and ownership.** The existing command sink merges both streams. Stage 1 establishes complete storage using synthetic independent-stream inputs; Stage 2 retrieves them; Stage 10 modifies the existing one-shot sink narrowly and verifies independent real stdout/stderr capture. Stage 1 cannot claim production-command separation. Stage 10 must preserve approval, timeout and process lifecycle safeguards. If the current runner cannot meet these requirements, the **minimum managed-command capture transport becomes an immediate prerequisite**, not a deferred issue beyond Stage 11.
3. **Redaction at rest.** `redactEvidence` currently mutates what is stored, so "original bytes" and "policy exclusion" must be recorded per blob; the design leaves at-rest protection as policy. Needs a maintainer decision before Stage 1's tests are written: lossless-plus-redacted-presentation, or excluded-by-policy with an explicit gap record.
4. **Rename identity.** `SourceRoots` has no rename table and the index has no `onDidRenameFiles`; Stage 4 adds the event path. A verified rename link must not be inferred from a matching hash (Stage 13 of the unified plan deliberately left matching hashes as candidates only).
5. **Threshold vs hard limit.** The projector's threshold is a policy; the provider's hard limit stays authoritative even with pruning off. A stage that changes `planContext` semantics could make a request exceed what a server holds — the existing "smallest confirmed size wins" rule must not be relaxed.
6. **Favourite scope** (design §13.8): this plan implements per-project observation preference with conversation/task visibility filtered by authorization, which is the design's recommended default. If the maintainer wants per-conversation scoping, Stage 6 must change before Stage 8 relies on it.

**Design §13 open questions and what the audit answers today**

| Question | Answer at planning time |
|---|---|
| Does the project DB retain raw bytes, normalized text or only compact/redacted excerpts? | Redacted text up to `MAX_RETAINED_EVIDENCE_CHARS`; counts-only summaries for successes; no raw bytes. Authoritative path for commands and failed calls is absent → Stage 1. |
| Guaranteed storage policy for large/binary/credentials? | None exists beyond per-list char budget → Stage 1 (§5.3). |
| Which fingerprint corresponds to disk versus editor buffer? | `observation_source.observed_version` + `editor_version`; the boundary distinguishes them; the index describes disk only. |
| How much derived-fact dependency metadata already exists? | FK links (`observation_id`) only, no edge table → Stage 4's minimal additive schema. |
| Provider-estimated tokens versus counted tokens? | `TokenEstimator` learns from counted requests; `ContextUsageStore` records counted vs estimated separately. Reliable enough for a threshold if the margin is respected. |
| Minimal context fields required by tool call/result pairing? | Call ID + role + tool name for native mode; name + body for text mode; Stage 8 must preserve exactly these. |
| Did evidence lookup tools change since the investigation? | `twinny_evidence_lookup` returns facts, per-reference validity, relocation candidates and bounded observations — metadata only, no content ranges → Stage 2/3. |
| Favourites scoped per project, conversation or task? | Recommendation adopted: per-project preference with authorization-filtered visibility. |

---

## 14. Implementing one stage in a fresh conversation

1. Open the plan at §0, §1, §2, §3, §4, the Progress Log and the stage you are given. Do not read other stages except where this stage cites them.
2. Establish repository state per §0.4 (branch, status, gates, evidence lookup before rereading).
3. Create the stage's own TODOs through the native TODO tools with a parent under the plan task; do not hand-mark completion — submit claims and let Feedback decide. Distinguish an approval requirement (protected file, outside-workspace access) from a review status.
4. Implement only this stage's files. If the plan names a file that does not match what you read, stop and report the contradiction.
5. Run every verification command in the stage's own section, plus the §0.3 gates, recording real counts.
6. Write the §0.5 report and update the Progress Log row; keep unrelated working-tree changes untouched; delete scratch files.
7. Resume rules after interruption, restart or model handoff: read the Progress Log row for this stage, `git status --short`, the stage's own test file results, and the persisted state (`context_projections`, `evidence_*` rows). Do not redo work that accepted evidence already proves; do not rerun a side-effecting tool to recover output. After context compaction, recover from stored evidence, not from memory, and never re-execute a mutation whose record exists.
8. No indefinite retry loops: a deterministic failure is reported once with its exact error, then the stage's remaining work continues or stops.

---

## 15. Overall definition of done

A long Moriarty run is complete when it can repeatedly read and edit files, preserve all original authorized tool execution evidence, retrieve any retained part by UUID without repeating the operation, invalidate source-dependent facts without exposing a new hash, honour favourites and Rule 0, resolve an old observation to an independently verified current source (or a clear deleted/ambiguous/unavailable state), and automatically prune stale then older valid model-visible results at the configured inline threshold. The model must be able to tell apart "not seen", "seen historically", "still current", "not stored" and "not authorized". Tests prove tool-call/result pairing, permissions, sparse protocol accuracy, determinism of the projector, and the absence of fake success or duplicated execution.

The managed `run_command` redesign remains a separate reviewed effort; it adopts this branch's observation, output-stream and retrieval contracts without redesigning the evidence database.

*End of plan. Nothing here has been implemented; the first action is Stage 0, and this document itself must not be treated as an implementation.*
