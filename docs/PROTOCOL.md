# Internal protocol (proposed)

Use allowlisted typed IPC methods; no generic shell or arbitrary URL bridge. Requests validated in main/daemon. If a loopback service is used, require session auth and origin checks. This is internal design, not OpenClaw/Codex's actual protocol.

Methods: agents.list/create/update/archive; sessions.list/create/get; runs.start/cancel; approvals.resolve; providers.list/connect/disconnect/discover; usage.snapshot; settings.get/update; teams.create/assign; routines.list/create/enable; artifacts.read (scoped IDs). Return structured errors (code, message, retryable, capability). Never return secrets.

Run lifecycle: queued → running → awaiting_approval → running → completed/failed/cancelled. Terminal states immutable. Approval lifecycle: pending → allowed/denied/expired → consumed (allowed only). Use idempotency keys and sequence numbers, replay events after cursor; deduplicate; bound buffers; persist terminal state. Stream deltas, tool lifecycle, approval requests, artifacts and usage via normalized envelope. On cancellation request, stop accepting new actions, ask runtime to cancel and mark confirmed outcome; do not claim cancelled if unresolved.

Capability negotiation: supported effort strings and policy modes per runtime/model; permission mode enforced or unavailable; unsupported quota null. Store normalized status and raw event only if redacted and permitted. All examples are app-level contracts, to validate against real probes.
