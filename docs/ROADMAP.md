# Roadmap

All items are planned unless explicitly marked complete. Estimates intentionally omitted until Phase 0 results. The UI prototype is not a completed production milestone.

## Phase 0 — Technical proof
- [ ] Verify OpenClaw protocol and auth; run minimal gateway probe.
- [ ] Verify Codex App Server account eligibility, initialize/model/effort/quota/approval events.
- [ ] Investigate permitted Claude/Gemini/Kimi integrations and Ollama; update matrix.
- [ ] Normalize capabilities/events, clarify ownership, test fail-closed permissions and cancellation.
- [ ] Record reproducible commands/results, blockers, decisions; review gate before Phase 1.

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
