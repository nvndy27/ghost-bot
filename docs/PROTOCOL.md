# Internal protocol (proposed)

Use allowlisted typed IPC methods; no generic shell or arbitrary URL bridge. Requests validated in main/daemon. If a loopback service is used, require session auth and origin checks. This is internal design, not OpenClaw/Codex's actual protocol.

Methods: agents.list/create/update/archive; sessions.list/create/get; runs.start/cancel; approvals.resolve; providers.list/connect/disconnect/discover; usage.snapshot; settings.get/update; teams.create/assign; routines.list/create/enable; artifacts.read (scoped IDs). Return structured errors (code, message, retryable, capability). Never return secrets.

Run lifecycle: queued → running → awaiting_approval → running → completed/failed/cancelled. Terminal states immutable. Approval lifecycle: pending → allowed/denied/expired → consumed (allowed only). Use idempotency keys and sequence numbers, replay events after cursor; deduplicate; bound buffers; persist terminal state. Stream deltas, tool lifecycle, approval requests, artifacts and usage via normalized envelope. On cancellation request, stop accepting new actions, ask runtime to cancel and mark confirmed outcome; do not claim cancelled if unresolved.

Capability negotiation: supported effort strings and policy modes per runtime/model; permission mode enforced or unavailable; unsupported quota null. Store normalized status and raw event only if redacted and permitted. All examples are app-level contracts, to validate against real probes.

The proposed wire envelope is `RuntimeEventV1` with `version: 1`, runtime/session/run identifiers, a positive contiguous sequence per run starting at 1, an RFC 3339 UTC event timestamp and a discriminated payload. The daemon validates and redacts before assigning sequence and persisting. Consumers replay after the last committed sequence, ignore duplicates and resync on gaps. An unresolved interrupt leaves the run outcome unresolved until reconciliation confirms a terminal event.

## Phase 1C & 1D IPC surface (implemented)

Allowlisted typed IPC channels in `packages/shared-types/ipc.ts` (validated by `WebContents` + `mainFrame` + Zod in Electron main and authenticated via Bearer token on the daemon Unix socket):
- `ghost:app:info`, `ghost:daemon:health`, `ghost:providers:list`
- `ghost:bots:list`, `ghost:bots:create`, `ghost:bots:update`, `ghost:bots:duplicate`, `ghost:bots:delete`, `ghost:bots:set-active`
- `ghost:avatar:import-svg`, `ghost:workspace:pick`
- `ghost:settings:get`, `ghost:settings:update`, `ghost:settings:reset`, `ghost:settings:migrate-local`
- `ghost:runtime:snapshot` (metadata-only: `account/read`, `model/list`, `account/rateLimits/read`; no inference)

## Phase 3D.1 Memory IPC surface (implemented)

- `ghost:memory:list`, `ghost:memory:search`, `ghost:memory:create`, `ghost:memory:update`, `ghost:memory:archive`, `ghost:memory:delete` (strict Zod v4 schemas in `packages/shared-types/ipc.ts`; `MemoryAuthContext` constructed exclusively in `@ghost-bot/daemon`).

## Phase 3D.2 Knowledge IPC surface (implemented)

- `ghost:knowledge:collections:list`, `ghost:knowledge:collections:create`, `ghost:knowledge:docs:list`, `ghost:knowledge:docs:search`, `ghost:knowledge:docs:ingest-text`, `ghost:knowledge:docs:pick-and-ingest`, `ghost:knowledge:docs:update`, `ghost:knowledge:docs:replace-text`, `ghost:knowledge:docs:archive`, `ghost:knowledge:docs:delete`, `ghost:knowledge:citations:resolve`.

## Phase 3D.3 MCP IPC surface (implemented)

- `ghost:mcp:servers:list`, `ghost:mcp:servers:register`, `ghost:mcp:servers:update`, `ghost:mcp:servers:approve-trust`, `ghost:mcp:servers:revoke-trust`, `ghost:mcp:servers:set-enabled`, `ghost:mcp:servers:delete`, `ghost:mcp:servers:connect`, `ghost:mcp:servers:disconnect`, `ghost:mcp:servers:capabilities`, `ghost:mcp:servers:read-resource`, `ghost:mcp:servers:get-prompt`.
