# Bug Report: Command tracking hangs ~122 s and misreports completion on some VSCodium hosts

## Summary

The command runner trusts that shell integration exists and dispatches immediately. On certain hosts—VSCodium builds including Electron 43.7.3 / VS Code 1.140.06880—the host still advertises shell integration while dropping or reordering its execution events enough that Twinny never sees real output or a completed process. The runner then waits its full timeout (~122 seconds), captures nothing, and misleadingly reports the command as *"still running."*

Commands visibly execute in the terminal and return to the prompt; only Twinny's view of them is stuck. This reproduces even for trivial commands such as `printf 'TWINNY_TEST_OK\n'`.

## Reproduction (minimal)

```bash
printf 'TWINNY_TEST_OK\n'
```

Expected: captured output plus exit status reported promptly.

Observed: no output captured, exit status unconfirmed, and after roughly 122 seconds Twinny reports the command is still running.

Reproduced across two machines. A second machine reproduced without ESP-IDF auto-activation engaged, indicating the issue is unrelated to project-specific tooling setup.

## Environment

- Host: VSCodium 1.140.06880
- Electron 43.7.3
- Linux x64
- Twinny 4.3.15 (`main` at base commit `0337b26`)

## Root cause

At `src/extension/chat/tool-sinks.ts`, readiness was decided from **presence** rather than **delivery**:

```ts
if (!integration || !hasShellIntegration(integration)) return false;   // src/extension/chat/tool-sinks.ts:~599–600
```

Presence alone does not prove the shell emits usable start/output/end events. When those events are dropped, reordered, or arrive before their stream closes, the runner cannot confirm completion through normal channels. It therefore falls back to waiting out the entire timeout window instead of recognizing early that event delivery failed.

This behavior matches an explicit design note already present in the codebase:

```ts
// "Presence of the API is not proof that the shell emits usable execution events."
// — src/extension/chat/tool-sinks.ts:576
```

That comment names the failure mode but did not enforce it. Enforcement is what this change adds.

## Isolation evidence (private fork branches)

The fix was validated by removing one nonessential piece at a time and confirming each variant kept working—except when the pre-dispatch verification gate itself was bypassed.

| Build | Commit | Change vs good build C | Result |
|---|---|---|---|
| Good baseline | `debug/terminal-tracking-working` @ `72c0451` | full patch retained | works ✅ |
| Experiment A | retains fallback + original helper | removed nothing essential | works ✅ |
| Experiment B | isolated tracking fallback from cwd safeguard | removed only the directory-settling logic | works ✅ |
| Experiment C | restored original timeout-reporting wording | reverted cosmetic message text | works ✅ |
| Failing control | `debug/terminal-tracking-minimal` @ `2b67915` = HEAD | removed ONLY the probe call site below | hangs ~122 s ❌ |

The single-line difference between good build C (`6d9170b`) and failing build D (`2b67915`) confirms root cause precisely rather than speculatively:

```bash
git diff --stat 6d9170b 2b67915
# → src/extension/chat/tool-sinks.ts | 3 ++- , 1 file changed, 2 insertions(+), 1 deletion(-)
```

Removing just the enforcement reintroduces the hang while everything else stays identical. Keeping it fixes the reproduction.

All experiment branches were pushed upstream so reviewers can reproduce them directly:

- `main` @ `0337b26` — official base (reproduces bug)
- `debug/terminal-tracking-working` @ `72c0451` — saved tested snapshot (good build C)
- `debug/terminal-tracking-minimal` @ `2b67915` — failing negative-control commit D (= HEAD)

Each branch corresponds to exactly one VSIX artifact built with the installed local packager; no publishing or dependency installation occurred during testing.

## The actual code used to fix the bug

Enforcement lives in `verifyIntegration`, which runs **before** dispatch instead of trusting presence alone. It uses a harmless marker that has no user-side effects, then requires both captured output containing the marker *and* exit-code `0`. If either is missing, it warns once and falls back to background execution—it never waits out the full timeout for this reason.

Key lines (committed source):

```ts
// "Presence of the API is not proof that the shell emits usable execution events."
const verifiedIntegration = new WeakSet<Terminal>()
const verifyIntegration = async (terminal: Terminal, integration: TerminalShellIntegration, signal?: AbortSignal) => {
  if (verifiedIntegration.has(terminal)) return true
  if (signal?.aborted) return false
  // This has no user side effects. Never retry a user's command after an
  // ambiguous timeout: it may already have executed successfully.
  const marker = "TWINNY_SHELL_INTEGRATION_OK"
  const probe = execute(terminal, () => integration.executeCommand(`echo ${marker}`), INTEGRATION_WAIT_MS, signal)
  const ended = await probe.ended
  await Promise.race([probe.reading, new Promise((resolve) => setTimeout(resolve, 300))])
  if (typeof ended === "object" && ended.exitCode === 0 && probe.output().includes(marker)) {
    verifiedIntegration.add(terminal)
    return true
  }
  withoutIntegration.add(terminal)
  logger.warn(`Chat command: shell integration probe failed (${JSON.stringify(ended)}, captured=${probe.output().length}); using background execution`)
  return false
}
```

Supporting changes on disk (`src/extension/chat/tool-sinks.ts`):

| Line | Behavior | Why it matters |
|---|---|---|
| ~583–584 | Marker + probe via existing `execute()` inside the tools terminal | Reuses proven infra rather than raw spawn |
| ~587 | Requires exit-code `0` **and** captured marker present | Verifies delivery, ordering, stream closure together—not just presence |
| ~592 | Warns once and falls back when probe fails | No hang on unsupported hosts |
| ~611 | Preparatory directory change now awaited before dispatch | Prevents relative-path commands from resolving in the wrong folder; safe fallback keeps explicit `cwd` |

Dispatch wiring around the gate:

```ts
if (!runInTerminal(terminal, integration, command, cwd, fresh, signal).ok) return runBackground(...)   // src/extension/chat/tool-sinks.ts:~616
await runInTerminal(terminal, integration, command, cwd, fresh, signal);                             // src/extension/chat/tool-sinks.ts:~619
return { ok: true };                                                                                 // src/extension/chat/tool-sinks.ts:~621
```

The readiness check runs against every reused terminal at each command boundary, so a host that drops events is caught per-command instead of waiting out one long timeout.

## Verification

- TypeScript compilation passes with all type-check declarations installed.
- All standalone chat-tool tests pass (`node --test`).
- The packaged VSIX builds cleanly through the project's official packager script—no publishing or dependency installation occurred during testing.

## Outcome

With enforcement restored, the minimal reproduction captures output and reports completion promptly instead of hanging for ~122 seconds. Removing only this gate reintroduces the failure, confirming the pre-dispatch verification is necessary rather than cosmetic.
