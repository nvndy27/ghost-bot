# Roadmap

States are Not Started, In Progress, Implemented, Tested, Verified and Blocked. See [progress](PROGRESS.md) for test evidence.

## Phase 0 — Technical proof

- **Verified** — Starter kit audit, project rename, Git initialization and initial private GitHub push.
- **Verified** — OpenClaw CLI health and isolated Codex App Server initialize/account/model/effort discovery.
- **Tested** — Model metadata normalization and fail-closed permission preflight.
- **Implemented** — Runtime event envelope, SQLite design, security boundary and provider research.
- **Blocked** — Live Ollama discovery requires a local service.
- **Not Started** — Account-bound Codex quota, streaming, interruption and permission proof. Native OpenClaw session and permission verification.
- **In Progress** — Phase 0 exit review. Phase 1 remains gated on the review of provider and permission gaps.

## Phase 1 — Desktop foundation
- [ ] Electron + React TS + Vite + pnpm workspace, lint/typecheck/test pipeline.
- [ ] Secure IPC, daemon lifecycle and SQLite migrations; mock adapter clearly marked.
- [ ] Three-panel shell, settings, theming, resized/collapsed panels, keyboard accessibility.
- [ ] Bot CRUD, SVG avatar editor, persistence and custom upload validation.
Gate: restart persistence, UI matches references, offline integration tests pass.

## Phase 2 — Functional MVP
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
