# Phase 3C — Independent MCP Client Foundation (`@ghost-bot/mcp`)

Status: **In Progress** (acceptance review) (Track B — Independent Extensions, branched from `feat/phase-3b-knowledge-retrieval @ 4d3f5c3`).

## 1. Architecture & SDK Selection Rationale

`@ghost-bot/mcp` is a standalone, daemon-agnostic Model Context Protocol (MCP) client foundation.
- **Selected SDK & Specification**: `@modelcontextprotocol/sdk@1.32.2` (stable v1.x maintenance line, targeting MCP specification `2025-11-25`) paired with `@cfworker/json-schema@4.1.6` (zero-dependency JSON Schema 2020-12 validator).
- **Compatibility rationale**: Ghost Bot's monorepo standardizes on `zod@^3.25.67` (`3.25.76`). `@modelcontextprotocol/client@2.4.0` (SDK v2, spec `2026-07-28`) requires `zod@^4.2.0`, whereas `@modelcontextprotocol/sdk@1.32.2` declares `peerDependencies: { zod: "^3.25 || ^4.0" }`, avoiding a duplicate Zod major version across workspace packages. Spec `2026-07-28` features are not claimed.

## 2. Package Structure & Public API

```text
packages/mcp/
  package.json
  tsconfig.json
  src/
    index.ts
    contracts/      # MCP_LIMITS, McpError hierarchy, strict Zod schemas, TS types
    registry/       # McpRegistryRepository interface & canonical SHA-256 config fingerprint
    storage/        # node:sqlite mcp_schema_meta + mcp_servers (0700/0600 guards)
    security/       # Deny-by-default authorization, launch path guards, env filtering, trust
    policy/         # Narrow HostMcpPolicyAdapter hook for future RuntimePolicyBroker
    transport/      # BoundedStdioClientTransport (hard byte bounds before buffering)
    discovery/      # Paginated capability discovery with repeated-cursor detection
    invocation/     # Schema-validated tool calls, resource reads, & prompt retrieval
    lifecycle/      # McpConnectionManager (state machine, generation binding, cleanup)
  tests/
    fixtures/       # valid-mcp-server.mjs (official SDK McpServer) & adversarial-mcp-server.mjs
    unit/           # contracts-and-trust, authorization-and-policy, bounded-stdio-transport
    integration/    # registry-persistence, mcp-stdio-lifecycle, discovery-and-invocation, security-and-poisoning
```

## 3. Supported & Unsupported Transports

- **Supported**: Local `stdio` (`McpStdioTransportSchema`) via `BoundedStdioClientTransport`.
- **Unsupported (fail-closed)**: Remote `streamable_http`, SSE, and WebSocket transports are rejected at schema validation and connection boundaries. No general remote MCP compatibility is claimed.

## 4. Server Registry, Configuration Identity & Trust Invalidation

- **Isolated SQLite Schema**: `mcp_schema_meta` (`schema_version = 1`) and `mcp_servers` (`UNIQUE(scope_key, display_name)`). Persists configuration and opaque `secretRefs` only; never stores raw secret values, tool outputs, or ephemeral process state.
- **Trust & Fingerprinting**: `computeServerConfigFingerprint(scope, transport)` hashes `scope`, `executablePath`, `args`, `cwd`, `envAllowlist`, and `secretRefs`. New servers start `enabled: false, trustState: 'untrusted'`. Any `update()` changing `transport` automatically resets `trustState = 'untrusted'`, `trustedFingerprint = null`, and `enabled = false`.
- **Distinction**: Configuration fingerprinting detects config edits, not silent replacement of the executable binary or its imported libraries on disk.

## 5. Authorization & Deny-by-Default Policy

- `McpAuthContext` is a trusted host input (never independently authenticated by `@ghost-bot/mcp`; the future daemon must derive it from authenticated session/bot/workspace ownership).
- Permissions are separated: `canReadConfig`, `canManageConfig`, `canLaunch`, `canDiscover`, `allowedTools`, `allowedResources`, `allowedPrompts`. Discovery never grants invocation; user-wide read never grants management or launch. Server hints (e.g., `readOnlyHint`) never grant permissions.

## 6. STDIO Process Launch, Bounded Transport & Cleanup

- **Launch Validation (`validateStdioLaunchPaths`)**: Requires absolute non-symlink executable (`uid` = current user or root, executable bit set), non-symlink `cwd` owned by current user, and blocks shells/package-runners (`npx`, `npm`, `uvx`, `pip`, `curl`, `wget`, `sh`, `bash`, etc.).
- **Minimal Environment (`buildMinimalChildEnv`)**: Starts from empty `{}` (never inherits `process.env` or provider keys like `OPENAI_API_KEY` / `CODEX_API_KEY`).
- **Hard-Bounded Framing (`BoundedStdioClientTransport`)**: Enforces `maxMessageBytes` (1 MiB) **before** buffering `\n`-delimited stdout lines; oversized messages immediately destroy streams, terminate the subprocess, and emit `McpTransportError`. `stderr` is capped at `16 KiB` and redacted.
- **Cleanup**: `SIGTERM` followed by bounded `SIGKILL` escalation (`gracefulShutdownMs`). Child-spawned grandchild processes outside direct PID signaling are a documented OS limitation unless process-group/cgroup containment is added at the host layer.
- **OS Isolation Limitation**: `shell: false`, path validation, and env filtering are **not** OS sandboxing; a local MCP subprocess runs with the parent user's OS privileges.

## 7. Lifecycle, Discovery, Invocation, Resources & Prompts

- **States**: `disconnected -> connecting -> ready -> disconnecting -> failed`. Concurrent `connect()` calls are rejected deterministically. Each connection binds a monotonic `connectionGeneration`.
- **Client Capabilities**: Advertises `{}` (no sampling, no elicitation, no roots); server-initiated `sampling/createMessage` fails closed.
- **Discovery**: Paginated `tools/list`, `resources/list`, `prompts/list` with repeated-cursor detection, `maxDiscoveryPages = 20`, `maxSchemaDepth = 12`, and `serverId::name` capability keys.
- **Invocation**: Validates arguments locally via `@cfworker/json-schema` (no remote `$ref`), distinguishes `isToolError: true` from transport errors, and marks timeout/cancellation with `uncertainOutcome: true` (no automatic retry).
- **Resources & Prompts**: Binary blobs are rejected; text resources and prompt messages are returned with `authority: 'none'` as untrusted reference data.

## 8. Threat Model, Credential Protection & Poisoning Boundaries

- Configuration rejects recognized credential patterns (`assertNoCredentialsInServerInput`) and blocks protected provider env var names. Regex detection cannot catch arbitrary high-entropy secrets.
- Tool descriptions, schemas, tool outputs, resource text, and prompt messages are wrapped as untrusted data (`authority: 'none'`) and cannot elevate trust, modify config, or invoke other tools. Structural envelopes do not guarantee downstream LLM prompt-injection resistance.

## 9. Future Phase 3D Daemon Integration Contract (Not Implemented)

- **Registry**: Migrate `mcp_servers` into daemon-owned SQLite (`apps/daemon/src/db/`) and resolve `secretRefs` via OS keyring.
- **Policy & Approvals**: Implement `HostMcpPolicyAdapter` inside `RuntimePolicyBroker` (`apps/daemon/src/runtime/policy-broker.ts`) and route tool calls through existing `RunOrchestrator` approval/audit flows while preserving `full-access` restrictions.
- **IPC & Desktop**: Expose allowlisted typed channels in `packages/shared-types/ipc.ts` and desktop MCP settings/approval UI without granting renderer direct process access.

## 10. Verification Commands & Results

- `corepack pnpm lint` — **exit 0**
- `corepack pnpm -r --if-present typecheck` — **exit 0**
- `corepack pnpm -r --if-present build` — **exit 0**
- `corepack pnpm --filter @ghost-bot/memory test` — **exit 0**
- `corepack pnpm --filter @ghost-bot/knowledge test` — **exit 0**
- `corepack pnpm --filter @ghost-bot/mcp test` — **exit 0**
- `corepack pnpm test` — **exit 0**

## 11. Acceptance review handoff, 2026-11-26

Reviewed baseline `4553e0e` on `feat/phase-3c-mcp-foundation`, descended from Phase 3B `4d3f5c3`. Antigravity stopped at its quota limit during this review.

- The connection manager rechecks launch permission, current configuration fingerprint, enabled/trusted state, and host policy after asynchronous path validation and before reporting ready. Concurrent launches recheck the connection slot and global limit before starting a subprocess.
- Discovery rejects duplicate or oversized identities and applies a cumulative byte budget to listing responses. Local snapshots are protected from caller mutation, and list changes or competing discovery invalidate pending discovery results.
- Tool grants can additionally bind to the SHA-256 hash of the discovered definition. A mismatched hash is rejected. The integration test exercises both a valid hash and a mismatched hash after caller-side mutation of the returned snapshot.
- Persisted configurations are checked against their scope key and recomputed fingerprint. SQLite records with inconsistent trust or enablement fail closed. The persistence test checks a syntactically valid but incorrect fingerprint.
- Child environments protect the fixed PATH, provider credentials, and common loader/interpreter overrides. The manager forwards resolved secrets only for explicitly declared names.
- The `@ghost-bot/mcp/registry` subpath now points to the actual implementation. All four package entry points were imported successfully.

The Phase 3C acceptance gate remains open. Existing name-based tool grants still work and definition-hash grants are optional. Executable contents and interpreter entrypoints are still outside trust identity. Further review is required for trust revocation and reapproval during a live connection, schema validation cost, protocol-wide bounds, and process descendants. Production dependency audit exited 1 with [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) for Zod 3.25.76 on the reported daemon path. Applicability to extension boundaries and a compatible patched dependency path remain to be checked before final acceptance.

Verification for this checkpoint: workspace lint, recursive typecheck and recursive build exited 0. Memory passed 14/14, Knowledge 12/12, MCP 8/8, and root tests 48/48. All four module imports and `git diff --check` passed. Track A and accepted Phase 3A/3B sources were outside the change set.
