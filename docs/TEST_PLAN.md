# Test plan

Offline default: unit tests for adapter normalization, malformed event rejection, sequence replay, capability filtering, permission decisions and path canonicalization; SQLite migration/restart and idempotency; UI Playwright for create bot, avatar, model selection, settings, approval, cancellation, theme and keyboard. Mock data clearly marked.

Opt-in integration: OpenClaw health/version/discovery; Codex initialize/account state/model discovery/optional minimal stream; Ollama local discovery and stream. No paid requests without explicit opt-in. Redact diagnostics. Test disconnect/reconnect, cancellation, rate limits, unsupported fields and missing keyring. Security negative tests: denied tool no side effect; symlink escape; untrusted prompt injection; malicious SVG; renderer IPC spoofing; expired approval; changed args after approval; cross-agent data isolation; no secret in logs. Test packaging on Fedora/Wayland. Run actual tests before marking done. Record version, command, result, and blockers.

## Phase 0 commands

- `npm test` — four offline tests pass.
- `npm exec --yes --package=typescript@5.9.3 -- tsc --noEmit --strict --module nodenext --target es2022 packages/shared-types/*.ts packages/avatar/presets.ts` — strict checks pass for source contracts and avatar types.
- `node --check` on prototype JavaScript and probe modules — syntax passes. Project-wide lint is scheduled with the desktop scaffold.
- `node scripts/probe-codex.mjs` and `node scripts/probe-openclaw.mjs` — pass on the environment recorded in [progress](PROGRESS.md).
- `node scripts/probe-ollama.mjs` — blocked with no local listener.
