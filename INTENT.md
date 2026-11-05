# Twinny Intent Compiler: Architectural Design Contract

> **Current behavior (supersedes the execution flow below).** The Intent system is now two independent capabilities:
>
> - **Feedback** (`twinny.feedback.enabled`, `.provider`, `.model`) plans TODOs from each ordinary agent request, tracks progress through the tool loop, and evaluates completion. It does not depend on prompt compilation.
> - **Prompt Compiler** (`twinny.promptCompiler.enabled`, `.provider`, `.model`, `.maxTurns`, `.trace`, `.baseInstructionsMode`, `.baseInstructionsFile`) is a capability toggle. It runs only when the user Ctrl+Clicks Send (Command+Click on macOS), replaces the composer draft with the compiled prompt, and never sends it. A plain Send always submits the draft unchanged, and there is no review dialog.
>
> Both roles default to the provider selected as **Feedback** (formerly "Intent") in the providers panel. A `*.provider` setting can name another provider by ID or label. If that provider is missing, Twinny reports an error and does not fall back. Legacy `twinny.chatToolsIntentCompiler*`, `twinny.chatToolsFeedbackEvaluatorEnabled` and `twinny.intentBaseInstructions*` values are migrated to the new keys. `twinny.chatToolsIntentCompilerMode` is retired and ignored, so no setting can make compilation automatic.

**Status:** Design reference and acceptance contract  
**Scope:** Independent Intent Compiler provider role, its configuration and resolution, team integration, discovery, execution, and regression tests.  
**Principle:** **Intent is a first-class provider role, not another name for Chat.**

## 1. Why this exists

Twinny supports a two-stage workflow:

1. An **Intent Compiler** interprets the current user request in context and, where appropriate, produces a refined execution prompt.
2. A **Chat/Execution** provider performs the actual requested work using that prompt (or the original prompt when compilation is bypassed).

These stages have different responsibilities and **must be independently configurable**. Intent may use the same model-server *protocol* as Chat, including an OpenAI-compatible chat-completions endpoint, without sharing Chat's *provider role, active selection, configuration, or lifecycle*.

This is an architectural rule, not a UI convention or a request to add another chat provider under a different label.

## 2. Conceptual flow

```text
User request + bounded prior conversation history
                        |
                        v
              Intent policy gate
          (enabled? compile requested?)
                 /              \
              yes                no
               |                  |
               v                  |
    resolve ACTIVE INTENT          |
    provider (role = intent)       |
        /             \            |
     found          missing        |
       |               |           |
       v               |           |
  compile request      |           |
       |               |           |
  validate result      |           |
    /       \           |           |
 valid    failure       |           |
   |         |          |           |
   v         +----------+-----------+
refined prompt                    original prompt
   |                                  |
   +----------------+-----------------+
                    |
                    v
          resolve ACTIVE CHAT
          provider (role = chat)
                    |
                    v
         execution / tool loop
                    |
                    v
              user response
```

A compiler failure must **not** turn into a silent second Chat-provider call masquerading as compilation. Execution continues with the original request under the product's existing failure and cancellation rules.

## 3. Separate role from transport

These are distinct dimensions:

| Dimension | Intent | Chat |
| --- | --- | --- |
| **Provider role** (`type`) | `intent` | `chat` |
| **Active provider selection** | Independently persisted | Independently persisted |
| **Provider record ID** | Own ID | Own ID |
| **Hostname, port, protocol, path, model, key** | Own configuration | Own configuration |
| **Job** | Understand/refine current user request | Execute user request and tool loop |
| **Inference transport** | May use chat-completions adapter | May use chat-completions adapter |
| **Model / physical server** | Chosen explicitly | Chosen explicitly |

A user **may explicitly choose the same model/server** for both roles. That does not make the roles interchangeable, and it must never happen because code silently copies `chat` into `intent`.

**Non-negotiable invariants:**

1. A configured Intent provider persists with `type: "intent"`, never `type: "chat"` as a substitute.
2. `getActive("intent")` and `getActive("chat")` resolve separate stored selections. Changing or removing either must not silently change the other.
3. `resolve("intent")` must never fall back to `resolve("chat")` or synthesize an Intent provider from the active Chat provider.
4. The same UI component, validation rules, registry of server adapters, or transport code can be reused; **role identity cannot**.
5. Provider identity must remain distinct even if a model ID, endpoint, or team alias is the same.
6. An absent or unavailable Intent provider means **skip compilation and use the original user request**, with useful diagnostics. Do not implicitly use Chat as compiler.
7. A selected Chat/Execution provider is not modified by running the compiler or applying the compiler result.

## 4. Configuration and selection

Use the established Twinny provider configuration UX and `TwinnyProvider` shape. Do not create a competing settings system.

- `intent` is a selectable role alongside `chat`, `fim`, and `embedding`.
- Intent has its own model name, endpoint fields, credentials, provider ID, and active-provider persistence. Reusing the shared configuration form is expected.
- Chat and Intent choices remain independent across restarts, manual edits, discovery, importing/exporting settings, and team connect/disconnect.
- An enabled Intent Compiler with **no selected Intent provider** must be handled as an explicit *not configured* case, not interpreted as permission to reuse Chat.
- Preserve existing Intent selections during migration. Do not overwrite an intentional selection with a newly discovered Chat model.
- Provider labels should distinguish the roles (for example `Ollama` and `Ollama Intent`) even when both use the same adapter/server.
- Keep existing user-facing switches such as compile-disabled and always-use-original behavior. Their settings should be honored before attempting compiler inference.

### Role-to-capability mapping

`intent` is a **job/role** that generally needs a **chat-capable model/transport**. It is not necessary to invent an `/intent` HTTP endpoint or a new adapter just because the stored provider role is named `intent`.

At the capability/adapter boundary, map `intent` to the required conversational inference capability **without** rewriting the role or looking up the Chat selection. Validate the actual selected Intent model's conversational capability. Keep any provider-specific endpoint conventions intact.

## 5. Discovery and first-run bootstrap

The existing source inspection showed `src/common/provider-discovery.ts` iterating `PROVIDER_TYPES`, calling `pickModelStrict(server.models, type)`, and constructing one record for each supported role. This can produce both `chat` and `intent` records with the same discovered model name.

That can be legitimate as **two separate candidate configurations**, but discovery and activation are different operations:

- Discovery may **offer** a dedicated Intent candidate with its own ID and `type: "intent"`.
- Do **not** auto-activate Intent merely because Chat was discovered, selected, imported, or made active.
- If the current `addAll` or first-run code couples creation with activation, separate those concerns or gate Intent activation behind an explicit user choice. Preserve existing first-run behavior for unrelated roles.
- Reuse `pickModelStrict`'s chat-capability heuristic for finding a *candidate* only if that is appropriate; do not treat the heuristic as an instruction to select Chat's exact provider.
- Add coverage for both identical and different underlying Chat/Intent models, separate IDs, labels, and activation state.

**Compatibility:** Do not break existing installations with no Intent provider; they must still be able to chat normally.

## 6. Team / remote gateway semantics

The current team test fixture has:

```ts
// Team protocol fixture: there is deliberately NO Intent default.
defaults: { chat: "coder", fim: "coder", embeddings: "embed" }
```

Yet the observed preview produces an extra `coder` assignment. This is a **suspected fallback/coupling bug**, not a test expectation to bless automatically.

Required behavior:

1. A team advertisement that lacks an explicit Intent default **must not** create, activate, or replace an Intent provider by copying `defaults.chat`.
2. When joining such a team, preserve any pre-existing personal Intent selection; otherwise leave Intent unset. Do not count a synthesized Intent connection as a successful team role.
3. If a team explicitly advertises an Intent default, it may configure an **independent** Intent role after the normal preview and replacement/consent safeguards.
4. Extend the team default schema with an **optional** `intent` entry only where required. Older payloads without it must remain valid. Avoid a protocol version bump or breaking wire change unless strictly necessary and justified.
5. A remote alias chosen explicitly for Intent can be the same alias as Chat, but **both assignments must be explicit and independently stored**.
6. The gateway may expose a chat-capable alias/route to serve Intent compilation. Distinguish the *client's role selection* from the *remote transport capability*. Don't require a new gateway HTTP route simply to create a new provider role.
7. Preserve existing team secret storage, identity, preview, consent, rollback, reconnection, and active-personal-provider protections. Never expose keys in previews or logs.
8. Disconnecting/leaving a team must restore previous personal selections according to existing semantics, including Intent if the team explicitly changed it.

**Naming note:** The local provider role is `embedding`, while the observed remote team default key is `embeddings`. Preserve that established mapping. Use an explicitly documented `intent` key for the optional Intent default.

## 7. Intent execution contract

### Compiler input

- Address the **currently selected Intent provider** and no other provider for the compiler request.
- Include the current user request and only the bounded prior context that the established compiler implementation needs.
- Previous prompt/response pairs are **historical context**, not instructions that override the current request and not standing policy for the new task.
- Preserve the existing structured compiler output/validation format and current prompt-authority rules rather than rewriting the compiler prompt unnecessarily.
- Compilation must not invoke agent tools, edit files, or execute terminal commands. Those belong to the execution stage.

### Compiler result

- Valid refinement: send the **refined execution prompt** to the independently selected Chat/Execution provider.
- Skipped/disabled/always-original, missing Intent selection, invalid compiler output, compiler provider error, or compilation timeout: do not invent a replacement. Follow existing cancellation/error semantics and, when safe to proceed, use the **original request**.
- Prior user restrictions can be quoted as history for understanding but cannot become new standing task rules merely because the compiler saw them.
- Do not accidentally append a second assistant turn, rewrite the original history, or double-send the current prompt when moving from compiler to execution.
- Preserve normal execution tool calling and the chosen Chat provider's own stream behavior.

### Observability

When developer diagnostics are enabled, distinguish:

```text
intent.role=intent   intent.providerId=<redacted-or-safe-id>   intent.model=<model>
intent.outcome=refined | skipped | fallback | error
chat.role=chat       chat.providerId=<redacted-or-safe-id>     chat.model=<model>
```

Use existing logging/trace facilities, redaction, and opt-in controls. Do **not** introduce default raw prompt or credential logging. The existing optional compiler-request trace is useful for verifying the request body, but should remain opt-in.

## 8. Code review map (verify actual current implementation)

The source snippets and test logs suggest these starting points; **inspect the actual repository**, because names and contracts may have changed:

- `src/common/provider-validation.ts`: `ProviderType`, `PROVIDER_TYPES`, per-role validation and endpoint defaults.
- `src/common/model-pick.ts`: model capability matching and discovery heuristics.
- `src/common/provider-discovery.ts`: `providersForServer`, `labelFor`, candidate creation.
- `src/extension/providers/discovery.ts`: discovery application and activation behavior.
- `src/extension/providers/store.ts`: active-provider storage and role mapping.
- `src/extension/providers/team.ts`: team default-to-role mapping, preview/apply/disconnect.
- `src/common/team.ts`, protocol types and wire parsing: optional remote default and backward compatibility.
- Intent Compiler service and call sites (locate them with `rg`): provider resolution, compile request, fallback, execution handoff, trace.
- Shared provider UI and inference adapters: role display, chat-compatible transport, capability checks.

**Do not infer that a role is independent merely because `ProviderType` contains `"intent"`.** Follow the full chain from active selection to actual request dispatch.

## 9. Required regression tests

Tests must enforce behavior, not merely reflect observed counts.

### Configuration / identity

- Chat and Intent can reference **different endpoints/models** and the correct distinct provider is used at each stage.
- Independently changing Chat does not change Intent, and independently changing Intent does not change Chat.
- Same underlying model/server is allowed **only as independently configured records**; IDs/role selections remain independent.
- Missing or deleted Intent provider does not resolve to Chat.
- Persistence and restart retain the separate active selections.

### Discovery

- Discovery can identify a chat-capable model as a **candidate** for Intent while retaining `type: "intent"`, separate ID, and unambiguous label.
- Chat discovery/auto-activation does **not** silently activate Intent.
- Discovery does not invent a candidate without a suitable model.

### Team connection

- Existing team fixture with `{ chat, fim, embeddings }` and **no `intent`** does not synthesize an Intent alias/provider/activation.
- Missing Intent default leaves an existing personal Intent active and unchanged.
- Explicit Intent default configures an independent role with the ordinary preview, consent, secret storage, and rollback protections.
- Reconnect with the same explicit configuration does not duplicate entries.
- Old team protocol payloads remain accepted.

### Compiler / execution

- When enabled and configured: **one request to Intent**, then **one request to Chat**, using each independently selected provider/endpoint and the appropriate original/refined prompt.
- Disabled, always-original, and missing-Intent cases do not issue a compiler inference request.
- Malformed compiler response / provider unavailable follows the documented original-request fallback and produces diagnostic status.
- Historical prompt/response context remains context only; preserve the current compiler prompt wording and tests for it.
- Compiler does not call execution tools; Chat tool loop remains functional.

### Testing discipline

- Run relevant focused tests, TypeScript build, and ESLint; then run the full suite and report unrelated failures separately.
- Do **not** fix tests by changing assertions to accept a silently inherited Chat provider.
- The observed VS Code `workspace.applyEdit()` delete/undo failures, earlier exact-match `edit_file` failure, and terminal timeout are **separate issues**. Do not weaken file safety or sweep them into this provider refactor.
- Tests running under a Node inspector may encounter the known `Missing dataLength in event` instrumentation failure. Compare results with an ordinary non-debugger test run rather than masking application errors.

## 10. Acceptance criteria / definition of done

This change is complete only when:

1. A user can explicitly configure and select **Intent Provider A** and **Chat Provider B** with different models and/or endpoints.
2. A real request demonstrates the compiler is sent to **A**, and the resulting execution is sent to **B**, with no hidden substitution.
3. Removing A, disabling compilation, or receiving unusable compilation output never sends a compiler request to B; the established original-prompt path is preserved.
4. A legacy team advertisement without `defaults.intent` does not invent an Intent role, change an existing Intent selection, or increase connected-role counts by silently copying Chat.
5. An explicit team Intent assignment works without breaking backward compatibility or secret handling.
6. Discovery supports separate role identity without unwanted auto-activation.
7. Focused regression tests enforce the above and pass; build and lint pass; remaining unrelated full-suite failures are itemized rather than suppressed.
8. The implementation report names the root causes, changed files, tests run, results, and manual proof of two independently routed stages.

**Final architectural test:** If removing the currently selected Chat provider also makes the configured Intent provider disappear or change, or vice versa, the separation is still broken. If the compiler quietly uses Chat when Intent is unset, the separation is still broken.
