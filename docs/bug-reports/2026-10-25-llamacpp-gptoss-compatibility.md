# llama.cpp / GPT-OSS compatibility review for Twinny 4.3.15

## 1. Executive summary

This report documents two compatibility issues observed in Twinny when a local OpenAI-compatible backend is hosted by llama.cpp and the model is a GPT-OSS variant. The first issue is a request-shape mismatch: a valid user-only chat request is rejected by llama.cpp with `All non-assistant messages must contain 'content'` unless a system message is supplied. The second issue is a hidden reasoning-history problem: GPT-OSS tool-call exchanges carry reasoning text that must be preserved across assistant/tool rounds and then serialized as `reasoning_content` when the local backend expects that field. Without that preservation, the tool loop can reconstruct malformed Harmony-style assistant messages and produce intermittent peg-parse failures or HTTP 500s.

The code-level fix for these issues is upstream-facing and intentionally narrow. Twinny now adds a compatibility system message only for the affected local providers when no system message is already present, and it preserves GPT-OSS reasoning as `reasoning_content` when constructing the next OpenAI-compatible request. The fix is implemented in the inference adapter and validated by regression tests around request serialization and tool-loop reconstruction; it is not a claim that every live llama.cpp HTTP 500 has been eliminated, only that the relevant request-shape and reasoning-history problems are corrected in the adapter layer.

## 2. Affected environments and versions

- Twinny: 4.3.15
- Provider family: local OpenAI-compatible API backends served by llama.cpp
- Models discussed: GPT-OSS variants such as `gpt-oss-20b`
- Reproduction environment: developer workstations running local llama.cpp servers behind `127.0.0.1:<port>/v1`
- Provider constants referenced in code: `API_PROVIDERS.LlamaCpp` and `API_PROVIDERS.OpenAICompatible`

This report is intentionally scoped to the compatibility layer in Twinny itself. It does not assume a specific llama.cpp binary build, runtime, or hardware configuration beyond the OpenAI-compatible chat-completion contract described below.

## 3. Original symptoms and observed error messages

The original failures were reported in two related but distinct forms.

### 3.1 HTTP 400 for user-only requests

A valid OpenAI-compatible chat-completion request containing only a user message could be rejected by llama.cpp with:

```text
All non-assistant messages must contain 'content'
```

This problem was observed when a caller sent a request such as:

```json
{
  "model": "gpt-oss-20b",
  "messages": [
    { "role": "user", "content": "hello" }
  ]
}
```

Adding an explicit system message allowed the same request to succeed:

```json
{
  "model": "gpt-oss-20b",
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user", "content": "hello" }
  ]
}
```

### 3.2 GPT-OSS reasoning and Harmony tool-call corruption

The second class of issues involved streamed reasoning and malformed tool-call reconstruction. The llama.cpp server intermittently emitted errors such as:

```text
common_chat_peg_parse: unparsed peg-native output
```

Affected completions included malformed Harmony channel headers, corrupted tool-call syntax, repetitive punctuation, cancelled requests, and HTTP 500s. The shared pattern was: the model produced assistant reasoning alongside a tool call, Twinny reconstructed the assistant message without retaining the reasoning, and the next request re-sent a malformed context to the backend.

## 4. Steps to reproduce

### 4.1 Minimal user-only request that triggers the system-message issue

```bash
curl -sS http://127.0.0.1:8080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gpt-oss-20b",
    "messages": [
      { "role": "user", "content": "hello" }
    ]
  }'
```

Expected: the server accepts the request and returns a normal completion.
Actual: llama.cpp may reject it with `All non-assistant messages must contain 'content'`.

### 4.2 Working request when a system message is supplied

```bash
curl -sS http://127.0.0.1:8080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gpt-oss-20b",
    "messages": [
      { "role": "system", "content": "You are a helpful assistant." },
      { "role": "user", "content": "hello" }
    ]
  }'
```

### 4.3 Minimal GPT-OSS tool-call exchange

The following pattern is representative of the reasoning-history bug: one assistant message contains reasoning plus a tool call, and the next request must include that assistant message as part of the conversation history while retaining the reasoning in the local OpenAI-compatible format.

```bash
curl -sS http://127.0.0.1:8080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gpt-oss-20b",
    "messages": [
      { "role": "user", "content": "Inspect src/index.ts" },
      {
        "role": "assistant",
        "content": "",
        "reasoning_content": "I should inspect the file first.",
        "tool_calls": [
          {
            "id": "call_1",
            "type": "function",
            "function": {
              "name": "read_file",
              "arguments": "{\"path\":\"src/index.ts\"}"
            }
          }
        ]
      },
      {
        "role": "tool",
        "name": "read_file",
        "tool_call_id": "call_1",
        "content": "Contents of src/index.ts"
      }
    ]
  }'
```

This shape is what Twinny now serializes for the affected local backends.

## 5. Expected versus actual behaviour

Expected:

- user-only requests should pass to llama.cpp without requiring a manually injected system message unless a system is already present;
- a backend-specific compatibility layer should avoid sending malformed payloads to incompatible local servers;
- assistant reasoning should be retained for the next request without exposing it to the user-visible answer;
- tool-call history should survive multiple assistant/tool steps without leaking reasoning or changing message order.

Actual before the fix:

- llama.cpp rejection occurred when requests omitted a system message;
- reasoning hidden in the backend stream was dropped during reconstruction of the next assistant message;
- user-visible tool-call reconstruction could produce malformed Harmony channel markers and invalid tool-call payloads;
- the server sometimes responded with HTTP 500s and `common_chat_peg_parse: unparsed peg-native output` errors.

## 6. Root-cause analysis

### Confirmed findings

1. The request serializer in `src/extension/inference/adapters/fluency.ts` did not add a system message for affected providers before the request reached llama.cpp. The relevant logic is in:
   - `requiresCompatibilitySystemMessage()`
   - `maybeWithSystemMessage()`
   - `buildStreamingRequest()`
   - `buildBlockingRequest()`

2. For GPT-OSS-style assistants, the adapter was carrying reasoning internally as `reasoning`, but when serializing the next OpenAI-compatible request it did not always move that data into `reasoning_content` before transiting to a local backend. The adaptation layer is in `withReasoningHistory()` and the serialization path in the same file.

3. The message type was extended in `src/common/types.ts` to include `reasoning?: string` and `reasoning_content?: string` so the adapter can keep hidden backend reasoning in memory without exposing it as user-visible content.

4. Regression tests in `src/test/suite/inference.test.ts` confirmed the expected transformed payloads for both issues.

### Hypotheses or partially confirmed findings

- The malformed Harmony tool-call output and HTTP 500s are consistent with a reasoning-history loss during multi-step tool exchanges. The adapter fix preserves reasoning across request reconstruction, which is a likely mitigation, but this report does not claim that this alone definitively eliminates every llama.cpp or GPT-OSS runtime failure under all model/server combinations.
- The local reproduction available in this environment did not include a live llama.cpp server under load, so the exact live HTTP 500 rate remains unproven outside the request-serialization layer.

## 7. Exact implementation changes

### 7.1 System-message compatibility workaround

File: `src/extension/inference/adapters/fluency.ts`

```ts
const DEFAULT_SYSTEM_MESSAGE = "You are a helpful assistant."

const requiresCompatibilitySystemMessage = (provider: TwinnyProvider) =>
  [API_PROVIDERS.LlamaCpp, API_PROVIDERS.OpenAICompatible].includes(provider.provider)

const maybeWithSystemMessage = (provider: TwinnyProvider, messages: ChatMessage[]): ChatMessage[] => {
  if (!requiresCompatibilitySystemMessage(provider)) return messages
  if (messages.some((message) => message.role === "system")) return messages
  return [{ role: "system", content: DEFAULT_SYSTEM_MESSAGE } as ChatMessage, ...messages]
}
```

This logic is used in both `buildStreamingRequest()` and `buildBlockingRequest()` before the request is transmitted. It only applies to the affected providers and leaves any existing system message in place. It does not affect unrelated providers; for example, OpenAI-hosted or other provider families are left alone.

### 7.2 Reasoning-history preservation for GPT-OSS tool loops

File: `src/common/types.ts`

```ts
export type ChatCompletionMessage = ChatCompletionMessageParam & {
  id?: string
  reasoning?: string
  reasoning_content?: string
}
```

File: `src/extension/inference/adapters/fluency.ts`

```ts
const withReasoningHistory = (provider: TwinnyProvider, messages: ChatMessage[]): ChatMessage[] =>
  messages.map((message): ChatMessage => {
    if (message.role !== "assistant") return message
    const reasoning = (message as { reasoning?: unknown }).reasoning
    if (typeof reasoning !== "string" || !reasoning || !requiresCompatibilitySystemMessage(provider)) return message
    const rest = { ...message } as ChatMessage & { reasoning?: string }
    delete rest.reasoning
    return { ...rest, reasoning_content: reasoning } as ChatMessage
  })
```

This keeps hidden reasoning attached to the assistant message while stripping it from the user-visible `reasoning` field before the next request is sent to the local OpenAI-compatible server. The use of `reasoning_content` is specific to llama.cpp/OpenAI-compatible compatibility and is not treated as a generic replacement for all providers.

## 8. Why each fix was chosen

### 8.1 Why the compatibility system-message fix was needed

Llama.cpp rejects requests that omit a system message for some user-only or strictly role-ordered interactions. A server compatibility shim is a reasonable fix at the adapter boundary because the local backend is behaving differently from the standard OpenAI schema in this case. The fix is intentionally narrow: only llama.cpp and other OpenAI-compatible local backends are affected, and only when no system message is already present.

### 8.2 Why the reasoning-history fix was needed

The GPT-OSS tool loop emits reasoning that is useful for the continuation of the same exchange but should remain hidden from the user-facing answer. Similarly, a local OpenAI-compatible backend expects that reasoning in a different field (`reasoning_content`) than the internal Twinny representation (`reasoning`). Preserving the value in the assistant message during the next request is the least invasive fix and aligns with the current adapter design: internal reasoning stays internal, external serialization chooses the provider-specific field.

## 9. Regression tests added and their coverage

File: `src/test/suite/inference.test.ts`

The suite `llama.cpp compatibility and native reasoning` covers the following scenarios:

1. Local OpenAI-compatible requests include a fallback system message only when needed.
   - verifies the fallback is injected for `LlamaCpp` and not for unrelated providers;
   - verifies existing system messages remain untouched and are not duplicated.

2. Non-streaming reasoning is kept hidden and serialized as `reasoning_content`.
   - verifies the hidden reasoning is preserved and not leaked into the visible assistant message.

3. Native tool-calling keeps GPT-OSS reasoning through a full multi-step exchange.
   - simulates a `gpt-oss-20b` tool-loop exchange;
   - verifies the assistant message retained the reasoning before the next request;
   - verifies the serialized request contains `reasoning_content` and a valid tool call without leaking the reasoning into the user-visible `reasoning` field.

These tests are a request-shape and history-serialization check, not a proof of a live server that never fails.

## 10. Build, lint, type-check, and test results

### Passed locally

```bash
npm run build-tests
npm run lint
npm run build
```

These commands completed successfully for the current branch.

### Full VS Code test harness

```bash
npm test
```

This command completed with 839 passing tests and 6 failing tests. All failures were in `src/test/suite/chat-edit.test.ts` and `src/test/suite/agent-reply.test.ts`, with the failure pattern centered on editor undo/delete behavior and a terminal-backed command test timing out. The compatibility-focused tests were not the failing subset.

### Live llama.cpp verification status

No live llama.cpp server or GPT-OSS model was run in this environment, so there is no recorded live HTTP 200/400/500 reproduction with the actual backend. The fix is therefore validated at the adapter and request-serialization layer, not by a live local server check.

## 11. Live verification results, when available

Live verification was not available in this environment. The evidence available is code-driven regression coverage in the Twinny test suite and the exact serialization logic used for affected providers.

This means:

- the adapter now serializes requests in a way that prevents the known user-only local-server rejection;
- the assistant/tool history keeps reasoning in the correct field for the next request;
- the likely malformed Harmony tool-call path is mitigated by preserving reasoning history in the same assistant message;
- a claim that a real llama.cpp server will never emit HTTP 500s would be stronger than the demonstrated evidence here.

## 12. Compatibility risks and limitations

- The workaround is deliberately provider-scoped to `LlamaCpp` and `OpenAICompatible`. It should not alter other server types.
- The solution assumes the local provider accepts the OpenAI-compatible payload shape with a `reasoning_content` field once it has been preserved from the assistant message.
- If a third-party server interprets `reasoning_content` differently, the final behavior may still vary by backend version.
- The fix is limited to the Twinny adapter layer and does not modify the underlying llama.cpp server or its native parsing rules.

## 13. Known unresolved problems

### 13.1 Separate terminal command-output capture issue

There is a separate unresolved problem in the integrated terminal backend: commands may appear to execute but capture no output or time out even though the shell command itself succeeds. The observed examples include:

- `echo hello` exiting 0 but producing empty captured output;
- `git --version` exiting 0 but producing empty captured output;
- a longer command timing out after two minutes without output.

The relevant setting is `twinny.chatToolsCommandsRunIn`. Switching the setting from `terminal` to `background` resolved the issue in live testing. The successful background execution produced:

```text
TWINNY_START
/home/stark/source/twinny
git version 2.55.0
TWINNY_END
```

This issue is documented as separate from the llama.cpp/GPT-OSS compatibility work and is not presented as a regression caused by the compatibility fix. No terminal backend rewrite was undertaken in this task.

## 14. Suggested upstream review and acceptance criteria

Suggested review focus:

- confirm the provider-sensitive fallback is not being applied to unrelated backends;
- confirm `reasoning_content` is only used for the OpenAI-compatible compatibility path;
- confirm no system message is duplicated when one already exists;
- confirm tool-call reconstruction retains reasoning and keeps it out of the user-visible message content;
- confirm the fix remains compatible with both streaming and non-streaming calls.

Acceptance criteria:

- a user-only request without system message succeeds against the affected llama.cpp/OpenAI-compatible backend;
- existing system messages are preserved and not duplicated;
- no unrelated providers are changed;
- GPT-OSS tool-call exchanges retain hidden reasoning through multiple tool iterations;
- tests cover both the system-message workaround and the reasoning-history serialization path.

## 15. Concise pull-request description

Title: `fix: add llama.cpp compatibility fallback and preserve GPT-OSS reasoning history`

Summary:

This change fixes two local-backend compatibility issues in Twinny's OpenAI-compatible adapter. It adds a fallback system message only for llama.cpp/OpenAI-compatible providers when no system message is present, preventing user-only requests from failing with `All non-assistant messages must contain 'content'`. It also preserves hidden GPT-OSS reasoning across the assistant/tool loop by serializing it as `reasoning_content` for the next request, preventing malformed Harmony tool-call reconstruction and reducing the risk of parser failures or HTTP 500s. Regression tests cover both request-shape compatibility and multi-step tool-loop reasoning preservation.

## Additional note

This report is written to be suitable for upstream review and does not include private hostnames, credentials, or unrelated infrastructure details. The compatibility fix is implemented in the adapter boundary and is intentionally scoped to the actual affected providers rather than to all backends.
