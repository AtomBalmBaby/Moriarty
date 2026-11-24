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
| 2 | Git session baseline and ownership tracker | not started | | | | |
| 3 | Repository/status/change native tools | not started | | | | |
| 4 | Alternate-index staging and commit | not started | | | | |
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
