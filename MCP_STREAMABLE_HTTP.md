# Twinny: MCP Streamable HTTP Transport

**Status:** Implementation specification  
**Feature branch:** `feature/mcp-streamable-http` (use the branch already created by the developer; do not rename or recreate it)  
**Scope:** MCP client transport refactor, HTTP server configuration, settings UI, tests, diagnostics, documentation  
**Out of scope:** Redesigning Intent, modifying model provider inference, inventing a new MCP protocol, implementing an MCP server

## 1. Objective

Allow Twinny to connect to **MCP servers using Streamable HTTP**, whether the endpoint is on the same machine, elsewhere on the LAN, or operated by an external provider. A server configured with `type: "http"` uses the HTTP transport; a server with `type: "stdio"` uses the existing subprocess transport. Older STDIO entries that omit `type` must continue working unchanged.

**Keep Intent completely independent of the transport.** The existing Intent Compiler must remain selectable/configurable as it is today. Its refined prompt is passed to the Executor through the existing flow. The Executor's MCP tool discovery and calls then use the configured MCP server transport transparently. Do not reinterpret Intent as an MCP service or add an `/intent` endpoint.

This feature is a **client** implementation. It does not expose a Twinny HTTP server and must not rewrite the model API transport.

## 2. Protocol and SDK compatibility

The target is **MCP Streamable HTTP**, **not** the older deprecated standalone HTTP+SSE transport (unless legacy fallback is deliberately added and tested as a distinct capability).

As of October 2026, major relevant revisions include:

- **2025-03-26 through 2025-11-25:** Streamable HTTP with a session-capable `initialize` lifecycle, optional session IDs, and optional server GET SSE streams.
- **2026-07-28:** A different, stateless protocol era. Every operation uses a self-describing POST; no protocol-level `Mcp-Session-Id`, no GET stream, and no mandatory `initialize` handshake. Servers can be discovered through `server/discover`. HTTP responses can be ordinary JSON or request-scoped SSE streams; additional headers and per-request metadata apply.

**Implementation rule:** First inspect Twinny's installed MCP packages, versions, API surfaces, and existing transport code. Prefer the official MCP TypeScript SDK's HTTP client transport and its supported version negotiation. Do **not** hand-code JSON-RPC framing, SSE parsing, the handshake, session IDs, headers, reconnection, or negotiation if the installed SDK already implements those correctly. If an SDK update is needed, justify it, choose a compatible supported version, and validate the dependency/build impact rather than applying an unrelated broad migration.

Never assume every server implements the newest revision. Verify which revisions the selected SDK actually supports, document the compatibility policy, and test at least one real compatible local HTTP MCP server. If the installed SDK cannot support the latest version without a substantial migration, keep the initial feature honest and functional with its supported versions; don't claim 2026-era support that wasn't tested.

References:

- Current transport specification: https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
- Previous revision for interoperability: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- Official TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk
- SDK client connection documentation: https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/clients/connect.md

## 3. Architectural requirement: extract STDIO before adding HTTP

**Inspect the repository first.** The following is a *logical layout*, not a claim that Twinny currently has these exact files. Determine the current MCP manager path and place the new files under its existing MCP source area. Preserve existing exports, callers, public behavior, configuration conventions, and test hooks.

Suggested shape:

```text
<existing MCP source location>/
  <existing manager/facade>.ts     # Retains public API; delegates by server type
  mcp/
    stdio.ts                       # ALL existing STDIO-only implementation
    http.ts                        # NEW Streamable HTTP implementation
    types.ts                       # Shared contract/config, if useful
    [optional: factory.ts]         # Type-based adapter selection, if useful
```

If the existing manager already lives in an `mcp/` directory, avoid creating `mcp/mcp/`. Instead, use sibling files such as `mcp/stdio.ts`, `mcp/http.ts`, and retain its manager as the facade. The requested outcome is **one MCP subfolder with separate STDIO and HTTP files**, not a rigid directory spelling.

### 3.1 STDIO extraction

- Move subprocess creation, command/args/env processing, STDIO transport construction, process lifecycle, stderr handling, and STDIO-specific reconnection/cleanup into `mcp/stdio.ts`.
- Preserve current command execution behavior, environment merging, default handling, tool discovery, error reporting, and user-facing connection status.
- The existing manager/facade should forward STDIO connection and lifecycle operations to the extracted module instead of retaining duplicated STDIO logic.
- **No functional STDIO changes** should be required merely to add HTTP. Where the current implementation has known behavior or tests, preserve them.
- The original manager should continue to present the same MCP tools and responses to the agent. Do not force Chat, Intent, UI, or tool dispatch consumers to import the new transport files.

### 3.2 HTTP module

- Put HTTP-specific endpoint construction, SDK transport creation, initialization/version negotiation, authentication-header wiring, connection lifecycle, timeout/cancellation, and stream response handling in `mcp/http.ts`.
- Connect to the **full user-configured MCP endpoint URL**, including path and query when valid. **Do not assume `/mcp` is always the path** or silently append it.
- Support multiple independently configured servers, including simultaneous STDIO and HTTP servers.
- Support server tools being discovered and invoked using the **same downstream registry, name-resolution strategy, approval flow, and result mapping** as STDIO tools. Preserve current collision rules or explicitly document any required change.
- Request-scoped SSE notifications/progress should be processed using SDK mechanisms and surfaced through existing progress/status conventions when practical; intermediate progress must not be mistaken for final JSON-RPC tool results.
- Support both a single JSON response and a streamed SSE response for tool calls when the negotiated protocol permits. Honor abort/disposal and do not strand background streams when an agent turn is cancelled, server settings change, or extension deactivates.
- A network failure in one MCP server must not tear down unrelated MCP servers or break Intent compilation.

### 3.3 Shared boundary

The manager/facade owns configuration lookup, per-server identity, registry integration, connection status and forwarding. The adapters own only **transport-specific** details. Use the repository's established MCP client abstractions if already present; do not introduce an unnecessary second MCP stack or a second independent tool registry.

Conceptually:

```ts
// Illustrative only. Match the repository's existing types and API.
type McpTransportType = 'stdio' | 'http';

type McpServerConfig =
  | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string> /* non-secret */ };

function resolveTransportType(server: McpServerConfig): McpTransportType {
  return server.type === 'http' ? 'http' : 'stdio';
}
```

Use a discriminated union in actual TypeScript after inspecting the existing configuration format. Reject *unknown explicit types* with a helpful validation error; don't silently treat `type: "htp"` as STDIO. The default to STDIO applies only when `type` is omitted on a legacy entry.

## 4. Settings and configuration

### 4.1 New type selection

Add **HTTP** to the MCP server type selector/configuration. The stored value must be exactly **`"http"`**. Preserve **STDIO** with stored value **`"stdio"`**, and interpret legacy records without `type` as STDIO.

When `http` is selected:

- Show an **Endpoint URL** field (required) instead of STDIO command/args fields.
- Optionally expose authentication and headers through the application's established secure credential/settings mechanisms.
- Validate protocol and URL shape. Accept loopback, private LAN, hostnames, and remote provider endpoints; do not impose arbitrary host/domain allowlists. Support `http://` and `https://`. Warn appropriately if credentials would be transmitted over plaintext HTTP, but allow legitimate local/LAN use under explicit user control.
- Show connection status and actionable errors, without revealing tokens.
- Updating a server type or URL must cleanly dispose the old adapter, refresh registered tools, and connect through the selected new adapter.

When `stdio` is selected, keep the existing command, arguments, and environment experience unchanged.

If Twinny supports both editing settings as JSON and through a GUI, support **both**. Do not silently discard HTTP entries during serialization, migration, validation, save/reload, or settings synchronization.

### 4.2 Example configuration

Adapt the following to Twinny's **existing MCP settings structure** rather than inventing a replacement root key:

```json
{
  "local-tools": {
    "type": "stdio",
    "command": "node",
    "args": ["./tools/server.js"]
  },
  "localhost-http": {
    "type": "http",
    "url": "http://127.0.0.1:3000/mcp"
  },
  "lan-http": {
    "type": "http",
    "url": "http://192.168.3.50:3100/mcp"
  },
  "remote-provider": {
    "type": "http",
    "url": "https://tools.example.net/mcp"
  }
}
```

Addresses and domains are illustrative. For servers requiring authentication, support the SDK's compatible authentication hooks or securely referenced credentials. If OAuth requires extra UI and cannot be completed in this increment, report it explicitly as an unsupported auth flow rather than implying that all provider-hosted MCP servers work without authorization.

**Credential rule:** avoid plaintext secrets in logs, telemetry, command echo, URLs, debug dumps, or exported settings. Prefer VS Code `SecretStorage` or the project's existing secret store for tokens and refer to them by stable key. Non-secret headers can remain in normal settings. Do not disable TLS certificate checks to make a remote server work.

## 5. Behavior through Intent and the Executor

Intent is a **model-provider capability**, not an MCP transport mode:

```text
User request
     |
Intent compiler (existing provider selection + max-step controls)
     |
Refined / accepted task
     |
Existing Executor + MCP registry
     |
MCP manager / facade
   +-------------+----------------+
   |                              |
STDIO adapter                  HTTP adapter
   |                              |
Local subprocess            POST + JSON / SSE
   |                              |
Local MCP server            Local / LAN / remote MCP server
```

Requirements:

- Do not modify Intent provider type, model selection, max steps, state management, or prompt handoff merely to add HTTP.
- Intent **on** and **off** must both work with STDIO and HTTP tools. A failed HTTP endpoint must not prevent the Intent provider from running.
- The tool discovery and call path should not care whether the tool came from STDIO or HTTP, apart from displaying accurate server identity and transport-specific diagnostics.
- Preserve any existing read-only/approval boundaries. HTTP tools are **not** more trusted because their server is local, and local tools are **not** less trusted because they communicate over HTTP.

## 6. Errors, cancellation, and lifecycle

Handle and report clearly, at the appropriate existing UI/log layer:

- Bad or missing URL, DNS failure, connection refused, timeout, TLS/auth failure, unreachable LAN host.
- HTTP status errors including 401, 403, 404, 429, 5xx, malformed content type, malformed JSON/RPC, interrupted SSE stream.
- Protocol incompatibility and version negotiation failure, with a useful server-specific error rather than a misleading generic tool failure.
- Tool-not-found or duplicate tool names and stale registry entries after disconnect/reconnect.
- Server restart and explicit disconnect, user cancellation, extension shutdown, and configuration edits while a request is in flight.

Reuse established retry policy if present. Do not introduce unbounded automatic retries, duplicate irreversible calls, or retry POST tool invocations after ambiguous outcomes unless the application can establish they are safe to repeat. For transient connectivity loss, recovery should be bounded and observable.

Use request correlation and structured server identity in debug logs, with secrets redacted. Preserve enough logging to distinguish **model-issued invalid tool arguments** from **transport failure** and **server-side tool error**.

## 7. Implementation phases

**Phase A: inspect and baseline**

1. Find all current MCP manager, STDIO transport, server config/schema, UI settings, registry/dispatcher, tests, and installed SDK dependency paths.
2. Record current public exports and STDIO behavior, and run the relevant baseline tests/build.
3. Identify actual supported MCP protocol versions from the installed SDK, and whether a compatible SDK change is warranted.

**Phase B: extract STDIO, no behavior change**

1. Create `mcp/stdio.ts` under the appropriate existing source folder.
2. Move STDIO-specific code there, preserving behavior and tests.
3. Turn existing connection manager into a thin routing facade, keeping upstream callers unchanged.
4. Build/test **before** adding HTTP. Make the refactor independently reviewable where practical.

**Phase C: add HTTP**

1. Add `mcp/http.ts` using the supported official SDK Streamable HTTP client transport.
2. Add `type: 'http'` config, validation, and transport selection; legacy no-type entries remain STDIO.
3. Connect HTTP clients to the same registry/dispatcher, status, and result handling.
4. Add network error/cancellation handling, SDK-supported streaming behavior, and cleanup.

**Phase D: settings and user documentation**

1. Add/modify the existing MCP settings UI type selector and conditional fields.
2. Ensure JSON settings and UI settings round-trip without losing HTTP data.
3. Document sample local/LAN/provider configurations, supported versions, known auth limitations, and migration/rollback.

**Phase E: run integration tests**

Test both the extracted STDIO path and HTTP path. Capture the test/build outputs and identify any failures that predate the branch.

## 8. Acceptance test matrix

| Scenario | Expected behavior |
| --- | --- |
| Existing server config has no `type` | Runs as STDIO with unchanged behavior |
| Explicit `type: 'stdio'` | Runs as STDIO with unchanged command/args/env behavior |
| Explicit `type: 'http'` + loopback URL | Connects, lists tools, invokes tool, receives final result |
| HTTP server on LAN / hostname | No artificial localhost-only restriction; uses configured URL |
| External HTTPS MCP server | Connects when endpoint and compatible authentication are valid |
| HTTP JSON response | Correctly resolves tool call and maps result into existing registry |
| HTTP request-scoped SSE response | Handles progress separately, resolves on final result |
| Current and supported older protocol eras | Version negotiation works within claimed SDK support; otherwise actionable incompatibility |
| Unknown `type` | Validation error, not silent STDIO fallback |
| Multiple HTTP + STDIO servers | Independent connections, discovery, dispatch, and teardown |
| HTTP 401 / 403 / bad TLS / timeout / 5xx | Server-specific error, no leaked credentials, no global crash |
| Cancel in-flight HTTP call | Abort/dispose resources, no orphaned stream |
| Change endpoint/type in settings | Old transport closed, old tools removed, correct new transport used |
| Intent enabled + STDIO tool | Existing compiled-prompt path unaffected |
| Intent enabled + HTTP tool | Same compiled-prompt flow and HTTP tool execution work together |
| Intent disabled + STDIO / HTTP | Same tool mechanism works without compilation |
| Extension reload / shutdown | No leaked subprocesses, streams, listeners, or stale registered tools |

**Testing expectation:** Unit tests alone are insufficient. Include an integration test with a real local HTTP MCP test server or a sufficiently faithful SDK-backed test harness (including a streaming response), and exercise a real tool through Twinny's existing execution path. Mock only the boundaries necessary for deterministic tests. Do not weaken/skip existing tests just to make them green.

## 9. Completion / delivery expectations

Before declaring the implementation finished, provide:

1. Changed-file list and explanation of which code moved into `mcp/stdio.ts` versus `mcp/http.ts`.
2. The actual config shape and example JSON for `type: 'http'`.
3. SDK package version and verified MCP protocol versions; any missing auth/protocol features called out explicitly.
4. Build, lint, relevant unit tests, integration test results, and the exact behavior of Intent-on + HTTP in testing.
5. Any remaining issues, with accurate error messages and reproduction steps.

**Non-goals:** replacing STDIO, changing existing Chat/Intent provider independence, creating new inference endpoints, starting an MCP HTTP server, silently introducing an MCP proxy, or modifying unrelated Twinny features.

**Design principle:** *One MCP tool interface; transport-specific adapters underneath. STDIO remains dependable, HTTP reaches wherever the user configures it, and Intent remains independent.*
