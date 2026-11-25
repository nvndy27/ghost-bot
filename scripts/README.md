# Phase 0 probes

Run from the repository root on Node 24 or later.

- `node scripts/probe-codex.mjs` starts the installed Codex CLI with a temporary profile and checks initialize, signed-out account state and one page of model/effort discovery. It never starts a turn.
- `node scripts/probe-openclaw.mjs` runs the installed OpenClaw CLI health RPC using CLI-managed auth. Requires a running configured gateway at `ws://127.0.0.1:18789`.
- `node scripts/probe-ollama.mjs` checks version and installed model count at `http://127.0.0.1:11434`. It never downloads or starts a model.

The probes are opt-in and exit nonzero when unavailable or when an expected response fails validation.
