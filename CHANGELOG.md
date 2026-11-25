# Changelog

## Unreleased

### Phase 0B & 0C
- Added reusable newline-delimited JSON-RPC 2.0 stdio client (`packages/runtime-adapters/json-rpc-client.ts`) with concurrent request correlation, server-initiated request handling, timeouts, `AbortSignal` cancellation, malformed payload resilience, and graceful shutdown.
- Added `CodexAppServerAdapter` (`packages/runtime-adapters/codex/codex-app-server.ts`) using an isolated persistent profile (`~/.config/ghost-bot/codex-profile`), ChatGPT subscription auth, live rate-limit normalization, streaming, cancellation, session resume, `argsHash`-bound approvals, and `excludeSlashTmp: true` workspace containment.
- Added 12 new offline unit tests (`tests/json-rpc-client.test.ts`, `tests/codex-adapter.test.ts`) bringing total offline tests to 16/16 passing.
- Added opt-in live Codex verification harness (`scripts/verify-codex-live.mjs`) and verified all Phase 0 exit gate criteria.
- Documented [ADR 0004](docs/adr/0004-codex-jsonrpc-and-sandbox-containment.md) and updated provider matrix, security, roadmap, progress, and test plan.

### Phase 0A
- Initialized the ghost-bot repository from the starter kit with the original offline prototype and avatar system.
- Added opt-in Codex App Server, OpenClaw Gateway and Ollama discovery probes.
- Added normalized model discovery, versioned runtime events and tested permission preflight.
- Documented provider evidence, SQLite design, security boundaries and the Phase 0 handoff.
