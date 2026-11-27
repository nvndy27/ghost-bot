# Roadmap

States are Not Started, In Progress, Implemented, Tested, Verified and Blocked. See [progress](PROGRESS.md) for test evidence.

## Product release track — v0.1 Personal & Friends Alpha

Owner scope decision (2026-11-27): the first daily-use build for the maintainer and a small circle of friends is the existing Chat workspace foundation plus **exactly two new feature areas: Group Bot and the right-hand Workspace Panel**. Local-first, open-source-first direction, BYOK/local AI and supported subscription flows; no Ghost Bot account, payment, paid plan, central server or cloud dependency.

### Alpha.0 — Usable native Chat foundation
- **In Progress** (Alpha.0A offline closure **Tested**; PR convergence & authorized live/packaging sign-off remaining) — Resolved `LIVE_INFERENCE_DISABLED` 501 execution gap in Provider.7 and closed Alpha.0A native chat consistency, atomic preflight/dispatch barriers, structured canonical history role separation, provider coverage (`llamacpp`, `claude-api`, `gemini-api`, `ollama` via deterministic fixtures), and loopback proxy/sandbox checks (see [Alpha.0A report](extensions/alpha0a-native-chat-closure.md)).
- Gate: at least one verified live provider path remains functional; each advertised live provider/capability has matching evidence; unsupported paths fail closed with clear status; no unauthorized inference or billing.

### Alpha.1 — Group Bot & private task collaboration
- **Not Started** — Extend existing `TeamsService` / `TeamsExecutionBridge` / task ledger / session infrastructure (no duplicate team engine).

### Alpha.2 — Workspace Panel
- **Not Started** — Right-hand Workspace Panel (Files/Editor, Git Changes, Browser/Live Demo, Output) with workspace-scoped authorization.

### Alpha.3 — Personal & Friends Alpha Release Readiness
- **Not Started** — Integrated acceptance, packaging smoke checks, and security review.

## Phase 0 — Technical proof

- **Verified** — Starter kit audit, project rename, Git initialization and initial private GitHub push.
- **Verified** — Reusable JSON-RPC stdio client (`packages/runtime-adapters/json-rpc-client.ts`) and Codex App Server adapter (`packages/runtime-adapters/codex/codex-app-server.ts`).
- **Verified** — Dedicated ChatGPT-authenticated Codex profile (`plus`), model/effort discovery, live rate-limit windows, streaming, cancellation, session resume, read-only/workspace sandboxing (`excludeSlashTmp: true`), and rejected approval with no side effect.
- **Verified** — OpenClaw CLI health and read-only loopback gateway probe (`operator.read`).
- **Tested** — 16 offline unit tests (JSON-RPC correlation, concurrency, timeouts, cancellation, crashes, malformed payloads, unknown quota, permission modes, approval rejection) and strict TypeScript check.
- **Blocked** — Live Ollama discovery (no local service) and live Kimi ACP (CLI not installed); non-blocking for Phase 1.
- **Verified** — Phase 0 exit gate **PASS** (2026-11-25). Ready for Phase 1 desktop foundation.

## Phase 1 — Desktop foundation
- [x] Electron + React TS + Vite + pnpm workspace, lint/typecheck/test pipeline (Phase 1A **Verified**).
- [x] Secure IPC, daemon lifecycle, mock adapter, and SQLite migrations (Phase 1A/1C **Verified**).
- [x] Three-panel shell, 13-section Settings, theming, resized/collapsed panels, keyboard accessibility (Phase 1B/1D **Verified**).
- [x] Bot CRUD, SVG avatar editor, SQLite persistence, and custom SVG sanitization (Phase 1C **Verified**).
- [x] Daemon runtime registry, policy broker, and Codex metadata/usage/model bridge (Phase 1D **Verified**).
Gate: restart persistence, UI matches references, offline integration tests pass — **Phase 1 Gate PASS**.

## Phase 2 — Functional MVP
- [x] Phase 2A — Daemon-owned session, run, event, and message persistence foundation (**Verified**; merged to `main` at `2ffc521`).
- [x] Phase 2B — Live read-only Codex execution, thread continuity, streaming, and cancellation (**Verified**; 3-turn live Electron+Codex E2E and offline suites passed).
- [x] Phase 2C — Live tools, durable interactive approvals, and workspace-write permissions (**Verified**; live Deny + Approve once + canary containment + 53/53 tests passed).
- [x] Phase 2D — Runtime recovery, reconnect, thread inspection, manual retry, and Linux AppImage packaging (**Verified**; 2-turn live recovery, security hardening, and packaged AppImage 2-launch verification passed; RPM packaging deferred to Phase 2E).
- [x] Real verified Codex integration; connect/disconnect/stream/cancel/resume.
- [x] OpenClaw adapter if verified; optional local Ollama (**Metadata Verified / Execution Gated** for OpenClaw `2026.11.8`; `OllamaLocalAdapter` optional/protocol-tested and unavailable on host).
- [x] Dynamic model/effort, actual permission enforcement, approval/diff display.
- [x] Usage source and timestamps; unknown quotas shown correctly; opt-in API costs.
- [x] Fedora packaging and security tests (AppImage **Verified** via `APPIMAGE_EXTRACT_AND_RUN=1`; native `rpmbuild` RPM built, inspected, and extracted-package smoke-verified).
Gate: one verified subscription path, real streaming, denial yields no side effect, restart recovery — **Phase 2 Gate PASS** (see `docs/PHASE2_RELEASE_REPORT.md`).

## Phase 3 — Agent core
- **Verified** (Phase 3D.0 Integration Foundation) — Merged Track B independent packages (`@ghost-bot/memory`, `@ghost-bot/knowledge`, `@ghost-bot/mcp`) onto `main` (`07839ff`), upgraded all workspaces to `zod@4.6.7` (`GHSA-mrhx-c7xc-m3w5` resolved, `0` prod vulnerabilities), and passed `typecheck`, `lint`, `build`, `verify-phase-2e-acceptance.mjs`, and 3 consecutive `102/102` test runs (see [Phase 3D.0 report](extensions/phase-3d0-integration-report.md)).
- **Verified** (Phase 3D.1 Production Memory Integration) — Added migration `0005_memory_core`, daemon-owned `MemoryService` (`createBorrowedMemoryDatabaseHandle`), trusted server-side `MemoryAuthContext`, strict Zod v4 memory IPC, `MemorySettingsSection` UI, and dispatch-boundary `RunOrchestrator` context assembly + revalidation (see [Phase 3D.1 report](extensions/phase-3d1-memory-integration.md)).
- **Verified** (Phase 3D.2 Production Knowledge & Retrieval Integration) — Added migration `0006_knowledge_core`, daemon-owned `KnowledgeService` (`createBorrowedKnowledgeDatabaseHandle`), trusted file-grant ingestion (`.txt`/`.md`), revision-aware citations, `KnowledgeSettingsSection` UI, and combined Memory+Knowledge dispatch-boundary context assembly (`<= 12288` bytes) (see [Phase 3D.2 report](extensions/phase-3d2-knowledge-integration.md)).
- **Verified** (Phase 3D.3 Production MCP Integration) — Added migration `0007_mcp_core`, daemon-owned `McpService` (`createBorrowedMcpDatabaseHandle`), `RuntimePolicyBroker.createMcpPolicyAdapter`, durable `approvals` + `mcp_approval_bindings` single-use execution, `McpSettingsSection` UI, and real local STDIO fixture tool/resource/prompt verification (see [Phase 3D.3 report](extensions/phase-3d3-mcp-integration.md)).
- **Verified (Offline RC)** (Phase 3D.4 Integrated End-to-End Acceptance) — Verified unified v4/v5/v6->v7 upgrades, combined 27-step Memory+Knowledge+MCP Electron E2E, ~2500-chunk cross-extension responsiveness, and rebuilt AppImage + Fedora RPM packaging; OS Secret Service keyring for MCP `secretRefs` and native Codex MCP (`unsupported_native_mcp`) remain open for follow-up (see [Phase 3D.4 report](extensions/phase-3d4-integrated-acceptance.md)).
- **Tested** (Provider.7 Unified Multi-Provider Execution) — Resolved `LIVE_INFERENCE_DISABLED` 501 execution gap in `RunOrchestrator`, `RuntimeRegistry`, and `DaemonServer` across `openclaw`, `ollama`, `claude-api`, `gemini-api`, `kimi-acp`, `lmstudio`, `llamacpp`, and `openrouter` while preserving Codex and fail-closed `RuntimePolicyBroker` gating; added restart canonical-history reconstruction and targeted Provider.6 residual hardening (see [Provider.7 report](extensions/provider7-unified-execution.md)).
- [ ] OS Secret Service keyring for MCP `secretRefs`, native Codex MCP (`dynamicToolCall`), skills, terminal/artifacts, and audit.
- [ ] Add other supported runtime/provider adapters according to verified matrix.
Gate: no cross-agent leaks; tool and memory consent validated.

## Phase 4 — Multi-agent teams
- [ ] Chief of Staff, team/group chat, task delegation, parallel execution, task ledger.
- [ ] Bound depth, attempts, tokens/time and concurrency; aggregate usage and stop propagation.
Gate: delegation failures, cancellation and budget exhaustion tested.

## Phase 5 — Autonomous work
- [ ] Durable scheduler, timezone, cron, webhook/file triggers, retry, missed-run policy, notifications.
- [ ] systemd user service opt-in, browser sandbox and live virtual desktop, logs.
Gate: restart/idempotency/approval handling and isolated browser tested.

## Phase 6 — Expansion
- [ ] Consented meeting assistant, mobile companion, remote gateway, marketplace, Windows/macOS.
Gate: threat model, consent, privacy and platform-specific tests reviewed.
