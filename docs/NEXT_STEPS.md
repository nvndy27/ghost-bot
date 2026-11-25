# Next steps

## Phase 2D release gate

1. Review the [latest Phase 2D evidence](PROGRESS.md#phase-2d-continuation--2026-11-26), including Fedora packaging and offline recovery.
2. With a fresh authorized turn budget, finish the Codex restart/reconnect check and verify provider-side access to the persisted thread before claiming live continuation.
3. Re-evaluate the Phase 2D acceptance gate before merging. Keep other phases on their existing branches.

## Earlier Phase 2 plan

Phase 1 (1A–1D) Desktop Foundation is **Verified** and ready for acceptance review. Next milestone: **Phase 2 — Functional MVP**:

1. Wire live chat execution (`runs.start`, `runs.cancel`, `approvals.resolve`) through the daemon `RuntimePolicyBroker` and `CodexAppServerAdapter` (preserving `read-only`, `ask-approval`, and `workspace` sandboxing with `excludeSlashTmp: true`).
2. Persist sessions, runs, run events (`RuntimeEventV1` with monotonic `seq`), and messages transactionally in SQLite (`apps/daemon/src/db/`).
3. Surface real tool activity, approval requests, diff previews, and cancellation in the desktop workspace.
4. Implement native OpenClaw Gateway WebSocket adapter and optional local Ollama adapter after live verification.

Start with [progress](PROGRESS.md), [protocol](PROTOCOL.md), and [provider matrix](PROVIDER_MATRIX.md).
