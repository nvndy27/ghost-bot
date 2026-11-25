# Roadmap

States are Not Started, In Progress, Implemented, Tested, Verified and Blocked. See [progress](PROGRESS.md) for test evidence.

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
- [ ] Real verified Codex integration; connect/disconnect/stream/cancel/resume.
- [ ] OpenClaw adapter if verified; optional local Ollama.
- [ ] Dynamic model/effort, actual permission enforcement, approval/diff display.
- [ ] Usage source and timestamps; unknown quotas shown correctly; opt-in API costs.
- [ ] Fedora packaging and security tests.
Gate: one verified subscription path, real streaming, denial yields no side effect, restart recovery.

## Phase 3 — Agent core
- [ ] Memory and workspace management, tools/MCP registry, skills, terminal/artifacts, audit.
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
