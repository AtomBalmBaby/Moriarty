# Moriarty Native Git Integration Design

**Status:** Design only - no implementation
**Repository:** `/home/stark/source/twinny`
**Branch audited:** `context-management`
**Audited at:** 2026-11-24

## 1. Intent and decisions

Moriarty needs native, observable Git operations that preserve the repository, the user's existing
work, the permanent logical identity `Moriarty`, and the identity of the underlying chat/model
without exposing authentication secrets.

This design makes Git operations part of Moriarty's existing native-tool, authorization,
workspace-boundary, evidence, source-validity, project-database, and context-management
architecture. It does not introduce a second Git client, credential database, shell runner, or
context subsystem.

Non-negotiable decisions:

- Git operations never use `git add -A`.
- A chat session captures its initial staged, unstaged, untracked, HEAD, branch, index and working
  tree state.
- Moriarty attributes only changes its own verified operations produced.
- Commit and push are separate, authorized, durable operations.
- The real user index is preserved. Commit preparation uses an alternate `GIT_INDEX_FILE`.
- `run_command` is not a provenance-bearing Git mutation path. Obvious mutating Git subcommands
  may be invoked through the shell without native Git attribution or authorization. This
  limitation is explicit and temporary, pending the planned `run_command` redesign.
- GitHub, GitLab and self-hosted repositories use ordinary Git commands. No hosting-service API is
  required for basic commit or push operations.
- Authentication is independent of author, committer and co-author identities.
- Automatic Moriarty attribution is enabled unless project configuration explicitly disables it.
- Explicit task restrictions, especially "Do not commit" and "Do not push", override all workflow
  permissions.
- Credentials never enter tool arguments, model-visible output, evidence, commit metadata or logs.

## 2. Repository foundation to reuse

The implementation must build on these audited components rather than replace them.

| Existing component | Reuse |
|---|---|
| `src/extension/tools/workspace.ts` | Native tool registry, typed tool arguments/results, mutating-tool serialization, workspace boundary dispatch |
| `src/extension/tools/more.ts` | Existing authoritative native `git(view)` tool implementation and compatibility boundary |
| `src/extension/tools/helpers.ts` | Existing `readOnlyGitArgs`, `gitNamedPaths`, `READ_ONLY_GIT` allowlist and shell-operator/path safety guards |
| `src/extension/tools/operation-authorization.ts` | Extend with typed Git operation authorization rather than creating an independent approval model |
| `src/extension/tools/access-preflight.ts` | Repository and remote/destination preflight, one call's authorization lifecycle |
| `src/extension/tools/access-grants.ts` | Existing host-scoped, once-used authorization storage and canonical path rules |
| `src/extension/chat/command-snapshot.ts` | Before/after repository snapshots already used to track changes made by commands |
| `src/extension/chat/reply-changes.ts` | Session/reply file-change evidence and undo state |
| `src/extension/chat/tool-sinks.ts` | Edit operation ledger, sinks and source save reconciliation |
| `src/extension/chat/tool-evidence.ts` | Durable project tool observations |
| `src/extension/todos/evidence-store.ts` | Bounded raw evidence and evidence blob storage |
| `src/extension/todos/evidence-config.ts` | Existing project-owned `.twinny/config.json` parser/reload behavior |
| `src/extension/todos/sqlite.ts` | Unified project database and schema ownership |
| `src/extension/todos/repository.ts` | Project operations, source-dependency context and edit operation ledger |
| `src/extension/todos/dependency-index.ts` | Recorded source events and origin |
| `src/extension/todos/source-validity.ts` | Git operation stale/unknown/current classification contract |
| `src/extension/chat/index.ts` | Conversation identity, task scope, active model/provider and tool construction |
| `src/common/types.ts` | Reply/model metadata and tool result contracts |
| `src/test/standalone/*.standalone.ts` | Standalone temporary-repository and database test pattern |

### Existing Git implementation audit

The current native Git implementation is actually present at these locations and symbols:

- `src/extension/tools/more.ts`: `insideGitRepository(root)` detects a repository,
  `GIT_PINNED` pins Git output/options, `runGit(root,args,signal)` executes one argument-array
  Git process, and `git(view)` is the registered native tool.
- `src/extension/tools/helpers.ts`: `READ_ONLY_GIT` is the subcommand allowlist,
  `readOnlyGitArgs(line)` parses and guards legacy `args` strings, and `gitNamedPaths(args)`
  identifies repository/workspace paths.
- `src/extension/tools/workspace.ts`: `workspaceTools(...)` registers `git(view)` only when
  `insideGitRepository(view.root)` succeeds. `WorkspaceTools.run(...)` dispatches it through the
  shared tool boundary and `serializeMutation(...)` serializes mutating tools.
- `src/test/standalone/more-tools.standalone.ts`: real-repository tests prove legacy argument
  parsing and read-only behavior.

The current `git(view)` tool has this compatibility contract:

- name: `git`;
- `readOnly: true`;
- parameter: `args`, for text such as `status -u`, `diff --stat` or `log -5 --oneline`;
- guard: `readOnlyGitArgs` rejects `commit`, `push`, branch mutation and unsafe/diff options;
- result: model-facing `$ git ...`, exit code, bounded text, and a one-line summary;
- repository/path guard: hidden/ignored and outside-workspace paths are removed or refused;
- execution: `execFile("git", [...GIT_PINNED, ...args])`, never a shell command.

This implementation is the authoritative compatibility and repository-resolution boundary to
extend. It must not be replaced by a second set of Git tools.

### Existing context-management dependencies

The Git design depends on work still in progress or recently implemented on the
`context-management` branch:

- durable project observations and evidence;
- source validity/dependency invalidation;
- compact and retrieval-aware tool results;
- conversation/task provenance;
- source event reporting;
- context pruning and protected system-policy segments.

Git work must wait for the context/evidence schema and contracts it consumes to reach their
published branch checkpoints. Git must not modify or redefine those contracts.

## 3. Identity model

Git attribution has four distinct identities.

| Identity | Purpose | Source |
|---|---|---|
| Logical agent identity | Permanent Moriarty attribution | Constant `Moriarty` |
| Author identity | Git commit author | Moriarty or a known human, depending on ownership and tagging policy |
| Committer identity | Git commit committer | Moriarty when tagging, otherwise normal Git identity |
| Authentication identity | HTTPS/SSH account used to push or fetch | Inherit, dedicated, environment or future managed provider |
| Model provenance | Which provider/model/hosted execution initiated an operation | Project database/evidence only; never used as Git co-author |
| Human identity | Directing human for co-authorship | Project config, `git config user.name/email`, or explicit trusted host instruction |

No account or credential used for authentication changes the logical name `Moriarty`.

### Permanent Moriarty identity

The automatic Git identity name is always `Moriarty`. It is not the operating-system username,
provider name, model name or account login.

The Moriarty email is never hardcoded. It is resolved before commit creation from project config,
the user-preference layer or a normal VS Code environment. The illustrative project value:

```json
{
  "git": {
    "identity": {
      "email": {
        "env": "MORIARTY_GIT_EMAIL"
      }
    }
  }
}
```

A missing or empty Moriarty email is a configuration error. Tagging-disabled commits do not require
the Moriarty email because Moriarty is not used as author or committer.

## 4. Project configuration

Project settings continue to use `<projectHome>/.twinny/config.json`, next to
`project.sqlite`. A missing file uses built-in defaults. Invalid JSON or invalid Git values produce
actionable configuration errors and do not silently fall back. Unknown keys remain preserved;
the existing evidence parser reports unrelated keys instead of dropping them.

Add this documented shape:

```json
{
  "evidence": {
    "storage": {
      "enabled": true
    }
  },
  "git": {
    "workflow": {
      "mode": "manual-approval",
      "plainCommit": "commit-only"
    },
    "destination": {
      "remote": "origin",
      "branch": "current",
      "setUpstream": true
    },
    "identity": {
      "tagging": true,
      "email": {
        "env": "MORIARTY_GIT_EMAIL"
      },
      "human": {
        "name": "Ada Human",
        "email": "ada@example.com"
      }
    },
    "auth": {
      "mode": "inherit"
    }
  }
}
```

### Schema

- `git.workflow.mode`: `"manual-approval"`, `"local-commits"`, `"commit-and-push"`, or
  `"autonomous"`.
- `git.workflow.plainCommit`: `"commit-only"` or `"commit-and-push"`:
  - `"commit-only"` means an ordinary commit request does not publish.
  - `"commit-and-push"` means an ordinary commit request publishes only if it is in a mode that
    permits push and an explicit destination is available.
- `git.destination.remote`: non-empty remote name or URL; default `"origin"` for presets.
- `git.destination.branch`: `"current"` or a fully qualified/local branch name.
- `git.destination.setUpstream`: boolean; default `true`.
- `git.identity.tagging`: boolean. Missing means `true`; invalid values are rejected.
- `git.identity.email`: direct string or `{ "env": "ENV_NAME" }`.
- `git.identity.human`: optional `{ "name": string, "email": string | {"env": "ENV_NAME"} }`.
- `git.auth.mode`: `"inherit"`, `"dedicated"`, `"environment"` or `"managed"`.
- `git.auth.sshIdentityFile`: optional absolute or `~`-expanded path.
- `git.auth.credentialHelper`: optional Git credential helper name or command.
- `git.auth.username`: optional authentication username, never a password or token.
- `git.auth.env`: optional map from a limited set of Git environment names to env references.

Only environment variable names are stored in project config for environment credentials. Secret
values are resolved into the child process environment at execution time.

Example environment authentication:

```json
{
  "git": {
    "auth": {
      "mode": "environment",
      "env": {
        "GIT_ASKPASS": { "env": "MORIARTY_GIT_ASKPASS" },
        "GIT_SSH_COMMAND": { "env": "MORIARTY_GIT_SSH_COMMAND" },
        "GIT_HTTP_EXTRA_HEADER": { "env": "MORIARTY_GIT_HTTP_EXTRA_HEADER" }
      }
    }
  }
}
```

`GIT_HTTP_EXTRA_HEADER` and similar values are never included in evidence or errors.

### Configuration precedence

Effective configuration is resolved lowest to highest:

1. built-in defaults;
2. machine/user VS Code Git preferences;
3. project-owned `.twinny/config.json`;
4. explicit task restrictions.

Explicit instructions such as "Do not commit", "Do not push", "Do not amend", "Do not force-push"
and "use only this remote/branch" are host-derived policy, not model-supplied config. They override
permissive project/workflow defaults.

The attribution opt-out is project-only and manually editable. It is not added to VS Code settings,
package configuration or the GUI.

## 5. Workflow presets

Every preset is a permission policy, not a requirement to create a commit.

| Preset | Commit | Push | Approval behavior |
|---|---|---|---|
| `manual-approval` | Ask | Ask | Ask separately for commit and push |
| `local-commits` | Commit when instructed or authorized | Never automatic | Ask if no clear commit authorization |
| `commit-and-push` | Commit an authorized request | Permit an explicitly requested publish workflow once destination is authorized | `plainCommit` decides whether plain "commit" stays local |
| `autonomous` | Permit Moriarty to commit appropriate milestones | Permit push to authorized remotes/branches | No repeated prompt for previously authorized operation/destination |

Commit authorization and push authorization are separate capabilities. Authorizing commit never
authorizes push. Authorizing push never authorizes force-push, rebase, reset, amend, history
rewriting or protected-branch operations.

For version 1:

- ordinary commit and non-force push only;
- no implicit force/lease force;
- no implicit protected-branch override;
- no automatic rebase or pull;
- no reset or amend;
- no branch creation/deletion except an explicit future capability;
- no shell route for these operations.

### Examples

- `"commit"` in `local-commits`: create a commit locally.
- `"commit"` in `commit-and-push` with `plainCommit="commit-only"`: create a commit and leave it
  local.
- `"commit and push"` in `commit-and-push`: commit and push once using the authorized destination.
- `"commit and push"` in `manual-approval`: ask for commit and push as separate operations.
- `"do not push"`: `operation:"push"` is denied even in `autonomous`.

## 6. Authentication

Authentication is resolved only inside the native Git host. It is not passed to Moriarty and is
never retained in project evidence.

### Inherit

Default mode. Git uses:

- existing Git configuration;
- `~/.ssh`, SSH agent and `GIT_SSH`;
- credential helpers;
- existing `GIT_*` environment variables;
- Git's normal HTTPS behavior.

The Git host must disable terminal prompts unless explicitly configured through a safe askpass
facility:

```text
GIT_TERMINAL_PROMPT=0
```

Interactive credential prompts do not expose credentials to the model or tool result.

### Dedicated

Dedicated mode may configure:

- an SSH key path;
- an SSH command/agent;
- a credential helper;
- a Git username;
- a dedicated HTTP askpass program.

No private key content or secret helper output enters arguments or evidence. Dedicated
configuration is for credential selection only, never attribution.

### Environment

Environment mode resolves named environment variables at process creation:

- the project stores variable names;
- the host reads values from the process environment;
- missing variables produce a clear authentication configuration error;
- secret values are held only in the child-process environment and omitted from all logs.

Environment values are never copied into database rows or tool results.

### Future managed credentials

Define a clean provider contract:

```text
GitCredentialProvider.resolve({
  repository,
  remote,
  operation: "fetch" | "push",
  signal
}) -> {
  environment?: ReadonlyMap<string, string>,
  gitConfig?: ReadonlyMap<string, string>,
  sshIdentityFile?: string
}
```

The provider is implemented only in a future credential-daemon stage. It must return secret values
to the immediate Git process only. Moriarty never sees or stores the result. The provider interface
is not an authentication database.

## 7. Native tool architecture

Native Git operations remain registered by the existing `git(view)` tool in
`src/extension/tools/more.ts`. Moriarty does not introduce `git_status`, `git_commit`,
`git_push`, or separate read/commit/push tool names.

The existing `args` parameter remains fully compatible:

```json
{"args":"diff --stat"}
{"args":"status -u"}
{"args":"log -5 --oneline -- src/a.ts"}
```

When `args` is present, `git(view)` uses `readOnlyGitArgs`, `gitNamedPaths`,
`refuseBareArguments`, `GIT_PINNED` and `runGit` exactly as today. No mutating subcommand is
accepted and the model-facing output remains compatible.

Structured mutating and compound operations are added through sparse typed fields on the same
tool:

```ts
type GitOperation =
  | "status"
  | "inspect"
  | "prepare_commit"
  | "commit"
  | "push"
  | "recover";

interface GitToolArguments {
  args?: string;                    // Legacy read-only compatibility
  operation?: GitOperation;         // Typed shared-service operation
  repository?: string;
  paths?: string[];
  hunks?: Array<{ path: string; patch: string }>;
  message?: string;
  operationId?: string;
  commitSha?: string;
  remote?: string;
  branch?: string;
  setUpstream?: boolean;
  attribution?: {                  // Host-validated; not used for credentials
    mode?: "automatic" | "preserve-human" | "explicit";
  };
}
```

`args` and `operation` are mutually exclusive. The tool's dynamic read-only classification is:

- legacy `args`: read-only;
- `operation: "status" | "inspect" | "recover"`: read-only;
- `operation: "prepare_commit" | "commit" | "push"`: mutating/transactional.

The existing tool interface is extended minimally with a call-aware read-only classifier rather
than changing all existing tool definitions. The workspace loop can use it both for mutation
serialization and for duplicate/read-only caching.

### 7.1 One Git execution service

The implementation introduces one internal service behind `git(view)`:

- repository resolution;
- real repository discovery;
- read-only argument execution;
- status/inspection;
- auth environment resolution;
- baseline/ownership integration;
- alternate-index staging;
- commit metadata and co-author trailers;
- push/destination resolution;
- transaction/auditing/recovery;
- model-visible and evidence result shaping.

The proposed location is `src/extension/git/service.ts`, with `GitExecutionService` constructed
by `src/extension/tools/more.ts`/`workspaceTools`. It centralizes execution but does not own
credentials or add a second database. `git(view)` remains the tool registrar and compatibility
adapter.

This service may extract and reuse `runGit`, repository prefix/path filtering and output clipping
from `more.ts`; those private pieces are not left duplicated. It must also reuse
`readOnlyGitArgs`, `gitNamedPaths`, `insideGitRepository`, `GIT_PINNED` and hidden-file filtering.

No `GitHubRemote`, GitHub API, GitLab API or hosting-service implementation is part of basic
commit/push execution.

### 7.2 Status and inspection operations

`operation:"status"` or legacy `args:"status"` reports HEAD, branch, staged/unstaged/untracked
changes and commit/push capability:

```json
{
  "kind": "git_status",
  "observationId": "uuid",
  "succeeded": true,
  "repository": { "top": "/workspace/root", "head": "04489ba...", "branch": "context-management" },
  "baselineId": "uuid",
  "staged": ["src/a.ts"],
  "unstaged": ["src/b.ts"],
  "untracked": ["scratch.txt"],
  "capabilities": {
    "commit": "allowed" | "denied" | "approval-required",
    "push": "allowed" | "denied" | "approval-required"
  }
}
```

`operation:"inspect"` returns ownership classes: `agent`, `human`, `external`, `mixed` or
`unknown`. Large diffs remain in existing evidence storage, not in the model-visible result.

### 7.3 Prepare/commit operations

`operation:"prepare_commit"` creates a transaction record and stages an exact commit scope in an
alternate `GIT_INDEX_FILE` without touching the real index.

The result:

```json
{
  "kind": "git_commit_prepared",
  "observationId": "uuid",
  "operationId": "uuid",
  "succeeded": true,
  "head": "04489ba...",
  "selectedFiles": ["src/a.ts"],
  "selectedDiffSha256": "sha256",
  "empty": false,
  "realIndexPreserved": true,
  "requiresCommitApproval": true
}
```

`operation:"commit"` accepts only `operationId` and host-derived state. It does not accept
author/committer/credential values. Before execution it verifies HEAD, real-index digest,
selected content/hunks, alternate-index tree and task policy.

After execution:

```json
{
  "kind": "git_commit",
  "observationId": "uuid",
  "operationId": "uuid",
  "state": "succeeded",
  "commit": {
    "sha": "abcdef...",
    "parents": ["04489ba..."],
    "author": { "name": "Moriarty", "email": "<configured>" },
    "committer": { "name": "Moriarty", "email": "<configured>" },
    "coAuthors": [{ "name": "Ada Human", "email": "ada@example.com" }],
    "message": "Fix the parser",
    "files": ["src/a.ts"],
    "tree": "123456..."
  }
}
```

Ambiguous completion is recovered by repository inspection. A matching commit is reused and no
second commit is created.

### 7.4 Push and recovery operations

`operation:"push"` uses exact commit SHA and the effective destination:

```json
{
  "kind": "git_push",
  "observationId": "uuid",
  "operationId": "uuid",
  "state": "succeeded",
  "remote": "origin",
  "branch": "context-management",
  "commitSha": "abcdef...",
  "remoteShaBefore": "04489ba...",
  "remoteShaAfter": "abcdef...",
  "setUpstream": true
}
```

`operation:"recover"` requires only `operationId`; it first inspects local/persisted/remote state
and never retries solely from an exit code or timeout.

## 8. Commit preparation and staging isolation

### 8.1 Session baseline

At the start of each chat session/conversation, the host records:

- repository top and `.git` location;
- HEAD SHA or unborn state;
- branch, detached HEAD state;
- initial real-index digest;
- staged paths/diffs;
- unstaged tracked paths/diffs;
- untracked paths;
- initial working-tree snapshot;
- selected repository capabilities.

The baseline is project-database metadata, not a context prompt. It survives context pruning and
conversation restoration.

The existing `snapshotTree`/alternate-index pattern in `command-snapshot.ts` is reused for
working-tree snapshots. `git status --porcelain=v1 -z`, `git diff --name-status -z` and
`git diff --cached --name-status -z` provide the exact classifications.

### 8.2 Ownership tracking

Use existing change evidence:

- native file edits: `reply-changes.ts` records first-touch state and final state;
- apply-mode edit ledger: `todo_edit_operations` records target, pre/post digest and status;
- command mutations: `command-snapshot.ts` records repository tree before/after;
- source saves: existing source-event infrastructure records save/unknown changes;
- Git operations: native Git tool observations link operation, task, conversation and source refs.

The Git session service receives host facts from these components. It does not infer ownership by
matching arbitrary text or asking the model.

Ownership rules:

- A file touched first by Moriarty's native edit/command evidence is `agent` for that session.
- A file changed only in the baseline is not agent-owned.
- A file changed by Moriarty and subsequently changed externally is `mixed` or `unknown`.
- A file staged by a human before the session remains human-owned unless Moriarty verified a new
  hunk against a host-owned edit record.
- If ownership of a file or hunk is unknown, split where possible or require explicit authorship.
- Clean start does not authorize committing later unrelated human changes.

### 8.3 Alternate index

For every preparation:

1. create a temporary index from a copy of the real index;
2. set `GIT_INDEX_FILE` for all staging and commit commands;
3. never call `git add -A`;
4. stage exact selected agent paths or apply verified hunk patches;
5. write the alternate index tree;
6. verify the selected diff;
7. preserve and verify the real index digest;
8. delete alternate-index scratch files after commit or explicit cancellation.

For exact-file selection:

- only wholly agent-owned files may be staged automatically;
- mixed or unknown files require hunk selection or a trusted explicit whole-file choice;
- pre-existing staged content is never replaced or committed as agent work;
- pre-existing unstaged content is never automatically included;
- untracked files are included only when verified agent-created.

Hunk-level support is required to the practical extent existing edit evidence makes it possible.
In V1, exact-file staging is complete; hunk patches for verified native edits are supported. Hunk
selection for arbitrary external diffs may be a follow-up if diff ownership cannot be established.

### 8.4 Concurrent change check

Before commit:

- HEAD SHA equals prepared parent;
- real index content digest equals prepared real-index digest;
- working-tree digest for exact selected files equals prepared digest;
- alternate-index tree equals the prepared tree;
- no selected file was changed after preparation in an ownership-unknown way;
- no other Git operation has claimed the same commit intent.

If a check fails, the operation is refused and the model is told to inspect or reprepare. Moriarty
does not merge, reset or overwrite the user's work.

## 9. Attribution policy

### 9.1 Attribution enabled

Automatic attribution uses:

- author `Moriarty`;
- committer `Moriarty`;
- human co-author, if a known human identity exists;
- no underlying model as Git co-author.

Standard co-author trailer:

```text
Co-authored-by: Ada Human <ada@example.com>
```

One trailer per human identity. Names and emails are trimmed and de-duplicated case-insensitively.
Moriarty is not added as co-author in a commit it already authors.

### 9.2 Clean working tree at session start

When Moriarty makes changes and is authorized to commit:

```text
Author: Moriarty <configured-email>
Committer: Moriarty <configured-email>
Co-authored-by: <human directing task>
```

Model identity is stored in the Git operation evidence record, not in a co-author trailer.

### 9.3 No Moriarty change; existing work committed

When Moriarty makes no changes and commits existing work:

- author: preserve the known human/original author;
- committer: Moriarty;
- co-author: none solely because Moriarty committed.

If the existing author is unknown, require explicit authorship or use a verified normal Git
identity, never label Moriarty as author merely because it executed the commit.

### 9.4 Dirty session baseline

Pre-existing changes are never attributed to Moriarty. Split commits or require explicit choice
for mixed/unknown ownership.

Human changes introduced after a clean session start are not claimed even if Moriarty later
commits them; exact ownership verification prevents this.

### 9.5 Tagging disabled

If `git.identity.tagging === false`:

- Moriarty is not used as author or committer;
- Moriarty co-author trailers are omitted;
- Moriarty advertising/model trailers are omitted;
- commit/push functionality uses normal configured Git identities;
- no history rewriting or retroactive changes occur.

Invalid or missing other project values are validated separately.

Explicit per-commit attribution instructions may override automatic identity only when supplied
through a trusted host policy. Tool arguments cannot replace Moriarty's logical identity or hide
authentication secrets.

## 10. Commit and push transaction semantics

### 10.1 Commit record

Add compact project metadata rather than large evidence dumps.

Each commit operation retains:

- operation ID and invocation ID;
- repository top and project fingerprint;
- conversation ID and task/item ID;
- execution ID;
- model provider/model name when the host has it;
- prepared/initial HEAD and branch;
- selected paths/hunks and selected diff digest;
- real index digest;
- alternate-index tree digest;
- author/committer/co-author identities;
- commit SHA, parents and tree SHA;
- changed-file summary;
- state and timestamps;
- outcome/refusal/uncertain reason;
- source observation and evidence references.

Email and human names are commit attribution data, not secrets. Credentials are absent.

### 10.2 Commit state machine

```text
prepared -> commit_authorized -> running -> succeeded
                              \-> refused
                              \-> failed
                              \-> uncertain

uncertain -> succeeded (repository verified matching commit)
           -> failed (verified no matching commit)
           -> uncertain (still cannot prove outcome)
```

A successful commit is never repeated solely because a tool response was interrupted. Retry by
operation ID is an idempotent status check.

### 10.3 Push state machine

```text
push_authorized -> running -> succeeded
                           -> rejected
                           -> failed
                           -> uncertain

uncertain -> succeeded (remote ref equals local commit)
           -> rejected/failed (verified remote state differs)
           -> uncertain (network/state remains ambiguous)
```

Push never creates a commit. It records remote name, destination branch, local SHA, expected remote
SHA where available and actual remote SHA. It never assumes an exit code proves remote state.

Normal push uses `git push` without force options. Non-fast-forward rejection is reported and no
automatic rebase/reset/force is attempted.

## 11. Concurrency and recovery

### 11.1 Within Moriarty

- serialize mutations per workspace/repository with an in-process promise queue;
- serialize only Git operations; do not block unrelated projects;
- keep no SQLite transaction open during network or Git process waits;
- use database compare-and-set for operation state;
- one invocation ID owns one operation and terminal state;
- a duplicate call for the same operation ID returns the existing terminal/uncertain state.

### 11.2 Multiple conversations and hosts

Git operation records are project-owned and include conversation/task/host provenance.

- another conversation may inspect a project baseline or operation;
- it may not replay or re-own another conversation's prepared operation;
- an operation that is still running or uncertain is reconciled from Git state;
- stale prepared operations do not mutate the repository;
- edit and Git target blockers use existing project database patterns.

### 11.3 Interrupted commit

If commit response is lost:

1. inspect local operation state;
2. verify HEAD SHA and recent commit candidates;
3. match parent, tree and operation fingerprint;
4. mark succeeded only on a matching commit;
5. otherwise report failed or uncertain and ask for no automatic replay.

No empty commit is manufactured. An operation that prepared no tree diff is refused.

### 11.4 Interrupted push

If push response or network state is lost:

1. read local commit SHA;
2. inspect configured remote ref using `ls-remote` or an existing remote-tracking ref;
3. compare remote SHA;
4. mark succeeded if the remote ref equals local SHA;
5. mark rejected if the remote is ahead or changed incompatibly;
6. mark uncertain if remote access cannot prove the result.

Only an authorized explicit retry after state reconciliation may run push again.

## 12. Database and evidence integration

The unified project database is the owner of Git transaction metadata.

### Proposed tables

This is an exact proposed additive schema. The implementation stage must preserve schema v21 data
and not reset or replace the developer database.

```sql
CREATE TABLE git_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NOT NULL REFERENCES todo_projects(id),
  conversation_id TEXT,
  task_id TEXT,
  host_key TEXT NOT NULL,
  repository_top TEXT NOT NULL,
  head_before TEXT,
  branch_before TEXT,
  real_index_digest TEXT,
  baseline_json TEXT NOT NULL,
  model_provider TEXT,
  model_name TEXT,
  restrictions_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE git_operations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES todo_projects(id),
  session_id TEXT NOT NULL REFERENCES git_sessions(id),
  conversation_id TEXT,
  task_id TEXT,
  execution_id TEXT,
  host_key TEXT NOT NULL,
  invocation_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('commit','push')),
  state TEXT NOT NULL CHECK(state IN (
    'prepared','authorized','running','succeeded','failed',
    'refused','rejected','uncertain'
  )),
  repository_top TEXT NOT NULL,
  request_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  observation_id TEXT REFERENCES todo_tool_observations(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, invocation_id)
);

CREATE TABLE git_change_ownership (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES git_sessions(id),
  operation_id TEXT REFERENCES git_operations(id),
  path TEXT NOT NULL,
  ownership TEXT NOT NULL CHECK(ownership IN (
    'agent','human','external','mixed','unknown'
  )),
  confidence TEXT NOT NULL CHECK(confidence IN ('verified','known','uncertain')),
  pre_digest TEXT,
  post_digest TEXT,
  hunk_json TEXT,
  source_observation_id TEXT REFERENCES todo_tool_observations(id),
  created_at TEXT NOT NULL
);
```

No credential, raw patch, remote secret URL or large diff is stored in these tables.

The implementation should use schema version `22` and an additive migration from v21. It must:

- create a backup of the database file before migration;
- create only the new tables and indexes;
- set `user_version` after a successful transaction;
- leave the existing file and existing rows untouched;
- refuse migration if integrity or backup verification fails;
- never reset, vacuum-replace or silently delete an existing developer database.

Minimization principle: if the context/evidence branch later provides a vetted generic
transaction-table contract, migrate Git operations onto it instead of duplicating a third
contract. The Git table names above are the fallback exact design.

### Evidence behavior

Each native Git call uses `toolObservationInput` and `recordToolResult`:

- compact model-visible result;
- bounded raw command output retained when useful;
- operation/commit SHA in structured result;
- no secret-bearing stderr/stdout;
- source refs for selected files and their verified hashes;
- task and conversation ID by existing scope.

Git push/fetch output is redacted for URLs/credentials before evidence storage.

### Source validity

- staging or normal commit/push does not change checked-out file contents, so it reports no source
  mutation;
- a commit/push must not invalidate unchanged file observations;
- only operations that truly change working-tree source content, such as future reset/checkout
  operations, may emit `git_operation` source events;
- ordinary commit/push never marks a file stale.

## 13. Authorization and workspace boundaries

The existing `git` tool and its typed operations run through `workspaceTools`, `WorkspaceTools.run`,
existing mutating-tool
serialization and access preflight.

The existing `OperationAuthorization`/`WriteAuthorization` mechanism is extended for typed Git
requests rather than bypassed:

```text
GitPrepareRequest
GitCommitRequest
GitPushRequest
```

The authorization object is host-issued, tied to the current access host and call, and spent by
the operation. It may cover:

- exact repository;
- exact commit operation ID;
- exact remote and branch for push;
- force=false;
- no destructive operation.

The model cannot forge authorization. The tool dispatcher rejects a commit/push with no matching
authorization.

The existing file access preflight applies to:

- alternate index scratch paths;
- repository paths outside an open workspace;
- remote credential key paths;
- hunk patch/snapshot scratch files.

Git operations in a repository package respect the existing workspace allowed/blocked roots.

### `run_command` coexistence

The existing public `git` tool remains, with legacy read-only `args` plus typed operations.

#### Known temporary security limitation

The existing `run_command` implementation is an unrestricted mutation-capable command surface.
Native Git integration must not claim that Git commit/push policies, identity attribution or
destructive-operation restrictions apply globally while this bypass exists.

Accepted temporary behavior:

- Moriarty can invoke `git` directly through `run_command` until the separate managed
  `run_command` redesign is implemented.
- Such shell Git operations do not pass through native Git identity, workflow or push
  authorization.
- Shell Git operations are not retroactively attributed to Moriarty and are treated as external
  repository operations for provenance.
- No shell-command interception or Git subcommand classification is implemented by native Git
  integration.
- The native Git interface enforces workflow, identity and authorization policies for every
  operation it exposes.

This limitation is not a reason to block native Git implementation. It is a documented boundary
between native Git operations and general shell capability. The planned `run_command` redesign,
scheduled after context management, is the only component that should address this boundary.

#### Reusable future authorization boundary

Future `run_command` integration must reuse, rather than duplicate, a host-owned `GitCapability`
boundary:

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

This boundary will make `run_command` dispatch Git mutations through the same identity, workflow,
credential and transaction service already used by native `git`. It is an integration contract for
future work, not a shell classifier or credential database for this stage.

## 14. Failure and denial result contract

Native tool failures use the existing `ToolResult.failed/error/observation` contract.

Examples:

### Missing email

```json
{
  "failed": true,
  "error": {
    "code": "git_identity_missing_email",
    "executed": false
  },
  "summary": "Commit refused: Moriarty Git email is missing",
  "output": "Set git.identity.email in .twinny/config.json or configure MORIARTY_GIT_EMAIL."
}
```

### Mixed ownership

```json
{
  "failed": true,
  "error": {
    "code": "git_mixed_ownership",
    "executed": false
  },
  "summary": "Commit refused: ownership is mixed",
  "output": "src/a.ts contains known human and Moriarty changes. Select hunks or choose an explicit authorship policy."
}
```

### Push rejected

```json
{
  "failed": true,
  "error": {
    "code": "git_push_non_fast_forward",
    "executed": true
  },
  "summary": "Push rejected: remote has advanced",
  "output": "No history was rewritten and no commit was recreated."
}
```

No credential value appears in these payloads.

## 15. UI and diagnostics

The existing settings UI may expose:

- active Git workflow preset;
- plain commit behavior;
- configured remote/branch;
- configured Moriarty email source (direct/env variable name, but not value);
- authentication mode;
- current commit/push authorization state;
- operation status and safe retry action.

The UI must not expose:

- the `git.identity.tagging` setting;
- credential values;
- private key content;
- credential helper output;
- HTTP extra headers;
- askpass answers.

The user may diagnose:

- missing Moriarty email;
- invalid project config;
- missing environment variable;
- no upstream or ambiguous destination;
- SSH/credential failure;
- denied commit/push;
- non-fast-forward rejection;
- interrupted/uncertain operation;
- mixed/unknown file ownership.

## 16. Security boundaries

- project configuration is read by the host, never freely interpreted as shell;
- env references store names, not values;
- Git commands use argument arrays, not one shell command string;
- alternate index patch files are private temp files removed after use;
- remote URLs are sanitized before display/evidence;
- Git process stderr is redacted before evidence storage;
- no credential database is added;
- no commit message contains evidence dumps;
- commit messages may contain compact task/operation references only when explicitly size-bounded;
- no model is included as a Git co-author;
- no secret appears in tool logs or diagnostic events.

## 17. Testing strategy

Tests use temporary repositories and local bare repositories. Normal automated tests require no
GitHub or GitLab network access.

Positive and negative tests include:

- existing legacy `git` argument parsing remains unchanged;
- existing read-only real-repository `git diff/status/log` behavior remains unchanged;
- existing read-only mutation refusals remain unchanged;
- existing hidden/ignored workspace path filtering remains unchanged;
- typed Git operations use the same `git(view)` dispatcher and repository boundary;
- clean and dirty session baselines;
- staged, unstaged and untracked changes;
- agent-authored and human-authored changes;
- mixed contributions;
- exact-file staging;
- hunk-level staging;
- human staged work plus agent unstaged work;
- concurrent edit during prepare;
- concurrent branch/head/remote change;
- clean initial tree with later external edit;
- automatic attribution enabled/disabled;
- missing/invalid email;
- direct and environment Moriarty email;
- inherited, dedicated and environment authentication;
- missing authentication environment variable;
- no credential values in logs/evidence/errors;
- commit success;
- commit response interruption;
- commit duplicate/retry;
- commit of existing work without Moriarty author;
- push success;
- push timeout/ambiguous state;
- push non-fast-forward;
- remote ref changed;
- no second commit after push failure;
- explicit no-commit/no-push;
- workflow mode restrictions;
- force/rebase/reset/amend denied;
- protected branch/remote override denied;
- context compaction and session restoration;
- multiple chat sessions;
- model change across continuation;
- no accidental staging of unrelated files;
- no source validity invalidation after ordinary commit/push.

Named standalone tests should live near existing standalone tests:

- `git-config.standalone.ts`
- `git-baseline.standalone.ts`
- `git-attribution.standalone.ts`
- `git-index-staging.standalone.ts`
- `git-transaction.standalone.ts`
- `git-push-recovery.standalone.ts`
- `git-tool-dispatch.standalone.ts`

Integration tests should invoke production `workspaceTools.run`, real authorization, real SQLite
project storage and real temporary Git repositories.
